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
  for (const [path,status] of [['/api/health',200],['/api/ready',503],['/api/v1/hubs',401],['/api/v1/people',401],['/api/v1/audit-events',401],['/api/auth/get-session',503]]) {
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
  const spec=await (await fetch(base+'/openapi.json')).json();assert.equal(spec.openapi,'3.1.0');assert.ok(spec.paths['/api/v1/files/{id}/upload-link']?.post);
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
