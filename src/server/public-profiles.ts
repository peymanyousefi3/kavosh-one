import 'server-only';
import pg from 'pg';
import { postgresOptions } from '../core/postgres-config.ts';
import type { Database } from '../core/database.ts';
import { createPublicProfileApi,type PublicProfileResource } from '../profiles/public-api.ts';
import {createPublicProfileImageApi} from '../profiles/public-images-api.ts';
import {configuredR2Download} from '../integrations/r2-config.ts';

let pool:pg.Pool|undefined;
const database:Database={async connect(){
 if(!pool){if(process.env.NODE_ENV==='production'&&process.env.MIGRATION_DATABASE_URL)throw new Error('MIGRATION_CREDENTIALS_FORBIDDEN_IN_RUNTIME');pool=new pg.Pool({...postgresOptions(process.env.PUBLIC_PROFILE_DATABASE_URL),max:2,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>console.error('public_profile_pool_error'));}return pool.connect();
}};
export function publicProfileApi(request:Request,id:string,resource:PublicProfileResource|'images'|'image'='profile',selection?:unknown){
 const config={enabled:process.env.PUBLIC_PROFILES_ENABLED==='true',production:process.env.NODE_ENV==='production',edgeSecret:process.env.EDGE_AUTH_SECRET,budgetSecret:process.env.PUBLIC_PROFILE_BUDGET_SECRET};
 if(resource==='images'||resource==='image')return createPublicProfileImageApi(database,{...config,enabled:config.enabled&&process.env.PUBLIC_PROFILE_IMAGES_ENABLED==='true'},configuredR2Download)(request,id,resource==='image'?selection??null:undefined);
 return createPublicProfileApi(database,{...config,shareOrigin:process.env.PROFILE_SHARE_ORIGIN})(request,id,resource);
}
export {database as publicReadDatabase};
