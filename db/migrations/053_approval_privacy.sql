-- Cross-school backfill must not silently skip FORCE-RLS rows. This authority
-- belongs only to the offline migration operator, never a web/worker login.
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND(rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'PRIVACY_MIGRATION_REQUIRES_RLS_BYPASS';END IF;END $$;
ALTER TABLE public.approval_requests ADD COLUMN privacy_bindings jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(privacy_bindings)='array' AND jsonb_array_length(privacy_bindings)<=64);
CREATE FUNCTION public.approval_scope_nonempty(s jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT coalesce(s->'all'='true'::jsonb,false) OR CASE WHEN jsonb_typeof(s->'hubs')='array' THEN jsonb_array_length(s->'hubs')>0 ELSE false END OR CASE WHEN jsonb_typeof(s->'classes')='array' THEN jsonb_array_length(s->'classes')>0 ELSE false END OR CASE WHEN jsonb_typeof(s->'people')='array' THEN jsonb_array_length(s->'people')>0 ELSE false END OR CASE WHEN jsonb_typeof(s->'areas')='array' THEN jsonb_array_length(s->'areas')>0 ELSE false END
$$;
CREATE FUNCTION public.approval_hub_binding(p_cap text,p_hubs uuid[]) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN p_hubs IS NULL OR cardinality(p_hubs)=0 THEN jsonb_build_object('unresolved',true)
 ELSE jsonb_build_object('capability',p_cap,'scope',CASE WHEN array_position(p_hubs,NULL::uuid) IS NOT NULL THEN jsonb_build_object('all',true,'hubs','[]'::jsonb) ELSE jsonb_build_object('all',false,'hubs',(SELECT jsonb_agg(h ORDER BY h) FROM(SELECT DISTINCT unnest(p_hubs) h) d)) END) END
$$;
-- Persist only resource boundaries, never complete grant snapshots. Immutable
-- account/file anchors and canonical financial tuples identify the actual
-- source; losing unrelated grants must not hide an otherwise permitted case.
CREATE FUNCTION public.build_approval_privacy_bindings(p_academy uuid,p_action text,p_payload jsonb,p_context jsonb,p_scope jsonb,p_privacy text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE result jsonb:='[]';view_cap text;account_refs jsonb;account_ids uuid[];hubs uuid[];bound_file uuid;bound_bill uuid;bound_method uuid;bound_handler uuid;r record;ref text;
BEGIN
 IF p_privacy IS NOT NULL THEN
  view_cap=regexp_replace(p_privacy,'[.]edit$','.view');
  IF NOT EXISTS(SELECT 1 FROM public.capability_catalog WHERE name=view_cap) THEN view_cap=p_privacy;END IF;
  IF NOT public.approval_scope_nonempty(p_scope) OR jsonb_typeof(p_scope->'all') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_scope->'hubs') IS DISTINCT FROM 'array' THEN result=jsonb_build_array(jsonb_build_object('unresolved',true));
  ELSE result=jsonb_build_array(jsonb_build_object('capability',view_cap,'scope',p_scope));END IF;
 END IF;
 IF p_action NOT LIKE 'finance.%' THEN RETURN result;END IF;
 account_refs=coalesce(p_context#>'{posting,accounts}',p_context->'accounts');
 IF jsonb_typeof(account_refs)='array' AND jsonb_array_length(account_refs)>0 THEN
  SELECT array_agg(DISTINCT(x->>'id')::uuid) INTO account_ids FROM jsonb_array_elements(account_refs) x;
  SELECT array_agg(a.hub_id ORDER BY a.id) INTO hubs FROM public.finance_accounts a WHERE a.academy_id=p_academy AND a.id=ANY(account_ids);
  IF(SELECT count(*) FROM public.finance_accounts a WHERE a.academy_id=p_academy AND a.id=ANY(account_ids))<>cardinality(account_ids) THEN result=result||jsonb_build_array(jsonb_build_object('unresolved',true));
  ELSE result=result||jsonb_build_array(public.approval_hub_binding('accounts.view',hubs));END IF;
 END IF;
 -- Shared catalogue entries intentionally need some selection permission,
 -- not unrelated school-wide account/ledger authority.
 IF p_action IN('finance.expense-payment.record','finance.expense-payment.reverse') THEN
  IF p_action='finance.expense-payment.record' THEN bound_bill=(p_payload->>'billId')::uuid;bound_method=(p_payload#>>'{method,id}')::uuid;bound_handler=(p_payload->>'handledById')::uuid;
  ELSE SELECT p.bill_id INTO bound_bill FROM public.expense_payments p WHERE p.academy_id=p_academy AND p.id=(p_payload->>'paymentId')::uuid;END IF;
  SELECT array_agg(DISTINCT l.hub_id) INTO hubs FROM public.expense_bill_lines l WHERE l.academy_id=p_academy AND l.bill_id=bound_bill;
  result=result||jsonb_build_array(public.approval_hub_binding('expenses.view',hubs));
  IF bound_method IS NOT NULL THEN
   SELECT m.hub_id INTO r FROM public.finance_payment_methods m WHERE m.academy_id=p_academy AND m.id=bound_method;
   IF NOT FOUND THEN result=result||jsonb_build_array(jsonb_build_object('unresolved',true));
   ELSIF r.hub_id IS NULL THEN result=result||jsonb_build_array(jsonb_build_object('capability','payment-methods.view','any',true));
   ELSE result=result||jsonb_build_array(public.approval_hub_binding('payment-methods.view',ARRAY[r.hub_id]));END IF;
  END IF;
  IF bound_handler IS NOT NULL THEN
   SELECT p.hub_id INTO r FROM public.people p WHERE p.academy_id=p_academy AND p.id=bound_handler;
   IF NOT FOUND THEN result=result||jsonb_build_array(jsonb_build_object('unresolved',true));
   ELSE result=result||jsonb_build_array(jsonb_build_object('capability','people.view','personId',bound_handler));END IF;
  END IF;
 END IF;
 -- Exact file references are checked against CURRENT file/domain access on
 -- every read; no copied hub snapshot can outlive a moved person anchor.
 FOR ref IN SELECT DISTINCT x FROM unnest(ARRAY[p_payload#>>'{evidence,id}',p_context#>>'{evidence,id}',p_context#>>'{payment,evidence_file}',p_context#>>'{receipt,evidence_file}',p_context#>>'{remittance,evidence_file}',p_context#>>'{transfer,evidence_file}',p_context#>>'{bill,evidence_file}']) x WHERE x IS NOT NULL LOOP
  bound_file=ref::uuid;IF NOT EXISTS(SELECT 1 FROM public.file_records f WHERE f.academy_id=p_academy AND f.id=bound_file) THEN result=result||jsonb_build_array(jsonb_build_object('unresolved',true));ELSE result=result||jsonb_build_array(jsonb_build_object('fileId',bound_file));END IF;
 END LOOP;
 RETURN result;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN result||jsonb_build_array(jsonb_build_object('unresolved',true));
END $$;
CREATE FUNCTION public.approval_file_scope_allows(s jsonb,p_hub uuid,p_class uuid,p_person uuid) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT(coalesce(s->'all'='true'::jsonb,false) AND(p_hub IS NOT NULL OR(jsonb_array_length(coalesce(s->'excludedHubs','[]'::jsonb))=0 AND jsonb_array_length(coalesce(s->'excludedAreas','[]'::jsonb))=0)) OR coalesce(s->'hubs' ? p_hub::text,false) OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s->'classes','[]'::jsonb)) x WHERE x->>'id'=p_class::text) OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s->'people','[]'::jsonb)) x WHERE x->>'id'=p_person::text))
 AND NOT coalesce(s->'excludedHubs' ? p_hub::text,false) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s->'excludedClasses','[]'::jsonb)) x WHERE x->>'id'=p_class::text) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(s->'excludedPeople','[]'::jsonb)) x WHERE x->>'id'=p_person::text)
$$;
CREATE FUNCTION public.approval_bindings_allow(p_bindings jsonb,p_scopes jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE b jsonb;s jsonb;f record;domain_cap text;BEGIN
 IF jsonb_typeof(p_bindings) IS DISTINCT FROM 'array' OR jsonb_array_length(p_bindings)>64 THEN RETURN false;END IF;
 FOR b IN SELECT * FROM jsonb_array_elements(p_bindings) LOOP
  IF b->'unresolved'='true'::jsonb THEN RETURN false;END IF;
  IF b ? 'fileId' THEN
   SELECT effective_hub_id,class_id,person_id,domain INTO f FROM public.file_catalogue WHERE id=(b->>'fileId')::uuid;
   IF NOT FOUND OR NOT public.approval_file_scope_allows(p_scopes->'files.view',f.effective_hub_id,f.class_id,f.person_id) THEN RETURN false;END IF;
   domain_cap=CASE f.domain WHEN 'student_private' THEN 'students.view' WHEN 'guardian_private' THEN 'guardians.view' WHEN 'agreement_definition' THEN 'agreements.view' WHEN 'finance_private' THEN 'financial-files.view' WHEN 'general' THEN NULL ELSE 'unknown.private-domain' END;
   IF domain_cap IS NOT NULL AND NOT public.approval_file_scope_allows(p_scopes->domain_cap,f.effective_hub_id,f.class_id,f.person_id) THEN RETURN false;END IF;
  ELSIF b ? 'personId' THEN
   SELECT id,hub_id INTO f FROM public.people WHERE id=(b->>'personId')::uuid;
   s=p_scopes->(b->>'capability');IF NOT FOUND OR NOT public.approval_scope_nonempty(s) OR NOT public.scope_contains(s,jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',jsonb_build_array(jsonb_build_object('id',f.id,'hubId',f.hub_id)))) THEN RETURN false;END IF;
  ELSE
   s=p_scopes->(b->>'capability');IF NOT public.approval_scope_nonempty(s) THEN RETURN false;END IF;
   IF b->'any' IS DISTINCT FROM 'true'::jsonb AND(jsonb_typeof(b->'scope') IS DISTINCT FROM 'object' OR NOT public.approval_scope_nonempty(b->'scope') OR NOT public.scope_contains(s,b->'scope')) THEN RETURN false;END IF;
  END IF;
 END LOOP;RETURN true;
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN RETURN false;
END $$;
UPDATE public.approval_requests p SET privacy_bindings=public.build_approval_privacy_bindings(p.academy_id,p.action,p.payload,p.review_context,p.scope,p.privacy_capability);
CREATE FUNCTION public.bind_approval_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 NEW.privacy_bindings=public.build_approval_privacy_bindings(NEW.academy_id,NEW.action,NEW.payload,NEW.review_context,NEW.scope,NEW.privacy_capability);RETURN NEW;
END $$;
CREATE TRIGGER approval_source_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW EXECUTE FUNCTION public.bind_approval_privacy();
REVOKE INSERT ON public.approval_requests FROM kavosh_runtime;
GRANT INSERT(academy_id,id,requester_id,requester_kind,credential_snapshot,grants_hash,action,target_id,target_version,payload,scope,dependency_hash,review_context,privacy_capability) ON public.approval_requests TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.approval_scope_nonempty(jsonb),public.approval_hub_binding(text,uuid[]),public.build_approval_privacy_bindings(uuid,text,jsonb,jsonb,jsonb,text),public.approval_file_scope_allows(jsonb,uuid,uuid,uuid),public.approval_bindings_allow(jsonb,jsonb),public.bind_approval_privacy() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approval_scope_nonempty(jsonb),public.approval_hub_binding(text,uuid[]),public.build_approval_privacy_bindings(uuid,text,jsonb,jsonb,jsonb,text),public.approval_file_scope_allows(jsonb,uuid,uuid,uuid),public.approval_bindings_allow(jsonb,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 53 $$;
