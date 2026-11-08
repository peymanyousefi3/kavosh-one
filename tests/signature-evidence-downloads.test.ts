import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { operationsFixture } from './operations-fixture.ts';

test('actual208to209 preserves existing people roles approvals policy definitions and function ownership without granting old serving policies signed evidence access',async()=>{
 const f=await operationsFixture({throughSchema:208});try{
  const snapshot="SELECT jsonb_build_object('people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p),'permissions',(SELECT jsonb_agg(to_jsonb(p) ORDER BY role_id,capability) FROM public.role_permissions p),'routes',(SELECT jsonb_agg(to_jsonb(p) ORDER BY route_id,version) FROM public.file_storage_route_revisions p),'approvals',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.approval_requests p)) snapshot",before=(await f.pg.query(snapshot)).rows;
  const funcs="SELECT oid,proowner,proacl,pg_get_functiondef(oid) definition FROM pg_proc WHERE oid='public.valid_file_pdf_evidence(jsonb)'::regprocedure",unsigned=(await f.pg.query(funcs)).rows,acl="SELECT oid,proowner,proacl FROM pg_proc WHERE oid=ANY(ARRAY['public.record_signature_evidence_inspection(uuid,uuid,uuid,text,text,jsonb)'::regprocedure,'public.file_storage_route_definition_valid(jsonb)'::regprocedure]) ORDER BY oid",oldAcl=(await f.pg.query(acl)).rows;
  const d={name:'Old reviewed ordinary PDF policy',translations:{},enabled:true,sourceTargetId:'a'.repeat(64),destinationTargetId:'b'.repeat(64),maximumBytes:10000,serving:{enabled:true,allowedMimeTypes:['application/pdf'],maximumLinkSeconds:30}},valid=async(value:unknown)=>(await f.pg.query<{valid:boolean}>('SELECT public.file_storage_route_definition_valid($1::jsonb) valid',[JSON.stringify(value)])).rows[0].valid;
  assert.equal(await valid(d),true);assert.equal(await valid({...d,serving:{...d.serving,signedEvidence:true}}),false);
  await f.pg.exec(await readFile(new URL('../db/migrations/209_signature_evidence_downloads.sql',import.meta.url),'utf8'));
  assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,209);assert.deepEqual((await f.pg.query(snapshot)).rows,before);assert.deepEqual((await f.pg.query(funcs)).rows,unsigned);assert.deepEqual((await f.pg.query(acl)).rows,oldAcl);
  assert.equal(await valid(d),true);for(const signedEvidence of [true,false])assert.equal(await valid({...d,serving:{...d.serving,signedEvidence}}),true);for(const signedEvidence of ['true',null,{},0])assert.equal(await valid({...d,serving:{...d.serving,signedEvidence}}),false);
  assert.equal((await f.pg.query('SELECT * FROM public.signature_evidence_download_grants')).rows.length,0);
  for(const role of ['kavosh_signature_evidence_worker','kavosh_signature_completion_worker','kavosh_file_worker','kavosh_identity','kavosh_delivery']){
   await f.pg.exec('SET ROLE '+role);try{await assert.rejects(f.pg.query('SELECT public.signature_evidence_download_source($1,$2,$3)',[randomUUID(),'document',randomUUID()]),/permission denied/i);await assert.rejects(f.pg.query('SELECT * FROM public.signature_evidence_download_grants'),/permission denied/i);}finally{await f.pg.exec('RESET ROLE');}
  }
  await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);assert.equal((await f.pg.query('SELECT public.signature_evidence_download_source($1,$2,$3) source',[randomUUID(),'document',randomUUID()])).rows[0].source,null);await assert.rejects(f.pg.query('SELECT result FROM public.signature_evidence_inspections'),/permission denied/i);await assert.rejects(f.pg.query('INSERT INTO public.signature_evidence_download_grants(academy_id,id,evidence_id,kind,route_id,created_by,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[f.a,randomUUID(),randomUUID(),'document',randomUUID(),f.actors.master.person,randomUUID()]),/SIGNATURE_EVIDENCE_DOWNLOAD_NOT_READY/);}finally{await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});
