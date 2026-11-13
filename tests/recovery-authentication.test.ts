import assert from 'node:assert/strict';
import {test} from 'node:test';
import type pg from 'pg';
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
