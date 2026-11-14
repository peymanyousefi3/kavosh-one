-- Match guardian-led preparation without activating or verifying a child login.
-- The unchanged later civil-age check requires a DIFFERENT legal guardian for
-- minors and the SAME active verified student for adults. Disabled parties,
-- guardian authority,profile/contact/content revisions and approvals remain.
-- Preserve the original function OID,owner,ACL and all other source checks.
DO $$ DECLARE body text;needle text:='OR s.id IS NULL OR s.status<>''active'' OR g.id IS NULL OR g.status<>''active''';BEGIN
 body=pg_get_functiondef('public.agreement_package_content_basis(uuid,uuid)'::regprocedure);
 IF position(needle IN body)=0 THEN RAISE EXCEPTION 'PENDING_CHILD_AGREEMENT_SOURCE_UNEXPECTED';END IF;
 EXECUTE replace(body,needle,'OR s.id IS NULL OR s.status NOT IN(''active'',''pending'') OR g.id IS NULL OR g.status<>''active''');
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 203 $$;
