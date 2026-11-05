import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { quickCheckGroups } from '../scripts/run-quick-checks.mjs';

const prefix="node --import tsx --test --test-concurrency=1 --test-skip-pattern='large|one thousand' ";
test('quick CI groups cover every authoritative quick-suite file exactly once with original order and stress exclusions',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')),command:string=pkg.scripts['test:quick'],{groups,skipPattern}=quickCheckGroups(command),all=command.match(/tests\/[A-Za-z0-9_.-]+\.test\.ts/g)!;
 assert.equal(groups.length,2);assert.equal(new Set(groups.flat()).size,all.length);assert.deepEqual([...groups.flat()].sort(),[...all].sort());assert.equal(skipPattern,command.match(/--test-skip-pattern='([^']+)'/)![1]);
 assert.deepEqual(all.map((_,i)=>groups[i%2][Math.floor(i/2)]),all);assert.ok(groups.every(g=>g.length>0));assert.ok(Math.abs(groups[0].length-groups[1].length)<=1);assert.ok(all.includes('tests/quick-check-groups.test.ts'));
});
test('quick grouping refuses unsupported flags,missing files,duplicate tests or shell fragments instead of silently weakening CI',()=>{
 assert.deepEqual(quickCheckGroups(prefix+'tests/a.test.ts tests/b.test.ts tests/c.test.ts'),{skipPattern:'large|one thousand',groups:[['tests/a.test.ts','tests/c.test.ts'],['tests/b.test.ts']]});
 for(const command of [prefix,prefix+'tests/a.test.ts',prefix+'tests/a.test.ts tests/a.test.ts',prefix+'tests/a.test.ts tests/b.test.ts; true',prefix+'tests/../secret.test.ts tests/b.test.ts',prefix.replace('--test-concurrency=1','--test-concurrency=4')+'tests/a.test.ts tests/b.test.ts'])assert.throws(()=>quickCheckGroups(command),/QUICK_TEST_/);
});
