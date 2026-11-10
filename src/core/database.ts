export interface QueryResult<Row = Record<string, unknown>> { rows: Row[]; rowCount?: number | null }
export interface Connection {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
  release(destroy?: boolean): void;
}
export interface Database { connect(): Promise<Connection> }
export const expectedSchemaRevision=316;
export async function assertSchemaReady(db:Connection) {
  const result=await db.query<{revision:number}>('SELECT public.schema_revision() AS revision');
  if(!Number.isInteger(result.rows[0]?.revision)||result.rows[0].revision<expectedSchemaRevision)throw new Error('SCHEMA_NOT_CURRENT');
}

export async function assertRuntimeRole(db: Connection,purpose:'web'|'automation_worker'|'message_worker'='web') {
  const result = await db.query<{ safe: boolean }>(`
    SELECT NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
      AND ($2::boolean<>pg_has_role(current_user,'kavosh_runtime','member'))
      AND NOT pg_has_role(current_user,'kavosh_file_worker','member')
      AND NOT pg_has_role(current_user,'kavosh_file_policy','member')
      AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname IN ('kavosh_checkout_result_worker','kavosh_checkout_result_policy') AND pg_has_role(current_user,b.oid,'member'))
      AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname IN ('kavosh_payment_ingest','kavosh_payment_policy') AND pg_has_role(current_user,b.oid,'member'))
      AND NOT EXISTS(SELECT 1 FROM pg_roles b WHERE b.rolname IN ('kavosh_report_capture_policy','kavosh_message_policy','kavosh_signature_ingest','kavosh_signature_policy','kavosh_signature_result_worker','kavosh_signature_result_policy','kavosh_signature_completion_worker','kavosh_signature_completion_policy','kavosh_signature_evidence_worker','kavosh_signature_evidence_policy','kavosh_event_policy','kavosh_automation_policy','kavosh_bot_policy') AND pg_has_role(current_user,b.oid,'member'))
      AND ($1::boolean=EXISTS(SELECT 1 FROM pg_roles w WHERE w.rolname='kavosh_automation_worker' AND pg_has_role(current_user,w.oid,'member')))
      AND ($2::boolean=EXISTS(SELECT 1 FROM pg_roles w WHERE w.rolname='kavosh_message_worker' AND pg_has_role(current_user,w.oid,'member')))
      AND NOT has_schema_privilege(current_user,'auth_private','usage')
      AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='platform_private' AND has_schema_privilege(current_user,n.oid,'usage'))
      AND NOT has_schema_privilege(current_user,'public','create')
      AND (NOT $2::boolean OR NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN('r','p','v','m','f') AND(
          has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))))
      AND (NOT $2::boolean OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE')
        AND p.oid<>ALL(array_remove(ARRAY[to_regprocedure('public.claim_notification_delivery(jsonb)'),to_regprocedure('public.begin_notification_delivery(uuid,uuid)'),
          to_regprocedure('public.finish_notification_delivery(uuid,uuid,text,text,text)'),to_regprocedure('public.lock_notification_delivery_source(uuid,uuid)'),
          to_regprocedure('public.account_security_notice_allows(uuid,uuid,jsonb)'),to_regprocedure('public.report_comment_human_verified(uuid)'),to_regprocedure('public.checkout_notice_allows(uuid,jsonb)'),to_regprocedure('public.checkout_notice_current(uuid)'),
          to_regprocedure('public.work_signature_evidence_notice_state(uuid)'),to_regprocedure('public.tuition_reminder_notice_current(uuid)'),
          to_regprocedure('public.tuition_reminder_notice_allows(uuid,uuid,jsonb)'),to_regprocedure('public.expense_reminder_notice_current(uuid)'),to_regprocedure('public.expense_reminder_notice_allows(uuid,jsonb)'),to_regprocedure('public.payroll_reminder_notice_current(uuid)'),to_regprocedure('public.payroll_reminder_notice_allows(uuid,jsonb)'),to_regprocedure('public.statement_reminder_notice_current(uuid)'),to_regprocedure('public.statement_reminder_notice_allows(uuid,uuid,jsonb)'),to_regprocedure('public.counterparty_notice_current(uuid)'),to_regprocedure('public.counterparty_notice_allows(uuid,uuid,jsonb)')],NULL)::oid[])))
      AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='identity' AND has_schema_privilege(current_user,n.oid,'usage'))
      AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datname=current_database()
        AND pg_has_role(current_user,d.datdba,'member'))
      AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname IN ('public','auth_private')
        AND pg_has_role(current_user,n.nspowner,'member'))
      AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN ('public','auth_private') AND pg_has_role(current_user,c.relowner,'member'))
      AND NOT EXISTS (SELECT 1 FROM pg_roles elevated WHERE (elevated.rolsuper OR elevated.rolbypassrls OR elevated.rolcreaterole OR elevated.rolcreatedb OR elevated.rolreplication)
        AND pg_has_role(current_user,elevated.oid,'member')) AS safe
    FROM pg_roles r WHERE r.rolname=current_user`,[purpose==='automation_worker',purpose==='message_worker']);
  if (!result.rows[0]?.safe) throw new Error('UNSAFE_DATABASE_ROLE');
}
