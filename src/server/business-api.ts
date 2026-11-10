import 'server-only';
import { createApi } from '../core/api.ts';
import { assertMediaAcademy } from './media-request.ts';
import { getDatabase } from './database.ts';
import { resolveHuman } from './identity.ts';
import { business } from '../modules/business.ts';
import { configuredR2Upload,configuredR2Download } from '../integrations/r2-config.ts';
import { getPayrollPrivateVault } from './payroll-private.ts';
import { getStudentCareVault } from './student-care-private.ts';

export function handleBusinessApi(request:Request,path:string,selectedAcademy?:string){
 return createApi({connect:()=>getDatabase().connect()},resolveHuman,ctx=>{
  if(selectedAcademy)assertMediaAcademy(ctx.credential.academy_id,selectedAcademy);
  return business(ctx,configuredR2Upload,configuredR2Download,{botCredentialSecret:process.env.BOT_CREDENTIAL_HANDOFF_SECRET,invitationSecret:process.env.AUTH_SECRET,payrollPrivateVault:getPayrollPrivateVault,studentCareVault:getStudentCareVault});
 })(request,path);
}
