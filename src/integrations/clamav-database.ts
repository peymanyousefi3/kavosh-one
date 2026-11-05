import { createConnection } from 'node:net';
import type { Readable } from 'node:stream';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { ApiError } from '../core/policy.ts';
import { clamdConfiguration,clamdScanClaims,scanWithClamd,type ClamdConfiguration } from './clamav.ts';

export const clamdDatabasePolicy=z.object({timeZone:z.string().min(1).max(100).refine(v=>{
 if(/^[+-]/.test(v))return false;try{Temporal.Now.instant().toZonedDateTimeISO(v);return true;}catch{return false;}
}),maximumAgeSeconds:z.number().int().min(1).max(604800)}).strict();
export type ClamdDatabasePolicy=z.infer<typeof clamdDatabasePolicy>;

// VERSION exposes the LOADED engine database time, not the file's mtime or the
// updater's last run. ClamAV formats it with daemon-local ctime, WITHOUT a zone.
// Require the actual operator-configured daemon zone; never guess host/UTC/hub.
// Ambiguous/nonexistent civil times fail closed rather than choose a DST offset.
// https://github.com/Cisco-Talos/clamav/blob/main/clamd/session.c (print_ver)
function databaseVersion(reply:string,policy:ClamdDatabasePolicy){
 const m=/^ClamAV ([0-9]+\.[0-9]+\.[0-9]+(?:[-+_][A-Za-z0-9._+-]+)?)\/([1-9][0-9]{0,9})\/(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12][0-9]|3[01]) ([0-2][0-9]):([0-5][0-9]):([0-5][0-9]) ([1-9][0-9]{3})$/.exec(reply);
 if(!m||m[1].length>80||Number(m[2])>4294967295)throw new ApiError(503,'SCANNER_DATABASE_METADATA_INVALID');
 let time:Temporal.ZonedDateTime;
 try{
  time=Temporal.ZonedDateTime.from({timeZone:policy.timeZone,year:Number(m[9]),month:1+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(m[4]),day:Number(m[5]),hour:Number(m[6]),minute:Number(m[7]),second:Number(m[8])},{overflow:'reject',disambiguation:'reject'});
  if(['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][time.dayOfWeek-1]!==m[3])throw new Error('WEEKDAY');
 }catch{throw new ApiError(503,'SCANNER_DATABASE_METADATA_INVALID');}
 const now=Date.now(),age=now-time.epochMilliseconds;
 if(age<0||age>policy.maximumAgeSeconds*1000)throw new ApiError(503,'SCANNER_DATABASE_NOT_CURRENT');
 return {engineVersion:m[1],databaseVersion:Number(m[2]),databaseCreatedAt:time.toInstant().toString(),observedAt:new Date(now).toISOString(),timeZone:policy.timeZone,maximumAgeSeconds:policy.maximumAgeSeconds};
}

// Bounded read-only command on the same fixed private socket as scans. No
// subprocess, file read, public URL, automatic update or command substitution.
export async function getClamdDatabase(config:ClamdConfiguration,rawPolicy:ClamdDatabasePolicy,signal?:AbortSignal){
 const parsed=clamdConfiguration.safeParse(config),selected=clamdDatabasePolicy.safeParse(rawPolicy);
 if(!parsed.success)throw new ApiError(503,'SCANNER_NOT_CONFIGURED');
 if(!selected.success)throw new ApiError(503,'SCANNER_DATABASE_POLICY_NOT_CONFIGURED');
 if(signal?.aborted)throw new ApiError(503,'SCANNER_CANCELLED');
 const socket=createConnection({path:parsed.data.socketPath});let reply=Buffer.alloc(0);
 try{
  const value=await new Promise<string>((resolve,reject)=>{
   let settled=false;
   const stop=(code:string)=>{if(settled)return;settled=true;reject(new ApiError(503,code));socket.destroy();};
   const cancel=()=>stop('SCANNER_CANCELLED'),timer=setTimeout(()=>stop('SCANNER_TIMEOUT'),Math.min(parsed.data.timeoutMs,5000));
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
   signal?.addEventListener('abort',cancel,{once:true});
   socket.once('connect',()=>{if(!settled)socket.write('zVERSION\0');});
   socket.on('data',(chunk:Buffer)=>{
    if(settled)return;
    if(reply.length+chunk.length>4096||chunk.some(b=>b>127)){stop('SCANNER_DATABASE_METADATA_INVALID');return;}
    reply=Buffer.concat([reply,chunk]);
    const end=reply.indexOf(0);if(end!==-1&&end!==reply.length-1)stop('SCANNER_DATABASE_METADATA_INVALID');
   });
   socket.once('error',()=>stop('SCANNER_UNAVAILABLE'));
   socket.once('close',()=>{
    cleanup();if(settled)return;settled=true;
    if(!reply.length||reply.indexOf(0)!==reply.length-1)reject(new ApiError(503,'SCANNER_DATABASE_METADATA_INVALID'));
    else resolve(reply.subarray(0,-1).toString('ascii'));
   });
   if(signal?.aborted)cancel();
  });
  return databaseVersion(value,selected.data);
 }finally{socket.destroy();}
}

// The ordinary no_detection receipt is NOT a freshness/configuration guarantee.
// Production checks the loaded metadata before AND after the full-byte scan.
// A normal reload changing the observed engine/database rejects this evidence.
// Even IDSESSION does not pin an engine across commands (server-th.c assigns
// the current engine per command), so do not claim a session proves that fact.
// Signed official databases, trusted socket/runtime and scan configuration still
// require deployment verification; this adapter alone NEVER clears publication.
// A positive detection is always rejection, so preserve it without waiting for
// another health request; a missing later health reply must not hide that alert.
export async function scanWithFreshClamd(config:ClamdConfiguration,policy:ClamdDatabasePolicy,source:Readable,expected:Parameters<typeof scanWithClamd>[2],signal?:AbortSignal){
 const parsed=clamdConfiguration.safeParse(config),selected=clamdDatabasePolicy.safeParse(policy),input=clamdScanClaims.safeParse(expected);
 if(!parsed.success){source.destroy();throw new ApiError(503,'SCANNER_NOT_CONFIGURED');}
 if(!selected.success){source.destroy();throw new ApiError(503,'SCANNER_DATABASE_POLICY_NOT_CONFIGURED');}
 if(!input.success||input.data.bytes>parsed.data.maximumBytes){source.destroy();throw new ApiError(400,'INVALID_SCAN_CLAIMS');}
 const timeout=AbortSignal.timeout(parsed.data.timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;
 try{
  const before=await getClamdDatabase(parsed.data,selected.data,combined),result=await scanWithClamd(parsed.data,source,input.data,combined);
  if(result.verdict==='detected')return {...result,database:null};
  const after=await getClamdDatabase(parsed.data,selected.data,combined);
  if(before.engineVersion!==after.engineVersion||before.databaseVersion!==after.databaseVersion||before.databaseCreatedAt!==after.databaseCreatedAt)throw new ApiError(503,'SCANNER_DATABASE_CHANGED');
  return {...result,database:{...after,observedBeforeAt:before.observedAt}};
 }catch(error){if(timeout.aborted&&!signal?.aborted)throw new ApiError(503,'SCANNER_TIMEOUT');throw error;}finally{source.destroy();}
}
