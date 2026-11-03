import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/core/database.ts';
import { Kysely,PostgresDialect,PGliteDialect,CompiledQuery } from 'kysely';

export interface TestDatabase {
  identityDb(role?:'kavosh_identity'|'kavosh_delivery'): Kysely<unknown>;
  runtime?: Database;
  query<Row=Record<string,unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}
export async function testDatabase(): Promise<TestDatabase> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    const engine=new PGlite({extensions:{btree_gist}});
    return Object.assign(engine,{identityDb:()=>new Kysely<unknown>({dialect:new PGliteDialect({pglite:engine})}).withSchema('identity')});
  }
  const url = new URL(connectionString);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Integration tests require an isolated loopback PostgreSQL instance');
  const admin = new pg.Client({ connectionString }); await admin.connect();
  // This exact, generated disposable database is the only teardown target.
  const name = `kavosh_test_${randomUUID().replaceAll('-','')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  url.pathname=`/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  return {
    identityDb:(role='kavosh_identity')=>new Kysely<unknown>({dialect:new PostgresDialect({
      pool:new pg.Pool({connectionString:url.toString(),max:4}),
      async onCreateConnection(connection){await connection.executeQuery(CompiledQuery.raw(`SET ROLE ${role}`));}
    })}).withSchema('identity'),
    runtime: {
      async connect() {
        const connection=await pool.connect();
        try { await connection.query('SET ROLE kavosh_runtime'); }
        catch(error) { connection.release(true); throw error; }
        return connection;
      }
    },
    async query<Row>(sql: string, params?: unknown[]) { const result=await client.query(sql,params); return { rows: result.rows as Row[],affectedRows:result.rowCount??undefined }; },
    async exec(sql:string) { return client.query(sql); },
    async close() {
      await pool.end();
      await client.end();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  };
}
