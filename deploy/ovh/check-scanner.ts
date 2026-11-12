import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { scanWithFreshClamd } from '../../src/integrations/clamav-database.ts';
let phase='arguments';
try {
 assert.deepEqual(process.argv.slice(2),['--execute']);
 const socketPath='/run/kavosh-one-scanner/clamd.sock', info=await stat(socketPath);
 assert.ok(info.isSocket()); assert.equal(info.mode&0o777,0o660);
 const config={socketPath,maximumBytes:67108864,timeoutMs:10000},policy={timeZone:'UTC',maximumAgeSeconds:172800};
 const scan=(bytes:Buffer)=>scanWithFreshClamd(config,policy,Readable.from([bytes]),{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 phase='current official database and unmatched synthetic bytes';
 const ordinary=await scan(Buffer.from('Kavosh One scanner acceptance: harmless synthetic bytes only.'));
 assert.equal(ordinary.verdict,'no_detection'); assert.ok(ordinary.database);
 phase='harmless standard antivirus test detection';
 const sample=Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$'+'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
 assert.equal(sample.length,68); assert.equal((await scan(sample)).verdict,'detected');
 phase='healthy after detection'; assert.equal((await scan(Buffer.from('Second harmless synthetic stream.'))).verdict,'no_detection');
 console.log(JSON.stringify({executedOnVps:true,officialEngineVersion:ordinary.database.engineVersion,loadedDatabaseVersion:ordinary.database.databaseVersion,loadedDatabaseCreatedAt:ordinary.database.databaseCreatedAt,currentDatabaseVerified:true,privateSocketMode:'0660',unmatchedAndStandardAntivirusTestDistinguished:true,healthyAfterDetection:true,realPersonalDataUsed:false,applicationMediaWorkflowActivated:false}));
} catch { console.error('SCANNER_ACCEPTANCE_FAILED: '+phase);process.exitCode=1; }
