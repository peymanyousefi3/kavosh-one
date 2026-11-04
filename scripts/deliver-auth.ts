import pg from 'pg';
import { Kysely,PostgresDialect } from 'kysely';
import { z } from 'zod';
import { IdentityStore } from '../src/auth/store.ts';
import { providerDelivery,deliverOne } from '../src/auth/delivery.ts';
import { postgresOptions } from '../src/core/postgres-config.ts';
import { setTimeout } from 'node:timers/promises';

if(process.env.MIGRATION_DATABASE_URL)throw new Error('MIGRATION_CREDENTIALS_FORBIDDEN_IN_WORKER');
const key=z.string().min(32).parse(process.env.AUTH_SECRET);
const pool=new pg.Pool({...postgresOptions(process.env.DELIVERY_DATABASE_URL),max:2,
  connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});
pool.on('error',()=>{console.error('delivery_database_pool_error');});
const db=new Kysely<unknown>({dialect:new PostgresDialect({pool})});
const store=new IdentityStore(db,key);
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{stopping=true;});
try {
  const result=await store.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls
    AND pg_has_role(current_user,'kavosh_delivery','member')
    AND NOT pg_has_role(current_user,'kavosh_identity','member')
    AND NOT pg_has_role(current_user,'kavosh_identity_policy','member')
    AND NOT pg_has_role(current_user,'kavosh_runtime','member')
    AND NOT pg_has_role(current_user,'kavosh_file_worker','member')
    AND NOT pg_has_role(current_user,'kavosh_file_policy','member')
    AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','identity','auth_private') AND pg_has_role(current_user,n.nspowner,'member'))
    AND NOT EXISTS(SELECT 1 FROM pg_roles e WHERE (e.rolsuper OR e.rolbypassrls) AND pg_has_role(current_user,e.oid,'member'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','identity','auth_private') AND pg_has_role(current_user,c.relowner,'member')) AS safe
    FROM pg_roles r WHERE r.rolname=current_user`);
  if(!result.rows[0]?.safe)throw new Error('UNSAFE_DELIVERY_ROLE');
  const delivery=providerDelivery();
  let sweptAt=0;
  while(!stopping){
    if(Date.now()-sweptAt>=3600000){await store.query('SELECT identity.cleanup_expired_auth()');sweptAt=Date.now();}
    if(!await deliverOne(store,key,delivery))await setTimeout(1000);
  }
} catch {
  console.error('Auth delivery worker stopped; check configuration without logging credentials.');process.exitCode=1;
} finally {await db.destroy();}
