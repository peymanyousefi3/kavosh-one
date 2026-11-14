import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

// Synthetic bytes only; proves the deployed artifact can start the fixed worker
// without TypeScript loaders, provider credentials or writable application files.
const worker=new Worker(join(process.cwd(),'src/reports/xlsx-worker.mjs'),{env:{},execArgv:[],workerData:'identifier,amount\r\n000123,12345678901234567890.12\r\n',resourceLimits:{maxOldGenerationSizeMb:96,maxYoungGenerationSizeMb:16,stackSizeMb:4}});
const timer=setTimeout(()=>{void worker.terminate();},10_000);
let bytes;
worker.on('message',message=>{bytes=message.bytes;});
try {
 await new Promise((resolve,reject)=>{worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(Error('SPREADSHEET_WORKER_FAILED')));});
 assert.ok(bytes instanceof Uint8Array);assert.equal(bytes[0],80);assert.equal(bytes[1],75);assert.ok(bytes.byteLength>1000&&bytes.byteLength<10000);
 console.log(JSON.stringify({spreadsheetRuntime:'passed',bytes:bytes.byteLength,liveServicesUsed:false}));
} finally {clearTimeout(timer);}
