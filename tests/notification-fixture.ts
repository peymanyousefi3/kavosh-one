import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationsFixture } from './operations-fixture.ts';
export async function notificationFixture(options:{throughSchema?:number}={}){const f=await operationsFixture(options);try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['automations.view','automations.edit','automations.execute'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const definition={name:'Case update',enabled:true,trigger:{kind:'domain_event',eventTypes:['approval.requested']},condition:{op:'exists',field:'entityId'},actions:[{kind:'notify',channels:['portal'],audience:{kind:'people',personIds:[f.actors.staff.person,f.actors.manager.person]},title:{en:'Review {{entityId}}',fr:'Vérifier {{entityId}}'},body:{en:'Event {{eventType}}'}}],execution:{mode:'automatic',maxRecipientsPerEvent:100,maxDailyDeliveries:100,maxDailySms:0,cooldownSeconds:0,maxChainDepth:1}};
 async function rule(patch:Record<string,unknown>={},code='NOTICES'){const r=await f.request('automations/rules',{hubId:f.hub,code,definition:{...definition,...patch},reason:'Approved notification policy'});assert.equal(r.response.status,201,JSON.stringify(r.body));return r.body.data;}
 async function source(){const p=await f.request('automations/rules',{hubId:f.hub,code:'SOURCE_'+randomUUID().replaceAll('-','').toUpperCase(),definition,reason:'Pending source'},'staff');assert.equal(p.response.status,202,JSON.stringify(p.body));const e=await f.request('automations/events?approvalId='+p.body.approval.id);assert.equal(e.response.status,200,JSON.stringify(e.body));return e.body.data[0];}
 async function dispatch(ruleId:string,eventId:string,as='master',key?:string,extra:Record<string,unknown>={}){return f.request('automations/rules/'+ruleId+'/dispatch',{eventId,expectedVersion:1,...extra},as,{key});}
 return {...f,definition,rule,source,dispatch};
}catch(error){await f.pg.close();throw error;}}
