// Explicit root-only,zero-recipient credential check from the VPS itself.
// No To,From or Body is supplied,so no SMS can be sent. The configured
// MessagingServiceSid may be included to validate the production request shape.
import assert from 'node:assert/strict';
import { readFileSync,existsSync } from 'node:fs';
let stage = 'configuration', observed = {};
try {
 assert.equal(process.getuid(), 0); assert.ok([JSON.stringify(['--execute']),JSON.stringify(['--execute','--credentials-only'])].includes(JSON.stringify(process.argv.slice(2)))); assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
 const configuredService=!process.argv.includes('--credentials-only')&&existsSync('/etc/kavosh-one/twilio-production.json');
 const config = JSON.parse(readFileSync(configuredService?'/etc/kavosh-one/twilio-production.json':'/etc/kavosh-one/twilio-credentials.json', 'utf8'));
 assert.match(config.accountSid, /^AC[a-fA-F0-9]{32}$/); assert.match(config.apiKeySid, /^SK[a-fA-F0-9]{32}$/); assert.match(config.apiKeySecret, /^[A-Za-z0-9_-]{20,128}$/);
 if(configuredService)assert.match(config.messagingServiceSid,/^MG[a-f0-9]{32}$/);
 const headers = { authorization: 'Basic ' + Buffer.from(config.apiKeySid + ':' + config.apiKeySecret).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' };
 const base = 'https://api.twilio.com/2010-04-01/Accounts/' + config.accountSid;
 stage = 'authenticated send permission without a recipient';
 const response = await fetch(base + '/Messages.json', { method: 'POST', headers, body: new URLSearchParams(configuredService?{MessagingServiceSid:config.messagingServiceSid}:{}), redirect: 'error', signal: AbortSignal.timeout(10000) });
 assert.equal(response.headers.get('content-type')?.includes('application/json'), true);
 const payload = await response.json(); observed = { sendProbeStatus: response.status, sendProbeCode: payload.code };
 // Vendor-documented missing Body,From,To errors prove authenticated request
 // validation,not carrier delivery. Never accept authentication/balance errors.
 assert.equal(response.status, 400); assert.ok([21602, 21603, 21604].includes(payload.code));
 stage = 'message history denial'; const history = await fetch(base + '/Messages.json?PageSize=1', { headers, redirect: 'error', signal: AbortSignal.timeout(10000) }); await history.body?.cancel(); observed.historyStatus = history.status; assert.ok([401, 403].includes(history.status));
 stage = 'billing access denial'; const billing = await fetch(base + '/Balance.json', { headers, redirect: 'error', signal: AbortSignal.timeout(10000) }); await billing.body?.cancel(); observed.billingStatus = billing.status; assert.ok([401, 403].includes(billing.status));
 console.log(JSON.stringify({ ...observed, executedOnVps: true, productionServiceConfigured:configuredService, authenticatedSendEndpointValidated: true, historyReadDenied: true, billingReadDenied: true, messagesSent: 0, phoneNumbersPurchased: 0, carrierDeliveryVerified: false, productionMessagingActivated: false }));
} catch { console.error(JSON.stringify({ error: 'TWILIO_CREDENTIAL_CHECK_FAILED', stage, ...observed, messagesSent: 0 })); process.exitCode = 1; }
