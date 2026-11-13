import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isolatedClusterUnit} from '../src/operations/cluster-recovery-unit.ts';
test('offline restore unit uses a new OS identity,private network,live-path exclusions and only explicit root input copies',()=>{
 const id='a'.repeat(32),operator='/srv/kavosh-one/operations/recovery-5352111',result=isolatedClusterUnit(id,operator),unit=result.unit;
 for(const required of ['DynamicUser=yes','PrivateNetwork=yes','PrivateIPC=yes','ProtectProc=ptraceable','ProtectSystem=strict','NoNewPrivileges=yes','RestrictAddressFamilies=AF_UNIX','CapabilityBoundingSet=','KillMode=control-group','MemoryMax=512M','CPUQuota=50%','/var/lib/postgresql /run/postgresql /etc/postgresql /etc/kavosh-one'])assert.ok(unit.includes(required),required);
 assert.equal(unit.split('\n').filter(line=>line.startsWith('ExecStartPre=+')).length,4);assert.ok(unit.includes('ExecStart=/usr/bin/node '+operator+'/scripts/restore-isolated-cluster.js'));assert.ok(!unit.includes('User=postgres'));assert.ok(!unit.includes('EnvironmentFile'));assert.ok(!unit.includes('LoadCredential'));assert.ok(!unit.includes('[Install]'));assert.ok(!unit.includes('RemainAfterExit'));
 assert.equal(result.staging,'/var/lib/kavosh-one-recovery-input-'+id);assert.equal(result.directory,'/var/lib/kavosh-one-recovery-'+id);
 for(const value of [id+'\n','../source','a'.repeat(31)])assert.throws(()=>isolatedClusterUnit(value,operator));
 for(const value of [operator+'\n','/srv/kavosh-one/current','/tmp/operator','/srv/kavosh-one/operations/recovery-5352111/../source'])assert.throws(()=>isolatedClusterUnit(id,value));
});
