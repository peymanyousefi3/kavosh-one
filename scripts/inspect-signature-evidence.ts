// Explicit non-root operator inspection of ONE original retained artifact.
// No webhook/provider key,sending,publication or automatic service activation.
import assert from 'node:assert/strict';
import pg from 'pg';
import { z } from 'zod';
import { postgresOptions } from '../src/core/postgres-config.ts';
import type { Database } from '../src/core/database.ts';
import { signatureEvidenceConfiguration } from '../src/integrations/signature-evidence-config.ts';
import { processSignatureEvidenceInspection,processWorkSignatureEvidenceInspection } from '../src/integrations/signature-evidence-worker.ts';
import { assertPrivatePdfSocket } from '../src/files/pdf-runtime.ts';

const uuid=z.string().uuid().transform(v=>v.toLowerCase()),target=z.tuple([z.enum(['unified_enrollment','worker_services']),uuid,uuid,z.enum(['document','audit']),uuid]);
const stopping=new AbortController();for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>stopping.abort());
let pool:pg.Pool|undefined;
try{
 assert.notEqual(process.getuid?.(),0);
 const [purpose,academyId,evidenceId,kind,operationId]=target.parse(process.argv.slice(2)),configuration=signatureEvidenceConfiguration();
 if(!configuration||!configuration.academyIds.includes(academyId))throw Error();
 await assertPrivatePdfSocket(configuration.pdfService.socketPath);
 pool=new pg.Pool({...postgresOptions(process.env.SIGNATURE_EVIDENCE_DATABASE_URL),max:2,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000});pool.on('error',()=>console.error('signature_evidence_database_pool_error'));
 const run=purpose==='worker_services'?processWorkSignatureEvidenceInspection:processSignatureEvidenceInspection;
 const result=await run({academyId,evidenceId,kind,operationId},{database:pool as unknown as Database,...configuration},{enabled:true,signal:AbortSignal.any([stopping.signal,AbortSignal.timeout(120000)])});
 console.log(JSON.stringify({purpose,kind,recorded:result.recorded,inserted:'inserted'in result?result.inserted:false,alreadyRecorded:'alreadyRecorded'in result?result.alreadyRecorded:false,outcome:'outcome'in result?result.outcome:null,privateContentIncluded:false,admissionCleared:false,paymentCleared:false,cryptographicValidityVerified:false}));
 if(!result.recorded)process.exitCode=2;
}catch{console.error('SIGNATURE_EVIDENCE_INSPECTION_STOPPED: check explicit target,private configuration and isolated services without logging credentials.');process.exitCode=1;}
finally{await pool?.end();}
