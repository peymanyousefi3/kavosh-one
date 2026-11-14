import { readFile,readdir } from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// One authoritative quick-suite list. Each CI runner has its own PostgreSQL
// service; keep tests serial WITHIN that runner because native roles are shared.
export const quickCheckGroupCount=6;
const baseline=JSON.parse(readFileSync(new URL('./quick-test-timings.json',import.meta.url),'utf8'));
export function quickCheckGroups(command,weights=baseline.files){
 const match=/^node --import tsx --test --test-concurrency=1 --test-skip-pattern='([^']+)' (tests\/[A-Za-z0-9_.-]+\.test\.ts(?: tests\/[A-Za-z0-9_.-]+\.test\.ts)*)$/.exec(command);
 if(!match)throw new Error('QUICK_TEST_COMMAND_NOT_SUPPORTED');
 const files=match[2].split(' ');if(files.length<quickCheckGroupCount||new Set(files).size!==files.length)throw new Error('QUICK_TEST_FILES_NOT_UNIQUE');
 if(!weights||typeof weights!=='object'||Array.isArray(weights)||!Number.isSafeInteger(baseline.defaultWeightMs)||baseline.defaultWeightMs<1||baseline.defaultWeightMs>3600000||!Number.isSafeInteger(baseline.perFileOverheadMs)||baseline.perFileOverheadMs<0||baseline.perFileOverheadMs>60000||Object.entries(weights).some(([file,weight])=>!/^tests\/[A-Za-z0-9_.-]+\.test\.ts$/.test(file)||!Number.isSafeInteger(weight)||weight<1||weight>3600000))throw new Error('QUICK_TEST_TIMINGS_INVALID');
 // Largest measured files first;keep serial native-role isolation and restore
 // original file order inside each batch. Weights never select or omit tests.
 /** @type {string[][]} */ const groups=Array.from({length:quickCheckGroupCount},()=>[]);
 const loads=Array(quickCheckGroupCount).fill(0),order=new Map(files.map((f,i)=>[f,i])),weight=f=>(Object.hasOwn(weights,f)?weights[f]:baseline.defaultWeightMs)+baseline.perFileOverheadMs;
 for(const file of [...files].sort((a,b)=>weight(b)-weight(a)||order.get(a)-order.get(b))){const group=loads.indexOf(Math.min(...loads));groups[group].push(file);loads[group]+=weight(file);}
 return {skipPattern:match[1],groups:groups.map(group=>group.sort((a,b)=>order.get(a)-order.get(b)))};
}
export function verifyQuickCheckFiles(groups,available){
 if(groups.flat().some(file=>!available.has(file)))throw new Error('QUICK_TEST_FILE_MISSING');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3||!Array.from({length:quickCheckGroupCount},(_,i)=>String(i+1)).includes(process.argv[2]))throw new Error('QUICK_TEST_GROUP_REQUIRED');
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')),{skipPattern,groups}=quickCheckGroups(pkg.scripts['test:quick']),group=Number(process.argv[2]),files=groups[group-1];
 const available=new Set((await readdir(new URL('../tests/',import.meta.url),{withFileTypes:true})).filter(f=>f.isFile()).map(f=>'tests/'+f.name));verifyQuickCheckFiles(groups,available);
 console.log(JSON.stringify({quickLogicGroup:group,files:files.length,groups:groups.length,testConcurrency:1}));
 const result=spawnSync(process.execPath,['--import','tsx','--test','--test-concurrency=1','--test-skip-pattern='+skipPattern,...files],{stdio:'inherit'});
 process.exitCode=result.status??1;
}
