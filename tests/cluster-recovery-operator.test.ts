import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('real-cluster operator refuses malformed selection or untrusted operator paths before connections or private output',async()=>{
 const run=promisify(execFile),id='171a9ad4-c40b-4d98-9890-6a87ce15a976';
 for(const args of [[],['--execute','../../source'],['--execute',id,'extra'],['--execute',id]])await assert.rejects(run(process.execPath,['--import','tsx','scripts/verify-vps-cluster-recovery.ts',...args],{env:{PATH:process.env.PATH,NODE_ENV:'test',CLUSTER_RECOVERY_OPERATOR_REVISION:'../../PRIVATE_UNTRUSTED_PATH'},timeout:5000}),error=>{const e=error as Error&{stdout:string;stderr:string};assert.equal(e.stdout,'');assert.equal(e.stderr.trim(),'ISOLATED_CLUSTER_ACCEPTANCE_FAILED: arguments');assert.ok(!e.stderr.includes('PRIVATE_UNTRUSTED_PATH'));return true;});
});
