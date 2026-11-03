import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { mintToken, hashToken } from '../src/core/tokens.ts';
import { postgresOptions } from '../src/core/postgres-config.ts';

// Local operator provisioning only. Does not activate the academy or verify anyone.
const config = z.object({
  MIGRATION_DATABASE_URL: z.string().url(),
  BOOTSTRAP_ACADEMY_NAME: z.string().min(1).max(200),
  BOOTSTRAP_MASTER_NAME: z.string().min(1).max(200),
  BOOTSTRAP_MASTER_EMAIL: z.string().email()
}).parse(process.env);
const client = new pg.Client(postgresOptions(config.MIGRATION_DATABASE_URL));
try {
  await client.connect(); await client.query('BEGIN');
  const academy = randomUUID(), master = randomUUID(), bot = randomUUID(), role = randomUUID(), assignment = randomUUID(), credential = randomUUID();
  const token = mintToken();
  await client.query("SELECT set_config('app.academy_id',$1,true)", [academy]);
  await client.query('INSERT INTO public.academies (id,name,master_person_id) VALUES ($1,$2,$3)', [academy, config.BOOTSTRAP_ACADEMY_NAME, master]);
  await client.query("INSERT INTO public.people (academy_id,id,kind,name,email,status) VALUES ($1,$2,'human',$3,$4,'pending')", [academy, master, config.BOOTSTRAP_MASTER_NAME, config.BOOTSTRAP_MASTER_EMAIL]);
  await client.query("INSERT INTO public.people (academy_id,id,kind,name) VALUES ($1,$2,'bot','Foundation provisioning bot')", [academy, bot]);
  await client.query("INSERT INTO public.roles (academy_id,id,name) VALUES ($1,$2,'Foundation operations')", [academy, role]);
  // No financial, approval or role-management power is provisioned here.
  for (const capability of ['hubs.view','hubs.edit','people.view','people.edit','audit.view','credentials.revoke']) {
    await client.query("INSERT INTO public.role_permissions VALUES ($1,$2,$3,'allow')", [academy, role, capability]);
  }
  await client.query('INSERT INTO public.role_assignments (academy_id,id,person_id,role_id,all_hubs) VALUES ($1,$2,$3,$4,true)', [academy, assignment, bot, role]);
  await client.query("INSERT INTO auth_private.credentials (id,academy_id,person_id,token_hash,capabilities,all_hubs,expires_at) VALUES ($1,$2,$3,$4,$5,true,now()+interval '7 days')", [credential, academy, bot, hashToken(token), ['hubs.view','hubs.edit','people.view','people.edit','audit.view','credentials.revoke']]);
  await client.query('COMMIT');
  console.log('Provisioned inactive academy:', academy);
  console.log('Master must complete real verification before activation. No activation endpoint exists in this milestone.');
  console.log('One-time bot credential (store securely; do not commit or share in chat):', token);
} catch {
  try { await client.query('ROLLBACK'); } catch { /* unavailable connection */ }
  console.error('Provisioning failed. No academy activation was performed.'); process.exitCode=1;
} finally { await client.end(); }
