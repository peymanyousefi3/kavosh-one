INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('allocations.view','View permitted tuition installment allocations','Finance',true,ARRAY['hub','class','person','country','region','city']),
 ('allocations.edit','Request reviewed tuition installment allocations','Finance',true,ARRAY['hub','class','person','country','region','city']);
CREATE TABLE public.receipt_allocation_plans(
 academy_id uuid NOT NULL,receipt_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(academy_id,receipt_id),FOREIGN KEY(academy_id,receipt_id) REFERENCES public.tuition_receipts(academy_id,id)
);
CREATE TABLE public.receipt_allocation_revisions(
 academy_id uuid NOT NULL,receipt_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),plan_id uuid NOT NULL,plan_version integer NOT NULL,
 mode text NOT NULL CHECK(mode IN ('manual','oldest_due')),total_minor numeric NOT NULL CHECK(total_minor=trunc(total_minor) AND total_minor>=0 AND total_minor<1e38),line_count integer NOT NULL CHECK(line_count BETWEEN 0 AND 1000),
 changed_by uuid NOT NULL,changed_kind text NOT NULL DEFAULT 'human' CHECK(changed_kind='human'),approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(academy_id,receipt_id,version),UNIQUE(academy_id,receipt_id,version,plan_id,plan_version),
 FOREIGN KEY(academy_id,receipt_id) REFERENCES public.receipt_allocation_plans(academy_id,receipt_id),FOREIGN KEY(academy_id,plan_id,plan_version) REFERENCES public.tuition_plan_revisions(academy_id,plan_id,version),
 FOREIGN KEY(academy_id,changed_by,changed_kind) REFERENCES public.people(academy_id,id,kind),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE TABLE public.receipt_allocation_lines(
 academy_id uuid NOT NULL,receipt_id uuid NOT NULL,version integer NOT NULL,plan_id uuid NOT NULL,plan_version integer NOT NULL,installment integer NOT NULL,
 amount_minor numeric NOT NULL CHECK(amount_minor=trunc(amount_minor) AND amount_minor>0 AND amount_minor<1e38),PRIMARY KEY(academy_id,receipt_id,version,installment),
 FOREIGN KEY(academy_id,receipt_id,version,plan_id,plan_version) REFERENCES public.receipt_allocation_revisions(academy_id,receipt_id,version,plan_id,plan_version),
 FOREIGN KEY(academy_id,plan_id,plan_version,installment) REFERENCES public.tuition_installments(academy_id,plan_id,version,ordinal)
);
ALTER TABLE public.receipt_allocation_plans ADD CONSTRAINT receipt_allocation_current FOREIGN KEY(academy_id,receipt_id,version) REFERENCES public.receipt_allocation_revisions(academy_id,receipt_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX allocation_installment ON public.receipt_allocation_lines(academy_id,plan_id,plan_version,installment,receipt_id,version);
DO $$ DECLARE t text;BEGIN
 FOREACH t IN ARRAY ARRAY['receipt_allocation_plans','receipt_allocation_revisions','receipt_allocation_lines'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
  EXECUTE format('CREATE TRIGGER finance_book_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.guard_finance_book_write()',t);
 END LOOP;
END $$;
CREATE TRIGGER allocation_header_version BEFORE INSERT OR UPDATE ON public.receipt_allocation_plans FOR EACH ROW EXECUTE FUNCTION public.guard_finance_header_version();
CREATE FUNCTION public.guard_allocation_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE i record;r record;BEGIN
 SELECT x.id,x.plan_id,x.plan_version,x.credit_id INTO i FROM public.tuition_invoices x JOIN public.tuition_receipts p ON p.academy_id=x.academy_id AND p.invoice_id=x.id WHERE p.academy_id=NEW.academy_id AND p.id=NEW.receipt_id FOR UPDATE OF x;
 SELECT * INTO r FROM public.tuition_receipts WHERE academy_id=NEW.academy_id AND id=NEW.receipt_id FOR UPDATE;
 IF i.id IS NULL OR i.credit_id IS NOT NULL OR r.reversal_id IS NOT NULL OR NEW.plan_id IS DISTINCT FROM i.plan_id OR NEW.plan_version IS DISTINCT FROM i.plan_version
  OR NOT EXISTS(SELECT 1 FROM public.receipt_allocation_plans h WHERE h.academy_id=NEW.academy_id AND h.receipt_id=NEW.receipt_id AND h.version=NEW.version)
  OR NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.target_id=NEW.receipt_id AND p.target_version=NEW.version-1 AND p.status IN ('pending','applied') AND(
   (p.action='finance.receipt.allocate' AND p.privacy_capability='allocations.edit') OR
   (NEW.version=1 AND NEW.mode='oldest_due' AND p.action='finance.receipt.record' AND p.privacy_capability='receipts.edit' AND p.payload->>'allocation'='oldest_due')
  )) THEN RAISE EXCEPTION 'ALLOCATION_SOURCE_OR_APPROVAL_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER allocation_revision BEFORE INSERT ON public.receipt_allocation_revisions FOR EACH ROW EXECUTE FUNCTION public.guard_allocation_revision();
CREATE FUNCTION public.validate_allocation_complete(p_academy uuid,p_receipt uuid,p_version integer) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE v public.receipt_allocation_revisions%ROWTYPE;r public.tuition_receipts%ROWTYPE;n integer;amount numeric;
BEGIN
 SELECT * INTO v FROM public.receipt_allocation_revisions WHERE academy_id=p_academy AND receipt_id=p_receipt AND version=p_version;
 SELECT * INTO r FROM public.tuition_receipts WHERE academy_id=p_academy AND id=p_receipt;
 SELECT count(*),coalesce(sum(amount_minor),0) INTO n,amount FROM public.receipt_allocation_lines WHERE academy_id=p_academy AND receipt_id=p_receipt AND version=p_version;
 IF v.receipt_id IS NULL OR n<>v.line_count OR amount<>v.total_minor OR amount>r.amount_minor OR NOT EXISTS(SELECT 1 FROM public.receipt_allocation_plans h WHERE h.academy_id=p_academy AND h.receipt_id=p_receipt AND h.version=p_version) THEN RAISE EXCEPTION 'ALLOCATION_TOTAL_INVALID' USING ERRCODE='23514';END IF;
 IF EXISTS(
  WITH other_allocated AS MATERIALIZED(
   SELECT other.installment,sum(other.amount_minor) AS amount FROM public.receipt_allocation_lines other JOIN public.receipt_allocation_plans h ON h.academy_id=other.academy_id AND h.receipt_id=other.receipt_id AND h.version=other.version JOIN public.tuition_receipts p ON p.academy_id=other.academy_id AND p.id=other.receipt_id
   WHERE p.academy_id=p_academy AND p.invoice_id=r.invoice_id AND p.id<>p_receipt AND p.reversal_id IS NULL GROUP BY other.installment)
  SELECT 1 FROM public.receipt_allocation_lines l JOIN public.tuition_installments t ON t.academy_id=l.academy_id AND t.plan_id=l.plan_id AND t.version=l.plan_version AND t.ordinal=l.installment LEFT JOIN other_allocated a ON a.installment=l.installment
  WHERE l.academy_id=p_academy AND l.receipt_id=p_receipt AND l.version=p_version AND l.amount_minor+coalesce(a.amount,0)>t.amount_minor
 ) THEN RAISE EXCEPTION 'INSTALLMENT_OVERALLOCATED' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=p_academy AND p.id=v.approval_id AND p.action='finance.receipt.record') AND EXISTS(
  WITH other_allocated AS MATERIALIZED(
   SELECT l.installment,sum(l.amount_minor) AS amount FROM public.receipt_allocation_lines l JOIN public.receipt_allocation_plans h ON h.academy_id=l.academy_id AND h.receipt_id=l.receipt_id AND h.version=l.version JOIN public.tuition_receipts p ON p.academy_id=h.academy_id AND p.id=h.receipt_id
   WHERE p.academy_id=p_academy AND p.invoice_id=r.invoice_id AND p.id<>p_receipt AND p.reversal_id IS NULL GROUP BY l.installment),
  capacity AS(SELECT t.ordinal,t.due_on,greatest(t.amount_minor-coalesce(a.amount,0),0) AS available FROM public.tuition_installments t LEFT JOIN other_allocated a ON a.installment=t.ordinal WHERE t.academy_id=p_academy AND t.plan_id=v.plan_id AND t.version=v.plan_version),
  ordered AS(SELECT *,coalesce(sum(available) OVER(ORDER BY due_on,ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS preceding FROM capacity),
  wanted AS(SELECT ordinal,greatest(least(available,r.amount_minor-preceding),0) AS amount FROM ordered),
  actual AS(SELECT installment,amount_minor FROM public.receipt_allocation_lines WHERE academy_id=p_academy AND receipt_id=p_receipt AND version=p_version)
  SELECT 1 FROM wanted w FULL JOIN actual a ON a.installment=w.ordinal WHERE coalesce(w.amount,0) IS DISTINCT FROM coalesce(a.amount_minor,0)
 ) THEN RAISE EXCEPTION 'AUTOMATIC_ALLOCATION_MISMATCH' USING ERRCODE='23514';END IF;
END $$;
CREATE FUNCTION public.check_allocation_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE row_key record;BEGIN
 IF TG_LEVEL='ROW' THEN PERFORM public.validate_allocation_complete(NEW.academy_id,NEW.receipt_id,NEW.version);
 ELSE FOR row_key IN SELECT DISTINCT academy_id,receipt_id,version FROM inserted_allocation_lines LOOP
  PERFORM public.validate_allocation_complete(row_key.academy_id,row_key.receipt_id,row_key.version);
 END LOOP;END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER allocation_revision_complete AFTER INSERT ON public.receipt_allocation_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_allocation_complete();
-- One check per affected revision/batch, not one full aggregate per line.
-- Late appends to historical or already-complete revisions still fail.
CREATE TRIGGER allocation_line_complete AFTER INSERT ON public.receipt_allocation_lines REFERENCING NEW TABLE AS inserted_allocation_lines FOR EACH STATEMENT EXECUTE FUNCTION public.check_allocation_complete();
REVOKE ALL ON FUNCTION public.guard_allocation_revision(),public.check_allocation_complete(),public.validate_allocation_complete(uuid,uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_allocation_complete(uuid,uuid,integer) TO kavosh_runtime;
GRANT SELECT ON public.receipt_allocation_plans,public.receipt_allocation_revisions,public.receipt_allocation_lines TO kavosh_runtime;
GRANT INSERT(academy_id,receipt_id) ON public.receipt_allocation_plans TO kavosh_runtime;
GRANT UPDATE(version) ON public.receipt_allocation_plans TO kavosh_runtime;
GRANT INSERT ON public.receipt_allocation_revisions,public.receipt_allocation_lines TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 46 $$;
