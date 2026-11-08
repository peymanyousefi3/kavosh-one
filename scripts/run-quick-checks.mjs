import { readFile,readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// One authoritative quick-suite list. Each CI runner has its own PostgreSQL
// service; keep tests serial WITHIN that runner because native roles are shared.
export const quickCheckGroupCount=6;
export function quickCheckGroups(command){
 const match=/^node --import tsx --test --test-concurrency=1 --test-skip-pattern='([^']+)' (tests\/[A-Za-z0-9_.-]+\.test\.ts(?: tests\/[A-Za-z0-9_.-]+\.test\.ts)*)$/.exec(command);
 if(!match)throw new Error('QUICK_TEST_COMMAND_NOT_SUPPORTED');
 const files=match[2].split(' ');if(files.length<quickCheckGroupCount||new Set(files).size!==files.length)throw new Error('QUICK_TEST_FILES_NOT_UNIQUE');
 return {skipPattern:match[1],groups:Array.from({length:quickCheckGroupCount},(_,group)=>files.filter((_,i)=>i%quickCheckGroupCount===group))};
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
