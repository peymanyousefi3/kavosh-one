import {RecoveryError} from './recovery-error.ts';
export {databaseAccessFingerprint} from './database-verification.ts';

// Comparison only,NOT a SQL sanitizer or an execution permit. Restore trusted
// authenticated dumps only inside a fresh,isolated PostgreSQL instance.
// Keep quoted values intact while discarding pg_dumpall's variable headers and
// psql restriction tokens. Never discard quoted/multiline role configuration.
function roleExportStatements(text:string,bootstrapRole?:string){
 if(typeof text!=='string'||Buffer.byteLength(text)>4194304||text.includes('\0')||bootstrapRole!==undefined&&(/[\x00-\x1f\x7f]/.test(bootstrapRole)||!/^kavosh_recovery_bootstrap_[a-f0-9]{16,32}$/.test(bootstrapRole)))throw new RecoveryError('INVALID_ROLE_EXPORT');
 const statements:string[]=[];let current='',quote='',dollar='',escaped=false,block=0;
 const space=()=>{if(current&&!current.endsWith(' '))current+=' ';};
 for(let i=0;i<text.length;i++){
  const c=text[i],next=text[i+1];
  if(block){if(c==='/'&&next==='*'){block++;i++;}else if(c==='*'&&next==='/'){block--;i++;}continue;}
  if(dollar){if(text.startsWith(dollar,i)){current+=dollar;i+=dollar.length-1;dollar='';}else current+=c;continue;}
  if(quote){current+=c;if(escaped&&c==='\\'&&next!==undefined){current+=next;i++;}else if(c===quote){if(next===quote){current+=next;i++;}else{quote='';escaped=false;}}continue;}
  if(c==='-'&&next==='-'){space();const end=text.indexOf('\n',i+2);if(end<0)break;i=end;continue;}
  if(c==='/'&&next==='*'){space();block=1;i++;continue;}
  if(c==='\\'){
   const end=text.indexOf('\n',i),line=text.slice(i,end<0?text.length:end).trim();if(current.trim()||!/^\\(?:un)?restrict [A-Za-z0-9]+$/.test(line))throw new RecoveryError('INVALID_ROLE_EXPORT');i=end<0?text.length:end;continue;
  }
  if(c==='\''||c==='"'){quote=c;escaped=c==='\''&&/[eE]/.test(text[i-1]??'')&&!/[A-Za-z0-9_$]/.test(text[i-2]??'');current+=c;continue;}
  if(c==='$'){const tag=/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))?.[0];if(tag){dollar=tag;current+=tag;i+=tag.length-1;continue;}}
  if(/\s/.test(c)){space();continue;}
  if(c===';'){const statement=current.trim()+';';if(statement!==';')statements.push(statement);current='';continue;}
  current+=c;
 }
 if(quote||dollar||block||current.trim())throw new RecoveryError('INVALID_ROLE_EXPORT');
 if(!statements.some(s=>/^CREATE ROLE /i.test(s)))throw new RecoveryError('INVALID_ROLE_EXPORT');
 if(statements.some(s=>/^ALTER ROLE /i.test(s)&&/\bPASSWORD\s+(?:NULL\b|E?'|U&'|\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/i.test(s)))throw new RecoveryError('ROLE_PASSWORD_EXPORT_REFUSED');
 const ignored=bootstrapRole?new RegExp('^(?:CREATE|ALTER) ROLE (?:"'+bootstrapRole+'"|'+bootstrapRole+')(?:;| WITH | SET | RESET )','i'):null;
 return statements.filter(s=>!ignored?.test(s));
}
export function canonicalRoleExport(text:string,bootstrapRole?:string){return roleExportStatements(text,bootstrapRole).sort();}

// initdb must preserve the source OID-10 administrator: GRANTED BY that role
// has special native semantics. Remove only its redundant CREATE statement,
// retaining its attributes and every membership/grantor without substitution.
export function roleExportForRestore(text:string,sourceBootstrapRole:string){
 if(!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(sourceBootstrapRole)||/[\x00-\x1f\x7f]/.test(sourceBootstrapRole))throw new RecoveryError('INVALID_SOURCE_BOOTSTRAP');
 const statements=roleExportStatements(text),matches=statements.filter(s=>s==='CREATE ROLE '+sourceBootstrapRole+';'||s==='CREATE ROLE "'+sourceBootstrapRole+'";');
 if(matches.length!==1)throw new RecoveryError('SOURCE_BOOTSTRAP_REQUIRED');
 return statements.filter(s=>s!==matches[0]).join('\n')+'\n';
}

// A new cluster may use the original database name safely. Existing/shared
// clusters must NOT use --create:it targets the archive's original database.
// https://www.postgresql.org/docs/18/app-pgrestore.html
export function isolatedClusterRecoveryPlan(directory:string,bootstrapRole:string,postgresBin:string){
 if([directory,bootstrapRole,postgresBin].some(v=>/[\x00-\x1f\x7f]/.test(v))||!/^\/var\/lib\/(?:private\/)?kavosh-one-recovery-[a-f0-9]{32}$/.test(directory)||!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(bootstrapRole)||!/^\/usr\/(?:lib\/postgresql\/(?:17|18)|local)\/bin$/.test(postgresBin))throw new RecoveryError('ISOLATED_CLUSTER_REQUIRED');
 const socket=directory+'/socket',data=directory+'/data';
 return{directory,data,socket,bootstrapRole,port:55493,networkListeningAllowed:false,applicationActivationAllowed:false,
  initdb:[postgresBin+'/initdb','--pgdata',data,'--username',bootstrapRole,'--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'],
  start:[postgresBin+'/pg_ctl','--pgdata',data,'--log',directory+'/postgres.log','--options',"-h '' -k "+socket+" -p 55493 -c unix_socket_permissions=0700 -c shared_buffers=16MB -c max_connections=20",'--wait','start'],
  roles:[postgresBin+'/psql','--no-psqlrc','--no-password','--host',socket,'--port','55493','--username',bootstrapRole,'--dbname','postgres','--set','ON_ERROR_STOP=1','--single-transaction','--file',directory+'/roles.sql'],
  database:[postgresBin+'/pg_restore','--create','--exit-on-error','--no-password','--no-tablespaces','--host',socket,'--port','55493','--username',bootstrapRole,'--dbname','postgres',directory+'/database.dump'],
  stop:[postgresBin+'/pg_ctl','--pgdata',data,'--mode','fast','--wait','stop']};
}
