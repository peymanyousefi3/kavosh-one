import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

// Use the independently checksum-verified official Gitleaks executable. No
// credential/provider calls,network uploads or unredacted diagnostic output.
const root=fileURLToPath(new URL('../',import.meta.url)),localBin=root+'.local-tools/gitleaks',bin=process.env.GITLEAKS_BIN??(existsSync(localBin)?localBin:'gitleaks'),env={...process.env};
delete env.GITLEAKS_CONFIG;delete env.GITLEAKS_CONFIG_TOML;
const common=['--config',root+'.gitleaks.toml','--gitleaks-ignore-path',root+'.gitleaksignore','--ignore-gitleaks-allow','--redact=100','--no-banner','--no-color'];
const run=(args,input)=>spawnSync(bin,args,{cwd:root,env,input,encoding:'utf8',maxBuffer:8*1024*1024});
try{
 // Prove the installed scanner catches the exact class GitHub reported. This
 // canary exists only in process memory,never in a file,commit or provider.
 const canary='whsec_'+randomBytes(32).toString('hex'),probe=run(['stdin',...common,'--log-level','error','--report-format','json','--report-path','-'],'signing_material="'+canary+'"');
 assert.equal(probe.status,1,'Secret scanner canary must be detected');
 assert.ok(JSON.parse(probe.stdout).some(v=>v.RuleID==='stripe-webhook-signing-secret'),'Required webhook rule did not run');
 assert.ok(!probe.stdout.includes(canary),'Secret scanner output must be fully redacted');
 const clean=run(['stdin',...common,'--log-level','error'],'Harmless secret-check smoke test.');assert.equal(clean.status,0,'Clean-input self-check failed');
 const scan=run(['git',...common,'--log-opts=--all']);
 if(scan.error)throw new Error('SCANNER_UNAVAILABLE');
 // No --verbose: only redacted aggregate diagnostics are forwarded.
 process.stdout.write(scan.stdout??'');process.stderr.write(scan.stderr??'');
 if(scan.status!==0)throw new Error('NEW_SECRET_CANDIDATES');
 console.log('Secret checks passed: runtime canary detected,clean control accepted,all local Git refs scanned. Historical exceptions are exact fingerprints only.');
}catch{
 console.error('Secret check failed. Do not push. Check scanner installation or review the redacted findings; never print or commit detected values.');process.exitCode=1;
}
