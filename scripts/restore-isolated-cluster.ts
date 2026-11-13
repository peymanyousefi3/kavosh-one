import {restoreIsolatedCluster} from '../src/operations/cluster-recovery.ts';
import {RecoveryError} from '../src/operations/recovery-error.ts';
import {realpath} from 'node:fs/promises';
const controller=new AbortController(),cancel=()=>controller.abort();
process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
try{
 if(process.argv.length!==2||!process.env.STATE_DIRECTORY||!process.env.RECOVERY_POSTGRES_BIN)throw new RecoveryError('INVALID_CLUSTER_COMMAND');
 if(!/^\/var\/lib\/kavosh-one-recovery-[a-f0-9]{32}$/.test(process.env.STATE_DIRECTORY))throw new RecoveryError('INVALID_CLUSTER_COMMAND');
 const directory=await realpath(process.env.STATE_DIRECTORY);if(directory!==process.env.STATE_DIRECTORY&&directory!==process.env.STATE_DIRECTORY.replace('/var/lib/','/var/lib/private/'))throw new RecoveryError('INVALID_CLUSTER_COMMAND');
 console.log(JSON.stringify(await restoreIsolatedCluster(directory,process.env.RECOVERY_POSTGRES_BIN,controller.signal)));
}catch(error){console.error(error instanceof RecoveryError?error.code:'ISOLATED_CLUSTER_RECOVERY_FAILED');process.exitCode=1;}
finally{process.off('SIGTERM',cancel);process.off('SIGINT',cancel);}
