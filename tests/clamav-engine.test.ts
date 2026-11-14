import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn,spawnSync } from 'node:child_process';
import { mkdtemp,writeFile,access,rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { scanWithClamd } from '../src/integrations/clamav.ts';
import { getClamdDatabase } from '../src/integrations/clamav-database.ts';

// A real engine with an isolated harmless test signature, NOT current official
// signatures, a production configuration, or proof that arbitrary files are safe.
// https://docs.clamav.net/manual/Signatures/ExtendedSignatures.html
const binary=process.env.TEST_CLAMD_BINARY;
test('actual ClamAV daemon distinguishes harmless signature detection, unmatched bytes and its stream limit',{skip:!binary,timeout:30000},async()=>{
  assert.match(binary!,/^\/(?:[^\0\r\n]+)$/);
  const version=spawnSync(binary!,['--version'],{encoding:'utf8',timeout:5000,maxBuffer:4096});
  assert.equal(version.status,0);assert.match(version.stdout,/ClamAV/);
  const dir=await mkdtemp('/private/tmp/ko-engine-').catch(()=>mkdtemp('/tmp/ko-engine-'));
  const marker=Buffer.from('KavoshHarmlessSyntheticScannerMarker_20261104'),socketPath=dir+'/s',configFile=dir+'/clamd.conf';
  let child:ReturnType<typeof spawn>|undefined,output='',exited=Promise.resolve();
  try {
    await writeFile(dir+'/synthetic.ndb','Kavosh.Synthetic.Test:0:*:'+marker.toString('hex')+'\n',{mode:0o600});
    await writeFile(configFile,[
      'Foreground yes','LocalSocket '+socketPath,'LocalSocketMode 600','DatabaseDirectory '+dir,'TemporaryDirectory '+dir,
      'StreamMaxLength 128K','MaxScanSize 256K','MaxFileSize 256K','AlertExceedsMax yes','ScanArchive yes',
      'MaxThreads 1','MaxQueue 2','ReadTimeout 5','CommandReadTimeout 5','SelfCheck 0'
    ].join('\n')+'\n',{mode:0o600});
    child=spawn(binary!,['--config-file',configFile],{stdio:['ignore','pipe','pipe']});
    exited=new Promise<void>(resolve=>{child!.once('close',()=>resolve());child!.once('error',()=>resolve());});
    for(const stream of [child.stdout,child.stderr])stream?.on('data',(chunk:Buffer)=>{output=(output+chunk.toString()).slice(-4000);});
    let ready=false;
    for(let attempt=0;attempt<100;attempt++) {
      if(child.exitCode!==null)assert.fail('Isolated test daemon exited before startup: '+output);
      try{await access(socketPath);ready=true;break;}catch{await delay(100);}
    }
    assert.ok(ready,'Isolated test daemon did not expose its private socket: '+output);
    const configuration={socketPath,maximumBytes:262144,timeoutMs:5000};
    // Actual custom-NDB daemon has no official loaded CVD version/time. Its
    // ability to detect a test marker must NEVER pass the production preflight.
    await assert.rejects(getClamdDatabase(configuration,{timeZone:'UTC',maximumAgeSeconds:172800}),{code:'SCANNER_DATABASE_METADATA_INVALID',status:503});
    const scan=(data:Buffer)=>scanWithClamd(configuration,Readable.from([data]),{bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
    const unmatched=Buffer.from('This harmless payload deliberately does not match the test signature.');
    const clean=await scan(unmatched);assert.equal(clean.verdict,'no_detection');assert.equal(clean.bytes,unmatched.length);
    const detected=await scan(Buffer.concat([Buffer.from('prefix '),marker,Buffer.from(' suffix')]));assert.equal(detected.verdict,'detected');assert.equal(detected.engine,'clamd');
    await assert.rejects(scan(Buffer.alloc(131073,65)),error=>error instanceof Error&&/^SCANNER_/.test(error.message));
    // A rejected oversized stream must not poison the next independent request.
    assert.equal((await scan(marker)).verdict,'detected');
    console.log('Isolated engine: '+version.stdout.trim()+'; harmless custom signature only; stream limit rejection verified.');
    child.kill('SIGTERM');await Promise.race([exited,delay(3000)]);
    if(child.exitCode===null){child.kill('SIGKILL');await exited;}
    child=undefined;
  }finally {
    if(child&&child.exitCode===null){child.kill('SIGKILL');await exited;}
    await rm(dir,{recursive:true,force:true});
  }
});
