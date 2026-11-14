import {constants} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {z} from 'zod';
import {evaluateOperationalHealth,healthObservation} from './operational-health.ts';

const snapshot=healthObservation.extend({format:z.literal('kavosh-operational-health-v1'),issues:z.array(z.object({component:z.string(),code:z.string(),severity:z.enum(['warning','critical'])}).strict()).max(20),status:z.enum(['healthy','warning','critical']),workerCoverage:z.enum(['required_process_states_observed','not_observed']).optional(),queueProgressVerified:z.literal(false).optional(),observationVantage:z.literal('same-vps'),independentUptimeVerified:z.literal(false),externalMessagesSent:z.literal(0),applicationChangesMade:z.literal(false)}).strict();
export function operationalHealthStatus(raw:unknown,now=Date.now()){
 const stored=snapshot.parse(raw),{format,issues,status,workerCoverage,queueProgressVerified,observationVantage,independentUptimeVerified,externalMessagesSent,applicationChangesMade,...observation}=stored;
 const result=evaluateOperationalHealth(observation),age=now-Date.parse(result.observedAt);
 // Recompute findings: never trust a stored healthy label or keep showing a
 // green sample after the monitoring timer has stopped.
 if(!Number.isFinite(now))throw new Error('INVALID_HEALTH_CLOCK');
 if(age< -30000||age>180000){result.issues.push({component:'monitor',code:age<0?'MONITOR_CLOCK_INCONSISTENT':'MONITOR_OBSERVATION_STALE',severity:'critical'});result.status='critical';}
 return result;
}
export async function readOperationalHealthStatus(directory='/run/kavosh-one-health',now=Date.now()){
 const before=await lstat(directory);
 // Host-generated /run metadata is read at runtime,not a bundled project asset.
 if(!before.isDirectory()||before.isSymbolicLink()||(before.mode&0o777)!==0o750||await realpath(/* turbopackIgnore: true */ directory)!==resolve(/* turbopackIgnore: true */ directory))throw new Error('UNSAFE_HEALTH_DIRECTORY');
 const path=directory+'/status.json',metadata=await lstat(path);
 if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.nlink!==1||metadata.uid!==before.uid||(metadata.mode&0o777)!==0o640||metadata.size>16384)throw new Error('UNSAFE_HEALTH_FILE');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const current=await file.stat();if(current.ino!==metadata.ino||current.dev!==metadata.dev||current.size!==metadata.size||current.nlink!==1||current.uid!==before.uid||(current.mode&0o777)!==0o640)throw new Error('HEALTH_FILE_CHANGED');const bytes=Buffer.alloc(metadata.size+1),read=await file.read(bytes,0,bytes.length,0);if(read.bytesRead!==metadata.size)throw new Error('HEALTH_FILE_CHANGED');return operationalHealthStatus(JSON.parse(bytes.subarray(0,read.bytesRead).toString('utf8')),now);}finally{await file.close();}
}
