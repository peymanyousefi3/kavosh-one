-- Inbox/event listings must not acquire one worker lock per result. Extract
-- the CURRENT canonical read bodies,not a second implementation of money or
-- tax rules. STABLE read kernels share their caller's single MVCC snapshot.
-- Existing VOLATILE mutation entrypoints keep original OIDs/ACLs/signatures;
-- their separate post-lock SQL statement sees changes committed while waiting.
DO $$ DECLARE body text;needle text;BEGIN
 body=pg_get_functiondef('public.payrun_net_source(uuid)'::regprocedure);
 needle='PERFORM public.lock_hourly_worker(r.person_id);SELECT * INTO r FROM public.payrun_groups WHERE id=p_run AND academy_id=r.academy_id;';
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_READ_RUN_BASE_CHANGED';END IF;
 body=replace(body,needle,'');
 EXECUTE replace(replace(body,'FUNCTION public.payrun_net_source(','FUNCTION public.payrun_net_source_read('),'LANGUAGE plpgsql','LANGUAGE plpgsql STABLE');
 body=pg_get_functiondef('public.calculated_net_source(uuid,jsonb)'::regprocedure);
 needle='public.payrun_net_source(p_run)';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_READ_CALC_BASE_CHANGED';END IF;
 body=replace(body,needle,'public.payrun_net_source_read(p_run)');
 EXECUTE replace(replace(body,'FUNCTION public.calculated_net_source(','FUNCTION public.calculated_net_source_read('),'LANGUAGE plpgsql','LANGUAGE plpgsql STABLE');
 body=pg_get_functiondef('public.calculated_net_current(uuid,integer)'::regprocedure);
 needle='public.calculated_net_source(p_run,c->''request'')';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_READ_CURRENT_BASE_CHANGED';END IF;
 body=replace(body,needle,'public.calculated_net_source_read(p_run,c->''request'')');
 EXECUTE replace(replace(body,'FUNCTION public.calculated_net_current(','FUNCTION public.calculated_net_current_read('),'LANGUAGE plpgsql','LANGUAGE plpgsql STABLE');
 body=pg_get_functiondef('public.payrun_payment_balances(uuid,date,uuid)'::regprocedure);
 EXECUTE replace(replace(body,'FUNCTION public.payrun_payment_balances(','FUNCTION public.payrun_payment_balances_read('),'LANGUAGE sql','LANGUAGE sql STABLE');
 body=pg_get_functiondef('public.payroll_reminder_source(uuid,integer,text)'::regprocedure);
 needle='public.payrun_net_source(g.id)';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_READ_REMINDER_RUN_CHANGED';END IF;
 body=replace(body,needle,'public.payrun_net_source_read(g.id)');
 needle='public.calculated_net_current(run_id,net_version)';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_READ_REMINDER_CALC_CHANGED';END IF;
 body=replace(body,needle,'public.calculated_net_current_read(run_id,net_version)');
 needle='public.payrun_payment_balances(t.id,t.today)';IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PAYROLL_READ_REMINDER_BALANCE_CHANGED';END IF;
 body=replace(body,needle,'public.payrun_payment_balances_read(t.id,t.today)');
 EXECUTE replace(replace(body,'FUNCTION public.payroll_reminder_source(','FUNCTION public.payroll_reminder_source_read('),'LANGUAGE sql','LANGUAGE sql STABLE');
END $$;
CREATE OR REPLACE FUNCTION public.payrun_net_source(p_run uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE who uuid;BEGIN
 SELECT person_id INTO who FROM public.payrun_groups WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_run;
 IF NOT FOUND THEN RETURN NULL;END IF;PERFORM public.lock_hourly_worker(who);
 RETURN public.payrun_net_source_read(p_run);
END $$;
CREATE OR REPLACE FUNCTION public.calculated_net_source(p_run uuid,i jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ DECLARE who uuid;BEGIN
 IF public.calculated_net_request_valid(i) IS NOT TRUE THEN RETURN public.calculated_net_source_read(p_run,i);END IF;
 SELECT person_id INTO who FROM public.payrun_groups WHERE academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND id=p_run;
 IF NOT FOUND THEN RETURN NULL;END IF;PERFORM public.lock_hourly_worker(who);
 RETURN public.calculated_net_source_read(p_run,i);
END $$;
CREATE OR REPLACE FUNCTION public.payrun_payment_balances(p_posting uuid,p_on date,p_exclude uuid DEFAULT NULL)
RETURNS TABLE(account_id uuid,budget_minor numeric,paid_minor numeric,balance_minor numeric,capacity_minor numeric)
LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$ SELECT * FROM public.payrun_payment_balances_read(p_posting,p_on,p_exclude) $$;
CREATE OR REPLACE FUNCTION public.payroll_reminder_source(p_posting uuid,p_days_from_planned_pay integer,p_time_zone text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog SET DateStyle='ISO,YMD' AS $$ DECLARE who uuid;BEGIN
 SELECT g.person_id INTO who FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id
  WHERE p.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND p.id=p_posting;
 IF NOT FOUND THEN RETURN NULL;END IF;PERFORM public.lock_hourly_worker(who);
 RETURN public.payroll_reminder_source_read(p_posting,p_days_from_planned_pay,p_time_zone);
END $$;
REVOKE ALL ON FUNCTION public.payrun_net_source_read(uuid),public.calculated_net_source_read(uuid,jsonb),public.calculated_net_current_read(uuid,integer),public.payrun_payment_balances_read(uuid,date,uuid),public.payroll_reminder_source_read(uuid,integer,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.payrun_net_source_read(uuid),public.calculated_net_source_read(uuid,jsonb),public.calculated_net_current_read(uuid,integer),public.payrun_payment_balances_read(uuid,date,uuid),public.payroll_reminder_source_read(uuid,integer,text) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 260 $$;
