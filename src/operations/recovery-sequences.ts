import type pg from 'pg';
import {RecoveryError} from './recovery-error.ts';

const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const integer=(value:unknown)=>{if(typeof value!=='string'||!/^-?(?:0|[1-9][0-9]{0,19})$/.test(value))throw new RecoveryError('RECOVERY_SEQUENCE_STATE_INVALID');return BigInt(value);};

// Only call in the isolated restored cluster,after original data equality and
// before authentication quarantine. Sequences are not MVCC snapshots: this
// proves the next restored value cannot collide with retained owned-column
// data,not that a sequence equals its live source at an earlier snapshot time.
// Never consume nextval,repair setval,or authorize application activation here.
export async function verifyRecoveredSequenceSafety(client:Pick<pg.Client,'query'>,signal?:AbortSignal){
 const check=()=>{if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');};check();
 const transaction=(await client.query<{isolation:string;readOnly:string;unfiltered:boolean}>("SELECT current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') AS \"readOnly\",(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) unfiltered")).rows[0];
 if(transaction?.isolation!=='repeatable read'||transaction.readOnly!=='on'||transaction.unfiltered!==true)throw new RecoveryError('RECOVERY_SEQUENCE_SNAPSHOT_REQUIRED');
 const sequences=(await client.query<{schema:string;name:string;increment:string;minimum:string;maximum:string;cycle:boolean;tableSchema:string|null;tableName:string|null;columnName:string|null;tableKind:string|null}>(`SELECT n.nspname schema,c.relname name,s.seqincrement::text increment,s.seqmin::text minimum,s.seqmax::text maximum,s.seqcycle cycle,tn.nspname "tableSchema",t.relname "tableName",a.attname "columnName",t.relkind "tableKind"
 FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.objsubid=0 AND d.refclassid='pg_class'::regclass AND d.deptype IN('a','i')
 LEFT JOIN pg_class t ON t.oid=d.refobjid LEFT JOIN pg_namespace tn ON tn.oid=t.relnamespace LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid AND NOT a.attisdropped
 WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C" LIMIT 10001`)).rows;
 if(sequences.length>10000)throw new RecoveryError('RECOVERY_SEQUENCE_LIMIT');
 const seen=new Set<string>();let unused=0;
 for(const sequence of sequences){
  check();const key=JSON.stringify([sequence.schema,sequence.name]);
  if(seen.has(key)||sequence.cycle||!sequence.tableSchema||!sequence.tableName||!sequence.columnName||!['r','p'].includes(sequence.tableKind??''))throw new RecoveryError('RECOVERY_SEQUENCE_LAYOUT_UNSUPPORTED');seen.add(key);
  const increment=integer(sequence.increment),minimum=integer(sequence.minimum),maximum=integer(sequence.maximum);
  if(increment===0n||minimum>=maximum)throw new RecoveryError('RECOVERY_SEQUENCE_STATE_INVALID');
  const states=(await client.query<{lastValue:string;isCalled:boolean}>(`SELECT last_value::text AS "lastValue",is_called AS "isCalled" FROM ${quote(sequence.schema)}.${quote(sequence.name)}`)).rows;
  if(states.length!==1||typeof states[0].isCalled!=='boolean')throw new RecoveryError('RECOVERY_SEQUENCE_STATE_INVALID');
  const last=integer(states[0].lastValue),next=states[0].isCalled?last+increment:last;
  if(last<minimum||last>maximum||next<minimum||next>maximum)throw new RecoveryError('RECOVERY_SEQUENCE_EXHAUSTED');
  const extreme=(await client.query<{value:string|null}>(`SELECT ${increment>0n?'max':'min'}(${quote(sequence.columnName)})::text value FROM ${quote(sequence.tableSchema)}.${quote(sequence.tableName)}`)).rows[0]?.value;
  if(extreme===undefined)throw new RecoveryError('RECOVERY_SEQUENCE_STATE_INVALID');
  if(extreme!==null&&(increment>0n?next<=integer(extreme):next>=integer(extreme)))throw new RecoveryError('RECOVERY_SEQUENCE_RETAINED_DATA_CONFLICT');
  if(!states[0].isCalled)unused++;
 }
 check();return {ownedSequencesChecked:sequences.length,unusedSequencesChecked:unused,nextGeneratedValuesOutsideRetainedData:true,originalLiveSequenceValuesCompared:false,sequenceValuesChanged:false};
}
