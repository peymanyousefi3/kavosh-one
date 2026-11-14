import 'server-only';
import pg from 'pg';
import type { Database } from '../core/database.ts';
import { postgresOptions } from '../core/postgres-config.ts';

let pool: pg.Pool | undefined;
export function getDatabase(): Database {
  if (!pool) {
    if (process.env.NODE_ENV === 'production' && process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_CREDENTIALS_FORBIDDEN_IN_RUNTIME');
    pool = new pg.Pool({ ...postgresOptions(process.env.DATABASE_URL), max: 10, connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000, statement_timeout: 5000, query_timeout: 7000 });
    pool.on('error', () => { console.error('database_pool_error'); });
  }
  return pool as unknown as Database;
}
