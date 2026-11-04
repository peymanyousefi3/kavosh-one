import assert from 'node:assert/strict';
import { expenseFixture } from './expense-fixture.ts';

export async function inventoryFixture(){
 const f=await expenseFixture();
 try{
 const item=await f.made('inventory/items',{code:'ROBOT',definition:{name:'Bulk robot kits',tracking:'bulk'},reason:'Synthetic stock catalogue'});
 const location=await f.made('inventory/locations',{hubId:f.hub,code:'ROOM-A',definition:{name:'Hub A robotics room',custodianId:f.actors.staff.person},reason:'Synthetic physical location'});
 const other=await f.made('inventory/locations',{hubId:f.otherHub,code:'ROOM-B',definition:{name:'Hub B robotics room'},reason:'Synthetic physical location'});
 const b=await f.bill({issuedOn:'2026-10-01',postedOn:'2026-10-01'});assert.equal(b.response.status,201,JSON.stringify(b.body));
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['inventory.view','inventory.edit','expenses.view'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,role,cap]);
 const input={kind:'receive',item:{id:item.id,version:1},billId:b.body.data.id,billLine:1,quantity:3,costMinor:'10650',purchasedAt:'2026-10-01T10:00:00Z',purchasedById:f.actors.staff.person,to:{id:location.id,version:1},occurredAt:'2026-11-01T10:00:00Z',reason:'Private physical purchase receipt'};
 const receive=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request('inventory/movements',{...input,...patch},as,{key});
 const stock=(id=location.id,as='master')=>f.request('inventory/locations/'+id+'/stock',undefined,as);
 const move=(lotId:string,patch:Record<string,unknown>={},as='master',key?:string)=>f.request('inventory/movements',{kind:'transfer',lotId,quantity:1,from:input.to,to:{id:other.id,version:1},occurredAt:'2026-11-02T10:00:00Z',reason:'Private physical transfer',...patch},as,{key});
 return {...f,item,location,other,purchase:b.body.data,input,receive,stock,move};
 }catch(error){await f.pg.close();throw error;}
}
