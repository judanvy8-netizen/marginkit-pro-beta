const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const suite = require('../suite-tools.js');
let count = 0;
function test(name, fn) { fn(); count++; console.log('PASS', name); }
const base = suite.defaults().simulator;
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 0.00001, `${actual} != ${expected}`); }
function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem(key) { return values.has(key) ? values.get(key) : null; }, setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); } };
}
const legacy = { costPrice: '12000', sellPrice: '29900', platform: '0.058', customFee: '5.8', shippingFee: '3000', adFee: '2500', fixedCostPerUnit: '500', taxType: 'general', monthlyVolume: '500', targetMarginRate: '25' };
test('one cash basis includes VAT in purchase cost', () => {
  const result = suite.calculateSimulator(base);
  near(result.profit, 8965.8); near(result.monthly, 1793160); near(result.fee, 1734.2);
});
test('reserve is explicit percentage of gross revenue', () => {
  const result = suite.calculateSimulator({ ...base, reserveEnabled: true, reservePct: '3' });
  near(result.reserve, 897); near(result.profit, 8068.8); near(result.cashProfit, 8965.8);
});
test('disabled reserve ignores an unfinished reserve input', () => near(suite.calculateSimulator({ ...base, reservePct: '' }).reserve, 0));
test('target price round-trips same fees, reserve, and all costs', () => {
  for (const feePct of [0, 3.3, 5.8, 10.8, 15]) for (const reservePct of [0, 3, 15]) for (const targetPct of [0, 10, 25, 60]) {
    const input = { ...base, feePct, reserveEnabled: true, reservePct, targetPct };
    const target = suite.calculateSimulator(input).targetPrice;
    if (feePct + reservePct + targetPct >= 100) { assert.equal(target, null); continue; }
    assert.ok(target > 0);
    const at = suite.calculateSimulator({ ...input, sell: target });
    const below = suite.calculateSimulator({ ...input, sell: target - 1 });
    assert.ok(at.margin + 1e-12 >= targetPct / 100);
    assert.ok(below.margin < targetPct / 100);
  }
});
test('no artificial denominator clamp for impossible target', () => assert.equal(suite.calculateSimulator({ ...base, feePct: '50', targetPct: '50' }).targetPrice, null));
test('exact integer target is not inflated by binary rounding', () => {
  assert.equal(suite.recommendedPrice(12, 0.03, 0, 0.93), 300);
  assert.equal(suite.recommendedPrice(19200, 0.058, 0.15, 0.60), 100000);
});
test('5005 exact300-won inverse boundaries use decimal arithmetic', () => {
  let cases = 0;
  for (let fee = 0; fee <= 90; fee++) for (let target = 0; target <= 99 - fee; target++) {
    const fixed = (100 - fee - target) * 3;
    assert.equal(suite.recommendedPrice(fixed, fee / 100, 0, target / 100), 300, `fee=${fee} target=${target}`);
    cases++;
  }
  assert.equal(cases, 5005);
});
test('sub-won boundary and tiny positive denominator never use loose epsilon', () => {
  assert.equal(suite.recommendedPrice(12.000000000001, 0.03, 0, 0.93), 301);
  assert.equal(suite.recommendedPrice(1, 0.999999999999, 0, 0), 1000000000000);
  assert.equal(suite.recommendedPrice(1, 0.9999999999999, 0, 0), null);
});
test('zero-cost boundary target has a positive valid price', () => {
  const result = suite.calculateSimulator({ ...base, cost: 0, ship: 0, ad: 0, fixed: 0, feePct: 10, reserveEnabled: true, reservePct: 20, targetPct: 70 });
  assert.equal(result.targetPrice, 1);
});
test('zero-cost exact100% allocation does not fail binary subtraction', () => {
  assert.equal(suite.recommendedPrice(0, 0.8, 0, 0.2), 1);
  assert.equal(suite.recommendedPrice(0, 0.9, 0, 0.1), 1);
  assert.equal(suite.recommendedPrice(0, 0.9, 0, 0.1001), null);
});
test('zero advertising produces no infinite multiple', () => assert.equal(suite.calculateSimulator({ ...base, ad: 0 }).adMultiple, null));
test('loss before ads cannot be cured by zero advertising', () => assert.equal(suite.calculateSimulator({ ...base, sell: 1000 }).breakEvenAd, null));
test('advertising exactly at break-even has zero residue', () => {
  const result = suite.calculateSimulator(base);
  const at = suite.calculateSimulator({ ...base, ad: result.breakEvenAd });
  near(at.profit, 0); near(at.adMultiple, 1);
});
test('zero volume does not force one sale', () => assert.equal(suite.calculateSimulator({ ...base, units: 0 }).monthly, 0));
for (const [field, value] of [['sell', -1], ['cost', Infinity], ['ship', ''], ['ad', NaN], ['feePct', 100.1], ['targetPct', -1], ['units', 1.5], ['units', 1e10], ['fixed', 1e13]]) {
  test('reject invalid simulator ' + field + ':' + value, () => assert.throws(() => suite.calculateSimulator({ ...base, [field]: value }), RangeError));
}
test('reject monthly products beyond precise numeric range', () => assert.throws(() => suite.calculateSimulator({ ...base, sell: 1e12, units: 1e9 }), RangeError));
test('settlement combines taxable and exempt sales separately', () => {
  const result = suite.calculateSettlement([{ channel: '과세', sales: 11000, feePct: 10, vatPct: 10 }, { channel: '면세', sales: 2000, feePct: 0, vatPct: 0 }]);
  near(result.totals.vat, 1000); near(result.totals.supply, 12000); near(result.totals.take, 11900);
});
test('settlement rejects invalid fee/VAT/nonfinite sales', () => {
  for (const values of [{ sales: Infinity }, { sales: -1 }, { feePct: 101 }, { vatPct: 20 }]) assert.throws(() => suite.calculateSettlement([{ channel: 'A', sales: 1000, feePct: 0, vatPct: 10, ...values }]), RangeError);
});
test('settlement rejects unbounded row counts', () => assert.throws(() => suite.calculateSettlement(Array.from({ length: 101 }, () => ({ sales: 1, feePct: 1, vatPct: 10 }))), RangeError));
test('CSV neutralizes formula text while preserving numeric losses', () => {
  const output = suite.makeCsv([['=HYPERLINK("https://example.com")', ' @SUM(1)', '\t=1', -100, 'a,"b"\nline']]);
  assert.ok(output.startsWith('\uFEFF'));
  assert.ok(output.includes('"\'=HYPERLINK(""https://example.com"")"'));
  assert.ok(output.includes('"\' @SUM(1)"'));
  assert.ok(output.includes(',-100,'));
  assert.ok(output.includes('"a,""b""\nline"'));
});
test('simulator CSV contains target, ads, reserve, and channel comparison', () => {
  const output = suite.simulatorExport(suite.calculateSimulator(base));
  for (const label of ['목표 판매가', '손익분기 광고비', '충당금 가정', '채널 비교', '광고비 회수 배수']) assert.ok(output.includes(label));
});
test('comparison-only monthly overflow does not break a valid current scenario', () => {
  const input = { ...base, sell: 1e12, cost: 1e12, ship: 1e12, fixed: 1e12, ad: 1e12, units: 3000, feePct: 0 };
  const result = suite.calculateSimulator(input);
  assert.ok(suite.simulatorExport(result).includes('종합몰 예시'));
});
test('settlement export neutralizes malicious channel name', () => {
  const output = suite.settlementExport(suite.calculateSettlement([{ channel: '=1+1', sales: 11000, feePct: 0, vatPct: 10 }]));
  assert.ok(output.includes('"\'=1+1"'));
});
test('CSV guards every leading C0 control before formulas', () => {
  for (let code = 0; code < 32; code++) assert.ok(suite.makeCsv([[String.fromCharCode(code) + '=1+1']]).startsWith('\uFEFF"\''));
  assert.ok(suite.makeCsv([['\u007F=1+1']]).startsWith('\uFEFF"\''));
});
test('legacy VAT-exclusive cost converts once and old key stays intact', () => {
  const store = storage({ [suite.LEGACY_KEY]: JSON.stringify(legacy) });
  const first = suite.loadDraft(store);
  assert.equal(first.migrated, true); assert.equal(first.draft.simulator.cost, '13200'); assert.equal(first.draft.simulator.feePct, '5.8');
  assert.equal(first.draft.simulator.reserveEnabled, false); assert.equal(first.draft.simulator.reservePct, '0');
  assert.ok(first.draft.migrationNote.includes('10%'));
  assert.equal(suite.saveDraft(store, first.draft), true);
  assert.equal(suite.loadDraft(store).migrated, false);
  assert.equal(suite.loadDraft(store).draft.simulator.cost, '13200');
  assert.equal(store.getItem(suite.LEGACY_KEY), JSON.stringify(legacy));
});
test('new draft always wins over legacy settings', () => {
  const draft = suite.defaults(); draft.simulator.cost = '777';
  const store = storage({ [suite.LEGACY_KEY]: JSON.stringify(legacy), [suite.DRAFT_KEY]: JSON.stringify(draft) });
  assert.equal(suite.loadDraft(store).draft.simulator.cost, '777');
});
test('invalid new draft blocks overwrite and is not replaced with legacy', () => {
  const store = storage({ [suite.DRAFT_KEY]: '{bad', [suite.LEGACY_KEY]: JSON.stringify(legacy) });
  const result = suite.loadDraft(store);
  assert.equal(result.blocked, true); assert.equal(result.migrated, false); assert.equal(store.getItem(suite.DRAFT_KEY), '{bad');
});
test('legacy malformed/unsupported values are not silently clamped', () => {
  assert.throws(() => suite.migrateLegacy({ ...legacy, customFee: '-1' }));
  const result = suite.migrateLegacy({ ...legacy, costPrice: '1000000000000' });
  assert.equal(result.simulator.cost, '1100000000000');
  assert.throws(() => suite.calculateSimulator(result.simulator), RangeError);
});
test('actual custom fee wins over conflicting legacy preset', () => {
  const result = suite.migrateLegacy({ ...legacy, customFee: '7' });
  assert.equal(result.simulator.platform, 'custom'); assert.equal(result.simulator.feePct, '7');
});
test('storage refusal does not delete or rewrite original settings', () => {
  const store = storage({ [suite.LEGACY_KEY]: JSON.stringify(legacy) });
  store.setItem = () => { throw new Error('Quota'); };
  assert.equal(suite.saveDraft(store, suite.loadDraft(store).draft), false);
  assert.equal(store.getItem(suite.LEGACY_KEY), JSON.stringify(legacy));
});
test('unfinished numeric edits survive draft persistence', () => {
  const draft = suite.defaults(); draft.simulator.ad = ''; draft.settlement[0].sales = '';
  const store = storage(); assert.equal(suite.saveDraft(store, draft), true);
  assert.equal(suite.loadDraft(store).draft.simulator.ad, '');
  assert.equal(suite.loadDraft(store).draft.settlement[0].sales, '');
});

function createDOM() {
  const ids = new Map();
  function matches(node, selector) {
    if (selector.includes(',')) return selector.split(',').some(part => matches(node, part));
    if (selector === 'input' || selector === 'select' || selector === 'button') return node.tagName === selector;
    const attribute = selector.match(/^\[data-([\w-]+)="([^"]+)"\]$/);
    return attribute && node.dataset[attribute[1]] === attribute[2];
  }
  function createElement(tagName) {
    const element = { tagName, children: [], listeners: {}, dataset: {}, attrs: {}, style: {}, value: '', className: '', textContent: '',
      set id(value) { this._id = value; ids.set(value, this); }, get id() { return this._id; },
      append(...nodes) { nodes.forEach(node => { node.parent = this; this.children.push(node); }); },
      replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); },
      setAttribute(name, value) { this.attrs[name] = value; }, removeAttribute(name) { delete this.attrs[name]; },
      addEventListener(type, fn) { if (!this.listeners[type]) this.listeners[type] = []; this.listeners[type].push(fn); },
      dispatch(type) { (this.listeners[type] || []).forEach(fn => fn({ currentTarget: this, target: this })); },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(matches(child, selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
      focus() { this.focused = true; }, select() { this.selected = true; }, click() { this.dispatch('click'); },
      set innerHTML(_) { throw new Error('HTML injection sink used'); },
    };
    element.classList = { add(name) { element.className += ' ' + name; } };
    return element;
  }
  const body = createElement('body');
  ['page-simulator', 'page-settlement'].forEach(id => { const host = createElement('section'); host.id = id; body.append(host); });
  return { ids, body, readyState: 'complete', createElement, getElementById(id) { return ids.get(id); } };
}
function mountDOM(store = storage()) {
  const document = createDOM();
  const downloads = []; const revoked = [];
  const context = { document, localStorage: store, URL: { createObjectURL(blob) { downloads.push(blob); return 'blob:download'; }, revokeObjectURL(url) { revoked.push(url); } }, Blob, setTimeout(fn) { fn(); } };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(require.resolve('../suite-tools.js'), 'utf8'), context);
  return { document, store, context, downloads, revoked, get: id => document.getElementById(id) };
}
test('both real modules mount without HTML sinks or vendor libraries', () => {
  const view = mountDOM(); assert.ok(view.get('page-simulator').children.length > 3); assert.ok(view.get('page-settlement').children.length > 3);
  assert.notEqual(view.get('suite-result-profit').textContent, '—');
});
test('mount is idempotent and navigation does not reset inputs', () => {
  const view = mountDOM(); view.get('suite-cost').value = '999'; view.get('suite-cost').dispatch('input');
  const countBefore = view.get('page-simulator').children.length;
  view.context.MarginKitSuite.mount(); assert.equal(view.get('page-simulator').children.length, countBefore); assert.equal(view.get('suite-cost').value, '999');
  assert.equal(suite.loadDraft(view.store).draft.simulator.cost, '999');
});
test('invalid simulator values clear stale results and disable export', () => {
  const view = mountDOM(); view.get('suite-sell').value = '-1'; view.get('suite-sell').dispatch('input');
  assert.equal(view.get('suite-result-profit').textContent, '—');
  const button = view.get('page-simulator').querySelectorAll('button').find(item => item.textContent === '시뮬레이션 CSV 저장');
  assert.equal(button.disabled, true);
  assert.equal(view.get('suite-sim-copy').disabled, true);
});
test('manual fee input changes preset to custom', () => {
  const view = mountDOM(); view.get('suite-feePct').value = '7'; view.get('suite-feePct').dispatch('input');
  assert.equal(view.get('suite-platform').value, 'custom');
});
test('malicious settlement labels remain literal text and preserve edit focus', () => {
  const view = mountDOM(); const field = view.get('suite-row-0-channel');
  field.value = '<img src=x onerror=alert(1)>'; view.get('suite-settlement-rows').dispatch('input');
  assert.equal(view.get('suite-row-0-channel'), field);
  const table = view.get('page-settlement').children.at(-1).children.at(-1).children[0];
  const firstCell = table.children[1].children[0].children[0];
  assert.equal(firstCell.textContent, field.value); assert.equal(firstCell.children.length, 0);
});
test('invalid settlement blocks stale CSV', () => {
  const view = mountDOM(); view.get('suite-row-0-sales').value = '-1'; view.get('suite-settlement-rows').dispatch('input');
  assert.equal(view.get('suite-settlement-sales').textContent, '—');
  const button = view.get('page-settlement').querySelectorAll('button').find(item => item.textContent === '정산 요약 CSV 저장'); assert.equal(button.disabled, true);
  assert.equal(view.get('suite-settlement-copy').disabled, true);
});
test('CSV download uses Blob and releases URL without network', () => {
  const view = mountDOM(); const button = view.get('page-simulator').querySelectorAll('button').find(item => item.textContent === '시뮬레이션 CSV 저장');
  button.dispatch('click'); assert.equal(view.downloads.length, 1); assert.equal(view.revoked[0], 'blob:download');
});
test('malformed stored draft remains untouched after user input', () => {
  const store = storage({ [suite.DRAFT_KEY]: '{bad' }); const view = mountDOM(store);
  view.get('suite-cost').value = '555'; view.get('suite-cost').dispatch('input');
  assert.equal(store.getItem(suite.DRAFT_KEY), '{bad');
});
test('legacy migration persists new key without mutating core or legacy state', () => {
  const store = storage({ [suite.LEGACY_KEY]: JSON.stringify(legacy), 'marginkit_costs': 'private-core-data' });
  const view = mountDOM(store); assert.equal(view.get('suite-cost').value, '13200');
  assert.ok(store.getItem(suite.DRAFT_KEY)); assert.equal(store.getItem(suite.LEGACY_KEY), JSON.stringify(legacy)); assert.equal(store.getItem('marginkit_costs'), 'private-core-data');
});
test('declined reset leaves current and stored drafts untouched', () => {
  const view = mountDOM(); view.get('suite-cost').value = '777'; view.get('suite-cost').dispatch('input');
  view.context.confirm = () => false; view.get('page-simulator-reset').dispatch('click');
  assert.equal(view.get('suite-cost').value, '777'); assert.equal(suite.loadDraft(view.store).draft.simulator.cost, '777');
});
test('confirmed reset clears only suite draft and prevents legacy remigration', () => {
  const store = storage({ [suite.LEGACY_KEY]: JSON.stringify(legacy), core: 'preserve-core' });
  const view = mountDOM(store); view.get('suite-cost').value = '777'; view.get('suite-cost').dispatch('input');
  view.get('suite-row-0-channel').value = 'Private financial channel'; view.get('suite-settlement-rows').dispatch('input');
  view.context.confirm = () => true; view.get('page-settlement-reset').dispatch('click');
  assert.equal(view.get('suite-cost').value, suite.defaults().simulator.cost);
  assert.equal(view.get('suite-row-0-channel').value, '채널 1');
  assert.equal(store.getItem('core'), 'preserve-core'); assert.equal(store.getItem(suite.LEGACY_KEY), JSON.stringify(legacy));
  assert.equal(suite.loadDraft(store).migrated, false);
  assert.equal(store.getItem(suite.DRAFT_KEY).includes('Private financial channel'), false);
});
test('failed reset write preserves current input', () => {
  const view = mountDOM(); view.get('suite-cost').value = '777'; view.get('suite-cost').dispatch('input');
  view.store.setItem = () => { throw new Error('denied'); }; view.context.confirm = () => true;
  view.get('page-simulator-reset').dispatch('click'); assert.equal(view.get('suite-cost').value, '777');
});
(async () => {
  const fallback = mountDOM();
  await fallback.get('suite-sim-copy').listeners.click[0]();
  test('simulator clipboard fallback selects safe readonly text', () => {
    assert.equal(fallback.get('suite-sim-copy-text').selected, true);
    assert.equal(fallback.get('suite-sim-copy-text').readOnly, true);
    assert.ok(fallback.get('suite-sim-copy-text').value.includes('목표 잔액률'));
  });
  await fallback.get('suite-settlement-copy').listeners.click[0]();
  test('settlement clipboard fallback preserves summary', () => {
    assert.equal(fallback.get('suite-settlement-copy-text').selected, true);
    assert.ok(fallback.get('suite-settlement-copy-text').value.includes('수수료 차감 수령액'));
  });
  let copied;
  const success = mountDOM(); success.context.navigator = { clipboard: { async writeText(text) { copied = text; } } };
  await success.get('suite-sim-copy').listeners.click[0]();
  test('clipboard success copies current simulation summary', () => {
    assert.ok(copied.includes('[MarginKit 마진·광고 시뮬레이션]'));
    assert.equal(success.get('suite-sim-copy-text').hidden, true);
    assert.equal(success.get('suite-sim-export-status').textContent, '요약을 복사했습니다.');
  });
  let rejectCopy;
  const stale = mountDOM(); stale.context.navigator = { clipboard: { writeText() { return new Promise((_, reject) => rejectCopy = reject); } } };
  const pending = stale.get('suite-sim-copy').listeners.click[0]();
  stale.context.confirm = () => true; stale.get('page-simulator-reset').dispatch('click');
  rejectCopy(new Error('denied')); await pending;
  test('late clipboard rejection cannot resurrect a cleared financial summary', () => {
    assert.equal(stale.get('suite-sim-copy-text').hidden, true);
    assert.equal(stale.get('suite-sim-copy-text').value, '');
  });
  console.log(`${count} suite regression checks passed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
