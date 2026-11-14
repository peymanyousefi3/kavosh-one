import 'server-only';
import { platformApi } from '../../../../../src/server/platform.ts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function handle(request:Request,context:{params:Promise<{path:string[]}>}){
 const {path}=await context.params;return platformApi(request,path.join('/'));
}
export {handle as GET,handle as POST,handle as PUT,handle as PATCH,handle as DELETE,handle as HEAD,handle as OPTIONS};
