import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ApiContext,Reply } from '../core/api.ts';
import { ApiError,scopeNonempty,type Capability } from '../core/policy.ts';
import { permissionScope } from '../core/approvals.ts';
import { financialReports,financialReportsContract } from './financial-reports.ts';
import { financialStatements,financialStatementsContract } from './financial-statements.ts';
import { financialOutlook,financialOutlookContract } from './financial-outlook.ts';
import { receivablesAging,receivablesAgingContract } from './receivables-aging.ts';
import { payablesAging,payablesAgingContract } from './payables-aging.ts';
import { bankReconciliationReport,bankReconciliationReportContract } from './bank-reconciliation-report.ts';
import { inventoryReports,inventoryReportsContract } from './inventory-reports.ts';
import { payrollForecast,payrollForecastContract } from './payroll-forecast.ts';
import { recordedWorkReport,recordedWorkReportContract } from './recorded-work-report.ts';
import { payrollGrossReport,payrollGrossReportContract } from './payroll-gross-report.ts';
import { pollResults,pollResultsContract } from './poll-results.ts';
import { sessionEvidenceReport,sessionEvidenceReportContract } from './session-evidence-report.ts';

type Contract={path:string;summary:string;querySchema?:z.ZodType};
type Entry={id:string;path:string;summary:string;schema:z.ZodType;handler:(ctx:ApiContext)=>Promise<Reply|null>;capability:Capability};
const groups:{contracts:readonly Contract[];handler:Entry['handler'];capability:Capability}[]=[
 {contracts:financialReportsContract,handler:financialReports,capability:'financial-reports.view'},
 {contracts:financialStatementsContract,handler:financialStatements,capability:'financial-reports.view'},
 {contracts:financialOutlookContract,handler:financialOutlook,capability:'financial-outlook.view'},
 {contracts:receivablesAgingContract,handler:receivablesAging,capability:'receivables-reports.view'},
 {contracts:payablesAgingContract,handler:payablesAging,capability:'payables-reports.view'},
 {contracts:bankReconciliationReportContract,handler:bankReconciliationReport,capability:'financial-reports.view'},
 {contracts:inventoryReportsContract,handler:inventoryReports,capability:'inventory-reports.view'},
 {contracts:payrollForecastContract,handler:payrollForecast,capability:'work-pay.view'},
 {contracts:recordedWorkReportContract,handler:recordedWorkReport,capability:'session-time.view'},
 {contracts:payrollGrossReportContract,handler:payrollGrossReport,capability:'financial-reports.view'},
 {contracts:pollResultsContract,handler:pollResults,capability:'poll-results.view'},
 {contracts:sessionEvidenceReportContract,handler:sessionEvidenceReport,capability:'session-time.view'}
];
export const reportCatalogue:readonly Entry[]=groups.flatMap(g=>g.contracts.map(c=>({id:c.path.slice('/api/v1/reports/'.length).replaceAll('/','.').replace('{id}','by-id'),path:c.path.slice('/api/v1/'.length),summary:c.summary,schema:c.querySchema??z.object({}).strict(),handler:g.handler,capability:g.capability}))).sort((a,b)=>a.id.localeCompare(b.id));
export const reportId=z.enum(reportCatalogue.map(r=>r.id));
export function catalogueReport(id:string){const r=reportCatalogue.find(r=>r.id===id);if(!r)throw new ApiError(400,'UNKNOWN_REPORT');return r;}
export const reportParameters=z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/).refine(k=>!['constructor','prototype','__proto__'].includes(k)),z.string().max(8000).refine(v=>v.isWellFormed()&&!v.includes('\0'))).refine(v=>Object.keys(v).length<=48&&Buffer.byteLength(JSON.stringify(v),'utf8')<=65536);
const pathParameters=z.record(z.string().regex(/^id$/),z.string().uuid().transform(v=>v.toLowerCase()));
const cursor=/^(?:after|statementAfter|ledgerAfter)|^snapshot$/i;
export function reportConfiguration(id:string,parameters:Record<string,string>,path:Record<string,string>){
 const entry=catalogueReport(id),paths=pathParameters.parse(path);if(entry.path.includes('{id}')!==Boolean(paths.id))throw new ApiError(400,'REPORT_PATH_PARAMETERS_REQUIRED');
 const input=reportParameters.parse(parameters);if(Object.keys(input).some(k=>cursor.test(k)))throw new ApiError(400,'REPORT_CURSOR_NOT_A_PRESET');const parsed=entry.schema.parse(input) as Record<string,unknown>,canonical:Record<string,string>={};
 for(const [key,value] of Object.entries(parsed)){if(value===undefined)continue;if(Array.isArray(value)&&value.every(v=>['string','number','boolean'].includes(typeof v)))canonical[key]=value.join(',');else if(['string','number','boolean'].includes(typeof value))canonical[key]=String(value);else throw new ApiError(400,'REPORT_PARAMETER_NOT_REUSABLE');}
 reportParameters.parse(canonical);if(!isDeepStrictEqual(entry.schema.parse(canonical),parsed))throw new ApiError(400,'REPORT_PARAMETER_NOT_REUSABLE');return {reportId:entry.id,queryContractVersion:1 as const,parameters:canonical,pathParameters:paths};
}
export async function runConfiguredReport(ctx:ApiContext,configuration:{reportId:string;queryContractVersion:number;parameters:Record<string,string>;pathParameters:Record<string,string>},overrides:Record<string,string>={}){
 if(configuration.queryContractVersion!==1)throw new ApiError(409,'REPORT_CONFIGURATION_REQUIRES_REVIEW');const entry=catalogueReport(configuration.reportId),checked=reportConfiguration(entry.id,configuration.parameters,configuration.pathParameters),parameters=reportParameters.parse({...checked.parameters,...overrides});entry.schema.parse(parameters);
 const path=entry.path.replace('{id}',checked.pathParameters.id??''),url=new URL(ctx.request.url);url.pathname='/api/v1/'+path;url.search=new URLSearchParams(parameters).toString();
 // Directly reuse the original read handler and CURRENT caller context. No
 // HTTP request,stored credential,creator authority or arbitrary path dispatch.
 const reply=await entry.handler({...ctx,path,request:new Request(url,{method:'GET'})});if(!reply||reply.status!==200||reply.csv)throw new Error('REPORT_HANDLER_INVALID');return reply;
}
export async function reportDirectory(ctx:ApiContext):Promise<Reply|null>{
 if(ctx.path!=='reports/catalogue')return null;if(ctx.request.method!=='GET')throw new ApiError(405,'METHOD_NOT_ALLOWED');z.object({}).strict().parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
 const canDesign=['report-presets.view','report-presets.edit'].every(cap=>scopeNonempty(permissionScope(ctx,cap as Capability))),entries=reportCatalogue.filter(e=>canDesign||scopeNonempty(permissionScope(ctx,e.capability)));if(!entries.length)throw new ApiError(403,'FORBIDDEN');return {status:200,body:{data:entries.map(e=>({id:e.id,path:'/api/v1/'+e.path,summary:e.summary,queryContractVersion:1,formats:['json'],sourcePermissionsRecheckedAtExecution:true,parametersSchema:z.toJSONSchema(e.schema,{io:'input',unrepresentable:'any'})})),savedConfigurationsSupported:true,arbitraryQueriesSupported:false,backgroundJobsIncluded:false}};
}
export const reportDirectoryContract=[{path:'/api/v1/reports/catalogue',method:'get',summary:'Central directory of registered financial,payroll,inventory and learning inputs; baseline scopes filter readers,preset designers may discover all schemas without data rights; full source authorization remains mandatory at execution; JSON only,not arbitrary SQL or background export'}] as const;
