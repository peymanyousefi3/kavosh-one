import 'server-only';
import {publicProfileApi} from '../../../../../../../../../src/server/public-profiles.ts';
export const runtime='nodejs';export const dynamic='force-dynamic';
async function handle(request:Request,context:{params:Promise<{id:string;version:string;number:string}>}){const p=await context.params;return publicProfileApi(request,p.id,'image',{version:p.version,number:p.number});}
export {handle as GET,handle as POST,handle as PUT,handle as PATCH,handle as DELETE,handle as HEAD,handle as OPTIONS};
