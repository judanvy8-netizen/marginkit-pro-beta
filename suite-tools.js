(function (global) {
  'use strict';
  const DRAFT_KEY = 'marginkit_suite_draft_v1';
  const LEGACY_KEY = 'markit_enterprise_inputs_v1';
  const MAX_MONEY = 1e12;
  const MAX_UNITS = 1e9;
  const CHANNELS = [
    { name: '스마트스토어 예시', rate: 3.3 }, { name: '쿠팡 예시', rate: 5.8 },
    { name: '11번가·G마켓 예시', rate: 10.8 }, { name: '종합몰 예시', rate: 15 },
  ];
  const SIM_KEYS = ['sell', 'cost', 'ship', 'ad', 'fixed', 'feePct', 'units', 'targetPct', 'reservePct'];
  function defaults() {
    return { version: 1, simulator: { sell: '29900', cost: '13200', ship: '3000', ad: '2500', fixed: '500', feePct: '5.8', units: '200', targetPct: '25', reservePct: '0', reserveEnabled: false, platform: '5.8' }, settlement: [{ channel: '채널 1', sales: '0', feePct: '3.3', vatPct: '10' }], migrationNote: '' };
  }
  function number(raw, key, max = MAX_MONEY, integer = false) {
    if ((typeof raw !== 'number' && typeof raw !== 'string') || String(raw).trim() === '') throw new RangeError(key);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > max || (integer && !Number.isInteger(value))) throw new RangeError(key);
    return value;
  }
  function decimalRatio(value) {
    if (!Number.isFinite(Number(value)) || Number(value) < 0) throw new RangeError('price assumption');
    const match = String(value).match(/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (!match) throw new RangeError('price assumption');
    const fraction = match[2] || '';
    const exponent = Number(match[3] || 0) - fraction.length;
    let numerator = BigInt(match[1] + fraction);
    let denominator = 1n;
    if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
    else denominator = 10n ** BigInt(-exponent);
    return { n: numerator, d: denominator };
  }
  function exactTargetPrice(costs, rates, scale) {
    // Decimal-rational arithmetic avoids binary cancellation/ceil errors at
    // exact won boundaries. Percentage values are divided by 100 exactly.
    let fixed = { n: 0n, d: 1n };
    for (const amount of costs) {
      const part = decimalRatio(amount);
      fixed = { n: fixed.n * part.d + part.n * fixed.d, d: fixed.d * part.d };
    }
    let remaining = { n: 1n, d: 1n };
    for (const rate of rates) {
      const part = decimalRatio(rate); part.d *= BigInt(scale);
      remaining = { n: remaining.n * part.d - part.n * remaining.d, d: remaining.d * part.d };
    }
    if (fixed.n === 0n) return remaining.n >= 0n ? 1 : null;
    if (remaining.n <= 0n) return null;
    const numerator = fixed.n * remaining.d;
    const denominator = fixed.d * remaining.n;
    const integerPrice = (numerator + denominator - 1n) / denominator;
    return integerPrice <= BigInt(MAX_MONEY) ? Number(integerPrice) : null;
  }
  function recommendedPrice(fixed, feeRate, reserveRate, targetRate) {
    return exactTargetPrice([fixed], [feeRate, reserveRate, targetRate], 1);
  }
  function calculateSimulator(raw) {
    const input = {};
    if (typeof raw.reserveEnabled !== 'boolean') throw new RangeError('reserveEnabled');
    SIM_KEYS.forEach((key) => input[key] = key === 'reservePct' && !raw.reserveEnabled ? 0 : number(raw[key], key, key === 'units' ? MAX_UNITS : /Pct$/.test(key) ? 100 : MAX_MONEY, key === 'units'));
    input.reserveEnabled = raw.reserveEnabled;
    const feeRate = input.feePct / 100;
    const reserveRate = input.reserveEnabled ? input.reservePct / 100 : 0;
    const fee = input.sell * feeRate;
    const reserve = input.sell * reserveRate;
    const baseCosts = input.cost + input.ship + input.fixed;
    const beforeAd = input.sell - fee - reserve - baseCosts;
    const profit = beforeAd - input.ad;
    const cashProfit = profit + reserve;
    const monthly = profit * input.units;
    const monthlyRevenue = input.sell * input.units;
    if (Math.abs(monthly) > Number.MAX_SAFE_INTEGER || monthlyRevenue > Number.MAX_SAFE_INTEGER) throw new RangeError('units');
    return { ...input, fee, reserve, beforeAd, profit, cashProfit, monthly, monthlyRevenue,
      margin: input.sell > 0 ? profit / input.sell : null,
      adMultiple: input.ad > 0 ? beforeAd / input.ad : null,
      breakEvenAd: beforeAd >= 0 ? beforeAd : null,
      targetPrice: exactTargetPrice([input.cost, input.ship, input.fixed, input.ad], [input.feePct, input.reserveEnabled ? input.reservePct : 0, input.targetPct], 100),
      totalCost: baseCosts + input.ad + fee + reserve,
    };
  }
  function calculateSettlement(lines) {
    if (!Array.isArray(lines) || lines.length < 1 || lines.length > 100) throw new RangeError('lines');
    const rows = lines.map((line, index) => {
      const sales = number(line.sales, `row-${index}-sales`);
      const feePct = number(line.feePct, `row-${index}-feePct`, 100);
      const vatPct = number(line.vatPct, `row-${index}-vatPct`, 100);
      if (![0, 10].includes(vatPct)) throw new RangeError(`row-${index}-vatPct`);
      const channel = String(line.channel || '채널').replace(/[\r\n\t]/g, ' ').slice(0, 100);
      const fee = sales * feePct / 100;
      const supply = sales / (1 + vatPct / 100);
      return { channel, sales, feePct, vatPct, fee, supply, vat: sales - supply, take: sales - fee };
    });
    const totals = rows.reduce((sum, row) => ({ sales: sum.sales + row.sales, fee: sum.fee + row.fee, supply: sum.supply + row.supply, vat: sum.vat + row.vat, take: sum.take + row.take }), { sales: 0, fee: 0, supply: 0, vat: 0, take: 0 });
    return { rows, totals };
  }
  function csvCell(value) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('Nonfinite CSV number');
      return String(value);
    }
    let text = String(value == null ? '' : value);
    if (/^[\s\u0000-\u001f\u007f\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function makeCsv(rows) { return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'); }
  function simulatorExport(result) {
    return makeCsv([
      ['MarginKit 마진·광고 시뮬레이터', 'VAT 포함 실제 수입·지출 기준'],
      ['항목', '값', '단위'],
      ['판매가', result.sell, '원'], ['매입 원가', result.cost, '원'], ['배송·부자재', result.ship, '원'],
      ['광고비', result.ad, '원'], ['배분 고정비', result.fixed, '원'], ['수수료율', result.feePct, '%'],
      ['충당금 사용', result.reserveEnabled ? '사용' : '미사용', ''], ['충당금 가정', result.reserveEnabled ? result.reservePct : 0, '매출 대비 %'],
      ['건당 수수료', result.fee, '원'], ['건당 충당금', result.reserve, '원'], ['충당금 전 현금 잔액', result.cashProfit, '원'],
      ['충당금 반영 건당 잔액', result.profit, '원'], ['잔액률', result.margin === null ? '해당 없음' : result.margin * 100, '%'],
      ['월 판매 수량', result.units, '개'], ['월 예상 잔액', result.monthly, '원'],
      ['광고비 회수 배수', result.adMultiple === null ? '광고비 0원으로 해당 없음' : result.adMultiple, '배'],
      ['손익분기 광고비', result.breakEvenAd === null ? '광고비 조정만으로 달성 불가' : result.breakEvenAd, '원'],
      ['목표 잔액률', result.targetPct, '%'], ['목표 판매가', result.targetPrice === null ? '가정 범위에서 달성 불가' : result.targetPrice, '원'],
      ['안내', '추정 시나리오입니다. 충당금은 사용자 가정이며 실제 납부세액 또는 세무 신고 금액이 아닙니다.'],
      [], ['채널 비교 (요율은 예시)', '수수료율 (%)', '건당 잔액 (원)', '잔액률 (%)'],
      ...CHANNELS.map(channel => { const row = calculateSimulator({ ...result, feePct: channel.rate, units: 0 }); return [channel.name, channel.rate, row.profit, row.margin === null ? '해당 없음' : row.margin * 100]; }),
    ]);
  }
  function settlementExport(result) {
    return makeCsv([
      ['MarginKit 월간 수기 정산', '정산 파일 분석과 별개로 직접 입력한 요약'],
      ['채널', '매출 VAT 포함 (원)', '수수료율 (%)', '가정 VAT (%)', '수수료 (원)', '공급가액 (원)', '매출 VAT 성분 (원)', '수수료 차감 수령액 (원)'],
      ...result.rows.map(row => [row.channel, row.sales, row.feePct, row.vatPct, row.fee, row.supply, row.vat, row.take]),
      ['합계', result.totals.sales, '', '', result.totals.fee, result.totals.supply, result.totals.vat, result.totals.take],
      ['안내', '수령액은 원가·배송비·세금 차감 전입니다. 매입세액/공제 미반영으로 매출 VAT 성분은 납부세액이 아닙니다.'],
    ]);
  }
  function simulatorSummary(result) {
    const won = value => Math.round(value).toLocaleString('ko-KR') + '원';
    return [
      '[MarginKit 마진·광고 시뮬레이션]',
      `판매가 ${won(result.sell)} / 매입 원가 ${won(result.cost)} (모두 VAT 포함)`,
      `배송 ${won(result.ship)} / 광고 ${won(result.ad)} / 배분 고정비 ${won(result.fixed)}`,
      `수수료율 ${result.feePct}% / 충당금 가정 ${result.reserveEnabled ? result.reservePct : 0}%`,
      `건당 잔액 ${won(result.profit)} / 잔액률 ${result.margin === null ? '해당 없음' : (result.margin * 100).toFixed(1) + '%'}`,
      `월 ${result.units.toLocaleString('ko-KR')}개 기준 예상 잔액 ${won(result.monthly)}`,
      `광고비 회수 배수 ${result.adMultiple === null ? '광고비 0원으로 해당 없음' : result.adMultiple.toFixed(2) + '배'}`,
      `손익분기 광고비 ${result.breakEvenAd === null ? '광고비 조정만으로 달성 불가' : won(result.breakEvenAd)}`,
      `목표 잔액률 ${result.targetPct}% 판매가 ${result.targetPrice === null ? '달성 불가' : won(result.targetPrice)}`,
      '※ 충당금은 사용자가 선택한 가정이며 실제 납부세액 또는 세무 신고 금액이 아닙니다.',
    ].join('\n');
  }
  function settlementSummary(result) {
    const won = value => Math.round(value).toLocaleString('ko-KR') + '원';
    return [
      '[MarginKit 월간 수기 정산]',
      ...result.rows.map(row => `${row.channel}: 매출 ${won(row.sales)} / 수수료 ${won(row.fee)} / 수령액 ${won(row.take)} / VAT ${row.vatPct}% 가정`),
      `총 매출 ${won(result.totals.sales)} / 총 수수료 ${won(result.totals.fee)}`,
      `매출에 포함된 VAT 성분 ${won(result.totals.vat)} / 수수료 차감 수령액 ${won(result.totals.take)}`,
      '※ 직접 입력한 요약입니다. 수령액은 원가·배송비·세금 차감 전이며 VAT 성분은 실제 납부세액이 아닙니다.',
    ].join('\n');
  }
  function cleanDraft(value) {
    if (!value || value.version !== 1 || !value.simulator || !Array.isArray(value.settlement) || value.settlement.length < 1 || value.settlement.length > 100) throw new TypeError('Invalid saved draft');
    const draft = defaults();
    SIM_KEYS.forEach(key => {
      if (typeof value.simulator[key] !== 'string' || value.simulator[key].length > 40) throw new TypeError('Invalid saved field');
      draft.simulator[key] = value.simulator[key];
    });
    draft.simulator.reserveEnabled = value.simulator.reserveEnabled === true;
    draft.simulator.platform = ['3.3', '5.8', '10.8', '15', 'custom'].includes(value.simulator.platform) ? value.simulator.platform : 'custom';
    draft.settlement = value.settlement.map(line => {
      if (!line || typeof line !== 'object') throw new TypeError('Invalid saved row');
      const row = {};
      ['channel', 'sales', 'feePct', 'vatPct'].forEach(key => {
        if (typeof line[key] !== 'string' || line[key].length > (key === 'channel' ? 100 : 40)) throw new TypeError('Invalid saved row value');
        row[key] = line[key];
      });
      return row;
    });
    draft.migrationNote = typeof value.migrationNote === 'string' ? value.migrationNote.slice(0, 500) : '';
    return draft;
  }
  function migrateLegacy(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid legacy settings');
    const draft = defaults();
    const mapping = { sellPrice: 'sell', costPrice: 'cost', shippingFee: 'ship', adFee: 'ad', fixedCostPerUnit: 'fixed', customFee: 'feePct', monthlyVolume: 'units', targetMarginRate: 'targetPct' };
    for (const [oldKey, newKey] of Object.entries(mapping)) {
      const amount = number(value[oldKey], oldKey, newKey === 'units' ? MAX_UNITS : /Pct$/.test(newKey) ? 100 : MAX_MONEY, newKey === 'units');
      if (typeof value[oldKey] !== 'string' || value[oldKey].length > 40) throw new TypeError('Invalid legacy field');
      draft.simulator[newKey] = String(newKey === 'cost' ? Math.round(amount * 110) / 100 : amount);
    }
    if (!['0.033', '0.058', '0.108', '0.15', 'custom'].includes(value.platform) || !['general', 'simple_retail', 'corporate'].includes(value.taxType)) throw new TypeError('Invalid legacy option');
    const preset = String(Number((Number(value.platform) * 100).toFixed(1)));
    draft.simulator.platform = preset === draft.simulator.feePct && ['3.3', '5.8', '10.8', '15'].includes(preset) ? preset : 'custom';
    draft.simulator.reserveEnabled = false;
    draft.simulator.reservePct = '0';
    draft.migrationNote = '이전 Enterprise 설정을 가져왔습니다. 부가세 별도 매입원가에 10%를 더해 실제 지출액으로 환산했습니다. 이전 세금 시나리오는 이 계산과 달라 충당금은 0%·꺼짐으로 시작합니다. 면세 매입이라면 원가를 수정하고 모든 가정을 확인해 주세요. 원래 저장 설정은 그대로 보존했습니다.';
    return draft;
  }
  function loadDraft(storage) {
    const result = { draft: defaults(), warning: '', blocked: false, migrated: false };
    if (!storage) { result.warning = '브라우저 저장소를 사용할 수 없어 현재 탭에서만 유지됩니다. CSV로 결과를 보관해 주세요.'; return result; }
    let saved;
    try { saved = storage.getItem(DRAFT_KEY); } catch (_) { result.warning = '브라우저 저장소를 읽을 수 없습니다. 현재 입력은 이 탭에서 유지됩니다.'; return result; }
    if (saved !== null) {
      try {
        if (saved.length > 1000000) throw new TypeError('Oversize draft');
        result.draft = cleanDraft(JSON.parse(saved));
      } catch (_) {
        result.blocked = true;
        result.warning = '저장된 초안을 읽지 못했습니다. 기존 데이터 보호를 위해 자동 덮어쓰기를 중지했습니다. 현재 입력 결과는 CSV로 보관할 수 있습니다.';
      }
      return result;
    }
    try {
      const legacy = storage.getItem(LEGACY_KEY);
      if (legacy !== null) {
        if (legacy.length > 20000) throw new TypeError('Oversize legacy');
        result.draft = migrateLegacy(JSON.parse(legacy));
        result.migrated = true;
      }
    } catch (_) { result.warning = '이전 Enterprise 설정을 자동 변환하지 못했습니다. 원래 저장값은 보존되어 있습니다. 입력 가정을 직접 확인해 주세요.'; }
    return result;
  }
  function saveDraft(storage, draft) {
    if (!storage) return false;
    try { storage.setItem(DRAFT_KEY, JSON.stringify(cleanDraft(draft))); return true; } catch (_) { return false; }
  }

  let mounted = false;
  function mount() {
    if (mounted || typeof document === 'undefined') return;
    const simHost = document.getElementById('page-simulator');
    const settleHost = document.getElementById('page-settlement');
    if (!simHost || !settleHost) return;
    mounted = true;
    let storage;
    try { storage = global.localStorage; } catch (_) { storage = null; }
    const loaded = loadDraft(storage);
    const draft = loaded.draft;
    const storeStatuses = [];
    let simResult = null;
    let settlementResult = null;
    let migrationNotice = null;
    let simCopyGeneration = 0;
    let settlementCopyGeneration = 0;
    const simFields = {};
    const won = value => Math.round(value).toLocaleString('ko-KR') + '원';
    const percent = value => value === null ? '해당 없음' : (value * 100).toFixed(1) + '%';
    function el(tag, className, text) {
      const item = document.createElement(tag);
      if (className) item.className = className;
      if (text !== undefined) item.textContent = text;
      return item;
    }
    function button(label, action, primary = false) {
      const item = el('button', primary ? 'suite-button suite-primary' : 'suite-button', label);
      item.type = 'button'; item.addEventListener('click', action); return item;
    }
    function textStatus(id) { const status = el('p', 'suite-status'); status.id = id; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); return status; }
    function save() {
      const ok = !loaded.blocked && saveDraft(storage, draft);
      storeStatuses.forEach(item => item.textContent = loaded.blocked ? loaded.warning : ok ? '이 브라우저에 초안이 저장되었습니다. 탭을 이동해도 입력은 유지됩니다.' : '자동 저장을 사용할 수 없습니다. 이 탭을 닫기 전에 CSV로 결과를 보관해 주세요.');
    }
    function createHeader(host, eyebrow, title, description) {
      host.classList.add('suite-tools');
      const header = el('div', 'suite-heading');
      header.append(el('div', 'suite-eyebrow', eyebrow), el('h1', '', title), el('p', '', description));
      host.append(header);
      const storageStatus = textStatus(host.id + '-storage');
      storageStatus.textContent = loaded.warning || '입력 초안은 이 브라우저에 자동 저장됩니다. 공용 기기에서는 민감한 정보를 입력하지 마세요.';
      storeStatuses.push(storageStatus);
      host.append(storageStatus);
      const reset = button('도구 초안 초기화', resetTools);
      reset.id = host.id + '-reset'; host.append(reset);
    }
    function makeTable(headers) {
      const wrap = el('div', 'suite-table-wrap');
      const table = el('table', 'suite-table');
      const head = el('thead'); const tr = el('tr');
      headers.forEach(label => { const th = el('th', '', label); th.scope = 'col'; tr.append(th); });
      head.append(tr); const body = el('tbody'); table.append(head, body); wrap.append(table);
      return { wrap, body };
    }
    function tableRows(body, rows) {
      body.replaceChildren(...rows.map(values => { const row = el('tr'); values.forEach(value => row.append(el('td', '', String(value)))); return row; }));
    }
    function inputField(parent, key, label, initial, max, options) {
      const group = el('div', 'suite-field'); const name = el('label', '', label); const id = 'suite-' + key;
      name.htmlFor = id;
      const input = el(options ? 'select' : 'input'); input.id = id;
      if (options) options.forEach(([value, text]) => { const option = el('option', '', text); option.value = value; input.append(option); });
      else { input.type = 'number'; input.min = '0'; input.max = String(max); input.step = key === 'units' ? '1' : 'any'; input.inputMode = 'decimal'; }
      input.value = String(initial); group.append(name, input); parent.append(group); return input;
    }
    function download(text, filename, status) {
      let url;
      try {
        url = global.URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
        const anchor = el('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
        status.textContent = 'CSV 다운로드를 시작했습니다. 저장된 파일을 확인해 주세요.';
      } catch (_) { status.textContent = 'CSV 다운로드를 시작하지 못했습니다. 브라우저의 다운로드 권한을 확인해 주세요.'; }
      finally { if (url) global.setTimeout(() => global.URL.revokeObjectURL(url), 1000); }
    }
    function fallbackBox(id) {
      const box = el('textarea', 'suite-copy-fallback'); box.id = id; box.readOnly = true; box.hidden = true;
      box.setAttribute('aria-label', '직접 복사할 수 있는 요약'); return box;
    }
    async function copySummary(text, fallback, status, isCurrent) {
      try {
        if (!global.navigator || !global.navigator.clipboard) throw new Error('Clipboard unavailable');
        await global.navigator.clipboard.writeText(text);
        if (!isCurrent()) return;
        fallback.hidden = true; status.textContent = '요약을 복사했습니다.';
      } catch (_) {
        if (!isCurrent()) return;
        fallback.value = text; fallback.hidden = false; fallback.focus(); fallback.select();
        status.textContent = '자동 복사를 사용할 수 없습니다. 아래 선택된 요약을 직접 복사해 주세요.';
      }
    }
    createHeader(simHost, 'PLAN & COMPARE', '마진·광고 시뮬레이터', '한 번 입력해 광고비 손익분기, 월 잔액, 목표 판매가와 채널별 차이를 함께 확인하세요.');
    if (draft.migrationNote) {
      const note = el('div', 'suite-notice'); note.append(el('p', '', draft.migrationNote));
      migrationNotice = note;
      note.append(button('설정 확인했어요', () => { draft.migrationNote = ''; note.remove(); migrationNotice = null; save(); })); simHost.append(note);
    }
    simHost.append(el('p', 'suite-note', '모든 금액은 VAT 포함 실제 수입·지출 기준입니다. 공급가만 알고 있다면 과세 매입의 VAT를 더해 입력하세요. 실제 납부세액은 계산하지 않습니다. 예시 수수료율은 계약·카테고리에 따라 바꿔주세요.'));
    const layout = el('div', 'suite-layout'); const inputPanel = el('section', 'suite-card'); const outputPanel = el('section', 'suite-card');
    inputPanel.append(el('h2', '', '공통 입력')); const fields = el('div', 'suite-fields'); inputPanel.append(fields);
    const simSpecs = [
      ['sell', '판매가 (VAT 포함, 원)'], ['cost', '매입 원가 (VAT 포함, 원)'],
      ['ship', '건당 배송·부자재 (원)'], ['ad', '건당 광고비 (원)'], ['fixed', '건당 배분 고정비 (원)'],
      ['feePct', '수수료율 (%)'], ['units', '월 판매 수량 (정수)'], ['targetPct', '목표 잔액률 (%)'],
    ];
    simFields.platform = inputField(fields, 'platform', '수수료 예시 선택', draft.simulator.platform, 0, [['custom', '직접 입력'], ...CHANNELS.map(ch => [String(ch.rate), ch.name + ' (' + ch.rate + '%)'])]);
    simSpecs.forEach(([key, label]) => simFields[key] = inputField(fields, key, label, draft.simulator[key], key === 'units' ? MAX_UNITS : /Pct$/.test(key) ? 100 : MAX_MONEY));
    const reserveGroup = el('div', 'suite-reserve'); const reserveLabel = el('label', 'suite-check'); const reserveToggle = el('input');
    reserveToggle.type = 'checkbox'; reserveToggle.id = 'suite-reserveEnabled'; reserveToggle.checked = draft.simulator.reserveEnabled;
    reserveLabel.append(reserveToggle, el('span', '', '별도 충당금 가정 적용')); reserveGroup.append(reserveLabel);
    simFields.reservePct = inputField(reserveGroup, 'reservePct', '매출 대비 충당금 (%)', draft.simulator.reservePct, 100);
    reserveGroup.append(el('p', 'suite-note', '세금·예비비를 따로 남겨두려는 사용자 가정입니다. 매출 × 설정 비율로 계산하며 사업자 유형별 실제 세액을 추정하지 않습니다.'));
    inputPanel.append(reserveGroup); const simError = textStatus('suite-sim-error'); simError.classList.add('suite-error'); inputPanel.append(simError);
    outputPanel.append(el('h2', '', '같은 가정으로 계산한 결과'));
    const kpis = el('div', 'suite-kpis'); const simKpis = {};
    [['profit', '충당금 반영 건당 잔액'], ['margin', '잔액률'], ['monthly', '월 예상 잔액'], ['targetPrice', '목표 잔액률 판매가'], ['adMultiple', '광고비 회수 배수'], ['breakEvenAd', '손익분기 광고비']].forEach(([key, label]) => {
      const box = el('div', 'suite-kpi'); const value = el('strong', '', '—'); value.id = 'suite-result-' + key; simKpis[key] = value; box.append(el('span', '', label), value); kpis.append(box);
    }); outputPanel.append(kpis);
    const simSummary = el('p', 'suite-note'); simSummary.id = 'suite-sim-summary'; outputPanel.append(simSummary);
    const breakdown = makeTable(['건당 구성', '금액']); outputPanel.append(breakdown.wrap);
    const simActions = el('div', 'suite-actions'); const simExportStatus = textStatus('suite-sim-export-status');
    const simCopyFallback = fallbackBox('suite-sim-copy-text');
    const simCopyButton = button('요약 복사', () => { const generation = simCopyGeneration; if (simResult) return copySummary(simulatorSummary(simResult), simCopyFallback, simExportStatus, () => generation === simCopyGeneration); });
    simCopyButton.id = 'suite-sim-copy';
    const simExportButton = button('시뮬레이션 CSV 저장', () => { if (simResult) download(simulatorExport(simResult), 'marginkit-simulator.csv', simExportStatus); }, true);
    simActions.append(simCopyButton, simExportButton); outputPanel.append(simActions, simExportStatus, simCopyFallback); layout.append(inputPanel, outputPanel); simHost.append(layout);
    const comparePanel = el('section', 'suite-card'); comparePanel.append(el('h2', '', '수수료만 바꿔 보는 채널 비교'), el('p', 'suite-note', '원가·광고비·충당금·판매가는 위 입력과 동일합니다. 아래 요율은 예시이며 실제 채널 계약 수수료가 아닙니다.'));
    const compare = makeTable(['채널 예시', '수수료율', '건당 수수료', '건당 잔액', '잔액률', '목표 판매가']); comparePanel.append(compare.wrap); simHost.append(comparePanel);
    function renderSimulator() {
      simCopyGeneration++;
      SIM_KEYS.forEach(key => { draft.simulator[key] = simFields[key].value; simFields[key].removeAttribute('aria-invalid'); });
      draft.simulator.reserveEnabled = reserveToggle.checked;
      draft.simulator.platform = simFields.platform.value;
      simFields.reservePct.disabled = !reserveToggle.checked;
      simExportStatus.textContent = '';
      simCopyFallback.hidden = true; simCopyFallback.value = '';
      try {
        simResult = calculateSimulator(draft.simulator); simError.textContent = ''; simExportButton.disabled = false; simCopyButton.disabled = false;
        const result = simResult;
        simKpis.profit.textContent = won(result.profit); simKpis.profit.className = result.profit < 0 ? 'suite-loss' : 'suite-gain';
        simKpis.margin.textContent = percent(result.margin); simKpis.monthly.textContent = won(result.monthly);
        simKpis.targetPrice.textContent = result.targetPrice === null ? '달성 불가' : won(result.targetPrice);
        simKpis.adMultiple.textContent = result.adMultiple === null ? '광고비 0원' : result.adMultiple.toFixed(2) + '배';
        simKpis.breakEvenAd.textContent = result.breakEvenAd === null ? '달성 불가' : won(result.breakEvenAd);
        simSummary.textContent = result.beforeAd < 0 ? '광고비를 0원으로 내려도 잔액이 음수입니다. 판매가·원가·고정비 또는 수수료·충당금 가정을 조정하세요.' : '광고비 회수 배수는 광고 전 잔액 ÷ 광고비이며 1배가 손익분기입니다. 목표 판매가는 현재 비용·수수료·충당금 가정이 유지될 때의 1원 단위 최소값입니다.';
        tableRows(breakdown.body, [['매입 원가', won(result.cost)], ['배송·광고·배분 고정비', won(result.ship + result.ad + result.fixed)], ['플랫폼 수수료', won(result.fee)], ['별도 충당금', won(result.reserve)], ['충당금 전 현금 잔액', won(result.cashProfit)]]);
        tableRows(compare.body, CHANNELS.map(ch => { const row = calculateSimulator({ ...draft.simulator, feePct: ch.rate, units: 0 }); return [ch.name, ch.rate + '%', won(row.fee), won(row.profit), percent(row.margin), row.targetPrice === null ? '달성 불가' : won(row.targetPrice)]; }));
      } catch (error) {
        simResult = null; simExportButton.disabled = true; simCopyButton.disabled = true;
        if (simFields[error.message]) simFields[error.message].setAttribute('aria-invalid', 'true');
        simError.textContent = '입력을 확인해 주세요. 금액은 0~1조 원, 비율은 0~100%, 수량은 0~10억의 정수입니다. 월 합계는 안전하게 계산할 수 있는 범위여야 합니다. 빈칸에는 0을 입력해 주세요.';
        Object.values(simKpis).forEach(item => item.textContent = '—');
        breakdown.body.replaceChildren(); compare.body.replaceChildren(); simSummary.textContent = '입력값을 수정하면 결과와 내보내기를 사용할 수 있습니다.';
      }
    }
    SIM_KEYS.forEach(key => simFields[key].addEventListener('input', () => { if (key === 'feePct') simFields.platform.value = 'custom'; renderSimulator(); save(); }));
    simFields.platform.addEventListener('change', () => { if (simFields.platform.value !== 'custom') simFields.feePct.value = simFields.platform.value; renderSimulator(); save(); });
    reserveToggle.addEventListener('change', () => { renderSimulator(); save(); });

    createHeader(settleHost, 'MANUAL SETTLEMENT', '월간 수기 정산', '파일이 없을 때 채널별 월 매출과 수수료를 직접 적는 요약입니다. 파일 분석 데이터와 합산하거나 덮어쓰지 않습니다.');
    settleHost.append(el('p', 'suite-note', '수수료 차감 수령액은 원가·배송비·세금 차감 전 금액입니다. VAT 성분은 선택한 가정으로 매출에 포함된 금액만 분리합니다. 매입세액·공제 미반영으로 실제 납부세액이 아닙니다.'));
    const settlementPanel = el('section', 'suite-card'); const settlementRows = el('div', 'suite-settlement-rows'); settlementRows.id = 'suite-settlement-rows';
    const settlementError = textStatus('suite-settlement-error'); settlementError.classList.add('suite-error');
    const settlementActions = el('div', 'suite-actions');
    const addRowButton = button('+ 채널 추가', () => { readSettlement(); if (draft.settlement.length >= 100) return; draft.settlement.push({ channel: '새 채널', sales: '0', feePct: '0', vatPct: '10' }); renderSettlementInputs(); renderSettlement(); save(); document.getElementById('suite-row-' + (draft.settlement.length - 1) + '-channel').focus(); });
    const settlementExportStatus = textStatus('suite-settlement-export-status');
    const settlementCopyFallback = fallbackBox('suite-settlement-copy-text');
    const settlementCopyButton = button('요약 복사', () => { const generation = settlementCopyGeneration; if (settlementResult) return copySummary(settlementSummary(settlementResult), settlementCopyFallback, settlementExportStatus, () => generation === settlementCopyGeneration); });
    settlementCopyButton.id = 'suite-settlement-copy';
    const settlementExportButton = button('정산 요약 CSV 저장', () => { if (settlementResult) download(settlementExport(settlementResult), 'marginkit-settlement.csv', settlementExportStatus); }, true);
    settlementActions.append(addRowButton, settlementCopyButton, settlementExportButton);
    settlementPanel.append(el('h2', '', '채널별 직접 입력'), settlementRows, settlementError, settlementActions, settlementExportStatus, settlementCopyFallback); settleHost.append(settlementPanel);
    const settlementOutput = el('section', 'suite-card'); settlementOutput.append(el('h2', '', '수기 입력 합계'));
    const settlementKpis = {}; const settlementKpiGrid = el('div', 'suite-kpis');
    [['sales', '총 매출'], ['fee', '총 수수료'], ['vat', '매출에 포함된 VAT 성분'], ['take', '수수료 차감 수령액']].forEach(([key, label]) => { const box = el('div', 'suite-kpi'); const value = el('strong', '', '—'); value.id = 'suite-settlement-' + key; settlementKpis[key] = value; box.append(el('span', '', label), value); settlementKpiGrid.append(box); });
    const settlementTable = makeTable(['채널', '매출', '수수료', 'VAT 가정', 'VAT 성분', '수수료 차감 수령액']);
    settlementOutput.append(settlementKpiGrid, settlementTable.wrap); settleHost.append(settlementOutput);
    function readSettlement() {
      draft.settlement = [...settlementRows.children].map(row => Object.fromEntries(['channel', 'sales', 'feePct', 'vatPct'].map(key => [key, row.querySelector('[data-field="' + key + '"]').value])));
    }
    function renderSettlementInputs() {
      settlementRows.replaceChildren(...draft.settlement.map((line, index) => {
        const row = el('div', 'suite-settlement-row');
        [['channel', '채널'], ['sales', '매출 (VAT 포함, 원)'], ['feePct', '수수료율 (%)'], ['vatPct', 'VAT 포함 가정']].forEach(([key, label]) => {
          const group = el('div', 'suite-field'); const name = el('label', '', label);
          const field = el(key === 'vatPct' ? 'select' : 'input'); field.id = `suite-row-${index}-${key}`; name.htmlFor = field.id; field.dataset.field = key;
          if (key === 'vatPct') [['10', '10% 포함'], ['0', '0% (면세 가정)']].forEach(([value, text]) => { const option = el('option', '', text); option.value = value; field.append(option); });
          else if (key === 'channel') { field.type = 'text'; field.maxLength = 100; }
          else { field.type = 'number'; field.min = '0'; field.max = String(key === 'sales' ? MAX_MONEY : 100); field.step = 'any'; field.inputMode = 'decimal'; }
          field.value = line[key]; group.append(name, field); row.append(group);
        });
        const remove = button('삭제', () => { readSettlement(); draft.settlement.splice(index, 1); if (!draft.settlement.length) draft.settlement.push({ channel: '채널 1', sales: '0', feePct: '0', vatPct: '10' }); renderSettlementInputs(); renderSettlement(); save(); });
        remove.setAttribute('aria-label', `${index + 1}번 채널 삭제`); remove.classList.add('suite-delete'); row.append(remove); return row;
      })); addRowButton.disabled = draft.settlement.length >= 100;
    }
    function renderSettlement() {
      settlementCopyGeneration++;
      readSettlement(); settlementExportStatus.textContent = '';
      settlementCopyFallback.hidden = true; settlementCopyFallback.value = '';
      settlementRows.querySelectorAll('input,select').forEach(field => field.removeAttribute('aria-invalid'));
      try {
        settlementResult = calculateSettlement(draft.settlement); settlementError.textContent = ''; settlementExportButton.disabled = false; settlementCopyButton.disabled = false;
        Object.entries(settlementKpis).forEach(([key, item]) => item.textContent = won(settlementResult.totals[key]));
        tableRows(settlementTable.body, settlementResult.rows.map(row => [row.channel, won(row.sales), won(row.fee), row.vatPct + '%', won(row.vat), won(row.take)]));
      } catch (error) {
        settlementResult = null; settlementExportButton.disabled = true; settlementCopyButton.disabled = true;
        const field = document.getElementById('suite-' + error.message); if (field) field.setAttribute('aria-invalid', 'true');
        settlementError.textContent = '매출은 0~1조 원, 수수료율은 0~100%, VAT 가정은 10% 또는 0%로 입력해 주세요. 빈칸에는 0을 입력해 주세요.';
        Object.values(settlementKpis).forEach(item => item.textContent = '—'); settlementTable.body.replaceChildren();
      }
    }
    function resetTools() {
      if (!global.confirm || !global.confirm('시뮬레이터와 월간 수기 정산의 현재 입력·저장 초안을 초기값으로 바꿀까요?\n기존 상품 원가·분석 데이터·이전 Enterprise 저장값은 유지됩니다.')) return;
      const fresh = defaults();
      // A blank, non-sensitive draft prevents the preserved legacy settings
      // from being silently migrated again on the next visit.
      if (!saveDraft(storage, fresh)) {
        storeStatuses.forEach(item => item.textContent = '저장소를 변경할 수 없어 초기화하지 않았습니다. 현재 입력은 그대로 유지됩니다.');
        return;
      }
      Object.assign(draft, fresh); loaded.blocked = false;
      SIM_KEYS.forEach(key => simFields[key].value = draft.simulator[key]);
      simFields.platform.value = draft.simulator.platform; reserveToggle.checked = false;
      if (migrationNotice) { migrationNotice.remove(); migrationNotice = null; }
      renderSettlementInputs(); renderSettlement(); renderSimulator();
      storeStatuses.forEach(item => item.textContent = '이 도구의 초안을 초기값으로 바꿨습니다. 상품 원가·분석 데이터·이전 Enterprise 저장값은 유지했습니다.');
    }
    settlementRows.addEventListener('input', () => { renderSettlement(); save(); });
    settlementRows.addEventListener('change', () => { renderSettlement(); save(); });
    renderSettlementInputs(); renderSettlement(); renderSimulator();
    if (loaded.migrated) save();
  }
  const api = { mount, calculateSimulator, calculateSettlement, recommendedPrice, exactTargetPrice, makeCsv, simulatorExport, settlementExport, simulatorSummary, settlementSummary, defaults, cleanDraft, migrateLegacy, loadDraft, saveDraft, DRAFT_KEY, LEGACY_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MarginKitSuite = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }
})(typeof window !== 'undefined' ? window : globalThis);
