export interface QueryResult<Row = Record<string, unknown>> { rows: Row[]; rowCount?: number | null }
export interface Connection {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
  release(destroy?: boolean): void;
}
export interface Database { connect(): Promise<Connection> }
export const expectedSchemaRevision=171;
export async function assertSchemaReady(db:Connection) {
  const result=await db.query<{revision:number}>('SELECT public.schema_revision() AS revision');
  if(!Number.isInteger(result.rows[0]?.revision)||result.rows[0].revision<expectedSchemaRevision)throw new Error('SCHEMA_NOT_CURRENT');
}

export async function assertRuntimeRole(db: Connection,purpose:'web'|'automation_worker'='web') {
  const result = await db.query<{ safe: boolean }>(`
    SELECT NOT r.rolsuper AND NOT r.rolbypassrls
      AND pg_has_role(current_user,'kavosh_runtime','member')
      AND NOT pg_has_role(current_user,'kavosh_file_worker','member')
      AND NOT pg_has_role(current_user,'kavosh_file_policy','member')
      AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname IN ('kavosh_signature_ingest','kavosh_signature_policy','kavosh_signature_result_worker','kavosh_signature_result_policy','kavosh_event_policy','kavosh_automation_policy') AND pg_has_role(current_user,b.oid,'member'))
      AND ($1::boolean=EXISTS(SELECT 1 FROM pg_roles w WHERE w.rolname='kavosh_automation_worker' AND pg_has_role(current_user,w.oid,'member')))
      AND NOT has_schema_privilege(current_user,'auth_private','usage')
      AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='platform_private' AND has_schema_privilege(current_user,n.oid,'usage'))
      AND NOT has_schema_privilege(current_user,'public','create')
      AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='identity' AND has_schema_privilege(current_user,n.oid,'usage'))
      AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname=current_database()
        AND pg_has_role(current_user,d.datdba,'member'))
      AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','auth_private')
        AND pg_has_role(current_user,n.nspowner,'member'))
      AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','auth_private') AND pg_has_role(current_user,c.relowner,'member'))
      AND NOT EXISTS (SELECT 1 FROM pg_roles elevated WHERE (elevated.rolsuper OR elevated.rolbypassrls)
        AND pg_has_role(current_user,elevated.oid,'member')) AS safe
    FROM pg_roles r WHERE r.rolname=current_user`,[purpose==='automation_worker']);
  if (!result.rows[0]?.safe) throw new Error('UNSAFE_DATABASE_ROLE');
}
