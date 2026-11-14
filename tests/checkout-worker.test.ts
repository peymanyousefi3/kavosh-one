import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes,randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { executeCheckoutAttempt,CheckoutWorkerError } from '../src/integrations/checkout-worker.ts';
import { paymentConnection } from './stripe-fixture.ts';

test('isolated worker refuses invalid credentials,origins and targets before either backend or provider IO',async()=>{
 const {secrets:_secrets,...identity}=paymentConnection(),config={...identity,origin:'https://academy.example',apiKey:['sk','test',randomBytes(24).toString('hex')].join('_')},target={requestId:randomUUID(),attemptId:randomUUID()},token='kvo_'+randomBytes(32).toString('base64url');let calls=0;
 const send:typeof fetch=async()=>{calls++;throw new Error('UNEXPECTED_IO');},sink={workerId:randomUUID(),resultDatabase:{async connect(){throw new Error('UNEXPECTED_DB');}}};
 for(const api of [{origin:config.origin,token:'invalid'},{origin:'http://academy.example',token},{origin:'https://evil.example',token},{origin:'https://academy.example/path',token},{origin:'https://user:pass@academy.example',token}])await assert.rejects(executeCheckoutAttempt(target,config,{...api,...sink},send),e=>e instanceof CheckoutWorkerError&&e.stage==='configuration');
 await assert.rejects(executeCheckoutAttempt({...target,amount:'1'},config,{origin:config.origin,token,...sink},send),e=>e instanceof CheckoutWorkerError&&e.stage==='configuration');assert.equal(calls,0);
});
test('operator command defaults off,requires explicit dispatch and never logs secret configuration on failure',async()=>{
 const execute=promisify(execFile),ids=Array.from({length:3},()=>randomUUID()),secret=['sk','test',randomBytes(24).toString('hex')].join('_');
 for(const args of [[...ids,'--dispatch'],ids,[...ids,'--inspect-disputes','cs_test_synthetic'],[...ids,'--inspect-dispute-balance','cs_test_synthetic','du_synthetic','txn_synthetic']])await assert.rejects(execute(process.execPath,['--import','tsx','scripts/dispatch-checkout.ts',...args],{timeout:5000,env:{NODE_ENV:'test',PATH:process.env.PATH,STRIPE_CHECKOUT_TRANSPORT_ENABLED:'false',STRIPE_CHECKOUT_CONNECTIONS:secret,CHECKOUT_WORKER_TOKEN:secret}}),e=>{
  const r=e as Error&{stdout:string;stderr:string};assert.equal(r.stdout,'');assert.match(r.stderr,/Checkout dispatch did not finish/);assert.ok(!r.stderr.includes(secret));return true;
 });
});
