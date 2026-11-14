import {z} from 'zod';
import type {Database} from '../core/database.ts';
import {ApiError} from '../core/policy.ts';
import {readDispositionCatalog,dispositionSchemaOrder} from './disposition-schema.ts';

const request=z.object({academyId:z.string().uuid(),seeds:z.array(z.object({relation:z.string().regex(/^public\.[A-Za-z_][A-Za-z0-9_$]{0,62}$/),key:z.array(z.string().max(2048)).min(1).max(32)}).strict()).max(10000),maxRows:z.number().int().min(1).max(1000000).default(100000)}).strict();
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const qualified=(schema:string,name:string)=>quote(schema)+'.'+quote(name);

// Internal,unmounted prerequisite only. Caller-supplied seeds are NOT a lawful
// retention policy or permission to delete anything. Own read-only transaction;
// row_security=off refuses an incomplete RLS-filtered view rather than bypassing
// RLS. Never used with a production worker or exposed as a public endpoint.
// Native recursive UNION deduplicates actual record keys,including cycles;
// records and references stay in PostgreSQL,not a million-row JavaScript graph.
export async function inspectRetainedDispositionRows(database:Database,input:unknown){
 const parsed=request.safeParse(input);if(!parsed.success)throw new ApiError(400,'DISPOSITION_RETENTION_INPUT_INVALID');
 const {academyId,seeds,maxRows}=parsed.data;
 if(new Set(seeds.map(s=>JSON.stringify(s))).size!==seeds.length)throw new ApiError(400,'DISPOSITION_RETENTION_INPUT_INVALID');
 const db=await database.connect();let begun=false,destroy=false;
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  await db.query("SELECT set_config('row_security','off',true),set_config('statement_timeout','15000',true),set_config('work_mem','16MB',true)");
  const catalog=await readDispositionCatalog(db),structure=dispositionSchemaOrder(catalog);
  if(structure.blockers.some(b=>b.code!=='ACTION_DEPENDENCY_CYCLE'))throw new ApiError(409,'DISPOSITION_SCHEMA_REVIEW_REQUIRED');
  const relations=new Map(catalog.relations.map(r=>['public.'+r.name,r]));
  for(const seed of seeds)if(!relations.has(seed.relation)||relations.get(seed.relation)!.primaryKey.length!==seed.key.length)throw new ApiError(400,'DISPOSITION_RETENTION_INPUT_INVALID');
  const table=(r:{schema:string;name:string})=>qualified(r.schema,r.name);
  const key=(alias:string,r:{primaryKey:string[]})=>'jsonb_build_array('+r.primaryKey.map(k=>alias+'.'+quote(k)+'::text').join(',')+')';
  const scope=(alias:string,r:{scopeColumn:string})=>alias+'.'+quote(r.scopeColumn);
  const seedMatches=[...new Set(seeds.map(s=>s.relation))].map(name=>{
   const r=relations.get(name)!;return `SELECT ${literal(name)} relation,${key('t',r)} record_key FROM ${table(r)} t JOIN requested s ON s.relation=${literal(name)} AND s.record_key=${key('t',r)} WHERE ${scope('t',r)}=$1::uuid`;
  });
  const root=relations.get('public.academies')!;
  const initial=[`SELECT 'public.academies'::text relation,${key('a',root)} record_key FROM public.academies a WHERE a.id=$1::uuid`,'SELECT relation,record_key FROM accepted'];
  const parents:string[]=[],anomalies:string[]=[];
  for(const f of catalog.foreignKeys){
   const childName=f.childSchema+'.'+f.childRelation,parentName=f.parentSchema+'.'+f.parentRelation,c=relations.get(childName),p=relations.get(parentName);
   if(!p)continue; // Shared identities and other schools are never deletion targets.
   const join=f.childColumns.map((column,i)=>'c.'+quote(column)+'=p.'+quote(f.parentColumns[i])).join(' AND ');
   const from=`FROM ${qualified(f.childSchema,f.childRelation)} c JOIN ${table(p)} p ON ${join}`;
   const parentRow=`SELECT ${literal(parentName)}::text relation,${key('p',p)} record_key ${from}`;
   if(!c)initial.push(`${parentRow} WHERE ${scope('p',p)}=$1::uuid`);
   else{
    // Incoming references from another school protect the target parent,even
    // when an old single-column FK did not enforce matching academy IDs.
    initial.push(`${parentRow} WHERE ${scope('p',p)}=$1::uuid AND ${scope('c',c)}<>$1::uuid`);
    anomalies.push(`SELECT 1 ${from} WHERE (${scope('p',p)}=$1::uuid AND ${scope('c',c)}<>$1::uuid) OR (${scope('c',c)}=$1::uuid AND ${scope('p',p)}<>$1::uuid) LIMIT 1`);
    // Populate the native composite type so PK comparisons remain native and
    // indexable,not casts of every stored PK to text. Values are bound JSON.
    const populated=`jsonb_populate_record(NULL::${table(c)},jsonb_build_object(${c.primaryKey.flatMap((column,i)=>[literal(column),`r.record_key->>${i}`]).join(',')}))`;
    const match=c.primaryKey.map(column=>'c.'+quote(column)+'=('+populated+').'+quote(column)).join(' AND ');
    parents.push(`${parentRow} WHERE r.relation=${literal(childName)} AND ${match} AND ${scope('c',c)}=$1::uuid AND ${scope('p',p)}=$1::uuid`);
   }
  }
  const empty="SELECT NULL::text relation,NULL::jsonb record_key WHERE false";
  const sql=`WITH RECURSIVE requested AS(SELECT s->>'relation' relation,s->'key' record_key FROM jsonb_array_elements($2::jsonb) s),
   accepted AS MATERIALIZED(${seedMatches.join(' UNION ALL ')||empty}),
   retained(relation,record_key) AS((${initial.join(' UNION ')}) UNION SELECT next.relation,next.record_key FROM retained r CROSS JOIN LATERAL(${parents.join(' UNION ALL ')||empty}) next),
   bounded AS MATERIALIZED(SELECT * FROM retained LIMIT $3::integer+1),
   counts AS(SELECT relation,count(*)::integer count,encode(sha256(convert_to(string_agg(record_key::text,E'\\n' ORDER BY record_key::text COLLATE "C"),'UTF8')),'hex') fingerprint FROM bounded GROUP BY relation)
   SELECT (SELECT count(*)::integer FROM accepted) accepted_count,(SELECT count(*)::integer FROM bounded) retained_count,
    (SELECT count(*)::integer FROM public.academies WHERE id=$1::uuid) academy_count,
    EXISTS(${anomalies.map(q=>'('+q+')').join(' UNION ALL ')||'SELECT 1 WHERE false'}) cross_tenant_reference,
    coalesce((SELECT jsonb_agg(to_jsonb(counts) ORDER BY relation COLLATE "C") FROM counts),'[]'::jsonb) relations`;
  const result=await db.query<{accepted_count:number;retained_count:number;academy_count:number;cross_tenant_reference:boolean;relations:{relation:string;count:number;fingerprint:string}[]}>(sql,[academyId,JSON.stringify(seeds),maxRows]);
  const value=result.rows[0];
  if(result.rows.length!==1||value.academy_count!==1||value.accepted_count!==seeds.length)throw new ApiError(409,'DISPOSITION_RETENTION_SOURCE_MISSING');
  if(value.retained_count>maxRows)throw new ApiError(409,'DISPOSITION_RETENTION_LIMIT_EXCEEDED');
  await db.query('COMMIT');begun=false;
  return{structuralFingerprint:structure.structuralFingerprint,retainedCount:value.retained_count,relations:value.relations,crossTenantReference:value.cross_tenant_reference,closureComplete:true as const,recordScopeEvaluated:true as const,retentionEvaluated:false as const,executionAuthorized:false as const,dataDeleted:false as const};
 }catch(error){if(begun)try{await db.query('ROLLBACK');}catch{destroy=true;}throw error;}finally{db.release(destroy);}
}
