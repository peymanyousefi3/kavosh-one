import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { quickCheckGroups,quickCheckGroupCount,verifyQuickCheckFiles } from '../scripts/run-quick-checks.mjs';

const prefix="node --import tsx --test --test-concurrency=1 --test-skip-pattern='large|one thousand' ";
test('scanner CI keeps the actual mandatory engine with bounded signed-repository downloads',async()=>{
 const workflow=await readFile(new URL('../.github/workflows/backend.yml',import.meta.url),'utf8'),job=workflow.split('  scanner-engine:')[1]?.split('  video-parser:')[0];assert.ok(job);assert.ok(job.includes('set -euo pipefail'));assert.ok(job.includes('Acquire::Retries=1'));assert.ok(job.includes('Acquire::http::Timeout=15'));assert.ok(job.includes('Acquire::https::Timeout=15'));assert.ok(job.includes('--no-install-recommends clamav-daemon'));assert.ok(job.includes('tests/clamav-engine.test.ts'));assert.ok(job.includes('TEST_CLAMD_BINARY: /usr/sbin/clamd'));assert.doesNotMatch(job,/continue-on-error|allow-unauthenticated|AllowInsecure|Verify-Peer=false|Verify-Host=false|Check-Valid-Until=false/);
 const expression=job.match(/sudo sed -i '([^']+)' \/etc\/apt\/apt-mirrors\.txt/)![1],before='http://azure.archive.ubuntu.com/ubuntu\nhttps://azure.archive.ubuntu.com/ubuntu\nhttps://security.ubuntu.com/ubuntu\nhttps://other.example.test/ubuntu\n',after=execFileSync('sed',['-e',expression],{input:before,encoding:'utf8'});assert.equal(after,'https://archive.ubuntu.com/ubuntu\nhttps://archive.ubuntu.com/ubuntu\nhttps://security.ubuntu.com/ubuntu\nhttps://other.example.test/ubuntu\n');
});
test('quick CI groups cover every authoritative quick-suite file exactly once with original order and stress exclusions',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')),command:string=pkg.scripts['test:quick'],{groups,skipPattern}=quickCheckGroups(command),all=command.match(/tests\/[A-Za-z0-9_.-]+\.test\.ts/g)!;
 assert.equal(groups.length,quickCheckGroupCount);assert.equal(new Set(groups.flat()).size,all.length);assert.deepEqual([...groups.flat()].sort(),[...all].sort());assert.equal(skipPattern,command.match(/--test-skip-pattern='([^']+)'/)![1]);
 verifyQuickCheckFiles(groups,new Set((await readdir(new URL('./',import.meta.url),{withFileTypes:true})).filter(f=>f.isFile()).map(f=>'tests/'+f.name)));
 assert.deepEqual(all.map((_,i)=>groups[i%quickCheckGroupCount][Math.floor(i/quickCheckGroupCount)]),all);assert.ok(groups.every(g=>g.length>0));assert.ok(Math.max(...groups.map(g=>g.length))-Math.min(...groups.map(g=>g.length))<=1);assert.ok(all.includes('tests/quick-check-groups.test.ts'));assert.ok(all.includes('tests/payroll-tax-profiles.test.ts'));
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
 assert.ok(all.includes('tests/privacy-requests.test.ts'));assert.ok(all.includes('tests/t4a-consolidated-working-paper.test.ts'));assert.ok(all.includes('tests/t4a-consolidated-report-jobs.test.ts'));
 const workflow=await readFile(new URL('../.github/workflows/backend.yml',import.meta.url),'utf8'),job=workflow.split('  business-logic:')[1]?.split('  learning:')[0];assert.ok(job);assert.deepEqual(job.match(/group: \[([^\]]+)\]/)![1].match(/'[0-9]+'/g)?.map(v=>Number(v.slice(1,-1))),Array.from({length:quickCheckGroupCount},(_,i)=>i+1));assert.ok(job.includes('max-parallel: '+quickCheckGroupCount));assert.ok(job.includes('timeout-minutes: 30'));assert.ok(job.includes('postgres:17'));
});
test('quick runner refuses a named missing file instead of trusting a declared path or a permissive test runner',()=>{
 const groups=[['tests/real.test.ts'],['tests/missing.test.ts']];assert.throws(()=>verifyQuickCheckFiles(groups,new Set(['tests/real.test.ts'])),/QUICK_TEST_FILE_MISSING/);assert.doesNotThrow(()=>verifyQuickCheckFiles(groups,new Set(groups.flat())));
});
test('quick grouping refuses unsupported flags,missing files,duplicate tests or shell fragments instead of silently weakening CI',()=>{
 assert.deepEqual(quickCheckGroups(prefix+'tests/a.test.ts tests/b.test.ts tests/c.test.ts tests/d.test.ts tests/e.test.ts tests/f.test.ts tests/g.test.ts'),{skipPattern:'large|one thousand',groups:[['tests/a.test.ts','tests/g.test.ts'],['tests/b.test.ts'],['tests/c.test.ts'],['tests/d.test.ts'],['tests/e.test.ts'],['tests/f.test.ts']]});
 for(const command of [prefix,prefix+'tests/a.test.ts',prefix+'tests/a.test.ts tests/a.test.ts',prefix+'tests/a.test.ts tests/b.test.ts; true',prefix+'tests/../secret.test.ts tests/b.test.ts',prefix.replace('--test-concurrency=1','--test-concurrency=4')+'tests/a.test.ts tests/b.test.ts'])assert.throws(()=>quickCheckGroups(command),/QUICK_TEST_/);
});
