import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { quickCheckGroups,quickCheckGroupCount,verifyQuickCheckFiles } from '../scripts/run-quick-checks.mjs';

const prefix="node --import tsx --test --test-concurrency=1 --test-skip-pattern='large|one thousand' ";
test('contractor zero-net recognition runs exactly once with native concurrency in the existing accounting job',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/backend.yml',import.meta.url),'utf8'),step=workflow.split('      - name: Native reviewed contractor settlement deductions')[1]?.split('      - name:')[0];assert.ok(step);assert.ok(step.includes('if: matrix.group == 3'));assert.ok(step.includes('tests/zero-net-t4a-records.test.ts'));assert.equal(workflow.match(/tests\/zero-net-t4a-records\.test\.ts/g)?.length,1);assert.doesNotMatch(step,/continue-on-error|test-name-pattern|test-skip-pattern/);
});
test('new contractor deduction allocation and native concurrency run once in an existing isolated database job',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/backend.yml',import.meta.url),'utf8'),step=workflow.split('      - name: Native reviewed contractor settlement deductions')[1]?.split('      - name:')[0];assert.ok(step);assert.ok(step.includes('if: matrix.group == 3'));assert.ok(step.includes('node --import tsx --test --test-concurrency=1 tests/t4a-non-tax-deductions.test.ts tests/consolidated-private-package.test.ts'));assert.equal(workflow.match(/tests\/t4a-non-tax-deductions\.test\.ts/g)?.length,1);assert.equal(workflow.match(/tests\/consolidated-private-package\.test\.ts/g)?.length,1);assert.doesNotMatch(step,/continue-on-error|test-name-pattern|test-skip-pattern/);
});
test('the packaged platform-notice CLI is exercised separately from the notification image default command',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/backend.yml',import.meta.url),'utf8'),step=workflow.split('      - name: Verify the platform-notice entrypoint has its own complete minimal runtime')[1]?.split('      - name:')[0];assert.ok(step);for(const fragment of ['--read-only','--network none','--cap-drop ALL','--security-opt no-new-privileges:true','--entrypoint node kavosh-notifications:ci scripts/process-platform-notices.js','test "$task_platform_status" -eq 1',"grep -Fx 'Platform notice worker stopped; check isolated configuration without logging credentials.'"])assert.ok(step.includes(fragment));assert.doesNotMatch(step,/continue-on-error|DATABASE_URL|AUTH_SECRET/);
});
test('durable operational inbox runs in the early native owner gate without omitting existing owner fixtures',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/backend.yml',import.meta.url),'utf8'),job=workflow.split('  business-logic:')[1]?.split('  learning:')[0];assert.ok(job);const command=job.split('\n').find(line=>line.includes('tests/platform-health.test.ts'))!;assert.ok(command);assert.deepEqual(command.match(/tests\/[^ ]+\.test\.ts/g),['tests/database-template.test.ts','tests/platform-health.test.ts','tests/platform-directories.test.ts','tests/platform-class-operations.test.ts','tests/platform-learning-session.test.ts','tests/platform-learning-history.test.ts','tests/platform-homework.test.ts','tests/platform-student-care.test.ts','tests/platform-finance.test.ts','tests/platform-operational-events.test.ts','tests/platform-access-directories.test.ts']);assert.equal(job.match(/tests\/database-template\.test\.ts/g)?.length,1);assert.equal(job.match(/tests\/platform-operational-events\.test\.ts/g)?.length,1);assert.equal(job.match(/tests\/platform-class-operations\.test\.ts/g)?.length,1);assert.equal(job.match(/tests\/platform-learning-session\.test\.ts/g)?.length,1);assert.equal(job.match(/tests\/platform-learning-history\.test\.ts/g)?.length,1);assert.equal(job.match(/tests\/platform-homework\.test\.ts/g)?.length,1);assert.equal(job.match(/tests\/platform-student-care\.test\.ts/g)?.length,1);
});
test('native signing failures run first without omitting or repeating the remaining PDF regressions',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/backend.yml',import.meta.url),'utf8'),job=workflow.split('  pdf-parser:')[1]?.split('  scanner-engine:')[0];assert.ok(job);
 const pattern=new RegExp(job.match(/SIGNING_SOURCE_PATTERN: '([^']+)'/)![1]),commands=job.split('\n').filter(line=>line.includes('node --import tsx --test'));
 assert.equal(commands.length,2);assert.ok(commands[0].includes('--test-name-pattern="$SIGNING_SOURCE_PATTERN"'));assert.ok(commands[1].includes('--test-skip-pattern="$SIGNING_SOURCE_PATTERN"'));
 assert.deepEqual(commands[0].match(/tests\/[^ ]+\.test\.ts/g),['tests/signing-original-flow.test.ts','tests/work-signature-original.test.ts']);
 const remaining=commands[1].match(/tests\/[^ ]+\.test\.ts/g)!;assert.equal(remaining.length,13);assert.equal(new Set(remaining).size,13);assert.ok(remaining.includes('tests/pdf-validation.test.ts'));assert.ok(remaining.includes('tests/signing-original-flow.test.ts'));assert.ok(remaining.includes('tests/work-signature-original.test.ts'));
 for(const name of ['approved source,real PDF parsing (Test registry)','approved source,real PDF parsing (Live registry)','two-party worker source uses actual parsed PDF'])assert.equal(pattern.test(name),true);
 for(const name of ['genuine three-party worker agreement','signed archive parsing','PDF runtime missing isolation'])assert.equal(pattern.test(name),false);
 assert.equal(job.match(/PDF_VALIDATION_TEST_REQUIRED: 'true'/g)?.length,2);assert.equal(job.match(/TEST_DATABASE_URL: postgresql:/g)?.length,2);assert.doesNotMatch(job,/continue-on-error/);
});
test('scanner CI keeps the actual mandatory engine with bounded signed-repository downloads',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/backend.yml',import.meta.url),'utf8'),job=workflow.split('  scanner-engine:')[1]?.split('  video-parser:')[0];assert.ok(job);assert.ok(job.includes('set -euo pipefail'));assert.ok(job.includes('Acquire::Retries=1'));assert.ok(job.includes('Acquire::http::Timeout=15'));assert.ok(job.includes('Acquire::https::Timeout=15'));assert.ok(job.includes('--no-install-recommends clamav-daemon'));assert.ok(job.includes('tests/clamav-engine.test.ts'));assert.ok(job.includes('TEST_CLAMD_BINARY: /usr/sbin/clamd'));assert.doesNotMatch(job,/continue-on-error|allow-unauthenticated|AllowInsecure|Verify-Peer=false|Verify-Host=false|Check-Valid-Until=false/);
 const expression=job.match(/sudo sed -i '([^']+)' \/etc\/apt\/apt-mirrors\.txt/)![1],before='http://azure.archive.ubuntu.com/ubuntu\nhttps://azure.archive.ubuntu.com/ubuntu\nhttps://security.ubuntu.com/ubuntu\nhttps://other.example.test/ubuntu\n',after=execFileSync('sed',['-e',expression],{input:before,encoding:'utf8'});assert.equal(after,'https://archive.ubuntu.com/ubuntu\nhttps://archive.ubuntu.com/ubuntu\nhttps://security.ubuntu.com/ubuntu\nhttps://other.example.test/ubuntu\n');
});
test('quick CI groups cover every authoritative file exactly once with within-batch original order and unchanged stress exclusions',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')),command:string=pkg.scripts['test:quick'],{groups,skipPattern}=quickCheckGroups(command),all=command.match(/tests\/[A-Za-z0-9_.-]+\.test\.ts/g)!;
 assert.equal(groups.length,quickCheckGroupCount);assert.equal(new Set(groups.flat()).size,all.length);assert.deepEqual([...groups.flat()].sort(),[...all].sort());assert.equal(skipPattern,command.match(/--test-skip-pattern='([^']+)'/)![1]);
 verifyQuickCheckFiles(groups,new Set((await readdir(new URL('./',import.meta.url),{withFileTypes:true})).filter(f=>f.isFile()).map(f=>'tests/'+f.name)));
 for(const group of groups)assert.deepEqual(group,all.filter(file=>group.includes(file)));assert.ok(groups.every(g=>g.length>0));assert.ok(all.includes('tests/quick-check-groups.test.ts'));assert.ok(all.includes('tests/payroll-tax-profiles.test.ts'));
 assert.ok(all.includes('tests/t4a-service-allocation.test.ts'));
 assert.ok(all.includes('tests/t4a-payment-records.test.ts'));
 assert.ok(all.includes('tests/t4a-working-paper.test.ts'));
 assert.ok(all.includes('tests/year-end-private-package.test.ts'));
 assert.ok(all.includes('tests/paid-tax-selection.test.ts'));
 assert.ok(all.includes('tests/audit-events.test.ts'));
 assert.ok(all.includes('tests/expense-tax-source.test.ts'));
 assert.ok(all.includes('tests/supplier-tax-records.test.ts'));
 assert.ok(all.includes('tests/supplier-tax-working-paper.test.ts'));
 assert.ok(all.includes('tests/supplier-tax-report-jobs.test.ts'));
 assert.ok(all.includes('tests/privacy-requests.test.ts'));assert.ok(all.includes('tests/overview.test.ts'));assert.ok(all.includes('tests/session-follow-up-filter.test.ts'));assert.ok(all.includes('tests/message-payroll-source-access.test.ts'));assert.ok(all.includes('tests/t4a-consolidated-working-paper.test.ts'));assert.ok(all.includes('tests/t4a-consolidated-report-jobs.test.ts'));
 const workflow=await readFile(new URL('../.github/workflows/backend.yml',import.meta.url),'utf8'),job=workflow.split('  business-logic:')[1]?.split('  learning:')[0];assert.ok(job);assert.deepEqual(job.match(/group: \[([^\]]+)\]/)![1].match(/'[0-9]+'/g)?.map(v=>Number(v.slice(1,-1))),Array.from({length:quickCheckGroupCount},(_,i)=>i+1));assert.ok(job.includes('max-parallel: '+quickCheckGroupCount));assert.ok(job.includes('timeout-minutes: 30'));assert.ok(job.includes('postgres:17'));assert.ok(job.indexOf('Native owner access, school isolation and immutable audit')<job.indexOf('Complete assigned quick-logic group'));assert.ok(job.includes('tests/platform-health.test.ts tests/platform-directories.test.ts'));
});
test('measured native timings reduce estimated critical-batch work without dropping files or changing case selection',async()=>{
 const baseline=JSON.parse(await readFile(new URL('../scripts/quick-test-timings.json',import.meta.url),'utf8')),pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')),{groups}=quickCheckGroups(pkg.scripts['test:quick']),all=pkg.scripts['test:quick'].match(/tests\/[A-Za-z0-9_.-]+\.test\.ts/g)!,weight=(file:string)=>(baseline.files[file]??baseline.defaultWeightMs)+baseline.perFileOverheadMs,sum=(files:string[])=>files.reduce((n,f)=>n+weight(f),0),previous=Array.from({length:quickCheckGroupCount},(_,i)=>all.filter((_:string,index:number)=>index%quickCheckGroupCount===i));
 assert.equal(baseline.sourceRun,43412665186);assert.equal(baseline.unit,'milliseconds');assert.ok(baseline.unmappedDurationMs>0);assert.ok(Object.keys(baseline.files).length>200);assert.ok(Math.max(...groups.map(sum))<Math.max(...previous.map(sum)));assert.equal(groups.flat().length,all.length);assert.deepEqual(quickCheckGroups(pkg.scripts['test:quick']).groups,groups);
 const command=prefix+['a','b','c','d','e','f','g','h'].map(n=>'tests/'+n+'.test.ts').join(' '),weights=Object.fromEntries(['a','b','c','d','e','f','g','h'].map((n,i)=>['tests/'+n+'.test.ts',100-i*10]));
 assert.deepEqual(quickCheckGroups(command,weights).groups,[['tests/a.test.ts'],['tests/b.test.ts'],['tests/c.test.ts'],['tests/d.test.ts'],['tests/e.test.ts','tests/h.test.ts'],['tests/f.test.ts','tests/g.test.ts']]);
 for(const invalid of [null,[],{'tests/a.test.ts':0},{'tests/a.test.ts':NaN},{'tests/a.test.ts':'5'},{'tests/../outside.test.ts':5},{'tests/a.test.ts':3600001}])assert.throws(()=>quickCheckGroups(command,invalid),/QUICK_TEST_TIMINGS_INVALID/);
 assert.deepEqual(quickCheckGroups(command,{'tests/unlisted.test.ts':999}).groups.flat().sort(),command.match(/tests\/[a-z]+\.test\.ts/g)!.sort());
});
test('quick runner refuses a named missing file instead of trusting a declared path or a permissive test runner',()=>{
 const groups=[['tests/real.test.ts'],['tests/missing.test.ts']];assert.throws(()=>verifyQuickCheckFiles(groups,new Set(['tests/real.test.ts'])),/QUICK_TEST_FILE_MISSING/);assert.doesNotThrow(()=>verifyQuickCheckFiles(groups,new Set(groups.flat())));
});
test('quick grouping refuses unsupported flags,missing files,duplicate tests or shell fragments instead of silently weakening CI',()=>{
 assert.deepEqual(quickCheckGroups(prefix+'tests/a.test.ts tests/b.test.ts tests/c.test.ts tests/d.test.ts tests/e.test.ts tests/f.test.ts tests/g.test.ts'),{skipPattern:'large|one thousand',groups:[['tests/a.test.ts','tests/g.test.ts'],['tests/b.test.ts'],['tests/c.test.ts'],['tests/d.test.ts'],['tests/e.test.ts'],['tests/f.test.ts']]});
 for(const command of [prefix,prefix+'tests/a.test.ts',prefix+'tests/a.test.ts tests/a.test.ts',prefix+'tests/a.test.ts tests/b.test.ts; true',prefix+'tests/../secret.test.ts tests/b.test.ts',prefix.replace('--test-concurrency=1','--test-concurrency=4')+'tests/a.test.ts tests/b.test.ts'])assert.throws(()=>quickCheckGroups(command),/QUICK_TEST_/);
});
