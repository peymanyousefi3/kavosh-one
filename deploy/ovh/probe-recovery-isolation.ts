import assert from 'node:assert/strict';
import {access,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {privateDirectory} from '../../src/operations/recovery-files.ts';
import {verifyRecoveryOsIsolation} from '../../src/operations/recovery-isolation.ts';
// Empty synthetic input files only. Never reads a live credential or SQL dump.
let stage='process identity';
try{
 assert.equal(process.argv.length,2);assert.equal(process.platform,'linux');assert.ok(process.getuid!()>0);
 stage='private state directory';
 const path=process.env.STATE_DIRECTORY;assert.ok(path&&/^\/var\/lib\/kavosh-one-recovery-[a-f0-9]{32}$/.test(path));const directory=await realpath(path);assert.ok(directory===path||directory===path.replace('/var/lib/','/var/lib/private/'));await privateDirectory(directory);
 stage='root-owned synthetic inputs';for(const name of ['database.dump','roles-export.sql','verification.json','input.json']){const file=await lstat(directory+'/'+name);assert.equal(file.isFile(),true);assert.equal(file.isSymbolicLink(),false);assert.equal(file.uid,0);assert.equal(file.nlink,1);assert.equal(file.mode&0o777,0o444);assert.equal(file.size,0);await access(directory+'/'+name,constants.R_OK);}
 stage='OS restrictions';await verifyRecoveryOsIsolation();
 console.log(JSON.stringify({syntheticInputsOnly:true,privateOwnedDirectoryVerified:true,rootOwnedReadOnlyInputFilesVerified:4,liveDatabaseAndCredentialPathsDenied:true,externalNetworkInterfacesAbsent:true,noNewPrivilegesVerified:true,effectiveCapabilitiesAbsent:true,productionCredentialsInjected:false,sqlExecuted:false}));
}catch{console.error('RECOVERY_ISOLATION_PROBE_FAILED: '+stage);process.exitCode=1;}
