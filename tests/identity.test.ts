import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes,randomUUID,createHmac } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { testDatabase } from './database.ts';
import { createIdentity,type Delivery } from '../src/auth/config.ts';
import { IdentityStore } from '../src/auth/store.ts';
import { identityGateway,verifiedProxyIp,humanResolver } from '../src/auth/gateway.ts';
import { queuedDelivery,deliverOne,providerDelivery } from '../src/auth/delivery.ts';
import { createApi } from '../src/core/api.ts';
import { business as businessRoutes } from '../src/modules/business.ts';
import type { Database } from '../src/core/database.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import autocannon from 'autocannon';
import { hashPassword } from 'better-auth/crypto';

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
async function fixture() {
  const pg=await testDatabase();
  const directory=new URL('../db/migrations/',import.meta.url);
  for(const file of (await readdir(directory)).filter(n=>n.endsWith('.sql')).sort())await pg.exec(await readFile(new URL(file,directory),'utf8'));
  const db=pg.identityDb(),store=new IdentityStore(db,config.secret);
  async function admin<T>(fn:()=>Promise<T>){await pg.exec('RESET ROLE');try{return await fn();}finally{if(!pg.runtime)await pg.exec('SET ROLE kavosh_identity');}}
  const messages:{emails:{to:string;text:string}[];sms:{to:string;text:string}[]}={emails:[],sms:[]};
  const delivery:Delivery={async email(message){messages.emails.push(message);},async sms(message){messages.sms.push(message);}};
  const auth=createIdentity(db,store,delivery,config),gateway=identityGateway(auth,store,config);
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
  const api=createApi(database,humanResolver(auth,store,config),businessRoutes);
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
  return {pg,db,store,admin,worker,messages,delivery,request,invitation,signup,verifyEmail,signin,phone,otp,mfa,business,close,gateway,api};
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
      const other=sessions.body.find((s:{id:string})=>s.id!==own.body.session.id);
      assert.equal((await f.request('/revoke-session',{sessionId:other.id},regular.jar)).response.status,200);
      assert.equal((await f.request('/get-session',undefined,fresh)).body,null);
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
        assert.equal(await deliverOne(worker,config.secret,{...f.delivery,async sms(){throw new Error('synthetic transport failure');}}),true);
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

test('production edge trust rejects spoofed and malformed proxy headers',()=>{
  const production={...config,production:true,edgeSecret:'a'.repeat(32)};
  assert.throws(()=>verifiedProxyIp(new Request(origin),production),/UNTRUSTED_PROXY/);
  assert.throws(()=>verifiedProxyIp(new Request(origin,{headers:{'x-kavosh-edge-key':'é'.repeat(32),'x-kavosh-client-ip':'1.2.3.4'}}),production),/UNTRUSTED_PROXY/);
  assert.equal(verifiedProxyIp(new Request(origin,{headers:{'x-kavosh-edge-key':production.edgeSecret,'x-kavosh-client-ip':'1.2.3.4'}}),production),'1.2.3.4');
});

test('provider configuration fails closed and SMS sends only to fixed endpoint',async()=>{
  assert.throws(()=>providerDelivery({}),/SMTP_HOST/);
  let called=0;
  const send:typeof fetch=async (url,options)=>{
    called++;assert.match(String(url),/^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC[a-f0-9]{32}\/Messages.json$/);
    assert.equal(options?.redirect,'error');assert.ok(options?.signal);
    return new Response('{}',{status:201});
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
