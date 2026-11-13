// Read-only operator check. GitHub filters out secret values BEFORE they
// reach this process. Never resolves alerts,tests credentials or changes keys.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
try{
 assert.deepEqual(process.argv.slice(2),['--execute']);
 // Server-side hiding,not just a local jq filter:
 // https://docs.github.com/en/rest/secret-scanning/secret-scanning
 const response=spawnSync('gh',['api','--paginate','repos/peymanyousefi3/kavosh-one/secret-scanning/alerts?hide_secret=true','--header','X-GitHub-Api-Version: 2026-03-10','--jq','.[]|{number,state,resolution,secret_type,validity:(.validity//"unknown")}'],{encoding:'utf8',timeout:30000,maxBuffer:1048576});
 assert.equal(response.status,0);assert.ok(!response.error);assert.ok(Buffer.byteLength(response.stdout)<=1048576);
 const alerts=response.stdout.trim()?response.stdout.trim().split('\n').map(line=>JSON.parse(line)):[];assert.ok(alerts.length<=1000);
 for(const alert of alerts){assert.deepEqual(Object.keys(alert).sort(),['number','resolution','secret_type','state','validity']);assert.ok(Number.isSafeInteger(alert.number)&&alert.number>0);assert.ok(['open','resolved'].includes(alert.state));assert.match(alert.secret_type,/^[a-z0-9_]{1,100}$/);assert.ok(alert.resolution===null||/^[a-z_]{1,100}$/.test(alert.resolution));assert.ok(['active','inactive','unknown'].includes(alert.validity));}
 const validity=Object.fromEntries(['active','inactive','unknown'].map(state=>[state,alerts.filter(a=>a.validity===state).length])),open=alerts.filter(a=>a.state==='open').length;
 console.log(JSON.stringify({repository:'peymanyousefi3/kavosh-one',checkedAt:new Date().toISOString(),openAlerts:open,resolvedAlerts:alerts.length-open,reportedValidity:validity,alerts,secretValuesRequested:false,alertStateChanged:false,providerValidityVerified:false,providerKeysRotated:false}));
 if(open||validity.active)process.exitCode=1;
}catch{console.error('GITHUB_SECRET_ALERT_CHECK_FAILED: no secret values or private diagnostics were printed.');process.exitCode=1;}
