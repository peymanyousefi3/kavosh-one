import pg from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {databaseVerificationSnapshot,fingerprintQuery,type databaseVerification} from './database-verification.ts';
import type {z} from 'zod';
import {RecoveryError} from './recovery-error.ts';

const mutable=new Set(['identity.session','identity.verification','identity.phone_challenges','identity.phone_change_requests','identity.email_change_requests','identity.invites','identity.delivery_outbox','auth_private.credentials']);
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const projections=[['auth_private.credentials','revoked_at'],['identity.invites','expires_at'],['identity.delivery_outbox','payload','expires_at','locked_until','outcome']];
const unchanged=(value:z.infer<typeof databaseVerification>)=>({...value,tables:value.tables.filter(t=>!mutable.has(t.schema+'.'+t.name))});

// Called only AFTER exact snapshot/role verification. Never a web endpoint or
// an operation on the source cluster. The original backup remains unchanged.
export async function quarantineRecoveredAuthentication(client:pg.Client,dataDirectory:string,original:z.infer<typeof databaseVerification>,signal?:AbortSignal){
 if(!/^\/var\/lib\/(?:private\/)?kavosh-one-recovery-[a-f0-9]{32}\/data$/.test(dataDirectory)||/[\x00-\x1f\x7f]/.test(dataDirectory))throw new RecoveryError('ISOLATED_CLUSTER_REQUIRED');
 const boundary=(await client.query("SELECT current_setting('data_directory') directory,current_setting('listen_addresses') listening,inet_server_addr() address,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) administrator,current_user=session_user same_user")).rows[0];
 if(boundary.directory!==dataDirectory||boundary.listening!==''||boundary.address!==null||boundary.administrator!==true||boundary.same_user!==true)throw new RecoveryError('CLUSTER_BOUNDARY_MISMATCH');
 if(signal?.aborted)throw new RecoveryError('RECOVERY_CANCELLED');
 const fingerprint=(columns:string[])=>{const [table,...excluded]=columns;return fingerprintQuery(client,'SELECT value FROM(SELECT (to_jsonb(t)-ARRAY['+excluded.map(s=>"'"+s+"'").join(',')+']::text[])::text value FROM '+table+' t) records ORDER BY value COLLATE "C"',signal);};
 await client.query('BEGIN');let result;
 try{
  await client.query("SET LOCAL TIME ZONE 'UTC';SET LOCAL work_mem='4MB'");
  const before=[];for(const columns of projections)before.push(await fingerprint(columns));
  const sessions=await client.query('DELETE FROM identity.session');
  const verification=await client.query('DELETE FROM identity.verification');
  const phoneChallenges=await client.query('DELETE FROM identity.phone_challenges');
  // Session-bound contact changes must be restarted,not silently completed.
  await client.query('DELETE FROM identity.phone_change_requests');await client.query('DELETE FROM identity.email_change_requests');
  const invites=await client.query('UPDATE identity.invites SET expires_at=least(expires_at,clock_timestamp()) WHERE consumed_at IS NULL AND expires_at>clock_timestamp()');
  const botKeys=await client.query('UPDATE auth_private.credentials SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL');
  const authDeliveries=await client.query("UPDATE identity.delivery_outbox SET outcome='expired',payload=NULL,locked_until=NULL,expires_at=least(expires_at,clock_timestamp()) WHERE outcome IS NULL");
  const roles=(await client.query<{rolname:string}>('SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname<>session_user ORDER BY rolname LIMIT 1001')).rows;if(roles.length>1000)throw new RecoveryError('RECOVERY_ROLE_LIMIT');
  for(const role of roles)await client.query('ALTER ROLE '+quote(role.rolname)+' NOLOGIN');
  const after=[];for(const columns of projections)after.push(await fingerprint(columns));if(!isDeepStrictEqual(before,after))throw new RecoveryError('RECOVERY_AUTHENTICATION_PRESERVATION_FAILED');
  result={sessionsInvalidated:sessions.rowCount,verificationRecordsInvalidated:verification.rowCount,phoneChallengesInvalidated:phoneChallenges.rowCount,invitationsExpired:invites.rowCount,botKeysRevoked:botKeys.rowCount,authenticationDeliveriesExpired:authDeliveries.rowCount,databaseLoginsDisabled:roles.length};
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 // Independent read-only verification:all business/audit/finance/learning,
 // account/password/MFA records and schema authority must stay byte-identical.
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');try{if(!isDeepStrictEqual(unchanged(await databaseVerificationSnapshot(client,signal)),unchanged(original)))throw new RecoveryError('RECOVERY_BUSINESS_PRESERVATION_FAILED');}finally{await client.query('ROLLBACK');}
 return{...result,originalBusinessAndAccountRecordsPreserved:true,originalCredentialAndInvitationHistoryPreserved:true,externalQueuesReplayed:false,providerAndPrivacyReconciliationRequired:true,applicationSecretRotationAndMfaMigrationRequired:true,applicationActivationAllowed:false};
}
