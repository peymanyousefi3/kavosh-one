import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import {quarantineRecoveredAuthentication} from '../src/operations/recovery-authentication.ts';
import {databaseVerification} from '../src/operations/database-verification.ts';
const fp={rows:0,sha256:'a'.repeat(64)},snapshot=databaseVerification.parse({format:'kavosh-database-verification-v1',schemaRevision:396,tables:[],relations:fp,functions:fp,policies:fp,sequenceValuesCovered:false,globalRolesCovered:false});
test('authentication quarantine refuses source paths and nonisolated/nonadmin connections before any writes',async()=>{
 const directory='/var/lib/kavosh-one-recovery-'+'a'.repeat(32)+'/data';let calls=0;
 const unused={query(){calls++;throw new Error('must not query');}} as unknown as pg.Client;
 for(const path of ['/var/lib/postgresql/18/main',directory+'/../data',directory+'\n'])await assert.rejects(quarantineRecoveredAuthentication(unused,path,snapshot),{code:'ISOLATED_CLUSTER_REQUIRED'});assert.equal(calls,0);
 for(const change of [{directory:'/var/lib/postgresql/18/main'},{listening:'localhost'},{address:'127.0.0.1'},{administrator:false},{same_user:false}]){
  const commands:string[]=[],client={async query(sql:string){commands.push(sql);return{rows:[{directory,listening:'',address:null,administrator:true,same_user:true,...change}]};}} as unknown as pg.Client;
  await assert.rejects(quarantineRecoveredAuthentication(client,directory,snapshot),{code:'CLUSTER_BOUNDARY_MISMATCH'});assert.equal(commands.length,1);assert.ok(commands.every(sql=>sql.startsWith('SELECT')));
 }
});
test('unexpected credential/history changes roll back quarantine before commit or a preservation success claim',async()=>{
 const directory='/var/lib/kavosh-one-recovery-'+'b'.repeat(32)+'/data',commands:string[]=[];let frames=0;
 const client={query(sql:string|pg.Query){
  if(typeof sql!=='string'){frames++;sql.emit('row',{value:frames===4?'unexpected-history-change':'unchanged'});sql.emit('end');return sql;}
  commands.push(sql);return Promise.resolve({rows:sql.startsWith("SELECT current_setting")?[{directory,listening:'',address:null,administrator:true,same_user:true}]:[],rowCount:1});
 }} as unknown as pg.Client;
 await assert.rejects(quarantineRecoveredAuthentication(client,directory,snapshot),{code:'RECOVERY_AUTHENTICATION_PRESERVATION_FAILED'});assert.equal(commands.at(-1),'ROLLBACK');assert.ok(!commands.includes('COMMIT'));assert.equal(frames,6);
 const calls:string[]=[],cancelled={async query(sql:string){calls.push(sql);return{rows:[{directory,listening:'',address:null,administrator:true,same_user:true}]};}} as unknown as pg.Client;
 await assert.rejects(quarantineRecoveredAuthentication(cancelled,directory,snapshot,AbortSignal.abort()),{code:'RECOVERY_CANCELLED'});assert.equal(calls.length,1);assert.ok(!calls.includes('BEGIN'));
});
