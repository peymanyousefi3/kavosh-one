import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {invoiceFixture} from './invoice-fixture.ts';
import {createPlatformApi,assertPlatformRole} from '../src/platform/api.ts';
import {upgradeToCurrent} from './migration-upgrade.ts';
import type {Database} from '../src/core/database.ts';

async function fixture(options:{throughSchema?:number}={}){
 const f=await invoiceFixture(options);try{
  const owner=f.actors.master;await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Synthetic access oversight']);
  const role=await f.made('roles',{name:'PRIVATE configured oversight role',description:'PRIVATE role description',permissions:[{capability:'people.view',effect:'allow'},{capability:'people.edit',effect:'deny'}]});
  const geo=(await f.pg.query<{country:string;region:string;city:string}>('SELECT k.id country,r.id region,c.id city FROM public.countries k JOIN public.regions r ON r.academy_id=k.academy_id AND r.country_id=k.id JOIN public.cities c ON c.academy_id=r.academy_id AND c.region_id=r.id WHERE k.academy_id=$1',[f.a])).rows[0];
  const assigned=await f.request('people/'+f.actors.staff.person+'/access',{expectedVersion:1,assignments:[{roleId:role.id,allHubs:false,hubIds:[f.hub],classIds:[f.c.id],personIds:[f.student.id],countryIds:[geo.country],regionIds:[geo.region],cityIds:[geo.city]}]});assert.equal(assigned.response.status,200,JSON.stringify(assigned.body));
  const assignment=(await f.pg.query<{id:string}>('SELECT id FROM public.role_assignments WHERE academy_id=$1 AND person_id=$2 AND role_id=$3',[f.a,f.actors.staff.person,role.id])).rows[0];
  await f.pg.query("INSERT INTO public.roles(academy_id,id,name) VALUES($1,$2,'FOREIGN_SAME_ID_ROLE')",[f.b,role.id]);await f.pg.query("INSERT INTO public.role_permissions(academy_id,role_id,capability,effect) VALUES($1,$2,'hubs.edit','allow')",[f.b,role.id]);await f.pg.query('INSERT INTO public.role_assignments(academy_id,id,person_id,role_id,all_hubs) VALUES($1,$2,$3,$4,true)',[f.b,assignment.id,f.actors.foreignMaster.person,role.id]);
  const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_platform_service');return c;}};
  const api=createPlatformApi(database,async r=>{const actor=f.actors[r.headers.get('x-test-actor')??''];return actor?{userId:actor.user,sessionId:actor.session}:null;},true);
  const request=async(collection:string,options:{academy?:string;actor?:string;query?:string;purpose?:string|null;method?:string;bearer?:boolean}={})=>{
   const path='academies/'+(options.academy??f.a)+'/records/'+collection,headers:Record<string,string>={'x-test-actor':options.actor??'master'};if(options.purpose!==null)headers['x-access-purpose']=options.purpose??'PRIVATE access oversight purpose';if(options.bearer)headers.authorization='Bearer synthetic';
   try{const response=await api(new Request('https://example.test/api/platform/v1/'+path+(options.query??''),{method:options.method??'GET',headers}),path);return{response,body:await response.json()};}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
  };
  return {...f,owner,role,geo,assignment,database,ownerRequest:request};
 }catch(error){await f.pg.close();throw error;}
}
const tables=['people','roles','role_permissions','role_assignments','assignment_hubs','assignment_classes','assignment_people','assignment_countries','assignment_regions','assignment_cities','audit_events','outbox_events'];
async function snapshot(f:Awaited<ReturnType<typeof fixture>>){const rows=[];for(const t of tables)rows.push((await f.pg.query('SELECT to_jsonb(r) row FROM public.'+t+' r ORDER BY to_jsonb(r)::text')).rows);return rows;}
test('platform owner reads complete configured grants and all six scope types with explicit school isolation and no impersonation',async()=>{
 const f=await fixture();try{
  const before=await snapshot(f),roles=await f.ownerRequest('roles');assert.equal(roles.response.status,200,JSON.stringify(roles.body));
  const role=roles.body.data.find((r:{id:string})=>r.id===f.role.id);assert.equal(role.name,'PRIVATE configured oversight role');assert.equal(role.description,'PRIVATE role description');assert.equal(role.version,1);assert.equal(role.systemRole,false);assert.deepEqual(role.permissions,[{capability:'people.edit',effect:'deny'},{capability:'people.view',effect:'allow'}]);assert.doesNotMatch(JSON.stringify(roles.body),/FOREIGN_SAME_ID_ROLE|auth_user_id|credentials_valid_after|token_hash|password/);
  const assigned=await f.ownerRequest('role-assignments');assert.equal(assigned.response.status,200,JSON.stringify(assigned.body));assert.deepEqual(assigned.body.data.find((r:{id:string})=>r.id===f.assignment.id),{id:f.assignment.id,personId:f.actors.staff.person,roleId:f.role.id,allHubs:false,hubIds:[f.hub],classIds:[f.c.id],personIds:[f.student.id],countryIds:[f.geo.country],regionIds:[f.geo.region],cityIds:[f.geo.city]});
  const other=await f.ownerRequest('roles',{academy:f.b});assert.equal(other.response.status,200);const foreign=other.body.data.find((r:{id:string})=>r.id===f.role.id);assert.equal(foreign.name,'FOREIGN_SAME_ID_ROLE');assert.deepEqual(foreign.permissions,[{capability:'hubs.edit',effect:'allow'}]);const foreignAssignment=(await f.ownerRequest('role-assignments',{academy:f.b})).body.data.find((r:{id:string})=>r.id===f.assignment.id);assert.equal(foreignAssignment.personId,f.actors.foreignMaster.person);assert.equal(foreignAssignment.allHubs,true);for(const k of ['hubIds','classIds','personIds','countryIds','regionIds','cityIds'])assert.deepEqual(foreignAssignment[k],[]);
  assert.equal(roles.response.headers.get('cache-control'),'no-store');assert.deepEqual(await snapshot(f),before);
  const audit=(await f.pg.query<{reason:string;after_data:any}>("SELECT reason,after_data FROM platform_private.audit_events WHERE action='platform.academy.directory.read'")).rows;assert.equal(audit.length,4);assert.ok(audit.every(r=>r.reason==='PRIVATE access oversight purpose'));assert.doesNotMatch(JSON.stringify(audit.map(r=>r.after_data)),/PRIVATE|people.view|people.edit|FOREIGN|hubIds|personIds/);
 }finally{await f.pg.close();}
});
test('owner access directories preserve keyset pagination,current MFA,private purpose and service-role boundaries',async()=>{
 const f=await fixture();try{
  for(const collection of ['roles','role-assignments']){
   const all=await f.ownerRequest(collection),ids:string[]=[];let after:string|null=null;do{const page=await f.ownerRequest(collection,{query:'?limit=1'+(after?'&after='+after:'')});assert.equal(page.response.status,200);ids.push(...page.body.data.map((r:{id:string})=>r.id));after=page.body.nextCursor;}while(after);assert.deepEqual(ids,all.body.data.map((r:{id:string})=>r.id));assert.equal(new Set(ids).size,ids.length);
   for(const actor of ['staff','manager','foreignMaster'])assert.equal((await f.ownerRequest(collection,{actor})).response.status,403);assert.equal((await f.ownerRequest(collection,{bearer:true})).response.status,401);assert.equal((await f.ownerRequest(collection,{method:'POST'})).response.status,405);
   for(const options of [{purpose:null},{purpose:' '},{query:'?limit=101'},{query:'?limit=1&limit=2'},{query:'?classId='+f.c.id},{query:'?table=identity.user'}])assert.equal((await f.ownerRequest(collection,options)).response.status,400);assert.equal((await f.ownerRequest(collection,{academy:randomUUID()})).response.status,404);
  }
  await f.pg.query('UPDATE identity.session SET "mfaVerified"=false WHERE id=$1',[f.owner.session]);assert.equal((await f.ownerRequest('roles')).response.status,403);
  const connection=await f.database.connect();try{await assertPlatformRole(connection);for(const table of ['roles','role_permissions','role_assignments','assignment_hubs'])await assert.rejects(connection.query('SELECT * FROM public.'+table),/permission denied/);await assert.rejects(connection.query('SELECT platform_private.read_academy_directory($1,$2,$3::jsonb)',[f.owner.user,f.owner.session,JSON.stringify({academyId:f.a,collection:'roles',purpose:'Cannot bypass gateway'})]),/permission denied/);}finally{connection.release();if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 }finally{await f.pg.close();}
});
test('actual420to421 preserves populated roles,all scope rows,financial audit and the original gateway authority',async()=>{
 const f=await fixture({throughSchema:420});try{
  const before=await snapshot(f),sql="SELECT oid,proowner,proacl,prosecdef,proconfig FROM pg_proc WHERE oid IN('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure,'platform_private.read_academy_directory(uuid,uuid,jsonb)'::regprocedure) ORDER BY oid",authority=(await f.pg.query(sql)).rows;await upgradeToCurrent(f.pg);assert.deepEqual(await snapshot(f),before);assert.deepEqual((await f.pg.query(sql)).rows,authority);assert.equal((await f.ownerRequest('roles')).response.status,200);assert.equal((await f.ownerRequest('role-assignments')).response.status,200);assert.deepEqual(await snapshot(f),before);
 }finally{await f.pg.close();}
});
test('owner access disclosure refuses a suppressed private audit instead of returning unlogged permissions',async()=>{
 const f=await fixture();try{
  await f.pg.exec("CREATE FUNCTION platform_private.suppress_directory_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.action='platform.academy.directory.read' THEN RETURN NULL;END IF;RETURN NEW;END$$;CREATE TRIGGER suppress_directory_audit_test BEFORE INSERT ON platform_private.audit_events FOR EACH ROW EXECUTE FUNCTION platform_private.suppress_directory_audit_test()");
  for(const collection of ['roles','role-assignments','people']){const r=await f.ownerRequest(collection);assert.equal(r.response.status,503);assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE|people.view|permissions|FOREIGN/);}assert.equal((await f.pg.query("SELECT * FROM platform_private.audit_events WHERE action='platform.academy.directory.read'")).rows.length,0);
 }finally{await f.pg.close();}
});
test('an oversized real permission page refuses partial disclosure and a smaller page retains every configured grant',async()=>{
 const f=await fixture();try{
  const count=(await f.pg.query<{n:number}>('SELECT count(*)::integer n FROM public.capability_catalog')).rows[0].n,n=Math.ceil(20001/count);assert.ok(n<=99);
  const ids=Array.from({length:n},(_,i)=>'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'));
  await f.pg.query("INSERT INTO public.roles(academy_id,id,name) SELECT $1,x.id,'Synthetic budget role '||x.ordinality FROM unnest($2::uuid[]) WITH ORDINALITY x(id,ordinality)",[f.a,ids]);
  await f.pg.query("INSERT INTO public.role_permissions(academy_id,role_id,capability,effect) SELECT $1,r.id,c.name,'allow' FROM public.roles r CROSS JOIN public.capability_catalog c WHERE r.academy_id=$1 AND r.id=ANY($2::uuid[])",[f.a,ids]);
  const actual=(await f.pg.query<{n:number}>('WITH page AS(SELECT id FROM public.roles WHERE academy_id=$1 ORDER BY id LIMIT 101) SELECT count(*)::integer n FROM public.role_permissions p JOIN page r ON r.id=p.role_id WHERE p.academy_id=$1',[f.a])).rows[0].n;assert.ok(actual>20000);
  const oversized=await f.ownerRequest('roles',{query:'?limit=100'});assert.equal(oversized.response.status,422);assert.deepEqual(oversized.body,{error:{code:'PLATFORM_DIRECTORY_OUTPUT_LIMIT'}});assert.equal((await f.pg.query("SELECT * FROM platform_private.audit_events WHERE action='platform.academy.directory.read'")).rows.length,0);
  const smaller=await f.ownerRequest('roles',{query:'?limit=1'});assert.equal(smaller.response.status,200);assert.equal(smaller.body.data.length,1);assert.equal(smaller.body.data[0].id,ids[0]);assert.equal(smaller.body.data[0].permissions.length,count);assert.equal(smaller.body.nextCursor,ids[0]);assert.equal((await f.pg.query("SELECT count(*)::integer n FROM public.role_permissions WHERE academy_id=$1 AND role_id=ANY($2::uuid[])",[f.a,ids])).rows[0].n,n*count);
 }finally{await f.pg.close();}
});
