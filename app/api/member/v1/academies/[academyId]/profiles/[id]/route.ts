import 'server-only';
import { memberProfileApi } from '../../../../../../../../src/server/profile-sharing.ts';
export const runtime='nodejs';export const dynamic='force-dynamic';
async function handle(request:Request,context:{params:Promise<{academyId:string;id:string}>}){const p=await context.params;return memberProfileApi(request,p.academyId,p.id);}
export {handle as GET,handle as POST,handle as PUT,handle as PATCH,handle as DELETE,handle as HEAD,handle as OPTIONS};
