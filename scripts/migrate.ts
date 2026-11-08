import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { postgresOptions } from '../src/core/postgres-config.ts';

const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('Set MIGRATION_DATABASE_URL using the dedicated migration owner');
const client = new pg.Client(postgresOptions(connectionString));
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(742061)');
  await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const directory = new URL('../db/migrations/', import.meta.url);
  const names=(await readdir(directory)).filter(n=>n.endsWith('.sql')).sort();
  // A misnamed SQL file must fail installation,not silently disappear while
  // test fixtures that load all SQL files appear to pass.
  if(names.some(n=>!/^\d+_[a-z_]+\.sql$/.test(n)))throw new Error('Invalid migration filename');
  for (const name of names) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = await client.query<{ checksum: string }>('SELECT checksum FROM public.schema_migrations WHERE name=$1', [name]);
    if (previous.rows[0]) {
      if (previous.rows[0].checksum !== checksum) throw new Error(`Migration changed after application: ${name}`);
      continue;
    }
    await client.query(sql);
    await client.query('INSERT INTO public.schema_migrations (name,checksum) VALUES ($1,$2)', [name, checksum]);
    console.log(`Applied ${name}`);
  }
  await client.query('COMMIT');
} catch (error) {
  try { await client.query('ROLLBACK'); } catch { /* connection may not have opened */ }
  // Do not print pg errors: they may contain a connection string or row data.
  console.error(error instanceof Error && error.message.startsWith('Migration changed') ? error.message : 'Migration failed; inspect database configuration without exposing secrets.');
  process.exitCode = 1;
} finally { await client.end(); }
