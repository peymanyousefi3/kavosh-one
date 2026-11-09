import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { test,before,after } from 'node:test';
import { checkoutFixture } from './checkout-fixture.ts';
import { record } from '../src/core/api.ts';
import type { Connection } from '../src/core/database.ts';
import { upgradeToCurrent } from './migration-upgrade.ts';
import { executeCheckoutAttempt,CheckoutWorkerError } from '../src/integrations/checkout-worker.ts';
import { buildStripeCheckout,type StripeCheckoutConnection } from '../src/integrations/stripe-checkout.ts';

const priorOrigin=process.env.APP_ORIGIN;before(()=>{process.env.APP_ORIGIN='https://academy.example';});after(()=>{if(priorOrigin===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=priorOrigin;});
async function fixture(){const f=await checkoutFixture(),r=await f.prepare();assert.equal(r.response.status,201,JSON.stringify(r.body));const requestId=r.body.data.id,path='finance/checkout-requests/'+requestId;
 const source=(as='master')=>f.request(path+'/dispatch-source',undefined,as);
 async function reserve(as='master',patch:Record<string,unknown>={},key?:string){const s=await source(as);assert.equal(s.response.status,200,JSON.stringify({body:s.body,failures:f.metrics.queryFailures}));const d=s.body.data;return f.request(path+'/attempts',{requestSha256:d.receipt.requestSha256,requestBytes:d.receipt.requestBytes,sourceFingerprint:d.sourceFingerprint,expiresAt:d.draft.expiresAt,...patch},as,{key});}
 const start=(a:any,as='master',key?:string)=>f.request(path+'/attempts/'+a.id+'/dispatch',{requestSha256:a.requestSha256,requestBytes:a.requestBytes},as,{key}),observe=(a:any,state='outcome_unknown',as='master',key?:string)=>f.request(path+'/attempts/'+a.id+'/dispatch/outcome',{state,...state==='accepted'?{sessionId:'cs_test_syntheticSession'}:{}},as,{key});
 return {...f,requestId,path,source,reserve,start,observe};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}
check('server-only nonsecret draft and exact durable reservation preserve original invoice money and one request identity',async f=>{
 const source=await f.source();assert.equal(source.response.status,200,JSON.stringify(source.body));const d=source.body.data;
 assert.equal(d.draft.amountMinor,'5000');assert.equal(d.draft.accountId,f.connection.accountId);assert.equal(d.draft.successUrl,'https://academy.example/?payment_request='+f.requestId+'&payment_return=success');assert.equal(d.dispatchAuthority,false);assert.doesNotMatch(JSON.stringify(d),/apiKey|whsec_|sk_test_|PRIVATE|legalName/);
 const key=randomUUID(),input={requestSha256:d.receipt.requestSha256,requestBytes:d.receipt.requestBytes,sourceFingerprint:d.sourceFingerprint,expiresAt:d.draft.expiresAt},a=await f.request(f.path+'/attempts',input,'master',{key});assert.equal(a.response.status,201,JSON.stringify({body:a.body,failures:f.metrics.queryFailures}));assert.deepEqual((await f.request(f.path+'/attempts',input,'master',{key})).body,a.body);
 assert.equal((await f.request(f.path+'/attempts',input)).response.status,409);assert.equal((await f.request(f.path+'/attempts')).body.data.length,1);
 const normal=await f.request(f.path+'/attempts/'+a.body.data.id);assert.equal(normal.response.status,200);assert.equal(normal.body.data.draft,undefined);const privateRead=await f.request(f.path+'/attempts/'+a.body.data.id+'/source');assert.equal(privateRead.response.status,200);assert.deepEqual(privateRead.body.data.draft,d.draft);assert.equal(privateRead.body.data.dispatchAuthority,false);
 assert.equal((await f.status()).balance,'113.00');assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.tuition_receipts')).rows[0].n,0);
});
for(const scenario of ['accepted','lost_start','lost_provider','lost_observation','wrong_manifest'] as const)check('isolated actual SDK plus native coordination: '+scenario,async f=>{
 const a=(await f.reserve()).body.data,source=(await f.request(f.path+'/attempts/'+a.id+'/source')).body.data;
 const {secrets:_secrets,...identity}=f.connection,config:StripeCheckoutConnection={...identity,origin:'https://academy.example',apiKey:['sk','test',randomBytes(24).toString('hex')].join('_')},token='kvo_'+randomBytes(32).toString('base64url');
 const built=buildStripeCheckout(source.draft,config),sessionId='cs_test_'+randomBytes(12).toString('hex');let posts=0,backendCalls=0;
 const send:typeof fetch=async(url,init)=>{
  const u=new URL(String(url)),method=init?.method??'GET';assert.equal(init?.redirect,'error');
  if(u.origin===config.origin){backendCalls++;assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+token);const path=u.pathname.slice('/api/v1/'.length),body=method==='GET'?undefined:JSON.parse(String(init?.body)),r=await f.request(path,body,'master',{key:new Headers(init?.headers).get('idempotency-key')??undefined});
   if(scenario==='lost_start'&&path.endsWith('/dispatch'))throw new Error('PRIVATE lost committed start');
   if(scenario==='lost_observation'&&path.endsWith('/outcome'))throw new Error('PRIVATE lost committed observation');
   if(scenario==='wrong_manifest'&&path.endsWith('/source'))r.body.data.requestSha256='0'.repeat(64);
   return Response.json(r.body,{status:r.response.status});
  }
  assert.equal(u.origin,'https://api.stripe.com');assert.notEqual(new Headers(init?.headers).get('authorization'),'Bearer '+token);
  if(u.pathname==='/v1/account')return Response.json({id:config.accountId,object:'account',country:'CA',charges_enabled:true,capabilities:{card_payments:'active'}});
  if(u.pathname==='/v1/country_specs/CA')return Response.json({id:'CA',object:'country_spec',supported_payment_currencies:['cad'],supported_payment_methods:['card']});
  assert.equal(u.pathname,'/v1/checkout/sessions');assert.equal(method,'POST');posts++;assert.equal(new Headers(init?.headers).get('idempotency-key'),source.idempotencyKey);const form=new URLSearchParams(String(init?.body));assert.equal(form.get('line_items[0][price_data][unit_amount]'),'5000');assert.equal(form.get('metadata[kavosh_request]'),f.requestId);assert.equal(form.get('success_url'),source.draft.successUrl);
  if(scenario==='lost_provider')throw new Error('PRIVATE '+config.apiKey);
  return Response.json({id:sessionId,object:'checkout.session',livemode:false,mode:'payment',ui_mode:'hosted_page',client_reference_id:f.requestId,metadata:built.params.metadata,currency:'cad',amount_total:5000,amount_subtotal:5000,total_details:{amount_discount:0,amount_shipping:0,amount_tax:0},automatic_tax:{enabled:false},payment_method_types:['card'],status:'open',payment_status:'unpaid',payment_intent:null,expires_at:source.draft.expiresAt,url:'https://checkout.stripe.com/c/pay/'+sessionId});
 };
 const target={requestId:f.requestId,attemptId:a.id},api={origin:config.origin,token};
 if(scenario==='lost_start'||scenario==='wrong_manifest')await assert.rejects(executeCheckoutAttempt(target,config,api,send),e=>e instanceof CheckoutWorkerError&&e.stage===(scenario==='lost_start'?'start':'preflight')&&e.reconciliationRequired===(scenario==='lost_start'));
 else{const result=await executeCheckoutAttempt(target,config,api,send);assert.equal(result.outcome,scenario==='lost_provider'?'outcome_unknown':'accepted');assert.equal(result.observationRecorded,scenario!=='lost_observation');assert.equal(result.paymentVerified,false);assert.equal(result.ledgerAdjusted,false);assert.equal(result.automaticRetryAllowed,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|apiKey|Bearer/);}
 assert.equal(posts,scenario==='lost_start'||scenario==='wrong_manifest'?0:1);assert.equal((await f.status()).received,'0.00');
 if(scenario!=='wrong_manifest'){await assert.rejects(executeCheckoutAttempt(target,config,api,send),e=>e instanceof CheckoutWorkerError&&e.stage==='source');assert.equal(posts,scenario==='lost_start'?0:1);assert.equal((await f.cancel(f.requestId)).response.status,409);}
 const before=backendCalls;await assert.rejects(executeCheckoutAttempt(target,config,{...api,origin:'http://academy.example'},send),e=>e instanceof CheckoutWorkerError&&e.stage==='configuration');assert.equal(backendCalls,before);
});
check('one committed start survives fresh reads and idempotent retries; unverified outcomes cannot permit cancellation,replacement or another charge',async f=>{
 const a=(await f.reserve()).body.data,key=randomUUID(),start=await f.start(a,'master',key);assert.equal(start.response.status,201,JSON.stringify({body:start.body,failures:f.metrics.queryFailures}));assert.equal(start.body.data.providerVerified,false);
 for(const retry of [await f.start(a,'master',key),await f.start(a)])assert.equal(retry.body.error.code,'CHECKOUT_DISPATCH_ALREADY_STARTED');
 const viewed=await f.request(f.path);assert.equal(viewed.body.data.state,'dispatch_started_unverified');assert.equal(viewed.body.data.providerRequestMade,null);assert.equal(viewed.body.data.reconciliationRequired,true);
 const outcomeKey=randomUUID(),o=await f.observe(a,'not_attempted','master',outcomeKey);assert.equal(o.response.status,201,JSON.stringify(o.body));assert.deepEqual((await f.observe(a,'not_attempted','master',outcomeKey)).body,o.body);assert.equal((await f.observe(a,'accepted')).response.status,409);
 assert.equal((await f.cancel(f.requestId)).body.error.code,'CHECKOUT_DISPATCH_RECONCILIATION_REQUIRED');assert.equal((await f.prepare({priorId:f.requestId})).body.error.code,'CHECKOUT_DISPATCH_RECONCILIATION_REQUIRED');assert.equal((await f.start(a)).response.status,409);
 const status=await f.request(f.path+'/attempts/'+a.id);assert.equal(status.body.data.observation.state,'not_attempted');assert.equal(status.body.data.reconciliationRequired,true);assert.equal(status.body.data.providerVerified,false);assert.equal((await f.status()).received,'0.00');
});
check('manifest,expiry and source tampering or caller money/URLs/keys never reserve an executable request',async f=>{
 const s=await f.source();assert.equal(s.response.status,200);const d=s.body.data,base={...d.receipt,sourceFingerprint:d.sourceFingerprint,expiresAt:d.draft.expiresAt};delete base.idempotencyKey;
 for(const patch of [{requestSha256:'0'.repeat(64)},{sourceFingerprint:'0'.repeat(64)},{requestBytes:1},{expiresAt:Math.floor(Date.now()/1000)+100},{amountMinor:'1'},{apiKey:'forbidden'},{successUrl:'https://evil.example'},{draft:{amountMinor:'1'}}]){const r=await f.request(f.path+'/attempts',{...base,...patch});assert.ok([400,409].includes(r.response.status),JSON.stringify({patch,body:r.body}));}
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_attempts')).rows[0].n,0);
 const origin=process.env.APP_ORIGIN;delete process.env.APP_ORIGIN;try{assert.equal((await f.source()).body.error.code,'CHECKOUT_RETURN_ORIGIN_NOT_CONFIGURED');}finally{process.env.APP_ORIGIN=origin;}
});
check('native database guards reject forged draft,money,source and missing audit even outside the HTTP handler',async f=>{
 const s=await f.source();assert.equal(s.response.status,200);const d=s.body.data;
 const db:Connection={query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}};
 for(const change of ['amount','url','source','audit']){
  await f.pg.exec('BEGIN');try{
   await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
   const target=randomUUID(),request=randomUUID();await record(db,{token_id:f.actors.master.session,academy_id:f.a,person_id:f.actors.master.person,capabilities:[],all_hubs:true,hub_ids:[],allowed:true,kind:'human'},request,'finance.checkout.reserved',target,f.hub,{requestId:f.requestId,attemptId:target,severity:'critical',providerVerified:false});
   const audit=(await f.pg.query<{id:string}>('SELECT id FROM public.audit_events WHERE request_id=$1 AND entity_id=$2',[request,target])).rows[0].id;
   await assert.rejects(f.pg.query('INSERT INTO public.payment_checkout_attempts(academy_id,id,request_id,actor_id,audit_id,source_fingerprint,request_sha256,request_bytes,origin,draft) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',[f.a,target,f.requestId,f.actors.master.person,change==='audit'?randomUUID():audit,change==='source'?'0'.repeat(64):d.sourceFingerprint,d.receipt.requestSha256,d.receipt.requestBytes,'https://academy.example',JSON.stringify({...d.draft,...change==='amount'?{amountMinor:'1'}:{},...change==='url'?{successUrl:'https://evil.example/'}:{}})]),change==='audit'?/CHECKOUT_DISPATCH_AUDIT_REQUIRED/:change==='source'?/CHECKOUT_DISPATCH_SOURCE_CHANGED/:/CHECKOUT_DISPATCH_DRAFT_INVALID/);
  }finally{await f.pg.exec('ROLLBACK');}
 }
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_attempts')).rows[0].n,0);assert.equal((await f.status()).received,'0.00');
});
check('independent execute grants,selected students and original invoice rights protect private source and dispatch',async f=>{
 await f.access('staff');assert.equal((await f.source('staff')).response.status,403);
 await f.access('staff',{all:false,studentId:f.student.id,caps:['checkouts.view','checkouts.execute','invoices.view']});const a=await f.reserve('staff');assert.equal(a.response.status,201,JSON.stringify(a.body));assert.equal((await f.start(a.body.data,'staff')).response.status,201);assert.equal((await f.observe(a.body.data,'accepted')).response.status,404);assert.equal((await f.observe(a.body.data,'accepted','staff')).response.status,201);
 assert.equal((await f.request(f.path+'/attempts/'+a.body.data.id+'/source',undefined,'foreignMaster',{academy:f.b})).response.status,404);
 const role=await f.access('staff',{caps:['checkouts.view','checkouts.execute','invoices.view']});await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='invoices.view'",[role.id]);assert.equal((await f.source('staff')).response.status,403);
});
check('minimum30minute and maximum24hour drafts obey provider bounds without a rounded-up25th-hour rejection',async f=>{
 let previous=f.requestId;for(const minutes of [30,1440]){assert.equal((await f.cancel(previous)).response.status,201);const prepared=await f.prepare({priorId:previous,sessionLifetimeMinutes:minutes});assert.equal(prepared.response.status,201);previous=prepared.body.data.id;const path='finance/checkout-requests/'+previous,read=await f.request(path+'/dispatch-source');assert.equal(read.response.status,200,JSON.stringify(read.body));const d=read.body.data,expiry=d.draft.expiresAt,remaining=expiry-Math.floor(Date.now()/1000);assert.ok(remaining>=1799&&remaining<=86400);assert.equal(d.draft.amountMinor,'5000');const reserved=await f.request(path+'/attempts',{expiresAt:expiry,sourceFingerprint:d.sourceFingerprint,requestSha256:d.receipt.requestSha256,requestBytes:d.receipt.requestBytes});assert.equal(reserved.response.status,201,JSON.stringify(reserved.body));}
});
check('scoped bots can coordinate approved work but revoked execute permission stops the next step',async f=>{
 const role=await f.access('bot',{all:false,studentId:f.student.id,caps:['checkouts.view','checkouts.execute','invoices.view']});const a=await f.reserve('bot');assert.equal(a.response.status,201,JSON.stringify(a.body));await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='checkouts.execute'",[role.id]);assert.equal((await f.start(a.body.data,'bot')).response.status,403);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_dispatch_starts')).rows[0].n,0);assert.equal((await f.start(a.body.data)).response.status,201);
});
if(process.env.TEST_DATABASE_URL)check('a real concurrent start versus cancellation commits only one side and never clears an uncertain dispatch',async f=>{
 const a=(await f.reserve()).body.data,results=await Promise.all([f.start(a),f.cancel(f.requestId)]);assert.equal(results.filter(v=>v.response.status===201).length,1,JSON.stringify(results.map(v=>v.body)));assert.equal(results.filter(v=>v.response.status===409).length,1);const counts=(await f.pg.query<{starts:number;cancels:number}>('SELECT(SELECT count(*)::integer FROM public.payment_checkout_dispatch_starts) starts,(SELECT count(*)::integer FROM public.payment_checkout_cancellations) cancels')).rows[0];assert.equal(counts.starts+counts.cancels,1);assert.equal((await f.status()).received,'0.00');
});
check('a receipt,credit or operator connection disable invalidates reserved source before the durable start',async f=>{
 const a=(await f.reserve()).body.data;assert.equal((await f.pay({amount:'1'})).response.status,201);assert.equal((await f.start(a)).response.status,409);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_dispatch_starts')).rows[0].n,0);
 const correction=(await f.request('finance/receipts')).body.data[0];assert.equal((await f.reverse(correction.id)).response.status,201);await f.pg.query('UPDATE public.payment_connections SET enabled=false WHERE id=$1',[f.connection.connectionId]);assert.equal((await f.start(a)).response.status,409);await f.pg.query('UPDATE public.payment_connections SET enabled=true WHERE id=$1',[f.connection.connectionId]);assert.equal((await f.start(a)).response.status,201);
});
check('late actor observations survive changed invoice sources but never become provider proof or a receipt',async f=>{
 const a=(await f.reserve()).body.data;assert.equal((await f.start(a)).response.status,201);assert.equal((await f.credit(f.invoice.id)).response.status,201);const o=await f.observe(a,'accepted');assert.equal(o.response.status,201,JSON.stringify(o.body));assert.equal(o.body.data.paymentVerified,false);
 const read=await f.request(f.path+'/attempts/'+a.id);assert.equal(read.body.data.observation.source_current,false);assert.equal(read.body.data.providerVerified,false);assert.equal(read.body.data.reconciliationRequired,true);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.tuition_receipts')).rows[0].n,0);
});
check('audit/outbox failure rolls back reservation and start; original actor records and school boundaries are immutable',async f=>{
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{const s=await f.source();assert.equal(s.response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 const s=await f.source(),d=s.body.data,input={requestSha256:d.receipt.requestSha256,requestBytes:d.receipt.requestBytes,sourceFingerprint:d.sourceFingerprint,expiresAt:d.draft.expiresAt};
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.request(f.path+'/attempts',input)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_attempts')).rows[0].n,0);const a=(await f.request(f.path+'/attempts',input)).body.data;
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_runtime');try{assert.equal((await f.start(a)).response.status,503);}finally{await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_runtime');}assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_dispatch_starts')).rows[0].n,0);
 await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.payment_checkout_attempts')).rows.length,0);await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);for(const sql of ['DELETE FROM public.payment_checkout_attempts',"UPDATE public.payment_checkout_attempts SET request_sha256=repeat('0',64)",'DELETE FROM public.payment_checkout_dispatch_starts'])await assert.rejects(f.pg.exec(sql),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
});
if(process.env.TEST_DATABASE_URL)check('four short concurrent reservations and starts each retain one durable winner without provider IO',async f=>{
 const s=await f.source(),d=s.body.data,input={requestSha256:d.receipt.requestSha256,requestBytes:d.receipt.requestBytes,sourceFingerprint:d.sourceFingerprint,expiresAt:d.draft.expiresAt},at=performance.now(),r=await Promise.all(Array.from({length:4},()=>f.request(f.path+'/attempts',input)));
 assert.equal(r.filter(v=>v.response.status===201).length,1,JSON.stringify(r.map(v=>v.body)));const a=r.find(v=>v.response.status===201)!.body.data,started=await Promise.all(Array.from({length:4},()=>f.start(a)));assert.equal(started.filter(v=>v.response.status===201).length,1,JSON.stringify(started.map(v=>v.body)));assert.ok(started.filter(v=>v.response.status!==201).every(v=>v.response.status===409));
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.payment_checkout_dispatch_starts')).rows[0].n,1);console.log(JSON.stringify({measurement:'brief-durable-checkout-races',reservationRequests:4,startRequests:4,elapsedMs:Math.ceil(performance.now()-at),starts:1,liveProviderRequests:0}));
});
check('actual293to294 upgrade preserves approved checkout,invoices,original money and audit while adding start protection',async current=>{
 const f=await checkoutFixture({throughSchema:293});try{
  await f.access('staff');const p=await f.prepare({},'staff');assert.equal(p.response.status,202,JSON.stringify(p.body));const original=(await f.pg.query<any>('SELECT * FROM public.approval_requests WHERE id=$1',[p.body.approval.id])).rows[0],id=original.target_id;
  const db:Connection={query:<Row>(sql:string,args?:unknown[])=>f.pg.query<Row>(sql,args),release(){}};await f.pg.exec('BEGIN');try{await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
   await f.pg.query(`INSERT INTO public.payment_checkout_requests(academy_id,id,invoice_id,student_id,class_id,hub_id,connection_id,prior_id,amount_text,amount_minor,currency_id,unit_scale,currency_code,session_lifetime_minutes,dispatch_within_minutes,context,approval_id,created_by,reason) VALUES($1,$2,$3,$4,$5,$6,$7,NULL,$8,5000,$9,2,'CAD',60,10,$10::jsonb,$11,$12,$13)`,[f.a,id,f.invoice.id,f.student.id,f.c.id,f.hub,f.connection.connectionId,f.input.amount,f.currency.id,JSON.stringify(original.review_context),original.id,f.actors.master.person,f.input.reason]);
   await record(db,{token_id:f.actors.master.session,academy_id:f.a,person_id:f.actors.master.person,capabilities:[],all_hubs:true,hub_ids:[],allowed:true,kind:'human'},randomUUID(),'finance.checkout.request',id,f.hub,{approvalId:original.id,severity:'critical',hasReason:true,providerRequestMade:false});await f.pg.query("UPDATE public.approval_requests SET status='applied',reviewer_id=$2,version=2,decided_at=transaction_timestamp() WHERE id=$1",[original.id,f.actors.master.person]);await f.pg.exec('COMMIT');
  }catch(e){await f.pg.exec('ROLLBACK');throw e;}
  const before=(await f.pg.query('SELECT to_jsonb(r) value FROM public.payment_checkout_requests r')).rows[0].value;await upgradeToCurrent(f.pg);assert.deepEqual((await f.pg.query('SELECT to_jsonb(r) value FROM public.payment_checkout_requests r')).rows[0].value,before);assert.equal((await f.request('finance/checkout-requests/'+id)).body.data.state,'approved_unexecuted');assert.equal((await f.request('finance/checkout-requests/'+id+'/dispatch-source')).response.status,200);assert.equal((await f.status()).balance,'113.00');
 }finally{await f.pg.close();}assert.equal((await current.pg.query('SELECT public.schema_revision() n')).rows[0].n,294);
});
