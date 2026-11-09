-- The sender evaluates the existing read policies, but must not inherit the
-- web principal's domain writes, authentication or approval execution rights.
REVOKE kavosh_runtime FROM kavosh_message_worker;
GRANT USAGE ON SCHEMA public TO kavosh_message_worker;
DO $$ DECLARE t text;cols text;BEGIN
 FOREACH t IN ARRAY ARRAY[
  'academies','people','capability_catalog','role_assignments','role_permissions',
  'assignment_hubs','assignment_classes','assignment_people','assignment_countries','assignment_regions','assignment_cities',
  'countries','regions','cities','geographic_areas','hub_geography','assignment_geography','assignment_geographic_hubs',
  'automation_event_sources','automation_rules','automation_rule_revisions',
  'calendar_events','classes','class_sessions','class_enrollments','class_staff','hubs','student_profiles','family_relationships',
  'report_schedule_issues','report_schedule_work','report_schedules','report_job_issues','report_jobs','payroll_tax_profiles',
  'file_catalogue','file_records','agreement_templates','work_engagements','work_agreement_contents','work_agreement_preparations',
  'work_signature_completion_evidence','work_signature_dispatch_starts','work_signature_send_attempts','work_signature_send_requests',
  'finance_accounts','finance_payment_methods','payroll_hourly_accruals','payroll_tax_period_revisions','payrun_groups','payrun_net_postings','payrun_payments',
  'pay_statement_release_revisions','pay_statement_releases','payrun_statement_records','payrun_statement_revisions',
  'expense_bill_lines','expense_bills','expense_commitment_bill_links','expense_commitment_revisions','expense_commitments',
  'session_attendance','session_reports','session_time_entries','session_evidence_reviews','session_follow_up_occurrences','session_reminder_occurrences'
 ] LOOP
  -- Copy only the existing web READ boundary on these explicit dependencies.
  -- In particular, never widen column-restricted queue/identity/provider reads.
  IF has_table_privilege('kavosh_runtime','public.'||t,'SELECT') THEN
   EXECUTE format('GRANT SELECT ON public.%I TO kavosh_message_worker',t);
  ELSE
   SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO cols FROM pg_attribute
    WHERE attrelid=('public.'||t)::regclass AND attnum>0 AND NOT attisdropped
    AND has_column_privilege('kavosh_runtime',attrelid,attnum,'SELECT');
   IF cols IS NULL THEN RAISE EXCEPTION 'MESSAGE_READ_DEPENDENCY_NOT_GRANTED: %',t;END IF;
   EXECUTE format('GRANT SELECT(%s) ON public.%I TO kavosh_message_worker',cols,t);
  END IF;
 END LOOP;
END $$;
GRANT SELECT(academy_id,id,version,privacy_capability,privacy_bindings,requester_id,scope) ON public.approval_requests TO kavosh_message_worker;
GRANT SELECT(academy_id,id,event_id,person_id,rule_id,rule_version,status) ON public.notification_deliveries TO kavosh_message_worker;
-- Exact reviewed helper signatures, not all functions and not an inference
-- that STABLE/IMMUTABLE labels make a function safe. Definer helpers retain
-- their own private dependency privileges; the sender gets none of those.
GRANT EXECUTE ON FUNCTION
 public.schema_revision(),public.scope_contains(jsonb,jsonb),public.scope_contains_before_payrun_groups(jsonb,jsonb),
 public.scope_contains_before_work_records(jsonb,jsonb),public.scope_contains_before_exact_records(jsonb,jsonb),
 public.scope_contains_geographic(jsonb,jsonb),public.scope_contains_records(jsonb,jsonb),public.scope_covers_ref(jsonb,jsonb,text),
 public.area_contains(jsonb,jsonb),public.area_matches_hub(jsonb,jsonb,boolean),public.work_scope_allows(jsonb,uuid,uuid),
 public.approval_bindings_allow(jsonb,jsonb),public.approval_scope_nonempty(jsonb),public.approval_file_scope_allows(jsonb,uuid,uuid,uuid),
 public.work_file_allows(uuid,jsonb,boolean,boolean),public.work_file_context(uuid),public.commitment_bill_related_allow(uuid,jsonb),
 public.commitment_bill_source_scopes(uuid,integer,uuid),public.expense_commitment_scope(jsonb),public.poll_recipient_records_allow(jsonb,jsonb),
 public.homework_recipients_allow(jsonb,jsonb),public.payrun_net_source_allows(uuid,text,jsonb),public.payroll_preparation_allows(jsonb,jsonb,jsonb),
 public.calculated_net_history_allows(uuid,jsonb,jsonb),public.calculated_net_request_valid(jsonb),public.work_money_valid(jsonb,integer),
 public.is_supervisor(uuid,uuid),public.supervisor_chain(uuid),public.calendar_event_scope(text,uuid,uuid),
 public.calendar_event_notice_person(uuid,uuid,jsonb),public.calendar_event_family_allowed(uuid,uuid,uuid,jsonb,uuid,uuid),
 public.calendar_event_notice_current(uuid),public.calendar_event_notice_source(uuid),public.report_comment_human_verified(uuid),public.report_recipient(uuid,uuid),
 public.session_calendar_person(uuid,uuid,jsonb),public.session_notification_source(uuid),public.session_follow_up_current(uuid),
 public.session_follow_up_source(uuid),public.session_evidence_snapshot(uuid),public.session_follow_up_attention(jsonb,jsonb,text),
 public.session_attendance_source(uuid),public.session_report_source(uuid,jsonb),public.session_reminder_current(uuid),public.session_reminder_stamp(jsonb),
 public.work_signature_evidence_notice_allows(uuid,uuid,jsonb),public.work_signature_notice_allows(uuid,jsonb),public.work_signature_evidence_notice_state(uuid),
 public.pay_statement_notice_allows(uuid,uuid,jsonb),public.pay_statement_notice_current(uuid),
 public.report_schedule_issue_current(uuid),public.account_security_notice_allows(uuid,uuid,jsonb)
 TO kavosh_message_worker;

-- FOR SHARE also requires UPDATE privilege in PostgreSQL. Keep that privilege
-- private, behind an exact live delivery/lease boundary; never grant it to the
-- sender just to acquire source locks. No user-supplied table or lock target.
GRANT SELECT ON public.automation_event_sources,public.calendar_events,public.report_schedules,
 public.classes,public.class_sessions,public.approval_requests,public.payrun_net_postings,public.payrun_groups TO kavosh_message_policy;
GRANT UPDATE(id) ON public.calendar_events,public.report_schedules,public.classes,public.class_sessions,public.approval_requests TO kavosh_message_policy;
GRANT EXECUTE ON FUNCTION public.lock_hourly_worker(uuid),public.lock_finance_book(),public.pay_statement_notice_worker(uuid) TO kavosh_message_policy;
CREATE FUNCTION public.lock_notification_delivery_source(p_delivery uuid,p_lease uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;e record;BEGIN
 IF tenant IS NULL THEN RETURN false;END IF;
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,8));
 PERFORM pg_advisory_xact_lock_shared(hashtextextended(tenant::text,9));
 SELECT s.* INTO e FROM public.notification_deliveries d JOIN public.automation_event_sources s ON s.academy_id=d.academy_id AND s.event_id=d.event_id
  WHERE d.academy_id=tenant AND d.id=p_delivery AND d.status='preparing' AND d.lease_token=p_lease AND d.lease_until>clock_timestamp();
 IF NOT FOUND THEN RETURN false;END IF;
 IF e.source_kind='calendar_event' THEN
  PERFORM id FROM public.calendar_events WHERE academy_id=tenant AND id=e.calendar_event_id FOR SHARE;
 ELSIF e.source_kind='pay_statement' THEN
  PERFORM public.lock_hourly_worker(public.pay_statement_notice_worker(e.event_id));
 ELSIF e.source_kind='report_schedule' THEN
  PERFORM id FROM public.report_schedules WHERE academy_id=tenant AND id=(e.projection->>'entityId')::uuid FOR SHARE;
 ELSIF e.source_kind='session' THEN
  -- Preserve the existing writer's parent-then-session order.
  PERFORM c.id FROM public.classes c JOIN public.class_sessions s ON s.academy_id=c.academy_id AND s.class_id=c.id WHERE s.academy_id=tenant AND s.id=e.session_id FOR SHARE OF c;
  PERFORM id FROM public.class_sessions WHERE academy_id=tenant AND id=e.session_id FOR SHARE;
 ELSIF e.source_kind='approval' THEN
  PERFORM id FROM public.approval_requests WHERE academy_id=tenant AND id=e.approval_id FOR SHARE;
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.lock_notification_delivery_source(uuid,uuid) FROM PUBLIC;
GRANT CREATE ON SCHEMA public TO kavosh_message_policy;
ALTER FUNCTION public.lock_notification_delivery_source(uuid,uuid) OWNER TO kavosh_message_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_message_policy;
GRANT EXECUTE ON FUNCTION public.lock_notification_delivery_source(uuid,uuid) TO kavosh_message_worker;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE AS $$SELECT 234$$;
