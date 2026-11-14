import {z} from 'zod';
import {isDeepStrictEqual} from 'node:util';
import {ApiError} from '../core/policy.ts';
import type {t4WorkingPaperData} from './t4-working-paper.ts';
import type {t4aWorkingPaperData} from './t4a-working-paper.ts';
import type {consolidatedT4aWorkingPaperData} from './t4a-consolidated-working-paper.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const yearEndDraftOptions=z.object({copyKind:z.enum(['recipient','payer']).default('recipient'),payerEditionSelections:z.array(z.object({reportingAccountId:uuid,version:z.number().int().positive().max(2147483647)}).strict()).max(500).refine(v=>new Set(v.map(e=>e.reportingAccountId)).size===v.length).default([])}).strict();
type Address={lines:string[];city:string;region:string|null;postalCode:string|null;countryCode:string};
type Payer={id:string;version:number;accountNumber:string;legalEmployerName:string|null;address:Address};
type Paper=Awaited<ReturnType<typeof t4WorkingPaperData>>|Awaited<ReturnType<typeof t4aWorkingPaperData>>|Awaited<ReturnType<typeof consolidatedT4aWorkingPaperData>>;
type Packet={workingPaper:Paper;recipient:{personId:string;identityVersion:number;givenNames:string|null;familyName:string|null;address:Address;sin:string|null};payerReportingEditions:Payer[];reviewWarnings:string[]};
type Field={box:string;kind:'amount';minor:string;value:string;printBlank:boolean}|{box:string;kind:'text'|'whole_dollars';value:string;printBlank:boolean}|{box:'28';kind:'exemptions';cppQpp:boolean;ei:boolean;ppip:boolean};
type Row={reportingAccountId:string|null;reportingAccountVersions:number[];provinceOfEmployment:string|null;fields:Field[];issues:string[];declarationVersions:number[]};
const money=(f:{box:string;amount:{minor:string;amount:string};printBlank:boolean}):Field=>({box:f.box,kind:'amount',minor:f.amount.minor,value:f.amount.amount,printBlank:f.printBlank});
const text=(box:string,value:string|null,kind:'text'|'whole_dollars'='text',printBlank=value===null||value===''):Field=>({box,kind,value:value??'',printBlank});
const display=(p:Payer)=>({legalName:p.legalEmployerName,address:p.address,accountNumber:p.accountNumber});

// Authorized internal source only,never caller-supplied money or identity.
// This is a nonvisual draft,not an issued form,PDF or filing authorization.
export function prepareYearEndFormDraft(packet:Packet,rawOptions:unknown){
 const options=yearEndDraftOptions.parse(rawOptions),paper=packet.workingPaper,isT4='yearEndDeclarations'in paper,byAccount=new Map<string,Payer[]>();
 for(const p of packet.payerReportingEditions){const list=byAccount.get(p.id)??[];if(list.some(e=>e.version===p.version))throw new ApiError(409,'YEAR_END_PAYER_SOURCE_REVIEW_REQUIRED');list.push(p);byAccount.set(p.id,list);}
 const selected=new Map(options.payerEditionSelections.map(s=>[s.reportingAccountId,s.version]));
 for(const [id,version]of selected)if(!byAccount.get(id)?.some(p=>p.version===version))throw new ApiError(409,'YEAR_END_PAYER_SELECTION_SOURCE_REQUIRED');
 const resolved=new Map([...byAccount].map(([id,editions])=>{
  const version=selected.get(id),chosen=version!==undefined?editions.find(e=>e.version===version)!:editions.every(e=>isDeepStrictEqual(display(e),display(editions[0])))?editions[0]:null;
  return [id,{chosen,basis:version!==undefined?'explicit_retained_edition':chosen?(editions.length===1?'single_retained_edition':'identical_retained_payer_fields'):'ambiguous_retained_payer_fields',references:(version!==undefined?editions.filter(e=>e.version===version):editions).map(e=>({id:e.id,version:e.version}))}] as const;
 }));
 let rows:Row[];
 if('yearEndDeclarations'in paper){
  rows=paper.slips.map(s=>{
   const declarations=paper.yearEndDeclarations,exemption=declarations.box28.find(e=>e.provinceOfEmployment===s.provinceOfEmployment&&(e.reportingAccountId??null)===s.reportingAccountId)?.declaration,extra=declarations.supplemental.find(e=>e.provinceOfEmployment===s.provinceOfEmployment&&(e.reportingAccountId??null)===s.reportingAccountId)?.declaration;
   const fields:Field[]=[text('10',s.provinceOfEmployment),...s.fields.map(money)],issues:string[]=[],versions:number[]=[];
   if(declarations.box45){fields.push(text('45',declarations.box45.code));versions.push(declarations.box45.profileVersion);}else issues.push('T4_DENTAL_DECLARATION_REVIEW_REQUIRED');
   if(exemption){fields.push({box:'28',kind:'exemptions',cppQpp:exemption.cppQpp,ei:exemption.ei,ppip:exemption.ppip});versions.push(exemption.profileVersion);}else issues.push('T4_EXEMPTION_DECLARATION_REVIEW_REQUIRED');
   if(extra){fields.push(...extra.fields.map(money),text('52',extra.pensionAdjustment.dollars,'whole_dollars',extra.pensionAdjustment.printBlank),text('50',extra.plan.value,'text',extra.plan.printBlank));versions.push(extra.profileVersion);}else issues.push('T4_SUPPLEMENTAL_DECLARATION_REVIEW_REQUIRED');
   if(!s.officialFieldValidation.box14WithinLimit)issues.push('T4_BOX14_AMOUNT_LIMIT_EXCEEDED');
   if(s.unmappedEmployeeDeductions.minor!=='0')issues.push('T4_UNMAPPED_OTHER_DEDUCTIONS_REVIEW_REQUIRED');
   return {reportingAccountId:s.reportingAccountId,reportingAccountVersions:s.reportingAccountVersions,provinceOfEmployment:s.provinceOfEmployment,fields,issues,declarationVersions:[...new Set(versions)].sort((a,b)=>a-b)};
  });
 }else rows=paper.slips.map(s=>({reportingAccountId:s.reportingAccountId,reportingAccountVersions:s.reportingAccountVersions,provinceOfEmployment:null,fields:s.fields.map(money),issues:[],declarationVersions:[]}));
 const slips=rows.map(s=>{
  const payer=s.reportingAccountId?resolved.get(s.reportingAccountId):undefined,p=payer?.chosen,issues=[...s.issues];
  if(!s.reportingAccountId||!s.reportingAccountVersions.length)issues.push('PAYMENT_REPORTING_ACCOUNT_NOT_RECORDED');
  else if(!p)issues.push('PAYER_RETAINED_EDITION_SELECTION_REQUIRED');
  if(p&&!p.legalEmployerName?.trim())issues.push('PAYER_LEGAL_NAME_REVIEW_REQUIRED');
  if(packet.recipient.sin===null)issues.push('RECIPIENT_SIN_NOT_RECORDED');
  const fields=[...s.fields];if(packet.recipient.sin!==null)fields.push(text(isT4?'12':'012',packet.recipient.sin));
  // CRA T4 box54/T4A box061 must NEVER appear on recipient copies. Do
  // not return the original packet/accounts alongside this reduced model.
  if(p&&options.copyKind==='payer')fields.push(text(isT4?'54':'061',p.accountNumber));
  return {reportingAccountId:s.reportingAccountId,provinceOfEmployment:s.provinceOfEmployment,payer:p?{legalName:p.legalEmployerName,address:p.address}:null,payerSelection:{basis:payer?.basis??'unavailable',sourceEditions:payer?.references??[],selectionScope:'retained_reporting_account_editions_in_selected_year'},fields,reviewIssues:issues,sourceDeclarationVersions:s.declarationVersions};
 });
 const unresolved=('unresolvedPaymentCount'in paper?paper.unresolvedPaymentCount:0)+('unresolvedZeroNetSettlementCount'in paper?(paper.unresolvedZeroNetSettlementCount??0):0);
 return {kind:isT4?'t4_form_draft':'t4a_service_form_draft',copyKind:options.copyKind,taxYear:paper.taxYear,currency:'CAD',recipient:{personId:packet.recipient.personId,identityVersion:packet.recipient.identityVersion,givenNames:packet.recipient.givenNames,familyName:packet.recipient.familyName,address:packet.recipient.address},slips,
  reviewIssues:[...packet.reviewWarnings,...slips.length?[]:['NO_RECOGNIZED_SLIPS'],...unresolved?['SOURCE_RECOGNITION_INCOMPLETE']:[]],
  requiredReview:['IDENTITY_AND_PAYER_ASSIGNMENT_REVIEW','ANNUAL_SOURCE_COMPLETENESS_AND_TAX_ELIGIBILITY_REVIEW','OFFICIAL_FIELD_LIMITS_AND_OTHER_INFORMATION_REVIEW'],
  sourceCoverage:{report:paper.report,scope:'selected_recorded_sources_only_not_complete_annual_return',unresolvedRecordedSources:unresolved,unassessedInputs:'notAssessedInputs'in paper?paper.notAssessedInputs:[],nonCashBenefitsAssessed:false,externalPaymentsAssessed:false},
  payerAccountNumbersIncluded:options.copyKind==='payer',privateFieldsIncluded:true,responseRetainedInIdempotencyCache:false,storedInReportArchive:false,layoutPrepared:false,pdfGenerated:false,isOfficialForm:false,readyToIssue:false,craFilingPerformed:false,paymentExecuted:false,additionalLedgerPosting:false};
}
