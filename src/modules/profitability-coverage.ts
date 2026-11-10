import { financialAccountSelectionSQL } from './financial-reports.ts';
import { journalPointLookupSQL } from './finance-journals.ts';

// Internal CTE names only. The enclosing report generates each baseline proof
// with the original source/target authorization and the SAME MVCC snapshot.
// Amount cancellation cannot prove membership:count actual posted lines,even
// when their account/currency sum is zero. No source ID is returned to readers.
export const profitabilityCoverageSQL=`WITH selected AS MATERIALIZED(${financialAccountSelectionSQL}),operating AS MATERIALIZED(
 SELECT s.currency_id,s.currency_code,s.unit_scale,l.academy_id,l.journal_id,l.line_number,j.reverses_id FROM selected s
 JOIN public.finance_journal_lines l ON l.account_id=s.id ${journalPointLookupSQL}
 JOIN public.finance_account_revisions r ON r.academy_id=l.academy_id AND r.account_id=l.account_id AND r.version=l.account_version
 WHERE j.posted_on BETWEEN $9::date AND $5::date AND r.kind IN('income','expense') AND j.purpose IN('activity','legacy_unclassified')
),originals AS MATERIALIZED(
 SELECT 'manual'::text family,value::uuid source_id FROM jsonb_array_elements_text((SELECT "authorizationContext"->'journals' FROM baseline_manual))
 UNION ALL SELECT 'supplier',value::uuid FROM jsonb_array_elements_text((SELECT "authorizationContext"->'bills' FROM baseline_supplier))
 UNION ALL SELECT 'tuition_invoice',value::uuid FROM jsonb_array_elements_text((SELECT "authorizationContext"->'invoices' FROM baseline_tuition))
 UNION ALL SELECT 'tuition_recognition',value::uuid FROM jsonb_array_elements_text((SELECT "authorizationContext"->'recognitions' FROM baseline_tuition))
 UNION ALL SELECT 'provider_dispute',value::uuid FROM jsonb_array_elements_text((SELECT "authorizationContext"->'postings' FROM baseline_provider))
 UNION ALL SELECT 'payroll_'||(value->>'kind'),(value->>'sourceId')::uuid FROM jsonb_array_elements((SELECT "authorizationContext"->'sources' FROM baseline_payroll))
),claims AS MATERIALIZED(
 SELECT l.academy_id,l.journal_id,l.line_number,o.family,o.source_id FROM operating l
 CROSS JOIN LATERAL(VALUES(l.journal_id),(l.reverses_id)) parent(id) JOIN originals o ON o.source_id=parent.id
 WHERE o.family<>'payroll_employer_contribution' OR EXISTS(
  SELECT 1 FROM public.payrun_net_postings p CROSS JOIN LATERAL jsonb_array_elements(p.plan->'lines') WITH ORDINALITY plan(line,n)
  WHERE p.academy_id=l.academy_id AND p.id=o.source_id AND plan.n=l.line_number AND plan.line->>'side'='debit'
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.input->'employers') mapping WHERE plan.line->>'key'='EMPLOYER-EXPENSE:'||(mapping->>'code'))
 )
),represented AS MATERIALIZED(
 SELECT academy_id,journal_id,line_number,count(DISTINCT(family,source_id)) claims FROM claims GROUP BY academy_id,journal_id,line_number
),totals AS(
 SELECT o.currency_id "currencyId",o.currency_code "currencyCode",max(o.unit_scale) "unitScale",count(*)::text "postedOperatingLineCount",
 count(*) FILTER(WHERE r.claims=1)::text "representedOperatingLineCount",count(*) FILTER(WHERE r.claims IS NULL)::text "unrepresentedOperatingLineCount",count(*) FILTER(WHERE r.claims>1)::text "multiplyRepresentedOperatingLineCount"
 FROM operating o LEFT JOIN represented r ON r.academy_id=o.academy_id AND r.journal_id=o.journal_id AND r.line_number=o.line_number GROUP BY o.currency_id,o.currency_code
)
SELECT coalesce(jsonb_agg(to_jsonb(totals) ORDER BY "currencyId"),'[]'::jsonb) currencies FROM totals`;

export type ProfitabilityCoverageRow={currencyId:string;currencyCode:string;unitScale:number;postedOperatingLineCount:string;representedOperatingLineCount:string;unrepresentedOperatingLineCount:string;multiplyRepresentedOperatingLineCount:string};
