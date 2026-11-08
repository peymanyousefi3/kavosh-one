import { randomInt,randomUUID } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { ApiError } from '../core/policy.ts';
import type { Reply } from '../core/api.ts';
import type { Identity,Delivery } from './config.ts';
import type { IdentityStore } from './store.ts';

type Session=Awaited<ReturnType<Identity['api']['getSession']>>;
export async function verifyCurrentPassword(auth:Identity,password:string,request:Request){
 try{await auth.api.verifyPassword({body:{password},headers:request.headers});}catch(e){if(e instanceof APIError&&e.statusCode===400)throw new ApiError(400,'INVALID_PASSWORD');throw e;}
}
export async function phoneChange(path:string,input:Record<string,unknown>,request:Request,session:Session,auth:Identity,store:IdentityStore,delivery?:Delivery):Promise<Reply>{
 if(!session)throw new ApiError(401,'UNAUTHORIZED');const userId=session.user.id,sessionId=session.session.id;
 if(!await store.sessionReady(userId,sessionId))throw new ApiError(403,'VERIFICATION_REQUIRED');
 if(path==='/phone-change/cancel'){if(!await store.cancelPhoneChange(userId,sessionId,String(input.requestId)))throw new ApiError(409,'INVALID_PHONE_CHANGE');return {status:200,body:{status:true,cancelled:true,phoneChanged:false}};}
 if(path==='/phone-change')return {status:200,body:{data:await store.phoneChange(userId,sessionId),phoneChanged:false}};
 if(Date.now()-new Date(session.session.createdAt).getTime()>900000)throw new ApiError(403,'FRESH_SIGN_IN_REQUIRED');
 if(path==='/phone-change/authorize'){
  if(!await store.budget('phone-change-confirm:'+userId,10,900))throw new ApiError(429,'RATE_LIMITED');const requestId=String(input.requestId),hash=store.digest('phone-change:'+userId+':'+sessionId+':'+requestId+':'+String(input.code));
  if(!await store.authorizePhoneChange(userId,sessionId,requestId,hash))throw new ApiError(409,'INVALID_PHONE_CHANGE');return {status:200,body:{status:true,step:'verify_new_phone',phoneChanged:false}};
 }
 if(path!=='/phone-change/request')throw new ApiError(404,'NOT_FOUND');if(!delivery)throw new ApiError(503,'PHONE_CHANGE_UNAVAILABLE');
 if(!await store.budget('phone-change:'+userId,3,3600))throw new ApiError(429,'RATE_LIMITED');
 // Use the installed authentication library's password verification/KDF.
 await verifyCurrentPassword(auth,String(input.password),request);
 const requestId=randomUUID(),code=String(randomInt(0,100000000)).padStart(8,'0'),hash=store.digest('phone-change:'+userId+':'+sessionId+':'+requestId+':'+code),phone=String(input.phoneNumber);
 const prepared=await store.preparePhoneChange(userId,sessionId,requestId,phone,hash);if(prepared!=='PREPARED')throw new ApiError(prepared==='VERIFICATION_REQUIRED'?403:400,prepared??'INVALID_PHONE_CHANGE');
 try{await delivery.email({to:session.user.email,subject:'Confirm your Kavosh One phone change',text:'Phone change approval code: '+code+'. Expires in 15 minutes. Requested new number: '+phone+'. Enter this code in the same signed-in browser where you requested the change. Your phone has not changed yet; verification of the new number is also required. If you did not request this, cancel it from your account and change your password. Never share this code.'});}
 catch{try{await store.cancelPhoneChange(userId,sessionId,requestId);}catch{/* A retained unreachable request expires without changing the phone. */}throw new ApiError(503,'PHONE_CHANGE_UNAVAILABLE');}
 return {status:202,body:{status:true,requestId,step:'confirm_current_email',expiresInSeconds:900,phoneChanged:false}};
}
