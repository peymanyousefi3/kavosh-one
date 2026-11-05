import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { operationsFixture } from './operations-fixture.ts';

export async function reportFixture(throughSchema?:number){
 const f=await operationsFixture({throughSchema}),country=randomUUID(),region=randomUUID(),city=randomUUID();
 await f.pg.query("INSERT INTO public.countries(academy_id,id,code,name) VALUES($1,$2,'CA','Canada')",[f.a,country]);
 await f.pg.query("INSERT INTO public.regions(academy_id,id,country_id,code,name) VALUES($1,$2,$3,'ON','Ontario')",[f.a,region,country]);
 await f.pg.query("INSERT INTO public.cities(academy_id,id,region_id,name) VALUES($1,$2,$3,'Toronto')",[f.a,city,region]);
 await f.pg.query("UPDATE public.hubs SET city_id=$1,time_zone='America/Toronto',currency='CAD' WHERE academy_id=$2",[city,f.a]);
 const course=await f.request('courses',{code:'REPORT',name:'Session report tests'});assert.equal(course.response.status,201);
 const makeClass=async(hubId=f.hub)=>{const c=await f.request('classes',{hubId,courseId:course.body.data.id,courseVersion:1,name:'Shared session report',mode:'in_person',schedule:{oneOff:[{start:'2026-01-02T23:30',end:'2026-01-03T00:30'}]}});assert.equal(c.response.status,201);return {...c.body.data,session:(await f.request('classes/'+c.body.data.id+'/sessions')).body.data[0]};};
 const c=await makeClass(),assignment=await f.request('classes/'+c.id+'/staff',{personId:f.actors.staff.person,role:'teacher',startsOn:'2026-01-02',endsOn:'2026-01-02',reason:'Synthetic accepted staff assignment'});assert.equal(assignment.response.status,201);
 for(const role of [f.staffRole,f.managerRole])for(const cap of ['session-reports.view','session-reports.record','session-reports.edit','files.view','files.edit'].filter(c=>throughSchema===undefined||throughSchema>=73||!c.startsWith('session-reports.')))await f.pg.query("INSERT INTO public.role_permissions VALUES($1,$2,$3,'allow')",[f.a,role,cap]);
 const fileInput={anchor:{kind:'class',id:c.id},domain:'general',name:'PRIVATE robotics image.jpg',claimedMimeType:'image/jpeg',expectedBytes:1234,expectedSha256:'a'.repeat(64)};
 const file=await f.request('files',fileInput);assert.equal(file.response.status,201,JSON.stringify(file.body));
 const document={title:'PRIVATE Robots and teamwork',locale:'en',blocks:[{id:randomUUID(),kind:'text',text:'PRIVATE Students built robots. <script>literal report text</script>'},{id:randomUUID(),kind:'media',fileId:file.body.data.id,fileVersion:1,mediaKind:'image',caption:'PRIVATE Class teamwork'}]};
 const input={expectedVersion:0,sessionVersion:1,assignmentId:assignment.body.data.id,assignmentVersion:1,document,reason:'PRIVATE shared draft'},path='sessions/'+c.session.id+'/report';
 const save=(value:unknown=input,as='staff',key?:string)=>f.request(path,value,as,key?{key}:{});
 const {assignmentId,assignmentVersion,...change}=input;
 const correction=(value:unknown=change,as='manager',key?:string)=>f.request(path+'/change',value,as,key?{key}:{});
 return {...f,c,assignment:assignment.body.data,file:file.body.data,fileInput,input,document,path,save,change,correction,makeClass};
}

