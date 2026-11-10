-- Family features use the same original class/student record scope as their
-- authoring modules. No new role,credential,assignment or family entitlement.
UPDATE public.capability_catalog SET scope_kinds=scope_kinds||ARRAY['class']::text[]
WHERE name=ANY(ARRAY['received-reports.view','received-homework.view','received-submissions.view','received-submissions.drafts','received-grades.view','received-solutions.view','received-comments.view','received-comments.write','received-polls.view','received-polls.respond','homework-submissions.submit']) AND NOT('class'=ANY(scope_kinds));
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 356 $$;
