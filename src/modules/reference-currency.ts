import {ApiError} from '../core/policy.ts';

export type ReferenceCurrencySource={currency_id:string|null;source:'explicit'|'hub'|'school'|'unconfigured';defaults_version:number;maximum_age_days:number;age_source:'explicit'|'school'|'zero_days';target:{id:string;version:number;code:string;unitScale:number;active:boolean}|null};
// Code-owned SQL only. Parameters:explicit target,explicit age,selected hubs,
// effective all-hubs flag,permitted hubs,excluded hubs. Caller binds values;
// source amounts and this selection must execute in the SAME statement.
export const referenceCurrencySQL=`WITH settings AS MATERIALIZED(SELECT version,currency_id,maximum_rate_age_days FROM public.finance_reporting_preferences ORDER BY version DESC LIMIT 1),hub_default AS MATERIALIZED(
 SELECT h.currency FROM public.hubs h WHERE h.id=CASE WHEN $3::uuid[] IS NOT NULL THEN CASE WHEN cardinality($3::uuid[])=1 THEN($3::uuid[])[1] END WHEN NOT $4::boolean AND cardinality($5::uuid[])=1 THEN($5::uuid[])[1] END AND($4::boolean OR h.id=ANY($5::uuid[])) AND NOT h.id=ANY($6::uuid[])
),resolved AS MATERIALIZED(
 SELECT CASE WHEN $1::uuid IS NOT NULL THEN $1::uuid WHEN(SELECT currency FROM hub_default) IS NOT NULL THEN(SELECT id FROM public.finance_currency_catalogue WHERE code=(SELECT currency FROM hub_default)) ELSE(SELECT currency_id FROM settings) END currency_id,
 CASE WHEN $1::uuid IS NOT NULL THEN 'explicit' WHEN(SELECT currency FROM hub_default) IS NOT NULL THEN 'hub' WHEN EXISTS(SELECT 1 FROM settings) THEN 'school' ELSE 'unconfigured' END source,
 coalesce((SELECT version FROM settings),0) defaults_version,coalesce($2::integer,(SELECT maximum_rate_age_days FROM settings),0) maximum_age_days,
 CASE WHEN $2::integer IS NOT NULL THEN 'explicit' WHEN EXISTS(SELECT 1 FROM settings) THEN 'school' ELSE 'zero_days' END age_source
)
SELECT resolved.*,(SELECT jsonb_build_object('id',id,'version',version,'code',code,'unitScale',unit_scale,'active',active) FROM public.finance_currency_catalogue WHERE id=resolved.currency_id) target FROM resolved`;
export function requireReferenceCurrency(s:Pick<ReferenceCurrencySource,'source'|'target'>){
 if(!s.target)throw new ApiError(s.source==='explicit'?404:409,s.source==='explicit'?'NOT_FOUND':s.source==='hub'?'HUB_REPORTING_CURRENCY_NOT_CONFIGURED':'REPORTING_CURRENCY_NOT_CONFIGURED');
 if(!s.target.active&&s.source!=='explicit')throw new ApiError(409,'DEFAULT_REPORTING_CURRENCY_RETIRED');return s.target;
}
