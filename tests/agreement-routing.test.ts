import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { agreementRouting } from '../src/integrations/boldsign.ts';
import { migratedTestDatabase } from './database.ts';
import { operationsFixture } from './operations-fixture.ts';
const field={id:'Signature1',fieldType:'Signature',isRequired:true,pageNumber:1,bounds:{x:0,y:0,width:100,height:20}};
const choice={...field,id:'ProfileChoice',fieldType:'CheckBox',isRequired:false,consentPurpose:'public_profile'};
const v1={version:1,role:'legal_signer',fields:[field]},v2={...v1,version:2,fields:[field,choice]};
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
