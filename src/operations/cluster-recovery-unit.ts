import {RecoveryError} from './recovery-error.ts';

// Root operator installs this as a one-time /run unit,not a boot service.
// Input files are already authenticated/decrypted off-server. No key or live
// account credential enters this unit. The dynamic OS user is not postgres.
export function isolatedClusterUnit(id:string,operator:string){
 if(!/^[a-f0-9]{32}$/.test(id)||!/^\/srv\/kavosh-one\/operations\/recovery-[a-f0-9]{7,40}$/.test(operator)||/[\x00-\x1f\x7f]/.test(id+operator))throw new RecoveryError('INVALID_CLUSTER_UNIT');
 const name='kavosh-one-recovery-'+id,staging='/var/lib/kavosh-one-recovery-input-'+id;
 return{name,staging,directory:'/var/lib/'+name,unit:`[Unit]
Description=Kavosh One isolated offline recovery verification
[Service]
Type=oneshot
DynamicUser=yes
StateDirectory=${name}
StateDirectoryMode=0700
Environment=NODE_ENV=production
Environment=RECOVERY_POSTGRES_BIN=/usr/lib/postgresql/18/bin
${['database.dump','roles-export.sql','verification.json','input.json'].map(file=>'ExecStartPre=+/usr/bin/install --mode=0444 '+staging+'/'+file+' /var/lib/'+name+'/'+file).join('\n')}
ExecStart=/usr/bin/node ${operator}/scripts/restore-isolated-cluster.js
TimeoutStartSec=10min
TimeoutStopSec=15s
KillMode=control-group
UMask=0077
PrivateNetwork=yes
PrivateIPC=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectProc=ptraceable
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
NoNewPrivileges=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictAddressFamilies=AF_UNIX
CapabilityBoundingSet=
AmbientCapabilities=
InaccessiblePaths=/var/lib/postgresql /run/postgresql /etc/postgresql /etc/kavosh-one /etc/kavosh-one-tls /var/lib/kavosh-one-backups /var/lib/kavosh-one-config-backups ${staging}
MemoryHigh=256M
MemoryMax=512M
CPUQuota=50%
Nice=15
IOSchedulingClass=idle
IOWeight=10
TasksMax=64
StandardOutput=journal
StandardError=journal
`};
}
