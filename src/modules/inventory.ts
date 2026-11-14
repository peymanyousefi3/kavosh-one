import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope,propose,master,type ApprovalRegistry,type ApprovalAction,type Proposal } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,type Capability } from '../core/policy.ts';
import { readMinorUnits,formatMoney,roundRatio } from '../core/money.ts';
import { lockFinanceBook } from '../core/finance-lock.ts';
import { lockAcademyTopology } from './academy.ts';
import { expenseBillRow } from './expenses.ts';
import { permittedFile } from './files.ts';
import { permittedPerson } from './students.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive().max(2147483647),text=z.string().refine(v=>v.isWellFormed()&&!v.includes('\0')),name=text.trim().min(1).max(200),reason=text.trim().min(1).max(2000),ref=z.object({id:uuid,version}).strict();
const itemDefinition=z.object({name,active:z.boolean().default(true),tracking:z.enum(['bulk','individual']),unit:name.default('piece'),photo:ref.nullable().default(null)}).strict();
const locationDefinition=z.object({name,active:z.boolean().default(true),description:text.trim().max(1000).default(''),custodianId:uuid.nullable().default(null)}).strict();
const catalogueBase={hubId:uuid.nullable().default(null),code:z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/),reason};
const createItem=z.object({...catalogueBase,definition:itemDefinition}).strict(),createLocation=z.object({...catalogueBase,definition:locationDefinition}).strict();
const changeItem=z.object({expectedVersion:version,definition:itemDefinition,reason}).strict(),changeLocation=z.object({expectedVersion:version,definition:locationDefinition,reason}).strict();
const instant=z.iso.datetime({offset:true}).max(40).refine(v=>!/[.]\d{4}/.test(v)),quantity=z.number().int().min(1).max(1000000000),minor=z.string().regex(/^\d{1,38}$/);
const receive=z.object({item:ref,billId:uuid,billLine:z.number().int().min(1).max(50),quantity,costMinor:minor,serialNumber:name.nullable().default(null),purchasedAt:instant,purchasedById:uuid.nullable().default(null),to:ref,occurredAt:instant,reason}).strict().refine(v=>Date.parse(v.purchasedAt)<=Date.parse(v.occurredAt));
const move=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('transfer'),lotId:uuid,quantity,from:ref,to:ref,occurredAt:instant,reason}).strict(),
 z.object({kind:z.literal('dispose'),lotId:uuid,quantity,from:ref,disposition:z.enum(['destroyed','stolen','lost','consumed','sold','returned']),occurredAt:instant,reason}).strict(),
 z.object({kind:z.literal('restore'),lotId:uuid,quantity,to:ref,restoresId:uuid,occurredAt:instant,reason}).strict()
]);
const paging={limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional()};
const catalogQuery=z.object({...paging,hubId:uuid.optional(),q:name.optional(),active:z.enum(['true','false']).transform(v=>v==='true').optional()}).strict();
const historyQuery=z.object({limit:paging.limit,afterVersion:z.coerce.number().int().min(0).default(0)}).strict();
const stockQuery=z.object({...paging,itemId:uuid.optional()}).strict(),movementQuery=z.object({...paging,lotId:uuid.optional(),locationId:uuid.optional(),from:instant.optional(),through:instant.optional()}).strict().refine(v=>!v.from||!v.through||Date.parse(v.from)<=Date.parse(v.through));
type Kind='item'|'location';
type Catalogue={id:string;kind:Kind;hub_id:string|null;code:string;version:number;definition:Record<string,unknown>};
type Lot={id:string;item_id:string;item_version:number;quantity:string;cost_minor:string;currency_id:string;unit_scale:number;received_at:Date|string;serial_number:string|null};
function allowed(ctx:ApiContext,cap:Capability){const s=permissionScope(ctx,cap);if(!scopeNonempty(s))throw new ApiError(403,'FORBIDDEN');return s;}
function params(ctx:ApiContext,cap:Capability='inventory.view'){const s=allowed(ctx,cap);return [s.all,s.hubs,s.excludedHubs??[],!s.excludedAreas?.length];}
// Code-owned aliases only. NULL hub is shared catalogue selection for items,
// but school-wide physical stock requires unqualified school permission.
function permitted(alias:string,start=1,shared=false){return `((${alias}.hub_id IS NULL AND ${shared?`$${start+3}::boolean IS NOT NULL`:`$${start}::boolean AND cardinality($${start+2}::uuid[])=0 AND $${start+3}::boolean`}) OR(${alias}.hub_id IS NOT NULL AND($${start}::boolean OR ${alias}.hub_id=ANY($${start+1}::uuid[])) AND NOT ${alias}.hub_id=ANY($${start+2}::uuid[])))`;}
async function catalogue(ctx:ApiContext,kind:Kind,id:string,edit=false){
 const c=(await ctx.db.query<Catalogue>(`SELECT c.id,c.kind,c.hub_id,c.code,c.version,r.definition FROM public.inventory_catalogue c JOIN public.inventory_catalogue_revisions r ON r.academy_id=c.academy_id AND r.entry_id=c.id AND r.version=c.version WHERE c.kind=$5 AND c.id=$6 AND ${permitted('c',1,kind==='item')}`,[...params(ctx),kind,id])).rows[0];
 if(!c)throw new ApiError(404,'NOT_FOUND');if(edit)requireScope(allowed(ctx,'inventory.edit'),c.hub_id??undefined);return c;
}
async function catalogueAuthority(ctx:ApiContext,kind:Kind,creating:boolean,id:string,raw:unknown){
 const input=creating?(kind==='item'?createItem:createLocation).parse(raw):(kind==='item'?changeItem:changeLocation).parse(raw),before=creating?null:await catalogue(ctx,kind,id,true),hub=before?before.hub_id:('hubId' in input?input.hubId:null);
 requireScope(allowed(ctx,'inventory.view'),hub??undefined);requireScope(allowed(ctx,'inventory.edit'),hub??undefined);
 return {input,before,hub,scope:hub?{all:false,hubs:[hub]}:{all:true,hubs:[]}};
}
async function catalogueBasis(ctx:ApiContext,kind:Kind,creating:boolean,id:string,raw:unknown){
 const {input,before,hub,scope}=await catalogueAuthority(ctx,kind,creating,id,raw);
 if(before&&'expectedVersion' in input&&before.version!==input.expectedVersion)throw new ApiError(409,'INVENTORY_CATALOGUE_CHANGED');
 const h=hub?(await ctx.db.query('SELECT id,active,version FROM public.hubs WHERE id=$1',[hub])).rows[0]:null;if(hub&&!h?.active)throw new ApiError(409,'ACTIVE_INVENTORY_HUB_REQUIRED');
 const definition=input.definition;
 if('photo' in definition&&definition.photo){const f=await permittedFile(ctx,definition.photo.id);if(f.domain!=='general'||!f.claimed_mime_type.startsWith('image/')||f.archived||f.version!==definition.photo.version||(f.anchor_kind!=='academy'&&!(f.anchor_kind==='hub'&&f.hub_id===hub)))throw new ApiError(409,'INVENTORY_PHOTO_INVALID');}
 const custodian='custodianId' in definition&&definition.custodianId?await permittedPerson(ctx,definition.custodianId,'people.view'):null;
 if(custodian&&(custodian.kind!=='human'||custodian.status!=='active'))throw new ApiError(409,'ACTIVE_HUMAN_CUSTODIAN_REQUIRED');
 return {before,hub:h,custodian:custodian?{id:custodian.id,hubId:custodian.hub_id}:null,scope};
}
async function catalogueApply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const [,kindName,action]=p.action.split('.'),kind=kindName as Kind,creating=action==='create',input=creating?(kind==='item'?createItem:createLocation).parse(p.payload):(kind==='item'?changeItem:changeLocation).parse(p.payload),b=await catalogueBasis(ctx,kind,creating,p.target_id,input),v=(b.before?.version??0)+1;
 if(b.before&&b.before.version!==p.target_version)throw new ApiError(409,'INVENTORY_CATALOGUE_CHANGED');
 if(creating&&'hubId' in input)await ctx.db.query('INSERT INTO public.inventory_catalogue(academy_id,id,kind,hub_id,code) VALUES($1,$2,$3,$4,$5)',[ctx.credential.academy_id,p.target_id,kind,input.hubId,input.code]);else if(!(await ctx.db.query('UPDATE public.inventory_catalogue SET version=$2 WHERE id=$1 AND version=$3 RETURNING id',[p.target_id,v,p.target_version])).rows.length)throw new ApiError(409,'INVENTORY_CATALOGUE_CHANGED');
 await ctx.db.query('INSERT INTO public.inventory_catalogue_revisions(academy_id,entry_id,version,definition,changed_by,approval_id,reason) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)',[ctx.credential.academy_id,p.target_id,v,JSON.stringify(input.definition),ctx.credential.person_id,p.id,input.reason]);
 await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,b.before?.hub_id??('hubId' in input?input.hubId:null),{version:v,approvalId:p.id,severity:'critical',hasReason:true});return catalogue(ctx,kind,p.target_id);
}
async function lot(ctx:ApiContext,id:string){const l=(await ctx.db.query<Lot>('SELECT id,item_id,item_version,quantity::text,cost_minor::text,currency_id,unit_scale,received_at,serial_number FROM public.inventory_lots WHERE id=$1',[id])).rows[0];if(!l)throw new ApiError(404,'NOT_FOUND');return l;}
async function locationRef(ctx:ApiContext,r:z.infer<typeof ref>,outgoing=false){const c=await catalogue(ctx,'location',r.id,true);if(c.version!==r.version||(!outgoing&&c.definition.active!==true))throw new ApiError(409,'INVENTORY_LOCATION_CHANGED');return {id:c.id,version:c.version,hubId:c.hub_id};}
async function available(ctx:ApiContext,lotId:string,locationId:string,at:string){return readMinorUnits((await ctx.db.query<{quantity:string}>('SELECT public.inventory_available($1,$2,$3)::text AS quantity',[lotId,locationId,at])).rows[0].quantity);}
async function stockAuthority(ctx:ApiContext,receiving:boolean,raw:unknown){
 const input=receiving?receive.parse(raw):move.parse(raw),hubs:(string|null)[]=[];allowed(ctx,'inventory.view');allowed(ctx,'inventory.edit');
 if(receiving)await lockFinanceBook(ctx);await lockAcademyTopology(ctx);
 for(const r of [...'from' in input?[input.from]:[],...'to' in input?[input.to]:[]])hubs.push((await catalogue(ctx,'location',r.id,true)).hub_id);
 if('item' in input){const item=await catalogue(ctx,'item',input.item.id);if(item.hub_id!==null)hubs.push(item.hub_id);await expenseBillRow(ctx,input.billId);}
 else if(input.kind==='restore'){
  const original=(await ctx.db.query<{from_location:string}>('SELECT from_location FROM public.inventory_movements WHERE id=$1 AND kind=\'dispose\' AND lot_id=$2',[input.restoresId,input.lotId])).rows[0];
  if(!original)throw new ApiError(409,'INVENTORY_DISPOSAL_REQUIRED');hubs.push((await catalogue(ctx,'location',original.from_location,true)).hub_id);
 }
 return hubs.includes(null)?{all:true,hubs:[]}:{all:false,hubs:[...new Set(hubs as string[])].sort()};
}
async function stockBasis(ctx:ApiContext,receiving:boolean,raw:unknown,lock=false):Promise<Record<string,unknown>&{from:Awaited<ReturnType<typeof locationRef>>|null;to:Awaited<ReturnType<typeof locationRef>>|null}>{
 const input=receiving?receive.parse(raw):move.parse(raw);allowed(ctx,'inventory.view');allowed(ctx,'inventory.edit');
 if(receiving)await lockFinanceBook(ctx);await lockAcademyTopology(ctx);
 const from='from' in input?await locationRef(ctx,input.from,true):null,to='to' in input?await locationRef(ctx,input.to):null;
 if(from&&to&&from.id===to.id)throw new ApiError(400,'INVENTORY_DISTINCT_LOCATIONS_REQUIRED');
 const now=(await ctx.db.query<{at:Date|string}>('SELECT clock_timestamp() AS at')).rows[0].at;if(Date.parse(input.occurredAt)>new Date(now).getTime())throw new ApiError(409,'FUTURE_INVENTORY_EVENT_FORBIDDEN');
 let details:Record<string,unknown>;
 if('item' in input){
  const item=await catalogue(ctx,'item',input.item.id);
  if(item.version!==input.item.version||item.definition.active!==true||(item.definition.tracking==='individual'&&(input.quantity!==1||input.serialNumber===null))||(item.definition.tracking==='bulk'&&input.serialNumber!==null))throw new ApiError(409,'INVENTORY_ITEM_CHANGED');
  const b=await expenseBillRow(ctx,input.billId);if(lock)await ctx.db.query('SELECT id FROM public.expense_bills WHERE id=$1 FOR UPDATE',[b.id]);
  if(b.void_id)throw new ApiError(409,'VOIDED_INVENTORY_PURCHASE');
  const l=(await ctx.db.query<{gross_minor:string;recoverable_minor:string}>('SELECT gross_minor::text,recoverable_minor::text FROM public.expense_bill_lines WHERE bill_id=$1 AND line_number=$2',[b.id,input.billLine])).rows[0];if(!l)throw new ApiError(404,'NOT_FOUND');
  const used=(await ctx.db.query<{cost:string}>('SELECT coalesce(sum(cost_minor),0)::text AS cost FROM public.inventory_lots WHERE bill_id=$1 AND bill_line=$2',[b.id,input.billLine])).rows[0].cost;
  if(readMinorUnits(input.costMinor)+readMinorUnits(used)>readMinorUnits(l.gross_minor)-readMinorUnits(l.recoverable_minor))throw new ApiError(409,'INVENTORY_PURCHASE_COST_EXCEEDED');
  if(input.serialNumber&&(await ctx.db.query('SELECT 1 FROM public.inventory_lots WHERE item_id=$1 AND serial_number=$2',[item.id,input.serialNumber])).rows.length)throw new ApiError(409,'INVENTORY_SERIAL_EXISTS');
  if(input.purchasedById&&(await permittedPerson(ctx,input.purchasedById,'people.view')).kind!=='human')throw new ApiError(409,'HUMAN_PURCHASER_REQUIRED');
  details={item:{id:item.id,version:item.version},bill:{id:b.id,voidId:b.void_id,currencyId:b.currency_id,unitScale:b.unit_scale,line:input.billLine,usedCostMinor:used}};
 }else{
  if(lock)await ctx.db.query('SELECT public.lock_inventory_lot($1)',[input.lotId]);const l=await lot(ctx,input.lotId);
  if(Date.parse(input.occurredAt)<new Date(l.received_at).getTime())throw new ApiError(409,'INVENTORY_EVENT_PRECEDES_RECEIPT');
  if(from&&BigInt(input.quantity)>await available(ctx,l.id,from.id,input.occurredAt))throw new ApiError(409,'INVENTORY_QUANTITY_UNAVAILABLE');
  let restore=null;
  if(input.kind==='restore'){
   const original=(await ctx.db.query<{id:string;kind:string;lot_id:string;quantity:string;from_location:string;occurred_at:Date|string}>('SELECT id,kind,lot_id,quantity::text,from_location,occurred_at FROM public.inventory_movements WHERE id=$1',[input.restoresId])).rows[0];
   if(!original||original.kind!=='dispose'||original.lot_id!==l.id)throw new ApiError(409,'INVENTORY_DISPOSAL_REQUIRED');
   await catalogue(ctx,'location',original.from_location,true);
   const restored=(await ctx.db.query<{n:string}>('SELECT coalesce(sum(quantity),0)::text AS n FROM public.inventory_movements WHERE restores_id=$1',[original.id])).rows[0].n;
   if(BigInt(input.quantity)+BigInt(restored)>BigInt(original.quantity)||Date.parse(input.occurredAt)<new Date(original.occurred_at).getTime())throw new ApiError(409,'INVENTORY_RESTORE_EXCEEDED');restore={id:original.id,restored};
  }
  // Activity count prevents an ABA stock change from reviving old approval.
  const activity=(await ctx.db.query<{n:string}>('SELECT count(*)::text AS n FROM public.inventory_movements WHERE lot_id=$1',[l.id])).rows[0].n;
  details={lot:l,activity,restore};
 }
 return {from,to,...details};
}
function state(value:Record<string,unknown>){const {scope,...rest}=value;return JSON.parse(JSON.stringify(rest));}
async function stockApply(ctx:ApiContext,p:Proposal){
 if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');const receiving=p.action==='inventory.receive',input=receiving?receive.parse(p.payload):move.parse(p.payload),b=await stockBasis(ctx,receiving,input,true);
 if(!isDeepStrictEqual(state(b),p.review_context))throw new ApiError(409,'INVENTORY_SOURCE_CHANGED');
 let lotId:string;
 if('item' in input){lotId=p.target_id;const bill=b.bill as {currencyId:string;unitScale:number};await ctx.db.query('INSERT INTO public.inventory_lots(academy_id,id,item_id,item_version,bill_id,bill_line,quantity,cost_minor,currency_id,unit_scale,serial_number,purchased_at,purchased_by,received_at,approval_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',[ctx.credential.academy_id,lotId,input.item.id,input.item.version,input.billId,input.billLine,input.quantity,input.costMinor,bill.currencyId,bill.unitScale,input.serialNumber,input.purchasedAt,input.purchasedById,input.occurredAt,p.id,ctx.credential.person_id]);}else lotId=input.lotId;
 await ctx.db.query('INSERT INTO public.inventory_movements(academy_id,id,lot_id,kind,quantity,from_location,from_version,to_location,to_version,occurred_at,disposition,restores_id,reason,approval_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
  [ctx.credential.academy_id,p.target_id,lotId,receiving?'receive':('kind' in input?input.kind:''),input.quantity,b.from?.id??null,b.from?.version??null,b.to?.id??null,b.to?.version??null,input.occurredAt,'disposition' in input?input.disposition:null,'restoresId' in input?input.restoresId:null,input.reason,p.id,ctx.credential.person_id]);
 await record(ctx.db,ctx.credential,ctx.requestId,p.action,p.target_id,b.to?.hubId??b.from?.hubId??null,{approvalId:p.id,severity:'critical',hasReason:true,additionalLedgerPosting:false});
 return {id:p.target_id,lotId,kind:receiving?'receive':('kind' in input?input.kind:''),quantity:input.quantity,additionalLedgerPosting:false,formalAssetCapitalization:false};
}
export const inventoryActions:Record<string,ApprovalAction>={};
for(const kind of ['item','location'] as const)for(const creating of [true,false])inventoryActions['inventory.'+kind+(creating?'.create':'.change')]={requestCapability:'inventory.edit',privacyCapability:'inventory.view',createdStatus:creating?201:200,
 async validate(ctx,id,input){await lockAcademyTopology(ctx);return(await catalogueAuthority(ctx,kind,creating,id,input)).scope;},
 async dependencies(ctx,id,input,purpose){try{return state(await catalogueBasis(ctx,kind,creating,id,input));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},apply:catalogueApply};
for(const kind of ['receive','transfer','dispose','restore'])inventoryActions['inventory.'+kind]={requestCapability:'inventory.edit',privacyCapability:'inventory.view',createdStatus:201,
 async validate(ctx,id,input){return stockAuthority(ctx,kind==='receive',input);},
 async dependencies(ctx,id,input,purpose){try{return state(await stockBasis(ctx,kind==='receive',input));}catch(error){if(purpose==='review'&&error instanceof ApiError&&[403,404,409].includes(error.status))return {unavailable:error.code};throw error;}},
 async authorizeReviewer(ctx,p){if(await master(ctx))return;if(p.action==='inventory.receive'){const input=receive.parse(p.payload);if((await ctx.db.query('SELECT 1 FROM public.expense_bills b JOIN public.financial_payees x ON x.academy_id=b.academy_id AND x.id=b.payee_id WHERE b.id=$1 AND x.person_id=$2',[input.billId,ctx.credential.person_id])).rows.length)throw new ApiError(403,'BENEFICIARY_REVIEW_FORBIDDEN');}},apply:stockApply};

export async function inventory(ctx:ApiContext,registry:ApprovalRegistry=inventoryActions):Promise<Reply|null>{
 const catalog=/^inventory\/(items|locations)(?:\/([^/]+)(?:\/(change|history|stock))?)?$/.exec(ctx.path),movements=/^inventory\/movements(?:\/([^/]+))?$/.exec(ctx.path);
 if(!catalog&&!movements)return null;
 if(catalog){const kind:Kind=catalog[1]==='items'?'item':'location',id=catalog[2]?uuid.parse(catalog[2]):null,section=catalog[3];
  if(ctx.request.method==='POST'){if(id&&section!=='change')throw new ApiError(405,'METHOD_NOT_ALLOWED');const schema=id?(kind==='item'?changeItem:changeLocation):(kind==='item'?createItem:createLocation),input=schema.parse(await jsonBody(ctx.request));return propose(ctx,registry,'inventory.'+kind+(id?'.change':'.create'),id,'expectedVersion' in input?input.expectedVersion:0,input);}
  if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');
  if(id){const c=await catalogue(ctx,kind,id,section==='history');
   if(section==='stock'&&kind==='location'){
    const q=stockQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
    const rows=(await ctx.db.query<{id:string;quantity:string;cost_minor:string;original_quantity:string;unit_scale:number;purchase_source_voided:boolean;item_name:string;item_unit:string|null;item_tracking:'bulk'|'individual'}>(`SELECT l.id,l.item_id,l.item_version,l.serial_number,l.purchased_at,l.purchased_by,(b.void_id IS NOT NULL) AS purchase_source_voided,l.quantity::text AS original_quantity,l.cost_minor::text,l.unit_scale,c.code AS currency,r.definition->>'name' AS item_name,r.definition->>'unit' AS item_unit,r.definition->>'tracking' AS item_tracking,s.quantity::text FROM(SELECT lot_id,sum(quantity) AS quantity FROM public.inventory_deltas WHERE location_id=$1 GROUP BY lot_id HAVING sum(quantity)>0) s JOIN public.inventory_lots l ON l.academy_id=$2 AND l.id=s.lot_id JOIN public.expense_bills b ON b.academy_id=l.academy_id AND b.id=l.bill_id JOIN public.inventory_catalogue_revisions r ON r.academy_id=l.academy_id AND r.entry_id=l.item_id AND r.version=l.item_version JOIN public.finance_currencies c ON c.academy_id=l.academy_id AND c.id=l.currency_id WHERE($3::uuid IS NULL OR l.id>$3) AND($4::uuid IS NULL OR l.item_id=$4) ORDER BY l.id LIMIT $5`,[id,ctx.credential.academy_id,q.after??null,q.itemId??null,q.limit+1])).rows;
    return {status:200,body:{locationId:id,data:rows.slice(0,q.limit).map(r=>({...r,valueNumeratorMinor:r.purchase_source_voided?null:(readMinorUnits(r.cost_minor)*BigInt(r.quantity)).toString(),valuationReviewRequired:r.purchase_source_voided,valueDenominator:r.original_quantity,roundedManagementValue:r.purchase_source_voided?null:formatMoney(roundRatio(readMinorUnits(r.cost_minor)*BigInt(r.quantity),BigInt(r.original_quantity),'half_away'),r.unit_scale)})),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null,valueBasis:'purchase_cost_excluding_declared_recoverable_tax',roundedPerLot:true,formalBalanceSheetAsset:false,additionalLedgerPosting:false}};
   }
   if(section==='history'){const q=historyQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<{version:number}>('SELECT version,definition,reason,changed_by,approval_id,created_at FROM public.inventory_catalogue_revisions WHERE entry_id=$1 AND version>$2 ORDER BY version LIMIT $3',[id,q.afterVersion,q.limit+1])).rows;return {status:200,body:{data:rows.slice(0,q.limit),nextVersion:rows.length>q.limit?rows[q.limit-1].version:null}};}
   if(section)throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));return {status:200,body:{data:c}};
  }
  const q=catalogQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams)),rows=(await ctx.db.query<Catalogue>(`SELECT c.id,c.kind,c.hub_id,c.code,c.version,r.definition FROM public.inventory_catalogue c JOIN public.inventory_catalogue_revisions r ON r.academy_id=c.academy_id AND r.entry_id=c.id AND r.version=c.version WHERE c.kind=$5 AND ${permitted('c',1,kind==='item')} AND($6::uuid IS NULL OR c.id>$6) AND($7::uuid IS NULL OR c.hub_id=$7) AND($8::boolean IS NULL OR(r.definition->>'active')::boolean=$8) AND($9::text IS NULL OR position(lower($9) in lower(c.code||' '||(r.definition->>'name')))>0) ORDER BY c.id LIMIT $10`,[...params(ctx),kind,q.after??null,q.hubId??null,q.active??null,q.q??null,q.limit+1])).rows;
  return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
 }
 if(ctx.request.method==='POST'&&!movements![1]){const raw=await jsonBody(ctx.request),input=z.object({kind:z.literal('receive')}).passthrough().safeParse(raw);if(input.success){const {kind,...rest}=input.data;return propose(ctx,registry,'inventory.receive',null,0,receive.parse(rest));}const parsed=move.parse(raw);return propose(ctx,registry,'inventory.'+parsed.kind,null,0,parsed);}
 if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const id=movements![1]?uuid.parse(movements![1]):null,q=movementQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
 const filter=`NOT EXISTS(SELECT 1 FROM public.inventory_catalogue c WHERE c.academy_id=m.academy_id AND c.id IN(m.from_location,m.to_location) AND NOT ${permitted('c')})`;
 const rows=(await ctx.db.query<{id:string}>(`SELECT m.id,m.lot_id,m.kind,m.quantity::text,m.from_location,m.from_version,m.to_location,m.to_version,m.occurred_at,m.disposition,m.restores_id,m.reason,m.approval_id,m.created_by,m.created_at FROM public.inventory_movements m WHERE ${filter} AND($5::uuid IS NULL OR m.id=$5) AND($6::uuid IS NULL OR m.id>$6) AND($7::uuid IS NULL OR m.lot_id=$7) AND($8::uuid IS NULL OR $8 IN(m.from_location,m.to_location)) AND($9::timestamptz IS NULL OR m.occurred_at>=$9) AND($10::timestamptz IS NULL OR m.occurred_at<=$10) ORDER BY m.id LIMIT $11`,[...params(ctx),id,q.after??null,q.lotId??null,q.locationId??null,q.from??null,q.through??null,id?1:q.limit+1])).rows;
 if(id){if(!rows.length)throw new ApiError(404,'NOT_FOUND');return {status:200,body:{data:rows[0]}};}return {status:200,body:{data:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null}};
}
export const inventoryContract=[
 {path:'/api/v1/inventory/items',method:'get',summary:'Scoped equipment catalogue; shared item labels grant no school-wide stock access',querySchema:catalogQuery},
 {path:'/api/v1/inventory/items',method:'post',summary:'Request individual/serial or bulk equipment catalogue definition with optional protected photo reference',schema:createItem},
 {path:'/api/v1/inventory/items/{id}',method:'get',summary:'Read a permitted current equipment definition'},
 {path:'/api/v1/inventory/items/{id}/change',method:'post',summary:'Request versioned equipment definition replacement; purchase lots retain pinned revisions',schema:changeItem},
 {path:'/api/v1/inventory/items/{id}/history',method:'get',summary:'Editor-only immutable item definition and review history',querySchema:historyQuery},
 {path:'/api/v1/inventory/locations',method:'get',summary:'Permitted hub/room or school-wide stock locations only',querySchema:catalogQuery},
 {path:'/api/v1/inventory/locations',method:'post',summary:'Request named physical location and optional human custodian',schema:createLocation},
 {path:'/api/v1/inventory/locations/{id}',method:'get',summary:'Read authorized location and custodian reference'},
 {path:'/api/v1/inventory/locations/{id}/change',method:'post',summary:'Request versioned location/custodian status without rewriting stock movements',schema:changeLocation},
 {path:'/api/v1/inventory/locations/{id}/history',method:'get',summary:'Editor-only location revisions',querySchema:historyQuery},
 {path:'/api/v1/inventory/locations/{id}/stock',method:'get',summary:'Current usable quantities with the original lot-edition item name,unit and tracking plus exact rational purchase-cost value and explicitly rounded management display; no new expense or formal capitalization',querySchema:stockQuery},
 {path:'/api/v1/inventory/movements',method:'get',summary:'Whole-endpoint permission intersection before pagination; immutable dated receipt/transfer/disposal/restore history',querySchema:movementQuery},
 {path:'/api/v1/inventory/movements',method:'post',summary:'Request an expense-backed purchase receipt with declared purchase time/buyer, or exact stock movement; disposal retains original expense and restores require a real prior disposal',schema:z.union([receive.safeExtend({kind:z.literal('receive')}),move])},
 {path:'/api/v1/inventory/movements/{id}',method:'get',summary:'Read authorized complete stock movement without supplier invoice or unrelated bank/ledger details'}
] as const;
