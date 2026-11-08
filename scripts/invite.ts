import { randomBytes,createHmac } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { postgresOptions } from '../src/core/postgres-config.ts';

// Operator-only invitation issuance. The master identity is derived, not selectable.
const input=z.object({MIGRATION_DATABASE_URL:z.string().url(),AUTH_SECRET:z.string().min(32),
  INVITE_ACADEMY_ID:z.string().uuid(),INVITE_PERSON_ID:z.string().uuid()}).parse(process.env);
const db=new pg.Client(postgresOptions(input.MIGRATION_DATABASE_URL));
try {
  await db.connect();await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8))',[input.INVITE_ACADEMY_ID.toLowerCase()]);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,9))',[input.INVITE_ACADEMY_ID.toLowerCase()]);
  await db.query("SELECT set_config('app.academy_id',$1,true)",[input.INVITE_ACADEMY_ID]);
  const person=(await db.query<{email:string;master:boolean}>(`SELECT p.email,p.id=a.master_person_id AS master FROM public.people p
    JOIN public.academies a ON a.id=p.academy_id WHERE p.academy_id=$1 AND p.id=$2 AND p.kind='human'
    AND p.status<>'disabled' AND a.status IN ('provisioning','active') FOR UPDATE OF p`,[input.INVITE_ACADEMY_ID,input.INVITE_PERSON_ID])).rows[0];
  if(!person?.email)throw new Error('INVALID_INVITEE');
  const token='kvi_'+randomBytes(32).toString('base64url');
  const hash=createHmac('sha256',input.AUTH_SECRET).update(token).digest('hex');
  await db.query(`UPDATE identity.invites SET expires_at=now() WHERE academy_id=$1 AND person_id=$2 AND consumed_at IS NULL`,[input.INVITE_ACADEMY_ID,input.INVITE_PERSON_ID]);
  await db.query(`INSERT INTO identity.invites(token_hash,academy_id,person_id,email,master,expires_at) VALUES($1,$2,$3,lower(btrim($4)),$5,now()+interval '48 hours')`,[hash,input.INVITE_ACADEMY_ID,input.INVITE_PERSON_ID,person.email,person.master]);
  await db.query('COMMIT');
  console.log('Private invitation (expires in 48 hours; deliver securely, never commit):',token);
} catch {
  try{await db.query('ROLLBACK');}catch{/* connection may be unavailable */}
  console.error('Invitation could not be issued.');process.exitCode=1;
} finally {await db.end();}
