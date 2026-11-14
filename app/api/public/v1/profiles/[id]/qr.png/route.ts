import 'server-only';
import { publicProfileApi } from '../../../../../../../src/server/public-profiles.ts';
export const runtime='nodejs';export const dynamic='force-dynamic';
async function handle(request:Request,context:{params:Promise<{id:string}>}){return publicProfileApi(request,(await context.params).id,'qr');}
export {handle as GET,handle as POST,handle as PUT,handle as PATCH,handle as DELETE,handle as HEAD,handle as OPTIONS};
