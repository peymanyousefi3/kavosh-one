import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { testDatabase } from './database.ts';
import { createApi } from '../src/core/api.ts';
import { business } from '../src/modules/business.ts';
import type { Capability } from '../src/core/policy.ts';
import { mintToken,hashToken } from '../src/core/tokens.ts';
import type { Database } from '../src/core/database.ts';
import type { R2UploadConnections,R2DownloadConnections } from '../src/integrations/r2-config.ts';
import type { PayrollPrivateVault } from '../src/core/payroll-private-data.ts';

export async function operationsFixture(options:{botCredentialSecret?:string;connections?:R2UploadConnections;downloadConnections?:R2DownloadConnections;throughSchema?:number;invitationSecret?:string;payrollPrivateVault?:()=>PayrollPrivateVault;studentCareVault?:()=>PayrollPrivateVault}={}) {
  const pg=await testDatabase();
  try {
    for(const file of (await readdir(new URL('../db/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')&&(options.throughSchema===undefined||Number.parseInt(n,10)<=options.throughSchema)).sort())
      await pg.exec(await readFile(new URL('../db/migrations/'+file,import.meta.url),'utf8'));
    const a=randomUUID(),b=randomUUID(),hub=randomUUID(),otherHub=randomUUID(),foreignHub=randomUUID();
    const actors=Object.fromEntries(['master','manager','staff','peer','foreignMaster'].map(key=>[key,{person:randomUUID(),user:randomUUID(),session:randomUUID()}]));
    const managerRole=randomUUID(),policyRole=randomUUID(),staffRole=randomUUID(),bot=randomUUID(),credential=randomUUID(),token=mintToken(),systemRole=randomUUID();
    const allCaps=(await pg.query<{name:Capability}>('SELECT name FROM public.capability_catalog ORDER BY name')).rows.map(r=>r.name);
    await pg.exec('BEGIN');
    for(const [academy,who] of [[a,'master'],[b,'foreignMaster']])await pg.query("INSERT INTO public.academies(id,name,status,master_person_id) VALUES($1,'Synthetic academy','active',$2)",[academy,actors[who].person]);
    for(const [academy,id] of [[a,hub],[a,otherHub],[b,foreignHub]])await pg.query("INSERT INTO public.hubs VALUES($1,$2,'Synthetic hub','Toronto','CA')",[academy,id]);
    let index=0;
    for(const [name,actor] of Object.entries(actors)) {
      const academy=name==='foreignMaster'?b:a,master=name==='master'||name==='foreignMaster';
      const phone='+1647555'+String(++index).padStart(4,'0');
      await pg.query(`INSERT INTO identity."user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","mfaRequired") VALUES($1,'Synthetic person',$2,true,$3,true,$4)`,[actor.user,name+'@example.test',phone,master]);
      await pg.query(`INSERT INTO identity.session(id,token,"userId","expiresAt","updatedAt","mfaVerified") VALUES($1,$2,$3,now()+interval '1 day',now(),true)`,[actor.session,'synthetic-session-'+randomUUID(),actor.user]);
      const location=master?null:name==='peer'?otherHub:hub;
      await pg.query(`INSERT INTO public.people(academy_id,id,kind,name,email,hub_id,auth_user_id) VALUES($1,$2,'human','Synthetic person',$3,$4,$5)`,[academy,actor.person,name+'@example.test',location,actor.user]);
    }
    await pg.query('UPDATE public.people SET supervisor_person_id=$1 WHERE id=$2',[actors.manager.person,actors.staff.person]);
    await pg.query("INSERT INTO public.people(academy_id,id,kind,name,hub_id,supervisor_person_id) VALUES($1,$2,'bot','Synthetic agent',$3,$4)",[a,bot,hub,actors.manager.person]);
    for(const [id,name] of [[managerRole,'Manager'],[policyRole,'Policy editor'],[staffRole,'Read-only staff'],[systemRole,'Academy master']])
      await pg.query('INSERT INTO public.roles(academy_id,id,name,system_role) VALUES($1,$2,$3,$4)',[a,id,name,id===systemRole]);
    for(const cap of ['people.view','people.edit','hubs.view','access.view','access.edit','approvals.view','approvals.review'])
      await pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[a,managerRole,cap]);
    for(const cap of ['roles.view','roles.edit'])await pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[a,policyRole,cap]);
    await pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'people.view','allow')",[a,staffRole]);
    for(const [person,roleId,allHubs,hubs] of [[actors.manager.person,managerRole,false,[hub]],[actors.manager.person,policyRole,true,[]],
      [actors.staff.person,staffRole,false,[hub]],[actors.peer.person,managerRole,false,[otherHub]],[bot,managerRole,false,[hub]],[bot,policyRole,true,[]]] as [string,string,boolean,string[]][]) {
      const id=randomUUID();await pg.query('INSERT INTO public.role_assignments VALUES($1,$2,$3,$4,$5)',[a,id,person,roleId,allHubs]);
      for(const h of hubs)await pg.query('INSERT INTO public.assignment_hubs VALUES($1,$2,$3)',[a,id,h]);
    }
    await pg.query("INSERT INTO auth_private.credentials(id,academy_id,person_id,token_hash,capabilities,all_hubs,expires_at) VALUES($1,$2,$3,$4,$5,true,now()+interval '1 day')",[credential,a,bot,hashToken(token),allCaps]);
    await pg.exec('COMMIT');
    // Shared reference survives higher-level fixture spreads. The legacy
    // credential/token fields below still identify the original seeded key.
    const botAuth={credentialId:credential,token};
    const baseDatabase:Database=pg.runtime??{async connect(){await pg.exec('SET ROLE kavosh_runtime');return {
      async query<Row>(sql:string,params?:unknown[]){const result=await pg.query<Row>(sql,params);return {rows:result.rows,rowCount:result.affectedRows};},release(){}};}};
    const metrics={businessQueries:0,exclusivePolicyLocks:0,sharedPolicyLocks:0,queryFailures:[] as {sqlState:string;phase:string;elapsedMs:number}[]};
    const database:Database={async connect(){const connection=await baseDatabase.connect();return {
      async query<Row>(sql:string,params?:unknown[]){metrics.businessQueries++;if(sql.includes('pg_advisory_xact_lock(hashtextextended($1,8))'))metrics.exclusivePolicyLocks++;if(sql.includes('pg_advisory_xact_lock_shared(hashtextextended($1,8))'))metrics.sharedPolicyLocks++;
        const started=performance.now();try{return await connection.query<Row>(sql,params);}catch(error){
          const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
          if(metrics.queryFailures.length<200)metrics.queryFailures.push({sqlState:/^[0-9A-Z]{5}$/.test(code)?code:'UNKNOWN',phase:sql.startsWith('WITH selected AS MATERIALIZED')?'financial_report':'operation',elapsedMs:Math.ceil(performance.now()-started)});throw error;
        }},
      release(destroy?:boolean){connection.release(destroy);}
    };}};
    // The injected resolver is test-only. Real session cryptography is exercised
    // by identity.test.ts; SQL still validates these actual stored human sessions.
    const api=createApi(database,async request=>{
      const actor=actors[request.headers.get('x-test-actor')??''];
      return actor?{userId:actor.user,sessionId:actor.session,academyId:request.headers.get('x-academy-id')??a}:null;
    },ctx=>business(ctx,options.connections,options.downloadConnections,{botCredentialSecret:options.botCredentialSecret,invitationSecret:options.invitationSecret,payrollPrivateVault:options.payrollPrivateVault,studentCareVault:options.studentCareVault}));
    async function request(path:string,body?:unknown,as='master',options:{key?:string;academy?:string;method?:string;bearer?:string}={}) {
      try {
        const response=await api(new Request('https://academy.example/api/v1/'+path,{method:options.method??(body===undefined?'GET':'POST'),headers:{
          'content-type':'application/json','idempotency-key':options.key??randomUUID(),'x-test-actor':as,'x-academy-id':options.academy??a,
          ...(as==='bot'?{authorization:'Bearer '+(options.bearer??botAuth.token)}:{cookie:'synthetic-only-resolver-cookie'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),path.split('?')[0]);
        return {response,body:response.headers.get('content-type')?.startsWith('text/csv')?Buffer.from(await response.arrayBuffer()).toString('utf8'):await response.json()};
      // Native requests use their own role-resetting pool, not the fixture's
      // admin client. Only the single-engine embedded path shares its role.
      }finally{if(!pg.runtime)await pg.exec('RESET ROLE');}
    }
    const roleInput={name:'New viewer',description:'Synthetic configurable preset',permissions:[{capability:'people.view',effect:'allow'}]};
    async function refreshBotCredential(){
      // Test arrangement only:owner changes must first invalidate the old key.
      // Seed a genuinely new key/id afterward,never move an old creation date
      // forward or disable the native cutoff to make business tests pass.
      assert.equal((await request('people',undefined,'bot')).response.status,401,'Refresh only after the previous fixture key has become invalid');
      const next={credentialId:randomUUID(),token:mintToken()};await pg.exec('BEGIN');try{
        await pg.query('INSERT INTO auth_private.credentials(id,academy_id,person_id,token_hash,capabilities,all_hubs,expires_at,created_at) SELECT $1,academy_id,person_id,$2,capabilities,all_hubs,expires_at,clock_timestamp() FROM auth_private.credentials WHERE id=$3',[next.credentialId,hashToken(next.token),botAuth.credentialId]);
        await pg.query('INSERT INTO auth_private.credential_hubs(credential_id,academy_id,hub_id) SELECT $1,academy_id,hub_id FROM auth_private.credential_hubs WHERE credential_id=$2',[next.credentialId,botAuth.credentialId]);
        await pg.query('UPDATE auth_private.credentials SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id=$1',[botAuth.credentialId]);await pg.exec('COMMIT');
      }catch(error){await pg.exec('ROLLBACK');throw error;}Object.assign(botAuth,next);
    }
    async function newRole(name='New viewer') {
      const result=await request('roles',{...roleInput,name});assert.equal(result.response.status,201);return result.body.data;
    }
    async function proposal(name='Proposed viewer',as='manager') {
      const result=await request('roles',{...roleInput,name},as);assert.equal(result.response.status,202);return result.body.approval;
    }
    async function approve(id:string,as='master',expectedVersion=1){return request('approvals/'+id+'/decide',{expectedVersion,decision:'approve',reason:'Reviewed exact proposal and authority'},as);}
    return {pg,a,b,hub,otherHub,foreignHub,actors,managerRole,policyRole,staffRole,systemRole,bot,credential,token,botAuth,refreshBotCredential,request,newRole,proposal,approve,roleInput,metrics};
  }catch(error){await pg.close();throw error;}
}
