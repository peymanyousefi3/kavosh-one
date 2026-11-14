-- Operational follow-up only: neither the original thirty-day baseline nor
-- a reviewed target is certified here as a statutory deadline.
CREATE FUNCTION public.privacy_reminder_assessment(p_request uuid,p_basis text,p_days integer,p_scopes jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH candidate AS MATERIALIZED(
  SELECT h.*,r.state,reply.version response_version,reply.definition,
   (statement_timestamp() AT TIME ZONE h.time_zone)::date today,
   jsonb_build_object('all',false,'hubs','[]'::jsonb,'people',(SELECT jsonb_agg(jsonb_build_object('id',p.id,'hubId',p.hub_id) ORDER BY p.id) FROM public.people p WHERE p.academy_id=h.academy_id AND(p.id=h.subject_id OR h.origin='self' AND p.id=h.requested_by))) scope
  FROM public.privacy_requests h JOIN public.privacy_request_revisions r ON r.academy_id=h.academy_id AND r.request_id=h.id AND r.version=h.version
  LEFT JOIN LATERAL(SELECT d.version,d.definition FROM public.privacy_request_revisions d WHERE d.academy_id=h.academy_id AND d.request_id=h.id AND d.version<=h.version AND d.definition?'state' ORDER BY d.version DESC LIMIT 1) reply ON true
  WHERE h.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid AND h.id=p_request AND p_basis IN('baseline','target') AND p_days BETWEEN -365 AND 3650
 ),permitted AS MATERIALIZED(
  SELECT *,CASE WHEN p_basis='baseline' THEN baseline_review_on ELSE coalesce((definition->>'targetResponseOn')::date,baseline_review_on) END due_on FROM candidate
  WHERE jsonb_typeof(scope->'people')='array' AND jsonb_array_length(scope->'people')>0 AND(p_scopes IS NULL OR public.scope_contains(p_scopes->'privacy-requests.view',scope) IS TRUE)
 ),evaluated AS MATERIALIZED(
  SELECT *,due_on+p_days reminder_on,state NOT IN('responded','closed','withdrawn') open FROM permitted
 )
 SELECT jsonb_build_object('requestId',id,'version',version,'state',state,'basis',p_basis,'daysFromTarget',p_days,'timeZone',time_zone,'today',today,'baselineReviewOn',baseline_review_on,'targetResponseOn',coalesce((definition->>'targetResponseOn')::date,baseline_review_on),'selectedReviewOn',due_on,'reminderOn',reminder_on,'responseVersion',response_version,'eligible',open AND today=reminder_on,'assessmentState',CASE WHEN NOT open THEN 'final' WHEN today<reminder_on THEN 'not_due' WHEN today>reminder_on THEN 'window_expired' ELSE 'eligible' END,'scope',scope,'legalDeadlineVerified',false,'automaticDisclosurePerformed',false,'automaticDeletionPerformed',false)
 FROM evaluated WHERE extract(year FROM reminder_on) BETWEEN 1900 AND 9999
$$;
REVOKE ALL ON FUNCTION public.privacy_reminder_assessment(uuid,text,integer,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_reminder_assessment(uuid,text,integer,jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 385 $$;
