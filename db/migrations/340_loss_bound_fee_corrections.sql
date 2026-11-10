-- Reuse the existing atomic inverse/replacement workflow. After a loss,
-- only fees may change:the principal,currency,custody and disputed-asset
-- mappings must remain exactly the ones already reviewed in loss books.
DO $$ DECLARE d text;needle text;replacement text;BEGIN
 d=pg_get_functiondef('public.provider_dispute_correction_source(uuid,uuid,date,uuid,uuid,uuid,uuid)'::regprocedure);
 needle=$q$IF EXISTS(SELECT 1 FROM public.provider_dispute_losses l JOIN public.provider_dispute_postings d ON d.academy_id=l.academy_id AND d.collection_id=l.collection_id AND d.dispute_id=l.dispute_id WHERE d.id=p_posting) THEN RETURN NULL;END IF;$q$;
 IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'LOSS_FEE_CORRECTION_BLOCK_BASE_CHANGED';END IF;d=replace(d,needle,'');
 needle='prior jsonb;next jsonb;';IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'LOSS_FEE_CORRECTION_DECLARATION_CHANGED';END IF;d=replace(d,needle,needle||'loss_context jsonb:=''{}''::jsonb;');
 needle=$q$RETURN jsonb_build_object('postingId',r.id$q$;
 replacement=$r$IF EXISTS(SELECT 1 FROM public.provider_dispute_losses WHERE academy_id=r.academy_id AND collection_id=r.collection_id AND dispute_id=r.dispute_id) THEN
 IF public.provider_dispute_reviewed_recovery_total(r.collection_id,r.dispute_id,p_on) IS NULL
 OR(SELECT jsonb_object_agg(k,prior->k) FROM unnest(ARRAY['accountId','livemode','balanceTransactionId','disputeId','processorAccountId','disputedAccountId','currencyId','currencyCode','unitScale','grossMinor']) k) IS DISTINCT FROM(SELECT jsonb_object_agg(k,next->k) FROM unnest(ARRAY['accountId','livemode','balanceTransactionId','disputeId','processorAccountId','disputedAccountId','currencyId','currencyCode','unitScale','grossMinor']) k)
 OR(SELECT jsonb_object_agg(k,prior->'evidence'->k) FROM unnest(ARRAY['chargeId','disputeId','balanceTransactionId','balanceType','transactionType','reportingCategory','source','providerUnitScale','grossAmount','currency']) k) IS DISTINCT FROM(SELECT jsonb_object_agg(k,next->'evidence'->k) FROM unnest(ARRAY['chargeId','disputeId','balanceTransactionId','balanceType','transactionType','reportingCategory','source','providerUnitScale','grossAmount','currency']) k)
 OR next#>'{evidence,requiresFxReview}' IS DISTINCT FROM 'false'::jsonb OR next#>'{evidence,recognizedDisputeAdjustment}' IS DISTINCT FROM 'true'::jsonb OR next#>>'{evidence,sourceBinding}' IS DISTINCT FROM 'dispute'
 OR EXISTS(SELECT 1 FROM public.provider_dispute_losses l WHERE l.academy_id=r.academy_id AND l.collection_id=r.collection_id AND l.dispute_id=r.dispute_id AND(l.posted_on>p_on OR l.disputed_account::text IS DISTINCT FROM next->>'disputedAccountId' OR l.source->'currencyId' IS DISTINCT FROM next->'currencyId' OR l.source->'unitScale' IS DISTINCT FROM next->'unitScale')) THEN RETURN NULL;END IF;
 loss_context=jsonb_build_object('lossContextStamp',encode(sha256(convert_to(jsonb_build_object('loss',(SELECT to_jsonb(l) FROM public.provider_dispute_losses l WHERE l.academy_id=r.academy_id AND l.collection_id=r.collection_id AND l.dispute_id=r.dispute_id),'recoveries',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.recovery_no) FROM public.provider_dispute_loss_recoveries x WHERE x.academy_id=r.academy_id AND x.collection_id=r.collection_id AND x.dispute_id=r.dispute_id),'[]'::jsonb))::text,'UTF8')),'hex'));
 END IF;
 RETURN loss_context||jsonb_build_object('postingId',r.id$r$;IF strpos(d,needle)=0 THEN RAISE EXCEPTION 'LOSS_FEE_CORRECTION_SOURCE_BASE_CHANGED';END IF;EXECUTE replace(d,needle,replacement);
END $$;
CREATE FUNCTION public.provider_dispute_correction_loss_privacy() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ DECLARE collection uuid;bindings jsonb;BEGIN
 SELECT collection_id INTO collection FROM public.provider_dispute_postings WHERE academy_id=NEW.academy_id AND id=(NEW.payload->>'postingId')::uuid;
 IF EXISTS(SELECT 1 FROM public.provider_dispute_losses WHERE academy_id=NEW.academy_id AND collection_id=collection) THEN
 SELECT coalesce(jsonb_agg(DISTINCT b.value),'[]'::jsonb) INTO bindings FROM public.approval_requests p CROSS JOIN LATERAL jsonb_array_elements(p.privacy_bindings) b WHERE p.academy_id=NEW.academy_id AND(p.id IN(SELECT approval_id FROM public.provider_dispute_losses WHERE academy_id=NEW.academy_id AND collection_id=collection) OR p.id IN(SELECT approval_id FROM public.provider_dispute_loss_recoveries WHERE academy_id=NEW.academy_id AND collection_id=collection));
 IF jsonb_array_length(bindings)>60 THEN RAISE EXCEPTION 'DISPUTE_LOSS_FEE_PRIVACY_REQUIRES_BACKGROUND' USING ERRCODE='23514';END IF;
 NEW.privacy_bindings=NEW.privacy_bindings||bindings||jsonb_build_array(jsonb_build_object('capability','dispute-losses.view','scope',NEW.scope));END IF;RETURN NEW;
END $$;
CREATE TRIGGER zzz_provider_dispute_correction_loss_privacy BEFORE INSERT ON public.approval_requests FOR EACH ROW WHEN(NEW.action='finance.provider-dispute.correct') EXECUTE FUNCTION public.provider_dispute_correction_loss_privacy();
REVOKE ALL ON FUNCTION public.provider_dispute_correction_loss_privacy() FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.schema_revision() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 340 $$;
