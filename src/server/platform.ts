import 'server-only';
import pg from 'pg';
import type { Database } from '../core/database.ts';
import { postgresOptions } from '../core/postgres-config.ts';
import { createPlatformApi } from '../platform/api.ts';
import { resolvePlatformHuman } from './identity.ts';
import {readOperationalHealthStatus} from '../operations/health-status.ts';

let pool:pg.Pool|undefined;
const database:Database={async connect(){
 if(!pool){
  if(process.env.NODE_ENV==='production'&&process.env.MIGRATION_DATABASE_URL)throw new Error('MIGRATION_CREDENTIALS_FORBIDDEN_IN_RUNTIME');
  pool=new pg.Pool({...postgresOptions(process.env.PLATFORM_DATABASE_URL),max:2,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:5000,query_timeout:7000});
  pool.on('error',()=>{console.error('platform_database_pool_error');});
 }
 return pool.connect();
}};
export function platformApi(request:Request,path:string){return createPlatformApi(database,resolvePlatformHuman,process.env.PLATFORM_ENABLED==='true',{invitationSecret:process.env.AUTH_SECRET,readOperationalHealth:readOperationalHealthStatus})(request,path);}
