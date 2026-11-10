import 'server-only';
import pg from 'pg';
import { postgresOptions } from '../core/postgres-config.ts';
import type { Database } from '../core/database.ts';
import { createPublicProfileApi } from '../profiles/public-api.ts';

let pool:pg.Pool|undefined;
const database:Database={async connect(){
 if(!pool){if(process.env.NODE_ENV==='production'&&process.env.MIGRATION_DATABASE_URL)throw new Error('MIGRATION_CREDENTIALS_FORBIDDEN_IN_RUNTIME');pool=new pg.Pool({...postgresOptions(process.env.PUBLIC_PROFILE_DATABASE_URL),max:2,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>console.error('public_profile_pool_error'));}return pool.connect();
}};
export function publicProfileApi(request:Request,id:string,resource:'profile'|'achievements'='profile'){return createPublicProfileApi(database,{enabled:process.env.PUBLIC_PROFILES_ENABLED==='true',production:process.env.NODE_ENV==='production',edgeSecret:process.env.EDGE_AUTH_SECRET,budgetSecret:process.env.PUBLIC_PROFILE_BUDGET_SECRET})(request,id,resource);}
