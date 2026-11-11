import 'server-only';
import { handleBusinessApi } from './business-api.ts';
import { selectProfileShareRequest } from '../profiles/browser-request.ts';
export function memberProfileApi(request:Request,academyId:string,id:string,resource:'profile'|'qr'='profile'){
 let selected:ReturnType<typeof selectProfileShareRequest>;try{selected=selectProfileShareRequest(request,academyId,id,resource);}catch{return Response.json({error:{code:'NOT_FOUND'}},{status:404,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});}return handleBusinessApi(selected.request,selected.path,selected.academyId);
}
