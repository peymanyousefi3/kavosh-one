import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { workFixture } from './work-fixture.ts';

export async function workAgreementFixture(options:Parameters<typeof workFixture>[0]={}){const f=await workFixture(options);try{
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['work-signatures.view','work-signatures.edit','agreements.view','agreements.edit'])await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow') ON CONFLICT DO NOTHING",[f.a,role,cap]);
 const e=await f.create();assert.equal(e.response.status,201,JSON.stringify(e.body));const connection=randomUUID();await f.pg.query("INSERT INTO public.signature_connections(id,academy_id,region,environment,enabled) VALUES($1,$2,'CA','Test',true)",[connection,f.a]);
 const templateInput={hubId:f.hub,kind:'worker_services',name:'Synthetic work framework',legalEntityName:f.employer.legalName,countryCode:'CA',jurisdiction:'Ontario',languages:[{locale:'en',title:'Synthetic worker contract',body:'PRIVATE synthetic two-party terms'},{locale:'fr',title:'Contrat',body:'PRIVATE French version'}],provider:{region:'CA',templateId:randomUUID()},available:true,reason:'PRIVATE template review'};
 const t=await f.request('agreements',templateInput);assert.equal(t.response.status,201,JSON.stringify(t.body));const input={engagementVersion:1,templateId:t.body.data.id,templateVersion:1,academySignerId:f.actors.peer.person,connectionId:connection,locale:'en',signerAuthorityReview:'PRIVATE authority for named academy signer reviewed',reason:'PRIVATE two-party preparation'},path='payroll/engagements/'+e.body.data.id+'/agreement-preparations';
 const prepare=(patch:Record<string,unknown>={},as='master',key?:string)=>f.request(path,{...input,...patch},as,{key});return {...f,e:e.body.data,t:t.body.data,templateInput,connection,input,path,prepare};
 }catch(e){await f.pg.close();throw e;}}
