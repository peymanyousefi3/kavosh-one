import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {Database} from '../core/database.ts';
import {ApiError} from '../core/policy.ts';
import {readDispositionCatalog,dispositionSchemaOrder} from './disposition-schema.ts';
import {buildDispositionSnapshotQuery} from './disposition-snapshot-query.ts';

const request=z.object({academyId:z.string().uuid(),seeds:z.array(z.object({relation:z.string().regex(/^public\.[A-Za-z_][A-Za-z0-9_$]{0,62}$/),key:z.array(z.string().max(2048)).min(1).max(32)}).strict()).max(10000),maxRows:z.number().int().min(1).max(1000000).default(100000)}).strict();
const manifestRequest=request.extend({maxSourceRows:z.number().int().min(1).max(1000000).default(100000)});
type SourceManifest={version:1;totalRows:number;candidateRows:number;retainedRows:number;relations:{relation:string;totalRows:number;candidateRows:number;retainedRows:number;sourceFingerprint:string;candidateKeyFingerprint:string}[]};

// Internal,unmounted prerequisite only. Caller-supplied seeds are NOT a lawful
// retention policy or permission to delete anything. Own read-only transaction;
// row_security=off refuses an incomplete RLS-filtered view rather than bypassing
// RLS. Never used with a production worker or exposed as a public endpoint.
// Native recursive UNION deduplicates actual record keys,including cycles;
// records and references stay in PostgreSQL,not a million-row JavaScript graph.
export function inspectRetainedDispositionRows(database:Database,input:unknown){return inspectRecordSnapshot(database,input);}

// Exact bounded school-row content and candidate-key fingerprints,not a legal
// clearance or executable approval. No record bodies or raw keys leave SQL.
// Owner approval,holds,policy versions and transaction-time freshness checks
// must still bind this snapshot before a separate executor may use it.
export async function inspectDispositionManifest(database:Database,input:unknown){
 const parsed=manifestRequest.safeParse(input);if(!parsed.success)throw new ApiError(400,'DISPOSITION_RETENTION_INPUT_INVALID');
 const {maxSourceRows,...scope}=parsed.data,result=await inspectRecordSnapshot(database,scope,maxSourceRows);
 if(!result.sourceManifest)throw new ApiError(503,'DISPOSITION_MANIFEST_INVALID');
 return{...result,sourceManifest:result.sourceManifest};
}

async function inspectRecordSnapshot(database:Database,input:unknown,manifestLimit?:number){
 const parsed=request.safeParse(input);if(!parsed.success)throw new ApiError(400,'DISPOSITION_RETENTION_INPUT_INVALID');
 const {academyId,seeds,maxRows}=parsed.data;
 if(new Set(seeds.map(s=>JSON.stringify(s))).size!==seeds.length)throw new ApiError(400,'DISPOSITION_RETENTION_INPUT_INVALID');
 const db=await database.connect();let begun=false,destroy=false;
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
  // This bounded catalog-wide plan has many short,mostly inactive branches.
  // Do not pay LLVM compilation cost for every branch of a maintenance read.
  // Transaction-local only;ordinary application query settings are unchanged.
  await db.query("SELECT set_config('row_security','off',true),set_config('statement_timeout','15000',true),set_config('work_mem','16MB',true),set_config('jit','off',true),set_config('search_path','pg_catalog',true),set_config('TimeZone','UTC',true),set_config('DateStyle','ISO,YMD',true),set_config('extra_float_digits','3',true),set_config('bytea_output','hex',true),set_config('IntervalStyle','iso_8601',true)");
  const catalog=await readDispositionCatalog(db),structure=dispositionSchemaOrder(catalog);
  if(structure.blockers.some(b=>b.code!=='ACTION_DEPENDENCY_CYCLE'))throw new ApiError(409,'DISPOSITION_SCHEMA_REVIEW_REQUIRED');
  const relations=new Map(catalog.relations.map(r=>['public.'+r.name,r]));
  for(const seed of seeds)if(!relations.has(seed.relation)||relations.get(seed.relation)!.primaryKey.length!==seed.key.length)throw new ApiError(400,'DISPOSITION_RETENTION_INPUT_INVALID');
  const {sql}=buildDispositionSnapshotQuery(catalog,seeds.map(s=>s.relation),manifestLimit!==undefined);
  const result=await db.query<{accepted_count:number;retained_count:number;academy_count:number;cross_tenant_reference:boolean;relations:{relation:string;count:number;fingerprint:string}[];source_manifest:SourceManifest|null}>(sql,[academyId,JSON.stringify(seeds),maxRows,...(manifestLimit===undefined?[]:[manifestLimit])]);
  const value=result.rows[0];
  if(result.rows.length!==1||value.academy_count!==1||value.accepted_count!==seeds.length)throw new ApiError(409,'DISPOSITION_RETENTION_SOURCE_MISSING');
  if(value.retained_count>maxRows)throw new ApiError(409,'DISPOSITION_RETENTION_LIMIT_EXCEEDED');
  const source=value.source_manifest;
  if(manifestLimit!==undefined){
   if(!source||source.totalRows>manifestLimit)throw new ApiError(409,'DISPOSITION_MANIFEST_LIMIT_EXCEEDED');
   if(source.retainedRows!==value.retained_count||source.totalRows!==source.candidateRows+source.retainedRows)throw new ApiError(503,'DISPOSITION_MANIFEST_INVALID');
  }
  const sourceManifest=source?{...source,fingerprint:createHash('sha256').update(JSON.stringify({academyId,structuralFingerprint:structure.structuralFingerprint,crossTenantReference:value.cross_tenant_reference,source})).digest('hex')}:null;
  await db.query('COMMIT');begun=false;
  return{structuralFingerprint:structure.structuralFingerprint,retainedCount:value.retained_count,relations:value.relations,crossTenantReference:value.cross_tenant_reference,sourceManifest,closureComplete:true as const,recordScopeEvaluated:true as const,retentionEvaluated:false as const,executionAuthorized:false as const,dataDeleted:false as const};
 }catch(error){if(begun)try{await db.query('ROLLBACK');}catch{destroy=true;}throw error;}finally{db.release(destroy);}
}
