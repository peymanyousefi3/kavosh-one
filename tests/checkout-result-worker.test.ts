import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before,after,test } from 'node:test';
import { checkoutFixture } from './checkout-fixture.ts';
import { assertRuntimeRole,type Database } from '../src/core/database.ts';
import { assertCheckoutResultRole,probeCheckoutResultSink,recordCheckoutTransportReceipt } from '../src/integrations/checkout-result-worker.ts';

const previous=process.env.APP_ORIGIN;before(()=>{process.env.APP_ORIGIN='https://academy.example';});after(()=>{if(previous===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=previous;});
async function fixture(){
 const f=await checkoutFixture();try{
  const r=await f.prepare();assert.equal(r.response.status,201);const path='finance/checkout-requests/'+r.body.data.id,s=(await f.request(path+'/dispatch-source')).body.data;
  const a=await f.request(path+'/attempts',{sourceFingerprint:s.sourceFingerprint,expiresAt:s.draft.expiresAt,requestSha256:s.receipt.requestSha256,requestBytes:s.receipt.requestBytes});assert.equal(a.response.status,201);
  const start=await f.request(path+'/attempts/'+a.body.data.id+'/dispatch',{requestSha256:s.receipt.requestSha256,requestBytes:s.receipt.requestBytes});assert.equal(start.response.status,201);
  const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_checkout_result_worker');return c;}};
  const receipt={academyId:f.a,startId:start.body.data.id,workerId:randomUUID(),requestSha256:s.receipt.requestSha256,state:'accepted',sessionId:'cs_test_syntheticTransport',checkoutUrl:'https://checkout.stripe.com/c/pay/cs_test_syntheticTransport#private'};
  return {...f,database,receipt,path,attemptId:a.body.data.id};
 }catch(e){await f.pg.close();throw e;}
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.exec('RESET ROLE');await f.pg.close();}});}
check('separate service receipt is immutable,idempotent,private and never original payment evidence',async f=>{
 await probeCheckoutResultSink(f.database);await probeCheckoutResultSink(f.database,{academyId:f.a,startId:f.receipt.startId,requestSha256:f.receipt.requestSha256});
 const r=await recordCheckoutTransportReceipt(f.database,f.receipt);assert.equal(r.status,'recorded');assert.equal(r.paymentVerified,false);assert.equal((await recordCheckoutTransportReceipt(f.database,f.receipt)).status,'duplicate');
 const view=await f.request(f.path+'/attempts/'+f.attemptId);assert.equal(view.response.status,200);assert.equal(view.body.data.transportObservation.provenance,'isolated_service');assert.equal(view.body.data.transportObservation.conflict,false);assert.equal(view.body.data.transportObservation.paymentVerified,false);assert.doesNotMatch(JSON.stringify(view.body),/checkout[.]stripe|#private|recorded_by/);assert.equal((await f.status()).received,'0.00');
 await f.pg.exec('SET ROLE kavosh_runtime');try{await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.a]);await assert.rejects(f.pg.exec('SELECT checkout_url FROM public.checkout_transport_receipts'),/permission denied/);await assert.rejects(f.pg.exec('DELETE FROM public.checkout_transport_receipts'),/permission denied/);await f.pg.query("SELECT set_config('app.academy_id',$1,false)",[f.b]);assert.equal((await f.pg.query('SELECT state FROM public.checkout_transport_receipts')).rows.length,0);}finally{await f.pg.exec('RESET ROLE');}
});
check('original transport wins;contradictory service and later actor notes retain critical conflicts without overwriting',async f=>{
 await recordCheckoutTransportReceipt(f.database,f.receipt);const other={academyId:f.a,startId:f.receipt.startId,workerId:randomUUID(),requestSha256:f.receipt.requestSha256,state:'not_attempted'};
 assert.equal((await recordCheckoutTransportReceipt(f.database,other)).status,'conflict');assert.equal((await recordCheckoutTransportReceipt(f.database,other)).status,'conflict');assert.equal((await recordCheckoutTransportReceipt(f.database,f.receipt)).status,'duplicate_conflict');
 assert.equal((await f.request(f.path+'/attempts/'+f.attemptId+'/dispatch/outcome',{state:'rejected'})).response.status,201);
 assert.equal((await f.request(f.path+'/attempts/'+f.attemptId)).body.data.transportObservation.conflict,true);const rows=(await f.pg.query('SELECT state FROM public.checkout_transport_receipts')).rows;assert.deepEqual(rows,[{state:'accepted'}]);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.checkout_transport_conflicts')).rows[0].n,1);
 assert.equal((await f.pg.query("SELECT count(*)::integer n FROM public.outbox_events WHERE event_type='checkout.transport.actor_conflict.critical'")).rows[0].n,1);
});
check('actor-first conflict and late results survive user deactivation and invoice credit without granting payment rights',async f=>{
 assert.equal((await f.request(f.path+'/attempts/'+f.attemptId+'/dispatch/outcome',{state:'not_attempted'})).response.status,201);assert.equal((await f.credit(f.invoice.id)).response.status,201);await f.pg.query("UPDATE public.people SET status='disabled' WHERE id=$1",[f.actors.master.person]);
 const r=await recordCheckoutTransportReceipt(f.database,f.receipt);assert.equal(r.status,'recorded_conflict');assert.equal(r.reconciliationRequired,true);assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.tuition_receipts')).rows[0].n,0);
});
check('wrong school,start or manifest never creates a receipt;native mode and hosted URL forgery rejects',async f=>{
 for(const patch of [{academyId:f.b},{startId:randomUUID()},{requestSha256:'0'.repeat(64)}])assert.equal((await recordCheckoutTransportReceipt(f.database,{...f.receipt,...patch})).status,'unavailable');
 for(const patch of [{sessionId:'cs_live_syntheticTransport'},{checkoutUrl:'https://evil.example/'},{checkoutUrl:f.receipt.checkoutUrl.replace('Transport#','TransportBAD#')},{checkoutUrl:f.receipt.checkoutUrl+'\n'}])await assert.rejects(recordCheckoutTransportReceipt(f.database,{...f.receipt,...patch}),{code:'CHECKOUT_TRANSPORT_RECEIPT_UNAVAILABLE'});
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.checkout_transport_receipts')).rows[0].n,0);
});
check('missing outbox privilege refuses preflight and atomically rolls back result;write can recover without another charge',async f=>{
 await f.pg.exec('REVOKE INSERT ON public.outbox_events FROM kavosh_checkout_result_policy');try{await assert.rejects(probeCheckoutResultSink(f.database),{code:'CHECKOUT_TRANSPORT_RECEIPT_UNAVAILABLE'});await assert.rejects(recordCheckoutTransportReceipt(f.database,f.receipt),{code:'CHECKOUT_TRANSPORT_RECEIPT_UNAVAILABLE'});}finally{await f.pg.exec('RESET ROLE');await f.pg.exec('GRANT INSERT ON public.outbox_events TO kavosh_checkout_result_policy');}
 assert.equal((await f.pg.query('SELECT count(*)::integer n FROM public.checkout_transport_receipts')).rows[0].n,0);assert.equal((await recordCheckoutTransportReceipt(f.database,f.receipt)).status,'recorded');
});
check('result role has no table/identity access and role contamination fails closed in both directions',async f=>{
 await f.pg.exec('SET ROLE kavosh_checkout_result_worker');try{await assertCheckoutResultRole({query:f.pg.query.bind(f.pg),release(){}});for(const table of ['people','payment_checkout_dispatch_starts','checkout_transport_receipts','checkout_transport_conflicts','outbox_events'])await assert.rejects(f.pg.exec('SELECT * FROM public.'+table),/permission denied/);await assert.rejects(f.pg.exec('SELECT * FROM identity."user"'),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}
 await f.pg.exec('GRANT SELECT(id) ON public.people TO kavosh_checkout_result_worker');try{await f.pg.exec('SET ROLE kavosh_checkout_result_worker');await assert.rejects(assertCheckoutResultRole({query:f.pg.query.bind(f.pg),release(){}}),/UNSAFE_CHECKOUT_RESULT_ROLE/);}finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE SELECT(id) ON public.people FROM kavosh_checkout_result_worker');}
 await f.pg.exec('GRANT kavosh_checkout_result_worker TO kavosh_runtime');try{await f.pg.exec('SET ROLE kavosh_runtime');await assert.rejects(assertRuntimeRole({query:f.pg.query.bind(f.pg),release(){}}),/UNSAFE_DATABASE_ROLE/);}finally{await f.pg.exec('RESET ROLE');await f.pg.exec('REVOKE kavosh_checkout_result_worker FROM kavosh_runtime');}
 for(const role of ['kavosh_runtime','kavosh_file_worker','kavosh_payment_ingest']){await f.pg.exec('SET ROLE '+role);try{await assert.rejects(f.pg.query('SELECT public.record_checkout_transport_receipt($1,$2,$3,$4,$5,$6,$7)',[f.a,f.receipt.startId,f.receipt.workerId,f.receipt.requestSha256,'accepted',f.receipt.sessionId,f.receipt.checkoutUrl]),/permission denied/);}finally{await f.pg.exec('RESET ROLE');}}
});
test('strict receipt validation refuses invented payment proof and private data before connecting;connection failures stay redacted',async()=>{
 let connections=0;const database:Database={async connect(){connections++;throw new Error('PRIVATE operator credentials');}},valid={academyId:randomUUID(),startId:randomUUID(),workerId:randomUUID(),requestSha256:'a'.repeat(64),state:'outcome_unknown'};
 for(const patch of [{paymentVerified:true},{state:'paid'},{checkoutUrl:'https://evil.example'},{sessionId:'cs_test_forged'},{privateBody:'PRIVATE'}])await assert.rejects(recordCheckoutTransportReceipt(database,{...valid,...patch}),{code:'INVALID_CHECKOUT_TRANSPORT_RECEIPT'});assert.equal(connections,0);
 await assert.rejects(recordCheckoutTransportReceipt(database,valid),e=>{assert.equal((e as {code:string}).code,'CHECKOUT_TRANSPORT_RECEIPT_UNAVAILABLE');assert.doesNotMatch(String(e),/PRIVATE|credentials/);return true;});
});
