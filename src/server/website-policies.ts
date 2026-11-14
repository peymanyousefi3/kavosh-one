import 'server-only';
import {publicReadDatabase} from './public-profiles.ts';
import {createPublicWebsitePolicyApi} from '../profiles/website-policy-api.ts';

export function publicWebsitePolicyApi(request:Request,academy:string,code?:string){
 return createPublicWebsitePolicyApi(publicReadDatabase,{production:process.env.NODE_ENV==='production',edgeSecret:process.env.EDGE_AUTH_SECRET,budgetSecret:process.env.PUBLIC_PROFILE_BUDGET_SECRET})(request,academy,code);
}
