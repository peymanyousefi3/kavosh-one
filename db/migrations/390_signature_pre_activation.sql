-- Permit only discard-only handling of unrelated account events during initial
-- provisioning. Do not activate a school, retain bound events while inactive,
-- or relax suspended/deleted/legacy stream handling.
DO $$ DECLARE d text;old_selector text;new_selector text;filter text;BEGIN
 d=pg_get_functiondef('public.receive_signature_event(uuid,text,uuid,bigint,bigint,text,uuid,text,text,uuid,text,text,integer)'::regprocedure);
 old_selector=$s$WHERE sc.id=p_connection AND sc.enabled AND a.status IN ('active','read_only') FOR SHARE OF sc,a;$s$;
 new_selector=$s$WHERE sc.id=p_connection AND sc.enabled AND (a.status IN ('active','read_only') OR (sc.bound_documents_only AND a.status='provisioning')) FOR SHARE OF sc,a;$s$;
 filter=$s$IF c.bound_documents_only AND (p_object IS DISTINCT FROM 'document' OR public.signature_callback_document_bound(c.academy_id,c.id,p_resource) IS NOT TRUE) THEN RETURN 'ignored';END IF;$s$;
 IF position(old_selector IN d)=0 OR position(filter IN d)=0 THEN RAISE EXCEPTION 'SIGNATURE_PRE_ACTIVATION_DEFINITION_CHANGED';END IF;
 d=replace(d,old_selector,new_selector);
 d=replace(d,filter,filter||E'\n IF NOT EXISTS(SELECT 1 FROM public.academies WHERE id=c.academy_id AND status IN (''active'',''read_only'')) THEN RAISE EXCEPTION ''SIGNATURE_CONNECTION_UNAVAILABLE'' USING ERRCODE=''23514'';END IF;');
 EXECUTE d;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 390 $$;
