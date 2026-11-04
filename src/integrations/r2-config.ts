import { z } from 'zod';
import { ApiError } from '../core/policy.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase());
export const r2Connection=z.object({accountId:z.string().regex(/^[a-fA-F0-9]{32}$/).transform(v=>v.toLowerCase()),
  jurisdiction:z.enum(['default','eu']),bucket:z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/).refine(v=>!v.includes('..')),
  accessKeyId:z.string().min(1).max(200).regex(/^[\x21-\x7e]+$/),secretAccessKey:z.string().min(16).max(4096).regex(/^[\x21-\x7e]+$/),
  maximumUploadBytes:z.number().int().min(1).max(4_294_967_296)
}).strict();
export type R2Connection=z.input<typeof r2Connection>;
export type R2UploadConnections=(academyId:string)=>R2Connection|null;

// No SDK initialization or network activity for ordinary API/config requests.
// Credentials are operator-injected, not a client-editable request payload.
export function configuredR2Upload(academyId:string,env:Record<string,string|undefined>=process.env):R2Connection|null {
  if(env.R2_UPLOAD_LINKS_ENABLED!=='true')return null;
  try {
    const id=uuid.parse(academyId),text=env.R2_UPLOAD_CONNECTIONS;
    if(!text||Buffer.byteLength(text)>1_048_576)throw new Error('INVALID_CONFIG');
    const entries=z.array(z.object({academyId:uuid,configuration:z.unknown()}).strict()).max(1000).refine(v=>new Set(v.map(e=>e.academyId)).size===v.length).parse(JSON.parse(text));
    const selected=entries.find(e=>e.academyId===id);return selected?r2Connection.parse(selected.configuration):null;
  }catch{throw new ApiError(503,'R2_NOT_CONFIGURED');}
}
