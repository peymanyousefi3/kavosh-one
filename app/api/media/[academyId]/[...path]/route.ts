import 'server-only';
import { handleBusinessApi } from '../../../../../src/server/business-api.ts';
import { selectMediaRequest } from '../../../../../src/server/media-request.ts';

export const runtime='nodejs';
export const dynamic='force-dynamic';
async function handle(request:Request,context:{params:Promise<{academyId:string;path:string[]}>}){
 const params=await context.params,path=params.path.join('/');let selected:ReturnType<typeof selectMediaRequest>;
 try{selected=selectMediaRequest(request,params.academyId,path);}catch{return Response.json({error:{code:'NOT_FOUND'}},{status:404,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}
 return handleBusinessApi(selected.request,path,selected.academyId);
}
export{handle as GET,handle as HEAD};
