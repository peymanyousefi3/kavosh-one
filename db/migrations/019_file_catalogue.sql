CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('files.view','Browse permitted private file metadata','Files',true,ARRAY['hub','class','person','country','region','city']),
 ('files.edit','Reserve and maintain permitted private file metadata','Files',true,ARRAY['hub','class','person','country','region','city']);
CREATE TABLE public.file_records (
 academy_id uuid NOT NULL REFERENCES public.academies(id),id uuid NOT NULL,
 anchor_kind text NOT NULL CHECK(anchor_kind IN ('academy','hub','class','person')),hub_id uuid,class_id uuid,person_id uuid,
 person_kind text NOT NULL DEFAULT 'human' CHECK(person_kind='human'),
 domain text NOT NULL CHECK(domain IN ('general','student_private','guardian_private','agreement_definition')),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 200),description text NOT NULL DEFAULT '' CHECK(length(description)<=2000),
 tags text[] NOT NULL DEFAULT '{}' CHECK(cardinality(tags)<=20),
 claimed_mime_type text NOT NULL CHECK(length(claimed_mime_type)<=201),expected_bytes bigint NOT NULL CHECK(expected_bytes BETWEEN 1 AND 4294967296),
 expected_sha256 text CHECK(expected_sha256 ~ '^[a-f0-9]{64}$'),archived boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 search_text text NOT NULL CHECK(length(search_text)<=4000),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,id),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id),
 FOREIGN KEY(academy_id,class_id,hub_id) REFERENCES public.classes(academy_id,id,hub_id),
 FOREIGN KEY(academy_id,person_id,person_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),
 CHECK((anchor_kind='academy' AND hub_id IS NULL AND class_id IS NULL AND person_id IS NULL)
  OR (anchor_kind='hub' AND hub_id IS NOT NULL AND class_id IS NULL AND person_id IS NULL)
  OR (anchor_kind='class' AND hub_id IS NOT NULL AND class_id IS NOT NULL AND person_id IS NULL)
  OR (anchor_kind='person' AND hub_id IS NULL AND class_id IS NULL AND person_id IS NOT NULL)),
 CHECK(domain='general' OR (domain IN ('student_private','guardian_private') AND anchor_kind='person') OR (domain='agreement_definition' AND anchor_kind IN ('academy','hub')))
);
CREATE INDEX file_records_hub ON public.file_records(academy_id,hub_id,id);
CREATE INDEX file_records_class ON public.file_records(academy_id,class_id,id);
CREATE INDEX file_records_person ON public.file_records(academy_id,person_id,id);
CREATE INDEX file_records_search ON public.file_records USING gin(lower(search_text) public.gin_trgm_ops);
CREATE TABLE public.file_record_revisions (
 academy_id uuid NOT NULL,file_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 changed_by uuid NOT NULL,reason text NOT NULL CHECK(length(reason)<=2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,file_id,version),FOREIGN KEY(academy_id,file_id) REFERENCES public.file_records(academy_id,id),
 FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id)
);
ALTER TABLE public.file_records ADD CONSTRAINT current_file_record_revision
 FOREIGN KEY(academy_id,id,version) REFERENCES public.file_record_revisions(academy_id,file_id,version) DEFERRABLE INITIALLY DEFERRED;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['file_records','file_record_revisions'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
-- A person-bound file follows the person's current hub, never an obsolete hub
-- snapshot. Domain and file scopes are enforced together by the service query.
CREATE VIEW public.file_catalogue WITH(security_invoker=true) AS
 SELECT f.*,CASE WHEN f.anchor_kind='person' THEN p.hub_id ELSE f.hub_id END AS effective_hub_id
 FROM public.file_records f LEFT JOIN public.people p ON p.academy_id=f.academy_id AND p.id=f.person_id;
GRANT SELECT ON public.file_records,public.file_record_revisions,public.file_catalogue TO kavosh_runtime;
GRANT INSERT ON public.file_records,public.file_record_revisions TO kavosh_runtime;
GRANT UPDATE(name,description,tags,archived,version,search_text) ON public.file_records TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 19 $$;
