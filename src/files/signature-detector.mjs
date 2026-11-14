import { parentPort,workerData } from 'node:worker_threads';
import { fileTypeFromBuffer } from 'file-type';

// Fixed trusted module, no dynamic detector/path or inherited application secrets.
// This is a signature hint, never a file-validity or malware-safety verdict.
try {
  if(!(workerData instanceof Uint8Array)||workerData.byteLength<1||workerData.byteLength>16384)throw new Error('INVALID_SAMPLE');
  parentPort?.postMessage(await fileTypeFromBuffer(workerData)??null);
}catch{parentPort?.postMessage({failed:true});}
