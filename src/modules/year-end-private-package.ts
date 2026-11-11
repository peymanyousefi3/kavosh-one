import { z } from 'zod';
import { jsonBody,record,type ApiContext,type Reply } from '../core/api.ts';
import { lockApprovalWrites } from '../core/approvals.ts';
import { ApiError } from '../core/policy.ts';
import { reportDateWindow } from '../core/report-window.ts';
import { configuredReportContext } from './report-catalogue.ts';
import { t4WorkingPaperData } from './t4-working-paper.ts';
import { t4aWorkingPaperData } from './t4a-working-paper.ts';
import { requirePayrollEmployerView } from './payroll-employers.ts';
import { payrollIdentityRevealData } from './payroll-private-identities.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),identityVersion=z.number().int().positive().max(2147483647),timeZone=reportDateWindow.shape.timeZone;
const t4Input=z.object({profileId:uuid,timeZone,identityVersion}).strict(),t4aInput=z.object({personId:uuid,employerId:uuid,taxYear:z.number().int().min(1900).max(9999),timeZone,identityVersion}).strict();
type Account={id:string;version:number;accountNumber:string;legalEmployerName:string|null;address:{lines:string[];city:string;region:string|null;postalCode:string|null;countryCode:string}};
type Slip={reportingAccountId?:string|null;reportingAccountVersions?:number[]};
export function assertYearEndPrivatePackageBytes(bytes:number){if(!Number.isSafeInteger(bytes)||bytes<0)throw new Error('INVALID_PRIVATE_PACKAGE_SIZE');if(bytes>8_388_608)throw new ApiError(422,'YEAR_END_PRIVATE_PACKAGE_REQUIRES_BACKGROUND_REVIEW');}
async function payerEditions(ctx:ApiContext,employerId:string,slips:Slip[]){
 const refs=[...new Map(slips.flatMap(s=>s.reportingAccountId?(s.reportingAccountVersions??[]).map(version=>({id:s.reportingAccountId!,version})):[]).map(r=>[r.id+':'+r.version,r])).values()];
 if(refs.length>500)throw new ApiError(422,'YEAR_END_PRIVATE_PACKAGE_REQUIRES_BACKGROUND_REVIEW');if(!refs.length)return [];
 // Exact retained editions,not mutable defaults/current addresses. Only the
 // reporting fields are projected;private reviews never leave their source.
 const rows=(await ctx.db.query<Account>(`SELECT h.id,r.version,h.account_number "accountNumber",r.source_snapshot#>>'{employer,legalName}' "legalEmployerName",jsonb_build_object('lines',r.definition#>'{address,lines}','city',r.definition#>'{address,city}','region',r.definition#>'{address,region}','postalCode',r.definition#>'{address,postalCode}','countryCode',r.definition#>'{address,countryCode}') address FROM jsonb_to_recordset($1::jsonb) ref(id uuid,version integer) JOIN public.payroll_employer_accounts h ON h.id=ref.id AND h.employer_id=$2 JOIN public.payroll_employer_revisions r ON r.academy_id=h.academy_id AND r.account_id=h.id AND r.version=ref.version ORDER BY h.id,r.version`,[JSON.stringify(refs),employerId])).rows;
 if(rows.length!==refs.length)throw new ApiError(409,'YEAR_END_PAYER_SOURCE_REVIEW_REQUIRED');return rows;
}
export async function yearEndPrivatePackage(ctx:ApiContext):Promise<Reply|null>{
 const m=/^reports\/payroll\/(t4|t4a)-working-paper\/private-package$/.exec(ctx.path);if(!m)return null;
 if(ctx.request.method!=='POST')throw new ApiError(405,'METHOD_NOT_ALLOWED');if(ctx.credential.kind!=='human')throw new ApiError(403,'HUMAN_REVIEW_REQUIRED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
 const i=(m[1]==='t4'?t4Input:t4aInput).parse(await jsonBody(ctx.request,2048)),{identityVersion:version,...selectors}=i;
 await lockApprovalWrites(ctx);requirePayrollEmployerView(ctx);
 const source=configuredReportContext(ctx,{reportId:'payroll.'+m[1]+'-working-paper',queryContractVersion:1,parameters:Object.fromEntries(Object.entries(selectors).map(([k,v])=>[k,String(v)])),pathParameters:{}}),workingPaper=await(m[1]==='t4'?t4WorkingPaperData:t4aWorkingPaperData)(source);
 const accounts=await payerEditions(ctx,workingPaper.employerId,workingPaper.slips),revealed=await payrollIdentityRevealData(ctx,workingPaper.personId,{version,purpose:'year_end_reporting'});
 if(revealed.state!=='recorded'||!revealed.identity)throw new ApiError(409,'YEAR_END_RECORDED_IDENTITY_REQUIRED');const person=revealed.identity;
 const data={kind:m[1]==='t4'?'private_t4_review_package':'private_t4a_review_package',workingPaper,recipient:{personId:workingPaper.personId,identityVersion:version,latestIdentityVersion:revealed.latestVersion,historicalIdentitySelected:version!==revealed.latestVersion,givenNames:person.givenNames,familyName:person.familyName,address:{lines:person.address.lines,city:person.address.city,region:person.address.region,postalCode:person.address.postalCode,countryCode:person.address.countryCode},sin:person.sin},payerReportingEditions:accounts,
 reviewWarnings:[...person.sin===null?['RECIPIENT_SIN_NOT_RECORDED']:[],...workingPaper.slips.some(s=>!s.reportingAccountId||!s.reportingAccountVersions?.length)?['PAYMENT_REPORTING_ACCOUNT_NOT_RECORDED']:[]],identityAssignmentVerified:false,payerAccountVerified:false,privateFieldsIncluded:true,readAuditRecorded:true,responseRetainedInIdempotencyCache:false,storedInReportArchive:false,sourceConsistency:'same_worker_fence_explicit_identity_version_and_exact_retained_payer_editions',isOfficialForm:false,pdfGenerated:false,readyToIssue:false,craFilingPerformed:false,paymentExecuted:false,additionalLedgerPosting:false};
 // ponytail: transient private JSON is bounded8MiB,never silently paginated
 // or persisted as plaintext. Larger sensitive reviews need a secured export.
 assertYearEndPrivatePackageBytes(Buffer.byteLength(JSON.stringify(data)));
 await record(ctx.db,ctx.credential,ctx.requestId,'work.year-end-private-package.revealed',workingPaper.personId,null,{form:m[1],taxYear:workingPaper.taxYear,employerId:workingPaper.employerId,timeZone:workingPaper.timeZone,identityVersion:version,payerEditionCount:accounts.length,payerReportingEditions:accounts.map(a=>({id:a.id,version:a.version})),recognizedPayments:workingPaper.paymentSources.map(p=>({paymentId:p.paymentId,version:'recognitionVersion'in p?p.recognitionVersion:p.version})),purpose:'year_end_reporting',severity:'critical',privateContentRedacted:true,responseRetained:false});return {status:200,body:{data}};
}
export const yearEndPrivatePackageContract=[
 {path:'/api/v1/reports/payroll/t4-working-paper/private-package',method:'post',readOnly:true,humanOnly:true,schema:t4Input,summary:'Human-only purpose-audited private T4 review package from the existing complete working paper,explicit encrypted identity edition and exact original RP payer editions. Requires all original financial/tax,private identity reveal and full employer rights;historical identity additionally requires edit rights. No plaintext cache/archive,manual amount override,official PDF,CRA filing or issue certification.'},
 {path:'/api/v1/reports/payroll/t4a-working-paper/private-package',method:'post',readOnly:true,humanOnly:true,schema:t4aInput,summary:'Human-only purpose-audited private T4A review package from the existing bounded positive-payroll working paper,explicit encrypted recipient identity and exact original RP payer editions. Preserves incomplete-source warnings and original scope checks. Never stores the decrypted response in report archives or retry caches;not official forms,all-source T4A,CRA filing or government verification.'}
] as const;
