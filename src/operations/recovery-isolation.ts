import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createConnection} from 'node:net';

// Read-only checks run in the actual restore process before any recovered SQL.
// No live file is opened:no permission probe reads credential contents.
export async function verifyRecoveryOsIsolation(){
 assert.equal(process.platform,'linux');assert.ok(process.getuid!()>0);
 for(const path of ['/etc/kavosh-one/web.env','/etc/kavosh-one/drive.json','/run/postgresql/.s.PGSQL.5432','/var/lib/postgresql/18/main/PG_VERSION'])await assert.rejects(access(path,constants.R_OK),error=>['EACCES','ENOENT'].includes((error as NodeJS.ErrnoException).code??''));
 const status=await readFile('/proc/self/status','utf8');assert.match(status,/^NoNewPrivs:\s+1$/m);assert.match(status,/^CapEff:\s+0+$/m);
 // AF_NETLINK is deliberately denied,so os.networkInterfaces cannot be used.
 const interfaces=(await readFile('/proc/net/dev','utf8')).trim().split('\n').slice(2).map(line=>line.trim().split(':')[0]);assert.deepEqual(interfaces,['lo']);
 const blocked=await new Promise<string>((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port:9});const timeout=setTimeout(()=>{socket.destroy();reject(new Error('INET_NOT_DENIED'));},1000);socket.once('error',error=>{clearTimeout(timeout);socket.destroy();resolve((error as NodeJS.ErrnoException).code??'');});socket.once('connect',()=>{clearTimeout(timeout);socket.destroy();reject(new Error('INET_NOT_DENIED'));});});assert.ok(['EAFNOSUPPORT','EPERM','EACCES'].includes(blocked));
 for(const key of ['DATABASE_URL','AUTH_SECRET','CREDENTIALS_DIRECTORY','MIGRATION_DATABASE_URL','BACKUP_DATABASE_URL'])assert.equal(process.env[key],undefined);
 return true as const;
}
