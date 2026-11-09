import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes,randomUUID,createHmac,createHash } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { testDatabase } from './database.ts';
import { createIdentity,type Delivery } from '../src/auth/config.ts';
import { IdentityStore } from '../src/auth/store.ts';
import { identityGateway,verifiedProxyIp,humanResolver,platformHumanResolver } from '../src/auth/gateway.ts';
import { queuedDelivery,deliverOne,providerDelivery } from '../src/auth/delivery.ts';
import { MessageDeliveryError } from '../src/integrations/message-delivery.ts';
import { createApi } from '../src/core/api.ts';
import { business as businessRoutes } from '../src/modules/business.ts';
import type { Database } from '../src/core/database.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import autocannon from 'autocannon';
import { hashPassword } from 'better-auth/crypto';
import { createPlatformApi } from '../src/platform/api.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';

const origin='https://academy.example';
const config={origin,production:false,secret:'synthetic-test-identity-secret-not-for-production-000000'};
const password='Synthetic correct horse battery 123!';
type Jar=Map<string,string>;
// Independent RFC 6238 SHA-1 calculation, only for testing authenticator interop.
function totp(secret:string,time=Date.now()) {
  let bits=0,value=0;const bytes:number[]=[];
  for(const character of secret.replaceAll('=','')) {
    const n='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character.toUpperCase());assert.ok(n>=0);
    value=(value<<5)|n;bits+=5;
    if(bits>=8){bits-=8;bytes.push((value>>>bits)&255);}
  }
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(time/30000)));
  const digest=createHmac('sha1',Buffer.from(bytes)).update(counter).digest(),offset=digest.at(-1)!&15;
  return String((digest.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
async function fixture(options:{throughSchema?:number}={}) {
  const pg=await testDatabase();
  const directory=new URL('../db/migrations/',import.meta.url);
  for(const file of (await readdir(directory)).filter(n=>n.endsWith('.sql')&&(options.throughSchema===undefined||Number.parseInt(n,10)<=options.throughSchema)).sort())await pg.exec(await readFile(new URL(file,directory),'utf8'));
  const db=pg.identityDb(),store=new IdentityStore(db,config.secret);
  async function admin<T>(fn:()=>Promise<T>){await pg.exec('RESET ROLE');try{return await fn();}finally{if(!pg.runtime)await pg.exec('SET ROLE kavosh_identity');}}
  const messages:{emails:{to:string;text:string}[];sms:{to:string;text:string}[]}={emails:[],sms:[]};
  const delivery:Delivery={async email(message){messages.emails.push(message);},async sms(message){messages.sms.push(message);}};
  const auth=createIdentity(db,store,delivery,config),gateway=identityGateway(auth,store,config,delivery);
  if(!pg.runtime)await pg.exec('SET ROLE kavosh_identity');
  async function request(path:string,input?:unknown,jar:Jar=new Map(),headers:Record<string,string>={}) {
    const result=await gateway(new Request(origin+'/api/auth'+path,{method:input===undefined?'GET':'POST',
      headers:{origin,'content-type':'application/json',cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...headers},
      ...(input===undefined?{}:{body:JSON.stringify(input)})}));
    for(const value of result.headers.getSetCookie()) {
      const [pair]=value.split(';'),index=pair.indexOf('='),key=pair.slice(0,index),valuePart=pair.slice(index+1);
      if(/max-age=0/i.test(value)||!valuePart)jar.delete(key);else jar.set(key,valuePart);
      assert.match(value,/httponly/i);assert.match(value,/secure/i);assert.match(value,/samesite=lax/i);assert.doesNotMatch(value,/domain=/i);
    }
    assert.equal(result.headers.get('cache-control'),'no-store');
    const body=result.headers.get('content-type')?.includes('application/json')?await result.json():null;
    return {response:result,body};
  }
  let index=0;
  async function invitation(master=false,academy?:string) {
    const email=`synthetic${++index}@example.test`,person=randomUUID(),a=academy??randomUUID(),token='kvi_'+randomBytes(32).toString('base64url');
    await admin(async()=>{
      await pg.exec('BEGIN');
      if(!academy){
        const actualMaster=master?person:randomUUID();
        await pg.query("INSERT INTO public.academies(id,name,master_person_id,status) VALUES($1,'Synthetic academy',$2,$3)",[a,actualMaster,master?'provisioning':'active']);
        if(!master)await pg.query("INSERT INTO public.people(academy_id,id,kind,name,email,status) VALUES($1,$2,'human','Synthetic unregistered master','unregistered@example.test','pending')",[a,actualMaster]);
      }
      await pg.query("INSERT INTO public.people(academy_id,id,kind,name,email,status) VALUES($1,$2,'human','Synthetic person',$3,'pending')",[a,person,email]);
      await pg.query("INSERT INTO identity.invites VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',NULL)",[store.digest(token),a,person,email,master]);
      await pg.exec('COMMIT');
    });
    return {email,person,academy:a,token,phone:`+1647555${String(index).padStart(4,'0')}`,jar:new Map<string,string>(),id:''};
  }
  async function signup(user:Awaited<ReturnType<typeof invitation>>) {
    const result=await request('/sign-up/email',{name:'Synthetic person',email:user.email,password},user.jar,{'x-kavosh-invitation':user.token});
    assert.equal(result.response.status,200,'invited signup must work');
    assert.equal(result.body.token,undefined);user.id=result.body.user.id;
  }
  async function verifyEmail(user:Awaited<ReturnType<typeof invitation>>) {
    const message=messages.emails.findLast(m=>m.to===user.email)!;
    const link=message.text.match(/https:\/\/[^\s]+/)![0];
    assert.equal(new URL(link).origin,origin);
    const result=await request(new URL(link).pathname.slice('/api/auth'.length)+new URL(link).search,undefined,user.jar);
    assert.ok([200,302,303,307].includes(result.response.status),'email link must verify, status='+result.response.status+' code='+JSON.stringify(result.body));
  }
  async function signin(user:Awaited<ReturnType<typeof invitation>>,jar=user.jar,pass=password){return request('/sign-in/email',{email:user.email,password:pass},jar);}
  function otp(user:Awaited<ReturnType<typeof invitation>>){return messages.sms.findLast(m=>m.to===user.phone)!.text.match(/\b\d{6}\b/)![0];}
  async function phone(user:Awaited<ReturnType<typeof invitation>>) {
    assert.equal((await request('/phone-number/send-otp',{phoneNumber:user.phone},user.jar)).response.status,200);
    const result=await request('/phone-number/verify',{phoneNumber:user.phone,code:otp(user)},user.jar);
    assert.equal(result.response.status,200,'phone verification must work');
    assert.equal(result.body.token,undefined);
    assert.equal((await request('/get-session',undefined,user.jar)).body,null,'phone verification must invalidate old session');
  }
  async function mfa(user:Awaited<ReturnType<typeof invitation>>,jar=user.jar,trustDevice=false){
    assert.equal((await request('/two-factor/send-otp',{trustDevice},jar)).response.status,200);
    const result=await request('/two-factor/verify-otp',{code:otp(user),trustDevice},jar);
    assert.equal(result.response.status,200,'MFA OTP must work');return result;
  }
  const database:Database=pg.runtime??{async connect(){await pg.exec('SET ROLE kavosh_runtime');return {
    async query<Row>(sql:string,params?:unknown[]){const result=await pg.query<Row>(sql,params);return {rows:result.rows,rowCount:result.affectedRows};},release(){}};}};
  const api=createApi(database,humanResolver(auth,store,config),ctx=>businessRoutes(ctx,undefined,undefined,{invitationSecret:config.secret}));
  const platformDatabase:Database={async connect(){
    if(pg.runtime){const c=await pg.runtime.connect();await c.query('SET ROLE kavosh_platform_service');return c;}
    await pg.exec('SET ROLE kavosh_platform_service');return{query:async<Row>(sql:string,params?:unknown[])=>pg.query<Row>(sql,params),release(){}};
  }};
  const platformApi=createPlatformApi(platformDatabase,platformHumanResolver(auth,store,config),true,{invitationSecret:config.secret});
  async function platform(user:{jar:Jar},path:string,input?:unknown,key=randomUUID()){
    try{const response=await platformApi(new Request(origin+'/api/platform/v1/'+path,{method:input===undefined?'GET':'POST',headers:{origin,cookie:[...user.jar].map(([k,v])=>k+'='+v).join('; '),'content-type':'application/json','idempotency-key':key},...(input===undefined?{}:{body:JSON.stringify(input)})}),path);return{response,body:await response.json()};}
    finally{if(!pg.runtime)await pg.exec('SET ROLE kavosh_identity');}
  }
  async function business(user:Awaited<ReturnType<typeof invitation>>,path='hubs',input?:unknown,academy=user.academy,headers:Record<string,string>={}){
    try {return await api(new Request(origin+'/api/v1/'+path,{method:input===undefined?'GET':'POST',headers:{origin,
      cookie:[...user.jar].map(([k,v])=>k+'='+v).join('; '),'x-academy-id':academy,'content-type':'application/json','idempotency-key':randomUUID(),...headers},
      ...(input===undefined?{}:{body:JSON.stringify(input)})}),path);}
    finally{if(!pg.runtime)await pg.exec('SET ROLE kavosh_identity');}
  }
  async function close(){await db.destroy();if(pg.runtime)await pg.close();}
  async function worker<T>(fn:(worker:IdentityStore)=>Promise<T>) {
    return admin(async()=>{
      await pg.exec('SET ROLE kavosh_delivery');
      const worker=new IdentityStore(pg.runtime?pg.identityDb('kavosh_delivery'):db,config.secret);
      try{return await fn(worker);}finally{if(pg.runtime)await worker.db.destroy();await pg.exec('RESET ROLE');}
    });
  }
  async function replaceEmail(user:Awaited<ReturnType<typeof invitation>>,target:string){
    const r=await request('/email-change/request',{email:target,password},user.jar);assert.equal(r.response.status,202,JSON.stringify(r.body));
    const current=messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Email change approval code:'))!.text.match(/code: (\d{8})/)![1];assert.equal((await request('/email-change/authorize',{requestId:r.body.requestId,code:current},user.jar)).response.status,202);
    const next=messages.emails.findLast(m=>m.to===target&&m.text.startsWith('New email verification code:'))!.text.match(/code: (\d{8})/)![1];const done=await request('/email-change/confirm',{requestId:r.body.requestId,code:next},user.jar);assert.equal(done.response.status,200,JSON.stringify(done.body));user.email=target;return done;
  }
  return {pg,db,store,admin,worker,messages,delivery,request,invitation,signup,verifyEmail,signin,phone,otp,mfa,replaceEmail,business,platform,close,gateway,api,resolvePlatform:platformHumanResolver(auth,store,config)};
}

test('human identity: real library authentication and protected business access',async t=>{
  const f=await fixture();
  t.beforeEach(async()=>{await f.admin(()=>f.pg.query('DELETE FROM identity.auth_budgets'));});
  try {
    const master=await f.invitation(true),regular=await f.invitation(false,master.academy);
    await t.test('requires invitation, rejects forged verification flags and cross-origin requests',async()=>{
      assert.equal((await f.request('/sign-up/email',{name:'X',email:master.email,password})).response.status,403);
      assert.equal((await f.request('/sign-up/email',{name:'X',email:master.email,password,emailVerified:true},undefined,{'x-kavosh-invitation':master.token})).response.status,400);
      assert.equal((await f.request('/sign-in/email',{email:master.email,password},undefined,{origin:'https://attacker.example'})).response.status,403);
      assert.equal((await f.request('/sign-up/email',{name:'X',email:regular.email,password},undefined,{'x-kavosh-invitation':master.token})).response.status,403);
      assert.equal((await f.request('/sign-in/phone-number',{phoneNumber:master.phone,password})).response.status,404);
    });
    await t.test('email verification required; phone setup bound to authenticated email-verified person',async()=>{
      await f.signup(master);await f.signup(regular);
      assert.equal((await f.signin(master)).response.status,403);
      assert.equal((await f.request('/phone-number/send-otp',{phoneNumber:master.phone})).response.status,401);
      await f.verifyEmail(master);await f.verifyEmail(regular);
      assert.equal((await f.signin(master)).response.status,200);assert.equal((await f.signin(regular)).response.status,200);
      assert.equal((await f.business(master)).status,401);
      assert.equal((await f.request('/accept-invitation',{invitation:master.token},master.jar)).response.status,403);
      assert.equal((await f.request('/phone-number/send-otp',{phoneNumber:master.phone},master.jar)).response.status,200);
      assert.equal((await f.request('/phone-number/verify',{phoneNumber:master.phone,code:f.otp(master)},regular.jar)).response.status,400);
      assert.equal((await f.request('/phone-number/verify',{phoneNumber:master.phone,code:f.otp(master)==='000000'?'111111':'000000'},master.jar)).response.status,400);
      // A new challenge invalidates the earlier code, and only the owner can complete it.
      await f.phone(master);await f.phone(regular);
      await f.admin(async()=>{
        const row=(await f.pg.query<{password:string}>('SELECT password FROM identity.account WHERE "userId"=$1',[master.id])).rows[0];
        assert.notEqual(row.password,password);assert.ok(row.password.length>64,'password must be a salted hash');
      });
    });
    await t.test('master requires MFA on a new device, with no academy access before completion',async()=>{
      const result=await f.signin(master);
      assert.equal(result.response.status,200);assert.equal(result.body.twoFactorRedirect,true);
      assert.equal((await f.business(master)).status,401);
      assert.equal((await f.request('/two-factor/send-otp',{},master.jar)).response.status,200);
      assert.equal((await f.request('/two-factor/verify-otp',{code:f.otp(master)==='000000'?'111111':'000000'},master.jar)).response.status,401);
      const code=f.otp(master);
      assert.equal((await f.request('/two-factor/verify-otp',{code,trustDevice:true},master.jar)).response.status,200);
      assert.equal((await f.request('/two-factor/verify-otp',{code},new Map())).response.status,401);
      const accepted=await f.request('/accept-invitation',{invitation:master.token},master.jar);
      assert.equal(accepted.response.status,200,'verified master must activate academy');
      assert.equal(accepted.body.academyId,master.academy);
      await f.admin(async()=>{
        assert.equal((await f.pg.query<{system_role:boolean}>("SELECT system_role FROM public.roles WHERE academy_id=$1 AND name='Academy master'",[master.academy])).rows[0].system_role,true);
      });
      assert.equal((await f.request('/accept-invitation',{invitation:master.token},master.jar)).response.status,403);
      assert.equal((await f.business(master)).status,200);
      assert.equal((await f.request('/two-factor/disable',{password},master.jar)).response.status,403);
    });
    await t.test('platform resolver reuses real signed session without academy header and rejects forged cookies or cross-origin writes',async()=>{
      const headers={cookie:[...master.jar].map(([k,v])=>k+'='+v).join('; ')};
      const result=await f.resolvePlatform(new Request(origin+'/api/platform/v1/academies',{headers}));
      assert.equal(result?.userId,master.id);assert.ok(result?.sessionId);assert.equal(Object.hasOwn(result!,'academyId'),false);
      assert.equal(await f.resolvePlatform(new Request(origin+'/api/platform/v1/academies',{headers:{cookie:'__Secure-kavosh.session_token=forged'}})),null);
      await assert.rejects(f.resolvePlatform(new Request(origin+'/api/platform/v1/academies',{method:'POST',headers:{...headers,origin:'https://attacker.example'}})),/ORIGIN_REJECTED/);
    });
    await t.test('platform-issued master invitation completes real email phone MFA onboarding without plaintext token persistence',async()=>{
      await f.admin(()=>f.pg.query('SELECT platform_private.register_owner($1,$2)',[master.id,'Verified operator enrollment']));
      const created=await f.platform(master,'academies',{name:'Invited school',masterName:'Invited master',masterEmail:'platform-invited@example.test',reason:'Approved new school'});assert.equal(created.response.status,201,JSON.stringify(created.body));
      const academy=created.body.data.id,key=randomUUID(),path='academies/'+academy+'/master-invitation',input={expectedVersion:1,reason:'Provide private onboarding token'};
      const issued=await f.platform(master,path,input,key);assert.equal(issued.response.status,201,JSON.stringify(issued.body));assert.match(issued.body.data.privateInvitation,/^kvi_[A-Za-z0-9_-]{43}$/);
      assert.deepEqual((await f.platform(master,path,input,key)).body,issued.body);
      const token=issued.body.data.privateInvitation;
      await f.admin(async()=>{
        for(const table of ['platform_private.request_receipts','platform_private.audit_events','identity.invites']){const rows=await f.pg.query('SELECT row_to_json(t)::text AS data FROM '+table+' t');assert.ok(rows.rows.every(r=>!String(r.data).includes(token)));}
        assert.equal((await f.pg.query('SELECT * FROM identity.invites WHERE token_hash=$1 AND academy_id=$2',[f.store.digest(token),academy])).rows.length,1);
      });
      const newcomer={id:'',email:'platform-invited@example.test',person:issued.body.data.masterPersonId,academy,token,phone:'+16475550999',jar:new Map<string,string>()};
      await f.signup(newcomer);await f.verifyEmail(newcomer);await f.signin(newcomer);
      assert.equal((await f.request('/accept-invitation',{invitation:token},newcomer.jar)).response.status,403);
      await f.phone(newcomer);await f.signin(newcomer);assert.equal((await f.business(newcomer)).status,401);
      await f.mfa(newcomer);
      const accepted=await f.request('/accept-invitation',{invitation:token},newcomer.jar);assert.equal(accepted.response.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.academyId,academy);
      assert.equal((await f.business(newcomer)).status,200);
      assert.equal((await f.platform(master,path,input,key)).response.status,409,'completed onboarding must not reissue a cached secret');
      const ordinaryJar=new Map<string,string>();await f.signin(regular,ordinaryJar);assert.equal((await f.platform({jar:ordinaryJar},'academies')).response.status,403);
      assert.equal((await f.request('/sign-out',{},ordinaryJar)).response.status,200);
    });
    await t.test('school invitation completes real ordinary-account verification and preserves preapproved hub-only role access',async()=>{
      const email='school-invited@example.test',hub=(await(await f.business(master,'hubs',{name:'Invited hub',city:'Toronto',countryCode:'CA'})).json()).data.id;
      await f.business(master,'hubs',{name:'Other hub',city:'Toronto',countryCode:'CA'});
      const person=(await(await f.business(master,'people',{name:'Invited ordinary person',email,hubId:hub})).json()).data.id;
      const role=await f.business(master,'roles',{name:'Invited hub reader',description:'Scoped invitation fixture',permissions:[{capability:'hubs.view',effect:'allow'}]});assert.equal(role.status,201);const roleId=(await role.json()).data.id;
      const priorAccess=(await(await f.business(master,'people/'+person+'/access')).json()).data;
      const access=await f.business(master,'people/'+person+'/access',{expectedVersion:priorAccess.version,assignments:[{roleId,allHubs:false,hubIds:[hub]}]});assert.equal(access.status,200);
      const eligible=await f.business(master,'invitations/people/'+person);assert.equal(eligible.status,200);const detail=(await eligible.json()).data;
      const prepared=await f.business(master,'invitations',{personId:person,expectedPersonVersion:detail.version,reason:'Invite preapproved hub reader'});assert.equal(prepared.status,201);const id=(await prepared.json()).data.id;
      const issued=await f.business(master,'invitations/'+id+'/token',{});assert.equal(issued.status,201,await issued.clone().text());const token=(await issued.json()).data.privateInvitation;
      const newcomer={id:'',email,person,academy:master.academy,token,phone:'+16475550998',jar:new Map<string,string>()};
      await f.signup(newcomer);await f.verifyEmail(newcomer);await f.signin(newcomer);assert.equal((await f.business(newcomer)).status,401);
      await f.phone(newcomer);assert.equal((await f.signin(newcomer)).body.twoFactorRedirect,undefined);
      assert.equal((await f.request('/accept-invitation',{invitation:token},newcomer.jar)).response.status,200);
      const hubs=await f.business(newcomer);assert.equal(hubs.status,200);assert.deepEqual((await hubs.json()).data.map((h:{id:string})=>h.id),[hub]);
      assert.equal((await f.business(newcomer,'invitations/'+id+'/token',{})).status,404);
      const completed=(await(await f.business(master,'invitations/'+id)).json()).data;assert.equal(completed.issue.status,'consumed');assert.equal(completed.source_current,false);
    });
    await t.test('human API reuses tenant scope, role denial and audit; master identity cannot transfer',async()=>{
      const created=await f.business(master,'hubs',{name:'Synthetic hub',city:'Toronto',countryCode:'CA'});
      assert.equal(created.status,201);
      assert.equal((await f.business(master,'hubs',undefined,randomUUID())).status,401);
      assert.equal((await f.business(master,'hubs',{name:'Blocked',city:'Toronto',countryCode:'CA'},master.academy,{origin:'https://attacker.example'})).status,403);
      assert.equal((await f.business(master,'hubs',undefined,master.academy,{cookie:'__Secure-kavosh.session_token=forged-cookie'})).status,401);
      assert.equal((await f.business(master,'hubs',undefined,master.academy,{authorization:'Bearer invalid'})).status,401,'invalid bearer must not fall back to a valid cookie');
      await f.signin(regular);
      assert.equal((await f.request('/accept-invitation',{invitation:regular.token},regular.jar)).response.status,200);
      assert.equal((await f.business(regular)).status,403,'membership alone grants no roles');
      await f.admin(async()=>{
        const row=(await f.pg.query<{actor_kind:string;session_id:string;credential_id:string|null}>("SELECT actor_kind,session_id,credential_id FROM public.audit_events WHERE action='hub.created'")).rows[0];
        assert.equal(row.actor_kind,'human');assert.ok(row.session_id);assert.equal(row.credential_id,null);
        await assert.rejects(f.pg.query('UPDATE public.people SET auth_user_id=$1 WHERE id=$2',[regular.id,master.person]),/not transferable/);
      });
    });
    await t.test('trusted device skips extra step; a different device still requires it',async()=>{
      await f.request('/sign-out',{},master.jar);
      assert.equal((await f.signin(master)).body.twoFactorRedirect,undefined);
      assert.equal((await f.business(master)).status,200);
      const fresh=new Map<string,string>();
      assert.equal((await f.signin(master,fresh)).body.twoFactorRedirect,true);
      await f.mfa(master,fresh);
    });
    await t.test('phone codes expire, exhaust attempts, are hashed, and cannot be consumed twice concurrently',async()=>{
      const user=await f.invitation(false,master.academy);await f.signup(user);await f.verifyEmail(user);await f.signin(user);
      assert.equal((await f.request('/phone-number/send-otp',{phoneNumber:user.phone},user.jar)).response.status,200);
      const correct=f.otp(user),wrong=correct==='000000'?'111111':'000000';
      const stored=(await f.store.query<{value:string}>('SELECT value FROM identity.verification WHERE value=$1',[f.store.digest(`phone-otp:${user.phone}:${correct}`)+':0'])).rows;
      assert.equal(stored.length,1,'phone OTP must be keyed-hashed in the database');
      for(let n=0;n<3;n++)assert.equal((await f.request('/phone-number/verify',{phoneNumber:user.phone,code:wrong},user.jar)).response.status,400);
      assert.equal((await f.request('/phone-number/verify',{phoneNumber:user.phone,code:correct},user.jar)).response.status,403);
      await f.request('/phone-number/send-otp',{phoneNumber:user.phone},user.jar);
      const expired=f.otp(user);
      await f.admin(()=>f.pg.query(`UPDATE identity.verification SET "expiresAt"=now()-interval '1 minute' WHERE value=$1`,[f.store.digest(`phone-otp:${user.phone}:${expired}`)+':0']));
      assert.equal((await f.request('/phone-number/verify',{phoneNumber:user.phone,code:expired},user.jar)).response.status,400);
      await f.request('/phone-number/send-otp',{phoneNumber:user.phone},user.jar);
      const current=f.otp(user);
      const results=await Promise.all([f.request('/phone-number/verify',{phoneNumber:user.phone,code:current},user.jar),f.request('/phone-number/verify',{phoneNumber:user.phone,code:current},user.jar)]);
      assert.equal(results.filter(r=>r.response.status===200).length,1);
      assert.ok(results.every(r=>[200,400,401].includes(r.response.status)));
    });
    let backupCodes:string[]=[];
    await t.test('recovery codes encrypted at rest and single use',async()=>{
      const result=await f.request('/two-factor/generate-backup-codes',{password},master.jar);
      assert.equal(result.response.status,200);
      backupCodes=result.body.backupCodes;assert.equal(backupCodes.length,10);
      await f.admin(async()=>{
        const row=(await f.pg.query<{backupCodes:string}>('SELECT "backupCodes" FROM identity."twoFactor" WHERE "userId"=$1',[master.id])).rows[0];
        assert.ok(!row.backupCodes.includes(backupCodes[0]));
      });
      const jar=new Map<string,string>();await f.signin(master,jar);
      assert.equal((await f.request('/two-factor/verify-backup-code',{code:backupCodes[0]},jar)).response.status,200);
      const another=new Map<string,string>();await f.signin(master,another);
      assert.equal((await f.request('/two-factor/verify-backup-code',{code:backupCodes[0]},another)).response.status,401);
    });
    await t.test('password reset is private, single use, revokes sessions and trusted devices, preserves MFA',async()=>{
      const known=await f.request('/request-password-reset',{email:master.email});
      const unknown=await f.request('/request-password-reset',{email:'not-registered@example.test'});
      assert.equal(known.response.status,202);assert.deepEqual(known.body,unknown.body);
      const text=f.messages.emails.findLast(m=>m.to===master.email)!.text;
      const token=new URL(text.match(/https:\/\/[^\s]+/)![0]).hash.slice('#token='.length);
      const newPassword='Synthetic updated password 456!';
      const rows=(await f.store.query<{identifier:string}>('SELECT identifier FROM identity.verification WHERE value=$1',[master.id])).rows;
      assert.ok(rows.every(row=>!row.identifier.includes(token)),'reset bearer secret must not be stored verbatim');
      const racing=await Promise.all([f.request('/reset-password',{token,newPassword}),f.request('/reset-password',{token,newPassword})]);
      assert.deepEqual(racing.map(result=>result.response.status).sort(),[200,400],'only one concurrent reset may consume the token');
      assert.equal((await f.request('/reset-password',{token,newPassword})).response.status,400);
      assert.equal((await f.business(master)).status,401);
      // Reset removes remembered-device grants; an old trusted browser must do MFA again.
      assert.equal((await f.signin(master,master.jar,newPassword)).body.twoFactorRedirect,true);
      assert.equal((await f.signin(master,new Map(),password)).response.status,401);
      await f.mfa(master);
      assert.equal((await f.business(master)).status,200);
      assert.equal((await f.request('/two-factor/disable',{password:newPassword},master.jar)).response.status,403);
      await f.request('/request-password-reset',{email:regular.email});
      const expiredText=f.messages.emails.findLast(m=>m.to===regular.email)!.text;
      const expiredToken=new URL(expiredText.match(/https:\/\/[^\s]+/)![0]).hash.slice('#token='.length);
      await f.admin(()=>f.pg.query(`UPDATE identity.verification SET "expiresAt"=now()-interval '1 minute' WHERE value=$1`,[regular.id]));
      assert.equal((await f.request('/reset-password',{token:expiredToken,newPassword})).response.status,400);
    });
    await t.test('optional MFA, session revocation and password changes remain usable for ordinary accounts',async()=>{
      const fresh=new Map<string,string>();
      assert.equal((await f.signin(regular,fresh)).body.twoFactorRedirect,undefined);
      const sessions=await f.request('/list-sessions',undefined,regular.jar);
      assert.equal(sessions.response.status,200);assert.ok(sessions.body.length>=2);
      assert.ok(sessions.body.every((s:Record<string,unknown>)=>s.token===undefined));
      const own=await f.request('/get-session',undefined,regular.jar);
      const other=await f.request('/get-session',undefined,fresh);
      assert.notEqual(other.body.session.id,own.body.session.id);assert.ok(sessions.body.some((s:{id:string})=>s.id===other.body.session.id));
      assert.equal((await f.request('/revoke-session',{sessionId:other.body.session.id},regular.jar)).response.status,200);
      assert.equal((await f.request('/get-session',undefined,fresh)).body,null);
      assert.equal((await f.request('/get-session',undefined,regular.jar)).body.session.id,own.body.session.id);
      assert.equal((await f.request('/two-factor/enable',{password,method:'otp'},regular.jar)).response.status,200);
      assert.equal((await f.signin(regular)).body.twoFactorRedirect,true);await f.mfa(regular);
      assert.equal((await f.request('/two-factor/disable',{password},regular.jar)).response.status,200);
      assert.equal((await f.signin(regular)).body.twoFactorRedirect,undefined);
      assert.equal((await f.request('/change-password',{currentPassword:password,newPassword:'Synthetic changed password 789!'},regular.jar)).response.status,200);
      assert.equal((await f.request('/get-session',undefined,regular.jar)).body,null);
    });
    await t.test('authenticator app enrollment interoperates with RFC 6238 and failure budget blocks further codes',async()=>{
      assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',59000),'287082');
      const currentPassword='Synthetic changed password 789!';
      await f.signin(regular,regular.jar,currentPassword);
      assert.equal((await f.request('/two-factor/enable',{password:'incorrect password',method:'totp'},regular.jar)).response.status,400);
      assert.ok((await f.request('/get-session',undefined,regular.jar)).body);
      const enrollment=await f.request('/two-factor/enable',{password:currentPassword,method:'totp'},regular.jar);
      assert.equal(enrollment.response.status,200);assert.equal(enrollment.body.backupCodes.length,10);
      const secret=new URL(enrollment.body.totpURI).searchParams.get('secret')!;
      await f.signin(regular,regular.jar,currentPassword);
      assert.equal((await f.request('/two-factor/verify-totp',{code:totp(secret)},regular.jar)).response.status,200);
      const session=await f.request('/get-session',undefined,regular.jar);
      assert.ok(await f.store.sessionReady(regular.id,session.body.session.id));
      await f.request('/sign-out',{},regular.jar);
      assert.equal((await f.signin(regular,regular.jar,currentPassword)).body.twoFactorRedirect,true);
      assert.equal((await f.request('/two-factor/send-otp',{},regular.jar)).response.status,200);
      const correct=f.otp(regular),wrong=correct==='000000'?'111111':'000000';
      for(let n=0;n<5;n++)assert.ok([400,401,403].includes((await f.request('/two-factor/verify-otp',{code:wrong},regular.jar)).response.status));
      const blocked=await f.request('/two-factor/verify-otp',{code:correct},regular.jar);
      assert.ok(blocked.response.status>=400&&blocked.response.status<500,'exhausted MFA must reject even the correct code; status='+blocked.response.status);
      assert.equal((await f.request('/get-session',undefined,regular.jar)).body,null);
    });
    await t.test('identity and business credentials are separated at database boundary',async()=>{
      await assert.rejects(f.store.query('SELECT * FROM public.people'),/permission denied/);
      await assert.rejects(f.store.query('SELECT * FROM auth_private.credentials'),/permission denied/);
      await f.admin(async()=>{
        await f.pg.exec('SET ROLE kavosh_runtime');
        try{await assert.rejects(f.pg.query('SELECT * FROM identity."user"'),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
      });
      const connection=f.pg.runtime?f.pg.identityDb():f.db;
      try {
        const original=(await f.admin(()=>f.pg.query<{restore:string}>(`SELECT format('ALTER DATABASE %I OWNER TO %I',current_database(),current_user) AS restore`))).rows[0].restore;
        try {
          await f.admin(async()=>{const sql=(await f.pg.query<{command:string}>(`SELECT format('ALTER DATABASE %I OWNER TO kavosh_identity',current_database()) AS command`)).rows[0].command;await f.pg.exec(sql);});
          await assert.rejects(new IdentityStore(connection,config.secret).safe(),/UNSAFE_IDENTITY_ROLE/);
        }finally{await f.admin(()=>f.pg.exec(original));}
      }finally{if(f.pg.runtime)await connection.destroy();}
    });
    await t.test('identity and auth delivery roles reject accidental platform authority',async()=>{
      await f.store.safe();await f.worker(worker=>worker.safeDelivery());
      for(const role of ['kavosh_identity','kavosh_delivery']){
        await f.admin(()=>f.pg.exec('GRANT kavosh_platform_service TO '+role));
        try{
          if(role==='kavosh_identity')await assert.rejects(f.store.safe(),/UNSAFE_IDENTITY_ROLE/);
          else await assert.rejects(f.worker(worker=>worker.safeDelivery()),/UNSAFE_DELIVERY_ROLE/);
        }finally{await f.admin(()=>f.pg.exec('REVOKE kavosh_platform_service FROM '+role));}
      }
      await f.store.safe();await f.worker(worker=>worker.safeDelivery());
    });
    await t.test('encrypted delivery queue retries, expires, scrubs and isolates credentials',async()=>{
      const queued=queuedDelivery(f.store,config.secret);
      await queued.sms({to:regular.phone,text:'Synthetic private code: 123456'});
      await f.admin(async()=>{
        const rows=(await f.pg.query<{payload:string}>('SELECT payload FROM identity.delivery_outbox')).rows;
        assert.equal(rows.length,1);assert.ok(!rows[0].payload.includes('123456'));assert.ok(!rows[0].payload.includes(regular.phone));
      });
      await assert.rejects(f.store.query('SELECT * FROM identity.delivery_outbox'),/permission denied/);
      await f.worker(async worker=>{
        await assert.rejects(worker.query('SELECT * FROM identity."user"'),/permission denied/);
        assert.equal(await deliverOne(worker,config.secret,{...f.delivery,async sms(){throw new MessageDeliveryError('rejected','SYNTHETIC_PROVIDER_REJECTION');}}),true);
        assert.equal(await deliverOne(worker,config.secret,f.delivery),false,'retry must back off');
      });
      await f.admin(()=>f.pg.query("UPDATE identity.delivery_outbox SET available_at=now(),locked_until=NULL"));
      await f.worker(async worker=>{assert.equal(await deliverOne(worker,config.secret,f.delivery),true);});
      await f.admin(async()=>{
        const row=(await f.pg.query<{payload:null;outcome:string}>('SELECT payload,outcome FROM identity.delivery_outbox')).rows[0];
        assert.equal(row.payload,null);assert.equal(row.outcome,'delivered');
      });
      await queued.sms({to:master.phone,text:'Synthetic expired code: 123456'});
      await f.admin(()=>f.pg.query("UPDATE identity.delivery_outbox SET expires_at=now()-interval '1 minute' WHERE outcome IS NULL"));
      await f.worker(async worker=>{assert.equal(await deliverOne(worker,config.secret,f.delivery),false);});
      await f.admin(async()=>{
        const row=(await f.pg.query<{payload:null;outcome:string}>("SELECT payload,outcome FROM identity.delivery_outbox WHERE outcome='expired'")).rows[0];
        assert.equal(row.payload,null);assert.equal(row.outcome,'expired');
      });
      await queued.sms({to:master.phone,text:'Synthetic final failure: 123456'});
      await f.admin(()=>f.pg.query('UPDATE identity.delivery_outbox SET attempts=2 WHERE outcome IS NULL'));
      await f.worker(async worker=>{assert.equal(await deliverOne(worker,config.secret,{...f.delivery,async sms(){throw new Error('synthetic final failure');}}),true);});
      await f.admin(async()=>{
        const row=(await f.pg.query<{payload:null;outcome:string}>("SELECT payload,outcome FROM identity.delivery_outbox WHERE outcome='failed'")).rows[0];
        assert.equal(row.payload,null);assert.equal(row.outcome,'failed');
      });
      await queued.sms({to:master.phone,text:'Synthetic uncertain send'});let uncertainCalls=0;
      await f.worker(async worker=>{assert.equal(await deliverOne(worker,config.secret,{...f.delivery,async sms(){uncertainCalls++;throw new MessageDeliveryError('outcome_unknown','SYNTHETIC_RESPONSE_LOST');}}),true);assert.equal(await deliverOne(worker,config.secret,f.delivery),false);});assert.equal(uncertainCalls,1);
      await f.admin(async()=>{const failed=(await f.pg.query<{payload:null;attempts:number}>("SELECT payload,attempts FROM identity.delivery_outbox WHERE outcome='failed' ORDER BY created_at DESC LIMIT 1")).rows[0];assert.equal(failed.payload,null);assert.equal(failed.attempts,1);});
      await queued.sms({to:master.phone,text:'Synthetic abandoned in-flight send'});
      await f.admin(()=>f.pg.query("UPDATE identity.delivery_outbox SET attempts=1,locked_until=now()-interval '1 second' WHERE outcome IS NULL"));
      let abandonedCalls=0;await f.worker(async worker=>{assert.equal(await deliverOne(worker,config.secret,{...f.delivery,async sms(){abandonedCalls++;}}),false);});assert.equal(abandonedCalls,0);
      await queued.sms({to:master.phone,text:'Synthetic send finishing after lease expiry'});let lateCalls=0;
      await f.worker(async worker=>{assert.equal(await deliverOne(worker,config.secret,{...f.delivery,async sms(){
       lateCalls++;await f.admin(()=>f.pg.query("UPDATE identity.delivery_outbox SET locked_until=now()-interval '1 second' WHERE outcome IS NULL"));await f.pg.exec('SET ROLE kavosh_delivery');assert.equal(await deliverOne(worker,config.secret,{...f.delivery,async sms(){lateCalls++;}}),false);
      }}),true);});assert.equal(lateCalls,1);
      await f.admin(async()=>{assert.equal((await f.pg.query("SELECT outcome FROM identity.delivery_outbox ORDER BY created_at DESC LIMIT 1")).rows[0].outcome,'failed','late completion must not overwrite another worker terminal outcome');});
    });
    await t.test('expired auth cleanup removes challenges without deleting identities or audit history',async()=>{
      await f.admin(async()=>{
        await f.pg.query(`INSERT INTO identity.phone_challenges VALUES($1,'+16475559999',now()-interval '1 minute')`,[master.id]);
        await f.pg.query(`INSERT INTO identity.auth_budgets VALUES('synthetic-stale-budget',now()-interval '3 days',1)`);
        const before=(await f.pg.query<{count:string}>('SELECT count(*) FROM identity."user"')).rows[0].count;
        await f.pg.exec('SET ROLE kavosh_delivery');await f.pg.query('SELECT identity.cleanup_expired_auth()');await f.pg.exec('RESET ROLE');
        assert.equal((await f.pg.query('SELECT * FROM identity.phone_challenges')).rows.length,0);
        assert.equal((await f.pg.query("SELECT * FROM identity.auth_budgets WHERE key='synthetic-stale-budget'")).rows.length,0);
        assert.equal((await f.pg.query<{count:string}>('SELECT count(*) FROM identity."user"')).rows[0].count,before);
        assert.ok((await f.pg.query('SELECT * FROM public.audit_events')).rows.length>0);
      });
    });
    await t.test('per-account throttling stops brute force without relying on forwarded IP headers',async()=>{
      const email='rate-limit-target@example.test';
      for(let i=0;i<5;i++)assert.equal((await f.request('/sign-in/email',{email,password})).response.status,401);
      assert.equal((await f.request('/sign-in/email',{email,password},undefined,{'x-forwarded-for':'1.2.3.4'})).response.status,429);
    });
  }finally{await f.close();}
});

test('phone change: real password email approval new-phone OTP and native revocation',async t=>{
 const f=await fixture();t.beforeEach(async()=>{await f.admin(()=>f.pg.query('DELETE FROM identity.auth_budgets'));});
 try{
  const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,200);
  const candidate='+16479990101',emailCode=()=>f.messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Phone change approval code:'))!.text.match(/code: (\d{8})/)![1],smsCode=(phone:string)=>f.messages.sms.findLast(m=>m.to===phone)!.text.match(/\b\d{6}\b/)![0];let requestId='',approvalCode='',otherJar=new Map<string,string>();
  await t.test('requires fresh verified identity exact origin bounded inputs and real password without exposing the proof',async()=>{
   assert.equal((await f.request('/phone-change/request',{phoneNumber:candidate,password})).response.status,401);assert.equal((await f.request('/phone-change/request',{phoneNumber:candidate,password},user.jar,{origin:'https://untrusted.example'})).response.status,403);assert.equal((await f.request('/phone-change/request',{phoneNumber:candidate,password,userId:user.id},user.jar)).response.status,400);assert.equal((await f.request('/phone-change/request',{phoneNumber:candidate,password:'Incorrect synthetic password'},user.jar)).response.status,400);assert.equal((await f.request('/phone-number/send-otp',{phoneNumber:candidate},user.jar)).body.error.code,'PHONE_CHANGE_REQUIRES_RECOVERY');assert.equal((await f.request('/phone-change',undefined,user.jar)).body.data,null);
   await f.admin(async()=>{await f.pg.exec('BEGIN;SET LOCAL ROLE kavosh_identity');try{await assert.rejects(f.pg.query('UPDATE identity."user" SET "phoneNumber"=$2 WHERE id=$1',[user.id,candidate]),/PHONE_CHANGE_APPROVAL_REQUIRED/);}finally{await f.pg.exec('ROLLBACK');}});
  });
  await t.test('email proof is hashed owned session-bound limited to five guesses and single-use',async()=>{
   const smsBefore=f.messages.sms.length,r=await f.request('/phone-change/request',{phoneNumber:candidate,password},user.jar);assert.equal(r.response.status,202,JSON.stringify(r.body));requestId=r.body.requestId;approvalCode=emailCode();assert.equal(f.messages.sms.length,smsBefore);assert.equal(r.body.code,undefined);assert.equal((await f.request('/phone-change',undefined,user.jar)).body.data.state,'pending');await f.admin(async()=>{const stored=(await f.pg.query<{code_hash:string}>('SELECT * FROM identity.phone_change_requests WHERE user_id=$1',[user.id])).rows[0];assert.equal(stored.code_hash,f.store.digest('phone-change:'+user.id+':'+(await f.pg.query<{session_id:string}>('SELECT session_id FROM identity.phone_change_requests WHERE user_id=$1',[user.id])).rows[0].session_id+':'+requestId+':'+approvalCode));assert.notEqual(stored.code_hash,approvalCode);assert.equal(Object.hasOwn(stored,'code'),false);assert.ok(!JSON.stringify(stored).includes(password));});
   const wrong=approvalCode==='00000000'?'11111111':'00000000';for(let i=0;i<5;i++)assert.equal((await f.request('/phone-change/authorize',{requestId,code:wrong},user.jar)).response.status,409);assert.equal((await f.request('/phone-change/authorize',{requestId,code:approvalCode},user.jar)).response.status,409);assert.equal((await f.request('/phone-change',undefined,user.jar)).body.data,null);
   const next=await f.request('/phone-change/request',{phoneNumber:candidate,password},user.jar);assert.equal(next.response.status,202);assert.equal((await f.request('/phone-change/authorize',{requestId,code:approvalCode},user.jar)).response.status,409);requestId=next.body.requestId;approvalCode=emailCode();await f.signin(user,otherJar);assert.equal((await f.request('/phone-change/authorize',{requestId,code:approvalCode},otherJar)).response.status,409);const start=performance.now(),confirm=()=>f.request('/phone-change/authorize',{requestId,code:approvalCode},user.jar),decisions=f.pg.runtime?await Promise.all([confirm(),confirm()]):[await confirm(),await confirm()];assert.deepEqual(decisions.map(r=>r.response.status).sort(),[200,409]);if(f.pg.runtime)console.log('Two email approvals finished in '+Math.ceil(performance.now()-start)+'ms;not a capacity test.');assert.equal((await f.request('/phone-change',undefined,user.jar)).body.data.state,'authorized');assert.equal((await f.request('/phone-number/send-otp',{phoneNumber:'+16479990199'},user.jar)).response.status,403);
  });
  await t.test('new phone OTP is still required and failed native audit leaves phone sessions and permit unchanged',async t=>{
   const diagnostics:unknown[][]=[];t.mock.method(console,'error',(...args:unknown[])=>{diagnostics.push(args);});
   assert.equal((await f.request('/phone-number/send-otp',{phoneNumber:candidate},user.jar)).response.status,200);const code=smsCode(candidate),wrong=code==='000000'?'111111':'000000';assert.equal((await f.request('/phone-number/verify',{phoneNumber:candidate,code:wrong},user.jar)).response.status,400);
   await f.admin(()=>f.pg.exec("CREATE FUNCTION identity.synthetic_phone_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_PHONE_AUDIT_FAILURE';END $$;CREATE TRIGGER synthetic_phone_audit_failure BEFORE INSERT ON identity.security_events FOR EACH ROW WHEN(NEW.event='phone.changed') EXECUTE FUNCTION identity.synthetic_phone_audit_failure()"));try{assert.equal((await f.request('/phone-number/verify',{phoneNumber:candidate,code},user.jar)).response.status,503);}finally{await f.admin(()=>f.pg.exec('DROP TRIGGER synthetic_phone_audit_failure ON identity.security_events;DROP FUNCTION identity.synthetic_phone_audit_failure()'));}assert.equal(diagnostics.length,0,'Authentication must not print raw database diagnostics');
   await f.admin(async()=>{assert.equal((await f.pg.query<{phone:string}>('SELECT "phoneNumber" phone FROM identity."user" WHERE id=$1',[user.id])).rows[0].phone,user.phone);assert.equal((await f.pg.query('SELECT 1 FROM identity.session WHERE "userId"=$1',[user.id])).rows.length,2);assert.equal((await f.pg.query<{state:string}>('SELECT state FROM identity.phone_change_requests WHERE user_id=$1',[user.id])).rows[0].state,'authorized');});
   assert.equal((await f.request('/phone-number/send-otp',{phoneNumber:candidate},user.jar)).response.status,200);const done=await f.request('/phone-number/verify',{phoneNumber:candidate,code:smsCode(candidate)},user.jar);assert.equal(done.response.status,200,JSON.stringify(done.body));assert.equal(done.body.token,undefined);user.phone=candidate;assert.equal((await f.request('/get-session',undefined,user.jar)).body,null);assert.equal((await f.request('/get-session',undefined,otherJar)).body,null);await f.admin(async()=>{assert.equal((await f.pg.query('SELECT 1 FROM identity.session WHERE "userId"=$1',[user.id])).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM identity.phone_change_requests WHERE user_id=$1',[user.id])).rows.length,0);assert.equal((await f.pg.query("SELECT * FROM identity.security_events WHERE user_id=$1 AND event='phone.changed'",[user.id])).rows.length,1);assert.equal((await f.pg.query<{auth_user_id:string}>('SELECT auth_user_id FROM public.people WHERE id=$1',[user.person])).rows[0].auth_user_id,user.id);});await f.signin(user);assert.equal((await f.request('/get-session',undefined,user.jar)).body.user.phoneNumber,candidate);
  });
  await t.test('failed email delivery cancels only its request and per-user limits prevent repeated contact spam',async()=>{
   const send=f.delivery.email;f.delivery.email=async()=>{throw new Error('SYNTHETIC_PRIVATE_DELIVERY_FAILURE');};try{const failed=await f.request('/phone-change/request',{phoneNumber:'+16479990107',password},user.jar);assert.equal(failed.response.status,503);assert.equal(failed.body.error.code,'PHONE_CHANGE_UNAVAILABLE');}finally{f.delivery.email=send;}assert.equal((await f.request('/phone-change',undefined,user.jar)).body.data,null);const count=f.messages.emails.length,a=await f.request('/phone-change/request',{phoneNumber:'+16479990108',password},user.jar),b=await f.request('/phone-change/request',{phoneNumber:'+16479990109',password},user.jar);assert.equal(a.response.status,202);assert.equal(b.response.status,202);assert.equal((await f.request('/phone-change/request',{phoneNumber:'+16479990110',password},user.jar)).response.status,429);assert.equal(f.messages.emails.length,count+2);assert.equal((await f.request('/phone-change/cancel',{requestId:b.body.requestId},user.jar)).response.status,200);assert.equal((await f.request('/get-session',undefined,user.jar)).body.user.phoneNumber,candidate);
  });
  await t.test('replacement requests cancellation expiry fresh-session gates and password changes cannot reuse old proof',async()=>{
   const a=await f.request('/phone-change/request',{phoneNumber:'+16479990102',password},user.jar),oldCode=emailCode(),b=await f.request('/phone-change/request',{phoneNumber:'+16479990103',password},user.jar);assert.equal(a.response.status,202);assert.equal(b.response.status,202);assert.equal((await f.request('/phone-change/authorize',{requestId:a.body.requestId,code:oldCode},user.jar)).response.status,409);assert.equal((await f.request('/phone-change/cancel',{requestId:b.body.requestId},user.jar)).response.status,200);assert.equal((await f.request('/phone-change',undefined,user.jar)).body.data,null);const c=await f.request('/phone-change/request',{phoneNumber:'+16479990104',password},user.jar);assert.equal(c.response.status,202);const current=emailCode();await f.admin(()=>f.pg.query('UPDATE identity.phone_change_requests SET expires_at=now()-interval \'1 second\' WHERE user_id=$1',[user.id]));assert.equal((await f.request('/phone-change/authorize',{requestId:c.body.requestId,code:current},user.jar)).response.status,409);
   await f.admin(()=>f.pg.query('UPDATE identity.session SET "createdAt"=now()-interval \'16 minutes\' WHERE "userId"=$1',[user.id]));assert.equal((await f.request('/phone-change/request',{phoneNumber:'+16479990105',password},user.jar)).body.error.code,'FRESH_SIGN_IN_REQUIRED');await f.signin(user);await f.admin(()=>f.pg.query('DELETE FROM identity.auth_budgets'));const d=await f.request('/phone-change/request',{phoneNumber:'+16479990106',password},user.jar),code=emailCode();assert.equal(d.response.status,202);const changed='Synthetic changed account password 456!';assert.equal((await f.request('/change-password',{currentPassword:password,newPassword:changed},user.jar)).response.status,200);await f.signin(user,user.jar,changed);assert.equal((await f.request('/phone-change',undefined,user.jar)).body.data,null);assert.equal((await f.request('/phone-change/authorize',{requestId:d.body.requestId,code},user.jar)).response.status,409);assert.equal((await f.request('/get-session',undefined,user.jar)).body.user.phoneNumber,candidate);
  });
  await t.test('runtime delivery and unauthenticated callers cannot read or write private phone-change state',async()=>{
   for(const role of ['kavosh_runtime','kavosh_delivery'])await f.admin(async()=>{await f.pg.exec('BEGIN;SET LOCAL ROLE '+role);try{await assert.rejects(f.pg.query('SELECT * FROM identity.phone_change_requests'),/permission denied/i);}finally{await f.pg.exec('ROLLBACK');}});await f.admin(async()=>{await f.pg.exec('BEGIN;SET LOCAL ROLE kavosh_identity');try{await assert.rejects(f.pg.query('DELETE FROM identity.phone_change_requests'),/permission denied/i);}finally{await f.pg.exec('ROLLBACK');}});
  });
 }finally{await f.close();}
});

test('phone change: master keeps same nontransferable identity mandatory MFA and cannot reuse trusted devices',async()=>{
 const f=await fixture();try{const user=await f.invitation(true);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);assert.equal((await f.signin(user)).body.twoFactorRedirect,true);await f.mfa(user,user.jar,true);assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,200);const recovery=await f.request('/two-factor/generate-backup-codes',{password},user.jar);assert.equal(recovery.response.status,200);assert.equal(recovery.body.backupCodes.length,10);assert.equal((await f.signin(user)).body.twoFactorRedirect,true);assert.equal((await f.request('/two-factor/verify-backup-code',{code:recovery.body.backupCodes[0],trustDevice:true},user.jar)).response.status,200);const oldPhoneSms=f.messages.sms.filter(m=>m.to===user.phone).length;const candidate='+16479990201',requested=await f.request('/phone-change/request',{phoneNumber:candidate,password},user.jar);assert.equal(requested.response.status,202,JSON.stringify(requested.body));const code=f.messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Phone change approval code:'))!.text.match(/code: (\d{8})/)![1];assert.equal((await f.request('/phone-change/authorize',{requestId:requested.body.requestId,code},user.jar)).response.status,200);assert.equal((await f.request('/phone-number/send-otp',{phoneNumber:candidate},user.jar)).response.status,200);const otp=f.messages.sms.findLast(m=>m.to===candidate)!.text.match(/\b\d{6}\b/)![0];assert.equal((await f.request('/phone-number/verify',{phoneNumber:candidate,code:otp},user.jar)).response.status,200);assert.equal(f.messages.sms.filter(m=>m.to===user.phone).length,oldPhoneSms);user.phone=candidate;assert.equal((await f.business(user)).status,401);await f.admin(async()=>{assert.equal((await f.pg.query<{master_person_id:string}>('SELECT master_person_id FROM public.academies WHERE id=$1',[user.academy])).rows[0].master_person_id,user.person);assert.equal((await f.pg.query<{auth_user_id:string}>('SELECT auth_user_id FROM public.people WHERE id=$1',[user.person])).rows[0].auth_user_id,user.id);const u=(await f.pg.query<{mfaRequired:boolean;twoFactorEnabled:boolean}>('SELECT "mfaRequired","twoFactorEnabled" FROM identity."user" WHERE id=$1',[user.id])).rows[0];assert.equal(u.mfaRequired,true);assert.equal(u.twoFactorEnabled,true);assert.equal((await f.pg.query('SELECT * FROM identity.verification WHERE value=$1',[user.id])).rows.length,0);});assert.equal((await f.signin(user)).body.twoFactorRedirect,true);assert.equal((await f.request('/phone-change/request',{phoneNumber:'+16479990202',password},user.jar)).response.status,401);await f.mfa(user);assert.equal((await f.business(user)).status,200);assert.equal((await f.request('/two-factor/disable',{password},user.jar)).response.status,403);
 }finally{await f.close();}
});

test('production edge trust rejects spoofed and malformed proxy headers',()=>{
  const production={...config,production:true,edgeSecret:'a'.repeat(32)};
  assert.throws(()=>verifiedProxyIp(new Request(origin),production),/UNTRUSTED_PROXY/);
  assert.throws(()=>verifiedProxyIp(new Request(origin,{headers:{'x-kavosh-edge-key':'é'.repeat(32),'x-kavosh-client-ip':'1.2.3.4'}}),production),/UNTRUSTED_PROXY/);
  assert.equal(verifiedProxyIp(new Request(origin,{headers:{'x-kavosh-edge-key':production.edgeSecret,'x-kavosh-client-ip':'1.2.3.4'}}),production),'1.2.3.4');
});

test('phone change native password-first race refuses revoked proof without partial contact changes',{skip:!process.env.TEST_DATABASE_URL,timeout:10000},async()=>{
 const f=await fixture();try{
  const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);
  const candidate='+16479990401',r=await f.request('/phone-change/request',{phoneNumber:candidate,password},user.jar);assert.equal(r.response.status,202);
  const emailCode=f.messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Phone change approval code:'))!.text.match(/code: (\d{8})/)![1];
  assert.equal((await f.request('/phone-change/authorize',{requestId:r.body.requestId,code:emailCode},user.jar)).response.status,200);
  assert.equal((await f.request('/phone-number/send-otp',{phoneNumber:candidate},user.jar)).response.status,200);
  const otp=f.messages.sms.findLast(m=>m.to===candidate)!.text.match(/\b\d{6}\b/)![0];
  let changed!:ReturnType<typeof f.request>,phone!:ReturnType<typeof f.request>;const nextPassword='Synthetic password first race 987!';
  await f.admin(async()=>{
   await f.pg.exec('BEGIN');try{
    // Password revocation queues on the source session. Phone revalidation
    // must refuse that in-flight writer BEFORE this blocker is released.
    await f.pg.query('SELECT id FROM identity.session WHERE "userId"=$1 FOR UPDATE',[user.id]);
    changed=f.request('/change-password',{currentPassword:password,newPassword:nextPassword},user.jar);
    async function locked(n:number){for(let i=0;i<200;i++){if((await f.pg.query<{n:number}>("SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")).rows[0].n>=n)return;await new Promise<void>(r=>setTimeout(r,10));}assert.fail('Expected controlled native lock wait');}
    await locked(1);phone=f.request('/phone-number/verify',{phoneNumber:candidate,code:otp},user.jar);
    assert.equal((await phone).response.status,409);await f.pg.exec('COMMIT');
   }finally{await f.pg.exec('ROLLBACK');}
  });
  const [a,b]=await Promise.all([changed,phone]);assert.equal(a.response.status,200,JSON.stringify(a.body));assert.equal(b.response.status,409,JSON.stringify(b.body));assert.equal(b.body.error.code,'PHONE_CHANGE_SOURCE_CHANGED');
  await f.admin(async()=>{
   assert.equal((await f.pg.query<{phone:string}>('SELECT "phoneNumber" phone FROM identity."user" WHERE id=$1',[user.id])).rows[0].phone,user.phone);
   assert.equal((await f.pg.query('SELECT * FROM identity.phone_change_requests WHERE user_id=$1',[user.id])).rows.length,0);
   assert.equal((await f.pg.query('SELECT * FROM identity.session WHERE "userId"=$1',[user.id])).rows.length,0);
  });
  assert.equal((await f.signin(user,user.jar,nextPassword)).response.status,200);
 }finally{await f.close();}
});

test('email change pending invitation remains usable by the same verified identity without rewriting its approved recipient',async()=>{
 const f=await fixture();try{
  const user=await f.invitation(false),originalEmail=user.email;await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);
  assert.equal(await f.store.schemaReady(),true);
  const target='changed-before-acceptance@example.test',r=await f.request('/email-change/request',{email:target,password},user.jar);assert.equal(r.response.status,202);
  const oldCode=f.messages.emails.findLast(m=>m.to===originalEmail&&m.text.startsWith('Email change approval code:'))!.text.match(/code: (\d{8})/)![1];assert.equal((await f.request('/email-change/authorize',{requestId:r.body.requestId,code:oldCode},user.jar)).response.status,202);
  const newCode=f.messages.emails.findLast(m=>m.to===target)!.text.match(/code: (\d{8})/)![1];assert.equal((await f.request('/email-change/confirm',{requestId:r.body.requestId,code:newCode},user.jar)).response.status,200);
  user.email=target;assert.equal((await f.signin(user)).response.status,200);const accepted=await f.request('/accept-invitation',{invitation:user.token},user.jar);assert.equal(accepted.response.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.academyId,user.academy);
  await f.admin(async()=>{const p=(await f.pg.query<{auth_user_id:string;email:string}>('SELECT auth_user_id,email FROM public.people WHERE academy_id=$1 AND id=$2',[user.academy,user.person])).rows[0];assert.equal(p.auth_user_id,user.id);assert.equal(p.email,originalEmail);assert.equal((await f.pg.query<{email:string}>('SELECT email FROM identity.invites WHERE token_hash=$1',[f.store.digest(user.token)])).rows[0].email,originalEmail);});
 }finally{await f.close();}
});

test('email change pending invitation is identity-bound across repeated changes and cannot be taken by a new holder of the old email',async()=>{
 const f=await fixture();try{
  const user=await f.invitation(false),old=user.email;await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);await f.replaceEmail(user,'first-continuity@example.test');await f.signin(user);await f.replaceEmail(user,'second-continuity@example.test');await f.signin(user);
  await f.admin(async()=>{const row=(await f.pg.query<{user_id:string;email:string;academy_id:string;person_id:string}>('SELECT * FROM identity.invite_account_bindings WHERE token_hash=$1',[f.store.digest(user.token)])).rows[0];assert.equal(row.user_id,user.id);assert.equal(row.email,old);assert.equal(row.academy_id,user.academy);assert.equal(row.person_id,user.person);await f.pg.query('UPDATE identity.retired_emails SET expires_at=clock_timestamp()-interval \'1 second\' WHERE email=$1',[old]);});
  const other=await f.invitation(false);await f.admin(async()=>{await f.pg.query('UPDATE identity.invites SET email=$2 WHERE token_hash=$1',[f.store.digest(other.token),old]);await f.pg.query('UPDATE public.people SET email=$3 WHERE academy_id=$1 AND id=$2',[other.academy,other.person,old]);});other.email=old;await f.signup(other);await f.verifyEmail(other);await f.signin(other);await f.phone(other);await f.signin(other);
  assert.equal((await f.request('/accept-invitation',{invitation:user.token},other.jar)).body.error.code,'INVALID_INVITATION');assert.equal(await f.store.invite(user.token,old),null,'bound token cannot create a replacement account');
  assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,200);assert.equal((await f.request('/accept-invitation',{invitation:other.token},other.jar)).response.status,200);
 }finally{await f.close();}
});

test('email change pending master invitation still requires mandatory MFA and the unchanged sole-master person',async()=>{
 const f=await fixture();try{
  const user=await f.invitation(true);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);await f.mfa(user);await f.replaceEmail(user,'pending-master-continuity@example.test');assert.equal((await f.signin(user)).body.twoFactorRedirect,true);
  assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,401);await f.mfa(user);assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,200);
  await f.admin(async()=>{assert.equal((await f.pg.query<{master_person_id:string}>('SELECT master_person_id FROM public.academies WHERE id=$1',[user.academy])).rows[0].master_person_id,user.person);assert.equal((await f.pg.query<{auth_user_id:string}>('SELECT auth_user_id FROM public.people WHERE academy_id=$1 AND id=$2',[user.academy,user.person])).rows[0].auth_user_id,user.id);});
 }finally{await f.close();}
});

test('email change pending master invitation enables mandatory MFA for an existing ordinary account without lending cross-school authority',async()=>{
 const f=await fixture();try{
  const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);
  const master=await f.invitation(true);await f.admin(async()=>{await f.pg.query('UPDATE identity.invites SET email=$2 WHERE token_hash=$1',[f.store.digest(master.token),user.email]);await f.pg.query('UPDATE public.people SET email=$3 WHERE academy_id=$1 AND id=$2',[master.academy,master.person,user.email]);assert.equal((await f.pg.query<{mfaRequired:boolean}>('SELECT "mfaRequired" FROM identity."user" WHERE id=$1',[user.id])).rows[0].mfaRequired,false);});
  await f.replaceEmail(user,'ordinary-to-master-continuity@example.test');assert.equal((await f.signin(user)).response.status,200);
  assert.equal((await f.request('/accept-invitation',{invitation:master.token},user.jar)).body.error.code,'MFA_REQUIRED');assert.equal((await f.request('/get-session',undefined,user.jar)).body,null);assert.equal((await f.signin(user)).body.twoFactorRedirect,true);await f.mfa(user);
  assert.equal((await f.request('/accept-invitation',{invitation:master.token},user.jar)).response.status,200);assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,200);
  assert.equal((await f.business(user,'hubs',undefined,master.academy)).status,200);assert.equal((await f.business(user)).status,403,'master in one school is not master of another school');
  await f.admin(async()=>{assert.equal((await f.pg.query<{master_person_id:string}>('SELECT master_person_id FROM public.academies WHERE id=$1',[master.academy])).rows[0].master_person_id,master.person);assert.equal((await f.pg.query<{auth_user_id:string}>('SELECT auth_user_id FROM public.people WHERE academy_id=$1 AND id=$2',[master.academy,master.person])).rows[0].auth_user_id,user.id);});
 }finally{await f.close();}
});

test('email change pending invitation continuity does not bypass temporary school or person unavailability',async()=>{
 const f=await fixture();try{
  const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);
  await f.admin(async()=>{await f.pg.query('UPDATE public.academies SET status=\'read_only\' WHERE id=$1',[user.academy]);await f.pg.query('UPDATE public.people SET status=\'disabled\' WHERE academy_id=$1 AND id=$2',[user.academy,user.person]);});
  await f.replaceEmail(user,'temporarily-unavailable@example.test');await f.signin(user);assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).body.error.code,'INVALID_INVITATION');
  await f.admin(()=>f.pg.query('UPDATE public.people SET status=\'pending\' WHERE academy_id=$1 AND id=$2',[user.academy,user.person]));assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).body.error.code,'ACADEMY_UNAVAILABLE');
  await f.admin(()=>f.pg.query('UPDATE public.academies SET status=\'active\' WHERE id=$1',[user.academy]));assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,200);
 }finally{await f.close();}
});

test('email change pending invitation pins source,retains revocation,and cleans expired private bindings without raw identity access',async()=>{
 const f=await fixture();try{
  const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);await f.replaceEmail(user,'revoked-continuity@example.test');await f.signin(user);
  for(const role of ['kavosh_identity','kavosh_runtime','kavosh_delivery','kavosh_automation_worker'])await f.admin(async()=>{await f.pg.exec('BEGIN;SET LOCAL ROLE '+role);try{await assert.rejects(f.pg.query('SELECT * FROM identity.invite_account_bindings'),/permission denied/i);}finally{await f.pg.exec('ROLLBACK');}});
  await f.admin(async()=>{await f.pg.exec('BEGIN;SET LOCAL ROLE kavosh_identity_policy');try{await assert.rejects(f.pg.query('INSERT INTO identity.invite_account_bindings(token_hash,user_id,academy_id,person_id,email,master,expires_at) SELECT token_hash,user_id,academy_id,person_id,email,master,expires_at FROM identity.invite_account_bindings WHERE token_hash=$1',[f.store.digest(user.token)]),/INVITATION_CONTACT_CHANGE_REQUIRED/);}finally{await f.pg.exec('ROLLBACK');}});
  await f.admin(async()=>{await f.pg.exec('BEGIN');try{await assert.rejects(f.pg.query('UPDATE identity.invite_account_bindings SET user_id=$2 WHERE token_hash=$1',[f.store.digest(user.token),randomUUID()]),/INVITATION_CONTACT_BINDING_IMMUTABLE/);}finally{await f.pg.exec('ROLLBACK');}await f.pg.exec('BEGIN');try{await assert.rejects(f.pg.query('DELETE FROM identity.invite_account_bindings WHERE token_hash=$1',[f.store.digest(user.token)]),/INVITATION_CONTACT_BINDING_IMMUTABLE/);}finally{await f.pg.exec('ROLLBACK');}});
  await f.admin(()=>f.pg.query('UPDATE identity.invites SET expires_at=expires_at+interval \'1 second\' WHERE token_hash=$1',[f.store.digest(user.token)]));assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).body.error.code,'INVALID_INVITATION','even unexpired source replacement cannot silently inherit binding');
  await f.worker(async worker=>{await worker.query('SELECT identity.cleanup_expired_auth()');});await f.admin(async()=>{assert.equal((await f.pg.query('SELECT * FROM identity.invite_account_bindings WHERE token_hash=$1',[f.store.digest(user.token)])).rows.length,1,'cleanup must not restore address-only fallback for a still-live source');});
  await f.admin(()=>f.pg.query('UPDATE identity.invites SET expires_at=clock_timestamp()-interval \'8 days\' WHERE token_hash=$1',[f.store.digest(user.token)]));assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).body.error.code,'INVALID_INVITATION');
  await f.worker(async worker=>{await worker.query('SELECT identity.cleanup_expired_auth()');});
  await f.admin(async()=>{assert.equal((await f.pg.query('SELECT * FROM identity.invite_account_bindings WHERE token_hash=$1',[f.store.digest(user.token)])).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM identity.invites WHERE token_hash=$1',[f.store.digest(user.token)])).rows.length,0);assert.equal((await f.pg.query<{auth_user_id:null}>('SELECT auth_user_id FROM public.people WHERE academy_id=$1 AND id=$2',[user.academy,user.person])).rows[0].auth_user_id,null);assert.equal((await f.pg.query("SELECT * FROM identity.security_events WHERE user_id=$1 AND event='invitation.contact_bound'",[user.id])).rows.length,1);});
 }finally{await f.close();}
});

test('email change pending invitation late audit failure rolls back contacts sessions retirement continuity and observations together',async()=>{
 const f=await fixture();try{
  const user=await f.invitation(false),old=user.email;await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);
  const target='atomic-continuity@example.test',r=await f.request('/email-change/request',{email:target,password},user.jar);assert.equal(r.response.status,202);const oldCode=f.messages.emails.findLast(m=>m.to===old&&m.text.startsWith('Email change approval code:'))!.text.match(/code: (\d{8})/)![1];assert.equal((await f.request('/email-change/authorize',{requestId:r.body.requestId,code:oldCode},user.jar)).response.status,202);const code=f.messages.emails.findLast(m=>m.to===target)!.text.match(/code: (\d{8})/)![1];
  await f.admin(()=>f.pg.exec("CREATE FUNCTION identity.synthetic_continuity_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_CONTINUITY_AUDIT_FAILURE';END $$;CREATE TRIGGER synthetic_continuity_audit_failure BEFORE INSERT ON identity.security_events FOR EACH ROW WHEN(NEW.event='invitation.contact_bound') EXECUTE FUNCTION identity.synthetic_continuity_audit_failure()"));
  try{assert.equal((await f.request('/email-change/confirm',{requestId:r.body.requestId,code},user.jar)).response.status,503);}finally{await f.admin(()=>f.pg.exec('DROP TRIGGER synthetic_continuity_audit_failure ON identity.security_events;DROP FUNCTION identity.synthetic_continuity_audit_failure()'));}
  await f.admin(async()=>{
   assert.equal((await f.pg.query<{email:string}>('SELECT email FROM identity."user" WHERE id=$1',[user.id])).rows[0].email,old);assert.equal((await f.pg.query('SELECT * FROM identity.session WHERE "userId"=$1',[user.id])).rows.length,1);
   for(const table of ['invite_account_bindings','retired_emails','contact_change_events'])assert.equal((await f.pg.query('SELECT * FROM identity.'+table)).rows.length,0,table);assert.equal((await f.pg.query("SELECT * FROM identity.security_events WHERE user_id=$1 AND event IN('email.changed','invitation.contact_bound')",[user.id])).rows.length,0);
  });
  assert.equal((await f.request('/email-change/confirm',{requestId:r.body.requestId,code},user.jar)).response.status,200);user.email=target;await f.signin(user);assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,200);
 }finally{await f.close();}
});

test('email change pending invitation continuity does not wait on school invitation row locks',{skip:!process.env.TEST_DATABASE_URL,timeout:10000},async()=>{
 const f=await fixture();try{
  const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);
  const target='nonblocking-continuity@example.test',r=await f.request('/email-change/request',{email:target,password},user.jar);assert.equal(r.response.status,202);const oldCode=f.messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Email change approval code:'))!.text.match(/code: (\d{8})/)![1];assert.equal((await f.request('/email-change/authorize',{requestId:r.body.requestId,code:oldCode},user.jar)).response.status,202);const code=f.messages.emails.findLast(m=>m.to===target)!.text.match(/code: (\d{8})/)![1];
  let pending!:ReturnType<typeof f.request>;await f.admin(async()=>{
   await f.pg.exec('BEGIN');let timer:ReturnType<typeof setTimeout>|undefined;try{
    await f.pg.query('SELECT token_hash FROM identity.invites WHERE token_hash=$1 FOR UPDATE',[f.store.digest(user.token)]);pending=f.request('/email-change/confirm',{requestId:r.body.requestId,code},user.jar);
    const result=await Promise.race([pending,new Promise<null>(resolve=>{timer=setTimeout(()=>resolve(null),2000);})]);assert.ok(result,'Contact confirmation must return BEFORE releasing the held invitation row');assert.equal(result.response.status,200,JSON.stringify(result.body));
   }finally{if(timer)clearTimeout(timer);await f.pg.exec('ROLLBACK');}
  });await pending;user.email=target;await f.signin(user);assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,200);
 }finally{await f.close();}
});

test('email change pending invitation owner repair does not manufacture continuity from an unverified former email',async()=>{
 const f=await fixture();try{
  const user=await f.invitation(false);await f.signup(user);
  await f.admin(async()=>{await f.pg.query('UPDATE identity."user" SET email=\'unverified-repair@example.test\' WHERE id=$1',[user.id]);assert.equal((await f.pg.query('SELECT * FROM identity.invite_account_bindings')).rows.length,0);});
 }finally{await f.close();}
});

test('email change pending invitation actual199to200 upgrade preserves source identities permissions and helper ownership without backfill',async()=>{
 const f=await fixture({throughSchema:199});try{
  const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);const phone=await f.request('/phone-change/request',{phoneNumber:'+16479990801',password},user.jar);assert.equal(phone.response.status,202);
  const beforeUpgrade=await f.request('/email-change/request',{email:'not-yet-migrated@example.test',password},user.jar);assert.equal(beforeUpgrade.response.status,503);assert.equal(beforeUpgrade.body.error.code,'AUTH_SCHEMA_NOT_CURRENT');
  // Arrange a genuine old native request,not a current API write that must
  // refuse this historical schema. Viewing/aborting it must remain available.
  const oldRequest=randomUUID(),oldSession=(await f.request('/get-session',undefined,user.jar)).body.session.id;assert.equal(await f.store.prepareEmailChange(user.id,oldSession,oldRequest,'old-native-request@example.test','a'.repeat(64)),'PREPARED');
  for(const path of ['/email-change/authorize','/email-change/confirm']){const blocked=await f.request(path,{requestId:oldRequest,code:'00000000'},user.jar);assert.equal(blocked.response.status,503);assert.equal(blocked.body.error.code,'AUTH_SCHEMA_NOT_CURRENT');}
  assert.equal((await f.request('/email-change',undefined,user.jar)).body.data.requestId,oldRequest);assert.equal((await f.request('/email-change/cancel',{requestId:oldRequest},user.jar)).response.status,200);
  await f.admin(async()=>{
   const tables=['identity."user"','identity.session','identity.account','identity.invites','identity.security_events','identity.phone_change_requests','identity.contact_change_events','identity.contact_change_targets','public.people','public.academies','public.role_permissions','public.role_assignments'];async function snapshot(){const rows=[];for(const table of tables)rows.push({table,rows:(await f.pg.query('SELECT to_jsonb(x) r FROM '+table+' x ORDER BY to_jsonb(x)::text')).rows});return rows;}
   const before=await snapshot(),helpers="SELECT oid,proowner,proacl FROM pg_proc WHERE oid=ANY(ARRAY['identity.accept_invite(text,uuid,uuid)'::regprocedure,'identity.inspect_invite(text,text)'::regprocedure,'identity.cleanup_expired_auth()'::regprocedure,'identity.finish_email_change()'::regprocedure,'public.lock_human(uuid,uuid)'::regprocedure]) ORDER BY oid",acl=(await f.pg.query(helpers)).rows;
   await f.pg.exec(await readFile(new URL('../db/migrations/200_invitation_contact_continuity.sql',import.meta.url),'utf8'));assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.pg.query(helpers)).rows,acl);assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,200);await upgradeToCurrent(f.pg);assert.equal((await f.pg.query('SELECT * FROM identity.invite_account_bindings')).rows.length,0);
  });
  const code=f.messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Phone change approval code:'))!.text.match(/code: (\d{8})/)![1];assert.equal((await f.request('/phone-change/authorize',{requestId:phone.body.requestId,code},user.jar)).response.status,200);
  await f.replaceEmail(user,'upgraded-continuity@example.test');await f.signin(user);assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,200);
 }finally{await f.close();}
});

test('email change: both inbox proofs real password native revocation isolation and retirement safety',async t=>{
 const f=await fixture();t.beforeEach(()=>f.admin(()=>f.pg.query('DELETE FROM identity.auth_budgets')));
 try{
  const user=await f.invitation(false),target='changed-contact@example.test';await f.signup(user);await f.verifyEmail(user);await f.signin(user);
  assert.equal((await f.request('/email-change/request',{email:target,password},user.jar)).response.status,403);
  await f.phone(user);await f.signin(user);assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,200);
  const otherJar=new Map<string,string>();await f.signin(user,otherJar);const originalBusinessStatus=(await f.business(user)).status;
  const oldCode=()=>f.messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Email change approval code:'))!.text.match(/code: (\d{8})/)![1];
  const newCode=(email=target)=>f.messages.emails.findLast(m=>m.to===email&&m.text.startsWith('New email verification code:'))!.text.match(/code: (\d{8})/)![1];
  async function start(email=target){const r=await f.request('/email-change/request',{email,password},user.jar);assert.equal(r.response.status,202,JSON.stringify(r.body));return r.body.requestId as string;}
  async function authorize(requestId:string,code=oldCode()){return f.request('/email-change/authorize',{requestId,code},user.jar);}
  const wrong=(code:string)=>code==='00000000'?'11111111':'00000000';
  await t.test('strict origin self-only input and real password precede mail and native email writes stay denied',async()=>{
   const before=f.messages.emails.length;
   assert.equal((await f.request('/email-change/request',{email:target,password})).response.status,401);
   assert.equal((await f.request('/email-change/request',{email:target,password},user.jar,{origin:'https://untrusted.example'})).response.status,403);
   for(const patch of [{userId:user.id},{emailVerified:true},{callbackURL:'https://untrusted.example'}])assert.equal((await f.request('/email-change/request',{email:target,password,...patch},user.jar)).response.status,400);
   assert.equal((await f.request('/email-change/request',{email:target,password:'Wrong synthetic password'},user.jar)).response.status,400);
   assert.equal((await f.request('/email-change/request?code=12345678',{email:target,password},user.jar)).response.status,400);
   assert.equal((await f.request('/change-email',{newEmail:target},user.jar)).response.status,404);
   assert.equal(f.messages.emails.length,before);assert.equal((await f.request('/email-change',undefined,user.jar)).body.data,null);
   await f.admin(async()=>{await f.pg.exec('BEGIN;SET LOCAL ROLE kavosh_identity');try{await assert.rejects(f.pg.query('UPDATE identity."user" SET email=$2 WHERE id=$1',[user.id,target]),/EMAIL_CHANGE_REQUIRES_RECOVERY/);}finally{await f.pg.exec('ROLLBACK');}});
   for(const role of ['kavosh_runtime','kavosh_delivery'])await f.admin(async()=>{await f.pg.exec('BEGIN;SET LOCAL ROLE '+role);try{await assert.rejects(f.pg.query('SELECT * FROM identity.email_change_requests'),/permission denied/);}finally{await f.pg.exec('ROLLBACK');}});
   await f.admin(async()=>{await f.pg.exec('BEGIN;SET LOCAL ROLE kavosh_identity');try{await assert.rejects(f.pg.query('DELETE FROM identity.email_change_requests'),/permission denied/);}finally{await f.pg.exec('ROLLBACK');}});
  });
  await t.test('old inbox stage is keyed session-bound single-use capped and never mails new inbox before approval',async()=>{
   const requestId=await start(),code=oldCode();assert.equal(f.messages.emails.filter(m=>m.to===target).length,0);
   const current=(await f.request('/email-change',undefined,user.jar)).body;assert.deepEqual(Object.keys(current.data).sort(),['email','expiresAt','requestId','state']);assert.equal(current.data.state,'pending_current');
   assert.equal((await f.request('/email-change',undefined,otherJar)).body.data,null);
   assert.equal((await f.request('/email-change/authorize',{requestId,code},otherJar)).response.status,409);
   await f.admin(async()=>{const r=(await f.pg.query<{session_id:string;current_code_hash:string;new_code_hash:null}>('SELECT * FROM identity.email_change_requests WHERE user_id=$1',[user.id])).rows[0];assert.equal(r.current_code_hash,f.store.digest('email-change:current:'+user.id+':'+r.session_id+':'+requestId+':'+code));assert.equal(r.new_code_hash,null);assert.equal(Object.hasOwn(r,'code'),false);assert.ok(!JSON.stringify(r).includes(password));});
   assert.equal((await f.request('/email-change/confirm',{requestId,code},user.jar)).response.status,409);
   for(let i=0;i<5;i++)assert.equal((await authorize(requestId,wrong(code))).response.status,409);
   assert.equal((await authorize(requestId,code)).response.status,409);assert.equal((await f.request('/email-change',undefined,user.jar)).body.data,null);
  });
  await t.test('replacement exact cancellation and five new-inbox guesses cannot reuse old approval',async()=>{
   const a=await start(),old=oldCode(),b=await start();assert.equal((await authorize(a,old)).response.status,409);
   assert.equal((await f.request('/email-change/cancel',{requestId:a},user.jar)).response.status,409);assert.equal((await f.request('/email-change',undefined,user.jar)).body.data.requestId,b);
   assert.equal((await authorize(b)).response.status,202);const code=newCode();assert.equal((await authorize(b)).response.status,409);assert.equal((await f.request('/email-change',undefined,user.jar)).body.data.state,'pending_new');
   await f.admin(async()=>{const r=(await f.pg.query<{session_id:string;new_code_hash:string;expires_at:Date|string}>('SELECT * FROM identity.email_change_requests WHERE user_id=$1',[user.id])).rows[0];assert.equal(r.new_code_hash,f.store.digest('email-change:new:'+user.id+':'+r.session_id+':'+b+':'+code));assert.ok(new Date(r.expires_at).getTime()<=Date.now()+300000);});
   for(let i=0;i<5;i++)assert.equal((await f.request('/email-change/confirm',{requestId:b,code:wrong(code)},user.jar)).response.status,409);
   assert.equal((await f.request('/email-change/confirm',{requestId:b,code},user.jar)).response.status,409);
   assert.equal((await f.request('/email-change/cancel',{requestId:b},user.jar)).response.status,200);
  });
  await t.test('delivery failure cancels matching proof only and three-per-hour budget precedes password work',async()=>{
   const original=f.delivery.email;f.delivery.email=async()=>{throw new Error('Synthetic email failure');};
   try{assert.equal((await f.request('/email-change/request',{email:target,password},user.jar)).response.status,503);}finally{f.delivery.email=original;}
   assert.equal((await f.request('/email-change',undefined,user.jar)).body.data,null);
   const requestId=await start();f.delivery.email=async()=>{throw new Error('Synthetic new inbox failure');};
   try{assert.equal((await authorize(requestId)).response.status,503);}finally{f.delivery.email=original;}
   assert.equal((await f.request('/email-change',undefined,user.jar)).body.data,null);
   const last=await start();assert.equal((await f.request('/email-change/request',{email:target,password},user.jar)).response.status,429);assert.equal((await f.request('/email-change/cancel',{requestId:last},user.jar)).response.status,200);
  });
  await t.test('native audit failure rolls back email sessions proof and retirement;completion preserves membership and current verified contacts',async t=>{
   const diagnostics:unknown[][]=[];t.mock.method(console,'error',(...args:unknown[])=>{diagnostics.push(args);});
   const requestId=await start();assert.equal((await authorize(requestId)).response.status,202);const code=newCode(),oldEmail=user.email;
   assert.equal((await f.request('/phone-change/request',{phoneNumber:'+16479990501',password},user.jar)).response.status,202);
   await f.admin(async()=>{
    await f.pg.query('INSERT INTO public.guardian_profiles(academy_id,person_id,legal_name) VALUES($1,$2,$3)',[user.academy,user.person,'Synthetic guardian']);
    await f.pg.query('INSERT INTO identity.verification(identifier,value,"expiresAt","updatedAt") VALUES($1,$2,now()+interval \'1 hour\',now())',['synthetic-old-email-reset',user.id]);
    await f.pg.exec("CREATE FUNCTION identity.synthetic_email_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_EMAIL_AUDIT_FAILURE';END $$;CREATE TRIGGER synthetic_email_audit_failure BEFORE INSERT ON identity.security_events FOR EACH ROW WHEN(NEW.event='email.changed') EXECUTE FUNCTION identity.synthetic_email_audit_failure()");
   });
   try{assert.equal((await f.request('/email-change/confirm',{requestId,code},user.jar)).response.status,503);}finally{await f.admin(()=>f.pg.exec('DROP TRIGGER synthetic_email_audit_failure ON identity.security_events;DROP FUNCTION identity.synthetic_email_audit_failure()'));}
   assert.equal(diagnostics.length,0);await f.admin(async()=>{assert.equal((await f.pg.query<{email:string}>('SELECT email FROM identity."user" WHERE id=$1',[user.id])).rows[0].email,oldEmail);assert.equal((await f.pg.query('SELECT * FROM identity.retired_emails')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM identity.session WHERE "userId"=$1',[user.id])).rows.length,2);assert.equal((await f.pg.query('SELECT * FROM identity.email_change_requests WHERE user_id=$1',[user.id])).rows.length,1);});
   const done=await f.request('/email-change/confirm',{requestId,code},user.jar);assert.equal(done.response.status,200,JSON.stringify(done.body));assert.deepEqual(done.body,{status:true,emailChanged:true,signInRequired:true});
   assert.equal((await f.request('/get-session',undefined,user.jar)).body,null);assert.equal((await f.request('/get-session',undefined,otherJar)).body,null);
   await f.admin(async()=>{
    assert.equal((await f.pg.query('SELECT * FROM identity.session WHERE "userId"=$1',[user.id])).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM identity.verification WHERE value=$1',[user.id])).rows.length,0);
    for(const table of ['phone_change_requests','email_change_requests'])assert.equal((await f.pg.query('SELECT * FROM identity.'+table+' WHERE user_id=$1',[user.id])).rows.length,0);
    const u=(await f.pg.query<{email:string;emailVerified:boolean;phoneNumber:string}>('SELECT * FROM identity."user" WHERE id=$1',[user.id])).rows[0];assert.equal(u.email,target);assert.equal(u.emailVerified,true);assert.equal(u.phoneNumber,user.phone);
    const person=(await f.pg.query<{auth_user_id:string;email:string}>('SELECT * FROM public.people WHERE id=$1',[user.person])).rows[0];assert.equal(person.auth_user_id,user.id);assert.equal(person.email,oldEmail,'historical registration is not silently rewritten');
    assert.equal((await f.pg.query("SELECT * FROM identity.security_events WHERE user_id=$1 AND event='email.changed'",[user.id])).rows.length,1);
    assert.equal((await f.pg.query('SELECT * FROM identity.retired_emails WHERE email=$1 AND expires_at>clock_timestamp()+interval \'15 minutes 50 seconds\'',[oldEmail])).rows.length,1);
    await f.pg.exec('BEGIN;SET LOCAL ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[user.academy]);const contact=(await f.pg.query<{email:string;email_verified:boolean}>('SELECT * FROM public.guardian_contact_status($1)',[user.person])).rows[0];assert.equal(contact.email,target);assert.equal(contact.email_verified,true);}finally{await f.pg.exec('ROLLBACK');}
   });
   assert.equal((await f.signin(user)).response.status,401);user.email=target;assert.equal((await f.signin(user)).response.status,200);assert.equal((await f.business(user)).status,originalBusinessStatus);assert.equal((await f.request('/memberships',undefined,user.jar)).body.data[0].academy_id,user.academy);
   const reused=await f.invitation(false);await f.admin(()=>f.pg.query('UPDATE identity.invites SET email=$2 WHERE academy_id=$1',[reused.academy,oldEmail]));reused.email=oldEmail;
   const denied=await f.request('/sign-up/email',{name:'Synthetic reuse',email:oldEmail,password},reused.jar,{'x-kavosh-invitation':reused.token});assert.equal(denied.response.status,422,JSON.stringify(denied.body));assert.equal(denied.body.code,'FAILED_TO_CREATE_USER');
   await f.admin(()=>f.pg.query('UPDATE identity.retired_emails SET expires_at=clock_timestamp()-interval \'1 second\' WHERE email=$1',[oldEmail]));await f.signup(reused);
  });
 }finally{await f.close();}
});

test('email change: master remains nontransferable and must finish MFA again after changing both inboxes',async()=>{
 const f=await fixture();try{
  const user=await f.invitation(true);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);await f.mfa(user,user.jar,true);assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,200);
  const target='changed-master@example.test',r=await f.request('/email-change/request',{email:target,password},user.jar);assert.equal(r.response.status,202);
  const current=f.messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Email change approval code:'))!.text.match(/code: (\d{8})/)![1];assert.equal((await f.request('/email-change/authorize',{requestId:r.body.requestId,code:current},user.jar)).response.status,202);
  const next=f.messages.emails.findLast(m=>m.to===target)!.text.match(/code: (\d{8})/)![1];assert.equal((await f.request('/email-change/confirm',{requestId:r.body.requestId,code:next},user.jar)).response.status,200);
  await f.admin(async()=>{
   assert.equal((await f.pg.query<{master_person_id:string}>('SELECT master_person_id FROM public.academies WHERE id=$1',[user.academy])).rows[0].master_person_id,user.person);
   assert.equal((await f.pg.query<{auth_user_id:string}>('SELECT auth_user_id FROM public.people WHERE id=$1',[user.person])).rows[0].auth_user_id,user.id);
   const u=(await f.pg.query<{mfaRequired:boolean;twoFactorEnabled:boolean}>('SELECT * FROM identity."user" WHERE id=$1',[user.id])).rows[0];assert.equal(u.mfaRequired,true);assert.equal(u.twoFactorEnabled,true);
   assert.equal((await f.pg.query('SELECT * FROM identity.verification WHERE value=$1',[user.id])).rows.length,0);
  });
  user.email=target;assert.equal((await f.signin(user)).body.twoFactorRedirect,true);assert.equal((await f.request('/email-change/request',{email:'other-master@example.test',password},user.jar)).response.status,401);await f.mfa(user);assert.equal((await f.business(user)).status,200);assert.equal((await f.request('/two-factor/disable',{password},user.jar)).response.status,403);
 }finally{await f.close();}
});

test('email change: password revocation expiry cancellation and failed older delivery cannot restore superseded proofs',async()=>{
 const f=await fixture();try{
  const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);
  const target='expiry-email@example.test',original=f.delivery.email;let replacement='';
  f.delivery.email=async message=>{f.delivery.email=original;const newer=await f.request('/email-change/request',{email:target,password},user.jar);assert.equal(newer.response.status,202);replacement=newer.body.requestId;throw new Error('Synthetic older delivery failed after newer request persisted');};
  try{assert.equal((await f.request('/email-change/request',{email:target,password},user.jar)).response.status,503);}finally{f.delivery.email=original;}
  assert.equal((await f.request('/email-change',undefined,user.jar)).body.data.requestId,replacement);
  const code=f.messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Email change approval code:'))!.text.match(/code: (\d{8})/)![1];
  await f.admin(()=>f.pg.query('UPDATE identity.email_change_requests SET expires_at=clock_timestamp()-interval \'1 second\' WHERE user_id=$1',[user.id]));
  assert.equal((await f.request('/email-change/authorize',{requestId:replacement,code},user.jar)).response.status,409);
  await f.admin(()=>f.pg.query('UPDATE identity.session SET "createdAt"=clock_timestamp()-interval \'16 minutes\' WHERE "userId"=$1',[user.id]));
  assert.equal((await f.request('/email-change/request',{email:target,password},user.jar)).body.error.code,'FRESH_SIGN_IN_REQUIRED');
  assert.equal((await f.request('/email-change/cancel',{requestId:replacement},user.jar)).response.status,200,'freshness is not required for own cancellation');
  await f.signin(user);await f.admin(()=>f.pg.query('DELETE FROM identity.auth_budgets'));
  const r=await f.request('/email-change/request',{email:target,password},user.jar);assert.equal(r.response.status,202);const current=f.messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Email change approval code:'))!.text.match(/code: (\d{8})/)![1];assert.equal((await f.request('/email-change/authorize',{requestId:r.body.requestId,code:current},user.jar)).response.status,202);
  const next=f.messages.emails.findLast(m=>m.to===target)!.text.match(/code: (\d{8})/)![1],newPassword='Synthetic email changed password 567!';assert.equal((await f.request('/change-password',{currentPassword:password,newPassword},user.jar)).response.status,200);
  assert.equal((await f.request('/email-change/confirm',{requestId:r.body.requestId,code:next},user.jar)).response.status,401);
  assert.equal((await f.signin(user,user.jar,newPassword)).response.status,200);assert.equal((await f.request('/email-change/confirm',{requestId:r.body.requestId,code:next},user.jar)).response.status,409);
  await f.admin(async()=>{assert.equal((await f.pg.query<{email:string}>('SELECT email FROM identity."user" WHERE id=$1',[user.id])).rows[0].email,user.email);assert.equal((await f.pg.query('SELECT * FROM identity.email_change_requests WHERE user_id=$1',[user.id])).rows.length,0);});
 }finally{await f.close();}
});

test('email change native competing accounts consume one unique target without partial changes',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const f=await fixture();try{
  const target='competing-email@example.test',cases:{user:Awaited<ReturnType<typeof f.invitation>>;requestId:string;code:string}[]=[];
  for(let i=0;i<2;i++){
   const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);
   const r=await f.request('/email-change/request',{email:target,password},user.jar);assert.equal(r.response.status,202);const code=f.messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Email change approval code:'))!.text.match(/code: (\d{8})/)![1];assert.equal((await f.request('/email-change/authorize',{requestId:r.body.requestId,code},user.jar)).response.status,202);
   cases.push({user,requestId:r.body.requestId,code:f.messages.emails.findLast(m=>m.to===target)!.text.match(/code: (\d{8})/)![1]});
  }
  const start=performance.now(),results=await Promise.all(cases.map(c=>f.request('/email-change/confirm',{requestId:c.requestId,code:c.code},c.user.jar)));assert.deepEqual(results.map(r=>r.response.status).sort(),[200,409]);
  const winner=results.findIndex(r=>r.response.status===200),loser=1-winner;await f.admin(async()=>{
   assert.equal((await f.pg.query('SELECT id FROM identity."user" WHERE email=$1',[target])).rows.length,1);
   assert.equal((await f.pg.query("SELECT * FROM identity.security_events WHERE event='email.changed'")).rows.length,1);
   assert.equal((await f.pg.query('SELECT * FROM identity.session WHERE "userId"=$1',[cases[winner].user.id])).rows.length,0);
   assert.equal((await f.pg.query('SELECT * FROM identity.session WHERE "userId"=$1',[cases[loser].user.id])).rows.length,1);
   assert.equal((await f.pg.query<{email:string}>('SELECT email FROM identity."user" WHERE id=$1',[cases[loser].user.id])).rows[0].email,cases[loser].user.email);
  });
  console.log('Two competing email changes finished in '+Math.ceil(performance.now()-start)+'ms;not capacity/SLO evidence.');
 }finally{await f.close();}
});

test('email change: encrypted delivery deadline never outlives the actual remaining new-inbox proof',async()=>{
 const f=await fixture();try{
  const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);
  const r=await f.request('/email-change/request',{email:'queued-email@example.test',password},user.jar);assert.equal(r.response.status,202);const code=f.messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Email change approval code:'))!.text.match(/code: (\d{8})/)![1];
  await f.admin(()=>f.pg.query('UPDATE identity.email_change_requests SET expires_at=clock_timestamp()+interval \'20 seconds\' WHERE user_id=$1',[user.id]));
  const queue=queuedDelivery(f.store,config.secret),original=f.delivery.email;f.delivery.email=queue.email;
  try{assert.equal((await f.request('/email-change/authorize',{requestId:r.body.requestId,code},user.jar)).response.status,202);}finally{f.delivery.email=original;}
  await f.admin(async()=>{
   const row=(await f.pg.query<{bounded:boolean;short:boolean;payload:string}>('SELECT o.expires_at<=r.expires_at bounded,o.expires_at<o.created_at+interval \'21 seconds\' short,o.payload FROM identity.delivery_outbox o CROSS JOIN identity.email_change_requests r WHERE r.user_id=$1',[user.id])).rows[0];assert.equal(row.bounded,true);assert.equal(row.short,true);assert.ok(!row.payload.includes('queued-email@example.test'));assert.ok(!row.payload.includes('New email verification code:'));
   await f.pg.exec('UPDATE identity.delivery_outbox SET expires_at=clock_timestamp()-interval \'1 second\'');
  });
  let sends=0;await f.worker(async worker=>{assert.equal(await deliverOne(worker,config.secret,{async email(){sends++;},async sms(){sends++;}}),false);});assert.equal(sends,0);
  await f.admin(async()=>{const row=(await f.pg.query<{payload:null;outcome:string}>('SELECT payload,outcome FROM identity.delivery_outbox')).rows[0];assert.equal(row.payload,null);assert.equal(row.outcome,'expired');});
  await queue.email({to:'default-expiry@example.test',subject:'Synthetic default expiry',text:'Synthetic email without custom deadline'});
  await f.admin(async()=>{assert.equal((await f.pg.query('SELECT 1 FROM identity.delivery_outbox WHERE outcome IS NULL AND expires_at=created_at+interval \'14 minutes\'')).rows.length,1);});
  await assert.rejects(queue.email({to:'default-expiry@example.test',subject:'Invalid deadline',text:'Synthetic',expiresAt:'not-a-date'}));
 }finally{await f.close();}
});

test('contact change native proof mutations refuse in-flight password revocation before recovery-row writes',{skip:!process.env.TEST_DATABASE_URL,timeout:15000},async()=>{
 const f=await fixture();try{
  const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);let pass=password;
  for(const action of ['phone.request','phone.authorize','phone.cancel','email.request','email.authorize','email.confirm','email.cancel']){
   // Each round tests a different native mutation,not repeated password rate
   // limits (the library correctly allows only3 password changes/10seconds).
   await f.admin(()=>f.pg.exec('DELETE FROM identity.auth_budgets;DELETE FROM identity."rateLimit"'));assert.equal((await f.signin(user,user.jar,pass)).response.status,200,action);const session=(await f.request('/get-session',undefined,user.jar)).body.session.id,requestId=randomUUID(),hash='b'.repeat(64),newHash='c'.repeat(64);
   const phoneAction=action.startsWith('phone.');
   if(!action.endsWith('.request')){
    const result=phoneAction?await f.store.preparePhoneChange(user.id,session,requestId,'+16479990701',hash):await f.store.prepareEmailChange(user.id,session,requestId,'locked-source@example.test',hash);assert.equal(result,'PREPARED');
    if(action==='email.confirm')assert.equal((await f.store.authorizeEmailChange(user.id,session,requestId,hash,newHash))?.email,'locked-source@example.test');
   }
   const nextPassword=pass+'!';let changed!:ReturnType<typeof f.request>;
   await f.admin(async()=>{
    await f.pg.exec('BEGIN');try{
     await f.pg.query('SELECT id FROM identity.session WHERE id=$1 FOR UPDATE',[session]);changed=f.request('/change-password',{currentPassword:pass,newPassword:nextPassword},user.jar);
     let waiting=false;for(let i=0;i<200;i++){if((await f.pg.query<{n:number}>("SELECT count(*)::integer n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'")).rows[0].n){waiting=true;break;}await new Promise<void>(r=>setTimeout(r,10));}assert.equal(waiting,true,action+': password writer must actually be queued');
     const results:Record<string,()=>Promise<unknown>>={
      'phone.request':()=>f.store.preparePhoneChange(user.id,session,requestId,'+16479990701',hash),'phone.authorize':()=>f.store.authorizePhoneChange(user.id,session,requestId,hash),'phone.cancel':()=>f.store.cancelPhoneChange(user.id,session,requestId),
      'email.request':()=>f.store.prepareEmailChange(user.id,session,requestId,'locked-source@example.test',hash),'email.authorize':()=>f.store.authorizeEmailChange(user.id,session,requestId,hash,newHash),'email.confirm':()=>f.store.completeEmailChange(user.id,session,requestId,newHash),'email.cancel':()=>f.store.cancelEmailChange(user.id,session,requestId)
     };
     const expected:Record<string,unknown>={'phone.request':'VERIFICATION_REQUIRED','phone.authorize':false,'phone.cancel':false,'email.request':'VERIFICATION_REQUIRED','email.authorize':null,'email.confirm':'INVALID_EMAIL_CHANGE','email.cancel':false};
     assert.equal(await results[action](),expected[action],action+' must refuse BEFORE releasing the competing writer');await f.pg.exec('COMMIT');
    }finally{await f.pg.exec('ROLLBACK');}
   });
   assert.equal((await changed).response.status,200,action);pass=nextPassword;
   await f.admin(async()=>{const u=(await f.pg.query<{email:string;phoneNumber:string}>('SELECT email,"phoneNumber" FROM identity."user" WHERE id=$1',[user.id])).rows[0];assert.equal(u.email,user.email);assert.equal(u.phoneNumber,user.phone);for(const table of ['email_change_requests','phone_change_requests'])assert.equal((await f.pg.query('SELECT * FROM identity.'+table+' WHERE user_id=$1',[user.id])).rows.length,0);});
  }
 }finally{await f.close();}
});

test('email change actual197to198 upgrade preserves old identities active phone proof bindings and helper ACLs',async()=>{
 const f=await fixture({throughSchema:197});try{
  const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);const r=await f.request('/phone-change/request',{phoneNumber:'+16479990601',password},user.jar);assert.equal(r.response.status,202);
  await f.admin(async()=>{
   const tables=['identity."user"','identity.session','identity.account','identity.verification','identity.invites','identity.security_events','identity.phone_change_requests','public.people','public.academies','public.role_assignments'];
   async function snapshot(){const rows=[];for(const table of tables)rows.push({table,rows:(await f.pg.query('SELECT to_jsonb(x) r FROM '+table+' x ORDER BY to_jsonb(x)::text')).rows});return rows;}
   const before=await snapshot(),helpers="SELECT oid,proowner,proacl FROM pg_proc WHERE oid=ANY(ARRAY['identity.cleanup_expired_auth()'::regprocedure,'identity.prepare_phone_change(uuid,uuid,uuid,text,text)'::regprocedure,'identity.authorize_phone_change(uuid,uuid,uuid,text)'::regprocedure,'identity.cancel_phone_change(uuid,uuid,uuid)'::regprocedure,'identity.phone_change_source(uuid,uuid)'::regprocedure,'public.guardian_contact_status(uuid)'::regprocedure]) ORDER BY oid",acl=(await f.pg.query(helpers)).rows;
   await f.pg.exec(await readFile(new URL('../db/migrations/198_verified_email_changes.sql',import.meta.url),'utf8'));assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.pg.query(helpers)).rows,acl);assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,198);await upgradeToCurrent(f.pg);assert.equal((await f.pg.query('SELECT * FROM identity.email_change_requests')).rows.length,0);
  });
  assert.equal((await f.request('/get-session',undefined,user.jar)).body.user.id,user.id);const code=f.messages.emails.findLast(m=>m.to===user.email&&m.text.startsWith('Phone change approval code:'))!.text.match(/code: (\d{8})/)![1];assert.equal((await f.request('/phone-change/authorize',{requestId:r.body.requestId,code},user.jar)).response.status,200);
 }finally{await f.close();}
});

test('phone change actual196to197 upgrade preserves existing identities sessions credentials bindings and helper ownership',async()=>{
 const f=await fixture({throughSchema:196});try{const user=await f.invitation(false);await f.signup(user);await f.verifyEmail(user);await f.signin(user);await f.phone(user);await f.signin(user);assert.equal((await f.request('/accept-invitation',{invitation:user.token},user.jar)).response.status,200);const tables=['identity."user"','identity.session','identity.account','identity.verification','identity.invites','identity.security_events','public.people','public.academies','public.role_permissions','public.role_assignments'],snapshot=async()=>{const r=[];for(const table of tables){const rows=(await f.pg.query('SELECT to_jsonb(x) r FROM '+table+' x ORDER BY to_jsonb(x)::text')).rows;r.push({table,count:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')});}return r;};await f.admin(async()=>{const before=await snapshot(),helpers="SELECT oid,proowner,proacl FROM pg_proc WHERE oid=ANY(ARRAY['identity.cleanup_expired_auth()'::regprocedure,'identity.enforce_user_security()'::regprocedure,'public.lock_human(uuid,uuid)'::regprocedure]) ORDER BY oid",owners=(await f.pg.query(helpers)).rows;await f.pg.exec(await readFile(new URL('../db/migrations/197_verified_phone_changes.sql',import.meta.url),'utf8'));assert.deepEqual(await snapshot(),before);assert.deepEqual((await f.pg.query(helpers)).rows,owners);assert.equal((await f.pg.query('SELECT public.schema_revision() n')).rows[0].n,197);await upgradeToCurrent(f.pg);assert.equal((await f.pg.query('SELECT * FROM identity.phone_change_requests')).rows.length,0);});assert.equal((await f.request('/get-session',undefined,user.jar)).body.user.id,user.id);assert.equal((await f.request('/phone-change/request',{phoneNumber:'+16479990301',password},user.jar)).response.status,202);
 }finally{await f.close();}
});

test('provider configuration fails closed and SMS sends only to fixed endpoint',async()=>{
  assert.throws(()=>providerDelivery({}),/SMTP_HOST/);
  let called=0;
  const send:typeof fetch=async (url,options)=>{
    called++;assert.match(String(url),/^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC[a-f0-9]{32}\/Messages.json$/);
    assert.equal(options?.redirect,'error');assert.ok(options?.signal);
    return Response.json({sid:'SM'+'a'.repeat(32),account_sid:'AC'+'a'.repeat(32),messaging_service_sid:'MG'+'a'.repeat(32),to:'+16475550000',status:'accepted',error_code:null},{status:201});
  };
  const delivery=providerDelivery({SMTP_HOST:'smtp.example.test',SMTP_PORT:'465',SMTP_USER:'synthetic',SMTP_PASSWORD:'synthetic',SMTP_FROM:'test@example.test',
    TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),TWILIO_AUTH_TOKEN:'synthetic-test-token-000000',TWILIO_MESSAGING_SERVICE_SID:'MG'+'a'.repeat(32)},send);
  await delivery.sms({to:'+16475550000',text:'Synthetic message'});assert.equal(called,1);
  await assert.rejects(delivery.sms({to:'http://attacker.example',text:'no'}));assert.equal(called,1);
});

test('HTTP concurrency with 5,000 synthetic identities and 100 simultaneous connections',{skip:!process.env.TEST_DATABASE_URL,timeout:120000},async()=>{
  const f=await fixture();
  const academy=randomUUID(),role=randomUUID(),hub=randomUUID(),country=randomUUID(),region=randomUUID(),city=randomUUID(),course=randomUUID();
  const cookies:string[]=[];
  let masterCookie='';
  const server=createServer(async(req,res)=>{
    try {
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join('; '):value);
      const request=new Request(origin+req.url,{method:req.method,headers,...(req.method==='POST'?{body:Buffer.concat(chunks)}:{})});
      const result=req.url!.startsWith('/api/auth/')?await f.gateway(request):await f.api(request,new URL(request.url).pathname.slice('/api/v1/'.length));
      for(const cookie of result.headers.getSetCookie())res.appendHeader('set-cookie',cookie);
      res.writeHead(result.status,Object.fromEntries([...result.headers].filter(([key])=>key!=='set-cookie')));
      res.end(await result.text());
    }catch{res.writeHead(503);res.end('Unavailable');}
  });
  try {
    // Shared synthetic hash only: never reuse a password hash for real accounts.
    const hash=await hashPassword(password);
    await f.admin(async()=>{
      await f.pg.exec('BEGIN');
      await f.pg.query(`INSERT INTO identity."user"(id,name,email,"emailVerified","phoneNumber","phoneNumberVerified","twoFactorEnabled","mfaRequired")
        SELECT gen_random_uuid(),'Synthetic load user','load'||n||'@example.test',true,'+1647999'||lpad(n::text,4,'0'),true,false,false FROM generate_series(0,4999) n`);
      const master=(await f.pg.query<{id:string}>(`SELECT id FROM identity."user" WHERE email='load0@example.test'`)).rows[0].id;
      await f.pg.query(`INSERT INTO public.academies(id,name,status,master_person_id) VALUES($1,'Synthetic load academy','active',$2)`,[academy,master]);
      await f.pg.query(`INSERT INTO public.people(academy_id,id,kind,name,email,status,auth_user_id)
        SELECT $1,id,'human',name,email,'active',id FROM identity."user"`,[academy]);
      await f.pg.query(`INSERT INTO identity.account(id,"accountId","providerId","userId",password,"updatedAt")
        SELECT gen_random_uuid(),id::text,'credential',id,$1,now() FROM identity."user"`,[hash]);
      await f.pg.query("INSERT INTO public.roles VALUES($1,$2,'Synthetic read-only')",[academy,role]);
      await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'hubs.view','allow')",[academy,role]);
      await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'classes.view','allow')",[academy,role]);
      await f.pg.query('INSERT INTO public.role_assignments SELECT $1,gen_random_uuid(),id,$2,true FROM public.people',[academy,role]);
      await f.pg.query("INSERT INTO public.countries(academy_id,id,code,name) VALUES($1,$2,'CA','Canada')",[academy,country]);
      await f.pg.query("INSERT INTO public.regions(academy_id,id,country_id,code,name) VALUES($1,$2,$3,'ON','Ontario')",[academy,region,country]);
      await f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Toronto')",[academy,city,region]);
      await f.pg.query("INSERT INTO public.hubs(academy_id,id,name,city,country_code,city_id,time_zone,currency) VALUES($1,$2,'Synthetic hub','Toronto','CA',$3,'America/Toronto','CAD')",[academy,hub,city]);
      await f.pg.query("INSERT INTO public.courses(academy_id,id,code,name) VALUES($1,$2,'LOAD-101','Synthetic curriculum')",[academy,course]);
      await f.pg.query('INSERT INTO public.course_revisions(academy_id,course_id,version,definition) VALUES($1,$2,1,$3::jsonb)',[academy,course,
        JSON.stringify({code:'LOAD-101',name:'Synthetic curriculum',description:'',hubId:null,translations:{},active:true,modules:[]})]);
      await f.pg.exec('COMMIT');
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const url=`http://127.0.0.1:${address.port}`;
    let next=0;
    const rss=process.memoryUsage().rss,cpu=process.cpuUsage();
    const login=await autocannon({url,connections:100,amount:100,timeout:30,
      requests:[{method:'POST',path:'/api/auth/sign-in/email',headers:{origin,'content-type':'application/json'},body:'{}',onResponse(status,body,_context,headers){
        if(status===200){const raw=headers?.['set-cookie'],cookie=(Array.isArray(raw)?raw:[String(raw)]).map(value=>value.split(';')[0]).join('; ');cookies.push(cookie);
          if(JSON.parse(body).user.email==='load0@example.test')masterCookie=cookie;}
      }}],setupClient(client){client.setBody(JSON.stringify({email:`load${next++}@example.test`,password}));}});
    assert.equal(login.errors,0);assert.equal(login.timeouts,0);assert.equal(login.non2xx,0);assert.equal(cookies.length,100);
    assert.ok(masterCookie);
    const oneOff=Array.from({length:500},(_,n)=>{const day=new Date(Date.UTC(2027,0,n+1)).toISOString().slice(0,10);return {start:day+'T10:00',end:day+'T11:00'};});
    const create=await fetch(url+'/api/v1/classes',{method:'POST',headers:{origin,cookie:masterCookie,'x-academy-id':academy,'content-type':'application/json','idempotency-key':randomUUID()},
      body:JSON.stringify({hubId:hub,courseId:course,courseVersion:1,name:'Synthetic 500-session class',mode:'in_person',schedule:{oneOff}})});
    const created=await create.json();assert.equal(create.status,201,JSON.stringify(created));assert.equal(created.schedule.sessionCount,500);
    async function run(path:string,amount:number,expectedRows?:number) {
      let index=0,validBodies=0;
      const result=await autocannon({url:url+path,connections:100,amount,timeout:30,requests:[{path,onResponse(status,body){
        if(expectedRows===undefined)return;
        try{if(status===200&&JSON.parse(body).data?.length===expectedRows)validBodies++;}catch{/* Count malformed bodies as invalid results. */}
      }}],setupClient(client){
        client.setHeaders({origin,cookie:cookies[index++%cookies.length],'x-academy-id':academy});
      }});
      assert.equal(result.errors,0);assert.equal(result.timeouts,0);assert.equal(result.non2xx,0);
      if(expectedRows!==undefined)assert.equal(validBodies,amount,'every load response must contain the expected permitted records');
      assert.equal(result.requests.total,amount);return result;
    }
    const sessions=await run('/api/auth/get-session',300),business=await run('/api/v1/hubs',300,1),calendar=await run('/api/v1/classes/'+created.data.id+'/sessions?limit=100',300,100);
    const usage=process.cpuUsage(cpu);
    console.log(JSON.stringify({check:'synthetic-auth-load',identities:5000,connections:100,
      login:{requests:login.requests.total,p99Ms:login.latency.p99},sessions:{requests:sessions.requests.total,p99Ms:sessions.latency.p99},
      business:{requests:business.requests.total,p99Ms:business.latency.p99},calendar:{storedSessions:500,requests:calendar.requests.total,rowsPerResponse:100,p99Ms:calendar.latency.p99},rssGrowthMiB:Math.round((process.memoryUsage().rss-rss)/1048576),cpuMs:Math.round((usage.user+usage.system)/1000)}));
  }finally{
    server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));
    await f.close();
  }
});
