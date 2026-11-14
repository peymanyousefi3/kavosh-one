import {createHash} from 'node:crypto';
import {z} from 'zod';
import {accountingDate} from '../modules/finance-periods.ts';
import {exchangeRatio} from '../core/exchange.ts';

export const bankOfCanadaRequest=z.object({code:z.string().regex(/^[A-Z]{3}$/).refine(v=>v!=='CAD'),on:accountingDate,maximumAgeDays:z.number().int().min(0).max(30).default(0)}).strict();
const dayMs=86400000;
// Public reference data only. Call outside database transactions; callers must
// submit a selected observation through the existing human-reviewed FX API.
// No arbitrary URL, credential, redirect, retry, inverse or missing-rate fallback.
export async function fetchBankOfCanadaReference(raw:unknown,send:typeof fetch=fetch,signal?:AbortSignal){
 const input=bankOfCanadaRequest.parse(raw),series='FX'+input.code+'CAD';
 const end=Date.parse(input.on+'T00:00:00Z'),start=new Date(end-input.maximumAgeDays*dayMs).toISOString().slice(0,10);
 accountingDate.parse(start);
 const url=new URL('https://www.bankofcanada.ca/valet/observations/'+series+'/json');url.searchParams.set('start_date',start);url.searchParams.set('end_date',input.on);
 const controller=new AbortController(),cancel=()=>controller.abort();let reject!:(e:Error)=>void;
 const unavailable=()=>new Error('BANK_OF_CANADA_REFERENCE_UNAVAILABLE'),stopped=new Promise<never>((_,no)=>{reject=no;});void stopped.catch(()=>{});
 const abort=()=>reject(unavailable());controller.signal.addEventListener('abort',abort,{once:true});signal?.addEventListener('abort',cancel,{once:true});const timer=setTimeout(cancel,8000);
 let response:Response|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,complete=false;
 const discard=(body:ReadableStream<Uint8Array>|null|undefined)=>{try{void body?.cancel().catch(()=>{});}catch{/* Never disclose upstream diagnostics. */}};
 try{
  if(signal?.aborted)throw unavailable();
  const pending=send(url,{method:'GET',headers:{accept:'application/json'},redirect:'error',credentials:'omit',cache:'no-store',signal:controller.signal});
  void pending.then(r=>{if(controller.signal.aborted)discard(r.body);},()=>{});response=await Promise.race([pending,stopped]);
  if(!response.ok||response.redirected||(response.headers.get('content-type')??'').split(';')[0].trim().toLowerCase()!=='application/json')throw unavailable();
  const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||BigInt(length)>65536n))throw unavailable();
  reader=response.body?.getReader();if(!reader)throw unavailable();let size=0;const chunks:Uint8Array[]=[];
  for(;;){const part=await Promise.race([reader.read(),stopped]);if(part.done){complete=true;break;}if(!(part.value instanceof Uint8Array))throw unavailable();size+=part.value.byteLength;if(size>65536)throw unavailable();chunks.push(part.value);}
  const bytes=Buffer.concat(chunks,size),body=z.object({terms:z.object({url:z.literal('https://www.bankofcanada.ca/terms/')}),seriesDetail:z.record(z.string(),z.object({label:z.string(),dateFormat:z.literal('daily'),dimension:z.object({key:z.literal('d')}),metadata:z.object({frequency:z.literal('Business daily'),unit:z.string().min(1).max(200)})})),observations:z.array(z.record(z.string(),z.unknown())).max(31)}).parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  const detail=body.seriesDetail[series];if(Object.keys(body.seriesDetail).length!==1||detail?.label!==input.code+'/CAD'||!detail.metadata.unit.startsWith('Canadian dollars per '))throw unavailable();
  let previous='';const observations=body.observations.map(row=>{
   if(Object.keys(row).length!==2||!Object.hasOwn(row,series))throw unavailable();
   const on=accountingDate.parse(row.d),rate=z.object({v:z.string().max(37)}).strict().parse(row[series]).v;
   if(on<start||on>input.on||on<=previous)throw unavailable();previous=on;exchangeRatio(rate);
   return {on,rate,ageDays:(end-Date.parse(on+'T00:00:00Z'))/dayMs};
  });
  const selected=observations.at(-1)??null;
  return {provider:'Bank of Canada',series,sourceUrl:url.href,termsUrl:body.terms.url,retrievedAt:new Date().toISOString(),responseSha256:createHash('sha256').update(bytes).digest('hex'),requestedOn:input.on,maximumAgeDays:input.maximumAgeDays,baseCode:input.code,quoteCode:'CAD',convention:'one_base_major_unit_in_quote_major_units',observations,selected,issue:selected?null:'REFERENCE_RATE_MISSING',referenceOnly:true,humanReviewRequired:true,ledgerAdjusted:false,moneyMovementPerformed:false} as const;
 }catch{controller.abort();throw unavailable();}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',abort);if(!complete){if(reader){try{void reader.cancel().catch(()=>{});}catch{/* Cancellation must not block the caller. */}}else discard(response?.body);}reader?.releaseLock();}
}
