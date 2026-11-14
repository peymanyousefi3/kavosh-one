import type {PaidTaxDefinition} from '../core/paid-tax-definition.ts';
import {settlementAuthoritySQL} from './payroll-settlement-report.ts';

export type ZeroNetTaxYearRow={postingId:string;runId:string;profileId:string|null;version:number|null;settlementVersion:number|null;currentSettlementVersion:number;state:string|null;recognizedOn:string|null;settledOn:string|null;grossMinor:string|null;netMinor:string;definition:Omit<PaidTaxDefinition,'review'>|null;sourceCurrent:boolean;postingReversed:boolean;sourceIssue:string|null};
// Included only for server schemas411+. Same statement,worker fence,source
// authority and aggregate budgets as cash;no fabricated payment identity.
export const zeroNetTaxYearCtes=`,settled_zero_candidates AS MATERIALIZED(
 SELECT p.id FROM public.payrun_net_postings p JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id
 JOIN public.zero_net_settlements s ON s.academy_id=p.academy_id AND s.posting_id=p.id JOIN public.zero_net_settlement_revisions sr ON sr.academy_id=s.academy_id AND sr.posting_id=s.posting_id AND sr.version=s.version
 WHERE g.person_id=$3 AND EXISTS(SELECT 1 FROM jsonb_array_elements(g.source_snapshot->'contexts') context WHERE context->>'employerId'=$4::uuid::text)
 AND(jsonb_array_length(g.source_snapshot->'contexts')=1 AND g.source_snapshot#>>'{contexts,0,classification}'='contractor' AND g.source_snapshot#>>'{contexts,0,reportingForm}' IN('T4A','T4A_NR')) IS NOT TRUE
 AND((sr.state='recorded' AND((sr.definition->>'settledAt')::timestamptz AT TIME ZONE $7)::date BETWEEN $5::date AND $6::date)
 OR EXISTS(SELECT 1 FROM public.zero_net_tax_revisions history WHERE history.academy_id=p.academy_id AND history.posting_id=p.id AND(history.source_snapshot#>>'{source,recognizedOn}')::date BETWEEN $5::date AND $6::date)) ORDER BY p.id LIMIT 501
),settled_zero_permitted AS MATERIALIZED(
 SELECT c.id FROM settled_zero_candidates c JOIN public.payrun_net_postings p ON p.id=c.id JOIN public.payrun_groups g ON g.academy_id=p.academy_id AND g.id=p.run_id WHERE ${settlementAuthoritySQL}
),settled_zero_stats AS(
 SELECT count(*)::integer n,coalesce(sum(CASE WHEN r.state='recorded' THEN jsonb_array_length(r.definition->'employeeDeductions')+jsonb_array_length(r.definition->'employerContributions') ELSE 0 END),0)::integer lines,coalesce(sum(octet_length(r.definition::text)),0)::bigint bytes
 FROM settled_zero_permitted c LEFT JOIN public.zero_net_tax_records h ON h.posting_id=c.id LEFT JOIN public.zero_net_tax_revisions r ON r.academy_id=h.academy_id AND r.posting_id=h.posting_id AND r.version=h.version
),settled_zero_usable AS MATERIALIZED(
 SELECT * FROM settled_zero_permitted WHERE(SELECT n FROM stats)+(SELECT n FROM settled_zero_stats)+(SELECT count(*) FROM zero_permitted)<=500
 AND(SELECT lines FROM stats)+(SELECT lines FROM settled_zero_stats)<=20000 AND(SELECT bytes FROM stats)+(SELECT bytes FROM settled_zero_stats)<=2097152
),settled_zero_plans AS MATERIALIZED(
 SELECT c.id,CASE WHEN r.state='recorded' THEN public.zero_net_tax_plan(h.profile_id,h.posting_id,r.version,r.settlement_version,r.definition) END plan
 FROM settled_zero_usable c LEFT JOIN public.zero_net_tax_records h ON h.posting_id=c.id LEFT JOIN public.zero_net_tax_revisions r ON r.academy_id=h.academy_id AND r.posting_id=h.posting_id AND r.version=h.version
),settled_zero_rows AS(
 SELECT p.id "postingId",p.run_id "runId",h.profile_id "profileId",r.version,r.settlement_version "settlementVersion",s.version "currentSettlementVersion",r.state,r.source_snapshot#>>'{source,recognizedOn}' "recognizedOn",
 CASE WHEN sr.state='recorded' THEN(((sr.definition->>'settledAt')::timestamptz AT TIME ZONE $7)::date)::text END "settledOn",r.source_snapshot->>'grossMinor' "grossMinor",'0'::text "netMinor",CASE WHEN r.state='recorded' THEN r.definition-'review' END definition,
 l.plan IS NOT NULL AND(l.plan-'before') IS NOT DISTINCT FROM(r.source_snapshot-'before') AND l.plan->>'unavailable' IS NULL AS "sourceCurrent",p.reversal_id IS NOT NULL "postingReversed",l.plan->>'unavailable' "sourceIssue"
 FROM settled_zero_plans l JOIN public.payrun_net_postings p ON p.id=l.id JOIN public.zero_net_settlements s ON s.academy_id=p.academy_id AND s.posting_id=p.id JOIN public.zero_net_settlement_revisions sr ON sr.academy_id=s.academy_id AND sr.posting_id=s.posting_id AND sr.version=s.version
 LEFT JOIN public.zero_net_tax_records h ON h.academy_id=p.academy_id AND h.posting_id=p.id LEFT JOIN public.zero_net_tax_revisions r ON r.academy_id=h.academy_id AND r.posting_id=h.posting_id AND r.version=h.version
)`;
export const zeroNetTaxYearSelect=`,(SELECT count(*)::integer FROM settled_zero_candidates) "settledCandidates",(SELECT n FROM settled_zero_stats) "settledAuthorized",(SELECT lines FROM settled_zero_stats) "settledLines",(SELECT bytes FROM settled_zero_stats) "settledBytes",coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY "postingId") FROM settled_zero_rows r),'[]'::jsonb) "settledEntries"`;
