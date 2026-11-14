import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

// Independent pixel decoder,not the encoder's own matrix/text representation.
export function decodedProfileQr(bytes:Uint8Array){
 assert.ok(bytes.length<=65536);const png=PNG.sync.read(Buffer.from(bytes));assert.equal(png.width,png.height);assert.ok(png.width<=512);const decoded=jsQR(new Uint8ClampedArray(png.data),png.width,png.height,{inversionAttempts:'dontInvert'});assert.ok(decoded,'Generated PNG must independently decode');return decoded.data;
}
