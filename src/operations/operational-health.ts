import {z} from 'zod';
const time=z.iso.datetime(),service=z.object({active:z.enum(['active','activating','deactivating','inactive','failed','unknown']),result:z.string().regex(/^[a-z-]{1,40}$/),exitStatus:z.number().int().min(0).max(255),lastSuccessfulExitAt:time.nullable()}).strict();
export const healthObservation=z.object({observedAt:time,ready:z.boolean(),freeBackupDiskBytes:z.string().regex(/^(0|[1-9][0-9]{0,30})$/),web:service,backup:service,configuration:service,backupTimerActive:z.boolean(),configurationTimerActive:z.boolean()}).strict();
export function evaluateOperationalHealth(raw:unknown){
 const observation=healthObservation.parse(raw),now=Date.parse(observation.observedAt),issues:{component:string;code:string;severity:'warning'|'critical'}[]=[];
 const add=(component:string,code:string,severity:'warning'|'critical'='critical')=>issues.push({component,code,severity});
 if(observation.web.active!=='active')add('web','WEB_NOT_RUNNING');else if(!observation.ready)add('web','READINESS_UNAVAILABLE');
 for(const [component,value]of [['database-backup',observation.backup],['settings-backup',observation.configuration]] as const){
  const timer=component==='database-backup'?observation.backupTimerActive:observation.configurationTimerActive;
  if(!timer)add(component,'BACKUP_TIMER_INACTIVE');
  else if(value.active==='unknown'||value.result==='unknown')add(component,'BACKUP_STATUS_UNAVAILABLE');
  else if(value.active==='failed'||value.result!=='success'||value.exitStatus!==0)add(component,'BACKUP_LAST_RUN_FAILED');
  else if(value.lastSuccessfulExitAt===null)add(component,'BACKUP_SUCCESS_NOT_VERIFIED');
  else{const age=now-Date.parse(value.lastSuccessfulExitAt);if(age< -300000)add(component,'BACKUP_CLOCK_INCONSISTENT');else if(age>36*3600000)add(component,'BACKUP_OVERDUE');}
 }
 const free=BigInt(observation.freeBackupDiskBytes);if(free<2147483648n)add('storage','BACKUP_DISK_SPACE_CRITICAL');else if(free<4294967296n)add('storage','BACKUP_DISK_SPACE_LOW','warning');
 return{format:'kavosh-operational-health-v1' as const,...observation,issues,status:issues.some(i=>i.severity==='critical')?'critical' as const:issues.length?'warning' as const:'healthy' as const,observationVantage:'same-vps' as const,independentUptimeVerified:false,externalMessagesSent:0,applicationChangesMade:false};
}

// systemctl is forced to UTC/C locale. Unknown formats fail closed instead of
// guessing a local date or presenting a stale backup as successful.
export function systemdExitTime(value:string){
 const match=/^[A-Za-z]{3} (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.([0-9]{1,6}))? UTC$/.exec(value);
 if(!match)return null;const parsed=new Date(match[1]+'T'+match[2]+'.'+(match[3]??'').padEnd(3,'0').slice(0,3)+'Z');if(!Number.isFinite(parsed.getTime()))return null;const iso=parsed.toISOString();return iso.slice(0,10)===match[1]&&iso.slice(11,19)===match[2]?iso:null;
}
