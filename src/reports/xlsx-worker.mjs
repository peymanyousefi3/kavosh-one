import { parentPort, workerData } from 'node:worker_threads';
import { parse } from 'csv-parse/sync';
import writeXlsxFile from 'write-excel-file/node';

// Code-owned, text-only report conversion. No formulas, hyperlinks, images,
// workbook imports, filesystem writes or provider credentials in this worker.
export async function encodeReportSpreadsheet(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 4_194_304) throw new Error('SPREADSHEET_REQUIRES_CSV');
  let cells = 0;
  const rows = parse(source, { bom: true, skip_empty_lines: false, relax_column_count: false,
    on_record(row, info) {
      if (info.records > 20_001 || row.length > 256 || (cells += row.length) > 100_000) throw new Error('SPREADSHEET_REQUIRES_CSV');
      return row.map(value => {
        if (value.length > 32_767 || !value.isWellFormed()) throw new Error('SPREADSHEET_REQUIRES_CSV');
        // The writer strips these XML characters. Refuse rather than silently
        // changing source data; the original CSV remains available.
        for (const character of value) {
          const code = character.codePointAt(0);
          if (code < 32 && ![9,10,13].includes(code) || code >= 127 && code <= 159 || code >= 0xFDD0 && code <= 0xFDEF || code === 0xFFFD || (code & 0xFFFF) >= 0xFFFE) throw new Error('SPREADSHEET_REQUIRES_CSV');
        }
        // OOXML interprets _xHHHH_ even inside string cells. Escape literal
        // sequences first; XML parsers otherwise normalize raw carriage returns.
        return { type: String, value: value.replace(/_x[0-9a-fA-F]{4}_/g, match => '_x005F_' + match.slice(1)).replace(/\r/g, '_x000D_') };
      });
    }
  });
  if (!rows.length || !cells) throw new Error('EMPTY');
  const stream = await writeXlsxFile(rows, { sheet: 'Report' }).toStream();
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > 8_388_608) { stream.destroy(); throw new Error('SPREADSHEET_REQUIRES_CSV'); }
    chunks.push(chunk);
  }
  // Never transfer a pooled Buffer's potentially larger backing allocation.
  return Uint8Array.from(Buffer.concat(chunks, size));
}

if (parentPort) {
  try { const bytes = await encodeReportSpreadsheet(workerData); parentPort.postMessage({ bytes }, [bytes.buffer]); }
  catch (error) { parentPort.postMessage({ error: error instanceof Error && error.message === 'SPREADSHEET_REQUIRES_CSV' ? 'SPREADSHEET_REQUIRES_CSV' : 'SPREADSHEET_EXPORT_UNAVAILABLE' }); }
  finally { parentPort.close(); }
}
