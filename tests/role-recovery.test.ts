import assert from 'node:assert/strict';
import {test} from 'node:test';
import pg from 'pg';
import {canonicalRoleExport,isolatedClusterRecoveryPlan,databaseAccessFingerprint} from '../src/operations/role-recovery.ts';
import {operationsFixture} from './operations-fixture.ts';
import {globalRolePropertiesFingerprint,clusterVerificationSnapshot} from '../src/operations/database-verification.ts';

test('role comparison ignores dump headers but preserves attributes,memberships and quoted multiline values',()=>{
 const original=`-- original export\n\\restrict oldtoken\nCREATE ROLE postgres;\nALTER ROLE postgres WITH SUPERUSER LOGIN;\nCREATE ROLE kavosh_runtime;\nALTER ROLE kavosh_runtime WITH NOSUPERUSER NOLOGIN;\nGRANT kavosh_runtime TO postgres WITH ADMIN OPTION;\nCOMMENT ON ROLE kavosh_runtime IS 'line one;\n-- not a header\nline two ''quoted''';\nALTER ROLE kavosh_runtime SET application_name TO E'escaped\\\'value';\n\\unrestrict oldtoken\n`;
 const value=canonicalRoleExport(original);assert.deepEqual(canonicalRoleExport(original.replace('original export','another date').replaceAll('oldtoken','newtoken')),value);
 for(const modified of [original.replace('NOSUPERUSER','SUPERUSER'),original.replace('WITH ADMIN OPTION','WITH INHERIT TRUE'),original.replace('-- not a header','-- changed actual comment'),original.replace('escaped','different')])assert.notDeepEqual(canonicalRoleExport(modified),value);
 assert.deepEqual(canonicalRoleExport('CREATE/* outer /* nested */ done */ ROLE x;'),['CREATE ROLE x;']);assert.deepEqual(canonicalRoleExport('CREATE ROLE "a""b"; COMMENT ON ROLE "a""b" IS $tag$semi; -- literal$tag$;'),['COMMENT ON ROLE "a""b" IS $tag$semi; -- literal$tag$;','CREATE ROLE "a""b";']);
});
test('only the generated bootstrap role is excluded; malformed or password-bearing exports fail closed',()=>{
 const bootstrap='kavosh_recovery_bootstrap_'+'a'.repeat(32),source='CREATE ROLE postgres; ALTER ROLE postgres WITH LOGIN;';
 assert.deepEqual(canonicalRoleExport(source+' CREATE ROLE '+bootstrap+'; ALTER ROLE '+bootstrap+' WITH SUPERUSER LOGIN;',bootstrap),canonicalRoleExport(source));
 assert.notDeepEqual(canonicalRoleExport(source+' CREATE ROLE '+bootstrap+'_other;',bootstrap),canonicalRoleExport(source));
 for(const sql of ['CREATE ROLE a','CREATE ROLE "a;','CREATE ROLE a; /* unfinished','CREATE ROLE a; COMMENT ON ROLE a IS $q$unfinished;','\\! unsafe\nCREATE ROLE a;','CREATE ROLE a; ALTER ROLE a WITH PASSWORD \'not-a-real-credential\';','CREATE ROLE a; ALTER ROLE a PASSWORD NULL;'])assert.throws(()=>canonicalRoleExport(sql));
 assert.throws(()=>canonicalRoleExport(source,'postgres'));assert.throws(()=>canonicalRoleExport('x'.repeat(4194305)));
});
test('cluster reconstruction can target only its own private socket/data directory and never a shared instance',()=>{
 const directory='/var/lib/kavosh-one-recovery-'+'b'.repeat(32),role='kavosh_recovery_bootstrap_'+'c'.repeat(32),plan=isolatedClusterRecoveryPlan(directory,role,'/usr/lib/postgresql/18/bin');
 assert.equal(plan.networkListeningAllowed,false);assert.equal(plan.applicationActivationAllowed,false);assert.ok(plan.start.includes("-h '' -k "+directory+'/socket -p 55493 -c unix_socket_permissions=0700 -c shared_buffers=16MB -c max_connections=20'));assert.ok(plan.database.includes('--create'));assert.ok(!plan.database.includes('--clean'));assert.ok(!plan.database.includes('--no-owner'));assert.ok(!plan.database.includes('--no-acl'));assert.ok(plan.roles.includes('--single-transaction'));assert.ok(!JSON.stringify(plan).includes('/var/run/postgresql'));
 for(const path of ['/','/var/lib/postgresql/18/main','/var/lib/kavosh-one-backups',directory+'/../postgresql',directory+'\n'])assert.throws(()=>isolatedClusterRecoveryPlan(path,role,'/usr/lib/postgresql/18/bin'));
 assert.throws(()=>isolatedClusterRecoveryPlan(directory,role,'/tmp/tools'));assert.throws(()=>isolatedClusterRecoveryPlan(directory,'postgres','/usr/lib/postgresql/18/bin'));
 assert.throws(()=>isolatedClusterRecoveryPlan(directory,role+'\n','/usr/lib/postgresql/18/bin'));assert.throws(()=>canonicalRoleExport('CREATE ROLE postgres;',role+'\n'));
});
test('actual database access fingerprint detects PUBLIC privileges and database-scoped settings without exposing values',async()=>{
 const f=await operationsFixture(),native=f.pg.runtime?await f.pg.runtime.connect():undefined;
 const client=(native??{query(q:string|pg.Query){if(typeof q==='string')return f.pg.query(q);void f.pg.query((q as unknown as {text:string}).text).then(r=>{for(const row of r.rows)q.emit('row',row);q.emit('end');},e=>q.emit('error',e));return q;}}) as pg.Client;
 try{
  await client.query('RESET ROLE');const name=(await client.query('SELECT current_database() name')).rows[0].name,quote='"'+name.replaceAll('"','""')+'"',before=await databaseAccessFingerprint(client);assert.equal(before.rows,1);assert.deepEqual(await databaseAccessFingerprint(client),before);
  await client.query('REVOKE CONNECT,TEMPORARY ON DATABASE '+quote+' FROM PUBLIC');const restricted=await databaseAccessFingerprint(client);assert.notEqual(restricted.sha256,before.sha256);
  await client.query('ALTER DATABASE '+quote+" SET application_name='PRIVATE_DATABASE_SETTING'");const configured=await databaseAccessFingerprint(client);assert.notEqual(configured.sha256,restricted.sha256);assert.doesNotMatch(JSON.stringify(configured),/PRIVATE_DATABASE_SETTING|postgres|kavosh/);
  const roles=await globalRolePropertiesFingerprint(client);await client.query('ALTER ROLE kavosh_runtime CONNECTION LIMIT 3');try{assert.notEqual((await globalRolePropertiesFingerprint(client)).sha256,roles.sha256);}finally{await client.query('ALTER ROLE kavosh_runtime CONNECTION LIMIT -1');}
  await assert.rejects(clusterVerificationSnapshot(client),/VERIFICATION_SNAPSHOT_REQUIRED/);await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{const baseline=await clusterVerificationSnapshot(client);assert.equal(baseline.databaseAccess.rows,1);assert.ok(baseline.globalRoleProperties.rows>0);assert.doesNotMatch(JSON.stringify(baseline),/PRIVATE_DATABASE_SETTING|postgres|kavosh_runtime/);}finally{await client.query('ROLLBACK');}
  await assert.rejects(databaseAccessFingerprint(client,AbortSignal.abort()),/VERIFICATION_CANCELLED/);
 }finally{native?.release();await f.pg.close();}
});
