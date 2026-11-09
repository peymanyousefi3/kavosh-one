-- Repeated source boundaries must not exhaust the64-binding ceiling before
-- the advertised200line request can be reviewed. Group equivalent hub scopes;
-- retain EVERY distinct boundary and leave all old approval rows unchanged.
CREATE OR REPLACE FUNCTION public.journal_counterparty_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE tags jsonb;source_id uuid;hubs uuid[];payee_hubs uuid[];shared boolean;missing integer;
BEGIN
 IF NEW.action='finance.journal.post' THEN tags=NEW.payload->'counterpartyLines';IF NOT(NEW.payload ? 'counterpartyLines') THEN RETURN NEW;END IF;
 ELSE
  source_id=(NEW.payload->>'reversesId')::uuid;SELECT jsonb_agg(jsonb_build_object('lineNumber',line_number,'payee',jsonb_build_object('id',payee_id,'version',payee_version),'category',category)) INTO tags FROM public.finance_journal_counterparties WHERE academy_id=NEW.academy_id AND journal_id=source_id;
  IF tags IS NULL THEN RETURN NEW;END IF;
 END IF;
 IF jsonb_typeof(tags) IS DISTINCT FROM 'array' THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 IF jsonb_array_length(tags) NOT BETWEEN 1 AND 200 THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 IF source_id IS NULL THEN SELECT array_agg(DISTINCT a.hub_id) INTO hubs FROM jsonb_array_elements(NEW.payload->'lines') l JOIN public.finance_accounts a ON a.academy_id=NEW.academy_id AND a.id=(l->>'accountId')::uuid;
 ELSE SELECT array_agg(DISTINCT a.hub_id) INTO hubs FROM public.finance_journal_lines l JOIN public.finance_accounts a ON a.academy_id=l.academy_id AND a.id=l.account_id WHERE l.academy_id=NEW.academy_id AND l.journal_id=source_id;END IF;
 IF hubs IS NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('counterparty-balances.view',hubs));
 WITH refs AS(SELECT DISTINCT(t#>>'{payee,id}')::uuid id FROM jsonb_array_elements(tags) t)
 SELECT count(*) FILTER(WHERE p.id IS NULL)::integer,array_agg(DISTINCT p.hub_id) FILTER(WHERE p.hub_id IS NOT NULL),coalesce(bool_or(p.id IS NOT NULL AND p.hub_id IS NULL),false)
 INTO missing,payee_hubs,shared FROM refs r LEFT JOIN public.financial_payees p ON p.academy_id=NEW.academy_id AND p.id=r.id;
 IF missing>0 THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;END IF;
 IF shared THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(jsonb_build_object('capability','payees.view','any',true));END IF;
 IF payee_hubs IS NOT NULL THEN NEW.privacy_bindings=NEW.privacy_bindings||jsonb_build_array(public.approval_hub_binding('payees.view',payee_hubs),public.approval_hub_binding('counterparty-balances.view',payee_hubs));END IF;
 RETURN NEW;
 EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN NEW.privacy_bindings=NEW.privacy_bindings||'[{"unresolved":true}]'::jsonb;RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 271 $$;
