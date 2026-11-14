type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
type FieldChange={path:string[];beforePresent:boolean;afterPresent:boolean;before?:Json;after?:Json};
// Compare only snapshots already released by the audit reader. Never fetch a
// current business record: it could disclose a newer value or a private field.
export function auditDiff(changes:unknown){
 const unavailable=(availability:'not_recorded'|'limit_exceeded')=>({availability,source:'recorded_redacted_snapshots' as const,fields:[] as FieldChange[]});
 if(!changes||typeof changes!=='object'||Array.isArray(changes)||!Object.hasOwn(changes,'before')||!Object.hasOwn(changes,'after'))return unavailable('not_recorded');
 const snapshots=changes as {before:Json;after:Json},fields:FieldChange[]=[];let visited=0;
 try{
  if(Buffer.byteLength(JSON.stringify([snapshots.before,snapshots.after]),'utf8')>65536)return unavailable('limit_exceeded');
  const object=(value:Json):value is {[key:string]:Json}=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const validate=(value:Json,depth:number)=>{
   if(++visited>4000||depth>12)throw new Error('DIFF_LIMIT');
   if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return;
   if(Array.isArray(value)){for(const entry of value)validate(entry,depth+1);return;}
   if(object(value)){for(const entry of Object.values(value))validate(entry,depth+1);return;}throw new Error('INVALID_JSON_SNAPSHOT');
  };
  validate(snapshots.before,0);validate(snapshots.after,0);visited=0;
  const equal=(a:Json,b:Json,depth:number):boolean=>{
   if(++visited>4000||depth>12)throw new Error('DIFF_LIMIT');if(a===b)return true;
   if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>equal(v,b[i],depth+1));
   if(object(a)&&object(b)){const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k],depth+1));}return false;
  };
  const walk=(a:Json|undefined,b:Json|undefined,beforePresent:boolean,afterPresent:boolean,path:string[])=>{
   if(++visited>4000||path.length>12)throw new Error('DIFF_LIMIT');
   if(beforePresent&&afterPresent&&object(a!)&&object(b!)){
    for(const key of [...new Set([...Object.keys(a!),...Object.keys(b!)])].sort())walk(a![key],b![key],Object.hasOwn(a!,key),Object.hasOwn(b!,key),[...path,key]);return;
   }
   if(beforePresent&&afterPresent&&equal(a!,b!,path.length))return;
   if(fields.length>=100)throw new Error('DIFF_LIMIT');
   fields.push({path,beforePresent,afterPresent,...(beforePresent?{before:a!}:{}),...(afterPresent?{after:b!}:{})});
  };
  walk(snapshots.before,snapshots.after,true,true,[]);
  return{availability:'recorded' as const,source:'recorded_redacted_snapshots' as const,fields};
 }catch{return unavailable('limit_exceeded');}
}
