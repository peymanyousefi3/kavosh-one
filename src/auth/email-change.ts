import { randomInt,randomUUID } from 'node:crypto';
import { ApiError } from '../core/policy.ts';
import type { Reply } from '../core/api.ts';
import type { Identity,Delivery } from './config.ts';
import type { IdentityStore } from './store.ts';
import { verifyCurrentPassword } from './phone-change.ts';

type Session=Awaited<ReturnType<Identity['api']['getSession']>>;
export async function emailChange(path:string,input:Record<string,unknown>,request:Request,session:Session,auth:Identity,store:IdentityStore,delivery?:Delivery):Promise<Reply>{
 if(!session)throw new ApiError(401,'UNAUTHORIZED');const userId=session.user.id,sessionId=session.session.id;
 if(!await store.sessionReady(userId,sessionId))throw new ApiError(403,'VERIFICATION_REQUIRED');
 if(path==='/email-change')return {status:200,body:{data:await store.emailChange(userId,sessionId),emailChanged:false}};
 if(path==='/email-change/cancel'){if(!await store.cancelEmailChange(userId,sessionId,String(input.requestId)))throw new ApiError(409,'INVALID_EMAIL_CHANGE');return {status:200,body:{status:true,cancelled:true,emailChanged:false}};}
 // Status/cancellation remain available. New proof/mutation steps must not
 // silently use old native triggers during rollout and orphan an invitation.
 if(!await store.schemaReady())throw new ApiError(503,'AUTH_SCHEMA_NOT_CURRENT');
 if(Date.now()-new Date(session.session.createdAt).getTime()>900000)throw new ApiError(403,'FRESH_SIGN_IN_REQUIRED');
 const digest=(stage:string,requestId:string,code:string)=>store.digest('email-change:'+stage+':'+userId+':'+sessionId+':'+requestId+':'+code);
 if(path==='/email-change/confirm'){
  if(!await store.budget('email-change-confirm:'+userId,10,900))throw new ApiError(429,'RATE_LIMITED');
  const result=await store.completeEmailChange(userId,sessionId,String(input.requestId),digest('new',String(input.requestId),String(input.code)));
  if(result!=='CHANGED')throw new ApiError(409,result??'INVALID_EMAIL_CHANGE');
  return {status:200,body:{status:true,emailChanged:true,signInRequired:true}};
 }
 if(!delivery)throw new ApiError(503,'EMAIL_CHANGE_UNAVAILABLE');
 if(path==='/email-change/authorize'){
  if(!await store.budget('email-change-confirm:'+userId,10,900))throw new ApiError(429,'RATE_LIMITED');
  const requestId=String(input.requestId),code=String(randomInt(0,100000000)).padStart(8,'0');
  const proof=await store.authorizeEmailChange(userId,sessionId,requestId,digest('current',requestId,String(input.code)),digest('new',requestId,code));
  if(!proof)throw new ApiError(409,'INVALID_EMAIL_CHANGE');
  const lifetime=Math.floor((new Date(proof.expiresAt).getTime()-Date.now())/1000);
  if(lifetime<1){await store.cancelEmailChange(userId,sessionId,requestId);throw new ApiError(409,'INVALID_EMAIL_CHANGE');}
  try{await delivery.email({to:proof.email,expiresAt:proof.expiresAt,subject:'Verify your new Kavosh One email',text:'New email verification code: '+code+'. Expires in at most 5 minutes. Enter this code in the same signed-in browser where you requested the change. Your email has not changed yet. Never share this code.'});}
  catch{try{await store.cancelEmailChange(userId,sessionId,requestId);}catch{/* Request expires without changing identity. */}throw new ApiError(503,'EMAIL_CHANGE_UNAVAILABLE');}
  return {status:202,body:{status:true,step:'verify_new_email',emailChanged:false}};
 }
 if(path!=='/email-change/request')throw new ApiError(404,'NOT_FOUND');
 if(!await store.budget('email-change:'+userId,3,3600))throw new ApiError(429,'RATE_LIMITED');
 await verifyCurrentPassword(auth,String(input.password),request);
 const requestId=randomUUID(),code=String(randomInt(0,100000000)).padStart(8,'0'),target=String(input.email);
 const prepared=await store.prepareEmailChange(userId,sessionId,requestId,target,digest('current',requestId,code));
 if(prepared!=='PREPARED')throw new ApiError(prepared==='VERIFICATION_REQUIRED'?403:400,prepared??'INVALID_EMAIL_CHANGE');
 try{await delivery.email({to:session.user.email,subject:'Confirm your Kavosh One email change',text:'Email change approval code: '+code+'. Expires in 15 minutes. Requested new email: '+target+'. Enter this code in the same signed-in browser where you requested the change. Your email has not changed yet; verification of the new email is also required. If you did not request this, cancel it from your account and change your password. Never share this code.'});}
 catch{try{await store.cancelEmailChange(userId,sessionId,requestId);}catch{/* Request expires without changing identity. */}throw new ApiError(503,'EMAIL_CHANGE_UNAVAILABLE');}
 return {status:202,body:{status:true,requestId,step:'confirm_current_email',expiresInSeconds:900,emailChanged:false}};
}
