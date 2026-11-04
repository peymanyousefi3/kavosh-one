import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const port=process.env.SMOKE_PORT ?? '3197';
const base=process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${port}`;
const env={...process.env};
// This check deliberately runs with no live credentials or database.
delete env.DATABASE_URL; delete env.MIGRATION_DATABASE_URL;
delete env.IDENTITY_DATABASE_URL;delete env.AUTH_SECRET;delete env.EDGE_AUTH_SECRET;
delete env.R2_UPLOAD_CONNECTIONS;delete env.R2_UPLOAD_LINKS_ENABLED;
delete env.BOLDSIGN_WEBHOOK_CONNECTIONS;delete env.BOLDSIGN_WEBHOOK_ENABLED;delete env.SIGNATURE_INGEST_DATABASE_URL;
const child=process.env.SMOKE_BASE_URL ? null : spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',port],{env,stdio:['ignore','pipe','pipe']});
let output='';
child?.stdout.on('data',b=>{output+=b;});child?.stderr.on('data',b=>{output+=b;});
try {
  let ready=false;
  for (let i=0;i<80;i++) {
    if(child && child.exitCode!==null) throw new Error('Production server exited before smoke test');
    try { const r=await fetch(`${base}/api/health`); if(r.status===200){ready=true;break;} } catch { /* wait for startup */ }
    await delay(100);
  }
  assert.ok(ready,'Server did not become ready for HTTP checks');
  const providerPath=base+'/api/webhooks/boldsign/00000000-0000-4000-8000-000000000001';
  const provider=await fetch(providerPath,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(provider.status,503);assert.equal(provider.headers.get('cache-control'),'no-store');assert.equal(provider.headers.get('x-content-type-options'),'nosniff');assert.doesNotMatch(await provider.text(),/secrets|connectionId|academyId|DATABASE|postgres|stack/);
  const providerGet=await fetch(providerPath);assert.equal(providerGet.status,405);assert.equal(providerGet.headers.get('cache-control'),'no-store');
  const trial=await fetch(base+'/api/v1/reports/finance/trial-balance?through=2026-12-31');assert.equal(trial.status,401);assert.equal(trial.headers.get('cache-control'),'no-store');assert.doesNotMatch(await trial.text(),/accountCount|currencies|snapshotAt|stack/);
  const taxes=await fetch(base+'/api/v1/finance/tax-codes');assert.equal(taxes.status,401);assert.equal(taxes.headers.get('cache-control'),'no-store');assert.doesNotMatch(await taxes.text(),/legalBasis|ratePercent|stack/);
  const methods=await fetch(base+'/api/v1/finance/payment-methods');assert.equal(methods.status,401);assert.equal(methods.headers.get('cache-control'),'no-store');assert.doesNotMatch(await methods.text(),/category|createdBy|stack/);
  const tuition=await fetch(base+'/api/v1/finance/tuition-plans');assert.equal(tuition.status,401);assert.equal(tuition.headers.get('cache-control'),'no-store');assert.doesNotMatch(await tuition.text(),/plannedGross|studentId|stack/);
  for(const path of ['invoices','invoice-issuers','collectors','receipts','remittances','payees','sharing-plans','transfers','expense-bills','expense-payments']){const r=await fetch(base+'/api/v1/finance/'+path);assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');assert.doesNotMatch(await r.text(),/billToName|legalName|holdingAccount|collectorName|stack/);}
  for(const path of ['invoices/00000000-0000-4000-8000-000000000001/installment-status','receipts/00000000-0000-4000-8000-000000000001/allocations']){const r=await fetch(base+'/api/v1/finance/'+path);assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');assert.doesNotMatch(await r.text(),/installment|allocated|studentId|stack/);}
  const taxPreview=await fetch(base+'/api/v1/finance/tax-codes/00000000-0000-4000-8000-000000000001/preview',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(taxPreview.status,401);assert.equal(taxPreview.headers.get('cache-control'),'no-store');
  const closing=await fetch(base+'/api/v1/finance/periods/00000000-0000-4000-8000-000000000001/closing-preview');assert.equal(closing.status,401);assert.equal(closing.headers.get('cache-control'),'no-store');assert.doesNotMatch(await closing.text(),/sourceStamp|snapshot|temporaryGroupCount|stack/);
  for(const path of ['finance/periods/00000000-0000-4000-8000-000000000001/closing-runs','finance/closing-runs/00000000-0000-4000-8000-000000000001','finance/closing-runs/00000000-0000-4000-8000-000000000001/journals']){
    const response=await fetch(base+'/api/v1/'+path);assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'no-store');assert.doesNotMatch(await response.text(),/sourceStamp|equityMappings|approvalId|stack/);
  }
  for(const name of ['profit-loss','balance-sheet']){const response=await fetch(base+'/api/v1/reports/finance/'+name+'?from=2026-01-01&through=2026-12-31');assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'no-store');assert.doesNotMatch(await response.text(),/netResult|assets|snapshotAt|stack/);}
  for(const section of ['balance','ledger']){const response=await fetch(base+'/api/v1/finance/accounts/00000000-0000-4000-8000-000000000001/'+section+'?through=2026-12-31');assert.equal(response.status,401);assert.equal(response.headers.get('cache-control'),'no-store');}
  for (const [path,status] of [['/api/health',200],['/api/ready',503],['/api/v1/hubs',401],['/api/v1/people',401],['/api/v1/audit-events',401],['/api/v1/finance/currencies',401],['/api/v1/finance/accounts',401],['/api/v1/finance/periods',401],['/api/v1/finance/journals',401],['/api/auth/get-session',503]]) {
    const response=await fetch(base+path);assert.equal(response.status,status,path);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');
    assert.equal(response.headers.get('x-frame-options'),'DENY');
    assert.equal(response.headers.get('x-powered-by'),null);
    assert.match(response.headers.get('content-security-policy')??'',/frame-ancestors 'none'/);
    assert.doesNotMatch(await response.text(),/DATABASE_URL|password|stack|postgresql:\/\//);
  }
  const upload=await fetch(base+'/api/v1/files/73e6a708-ad23-484b-9b12-91db85854593/upload-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedMetadataVersion:1})});
  assert.equal(upload.status,401);assert.equal(upload.headers.get('cache-control'),'no-store');assert.doesNotMatch(await upload.text(),/X-Amz|secretAccessKey|storageTargetId|stack/);
  const inspection=await fetch(base+'/api/v1/files/73e6a708-ad23-484b-9b12-91db85854593/inspection',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({expectedMetadataVersion:1,grantId:'73e6a708-ad23-484b-9b12-91db85854593'})});
  assert.equal(inspection.status,401);assert.equal(inspection.headers.get('cache-control'),'no-store');assert.doesNotMatch(await inspection.text(),/X-Amz|secretAccessKey|storageTargetId|stack/);
  const grantHistory=await fetch(base+'/api/v1/files/73e6a708-ad23-484b-9b12-91db85854593/upload-grants?limit=1');assert.equal(grantHistory.status,401);assert.equal(grantHistory.headers.get('cache-control'),'no-store');assert.doesNotMatch(await grantHistory.text(),/formatPolicy|X-Amz|storageTargetId|stack/);
  const spec=await (await fetch(base+'/openapi.json')).json();assert.equal(spec.openapi,'3.1.0');assert.ok(spec.paths['/api/v1/files/{id}/upload-link']?.post);
  for(const path of ['sessions/00000000-0000-4000-8000-000000000001/my-time','sessions/00000000-0000-4000-8000-000000000001/time-entries','session-time-entries/00000000-0000-4000-8000-000000000001/history']){const r=await fetch(base+'/api/v1/'+path);assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');assert.doesNotMatch(await r.text(),/starts_at|assignment_id|reason|stack/);}
  assert.ok(spec.paths['/api/v1/sessions/{id}/my-time']?.post);
  for(const path of ['inventory/items','inventory/locations','inventory/movements','inventory/locations/00000000-0000-4000-8000-000000000001/stock']){const r=await fetch(base+'/api/v1/'+path);assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');assert.doesNotMatch(await r.text(),/cost_minor|serial_number|purchased_by|stack/);}
  assert.ok(spec.paths['/api/v1/inventory/movements']?.post);
  const stockReport=await fetch(base+'/api/v1/reports/inventory/stock?on=2026-11-03&timeZone=UTC');assert.equal(stockReport.status,401);assert.equal(stockReport.headers.get('cache-control'),'no-store');assert.doesNotMatch(await stockReport.text(),/knownSubtotal|locationSeries|serialNumber|stack/);assert.ok(spec.paths['/api/v1/reports/inventory/stock']?.get);
  assert.deepEqual(spec.paths['/api/webhooks/boldsign/{connectionId}']?.post?.security,[]);
  assert.match(spec.paths['/api/v1/files/{id}/inspection']?.post?.responses?.['202']?.description??'',/not verified/);
  console.log('Production HTTP smoke checks passed: liveness, fail-closed readiness, authorization, cache/security headers and API contract.');
} catch(error) {
  // Only generic startup diagnostics are allowed; this server has no secrets.
  console.error(output.slice(-2000));throw error;
} finally {
  if (child) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(3000)]);
    if(child.exitCode===null) child.kill('SIGKILL');
  }
}
