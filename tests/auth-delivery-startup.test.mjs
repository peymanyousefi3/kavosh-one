import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('auth delivery startup failures never leak malformed credentials or inherit unrelated web secrets',()=>{
 const marker='synthetic-private-startup-marker';
 for(const extra of [{DELIVERY_DATABASE_URL:marker},{AUTH_SECRET:marker},{DATABASE_URL:marker},{IDENTITY_DATABASE_URL:marker},{EDGE_AUTH_SECRET:marker}]){
  const r=spawnSync(process.execPath,['--import','tsx','scripts/deliver-auth.ts'],{env:{PATH:process.env.PATH,NODE_ENV:'test',AUTH_SECRET:'synthetic-auth-key-not-real-'.padEnd(40,'x'),...extra},encoding:'utf8',timeout:5000});
  assert.equal(r.status,1);assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'Auth delivery worker stopped; check configuration without logging credentials.');assert.ok(!r.stderr.includes(marker));
 }
});
