import assert from 'node:assert/strict';
import {access,lstat,readFile,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {networkInterfaces} from 'node:os';
import {privateDirectory} from '../../src/operations/recovery-files.ts';
// Empty synthetic input files only. Never reads a live credential or SQL dump.
let stage='process identity';
try{
 assert.equal(process.argv.length,2);assert.equal(process.platform,'linux');assert.ok(process.getuid!()>0);
 stage='private state directory';
 const path=process.env.STATE_DIRECTORY;assert.ok(path&&/^\/var\/lib\/kavosh-one-recovery-[a-f0-9]{32}$/.test(path));const directory=await realpath(path);assert.ok(directory===path||directory===path.replace('/var/lib/','/var/lib/private/'));await privateDirectory(directory);
 stage='root-owned synthetic inputs';for(const name of ['database.dump','roles-export.sql','verification.json','input.json']){const file=await lstat(directory+'/'+name);assert.equal(file.isFile(),true);assert.equal(file.isSymbolicLink(),false);assert.equal(file.uid,0);assert.equal(file.nlink,1);assert.equal(file.mode&0o777,0o444);assert.equal(file.size,0);await access(directory+'/'+name,constants.R_OK);}
 stage='live path denials';
 for(const path of ['/etc/kavosh-one/web.env','/etc/kavosh-one/drive.json','/run/postgresql/.s.PGSQL.5432','/var/lib/postgresql/18/main/PG_VERSION'])await assert.rejects(access(path,constants.R_OK),error=>['EACCES','ENOENT'].includes((error as NodeJS.ErrnoException).code??''));
 stage='kernel privilege restrictions';const status=await readFile('/proc/self/status','utf8');assert.match(status,/^NoNewPrivs:\s+1$/m);assert.match(status,/^CapEff:\s+0+$/m);
 stage='private network';
 const interfaces=networkInterfaces();assert.ok(Object.keys(interfaces).every(name=>name==='lo'));assert.ok(Object.values(interfaces).flat().every(address=>address?.internal===true));
 stage='credential absence';assert.equal(process.env.DATABASE_URL,undefined);assert.equal(process.env.AUTH_SECRET,undefined);assert.equal(process.env.CREDENTIALS_DIRECTORY,undefined);
 console.log(JSON.stringify({syntheticInputsOnly:true,privateOwnedDirectoryVerified:true,rootOwnedReadOnlyInputFilesVerified:4,liveDatabaseAndCredentialPathsDenied:true,externalNetworkInterfacesAbsent:true,noNewPrivilegesVerified:true,effectiveCapabilitiesAbsent:true,productionCredentialsInjected:false,sqlExecuted:false}));
}catch{console.error('RECOVERY_ISOLATION_PROBE_FAILED: '+stage);process.exitCode=1;}
