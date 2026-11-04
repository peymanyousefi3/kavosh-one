import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { jsonBody,mutation,record,loadGrants,type ApiContext,type Reply } from '../core/api.ts';
import { permissionScope,lockApprovalWrites } from '../core/approvals.ts';
import { ApiError,requireScope,scopeNonempty,areaAllowsNewRecord,areaContains,type Capability,type Scope,type AreaRef } from '../core/policy.ts';
import { areaFor } from '../core/geography.ts';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const title=z.string().trim().min(1).max(150);
const longTitle=z.string().trim().min(1).max(200);
const text=z.string().trim().max(200);
const translations=z.object({en:title.optional(),fr:title.optional(),'zh-CN':title.optional()}).strict();
const translationPatch=z.object({en:title.nullable().optional(),fr:title.nullable().optional(),'zh-CN':title.nullable().optional()}).strict();
const countryInput=z.object({code:z.string().regex(/^[A-Z]{2}$/),name:title,translations:translations.default({}),active:z.boolean().default(true)}).strict();
const regionInput=z.object({countryId:uuid,code:z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/),name:title,translations:translations.default({}),active:z.boolean().default(true)}).strict();
const cityInput=z.object({regionId:uuid,name:title.max(100),translations:translations.default({}),active:z.boolean().default(true)}).strict();
const timeZone=z.string().max(80).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'Choose a supported IANA time zone.');
const currency=z.string().refine(value=>Intl.supportedValuesOf('currency').includes(value),'Choose a supported currency code.');
const address=z.object({line1:text.default(''),line2:text.default(''),postalCode:z.string().trim().max(30).default('')}).strict();
const coordinates=z.object({latitude:z.number().min(-90).max(90),longitude:z.number().min(-180).max(180)}).strict().nullable();
const website=z.string().url().max(2048).refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;}).nullable();
const hubMetadata=z.object({name:longTitle,cityId:uuid,timeZone,currency,active:z.boolean().default(true),translations:translations.default({}),
  contactEmail:z.string().email().max(254).nullable().default(null),contactPhone:z.string().trim().max(40).nullable().default(null),
  website:website.default(null),address:address.default({line1:'',line2:'',postalCode:''}),coordinates:coordinates.default(null)}).strict();
const legacyHub=z.object({name:longTitle,city:title.max(100),countryCode:countryInput.shape.code}).strict();
const hubCreate=z.union([hubMetadata,legacyHub]);
const moduleInput=z.object({code:z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,29}$/),title:longTitle,summary:z.string().trim().max(2000).default('')}).strict();
const courseInput=z.object({code:moduleInput.shape.code,name:longTitle,description:z.string().trim().max(4000).default(''),
  hubId:uuid.nullable().default(null),translations:translations.default({}),active:z.boolean().default(true),modules:z.array(moduleInput).max(100).default([])}).strict();
const expectedVersion=z.number().int().min(1);
function patchFields(shape:Record<string,z.ZodType>) {
  // Zod's partial() preserves creation defaults. Remove those defaults so an
  // omitted PATCH-style field never erases existing content or reactivates it.
  return Object.fromEntries(Object.entries(shape).map(([key,field])=>[key,z.optional(field instanceof z.ZodDefault?field.removeDefault():field)]));
}
function patchSchema(shape:Record<string,z.ZodType>) {return z.object({...patchFields(shape),expectedVersion,translations:translationPatch.optional()}).strict().refine(v=>Object.keys(v).length>1);}
const countryUpdate=patchSchema(countryInput.shape),regionUpdate=patchSchema(regionInput.shape),cityUpdate=patchSchema(cityInput.shape);
const hubUpdate=patchSchema({...hubMetadata.shape,cityId:uuid.nullable(),city:title.max(100).optional(),countryCode:countryInput.shape.code.optional(),
  address:z.object({line1:text.optional(),line2:text.optional(),postalCode:z.string().trim().max(30).optional()}).strict()});
const courseUpdate=patchSchema(courseInput.shape);
const listBase={limit:z.coerce.number().int().min(1).max(100).default(50),after:uuid.optional(),q:z.string().trim().min(1).max(100).optional(),active:z.enum(['true','false']).transform(v=>v==='true').optional()};
const countriesQuery=z.object(listBase).strict(),regionsQuery=z.object({...listBase,countryId:uuid.optional()}).strict(),citiesQuery=z.object({...listBase,regionId:uuid.optional(),countryId:uuid.optional()}).strict();
const hubsQuery=z.object({...listBase,cityId:uuid.optional(),countryId:uuid.optional()}).strict();
const coursesQuery=z.object({...listBase,hubId:uuid.optional(),includeShared:z.enum(['true','false']).default('true').transform(v=>v==='true')}).strict();
type GeoKind='countries'|'regions'|'cities';
type Fields=Record<string,unknown>;

export function mergeLabels(previous:unknown,patch:unknown) {
  const result={...(previous as Record<string,string>??{})};
  for(const [key,value] of Object.entries(patch as Record<string,string|null>??{})){if(value===null)delete result[key];else result[key]=value;}
  return result;
}
function permitted(ctx:ApiContext,capability:Capability){const scope=permissionScope(ctx,capability);if(!scopeNonempty(scope))throw new ApiError(403,'FORBIDDEN');return scope;}
function values(scope:Scope):unknown[]{return [scope.all,scope.hubs,scope.excludedHubs??[]];}
// Identifiers below are code-owned constants, never arbitrary request SQL.
function hubFilter(column:'h.id'|'c.hub_id'){return `(($1::boolean OR ${column}=ANY($2::uuid[])) AND NOT coalesce(${column}=ANY($3::uuid[]),false))`;}
const hubFrom=`public.hubs h LEFT JOIN public.cities city ON city.academy_id=h.academy_id AND city.id=h.city_id
  LEFT JOIN public.regions region ON region.academy_id=city.academy_id AND region.id=city.region_id
  LEFT JOIN public.countries country ON country.academy_id=h.academy_id AND
    ((h.city_id IS NOT NULL AND country.id=region.country_id) OR (h.city_id IS NULL AND country.code=h.country_code))`;
const hubFields=`h.id,h.name,coalesce(city.name,h.city) AS city,coalesce(country.code,h.country_code) AS country_code,h.city_id,
  region.id AS region_id,country.id AS country_id,h.version,h.active,h.time_zone,h.currency,h.contact_email,h.contact_phone,h.website,h.address,
  h.latitude::float8 AS latitude,h.longitude::float8 AS longitude,h.translations,h.created_at,
  (h.city_id IS NOT NULL AND h.time_zone IS NOT NULL AND h.currency IS NOT NULL) AS setup_complete`;
async function hub(ctx:ApiContext,id:string) {
  const row=(await ctx.db.query<Fields>('SELECT '+hubFields+' FROM '+hubFrom+' WHERE h.id=$1',[id])).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');return row;
}
async function activeCity(ctx:ApiContext,id:string,requireActive=true) {
  const row=(await ctx.db.query<{id:string;name:string;country_code:string}>(`SELECT city.id,city.name,country.code AS country_code FROM public.cities city
    JOIN public.regions region ON region.academy_id=city.academy_id AND region.id=city.region_id
    JOIN public.countries country ON country.academy_id=region.academy_id AND country.id=region.country_id
    WHERE city.id=$1 AND (NOT $2::boolean OR (city.active AND region.active AND country.active))`,[id,requireActive])).rows[0];
  if(!row)throw new ApiError(400,'ACTIVE_LOCATION_REQUIRED');return row;
}
async function activeParent(ctx:ApiContext,kind:GeoKind,input:Fields) {
  if(kind==='countries'||!input.active)return;
  const result=kind==='regions'?await ctx.db.query('SELECT 1 FROM public.countries WHERE id=$1 AND active',[input.countryId])
    :await ctx.db.query(`SELECT 1 FROM public.regions r JOIN public.countries c ON c.academy_id=r.academy_id AND c.id=r.country_id WHERE r.id=$1 AND r.active AND c.active`,[input.regionId]);
  if(!result.rows.length)throw new ApiError(400,'ACTIVE_LOCATION_REQUIRED');
}
export async function lockAcademyTopology(ctx:ApiContext,exclusive=false) {
  await lockApprovalWrites(ctx);
  const query=exclusive?'SELECT pg_advisory_xact_lock(hashtextextended($1,9))':'SELECT pg_advisory_xact_lock_shared(hashtextextended($1,9))';
  await ctx.db.query(query,[ctx.credential.academy_id]);
  ctx.grants=await loadGrants(ctx.db,ctx.credential);
}
async function geoInUse(ctx:ApiContext,kind:GeoKind,id:string) {
  const query=kind==='countries'?'SELECT 1 FROM public.regions WHERE country_id=$1 AND active LIMIT 1'
    :kind==='regions'?'SELECT 1 FROM public.cities WHERE region_id=$1 AND active LIMIT 1':'SELECT 1 FROM public.hubs WHERE city_id=$1 AND active LIMIT 1';
  return (await ctx.db.query(query,[id])).rows.length>0;
}
function geoDefinition(kind:GeoKind,row:Fields) {
  return {name:row.name,translations:row.translations,active:row.active,...(kind!=='cities'?{code:row.code}:{}),
    ...(kind==='regions'?{countryId:row.country_id}:kind==='cities'?{regionId:row.region_id}:{})};
}
async function saveGeo(ctx:ApiContext,kind:GeoKind,id:string|null,raw:unknown):Promise<Reply> {
  requireScope(permitted(ctx,'locations.edit'));
  const schema=kind==='countries'?countryInput:kind==='regions'?regionInput:cityInput;
  const update=kind==='countries'?countryUpdate:kind==='regions'?regionUpdate:cityUpdate;
  const input=(id?update:schema).parse(raw) as Fields;
  await lockAcademyTopology(ctx,true);requireScope(permitted(ctx,'locations.edit'));
  return mutation(ctx,input,async()=>{
    const before=id?(await ctx.db.query<Fields>('SELECT * FROM public.'+kind+' WHERE id=$1 FOR UPDATE',[id])).rows[0]:null;
    if(id&&!before)throw new ApiError(404,'NOT_FOUND');
    if(before&&before.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
    const {expectedVersion:ignored,...patch}=input;
    const body=schema.parse({...before&&geoDefinition(kind,before),...patch,translations:mergeLabels(before?.translations,input.translations)}) as Fields;
    await activeParent(ctx,kind,body);
    if(id&&!body.active&&await geoInUse(ctx,kind,id))throw new ApiError(409,'ACTIVE_CHILDREN_EXIST');
    const actual=id??randomUUID(),names=['name','translations','active'],params:unknown[]=[ctx.credential.academy_id,actual,body.name,JSON.stringify(body.translations),body.active];
    if(kind!=='cities'){names.push('code');params.push(body.code);}
    if(kind==='regions'){names.push('country_id');params.push(body.countryId);}
    if(kind==='cities'){names.push('region_id');params.push(body.regionId);}
    if(id)await ctx.db.query('UPDATE public.'+kind+' SET '+names.map((field,index)=>field+'=$'+(index+3)+(field==='translations'?'::jsonb':'')).join(',')+',version=version+1 WHERE academy_id=$1 AND id=$2',params);
    else await ctx.db.query('INSERT INTO public.'+kind+'(academy_id,id,'+names.join(',')+') VALUES('+params.map((_,index)=>'$'+(index+1)+(index===3?'::jsonb':'')).join(',')+')',params);
    const result=(await ctx.db.query<Fields>('SELECT * FROM public.'+kind+' WHERE id=$1',[actual])).rows[0];
    await record(ctx.db,ctx.credential,ctx.requestId,'location.'+(id?'updated':'created'),actual,null,{kind,before,after:result});
    return {status:id?200:201,body:{data:result}};
  });
}
async function readGeo(ctx:ApiContext,kind:GeoKind,id?:string):Promise<Reply> {
  const scope=permitted(ctx,'locations.view');
  const query=(kind==='countries'?countriesQuery:kind==='regions'?regionsQuery:citiesQuery).parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const ancestry=kind==='countries'?'country.id=r.id':kind==='regions'?'region.id=r.id':'city.id=r.id';
  const joins=kind==='countries'?'':kind==='regions'?' JOIN public.countries parent ON parent.academy_id=r.academy_id AND parent.id=r.country_id'
    :' JOIN public.regions parent ON parent.academy_id=r.academy_id AND parent.id=r.region_id JOIN public.countries ancestor ON ancestor.academy_id=parent.academy_id AND ancestor.id=parent.country_id';
  const parentWhere=kind==='countries'?'':kind==='regions'?' AND ($9::uuid IS NULL OR r.country_id=$9)':' AND ($9::uuid IS NULL OR r.region_id=$9) AND ($10::uuid IS NULL OR parent.country_id=$10)';
  const params=[...values(scope),id??null,query.after??null,query.q??null,query.active??null,query.limit+1,
    ...(kind==='regions'?[('countryId' in query?query.countryId:null)??null]:kind==='cities'?[('regionId' in query?query.regionId:null)??null,('countryId' in query?query.countryId:null)??null]:[])];
  const scopeAt=params.length+1,enabledAt=params.length+2;
  params.push(JSON.stringify(scope),Boolean(scope.areas?.length||scope.excludedAreas?.length));
  const rows=(await ctx.db.query<Fields>(`SELECT r.* FROM public.${kind} r${joins} JOIN public.geographic_areas g ON g.academy_id=r.academy_id AND g.id=r.id AND g.kind='${kind==='countries'?'country':kind==='regions'?'region':'city'}' WHERE
    ((($1::boolean AND cardinality($3::uuid[])=0) OR EXISTS(SELECT 1 FROM ${hubFrom} WHERE ${ancestry} AND ${hubFilter('h.id')}))
      OR ($${enabledAt}::boolean AND public.scope_area_visible($${scopeAt}::jsonb,g.ref)))
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce($${scopeAt}::jsonb->'excludedAreas','[]'::jsonb)) e WHERE public.area_contains(e,g.ref))
    AND ($4::uuid IS NULL OR r.id=$4) AND ($5::uuid IS NULL OR r.id>$5) AND ($6::text IS NULL OR position(lower($6) in lower(r.name))>0)
    AND ($7::boolean IS NULL OR r.active=$7)${parentWhere} ORDER BY r.id LIMIT $8`,params)).rows;
  if(id&&!rows.length)throw new ApiError(404,'NOT_FOUND');
  return {status:200,body:id?{data:rows[0]}:{data:rows.slice(0,query.limit),nextCursor:rows.length>query.limit?rows[query.limit-1].id:null}};
}
async function saveHub(ctx:ApiContext,id:string|null,raw:unknown):Promise<Reply> {
  const initial=permitted(ctx,'hubs.edit');if(id||!initial.areas?.length)requireScope(initial,id??undefined);
  const input=(id?hubUpdate:hubCreate).parse(raw) as Fields;
  await lockAcademyTopology(ctx,true);const scope=permitted(ctx,'hubs.edit');
  if(id||!scope.areas?.length)requireScope(scope,id??undefined);
  return mutation(ctx,input,async()=>{
    const before=id?await hub(ctx,id):null;
    if(before&&before.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');
    const prior:Fields=before?{name:before.name,cityId:before.city_id,city:before.city,countryCode:before.country_code,timeZone:before.time_zone,currency:before.currency,
      contactEmail:before.contact_email,contactPhone:before.contact_phone,website:before.website,address:before.address,active:before.active,
      coordinates:before.latitude===null?null:{latitude:before.latitude,longitude:before.longitude}}:{};
    const body:Fields={...prior,...input,translations:mergeLabels(before?.translations,input.translations),address:{...(prior.address as Fields??{}),...(input.address as Fields??{})}};
    let city=String(body.city??''),country=String(body.countryCode??'');
    if(body.cityId) {
      const location=await activeCity(ctx,String(body.cityId),body.active!==false);
      if((input.city&&input.city!==location.name)||(input.countryCode&&input.countryCode!==location.country_code))throw new ApiError(400,'CHOOSE_LOCATION_INSTEAD_OF_DERIVED_LABELS');
      city=location.name;country=location.country_code;
    }else if(!city||!country)throw new ApiError(400,'LOCATION_REQUIRED');
    if(!id||before?.city_id!==(body.cityId??null)||before?.country_code!==country) {
      let destination:AreaRef|undefined;
      if(body.cityId)destination=await areaFor(ctx.db,'city',String(body.cityId));
      else destination=(await ctx.db.query<{ref:AreaRef}>(`SELECT g.ref FROM public.geographic_areas g JOIN public.countries c
        ON c.academy_id=g.academy_id AND c.id=g.id WHERE g.kind='country' AND c.code=$1`,[country])).rows[0]?.ref;
      const fixed=id&&ctx.grants.some(g=>g.capability==='hubs.edit'&&g.effect==='allow'&&(g.allHubs||g.hubIds.includes(id)));
      const blocked=destination&&scope.excludedAreas?.some(a=>areaContains(a,destination!)||(!body.cityId&&a.countryId===destination!.countryId));
      if(blocked||(!scope.all&&!fixed&&(!destination||!areaAllowsNewRecord(scope,destination))))throw new ApiError(403,'FORBIDDEN_LOCATION');
      if(!destination&&scope.excludedAreas?.length)throw new ApiError(403,'NORMALIZED_LOCATION_REQUIRED');
    }
    const actual=id??randomUUID(),point=body.coordinates as {latitude:number;longitude:number}|null;
    if(id&&body.active===false&&(await ctx.db.query('SELECT 1 FROM public.classes WHERE hub_id=$1 AND active LIMIT 1',[id])).rows.length)throw new ApiError(409,'ACTIVE_CLASSES_EXIST');
    const params=[ctx.credential.academy_id,actual,body.name,city,country,body.cityId??null,body.timeZone??null,body.currency??null,
      body.contactEmail??null,body.contactPhone??null,body.website??null,JSON.stringify(body.address??{}),point?.latitude??null,point?.longitude??null,JSON.stringify(body.translations),body.active??true];
    if(id) {
      const changed=await ctx.db.query(`UPDATE public.hubs SET name=$3,city=$4,country_code=$5,city_id=$6,time_zone=$7,currency=$8,contact_email=$9,contact_phone=$10,
        website=$11,address=$12::jsonb,latitude=$13,longitude=$14,translations=$15::jsonb,active=$16,version=version+1 WHERE academy_id=$1 AND id=$2 AND version=$17 RETURNING id`,[...params,input.expectedVersion]);
      if(!changed.rows.length)throw new ApiError(409,'TARGET_CHANGED');
    }
    else await ctx.db.query(`INSERT INTO public.hubs(academy_id,id,name,city,country_code,city_id,time_zone,currency,contact_email,contact_phone,website,address,latitude,longitude,translations,active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::jsonb,$16)`,params);
    const result=await hub(ctx,actual);
    if(before&&result.version!==Number(before.version)+1)throw new ApiError(409,'TARGET_CHANGED');
    await record(ctx.db,ctx.credential,ctx.requestId,'hub.'+(id?'updated':'created'),actual,actual,{before,after:result});
    return {status:id?200:201,body:{data:result}};
  });
}
async function readHubs(ctx:ApiContext,id?:string):Promise<Reply> {
  const scope=permitted(ctx,'hubs.view');if(id)requireScope(scope,id);
  const query=hubsQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  const rows=(await ctx.db.query<Fields>(`SELECT ${hubFields} FROM ${hubFrom} WHERE ${hubFilter('h.id')}
    AND ($4::uuid IS NULL OR h.id=$4) AND ($5::uuid IS NULL OR h.id>$5) AND ($6::text IS NULL OR position(lower($6) in lower(h.name))>0)
    AND ($7::boolean IS NULL OR h.active=$7) AND ($9::uuid IS NULL OR h.city_id=$9) AND ($10::uuid IS NULL OR country.id=$10) ORDER BY h.id LIMIT $8`,
    [...values(scope),id??null,query.after??null,query.q??null,query.active??null,query.limit+1,query.cityId??null,query.countryId??null])).rows;
  if(id&&!rows.length)throw new ApiError(404,'NOT_FOUND');
  return {status:200,body:id?{data:rows[0]}:{data:rows.slice(0,query.limit),nextCursor:rows.length>query.limit?rows[query.limit-1].id:null}};
}
async function course(ctx:ApiContext,id:string) {
  const row=(await ctx.db.query<Fields>(`SELECT c.*,v.definition->'modules' AS modules FROM public.courses c JOIN public.course_revisions v
    ON v.academy_id=c.academy_id AND v.course_id=c.id AND v.version=c.version WHERE c.id=$1`,[id])).rows[0];
  if(!row)throw new ApiError(404,'NOT_FOUND');return row;
}
async function saveCourse(ctx:ApiContext,id:string|null,raw:unknown):Promise<Reply> {
  permitted(ctx,'courses.edit');
  const input=(id?courseUpdate:courseInput).parse(raw) as Fields;
  await lockAcademyTopology(ctx);const scope=permitted(ctx,'courses.edit');
  return mutation(ctx,input,async()=>{
    const before=id?await course(ctx,id):null;
    if(before){requireScope(scope,before.hub_id as string??undefined);if(before.version!==input.expectedVersion)throw new ApiError(409,'TARGET_CHANGED');}
    const prior=before?{name:before.name,code:before.code,description:before.description,hubId:before.hub_id,active:before.active,modules:before.modules}:{};
    const {expectedVersion:ignored,...patch}=input;
    const body=courseInput.parse({...prior,...patch,translations:mergeLabels(before?.translations,input.translations)});
    requireScope(scope,body.hubId??undefined);
    if(body.hubId){const target=await hub(ctx,body.hubId);if(!target.active&&body.active)throw new ApiError(400,'ACTIVE_HUB_REQUIRED');}
    if(new Set(body.modules.map(m=>m.code)).size!==body.modules.length)throw new ApiError(400,'DUPLICATE_MODULE_CODE');
    const actual=id??randomUUID();
    const params=[ctx.credential.academy_id,actual,body.code,body.name,body.description,body.hubId,JSON.stringify(body.translations),body.active];
    if(id) {
      const changed=await ctx.db.query(`UPDATE public.courses SET code=$3,name=$4,description=$5,hub_id=$6,translations=$7::jsonb,active=$8,version=version+1
        WHERE academy_id=$1 AND id=$2 AND version=$9 RETURNING id`,[...params,input.expectedVersion]);
      if(!changed.rows.length)throw new ApiError(409,'TARGET_CHANGED');
    }else await ctx.db.query(`INSERT INTO public.courses(academy_id,id,code,name,description,hub_id,translations,active) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,params);
    const next=before?Number(before.version)+1:1;
    await ctx.db.query('INSERT INTO public.course_revisions(academy_id,course_id,version,definition) VALUES($1,$2,$3,$4::jsonb)',[ctx.credential.academy_id,actual,next,JSON.stringify(body)]);
    const result=await course(ctx,actual);
    await record(ctx.db,ctx.credential,ctx.requestId,'course.'+(id?'updated':'created'),actual,body.hubId,{before,after:result});
    return {status:id?200:201,body:{data:result}};
  });
}
async function readCourses(ctx:ApiContext,id?:string):Promise<Reply> {
  const scope=permitted(ctx,'courses.view');
  const query=coursesQuery.parse(Object.fromEntries(new URL(ctx.request.url).searchParams));
  if(query.hubId){requireScope(scope,query.hubId);await hub(ctx,query.hubId);}
  const rows=(await ctx.db.query<Fields>(`SELECT c.*,v.definition->'modules' AS modules FROM public.courses c JOIN public.course_revisions v
    ON v.academy_id=c.academy_id AND v.course_id=c.id AND v.version=c.version WHERE ((c.hub_id IS NOT NULL AND ${hubFilter('c.hub_id')}) OR (c.hub_id IS NULL AND $11::boolean))
    AND ($4::uuid IS NULL OR c.id=$4) AND ($5::uuid IS NULL OR c.id>$5) AND ($6::text IS NULL OR position(lower($6) in lower(c.name||' '||c.code))>0)
    AND ($7::boolean IS NULL OR c.active=$7) AND ($9::uuid IS NULL OR c.hub_id=$9 OR (c.hub_id IS NULL AND $10::boolean)) ORDER BY c.id LIMIT $8`,
    [...values(scope),id??null,query.after??null,query.q??null,query.active??null,query.limit+1,query.hubId??null,query.includeShared,query.includeShared])).rows;
  if(id&&!rows.length)throw new ApiError(404,'NOT_FOUND');
  return {status:200,body:id?{data:rows[0]}:{data:rows.slice(0,query.limit),nextCursor:rows.length>query.limit?rows[query.limit-1].id:null}};
}

export async function academy(ctx:ApiContext):Promise<Reply|null> {
  const {path,request}=ctx;
  const geo=/^locations\/(countries|regions|cities)(?:\/([^/]+)(?:\/(update))?)?$/.exec(path);
  if(geo) {
    const kind=geo[1] as GeoKind,id=geo[2]?uuid.parse(geo[2]):undefined;
    if(request.method==='GET'&&!geo[3])return readGeo(ctx,kind,id);
    if(request.method==='POST'&&(!id||geo[3]))return saveGeo(ctx,kind,id??null,await jsonBody(request));
    throw new ApiError(405,'METHOD_NOT_ALLOWED');
  }
  const resource=/^(hubs|courses)(?:\/([^/]+)(?:\/(update))?)?$/.exec(path);
  if(!resource)return null;
  const id=resource[2]?uuid.parse(resource[2]):undefined;
  if(request.method==='GET'&&!resource[3])return resource[1]==='hubs'?readHubs(ctx,id):readCourses(ctx,id);
  if(request.method==='POST'&&(!id||resource[3]))return resource[1]==='hubs'?saveHub(ctx,id??null,await jsonBody(request)):saveCourse(ctx,id??null,await jsonBody(request,1024*1024));
  throw new ApiError(405,'METHOD_NOT_ALLOWED');
}

export const academyContract=[
  ...(['countries','regions','cities'] as const).flatMap(kind=>[
    {path:'/api/v1/locations/'+kind,method:'get',summary:'List permitted '+kind,querySchema:kind==='countries'?countriesQuery:kind==='regions'?regionsQuery:citiesQuery},
    {path:'/api/v1/locations/'+kind,method:'post',summary:'Create editable geographic record',schema:kind==='countries'?countryInput:kind==='regions'?regionInput:cityInput},
    {path:'/api/v1/locations/'+kind+'/{id}',method:'get',summary:'Read permitted geographic record'},
    {path:'/api/v1/locations/'+kind+'/{id}/update',method:'post',summary:'Partially update or archive geographic record',schema:kind==='countries'?countryUpdate:kind==='regions'?regionUpdate:cityUpdate}
  ]),
  {path:'/api/v1/hubs',method:'get',summary:'List permitted hub profiles and configuration completeness',querySchema:hubsQuery},
  {path:'/api/v1/hubs',method:'post',summary:'Create hub from location/time-zone/currency settings; legacy minimal input remains supported with incomplete setup flagged',schema:hubCreate},
  {path:'/api/v1/hubs/{id}',method:'get',summary:'Read permitted hub profile'},
  {path:'/api/v1/hubs/{id}/update',method:'post',summary:'Version-checked partial hub profile update',schema:hubUpdate},
  {path:'/api/v1/courses',method:'get',summary:'List shared and permitted hub courses',querySchema:coursesQuery},
  {path:'/api/v1/courses',method:'post',summary:'Create versioned course/module outline',schema:courseInput},
  {path:'/api/v1/courses/{id}',method:'get',summary:'Read permitted current course and outline'},
  {path:'/api/v1/courses/{id}/update',method:'post',summary:'Partial course update preserving immutable earlier revisions',schema:courseUpdate}
] as const;
