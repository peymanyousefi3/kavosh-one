import pg from 'pg';
import { Kysely,PostgresDialect } from 'kysely';
import { z } from 'zod';
import { IdentityStore } from '../src/auth/store.ts';
import { providerDelivery,deliverOne } from '../src/auth/delivery.ts';
import { postgresOptions } from '../src/core/postgres-config.ts';
import { setTimeout } from 'node:timers/promises';

if(process.env.MIGRATION_DATABASE_URL)throw new Error('MIGRATION_CREDENTIALS_FORBIDDEN_IN_WORKER');
if(process.env.OPERATIONAL_DELIVERY_CONNECTIONS||process.env.NOTIFICATION_OUTBOUND_DATABASE_URL)throw new Error('SHARED_CREDENTIAL_ENVIRONMENT_FORBIDDEN');
const key=z.string().min(32).parse(process.env.AUTH_SECRET);
const pool=new pg.Pool({...postgresOptions(process.env.DELIVERY_DATABASE_URL),max:2,
  connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});
pool.on('error',()=>{console.error('delivery_database_pool_error');});
const db=new Kysely<unknown>({dialect:new PostgresDialect({pool})});
const store=new IdentityStore(db,key);
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopping=true;});
try {
  await store.safeDelivery();
  const delivery=providerDelivery();
  let sweptAt=0;
  while(!stopping){
    if(Date.now()-sweptAt>=3600000){await store.query('SELECT identity.cleanup_expired_auth()');sweptAt=Date.now();}
    if(!await deliverOne(store,key,delivery))await setTimeout(1000);
  }
} catch {
  console.error('Auth delivery worker stopped; check configuration without logging credentials.');process.exitCode=1;
} finally {await db.destroy();}
