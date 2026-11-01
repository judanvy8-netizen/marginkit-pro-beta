(() => {
'use strict';
if (!globalThis.MKDecimal) {
  document.body.textContent = '정확한 소수 계산 모듈을 사용할 수 없습니다. BigInt를 지원하는 최신 브라우저에서 다시 열어 주세요.';
  return;
}

const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];

// --- Local Storage Management ---
const STORAGE_KEY_COSTS = 'marginkit_costs_v2';
const STORAGE_KEY_PRESET = 'marginkit_map_preset_v2';

function loadCostsFromStorage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_COSTS);
    loadCostsFromStorage.revision = saved;
    loadCostsFromStorage.initialized = true;
    loadCostsFromStorage.blocked = false;
    if (saved !== null) {
      const arr = JSON.parse(saved);
      if (!Array.isArray(arr) || !arr.every(entry => Array.isArray(entry) && entry.length === 2 &&
        typeof entry[0] === 'string' && entry[1] && typeof entry[1].product === 'string' &&
        typeof entry[1].sku === 'string' && Number.isFinite(entry[1].unitCost) && entry[1].unitCost >= 0 && entry[1].unitCost <= 1e12 && validCostPrecision(entry[1])) ||
        new Set(arr.map(entry => entry[0])).size !== arr.length ||
        !withinDecimalBudget(arr.map(entry => entry[1]), ['unitCost', 'unitCostExact'])) {
        throw new Error('Invalid saved cost register');
      }
      return new Map(arr);
    }
  } catch (error) {
    loadCostsFromStorage.blocked = true;
    console.error('Failed to load costs from localStorage', error);
  }
  return new Map();
}

function checkCostStorageRevision(allowRecoveryReset = false) {
  if (!loadCostsFromStorage.initialized || (loadCostsFromStorage.blocked && !allowRecoveryReset)) {
    throw new Error('저장된 원가를 안전하게 읽지 못했습니다. 원본은 보존 중이며 덮어쓰기를 중지했습니다.');
  }
  if (localStorage.getItem(STORAGE_KEY_COSTS) !== loadCostsFromStorage.revision) {
    throw new Error('다른 탭에서 원가가 변경되었습니다. 현재 원본을 덮어쓰지 않습니다. 새로고침 후 다시 시도해 주세요.');
  }
}

function saveCostsToStorage() {
  return persistCosts(state.costs, state.isDemo);
}

function persistCosts(costs, isDemo) {
  // Preserve legacy oversized registers; only explicit deletion-only reductions
  // may remain above the restore limit. Never truncate or silently edit them.
  if (costs.size > 20000 && !(costs.size < state.costs.size &&
      [...costs].every(([key, value]) => state.costs.get(key) === value))) {
    toast('등록 원가는 최대 20,000개입니다. 기존 원가는 유지됩니다. 초과한 기존 원가표는 먼저 JSON으로 백업한 뒤 불필요한 항목만 삭제해 주세요.');
    return false;
  }
  if (!withinDecimalBudget([...costs.values()], ['unitCost', 'unitCostExact'])) {
    toast('원가 숫자 데이터가 처리 한도를 초과했습니다. 원가표를 작게 나누어 주세요. 기존 원가는 유지됩니다.');
    return false;
  }
  if (isDemo) return true;
  try {
    checkCostStorageRevision();
    const serialized = JSON.stringify([...costs.entries()]);
    localStorage.setItem(STORAGE_KEY_COSTS, serialized);
    loadCostsFromStorage.revision = serialized;
    return true;
  } catch (error) {
    console.error('Failed to save costs to localStorage', error);
    toast('원가를 저장하지 못했습니다. 기존 원가는 유지됩니다. ' + (error.message || '저장 공간·브라우저 설정을 확인해 주세요.'));
    return false;
  }
}

function calculationWithinBudget(transactions, costs) {
  const groups = new Map();
  const bounds = value => {
    const text = typeof value === 'number' ? MKDecimal.normalize(value) : String(value ?? '0');
    const parts = text.replace(/^-/, '').split('.');
    return { integer: parts[0].length, scale: (parts[1] || '').length };
  };
  for (const row of transactions) {
    const key = row.sku ? `sku:${row.sku}` : `name:${norm(row.product)}`;
    let group = groups.get(key);
    if (!group) { group = { product: row.product, sku: row.sku, count: 0, integer: 1, scale: 0 }; groups.set(key, group); }
    group.count++;
    for (const field of ['qty', 'revenue', 'commission', 'shipping', 'ads', 'refunds', 'other']) {
      const size = bounds(row.exact?.[field] ?? row[field] ?? '0');
      group.integer = Math.max(group.integer, size.integer);
      group.scale = Math.max(group.scale, size.scale);
    }
  }
  let projected = 0;
  for (const group of groups.values()) {
    const cost = (group.sku ? costs.get(`sku:${group.sku}`) : null) || costs.get(`name:${norm(group.product)}`);
    const rawLength = group.integer + group.scale + 2 + String(group.count).length - 1;
    const costSize = cost ? bounds(cost.unitCostExact ?? cost.unitCost) : { integer: 1, scale: 0 };
    const derivedLength = Math.max(rawLength, rawLength + costSize.integer + costSize.scale + 2);
    // Bound expanded per-product amounts, not merely the source file size.
    projected += 8 * rawLength + 4 * derivedLength + 50;
    if (projected > 8000000) return false;
  }
  return true;
}

function commitCosts(nextCosts) {
  if (!calculationWithinBudget(state.transactions || [], nextCosts)) { toast('계산 결과의 숫자 데이터가 처리 한도를 초과합니다. 분석 파일을 작게 나누어 주세요. 기존 원가는 유지됩니다.'); return false; }
  if (!persistCosts(nextCosts, state.isDemo)) return false;
  state.costs = nextCosts;
  return true;
}

function restoreCostsFromStorage() {
  state.costs = loadCostsFromStorage();
}

function invalidateImportReads(type) {
  if (!state.importGeneration) state.importGeneration = { sales: 0, cost: 0 };
  for (const key of (type ? [type] : ['sales', 'cost'])) {
    state.importGeneration[key] = (state.importGeneration[key] || 0) + 1;
    if (typeof state.importCancel?.[key] === 'function') state.importCancel[key]();
    if (state.importCancel) state.importCancel[key] = null;
  }
}

function exitDemoMode() {
  if (!state.isDemo) return;
  state.isDemo = false;
  restoreCostsFromStorage();
}

function saveMappingPreset(map) {
  try {
    localStorage.setItem(STORAGE_KEY_PRESET, JSON.stringify(map));
  } catch(e) {}
}

function loadMappingPreset() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_PRESET);
    const parsed = saved ? JSON.parse(saved) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch(e) {
    return {};
  }
}

// --- Application State ---
const state = {
  salesWorkbook: null,
  costWorkbook: null,
  salesSource: 'none',
  costSource: 'none',
  importGeneration: { sales: 0, cost: 0 },
  importStatus: { sales: 'idle', cost: 'idle' },
  salesFileName: '',
  costFileName: '',
  salesRows: [],
  costRows: [],
  salesHeaders: [],
  costHeaders: [],
  salesSheetName: '',
  costSheetName: '',
  salesMap: {},
  costMap: {},
  transactions: [],
  products: [],
  costs: loadCostsFromStorage(),
  isDemo: false,
  filter: 'all',
  activeTab: 'dashboard',
  chartMetric: 'revenue', // 'revenue' | 'profit'
  sortColumn: 'revenue',
  sortAsc: false
};

// --- Field Definitions & Aliases for Korean E-Commerce ---
const fieldDefs = [
  {
    key: 'product',
    label: '상품명 / 옵션정보',
    required: true,
    aliases: [
      '상품명', '상품 이름', '제품명', '옵션정보', '주문상품명', '노출상품명', '등록상품명',
      'item name', 'product name', 'product', 'item', '상품', '상품/옵션정보'
    ]
  },
  {
    key: 'sku',
    label: '상품 코드 / SKU / 옵션코드',
    aliases: [
      '상품코드', '상품 코드', '옵션코드', '옵션 코드', '판매자상품코드', '옵션관리코드',
      '자체상품코드', '바코드', '노출상품id', '옵션id', 'sku', 'item code', 'product code', '상품번호'
    ]
  },
  {
    key: 'revenue',
    label: '상품 매출액 (환불 차감 전)',
    required: true,
    aliases: [
      '상품매출', '상품 매출', '판매금액', '판매 금액', '주문금액', '주문 금액', '결제금액',
      '결제 금액', '매출액', '매출', '정산대상금액', '결제완료금액', '총결제금액', 'sales', 'revenue', 'gross sales'
    ]
  },
  {
    key: 'qty',
    label: '판매 수량',
    aliases: [
      '판매수량', '판매 수량', '수량', '주문수량', '주문 수량', '구매수량', '결제수량',
      'quantity', 'qty', '수량합계'
    ]
  },
  {
    key: 'commission',
    label: '판매 수수료 / 이용료',
    aliases: [
      '판매수수료', '판매 수수료', '수수료', '네이버페이 주문관리 수수료', '매출연동수수료',
      '중개수수료', '서비스이용료', '카테고리수수료', '결제수수료', 'commission', 'fee'
    ]
  },
  {
    key: 'shipping',
    label: '판매자 부담 배송비',
    aliases: [
      '배송비', '판매자배송비', '판매자 부담 배송비', '출고배송비', '정산배송비',
      '배송비정산액', 'shipping', 'shipping fee'
    ]
  },
  {
    key: 'ads',
    label: '광고비 / 마케팅비',
    aliases: [
      '광고비', '광고비용', '마케팅비', 'cpc', '쇼핑검색광고', '매출최적화광고', 'ads', 'ad cost'
    ]
  },
  {
    key: 'refunds',
    label: '환불·취소 조정액 (양수)',
    aliases: [
      '환불금액', '환불 금액', '취소금액', '취소 금액', '취소완료금액', '반품금액',
      '환불/취소', '환불액', '환불 조정액', 'refund', 'refund amount'
    ]
  },
  {
    key: 'other',
    label: '기타 공제 / 프로모션 부담금',
    aliases: [
      '기타비용', '기타 비용', '추가비용', '프로모션할인', '쿠폰할인부담금', '정산차감액',
      '패널티', 'other fee', 'other cost'
    ]
  }
];

const costFieldDefs = [
  {
    key: 'product',
    label: '상품명',
    required: true,
    aliases: ['상품명', '상품 이름', '제품명', 'product', 'item name', '상품']
  },
  {
    key: 'sku',
    label: '상품 코드 / SKU',
    aliases: ['상품코드', '상품 코드', '옵션코드', '옵션 코드', 'sku', 'item code', 'product code', '판매자상품코드']
  },
  {
    key: 'unitCost',
    label: '단위당 매입 원가 (₩)',
    required: true,
    aliases: [
      '매입원가', '매입 원가', '원가', '상품원가', '상품 원가', '단위원가', '단위 원가',
      '단위당 원가', '공급가', '매입가', 'unit cost', 'cost', 'cost price'
    ]
  }
];

// --- Utilities ---
const fmt = (n, decimals=0) => Number.isFinite(Number(n)) ? new Intl.NumberFormat('ko-KR', { maximumFractionDigits: decimals, minimumFractionDigits: decimals }).format(Number(n)) : '—';
const won = n => { try { return n === null || n === undefined ? '—' : '₩' + MKDecimal.format(n); } catch { return '—'; } };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function compactWon(n) {
  n = Number(n) || 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 100000000) return sign + (abs / 100000000).toFixed(1) + '억';
  if (abs >= 10000) return sign + (abs / 10000).toFixed(0) + '만';
  return won(n);
}
function shorten(s, n=10) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

function showModal(title, body) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  $('#modalCustomContent').innerHTML = '';
  $('#modalBackdrop').classList.add('show');
}

function parseNum(v) {
  const exact = MKDecimal.input(v);
  return exact === null ? null : Number(exact);
}

// Bound synchronous decimal work without rounding normal decimal inputs.
function withinDecimalBudget(rows, columns) {
  let size = 0;
  for (const row of rows) {
    for (const column of columns) {
      const value = row[column];
      size += String(value ?? '').length;
      if (typeof value === 'number' && Number.isFinite(value) && value !== 0 && Math.abs(value) < 1) {
        size += Math.max(0, -Math.floor(Math.log10(Math.abs(value))));
      }
      if (size > 3000000) return false;
    }
  }
  return true;
}

function makeCostRecord(product, sku, raw) {
  const exact = MKDecimal.input(raw);
  if (exact === null || MKDecimal.compare(exact, '0') < 0) return null;
  const unitCost = Number(exact);
  const record = { product, sku, unitCost };
  if (MKDecimal.normalize(unitCost) !== exact) record.unitCostExact = exact;
  return record;
}

function validCostPrecision(record) {
  if (!Object.prototype.hasOwnProperty.call(record, 'unitCostExact')) return true;
  return typeof record.unitCostExact === 'string' && MKDecimal.input(record.unitCostExact) === record.unitCostExact &&
    MKDecimal.compare(record.unitCostExact, '0') >= 0 && Number(record.unitCostExact) === record.unitCost;
}

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[\s_\-()/·,\[\]]/g, '').trim();
}

function findHeader(headers, aliases) {
  const normalized = headers.map(norm);
  for (const a of aliases) {
    const n = norm(a);
    const i = normalized.indexOf(n);
    if (i >= 0) return headers[i];
  }
  for (const a of aliases) {
    const n = norm(a);
    if (n.length >= 2) {
      const i = normalized.findIndex(h => h.includes(n) || n.includes(h));
      if (i >= 0) return headers[i];
    }
  }
  return '';
}

function detectMaps(headers, defs, savedPreset = {}) {
  const m = {};
  for (const d of defs) {
    if (savedPreset[d.key] && headers.includes(savedPreset[d.key])) {
      m[d.key] = savedPreset[d.key];
    } else {
      m[d.key] = findHeader(headers, d.aliases) || '';
    }
  }
  return m;
}

// --- Encoding-Aware File Reader (Supports UTF-8 and EUC-KR / CP949) ---
function readFile(file, cb) {
  if (file.size > MAX_IMPORT_BYTES) {
    cb(new Error('파일은 10MB 이하로 나누어 업로드해 주세요.'));
    return;
  }
  if (typeof Worker === 'undefined') {
    cb(new Error('안전한 파일 분석을 지원하는 최신 브라우저에서 다시 시도해 주세요.'));
    return;
  }
  let worker, reader, timer, finished = false;
  const cleanup = () => {
    clearTimeout(timer);
    if (reader) {
      reader.onload = reader.onerror = reader.onabort = null;
      if (reader.readyState === 1) reader.abort();
    }
    if (worker) { worker.onmessage = worker.onerror = null; worker.terminate(); }
  };
  const finish = (error, workbook) => {
    if (finished) return;
    finished = true;
    cleanup();
    cb(error, workbook);
  };
  try {
    worker = new Worker('./import-worker.js');
    reader = new FileReader();
    timer = setTimeout(() => finish(new Error('파일 분석이 10초를 초과해 중단되었습니다. 파일을 작게 나누어 주세요.')), 10000);
    worker.onmessage = event => {
      const result = event.data;
      if (result?.ok && result.workbook) finish(null, result.workbook);
      else finish(new Error(result?.error || '파일을 분석하지 못했습니다.'));
    };
    worker.onerror = () => finish(new Error('파일 분석 작업을 시작하지 못했습니다. 새로고침 후 다시 시도해 주세요.'));
    reader.onerror = () => finish(new Error('파일을 읽는 도중 오류가 발생했습니다.'));
    reader.onabort = () => finish(new Error('파일 읽기가 취소되었습니다.'));
    reader.onload = event => {
      try {
        const buffer = event.target.result;
        worker.postMessage({ buffer, name: file.name }, [buffer]);
      } catch (error) { finish(error); }
    };
    reader.readAsArrayBuffer(file);
  } catch (error) { finish(error); }
  return () => { if (!finished) { finished = true; cleanup(); } };
}

// --- Navigation ---
function setPage(name, updateHash = true) {
  const validPages = ['dashboard', 'import', 'products', 'results', 'simulator', 'settlement'];
  if (!validPages.includes(name)) name = 'dashboard';
  if (updateHash && window.location.hash !== '#' + name) history.pushState(null, '', '#' + name);
  $('#demoModeNotice').classList.toggle('hidden', !state.isDemo);
  state.activeTab = name;
  $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
  $$('.nav-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === name));

  if (name === 'dashboard') renderDashboard();
  if (name === 'products') renderProducts();
  if (name === 'results') renderResults();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Data Ingestion & Calculation ---
function ingestSalesRows(rows, map) {
  if (!map.product || !map.revenue) {
    return { ok: false, error: '상품명과 상품 매출 열은 필수입니다.' };
  }

  if (!withinDecimalBudget(rows, ['qty', 'revenue', 'commission', 'shipping', 'ads', 'refunds', 'other'].map(key => map[key]).filter(Boolean))) {
    return { ok: false, error: '숫자 데이터가 처리 한도를 초과했습니다. 파일을 작게 나누어 주세요.' };
  }
  const parsed = [];
  let skipped = 0;
  let rowNumber = 1;

  for (const row of rows) {
    rowNumber++;
    const product = String(row[map.product] ?? '').trim();
    const revenue = parseNum(row[map.revenue]);

    if (!product || revenue === null) {
      skipped++;
      continue;
    }

    const get = k => map[k] ? parseNum(row[map[k]]) : null;
    for (const key of ['qty', 'commission', 'shipping', 'ads', 'refunds', 'other']) {
      if (map[key]) {
        const raw = row[map[key]];
        if (raw !== null && raw !== undefined && String(raw).trim() !== '' && parseNum(raw) === null) {
          return { ok: false, error: rowNumber + '행의 “' + map[key] + '” 값이 올바른 숫자가 아닙니다. 숫자는 절댓값 1조 이하로 입력해 주세요.' };
        }
      }
    }
    const qty = get('qty');
    const exact = {};
    for (const key of ['qty', 'revenue', 'commission', 'shipping', 'ads', 'refunds', 'other']) {
      const value = map[key] ? MKDecimal.input(row[map[key]]) : null;
      exact[key] = value === null ? (key === 'qty' ? '1' : '0') : (['qty', 'revenue'].includes(key) ? value : MKDecimal.abs(value));
    }

    parsed.push({
      product,
      sku: map.sku ? String(row[map.sku] ?? '').trim() : '',
      revenue,
      qty: qty === null ? 1 : qty,
      commission: Math.abs(get('commission') ?? 0),
      shipping: Math.abs(get('shipping') ?? 0),
      ads: Math.abs(get('ads') ?? 0),
      refunds: Math.abs(get('refunds') ?? 0),
      other: Math.abs(get('other') ?? 0),
      exact,
      source: row
    });
  }

  if (!parsed.length) {
    return { ok: false, error: '분석 가능한 행이 없습니다. 상품명 및 매출 열 매핑과 숫자 데이터를 확인하세요.' };
  }

  return { ok: true, rows: parsed, skipped };
}

function ingestCostRows(rows, map, baseCosts = state.costs) {
  if (!map.product || !map.unitCost) {
    return { ok: false, error: '원가 파일에서 상품명과 단위당 매입 원가 열을 지정해 주세요.' };
  }

  if (!withinDecimalBudget(rows, [map.unitCost])) return { ok: false, added: 0, error: '원가 숫자 데이터가 처리 한도를 초과했습니다. 파일을 작게 나누어 주세요.' };
  const costs = new Map(baseCosts);
  let added = 0;
  for (const row of rows) {
    const product = String(row[map.product] ?? '').trim();
    const sku = map.sku ? String(row[map.sku] ?? '').trim() : '';
    const unitCost = parseNum(row[map.unitCost]);

    if (!product || unitCost === null || MKDecimal.compare(MKDecimal.input(row[map.unitCost]), '0') < 0) continue;

    const key = sku ? `sku:${sku}` : `name:${norm(product)}`;
    costs.set(key, makeCostRecord(product, sku, row[map.unitCost]));
    added++;
  }

  if (added > 0) return { ok: true, added, costs };
  return { ok: false, added: 0, costs, error: '원가 파일에서 유효한 상품과 원가를 찾지 못했습니다.' };
}

function getCost(p) {
  let c = p.sku ? state.costs.get(`sku:${p.sku}`) : null;
  if (!c) c = state.costs.get(`name:${norm(p.product)}`);
  return c ?? null;
}

function aggregate() {
  const map = new Map();
  const fields = ['qty', 'revenue', 'commission', 'shipping', 'ads', 'refunds', 'other'];
  for (const t of state.transactions) {
    const key = t.sku ? `sku:${t.sku}` : `name:${norm(t.product)}`;
    if (!map.has(key)) {
      const product = { key, product: t.product, sku: t.sku, rows: 0 };
      for (const field of fields) product[field] = '0';
      map.set(key, product);
    }
    const product = map.get(key);
    for (const field of fields) product[field] = MKDecimal.add(product[field], t.exact?.[field] ?? t[field]);
    product.rows++;
  }
  state.products = [...map.values()].map(p => {
    const c = getCost(p);
    const netRevenue = MKDecimal.sub(p.revenue, p.refunds);
    const fees = ['commission', 'shipping', 'ads', 'other'].reduce((sum, field) => MKDecimal.add(sum, p[field]), '0');
    const unitCost = c ? MKDecimal.normalize(c.unitCostExact ?? c.unitCost) : null;
    const cost = c ? MKDecimal.mul(unitCost, p.qty) : null;
    const profit = cost === null ? null : MKDecimal.sub(MKDecimal.sub(netRevenue, fees), cost);
    const margin = profit !== null && MKDecimal.compare(netRevenue, '0') > 0 ? MKDecimal.percentage(profit, netRevenue) : null;
    const totalCostAndFee = MKDecimal.add(cost ?? '0', fees);
    const roi = profit !== null && MKDecimal.compare(totalCostAndFee, '0') > 0 ? MKDecimal.percentage(profit, totalCostAndFee) : null;
    return { ...p, netRevenue, fees, cost, unitCost, profit, margin, roi, hasCost: !!c };
  });
  return sortProducts(state.products);
}

function sortProducts(products) {
  const col = state.sortColumn;
  const asc = state.sortAsc ? 1 : -1;

  return [...products].sort((a, b) => {
    let va = a[col];
    let vb = b[col];

    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;

    if (['product', 'sku', 'key'].includes(col)) return String(va).localeCompare(String(vb), 'ko') * asc;
    return MKDecimal.compare(va, vb) * asc;
  });
}

function totalUp() {
  const products = aggregate();
  const sum = (list, field) => list.reduce((value, p) => MKDecimal.add(value, p[field] ?? '0'), '0');
  const totalRevenue = sum(products, 'revenue');
  const totalRefunds = sum(products, 'refunds');
  const known = products.filter(p => p.hasCost);
  const profit = sum(known, 'profit');
  const knownRevenue = sum(known, 'netRevenue');
  return { products, totalRevenue, totalRefunds, profit,
    margin: MKDecimal.compare(knownRevenue, '0') > 0 ? MKDecimal.percentage(profit, knownRevenue) : null,
    missing: products.filter(p => !p.hasCost).length, knownCount: known.length,
    qty: sum(products, 'qty'), knownRevenue };
}

function setCost(p, unitCost) {
  const n = parseNum(unitCost);
  if (n === null || MKDecimal.compare(MKDecimal.input(unitCost), '0') < 0) {
    toast('원가는 0 이상의 숫자로 입력해 주세요.');
    return false;
  }
  const key = p.sku ? `sku:${p.sku}` : `name:${norm(p.product)}`;
  const nextCosts = new Map(state.costs);
  nextCosts.set(key, makeCostRecord(p.product, p.sku || '', unitCost));
  return commitCosts(nextCosts);
}

function removeRegisteredCost(key) {
  if (!state.costs.has(key)) {
    toast('이 행은 공통 상품명 원가를 사용합니다. 삭제할 개별 원가는 없습니다. 상품명 기준 원가 행에서 직접 관리해 주세요.');
    return false;
  }
  const nextCosts = new Map(state.costs);
  nextCosts.delete(key);
  return commitCosts(nextCosts);
}

// --- Dashboard Rendering ---
function renderDashboard() {
  const t = totalUp();

  $('#kpiRevenue').textContent = t.products.length ? won(t.totalRevenue) : '—';
  $('#kpiRevenueFoot').textContent = t.products.length ? `${fmt(t.products.length)}개 품목 · ${MKDecimal.format(t.qty)}개 수량` : '분석 데이터 없음';

  $('#kpiProfit').textContent = t.knownCount ? won(t.profit) : '—';
  $('#kpiProfit').className = 'kpi-val ' + (t.knownCount ? (MKDecimal.compare(t.profit, '0') < 0 ? 'negative' : 'positive') : '');
  $('#kpiProfitFoot').textContent = t.knownCount ? `원가 등록 ${fmt(t.knownCount)}개 상품 합산` : '원가가 등록된 상품만 계산';

  $('#kpiMargin').textContent = t.margin === null ? '—' : `${fmt(t.margin, 1)}%`;
  $('#kpiMarginFoot').textContent = t.knownCount ? `원가 등록 상품 매출 기준` : '계산 가능한 상품 없음';

  $('#kpiMissing').textContent = t.products.length ? fmt(t.missing) : '—';
  $('#kpiMissingFoot').textContent = t.products.length ? (t.missing ? `${fmt(t.missing)}개 품목 원가 입력 필요` : '모든 상품에 원가 등록 완료됨') : '원가 입력 필요';

  $('#demoBanner').classList.toggle('hidden', !!(t.products.length && !state.isDemo));

  renderSalesChart(t.products);
  renderInsights(t);
  renderDashTable(t.products);
}

function renderSalesChart(products) {
  const el = $('#salesChart');
  if (!products.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">▥</div><h3>아직 표시할 데이터가 없습니다</h3><p>예시 데이터를 체험하거나 판매 정산 파일을 업로드하세요.</p></div>';
    return;
  }

  const metric = state.chartMetric;
  $('#chartSubText').textContent = metric === 'revenue' ? '매출 상위 상품 최대 6개' : '추정 이익 상위 상품 최대 6개';

  let rows = [...products];
  if (metric === 'revenue') {
    rows = rows.sort((a, b) => MKDecimal.compare(b.revenue, a.revenue)).slice(0, 6);
  } else {
    rows = rows.filter(p => p.hasCost && p.profit !== null).sort((a, b) => MKDecimal.compare(b.profit ?? '0', a.profit ?? '0')).slice(0, 6);
  }

  if (!rows.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">!</div><h3>표시할 상품이 없습니다</h3><p>원가가 등록된 상품이 있어야 이익 차트를 볼 수 있습니다.</p></div>';
    return;
  }

  const max = Math.max(...rows.map(p => Math.abs(metric === 'revenue' ? p.revenue : (p.profit ?? 0))), 1);

  el.innerHTML = `
    <div class="bar-chart">
      ${rows.map(p => {
        const val = metric === 'revenue' ? p.revenue : (p.profit ?? 0);
        const h = Math.max(6, Math.abs(val) / max * 100);
        const isLoss = MKDecimal.compare(val, '0') < 0;
        return `
          <div class="bar-col">
            <div class="bar-value ${isLoss ? 'negative' : ''}">${esc(compactWon(val))}</div>
            <div class="bar-track">
              <div class="bar-fill ${isLoss ? 'bar-loss' : ''}" style="height:${h}%"></div>
            </div>
            <div class="bar-label" title="${esc(p.product)}">${esc(shorten(p.product, 7))}</div>
          </div>
        `;
      }).join('')}
    </div>
    <div class="tiny muted" style="margin-top:12px; display:flex; justify-content:space-between">
      <span>${metric === 'revenue' ? '매출액 기준 (VAT/환불 포함)' : '원가 및 수수료 차감 후 추정 이익'}</span>
      <span style="color:var(--primary); font-weight:700">축·축약 금액은 표시용 근사값</span>
    </div>
  `;
}

function renderInsights(t) {
  const el = $('#insights');
  if (!t.products.length) {
    el.innerHTML = `
      <div class="insight">
        <div class="insight-icon blue">✓</div>
        <div>
          <strong>분석을 시작해 보세요</strong>
          <p>정산 파일을 올리거나 예시 데이터를 불러오면 원가 누락, 손실 품목 등 핵심 수익성 이슈를 진단해 드립니다.</p>
        </div>
      </div>
    `;
    return;
  }

  const arr = [];
  if (t.missing > 0) {
    arr.push(['!', '원가 미등록 상품 확인', `${t.missing}개 품목의 원가가 누락되어 이익 집계에서 제외되었습니다. 원가를 입력해야 전체 순이익이 정확해집니다.`, 'amber']);
  }

  const lossProds = t.products.filter(p => p.hasCost && MKDecimal.compare(p.profit, '0') < 0);
  if (lossProds.length > 0) {
    const totalLoss = lossProds.reduce((s, p) => MKDecimal.add(s, MKDecimal.abs(p.profit)), '0');
    arr.push(['↘', '적자(손실) 판매 품목 주의', `${lossProds.length}개 상품에서 총 ${won(totalLoss)}의 손실이 추정됩니다. 광고비나 과도한 수수료, 매입원가를 재점검하세요.`, 'red']);
  }

  const bestProfit = [...t.products].filter(p => p.hasCost && MKDecimal.compare(p.profit, '0') > 0).sort((a, b) => MKDecimal.compare(b.profit, a.profit))[0];
  if (bestProfit) {
    arr.push(['★', '최대 이익 기여 효자 상품', `[${shorten(bestProfit.product, 12)}]에서 추정 이익 ${won(bestProfit.profit)} (마진율 ${fmt(bestProfit.margin, 1)}%)을 기록했습니다.`, 'green']);
  }

  const refundHeavy = t.products.filter(p => MKDecimal.compare(p.refunds, '0') > 0 && MKDecimal.compare(p.revenue, '0') > 0 && MKDecimal.compare(p.refunds, MKDecimal.mul(p.revenue, '0.1')) > 0);
  if (refundHeavy.length > 0) {
    arr.push(['⟲', '반품·환불 비율 주의 품목', `${refundHeavy.length}개 품목에서 매출의 10%를 초과하는 환불/취소가 감지되었습니다. 품질 및 배송 이슈를 점검하세요.`, 'amber']);
  }

  if (arr.length === 0) {
    arr.push(['✓', '수익성 양호', '모든 상품의 원가가 등록되어 있으며, 적자 상품이 발생하지 않았습니다.', 'green']);
  }

  el.innerHTML = arr.slice(0, 4).map(([ico, title, desc, type]) => `
    <div class="insight">
      <div class="insight-icon ${type}">${ico}</div>
      <div>
        <strong>${esc(title)}</strong>
        <p>${esc(desc)}</p>
      </div>
    </div>
  `).join('');
}

// --- Tables Rendering ---
function renderTableHtml(products, preview = false) {
  if (!products.length) {
    return `
      <div class="empty-state">
        <div class="empty-icon">▤</div>
        <h3>표시할 상품이 없습니다</h3>
        <p>정산 파일을 가져오거나 검색 조건을 변경해 보세요.</p>
      </div>
    `;
  }

  const rows = preview ? products.slice(0, 6) : products;

  const getSortIco = col => {
    if (state.sortColumn !== col) return '<span class="sort-ico">↕</span>';
    return state.sortAsc ? '<span class="sort-ico">▲</span>' : '<span class="sort-ico">▼</span>';
  };

  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th class="sortable ${state.sortColumn==='product'?'sorted':''}" data-sort="product">상품명 / 코드 ${getSortIco('product')}</th>
            <th class="num sortable ${state.sortColumn==='revenue'?'sorted':''}" data-sort="revenue">매출액 ${getSortIco('revenue')}</th>
            <th class="num sortable ${state.sortColumn==='qty'?'sorted':''}" data-sort="qty">판매수량 ${getSortIco('qty')}</th>
            <th class="num sortable ${state.sortColumn==='cost'?'sorted':''}" data-sort="cost">상품 원가 ${getSortIco('cost')}</th>
            <th class="num">플랫폼 수수료·기타</th>
            <th class="num sortable ${state.sortColumn==='profit'?'sorted':''}" data-sort="profit">추정 순이익 ${getSortIco('profit')}</th>
            <th class="num sortable ${state.sortColumn==='margin'?'sorted':''}" data-sort="margin">마진율 ${getSortIco('margin')}</th>
            <th>상태</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(p => `
            <tr>
              <td>
                <span class="product-name" title="${esc(p.product)}">${esc(p.product)}</span>
                ${p.sku ? `<span class="product-code">${esc(p.sku)}</span>` : ''}
              </td>
              <td class="num money">${won(p.revenue)}</td>
              <td class="num money">${MKDecimal.format(p.qty)}</td>
              <td class="num money">${p.cost === null ? '<span class="muted">미등록</span>' : won(p.cost)}</td>
              <td class="num money">${won(MKDecimal.add(p.fees, p.refunds))}</td>
              <td class="num money ${p.profit === null ? '' : (MKDecimal.compare(p.profit, '0') < 0 ? 'negative' : 'positive')}">
                ${p.profit === null ? '—' : won(p.profit)}
              </td>
              <td class="num font-bold ${p.margin === null ? '' : (MKDecimal.compare(p.profit, '0') < 0 ? 'negative' : 'positive')}">
                ${p.margin === null ? '—' : `${fmt(p.margin, 1)}%`}
              </td>
              <td>
                ${p.hasCost
                  ? (MKDecimal.compare(p.profit, '0') < 0 ? '<span class="status-chip chip-red">손실 (적자)</span>' : '<span class="status-chip chip-green">정상 마진</span>')
                  : '<span class="status-chip chip-amber">원가 입력필요</span>'
                }
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function bindTableSortEvents(container) {
  $$('.sortable', container).forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (state.sortColumn === col) {
        state.sortAsc = !state.sortAsc;
      } else {
        state.sortColumn = col;
        state.sortAsc = false;
      }
      if (state.activeTab === 'results') renderResults();
      if (state.activeTab === 'dashboard') renderDashboard();
    });
  });
}

function renderDashTable(products) {
  const container = $('#dashTable');
  if (!products.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">▤</div>
        <h3>분석 결과가 아직 없습니다</h3>
        <p>첫 번째 정산 파일을 업로드하거나 예시 데이터로 기능을 체험해 보세요.</p>
        <button class="btn btn-primary" id="btnDemo2">예시 데이터 불러오기</button>
      </div>
    `;
    if ($('#btnDemo2')) $('#btnDemo2').onclick = loadDemo;
    return;
  }
  container.innerHTML = renderTableHtml(products, true);
  bindTableSortEvents(container);
}

// --- Products Cost Management Page ---
function renderProducts() {
  const t = totalUp();
  const search = norm($('#productSearch').value || '');
  $('#costCountWarning').classList.toggle('hidden', state.costs.size <= 20000);
  $('#costStorageWarning').classList.toggle('hidden', !loadCostsFromStorage.blocked);
  $('#btnExportStoredCostRaw').disabled = typeof loadCostsFromStorage.revision !== 'string';

  const allProductKeys = new Set();
  const combinedList = [];

  for (const p of t.products) {
    allProductKeys.add(p.key);
    combinedList.push({
      key: p.key,
      product: p.product,
      sku: p.sku,
      qty: p.qty,
      unitCost: p.unitCost,
      cost: p.cost,
      hasCost: p.hasCost,
      isFromSales: true
    });
  }

  for (const [key, c] of state.costs.entries()) {
    if (!allProductKeys.has(key)) {
      allProductKeys.add(key);
      combinedList.push({
        key,
        product: c.product,
        sku: c.sku,
        qty: 0,
        unitCost: c.unitCostExact ?? c.unitCost,
        cost: 0,
        hasCost: true,
        isFromSales: false
      });
    }
  }

  $('#prodCount').textContent = fmt(state.costs.size);
  $('#prodMapped').textContent = fmt(t.products.filter(p => p.hasCost).length);
  $('#prodMissing').textContent = fmt(t.missing);

  const filtered = combinedList.filter(p =>
    !search || norm(p.product).includes(search) || norm(p.sku).includes(search)
  );

  const container = $('#productTable');

  if (!filtered.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">▤</div>
        <h3>표시할 상품 원가 데이터가 없습니다</h3>
        <p>정산 데이터를 가져오거나 상단의 '＋ 개별 상품 원가 추가' 버튼으로 새 원가를 등록하세요.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th>상품명 / 코드</th>
            <th class="num">판매 수량</th>
            <th>단위당 매입 원가 (₩)</th>
            <th class="num">총 매입 원가</th>
            <th>상태</th>
            <th style="width:50px; text-align:center">관리</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(p => `
            <tr>
              <td>
                <span class="product-name" title="${esc(p.product)}">${esc(p.product)}</span>
                ${p.sku ? `<span class="product-code">${esc(p.sku)}</span>` : ''}
                ${p.hasCost && !state.costs.has(p.key) ? '<span class="tiny muted">공통 상품명 원가 적용 · 수정 시 개별 SKU 원가 등록</span>' : !p.sku ? '<span class="tiny muted">상품명 기준 원가 · 같은 상품명의 SKU에도 적용될 수 있음</span>' : ''}
              </td>
              <td class="num">${p.isFromSales ? MKDecimal.format(p.qty) : '<span class="muted">— (정산 없음)</span>'}</td>
              <td>
                <input class="cost-input" type="number" min="0" step="any"
                       data-cost-key="${esc(p.key)}"
                       value="${p.unitCost === null ? '' : p.unitCost}"
                       placeholder="원가 입력" />
              </td>
              <td class="num money">${p.cost === null ? '—' : won(p.cost)}</td>
              <td>
                ${p.hasCost
                  ? '<span class="status-chip chip-green">원가 등록됨</span>'
                  : '<span class="status-chip chip-amber">입력 필요</span>'
                }
              </td>
              <td style="text-align:center">
                ${p.hasCost && state.costs.has(p.key) ? `<button class="btn-icon" data-delete-cost="${esc(p.key)}" title="등록 원가 삭제">🗑️</button>` : p.hasCost ? '<span class="tiny muted">공통 원가</span>' : ''}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="tiny muted" style="margin-top:12px; display:flex; justify-content:space-between">
      <span>원가 변경은 즉시 반영됩니다. 실제 데이터는 자동 저장되고 예시 데이터의 수정은 저장되지 않습니다.</span>
      <span>총 ${filtered.length}개 상품 표시 중</span>
    </div>
  `;

  $$('[data-cost-key]', container).forEach(input => {
    input.addEventListener('change', () => {
      const key = input.dataset.costKey;
      const item = combinedList.find(x => x.key === key);
      if (!item) return;

      const v = input.value.trim();
      let message = '상품 원가를 업데이트했습니다.';
      if (!v) {
        if (!removeRegisteredCost(key)) { renderProducts(); return; }
        message = item.sku && state.costs.has(`name:${norm(item.product)}`) ? '개별 SKU 원가를 삭제했습니다. 공통 상품명 원가가 다시 적용됩니다.' : '등록된 원가를 삭제했습니다.';
      } else {
        if (!setCost(item, v)) { renderProducts(); return; }
      }
      renderProducts();
      renderDashboard();
      renderResults();
      toast(message);
    });
  });

  $$('[data-delete-cost]', container).forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.deleteCost;
      const item = combinedList.find(x => x.key === key);
      if (!removeRegisteredCost(key)) return;
      const message = item?.sku && state.costs.has(`name:${norm(item.product)}`) ? '개별 SKU 원가를 삭제했습니다. 공통 상품명 원가가 다시 적용됩니다.' : '등록된 원가를 삭제했습니다.';
      renderProducts();
      renderDashboard();
      renderResults();
      toast(message);
    });
  });
}

// --- Results Detailed Report Page ---
function renderResults() {
  const t = totalUp();
  const search = norm($('#resultSearch').value || '');

  let products = t.products.filter(p =>
    !search || norm(p.product).includes(search) || norm(p.sku).includes(search)
  );

  if (state.filter === 'profit') products = products.filter(p => p.hasCost && MKDecimal.compare(p.profit, '0') >= 0);
  if (state.filter === 'loss') products = products.filter(p => p.hasCost && MKDecimal.compare(p.profit, '0') < 0);
  if (state.filter === 'missing') products = products.filter(p => !p.hasCost);

  $('#resultSub').textContent = state.isDemo
    ? '가상 예시 정산 데이터로 산출된 리포트입니다.'
    : t.products.length
      ? `${fmt(t.products.length)}개 상품 · ${fmt(state.transactions.length)}개 주문 데이터 기반`
      : '업로드된 데이터를 기반으로 분석합니다.';

  $('#resultCount').textContent = `${products.length}개 상품`;

  $('#resultNotice').innerHTML = t.products.length ? `
    <div class="alert alert-info">
      <span>ⓘ</span>
      <div>
        <strong>요약:</strong> 전체 ${t.products.length}개 상품 중 ${t.knownCount}개 상품에 원가가 연결되어 추정 순이익 <strong>${won(t.profit)}</strong> (마진율 ${fmt(t.margin, 1)}%)이 계산되었습니다.
        ${t.missing > 0 ? `<br><span style="color:var(--amber); font-weight:700">원가 미등록 상품 ${t.missing}개는 이익 계산에서 제외되었습니다.</span>` : ''}
      </div>
    </div>
  ` : '';

  const container = $('#resultTable');
  container.innerHTML = renderTableHtml(products);
  bindTableSortEvents(container);

  const notes = [
    ['₩', '추정 순이익의 정의', '상품 매출에서 환불액, 등록 원가, 플랫폼 수수료, 배송비, 광고비, 기타 잡비를 차감한 공헌 이익입니다. 세금계산서 발행분 및 세무 신고 내역과 차이가 있을 수 있습니다.'],
    ['!', '환불·취소액 중복 차감 확인', '스마트스토어 등 일부 정산서는 이미 환불이 차감된 순결제금액을 제공합니다. 이 경우 매핑 단계에서 환불 열을 제외해야 이중 차감을 방지할 수 있습니다.'],
    ['↕', '비용의 부호 처리', '수수료, 배송비, 광고비 등이 엑셀에서 음수(-)로 적혀 있어도 시스템이 자동으로 비용(절댓값)으로 인식하여 차감합니다.'],
    ['i', '원가 단위 및 묶음 판매', '주문 수량에 단위원가를 곱하여 총 원가를 산출합니다. 1+1 기획 상품이나 옵션별 원가가 크게 다른 경우 상품 코드(SKU) 단위로 원가를 분리해 등록하세요.']
  ];

  $('#calcNotes').innerHTML = notes.map(([i, t, d]) => `
    <div class="insight">
      <div class="insight-icon">${i}</div>
      <div><strong>${t}</strong><p>${d}</p></div>
    </div>
  `).join('');
}

// --- Mapping & Import Setup ---
function renderMappings(containerId, headers, defs, map) {
  const el = $('#' + containerId);
  el.innerHTML = defs.map(d => `
    <div class="field">
      <label>
        ${esc(d.label)}
        ${d.required ? '<span style="color:var(--red)">*</span>' : '<span class="muted">선택</span>'}
      </label>
      <select class="select mapping-select" data-map-key="${d.key}" data-map-type="${containerId === 'salesMappings' ? 'sales' : 'cost'}">
        <option value="">(선택 안 함)</option>
        ${headers.map(h => `<option value="${esc(h)}" ${map[d.key] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}
      </select>
    </div>
  `).join('');

  $$('.mapping-select', el).forEach(sel => {
    sel.addEventListener('change', () => {
      const target = sel.dataset.mapType === 'sales' ? state.salesMap : state.costMap;
      target[sel.dataset.mapKey] = sel.value;
      if (sel.dataset.mapType === 'sales' && !state.isDemo && state.salesSource === 'file') {
        saveMappingPreset(state.salesMap);
      }
    });
  });
}

function renderPreview(headers, rows, elId) {
  const el = $('#' + elId);
  if (!headers.length) {
    el.innerHTML = '<p class="muted tiny">미리보기를 표시할 수 없습니다.</p>';
    return;
  }
  const showHeaders = headers.slice(0, 10);
  el.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          ${showHeaders.map(h => `<th>${esc(h)}</th>`).join('')}
          ${headers.length > 10 ? '<th>…</th>' : ''}
        </tr>
      </thead>
      <tbody>
        ${rows.slice(0, 5).map(r => `
          <tr>
            ${showHeaders.map(h => `<td>${esc(String(r[h] ?? ''))}</td>`).join('')}
            ${headers.length > 10 ? '<td>…</td>' : ''}
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function updateMappingUI() {
  const ready = state.salesHeaders.length > 0;
  $('#mappingPanel').classList.toggle('hidden', !ready);
  $('#importTip').classList.toggle('hidden', ready);

  $('#salesSheetBlock').classList.toggle('hidden', !(state.salesWorkbook && state.salesWorkbook.SheetNames.length > 1));
  $('#costSheetBlock').classList.toggle('hidden', !(state.costWorkbook && state.costWorkbook.SheetNames.length > 1));

  if (ready) {
    renderMappings('salesMappings', state.salesHeaders, fieldDefs, state.salesMap);
    renderPreview(state.salesHeaders, state.salesRows, 'salesPreview');
  }

  if (state.costHeaders.length) {
    $('#costMappingSection').classList.remove('hidden');
    renderMappings('costMappings', state.costHeaders, costFieldDefs, state.costMap);
  } else {
    $('#costMappingSection').classList.add('hidden');
  }
}

function removeImportFile(type) {
  if (type !== 'sales' && type !== 'cost') return;
  const isSales = type === 'sales';
  invalidateImportReads(type);
  state.importStatus[type] = 'idle';
  if (isSales) {
    state.salesWorkbook = null;
    state.salesSource = 'none';
    state.salesRows = [];
    state.salesHeaders = [];
    state.salesFileName = '';
    state.salesMap = {};
  } else {
    state.costWorkbook = null;
    state.costSource = 'none';
    state.costRows = [];
    state.costHeaders = [];
    state.costFileName = '';
    state.costMap = {};
  }
  const input = $('#'+type+'File');
  if (input) input.value = '';
  updateFileStatus(type);
  updateMappingUI();
}

function updateFileStatus(type) {
  const isSales = type === 'sales';
  const wb = isSales ? state.salesWorkbook : state.costWorkbook;
  const name = isSales ? state.salesFileName : state.costFileName;
  const status = state.importStatus?.[type] || 'idle';
  const el = $('#' + type + 'FileStatus');

  if (!wb) {
    if (!isSales && ['selected', 'reading', 'failed', 'cancelled'].includes(status)) {
      const label = status === 'failed'
        ? '\uC6D0\uAC00 \uD30C\uC77C \uC77D\uAE30 \uC2E4\uD328'
        : status === 'cancelled'
          ? '\uC6D0\uAC00 \uD30C\uC77C \uC120\uD0DD\uC774 \uCDE8\uC18C\uB428'
          : status === 'reading'
            ? '\uC6D0\uAC00 \uD30C\uC77C \uC77D\uB294 \uC911...'
            : '\uC6D0\uAC00 \uD30C\uC77C \uC120\uD0DD\uB428';
      const removeLabel = '\uC6D0\uAC00 \uD30C\uC77C \uC120\uD0DD \uC81C\uAC70';
      el.innerHTML = '<div class="file-status"><span>' + label + '</span>' +
        '<button class="remove" title="' + removeLabel + '" aria-label="' + removeLabel + '" data-remove-file="' + type + '">×</button></div>';
      $('[data-remove-file="' + type + '"]', el).onclick = () => removeImportFile(type);
    } else {
      el.innerHTML = '';
    }
    return;
  }

  const replacementStatus = !isSales && status === 'reading'
    ? '<span>\uC0C8 \uD30C\uC77C\uC744 \uC77D\uB294 \uC911\uC785\uB2C8\uB2E4</span>'
    : !isSales && ['failed', 'cancelled'].includes(status)
      ? '<span>\uC6D0\uAC00 \uD30C\uC77C \uCC98\uB9AC\uAC00 \uD544\uC694\uD569\uB2C8\uB2E4</span>'
      : '';
  const removeLabel = isSales
    ? '\uD310\uB9E4 \uD30C\uC77C \uC120\uD0DD \uC81C\uAC70'
    : '\uC6D0\uAC00 \uD30C\uC77C \uC120\uD0DD \uC81C\uAC70';
  el.innerHTML = '<div class="file-status"><span>✓</span><span class="name">' + esc(name) + '</span>' +
    '<span>' + wb.SheetNames.length + '\uAC1C \uC2DC\uD2B8</span>' + replacementStatus +
    '<button class="remove" title="' + removeLabel + '" aria-label="' + removeLabel + '" data-remove-file="' + type + '">×</button></div>';
  $('[data-remove-file="' + type + '"]', el).onclick = () => removeImportFile(type);
}

function setWorkbook(type, wb, fileName) {
  const isSales = type === 'sales';
  const preset = loadMappingPreset();

  if (isSales) {
    state.salesWorkbook = wb;
    state.salesSource = 'file';
    state.salesFileName = fileName;
    state.salesSheetName = wb.SheetNames[0];
    $('#salesSheet').innerHTML = wb.SheetNames.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    loadSheet('sales', state.salesSheetName, preset);
  } else {
    state.costWorkbook = wb;
    state.costSource = 'file';
    state.costFileName = fileName;
    state.costSheetName = wb.SheetNames[0];
    $('#costSheet').innerHTML = wb.SheetNames.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    loadSheet('cost', state.costSheetName);
  }

  updateFileStatus(type);
  updateMappingUI();
  state.importStatus[type] = 'ready';
  toast(isSales ? '정산 파일을 읽었습니다. 매핑을 확인하세요.' : '원가 파일을 읽었습니다. 매핑을 확인하세요.');
}

function loadSheet(type, name, preset = {}) {
  const wb = type === 'sales' ? state.salesWorkbook : state.costWorkbook;
  if (!wb) return;

  const res = sheetToRows(wb, name);
  if (type === 'sales') {
    state.salesSheetName = name;
    state.salesHeaders = res.headers;
    state.salesRows = res.rows;
    state.salesMap = detectMaps(res.headers, fieldDefs, preset);
  } else {
    state.costSheetName = name;
    state.costHeaders = res.headers;
    state.costRows = res.rows;
    state.costMap = detectMaps(res.headers, costFieldDefs);
  }
  updateMappingUI();
}

function importFile(type, file) {
  if (!state.importStatus) state.importStatus = { sales: 'idle', cost: 'idle' };
  if (!file) {
    invalidateImportReads(type);
    state.importStatus[type] = 'cancelled';
    updateFileStatus(type);
    return;
  }
  invalidateImportReads(type);
  const generation = state.importGeneration[type];
  state.importStatus[type] = 'selected';
  updateFileStatus(type);
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
    state.importStatus[type] = 'failed';
        updateFileStatus(type);
    toast('XLSX, XLS 또는 CSV 파일을 선택해 주세요.');
    return;
  }
  state.importStatus[type] = 'reading';
  updateFileStatus(type);
  try {
    if (!state.importCancel) state.importCancel = {};
    state.importCancel[type] = readFile(file, (err, wb) => {
      if (generation !== state.importGeneration[type]) return;
      state.importCancel[type] = null;
      if (err) {
        state.importStatus[type] = 'failed';
        updateFileStatus(type);
        toast(err.message || '파일을 파싱하지 못했습니다.');
        return;
      }
      if (!wb || !wb.SheetNames || !wb.SheetNames.length) {
        state.importStatus[type] = 'failed';
        updateFileStatus(type);
        toast('파일에 읽을 수 있는 시트가 없습니다.');
        return;
      }
      try {
        setWorkbook(type, wb, file.name);
        state.importStatus[type] = 'ready';
        updateFileStatus(type);
      } catch(setupError) {
        state.importStatus[type] = 'failed';
        updateFileStatus(type);
        toast(setupError.message || '파일 내용을 준비하지 못했습니다.');
      }
    });
  } catch(readError) {
    if (generation === state.importGeneration[type]) {
      state.importStatus[type] = 'failed';
        updateFileStatus(type);
      toast(readError.message || '파일을 파싱하지 못했습니다.');
    }
  }
}

function processImport() {
  const salesStatus = state.importStatus?.sales || 'idle';
  const costStatus = state.importStatus?.cost || 'idle';
  if (salesStatus === 'selected' || salesStatus === 'reading') {
    toast('판매 파일을 읽는 중입니다. 완료 후 분석해 주세요.');
    return;
  }
  if (salesStatus === 'failed' || salesStatus === 'cancelled') {
    toast('판매 파일을 다시 선택해 주세요.');
    return;
  }
  if (salesStatus !== 'ready' || state.salesSource !== 'file' || !state.salesWorkbook) {
    toast('실제 판매 파일을 먼저 업로드해 주세요.');
    return;
  }
  if (['selected', 'reading'].includes(costStatus)) {
    toast('판매/원가 파일 처리가 끝난 뒤 분석해 주세요.');
    return;
  }
  if (costStatus === 'failed' || costStatus === 'cancelled') {
    toast('원가 파일을 다시 선택하거나 입력을 취소해 주세요.');
    return;
  }
  const costSelected = costStatus === 'ready' || state.costSource === 'file' || !!state.costWorkbook;
  if (costSelected && (costStatus !== 'ready' || state.costSource !== 'file' || !state.costWorkbook)) {
    toast('원가 파일 상태를 확인해 주세요.');
    return;
  }

  const m = ingestSalesRows(state.salesRows, state.salesMap);
  if (!m.ok) {
    toast(m.error);
    return;
  }

  let nextCosts = state.isDemo ? loadCostsFromStorage() : new Map(state.costs);
  let costImport = null;
  if (costSelected) {
    const c = ingestCostRows(state.costRows, state.costMap, nextCosts);
    if (!c.ok) {
      toast('원가 파일 매핑을 다시 확인해 주세요.');
      return;
    }
    costImport = c;
    nextCosts = c.costs;
  }

  if (!calculationWithinBudget(m.rows, nextCosts)) { toast('계산 결과의 숫자 데이터가 처리 한도를 초과합니다. 분석 파일을 작게 나누어 주세요.'); return; }
  // Persist candidate costs before publishing any imported state.
  if (costImport?.added > 0 && !persistCosts(nextCosts, false)) return;
  // Commit only after all selected inputs have parsed and validated.
  invalidateImportReads();
  state.transactions = m.rows;
  state.costs = nextCosts;
  state.isDemo = false;
  saveMappingPreset(state.salesMap);

  $('#step1').classList.add('done');
  $('#step2').classList.add('done');
  $('#step3').classList.add('active');

  toast(`${m.rows.length}개 정산 행을 성공적으로 분석했습니다.`);
  renderDashboard();
  renderProducts();
  renderResults();
  setPage('results');

  if (m.skipped > 0) {
    showModal(
      '일부 누락 행 안내',
      `${m.skipped}개 행은 상품명이 비어 있거나 매출액 숫자가 없어 분석에서 제외되었습니다. 원본 엑셀의 빈 행이나 소계/합계 행인지 확인하세요.`
    );
  }
}

// --- Demo Data ---
function loadDemo() {
  // Flush real costs first, then switch to an in-memory demo map.
  if (!state.isDemo) {
    if (!saveCostsToStorage()) return;
  }
  invalidateImportReads();
  state.isDemo = true;
  state.salesWorkbook = null;
  state.costWorkbook = null;
  state.salesSource = 'demo';
  state.costSource = 'demo';
  state.importStatus = { sales: 'idle', cost: 'idle' };
  state.salesSheetName = '';
  state.costRows = [];
  state.costHeaders = [];
  state.costSheetName = '';
  state.costMap = {};
  state.salesFileName = '스마트스토어_정산내역_샘플.csv';
  state.costFileName = '상품_원가표_샘플.csv';

  state.salesRows = [
    { '상품명': '고휘도 LED 감성 캠핑 랜턴', '상품코드': 'CP-001', '상품 매출': 597000, '판매 수량': 30, '판매 수수료': 35820, '판매자 배송비': 18000, '광고비': 36000, '환불 조정액': 19900, '기타 비용': 0 },
    { '상품명': '감성 방수 수납 파우치 세트', '상품코드': 'ST-010', '상품 매출': 450000, '판매 수량': 50, '판매 수수료': 27000, '판매자 배송비': 25000, '광고비': 18000, '환불 조정액': 0, '기타 비용': 1500 },
    { '상품명': '스테인리스 보온보냉 텀블러 500ml', '상품코드': 'TB-050', '상품 매출': 720000, '판매 수량': 48, '판매 수수료': 43200, '판매자 배송비': 36000, '광고비': 95000, '환불 조정액': 45000, '기타 비용': 0 },
    { '상품명': '초경량 블루투스 셀카봉 삼각대', '상품코드': 'TR-006', '상품 매출': 185000, '판매 수량': 37, '판매 수수료': 11100, '판매자 배송비': 18500, '광고비': 38000, '환불 조정액': 0, '기타 비용': 3000 },
    { '상품명': '프리미엄 퀵 차지 고속충전 케이블', '상품코드': 'CB-990', '상품 매출': 120000, '판매 수량': 20, '판매 수수료': 7200, '판매자 배송비': 12000, '광고비': 0, '환불 조정액': 0, '기타 비용': 0 },
    { '상품명': '휴대용 미니 실리콘 물병', '상품코드': 'WB-101', '상품 매출': 99000, '판매 수량': 11, '판매 수수료': 5940, '판매자 배송비': 6600, '광고비': 5000, '환불 조정액': 0, '기타 비용': 0 }
  ];

  state.salesHeaders = Object.keys(state.salesRows[0]);
  state.salesMap = detectMaps(state.salesHeaders, fieldDefs);
  state.transactions = ingestSalesRows(state.salesRows, state.salesMap).rows;

  const demoCosts = [
    ['고휘도 LED 감성 캠핑 랜턴', 'CP-001', 9200],
    ['감성 방수 수납 파우치 세트', 'ST-010', 4100],
    ['스테인리스 보온보냉 텀블러 500ml', 'TB-050', 10500],
    ['초경량 블루투스 셀카봉 삼각대', 'TR-006', 4200],
    ['프리미엄 퀵 차지 고속충전 케이블', 'CB-990', 2500]
  ];

  state.costs = new Map();
  demoCosts.forEach(([product, sku, unitCost]) => {
    state.costs.set(`sku:${sku}`, { product, sku, unitCost });
  });
  // Intentionally do not call saveCostsToStorage() in demo mode.
  $('#salesFile').value = '';
  $('#costFile').value = '';

  updateFileStatus('sales');
  updateFileStatus('cost');
  updateMappingUI();

  $('#step1').classList.add('done');
  $('#step2').classList.add('done');
  $('#step3').classList.add('done');

  renderDashboard();
  renderProducts();
  renderResults();
  toast('가상 예시 데이터를 불러왔습니다.');
  setPage('dashboard');
}

// --- CSV Downloads & Templates ---
function csvCell(v) {
  let s = String(v ?? '');
  // Prevent spreadsheet applications from treating untrusted text as a formula.
  if (typeof v !== 'number' && /^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvDecimalCell(value) {
  if (value === '' || value === null || value === undefined) return '';
  // Ratio display can use scientific notation at large magnitudes; only numeric
  // primitives are expanded here. Arbitrary string exponents remain rejected.
  return MKDecimal.normalize(value);
}

function downloadBlob(content, name, type = 'text/csv;charset=utf-8;') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function downloadSalesTemplate() {
  const rows = [
    ['상품명', '상품코드', '상품 매출', '판매 수량', '판매 수수료', '판매자 배송비', '광고비', '환불 조정액', '기타 비용'],
    ['캠핑 랜턴 LED', 'SKU-001', 300000, 10, 18000, 15000, 10000, 0, 0],
    ['보온 텀블러', 'SKU-002', 450000, 15, 27000, 22500, 15000, 30000, 0]
  ];
  downloadBlob('\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'marginkit-sales-template.csv');
  toast('정산 샘플 CSV 양식을 다운로드했습니다.');
}

function downloadCostTemplate() {
  const rows = [
    ['상품명', '상품코드', '단위당 매입 원가'],
    ['캠핑 랜턴 LED', 'SKU-001', 12000],
    ['보온 텀블러', 'SKU-002', 15000]
  ];
  downloadBlob('\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'marginkit-cost-template.csv');
  toast('원가 샘플 CSV 양식을 다운로드했습니다.');
}

function exportCurrentProductsCostTemplate() {
  const t = totalUp();
  if (!t.products.length) {
    downloadCostTemplate();
    return;
  }
  const headers = ['상품명', '상품코드', '단위당 매입 원가'];
  const rows = t.products.map(p => [p.product, p.sku, p.unitCost ?? '']);
  const csv = '\ufeff' + [headers.map(csvCell).join(','), ...rows.map(r => r.map((value, i) => i < 2 || i === 16 ? csvCell(value) : csvDecimalCell(value)).join(','))].join('\r\n');
  downloadBlob(csv, `marginkit-products-costs-${new Date().toISOString().slice(0, 10)}.csv`);
  toast('현재 분석된 상품 목록이 채워진 원가표를 다운로드했습니다.');
}

// Export the complete active cost register, independent of sales and view filters.
// Demo mode exports only its isolated in-memory data, never real stored costs.
function exportRegisteredCosts() {
  if (!state.costs.size) {
    toast('내보낼 등록 원가가 없습니다.');
    return;
  }
  const headers = ['상품명', '상품코드', '단위당 매입 원가'];
  const rows = [...state.costs.values()].map(c => [c.product, c.sku, c.unitCostExact ?? c.unitCost]);
  const csv = '\ufeff' + [headers.map(csvCell).join(','), ...rows.map(r => r.map((value, i) => i < 2 || i === 16 ? csvCell(value) : csvDecimalCell(value)).join(','))].join('\r\n');
  const prefix = state.isDemo ? 'marginkit-demo-costs' : 'marginkit-registered-costs';
  downloadBlob(csv, `${prefix}-${new Date().toISOString().slice(0, 10)}.csv`);
  toast(`${state.isDemo ? '데모' : '등록'} 원가 전체 ${rows.length}개를 내보냈습니다. 현재 분석에 없는 상품도 포함됩니다.`);
}

// Versioned lossless cost-register snapshot.
function exportCostRegisterJson() {
  if (!state.costs.size) {
    toast('백업할 등록 원가가 없습니다.');
    return;
  }
  const snapshot = {
    format: 'marginkit-cost-register',
    version: [...state.costs.values()].some(c => Object.prototype.hasOwnProperty.call(c, 'unitCostExact')) ? 2 : 1,
    mode: state.isDemo ? 'demo' : 'real',
    exportedAt: new Date().toISOString(),
    costs: [...state.costs.entries()]
  };
  const prefix = state.isDemo ? 'marginkit-demo-cost-register' : 'marginkit-cost-register';
  downloadBlob(JSON.stringify(snapshot, null, 2), `${prefix}-${snapshot.exportedAt.slice(0, 10)}.json`, 'application/json;charset=utf-8');
  toast(snapshot.costs.length > 20000
    ? `원가 ${snapshot.costs.length}개를 손실 없이 백업했습니다. 이 파일은 20,000개 복원 한도를 초과합니다. 별도 분할 검토가 필요하며 원본을 보관해 주세요.`
    : `원가 ${snapshot.costs.length}개의 JSON 백업을 받았습니다. JSON 복원에서 검토 후 새 상품만 추가할 수 있습니다.`);
}

function downloadResults() {
  const t = totalUp();
  if (!t.products.length) {
    toast('먼저 정산 데이터를 분석해 주세요.');
    return;
  }
  const headers = [
    '상품명', '상품코드', '판매수량', '총매출액', '환불조정액', '순매출액',
    '단위원가', '총원가', '플랫폼수수료', '배송비', '광고비', '기타비용',
    '총비용합계', '추정순이익', '추정마진율(%)', 'ROI(%)', '원가등록여부'
  ];
  const rows = t.products.map(p => [
    p.product,
    p.sku,
    p.qty,
    p.revenue,
    p.refunds,
    p.netRevenue,
    p.unitCost ?? '',
    p.cost ?? '',
    p.commission,
    p.shipping,
    p.ads,
    p.other,
    MKDecimal.add(p.fees, p.cost ?? '0'),
    p.profit ?? '',
    p.margin !== null ? Number(p.margin.toFixed(1)) : '',
    p.roi !== null ? Number(p.roi.toFixed(1)) : '',
    p.hasCost ? '등록됨' : '미등록'
  ]);
  const csv = '\ufeff' + [headers.map(csvCell).join(','), ...rows.map(r => r.map((value, i) => i < 2 || i === 16 ? csvCell(value) : csvDecimalCell(value)).join(','))].join('\r\n');
  downloadBlob(csv, `marginkit-report-${new Date().toISOString().slice(0, 10)}.csv`);
  toast('분석 리포트 CSV를 다운로드했습니다.');
}

// --- Validated, non-destructive JSON cost restoration ---
let costRestoreGeneration = 0;
let pendingCostRestore = null;

function validateCostSnapshot(text) {
  if (new TextEncoder().encode(text).byteLength > 10 * 1024 * 1024) throw new Error('JSON 백업은 10MB 이하만 지원합니다.');
  let data;
  try { data = JSON.parse(text.replace(/^\ufeff/, '')); } catch { throw new Error('올바른 JSON 파일이 아닙니다.'); }
  const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
  if (!exact(data, ['format', 'version', 'mode', 'exportedAt', 'costs']) || data.format !== 'marginkit-cost-register' || ![1, 2].includes(data.version)) {
    throw new Error('지원하는 MarginKit 원가 백업 버전 1 또는 2가 아닙니다.');
  }
  if (!['real', 'demo'].includes(data.mode) || typeof data.exportedAt !== 'string' ||
      !Number.isFinite(Date.parse(data.exportedAt)) || new Date(data.exportedAt).toISOString() !== data.exportedAt ||
      !Array.isArray(data.costs) || data.costs.length > 20000) throw new Error('백업 메타데이터 또는 상품 수가 올바르지 않습니다.');
  if (!withinDecimalBudget(data.costs.map(entry => entry?.[1] || {}), ['unitCost', 'unitCostExact'])) throw new Error('백업 숫자 데이터가 처리 한도를 초과했습니다.');
  const costs = new Map();
  for (const entry of data.costs) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
        !(exact(entry[1], ['product', 'sku', 'unitCost']) || (data.version === 2 && exact(entry[1], ['product', 'sku', 'unitCost', 'unitCostExact'])))) throw new Error('백업 상품 형식이 올바르지 않습니다.');
    const [key, item] = entry;
    if (typeof item.product !== 'string' || !item.product.trim() || typeof item.sku !== 'string' ||
        typeof item.unitCost !== 'number' || !Number.isFinite(item.unitCost) || item.unitCost < 0 || item.unitCost > 1e12 ||
        key !== (item.sku ? `sku:${item.sku}` : `name:${norm(item.product)}`) || costs.has(key) || !validCostPrecision(item)) {
      throw new Error('상품 키·원가 또는 중복 상품이 올바르지 않습니다. 전체 복원을 중단했습니다.');
    }
    costs.set(key, { product: item.product, sku: item.sku, unitCost: item.unitCost, ...(Object.prototype.hasOwnProperty.call(item, 'unitCostExact') ? { unitCostExact: item.unitCostExact } : {}) });
  }
  return { mode: data.mode, costs };
}

function planCostMerge(current, incoming) {
  const merged = new Map(current);
  let skipped = 0;
  for (const [key, item] of incoming) {
    if (merged.has(key)) skipped++;
    else merged.set(key, item);
  }
  if (merged.size > 20000) throw new Error('병합 후 등록 원가는 20,000개 이하이어야 합니다.');
  if (!withinDecimalBudget([...merged.values()], ['unitCost', 'unitCostExact'])) throw new Error('병합 후 원가 숫자 데이터가 처리 한도를 초과합니다.');
  return { merged, skipped, added: merged.size - current.size };
}

function cancelCostRestore() {
  costRestoreGeneration++;
  pendingCostRestore = null;
  $('#costRestoreBackdrop').classList.remove('show');
  $('#costRestoreFile').value = '';
  $('#btnConfirmCostRestore').disabled = true;
}

async function previewCostRestore(file) {
  cancelCostRestore();
  if (!file) return;
  const generation = costRestoreGeneration;
  const mode = state.isDemo;
  const original = state.costs;
  const fingerprint = JSON.stringify([...original]);
  try {
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > 10 * 1024 * 1024) throw new Error('JSON 백업은 10MB 이하만 지원합니다.');
    const stored = mode ? null : localStorage.getItem(STORAGE_KEY_COSTS);
    // A different tab may have changed persistence before this preview began.
    // Never merge stale memory over a newer persisted register.
    if (!mode && (stored === null ? original.size !== 0 : JSON.stringify(JSON.parse(stored)) !== fingerprint)) {
      throw new Error('현재 원가와 저장된 원가가 다릅니다. 새로고침 후 파일을 다시 선택해 주세요.');
    }
    const parsed = validateCostSnapshot(await file.text());
    if (generation !== costRestoreGeneration) return;
    if (mode !== state.isDemo || original !== state.costs || fingerprint !== JSON.stringify([...state.costs])) throw new Error('원가 또는 모드가 변경되었습니다. 파일을 다시 선택해 주세요.');
    if (parsed.mode !== (mode ? 'demo' : 'real')) throw new Error('데모와 실제 원가 백업은 서로 다른 모드에서 복원할 수 없습니다.');
    const { merged, skipped, added } = planCostMerge(original, parsed.costs);
    if (!calculationWithinBudget(state.transactions || [], merged)) throw new Error('복원 후 계산 결과가 처리 한도를 초과합니다. 분석 파일을 작게 나누어 주세요.');
    pendingCostRestore = { generation, mode, original, fingerprint, stored, merged, added };
    $('#costRestoreSummary').textContent = `${mode ? '데모' : '실제'} 원가: 현재 ${original.size}개 · 파일 ${parsed.costs.size}개 · 새로 추가 ${added}개 · 기존 키와 겹쳐 건너뜀 ${skipped}개. 기존 상품은 원가가 달라도 덮어쓰지 않습니다. 최종 ${merged.size}개.`;
    $('#costRestorePreview').textContent = [...parsed.costs.values()].slice(0, 5).map(c => `${c.product} / ${c.sku || '(상품명 키)'} / ${c.unitCostExact ?? c.unitCost}`).join('\n') || '빈 백업: 추가할 상품이 없습니다.';
    $('#btnConfirmCostRestore').disabled = added === 0;
    $('#costRestoreBackdrop').classList.add('show');
    $('#btnCancelCostRestore').focus();
  } catch (error) {
    if (generation === costRestoreGeneration) { cancelCostRestore(); toast(error.message || '백업 파일을 읽지 못했습니다.'); }
  }
}

function confirmCostRestore() {
  const pending = pendingCostRestore;
  if (!pending || !pending.added) return;
  try {
    if (pending.generation !== costRestoreGeneration || pending.mode !== state.isDemo || pending.original !== state.costs ||
        pending.fingerprint !== JSON.stringify([...state.costs])) throw new Error('미리보기 이후 원가 또는 모드가 변경되었습니다. 파일을 다시 선택해 주세요.');
    if (!calculationWithinBudget(state.transactions || [], pending.merged)) throw new Error('복원 후 계산 결과가 처리 한도를 초과합니다.');
    if (!pending.mode) {
      if (localStorage.getItem(STORAGE_KEY_COSTS) !== pending.stored) throw new Error('다른 탭에서 저장된 원가가 변경되었습니다. 새로고침 후 다시 시도해 주세요.');
      // localStorage.setItem is atomic; publish memory only after persistence succeeds.
      if (!persistCosts(pending.merged, false)) { cancelCostRestore(); return; }
    }
  } catch (error) {
    cancelCostRestore();
    toast(error.message || '저장하지 못했습니다. 원가는 변경되지 않았습니다.');
    return;
  }
  state.costs = pending.merged;
  cancelCostRestore();
  renderProducts(); renderDashboard(); renderResults();
  toast(`원가 ${pending.added}개를 추가했습니다. 기존 원가는 유지되었습니다.`);
}

// --- Add Product Modal Handlers ---
function openAddProductModal() {
  $('#newProdName').value = '';
  $('#newProdSku').value = '';
  $('#newProdCost').value = '';
  $('#addProductModalBackdrop').classList.add('show');
  $('#newProdName').focus();
}

function closeAddProductModal() {
  $('#addProductModalBackdrop').classList.remove('show');
}

function saveNewProduct() {
  const name = $('#newProdName').value.trim();
  const sku = $('#newProdSku').value.trim();
  const cost = parseNum($('#newProdCost').value);

  if (!name) {
    toast('상품명을 입력해 주세요.');
    $('#newProdName').focus();
    return;
  }
  if (cost === null || MKDecimal.compare(MKDecimal.input($('#newProdCost').value), '0') < 0) {
    toast('0 이상의 올바른 원가를 입력해 주세요.');
    $('#newProdCost').focus();
    return;
  }

  const key = sku ? `sku:${sku}` : `name:${norm(name)}`;
  const nextCosts = new Map(state.costs);
  nextCosts.set(key, makeCostRecord(name, sku, $('#newProdCost').value));
  if (!commitCosts(nextCosts)) return;

  closeAddProductModal();
  renderProducts();
  renderDashboard();
  renderResults();
  toast(`'${name}' 상품 원가를 저장했습니다.`);
}

// --- Event Listeners & Bindings ---
document.addEventListener('click', event => {
  const control = event.target.closest('.nav-item[data-page], [data-page-link]');
  if (!control) return;
  event.preventDefault();
  setPage(control.dataset.page || control.dataset.pageLink);
});
window.addEventListener('hashchange', () => setPage(window.location.hash.slice(1), false));
window.addEventListener('popstate', () => setPage(window.location.hash.slice(1), false));

$('#btnStartImport').onclick = () => setPage('import');
$('#btnAllResults').onclick = () => setPage('results');
$('#btnDemo').onclick = loadDemo;
$('#btnDemoImport').onclick = loadDemo;

$('#btnDownloadSalesTpl').onclick = downloadSalesTemplate;
$('#btnDownloadCostTpl').onclick = downloadCostTemplate;
$('#btnImportTpl').onclick = downloadSalesTemplate;
$('#btnExportCurrentCostTpl').onclick = exportCurrentProductsCostTemplate;
$('#btnExportCurrentCost').onclick = exportCurrentProductsCostTemplate;
$('#btnExportRegisteredCosts').onclick = exportRegisteredCosts;
$('#btnBackupCostRegister').onclick = exportCostRegisterJson;
$('#btnExportStoredCostRaw').onclick = () => {
  if (typeof loadCostsFromStorage.revision === 'string') downloadBlob(loadCostsFromStorage.revision, 'marginkit-stored-cost-original.txt', 'text/plain;charset=utf-8');
};
$('#btnRestoreCostRegister').onclick = () => { cancelCostRestore(); $('#costRestoreFile').click(); };
$('#costRestoreFile').onchange = event => previewCostRestore(event.target.files[0]);
$('#btnCancelCostRestore').onclick = cancelCostRestore;
$('#btnConfirmCostRestore').onclick = confirmCostRestore;
$('#costRestoreBackdrop').addEventListener('click', event => { if (event.target.id === 'costRestoreBackdrop') cancelCostRestore(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') cancelCostRestore(); });
$('#btnExportCosts').onclick = exportCurrentProductsCostTemplate;
$('#btnExport').onclick = downloadResults;

$('#btnAddProduct').onclick = openAddProductModal;
$('#btnCancelAddProd').onclick = closeAddProductModal;
$('#btnSaveAddProd').onclick = saveNewProduct;
$('#btnCostImport').onclick = () => { setPage('import'); $('#costFile').click(); };

$('#chartSortRevenue').onclick = () => {
  state.chartMetric = 'revenue';
  $('#chartSortRevenue').classList.add('active');
  $('#chartSortProfit').classList.remove('active');
  renderSalesChart(state.products);
};
$('#chartSortProfit').onclick = () => {
  state.chartMetric = 'profit';
  $('#chartSortProfit').classList.add('active');
  $('#chartSortRevenue').classList.remove('active');
  renderSalesChart(state.products);
};

$('#btnReset').onclick = () => {
  if (confirm('현재 업로드한 데이터와 등록된 상품 원가를 모두 초기화하시겠습니까?')) {
    const leavingDemo = state.isDemo;
    let presetResetFailed = false;
    if (!leavingDemo) {
      try {
        checkCostStorageRevision(true);
        localStorage.removeItem(STORAGE_KEY_COSTS);
        loadCostsFromStorage.revision = null;
        loadCostsFromStorage.blocked = false;
      } catch (error) {
        toast('초기화하지 못했습니다. 현재 원가·분석은 유지됩니다. ' + (error.message || '저장소 권한을 확인해 주세요.'));
        return;
      }
      try { localStorage.removeItem(STORAGE_KEY_PRESET); } catch { presetResetFailed = true; }
    }
    invalidateImportReads();
    Object.assign(state, {
      salesWorkbook: null, costWorkbook: null,
      salesSource: 'none', costSource: 'none',
      importStatus: { sales: 'idle', cost: 'idle' },
      salesFileName: '', costFileName: '',
      salesRows: [], costRows: [],
      salesHeaders: [], costHeaders: [],
      salesMap: {}, costMap: {},
      transactions: [], products: [],
      // Demo exit restores persisted real costs; real reset clears them.
      costs: leavingDemo ? loadCostsFromStorage() : new Map(),
      isDemo: false
    });
    $('#salesFile').value = '';
    $('#costFile').value = '';
    ['sales', 'cost'].forEach(updateFileStatus);
    $('#step1').classList.remove('done');
    $('#step2').classList.remove('done');
    $('#step3').classList.remove('done', 'active');
    updateMappingUI();
    renderDashboard();
    renderProducts();
    renderResults();
    setPage('dashboard');
    toast(leavingDemo
      ? '예시 데이터를 종료했습니다. 저장된 실제 원가는 유지됩니다.'
      : presetResetFailed ? '원가·분석은 초기화했지만 저장된 열 매핑 설정은 삭제하지 못했습니다.' : '모든 데이터와 원가 설정이 초기화되었습니다.');
  }
};

$('#salesDrop').onclick = () => $('#salesFile').click();
$('#costDrop').onclick = () => $('#costFile').click();

$('#salesFile').addEventListener('change', e => importFile('sales', e.target.files[0]));
$('#costFile').addEventListener('change', e => importFile('cost', e.target.files[0]));

[['salesDrop', 'sales'], ['costDrop', 'cost']].forEach(([id, type]) => {
  const el = $('#' + id);
  ['dragenter', 'dragover'].forEach(ev => el.addEventListener(ev, e => {
    e.preventDefault();
    el.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(ev => el.addEventListener(ev, e => {
    e.preventDefault();
    el.classList.remove('dragover');
  }));
  el.addEventListener('drop', e => {
    const f = e.dataTransfer.files[0];
    if (f) importFile(type, f);
  });
});

function switchImportSheet(type, name) {
  try {
    loadSheet(type, name);
    state.importStatus[type] = 'ready';
  } catch (error) {
    state.importStatus[type] = 'failed';
    toast(error.message || '시트 내용을 읽지 못했습니다. 다른 시트를 선택해 주세요.');
  }
  updateFileStatus(type);
}
$('#salesSheet').addEventListener('change', e => switchImportSheet('sales', e.target.value));
$('#costSheet').addEventListener('change', e => switchImportSheet('cost', e.target.value));
$('#btnProcessImport').onclick = processImport;
$('#btnCancelImport').onclick = () => {
  invalidateImportReads();
  ['sales', 'cost'].forEach(type => {
    if (state.importStatus[type] === 'selected' || state.importStatus[type] === 'reading') {
      state.importStatus[type] = 'cancelled';
    }
  });
  setPage('dashboard');
};

$('#productSearch').addEventListener('input', renderProducts);
$('#resultSearch').addEventListener('input', renderResults);

$$('.filter-btn').forEach(b => b.onclick = () => {
  state.filter = b.dataset.filter;
  $$('.filter-btn').forEach(x => x.classList.toggle('active', x === b));
  renderResults();
});

$('#btnHelp').onclick = () => showModal(
  '마진킷 사용 가이드 및 도움말',
  '1. 정산 파일 업로드:\n' +
  '• 네이버 스마트스토어, 쿠팡, 지마켓 등에서 다운로드한 판매/정산 엑셀(XLSX/XLS) 또는 CSV 파일을 업로드합니다.\n' +
  '• 한글 깨짐 방지 기능이 내장되어 있어 EUC-KR 파일도 자동으로 올바르게 인식됩니다.\n\n' +
  '2. 열(Column) 매핑 확인:\n' +
  '• [상품명]과 [상품 매출]은 필수입니다.\n' +
  '• 수수료, 배송비, 광고비 등은 정산 파일에 해당 열이 존재하는 경우에만 선택하세요.\n' +
  '• 이미 환불이나 수수료가 공제된 순매출을 선택한 경우, 환불/수수료 열을 다시 선택하면 이중 차감되므로 주의하세요.\n\n' +
  '3. 상품 원가 입력:\n' +
  '• 원가 엑셀 파일을 함께 업로드하거나, [상품 원가 관리] 메뉴에서 직접 단위원가를 입력할 수 있습니다.\n' +
  '• 입력된 원가는 브라우저에 자동 저장되므로 다음 번 접속 시에도 그대로 유지됩니다.\n\n' +
  '4. 분석 결과 및 의사결정:\n' +
  '• 순이익, 마진율(%), 적자 여부를 확인하고 필요 시 CSV 결과 보고서를 내려받으세요.'
);

$('#modalClose').onclick = () => $('#modalBackdrop').classList.remove('show');
$('#modalBackdrop').addEventListener('click', e => {
  if (e.target.id === 'modalBackdrop') $('#modalBackdrop').classList.remove('show');
});
$('#addProductModalBackdrop').addEventListener('click', e => {
  if (e.target.id === 'addProductModalBackdrop') closeAddProductModal();
});

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    $('#modalBackdrop').classList.remove('show');
    closeAddProductModal();
  }
});

// Initial boot
renderDashboard();
renderProducts();
renderResults();
setPage(window.location.hash.slice(1) || 'dashboard', false);
if (loadCostsFromStorage.blocked) toast('저장 원가를 읽지 못해 덮어쓰기를 중지했습니다. 상품 원가 관리에서 원본을 보관하고 복구해 주세요.');

})();
