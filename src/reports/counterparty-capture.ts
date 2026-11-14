import {z} from 'zod';
import {counterpartyReportAuthorization} from '../modules/counterparty-statement-access.ts';
import {record,type ApiContext} from '../core/api.ts';
import {counterpartyReportScopes} from '../modules/counterparty-statement-access.ts';
import {ApiError} from '../core/policy.ts';

const result=z.object({jobId:z.string().uuid(),captured:z.literal(true),sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/),sourceCount:z.number().int().min(0).max(200000),entryCount:z.number().int().min(0).max(200000)}).strict();
// Caller owns the existing live job/identity transaction and policy/topology
// gates. Native capture binds its actor,audit,lease and fixed queued filters.
export async function captureCounterpartyReport(ctx:ApiContext,jobId:string,lease:string){
 const scopes=counterpartyReportScopes(ctx);await record(ctx.db,ctx.credential,ctx.requestId,'report.capture',jobId,null,{reportId:'finance.counterparty-statement',externalRequestMade:false});
 try{const raw=(await ctx.db.query<{data:unknown}>('SELECT public.capture_counterparty_report_job($1,$2,$3,$4::jsonb) data',[jobId,lease,ctx.requestId,JSON.stringify(scopes)])).rows[0].data,parsed=result.safeParse(raw);if(!parsed.success)throw Error('REPORT_CAPTURE_RESULT_INVALID');return parsed.data;
 }catch(e){if(e&&typeof e==='object'&&'code'in e&&'message'in e){if(e.code==='42501'&&e.message==='REPORT_CAPTURE_SOURCE_DENIED')throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');if(e.code==='23514'&&e.message==='REPORT_CAPTURE_SOURCE_INCOMPLETE')throw new ApiError(422,'REPORT_OUTPUT_LIMIT_EXCEEDED');}throw e;}
}
export const counterpartyCaptureAuthorization=z.object({kind:z.literal('counterparty_capture'),jobId:z.string().uuid(),sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/),frame:counterpartyReportAuthorization.shape.frame}).strict();
export async function requireCounterpartyCaptureAccess(ctx:ApiContext,raw:unknown){
 const p=counterpartyCaptureAuthorization.parse(raw),scopes=counterpartyReportScopes(ctx),ok=(await ctx.db.query<{ok:boolean}>('SELECT public.counterparty_report_capture_allows($1,$2,$3::jsonb,$4::jsonb) ok',[p.jobId,p.sourceFingerprint,JSON.stringify(p.frame),JSON.stringify(scopes)])).rows[0]?.ok;
 if(ok!==true)throw new ApiError(403,'REPORT_SOURCE_ACCESS_CHANGED');
}
