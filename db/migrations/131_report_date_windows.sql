CREATE FUNCTION public.report_preset_static_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$ DECLARE k text;x record;BEGIN
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR NOT(d ?& ARRAY['name','translations','reportId','queryContractVersion','parameters','pathParameters','active']) OR d-ARRAY['name','translations','reportId','queryContractVersion','parameters','pathParameters','active']<>'{}'::jsonb OR octet_length(d::text)>65536
 OR jsonb_typeof(d->'name') IS DISTINCT FROM 'string' OR length(btrim(d->>'name')) NOT BETWEEN 1 AND 200 OR d->'queryContractVersion' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(d->'active') IS DISTINCT FROM 'boolean'
 OR d->>'reportId' IS NULL OR d->>'reportId' NOT IN('finance.trial-balance','finance.profit-loss','finance.balance-sheet','finance.outlook','finance.receivables-aging','finance.payables-aging','finance.bank-reconciliation','inventory.stock','payroll.scheduled-costs','payroll.recorded-time','payroll.gross-accruals','learning.polls.by-id','learning.sessions.by-id.evidence')
 OR jsonb_typeof(d->'translations') IS DISTINCT FROM 'object' OR(d->'translations')-ARRAY['en','fr','zh-CN']<>'{}'::jsonb THEN RETURN false;END IF;
 FOR x IN SELECT * FROM jsonb_each(d->'translations') LOOP IF jsonb_typeof(x.value) IS DISTINCT FROM 'string' OR length(btrim(x.value#>>'{}')) NOT BETWEEN 1 AND 200 THEN RETURN false;END IF;END LOOP;
 FOREACH k IN ARRAY ARRAY['parameters','pathParameters'] LOOP IF jsonb_typeof(d->k) IS DISTINCT FROM 'object' OR(SELECT count(*) FROM jsonb_each(d->k))>48 THEN RETURN false;END IF;
 FOR x IN SELECT * FROM jsonb_each(d->k) LOOP IF x.key!~'^[A-Za-z][A-Za-z0-9]{0,63}$' OR x.key IN('constructor','prototype','__proto__') OR jsonb_typeof(x.value) IS DISTINCT FROM 'string' OR length(x.value#>>'{}')>8000 OR(k='parameters' AND x.key~*'^(after|statementAfter|ledgerAfter|snapshot$)') OR(k='pathParameters' AND(x.key<>'id' OR(x.value#>>'{}')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')) THEN RETURN false;END IF;END LOOP;END LOOP;
 RETURN(d->'pathParameters' ? 'id')=(d->>'reportId' IN('learning.polls.by-id','learning.sessions.by-id.evidence'));
END $$;
-- Preserve the original validator's function identity and all retained rows.
-- Native approval/history guards keep calling the upgraded public validator.
CREATE OR REPLACE FUNCTION public.report_preset_definition_valid(d jsonb) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE w jsonb;fields text[];BEGIN
 IF NOT coalesce(d?'dateWindow',false) THEN RETURN public.report_preset_static_definition_valid(d);END IF;
 IF NOT public.report_preset_static_definition_valid(d-'dateWindow') OR octet_length(d::text)>65536 THEN RETURN false;END IF;
 w=d->'dateWindow';
 IF jsonb_typeof(w) IS DISTINCT FROM 'object' OR NOT(w ?& ARRAY['kind','timeZone','weekStartsOn']) OR w-ARRAY['kind','timeZone','weekStartsOn','days']<>'{}'::jsonb
 OR jsonb_typeof(w->'kind') IS DISTINCT FROM 'string' OR w->>'kind' NOT IN('today','yesterday','week_to_date','previous_week','month_to_date','previous_month','quarter_to_date','previous_quarter','year_to_date','previous_year','last_days','next_days')
 OR jsonb_typeof(w->'timeZone') IS DISTINCT FROM 'string' OR length(w->>'timeZone') NOT BETWEEN 1 AND 100 OR(w->>'timeZone')~'^[+-]' OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE lower(name)=lower(w->>'timeZone'))
 OR jsonb_typeof(w->'weekStartsOn') IS DISTINCT FROM 'number' OR(w->>'weekStartsOn')!~'^[1-7]$'
 OR((w->>'kind' IN('last_days','next_days')) IS DISTINCT FROM(w?'days')) THEN RETURN false;END IF;
 IF w?'days' THEN IF jsonb_typeof(w->'days') IS DISTINCT FROM 'number' OR(w->>'days')!~'^[0-9]{1,4}$' THEN RETURN false;END IF;IF(w->>'days')::integer NOT BETWEEN 1 AND 3660 THEN RETURN false;END IF;END IF;
 fields=CASE d->>'reportId' WHEN 'finance.trial-balance' THEN ARRAY['through'] WHEN 'finance.balance-sheet' THEN ARRAY['through']
 WHEN 'finance.profit-loss' THEN ARRAY['from','through'] WHEN 'finance.bank-reconciliation' THEN ARRAY['from','through']
 WHEN 'finance.outlook' THEN ARRAY['on','through','timeZone'] WHEN 'finance.receivables-aging' THEN ARRAY['on'] WHEN 'finance.payables-aging' THEN ARRAY['on'] WHEN 'payroll.gross-accruals' THEN ARRAY['on']
 WHEN 'inventory.stock' THEN ARRAY['on','timeZone'] WHEN 'payroll.scheduled-costs' THEN ARRAY['from','through','timeZone'] WHEN 'payroll.recorded-time' THEN ARRAY['from','through','timeZone'] END;
 IF fields IS NULL OR(d->'parameters') ?| fields THEN RETURN false;END IF;
 IF d->>'reportId'='finance.outlook' AND(w->>'kind' IN('today','yesterday','week_to_date','month_to_date','quarter_to_date','year_to_date') OR coalesce((w->>'days')::integer,2) NOT BETWEEN 2 AND 367) THEN RETURN false;END IF;RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.report_preset_static_definition_valid(jsonb),public.report_preset_definition_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.report_preset_static_definition_valid(jsonb),public.report_preset_definition_valid(jsonb) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 131 $$;
