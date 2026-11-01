/* Device-local Premium data and deterministic rules; no authentication or network side effects */
(function (global) {
  'use strict';
  const D = global.MKDecimal || (typeof module === 'object' && module.exports ? require('./exact-decimal.js') : null);
  const KEY = 'marginkit_premium_v1';
  const MAX_BYTES = 1000000;
  const LIMITS = Object.freeze({ rules: 100, scenarios: 100, months: 120, lines: 100, bytes: MAX_BYTES });
  const SIM_KEYS = ['sell', 'cost', 'ship', 'ad', 'fixed', 'feePct', 'units', 'targetPct', 'reservePct'];
  const metadata = new WeakMap();
  const compiledRuleSets = new WeakSet();
  function suite() {
    const api = global.MarginKitSuite || (typeof module === 'object' && module.exports ? require('./suite-tools.js') : null);
    if (!D || !api) throw new Error('정확한 계산 모듈을 사용할 수 없습니다');
    return api;
  }
  function object(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
      throw new TypeError(label + ' 형식이 올바르지 않습니다');
    }
    return value;
  }
  function text(value, max, label, empty = false) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || (!empty && !value.trim())) {
      throw new TypeError(label + ' 값을 확인해 주세요');
    }
    return value.trim();
  }
  function id(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) throw new TypeError('저장 항목 ID가 올바르지 않습니다');
    return value;
  }
  function norm(value) { return String(value ?? '').toLowerCase().replace(/[\s_\-()/·,\[\]]/g, '').trim(); }
  function decimal(value, label, max) {
    if (typeof value !== 'string' || value.length > 10000 || !value.trim()) throw new TypeError(label + ' 값을 확인해 주세요');
    let normalized;
    try { normalized = D.normalize(value.trim()); } catch (_) { throw new TypeError(label + ' 값을 확인해 주세요'); }
    if (D.compare(normalized, '0') < 0 || (max !== undefined && D.compare(normalized, max) > 0)) throw new RangeError(label + ' 범위를 확인해 주세요');
    return normalized;
  }
  function defaults() {
    return { version: 1, rules: [], scenarios: [], months: [], budget: { limit: '0', warnPct: '80' } };
  }
  function validateBudget(value) {
    object(value, ['limit', 'warnPct'], '광고비 한도');
    return { limit: decimal(value.limit, '광고비 한도', '1000000000000'), warnPct: decimal(value.warnPct, '주의 기준', '100') };
  }
  function validateRule(value) {
    object(value, ['id', 'field', 'match', 'value', 'costKey', 'enabled'], '매칭 규칙');
    if (!['sku', 'name'].includes(value.field) || !['exact', 'prefix', 'contains'].includes(value.match) || typeof value.enabled !== 'boolean') {
      throw new TypeError('매칭 규칙의 조건을 확인해 주세요');
    }
    const pattern = text(value.value, 200, '매칭할 문자');
    if (value.field === 'name' && !norm(pattern)) throw new TypeError('상품명 규칙에는 구분자 외의 문자가 필요합니다');
    const costKey = text(value.costKey, 1000, '원가 항목');
    if (!/^(sku|name):.+/.test(costKey)) throw new TypeError('원가 항목 키가 올바르지 않습니다');
    return { id: id(value.id), field: value.field, match: value.match, value: pattern, costKey, enabled: value.enabled };
  }
  function simulator(value) {
    object(value, [...SIM_KEYS, 'reserveEnabled', 'platform'], '시나리오 입력');
    if (typeof value.reserveEnabled !== 'boolean' || !['3.3', '5.8', '10.8', '15', 'custom'].includes(value.platform)) throw new TypeError('시나리오 선택값을 확인해 주세요');
    for (const key of SIM_KEYS) {
      if (typeof value[key] !== 'string' || value[key].length > 10000) throw new TypeError('시나리오 숫자 값을 확인해 주세요');
    }
    const api = suite();
    const cleaned = api.cleanDraft({ ...api.defaults(), simulator: value }).simulator;
    // Saved scenarios are executable snapshots, not incomplete editing drafts
    api.calculateSimulator(cleaned);
    // Validate the disabled reserve field too, so loading and enabling it stays safe
    api.calculateSimulator({ ...cleaned, reserveEnabled: true });
    return cleaned;
  }
  function validateScenario(value) {
    object(value, ['id', 'name', 'simulator'], '저장 시나리오');
    return { id: id(value.id), name: text(value.name, 80, '시나리오 이름'), simulator: simulator(value.simulator) };
  }
  function validateMonth(value) {
    object(value, ['id', 'month', 'name', 'lines'], '월별 정산');
    if (typeof value.month !== 'string' || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(value.month)) throw new TypeError('정산 월은 YYYY-MM 형식으로 입력해 주세요');
    if (!Array.isArray(value.lines) || value.lines.length < 1 || value.lines.length > LIMITS.lines) throw new RangeError('월별 정산은 채널 1~100개까지 저장할 수 있습니다');
    const lines = value.lines.map(line => {
      object(line, ['channel', 'sales', 'feePct', 'vatPct'], '정산 행');
      const result = { channel: text(line.channel, 100, '채널 이름') };
      for (const key of ['sales', 'feePct', 'vatPct']) {
        if (typeof line[key] !== 'string' || line[key].length > 10000) throw new TypeError('정산 숫자 값을 확인해 주세요');
        result[key] = line[key];
      }
      return result;
    });
    suite().calculateSettlement(lines);
    return { id: id(value.id), month: value.month, name: text(value.name, 80, '정산 이름'), lines };
  }
  function unique(items, key, label) {
    if (new Set(items.map(item => item[key])).size !== items.length) throw new TypeError(label + ' 중복 항목이 있습니다');
  }
  function validateDocument(value) {
    object(value, ['version', 'rules', 'scenarios', 'months', 'budget'], 'Premium 저장');
    if (value.version !== 1) throw new TypeError('지원하지 않는 Premium 저장 버전입니다');
    if (JSON.stringify(value).length > MAX_BYTES) throw new RangeError('Premium 저장 크기가 한도를 초과했습니다');
    for (const key of ['rules', 'scenarios', 'months']) {
      if (!Array.isArray(value[key]) || value[key].length > LIMITS[key]) throw new RangeError(key + ' 저장 개수가 한도를 초과했습니다');
    }
    const result = { version: 1, rules: value.rules.map(validateRule), scenarios: value.scenarios.map(validateScenario), months: value.months.map(validateMonth), budget: validateBudget(value.budget) };
    for (const key of ['rules', 'scenarios', 'months']) unique(result[key], 'id', key);
    unique(result.months, 'month', '월별 정산');
    return result;
  }
  function compileRules(rules) {
    if (!Array.isArray(rules) || rules.length > LIMITS.rules) throw new TypeError('규칙 매칭 입력이 올바르지 않습니다');
    const compiled = Object.freeze({
      rules: Object.freeze(rules.map(raw => {
        const rule = validateRule(raw);
        return Object.freeze({ ...rule, pattern: rule.field === 'sku' ? rule.value : norm(rule.value) });
      })),
      ruleCount: rules.length
    });
    compiledRuleSets.add(compiled);
    return compiled;
  }
  function matchCompiled(product, compiled, validCostKeys) {
    if (!product || typeof product !== 'object' || !compiledRuleSets.has(compiled)) throw new TypeError('검증된 원가 규칙을 사용해 주세요');
    const matches = [];
    let skuTarget, nameTarget;
    for (const rule of compiled.rules) {
      if (!rule.enabled) continue;
      // Normalize at most once per field, not once per rule for every product
      const target = rule.field === 'sku'
        ? (skuTarget ??= String(product.sku ?? '').trim())
        : (nameTarget ??= norm(product.product));
      const pattern = rule.pattern;
      if (!target || !pattern) continue;
      if (rule.match === 'exact' ? target === pattern : rule.match === 'prefix' ? target.startsWith(pattern) : target.includes(pattern)) matches.push(rule);
    }
    const costKeys = [...new Set(matches.map(rule => rule.costKey))];
    const result = { status: 'none', costKey: null, ruleIds: matches.map(rule => rule.id), costKeys };
    if (!costKeys.length) return result;
    if (costKeys.length > 1) return { ...result, status: 'conflict' };
    const key = costKeys[0];
    let exists = true;
    if (validCostKeys !== undefined) {
      if (validCostKeys instanceof Set || validCostKeys instanceof Map) exists = validCostKeys.has(key);
      else if (Array.isArray(validCostKeys)) exists = validCostKeys.includes(key);
      else throw new TypeError('등록 원가 키 목록이 올바르지 않습니다');
    }
    return { ...result, status: exists ? 'matched' : 'missing', costKey: exists ? key : null };
  }
  function matchRules(product, rules, validCostKeys) { return matchCompiled(product, compileRules(rules), validCostKeys); }
  const EMPTY_COMPILED = compileRules([]);
  function compareScenarios(values) {
    if (!Array.isArray(values) || values.length > LIMITS.scenarios) throw new RangeError('시나리오 개수를 확인해 주세요');
    const scenarios = values.map(validateScenario);
    unique(scenarios, 'id', '시나리오');
    return scenarios.map(item => ({ id: item.id, name: item.name, result: suite().calculateSimulator(item.simulator) }));
  }
  function monthIndex(month) { const [year, number] = month.split('-').map(Number); return year * 12 + number - 1; }
  function timeline(values) {
    if (!Array.isArray(values) || values.length > LIMITS.months) throw new RangeError('정산 월 개수를 확인해 주세요');
    const months = values.map(validateMonth).sort((a, b) => a.month.localeCompare(b.month));
    unique(months, 'id', '월별 정산'); unique(months, 'month', '월별 정산');
    let previous = null;
    const cumulative = { sales: '0', fee: '0', take: '0' };
    return months.map(item => {
      const result = suite().calculateSettlement(item.lines);
      const change = previous ? Object.fromEntries(['sales', 'fee', 'take'].map(key => [key, D.sub(result.totals.exact[key], previous.result.totals.exact[key])])) : null;
      for (const key of ['sales', 'fee', 'take']) cumulative[key] = D.add(cumulative[key], result.totals.exact[key]);
      const entry = { id: item.id, month: item.month, name: item.name, result, change, previousMonth: previous?.month ?? null, gapMonths: previous ? monthIndex(item.month) - monthIndex(previous.month) : null, cumulative: { ...cumulative } };
      previous = entry;
      return entry;
    });
  }
  function budgetStatus(value, rawBudget) {
    const spend = decimal(value, '광고 지출');
    const budget = validateBudget(rawBudget);
    const warningAt = D.mul(D.mul(budget.limit, budget.warnPct), '0.01');
    const difference = D.sub(budget.limit, spend);
    const status = D.compare(budget.limit, '0') === 0 ? 'disabled' : D.compare(spend, budget.limit) > 0 ? 'exceeded' : D.compare(spend, warningAt) >= 0 ? 'warning' : 'ok';
    return { status, spend, limit: budget.limit, warnPct: budget.warnPct, warningAt, remaining: D.compare(difference, '0') < 0 ? '0' : difference, over: D.compare(difference, '0') < 0 ? D.sub('0', difference) : '0', usagePct: status === 'disabled' ? null : D.percentage(spend, budget.limit) };
  }
  function load(storage, key = KEY) {
    const result = { document: defaults(), revision: undefined, blocked: false, warning: '' };
    const state = { storage, key, raw: undefined, blocked: false };
    if (typeof key !== 'string' || !key || key.length > 200) throw new TypeError('저장소 키가 올바르지 않습니다');
    try {
      if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') throw new Error('storage');
      state.raw = storage.getItem(key);
      if (state.raw !== null) {
        if (typeof state.raw !== 'string' || state.raw.length > MAX_BYTES) throw new Error('size');
        result.document = validateDocument(JSON.parse(state.raw));
      }
    } catch (_) {
      state.blocked = result.blocked = true;
      result.warning = 'Premium 저장 데이터를 읽지 못해 원본 보호를 위해 덮어쓰기를 중지했습니다';
    }
    result.revision = state.raw;
    metadata.set(result, state);
    return result;
  }
  function save(storage, value, loaded, key = KEY) {
    const origin = loaded && metadata.get(loaded);
    const fail = (code, error) => {
      if (origin) loaded.warning = error;
      return { ok: false, code, error };
    };
    if (!origin || origin.storage !== storage || origin.key !== key) return fail('unloaded', '같은 저장소에서 Premium 데이터를 먼저 불러와 주세요');
    if (origin.blocked) return fail('blocked', '저장 데이터 원본을 보호하기 위해 덮어쓰기를 중지했습니다');
    let cleaned;
    try { cleaned = validateDocument(value); } catch (error) { return fail('invalid', error.message || '저장할 데이터를 확인해 주세요'); }
    let serialized;
    try {
      const current = storage.getItem(key);
      if (current !== origin.raw) return fail('conflict', '다른 탭에서 Premium 데이터가 변경되었습니다 새로고침 후 다시 시도해 주세요');
      serialized = JSON.stringify(cleaned);
      storage.setItem(key, serialized);
    } catch (_) { return fail('storage', 'Premium 데이터를 저장하지 못했습니다 저장 공간과 브라우저 설정을 확인해 주세요'); }
    // Publish the new document only after the storage write succeeds
    origin.raw = serialized;
    loaded.document = cleaned;
    loaded.revision = serialized;
    loaded.blocked = false;
    loaded.warning = '';
    return { ok: true, document: cleaned, revision: serialized };
  }
  const api = { KEY, LIMITS, EMPTY_COMPILED, defaults, validateDocument, validateRule, validateScenario, validateMonth, validateBudget, compileRules, matchCompiled, matchRules, compareScenarios, timeline, budgetStatus, norm, load, save };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MarginKitPremiumCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
