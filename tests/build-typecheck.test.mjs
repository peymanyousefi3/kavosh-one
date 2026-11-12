import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
test('production build keeps strict checking of every runtime source while CI still checks all tests and operator scripts',()=>{
 const root=new URL('../',import.meta.url),config=name=>JSON.parse(execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--showConfig','--project',name],{cwd:root,encoding:'utf8',maxBuffer:2097152,timeout:15000})),full=config('tsconfig.json'),build=config('tsconfig.build.json'),runtime=full.files.filter(f=>/^\.\/(?:app|src)\//.test(f));
 assert.ok(runtime.length>200);for(const file of runtime)assert.ok(build.files.includes(file),'Missing runtime typecheck: '+file);
 assert.ok(full.files.some(f=>f.startsWith('./tests/')));assert.ok(full.files.some(f=>f.startsWith('./scripts/')));assert.ok(!build.files.some(f=>/^\.\/(?:tests|scripts|deploy)\//.test(f)));
 for(const option of ['strict','noEmit','isolatedModules']){assert.equal(full.compilerOptions[option],true);assert.equal(build.compilerOptions[option],true);}
 const next=readFileSync(new URL('../next.config.ts',import.meta.url),'utf8');assert.match(next,/tsconfigPath: 'tsconfig.build.json'/);assert.doesNotMatch(next,/ignoreBuildErrors/);
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));assert.equal(pkg.scripts.typecheck,'next typegen && tsc --noEmit');
 const ci=readFileSync(new URL('../.github/workflows/backend.yml',import.meta.url),'utf8');assert.ok(ci.includes('run: pnpm typecheck'));
});
