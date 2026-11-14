import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,realpath,open,readFile,writeFile,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type pg from 'pg';
import type {operationsFixture} from './operations-fixture.ts';
import {expectedSchemaRevision} from '../src/core/database.ts';
import {captureMediaReferencePlan,openMediaReferencePlan} from '../src/operations/media-reference-plan.ts';

// Called inside existing genuine signing flows after the ordinary isolated
// recorder has persisted original-bound complete AND review-required evidence.
// No invented evidence rows,disabled guards,provider requests or cloud claims.
export async function checkSignatureBackupReferences(database:Pick<Awaited<ReturnType<typeof operationsFixture>>['pg'],'runtime'|'query'|'exec'>){
 const root=await realpath(await mkdtemp(join(tmpdir(),'kavosh-signing-reference-'))),files:string[]=[];
 const client=database.runtime?await database.runtime.connect():undefined;
 const c=(client??{query:(sql:string,args?:unknown[])=>database.query(sql,args)}) as unknown as pg.Client;
 try{
  await c.query('RESET ROLE');await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const rows=(await c.query<{academy_id:string;manifest:{storageTargetId:string;receipt:Record<string,{id:string;sizeBytes:number;sha256:string}>}}>('SELECT academy_id,manifest FROM public.signature_completion_evidence UNION ALL SELECT academy_id,manifest FROM public.work_signature_completion_evidence')).rows;assert.ok(rows.length>0);
  const expected=[...new Map(rows.flatMap(row=>['document','audit','properties'].map(kind=>{const a=row.manifest.receipt[kind],r={type:'reference',academyId:row.academy_id,stage:'signature-evidence',storageTargetId:row.manifest.storageTargetId,fileId:a.id,bytes:a.sizeBytes,sha256:a.sha256};return[JSON.stringify(r),r] as const;}))).values()].sort((a,b)=>(a.academyId+a.storageTargetId+a.fileId).localeCompare(b.academyId+b.storageTargetId+b.fileId));
  const binding={databaseBackupId:randomUUID(),archiveSha256:'a'.repeat(64),schemaRevision:expectedSchemaRevision};
  const capture=async(name:string,signing?:boolean)=>{const path=join(root,name);files.push(path);const output=await open(path,'wx',0o600);let result;try{result=await captureMediaReferencePlan(c,output,binding,undefined,signing);}finally{await output.close();}const text=await readFile(path,'utf8');return{result,text,path,records:text.trim().split('\n').map(line=>JSON.parse(line))};};
  const legacy=await capture('legacy.jsonl'),explicitOff=await capture('off.jsonl',false);assert.equal(explicitOff.text,legacy.text);assert.equal(legacy.result.signedEvidenceIncluded,false);assert.ok(legacy.records.every(row=>row.stage!=='signature-evidence'));
  const included=await capture('included.jsonl',true),actual=included.records.filter(row=>row.stage==='signature-evidence');assert.equal(included.result.signedEvidenceIncluded,true);assert.equal(included.records[0].scope,'recorded_ordinary_and_signed_evidence_objects');assert.deepEqual(actual,expected);assert.equal(included.result.references,legacy.result.references+expected.length);assert.doesNotMatch(included.text,/PRIVATE|signerName|signerEmail|phoneNumber|apiKey|secretAccessKey/);
  const input={...binding,file:included.path,plaintextBytes:included.result.plaintextBytes,plaintextSha256:included.result.plaintextSha256},targets=new Set(included.records.filter(row=>row.type==='reference').map(row=>row.stage+':'+row.storageTargetId));
  const reader=await openMediaReferencePlan(input,null,targets);try{const observed=[];for await(const row of reader.referencesForSchool)if(row.stage==='signature-evidence')observed.push(row);assert.deepEqual(observed,expected);assert.equal(reader.signedEvidenceIncluded,true);}finally{await reader.close();}
  const missing=new Set(targets);missing.delete('signature-evidence:'+expected[0].storageTargetId);await assert.rejects(openMediaReferencePlan(input,null,missing),{code:'MEDIA_REFERENCE_TARGET_MISSING'});
  for(const scope of ['recorded_ordinary_file_objects','recorded_ordinary_and_signed_evidence_objects']){
   const forged=included.records.map((row,i)=>i?row:{...row,scope,signedEvidenceIncluded:false}),text=forged.map(row=>JSON.stringify(row)+'\n').join(''),file=join(root,'forged-'+files.length+'.jsonl');files.push(file);await writeFile(file,text,{mode:0o600,flag:'wx'});await assert.rejects(openMediaReferencePlan({...input,file,plaintextBytes:Buffer.byteLength(text),plaintextSha256:createHash('sha256').update(text).digest('hex')},null,targets));
  }
  console.log(JSON.stringify({case:'actual-signed-evidence-backup-reference-capture',retainedObservations:rows.length,uniqueArtifacts:expected.length,defaultOutputPreserved:true,signingScopeVerified:true,cloudRequests:0}));
 }finally{await c.query('ROLLBACK');client?.release();if(!database.runtime)await database.exec('RESET ROLE');for(const file of files)await unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});await rmdir(root);}
}
