// Read-only checks under the actual unprivileged worker account. No delivery.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {Kysely,PostgresDialect} from 'kysely';
import {IdentityStore} from '../../src/auth/store.ts';
import {postgresOptions} from '../../src/core/postgres-config.ts';
import {providerDelivery} from '../../src/auth/delivery.ts';
let db:Kysely<unknown>|undefined;
try{
 assert.deepEqual(process.argv.slice(2),['--execute']);assert.notEqual(process.getuid?.(),0);
 for(const key of ['DATABASE_URL','IDENTITY_DATABASE_URL','MIGRATION_DATABASE_URL','EDGE_AUTH_SECRET'])assert.equal(process.env[key],undefined);
 let denied=false;try{readFileSync('/etc/kavosh-one/web.env');}catch(e){denied=(e as NodeJS.ErrnoException).code==='EACCES';}assert.equal(denied,true);
 const pool=new pg.Pool({...postgresOptions(process.env.DELIVERY_DATABASE_URL),max:1,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});
 pool.on('error',()=>{});db=new Kysely<unknown>({dialect:new PostgresDialect({pool})});
 const store=new IdentityStore(db,process.env.AUTH_SECRET!);await store.safeDelivery();providerDelivery();
 const r=(await store.query<{tls:boolean;queueRead:boolean;queueUpdate:boolean;queueInsert:boolean;queueDelete:boolean;unrelatedRead:boolean;pending:number}>(`SELECT
 (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) tls,
 has_table_privilege(current_user,'identity.delivery_outbox','SELECT') "queueRead",
 has_table_privilege(current_user,'identity.delivery_outbox','UPDATE') "queueUpdate",
 has_table_privilege(current_user,'identity.delivery_outbox','INSERT') "queueInsert",
 has_table_privilege(current_user,'identity.delivery_outbox','DELETE') "queueDelete",
 EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','identity','auth_private','platform_private') AND c.relkind IN('r','p','v','m','f') AND NOT(n.nspname='identity' AND c.relname='delivery_outbox') AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE')) "unrelatedRead",
 (SELECT count(*)::integer FROM identity.delivery_outbox WHERE outcome IS NULL) pending`)).rows[0];
 assert.equal(r.tls,true);assert.equal(r.queueRead,true);assert.equal(r.queueUpdate,true);assert.equal(r.queueInsert,false);assert.equal(r.queueDelete,false);assert.equal(r.unrelatedRead,false);assert.equal(r.pending,0);
 console.log(JSON.stringify({workerRoleSafetyVerified:true,databaseTlsVerified:true,queueOnlySelectUpdateVerified:true,unrelatedAccountAndFinanceTablesDenied:true,otherWebCredentialsUnreadable:true,pendingMessages:0,messagesSent:0,mailboxAccessUsed:false}));
}catch{console.error('AUTH_DELIVERY_ISOLATION_CHECK_FAILED');process.exitCode=1;}
finally{await db?.destroy();}
