'use strict';
importScripts('./import-parser.js');

const MAX_ZIP_ENTRIES = 512;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;
const MAX_WORKBOOK_SHEETS = 20;
const MAX_WORKBOOK_CELLS = 250000;

// Check ZIP directory metadata before SheetJS decompresses an XLSX archive.
// Workers are terminated by the caller after 10 seconds; metadata checks do not
// constitute a browser memory quota or a complete validation of deflate data.
function inspectZip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const fail = message => { throw new Error(message); };
  if (bytes.length < 22) fail('손상된 XLSX 파일입니다.');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  }
  if (end < 0) fail('XLSX 압축 구조를 확인할 수 없습니다.');
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || count === 65535) fail('분할 또는 ZIP64 형식은 지원하지 않습니다.');
  if (!count || count > MAX_ZIP_ENTRIES || directoryOffset + directorySize > end) fail('XLSX 내부 파일 수 또는 구조가 허용 범위를 벗어났습니다.');
  let cursor = directoryOffset, expanded = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > directoryOffset + directorySize || view.getUint32(cursor, true) !== 0x02014b50) fail('손상된 XLSX 파일 목록입니다.');
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const unpacked = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (flags & 1) fail('암호화된 Excel 파일은 해제한 후 업로드해 주세요.');
    if (![0, 8].includes(method) || unpacked === 0xffffffff || compressed === 0xffffffff) fail('지원하지 않는 Excel 압축 형식입니다.');
    expanded += unpacked;
    if (unpacked > MAX_ENTRY_BYTES || expanded > MAX_EXPANDED_BYTES || (unpacked && (!compressed || unpacked / compressed > MAX_COMPRESSION_RATIO))) fail('압축 해제 크기가 너무 큰 파일입니다. 데이터를 나누어 업로드해 주세요.');
    if (localOffset + 30 > directoryOffset || view.getUint32(localOffset, true) !== 0x04034b50) fail('손상된 XLSX 내부 파일입니다.');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (localOffset + 30 + localNameLength + localExtraLength + compressed > directoryOffset || view.getUint16(localOffset + 8, true) !== method) fail('XLSX 파일 크기 정보가 일치하지 않습니다.');
    if (!(flags & 8) && (view.getUint32(localOffset + 18, true) !== compressed || view.getUint32(localOffset + 22, true) !== unpacked)) fail('XLSX 압축 크기 정보가 일치하지 않습니다.');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (cursor > directoryOffset + directorySize) fail('손상된 XLSX 파일 목록입니다.');
  }
  if (cursor !== directoryOffset + directorySize) fail('지원하지 않는 XLSX 파일 목록 형식입니다.');
  return { entries: count, expandedBytes: expanded };
}

function boundedWorkbook(wb) {
  if (!wb.SheetNames?.length || wb.SheetNames.length > MAX_WORKBOOK_SHEETS) throw new Error('Excel 파일은 1~20개 시트만 지원합니다.');
  const result = { SheetNames: [...wb.SheetNames], Sheets: Object.create(null) };
  let totalCells = 0;
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const range = sheet?.['!fullref'] || sheet?.['!ref'];
    if (range) {
      const { s, e } = XLSX.utils.decode_range(range);
      if (e.r > MAX_IMPORT_ROWS || e.c >= MAX_IMPORT_COLUMNS) throw new Error('파일은 20,000행·200열 이하로 나누어 주세요.');
      totalCells += (e.r - s.r + 1) * (e.c - s.c + 1);
      if (totalCells > MAX_WORKBOOK_CELLS) throw new Error('Excel 파일의 전체 셀 범위는 250,000개 이하로 나누어 주세요.');
    }
    result.Sheets[name] = sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true, blankrows: false }) : [];
  }
  return result;
}

self.onmessage = event => {
  try {
    const { buffer, name } = event.data || {};
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_IMPORT_BYTES || typeof name !== 'string') throw new Error('파일은 10MB 이하로 업로드해 주세요.');
    let wb;
    if (/\.csv$/i.test(name)) {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch { text = new TextDecoder('euc-kr').decode(buffer); }
      wb = parseCsvToWorkbook(text, name);
      const cells = wb.Sheets.Sheet1.reduce((n, row) => n + row.length, 0);
      if (cells > MAX_WORKBOOK_CELLS) throw new Error('CSV 파일은 250,000개 셀 이하로 나누어 주세요.');
    } else if (/\.(xlsx|xls)$/i.test(name)) {
      const sig = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
      const isZip = sig[0] === 0x50 && sig[1] === 0x4b;
      const isOle = [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1].every((v, i) => sig[i] === v);
      if (!isZip && !isOle) throw new Error('올바른 XLSX 또는 XLS 파일을 선택해 주세요.');
      if (isZip) inspectZip(buffer);
      if (typeof XLSX === 'undefined') importScripts('./vendor/xlsx-0.20.3.full.min.js');
      wb = boundedWorkbook(XLSX.read(buffer, { type: 'array', dense: true, sheetRows: MAX_IMPORT_ROWS + 2, cellDates: false, cellHTML: false, cellStyles: false, cellFormula: false, bookVBA: false }));
    } else throw new Error('XLSX, XLS 또는 CSV 파일을 선택해 주세요.');
    self.postMessage({ ok: true, workbook: wb });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : '파일을 읽지 못했습니다.' });
  }
};
