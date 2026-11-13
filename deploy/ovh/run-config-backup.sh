#!/bin/bash
# Root-only offline backup of Kavosh One secrets/configuration,not the landing
# page. No plaintext tar file is created;the age private key is never needed.
set -euo pipefail
umask 077
test "$(id -u)" = 0
task_phase=initialization
task_directory=
trap 'printf "KAVOSH_ONE_CONFIG_BACKUP_FAILED: %s\n" "$task_phase" >&2' ERR
test -s /run/kavosh-one-role-export/roles.sql
task_directory=$(mktemp -d /var/lib/kavosh-one-config-backups/config-XXXXXXXX)
task_id=$(/usr/bin/node -p 'require("node:crypto").randomUUID()')
task_phase=encrypted_configuration_archive
env -i PATH=/usr/bin:/bin LANG=C /usr/bin/tar -C / -cf - \
 etc/kavosh-one etc/kavosh-one-tls etc/kavosh-one-scanner etc/postgresql/18/main \
 etc/apparmor.d/local/usr.sbin.clamd etc/apparmor.d/kavosh-one-parser \
 etc/caddy/kavosh-one.caddy etc/systemd/system/kavosh-one.service \
 etc/systemd/system/kavosh-one-backup.service etc/systemd/system/kavosh-one-backup.timer \
 etc/systemd/system/kavosh-one-backup.service.d \
 etc/systemd/system/kavosh-one-config-backup.service etc/systemd/system/kavosh-one-config-backup.timer \
 etc/systemd/system/kavosh-one-role-export.service \
 etc/systemd/system/kavosh-one-monitor.service etc/systemd/system/kavosh-one-monitor.timer \
 etc/systemd/system/kavosh-one-scanner.service \
 etc/systemd/system/kavosh-one-auth-delivery.service \
 etc/systemd/system/kavosh-one-file-inspection.service \
 etc/systemd/system/kavosh-one-file-copy@.service \
 etc/systemd/system/kavosh-one-background@.service \
 etc/systemd/system/kavosh-one-background@platform-notices.service.d \
 etc/systemd/system/kavosh-one-signature-completion.service \
 etc/systemd/system/kavosh-one-parser@.service \
 -C /run/kavosh-one-role-export roles.sql 2>/dev/null \
 | env -i PATH=/usr/bin:/bin LANG=C /opt/kavosh-one-tools/age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" > "$task_directory/configuration.tar.age.partial" 2>/dev/null
mv -- "$task_directory/configuration.tar.age.partial" "$task_directory/configuration.tar.age"
rm -- /run/kavosh-one-role-export/roles.sql
task_phase=independent_copy_verification
task_digest=$(sha256sum "$task_directory/configuration.tar.age" | cut -d ' ' -f 1)
task_bytes=$(stat --format=%s "$task_directory/configuration.tar.age")
export BACKUP_DRIVE_CONNECTION_JSON
BACKUP_DRIVE_CONNECTION_JSON=$(/usr/bin/node -e 'process.stdout.write(require("node:fs").readFileSync(process.env.CREDENTIALS_DIRECTORY+"/drive.json","utf8"))')
RECOVERY_WORK_DIRECTORY=/var/lib/kavosh-one-config-backups /usr/bin/node /srv/kavosh-one/operations/config-v1/scripts/database-recovery.js copy-config "$task_id" "$task_directory/configuration.tar.age" "$task_digest" "$task_bytes" > "$task_directory/offsite.json"
unset BACKUP_DRIVE_CONNECTION_JSON
task_phase=receipt
TASK_CONFIG_DIRECTORY="$task_directory" TASK_CONFIG_ID="$task_id" TASK_CONFIG_DIGEST="$task_digest" TASK_CONFIG_BYTES="$task_bytes" /usr/bin/node -e 'const fs=require("node:fs"),p=process.env.TASK_CONFIG_DIRECTORY,r=JSON.parse(fs.readFileSync(p+"/offsite.json","utf8"));if(r.independentCopyVerified!==true||r.scope!=="one_encrypted_configuration_archive")throw Error("COPY_NOT_VERIFIED");const receipt={id:process.env.TASK_CONFIG_ID,createdAt:new Date().toISOString(),archivePath:p+"/configuration.tar.age",ciphertextSha256:process.env.TASK_CONFIG_DIGEST,encryptedBytes:Number(process.env.TASK_CONFIG_BYTES),offsite:r,privateAgeKeyOnVps:false,rolePasswordsIncluded:false,providerAndAppSecretsEncrypted:true,landingPageConfigurationIncluded:false,automaticallyRestored:false,mediaIncluded:false};fs.writeFileSync(p+"/manifest.json",JSON.stringify(receipt)+"\n",{mode:0o600,flag:"wx"});fs.writeFileSync("/var/lib/kavosh-one-config-backups/latest.next",JSON.stringify(receipt)+"\n",{mode:0o600,flag:"wx"});fs.renameSync("/var/lib/kavosh-one-config-backups/latest.next","/var/lib/kavosh-one-config-backups/latest.json");console.log(JSON.stringify({configurationBackupId:receipt.id,encryptedBytes:receipt.encryptedBytes,offsiteVerified:true,privateAgeKeyOnVps:false,automaticallyRestored:false}));'
