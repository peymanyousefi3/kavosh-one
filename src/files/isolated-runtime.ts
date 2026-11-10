import { readFile,open,lstat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';

// Private files0600/directories0700. A socket-only0117mask removes owner
// directory traversal;grant the socket's reviewed0660mode explicitly instead.
export const privateParserUmask=0o077;

// Production refuses to substitute a boolean "sandbox=true" assertion for
// observable kernel/runtime controls. OCI configuration must still be reviewed
// and tested; these checks are not a promise of protection from kernel exploits.
export async function assertIsolatedFileRuntime(socketDirectory:string,additionalExecutables:string[]=[]) {
 const fail=()=>{throw new Error('FILE_RUNTIME_ISOLATION_REQUIRED');};
 if(process.platform!=='linux'||!process.getuid||process.getuid()===0)fail();
 if(Object.keys(process.env).some(k=>!['NODE_ENV','TZ','PATH','HOSTNAME','HOME'].includes(k)))fail();
 if(Object.values(networkInterfaces()).flat().some(v=>v&&!v.internal))fail();
 for(const executablePath of [process.execPath,...additionalExecutables]){
 const executable=await open(executablePath,'r');const header=Buffer.alloc(20);
 try{if((await executable.read(header,0,20,0)).bytesRead!==20)fail();}finally{await executable.close();}
 if(header.subarray(0,4).toString('hex')!=='7f454c46'||![1,2].includes(header[5])||(header[5]===1?header.readUInt16LE(16):header.readUInt16BE(16))!==3)fail();
 }
 const [status,mounts,aslr,memory,swap,cpu,pids,directory]=await Promise.all([
  readFile('/proc/self/status','utf8'),readFile('/proc/self/mountinfo','utf8'),readFile('/proc/sys/kernel/randomize_va_space','utf8'),
  readFile('/sys/fs/cgroup/memory.max','utf8'),readFile('/sys/fs/cgroup/memory.swap.max','utf8'),readFile('/sys/fs/cgroup/cpu.max','utf8'),readFile('/sys/fs/cgroup/pids.max','utf8'),lstat(socketDirectory)
 ]);
 if(!/^NoNewPrivs:\s+1$/m.test(status)||!/^Seccomp:\s+2$/m.test(status)||['CapEff','CapPrm','CapAmb'].some(k=>!new RegExp('^'+k+':\\s+0+$','m').test(status)))fail();
 const root=mounts.split('\n').map(line=>line.split(' ')).find(fields=>fields[4]==='/');
 if(!root?.[5].split(',').includes('ro')||aslr.trim()!=='2')fail();
 const bounded=(raw:string,max:number)=>/^[1-9][0-9]*$/.test(raw.trim())&&Number.isSafeInteger(Number(raw))&&Number(raw)<=max;
 const quota=cpu.trim().split(/\s+/);
 if(!bounded(memory,1_073_741_824)||swap.trim()!=='0'||quota.length!==2||!bounded(quota[0],Number.MAX_SAFE_INTEGER)||!bounded(quota[1],Number.MAX_SAFE_INTEGER)
  ||Number(quota[0])/Number(quota[1])>2||!bounded(pids,64))fail();
 if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid!()||directory.gid!==process.getgid!()||(directory.mode&0o777)!==0o750)fail();
}
