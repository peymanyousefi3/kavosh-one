import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationsFixture } from './operations-fixture.ts';
import { automationDefinition,simulateRule,ruleSample } from '../src/core/automation-rules.ts';
export async function notificationFixture(options:{throughSchema?:number}={}){const f=await operationsFixture(options);try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['automations.view','automations.edit','automations.execute'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const definition={name:'Case update',enabled:true,trigger:{kind:'domain_event',eventTypes:['approval.requested']},condition:{op:'exists',field:'entityId'},actions:[{kind:'notify',channels:['portal'],audience:{kind:'people',personIds:[f.actors.staff.person,f.actors.manager.person]},title:{en:'Review {{entityId}}',fr:'Vérifier {{entityId}}'},body:{en:'Event {{eventType}}'}}],execution:{mode:'automatic',maxRecipientsPerEvent:100,maxDailyDeliveries:100,maxDailySms:0,cooldownSeconds:0,maxChainDepth:1}};
 async function rule(patch:Record<string,unknown>={},code='NOTICES'){const r=await f.request('automations/rules',{hubId:f.hub,code,definition:{...definition,...patch},reason:'Approved notification policy'});assert.equal(r.response.status,201,JSON.stringify(r.body));return r.body.data;}
 async function source(){const p=await f.request('automations/rules',{hubId:f.hub,code:'SOURCE_'+randomUUID().replaceAll('-','').toUpperCase(),definition,reason:'Pending source'},'staff');assert.equal(p.response.status,202,JSON.stringify(p.body));
  if(options.throughSchema&&options.throughSchema<244){const e=(await f.pg.query<{event_id:string;projection:unknown}>('SELECT event_id,projection FROM public.automation_event_sources WHERE approval_id=$1',[p.body.approval.id])).rows[0];assert.ok(e);return {id:e.event_id,sample:e.projection};}
  const e=await f.request('automations/events?approvalId='+p.body.approval.id);assert.equal(e.response.status,200,JSON.stringify(e.body));return e.body.data[0];}
 async function dispatch(ruleId:string,eventId:string,as='master',key?:string,extra:Record<string,unknown>={}){
  if(!options.throughSchema||options.throughSchema>62)return f.request('automations/rules/'+ruleId+'/dispatch',{eventId,expectedVersion:1,...extra},as,{key});
  // Historical migration fixtures use that schema's actual native run/message
  // protocol,not a current API requiring later source types. No schema spoofing
  // or production fallback;this is preservation evidence,not transport testing.
  const r=(await f.pg.query<{definition:unknown}>('SELECT definition FROM public.automation_rule_revisions WHERE rule_id=$1 AND version=1',[ruleId])).rows[0],e=(await f.pg.query<{projection:unknown}>('SELECT projection FROM public.automation_event_sources WHERE event_id=$1',[eventId])).rows[0],sim=simulateRule(automationDefinition.parse(r.definition),f.hub,ruleSample.parse(e.projection));assert.equal(sim.eligibleByConfiguration,true);assert.equal(sim.execution.mode,'automatic');assert.equal(sim.actions.length,1);const action=sim.actions[0];assert.equal(action.audience.kind,'people');if(action.audience.kind!=='people')throw new Error('UNSUPPORTED_HISTORICAL_FIXTURE');const runId=randomUUID(),actor=f.actors[as];assert.ok(actor);await f.pg.exec('BEGIN');try{await f.pg.exec('SET LOCAL ROLE kavosh_runtime');await f.pg.query("SELECT set_config('app.academy_id',$1,true)",[f.a]);
   await f.pg.query("INSERT INTO public.automation_runs(academy_id,id,rule_id,rule_version,event_id,actor_id,outcome,summary) VALUES($1,$2,$3,1,$4,$5,'processed',$6::jsonb)",[f.a,runId,ruleId,eventId,actor.person,JSON.stringify({portalNotifications:action.audience.personIds.length})]);
   for(const person of action.audience.personIds)await f.pg.query('INSERT INTO public.portal_notifications(academy_id,id,run_id,rule_id,event_id,person_id,action_index,severity,title,body,locale) VALUES($1,$2,$3,$4,$5,$6,0,$7,$8,$9,\'en\')',[f.a,randomUUID(),runId,ruleId,eventId,person,action.effectiveSeverity,action.title,action.body]);
   await f.pg.exec('COMMIT');return {response:new Response(null,{status:201}),body:{data:{id:runId}}};
  }catch(error){await f.pg.exec('ROLLBACK');throw error;}
 }
 return {...f,definition,rule,source,dispatch};
}catch(error){await f.pg.close();throw error;}}
