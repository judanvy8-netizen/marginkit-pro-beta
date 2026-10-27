'use strict';
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_ROWS = 20000;
const MAX_IMPORT_COLUMNS = 200;
function parseCsvToWorkbook(csvText, name) {
  const rows = [];
  let row = [], field = '', inQuotes = false, afterQuote = false;
  const pushField = () => {
    row.push(field); field = ''; afterQuote = false;
    if (row.length > MAX_IMPORT_COLUMNS) throw new Error('파일의 열 수는 200개 이하이어야 합니다.');
  };
  const pushRow = () => {
    pushField();
    if (row.some(value => value.trim() !== '')) rows.push(row);
    row = [];
    if (rows.length > MAX_IMPORT_ROWS + 1) throw new Error('파일은 20,000행 이하로 나누어 주세요.');
  };
  csvText = csvText.replace(/^\uFEFF/, '');
  for (let i = 0; i < csvText.length; i++) {
    const c = csvText[i];
    if (c === '"') {
      if (inQuotes && csvText[i + 1] === '"') { field += '"'; i++; }
      else if (inQuotes) { inQuotes = false; afterQuote = true; }
      else if (!field && !afterQuote) inQuotes = true;
      else throw new Error('CSV 파일의 따옴표 형식이 올바르지 않습니다.');
    } else if (c === ',' && !inQuotes) pushField();
    else if ((c === '\n' || c === '\r') && !inQuotes) {
      if (c === '\r' && csvText[i + 1] === '\n') i++;
      pushRow();
    } else if (afterQuote) {
      if (c !== ' ' && c !== '\t') throw new Error('CSV 닫는 따옴표 뒤에 구분자가 필요합니다.');
    } else field += c;
  }
  if (inQuotes) throw new Error('CSV 파일의 따옴표가 닫히지 않았습니다.');
  if (field.length || row.length || afterQuote) pushRow();
  return { SheetNames: ['Sheet1'], Sheets: { Sheet1: rows } };
}

function sheetToRows(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return { headers: [], rows: [] };
  let data;
  if (Array.isArray(ws)) data = ws;
  else if (typeof XLSX !== 'undefined' && XLSX.utils && XLSX.utils.sheet_to_json) {
    const range = ws['!fullref'] || ws['!ref'];
    if (range) {
      const end = XLSX.utils.decode_range(range).e;
      if (end.r > MAX_IMPORT_ROWS || end.c >= MAX_IMPORT_COLUMNS) {
        throw new Error('파일은 20,000행·200열 이하로 나누어 주세요.');
      }
    }
    data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false });
  } else return { headers: [], rows: [] };
  while (data.length && data[0].every(v => String(v ?? '').trim() === '')) data.shift();
  if (!data.length) return { headers: [], rows: [] };
  if (data.length > MAX_IMPORT_ROWS + 1 || data.some(r => r.length > MAX_IMPORT_COLUMNS)) {
    throw new Error('파일은 20,000행·200열 이하로 나누어 주세요.');
  }
  const headers = data[0].map((v, i) => String(v ?? '').trim() || '열 ' + (i + 1));
  if (new Set(headers).size !== headers.length) throw new Error('중복된 열 이름이 있습니다. 각 열 이름을 다르게 지정해 주세요.');
  const rows = data.slice(1).filter(r => r.some(v => String(v ?? '').trim() !== '')).map(r => {
    const o = Object.create(null);
    headers.forEach((h, i) => o[h] = r[i] ?? '');
    return o;
  });
  return { headers, rows };
}

