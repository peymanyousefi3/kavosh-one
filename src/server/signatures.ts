import 'server-only';
import pg from 'pg';
import { postgresOptions } from '../core/postgres-config.ts';
import type { Database } from '../core/database.ts';

let pool:pg.Pool|undefined;
export function getSignatureIngestDatabase():Database{
 if(process.env.NODE_ENV==='production'&&process.env.MIGRATION_DATABASE_URL)throw new Error('MIGRATION_CREDENTIALS_FORBIDDEN_IN_RUNTIME');
 if(!pool){pool=new pg.Pool({...postgresOptions(process.env.SIGNATURE_INGEST_DATABASE_URL),max:2,connectionTimeoutMillis:3000,idleTimeoutMillis:30000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>{console.error('signature_ingest_database_pool_error');});}
 return pool as unknown as Database;
}
