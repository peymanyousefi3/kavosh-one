import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

export interface TestDatabase {
  query<Row=Record<string,unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}
export async function testDatabase(): Promise<TestDatabase> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) return new PGlite();
  const url = new URL(connectionString);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Integration tests require an isolated loopback PostgreSQL instance');
  const admin = new pg.Client({ connectionString }); await admin.connect();
  // This exact, generated disposable database is the only teardown target.
  const name = `kavosh_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname=`/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return {
    async query<Row>(sql: string, params?: unknown[]) { const result=await client.query(sql,params); return { rows: result.rows as Row[],affectedRows:result.rowCount??undefined }; },
    async exec(sql:string) { return client.query(sql); },
    async close() {
      await client.end();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  };
}
