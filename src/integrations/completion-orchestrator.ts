import { z } from 'zod';
import type { S3ClientConfig } from '@aws-sdk/client-s3';
import { ApiError } from '../core/policy.ts';
import type { Database } from '../core/database.ts';
import type { BoldSignConnection } from './boldsign.ts';
import { reconcileEnrollmentCompletion } from './boldsign-completion.ts';
import { loadSignatureCompletionSource,matchSignatureCompletionSigner,recordSignatureCompletionEvidence } from './signature-completion-source.ts';
import { retainSignatureEvidence } from './signature-evidence-storage.ts';
import { r2Connection,r2TargetId,type R2Connection } from './r2-config.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),task=z.object({academyId:uuid,startId:uuid}).strict();
type Services={database:Database;providers:(academyId:string,connectionId:string,targetId:string)=>BoldSignConnection|null;evidenceStores:(academyId:string)=>{configuration:R2Connection;targetId:string}|null;providerFetch?:typeof fetch;storageHandler?:S3ClientConfig['requestHandler']};
// Explicit operator-only composition,no route/daemon/env activation. The task
// selects ONLY academy/start;native historical authority chooses all signer,
// document,package and routing identities. Never issue a provider POST here.
export async function processEnrollmentCompletion(raw:unknown,services:Services,options:{enabled?:boolean;signal?:AbortSignal}={}){
 const parsed=task.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_SIGNATURE_COMPLETION_TARGET');
 if(options.enabled!==true)return {state:'disabled' as const,evidenceRecorded:false,admissionCleared:false,providerMutationPerformed:false};
 if(options.signal?.aborted)throw new ApiError(503,'SIGNATURE_COMPLETION_INTERRUPTED');
 const source=await loadSignatureCompletionSource(services.database,parsed.data);
 if(!source)return {state:'source_unavailable' as const,evidenceRecorded:false,admissionCleared:false,providerMutationPerformed:false};
 let provider:ReturnType<Services['providers']>,store:ReturnType<Services['evidenceStores']>;
 try{provider=services.providers(source.academyId,source.connectionId,source.connectionTargetId);store=services.evidenceStores(source.academyId);}catch{throw new ApiError(503,'SIGNATURE_COMPLETION_NOT_CONFIGURED');}
 if(!provider||!store)throw new ApiError(503,'SIGNATURE_COMPLETION_NOT_CONFIGURED');
 const configured=r2Connection.safeParse(store.configuration);if(!configured.success||r2TargetId(configured.data)!==store.targetId)throw new ApiError(503,'SIGNATURE_COMPLETION_NOT_CONFIGURED');store={configuration:configured.data,targetId:store.targetId};
 let persisted:Awaited<ReturnType<typeof recordSignatureCompletionEvidence>>|undefined;
 const result=await reconcileEnrollmentCompletion(provider,source,{
  fetch:services.providerFetch,
  matchSigner:(s,observed)=>matchSignatureCompletionSigner(services.database,s,observed),
  retain:async(s,evidence,signal)=>{
   const retained=await retainSignatureEvidence(store.configuration,s,evidence,{targetId:store.targetId,signal},services.storageHandler);
   // Cloud writes can survive a DB failure. Their stable conditional identities
   // permit measured recovery;never delete/re-send or claim write finality.
   persisted=await recordSignatureCompletionEvidence(services.database,{academyId:s.academyId,startId:s.startId,sourceFingerprint:s.sourceFingerprint,propertiesJson:evidence.properties.bytes.toString('utf8'),storage:{receipt:retained.receipt,storageTargetId:retained.storageTargetId,etags:retained.etags}});
   return retained.receipt;
  }
 },{signal:options.signal});
 if(result.state==='not_completed')return {...result,evidenceRecorded:false};
 if(!persisted)throw new ApiError(503,'SIGNATURE_COMPLETION_EVIDENCE_UNAVAILABLE');
 return {state:persisted.state,id:persisted.id,inserted:persisted.inserted,evidenceRecorded:true,reviewPending:true,admissionCleared:false,legalValidityCertified:false,malwareFreeVerified:false,providerMutationPerformed:false};
}
