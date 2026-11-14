-- Audited owner-only source inspection. Original purchase cost/quantity and
-- dated movement quantities are not a computed stock balance or asset value.
GRANT SELECT(academy_id,id,kind,hub_id,code,version) ON public.inventory_catalogue TO kavosh_platform_policy;
GRANT SELECT(academy_id,entry_id,version,definition,changed_by,approval_id) ON public.inventory_catalogue_revisions TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,item_id,item_version,bill_id,bill_line,quantity,cost_minor,currency_id,unit_scale,serial_number,purchased_at,purchased_by,received_at,created_by,approval_id) ON public.inventory_lots TO kavosh_platform_policy;
GRANT SELECT(academy_id,id,lot_id,kind,quantity,from_location,from_version,to_location,to_version,occurred_at,disposition,restores_id,created_by,approval_id) ON public.inventory_movements TO kavosh_platform_policy;
DO $$ DECLARE body text;needle text;replacement text;BEGIN
 body=pg_get_functiondef('platform_private.read_academy_directory(uuid,uuid,jsonb)'::regprocedure);
 needle='NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'',''sessions'',''class-staff'',''enrollments'',''roles'',''role-assignments'',''tuition-invoices'',''tuition-receipts'',''payroll-runs'',''payroll-postings'',''payroll-payments'',''expense-bills'',''expense-payments'')';
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'INVENTORY_DIRECTORY_COLLECTION_CHANGED';END IF;
 body=replace(body,needle,'NOT IN(''hubs'',''people'',''courses'',''classes'',''students'',''finance-accounts'',''finance-journals'',''sessions'',''class-staff'',''enrollments'',''roles'',''role-assignments'',''tuition-invoices'',''tuition-receipts'',''payroll-runs'',''payroll-postings'',''payroll-payments'',''expense-bills'',''expense-payments'',''inventory-catalogue'',''inventory-lots'',''inventory-movements'')');
 needle=' IF collection=''expense-bills'' THEN';
 replacement=$branch$
 IF collection='inventory-catalogue' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO data FROM(
   SELECT c.id,c.kind,c.hub_id AS "hubId",c.code,c.version,v.definition->>'name' AS name,(v.definition->>'active')::boolean AS active,
    CASE WHEN c.kind='item' THEN v.definition->>'tracking' END AS tracking,CASE WHEN c.kind='item' THEN v.definition->>'unit' END AS unit,
    CASE WHEN c.kind='item' THEN v.definition#>>'{photo,id}' END AS "photoFileId",CASE WHEN c.kind='item' THEN(v.definition#>>'{photo,version}')::integer END AS "photoVersion",
    CASE WHEN c.kind='location' THEN v.definition->>'description' END AS description,CASE WHEN c.kind='location' THEN v.definition->>'custodianId' END AS "custodianId",v.changed_by AS "changedById",v.approval_id AS "approvalId"
   FROM public.inventory_catalogue c JOIN public.inventory_catalogue_revisions v ON v.academy_id=c.academy_id AND v.entry_id=c.id AND v.version=c.version
   WHERE c.academy_id=school AND(after_id IS NULL OR c.id>after_id) ORDER BY c.id LIMIT page_limit+1
  ) r;
 ELSIF collection='inventory-lots' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO data FROM(
   SELECT l.id,l.item_id AS "itemId",l.item_version AS "itemVersion",i.definition->>'name' AS "recordedItemName",i.definition->>'tracking' AS "recordedTracking",i.definition->>'unit' AS "recordedUnit",
    l.bill_id AS "billId",l.bill_line AS "billLine",b.void_id AS "purchaseBillVoidId",b.void_id IS NOT NULL AS "costBasisReviewRequired",l.quantity::text AS "purchasedQuantity",l.cost_minor::text AS "originalCostMinor",l.currency_id AS "currencyId",l.unit_scale AS "unitScale",
    l.serial_number AS "serialNumber",l.purchased_at::text AS "purchasedAt",l.purchased_by AS "purchasedById",l.received_at::text AS "receivedAt",l.created_by AS "receivedById",l.approval_id AS "approvalId"
   FROM public.inventory_lots l JOIN public.inventory_catalogue_revisions i ON i.academy_id=l.academy_id AND i.entry_id=l.item_id AND i.version=l.item_version JOIN public.expense_bills b ON b.academy_id=l.academy_id AND b.id=l.bill_id
   WHERE l.academy_id=school AND(after_id IS NULL OR l.id>after_id) ORDER BY l.id LIMIT page_limit+1
  ) r;
 ELSIF collection='inventory-movements' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]'::jsonb) INTO data FROM(
   SELECT m.id,m.lot_id AS "lotId",m.kind,m.quantity::text AS quantity,m.from_location AS "fromLocationId",m.from_version AS "fromLocationVersion",f.definition->>'name' AS "recordedFromLocationName",
    m.to_location AS "toLocationId",m.to_version AS "toLocationVersion",t.definition->>'name' AS "recordedToLocationName",m.occurred_at::text AS "occurredAt",m.disposition,m.restores_id AS "restoresId",m.created_by AS "changedById",m.approval_id AS "approvalId"
   FROM public.inventory_movements m LEFT JOIN public.inventory_catalogue_revisions f ON f.academy_id=m.academy_id AND f.entry_id=m.from_location AND f.version=m.from_version
   LEFT JOIN public.inventory_catalogue_revisions t ON t.academy_id=m.academy_id AND t.entry_id=m.to_location AND t.version=m.to_version
   WHERE m.academy_id=school AND(after_id IS NULL OR m.id>after_id) ORDER BY m.id LIMIT page_limit+1
  ) r;
 ELSIF collection='expense-bills' THEN$branch$;
 IF(length(body)-length(replace(body,needle,'')))/length(needle)<>1 THEN RAISE EXCEPTION 'INVENTORY_DIRECTORY_PROJECTION_CHANGED';END IF;
 EXECUTE replace(body,needle,replacement);
END $$;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 425 $$;
