import {createHash} from 'node:crypto';
import {open,type FileHandle} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import type pg from 'pg';
import {z} from 'zod';
import {RecoveryError} from './recovery-error.ts';
import {privateDirectory,regularFile} from './recovery-files.ts';
import {r2ObjectStage} from '../integrations/r2-config.ts';

const uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const recordedMediaReference=z.object({academyId:uuid,stage:r2ObjectStage,storageTargetId:sha,fileId:uuid,bytes:z.coerce.number().int().positive().max(4294967296),sha256:sha}).strict();
const bindingInput=z.object({databaseBackupId:uuid,archiveSha256:sha,schemaRevision:z.number().int().positive()}).strict();
export const mediaReferenceCoverage=z.object({binding:bindingInput.extend({plaintextSha256:sha}),recordedReferences:z.number().int().nonnegative().max(10000000),unconfirmedUploads:z.number().int().nonnegative().safe(),signedEvidenceIncluded:z.boolean()}).strict();
export const mediaReferencePlanInput=bindingInput.extend({file:z.string().min(1).max(4096).refine(v=>isAbsolute(v)&&!v.includes('\0')),plaintextSha256:sha,plaintextBytes:z.number().int().positive().max(4294967296)}).strict();
const headerInput=bindingInput.extend({type:z.literal('header'),format:z.literal('kavosh-media-reference-plan-v1'),scope:z.enum(['recorded_ordinary_file_objects','recorded_ordinary_and_signed_evidence_objects']),signedEvidenceIncluded:z.boolean()}).strict().refine(h=>h.scope===(h.signedEvidenceIncluded?'recorded_ordinary_and_signed_evidence_objects':'recorded_ordinary_file_objects'));
const schoolInput=z.object({type:z.literal('academy'),academyId:uuid,unconfirmedUploads:z.number().int().nonnegative().safe()}).strict();
const referenceInput=recordedMediaReference.extend({type:z.literal('reference')}).strict();
const footerInput=z.object({type:z.literal('complete'),academies:z.number().int().nonnegative().max(1000000),references:z.number().int().nonnegative().max(10000000),unconfirmedUploads:z.number().int().nonnegative().safe()}).strict();
export const mediaReferenceKey=(reference:Pick<z.infer<typeof recordedMediaReference>,'stage'|'storageTargetId'|'fileId'>)=>[reference.stage,reference.storageTargetId,reference.fileId].join(':');

// Two bounded passes: authenticate the complete metadata before cloud IO,
// then merge ordered references without buffering a school's files in memory.
export async function openMediaReferencePlan(raw:unknown,academyId:string|null,targets:ReadonlySet<string>,signal?:AbortSignal){
 const parsed=mediaReferencePlanInput.safeParse(raw),school=uuid.safeParse(academyId);if(!parsed.success||academyId!==null&&!school.success)throw new RecoveryError('INVALID_MEDIA_REFERENCE_BINDING');const i=parsed.data;
 let handle:FileHandle|undefined;
 try{
  await privateDirectory(dirname(i.file));const before=await regularFile(i.file,true);if(before.size!==i.plaintextBytes)throw new RecoveryError('MEDIA_REFERENCE_PLAN_CHANGED');
  handle=await open(i.file,constants.O_RDONLY|constants.O_NOFOLLOW);const original=await handle.stat();
  if(original.ino!==before.ino||original.dev!==before.dev||original.size!==before.size||original.uid!==process.getuid?.()||original.nlink!==1||(original.mode&0o077)!==0)throw new RecoveryError('UNSAFE_RECOVERY_FILE');
  const file=handle;
  async function* lines(){
   const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let position=0,pending=Buffer.alloc(0);
   while(true){
    if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');const {bytesRead}=await file.read(buffer,0,buffer.length,position);if(!bytesRead)break;position+=bytesRead;if(position>i.plaintextBytes)throw new RecoveryError('MEDIA_REFERENCE_PLAN_CHANGED');hash.update(buffer.subarray(0,bytesRead));pending=Buffer.concat([pending,buffer.subarray(0,bytesRead)]);
    let end:number;while((end=pending.indexOf(10))!==-1){if(end===0||end>65536)throw new RecoveryError('INVALID_MEDIA_REFERENCE_FORMAT');const line=pending.subarray(0,end);pending=pending.subarray(end+1);yield JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));}if(pending.length>65536)throw new RecoveryError('INVALID_MEDIA_REFERENCE_FORMAT');
   }
   const after=await file.stat();if(pending.length||position!==i.plaintextBytes||hash.digest('hex')!==i.plaintextSha256||after.ino!==original.ino||after.dev!==original.dev||after.size!==original.size||after.mtimeMs!==original.mtimeMs||after.ctimeMs!==original.ctimeMs||after.uid!==original.uid||after.mode!==original.mode||after.nlink!==1)throw new RecoveryError('MEDIA_REFERENCE_PLAN_CHANGED');
  }
  let phase='header',academies=0,references=0,unconfirmed=0,lastSchool='',lastReference='',selectedCount=0,selectedPending:number|undefined,signedEvidenceIncluded=false;
  for await(const value of lines()){
   if(phase==='header'){const h=headerInput.parse(value);if(h.databaseBackupId!==i.databaseBackupId||h.archiveSha256!==i.archiveSha256||h.schemaRevision!==i.schemaRevision)throw new RecoveryError('MEDIA_REFERENCE_BINDING_MISMATCH');signedEvidenceIncluded=h.signedEvidenceIncluded;phase='academies';continue;}
   if(phase==='complete')throw new RecoveryError('INVALID_MEDIA_REFERENCE_FORMAT');
   if(value.type==='academy'){const a=schoolInput.parse(value);if(phase!=='academies'||a.academyId<=lastSchool)throw new RecoveryError('INVALID_MEDIA_REFERENCE_FORMAT');lastSchool=a.academyId;academies++;unconfirmed+=a.unconfirmedUploads;if(!Number.isSafeInteger(unconfirmed)||academies>1000000)throw new RecoveryError('INVALID_MEDIA_REFERENCE_FORMAT');if(a.academyId===academyId)selectedPending=a.unconfirmedUploads;}
   else if(value.type==='reference'){phase='references';const r=referenceInput.parse(value),key=r.academyId+':'+mediaReferenceKey(r);if(r.stage==='signature-evidence'&&!signedEvidenceIncluded||key<=lastReference||++references>10000000)throw new RecoveryError('INVALID_MEDIA_REFERENCE_FORMAT');lastReference=key;if(academyId===null||r.academyId===academyId){if(!targets.has(r.stage+':'+r.storageTargetId))throw new RecoveryError('MEDIA_REFERENCE_TARGET_MISSING');selectedCount++;}}
   else{const f=footerInput.parse(value);if(f.academies!==academies||f.references!==references||f.unconfirmedUploads!==unconfirmed)throw new RecoveryError('INVALID_MEDIA_REFERENCE_FORMAT');phase='complete';}
  }
  if(academyId===null)selectedPending=unconfirmed;
  if(phase!=='complete'||selectedPending===undefined)throw new RecoveryError('MEDIA_REFERENCE_ACADEMY_NOT_FOUND');
  const referencesForSchool=(async function*(){try{for await(const value of lines())if(value.type==='reference'){const r=referenceInput.parse(value);if(academyId===null||r.academyId===academyId)yield r;}}catch(error){if(error instanceof RecoveryError)throw error;throw new RecoveryError('MEDIA_REFERENCE_PLAN_FAILED');}})();
  const academiesForBackup=(async function*(){try{for await(const value of lines())if(value.type==='academy'){const a=schoolInput.parse(value);if(academyId===null||a.academyId===academyId)yield a;}}catch(error){if(error instanceof RecoveryError)throw error;throw new RecoveryError('MEDIA_REFERENCE_PLAN_FAILED');}})();
  return{binding:{databaseBackupId:i.databaseBackupId,archiveSha256:i.archiveSha256,schemaRevision:i.schemaRevision,plaintextSha256:i.plaintextSha256},academies:academyId===null?academies:1,references:selectedCount,unconfirmedUploads:selectedPending,signedEvidenceIncluded,referencesForSchool,academiesForBackup,async close(){try{await referencesForSchool.return(undefined);await academiesForBackup.return(undefined);}finally{await file.close();}}};
 }catch(error){await handle?.close().catch(()=>{});if(error instanceof RecoveryError)throw error;throw new RecoveryError('MEDIA_REFERENCE_PLAN_FAILED');}
}
// Historical physical observations only. Pending grants are not fabricated
// uploads;archived files and superseded routes still require their old bytes.
const ordinaryReferences=`
 SELECT q.academy_id "academyId",'quarantine'::text stage,q.storage_target_id "storageTargetId",q.file_id "fileId",a.measured_bytes bytes,a.sha256
 FROM public.file_inspection_requests q JOIN public.file_inspection_attempts a ON a.academy_id=q.academy_id AND a.inspection_id=q.id WHERE a.outcome IN('no_detection','detected')
 UNION ALL
 SELECT r.academy_id,'clean',a.destination_target_id,r.file_id,a.measured_bytes,a.sha256 FROM public.file_copy_requests r JOIN public.file_copy_attempts a ON a.academy_id=r.academy_id AND a.copy_id=r.id WHERE a.outcome IN('written_verified','existing_verified')
 UNION ALL
 SELECT r.academy_id,'clean',a.destination_target_id,r.file_id,a.measured_bytes,a.sha256 FROM public.file_copy_requests r JOIN public.file_copy_checks c ON c.academy_id=r.academy_id AND c.copy_id=r.id JOIN public.file_copy_check_attempts a ON a.academy_id=c.academy_id AND a.check_id=c.id WHERE a.outcome='verified'
 `;
// Immutable original manifests,including superseded and review-required
// evidence. No current approval/admission filter may discard retained bytes.
const signatureReferences=`SELECT e.academy_id "academyId",'signature-evidence'::text stage,e.manifest->>'storageTargetId' "storageTargetId",(a.value->>'id')::uuid "fileId",(a.value->>'sizeBytes')::bigint bytes,a.value->>'sha256' sha256
 FROM(SELECT academy_id,manifest FROM public.signature_completion_evidence UNION ALL SELECT academy_id,manifest FROM public.work_signature_completion_evidence) e
 CROSS JOIN LATERAL jsonb_each(e.manifest->'receipt') a WHERE a.key IN('document','audit','properties')`;
// Retained image observations remain required after profile/source withdrawal.
// Use the captured schema version to avoid resolving a nonexistent relation
// when recovering an older archive. No current sharing filter or new stage.
const profileImageReferences=`SELECT a.academy_id "academyId",'clean'::text stage,a.receipt->>'storageTargetId' "storageTargetId",(a.receipt->>'objectId')::uuid "fileId",(a.receipt->>'bytes')::bigint bytes,a.receipt->>'sha256' sha256 FROM public.profile_image_job_attempts a WHERE a.outcome='retained'`;
const referenceQuery=(signing:boolean,images:boolean)=>`SELECT * FROM(SELECT DISTINCT "academyId",stage,"storageTargetId","fileId",bytes,sha256 FROM(${ordinaryReferences}${signing?' UNION ALL '+signatureReferences:''}${images?' UNION ALL '+profileImageReferences:''}) observed) refs ORDER BY "academyId",stage COLLATE "C","storageTargetId" COLLATE "C","fileId",bytes,sha256 COLLATE "C"`;
const academies=`SELECT a.id "academyId",coalesce(g.pending,0) "unconfirmedUploads" FROM public.academies a LEFT JOIN(
 SELECT g.academy_id,count(DISTINCT(g.file_id,g.storage_target_id)) pending FROM public.file_upload_grants g
 WHERE NOT EXISTS(SELECT 1 FROM public.file_inspection_requests q JOIN public.file_inspection_attempts e ON e.academy_id=q.academy_id AND e.inspection_id=q.id WHERE q.academy_id=g.academy_id AND q.file_id=g.file_id AND q.storage_target_id=g.storage_target_id AND e.outcome IN('no_detection','detected')) GROUP BY g.academy_id
 ) g ON g.academy_id=a.id ORDER BY a.id`;

// Caller supplies an exclusively created private metadata file and the SAME
// read-only snapshot used by pg_dump. FETCH bounds memory,not a giant rows array.
// No R2 IO,privileged broker call,grant change or private user value is needed.
export async function captureMediaReferencePlan(client:pg.Client,output:FileHandle,rawBinding:unknown,signal?:AbortSignal,includeSignedEvidence=false){
 const parsed=bindingInput.safeParse(rawBinding);if(!parsed.success||typeof includeSignedEvidence!=='boolean')throw new RecoveryError('INVALID_MEDIA_REFERENCE_BINDING');const binding=parsed.data,scope=includeSignedEvidence?'recorded_ordinary_and_signed_evidence_objects':'recorded_ordinary_file_objects';
 const hash=createHash('sha256');let bytes=0,schools=0,rows=0,unconfirmedUploads=0,cursor:string|undefined,lastIdentity='';
 async function write(values:unknown[]){if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');const text=values.map(value=>JSON.stringify(value)+'\n').join('');bytes+=Buffer.byteLength(text);if(bytes>4294967296)throw new RecoveryError('MEDIA_REFERENCE_PLAN_SIZE_LIMIT');hash.update(text);await output.writeFile(text);}
 try{
  if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
  const state=(await client.query<{isolation:string;readOnly:string;unfiltered:boolean;revision:number}>(`SELECT current_setting('transaction_isolation') isolation,current_setting('transaction_read_only') "readOnly",(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) unfiltered,public.schema_revision() revision`)).rows[0];
  if(state?.isolation!=='repeatable read'||state.readOnly!=='on'||state.unfiltered!==true||state.revision!==binding.schemaRevision)throw new RecoveryError('MEDIA_REFERENCE_SNAPSHOT_REQUIRED');
  await client.query("SET LOCAL work_mem='4MB'");await client.query("SET LOCAL statement_timeout='60s'");
  await write([{type:'header',format:'kavosh-media-reference-plan-v1',...binding,scope,signedEvidenceIncluded:includeSignedEvidence}]);
  for(const [name,sql]of [['media_backup_academies',academies],['media_backup_references',referenceQuery(includeSignedEvidence,state.revision>=415)]] as const){
   await client.query('DECLARE '+name+' NO SCROLL CURSOR FOR '+sql);cursor=name;
   while(true){
    if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
    const page=(await client.query('FETCH FORWARD 1000 FROM '+name)).rows;if(!page.length)break;
    const records=page.map(row=>{
     if(name==='media_backup_academies'){const school=z.object({academyId:uuid,unconfirmedUploads:z.coerce.number().int().nonnegative().safe()}).strict().parse(row);schools++;unconfirmedUploads+=school.unconfirmedUploads;if(schools>1000000||!Number.isSafeInteger(unconfirmedUploads))throw new RecoveryError('MEDIA_REFERENCE_PLAN_SIZE_LIMIT');return{type:'academy',...school};}
     const reference=recordedMediaReference.parse(row),identity=[reference.academyId,reference.stage,reference.storageTargetId,reference.fileId].join(':');
     if(identity===lastIdentity)throw new RecoveryError('MEDIA_REFERENCE_CONTENT_CONFLICT');lastIdentity=identity;rows++;if(rows>10000000)throw new RecoveryError('MEDIA_REFERENCE_PLAN_SIZE_LIMIT');return{type:'reference',...reference};
    });await write(records);
   }
   await client.query('CLOSE '+name);cursor=undefined;
  }
  await write([{type:'complete',academies:schools,references:rows,unconfirmedUploads}]);await output.sync();
  return{format:'kavosh-media-reference-plan-v1',...binding,plaintextSha256:hash.digest('hex'),plaintextBytes:bytes,academies:schools,references:rows,unconfirmedUploads,scope,signedEvidenceIncluded:includeSignedEvidence};
 }catch(error){if(error instanceof RecoveryError)throw error;throw new RecoveryError('MEDIA_REFERENCE_PLAN_FAILED');}
 finally{if(cursor)await client.query('CLOSE '+cursor).catch(()=>{});}
}
