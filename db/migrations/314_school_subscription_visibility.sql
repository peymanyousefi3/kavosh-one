INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('academy-subscription.view','View own academy platform subscription','Administration',true,ARRAY['academy']);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='kavosh_subscription_reader') THEN CREATE ROLE kavosh_subscription_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname='kavosh_subscription_reader' AND(r.rolcanlogin OR r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid))) THEN RAISE EXCEPTION 'UNSAFE_SUBSCRIPTION_READER_ROLE';END IF;
END $$;
GRANT kavosh_subscription_reader TO CURRENT_USER;
GRANT USAGE ON SCHEMA public,platform_private TO kavosh_subscription_reader;
GRANT SELECT(id,status,subscription_version,subscription_terms) ON public.academies TO kavosh_subscription_reader;
GRANT SELECT(plan_id,version,definition) ON platform_private.subscription_plan_editions TO kavosh_subscription_reader;
GRANT SELECT(academy_id) ON platform_private.primary_free_academy TO kavosh_subscription_reader;
GRANT SELECT(id,academy_id,requested_at) ON platform_private.school_cancellation_requests TO kavosh_subscription_reader;
GRANT SELECT(id,academy_id,current_data) ON platform_private.school_cancellation_cases TO kavosh_subscription_reader;
GRANT EXECUTE ON FUNCTION public.subscription_access_state(jsonb),public.effective_academy_status(text,jsonb) TO kavosh_subscription_reader;
CREATE INDEX school_cancellation_recent ON platform_private.school_cancellation_requests(academy_id,requested_at DESC,id DESC);
-- The non-login reader owns only these barriers,not academies. Its underlying
-- academy SELECT is subject to the existing FORCE RLS tenant policy. Runtime
-- gains no private-schema usage,table access,write authority or role membership.
CREATE VIEW public.academy_subscription_status WITH(security_barrier=true) AS
 SELECT a.id AS academy_id,a.subscription_version AS version,a.status AS operational_status,
 public.effective_academy_status(a.status,a.subscription_terms) AS effective_status,
 public.subscription_access_state(a.subscription_terms) AS subscription_state,a.subscription_terms AS terms,
 CASE WHEN p.plan_id IS NULL THEN NULL ELSE jsonb_build_object('id',p.plan_id,'version',p.version,'name',p.definition->>'name','currencyCode',p.definition->>'currencyCode','unitScale',(p.definition->>'unitScale')::integer,'referenceAmountMinor',p.definition->>'amountMinor','periodMonths',(p.definition->>'periodMonths')::integer) END AS plan_reference,
 EXISTS(SELECT 1 FROM platform_private.primary_free_academy f WHERE f.academy_id=a.id) AS permanent_free,
 latest.current_data AS latest_cancellation
 FROM public.academies a LEFT JOIN platform_private.subscription_plan_editions p ON p.plan_id=(a.subscription_terms->>'planId')::uuid AND p.version=(a.subscription_terms->>'planVersion')::integer
 LEFT JOIN LATERAL(SELECT c.current_data FROM platform_private.school_cancellation_requests r JOIN platform_private.school_cancellation_cases c ON c.id=r.id AND c.academy_id=r.academy_id WHERE r.academy_id=a.id ORDER BY r.requested_at DESC,r.id DESC LIMIT 1) latest ON true;
CREATE VIEW public.academy_subscription_cancellations WITH(security_barrier=true) AS
 SELECT a.id AS academy_id,r.id,r.requested_at,c.current_data AS data FROM public.academies a
 JOIN platform_private.school_cancellation_requests r ON r.academy_id=a.id
 JOIN platform_private.school_cancellation_cases c ON c.id=r.id AND c.academy_id=r.academy_id;
GRANT CREATE ON SCHEMA public TO kavosh_subscription_reader;
ALTER VIEW public.academy_subscription_status OWNER TO kavosh_subscription_reader;
ALTER VIEW public.academy_subscription_cancellations OWNER TO kavosh_subscription_reader;
REVOKE CREATE ON SCHEMA public FROM kavosh_subscription_reader;
REVOKE ALL ON public.academy_subscription_status,public.academy_subscription_cancellations FROM PUBLIC;
GRANT SELECT ON public.academy_subscription_status,public.academy_subscription_cancellations TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 314 $$;
