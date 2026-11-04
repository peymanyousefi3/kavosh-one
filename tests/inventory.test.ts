import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { inventoryFixture as fixture } from './inventory-fixture.ts';
type Fixture=Awaited<ReturnType<typeof fixture>>;
function check(name:string,run:(f:Fixture)=>Promise<void>){test(name,async()=>{const f=await fixture();try{await run(f);}finally{await f.pg.close();}});}

check('expense-backed stock receipts retain quantity and cost without another ledger expense, and transfers conserve both hubs',async f=>{
 const journals=(await f.pg.query('SELECT id FROM public.finance_journals')).rows.length,key=randomUUID(),r=await f.receive({},'master',key);assert.equal(r.response.status,201,JSON.stringify(r.body));const lotId=r.body.data.lotId;
 assert.equal((await f.receive({},'master',key)).body.data.id,r.body.data.id);
 const before=(await f.stock()).body.data[0];assert.equal(before.quantity,'3');assert.equal(before.roundedManagementValue,'106.50');assert.equal(before.valueNumeratorMinor,'31950');assert.equal(before.valueDenominator,'3');assert.equal(before.purchased_by,f.actors.staff.person);assert.equal(before.purchased_at,'2026-10-01T10:00:00.000Z');
 assert.equal((await f.move(lotId)).response.status,201);assert.equal((await f.stock()).body.data[0].quantity,'2');assert.equal((await f.stock(f.other.id)).body.data[0].roundedManagementValue,'35.50');
 assert.equal((await f.pg.query('SELECT id FROM public.finance_journals')).rows.length,journals);assert.equal((await f.request('finance/expense-bills/'+f.purchase.id)).body.data.expense,'106.50');
 assert.equal((await f.request('inventory/movements?lotId='+lotId)).body.data.length,2);
});
check('disposal removes usable value but never original expense; recovery is bounded by the actual disposed quantity',async f=>{
 const lotId=(await f.receive()).body.data.lotId;
 const disposal=await f.move(lotId,{kind:'dispose',to:undefined,quantity:3,disposition:'stolen'});assert.equal(disposal.response.status,201,JSON.stringify(disposal.body));assert.equal((await f.stock()).body.data.length,0);
 assert.equal((await f.request('finance/expense-bills/'+f.purchase.id)).body.data.expense,'106.50');
 const restoration={kind:'restore',lotId,quantity:2,to:f.input.to,restoresId:disposal.body.data.id,occurredAt:'2026-11-03T10:00:00Z',reason:'Two items recovered after theft'};
 assert.equal((await f.request('inventory/movements',restoration)).response.status,201);assert.equal((await f.stock()).body.data[0].quantity,'2');
 assert.equal((await f.request('inventory/movements',restoration)).response.status,409);
 assert.equal((await f.request('inventory/movements',{...restoration,restoresId:lotId,quantity:1})).response.status,409);
 assert.equal((await f.pg.query('SELECT * FROM public.inventory_movements')).rows.length,3);
});
check('source purchase budgets reject duplicate cost, void purchases and hidden financial approval payloads after view revocation',async f=>{
 const pending=await f.receive({},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.stock()).body.data.length,0);
 await f.pg.query("DELETE FROM public.role_permissions WHERE role_id=$1 AND capability='expenses.view'",[f.staffRole]);assert.equal((await f.request('approvals/'+pending.body.approval.id,undefined,'staff')).response.status,404);assert.ok(!(await f.request('approvals',undefined,'staff')).body.data.some((p:{id:string})=>p.id===pending.body.approval.id));
 assert.equal((await f.approve(pending.body.approval.id)).response.status,409);
 const posted=await f.receive();assert.equal(posted.response.status,201);assert.equal((await f.receive({costMinor:'1'})).body.error.code,'INVENTORY_PURCHASE_COST_EXCEEDED');
 const voided=await f.cancel(f.purchase.id);assert.equal(voided.response.status,201,JSON.stringify(voided.body));
 assert.equal((await f.request('finance/expense-bills/'+f.purchase.id)).body.data.status,'voided');
 const retained=(await f.stock()).body.data[0];assert.equal(retained.quantity,'3');assert.equal(retained.cost_minor,'10650');assert.equal(retained.valuationReviewRequired,true);assert.equal(retained.roundedManagementValue,null,'A genuine bill correction must not fabricate a valid current asset-cost estimate');
 assert.equal((await f.receive({costMinor:'0'})).response.status,409);
});
check('partial hub access reveals its own stock but never peer locations or full cross-hub movement details',async f=>{
 const lotId=(await f.receive({},'staff')).body.approval.id;
 assert.equal((await f.approve(lotId,'manager')).response.status,200);const owned=(await f.stock(f.location.id,'staff')).body.data[0].id;
 const transfer=await f.move(owned);assert.equal(transfer.response.status,201);
 assert.equal((await f.stock(f.other.id,'staff')).response.status,404);assert.equal((await f.request('inventory/movements/'+transfer.body.data.id,undefined,'staff')).response.status,404);
 const list=await f.request('inventory/movements?limit=1',undefined,'staff');assert.equal(list.body.data.length,1);assert.equal(list.body.data[0].kind,'receive');assert.equal(list.body.nextCursor,null);
 assert.equal((await f.request('inventory/locations',undefined,'staff')).body.data.length,1);
 assert.equal((await f.request('inventory/items',undefined,'staff')).body.data[0].id,f.item.id,'Shared labels do not require global physical-stock rights');
 assert.equal((await f.move(owned,{},'staff')).response.status,404);
});
check('backdated removals respect every later stock frontier, not merely stock at the selected date or now',async f=>{
 const lotId=(await f.receive()).body.data.lotId;
 const disposed=await f.move(lotId,{kind:'dispose',to:undefined,quantity:3,disposition:'destroyed'});assert.equal(disposed.response.status,201);
 assert.equal((await f.request('inventory/movements',{kind:'restore',lotId,quantity:3,to:f.input.to,restoresId:disposed.body.data.id,occurredAt:'2026-11-03T10:00:00Z',reason:'Corrected mistaken destruction report'})).response.status,201);
 const bad=await f.move(lotId,{occurredAt:'2026-11-01T11:00:00Z'});assert.equal(bad.response.status,409);assert.equal(bad.body.error.code,'INVENTORY_QUANTITY_UNAVAILABLE');
 assert.equal((await f.move(lotId,{occurredAt:'2026-11-03T11:00:00Z'})).response.status,201);
});
check('individual inventory requires one durable serial number, while bulk units retain exact rational cost',async f=>{
 const item=await f.made('inventory/items',{hubId:f.hub,code:'SERIAL',definition:{name:'Individual controller',tracking:'individual'},reason:'Serialized equipment'});
 assert.equal((await f.receive({item:{id:item.id,version:1},costMinor:'1'})).response.status,409);
 assert.equal((await f.receive({item:{id:item.id,version:1},quantity:1,costMinor:'1',serialNumber:'SYN-0001'})).response.status,201);
 assert.equal((await f.receive({item:{id:item.id,version:1},quantity:1,costMinor:'1',serialNumber:'SYN-0001'})).response.status,409);
 const r=await f.receive({costMinor:'5'});assert.equal(r.response.status,201);assert.equal((await f.move(r.body.data.lotId)).response.status,201);
 const stock=(await f.stock()).body.data.find((x:{id:string})=>x.id===r.body.data.lotId);assert.equal(stock.valueNumeratorMinor,'10');assert.equal(stock.valueDenominator,'3');assert.equal(stock.roundedManagementValue,'0.03');
});
check('catalogue edits are upper-reviewed, source-pinned and cannot silently change earlier item or custodian history',async f=>{
 const r=await f.receive();assert.equal(r.response.status,201);
 const change=await f.request('inventory/items/'+f.item.id+'/change',{expectedVersion:1,definition:{name:'Revised kit name',tracking:'bulk',active:false},reason:'Retain old catalogue identity'});assert.equal(change.response.status,200,JSON.stringify(change.body));
 assert.equal((await f.stock()).body.data[0].item_name,'Bulk robot kits');assert.equal((await f.receive({item:{id:f.item.id,version:2},costMinor:'0'})).response.status,409);
 assert.equal((await f.request('inventory/items/'+f.item.id+'/history')).body.data.length,2);
 const pending=await f.request('inventory/locations/'+f.location.id+'/change',{expectedVersion:1,definition:{name:'Renamed room'},reason:'Private proposed rename'},'staff');assert.equal(pending.response.status,202);assert.equal((await f.approve(pending.body.approval.id,'manager')).response.status,200);
 assert.equal((await f.move(r.body.data.lotId)).body.error.code,'INVENTORY_LOCATION_CHANGED');
 assert.equal((await f.move(r.body.data.lotId,{from:{id:f.location.id,version:2}})).response.status,201);
});
check('closed storage locations can release existing equipment but cannot accept new stock, and declared purchase dates cannot follow receipt',async f=>{
 assert.equal((await f.receive({purchasedAt:'2026-11-02T10:00:00Z'})).response.status,400);
 const lotId=(await f.receive()).body.data.lotId;
 const closed=await f.request('inventory/locations/'+f.location.id+'/change',{expectedVersion:1,definition:{name:'Closed storage room',active:false},reason:'Stop incoming stock without trapping existing equipment'});assert.equal(closed.response.status,200);
 assert.equal((await f.move(lotId,{from:{id:f.location.id,version:2}})).response.status,201);
 assert.equal((await f.move(lotId,{from:{id:f.other.id,version:1},to:{id:f.location.id,version:2}})).body.error.code,'INVENTORY_LOCATION_CHANGED');
});
check('inventory commands preserve human approval, bot proposal-only, stale dependencies and atomic rollback',async f=>{
 const r=await f.receive();assert.equal(r.response.status,201);const lotId=r.body.data.lotId;
 const pending=await f.move(lotId,{kind:'dispose',to:undefined,disposition:'consumed'},'bot');assert.equal(pending.response.status,202,JSON.stringify(pending.body));assert.equal((await f.approve(pending.body.approval.id,'bot')).response.status,403);
 assert.equal((await f.move(lotId,{kind:'dispose',to:undefined,disposition:'lost'})).response.status,201);assert.equal((await f.approve(pending.body.approval.id)).response.status,409);
 await f.pg.exec("CREATE FUNCTION public.reject_inventory_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='inventory.dispose' THEN RAISE EXCEPTION 'synthetic failure';END IF;RETURN NEW;END $$;CREATE TRIGGER reject_inventory_event BEFORE INSERT ON public.outbox_events FOR EACH ROW EXECUTE FUNCTION public.reject_inventory_event()");
 const before=(await f.pg.query('SELECT * FROM public.inventory_movements')).rows.length;assert.equal((await f.move(lotId,{kind:'dispose',to:undefined,disposition:'lost'})).response.status,503);assert.equal((await f.pg.query('SELECT * FROM public.inventory_movements')).rows.length,before);
});
check('runtime stock history is tenant-bound, append-only and cannot forge server timestamps or roll catalogue versions backward',async f=>{
 const r=await f.receive();assert.equal(r.response.status,201);const id=r.body.data.id;
 await f.pg.exec('BEGIN');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
 try{
  for(const [sql,params] of [['DELETE FROM public.inventory_movements WHERE id=$1',[id]],['UPDATE public.inventory_lots SET cost_minor=1 WHERE id=$1',[id]],['UPDATE public.inventory_catalogue SET version=version WHERE id=$1',[f.item.id]],['UPDATE public.inventory_catalogue_revisions SET reason=\'overwrite\' WHERE entry_id=$1',[f.item.id]],['UPDATE public.inventory_movements SET created_at=now() WHERE id=$1',[id]]] as [string,unknown[]][]){await f.pg.exec('SAVEPOINT hostile');await assert.rejects(f.pg.query(sql,params));await f.pg.exec('ROLLBACK TO SAVEPOINT hostile');}
  await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.b]);assert.equal((await f.pg.query('SELECT * FROM public.inventory_lots')).rows.length,0);assert.equal((await f.pg.query('SELECT * FROM public.inventory_movements')).rows.length,0);
 }finally{await f.pg.exec('ROLLBACK');}
});
check('native quantity checks independently reject two exact pending movements that together overdraw one stock lot',async f=>{
 const lotId=(await f.receive()).body.data.lotId;
 const proposals=await Promise.all([f.move(lotId,{kind:'dispose',to:undefined,quantity:3,disposition:'lost'},'staff'),f.move(lotId,{kind:'dispose',to:undefined,quantity:3,disposition:'destroyed'},'staff')]);assert.ok(proposals.every(p=>p.response.status===202));
 const rows=(await f.pg.query<{id:string;target_id:string;payload:{reason:string;disposition:string}}>('SELECT id,target_id,payload FROM public.approval_requests WHERE id=ANY($1::uuid[])',[proposals.map(p=>p.body.approval.id)])).rows;
 await f.pg.exec('BEGIN');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);await f.pg.exec('SET LOCAL ROLE kavosh_runtime');
 try{
  const sql="INSERT INTO public.inventory_movements(academy_id,id,lot_id,kind,quantity,from_location,from_version,occurred_at,disposition,reason,approval_id,created_by) VALUES($1,$2,$3,'dispose',3,$4,1,'2026-11-02T10:00:00Z',$5,$6,$7,$8)";
  await f.pg.query(sql,[f.a,rows[0].target_id,lotId,f.location.id,rows[0].payload.disposition,rows[0].payload.reason,rows[0].id,f.actors.master.person]);
  await assert.rejects(f.pg.query(sql,[f.a,rows[1].target_id,lotId,f.location.id,rows[1].payload.disposition,rows[1].payload.reason,rows[1].id,f.actors.master.person]),/INVENTORY_QUANTITY_UNAVAILABLE/);
 }finally{await f.pg.exec('ROLLBACK');}
 assert.equal((await f.stock()).body.data[0].quantity,'3');
});
check('an inventory change and restoration cannot revive an old approval merely because usable quantity returned to the earlier amount',async f=>{
 const lotId=(await f.receive()).body.data.lotId,pending=await f.move(lotId,{kind:'dispose',to:undefined,disposition:'consumed'},'staff');assert.equal(pending.response.status,202);
 const removal=await f.move(lotId,{kind:'dispose',to:undefined,disposition:'lost'});assert.equal(removal.response.status,201);
 assert.equal((await f.request('inventory/movements',{kind:'restore',lotId,quantity:1,to:f.input.to,restoresId:removal.body.data.id,occurredAt:'2026-11-03T10:00:00Z',reason:'Found the item'})).response.status,201);
 assert.equal((await f.stock()).body.data[0].quantity,'3');assert.equal((await f.approve(pending.body.approval.id)).response.status,409);
 const key=randomUUID(),body={expectedVersion:1,definition:{name:'Renamed stock room'},reason:'Durable catalogue retry'};
 assert.equal((await f.request('inventory/locations/'+f.location.id+'/change',body,'master',{key})).response.status,200);assert.equal((await f.request('inventory/locations/'+f.location.id+'/change',body,'master',{key})).response.status,200);
});
check('purchase correction review becomes stale if its inventory impact changes, without exposing location or quantity details in the financial source stamp',async f=>{
 const caps=(await f.pg.query<{name:string}>('SELECT name FROM public.capability_catalog')).rows.map(r=>r.name),role=await f.made('roles',{name:'Synthetic financial and stock operator',permissions:caps.map(capability=>({capability,effect:'allow'}))}),path='people/'+f.actors.staff.person+'/access';
 assert.equal((await f.request(path,{expectedVersion:(await f.request(path)).body.data.version,assignments:[{roleId:role.id,allHubs:true}]})).response.status,200);
 const lotId=(await f.receive()).body.data.lotId,pending=await f.cancel(f.purchase.id,{},'staff');assert.equal(pending.response.status,202,JSON.stringify(pending.body));
 const review=(await f.request('approvals/'+pending.body.approval.id)).body.data.reviewContext;assert.match(review.inventorySourceStamp,/^[a-f0-9]{64}$/);
 assert.equal((await f.move(lotId)).response.status,201);const stale=await f.approve(pending.body.approval.id);assert.equal(stale.response.status,409);assert.equal(stale.body.approval.decisionCode,'DEPENDENCIES_CHANGED');
 assert.equal((await f.request('finance/expense-bills/'+f.purchase.id)).body.data.status,'recorded');
});
test('brief simultaneous disposals cannot consume the same available stock twice',async t=>{
 const f=await fixture();try{if(!f.pg.runtime){t.skip('Requires native PostgreSQL connections');return;}const lotId=(await f.receive()).body.data.lotId,start=performance.now(),results=await Promise.all([f.move(lotId,{kind:'dispose',to:undefined,quantity:3,disposition:'lost'}),f.move(lotId,{kind:'dispose',to:undefined,quantity:3,disposition:'destroyed'})]);assert.deepEqual(results.map(r=>r.response.status).sort(),[201,409]);assert.equal((await f.stock()).body.data.length,0);console.log(JSON.stringify({measurement:'brief-inventory-race',requests:2,winners:1,elapsedMs:Math.ceil(performance.now()-start)}));}finally{await f.pg.close();}
});
