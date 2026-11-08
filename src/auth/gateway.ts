import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { isAPIError } from 'better-auth/api';
import { ApiError } from '../core/policy.ts';
import type { Identity, IdentityConfig,Delivery } from './config.ts';
import { IdentityStore } from './store.ts';
import { jsonBody,type HumanSession } from '../core/api.ts';
import { phoneChange } from './phone-change.ts';
import { emailChange } from './email-change.ts';

const email=z.string().email().max(254).transform(s=>s.trim().toLowerCase());
const password=z.string().min(15).max(128);
const phone=z.string().regex(/^\+[1-9]\d{7,14}$/);
const code=z.string().regex(/^\d{6}$/);
export const schemas:Record<string,z.ZodType>={
  '/email-change/request':z.object({email,password:z.string().min(1).max(128)}).strict(),
  '/email-change/authorize':z.object({requestId:z.string().uuid(),code:z.string().regex(/^\d{8}$/)}).strict(),
  '/email-change/confirm':z.object({requestId:z.string().uuid(),code:z.string().regex(/^\d{8}$/)}).strict(),
  '/email-change/cancel':z.object({requestId:z.string().uuid()}).strict(),
  '/phone-change/request':z.object({phoneNumber:phone,password:z.string().min(1).max(128)}).strict(),
  '/phone-change/authorize':z.object({requestId:z.string().uuid(),code:z.string().regex(/^\d{8}$/)}).strict(),
  '/phone-change/cancel':z.object({requestId:z.string().uuid()}).strict(),
  '/sign-up/email':z.object({name:z.string().trim().min(1).max(200),email,password}).strict(),
  '/sign-in/email':z.object({email,password:z.string().min(1).max(128),rememberMe:z.boolean().optional()}).strict(),
  '/send-verification-email':z.object({email}).strict(),
  '/request-password-reset':z.object({email}).strict(),
  '/reset-password':z.object({token:z.string().min(16).max(512),newPassword:password}).strict(),
  '/phone-number/send-otp':z.object({phoneNumber:phone}).strict(),
  '/phone-number/verify':z.object({phoneNumber:phone,code}).strict(),
  '/accept-invitation':z.object({invitation:z.string().max(100)}).strict(),
  '/two-factor/enable':z.object({password:z.string().max(128),method:z.enum(['otp','totp'])}).strict(),
  '/two-factor/disable':z.object({password:z.string().max(128)}).strict(),
  '/two-factor/send-otp':z.object({trustDevice:z.boolean().optional()}).strict(),
  '/two-factor/verify-otp':z.object({code,trustDevice:z.boolean().optional()}).strict(),
  '/two-factor/verify-totp':z.object({code,trustDevice:z.boolean().optional()}).strict(),
  '/two-factor/verify-backup-code':z.object({code:z.string().min(10).max(100),trustDevice:z.boolean().optional()}).strict(),
  '/two-factor/generate-backup-codes':z.object({password:z.string().max(128)}).strict(),
  '/change-password':z.object({currentPassword:z.string().max(128),newPassword:password,revokeOtherSessions:z.literal(true).default(true)}).strict(),
  '/sign-out':z.object({}).strict(), '/revoke-sessions':z.object({}).strict(), '/revoke-other-sessions':z.object({}).strict(),
  '/revoke-session':z.object({sessionId:z.string().uuid()}).strict()
};
export const getPaths=new Set(['/get-session','/list-sessions','/verify-email','/memberships','/phone-change','/email-change']);
const publicPosts=new Set(['/sign-up/email','/sign-in/email','/request-password-reset','/reset-password','/send-verification-email','/two-factor/send-otp','/two-factor/verify-otp','/two-factor/verify-totp','/two-factor/verify-backup-code']);

async function body(request:Request) {
  if(request.body)return jsonBody(request);
  // Keep existing empty-object authentication actions compatible.
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw new ApiError(415,'JSON_REQUIRED');
  return {};
}
function safeOutput(value:unknown):unknown {
  if(Array.isArray(value))return value.map(safeOutput);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['token','mfaVerified','mfaRequired'].includes(key)).map(([key,v])=>[key,safeOutput(v)]));
  return value;
}
export function verifiedProxyIp(request:Request,config:IdentityConfig) {
  if(!config.production)return '127.0.0.1';
  const expected=config.edgeSecret??'', provided=request.headers.get('x-kavosh-edge-key')??'';
  const a=Buffer.from(expected),b=Buffer.from(provided);
  if(a.length<32||a.length!==b.length||!timingSafeEqual(a,b))throw new ApiError(403,'UNTRUSTED_PROXY');
  const ip=request.headers.get('x-kavosh-client-ip')??'';
  if(!isIP(ip))throw new ApiError(403,'UNTRUSTED_PROXY');
  return ip;
}
export function platformHumanResolver(auth:Identity,store:IdentityStore,config:IdentityConfig) {
  return async(request:Request)=>{
    verifiedProxyIp(request,config);
    if(!['GET','HEAD'].includes(request.method)&&request.headers.get('origin')!==config.origin)throw new ApiError(403,'ORIGIN_REJECTED');
    await store.safe();
    const result=await auth.api.getSession({headers:request.headers,query:{disableCookieCache:true}});
    return result?{userId:result.user.id,sessionId:result.session.id}:null;
  };
}
export function humanResolver(auth:Identity,store:IdentityStore,config:IdentityConfig) {
  const resolve=platformHumanResolver(auth,store,config);
  return async(request:Request):Promise<HumanSession|null>=>{
    verifiedProxyIp(request,config);
    if(!['GET','HEAD'].includes(request.method)&&request.headers.get('origin')!==config.origin)throw new ApiError(403,'ORIGIN_REJECTED');
    const academyId=z.string().uuid().parse(request.headers.get('x-academy-id'));
    const result=await resolve(request);
    return result?{...result,academyId}:null;
  };
}
export function identityGateway(auth:Identity,store:IdentityStore,config:IdentityConfig,delivery?:Delivery) {
  return async(request:Request)=>{
    const headers=new Headers({'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
    let libraryInvoked=false;
    try {
      const url=new URL(request.url),path=url.pathname.slice('/api/auth'.length);
      if((request.method==='GET'&&!getPaths.has(path))||(request.method==='POST'&&!schemas[path])||!['GET','POST'].includes(request.method))throw new ApiError(404,'NOT_FOUND');
      if(request.method==='POST'&&request.headers.get('origin')!==config.origin)throw new ApiError(403,'ORIGIN_REJECTED');
      const ip=verifiedProxyIp(request,config);
      await store.safe();
      if(!await store.budget(`ip:${ip}`,600,60))throw new ApiError(429,'RATE_LIMITED');
      let input:Record<string,unknown>={};
      if(request.method==='POST')input=schemas[path].parse(await body(request)) as Record<string,unknown>;
      if(typeof input.email==='string'&&['/sign-in/email','/request-password-reset','/send-verification-email'].includes(path)) {
        const recovery=path!=='/sign-in/email';
        if(!await store.budget(`${path}:${input.email}`,recovery?3:5,recovery?3600:60))throw new ApiError(429,'RATE_LIMITED');
      }
      if(path==='/sign-up/email') {
        if(!await store.invite(request.headers.get('x-kavosh-invitation')??'',String(input.email)))throw new ApiError(403,'INVITATION_REQUIRED');
        if(!await store.budget(`signup:${input.email}`,3,3600))throw new ApiError(429,'RATE_LIMITED');
      }
      const session=await auth.api.getSession({headers:request.headers,query:{disableCookieCache:true}});
      if(request.method==='POST'&&!publicPosts.has(path)) {
        if(!session||!session.user.emailVerified)throw new ApiError(401,'UNAUTHORIZED');
      }
      if(path==='/phone-change'||path.startsWith('/phone-change/')){if(url.searchParams.size)throw new ApiError(400,'INVALID_INPUT');const reply=await phoneChange(path,input,request,session,auth,store,delivery);return Response.json(reply.body,{status:reply.status,headers});}
      if(path==='/email-change'||path.startsWith('/email-change/')){if(url.searchParams.size)throw new ApiError(400,'INVALID_INPUT');const reply=await emailChange(path,input,request,session,auth,store,delivery);return Response.json(reply.body,{status:reply.status,headers});}
      if(path.startsWith('/phone-number/')) {
        if(!session||!session.user.emailVerified)throw new ApiError(401,'UNAUTHORIZED');
        if(Date.now()-new Date(session.session.createdAt).getTime()>900000)throw new ApiError(403,'FRESH_SIGN_IN_REQUIRED');
        const number=String(input.phoneNumber);
        if((session.user.phoneNumberVerified||session.user.phoneNumber)&&(!await store.sessionReady(session.user.id,session.session.id)||!await store.phoneChangeReady(session.user.id,session.session.id,number)))throw new ApiError(403,'PHONE_CHANGE_REQUIRES_RECOVERY');
        if(path.endsWith('/send-otp')) {
          if(!await store.budget(`sms:${session.user.id}`,5,3600))throw new ApiError(429,'RATE_LIMITED');
          if(!await store.phoneAvailable(session.user.id,number))throw new ApiError(400,'PHONE_UNAVAILABLE');
          await store.pendingPhone(session.user.id,number);
        } else {
          if(!await store.matchesPhone(session.user.id,number))throw new ApiError(400,'INVALID_CHALLENGE');
          input={...input,updatePhoneNumber:true,disableSession:true};
        }
      }
      if(['/two-factor/enable','/two-factor/disable','/two-factor/generate-backup-codes','/change-password'].includes(path)) {
        if(!session||!await store.sessionReady(session.user.id,session.session.id))throw new ApiError(403,'VERIFICATION_REQUIRED');
        if(Date.now()-new Date(session.session.createdAt).getTime()>900000)throw new ApiError(403,'FRESH_SIGN_IN_REQUIRED');
        if(path==='/two-factor/disable'&&session.user.mfaRequired)throw new ApiError(403,'MFA_REQUIRED');
      }
      if(path==='/accept-invitation') {
        const result=await store.accept(String(input.invitation),session!.user.id,session!.session.id);
        if(result?.code!=='ACCEPTED')throw new ApiError(403,result?.code??'INVALID_INVITATION');
        return Response.json({academyId:result.academy_id},{headers});
      }
      if(path==='/memberships') {
        if(!session||!await store.sessionReady(session.user.id,session.session.id))throw new ApiError(401,'UNAUTHORIZED');
        return Response.json({data:await store.memberships(session.user.id)},{headers});
      }
      if(path==='/revoke-session') {
        const token=await store.ownSessionToken(session!.user.id,String(input.sessionId));
        if(!token)throw new ApiError(404,'NOT_FOUND');
        input={token};
      }
      let target=url.pathname;
      if(path==='/two-factor/generate-backup-codes'&&!await store.hasRecovery(session!.user.id)) {
        // Reuse the library's encrypted recovery-code enrollment; TOTP stays unverified.
        target='/api/auth/two-factor/enable';input={...input,method:'totp'};
      }
      const forwarded=new Headers(request.headers);forwarded.set('x-kavosh-client-ip',ip);forwarded.delete('x-kavosh-edge-key');forwarded.delete('x-kavosh-invitation');
      const authRequest=new Request(config.origin+target+url.search,{method:request.method,headers:forwarded,...(request.method==='POST'?{body:JSON.stringify(input)}:{})});
      libraryInvoked=true;const result=await auth.handler(authRequest);
      for(const cookie of result.headers.getSetCookie())headers.append('set-cookie',cookie);
      if(result.headers.has('location'))headers.set('location',result.headers.get('location')!);
      if([204,301,302,303,307,308].includes(result.status))return new Response(null,{status:result.status,headers});
      const parsed=result.headers.get('content-type')?.includes('application/json')?await result.json():null;
      if(result.ok&&path==='/change-password')await store.revokeRecoverySessions(session!.user.id,'password.changed');
      // Recovery/resend responses do not disclose whether an email is registered.
      if(['/request-password-reset','/send-verification-email'].includes(path))return Response.json({status:true,message:'If eligible, check your email.'},{status:202,headers});
      if(result.status>=500)return Response.json({error:{code:'AUTH_UNAVAILABLE'}},{status:503,headers});
      if(path==='/two-factor/generate-backup-codes'&&parsed?.backupCodes)return Response.json({backupCodes:parsed.backupCodes},{status:result.status,headers});
      return Response.json(safeOutput(parsed),{status:result.status,headers});
    }catch(error){
      const failedPath=new URL(request.url).pathname.slice('/api/auth'.length);
      if(libraryInvoked&&['/request-password-reset','/send-verification-email'].includes(failedPath))return Response.json({status:true,message:'If eligible, check your email.'},{status:202,headers});
      if(isAPIError(error)){
        const status=error.statusCode,original=new Headers(error.headers);
        for(const cookie of original.getSetCookie())headers.append('set-cookie',cookie);
        if(original.has('location'))headers.set('location',original.get('location')!);
        if(status>=500)return Response.json({error:{code:'AUTH_UNAVAILABLE'}},{status:503,headers});
        if([301,302,303,307,308].includes(status))return new Response(null,{status,headers});
        return Response.json(safeOutput(error.body),{status,headers});
      }
      if(error&&typeof error==='object'&&'code' in error&&error.code==='23514'&&'message' in error&&error.message==='PHONE_CHANGE_APPROVAL_REQUIRED')return Response.json({error:{code:'PHONE_CHANGE_SOURCE_CHANGED'}},{status:409,headers});
      if(error&&typeof error==='object'&&'code' in error&&error.code==='23514'&&'message' in error&&error.message==='EMAIL_UNAVAILABLE')return Response.json({error:{code:'EMAIL_UNAVAILABLE'}},{status:409,headers});
      const status=error instanceof ApiError?error.status:error instanceof z.ZodError?400:503;
      const code=error instanceof ApiError?error.code:status===400?'INVALID_INPUT':'AUTH_UNAVAILABLE';
      if(status===429)headers.set('retry-after','60');
      return Response.json({error:{code}},{status,headers});
    }
  };
}
