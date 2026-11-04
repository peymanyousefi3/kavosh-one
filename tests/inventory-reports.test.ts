import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { inventoryFixture } from './inventory-fixture.ts';

async function fixture(){
 const f=await inventoryFixture();try{
  for(const role of [f.staffRole,f.managerRole])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,'inventory-reports.view','allow')",[f.a,role]);
  const report=(query='on=2026-11-03&timeZone=UTC',as='master')=>f.request('reports/inventory/stock?'+query,undefined,as);
  return {...f,report};
 }catch(error){await f.pg.close();throw error;}
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('inventory report consolidates exact purchase-cost fractions across locations before rounding and keeps totals intact through pagination',async f=>{
 const received=await f.receive({costMinor:'1'});assert.equal(received.response.status,201);const lotId=received.body.data.lotId,third=await f.made('inventory/locations',{hubId:f.hub,code:'ROOM-C',definition:{name:'Third stock location'},reason:'Synthetic location'});
 assert.equal((await f.move(lotId)).response.status,201);assert.equal((await f.move(lotId,{to:{id:third.id,version:1}})).response.status,201);
 const r=await f.report('on=2026-11-03&timeZone=UTC&limit=1');assert.equal(r.response.status,200,JSON.stringify(r.body));const d=r.body.data;
 assert.equal(d.rowCount,3);assert.equal(d.locationCount,3);assert.equal(d.itemCount,1);assert.equal(d.coverage,'complete_selected_currencies');assert.equal(d.currencyConversion,'none');assert.equal(d.formalBalanceSheetAsset,false);assert.equal(d.additionalLedgerPosting,false);
 assert.equal(d.paginationSnapshot,'per_request_not_frozen_across_pages');assert.equal(d.entryRounding,'per_row_display_only_not_additive');
 assert.equal(d.entries.length,1);assert.equal(d.entries[0].managementValue.roundedMinor,'0');assert.equal(d.currencies[0].knownSubtotal.minorNumerator,'1');assert.equal(d.currencies[0].knownSubtotal.minorDenominator,'1');assert.equal(d.currencies[0].managementValue.roundedMinor,'1');assert.equal(d.currencies[0].managementValue.roundedAmount,'0.01');assert.equal(d.chartData.locations.length,3);assert.deepEqual(d.chartData.units,[{unit:'piece',quantity:'3'}]);
 const seen=new Set<string>();let page=r;while(true){for(const row of page.body.data.entries)seen.add(row.locationId+':'+row.lotId);assert.equal(page.body.data.currencies[0].knownSubtotal.roundedMinor,'1');if(!page.body.nextCursor)break;page=await f.report('on=2026-11-03&timeZone=UTC&limit=1&'+new URLSearchParams(page.body.nextCursor));}assert.equal(seen.size,3);
});
check('historical stock follows effective movement dates, keeps disposals out of usable values and preserves the actual expense',async f=>{
 const lotId=(await f.receive()).body.data.lotId;assert.equal((await f.move(lotId)).response.status,201);
 const before=await f.report('on=2026-10-31&timeZone=UTC');assert.equal(before.body.data.rowCount,0);assert.deepEqual(before.body.data.currencies,[]);
 const first=await f.report('on=2026-11-01&timeZone=UTC');assert.equal(first.body.data.rowCount,1);assert.equal(first.body.data.entries[0].quantity,'3');
 assert.equal((await f.move(lotId,{kind:'dispose',to:undefined,quantity:2,disposition:'destroyed',occurredAt:'2026-11-03T10:00:00Z'})).response.status,201);
 const second=await f.report('on=2026-11-02&timeZone=UTC');assert.equal(second.body.data.currencies[0].managementValue.roundedAmount,'106.50');
 const after=await f.report();assert.equal(after.body.data.rowCount,1);assert.equal(after.body.data.entries[0].locationId,f.other.id);assert.equal(after.body.data.currencies[0].managementValue.roundedAmount,'35.50');assert.equal((await f.request('finance/expense-bills/'+f.purchase.id)).body.data.expense,'106.50');
});
check('civil report days respect midnight and daylight transitions and reject a skipped day or unknown timezone',async f=>{
 assert.equal((await f.receive({occurredAt:'2026-11-01T03:30:00Z'})).response.status,201);
 assert.equal((await f.report('on=2026-10-31&timeZone=UTC')).body.data.rowCount,0);
 const local=await f.report('on=2026-10-31&timeZone=America%2FToronto');assert.equal(local.response.status,200);assert.equal(local.body.data.rowCount,1);assert.equal(local.body.data.cutoffExclusive,'2026-11-01T04:00:00Z');
 assert.equal((await f.report('on=2026-11-01&timeZone=America%2FToronto')).body.data.dayLengthHours,25);
 assert.equal((await f.report('on=2026-03-08&timeZone=America%2FToronto')).body.data.dayLengthHours,23);
 assert.equal((await f.report('on=2011-12-30&timeZone=Pacific%2FApia')).body.error.code,'REPORT_DAY_DOES_NOT_EXIST');assert.equal((await f.report('on=2026-11-03&timeZone=Not%2FAZone')).response.status,400);
});
check('report and source permissions intersect before totals and chart data; selected hidden hubs and foreign schools reveal nothing',async f=>{
 const lotId=(await f.receive()).body.data.lotId;assert.equal((await f.move(lotId)).response.status,201);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='expenses.view'",[f.staffRole]);
 const own=await f.report(undefined,'staff');assert.equal(own.response.status,200,JSON.stringify(own.body));assert.equal(own.body.data.rowCount,1);assert.equal(own.body.data.coverage,'scoped_selected_inventory');assert.equal(own.body.data.currencies[0].knownSubtotal.roundedAmount,'71.00');assert.ok(!JSON.stringify(own.body).includes(f.other.id));
 for(const hidden of [f.purchase.id,f.payee.id,f.actors.staff.person,f.input.reason])assert.ok(!JSON.stringify(own.body).includes(hidden));
 const selected=await f.report('on=2026-11-03&timeZone=UTC&locationIds='+f.other.id,'staff');assert.equal(selected.body.data.rowCount,0);assert.deepEqual(selected.body.data.chartData.locations,[]);
 const foreign=await f.request('reports/inventory/stock?on=2026-11-03&timeZone=UTC',undefined,'foreignMaster',{academy:f.b});assert.equal(foreign.response.status,200);assert.equal(foreign.body.data.rowCount,0);
 for(const cap of ['inventory.view','inventory-reports.view']){await f.pg.query('DELETE FROM public.role_permissions WHERE role_id=$1 AND capability=$2',[f.staffRole,cap]);assert.equal((await f.report(undefined,'staff')).response.status,403);await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,f.staffRole,cap]);}
 const reportRole=await f.made('roles',{name:'Report hub B only',permissions:[{capability:'inventory-reports.view',effect:'allow'}]}),stockRole=await f.made('roles',{name:'Stock hub A only',permissions:[{capability:'inventory.view',effect:'allow'}]}),path='people/'+f.actors.staff.person+'/access';
 assert.equal((await f.request(path,{expectedVersion:(await f.request(path)).body.data.version,assignments:[{roleId:reportRole.id,allHubs:false,hubIds:[f.otherHub]},{roleId:stockRole.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);assert.equal((await f.report(undefined,'staff')).body.data.rowCount,0);
});
check('geographic, location, item and currency filters compose without expanding scope, and denied areas hide global warehouses',async f=>{
 const lotId=(await f.receive()).body.data.lotId;assert.equal((await f.move(lotId)).response.status,201);
 const geo=(await f.pg.query<{city:string;region:string;country:string}>('SELECT c.id AS city,r.id AS region,r.country_id AS country FROM public.hubs h JOIN public.cities c ON c.academy_id=h.academy_id AND c.id=h.city_id JOIN public.regions r ON r.academy_id=c.academy_id AND r.id=c.region_id WHERE h.id=$1',[f.hub])).rows[0],second=randomUUID();await f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Other synthetic city')",[f.a,second,geo.region]);await f.pg.query('UPDATE public.hubs SET city_id=$2 WHERE id=$1',[f.otherHub,second]);
 const selected=await f.report('on=2026-11-03&timeZone=UTC&'+new URLSearchParams({countryIds:geo.country,regionIds:geo.region,cityIds:geo.city,itemIds:f.item.id,currencyIds:f.currency.id}));assert.equal(selected.response.status,200,JSON.stringify(selected.body));assert.equal(selected.body.data.rowCount,1);assert.equal(selected.body.data.currencies[0].knownSubtotal.roundedAmount,'71.00');
 const global=await f.made('inventory/locations',{code:'SCHOOL',definition:{name:'School-wide warehouse'},reason:'Synthetic global stock'});assert.equal((await f.move(lotId,{quantity:1,to:{id:global.id,version:1}})).response.status,201);
 const allow=await f.made('roles',{name:'Broad stock reporting',permissions:['inventory.view','inventory-reports.view'].map(capability=>({capability,effect:'allow'}))}),deny=await f.made('roles',{name:'Report hub denied',permissions:[{capability:'inventory-reports.view',effect:'deny'}]}),path='people/'+f.actors.staff.person+'/access';
 assert.equal((await f.request(path,{expectedVersion:(await f.request(path)).body.data.version,assignments:[{roleId:allow.id,allHubs:true},{roleId:deny.id,allHubs:false,hubIds:[f.hub]}]})).response.status,200);
 const restricted=await f.report(undefined,'staff');assert.equal(restricted.body.data.rowCount,1);assert.equal(restricted.body.data.entries[0].locationId,f.other.id);assert.ok(!JSON.stringify(restricted.body).includes(global.id));
});
check('genuine expense corrections mark cost unknown only from their effective accounting date without hiding physical quantity',async f=>{
 assert.equal((await f.receive()).response.status,201);assert.equal((await f.cancel(f.purchase.id)).response.status,201);
 const before=await f.report('on=2026-11-07&timeZone=UTC');assert.equal(before.body.data.currencies[0].valueComplete,true);assert.equal(before.body.data.currencies[0].managementValue.roundedAmount,'106.50');
 const after=await f.report('on=2026-11-08&timeZone=UTC');assert.equal(after.body.data.rowCount,1);assert.equal(after.body.data.entries[0].quantity,'3');assert.equal(after.body.data.entries[0].valuationReviewRequired,true);assert.equal(after.body.data.entries[0].managementValue,null);assert.equal(after.body.data.currencies[0].unpricedRows,1);assert.equal(after.body.data.currencies[0].knownSubtotal.roundedAmount,'0.00');assert.equal(after.body.data.currencies[0].managementValue,null);assert.equal(after.body.data.forecast,false);
});
check('currency totals normalize differently pinned precision exactly and never combine CAD with USD',async f=>{
 const first=await f.receive({costMinor:'1'});assert.equal(first.response.status,201);assert.equal((await f.move(first.body.data.lotId)).response.status,201);
 assert.equal((await f.request('finance/currencies/'+f.currency.id+'/change',{expectedVersion:1,unitScale:3,reason:'Synthetic currency precision revision'})).response.status,200);
 // Build actual posted expense sources at each pinned precision; no synthetic
 // float values or unguarded inventory inserts stand in for persisted rows.
 async function add(code:string,currencyId:string,currencyVersion:number,costMinor:string){
  const account=async(suffix:string,kind:string,operationalRole:string)=>f.made('finance/accounts',{code:code+suffix,name:'Synthetic report '+suffix,kind,operationalRole,hubId:f.hub,currencyId,currencyVersion,reason:'Synthetic report source account'}),ap=await account('AP','liability','payable'),expense=await account('EXP','expense','expense'),tax=await account('TAX','asset','tax_receivable');
  const bill=await f.bill({documentNumber:code,currency:{id:currencyId,version:currencyVersion},payableAccount:{id:ap.id,version:1},issuedOn:'2026-10-01',postedOn:'2026-10-01',lines:[{description:'Report precision purchase',hubId:f.hub,expenseAccount:{id:expense.id,version:1},taxAccount:{id:tax.id,version:1},taxCode:{id:f.planInput.taxCodeId,version:1},taxOn:'2026-10-01',amount:'1',pricing:'tax_exclusive',recoverablePercent:'50',taxReview:'Synthetic eligibility declaration'}]});assert.equal(bill.response.status,201,JSON.stringify(bill.body));
  assert.equal((await f.receive({billId:bill.body.data.id,quantity:1,costMinor})).response.status,201);
 }
 await add('CAD3',f.currency.id,2,'5');const usd=await f.made('finance/currencies',{code:'USD',name:'US dollar',unitScale:2,reason:'Separate synthetic report currency'});await add('USD2',usd.id,1,'7');
 const r=await f.report();assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.currencies.length,2);
 const cad=r.body.data.currencies.find((c:{currencyCode:string})=>c.currencyCode==='CAD'),dollar=r.body.data.currencies.find((c:{currencyCode:string})=>c.currencyCode==='USD');assert.equal(cad.unitScale,3);assert.equal(cad.managementValue.roundedMinor,'15');assert.equal(cad.managementValue.roundedAmount,'0.015');assert.equal(dollar.managementValue.roundedAmount,'0.07');
 const selected=await f.report('on=2026-11-03&timeZone=UTC&currencyIds='+usd.id);assert.equal(selected.body.data.coverage,'complete_selected_currencies');assert.equal(selected.body.data.currencies.length,1);
});
check('actual posted purchase lots aggregate beyond individual posting bounds without Number conversion or penny loss',async f=>{
 const cost=8n*10n**37n;
 for(const documentNumber of ['LARGE-ONE','LARGE-TWO']){
  const b=await f.bill({documentNumber,issuedOn:'2026-10-01',postedOn:'2026-10-01',lines:[{description:'Synthetic large exact-money source',hubId:f.hub,expenseAccount:{id:f.expense.id,version:1},taxAccount:{id:f.itc.id,version:1},taxCode:{id:f.planInput.taxCodeId,version:1},taxOn:'2026-10-01',amount:(8n*10n**35n).toString()+'.00',pricing:'tax_exclusive',recoverablePercent:'50',taxReview:'Synthetic manually declared source'}]});assert.equal(b.response.status,201,JSON.stringify(b.body));assert.equal((await f.receive({billId:b.body.data.id,costMinor:cost.toString(),quantity:1})).response.status,201);
 }
 const r=await f.report();assert.equal(r.response.status,200,JSON.stringify(r.body));assert.equal(r.body.data.currencies[0].managementValue.minorNumerator,(2n*cost).toString());assert.equal(r.body.data.currencies[0].managementValue.minorDenominator,'1');assert.equal(r.body.data.currencies[0].managementValue.roundedMinor,(2n*cost).toString());
});
check('report filters reject malformed or duplicate selectors, partial cursors, missing dates, oversized pages and mutation requests',async f=>{
 for(const q of ['', 'on=2026-11-03','on=2026-02-30&timeZone=UTC','on=2026-11-03&timeZone=UTC&limit=101','on=2026-11-03&timeZone=UTC&itemIds=','on=2026-11-03&timeZone=UTC&hubIds='+f.hub+','+f.hub,'on=2026-11-03&timeZone=UTC&afterLotId='+randomUUID(),'on=2026-11-03&timeZone=UTC&includePrivate=true'])assert.equal((await f.report(q)).response.status,400,q);
 assert.equal((await f.request('reports/inventory/stock',{on:'2026-11-03',timeZone:'UTC'})).response.status,405);
 assert.equal((await f.report('on=9999-12-31&timeZone=UTC')).response.status,200);
});
check('small parallel report reads keep complete same-snapshot totals and stable page order without posting or editing stock',async f=>{
 const lotId=(await f.receive()).body.data.lotId;assert.equal((await f.move(lotId)).response.status,201);const before=(await f.pg.query('SELECT id FROM public.inventory_movements')).rows.length,start=performance.now();
 const results=await Promise.all(Array.from({length:f.pg.runtime?4:1},()=>f.report('on=2026-11-03&timeZone=UTC&limit=1')));for(const r of results){assert.equal(r.response.status,200);assert.equal(r.body.data.rowCount,2);assert.equal(r.body.data.currencies[0].knownSubtotal.roundedAmount,'106.50');assert.ok(r.body.nextCursor);}assert.equal((await f.pg.query('SELECT id FROM public.inventory_movements')).rows.length,before);if(f.pg.runtime)console.log(JSON.stringify({measurement:'brief-inventory-report-reads',requests:4,elapsedMs:Math.ceil(performance.now()-start)}));
});
