// First-school operator setup only. Does not create a login/password, verify a
// person, issue credentials, grant platform ownership, send mail or activate it.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,lstatSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
let phase='configuration';
try{
 assert.equal(process.getuid(),0);assert.deepEqual(process.argv.slice(2),['--execute']);
 const input=readFileSync(0);assert.ok(input.length<=4096);const c=JSON.parse(input.toString());assert.deepEqual(Object.keys(c),['masterEmail']);assert.equal(typeof c.masterEmail,'string');assert.ok(c.masterEmail.length<=254);assert.match(c.masterEmail,/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/);const email=c.masterEmail.toLowerCase();
 const path='/etc/kavosh-one/initial-academy.json',quote=v=>"'"+v.replaceAll("'","''")+"'";
 const query=sql=>{try{return execFileSync('/usr/sbin/runuser',['-u','postgres','--','/usr/bin/psql','-X','-At','-v','ON_ERROR_STOP=1','-d','kavosh_one'],{input:sql,stdio:['pipe','pipe','pipe'],timeout:10000}).toString().trim();}catch{throw Error('PROVISION_DATABASE_FAILED');}};
 if(existsSync(path)){
  const s=lstatSync(path);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o600);const r=JSON.parse(readFileSync(path,'utf8'));assert.equal(r.masterEmail,email);assert.match(r.academyId,/^[a-f0-9-]{36}$/);assert.match(r.masterPersonId,/^[a-f0-9-]{36}$/);
  assert.equal(query(`SELECT count(*) FROM public.academies a JOIN public.people p ON p.academy_id=a.id AND p.id=a.master_person_id WHERE a.id=${quote(r.academyId)}::uuid AND p.id=${quote(r.masterPersonId)}::uuid AND p.email=${quote(email)} AND p.kind='human';`),'1');
  console.log(JSON.stringify({existingSetupMatches:true,identityOrPermissionsChanged:false}));
 }else{
  assert.equal(query('SELECT public.schema_revision();'),'388');assert.equal(query('SELECT (SELECT count(*) FROM public.academies)||\'|\'||(SELECT count(*) FROM identity."user");'),'0|0');
  const academyId=randomUUID(),masterPersonId=randomUUID(),r={academyId,masterPersonId,masterEmail:email,academyLegalName:'Kavosh Al and Robotics Academy Inc.',officialSenderEmail:'info@kavosh.ai',officialReplyEmail:'info@kavosh.ai',verificationNotPerformedByProvisioning:true};
  phase='private setup receipt';writeFileSync(path,JSON.stringify(r)+'\n',{mode:0o600,flag:'wx',flush:true});
  phase='pending school and master';
  query(`BEGIN;SELECT pg_advisory_xact_lock(hashtextextended('kavosh-one-first-school',0));DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.academies) OR EXISTS(SELECT 1 FROM identity."user") THEN RAISE EXCEPTION 'FIRST_SCHOOL_ONLY';END IF;END $$;
SELECT set_config('app.academy_id',${quote(academyId)},true);
INSERT INTO public.academies(id,name,master_person_id) VALUES(${quote(academyId)},${quote(r.academyLegalName)},${quote(masterPersonId)});
INSERT INTO public.people(academy_id,id,kind,name,email,status) VALUES(${quote(academyId)},${quote(masterPersonId)},'human','Master administrator',${quote(email)},'pending');COMMIT;`);
  console.log(JSON.stringify({pendingSchoolCreated:true,pendingMasterCreated:true,schoolActivated:false,loginCreated:false,verificationBypassed:false,botCredentialsCreated:false,messagesSent:0}));
 }
}catch{console.error('FIRST_SCHOOL_SETUP_FAILED: '+phase);process.exitCode=1;}
