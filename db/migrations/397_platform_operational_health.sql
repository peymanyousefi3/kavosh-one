-- Reuse the owner-only gateway and immutable audit rather than granting the
-- web identity another database function or access to operational credentials.
DO $$ DECLARE body text;needle text:='PERFORM platform_private.authorize_owner(p_user,p_session);';replacement text;BEGIN
 body=pg_get_functiondef('platform_private.request(uuid,uuid,text,uuid,jsonb)'::regprocedure);
 IF (length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'OPERATIONAL_HEALTH_GATEWAY_CHANGED';END IF;
 replacement=needle||$branch$
 IF p_operation='operations.health' THEN
  IF p_key IS NOT NULL OR p_input IS DISTINCT FROM '{}'::jsonb THEN RAISE EXCEPTION 'INVALID_PLATFORM_INPUT' USING ERRCODE='22023';END IF;
  INSERT INTO platform_private.audit_events(actor_user_id,session_id,action,after_data)
   VALUES(p_user,p_session,'platform.operations.health.access',jsonb_build_object('scope','same_vps_operational_metadata','serviceControlGranted',false));
  RETURN jsonb_build_object('status',200,'body',jsonb_build_object('operationalHealthAccessGranted',true));
 END IF;
$branch$;
 EXECUTE replace(body,needle,replacement);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 397 $$;
