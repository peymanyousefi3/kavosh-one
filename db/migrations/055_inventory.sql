INSERT INTO public.capability_catalog(name,label,workspace,sensitive,scope_kinds) VALUES
 ('inventory.view','View stock, purchase-cost management values and movements','Academy',true,ARRAY['hub','country','region','city']),
 ('inventory.edit','Request stock receipts, movements and catalogue changes','Academy',true,ARRAY['hub','country','region','city']);
CREATE TABLE public.inventory_catalogue(
 academy_id uuid NOT NULL,id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('item','location')),hub_id uuid,code text NOT NULL CHECK(code~'^[A-Z0-9][A-Z0-9._-]{0,63}$'),version integer NOT NULL DEFAULT 1 CHECK(version>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(academy_id,id),UNIQUE NULLS NOT DISTINCT(academy_id,kind,hub_id,code),FOREIGN KEY(academy_id,hub_id) REFERENCES public.hubs(academy_id,id)
);
CREATE TABLE public.inventory_catalogue_revisions(
 academy_id uuid NOT NULL,entry_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object' AND jsonb_typeof(definition->'name')='string' AND length(definition->>'name') BETWEEN 1 AND 200 AND jsonb_typeof(definition->'active')='boolean'),
 changed_by uuid NOT NULL,approval_id uuid NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,entry_id,version),CHECK(definition ?& ARRAY['name','active']),
 FOREIGN KEY(academy_id,entry_id) REFERENCES public.inventory_catalogue(academy_id,id),FOREIGN KEY(academy_id,changed_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id)
);
CREATE FUNCTION public.inventory_catalogue_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE c record;p record;BEGIN
 SELECT * INTO c FROM public.inventory_catalogue WHERE academy_id=NEW.academy_id AND id=NEW.entry_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF c.id IS NULL OR c.version<>NEW.version OR NEW.version<>(SELECT count(*)+1 FROM public.inventory_catalogue_revisions WHERE academy_id=NEW.academy_id AND entry_id=NEW.entry_id)
 OR p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM ('inventory.'||c.kind||(CASE WHEN NEW.version=1 THEN '.create' ELSE '.change' END)) OR p.target_id IS DISTINCT FROM NEW.entry_id OR p.target_version IS DISTINCT FROM NEW.version-1
 OR(p.payload->'definition') IS DISTINCT FROM NEW.definition OR(p.payload->>'reason') IS DISTINCT FROM NEW.reason OR(NEW.version=1 AND((p.payload->>'hubId')::uuid IS DISTINCT FROM c.hub_id OR p.payload->>'code' IS DISTINCT FROM c.code)) THEN RAISE EXCEPTION 'INVENTORY_EXACT_CATALOGUE_APPROVAL_REQUIRED' USING ERRCODE='23514';END IF;
 IF c.kind='item' AND(NEW.definition->>'tracking' NOT IN('bulk','individual') OR NEW.definition->>'tracking' IS NULL) THEN RAISE EXCEPTION 'INVENTORY_TRACKING_REQUIRED' USING ERRCODE='23514';END IF;
 IF c.kind='location' AND NEW.definition->>'custodianId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=(NEW.definition->>'custodianId')::uuid AND kind='human') THEN RAISE EXCEPTION 'INVENTORY_CUSTODIAN_INVALID' USING ERRCODE='23514';END IF;
 IF NEW.definition#>>'{photo,id}' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.file_records f WHERE f.academy_id=NEW.academy_id AND f.id=(NEW.definition#>>'{photo,id}')::uuid AND f.version=(NEW.definition#>>'{photo,version}')::integer AND f.domain='general' AND f.claimed_mime_type LIKE 'image/%' AND NOT f.archived) THEN RAISE EXCEPTION 'INVENTORY_PHOTO_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.changed_by AND kind='human') THEN RAISE EXCEPTION 'INVENTORY_HUMAN_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER inventory_catalogue_revision_guard BEFORE INSERT ON public.inventory_catalogue_revisions FOR EACH ROW EXECUTE FUNCTION public.inventory_catalogue_guard();
CREATE FUNCTION public.inventory_version_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'INVENTORY_VERSION_INVALID' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER inventory_catalogue_version BEFORE UPDATE ON public.inventory_catalogue FOR EACH ROW EXECUTE FUNCTION public.inventory_version_guard();
ALTER TABLE public.inventory_catalogue ADD CONSTRAINT inventory_current_revision FOREIGN KEY(academy_id,id,version) REFERENCES public.inventory_catalogue_revisions(academy_id,entry_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE public.inventory_lots(
 academy_id uuid NOT NULL,id uuid NOT NULL,item_id uuid NOT NULL,item_version integer NOT NULL,bill_id uuid NOT NULL,bill_line integer NOT NULL,
 quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 1000000000),cost_minor numeric NOT NULL CHECK(cost_minor=trunc(cost_minor) AND cost_minor BETWEEN 0 AND 1e38-1),currency_id uuid NOT NULL,unit_scale integer NOT NULL CHECK(unit_scale BETWEEN 0 AND 18),
 serial_number text CHECK(length(serial_number) BETWEEN 1 AND 200),purchased_at timestamptz NOT NULL,purchased_by uuid,buyer_kind text NOT NULL DEFAULT 'human' CHECK(buyer_kind='human'),received_at timestamptz NOT NULL,approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),CHECK(purchased_at<=received_at),
 PRIMARY KEY(academy_id,id),
 FOREIGN KEY(academy_id,item_id,item_version) REFERENCES public.inventory_catalogue_revisions(academy_id,entry_id,version),FOREIGN KEY(academy_id,bill_id,bill_line) REFERENCES public.expense_bill_lines(academy_id,bill_id,line_number),FOREIGN KEY(academy_id,currency_id) REFERENCES public.finance_currencies(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),FOREIGN KEY(academy_id,purchased_by,buyer_kind) REFERENCES public.people(academy_id,id,kind)
);
CREATE UNIQUE INDEX inventory_serial ON public.inventory_lots(academy_id,item_id,serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX inventory_bill_source ON public.inventory_lots(academy_id,bill_id,bill_line);
CREATE TABLE public.inventory_movements(
 academy_id uuid NOT NULL,id uuid NOT NULL,lot_id uuid NOT NULL,kind text NOT NULL CHECK(kind IN('receive','transfer','dispose','restore')),quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 1000000000),
 from_location uuid,from_version integer,to_location uuid,to_version integer,occurred_at timestamptz NOT NULL,disposition text CHECK(disposition IN('destroyed','stolen','lost','consumed','sold','returned')),restores_id uuid,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),approval_id uuid NOT NULL,created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(academy_id,id),
 FOREIGN KEY(academy_id,lot_id) REFERENCES public.inventory_lots(academy_id,id),FOREIGN KEY(academy_id,from_location,from_version) REFERENCES public.inventory_catalogue_revisions(academy_id,entry_id,version),FOREIGN KEY(academy_id,to_location,to_version) REFERENCES public.inventory_catalogue_revisions(academy_id,entry_id,version),FOREIGN KEY(academy_id,restores_id) REFERENCES public.inventory_movements(academy_id,id),FOREIGN KEY(academy_id,approval_id) REFERENCES public.approval_requests(academy_id,id),FOREIGN KEY(academy_id,created_by) REFERENCES public.people(academy_id,id),
 CHECK((from_location IS NULL)=(from_version IS NULL) AND(to_location IS NULL)=(to_version IS NULL)),CHECK(from_location IS DISTINCT FROM to_location),
 CHECK((kind='receive' AND from_location IS NULL AND to_location IS NOT NULL AND restores_id IS NULL AND disposition IS NULL) OR(kind='transfer' AND from_location IS NOT NULL AND to_location IS NOT NULL AND restores_id IS NULL AND disposition IS NULL) OR(kind='dispose' AND from_location IS NOT NULL AND to_location IS NULL AND restores_id IS NULL AND disposition IS NOT NULL) OR(kind='restore' AND from_location IS NULL AND to_location IS NOT NULL AND restores_id IS NOT NULL AND disposition IS NULL)),
 CHECK(occurred_at=date_trunc('milliseconds',occurred_at))
);
CREATE UNIQUE INDEX inventory_one_receipt ON public.inventory_movements(academy_id,lot_id) WHERE kind='receive';
CREATE INDEX inventory_movement_lot_time ON public.inventory_movements(academy_id,lot_id,occurred_at,id);
CREATE INDEX inventory_stock_from ON public.inventory_movements(academy_id,from_location,lot_id) WHERE from_location IS NOT NULL;
CREATE INDEX inventory_stock_to ON public.inventory_movements(academy_id,to_location,lot_id) WHERE to_location IS NOT NULL;
CREATE VIEW public.inventory_deltas WITH(security_invoker=true) AS
 SELECT academy_id,lot_id,id,occurred_at,from_location AS location_id,-quantity AS quantity FROM public.inventory_movements WHERE from_location IS NOT NULL
 UNION ALL SELECT academy_id,lot_id,id,occurred_at,to_location,quantity FROM public.inventory_movements WHERE to_location IS NOT NULL;
CREATE FUNCTION public.inventory_available(p_lot uuid,p_location uuid,p_at timestamptz) RETURNS bigint LANGUAGE sql VOLATILE SET search_path=pg_catalog AS $$
 WITH events AS(SELECT occurred_at,sum(quantity) AS delta FROM public.inventory_deltas WHERE lot_id=p_lot AND location_id=p_location GROUP BY occurred_at),levels AS(SELECT occurred_at,sum(delta) OVER(ORDER BY occurred_at) AS balance FROM events)
 SELECT least(coalesce((SELECT sum(delta) FROM events WHERE occurred_at<=p_at),0),coalesce((SELECT min(balance) FROM levels WHERE occurred_at>p_at),0+(SELECT coalesce(sum(delta),0) FROM events WHERE occurred_at<=p_at)))::bigint
$$;
CREATE FUNCTION public.inventory_lot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE b record;l record;i record;p record;used numeric;BEGIN
 SELECT * INTO b FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=NEW.bill_id FOR UPDATE;
 SELECT * INTO l FROM public.expense_bill_lines WHERE academy_id=NEW.academy_id AND bill_id=NEW.bill_id AND line_number=NEW.bill_line;
 SELECT c.kind,c.version,r.definition INTO i FROM public.inventory_catalogue c JOIN public.inventory_catalogue_revisions r ON r.academy_id=c.academy_id AND r.entry_id=c.id AND r.version=c.version WHERE c.academy_id=NEW.academy_id AND c.id=NEW.item_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 SELECT coalesce(sum(cost_minor),0) INTO used FROM public.inventory_lots WHERE academy_id=NEW.academy_id AND bill_id=NEW.bill_id AND bill_line=NEW.bill_line;
 IF b.id IS NULL OR b.void_id IS NOT NULL OR l.bill_id IS NULL OR NEW.currency_id<>b.currency_id OR NEW.unit_scale<>b.unit_scale OR NEW.cost_minor+used>l.gross_minor-l.recoverable_minor THEN RAISE EXCEPTION 'INVENTORY_PURCHASE_COST_EXCEEDED' USING ERRCODE='23514';END IF;
 IF i.kind IS DISTINCT FROM 'item' OR i.version IS DISTINCT FROM NEW.item_version OR i.definition->'active' IS DISTINCT FROM 'true'::jsonb OR(i.definition->>'tracking'='individual' AND(NEW.quantity<>1 OR NEW.serial_number IS NULL)) OR(i.definition->>'tracking'='bulk' AND NEW.serial_number IS NOT NULL) THEN RAISE EXCEPTION 'INVENTORY_ITEM_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 IF(p.payload->>'purchasedAt')::timestamptz IS DISTINCT FROM NEW.purchased_at OR(p.payload->>'purchasedById')::uuid IS DISTINCT FROM NEW.purchased_by THEN RAISE EXCEPTION 'INVENTORY_PURCHASE_IDENTITY_CHANGED' USING ERRCODE='23514';END IF;
 IF p.id IS NULL OR p.action IS DISTINCT FROM 'inventory.receive' OR p.status<>'pending' OR p.target_id IS DISTINCT FROM NEW.id OR(p.payload#>>'{item,id}')::uuid IS DISTINCT FROM NEW.item_id OR(p.payload#>>'{item,version}')::integer IS DISTINCT FROM NEW.item_version OR(p.payload->>'billId')::uuid IS DISTINCT FROM NEW.bill_id OR(p.payload->>'billLine')::integer IS DISTINCT FROM NEW.bill_line OR(p.payload->>'quantity')::bigint IS DISTINCT FROM NEW.quantity OR(p.payload->>'costMinor')::numeric IS DISTINCT FROM NEW.cost_minor OR(p.payload->>'serialNumber') IS DISTINCT FROM NEW.serial_number OR(p.payload->>'occurredAt')::timestamptz IS DISTINCT FROM NEW.received_at THEN RAISE EXCEPTION 'INVENTORY_EXACT_RECEIPT_REQUIRED' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER inventory_lot_source BEFORE INSERT ON public.inventory_lots FOR EACH ROW EXECUTE FUNCTION public.inventory_lot_guard();
CREATE FUNCTION public.lock_inventory_lot(p_lot uuid) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ BEGIN
 -- Shared source locks permit unrelated stock moves together but serialize
 -- them against an exclusive bill correction and its reviewed source stamp.
 PERFORM b.id FROM public.expense_bills b JOIN public.inventory_lots l ON l.academy_id=b.academy_id AND l.bill_id=b.id WHERE l.id=p_lot FOR SHARE OF b;
 PERFORM pg_advisory_xact_lock(hashtextextended('inventory:'||current_setting('app.academy_id')||':'||p_lot::text,11));
END $$;
CREATE FUNCTION public.inventory_movement_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE l record;c record;p record;r record;BEGIN
 -- A per-lot advisory gate keeps purchase lots strictly immutable: row locks
 -- would require granting UPDATE on an otherwise append-only source table.
 PERFORM public.lock_inventory_lot(NEW.lot_id);
 SELECT * INTO l FROM public.inventory_lots WHERE academy_id=NEW.academy_id AND id=NEW.lot_id;
 SELECT * INTO p FROM public.approval_requests WHERE academy_id=NEW.academy_id AND id=NEW.approval_id;
 IF l.id IS NULL OR NEW.occurred_at<l.received_at OR NEW.occurred_at>clock_timestamp() OR NOT EXISTS(SELECT 1 FROM public.people WHERE academy_id=NEW.academy_id AND id=NEW.created_by AND kind='human') THEN RAISE EXCEPTION 'INVENTORY_EVENT_SOURCE_INVALID' USING ERRCODE='23514';END IF;
 IF(SELECT count(*) FROM public.inventory_catalogue x JOIN public.inventory_catalogue_revisions v ON v.academy_id=x.academy_id AND v.entry_id=x.id AND v.version=x.version WHERE x.academy_id=NEW.academy_id AND x.id IN(NEW.from_location,NEW.to_location))<>(CASE WHEN NEW.from_location IS NULL THEN 0 ELSE 1 END)+(CASE WHEN NEW.to_location IS NULL THEN 0 ELSE 1 END) THEN RAISE EXCEPTION 'INVENTORY_LOCATION_CHANGED' USING ERRCODE='23514';END IF;
 FOR c IN SELECT x.id,x.kind,x.version,v.definition FROM public.inventory_catalogue x JOIN public.inventory_catalogue_revisions v ON v.academy_id=x.academy_id AND v.entry_id=x.id AND v.version=x.version WHERE x.academy_id=NEW.academy_id AND x.id IN(NEW.from_location,NEW.to_location) LOOP
  IF c.kind<>'location' OR c.version IS DISTINCT FROM (CASE WHEN c.id=NEW.from_location THEN NEW.from_version ELSE NEW.to_version END) OR(c.id=NEW.to_location AND c.definition->'active' IS DISTINCT FROM 'true'::jsonb) THEN RAISE EXCEPTION 'INVENTORY_LOCATION_CHANGED' USING ERRCODE='23514';END IF;
 END LOOP;
 IF p.id IS NULL OR p.status<>'pending' OR p.action IS DISTINCT FROM 'inventory.'||NEW.kind OR p.target_id IS DISTINCT FROM NEW.id OR(p.payload->>'quantity')::bigint IS DISTINCT FROM NEW.quantity OR(p.payload->>'occurredAt')::timestamptz IS DISTINCT FROM NEW.occurred_at OR(p.payload#>>'{from,version}')::integer IS DISTINCT FROM NEW.from_version OR(p.payload#>>'{to,version}')::integer IS DISTINCT FROM NEW.to_version OR p.payload->>'reason' IS DISTINCT FROM NEW.reason THEN RAISE EXCEPTION 'INVENTORY_EXACT_MOVEMENT_REQUIRED' USING ERRCODE='23514';END IF;
 IF NEW.kind='receive' THEN
  IF NEW.id<>NEW.lot_id OR NEW.quantity<>l.quantity OR NEW.occurred_at<>l.received_at OR NEW.approval_id<>l.approval_id OR(p.payload#>>'{to,id}')::uuid IS DISTINCT FROM NEW.to_location THEN RAISE EXCEPTION 'INVENTORY_INITIAL_RECEIPT_REQUIRED' USING ERRCODE='23514';END IF;
 ELSE IF(p.payload->>'lotId')::uuid IS DISTINCT FROM NEW.lot_id OR(p.payload#>>'{from,id}')::uuid IS DISTINCT FROM NEW.from_location OR(p.payload#>>'{to,id}')::uuid IS DISTINCT FROM NEW.to_location OR(p.payload->>'disposition') IS DISTINCT FROM NEW.disposition OR(p.payload->>'restoresId')::uuid IS DISTINCT FROM NEW.restores_id THEN RAISE EXCEPTION 'INVENTORY_EXACT_MOVEMENT_REQUIRED' USING ERRCODE='23514';END IF;END IF;
 IF NEW.kind='restore' THEN SELECT * INTO r FROM public.inventory_movements WHERE academy_id=NEW.academy_id AND id=NEW.restores_id;
  IF r.kind IS DISTINCT FROM 'dispose' OR r.lot_id IS DISTINCT FROM NEW.lot_id OR NEW.occurred_at<r.occurred_at OR NEW.quantity+coalesce((SELECT sum(quantity) FROM public.inventory_movements WHERE academy_id=NEW.academy_id AND restores_id=r.id),0)>r.quantity THEN RAISE EXCEPTION 'INVENTORY_RESTORE_EXCEEDED' USING ERRCODE='23514';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER inventory_movement_source BEFORE INSERT ON public.inventory_movements FOR EACH ROW EXECUTE FUNCTION public.inventory_movement_guard();
CREATE FUNCTION public.inventory_quantity_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM(SELECT sum(sum(quantity)) OVER(PARTITION BY location_id ORDER BY occurred_at) AS quantity FROM public.inventory_deltas WHERE academy_id=NEW.academy_id AND lot_id=NEW.lot_id GROUP BY location_id,occurred_at) q WHERE quantity<0) THEN RAISE EXCEPTION 'INVENTORY_QUANTITY_UNAVAILABLE' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER inventory_nonnegative AFTER INSERT ON public.inventory_movements FOR EACH ROW EXECUTE FUNCTION public.inventory_quantity_guard();
CREATE FUNCTION public.inventory_lot_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.inventory_movements m WHERE m.academy_id=NEW.academy_id AND m.id=NEW.id AND m.kind='receive') THEN RAISE EXCEPTION 'INVENTORY_RECEIPT_MISSING' USING ERRCODE='23514';END IF;RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER inventory_receipt_required AFTER INSERT ON public.inventory_lots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.inventory_lot_complete();
CREATE FUNCTION public.inventory_bill_correction_gate() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 PERFORM 1 FROM public.expense_bills WHERE academy_id=NEW.academy_id AND id=NEW.bill_id FOR UPDATE;
 RETURN NEW;
END $$;
CREATE TRIGGER inventory_expense_correction_gate BEFORE INSERT ON public.expense_bill_voids FOR EACH ROW EXECUTE FUNCTION public.inventory_bill_correction_gate();
CREATE FUNCTION public.inventory_approval_complete() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.approval_requests p WHERE p.academy_id=NEW.academy_id AND p.id=NEW.approval_id AND p.status='applied' AND p.reviewer_id=coalesce((to_jsonb(NEW)->>'created_by')::uuid,(to_jsonb(NEW)->>'changed_by')::uuid)) THEN RAISE EXCEPTION 'INVENTORY_APPROVAL_NOT_APPLIED' USING ERRCODE='23514';END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER inventory_catalogue_applied AFTER INSERT ON public.inventory_catalogue_revisions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.inventory_approval_complete();
CREATE CONSTRAINT TRIGGER inventory_movement_applied AFTER INSERT ON public.inventory_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.inventory_approval_complete();
CREATE CONSTRAINT TRIGGER inventory_lot_applied AFTER INSERT ON public.inventory_lots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.inventory_approval_complete();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['inventory_catalogue','inventory_catalogue_revisions','inventory_lots','inventory_movements'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY tenant_boundary ON public.%I USING(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid) WITH CHECK(academy_id=nullif(current_setting(''app.academy_id'',true),'''')::uuid)',t);
END LOOP;END $$;
GRANT SELECT ON public.inventory_catalogue,public.inventory_catalogue_revisions,public.inventory_lots,public.inventory_movements,public.inventory_deltas TO kavosh_runtime;
GRANT INSERT(academy_id,id,kind,hub_id,code) ON public.inventory_catalogue TO kavosh_runtime;
GRANT UPDATE(version) ON public.inventory_catalogue TO kavosh_runtime;
GRANT INSERT(academy_id,entry_id,version,definition,changed_by,approval_id,reason) ON public.inventory_catalogue_revisions TO kavosh_runtime;
GRANT INSERT(academy_id,id,item_id,item_version,bill_id,bill_line,quantity,cost_minor,currency_id,unit_scale,serial_number,purchased_at,purchased_by,received_at,approval_id,created_by) ON public.inventory_lots TO kavosh_runtime;
GRANT INSERT(academy_id,id,lot_id,kind,quantity,from_location,from_version,to_location,to_version,occurred_at,disposition,restores_id,reason,approval_id,created_by) ON public.inventory_movements TO kavosh_runtime;
REVOKE ALL ON FUNCTION public.inventory_catalogue_guard(),public.inventory_available(uuid,uuid,timestamptz),public.inventory_lot_guard(),public.inventory_movement_guard(),public.inventory_quantity_guard(),public.inventory_lot_complete(),public.inventory_bill_correction_gate(),public.inventory_version_guard(),public.inventory_approval_complete() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_inventory_lot(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inventory_available(uuid,uuid,timestamptz),public.lock_inventory_lot(uuid) TO kavosh_runtime;
-- Retain source privacy even if an inventory handler is later retired.
ALTER FUNCTION public.build_approval_privacy_bindings(uuid,text,jsonb,jsonb,jsonb,text) RENAME TO build_approval_privacy_before_inventory;
CREATE FUNCTION public.build_approval_privacy_bindings(p_academy uuid,p_action text,p_payload jsonb,p_context jsonb,p_scope jsonb,p_privacy text) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$ DECLARE result jsonb;hubs uuid[];BEGIN
 result=public.build_approval_privacy_before_inventory(p_academy,p_action,p_payload,p_context,p_scope,p_privacy);
 IF p_action='inventory.receive' THEN SELECT array_agg(DISTINCT hub_id) INTO hubs FROM public.expense_bill_lines WHERE academy_id=p_academy AND bill_id=(p_payload->>'billId')::uuid;result=result||jsonb_build_array(public.approval_hub_binding('expenses.view',hubs));END IF;
 IF p_action LIKE 'inventory.%' AND p_payload#>>'{definition,photo,id}' IS NOT NULL THEN result=result||jsonb_build_array(jsonb_build_object('fileId',p_payload#>>'{definition,photo,id}'));END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.build_approval_privacy_bindings(uuid,text,jsonb,jsonb,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.build_approval_privacy_bindings(uuid,text,jsonb,jsonb,jsonb,text) TO kavosh_runtime;
CREATE OR REPLACE FUNCTION public.bind_approval_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN NEW.privacy_bindings=public.build_approval_privacy_bindings(NEW.academy_id,NEW.action,NEW.payload,NEW.review_context,NEW.scope,NEW.privacy_capability);RETURN NEW;END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 55 $$;
