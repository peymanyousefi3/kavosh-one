import {restoreIsolatedCluster} from '../src/operations/cluster-recovery.ts';
import {RecoveryError} from '../src/operations/recovery-error.ts';
const controller=new AbortController(),cancel=()=>controller.abort();
process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
try{
 if(process.argv.length!==2||!process.env.STATE_DIRECTORY||!process.env.RECOVERY_POSTGRES_BIN)throw new RecoveryError('INVALID_CLUSTER_COMMAND');
 console.log(JSON.stringify(await restoreIsolatedCluster(process.env.STATE_DIRECTORY,process.env.RECOVERY_POSTGRES_BIN,controller.signal)));
}catch(error){console.error(error instanceof RecoveryError?error.code:'ISOLATED_CLUSTER_RECOVERY_FAILED');process.exitCode=1;}
finally{process.off('SIGTERM',cancel);process.off('SIGINT',cancel);}
