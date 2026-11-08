import 'server-only';
import pg from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { z } from 'zod';
import { createIdentity } from '../auth/config.ts';
import { IdentityStore } from '../auth/store.ts';
import { identityGateway, humanResolver,platformHumanResolver } from '../auth/gateway.ts';
import { queuedDelivery } from '../auth/delivery.ts';
import { postgresOptions } from '../core/postgres-config.ts';
import type { HumanSession } from '../core/api.ts';

function initialize() {
  const production=process.env.NODE_ENV==='production';
  if(production&&process.env.MIGRATION_DATABASE_URL)throw new Error('MIGRATION_CREDENTIALS_FORBIDDEN_IN_RUNTIME');
  const origin=z.string().url().parse(process.env.APP_ORIGIN);
  const url=new URL(origin);
  if(url.origin!==origin||url.username||url.password||(production&&url.protocol!=='https:')||!['http:','https:'].includes(url.protocol))throw new Error('INVALID_APP_ORIGIN');
  const config={origin,production,secret:z.string().min(32).parse(process.env.AUTH_SECRET),
    edgeSecret:production?z.string().min(32).parse(process.env.EDGE_AUTH_SECRET):undefined};
  const pool=new pg.Pool({
    ...postgresOptions(process.env.IDENTITY_DATABASE_URL),max:6,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:5000,query_timeout:7000
  });
  pool.on('error',()=>{console.error('identity_database_pool_error');});
  const db=new Kysely<unknown>({dialect:new PostgresDialect({pool})}).withSchema('identity');
  const store=new IdentityStore(db,config.secret);
  const auth=createIdentity(db,store,queuedDelivery(store,config.secret),config);
  return {auth,store,config,handle:identityGateway(auth,store,config),resolve:humanResolver(auth,store,config),resolvePlatform:platformHumanResolver(auth,store,config)};
}
let instance:ReturnType<typeof initialize>|undefined;
export function getIdentity(){return instance??=initialize();}
export async function resolveHuman(request:Request):Promise<HumanSession|null> {
  return getIdentity().resolve(request);
}
export async function resolvePlatformHuman(request:Request){return getIdentity().resolvePlatform(request);}
