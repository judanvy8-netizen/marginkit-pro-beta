import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const between = (a, b) => html.slice(html.indexOf(a), html.indexOf(b, html.indexOf(a)));
const context = vm.createContext({window: {}, FileReader: class { constructor() { throw Error('must reject before file read'); } }});
vm.runInContext(between('const MAX_IMPORT_BYTES', '// --- Navigation ---') + between('function csvCell(v)', 'function downloadBlob') + between('function parseNum(v)', 'function norm(s)'), context);
vm.runInContext(between('function ingestSalesRows(rows, map)', 'function ingestCostRows('), context);
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS', name); }
check('all inline scripts parse', () => { for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]); });
check('no remote analytics or remote executable dependencies', () => { assert.doesNotMatch(html, /amplitude|<script[^>]+src=["']https?:/i); });
check('vendored library version and source digest', () => {
  const bytes = fs.readFileSync(path.join(root, 'vendor/xlsx-0.20.3.full.min.js'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41');
});
check('CSV formula text is neutralized but numeric negatives remain numeric', () => {
  for (const value of ['=1+1', '+SUM(1)', '-SUM(1)', '@SUM(1)', ' \t=HYPERLINK("https://bad.example")']) {
    assert.ok(context.csvCell(value).replace(/^"/, '').startsWith("'"));
  }
  assert.equal(context.csvCell(-42), '-42');
  assert.equal(context.csvCell('normal text'), 'normal text');
});
check('CSV fallback handles BOM, escaped quotes and quoted newlines without XLSX', () => {
  const wb = context.parseCsvToWorkbook('\ufeff상품명,코드\r\n"a\nb","x""y"\r\n', 'x.csv');
  const data = context.sheetToRows(wb, 'Sheet1');
  assert.equal(data.rows[0]['상품명'], 'a\nb'); assert.equal(data.rows[0]['코드'], 'x"y');
});
check('unterminated CSV quotes are rejected', () => assert.throws(() => context.parseCsvToWorkbook('A,B\n"broken,1', 'x.csv'), /따옴표/));
check('CSV row and column bounds reject over-limit files', () => {
  assert.throws(() => context.parseCsvToWorkbook(Array(202).fill('A').join(','), 'x.csv'), /열/);
  assert.throws(() => context.parseCsvToWorkbook('A\n' + '1\n'.repeat(20001), 'x.csv'), /행/);
});
check('oversized binary rejected before constructing FileReader', () => { let err; context.readFile({size: 11 * 1024 * 1024}, e => err = e); assert.match(err.message, /10MB/); });
check('header objects cannot mutate prototypes', () => {
  const data = context.sheetToRows(context.parseCsvToWorkbook('__proto__,constructor,상품명\nx,y,z', 'x.csv'), 'Sheet1');
  assert.equal(Object.getPrototypeOf(data.rows[0]), null); assert.equal(data.rows[0].__proto__, 'x');
});
check('duplicate headers rejected instead of overwriting data', () => assert.throws(() => context.sheetToRows(context.parseCsvToWorkbook('A,A\n1,2', 'x.csv'), 'Sheet1'), /중복/));
check('money parser rejects embedded sign, invalid grouping and non-finite data', () => {
  for (const v of ['1-2', '1,2', 'Infinity', '0x10', '1e309', 1e308]) assert.equal(context.parseNum(v), null);
  assert.equal(context.parseNum('(₩1,250)'), -1250); assert.equal(context.parseNum('-1,250'), -1250); assert.equal(context.parseNum('2.5'), 2.5);
});
check('invalid mapped optional numbers reject the entire import; blanks and zero remain intentional', () => {
  const map = {product:'상품', revenue:'매출', qty:'수량', commission:'수수료'};
  for (const bad of [{수량:'oops'}, {수수료:'abc'}, {수수료:'1-2'}]) {
    const result = context.ingestSalesRows([{상품:'test',매출:100,수량:1,수수료:0,...bad}], map);
    assert.equal(result.ok,false); assert.match(result.error,/2행/);
  }
  const result = context.ingestSalesRows([{상품:'test',매출:100,수량:0,수수료:''}],map);
  assert.equal(result.ok,true);assert.equal(result.rows[0].qty,0);assert.equal(result.rows[0].commission,0);
});
check('vendored XLSX parses an actual binary workbook and rejects huge declared ranges', () => {
  const XLSX = createRequire(import.meta.url)(path.join(root, 'vendor/xlsx-0.20.3.full.min.js'));
  assert.equal(XLSX.version, '0.20.3');
  context.XLSX = XLSX; context.window.XLSX = XLSX;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['상품명', '상품코드', '판매 수량'], ['테스트', '00001', 0]]), '정산');
  const bytes = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
  const read = XLSX.read(bytes, {type:'buffer', sheetRows:20002});
  const rows = context.sheetToRows(read, '정산').rows;
  assert.equal(rows[0]['상품코드'], '00001'); assert.equal(rows[0]['판매 수량'], 0);
  read.Sheets['정산']['!fullref'] = 'A1:XFD1048576';
  assert.throws(() => context.sheetToRows(read, '정산'), /20,000행/);
});
console.log(`SUMMARY pass=${passed} fail=0`);
