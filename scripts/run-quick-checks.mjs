import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// One authoritative quick-suite list. Each CI runner has its own PostgreSQL
// service; keep tests serial WITHIN that runner because native roles are shared.
export function quickCheckGroups(command){
 const match=/^node --import tsx --test --test-concurrency=1 --test-skip-pattern='([^']+)' (tests\/[A-Za-z0-9_.-]+\.test\.ts(?: tests\/[A-Za-z0-9_.-]+\.test\.ts)*)$/.exec(command);
 if(!match)throw new Error('QUICK_TEST_COMMAND_NOT_SUPPORTED');
 const files=match[2].split(' ');if(files.length<2||new Set(files).size!==files.length)throw new Error('QUICK_TEST_FILES_NOT_UNIQUE');
 return {skipPattern:match[1],groups:[files.filter((_,i)=>i%2===0),files.filter((_,i)=>i%2===1)]};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(process.argv.length!==3||!['1','2'].includes(process.argv[2]))throw new Error('QUICK_TEST_GROUP_REQUIRED');
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')),{skipPattern,groups}=quickCheckGroups(pkg.scripts['test:quick']),group=Number(process.argv[2]),files=groups[group-1];
 console.log(JSON.stringify({quickLogicGroup:group,files:files.length,groups:groups.length,testConcurrency:1}));
 const result=spawnSync(process.execPath,['--import','tsx','--test','--test-concurrency=1','--test-skip-pattern='+skipPattern,...files],{stdio:'inherit'});
 process.exitCode=result.status??1;
}
