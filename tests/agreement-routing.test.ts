import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { agreementRouting } from '../src/integrations/boldsign.ts';
import { migratedTestDatabase } from './database.ts';
import { operationsFixture } from './operations-fixture.ts';
import { observeProfileConsentChoices } from '../src/integrations/boldsign-completion.ts';
const field={id:'Signature1',fieldType:'Signature',isRequired:true,pageNumber:1,bounds:{x:0,y:0,width:100,height:20}};
const choice={...field,id:'ProfileChoice',fieldType:'CheckBox',isRequired:false,consentPurpose:'public_profile'};
const v1={version:1,role:'legal_signer',fields:[field]},v2={...v1,version:2,fields:[field,choice]};
test('native consent evidence agrees with application inspection and never infers a selected choice from missing,locked,required or ambiguous fields',async()=>{
 const db=await migratedTestDatabase();try{
  const original=[{id:choice.id,pageNumber:choice.pageNumber,bounds:choice.bounds,purpose:'public_profile' as const}],reported={id:choice.id,type:'checkbox',pageNumber:choice.pageNumber,bounds:choice.bounds,isRequired:false,isReadOnly:false,value:'on'};
  const cases=[undefined,[],[reported],[{...reported,value:'off'}],[reported,reported],
   ...[{value:true},{value:'true'},{value:1},{value:'ON'},{value:null},{value:undefined},{isRequired:true},{isRequired:'false'},{isRequired:undefined},{isReadOnly:true},{isReadOnly:undefined},{type:'signature'},{id:'AnotherChoice'},{pageNumber:2},{bounds:{...choice.bounds,x:1}},{bounds:undefined}].map(patch=>[{...reported,...patch}])];
  for(const fields of cases){const expected=observeProfileConsentChoices(original,fields);const actual=(await db.query<{choices:unknown}>('SELECT public.observe_profile_consent_choices($1::jsonb,$2::jsonb) choices',[JSON.stringify({consentFields:original}),JSON.stringify({signerDetails:[{formFields:fields}]})])).rows[0].choices;assert.deepEqual(actual,expected,JSON.stringify(fields));}
  assert.deepEqual((await db.query('SELECT public.observe_profile_consent_choices($1::jsonb,$2::jsonb) choices',[JSON.stringify({}),JSON.stringify({signerDetails:[{formFields:[reported]}]})])).rows[0].choices,[]);
  const two=[...original,{...original[0],id:'MembersChoice',purpose:'verified_member_profile' as const}],fields=[reported,{...reported,id:'MembersChoice',value:'off'}];
  assert.deepEqual((await db.query('SELECT public.observe_profile_consent_choices($1::jsonb,$2::jsonb) choices',[JSON.stringify({consentFields:two}),JSON.stringify({signerDetails:[{formFields:fields}]})])).rows[0].choices,[{purpose:'public_profile',fieldId:choice.id,choice:'selected'},{purpose:'verified_member_profile',fieldId:'MembersChoice',choice:'declined'}]);
  for(const role of ['kavosh_runtime','kavosh_signature_completion_worker','kavosh_public_profile_service']){await db.exec('SET ROLE '+role);try{await assert.rejects(db.query('SELECT public.observe_profile_consent_choices($1::jsonb,$2::jsonb)',[JSON.stringify({consentFields:original}),'{}']),/permission denied/);}finally{await db.exec('RESET ROLE');}}
 }finally{await db.close();}
});
test('actual321to322 upgrade preserves original completion ownership,ACLs and existing history without manufacturing consent',async()=>{
 const f=await operationsFixture({throughSchema:321});try{
  const identity="SELECT oid,proowner,proacl::text,proconfig,prosecdef FROM pg_proc WHERE oid IN('public.signature_completion_source(uuid,uuid)'::regprocedure,'public.record_signature_completion_evidence(uuid,uuid,text,text,jsonb)'::regprocedure) ORDER BY oid",before=(await f.pg.query(identity)).rows;
  const history="SELECT jsonb_build_object('bindings',(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM public.agreement_content_bindings b),'publications',(SELECT jsonb_agg(to_jsonb(p) ORDER BY profile_id,version) FROM public.profile_publication_changes p),'people',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.people p)) snapshot",original=(await f.pg.query(history)).rows;
  await f.pg.exec(await readFile(new URL('../db/migrations/322_profile_consent_evidence.sql',import.meta.url),'utf8'));
  assert.deepEqual((await f.pg.query(identity)).rows,before);assert.deepEqual((await f.pg.query(history)).rows,original);
  assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.signature_completion_evidence')).rows[0].n,0);
 }finally{await f.pg.close();}
});
test('native and application routing validators agree on optional choices, strict geometry, required signature and malformed inputs',async()=>{
 const db=await migratedTestDatabase();try{
  const cases:unknown[]=[v1,v2,{...v2,fields:[field,choice,{...choice,id:'MembersChoice',consentPurpose:'verified_member_profile'}]},null,{},[],false,'private',
   {...v2,version:1},{...v2,version:null},{...v2,version:'2'},{...v2,version:3},{...v2,fields:[field]},{...v2,fields:[choice]},
   ...[null,[],false,{},1].map(fields=>({...v2,fields})),...['fields','version','role'].map(key=>Object.fromEntries(Object.entries(v2).filter(([k])=>k!==key))),
   ...[{isRequired:true},{isRequired:null},{isRequired:'false'},{consentPurpose:null},{consentPurpose:'all_data'},{fieldType:'checkbox'},{fieldType:'Signature'},{value:'on'},{isReadOnly:false},
    {id:field.id},{pageNumber:0},{pageNumber:1.5},{pageNumber:1001},{bounds:null},{bounds:{...field.bounds,width:0}},{bounds:{...field.bounds,width:'100'}},{bounds:{...field.bounds,x:-1}},{bounds:{...field.bounds,extra:1}}].map(patch=>({...v2,fields:[field,{...choice,...patch}]})),
   {...v2,fields:[field,choice,{...choice,id:'AnotherChoice'}]},{...v2,fields:[{...field,isRequired:false},choice]},{...v2,extra:true},
   {...v2,fields:[field,{...choice,consentPurpose:undefined}]},{...v2,fields:[field,{...choice,id:'x'.repeat(201)}]},
   {...v2,fields:Array.from({length:101},(_,n)=>({...field,id:'Signature'+n}))}];
  for(const routing of cases){const expected=agreementRouting.safeParse(routing).success;const actual=(await db.query<{valid:boolean}>('SELECT public.agreement_routing_valid($1::jsonb) valid',[JSON.stringify(routing)])).rows[0].valid;assert.equal(actual,expected,JSON.stringify(routing));}
  await db.exec('SET ROLE kavosh_runtime');try{assert.equal((await db.query<{valid:boolean}>('SELECT public.agreement_routing_valid($1::jsonb) valid',[JSON.stringify(v2)])).rows[0].valid,true);}finally{await db.exec('RESET ROLE');}
  assert.equal((await db.query<{allowed:boolean}>("SELECT has_function_privilege('kavosh_public_profile_service','public.agreement_routing_valid(jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
 }finally{await db.close();}
});
test('actual schema320 upgrade changes only enrollment routing guard and preserves function privileges and work routing security',async()=>{
 const f=await operationsFixture({throughSchema:320});try{
  const snapshot=async()=>(await f.pg.query<{oid:number;proowner:number;proacl:string|null;proconfig:unknown;prosecdef:boolean;definition:string}>("SELECT p.oid,p.proowner,p.proacl::text,p.proconfig,p.prosecdef,pg_get_functiondef(p.oid) definition FROM pg_proc p WHERE p.oid='public.guard_agreement_content_binding()'::regprocedure")).rows[0];
  const before=await snapshot(),work=(await f.pg.query("SELECT pg_get_functiondef('public.work_agreement_routing_valid(jsonb)'::regprocedure) definition")).rows[0];
  await f.pg.exec(await readFile(new URL('../db/migrations/321_optional_profile_consent_routing.sql',import.meta.url),'utf8'));
  const after=await snapshot();assert.deepEqual({...after,definition:null},{...before,definition:null});
  assert.equal(after.definition.split(' IF NOT public.agreement_routing_valid(NEW.routing)')[0],before.definition.split(' IF jsonb_typeof(NEW.routing)')[0]);
  assert.deepEqual((await f.pg.query("SELECT pg_get_functiondef('public.work_agreement_routing_valid(jsonb)'::regprocedure) definition")).rows[0],work);
  assert.equal((await f.pg.query<{valid:boolean}>('SELECT public.agreement_routing_valid($1::jsonb) valid',[JSON.stringify(v1)])).rows[0].valid,true);
 }finally{await f.pg.close();}
});
