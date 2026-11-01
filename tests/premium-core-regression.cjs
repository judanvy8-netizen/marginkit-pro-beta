'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../premium-core.js');
const suite = require('../suite-tools.js');
const copy = value => JSON.parse(JSON.stringify(value));
function rule(id = 'rule1', overrides = {}) {
  return { id, field: 'name', match: 'contains', value: '에코 백', costKey: 'sku:BAG', enabled: true, ...overrides };
}
function scenario(id = 'scenario1', overrides = {}) {
  return { id, name: id, simulator: { ...suite.defaults().simulator, ...overrides } };
}
function month(value, sales, id = value.replace('-', ''), overrides = {}) {
  return { id, month: value, name: value + ' 정산', lines: [{ channel: '채널 1', sales, feePct: '0', vatPct: '0' }], ...overrides };
}
function memory(initial = null) {
  const entries = new Map(initial === null ? [] : [[core.KEY, initial]]);
  return { getItem: key => entries.has(key) ? entries.get(key) : null, setItem: (key, value) => entries.set(key, value), entries };
}
test('matching uses the existing name normalization and does not fold SKU case', () => {
  assert.equal(core.norm(' Eco-[Bag] / (Blue) · '), 'ecobagblue');
  assert.equal(core.matchRules({ product: '에코-[백] / 블루' }, [rule()], new Set(['sku:BAG'])).costKey, 'sku:BAG');
  const sku = rule('skuRule', { field: 'sku', match: 'prefix', value: 'ABC-', costKey: 'sku:ABC' });
  assert.equal(core.matchRules({ sku: 'ABC-001' }, [sku], new Set(['sku:ABC'])).status, 'matched');
  assert.equal(core.matchRules({ sku: 'abc-001' }, [sku], new Set(['sku:ABC'])).status, 'none');
});
test('different matching targets conflict without silently choosing one', () => {
  const result = core.matchRules({ product: '에코백' }, [rule(), rule('rule2', { costKey: 'sku:OTHER' })], new Set(['sku:BAG']));
  assert.equal(result.status, 'conflict');
  assert.equal(result.costKey, null);
  assert.deepEqual(result.ruleIds, ['rule1', 'rule2']);
  assert.deepEqual(result.costKeys, ['sku:BAG', 'sku:OTHER']);
});
test('multiple matching rules for the same target are unambiguous', () => {
  const result = core.matchRules({ product: '에코백' }, [rule(), rule('rule2', { match: 'exact' })], new Set(['sku:BAG']));
  assert.equal(result.status, 'matched');
  assert.equal(result.costKey, 'sku:BAG');
});
test('missing cost targets and disabled rules never produce an applicable match', () => {
  const missing = core.matchRules({ product: '에코백' }, [rule()], new Set());
  assert.equal(missing.status, 'missing');
  assert.equal(missing.costKey, null);
  assert.equal(core.matchRules({ product: '에코백' }, [rule('disabled', { enabled: false })]).status, 'none');
});
test('empty normalized patterns, unknown rule fields and excessive rules fail validation', () => {
  assert.throws(() => core.validateRule(rule('empty', { value: ' - /[]_' })));
  assert.throws(() => core.validateRule({ ...rule(), expression: '.*' }));
  assert.throws(() => core.validateRule(rule('bad', { match: 'regex' })));
  assert.throws(() => core.matchRules({ product: '에코백' }, Array.from({ length: 101 }, (_, n) => rule('r' + n))));
});
test('compiled rule sets are deep frozen independent copies and reject forged brands', () => {
  const raw = [rule()];
  const compiled = core.compileRules(raw);
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.rules), true);
  assert.equal(Object.isFrozen(compiled.rules[0]), true);
  assert.equal(compiled.rules[0].pattern, '에코백');
  raw[0].value = '다른 이름'; raw[0].costKey = 'sku:OTHER'; raw.push(rule('new'));
  assert.equal(compiled.ruleCount, 1);
  assert.equal(core.matchCompiled({ product: '에코 백' }, compiled).costKey, 'sku:BAG');
  assert.throws(() => { compiled.rules[0].pattern = ''; }, TypeError);
  assert.throws(() => { compiled.rules.push(rule()); }, TypeError);
  assert.throws(() => core.matchCompiled({ product: '에코백' }, { rules: compiled.rules, ruleCount: 1 }));
  assert.throws(() => core.matchCompiled({ product: '에코백' }, JSON.parse(JSON.stringify(compiled))));
  assert.throws(() => core.matchCompiled({ product: '에코백' }, Object.create(compiled)));
  assert.throws(() => core.compileRules([rule('bad', { value: '' })]));
  assert.equal(core.matchCompiled({ product: '에코백' }, core.EMPTY_COMPILED).status, 'none');
});
test('compiled matching preserves conflict, missing-target, disabled, and case-sensitive behavior', () => {
  const rules = [rule(), rule('second', { costKey: 'sku:OTHER' }), rule('disabled', { enabled: false }), rule('sku', { field: 'sku', value: 'ABC', match: 'exact', costKey: 'sku:CODE' })];
  const compiled = core.compileRules(rules);
  for (const product of [{ product: '에코 백' }, { product: 'none', sku: 'ABC' }, { product: 'none', sku: 'abc' }]) {
    for (const keys of [new Set(), new Map([['sku:CODE', {}]]), ['sku:BAG', 'sku:OTHER']]) {
      assert.deepEqual(core.matchCompiled(product, compiled, keys), core.matchRules(product, rules, keys));
    }
  }
});
test('compiled matching normalizes each product field once while scanning 100 rules', () => {
  const rules = Array.from({ length: 100 }, (_, index) => rule('r' + index, { field: index % 2 ? 'sku' : 'name', value: 'absent' + index }));
  const compiled = core.compileRules(rules);
  let skuReads = 0, nameReads = 0;
  const product = { get sku() { skuReads++; return 'SKU'; }, get product() { nameReads++; return 'Different product'; } };
  for (let index = 0; index < 1000; index++) assert.equal(core.matchCompiled(product, compiled).status, 'none');
  assert.equal(skuReads, 1000); assert.equal(nameReads, 1000);
});
test('saved scenarios preserve exact decimal text and calculate without Number conversion', () => {
  const original = scenario('tiny', { sell: '0.3000000000000000000000000001', cost: '0.1', ship: '0', ad: '0.1', fixed: '0', feePct: '0', units: '3' });
  assert.equal(core.validateScenario(original).simulator.sell, original.simulator.sell);
  const row = core.compareScenarios([original])[0];
  assert.equal(row.result.exact.profit, '0.1000000000000000000000000001');
  assert.equal(row.result.exact.monthly, '0.3000000000000000000000000003');
});
test('saved scenarios reject incomplete inputs and invalid disabled reserve fields', () => {
  assert.throws(() => core.validateScenario(scenario('empty', { cost: '' })));
  assert.throws(() => core.validateScenario(scenario('reserve', { reservePct: 'NaN', reserveEnabled: false })));
  assert.throws(() => core.validateScenario(scenario('negative', { sell: '-1' })));
  assert.throws(() => core.validateScenario(scenario('platform', { platform: 'injected' })));
});
test('monthly timelines sort chronologically, retain gaps and use exact deltas/totals', () => {
  const rows = core.timeline([month('2026-03', '0.3'), month('2025-12', '0.1'), month('2026-01', '0.2')]);
  assert.deepEqual(rows.map(row => row.month), ['2025-12', '2026-01', '2026-03']);
  assert.equal(rows[0].change, null);
  assert.equal(rows[1].change.sales, '0.1');
  assert.equal(rows[2].change.take, '0.1');
  assert.equal(rows[2].previousMonth, '2026-01');
  assert.equal(rows[2].gapMonths, 2);
  assert.equal(rows[2].cumulative.sales, '0.6');
});
test('monthly snapshots reject duplicated months, malformed dates and invalid VAT', () => {
  assert.throws(() => core.timeline([month('2026-01', '1'), month('2026-01', '2', 'different')]));
  assert.throws(() => core.validateMonth(month('2026-13', '1')));
  assert.throws(() => core.validateMonth(month('0000-01', '1')));
  assert.throws(() => core.validateMonth(month('2026-01', '1', 'bad', { lines: [{ channel: 'x', sales: '1', feePct: '0', vatPct: '3' }] })));
});
test('budget thresholds compare exact values at and beyond the limit', () => {
  const budget = { limit: '0.3', warnPct: '80' };
  assert.equal(core.budgetStatus('0.23999999999999999999999999', budget).status, 'ok');
  assert.equal(core.budgetStatus('0.24', budget).status, 'warning');
  assert.equal(core.budgetStatus('0.3', budget).status, 'warning');
  const over = core.budgetStatus('0.30000000000000000001', budget);
  assert.equal(over.status, 'exceeded');
  assert.equal(over.over, '0.00000000000000000001');
  assert.equal(over.remaining, '0');
  assert.equal(core.budgetStatus('4', { limit: '0', warnPct: '80' }).status, 'disabled');
  assert.throws(() => core.budgetStatus('-1', budget));
  assert.throws(() => core.budgetStatus('1', { limit: '2', warnPct: '101' }));
});
test('document validation returns independent bounded canonical data', () => {
  const doc = core.defaults(); doc.scenarios.push(scenario()); doc.rules.push(rule()); doc.months.push(month('2026-01', '10'));
  const clean = core.validateDocument(doc);
  clean.scenarios[0].simulator.sell = '2';
  assert.notEqual(doc.scenarios[0].simulator.sell, '2');
  assert.throws(() => core.validateDocument({ ...doc, teamToken: 'not a cloud credential store' }));
  assert.throws(() => core.validateDocument({ ...doc, rules: [rule(), rule()] }));
  assert.throws(() => core.validateDocument({ ...doc, scenarios: Array.from({ length: 101 }, (_, n) => scenario('s' + n)) }));
});
test('first save and reload keep original decimal strings without mutating caller data', () => {
  const storage = memory(); const loaded = core.load(storage); const draft = copy(loaded.document);
  draft.scenarios.push(scenario('saved', { sell: '12.340000000000000001' }));
  const result = core.save(storage, draft, loaded);
  assert.equal(result.ok, true);
  assert.equal(result.document, loaded.document);
  draft.scenarios[0].name = 'changed after save';
  assert.equal(loaded.document.scenarios[0].name, 'saved');
  assert.equal(core.load(storage).document.scenarios[0].simulator.sell, '12.340000000000000001');
});
test('a stale tab cannot overwrite a newer Premium document', () => {
  const storage = memory(); const first = core.load(storage); const stale = core.load(storage);
  const doc = copy(first.document); doc.rules.push(rule());
  assert.equal(core.save(storage, doc, first).ok, true);
  const written = storage.getItem(core.KEY);
  const second = copy(stale.document); second.scenarios.push(scenario());
  const result = core.save(storage, second, stale);
  assert.equal(result.ok, false); assert.equal(result.code, 'conflict');
  assert.equal(storage.getItem(core.KEY), written); assert.equal(stale.document.scenarios.length, 0);
});
test('malformed and oversized stored data stay protected and are never overwritten', () => {
  for (const raw of ['{broken', JSON.stringify({ version: 2 }), ' '.repeat(core.LIMITS.bytes + 1)]) {
    const storage = memory(raw); const loaded = core.load(storage);
    assert.equal(loaded.blocked, true);
    assert.equal(core.save(storage, core.defaults(), loaded).code, 'blocked');
    assert.equal(storage.getItem(core.KEY), raw);
  }
});
test('quota errors leave both stored and loaded data unchanged', () => {
  const storage = memory(JSON.stringify(core.defaults())); const loaded = core.load(storage); const raw = storage.getItem(core.KEY);
  storage.setItem = () => { throw new Error('QuotaExceededError'); };
  const draft = copy(loaded.document); draft.rules.push(rule());
  assert.equal(core.save(storage, draft, loaded).code, 'storage');
  assert.equal(storage.getItem(core.KEY), raw); assert.equal(loaded.document.rules.length, 0); assert.equal(loaded.revision, raw);
});
test('unloaded, cross-storage and read-blocked saves cannot overwrite data', () => {
  const storage = memory(); const loaded = core.load(storage); const other = memory();
  assert.equal(core.save(storage, core.defaults(), {}).code, 'unloaded');
  assert.equal(core.save(other, core.defaults(), loaded).code, 'unloaded');
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('must not write'); } };
  const unreadable = core.load(blocked);
  assert.equal(unreadable.blocked, true); assert.equal(core.save(blocked, core.defaults(), unreadable).code, 'blocked');
});
test('separate in-memory demo storage never reads or overwrites the real document', () => {
  const real = memory(); const realLoaded = core.load(real); const realDoc = copy(realLoaded.document); realDoc.rules.push(rule()); core.save(real, realDoc, realLoaded);
  const prior = real.getItem(core.KEY); const demo = memory(); const demoLoaded = core.load(demo);
  assert.equal(demoLoaded.document.rules.length, 0);
  const demoDoc = copy(demoLoaded.document); demoDoc.scenarios.push(scenario('demo')); assert.equal(core.save(demo, demoDoc, demoLoaded).ok, true);
  assert.equal(real.getItem(core.KEY), prior); assert.equal(core.load(real).document.scenarios.length, 0);
});
