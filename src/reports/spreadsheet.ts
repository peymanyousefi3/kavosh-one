import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { ApiError } from '../core/policy.ts';

export const spreadsheetMime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// ponytail: two conversions per web process; scale with process replicas. The
// existing API budget still applies. No DB connection is held during encoding.
const active=new Set<string>();
export async function reportSpreadsheet(source:string,principal:string,signal:AbortSignal):Promise<Uint8Array<ArrayBuffer>> {
  if(typeof source!=='string'||Buffer.byteLength(source)>4_194_304)throw new ApiError(413,'SPREADSHEET_SOURCE_TOO_LARGE');
  if(signal.aborted)throw new ApiError(408,'SPREADSHEET_EXPORT_ABORTED');
  if(active.size>=2||active.has(principal))throw new ApiError(429,'SPREADSHEET_EXPORT_BUSY');
  active.add(principal);
  // Resource isolation, NOT a security sandbox. Fixed entry, no inherited
  // environment/loader flags and no caller-selected worker code or options.
  let worker:Worker;
  try {worker=new Worker(join(process.cwd(),'src/reports/xlsx-worker.mjs'),{workerData:source,env:{},execArgv:[],resourceLimits:{maxOldGenerationSizeMb:96,maxYoungGenerationSizeMb:16,stackSizeMb:4}});}
  catch {active.delete(principal);throw new ApiError(503,'SPREADSHEET_EXPORT_UNAVAILABLE');}
  return await new Promise((resolve,reject)=>{
    let result:Uint8Array<ArrayBuffer>|undefined,failure:ApiError|undefined;
    const stop=(error:ApiError)=>{failure??=error;void worker.terminate().catch(()=>{});};
    const abort=()=>stop(new ApiError(408,'SPREADSHEET_EXPORT_ABORTED'));
    const timer=setTimeout(()=>stop(new ApiError(503,'SPREADSHEET_EXPORT_TIMEOUT')),10_000);
    signal.addEventListener('abort',abort,{once:true});
    worker.on('message',message=>{
      if(message?.error==='SPREADSHEET_REQUIRES_CSV'){stop(new ApiError(422,'SPREADSHEET_REQUIRES_CSV'));return;}
      if(result||!message||!(message.bytes instanceof Uint8Array)||!(message.bytes.buffer instanceof ArrayBuffer)||message.bytes.byteLength<4||message.bytes.byteLength>8_388_608||message.bytes[0]!==80||message.bytes[1]!==75){stop(new ApiError(503,'SPREADSHEET_EXPORT_UNAVAILABLE'));return;}
      result=message.bytes;
    });
    worker.on('error',()=>stop(new ApiError(503,'SPREADSHEET_EXPORT_UNAVAILABLE')));
    worker.once('exit',code=>{
      // Keep admission until actual exit, including cancelled/failed workers.
      clearTimeout(timer);signal.removeEventListener('abort',abort);active.delete(principal);
      if(failure)reject(failure);else if(code!==0||!result)reject(new ApiError(503,'SPREADSHEET_EXPORT_UNAVAILABLE'));else resolve(result);
    });
    if(signal.aborted)abort();
  });
}
