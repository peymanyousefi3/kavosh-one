import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {Connection} from '../core/database.ts';
import {ApiError} from '../core/policy.ts';

const identifier=z.string().regex(/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/);
const relation=z.object({schema:z.literal('public'),name:identifier,scopeColumn:z.enum(['academy_id','id']),scopeType:z.string().max(120),scopeNotNull:z.boolean(),primaryKey:z.array(identifier).max(32),partitioned:z.boolean(),partitionChild:z.boolean(),inheritance:z.boolean()}).strict();
const foreignKey=z.object({name:identifier,childSchema:identifier,childRelation:identifier,parentSchema:identifier,parentRelation:identifier,childColumns:z.array(identifier).min(1).max(32),parentColumns:z.array(identifier).min(1).max(32),deferrable:z.boolean(),initiallyDeferred:z.boolean(),deleteAction:z.enum(['a','r','c','n','d']),validated:z.boolean(),enforced:z.boolean(),enforcementTriggersActive:z.boolean(),period:z.boolean()}).strict().refine(f=>f.childColumns.length===f.parentColumns.length&&(!f.initiallyDeferred||f.deferrable));
const snapshot=z.object({schemaRevision:z.number().int().positive().max(2147483647),replicationRole:z.enum(['origin','replica','local']),relations:z.array(relation).min(1).max(2000),foreignKeys:z.array(foreignKey).max(10000)}).strict();
type ForeignKey=z.infer<typeof foreignKey>;
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const key=(schema:string,name:string)=>schema+'.'+name;
const child=(f:ForeignKey)=>key(f.childSchema,f.childRelation),parent=(f:ForeignKey)=>key(f.parentSchema,f.parentRelation);
const constraintKey=(f:ForeignKey)=>child(f)+'.'+f.name;

// Catalog topology only: this is NOT a record-selection plan,legal clearance,
// approval or executable deletion request. No business values or identities are
// read. The eventual executor still needs exact retained-row closure,source
// freshness,owner authority,holds,provider-copy and restore-tombstone checks.
export async function readDispositionSchema(db:Pick<Connection,'query'>){
 const result=await db.query<{snapshot:unknown}>(`
 WITH tenant_relations AS MATERIALIZED (
  SELECT c.oid,c.relname,c.relkind,c.relispartition,s.attname scope_column,s.attnotnull scope_not_null,
   pg_catalog.format_type(s.atttypid,s.atttypmod) scope_type
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_attribute s ON s.attrelid=c.oid AND NOT s.attisdropped AND s.attnum>0
   AND s.attname=CASE WHEN c.relname='academies' THEN 'id' ELSE 'academy_id' END
  WHERE n.nspname='public' AND c.relkind IN('r','p')
 ), relation_data AS (
  SELECT jsonb_build_object('schema','public','name',r.relname,'scopeColumn',r.scope_column,'scopeType',r.scope_type,
   'scopeNotNull',r.scope_not_null,'partitioned',r.relkind='p','partitionChild',r.relispartition,
   'inheritance',EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=r.oid OR i.inhparent=r.oid),
   'primaryKey',coalesce((SELECT jsonb_agg(a.attname ORDER BY k.position) FROM pg_catalog.pg_constraint p
    CROSS JOIN LATERAL unnest(p.conkey) WITH ORDINALITY k(number,position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=p.conrelid AND a.attnum=k.number
    WHERE p.conrelid=r.oid AND p.contype='p'),'[]'::jsonb)) data,r.relname
  FROM tenant_relations r
 ), foreign_data AS (
  SELECT jsonb_build_object('name',f.conname,'childSchema',sn.nspname,'childRelation',s.relname,
   'parentSchema',pn.nspname,'parentRelation',p.relname,'deferrable',f.condeferrable,
   'initiallyDeferred',f.condeferred,'deleteAction',f.confdeltype,'validated',f.convalidated,
   'enforced',CASE WHEN current_setting('server_version_num')::integer>=180000 THEN(to_jsonb(f)->>'conenforced')::boolean ELSE true END,
   'enforcementTriggersActive',EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=f.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=f.oid AND t.tgenabled NOT IN('O','A')),
   'period',CASE WHEN current_setting('server_version_num')::integer>=180000 THEN(to_jsonb(f)->>'conperiod')::boolean ELSE false END,
   'childColumns',(SELECT jsonb_agg(a.attname ORDER BY k.position) FROM unnest(f.conkey) WITH ORDINALITY k(number,position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=f.conrelid AND a.attnum=k.number),
   'parentColumns',(SELECT jsonb_agg(a.attname ORDER BY k.position) FROM unnest(f.confkey) WITH ORDINALITY k(number,position)
    JOIN pg_catalog.pg_attribute a ON a.attrelid=f.confrelid AND a.attnum=k.number)) data,
   sn.nspname,s.relname,f.conname
  FROM pg_catalog.pg_constraint f JOIN pg_catalog.pg_class s ON s.oid=f.conrelid
  JOIN pg_catalog.pg_namespace sn ON sn.oid=s.relnamespace JOIN pg_catalog.pg_class p ON p.oid=f.confrelid
  JOIN pg_catalog.pg_namespace pn ON pn.oid=p.relnamespace
  WHERE f.contype='f' AND(f.conrelid IN(SELECT oid FROM tenant_relations) OR f.confrelid IN(SELECT oid FROM tenant_relations))
 )
 SELECT jsonb_build_object('schemaRevision',public.schema_revision(),'replicationRole',current_setting('session_replication_role'),
  'relations',(SELECT jsonb_agg(data ORDER BY relname) FROM relation_data),
  'foreignKeys',coalesce((SELECT jsonb_agg(data ORDER BY nspname,relname,conname) FROM foreign_data),'[]'::jsonb)) snapshot`);
 if(result.rows.length!==1)throw new ApiError(503,'DISPOSITION_SCHEMA_INVALID');
 return dispositionSchemaOrder(result.rows[0].snapshot);
}

export function dispositionSchemaOrder(raw:unknown){
 const parsed=snapshot.safeParse(raw);if(!parsed.success)throw new ApiError(503,'DISPOSITION_SCHEMA_INVALID');
 const s=parsed.data,relations=[...s.relations].sort((a,b)=>compare(a.name,b.name)),foreignKeys=[...s.foreignKeys].sort((a,b)=>compare(constraintKey(a),constraintKey(b)));
 const names=new Set<string>(),constraints=new Set<string>();
 for(const r of relations){const name=key(r.schema,r.name);if(names.has(name)||new Set(r.primaryKey).size!==r.primaryKey.length)throw new ApiError(503,'DISPOSITION_SCHEMA_INVALID');names.add(name);}
 if(!names.has('public.academies'))throw new ApiError(503,'DISPOSITION_SCHEMA_INVALID');
 for(const f of foreignKeys){const name=constraintKey(f);if(constraints.has(name)||!names.has(child(f))&&!names.has(parent(f))||new Set(f.childColumns).size!==f.childColumns.length||new Set(f.parentColumns).size!==f.parentColumns.length)throw new ApiError(503,'DISPOSITION_SCHEMA_INVALID');constraints.add(name);}
 const protectedRoots=relations.filter(r=>r.name==='academies').map(r=>key(r.schema,r.name));
 // Retain the school identity as a tombstone/foreign-key anchor. This helper
 // never authorizes retaining its name,contacts or other personal attributes.
 const targets=relations.filter(r=>r.name!=='academies'),targetNames=new Set(targets.map(r=>key(r.schema,r.name)));
 const blockers:{code:string;relations:string[];constraint?:string}[]=[];
 if(s.replicationRole!=='origin')blockers.push({code:'REPLICATION_MODE_REVIEW_REQUIRED',relations:[]});
 for(const r of relations){const name=key(r.schema,r.name);
  if(r.scopeType!=='uuid'||!r.scopeNotNull||r.scopeColumn!==(r.name==='academies'?'id':'academy_id'))blockers.push({code:'UNSUPPORTED_TENANT_KEY',relations:[name]});
  if(!r.primaryKey.length)blockers.push({code:'MISSING_PRIMARY_KEY',relations:[name]});
  if(r.partitioned||r.partitionChild)blockers.push({code:'PARTITION_REVIEW_REQUIRED',relations:[name]});
  if(r.inheritance&&!r.partitioned&&!r.partitionChild)blockers.push({code:'INHERITANCE_REVIEW_REQUIRED',relations:[name]});
 }
 const adjacency=new Map(targets.map(r=>[key(r.schema,r.name),new Set<string>()])),inDegree=new Map(targets.map(r=>[key(r.schema,r.name),0]));
 const deferConstraints:ForeignKey[]=[],selfReferences:ForeignKey[]=[],externalReferences:(ForeignKey&{direction:'incoming'|'outgoing'})[]=[];
 for(const f of foreignKeys){const from=child(f),to=parent(f);
  if(!f.validated)blockers.push({code:'UNVALIDATED_FOREIGN_KEY',relations:[from,to],constraint:constraintKey(f)});
  if(!f.enforced)blockers.push({code:'UNENFORCED_FOREIGN_KEY',relations:[from,to],constraint:constraintKey(f)});
  if(!f.enforcementTriggersActive)blockers.push({code:'DISABLED_FOREIGN_KEY_TRIGGER',relations:[from,to],constraint:constraintKey(f)});
  if(f.period)blockers.push({code:'TEMPORAL_FOREIGN_KEY_REVIEW_REQUIRED',relations:[from,to],constraint:constraintKey(f)});
  if(!targetNames.has(from)&&!targetNames.has(to))continue;
  if(!targetNames.has(from)||!targetNames.has(to)){externalReferences.push({...f,direction:targetNames.has(from)?'outgoing':'incoming'});continue;}
  // Only NO ACTION can actually wait until commit. Declaring a CASCADE,
  // RESTRICT,SET NULL or SET DEFAULT constraint deferrable does NOT defer its
  // action. Those dependencies must remain in the child-before-parent graph.
  // https://www.postgresql.org/docs/18/sql-createtable.html
  if(f.deferrable&&f.deleteAction==='a'){deferConstraints.push(f);continue;}
  if(from===to){selfReferences.push(f);continue;}
  const edges=adjacency.get(from)!;if(!edges.has(to)){edges.add(to);inDegree.set(to,inDegree.get(to)!+1);}
 }
 const queue=[...targetNames].filter(name=>inDegree.get(name)===0).sort(compare),ordered:string[]=[];
 for(let i=0;i<queue.length;i++){const from=queue[i];ordered.push(from);for(const to of [...adjacency.get(from)!].sort(compare)){const remaining=inDegree.get(to)!-1;inDegree.set(to,remaining);if(!remaining)queue.push(to);}}
 const blocked=[...targetNames].filter(name=>inDegree.get(name)!>0).sort(compare);
 if(blocked.length)blockers.push({code:'ACTION_DEPENDENCY_CYCLE',relations:blocked});
 return{
  schemaRevision:s.schemaRevision,
  structuralFingerprint:createHash('sha256').update(JSON.stringify({schemaRevision:s.schemaRevision,replicationRole:s.replicationRole,relations,foreignKeys})).digest('hex'),
  relationCount:relations.length,foreignKeyCount:foreignKeys.length,protectedRoots,
  schemaOrderReady:blockers.length===0,deleteOrder:blockers.length?[]:ordered,
  deferConstraints,selfReferences,externalReferences,blockers,
  singleStatementRequiredFor:[...new Set(selfReferences.map(child))].sort(compare),
  recordScopeEvaluated:false as const,retentionEvaluated:false as const,executionAuthorized:false as const,dataDeleted:false as const
 };
}
