import {createPlatformApi} from '../src/platform/api.ts';
import type {Database} from '../src/core/database.ts';
import type {invoiceFixture} from './invoice-fixture.ts';

export async function platformDirectoryFixture(f:Pick<Awaited<ReturnType<typeof invoiceFixture>>,'pg'|'actors'|'a'>,defaultPurpose='PRIVATE_TUITION_OVERSIGHT'){
 const owner=f.actors.master;await f.pg.query('SELECT platform_private.register_owner($1,$2)',[owner.user,'Synthetic tuition oversight']);
 const database:Database={async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_platform_service');return c;}};
 const api=createPlatformApi(database,async r=>{const a=f.actors[r.headers.get('x-test-actor')??''];return a?{userId:a.user,sessionId:a.session}:null;},true);
 const request=async(collection:string,options:{academy?:string;actor?:string;query?:string;purpose?:string|null;method?:string;bearer?:boolean}={})=>{
  const path='academies/'+(options.academy??f.a)+'/records/'+collection,headers:Record<string,string>={'x-test-actor':options.actor??'master'};if(options.purpose!==null)headers['x-access-purpose']=options.purpose??defaultPurpose;if(options.bearer)headers.authorization='Bearer synthetic';
  try{const response=await api(new Request('https://example.test/api/platform/v1/'+path+(options.query??''),{method:options.method??'GET',headers}),path);return {response,body:await response.json()};}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
 };
 return {owner,database,request};
}
