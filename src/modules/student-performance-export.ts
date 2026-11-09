import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError } from '../core/policy.ts';
import { csvRow,csvText } from '../core/csv.ts';
import type { ResolvedReportWindow } from '../core/report-window.ts';
import { studentPerformanceResult,studentPerformanceQuery,familyPerformanceQuery } from './student-performance.ts';

type Result=Awaited<ReturnType<typeof studentPerformanceResult>>;
type Provenance={id?:string;version?:number;retryOfJobId?:string;scheduledOccurrence?:{scheduleId:string;dueAt:string;recordedAt:string};dateWindow?:ResolvedReportWindow&{overriddenFields?:string[]}};
export function performanceReportCsv(r:Result,provenance?:Provenance):Reply{
 const d=r.data,header=['section','field','value','student_id','rubric_id','rubric_version','rubric_name','criterion','label_en','label_fr','label_zh_cn','count','sum','average_numerator','average_denominator','minimum','maximum','first_to_last_change','score_1_count','score_2_count','score_3_count','score_4_count','score_5_count','feedback_id','feedback_version','session_id','class_id','hub_id','local_date','session_starts_at','score','published_to_family'],rows:(string|number|boolean|null|undefined)[][]=[header];
 const metadata={report:'student_performance',snapshotAt:r.snapshotAt,filters:r.filters,publishedOnly:r.publishedOnly,sourcePermissions:r.sourcePermissions,summary:d.summary,coverage:d.coverage,dateBasis:d.dateBasis,trendOrder:d.trendOrder,rubricBasis:d.rubricBasis,averages:d.averages,missingScoresImputed:d.missingScoresImputed,privateNotesIncluded:d.privateNotesIncluded,performanceIndependentlyVerified:d.performanceIndependentlyVerified,payrollApproved:d.payrollApproved,exportCompleteness:'complete_permitted_report_within_limits',textPolicy:'Formula-like free text uses a visible text: prefix; original records unchanged.',numericPrecisionPolicy:'Average numerator and denominator are exact decimal text;import as text.',...provenance?{presetId:provenance.id,presetVersion:provenance.version,retryOfJobId:provenance.retryOfJobId,dateWindow:provenance.dateWindow,scheduledOccurrence:provenance.scheduledOccurrence}:{}};
 for(const [key,value]of Object.entries(metadata))if(value!==undefined)rows.push(['metadata',key,typeof value==='string'?value:JSON.stringify(value)]);
 let points=0;const feedbacks=new Set<string>(),students=new Set<string>();
 for(const g of d.chartData){students.add(g.studentId);for(const c of g.criteria){
  const scores=c.points.map(p=>p.score);if(!scores.length||c.count!==scores.length||c.sum!==scores.reduce((a,b)=>a+b,0)||c.average.numerator!==String(c.sum)||c.average.denominator!==String(c.count)||c.minimum!==Math.min(...scores)||c.maximum!==Math.max(...scores)||c.change!==(scores.length>1?scores.at(-1)!-scores[0]:null)||c.distribution.length!==5||c.distribution.some((v,i)=>v.score!==i+1||v.count!==scores.filter(s=>s===i+1).length))throw new Error('PERFORMANCE_EXPORT_INCOMPLETE');
  rows.push(['criterion','','',g.studentId,g.rubricId,g.rubricVersion,g.rubricName,c.code,c.labels.en,c.labels.fr,c.labels['zh-CN'],c.count,c.sum,c.average.numerator,c.average.denominator,c.minimum,c.maximum,c.change,...c.distribution.map(v=>v.count)]);
  for(const p of c.points){points++;feedbacks.add(p.feedbackId);const row:(string|number|boolean|null|undefined)[]=[];Object.assign(row,{0:'point',3:g.studentId,4:g.rubricId,5:g.rubricVersion,7:c.code,23:p.feedbackId,24:p.feedbackVersion,25:p.sessionId,26:p.classId,27:p.hubId,28:p.on,29:p.startsAt,30:p.score,31:p.publishedToFamily});rows.push(row);}
 }}
 if(points!==d.summary.criterionObservations||feedbacks.size!==d.summary.feedbacks||students.size!==d.summary.students||d.chartData.length!==d.summary.pinnedRubricSeries)throw new Error('PERFORMANCE_EXPORT_INCOMPLETE');
 const body='\uFEFF'+rows.map(row=>csvRow(Array.from({length:header.length},(_,i)=>typeof row[i]==='string'?csvText(row[i]):row[i]))).join('\r\n')+'\r\n';if(Buffer.byteLength(body)>4_194_304)throw new ApiError(422,'STUDENT_PERFORMANCE_REQUIRES_BACKGROUND_JOB');return {status:200,body,csv:{filename:`student-performance-${r.filters.from}-${r.filters.through}.csv`}};
}
export async function completePerformanceExport(ctx:ApiContext,provenance?:Provenance){return performanceReportCsv(await studentPerformanceResult(ctx),provenance);}
export async function studentPerformanceExport(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/learning/student-performance/export'&&!/^students\/[^/]+\/performance\/export$/.test(ctx.path))return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');const path=ctx.path.slice(0,-7),url=new URL(ctx.request.url);url.pathname='/api/v1/'+path;return completePerformanceExport({...ctx,path,request:new Request(url)});
}
export const studentPerformanceExportContract=[
 {path:'/api/v1/reports/learning/student-performance/export',method:'get',summary:'Complete source-scoped performance CSV with pinned criteria,all 1-5 distributions,exact average fractions and every included trend point;never an average of a screen page.200feedback/6000points/4MiB bound,formula-safe labels,no notes/private manifest or payroll decision.',querySchema:studentPerformanceQuery,responseContentType:'text/csv' as const},
 {path:'/api/v1/students/{id}/performance/export',method:'get',humanOnly:true,summary:'Human current-family/self complete published-only performance CSV,using the same live relationship,enrollment,publication and source-hub checks as the private JSON report. No draft/private/withdrawn scores,notes or retained family-result job;200feedback bound.',querySchema:familyPerformanceQuery,responseContentType:'text/csv' as const}
] as const;
