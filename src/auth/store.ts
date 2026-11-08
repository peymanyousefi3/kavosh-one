import { createHmac } from 'node:crypto';
import { CompiledQuery, type Kysely } from 'kysely';

export class IdentityStore {
  constructor(readonly db: Kysely<unknown>, private secret: string) {}
  async query<Row=Record<string,unknown>>(text: string, values: unknown[] = []) {
    return this.db.executeQuery<Row>(CompiledQuery.raw(text, values));
  }
  async safe() {
    const result = await this.query<{ safe: boolean }>(`SELECT
      NOT r.rolsuper AND NOT r.rolbypassrls
      AND pg_has_role(current_user,'kavosh_identity','member')
      AND NOT pg_has_role(current_user,'kavosh_runtime','member')
      AND NOT pg_has_role(current_user,'kavosh_delivery','member')
      AND NOT pg_has_role(current_user,'kavosh_identity_policy','member')
      AND NOT pg_has_role(current_user,'kavosh_file_worker','member')
      AND NOT pg_has_role(current_user,'kavosh_file_policy','member')
      AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname IN ('kavosh_signature_ingest','kavosh_signature_policy') AND pg_has_role(current_user,b.oid,'member'))
      AND NOT has_schema_privilege(current_user,'auth_private','usage')
      AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='platform_private' AND has_schema_privilege(current_user,n.oid,'usage'))
      AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
      AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','identity','auth_private') AND pg_has_role(current_user,c.relowner,'member'))
      AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','identity','auth_private') AND pg_has_role(current_user,n.nspowner,'member'))
      AND NOT EXISTS (SELECT 1 FROM pg_roles elevated WHERE (elevated.rolsuper OR elevated.rolbypassrls) AND pg_has_role(current_user,elevated.oid,'member')) AS safe
      FROM pg_roles r WHERE r.rolname=current_user`);
    if (!result.rows[0]?.safe) throw new Error('UNSAFE_IDENTITY_ROLE');
  }
  digest(value: string) { return createHmac('sha256',this.secret).update(value).digest('hex'); }
  async safeDelivery() {
    const result=await this.query<{safe:boolean}>(`SELECT NOT r.rolsuper AND NOT r.rolbypassrls
    AND pg_has_role(current_user,'kavosh_delivery','member')
    AND NOT pg_has_role(current_user,'kavosh_identity','member')
    AND NOT pg_has_role(current_user,'kavosh_identity_policy','member')
    AND NOT pg_has_role(current_user,'kavosh_runtime','member')
    AND NOT pg_has_role(current_user,'kavosh_file_worker','member')
    AND NOT pg_has_role(current_user,'kavosh_file_policy','member')
    AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname IN ('kavosh_signature_ingest','kavosh_signature_policy') AND pg_has_role(current_user,b.oid,'member'))
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='platform_private' AND has_schema_privilege(current_user,n.oid,'usage'))
    AND NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND pg_has_role(current_user,d.datdba,'member'))
    AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','identity','auth_private') AND pg_has_role(current_user,n.nspowner,'member'))
    AND NOT EXISTS(SELECT 1 FROM pg_roles e WHERE (e.rolsuper OR e.rolbypassrls) AND pg_has_role(current_user,e.oid,'member'))
    AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','identity','auth_private') AND pg_has_role(current_user,c.relowner,'member')) AS safe
    FROM pg_roles r WHERE r.rolname=current_user`);
    if(!result.rows[0]?.safe)throw new Error('UNSAFE_DELIVERY_ROLE');
  }
  async budget(key: string, maximum: number, seconds: number) {
    const result=await this.query<{ allowed: boolean }>('SELECT identity.consume_budget($1,$2,$3) AS allowed',[this.digest(key),maximum,seconds]);
    return result.rows[0]?.allowed === true;
  }
  async invite(token: string, email: string) {
    if (!/^kvi_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result=await this.query<{ academy_id:string;person_id:string;master:boolean }>('SELECT * FROM identity.inspect_invite($1,$2)',[this.digest(token),email.trim().toLowerCase()]);
    return result.rows[0]??null;
  }
  async accept(token: string,userId: string,sessionId: string) {
    return (await this.query<{ academy_id:string;code:string }>('SELECT * FROM identity.accept_invite($1,$2,$3)',[this.digest(token),userId,sessionId])).rows[0]??null;
  }
  async setRequiredMfa(userId:string) { await this.query('UPDATE identity."user" SET "mfaRequired"=true WHERE id=$1',[userId]); }
  async markMfaSession(sessionId:string,userId:string) { await this.query('UPDATE identity.session SET "mfaVerified"=true WHERE id=$1 AND "userId"=$2',[sessionId,userId]); }
  async securityEvent(userId:string,event:string) {await this.query('INSERT INTO identity.security_events(user_id,event) VALUES($1,$2)',[userId,event]);}
  async hasRecovery(userId:string) { return (await this.query('SELECT 1 FROM identity."twoFactor" WHERE "userId"=$1',[userId])).rows.length>0; }
  async verifiedPhone(userId:string) {
    return (await this.query<{ phoneNumber:string }>('SELECT "phoneNumber" FROM identity."user" WHERE id=$1 AND "emailVerified" AND "phoneNumberVerified"',[userId])).rows[0]?.phoneNumber;
  }
  async pendingPhone(userId:string,phone:string) {
    await this.query(`INSERT INTO identity.phone_challenges (user_id,phone,expires_at) VALUES ($1,$2,now()+interval '5 minutes')
      ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,expires_at=excluded.expires_at`,[userId,phone]);
  }
  async matchesPhone(userId:string,phone:string) {
    return (await this.query('SELECT 1 FROM identity.phone_challenges WHERE user_id=$1 AND phone=$2 AND expires_at>now()',[userId,phone])).rows.length===1;
  }
  async phoneAvailable(userId:string,phone:string) {
    return (await this.query('SELECT 1 FROM identity."user" WHERE "phoneNumber"=$1 AND id<>$2',[phone,userId])).rows.length===0;
  }
  async revokeRecoverySessions(userId:string,event='password.reset') {
    // Trusted-device verification rows store the user ID as their value.
    await this.query('DELETE FROM identity.session WHERE "userId"=$1',[userId]);
    await this.query('DELETE FROM identity.verification WHERE value=$1',[userId]);
    await this.query(`INSERT INTO identity.security_events(user_id,event) VALUES ($1,$2)`,[userId,event]);
  }
  async memberships(userId:string) {
    return (await this.query('SELECT * FROM identity.memberships($1)',[userId])).rows;
  }
  async sessionReady(userId:string,sessionId:string) {
    return (await this.query('SELECT 1 FROM identity.session s JOIN identity."user" u ON u.id=s."userId" WHERE s.id=$1 AND u.id=$2 AND s."expiresAt">now() AND u."emailVerified" AND coalesce(u."phoneNumberVerified",false) AND (NOT coalesce(u."twoFactorEnabled",false) OR s."mfaVerified")',[sessionId,userId])).rows.length>0;
  }
  async ownSessionToken(userId:string,sessionId:string) { return (await this.query<{token:string}>('SELECT token FROM identity.session WHERE id=$1 AND "userId"=$2',[sessionId,userId])).rows[0]?.token; }
}
