import { ApiError } from '../core/policy.ts';

// Preserve the original signed bytes. Bound both actual stream size and time;
// neither a claimed Content-Length nor an unending chunked stream is trusted.
export async function webhookBytes(request:Request,invalidBodyCode:string){
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')||!['','identity'].includes(request.headers.get('content-encoding')??''))throw new ApiError(415,'JSON_REQUIRED');
 const length=request.headers.get('content-length');if(length&&(!/^\d{1,10}$/.test(length)||Number(length)>1_048_576))throw new ApiError(413,'BODY_TOO_LARGE');
 const reader=request.body?.getReader();if(!reader)throw new ApiError(400,invalidBodyCode);
 let reject!: (error:ApiError)=>void;const cancelled=new Promise<never>((_resolve,r)=>{reject=r;}),abort=()=>reject(new ApiError(408,'WEBHOOK_BODY_CANCELLED'));
 const timer=setTimeout(()=>reject(new ApiError(408,'WEBHOOK_BODY_TIMEOUT')),3000);request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
 const chunks:Uint8Array[]=[];let size=0,finished=false;
 try{while(true){const part=await Promise.race([reader.read(),cancelled]);if(part.done){finished=true;break;}size+=part.value.byteLength;if(size>1_048_576)throw new ApiError(413,'BODY_TOO_LARGE');chunks.push(part.value);}return Buffer.concat(chunks);}
 finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);if(!finished)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
