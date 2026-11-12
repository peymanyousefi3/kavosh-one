-- Account-level callbacks also cover unrelated web agreements. New production
-- registrations opt into this immutable retention boundary. Existing streams
-- retain their prior semantics; no old event or agreement is changed/deleted.
ALTER TABLE public.signature_connections ADD COLUMN bound_documents_only boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION public.preserve_signature_connection() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF (NEW.id,NEW.academy_id,NEW.region,NEW.environment,NEW.client_id,NEW.bound_documents_only) IS DISTINCT FROM (OLD.id,OLD.academy_id,OLD.region,OLD.environment,OLD.client_id,OLD.bound_documents_only) THEN RAISE EXCEPTION 'SIGNATURE_CONNECTION_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

-- Only the NOLOGIN intake executor reads these routing columns. Its service
-- login still has no direct table or identity access and no new entrypoint.
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['signature_transport_receipts','signature_dispatch_outcomes','signature_dispatch_starts','signature_send_attempts','signature_send_requests','agreement_packages','work_signature_transport_receipts','work_signature_dispatch_outcomes','work_signature_dispatch_starts','work_signature_send_attempts','work_signature_send_requests','work_agreement_preparations'] LOOP
 EXECUTE format('CREATE POLICY signature_callback_binding_read ON public.%I FOR SELECT TO kavosh_signature_policy USING(true)',t);
END LOOP;END $$;
GRANT SELECT(academy_id,start_id,document_id,state) ON public.signature_transport_receipts,public.signature_dispatch_outcomes,public.work_signature_transport_receipts,public.work_signature_dispatch_outcomes TO kavosh_signature_policy;
GRANT SELECT(academy_id,id,attempt_id) ON public.signature_dispatch_starts,public.work_signature_dispatch_starts TO kavosh_signature_policy;
GRANT SELECT(academy_id,id,request_id) ON public.signature_send_attempts,public.work_signature_send_attempts TO kavosh_signature_policy;
GRANT SELECT(academy_id,id,package_id) ON public.signature_send_requests TO kavosh_signature_policy;
GRANT SELECT(academy_id,id,connection_id) ON public.agreement_packages TO kavosh_signature_policy;
GRANT SELECT(academy_id,id,preparation_id) ON public.work_signature_send_requests TO kavosh_signature_policy;
GRANT SELECT(academy_id,id,source_snapshot) ON public.work_agreement_preparations TO kavosh_signature_policy;
CREATE INDEX signature_callback_receipt_document ON public.signature_transport_receipts(academy_id,document_id,start_id) WHERE document_id IS NOT NULL;
CREATE INDEX signature_callback_outcome_document ON public.signature_dispatch_outcomes(academy_id,document_id,start_id) WHERE document_id IS NOT NULL;
CREATE INDEX work_signature_callback_receipt_document ON public.work_signature_transport_receipts(academy_id,document_id,start_id) WHERE document_id IS NOT NULL;
CREATE INDEX work_signature_callback_outcome_document ON public.work_signature_dispatch_outcomes(academy_id,document_id,start_id) WHERE document_id IS NOT NULL;
CREATE FUNCTION public.signature_callback_document_bound(p_academy uuid,p_connection uuid,p_document uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH enrollment AS (
  SELECT academy_id,start_id FROM public.signature_transport_receipts WHERE academy_id=p_academy AND document_id=p_document AND state='accepted_for_processing'
  UNION SELECT academy_id,start_id FROM public.signature_dispatch_outcomes WHERE academy_id=p_academy AND document_id=p_document AND state='accepted_for_processing'
 ), work AS (
  SELECT academy_id,start_id FROM public.work_signature_transport_receipts WHERE academy_id=p_academy AND document_id=p_document AND state='accepted_for_processing'
  UNION SELECT academy_id,start_id FROM public.work_signature_dispatch_outcomes WHERE academy_id=p_academy AND document_id=p_document AND state='accepted_for_processing'
 )
 SELECT EXISTS(SELECT 1 FROM enrollment d
  JOIN public.signature_dispatch_starts s ON s.academy_id=d.academy_id AND s.id=d.start_id
  JOIN public.signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id
  JOIN public.signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id
  JOIN public.agreement_packages p ON p.academy_id=r.academy_id AND p.id=r.package_id
  WHERE p.connection_id=p_connection)
 OR EXISTS(SELECT 1 FROM work d
  JOIN public.work_signature_dispatch_starts s ON s.academy_id=d.academy_id AND s.id=d.start_id
  JOIN public.work_signature_send_attempts a ON a.academy_id=s.academy_id AND a.id=s.attempt_id
  JOIN public.work_signature_send_requests r ON r.academy_id=a.academy_id AND r.id=a.request_id
  JOIN public.work_agreement_preparations w ON w.academy_id=r.academy_id AND w.id=r.preparation_id
  WHERE w.source_snapshot#>>'{connection,id}'=p_connection::text)
$$;
REVOKE ALL ON FUNCTION public.signature_callback_document_bound(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.signature_callback_document_bound(uuid,uuid,uuid) TO kavosh_signature_policy;
-- Keep the existing broker OID, owner, ACL, timestamp and rate-limit guards.
-- Discard before inbox/outbox/conflict persistence, but charge the bounded
-- connection counter. Early callbacks before a receipt are also discarded;
-- completion must reconcile the provider after the receipt, never trust that
-- a callback was retained (or use a callback alone to clear admission).
DO $$ DECLARE d text;needle text:=' IF budget IS NULL THEN RAISE EXCEPTION ''SIGNATURE_RATE_LIMIT'' USING ERRCODE=''P0001''; END IF;';BEGIN
 d=pg_get_functiondef('public.receive_signature_event(uuid,text,uuid,bigint,bigint,text,uuid,text,text,uuid,text,text,integer)'::regprocedure);
 IF position(needle IN d)=0 THEN RAISE EXCEPTION 'SIGNATURE_INTAKE_DEFINITION_CHANGED';END IF;
 d=replace(d,needle,needle||E'\n IF c.bound_documents_only AND (p_object IS DISTINCT FROM ''document'' OR public.signature_callback_document_bound(c.academy_id,c.id,p_resource) IS NOT TRUE) THEN RETURN ''ignored'';END IF;');
 EXECUTE d;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 389 $$;
