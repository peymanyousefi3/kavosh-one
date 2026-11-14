import {publicWebsitePolicyApi} from '../../../../../../../../src/server/website-policies.ts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function handle(request:Request,context:{params:Promise<{id:string;code:string}>}){const p=await context.params;return publicWebsitePolicyApi(request,p.id,p.code);}
export {handle as GET,handle as POST,handle as PUT,handle as PATCH,handle as DELETE,handle as OPTIONS,handle as HEAD};
