// Read public reference data and print a review draft; no API credential or DB
// connection is accepted. Pipe the draft through the normal scoped bot API.
import {z} from 'zod';
import {bankOfCanadaRequest,fetchBankOfCanadaReference} from '../src/integrations/bank-of-canada.ts';
import {exchangeRateInput} from '../src/modules/exchange-rates.ts';
try{
 if(process.argv.length!==3||process.argv[2]!=='--execute')throw Error('EXPLICIT_EXECUTE_REQUIRED');
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of process.stdin){const b=Buffer.from(chunk);size+=b.length;if(size>16384)throw Error('INPUT_TOO_LARGE');chunks.push(b);}
 const request=bankOfCanadaRequest.extend({base:exchangeRateInput.shape.base,quote:exchangeRateInput.shape.quote,quoteCode:z.literal('CAD'),supersedesId:exchangeRateInput.shape.supersedesId,reason:exchangeRateInput.shape.reason}).strict().refine(v=>v.base.id!==v.quote.id).parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
 const result=await fetchBankOfCanadaReference({code:request.code,on:request.on,maximumAgeDays:request.maximumAgeDays});
 const draft=result.selected?exchangeRateInput.parse({base:request.base,quote:request.quote,on:result.selected.on,rate:result.selected.rate,supersedesId:request.supersedesId,source:'Bank of Canada daily indicative average',reference:result.sourceUrl,reason:request.reason}):null;
 console.log(JSON.stringify({reference:result,draft,draftCurrencyIdsRequireCurrentCatalogueReview:true,proposalSubmitted:false}));
}catch{console.error('REFERENCE_RATE_DRAFT_FAILED');process.exitCode=1;}
