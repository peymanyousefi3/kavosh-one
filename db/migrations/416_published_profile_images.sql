-- Only exact reviewed,current,fully prepared derivatives can enter delivery.
-- Private original identifiers/keys never belong in the public JSON manifest.
-- This internal source contains only the selected derivative,not the original;
-- HTTP serializers must remove its private delivery descriptor before JSON.
CREATE FUNCTION public.published_profile_images(p_public uuid,p_audience text,p_version integer DEFAULT NULL,p_number integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tenant uuid:=nullif(current_setting('app.academy_id',true),'')::uuid;r record;s jsonb;images jsonb;BEGIN
 IF tenant IS NULL OR p_public IS NULL OR p_audience IS NULL OR p_audience NOT IN('public','members') OR(p_version IS NULL) IS DISTINCT FROM(p_number IS NULL) OR p_version<1 OR p_number NOT BETWEEN 1 AND 100 THEN RETURN NULL;END IF;
 -- In particular,members-only consent/source eligibility can NEVER imply
 -- public sharing. Public requests independently run the public-purpose gate.
 IF public.published_profile_projection(p_public,p_audience) IS NULL THEN RETURN NULL;END IF;
 SELECT x.* INTO r FROM public.profile_image_releases x JOIN public.profile_publication_heads h ON h.academy_id=x.academy_id AND h.profile_id=x.profile_id WHERE x.academy_id=tenant AND h.public_id=p_public ORDER BY x.version DESC LIMIT 1;
 IF r.version IS NULL OR r.state<>'published' OR(p_version IS NOT NULL AND p_version<>r.version) OR NOT public.profile_image_prepared(r.profile_id,r.version) THEN RETURN NULL;END IF;
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests a WHERE a.academy_id=tenant AND a.id=r.approval_id AND a.status='applied' AND a.action='profile-images.publish' AND a.target_id=r.profile_id AND a.target_version=r.version-1 AND a.reviewer_id=r.changed_by) THEN RETURN NULL;END IF;
 s=public.profile_image_source(r.profile_id,r.state,r.selection);IF s IS NULL OR s IS DISTINCT FROM r.source THEN RETURN NULL;END IF;
 SELECT jsonb_agg(jsonb_build_object('number',x.n,'purpose',x.choice->'kind','alt',x.choice->'alt','mime',j.receipt->'mime','width',j.receipt->'width','height',j.receipt->'height',
 'delivery',jsonb_build_object('academyId',tenant,'objectId',j.receipt->'objectId','storageTargetId',j.receipt->'storageTargetId','etag',j.receipt->'etag','bytes',j.receipt->'bytes','sha256',j.receipt->'sha256')) ORDER BY x.n) INTO images
 FROM jsonb_array_elements(r.selection) WITH ORDINALITY x(choice,n) JOIN public.profile_image_jobs j ON j.academy_id=tenant AND j.profile_id=r.profile_id AND j.release_version=r.version AND j.image_no=x.n AND j.state='retained' WHERE p_number IS NULL OR x.n=p_number;
 IF images IS NULL OR jsonb_array_length(images)=0 THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('id',p_public,'releaseVersion',r.version,'images',images,'mediaIncluded',true,'originalsIncluded',false);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_signature_evidence_policy;
ALTER FUNCTION public.published_profile_images(uuid,text,integer,integer) OWNER TO kavosh_signature_evidence_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_signature_evidence_policy;
REVOKE ALL ON FUNCTION public.published_profile_images(uuid,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.published_profile_images(uuid,text,integer,integer) TO kavosh_runtime,kavosh_public_profile_policy;

CREATE FUNCTION public.read_published_profile_images(p_public uuid,p_budget text,p_version integer DEFAULT NULL,p_number integer DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE gate jsonb;school uuid;previous_tenant text;data jsonb;BEGIN
 IF(p_version IS NULL) IS DISTINCT FROM(p_number IS NULL) OR p_version<1 OR p_number NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_PUBLIC_IMAGE_SELECTION' USING ERRCODE='22023';END IF;
 -- Share the existing persistent IP budget and ordinary profile gate. No
 -- unmetered public source entrypoint or anonymous student directory is added.
 gate=public.read_published_organization_profile(p_public,p_budget);IF gate->'limited' IS DISTINCT FROM 'false'::jsonb OR gate->'data' IS NULL OR gate->'data'='null'::jsonb THEN RETURN gate;END IF;
 SELECT academy_id INTO school FROM public.profile_publication_heads WHERE public_id=p_public;IF school IS NULL THEN RETURN jsonb_build_object('limited',false,'data',NULL);END IF;
 previous_tenant=current_setting('app.academy_id',true);PERFORM set_config('app.academy_id',school::text,true);data=public.published_profile_images(p_public,'public',p_version,p_number);PERFORM set_config('app.academy_id',coalesce(previous_tenant,''),true);
 RETURN jsonb_build_object('limited',false,'data',data);
END $$;
GRANT CREATE ON SCHEMA public TO kavosh_public_profile_policy;
ALTER FUNCTION public.read_published_profile_images(uuid,text,integer,integer) OWNER TO kavosh_public_profile_policy;
REVOKE CREATE ON SCHEMA public FROM kavosh_public_profile_policy;
REVOKE ALL ON FUNCTION public.read_published_profile_images(uuid,text,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_published_profile_images(uuid,text,integer,integer) TO kavosh_public_profile_service;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 416 $$;
