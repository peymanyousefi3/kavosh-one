import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const source=readFileSync(new URL('../deploy/ovh/run-parser.sh',import.meta.url),'utf8');
test('only three fixed credential-free parser instances can run; control files are outside the parser mount',()=>{
 const prefix='id(){ printf "0\\n"; }; chown(){ :; }; chmod(){ :; }; test(){ case "$1" in -d) return 0;; -L) return 1;; *) command test "$@";; esac; }; task_podman(){ printf "%s\\000" "$@"; };\n';
 for(const kind of ['image','pdf','video','unexpected']){
  const r=spawnSync('/bin/sh',['-s','--',kind],{input:prefix+source.replace('exec /usr/bin/podman','task_podman'),encoding:'utf8',timeout:2000});
  if(kind==='unexpected'){assert.equal(r.status,64);assert.equal(r.stdout,'');continue;}
  assert.equal(r.status,0,r.stderr);const args=r.stdout.split('\0').filter(Boolean);
  for(const flag of ['--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--security-opt=apparmor=kavosh-one-parser','--memory=1g','--memory-swap=1g','--cpus=0.5','--pids-limit=64'])assert.ok(args.includes(flag),flag);
  const binding=args[args.indexOf('--mount')+1];assert.equal(binding,`type=bind,source=/run/kavosh-one-parser-${kind},target=/run/kavosh-${kind}`);
  const control=args[args.indexOf('--cidfile')+1];assert.equal(control,`/run/kavosh-one-parser-${kind}-control/container.cid`);assert.equal(binding.includes('-control'),false);
  assert.equal(args.includes('--init'),kind==='video');assert.ok(args.includes(`localhost/kavosh-one-${kind}:e0fa615`));assert.ok(args.includes('-i'));assert.doesNotMatch(args.join('\n'),/env-file|host-network|SMTP|AUTH_SECRET|DATABASE_URL|\/etc\/kavosh-one/);
 }
 const profile=readFileSync(new URL('../deploy/ovh/kavosh-one-parser.apparmor',import.meta.url),'utf8');
 for(const rule of ['deny mount,','deny /sys/kernel/security/** rwklx,','peer="crun//&kavosh-one-parser"','peer="kavosh-one-parser//&crun"'])assert.ok(profile.includes(rule));
 assert.doesNotMatch(profile,/flags=.*unconfined|signal \(send.*peer=\*|signal \(send.*peer=unconfined/);
});
