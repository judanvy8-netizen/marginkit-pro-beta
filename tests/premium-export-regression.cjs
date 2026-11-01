'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('../vendor/xlsx-0.20.3.full.min.js');
const Export = require('../premium-export.js');
const Suite = require('../suite-tools.js');
const D = require('../exact-decimal.js');
function roundtrip(sheets) {
  const book = Export.workbook(XLSX, sheets);
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  assert.ok(bytes.length > 0);
  return XLSX.read(bytes, { type: 'buffer', cellFormula: true, sheetStubs: true, raw: true });
}
function rows(book, name) { return XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true, defval: '' }); }
function assertNoFormulas(book) {
  for (const sheet of Object.values(book.Sheets)) for (const [address, value] of Object.entries(sheet)) {
    if (!address.startsWith('!')) assert.equal(value.f, undefined, 'unexpected formula at ' + address);
  }
}
function product(overrides = {}) {
  return { product: '상품', sku: '00123', qty: '1', revenue: '10.5', refunds: '0', netRevenue: '10.5', unitCost: '0', cost: '0', commission: '0.3', shipping: '0', ads: '0', other: '0', profit: '10.2', hasCost: true, ...overrides };
}
function snapshot(products, overrides = {}) {
  return { isDemo: false, source: 'settlement.csv', totals: { products, totalRevenue: '10.5', totalRefunds: '0', profit: '10.2', missing: 0 }, ...overrides };
}
function scenario(id, overrides = {}) { return { id, name: id, simulator: { ...Suite.defaults().simulator, ...overrides } }; }
function month(value, sales, name = value) {
  return { id: value.replace('-', ''), month: value, name, lines: [{ channel: '채널', sales, feePct: '0.1', vatPct: '10' }] };
}
test('real XLSX serialization preserves identifiers and formula-like text as strings', () => {
  const texts = ['=HYPERLINK("https://example.invalid","x")', '+SUM(A1:A2)', '-cmd', '@SUM(A1)', '\t=1+1', '\ufeff=1+1', '00123'];
  const book = roundtrip([{ name: '문자', rows: texts.map(value => [value]) }]);
  const sheet = book.Sheets['문자'];
  texts.forEach((value, index) => { const cell = sheet['A' + (index + 1)]; assert.equal(cell.t, 's'); assert.equal(cell.v, value); });
  assertNoFormulas(book);
});
test('Excel-safe amounts are numeric while 24-digit and high-precision amounts remain exact text', () => {
  const values = ['12345.67', '0.000000000001', '-8.25', '0', '123456789012345678901234', '0.1000000000000000000000000001'];
  const book = roundtrip([{ name: '금액', rows: values.map(value => [Export.decimal(value)]) }]);
  const sheet = book.Sheets['금액'];
  values.forEach((value, index) => {
    const cell = sheet['A' + (index + 1)];
    assert.equal(cell.t, index < 4 ? 'n' : 's');
    assert.equal(D.normalize(cell.v), value);
  });
});
test('zero, unknown null and undefined remain distinct after workbook serialization', () => {
  const book = roundtrip([{ name: '값', rows: [[Export.decimal('0'), Export.decimal(null), Export.decimal(undefined)]] }]);
  assert.equal(book.Sheets['값'].A1.t, 'n'); assert.equal(book.Sheets['값'].A1.v, 0);
  assert.equal(book.Sheets['값'].B1.v, ''); assert.equal(book.Sheets['값'].C1.v, '');
});
test('analysis export keeps unknown cost/profit blank, registered zero numeric, and source/formula names harmless', () => {
  const known = product({ product: '=1+1', sku: '00007' });
  const unknown = product({ product: '+SUM(A1)', sku: '00008', unitCost: null, cost: null, profit: null, hasCost: false });
  const s = snapshot([known, unknown]); s.source = '=malicious.csv'; s.totals.missing = 1;
  const book = roundtrip(Export.analysisSheets(s));
  const sheet = book.Sheets['상품별 분석'];
  assert.equal(sheet.A2.v, '=1+1'); assert.equal(sheet.A2.t, 's');
  assert.equal(sheet.B2.v, '00007'); assert.equal(sheet.B2.t, 's');
  assert.equal(sheet.G2.v, 0); assert.equal(sheet.G2.t, 'n');
  assert.equal(sheet.H2.v, 0); assert.equal(sheet.M2.v, 10.2);
  assert.equal(sheet.G3.v, ''); assert.equal(sheet.H3.v, ''); assert.equal(sheet.M3.v, '');
  assert.equal(sheet.N3.v, '원가 미등록');
  assert.equal(book.Sheets['안내와 요약'].B2.v, '=malicious.csv');
  assertNoFormulas(book);
});
test('analysis export preserves 24-digit totals and exact advertising sums', () => {
  const s = snapshot([product({ ads: '0.1' }), product({ ads: '0.2' })]);
  s.totals.totalRevenue = '123456789012345678901234';
  const book = roundtrip(Export.analysisSheets(s));
  const sheet = book.Sheets['안내와 요약'];
  assert.equal(sheet.B6.t, 's'); assert.equal(sheet.B6.v, '123456789012345678901234');
  assert.equal(sheet.B10.t, 'n'); assert.equal(sheet.B10.v, 0.3);
});
test('scenario export carries exact fraction, high precision input/output, and impossible target as blank', () => {
  const fractional = scenario('third', { sell: '3', cost: '2', ship: '0', ad: '0', fixed: '0', feePct: '0', units: '1', targetPct: '100' });
  fractional.name = '=SUM(A1)';
  const precise = scenario('precise', { sell: '0.3000000000000000000000000001', cost: '0.1', ship: '0', ad: '0.1', fixed: '0', feePct: '0', units: '3' });
  const book = roundtrip(Export.scenarioSheets([fractional, precise]));
  const comparison = book.Sheets['시나리오 비교'];
  assert.equal(comparison.A4.v, '=SUM(A1)');
  assert.equal(comparison.I4.v, '1/3'); assert.equal(comparison.I4.t, 's');
  assert.equal(comparison.H4.v, '');
  assert.equal(comparison.B5.t, 's'); assert.equal(comparison.B5.v, precise.simulator.sell);
  assert.equal(comparison.G5.t, 's'); assert.equal(comparison.G5.v, '0.3000000000000000000000000003');
  assert.equal(book.Sheets['시나리오 입력값'].B3.v, precise.simulator.sell);
  assertNoFormulas(book);
});
test('monthly export sorts records, does not invent missing months, and preserves VAT fractions', () => {
  const january = month('2026-01', '100', '=JAN'); january.lines[0].channel = '+CHANNEL';
  const march = month('2026-03', '200');
  const book = roundtrip(Export.timelineSheets([march, january]));
  const monthly = rows(book, '월별 정산');
  assert.equal(monthly.length, 6);
  assert.deepEqual(monthly.slice(4).map(row => row[0]), ['2026-01', '2026-03']);
  assert.equal(monthly[4][5], ''); assert.equal(monthly[5][5], 99.9);
  assert.equal(monthly[4][6], '100/11'); assert.equal(monthly[5][6], '200/11');
  assert.match(monthly[2][1], /이전 저장 월/);
  const detail = book.Sheets['월별 채널 상세'];
  assert.equal(detail.C2.v, '+CHANNEL'); assert.equal(detail.I2.v, '1000/11'); assert.equal(detail.J2.v, '100/11');
  assertNoFormulas(book);
});
test('empty reports fail before creating a misleading workbook', () => {
  assert.throws(() => Export.analysisSheets(snapshot([])), /먼저 분석/);
  assert.throws(() => Export.scenarioSheets([]), /먼저 저장/);
  assert.throws(() => Export.timelineSheets([]), /먼저 저장/);
  assert.throws(() => Export.workbook(null, []), /엑셀 모듈/);
});
