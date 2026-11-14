import {validatedDispositionCatalog} from './disposition-schema.ts';
import {buildDispositionSnapshotQuery} from './disposition-snapshot-query.ts';

const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const literal=(name:string)=>"'"+name.replaceAll("'","''")+"'";

// Trusted installer/compiler only. No runtime accepts catalog JSON or this SQL.
// The sealed executor must supply owner/cancellation/retention approval, acquire
// the returned write fence, verify source freshness and roll back unless exact.
// Native FK constraints stay enabled,including cyclic and cross-school edges.
export function buildDispositionDeleteQuery(raw:unknown){
 const catalog=validatedDispositionCatalog(raw),snapshot=buildDispositionSnapshotQuery(catalog,[],true,true);
 const targets=catalog.relations.filter(r=>r.name!=='academies');
 const clauses=targets.map((r,i)=>{
  const name='public.'+r.name,table='public.'+quote(r.name),key='jsonb_build_array('+r.primaryKey.map(k=>'t.'+quote(k)+'::text').join(',')+')';
  const nativeKey=`jsonb_populate_record(NULL::${table},jsonb_build_object(${r.primaryKey.flatMap((column,j)=>[literal(column),`s.record_key->>${j}`]).join(',')}))`,match=r.primaryKey.map(column=>`t.${quote(column)}=(${nativeKey}).${quote(column)}`).join(' AND ');
  return{cte:`disposition_delete_${i} AS(DELETE FROM ${table} t USING execution_scope permit,classified_source s WHERE permit.allowed AND s.candidate AND s.relation=${literal(name)} AND t.${quote(r.scopeColumn)}=$1::uuid AND ${match} RETURNING ${key} record_key)`,
   summary:`SELECT ${literal(name)}::text relation,count(*)::integer count,encode(sha256(convert_to(coalesce(string_agg(record_key::text,E'\\n' ORDER BY record_key::text COLLATE "C"),''),'UTF8')),'hex') fingerprint FROM disposition_delete_${i}`};
 });
 const summaries=clauses.map(c=>c.summary).join(' UNION ALL ')||"SELECT NULL::text relation,0::integer count,encode(sha256(''::bytea),'hex') fingerprint WHERE false";
 const sql=`${snapshot.ctes},execution_scope AS MATERIALIZED(SELECT
  $3::integer BETWEEN 1 AND 1000000 AND $4::integer BETWEEN 1 AND 1000000
  AND(SELECT count(*) FROM public.academies WHERE id=$1::uuid)=1
  AND(SELECT count(*) FROM bounded)<=$3::integer AND(SELECT count(*) FROM bounded_source)<=$4::integer
  AND NOT(${snapshot.crossTenantReference}) allowed)${clauses.length?','+clauses.map(c=>c.cte).join(','):''},
  deleted AS(${summaries})
  SELECT(SELECT allowed FROM execution_scope) allowed,
   NOT EXISTS(SELECT 1 FROM deleted d LEFT JOIN manifest_counts m ON m.relation=d.relation
    WHERE d.count<>coalesce(m."candidateRows",0) OR d.fingerprint<>coalesce(m."candidateKeyFingerprint",encode(sha256(''::bytea),'hex'))) exact,
   (SELECT coalesce(sum(count),0)::integer FROM deleted) deleted_count,
   coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY relation COLLATE "C") FROM deleted d WHERE d.count>0),'[]'::jsonb) deleted_relations`;
 // ponytail: rare disposal uses one global table-write fence,not a new writer
 // coordination layer. Replace only with universally enforced per-school
 // fences if disposal volume makes this short maintenance step material.
 return{sql,lockSql:'LOCK TABLE '+catalog.relations.map(r=>'public.'+quote(r.name)).join(',')+' IN SHARE ROW EXCLUSIVE MODE',structure:snapshot.structure};
}
