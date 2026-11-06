import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('committed API reference is byte-exact generator output with sorted paths,without rewriting files',()=>{
 const target=new URL('../public/openapi.json',import.meta.url),generator=new URL('../scripts/generate-api.ts',import.meta.url);
 // Observe the real generator output;do not turn a stale checked-in artifact
 // green by rewriting it as part of its own test.
 const program=`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
 fs.writeFile=async(file,data)=>{if(String(file)!==${JSON.stringify(String(target))})throw Error('UNEXPECTED_API_WRITE');process.stdout.write(data);};
 syncBuiltinESMExports();await import(${JSON.stringify(String(generator))});`;
 const output=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',program],{cwd:fileURLToPath(new URL('../',import.meta.url)),maxBuffer:8_388_608,timeout:15000});
 const saved=readFileSync(target),paths=Object.keys(JSON.parse(saved.toString()).paths);assert.deepEqual(paths,[...paths].sort());assert.ok(output.equals(saved),'API reference differs from current generator output');
});
