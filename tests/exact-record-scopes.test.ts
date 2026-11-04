import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scopeContains,type Scope } from '../src/core/policy.ts';
import { operationsFixture } from './operations-fixture.ts';

test('exact-record class/person/hub containment agrees in application and native SQL without granting bundles or bypassing denials',async()=>{
 const f=await operationsFixture();try{const hub=f.hub,other=f.otherHub,classId=f.actors.manager.person,studentId=f.actors.staff.person,context={hubId:hub,classId,studentId},target:Scope={all:false,hubs:[],people:[{id:studentId,hubId:hub}],recordContext:context},source:Scope={all:false,hubs:[],classes:[{id:classId,hubId:hub}]};
 const cases:[Scope,Scope,boolean][]=[
 [source,target,true],[{all:false,hubs:[hub]},target,true],[{all:false,hubs:[],people:[{id:studentId,hubId:hub}]},target,true],[{all:true,hubs:[]},target,true],
 [{...source,excludedHubs:[hub]},target,false],[{...source,excludedClasses:[{id:classId,hubId:hub}]},target,false],[{...source,excludedPeople:[{id:studentId,hubId:hub}]},target,false],
 [source,{...target,people:[...target.people!,{id:f.actors.peer.person,hubId:other}]},false],[source,{...target,hubs:[other]},false],[source,{all:false,hubs:[hub]},false],
 [{...source,recordContext:context},{all:false,hubs:[hub]},false],[{...source,recordContext:{...context,studentId:f.actors.peer.person}},target,false],[source,{...target,all:true},false],[source,{all:false,hubs:[],recordContext:context},true]
 ];cases.push([{all:false,hubs:[hub],recordContext:context},{...target,people:[...target.people!,{id:f.actors.peer.person,hubId:hub}]},false]);
 for(const [s,t,expected]of cases){assert.equal(scopeContains(s,t),expected,JSON.stringify({s,t}));const native=(await f.pg.query<{allowed:boolean}>('SELECT public.scope_contains($1::jsonb,$2::jsonb) AS allowed',[JSON.stringify(s),JSON.stringify(t)])).rows[0].allowed;assert.equal(native,expected,JSON.stringify({s,t}));}
 }finally{await f.pg.close();}
});
