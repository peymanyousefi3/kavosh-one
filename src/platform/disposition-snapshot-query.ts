import {ApiError} from '../core/policy.ts';
import {validatedDispositionCatalog,dispositionSchemaOrder} from './disposition-schema.ts';

const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const qualified=(schema:string,name:string)=>quote(schema)+'.'+quote(name);

// Shared query compiler for the direct test inspector and the installer-sealed
// native owner broker. This returns trusted SQL,never an externally accepted
// query. The broker must bind values and enforce authority separately.
export function buildDispositionSnapshotQuery(raw:unknown,seedRelations:string[],withManifest:boolean,wholeRelationRetention=false){
 const catalog=validatedDispositionCatalog(raw),structure=dispositionSchemaOrder(catalog);
 if(structure.blockers.some(b=>b.code!=='ACTION_DEPENDENCY_CYCLE'))throw new ApiError(409,'DISPOSITION_SCHEMA_REVIEW_REQUIRED');
 const relations=new Map(catalog.relations.map(r=>['public.'+r.name,r]));
 if(seedRelations.some(name=>!relations.has(name)))throw new ApiError(400,'DISPOSITION_RETENTION_INPUT_INVALID');
  const table=(r:{schema:string;name:string})=>qualified(r.schema,r.name);
  const key=(alias:string,r:{primaryKey:string[]})=>'jsonb_build_array('+r.primaryKey.map(k=>alias+'.'+quote(k)+'::text').join(',')+')';
  const scope=(alias:string,r:{scopeColumn:string})=>alias+'.'+quote(r.scopeColumn);
  const seedMatches=[...new Set(seedRelations)].map(name=>{
   const r=relations.get(name)!;return `SELECT ${literal(name)} relation,${key('t',r)} record_key FROM ${table(r)} t JOIN requested s ON s.relation=${literal(name)} AND s.record_key=${key('t',r)} WHERE ${scope('t',r)}=$1::uuid`;
  });
  const root=relations.get('public.academies')!;
  const initial=[`SELECT 'public.academies'::text relation,${key('a',root)} record_key FROM public.academies a WHERE a.id=$1::uuid`,'SELECT relation,record_key FROM accepted'];
  // Keep relation-wide obligations native: a retained ledger may have far
  // more rows than the small individual-exception input permits. Never send
  // every financial primary key through JavaScript just to preserve a table.
  if(wholeRelationRetention)for(const r of catalog.relations)initial.push(`SELECT ${literal('public.'+r.name)}::text relation,${key('t',r)} record_key FROM ${table(r)} t WHERE ${scope('t',r)}=$1::uuid AND $5::jsonb?${literal('public.'+r.name)}`);
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
  // Hash full native row content before aggregation. Key-only fingerprints
  // cannot catch an edited amount,private field or source version. The global
  // source bound is applied inside PostgreSQL;never truncate and call it exact.
  const manifestCtes=!withManifest?'':`,source_rows AS(${catalog.relations.map(r=>`SELECT ${literal('public.'+r.name)}::text relation,${key('t',r)} record_key,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') row_hash FROM ${table(r)} t WHERE ${scope('t',r)}=$1::uuid`).join(' UNION ALL ')}),
   bounded_source AS MATERIALIZED(SELECT * FROM source_rows LIMIT $4::integer+1),
   classified_source AS(SELECT s.*,b.relation IS NULL candidate FROM bounded_source s LEFT JOIN bounded b ON b.relation=s.relation AND b.record_key=s.record_key),
   manifest_counts AS(SELECT relation,count(*)::integer "totalRows",count(*)FILTER(WHERE candidate)::integer "candidateRows",count(*)FILTER(WHERE NOT candidate)::integer "retainedRows",
    encode(sha256(convert_to(string_agg(record_key::text||':'||row_hash,E'\\n' ORDER BY record_key::text COLLATE "C"),'UTF8')),'hex') "sourceFingerprint",
    encode(sha256(convert_to(coalesce(string_agg(record_key::text,E'\\n' ORDER BY record_key::text COLLATE "C")FILTER(WHERE candidate),''),'UTF8')),'hex') "candidateKeyFingerprint",
    encode(sha256(convert_to(coalesce(string_agg(record_key::text||':'||row_hash,E'\\n' ORDER BY record_key::text COLLATE "C")FILTER(WHERE NOT candidate),''),'UTF8')),'hex') "retainedSourceFingerprint" FROM classified_source GROUP BY relation)`;
  const manifestSelect=!withManifest?'NULL::jsonb':`jsonb_build_object('version',1,'totalRows',(SELECT count(*)::integer FROM bounded_source),'candidateRows',(SELECT count(*)::integer FROM classified_source WHERE candidate),'retainedRows',(SELECT count(*)::integer FROM classified_source WHERE NOT candidate),'relations',coalesce((SELECT jsonb_agg(to_jsonb(manifest_counts) ORDER BY relation COLLATE "C") FROM manifest_counts),'[]'::jsonb))`;
  const crossTenantReference=`EXISTS(${anomalies.map(q=>'('+q+')').join(' UNION ALL ')||'SELECT 1 WHERE false'})`;
  const ctes=`WITH RECURSIVE requested AS(SELECT s->>'relation' relation,s->'key' record_key FROM jsonb_array_elements($2::jsonb) s),
   accepted AS MATERIALIZED(${seedMatches.join(' UNION ALL ')||empty}),
   retained(relation,record_key) AS((${initial.join(' UNION ')}) UNION SELECT next.relation,next.record_key FROM retained r CROSS JOIN LATERAL(${parents.join(' UNION ALL ')||empty}) next),
   bounded AS MATERIALIZED(SELECT * FROM retained LIMIT $3::integer+1),
   counts AS(SELECT relation,count(*)::integer count,encode(sha256(convert_to(string_agg(record_key::text,E'\\n' ORDER BY record_key::text COLLATE "C"),'UTF8')),'hex') fingerprint FROM bounded GROUP BY relation)${manifestCtes}`;
  const sql=`${ctes} SELECT (SELECT count(*)::integer FROM accepted) accepted_count,(SELECT count(*)::integer FROM bounded) retained_count,
    (SELECT count(*)::integer FROM public.academies WHERE id=$1::uuid) academy_count,
    ${crossTenantReference} cross_tenant_reference,
    coalesce((SELECT jsonb_agg(to_jsonb(counts) ORDER BY relation COLLATE "C") FROM counts),'[]'::jsonb) relations,${manifestSelect} source_manifest`;
 return{sql,structure,ctes,crossTenantReference};
}
