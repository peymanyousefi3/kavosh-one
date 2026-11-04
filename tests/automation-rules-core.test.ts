import assert from 'node:assert/strict';
import { test } from 'node:test';
import { automationDefinition,parseCondition,evaluateCondition,ruleSample,simulateRule } from '../src/core/automation-rules.ts';

const id='11111111-1111-4111-8111-111111111111',sample=ruleSample.parse({eventType:'session.report.delayed',entityId:id,hubId:id,actorId:id,actorKind:'human',severity:'critical',occurredAt:'2026-11-04T12:00:00Z',attributes:{delay:'60',amount:'99999999999999999999999999999999999999.01',note:'Untrusted <script>alert(1)</script>'}});
test('deterministic rule comparisons use exact decimal strings, typed equality and explicit timestamp offsets',()=>{
 for(const [condition,expected] of [
  [{op:'decimal_gt',field:'attributes.amount',value:'99999999999999999999999999999999999999'},true],
  [{op:'decimal_eq',field:'attributes.delay',value:'60.000'},true],
  [{op:'eq',field:'attributes.delay',value:60},false],
  [{op:'after',field:'occurredAt',value:'2026-11-04T06:59:59-05:00'},true],
  [{op:'in',field:'actorKind',value:['human','bot']},true],
  [{op:'contains',field:'attributes.note',value:'<script>'},true]
 ] as const)assert.equal(evaluateCondition(condition,sample).matched,expected);
});
test('missing and type-invalid comparisons remain unknown even under NOT; explicit missing/exists tests are supported',()=>{
 for(const c of [{op:'not',condition:{op:'decimal_gt',field:'attributes.missing',value:'0'}},{op:'decimal_gt',field:'actorId',value:'0'},{op:'not',condition:{op:'eq',field:'attributes.missing',value:null}}]){const r=evaluateCondition(c,sample);assert.equal(r.matched,false);assert.equal(r.result,'unknown');assert.equal(r.unknownFields.length,1);}
 assert.equal(evaluateCondition({op:'missing',field:'attributes.missing'},sample).matched,true);
 assert.equal(evaluateCondition({op:'any',conditions:[{op:'exists',field:'attributes.missing'},{op:'eq',field:'severity',value:'critical'}]},sample).matched,true);
});
test('rule parser rejects code/prototype traversal, cyclic/deep/wide trees, invalid numeric coercion and oversized values before evaluation',()=>{
 for(const c of [{op:'eval',field:'severity',value:'process.exit()'},{op:'eq',field:'attributes.__proto__.polluted',value:true},{op:'decimal_gt',field:'attributes.delay',value:1},{op:'exists',field:'severity',value:true},{op:'eq',field:'severity',value:'critical',script:'DROP TABLE'}])assert.throws(()=>parseCondition(c));
 let deep:unknown={op:'exists',field:'severity'};for(let i=0;i<1000;i++)deep={op:'not',condition:deep};assert.throws(()=>parseCondition(deep),/INVALID_RULE_CONDITION/);
 const cycle:{op:string;condition?:unknown}={op:'not'};cycle.condition=cycle;assert.throws(()=>parseCondition(cycle),/INVALID_RULE_CONDITION/);
 assert.throws(()=>parseCondition({op:'all',conditions:Array(33).fill({op:'exists',field:'severity'})}));
 assert.throws(()=>parseCondition({op:'all',conditions:Array.from({length:31},()=>({op:'any',conditions:Array.from({length:6},()=>({op:'exists',field:'severity'}))}))}),/INVALID_RULE_CONDITION/);
 assert.throws(()=>parseCondition({op:'in',field:'severity',value:Array(100).fill('x'.repeat(2000))}),/RULE_CONDITION_TOO_LARGE/);
 assert.throws(()=>ruleSample.parse({...sample,attributes:JSON.parse('{"__proto__":{"polluted":true}}')}));assert.equal(({} as {polluted?:boolean}).polluted,undefined);
});
test('plain-text multilingual previews inherit critical severity and never resolve audiences, consume budgets or send messages',()=>{
 const definition=automationDefinition.parse({name:'Late report',enabled:true,trigger:{kind:'domain_event',eventTypes:['session.report.*']},condition:{op:'decimal_gte',field:'attributes.delay',value:'60'},actions:[{kind:'notify',channels:['portal','email'],audience:{kind:'actor_supervisors'},severity:'normal',title:{en:'Review {{eventType}}',fr:'Réviser {{eventType}}'},body:{en:'Record {{entityId}}'}}]});
 const p=simulateRule(definition,id,sample,'fr');assert.equal(p.eligibleByConfiguration,true);assert.equal(p.actions[0].effectiveSeverity,'critical');assert.equal(p.actions[0].title,'Réviser session.report.delayed');assert.equal(p.actions[0].body,'Record '+id);assert.equal(p.actions[0].contentType,'text/plain');assert.equal(p.queued,false);assert.equal(p.delivered,false);assert.equal(p.externalRequestMade,false);assert.equal(p.recipientAuthorizationChecked,false);
 assert.equal(simulateRule(definition,'22222222-2222-4222-8222-222222222222',sample).triggerMatched,false);
 assert.equal(simulateRule(automationDefinition.parse({...definition,trigger:{kind:'domain_event',eventTypes:['session.*']}}),id,sample).triggerMatched,true);
 for(const eventTypes of [['session'],['session**']])assert.throws(()=>automationDefinition.parse({...definition,trigger:{kind:'domain_event',eventTypes}}));
 assert.throws(()=>automationDefinition.parse({...definition,actions:[{...definition.actions[0],title:{en:'{{attributes.note}}'}}]}));
 assert.throws(()=>automationDefinition.parse({...definition,actions:[{...definition.actions[0],title:{en:'Title\r\nBcc: recipient@example.test'}}]}));
 assert.throws(()=>automationDefinition.parse({...definition,actions:[{...definition.actions[0],body:{en:' \n '}}]}));
 assert.throws(()=>automationDefinition.parse({...definition,execution:{...definition.execution,maxChainDepth:4}}));
});
