import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { readMinorUnits,formatMoneyTotal,roundRatio,sumInventoryValueRatios,maximumSynchronousInventoryValueTerms } from '../core/money.ts';
import { accountingDate } from './finance-periods.ts';
import { hubReportAccess,financialIds as ids } from './financial-reports.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const zone=z.string().min(1).max(100).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});Temporal.Now.instant().toZonedDateTimeISO(v);return !/^[+-]/.test(v);}catch{return false;}},'Use an IANA time zone.');
const query=z.object({on:accountingDate,timeZone:zone,hubIds:ids.optional(),countryIds:ids.optional(),regionIds:ids.optional(),cityIds:ids.optional(),locationIds:ids.optional(),itemIds:ids.optional(),currencyIds:ids.optional(),tracking:z.enum(['bulk','individual']).optional(),
 limit:z.coerce.number().int().min(1).max(100).default(50),afterLocationId:uuid.optional(),afterLotId:uuid.optional()}).strict().refine(v=>(v.afterLocationId===undefined)===(v.afterLotId===undefined),'Provide both cursor fields together.');
type Row={locationId:string;locationCode:string;locationName:string;locationActive:boolean;hubId:string|null;lotId:string;itemId:string;itemVersion:number;itemName:string;itemCode:string;tracking:string;unit:string;serialNumber:string|null;quantity:string;originalQuantity:string;costMinor:string;currencyId:string;currencyCode:string;unitScale:number;sourceInvalid:boolean};
type Currency={currencyId:string;currencyCode:string;unitScale:number;rows:number;unpricedRows:number};
type Term={currencyId:string;numerator:string;denominator:string};
// Filter current authority/selected locations before quantity, value and chart
// aggregates. Each location uses indexed movement point reads; summaries and
// page entries share ONE statement snapshot, even under concurrent updates.
export const inventoryStockReportSQL=`WITH selected AS MATERIALIZED(
 SELECT loc.id,loc.hub_id,loc.code,loc.version,v.definition->>'name' AS name,(v.definition->>'active')::boolean AS active
 FROM public.inventory_catalogue loc JOIN public.inventory_catalogue_revisions v ON v.academy_id=loc.academy_id AND v.entry_id=loc.id AND v.version=loc.version
 LEFT JOIN public.hubs h ON h.academy_id=loc.academy_id AND h.id=loc.hub_id
 LEFT JOIN public.cities ci ON ci.academy_id=h.academy_id AND ci.id=h.city_id LEFT JOIN public.regions rg ON rg.academy_id=ci.academy_id AND rg.id=ci.region_id
 WHERE loc.kind='location' AND((loc.hub_id IS NULL AND $4::boolean) OR(loc.hub_id IS NOT NULL AND($1::boolean OR loc.hub_id=ANY($2::uuid[])) AND NOT loc.hub_id=ANY($3::uuid[])))
 AND($7::uuid[] IS NULL OR loc.hub_id=ANY($7)) AND($8::uuid[] IS NULL OR rg.country_id=ANY($8)) AND($9::uuid[] IS NULL OR rg.id=ANY($9)) AND($10::uuid[] IS NULL OR ci.id=ANY($10)) AND($11::uuid[] IS NULL OR loc.id=ANY($11))
),balances AS MATERIALIZED(
 SELECT s.id AS location_id,s.hub_id,s.code AS location_code,s.name AS location_name,s.active AS location_active,l.id AS lot_id,l.item_id,l.item_version,ic.code AS item_code,r.definition->>'name' AS item_name,r.definition->>'tracking' AS tracking,r.definition->>'unit' AS unit,l.serial_number,l.quantity AS original_quantity,l.cost_minor,l.currency_id,c.code AS currency_code,l.unit_scale,q.quantity,
 (j.id IS NOT NULL AND j.posted_on<=$6::date) AS source_invalid
 FROM selected s CROSS JOIN LATERAL(SELECT d.lot_id,sum(d.quantity) AS quantity FROM public.inventory_deltas d WHERE d.location_id=s.id AND d.occurred_at<$5::timestamptz GROUP BY d.lot_id HAVING sum(d.quantity)>0) q
 JOIN public.inventory_lots l ON l.id=q.lot_id AND l.academy_id=nullif(current_setting('app.academy_id',true),'')::uuid
 JOIN public.inventory_catalogue ic ON ic.academy_id=l.academy_id AND ic.id=l.item_id JOIN public.inventory_catalogue_revisions r ON r.academy_id=l.academy_id AND r.entry_id=l.item_id AND r.version=l.item_version
 JOIN public.finance_currencies c ON c.academy_id=l.academy_id AND c.id=l.currency_id JOIN public.expense_bills b ON b.academy_id=l.academy_id AND b.id=l.bill_id LEFT JOIN public.finance_journals j ON j.academy_id=b.academy_id AND j.id=b.void_id
 WHERE($12::uuid[] IS NULL OR l.item_id=ANY($12)) AND($13::uuid[] IS NULL OR l.currency_id=ANY($13)) AND($14::text IS NULL OR r.definition->>'tracking'=$14)
),normalized AS(
 SELECT b.*,max(unit_scale) OVER(PARTITION BY currency_id) AS scale FROM balances b
),terms AS MATERIALIZED(
 SELECT currency_id AS "currencyId",original_quantity::text AS denominator,sum(cost_minor*quantity*('1'||repeat('0',scale-unit_scale))::numeric)::text AS numerator FROM normalized WHERE NOT source_invalid GROUP BY currency_id,original_quantity
),currencies AS(
 SELECT currency_id AS "currencyId",currency_code AS "currencyCode",max(unit_scale) AS "unitScale",count(*)::integer AS rows,count(*) FILTER(WHERE source_invalid)::integer AS "unpricedRows" FROM balances GROUP BY currency_id,currency_code
),page AS(
 SELECT location_id AS "locationId",location_code AS "locationCode",location_name AS "locationName",location_active AS "locationActive",hub_id AS "hubId",lot_id AS "lotId",item_id AS "itemId",item_version AS "itemVersion",item_name AS "itemName",item_code AS "itemCode",tracking,unit,serial_number AS "serialNumber",quantity::text,original_quantity::text AS "originalQuantity",cost_minor::text AS "costMinor",currency_id AS "currencyId",currency_code AS "currencyCode",unit_scale AS "unitScale",source_invalid AS "sourceInvalid"
 FROM balances WHERE $15::uuid IS NULL OR(location_id,lot_id)>($15::uuid,$16::uuid) ORDER BY location_id,lot_id LIMIT $17
),location_series AS(
 SELECT location_id AS "locationId",location_name AS "locationName",hub_id AS "hubId",unit,sum(quantity)::text AS quantity,count(*)::integer AS rows,count(*) FILTER(WHERE source_invalid)::integer AS "unpricedRows" FROM balances GROUP BY location_id,location_name,hub_id,unit
),unit_series AS(
 SELECT unit,sum(quantity)::text AS quantity FROM balances GROUP BY unit
)
SELECT statement_timestamp() AS "snapshotAt",(SELECT count(*)::integer FROM balances) AS "rowCount",(SELECT count(DISTINCT location_id)::integer FROM balances) AS "locationCount",(SELECT count(DISTINCT item_id)::integer FROM balances) AS "itemCount",(SELECT count(*)::integer FROM terms) AS "termCount",
 (SELECT count(*)::integer FROM currencies) AS "currencyCount",(SELECT count(*)::integer FROM location_series) AS "chartRowCount",
 coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY "currencyId",denominator) FROM(SELECT * FROM terms ORDER BY "currencyId",denominator LIMIT ${maximumSynchronousInventoryValueTerms+1}) t),'[]'::jsonb) AS terms,
 coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY "currencyCode","currencyId") FROM(SELECT * FROM currencies ORDER BY "currencyCode","currencyId" LIMIT 1001) c),'[]'::jsonb) AS currencies,
 coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY "locationId","lotId") FROM page),'[]'::jsonb) AS entries,
 coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY "locationId",unit) FROM(SELECT * FROM location_series ORDER BY "locationId",unit LIMIT 1001) s),'[]'::jsonb) AS "locationSeries",
 coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY unit) FROM(SELECT * FROM unit_series ORDER BY unit LIMIT 1001) s),'[]'::jsonb) AS "unitSeries"`;
function value(numerator:bigint,denominator:bigint,scale:number){const rounded=roundRatio(numerator,denominator,'half_away');return {minorNumerator:numerator.toString(),minorDenominator:denominator.toString(),roundedMinor:rounded.toString(),roundedAmount:formatMoneyTotal(rounded,scale)};}
export async function inventoryReports(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/inventory/stock')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
 const access=hubReportAccess(ctx,['inventory-reports.view','inventory.view']),q=query.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
 const day=Temporal.PlainDate.from(q.on),start=day.toZonedDateTime(q.timeZone),end=day.add({days:1}).toZonedDateTime(q.timeZone);
 if(start.toPlainDate().toString()!==q.on)throw new ApiError(400,'REPORT_DAY_DOES_NOT_EXIST');
 // Temporal uses ISO expanded years; PostgreSQL requires the ordinary
 // five-digit year for the exclusive endpoint after 9999-12-31.
 const databaseCutoff=end.toInstant().toString().replace(/^\+0(?=\d{5}-)/,'');
 const result=(await ctx.db.query<{snapshotAt:Date|string;rowCount:number;locationCount:number;itemCount:number;termCount:number;currencyCount:number;chartRowCount:number;terms:Term[];currencies:Currency[];entries:Row[];locationSeries:unknown[];unitSeries:unknown[]}>(inventoryStockReportSQL,
  [access.all,access.hubs,access.excluded,access.global,databaseCutoff,q.on,q.hubIds??null,q.countryIds??null,q.regionIds??null,q.cityIds??null,q.locationIds??null,q.itemIds??null,q.currencyIds??null,q.tracking??null,q.afterLocationId??null,q.afterLotId??null,q.limit+1])).rows[0];
 // No silently partial summary if a deliberately diverse set of purchase-lot
 // denominators exceeds the synchronous exact-arithmetic budget.
 if(result.termCount>maximumSynchronousInventoryValueTerms||result.currencyCount>1000||result.chartRowCount>1000)throw new ApiError(422,'REPORT_REQUIRES_BACKGROUND_JOB');
 const terms=new Map<string,{numerator:bigint;denominator:bigint}[]>();for(const t of result.terms){const a=terms.get(t.currencyId)??[];a.push({numerator:readMinorUnits(t.numerator),denominator:BigInt(t.denominator)});terms.set(t.currencyId,a);}
 const currencies=result.currencies.map(c=>{const total=sumInventoryValueRatios(terms.get(c.currencyId)??[]),knownSubtotal=value(total.numerator,total.denominator,c.unitScale);return {...c,knownSubtotal,managementValue:c.unpricedRows?null:knownSubtotal,valueComplete:c.unpricedRows===0};});
 const entries=result.entries.slice(0,q.limit).map(({costMinor,originalQuantity,sourceInvalid,...r})=>({...r,valuationReviewRequired:sourceInvalid,managementValue:sourceInvalid?null:value(readMinorUnits(costMinor)*BigInt(r.quantity),BigInt(originalQuantity),r.unitScale)}));
 const next=result.entries.length>q.limit?result.entries[q.limit-1]:null,complete=access.global&&!q.hubIds&&!q.countryIds&&!q.regionIds&&!q.cityIds&&!q.locationIds&&!q.itemIds&&!q.tracking;
 return {status:200,body:{data:{report:'inventory_purchase_cost_stock',on:q.on,timeZone:q.timeZone,timeZoneDatabaseVersion:process.versions.tz??null,cutoffExclusive:end.toInstant().toString(),dayLengthHours:(end.epochMilliseconds-start.epochMilliseconds)/3600000,snapshotAt:result.snapshotAt,
  coverage:complete?'complete_selected_currencies':'scoped_selected_inventory',currencyConversion:'none',rounding:'half_away_once_after_scope_and_filtering',entryRounding:'per_row_display_only_not_additive',sourceBasis:'currently_recorded_effective_movement_times',paginationSnapshot:'per_request_not_frozen_across_pages',accountingSourceThrough:q.on,catalogueBasis:'pinned_item_revision_current_location_and_geography',formalBalanceSheetAsset:false,additionalLedgerPosting:false,forecast:false,
  cutoffIsFuture:end.epochMilliseconds>new Date(result.snapshotAt).getTime(),rowCount:result.rowCount,locationCount:result.locationCount,itemCount:result.itemCount,currencies,entries,chartData:{locations:result.locationSeries,units:result.unitSeries}},nextCursor:next?{afterLocationId:next.locationId,afterLotId:next.lotId}:null}};
}
export const inventoryReportsContract=[{path:'/api/v1/reports/inventory/stock',method:'get',summary:'Same-snapshot historical stock with explicit civil day/time zone, intersected inventory/report scopes, geographic/item/location/currency filters, full exact consolidated rational values and chart series; pagination never narrows totals, invalidated purchase costs remain unpriced, no FX or formal asset capitalization',querySchema:query}] as const;
