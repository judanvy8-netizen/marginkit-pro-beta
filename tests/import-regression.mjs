#!/usr/bin/env node
/**
 * F01 follow-up source-function regression harness.
 * Run from this directory or any cwd: node tests/f01-followup-regression.mjs
 * Runs selected functions extracted from this work copy in a Node VM with
 * synthetic rows, fake localStorage/DOM and a queued FileReader callback.
 * No browser, network, packages, profile, or user data are used.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = process.env.APP_SOURCE || path.join(ROOT, 'app.js');
const BASE_COMMIT = '34ac6229d2b76e7a1878c70fcc989345430fafdc';
const BASE_SOURCE_SHA256 = '5ef4f2cd936e4ac87c56c4904b7692218facb9f642f71cd0df31065b9d9b4c70';
const V1_SOURCE_SHA256 = '9816e6c9d53914738afb5da19d9dad7f966262e42512457445a248d8956f1bcf';
const V2_SOURCE_SHA256 = '6293d32805e3fa410df36a4d896343837317d63b575a88700bde91aba78dc394';
const COST_KEY = 'marginkit_costs_v2';
const PRESET_KEY = 'marginkit_map_preset_v2';

const html = fs.readFileSync(SOURCE_PATH, 'utf8');
const PATCH_SOURCE_SHA256 = crypto.createHash('sha256').update(html).digest('hex');
const between = (start, end) => {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Missing source markers: ${start} / ${end}`);
  return html.slice(a, b);
};
const source = {
  loadCosts: between('function loadCostsFromStorage() {', 'function saveCostsToStorage() {'),
  saveCosts: between('function saveCostsToStorage() {', 'function restoreCostsFromStorage() {'),
  savePreset: between('function saveMappingPreset(map) {', 'function loadMappingPreset() {'),
  parseNum: between('function parseNum(v) {', 'function norm(s) {'),
  norm: between('function norm(s) {', 'function findHeader(headers, aliases) {'),
  ingestSales: between('function ingestSalesRows(rows, map) {', 'function ingestCostRows(rows, map, baseCosts = state.costs) {'),
  ingestCosts: between('function ingestCostRows(rows, map, baseCosts = state.costs) {', 'function resolveProductCost('),
  resolveCost: between('function resolveProductCost(', 'function getCost(p) {'),
  invalidate: between('function invalidateImportReads(type) {', 'function exitDemoMode() {'),
  setCost: between('function setCost(p, unitCost) {', '// --- Dashboard Rendering ---'),
  renderMappings: between('function renderMappings(containerId, headers, defs, map) {', 'function renderPreview(headers, rows, elId) {'),
  removeFile: between('function removeImportFile(type) {', 'function updateFileStatus(type) {'),
  updateFileStatus: between('function updateFileStatus(type) {', 'function setWorkbook(type, wb, fileName) {'),
  loadSheet: between('function loadSheet(type, name, preset = {}) {', 'function importFile(type, file) {'),
  setWorkbook: between('function setWorkbook(type, wb, fileName) {', 'function loadSheet(type, name, preset = {}) {'),
  importFile: between('function importFile(type, file) {', 'function processImport() {'),
  processImport: between('function processImport() {', '// --- Demo Data ---'),
  loadDemo: between('function loadDemo() {', '// --- CSV Downloads & Templates ---'),
  resetHandler: between("$('#btnReset').onclick = () => {", "$('#salesDrop').onclick = () => $('#salesFile').click();")
};
const cancelStart = "$('#btnCancelImport').onclick = () => {";
const cancelOffset = html.indexOf(cancelStart);
if (cancelOffset < 0) throw new Error('Cancel handler not found');
const cancelEnd = html.indexOf('\n};', cancelOffset);
if (cancelEnd < 0) throw new Error('Cancel handler end not found');
source.cancelHandler = html.slice(cancelOffset, cancelEnd + 3);

const executedText = Object.values(source).join('\n');
assert.doesNotMatch(executedText, /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bsendBeacon\b/, 'network primitive found in extracted functions');
const storageBaseCosts = [
  ['sku:CP-001', { product: 'Saved synthetic item', sku: 'CP-001', unitCost: 12345 }],
  ['sku:KEEP-002', { product: 'Keep synthetic item', sku: 'KEEP-002', unitCost: 456 }]
];
const presetValue = { product: 'Original Product Column', revenue: 'Original Revenue Column' };

function fakeElement(selector) {
  return {
    selector, innerHTML: '', textContent: '', value: '', onclick: null,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, click() {}
  };
}
function makeHarness({ emptyCostKey = false, isDemo = true } = {}) {
  const storage = new Map([[PRESET_KEY, JSON.stringify(presetValue)]]);
  if (!emptyCostKey) storage.set(COST_KEY, JSON.stringify(storageBaseCosts));
  const storageOps = [];
  const elements = new Map();
  const selects = [];
  const pendingReads = [];
  const toastLog = [];
  const sampleDemoCosts = new Map([
    ['sku:CP-001', { product: 'Demo collision', sku: 'CP-001', unitCost: 9200 }]
  ]);
  const state = {
    salesWorkbook: null, costWorkbook: null, salesSource: 'none', costSource: 'none',
    importGeneration: { sales: 0, cost: 0 }, salesFileName: '', costFileName: '',
    importStatus: { sales: 'idle', cost: 'idle' },
    salesRows: [], costRows: [], salesHeaders: [], costHeaders: [],
    salesSheetName: '', costSheetName: '', salesMap: {}, costMap: {},
    transactions: [{ product: 'Visible synthetic demo', sku: 'CP-001', revenue: 100 }],
    products: [], costs: sampleDemoCosts, isDemo, filter: 'all', activeTab: 'dashboard',
    chartMetric: 'revenue', sortColumn: 'revenue', sortAsc: false
  };
  const ctx = {
    state, premiumRules: [], STORAGE_KEY_COSTS: COST_KEY, STORAGE_KEY_PRESET: PRESET_KEY,
    fieldDefs: ['product', 'sku', 'revenue', 'qty', 'commission', 'shipping', 'ads', 'refunds', 'other'].map(key => ({ key })),
    costFieldDefs: ['product', 'sku', 'unitCost'].map(key => ({ key })),
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storageOps.push(['set', key, String(value)]); storage.set(key, String(value)); },
      removeItem(key) { storageOps.push(['remove', key]); storage.delete(key); }
    },
    toast(message) { toastLog.push(String(message)); }, showModal() {},
    renderDashboard() {}, renderProducts() {}, renderResults() {}, updateMappingUI() {},
    updateFileStatus() {}, setPage(page) { ctx.currentPage = page; }, currentPage: '',
    confirm() { return true; }, esc(value) { return String(value); },
    detectMaps(headers, defs) {
      const keys = defs.map(d => d.key);
      const find = (test, fallback) => headers.find(h => test.test(String(h))) || headers[fallback] || '';
      const map = {};
      for (const key of keys) {
        const slot = { product: 0, sku: 1, revenue: 2, qty: 3, commission: 4, shipping: 5, ads: 6, refunds: 7, other: 8, unitCost: 2 }[key];
        const rx = { product: /product|name/i, sku: /sku|code/i, revenue: /revenue|sales/i, unitCost: /cost/i }[key] || /$a/;
        map[key] = find(rx, slot ?? 0);
      }
      return map;
    },
    loadMappingPreset() {
      const saved = storage.get(PRESET_KEY);
      return saved ? JSON.parse(saved) : {};
    },
    sheetToRows(wb, name) { return { headers: wb.syntheticHeaders || [], rows: wb.syntheticRows || [] }; },
    readFile(file, callback) { pendingReads.push({ file, callback }); }, pendingReads,
    storageOps, toastLog, elements, selects,
    $(selector) {
      if (!elements.has(selector)) elements.set(selector, fakeElement(selector));
      return elements.get(selector);
    },
    $$(selector) { return selector === '.mapping-select' ? selects : []; }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'exact-decimal.js'), 'utf8'), ctx);
  vm.runInContext(source.parseNum + source.norm + source.loadCosts + source.resolveCost, ctx);
  vm.runInContext("loadCostsFromStorage()", ctx);
  return { ctx, state, storage, storageOps, toastLog, elements, selects, pendingReads, baselineCosts: storage.get(COST_KEY) };
}
function install(h, ...names) {
  const revisionState = h.ctx.loadCostsFromStorage ? { ...h.ctx.loadCostsFromStorage } : {};
  vm.runInContext(names.map(name => source[name]).join('\n'), h.ctx);
  if (names.includes('loadCosts')) Object.assign(h.ctx.loadCostsFromStorage, revisionState);
}
function installFileFlow(h) {
  install(h, 'loadCosts', 'saveCosts', 'savePreset', 'parseNum', 'norm', 'ingestSales', 'ingestCosts',
    'invalidate', 'removeFile', 'updateFileStatus', 'loadSheet', 'setWorkbook', 'importFile', 'processImport');
}
let pass = 0;
let fail = 0;
function check(name, run) {
  try { run(); pass++; console.log('PASS ' + name); }
  catch (error) { fail++; console.error('FAIL ' + name + ': ' + (error.stack || error)); }
}
function seedActualSales(h, { validMap = true } = {}) {
  h.state.salesWorkbook = { SheetNames: ['Synthetic sales'] };
  h.state.salesSource = 'file';
  h.state.importStatus.sales = 'ready';
  h.state.salesRows = [{ Product: 'Actual synthetic product', SKU: 'CP-001', Revenue: '100' }];
  h.state.salesMap = validMap
    ? { product: 'Product', sku: 'SKU', revenue: 'Revenue' }
    : { product: '', sku: 'SKU', revenue: 'Revenue' };
}
function startSyntheticRead(h, type, name) {
  h.ctx.syntheticFile = { name };
  vm.runInContext(`importFile('${type}', syntheticFile)`, h.ctx);
  return h.pendingReads.at(-1);
}
function completeSyntheticRead(pending, headers, rows) {
  pending.callback(null, { SheetNames: ['Synthetic workbook'], syntheticHeaders: headers, syntheticRows: rows });
}
function clickCostRemove(h) {
  const status = h.elements.get('#costFileStatus');
  assert.match(status?.innerHTML || '', /data-remove-file="cost"/, 'cost status should expose a remove control');
  const button = h.elements.get('[data-remove-file="cost"]');
  assert.equal(typeof button?.onclick, 'function', 'cost remove control should be actionable');
  button.onclick();
}
function snapshotImportState(h) {
  return {
    isDemo: h.state.isDemo, transactions: h.state.transactions, costs: h.state.costs,
    costStorage: h.storage.get(COST_KEY), preset: h.storage.get(PRESET_KEY), storageOps: h.storageOps.length
  };
}
function assertImportStateUnchanged(h, before) {
  assert.equal(h.state.isDemo, before.isDemo);
  assert.equal(h.state.transactions, before.transactions);
  assert.equal(h.state.costs, before.costs);
  assert.equal(h.storage.get(COST_KEY), before.costStorage);
  assert.equal(h.storage.get(PRESET_KEY), before.preset);
  assert.equal(h.storageOps.length, before.storageOps);
}

console.log('BASE_COMMIT=' + BASE_COMMIT);
console.log('BASE_SOURCE_SHA256=' + BASE_SOURCE_SHA256);
console.log('V1_SOURCE_SHA256=' + V1_SOURCE_SHA256);
console.log('V2_SOURCE_SHA256=' + V2_SOURCE_SHA256);
console.log('PATCH_SOURCE_SHA256=' + PATCH_SOURCE_SHA256);
console.log('PATCH_SOURCE=' + path.relative(ROOT, SOURCE_PATH));
console.log('SCOPE=selected source functions in Node VM; synthetic rows and fake storage/DOM/FileReader; not browser E2E');
console.log('PASS_MEANS=the named protection or retained behavior was asserted; baseline reproduction PASS means a defect was reproduced');

check('failed sales mapping keeps demo state and colliding real cost key unchanged', () => {
  const h = makeHarness(); install(h, 'loadCosts', 'saveCosts', 'parseNum', 'norm', 'ingestSales', 'processImport', 'setCost');
  seedActualSales(h, { validMap: false });
  const demoRows = h.state.transactions; const demoCostMap = h.state.costs;
  vm.runInContext('processImport()', h.ctx);
  assert.equal(h.state.isDemo, true); assert.equal(h.state.transactions, demoRows); assert.equal(h.state.costs, demoCostMap);
  assert.equal(h.storage.get(COST_KEY), h.baselineCosts); assert.equal(h.storageOps.length, 0);
  vm.runInContext("setCost({product:'Synthetic demo edit',sku:'CP-001'},'99999')", h.ctx);
  assert.equal(h.state.costs.get('sku:CP-001').unitCost, 99999);
  assert.equal(h.storage.get(COST_KEY), h.baselineCosts);
});

check('failed cost mapping is transactional and leaves demo mode plus persisted costs intact', () => {
  const h = makeHarness(); install(h, 'loadCosts', 'saveCosts', 'parseNum', 'norm', 'ingestSales', 'ingestCosts', 'processImport');
  seedActualSales(h); h.state.costWorkbook = { SheetNames: ['Synthetic costs'] }; h.state.costSource = 'file'; h.state.importStatus.cost = 'ready';
  h.state.costRows = [{ Product: 'Actual synthetic product', SKU: 'CP-001', UnitCost: '777' }];
  h.state.costMap = { product: '', sku: 'SKU', unitCost: 'UnitCost' };
  const demoRows = h.state.transactions; const demoCostMap = h.state.costs;
  vm.runInContext('processImport()', h.ctx);
  assert.equal(h.state.isDemo, true); assert.equal(h.state.transactions, demoRows); assert.equal(h.state.costs, demoCostMap);
  assert.equal(h.storage.get(COST_KEY), h.baselineCosts); assert.equal(h.storageOps.length, 0);
});

check('failed import does not create an absent real-cost storage key', () => {
  const h = makeHarness({ emptyCostKey: true }); install(h, 'loadCosts', 'saveCosts', 'parseNum', 'norm', 'ingestSales', 'processImport');
  seedActualSales(h, { validMap: false }); vm.runInContext('processImport()', h.ctx);
  assert.equal(h.state.isDemo, true); assert.equal(h.storage.has(COST_KEY), false);
  assert.equal(h.storageOps.some(([op, key]) => key === COST_KEY), false);
});

check('sample rows cannot be analyzed as actual input without an uploaded sales file', () => {
  const h = makeHarness(); install(h, 'loadCosts', 'saveCosts', 'parseNum', 'norm', 'ingestSales', 'ingestCosts', 'processImport', 'invalidate');
  h.state.salesSource = 'demo'; h.state.salesRows = [{ Product: 'Sample', Revenue: '100' }];
  vm.runInContext('processImport()', h.ctx);
  assert.equal(h.state.isDemo, true); assert.equal(h.state.salesWorkbook, null);
  assert.equal(h.storage.get(COST_KEY), h.baselineCosts); assert.equal(h.storageOps.length, 0);
});

check('Analyze before the first sales callback leaves state frozen and does not invalidate the callback', () => {
  const h = makeHarness(); installFileFlow(h);
  const before = snapshotImportState(h);
  const pending = startSyntheticRead(h, 'sales', 'synthetic-sales.csv');
  const generation = h.state.importGeneration.sales;
  assert.equal(h.state.importStatus.sales, 'reading');
  vm.runInContext('processImport()', h.ctx);
  assertImportStateUnchanged(h, before);
  assert.equal(h.state.importGeneration.sales, generation);
  completeSyntheticRead(pending, ['Product', 'SKU', 'Revenue'], [
    { Product: 'First actual product', SKU: 'CP-001', Revenue: '100' }
  ]);
  assert.equal(h.state.importStatus.sales, 'ready');
  vm.runInContext('processImport()', h.ctx);
  assert.equal(h.state.isDemo, false);
  assert.equal(h.state.transactions[0].product, 'First actual product');
});

check('Analyze between sales completion and cost completion preserves demo and both read generations', () => {
  const h = makeHarness(); installFileFlow(h);
  const salesRead = startSyntheticRead(h, 'sales', 'synthetic-sales.csv');
  completeSyntheticRead(salesRead, ['Product', 'SKU', 'Revenue'], [
    { Product: 'Actual product', SKU: 'CP-001', Revenue: '100' }
  ]);
  const costRead = startSyntheticRead(h, 'cost', 'synthetic-costs.csv');
  const before = snapshotImportState(h);
  const generations = { ...h.state.importGeneration };
  vm.runInContext('processImport()', h.ctx);
  assertImportStateUnchanged(h, before);
  assert.deepEqual(h.state.importGeneration, generations);
  completeSyntheticRead(costRead, ['Product', 'SKU', 'UnitCost'], [
    { Product: 'Actual product', SKU: 'CP-001', UnitCost: '4444' }
  ]);
  vm.runInContext('processImport()', h.ctx);
  assert.equal(h.state.isDemo, false);
  assert.equal(h.state.costs.get('sku:CP-001').unitCost, 4444);
});

check('replacement sales read blocks the previous valid sales workbook but accepts its new callback', () => {
  const h = makeHarness(); installFileFlow(h); seedActualSales(h);
  const previousWorkbook = h.state.salesWorkbook;
  const before = snapshotImportState(h);
  const pending = startSyntheticRead(h, 'sales', 'replacement-sales.csv');
  vm.runInContext('processImport()', h.ctx);
  assertImportStateUnchanged(h, before);
  assert.equal(h.state.salesWorkbook, previousWorkbook);
  assert.equal(h.state.importStatus.sales, 'reading');
  completeSyntheticRead(pending, ['Product', 'SKU', 'Revenue'], [
    { Product: 'Replacement product', SKU: 'CP-001', Revenue: '200' }
  ]);
  assert.equal(h.state.salesRows[0].Product, 'Replacement product');
  assert.equal(h.state.importStatus.sales, 'ready');
  vm.runInContext('processImport()', h.ctx);
  assert.equal(h.state.isDemo, false);
  assert.equal(h.state.transactions[0].product, 'Replacement product');
});

check('replacement cost read blocks the previous valid cost workbook until replacement finishes', () => {
  const h = makeHarness(); installFileFlow(h); seedActualSales(h);
  const first = startSyntheticRead(h, 'cost', 'original-costs.csv');
  completeSyntheticRead(first, ['Product', 'SKU', 'UnitCost'], [
    { Product: 'Old actual product', SKU: 'CP-001', UnitCost: '1111' }
  ]);
  const previousWorkbook = h.state.costWorkbook;
  const before = snapshotImportState(h);
  const pending = startSyntheticRead(h, 'cost', 'replacement-costs.csv');
  vm.runInContext('processImport()', h.ctx);
  assertImportStateUnchanged(h, before);
  assert.equal(h.state.costWorkbook, previousWorkbook);
  assert.equal(h.state.importStatus.cost, 'reading');
  completeSyntheticRead(pending, ['Product', 'SKU', 'UnitCost'], [
    { Product: 'New actual product', SKU: 'CP-001', UnitCost: '2222' }
  ]);
  vm.runInContext('processImport()', h.ctx);
  assert.equal(h.state.isDemo, false);
  assert.equal(h.state.costs.get('sku:CP-001').unitCost, 2222);
});

check('read error marks replacement failed and prevents fallback to the old cost workbook', () => {
  const h = makeHarness(); installFileFlow(h); seedActualSales(h);
  const first = startSyntheticRead(h, 'cost', 'original-costs.csv');
  completeSyntheticRead(first, ['Product', 'SKU', 'UnitCost'], [
    { Product: 'Old actual product', SKU: 'CP-001', UnitCost: '1111' }
  ]);
  const before = snapshotImportState(h);
  const pending = startSyntheticRead(h, 'cost', 'broken-replacement.csv');
  pending.callback(new Error('synthetic read failure'), null);
  assert.equal(h.state.importStatus.cost, 'failed');
  vm.runInContext('processImport()', h.ctx);
  assertImportStateUnchanged(h, before);
  assert.equal(h.state.costRows[0].UnitCost, '1111');
});

check('cost extension/read failures and cancellation expose removal without changing saved costs or preset', () => {
  for (const failure of ['extension', 'read', 'cancel']) {
    const h = makeHarness(); installFileFlow(h);
    const before = snapshotImportState(h);
    if (failure === 'extension') {
      vm.runInContext("importFile('cost',{name:'synthetic-costs.txt'})", h.ctx);
    } else if (failure === 'read') {
      const pending = startSyntheticRead(h, 'cost', 'synthetic-costs.csv');
      pending.callback(new Error('synthetic parser failure'), null);
    } else {
      vm.runInContext("importFile('cost',null)", h.ctx);
    }
    assert.ok(['failed', 'cancelled'].includes(h.state.importStatus.cost));
    clickCostRemove(h);
    assert.equal(h.state.importStatus.cost, 'idle');
    assert.equal(h.state.costWorkbook, null); assert.equal(h.state.costSource, 'none');
    assert.equal(h.elements.get('#costFile').value, '');
    assertImportStateUnchanged(h, before);
  }
});

check('removing a cost file while reading invalidates its delayed callback', () => {
  const h = makeHarness(); installFileFlow(h);
  const before = snapshotImportState(h);
  const pending = startSyntheticRead(h, 'cost', 'slow-synthetic-costs.csv');
  const generation = h.state.importGeneration.cost;
  assert.equal(h.state.importStatus.cost, 'reading');
  clickCostRemove(h);
  assert.equal(h.state.importStatus.cost, 'idle');
  assert.ok(h.state.importGeneration.cost > generation);
  assert.equal(h.elements.get('#costFile').value, '');
  pending.callback(null, { SheetNames: ['Late workbook'], syntheticHeaders: ['Product', 'SKU', 'UnitCost'],
    syntheticRows: [{ Product: 'Late item', SKU: 'CP-001', UnitCost: '7777' }] });
  assert.equal(h.state.importStatus.cost, 'idle');
  assert.equal(h.state.costWorkbook, null); assert.equal(h.state.costSource, 'none');
  assert.equal(h.state.costRows.length, 0);
  assertImportStateUnchanged(h, before);
});

check('removing failed optional costs allows sales-only analysis and preserves saved values', () => {
  const h = makeHarness(); installFileFlow(h);
  const salesMap = { product: 'Product', sku: 'SKU', revenue: 'Revenue' };
  h.storage.set(PRESET_KEY, JSON.stringify(salesMap));
  const beforeCosts = h.storage.get(COST_KEY); const beforePreset = h.storage.get(PRESET_KEY);
  const pending = startSyntheticRead(h, 'cost', 'failed-synthetic-costs.csv');
  pending.callback(new Error('synthetic parser failure'), null);
  clickCostRemove(h);
  assert.equal(h.storage.get(COST_KEY), beforeCosts);
  assert.equal(h.storage.get(PRESET_KEY), beforePreset);
  seedActualSales(h); h.state.salesMap = { ...salesMap };
  vm.runInContext('processImport()', h.ctx);
  assert.equal(h.state.isDemo, false);
  assert.equal(h.state.transactions[0].product, 'Actual synthetic product');
  assert.equal(h.state.importStatus.cost, 'idle');
  assert.equal(h.state.costWorkbook, null); assert.equal(h.state.costRows.length, 0);
  assert.equal(h.storage.get(COST_KEY), beforeCosts);
  assert.equal(h.storage.get(PRESET_KEY), beforePreset);
  assert.equal(h.storageOps.some(([op, key]) => key === COST_KEY), false);
});

check('header-only selected cost file fails without exiting demo or changing saved state', () => {
  const h = makeHarness(); installFileFlow(h); seedActualSales(h);
  const pending = startSyntheticRead(h, 'cost', 'header-only-costs.csv');
  completeSyntheticRead(pending, ['Product', 'SKU', 'UnitCost'], []);
  assert.equal(h.state.importStatus.cost, 'ready');
  assert.equal(h.state.costRows.length, 0);
  const before = snapshotImportState(h);
  vm.runInContext('processImport()', h.ctx);
  assertImportStateUnchanged(h, before);
});

check('empty actual sales file fails without changing demo transactions, costs, or storage', () => {
  const h = makeHarness(); installFileFlow(h); seedActualSales(h);
  h.state.salesRows = [];
  const before = snapshotImportState(h);
  vm.runInContext('processImport()', h.ctx);
  assertImportStateUnchanged(h, before);
});

check('actual sales import with no cost file selected still exits demo normally', () => {
  const h = makeHarness(); installFileFlow(h); seedActualSales(h);
  const beforeCostKey = h.storage.get(COST_KEY);
  vm.runInContext('processImport()', h.ctx);
  assert.equal(h.state.isDemo, false);
  assert.equal(h.state.transactions[0].product, 'Actual synthetic product');
  assert.equal(h.state.costs.get('sku:CP-001').unitCost, 12345);
  assert.equal(h.storage.get(COST_KEY), beforeCostKey);
  assert.equal(h.storageOps.some(([op, key]) => key === COST_KEY), false);
});

check('entering and re-entering demo clears stale costs and keeps saved real data', () => {
  const h = makeHarness({ isDemo: false });
  h.state.costWorkbook = { SheetNames: ['Old'] }; h.state.costSource = 'file';
  h.state.costRows = [{ Product: 'Stale', UnitCost: '999' }]; h.state.costHeaders = ['Product', 'UnitCost'];
  h.state.costMap = { product: 'Product', unitCost: 'UnitCost' }; h.state.costSheetName = 'Old';
  h.state.costs = new Map([['sku:CP-001', { product: 'Real', sku: 'CP-001', unitCost: 12345 }]]);
  install(h, 'loadCosts', 'saveCosts', 'parseNum', 'norm', 'ingestSales', 'invalidate', 'loadDemo');
  vm.runInContext('loadDemo()', h.ctx);
  assert.equal(h.state.isDemo, true); assert.equal(h.state.costSource, 'demo');
  assert.equal(h.state.costWorkbook, null); assert.equal(h.state.costRows.length, 0); assert.equal(h.state.costHeaders.length, 0);
  assert.equal(Object.keys(h.state.costMap).length, 0); assert.equal(h.state.costSheetName, '');
  const persisted = h.storage.get(COST_KEY); assert.ok(persisted);
  h.state.costs.set('sku:CP-001', { product: 'Changed demo', sku: 'CP-001', unitCost: 1 });
  const opsBeforeReentry = h.storageOps.length;
  vm.runInContext('loadDemo()', h.ctx);
  assert.equal(h.state.isDemo, true); assert.equal(h.storage.get(COST_KEY), persisted);
  assert.equal(h.storageOps.length, opsBeforeReentry);
  assert.equal(h.state.costs.get('sku:CP-001').unitCost, 9200);
  h.state.isDemo = false;
  h.state.costs = new Map([['sku:CP-001', { product: 'New actual', sku: 'CP-001', unitCost: 2222 }]]);
  vm.runInContext('loadDemo()', h.ctx);
  assert.equal(h.state.isDemo, true); assert.equal(h.state.costs.get('sku:CP-001').unitCost, 9200);
  assert.equal(vm.runInContext('loadCostsFromStorage()', h.ctx).get('sku:CP-001').unitCost, 2222);
});

check('refresh during demo reloads saved real costs and does not persist demo edits', () => {
  const active = makeHarness(); install(active, 'saveCosts', 'parseNum', 'setCost');
  vm.runInContext("setCost({product:'Demo edit',sku:'CP-001'},'1')", active.ctx);
  assert.equal(active.storage.get(COST_KEY), active.baselineCosts);
  const refreshed = makeHarness({ isDemo: false }); install(refreshed, 'loadCosts');
  refreshed.state.costs = vm.runInContext('loadCostsFromStorage()', refreshed.ctx);
  assert.equal(refreshed.state.isDemo, false);
  assert.equal(refreshed.state.costs.get('sku:CP-001').unitCost, 12345);
});

check('demo mapping edits do not persist preset; successful actual analysis saves it', () => {
  const h = makeHarness();
  const select = { dataset: { mapType: 'sales', mapKey: 'product' }, value: 'SampleProduct', listener: null,
    addEventListener(event, fn) { this.listener = fn; } };
  h.selects.push(select); h.state.salesSource = 'file'; h.state.salesMap = { product: 'Product', revenue: 'Revenue' };
  install(h, 'savePreset', 'renderMappings');
  const originalPreset = h.storage.get(PRESET_KEY);
  vm.runInContext("renderMappings('salesMappings',['Product','Revenue'],[{key:'product',label:'Product',required:true}],state.salesMap)", h.ctx);
  select.listener(); assert.equal(h.storage.get(PRESET_KEY), originalPreset);
  h.selects.length = 0;
  install(h, 'loadCosts', 'saveCosts', 'parseNum', 'norm', 'ingestSales', 'invalidate', 'processImport');
  seedActualSales(h); vm.runInContext('processImport()', h.ctx);
  assert.equal(h.state.isDemo, false); assert.notEqual(h.storage.get(PRESET_KEY), originalPreset);
});

check('cancel invalidates delayed read and Analyze stays blocked immediately afterward', () => {
  const h = makeHarness();
  install(h, 'loadCosts', 'saveCosts', 'parseNum', 'norm', 'ingestSales', 'ingestCosts', 'invalidate', 'importFile', 'processImport');
  seedActualSales(h);
  const before = snapshotImportState(h);
  h.ctx.setWorkbook = () => { throw new Error('stale callback must not call setWorkbook'); };
  vm.runInContext(source.cancelHandler, h.ctx);
  const pending = startSyntheticRead(h, 'cost', 'synthetic-costs.csv');
  assert.equal(h.state.importStatus.cost, 'reading');
  h.elements.get('#btnCancelImport').onclick();
  assert.equal(h.state.importStatus.cost, 'cancelled');
  pending.callback(null, { SheetNames: ['Synthetic'] });
  vm.runInContext('processImport()', h.ctx);
  assertImportStateUnchanged(h, before);
  assert.equal(h.state.costWorkbook, null); assert.equal(h.state.costSource, 'none');
});

check('switching into demo invalidates a delayed real-file read', () => {
  const h = makeHarness({ isDemo: false }); install(h, 'loadCosts', 'saveCosts', 'parseNum', 'norm', 'ingestSales', 'invalidate', 'loadDemo', 'importFile');
  h.state.costs = vm.runInContext('loadCostsFromStorage()', h.ctx);
  h.ctx.setWorkbook = () => { throw new Error('stale callback must not install after demo entry'); };
  vm.runInContext("importFile('cost',{name:'synthetic-costs.csv'})", h.ctx);
  const pending = h.pendingReads[0];
  vm.runInContext('loadDemo()', h.ctx);
  pending.callback(null, { SheetNames: ['Synthetic costs'] });
  assert.equal(h.state.isDemo, true); assert.equal(h.state.costSource, 'demo');
  assert.equal(h.state.costWorkbook, null); assert.equal(h.state.costRows.length, 0);
});

check('valid actual sales and cost files transition only after both parse; colliding SKU commits actual cost', () => {
  const h = makeHarness(); install(h, 'loadCosts', 'saveCosts', 'savePreset', 'parseNum', 'norm', 'ingestSales', 'ingestCosts', 'invalidate', 'updateFileStatus', 'loadSheet', 'setWorkbook', 'importFile', 'processImport');
  h.ctx.syntheticSalesFile = { name: 'synthetic-sales.csv' };
  h.ctx.syntheticCostFile = { name: 'synthetic-costs.csv' };
  vm.runInContext("importFile('sales', syntheticSalesFile)", h.ctx);
  h.pendingReads.shift().callback(null, {
    SheetNames: ['Synthetic sales'], syntheticHeaders: ['Product', 'SKU', 'Revenue'],
    syntheticRows: [{ Product: 'Actual synthetic product', SKU: 'CP-001', Revenue: '100' }]
  });
  assert.equal(h.state.salesSource, 'file');
  vm.runInContext("importFile('cost', syntheticCostFile)", h.ctx);
  h.pendingReads.shift().callback(null, {
    SheetNames: ['Synthetic costs'], syntheticHeaders: ['Product', 'SKU', 'UnitCost'],
    syntheticRows: [{ Product: 'Actual synthetic product', SKU: 'CP-001', UnitCost: '33333' }]
  });
  assert.equal(h.state.costSource, 'file');
  vm.runInContext('processImport()', h.ctx);
  assert.equal(h.state.isDemo, false); assert.equal(h.state.transactions[0].product, 'Actual synthetic product');
  assert.equal(h.state.costs.get('sku:CP-001').unitCost, 33333);
  const saved = vm.runInContext('loadCostsFromStorage()', h.ctx);
  assert.equal(saved.get('sku:CP-001').unitCost, 33333);
});

check('normal real-mode cost edit still saves to the existing storage key', () => {
  const h = makeHarness({ isDemo: false }); install(h, 'loadCosts', 'saveCosts', 'parseNum', 'setCost');
  vm.runInContext("setCost({product:'Actual synthetic product',sku:'CP-001'},'8888')", h.ctx);
  assert.equal(h.state.costs.get('sku:CP-001').unitCost, 8888);
  assert.equal(vm.runInContext('loadCostsFromStorage()', h.ctx).get('sku:CP-001').unitCost, 8888);
  assert.equal(h.storageOps.filter(([op, key]) => op === 'set' && key === COST_KEY).length, 1);
});

check('demo reset still exits without deleting real costs; real F19 reset still removes the key', () => {
  const demo = makeHarness(); install(demo, 'loadCosts', 'invalidate', 'resetHandler');
  vm.runInContext(source.resetHandler, demo.ctx); demo.elements.get('#btnReset').onclick();
  assert.equal(demo.state.isDemo, false); assert.equal(demo.storage.get(COST_KEY), demo.baselineCosts);
  assert.equal(demo.state.costs.get('sku:CP-001').unitCost, 12345);
  const real = makeHarness({ isDemo: false }); install(real, 'loadCosts', 'invalidate', 'resetHandler');
  vm.runInContext(source.resetHandler, real.ctx); real.elements.get('#btnReset').onclick();
  assert.equal(real.storage.has(COST_KEY), false); assert.equal(real.state.costs.size, 0);
});

check('failed ordinary cost save preserves prior register and never reports success', () => {
  const h=makeHarness({isDemo:false});install(h,'loadCosts','saveCosts','parseNum','setCost');
  const before=snapshotImportState(h);h.ctx.localStorage.setItem=()=>{throw Error('quota');};
  assert.equal(vm.runInContext("setCost({product:'Actual',sku:'CP-001'},'8888')",h.ctx),false);
  assertImportStateUnchanged(h,before);assert.match(h.toastLog.at(-1),/저장하지 못/);
});
check('failed candidate deletion cannot remove an existing cost in memory', () => {
  const h=makeHarness({isDemo:false});install(h,'saveCosts');const before=snapshotImportState(h);
  h.ctx.localStorage.setItem=()=>{throw Error('quota');};
  assert.equal(vm.runInContext("commitCosts(new Map())",h.ctx),false);assertImportStateUnchanged(h,before);
});
check('failed imported cost persistence leaves demo and sales transactions unchanged', () => {
  const h=makeHarness();installFileFlow(h);seedActualSales(h);
  completeSyntheticRead(startSyntheticRead(h,'cost','costs.csv'),['Product','SKU','UnitCost'],[{Product:'new',SKU:'NEW',UnitCost:10}]);
  const before=snapshotImportState(h);h.ctx.localStorage.setItem=()=>{throw Error('quota');};
  vm.runInContext('processImport()',h.ctx);assertImportStateUnchanged(h,before);assert.match(h.toastLog.at(-1),/저장하지 못/);
});
check('manual add modal stays open and preserves costs when storage fails', () => {
  const h=makeHarness({isDemo:false});install(h,'saveCosts','parseNum','norm');let closed=false;
  h.ctx.closeAddProductModal=()=>{closed=true;};h.ctx.$('#newProdName').value='new';h.ctx.$('#newProdSku').value='NEW';h.ctx.$('#newProdCost').value='50';
  h.ctx.localStorage.setItem=()=>{throw Error('quota');};const before=snapshotImportState(h);
  vm.runInContext(between('function saveNewProduct() {','// --- Event Listeners & Bindings ---'),h.ctx);
  vm.runInContext('saveNewProduct()',h.ctx);assertImportStateUnchanged(h,before);assert.equal(closed,false);assert.match(h.toastLog.at(-1),/저장하지 못/);
});

check('failed demo flush leaves an in-flight import generation and status intact', () => {
  const h=makeHarness({isDemo:false});installFileFlow(h);install(h,'loadDemo');
  const pending=startSyntheticRead(h,'cost','pending.csv');const generation=h.state.importGeneration.cost;
  h.ctx.localStorage.setItem=()=>{throw Error('quota');};vm.runInContext('loadDemo()',h.ctx);
  assert.equal(h.state.isDemo,false);assert.equal(h.state.importGeneration.cost,generation);
  completeSyntheticRead(pending,['Product','SKU','UnitCost'],[{Product:'new',SKU:'NEW',UnitCost:10}]);
  assert.equal(h.state.importStatus.cost,'ready');assert.ok(h.state.costWorkbook);
});

check('stale real-tab edits preserve a newer persisted register', () => {
  const h=makeHarness({isDemo:false});install(h,'loadCosts','saveCosts','parseNum','setCost');
  const newer=JSON.stringify([...JSON.parse(h.storage.get(COST_KEY)),['sku:NEW',{product:'new tab',sku:'NEW',unitCost:77}]]);
  h.storage.set(COST_KEY,newer);const before=h.state.costs;
  assert.equal(vm.runInContext("setCost({product:'Actual',sku:'CP-001'},'8888')",h.ctx),false);
  assert.equal(h.storage.get(COST_KEY),newer);assert.equal(h.state.costs,before);assert.match(h.toastLog.at(-1),/다른 탭/);
});
check('entering Demo never flushes stale memory over newer persisted costs', () => {
  const h=makeHarness({isDemo:false});installFileFlow(h);install(h,'loadDemo');
  const newer=JSON.stringify([...JSON.parse(h.storage.get(COST_KEY)),['sku:NEW',{product:'new tab',sku:'NEW',unitCost:77}]]);h.storage.set(COST_KEY,newer);
  vm.runInContext('loadDemo()',h.ctx);assert.equal(h.state.isDemo,false);assert.equal(h.storage.get(COST_KEY),newer);assert.equal(h.storageOps.length,0);
});
check('malformed saved JSON blocks ordinary save and Demo without overwriting original bytes', () => {
  const h=makeHarness({isDemo:false});installFileFlow(h);install(h,'loadDemo','setCost');h.storage.set(COST_KEY,'{corrupt original');
  h.state.costs=vm.runInContext('loadCostsFromStorage()',h.ctx);assert.equal(h.state.costs.size,0);
  assert.equal(vm.runInContext("setCost({product:'New',sku:'NEW'},'10')",h.ctx),false);vm.runInContext('loadDemo()',h.ctx);
  assert.equal(h.storage.get(COST_KEY),'{corrupt original');assert.equal(h.state.isDemo,false);assert.equal(h.storageOps.length,0);
});
check('partly invalid or duplicate saved registers block writes instead of silently dropping records', () => {
  for(const raw of [JSON.stringify([storageBaseCosts[0],['sku:BAD',{product:'bad',sku:'BAD',unitCost:-1}]]),JSON.stringify([storageBaseCosts[0],storageBaseCosts[0]])]) {
    const h=makeHarness({isDemo:false});install(h,'loadCosts','saveCosts');h.storage.set(COST_KEY,raw);h.state.costs=vm.runInContext('loadCostsFromStorage()',h.ctx);
    assert.equal(vm.runInContext('saveCostsToStorage()',h.ctx),false);assert.equal(h.storage.get(COST_KEY),raw);assert.equal(h.storageOps.length,0);
  }
});
check('failed real reset preserves memory, analysis, pending reads and stored costs', () => {
  const h=makeHarness({isDemo:false});install(h,'loadCosts','invalidate','resetHandler');vm.runInContext(source.resetHandler,h.ctx);
  const before=snapshotImportState(h);h.ctx.localStorage.removeItem=()=>{throw Error('SecurityError');};const generation=JSON.stringify(h.state.importGeneration);
  h.elements.get('#btnReset').onclick();assertImportStateUnchanged(h,before);assert.equal(JSON.stringify(h.state.importGeneration),generation);assert.match(h.toastLog.at(-1),/초기화하지 못/);
});
check('stale real reset cannot delete changes made in another tab', () => {
  const h=makeHarness({isDemo:false});install(h,'loadCosts','invalidate','resetHandler');vm.runInContext(source.resetHandler,h.ctx);h.storage.set(COST_KEY,'newer raw');
  h.elements.get('#btnReset').onclick();assert.equal(h.storage.get(COST_KEY),'newer raw');assert.equal(h.storageOps.length,0);
});
check('confirmed recovery reset clears malformed original only after explicit action', () => {
  const h=makeHarness({isDemo:false});install(h,'loadCosts','invalidate','resetHandler');h.storage.set(COST_KEY,'{corrupt');h.state.costs=vm.runInContext('loadCostsFromStorage()',h.ctx);vm.runInContext(source.resetHandler,h.ctx);
  h.elements.get('#btnReset').onclick();assert.equal(h.storage.has(COST_KEY),false);assert.equal(h.ctx.loadCostsFromStorage.blocked,false);assert.equal(h.state.costs.size,0);
});
check('secondary mapping reset failure is disclosed rather than claiming all settings cleared', () => {
  const h=makeHarness({isDemo:false});install(h,'loadCosts','invalidate','resetHandler');vm.runInContext(source.resetHandler,h.ctx);const originalRemove=h.ctx.localStorage.removeItem;
  h.ctx.localStorage.removeItem=key=>{if(key===PRESET_KEY)throw Error('preset denied');originalRemove(key);};
  h.elements.get('#btnReset').onclick();assert.equal(h.storage.has(COST_KEY),false);assert.equal(h.storage.has(PRESET_KEY),true);assert.match(h.toastLog.at(-1),/매핑 설정은 삭제하지 못/);
});

check('oversized derived shared-cost import is rejected before mode, transaction or storage mutation', () => {
  const h=makeHarness();installFileFlow(h);seedActualSales(h);h.state.salesRows=Array.from({length:400},(_,i)=>({Product:'Shared',SKU:'S'+i,Revenue:'1'}));
  const tiny='0.'+'0'.repeat(9997)+'1';h.storage.set(COST_KEY,JSON.stringify([['name:shared',{product:'Shared',sku:'',unitCost:0,unitCostExact:tiny}]]));
  const before=snapshotImportState(h);vm.runInContext('processImport()',h.ctx);assertImportStateUnchanged(h,before);assert.match(h.toastLog.at(-1),/계산 결과/);
});

console.log(`SUMMARY pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
