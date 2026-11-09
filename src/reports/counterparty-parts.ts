import {createHash} from 'node:crypto';
import {record,type ApiContext,type Reply} from '../core/api.ts';
import {ApiError} from '../core/policy.ts';
import {captureCounterpartyReport,counterpartyCaptureAuthorization,requireCounterpartyCaptureAccess} from './counterparty-capture.ts';
import {renderCounterpartyCaptureRows} from './counterparty-render.ts';

// Fixed bounded work per leased step. Native append validates exact contiguous
// captured membership;productive yields preserve the ordinary retry allowance.
export async function processCounterpartyReportPart(ctx:ApiContext,jobId:string,lease:string,provenance:unknown,signal?:AbortSignal){
 type Header={frame:unknown;source_metadata:{sourceFingerprint:string}};
 let header=(await ctx.db.query<Header>('SELECT frame,source_metadata FROM public.counterparty_report_captures WHERE job_id=$1',[jobId])).rows[0];
 if(!header){await captureCounterpartyReport(ctx,jobId,lease);header=(await ctx.db.query<Header>('SELECT frame,source_metadata FROM public.counterparty_report_captures WHERE job_id=$1',[jobId])).rows[0];}
 if(!header)throw Error('REPORT_CAPTURE_UNAVAILABLE');
 const proof=counterpartyCaptureAuthorization.parse({kind:'counterparty_capture',jobId,sourceFingerprint:header.source_metadata.sourceFingerprint,frame:header.frame});await requireCounterpartyCaptureAccess(ctx,proof);
 const prior=(await ctx.db.query<{part_no:number;last_section:number;last_ordinal:number}>('SELECT part_no,last_section,last_ordinal FROM public.report_job_parts WHERE job_id=$1 ORDER BY part_no DESC LIMIT 1',[jobId])).rows[0],part=(prior?.part_no??0)+1;
 if(part>1000)throw new ApiError(422,'REPORT_OUTPUT_LIMIT_EXCEEDED');
 const rows=(await ctx.db.query<{section:number;ordinal:number;payload:unknown}>('SELECT section,ordinal,payload FROM public.counterparty_report_capture_rows WHERE job_id=$1 AND section<4 AND(section,ordinal)>($2::integer,$3::integer) ORDER BY section,ordinal LIMIT 250',[jobId,prior?.last_section??-1,prior?.last_ordinal??-1])).rows;
 if(!rows.length)throw Error('REPORT_CAPTURE_ROWS_UNAVAILABLE');const rendered=renderCounterpartyCaptureRows(proof.frame,rows,provenance),first=rows[0],last=rendered.last;
 if(signal?.aborted)throw new ApiError(503,'WORKER_STOPPED');
 await record(ctx.db,ctx.credential,ctx.requestId,'report.part',jobId,null,{reportId:'finance.counterparty-statement',part,records:rendered.records,first:[first.section,first.ordinal],last:[last.section,last.ordinal],sha256:createHash('sha256').update(rendered.body).digest('hex'),bytes:rendered.bytes,externalRequestMade:false});
 const complete=(await ctx.db.query<{complete:boolean}>('SELECT public.append_counterparty_report_part($1,$2,$3,$4,$5::smallint,$6,$7::smallint,$8,$9,$10) complete',[jobId,lease,ctx.requestId,part,first.section,first.ordinal,last.section,last.ordinal,rendered.records,rendered.body])).rows[0]?.complete;
 if(complete===false){const yielded=(await ctx.db.query<{ok:boolean}>('SELECT public.yield_counterparty_report_job($1,$2,$3) ok',[jobId,lease,part])).rows[0]?.ok;if(!yielded)throw new ApiError(409,'REPORT_LEASE_LOST');return {continued:true as const};}
 if(complete!==true)throw Error('REPORT_PART_RESULT_INVALID');
 const body=(await ctx.db.query<{body:string}>('SELECT public.report_parts_index($1) body',[jobId])).rows[0]?.body;if(!body)throw Error('REPORT_PART_INDEX_UNAVAILABLE');
 const file:Reply={status:200,body,csv:{filename:'counterparty-statement-'+proof.frame.from+'-'+proof.frame.through+'.csv'}};return {continued:false as const,file,proof};
}
