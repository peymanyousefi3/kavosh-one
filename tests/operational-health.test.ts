import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {evaluateOperationalHealth,systemdExitTime,operationalWorkerUnits,selectedOperationalWorkerUnits} from '../src/operations/operational-health.ts';
const now='2026-11-13T12:00:00.000Z',completed={active:'inactive',result:'success',exitStatus:0,lastSuccessfulExitAt:'2026-11-13T08:00:00.000Z'},workers=Object.fromEntries(Object.keys(operationalWorkerUnits).map(key=>[key,{...completed,active:'active'}])),normal={observedAt:now,ready:true,freeBackupDiskBytes:'50000000000',web:{...completed,active:'active'},backup:completed,configuration:completed,backupTimerActive:true,configurationTimerActive:true,workers};
test('normal observation is healthy but never certifies independent uptime or external alert delivery',()=>{
 const result=evaluateOperationalHealth(normal);assert.equal(result.status,'healthy');assert.deepEqual(result.issues,[]);assert.equal(result.independentUptimeVerified,false);assert.equal(result.observationVantage,'same-vps');assert.equal(result.externalMessagesSent,0);assert.equal(result.applicationChangesMade,false);
});
test('every required worker is checked independently and unknown or failed workers cannot hide behind web readiness',()=>{
 assert.equal(Object.keys(operationalWorkerUnits).length,12);assert.equal(new Set(Object.values(operationalWorkerUnits)).size,12);assert.ok(!Object.values(operationalWorkerUnits).some(unit=>/signature-completion|build-|probe-|^kavosh\.service$/.test(unit)));
 for(const worker of Object.keys(workers))for(const [patch,code]of [[{active:'inactive'},'WORKER_NOT_RUNNING'],[{active:'failed'},'WORKER_NOT_RUNNING'],[{active:'activating'},'WORKER_NOT_RUNNING'],[{active:'deactivating'},'WORKER_NOT_RUNNING'],[{active:'unknown'},'WORKER_STATUS_UNAVAILABLE'],[{result:'unknown'},'WORKER_STATUS_UNAVAILABLE'],[{exitStatus:null},'WORKER_STATUS_UNAVAILABLE'],[{exitStatus:1},'WORKER_PROCESS_FAILURE'],[{result:'exit-code'},'WORKER_PROCESS_FAILURE']] as const){const result=evaluateOperationalHealth({...normal,workers:{...workers,[worker]:{...workers[worker],...patch}}});assert.equal(result.status,'critical');assert.deepEqual(result.issues,[{component:'worker:'+worker,code,severity:'critical'}]);assert.equal(result.ready,true);assert.equal(result.queueProgressVerified,false);}
 const {workers:_,...legacy}=normal,old=evaluateOperationalHealth(legacy);assert.equal(old.status,'warning');assert.equal(old.workerCoverage,'not_observed');assert.equal(old.issues[0].code,'WORKER_STATUS_NOT_OBSERVED');assert.equal(evaluateOperationalHealth(normal).workerCoverage,'required_process_states_observed');
 const missing={...workers};delete missing.scanner;assert.throws(()=>evaluateOperationalHealth({...normal,workers:missing}));assert.throws(()=>evaluateOperationalHealth({...normal,workers:{...workers,arbitrary:completed}}));assert.throws(()=>evaluateOperationalHealth({...normal,workers:{...workers,scanner:{...workers.scanner,credential:'PRIVATE'}}}));
});
test('failed,missing,disabled,stale and future-clock backups are distinct failures,not silently accepted old successes',()=>{
 for(const [value,code]of [[{...completed,active:'failed',result:'exit-code',exitStatus:1},'BACKUP_LAST_RUN_FAILED'],[{...completed,active:'unknown',result:'unknown'},'BACKUP_STATUS_UNAVAILABLE'],[{...completed,lastSuccessfulExitAt:null},'BACKUP_SUCCESS_NOT_VERIFIED'],[{...completed,lastSuccessfulExitAt:'2026-11-11T12:00:00.000Z'},'BACKUP_OVERDUE'],[{...completed,lastSuccessfulExitAt:'2026-11-13T12:10:00.000Z'},'BACKUP_CLOCK_INCONSISTENT']] as const){const r=evaluateOperationalHealth({...normal,backup:value});assert.equal(r.status,'critical');assert.ok(r.issues.some(i=>i.component==='database-backup'&&i.code===code));}
 for(const field of ['backupTimerActive','configurationTimerActive'])assert.ok(evaluateOperationalHealth({...normal,[field]:false}).issues.some(i=>i.code==='BACKUP_TIMER_INACTIVE'));
 const active=evaluateOperationalHealth({...normal,backup:{...completed,active:'activating'}});assert.equal(active.status,'healthy');assert.equal(active.backup.lastSuccessfulExitAt,completed.lastSuccessfulExitAt);
 assert.ok(evaluateOperationalHealth({...normal,backupTimerActive:null}).issues.some(i=>i.code==='BACKUP_TIMER_STATUS_UNAVAILABLE'));const unknown=evaluateOperationalHealth({...normal,web:{...completed,active:'unknown',result:'unknown',exitStatus:null},backup:{...completed,active:'unknown',result:'unknown',exitStatus:null},backupTimerActive:null});assert.ok(unknown.issues.some(i=>i.code==='WEB_STATUS_UNAVAILABLE'));assert.ok(unknown.issues.some(i=>i.code==='BACKUP_STATUS_UNAVAILABLE'));assert.ok(!unknown.issues.some(i=>i.code==='WEB_NOT_RUNNING'||i.code==='BACKUP_TIMER_INACTIVE'));
});
test('operator-enabled signing worker states are observed without requiring activation in legacy deployments',()=>{
 for(const flag of [undefined,'false'])assert.deepEqual(selectedOperationalWorkerUnits(flag),operationalWorkerUnits);
 assert.deepEqual(selectedOperationalWorkerUnits('true'),{...operationalWorkerUnits,'signature-completion':'kavosh-one-signature-completion.service'});
 for(const flag of ['yes','1','TRUE','kavosh.service',''])assert.throws(()=>selectedOperationalWorkerUnits(flag),/INVALID_SIGNATURE_MONITOR_FLAG/);
 const signing={...completed,active:'active'},enabled={...normal,workers:{...workers,'signature-completion':signing}};
 assert.equal(evaluateOperationalHealth(enabled).status,'healthy');assert.equal(evaluateOperationalHealth(normal).status,'healthy');
 for(const [patch,code]of [[{active:'inactive'},'WORKER_NOT_RUNNING'],[{active:'failed'},'WORKER_NOT_RUNNING'],[{active:'unknown'},'WORKER_STATUS_UNAVAILABLE'],[{exitStatus:1},'WORKER_PROCESS_FAILURE']] as const){const r=evaluateOperationalHealth({...enabled,workers:{...enabled.workers,'signature-completion':{...signing,...patch}}});assert.equal(r.status,'critical');assert.deepEqual(r.issues,[{component:'worker:signature-completion',code,severity:'critical'}]);}
 assert.throws(()=>evaluateOperationalHealth({...enabled,workers:{...enabled.workers,'signature-completion':{...signing,secret:'PRIVATE'}}}));
});
test('separately enabled image worker is monitored without enabling signing or changing legacy worker requirements',()=>{
 for(const flag of [undefined,'false'])assert.deepEqual(selectedOperationalWorkerUnits(undefined,flag),operationalWorkerUnits);
 assert.deepEqual(selectedOperationalWorkerUnits('false','true'),{...operationalWorkerUnits,'profile-images':'kavosh-one-profile-images.service'});assert.equal(Object.keys(selectedOperationalWorkerUnits('true','true')).length,14);
 for(const flag of ['yes','1','TRUE',''])assert.throws(()=>selectedOperationalWorkerUnits(undefined,flag),/INVALID_PROFILE_IMAGE_MONITOR_FLAG/);
 const image={...completed,active:'active'};assert.equal(evaluateOperationalHealth({...normal,workers:{...workers,'profile-images':image}}).status,'healthy');const r=evaluateOperationalHealth({...normal,workers:{...workers,'profile-images':{...image,active:'failed'}}});assert.deepEqual(r.issues,[{component:'worker:profile-images',code:'WORKER_NOT_RUNNING',severity:'critical'}]);assert.equal(r.queueProgressVerified,false);
});
test('readiness failure,process failure and disk thresholds remain bounded without duplicate web alerts',()=>{
 assert.equal(evaluateOperationalHealth({...normal,ready:false}).issues[0].code,'READINESS_UNAVAILABLE');const stopped=evaluateOperationalHealth({...normal,ready:false,web:{...completed,active:'inactive'}});assert.equal(stopped.issues.length,1);assert.equal(stopped.issues[0].code,'WEB_NOT_RUNNING');
 for(const [bytes,status]of [['0','critical'],['2147483647','critical'],['2147483648','warning'],['4294967295','warning'],['4294967296','healthy'],['999999999999999999999999','healthy']])assert.equal(evaluateOperationalHealth({...normal,freeBackupDiskBytes:bytes}).status,status);
 assert.throws(()=>evaluateOperationalHealth({...normal,freeBackupDiskBytes:'-1'}));assert.throws(()=>evaluateOperationalHealth({...normal,credential:'PRIVATE'}));
});
test('systemd timestamps are parsed only in the measured UTC format without guessing invalid dates or local zones',()=>{
 assert.equal(systemdExitTime('Fri 2026-11-13 10:04:13 UTC'),'2026-11-13T10:04:13.000Z');assert.equal(systemdExitTime('Fri 2026-11-13 10:04:13.123456 UTC'),'2026-11-13T10:04:13.123Z');
 for(const value of ['','n/a','2026-11-13','Fri 2026-11-13 10:04:13 EST','Fri 2026-02-31 10:04:13 UTC','Fri 2026-11-13 25:04:13 UTC'])assert.equal(systemdExitTime(value),null);
});
test('monitor service has no credentials,root identity,database role or landing-page command',()=>{
 const unit=readFileSync(new URL('../deploy/ovh/kavosh-one-monitor.service',import.meta.url),'utf8'),timer=readFileSync(new URL('../deploy/ovh/kavosh-one-monitor.timer',import.meta.url),'utf8');
 for(const text of ['User=kavosh-one-monitor','Group=kavosh-one-monitor','StateDirectory=kavosh-one-health','StateDirectoryMode=0700','ProtectSystem=strict','NoNewPrivileges=yes','CapabilityBoundingSet=','MemoryMax=128M','CPUQuota=10%','InaccessiblePaths=/etc/kavosh-one /etc/kavosh-one-tls'])assert.ok(unit.includes(text));assert.ok(!unit.includes('User=nobody'));assert.ok(!unit.includes('DynamicUser'));
 assert.doesNotMatch(unit,/EnvironmentFile|LoadCredential|User=root|kavosh\.ai|\/srv\/kavosh\//);assert.match(timer,/OnCalendar=\*-\*-\* \*:\*:00 UTC/);assert.match(timer,/RandomizedDelaySec=5s/);
 assert.match(unit,/^Environment=SIGNATURE_COMPLETION_MONITOR_ENABLED=false$/m);
 assert.match(unit,/^Environment=PROFILE_IMAGE_MONITOR_ENABLED=false$/m);
 for(const text of ['RuntimeDirectory=kavosh-one-health','RuntimeDirectoryMode=0750','RuntimeDirectoryPreserve=yes'])assert.ok(unit.includes(text));
 const web=readFileSync(new URL('../deploy/ovh/kavosh-one.service',import.meta.url),'utf8');assert.match(web,/^SupplementaryGroups=kavosh-one-monitor$/m);
});
