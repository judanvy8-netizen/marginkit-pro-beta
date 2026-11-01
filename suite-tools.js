(function (global) {
  'use strict';
  const D = global.MKDecimal || (typeof module === 'object' && module.exports ? require('./exact-decimal.js') : null);
  const R = global.MKRational || (typeof module === 'object' && module.exports ? require('./exact-rational.js') : null);
  const exactValue = (result, key) => result.exact?.[key] ?? result[key];
  const exactCell = value => ({ decimal: D.normalize(value) });
  const wonText = value => D.format(value) + '원';
  const settlementValue = (row,key) => row.display?.[key] ?? row.exact[key];
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
  function decimalValue(raw, key, max = MAX_MONEY) {
    if (!D || !R || (typeof raw !== 'number' && typeof raw !== 'string')) throw new RangeError(key);
    if (typeof raw === 'number' && !Number.isFinite(raw)) throw new RangeError(key);
    let text = typeof raw === 'number' ? D.normalize(raw) : raw.trim();
    if (!text || text.length > 10000) throw new RangeError(key);
    const scientific = /^([+-]?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(text);
    if (scientific) {
      const exponent = Number(scientific[4]);
      if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) throw new RangeError(key);
      const digits = scientific[2] + (scientific[3] || '');
      const point = scientific[2].length + exponent;
      if (Math.max(digits.length, point, digits.length - point + 2) + 2 > 10000) throw new RangeError(key);
      text = scientific[1] + (point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0,point) + '.' + digits.slice(point));
    }
    try { text = D.normalize(text); } catch { throw new RangeError(key); }
    if (D.compare(text, '0') < 0 || D.compare(text, String(max)) > 0) throw new RangeError(key);
    return text;
  }
  function number(raw, key, max = MAX_MONEY, integer = false) {
    const value = decimalValue(raw, key, max);
    if (integer && value.includes('.')) throw new RangeError(key);
    return Number(value);
  }
  function exactTargetPrice(costs, rates, scale) {
    // This is explicitly a one-won-ceiling recommendation, not invoice rounding.
    if (![1,100].includes(scale) || costs.length > 10 || rates.length > 10) throw new RangeError('price assumption');
    const fixed = costs.reduce((sum,value) => D.add(sum, decimalValue(value,'price assumption',1e13)), '0');
    const totalRate = rates.reduce((sum,value) => D.add(sum, decimalValue(value,'price assumption',100)), '0');
    const remaining = D.sub('1', D.mul(totalRate, scale === 100 ? '0.01' : '1'));
    if (D.compare(fixed,'0') === 0) return D.compare(remaining,'0') >= 0 ? 1 : null;
    if (D.compare(remaining,'0') <= 0) return null;
    const price = R.divide(R.decimal(fixed),R.decimal(remaining));
    const ceiling = (price.n + price.d - 1n) / price.d;
    return ceiling <= BigInt(MAX_MONEY) ? Number(ceiling) : null;
  }
  function recommendedPrice(fixed, feeRate, reserveRate, targetRate) {
    return exactTargetPrice([fixed], [feeRate, reserveRate, targetRate], 1);
  }
  function calculateSimulator(raw) {
    const exact = {};
    if (typeof raw.reserveEnabled !== 'boolean') throw new RangeError('reserveEnabled');
    SIM_KEYS.forEach(key => exact[key] = key === 'reservePct' && !raw.reserveEnabled ? '0' : decimalValue(raw[key], key, key === 'units' ? MAX_UNITS : /Pct$/.test(key) ? 100 : MAX_MONEY));
    exact.fee = D.mul(D.mul(exact.sell,exact.feePct),'0.01');
    exact.reserve = raw.reserveEnabled ? D.mul(D.mul(exact.sell,exact.reservePct),'0.01') : '0';
    const baseCosts = D.add(D.add(exact.cost,exact.ship),exact.fixed);
    exact.beforeAd = D.sub(D.sub(D.sub(exact.sell,exact.fee),exact.reserve),baseCosts);
    exact.profit = D.sub(exact.beforeAd,exact.ad);
    exact.cashProfit = D.add(exact.profit,exact.reserve);
    exact.monthly = D.mul(exact.profit,exact.units);
    exact.monthlyRevenue = D.mul(exact.sell,exact.units);
    exact.totalCost = D.add(D.add(D.add(baseCosts,exact.ad),exact.fee),exact.reserve);
    const ratio = (a,b) => { const percentage=D.percentage(a,b);return percentage===null?null:percentage/100; };
    const fractions = { margin: D.compare(exact.sell,'0') > 0 ? R.fraction(R.divide(R.decimal(exact.profit),R.decimal(exact.sell))) : null, adMultiple: D.compare(exact.ad,'0') > 0 ? R.fraction(R.divide(R.decimal(exact.beforeAd),R.decimal(exact.ad))) : null };
    const result = Object.fromEntries(Object.entries(exact).map(([key,value])=>[key,Number(value)]));
    return { ...result, exact, fractions, reserveEnabled: raw.reserveEnabled,
      margin: D.compare(exact.sell,'0') > 0 ? ratio(exact.profit,exact.sell) : null,
      adMultiple: D.compare(exact.ad,'0') > 0 ? ratio(exact.beforeAd,exact.ad) : null,
      breakEvenAd: D.compare(exact.beforeAd,'0') >= 0 ? Number(exact.beforeAd) : null,
      targetPrice: exactTargetPrice([exact.cost,exact.ship,exact.fixed,exact.ad],[exact.feePct,exact.reservePct,exact.targetPct],100) };
  }
  function calculateSettlement(lines) {
    if (!Array.isArray(lines) || lines.length < 1 || lines.length > 100) throw new RangeError('lines');
    let textBudget = 0;
    const calculated = lines.map((line,index) => {
      const exact = {};
      for (const key of ['sales','feePct','vatPct']) {
        exact[key] = decimalValue(line[key],`row-${index}-${key}`,key==='sales'?MAX_MONEY:100);
        textBudget += exact[key].length;
        if (textBudget > 100000) throw new RangeError('lines');
      }
      if (!['0','10'].includes(exact.vatPct)) throw new RangeError(`row-${index}-vatPct`);
      const channel = String(line.channel || '채널').replace(/[\r\n\t]/g,' ').slice(0,100);
      exact.fee = D.mul(D.mul(exact.sales,exact.feePct),'0.01');
      exact.take = D.sub(exact.sales,exact.fee);
      const supply = R.divide(R.decimal(exact.sales),R.decimal(exact.vatPct==='10'?'1.1':'1'));
      const vat = R.sub(R.decimal(exact.sales),supply);
      const supplyPreview=R.preview(supply),vatPreview=R.preview(vat);
      const display={supply:supplyPreview.text,vat:vatPreview.text};
      exact.supply=supplyPreview.approximate?null:supplyPreview.text;exact.vat=vatPreview.approximate?null:vatPreview.text;
      const row={channel,...Object.fromEntries(Object.entries(exact).map(([key,value])=>[key,Number(value ?? display[key])])),exact,display,
        fractions:{supply:R.fraction(supply),vat:R.fraction(vat)},approximate:{supply:supplyPreview.approximate,vat:vatPreview.approximate}};
      return {row,supply,vat};
    });
    const exact={sales:'0',fee:'0',take:'0'};let supply=R.ratio(0n),vat=R.ratio(0n);
    for(const result of calculated){for(const key of ['sales','fee','take'])exact[key]=D.add(exact[key],result.row.exact[key]);supply=R.add(supply,result.supply);vat=R.add(vat,result.vat);}
    const supplyPreview=R.preview(supply),vatPreview=R.preview(vat);const display={supply:supplyPreview.text,vat:vatPreview.text};exact.supply=supplyPreview.approximate?null:supplyPreview.text;exact.vat=vatPreview.approximate?null:vatPreview.text;
    return {rows:calculated.map(result=>result.row),totals:{...Object.fromEntries(Object.entries(exact).map(([key,value])=>[key,Number(value ?? display[key])])),exact,display,
      fractions:{supply:R.fraction(supply),vat:R.fraction(vat)},approximate:{supply:supplyPreview.approximate,vat:vatPreview.approximate}}};
  }
  function csvCell(value) {
    if (value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value.decimal === 'string') return D.normalize(value.decimal);
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
      ['판매가', exactCell(exactValue(result,'sell')), '원'], ['매입 원가', exactCell(exactValue(result,'cost')), '원'], ['배송·부자재', exactCell(exactValue(result,'ship')), '원'],
      ['광고비', exactCell(exactValue(result,'ad')), '원'], ['배분 고정비', exactCell(exactValue(result,'fixed')), '원'], ['수수료율', exactCell(exactValue(result,'feePct')), '%'],
      ['충당금 사용', result.reserveEnabled ? '사용' : '미사용', ''], ['충당금 가정', result.reserveEnabled ? exactCell(exactValue(result,'reservePct')) : 0, '매출 대비 %'],
      ['건당 수수료', exactCell(exactValue(result,'fee')), '원'], ['건당 충당금', exactCell(exactValue(result,'reserve')), '원'], ['충당금 전 현금 잔액', exactCell(exactValue(result,'cashProfit')), '원'],
      ['충당금 반영 건당 잔액', exactCell(exactValue(result,'profit')), '원'], ['잔액률 (표시용 근사)', result.margin === null ? (result.fractions.margin === null ? '해당 없음' : '표시 범위 초과') : result.margin * 100, '%'],
      ['월 판매 수량', exactCell(exactValue(result,'units')), '개'], ['월 예상 잔액', exactCell(exactValue(result,'monthly')), '원'],
      ['광고비 회수 배수 (표시용 근사)', result.adMultiple === null ? (result.fractions.adMultiple === null ? '광고비 0원으로 해당 없음' : '표시 범위 초과') : result.adMultiple, '배'],
      ['잔액률 정확한 비율', result.fractions.margin === null ? '판매가 0원' : 'fraction: ' + result.fractions.margin, '분수 (×100하면 %)'], ['광고비 회수 정확한 배수', result.fractions.adMultiple === null ? '광고비 0원' : 'fraction: ' + result.fractions.adMultiple, '분수'],
      ['손익분기 광고비', result.breakEvenAd === null ? '광고비 조정만으로 달성 불가' : exactCell(exactValue(result,'beforeAd')), '원'],
      ['목표 잔액률', exactCell(exactValue(result,'targetPct')), '%'], ['목표 판매가', result.targetPrice === null ? '가정 범위에서 달성 불가' : result.targetPrice, '원'],
      ['안내', '추정 시나리오입니다. 충당금은 사용자 가정이며 실제 납부세액 또는 세무 신고 금액이 아닙니다.'],
      [], ['채널 비교 (요율은 예시)', '수수료율 (%)', '건당 잔액 (원)', '잔액률 (%)'],
      ...CHANNELS.map(channel => { const row = calculateSimulator({ ...result.exact, reserveEnabled:result.reserveEnabled, feePct:channel.rate, units:0 }); return [channel.name, channel.rate, exactCell(row.exact.profit), row.margin === null ? (row.fractions.margin === null ? '해당 없음' : '표시 범위 초과') : row.margin * 100]; }),
    ]);
  }
  function settlementExport(result) {
    const rowValues=row=>[exactCell(row.exact.sales),exactCell(row.exact.feePct || '0'),exactCell(row.exact.vatPct || '0'),exactCell(row.exact.fee),exactCell(settlementValue(row,'supply')),exactCell(settlementValue(row,'vat')),exactCell(row.exact.take),'fraction: '+row.fractions.supply,'fraction: '+row.fractions.vat,row.approximate.supply||row.approximate.vat?'표시값은 근사':'유한소수 정확값'];
    const total=result.totals;
    return makeCsv([
      ['MarginKit 월간 수기 정산','정산 파일 분석과 별개로 직접 입력한 요약'],
      ['채널','매출 VAT 포함 (원)','수수료율 (%)','가정 VAT (%)','수수료 (원)','공급가액 표시값 (원)','매출 VAT 표시값 (원)','수수료 차감 수령액 (원)','공급가액 정확한 분수','VAT 정확한 분수','표시 정밀도'],
      ...result.rows.map(row=>[row.channel,...rowValues(row)]),
      ['합계',exactCell(total.exact.sales),'','',exactCell(total.exact.fee),exactCell(settlementValue(total,'supply')),exactCell(settlementValue(total,'vat')),exactCell(total.exact.take),'fraction: '+total.fractions.supply,'fraction: '+total.fractions.vat,total.approximate.supply||total.approximate.vat?'표시값은 근사':'유한소수 정확값'],
      ['안내','반복소수 표시값은 소수 12자리까지 절삭한 근사이며 정확한 분수를 함께 제공합니다. 실제 정산·세무 반올림 규칙이 아닙니다. 매입세액·공제 미반영으로 VAT 성분은 납부세액이 아닙니다.']]);
  }
  function simulatorSummary(result) {
    const won = wonText;
    return [
      '[MarginKit 마진·광고 시뮬레이션]',
      `판매가 ${won(exactValue(result,'sell'))} / 매입 원가 ${won(exactValue(result,'cost'))} (모두 VAT 포함)`,
      `배송 ${won(exactValue(result,'ship'))} / 광고 ${won(exactValue(result,'ad'))} / 배분 고정비 ${won(exactValue(result,'fixed'))}`,
      `수수료율 ${exactValue(result,'feePct')}% / 충당금 가정 ${result.reserveEnabled ? exactValue(result,'reservePct') : '0'}%`,
      `건당 잔액 ${won(exactValue(result,'profit'))} / 잔액률 ${result.margin === null ? (result.fractions.margin === null ? '해당 없음' : '표시 범위 초과') : '≈' + (result.margin * 100).toFixed(1) + '%'}`,
      `월 ${D.format(exactValue(result,'units'))}개 기준 예상 잔액 ${won(exactValue(result,'monthly'))}`,
      `광고비 회수 배수 ${result.adMultiple === null ? (result.fractions.adMultiple === null ? '광고비 0원으로 해당 없음' : '표시 범위 초과: ' + result.fractions.adMultiple) : '≈' + result.adMultiple.toFixed(2) + '배'}`,
      `손익분기 광고비 ${result.breakEvenAd === null ? '광고비 조정만으로 달성 불가' : won(exactValue(result,'beforeAd'))}`,
      `목표 잔액률 ${exactValue(result,'targetPct')}% 판매가 ${result.targetPrice === null ? '달성 불가' : won(result.targetPrice)}`,
      '※ 충당금은 사용자가 선택한 가정이며 실제 납부세액 또는 세무 신고 금액이 아닙니다.',
    ].join('\n');
  }
  function settlementSummary(result) {
    const won = wonText;
    return [
      '[MarginKit 월간 수기 정산]',
      ...result.rows.map(row => `${row.channel}: 매출 ${won(row.exact.sales)} / 수수료 ${won(row.exact.fee)} / 수령액 ${won(row.exact.take)} / VAT ${row.vatPct}% 가정`),
      `총 매출 ${won(result.totals.exact.sales)} / 총 수수료 ${won(result.totals.exact.fee)}`,
      `매출에 포함된 VAT 성분 ${(result.totals.approximate.vat?'≈':'')+won(settlementValue(result.totals,'vat'))} / 수수료 차감 수령액 ${won(result.totals.exact.take)}`,
      '※ 직접 입력한 요약입니다. 수령액은 원가·배송비·세금 차감 전이며 VAT 성분은 실제 납부세액이 아닙니다.',
    ].join('\n');
  }
  function cleanDraft(value) {
    if (!value || value.version !== 1 || !value.simulator || !Array.isArray(value.settlement) || value.settlement.length < 1 || value.settlement.length > 100) throw new TypeError('Invalid saved draft');
    const draft = defaults();
    SIM_KEYS.forEach(key => {
      if (typeof value.simulator[key] !== 'string' || value.simulator[key].length > 10000) throw new TypeError('Invalid saved field');
      draft.simulator[key] = value.simulator[key];
    });
    draft.simulator.reserveEnabled = value.simulator.reserveEnabled === true;
    draft.simulator.platform = ['3.3', '5.8', '10.8', '15', 'custom'].includes(value.simulator.platform) ? value.simulator.platform : 'custom';
    draft.settlement = value.settlement.map(line => {
      if (!line || typeof line !== 'object') throw new TypeError('Invalid saved row');
      const row = {};
      ['channel', 'sales', 'feePct', 'vatPct'].forEach(key => {
        if (typeof line[key] !== 'string' || line[key].length > (key === 'channel' ? 100 : 10000)) throw new TypeError('Invalid saved row value');
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
      const amount = number(value[oldKey], oldKey, newKey === 'units' ? MAX_UNITS : /Pct$/.test(newKey) ? 100 : MAX_MONEY, false);
      if (typeof value[oldKey] !== 'string' || value[oldKey].length > 40) throw new TypeError('Invalid legacy field');
      draft.simulator[newKey] = newKey === 'cost' ? D.mul(decimalValue(value[oldKey],oldKey), '1.1') : decimalValue(value[oldKey],oldKey,newKey === 'units' ? MAX_UNITS : /Pct$/.test(newKey) ? 100 : MAX_MONEY);
    }
    if (!['0.033', '0.058', '0.108', '0.15', 'custom'].includes(value.platform) || !['general', 'simple_retail', 'corporate'].includes(value.taxType)) throw new TypeError('Invalid legacy option');
    const preset = String(Number((Number(value.platform) * 100).toFixed(1)));
    draft.simulator.platform = preset === draft.simulator.feePct && ['3.3', '5.8', '10.8', '15'].includes(preset) ? preset : 'custom';
    draft.simulator.reserveEnabled = false;
    draft.simulator.reservePct = '0';
    draft.migrationNote = '이전 Enterprise 설정을 가져왔습니다. 부가세 별도 매입원가에 10%를 더해 실제 지출액으로 환산했습니다. 이전 세금 시나리오는 이 계산과 달라 충당금은 0%·꺼짐으로 시작합니다. 면세 매입이라면 원가를 수정하고 모든 가정을 확인해 주세요. 원래 저장 설정은 그대로 보존했습니다.';
    return draft;
  }
  // Each independently loaded draft owns a revision, even inside one JS context.
  // No metadata is written into user JSON, and no stale drafts are auto-merged.
  const draftRevisions = new WeakMap();
  function rememberDraft(result, storage, raw) {
    draftRevisions.set(result.draft, { storage, raw, blocked: result.blocked, warning: result.warning });
    return result;
  }
  function loadDraft(storage) {
    const result = { draft: defaults(), warning: '', blocked: false, migrated: false };
    if (!storage) { result.warning = '브라우저 저장소를 사용할 수 없어 현재 탭에서만 유지됩니다. CSV로 결과를 보관해 주세요.'; return rememberDraft(result,storage,undefined); }
    let saved;
    try { saved = storage.getItem(DRAFT_KEY); } catch (_) { result.blocked=true;result.warning = '브라우저 저장소를 읽을 수 없습니다. 원본 보호를 위해 자동 저장을 중지했습니다. 현재 입력은 이 탭에서 유지됩니다.'; return rememberDraft(result,storage,undefined); }
    if (saved !== null) {
      try {
        if (saved.length > 1000000) throw new TypeError('Oversize draft');
        result.draft = cleanDraft(JSON.parse(saved));
      } catch (_) {
        result.blocked = true;
        result.warning = '저장된 초안을 읽지 못했습니다. 기존 데이터 보호를 위해 자동 덮어쓰기를 중지했습니다. 현재 입력 결과는 CSV로 보관할 수 있습니다.';
      }
      return rememberDraft(result,storage,saved);
    }
    try {
      const legacy = storage.getItem(LEGACY_KEY);
      if (legacy !== null) {
        if (legacy.length > 20000) throw new TypeError('Oversize legacy');
        result.draft = migrateLegacy(JSON.parse(legacy));
        result.migrated = true;
      }
    } catch (_) { result.warning = '이전 Enterprise 설정을 자동 변환하지 못했습니다. 원래 저장값은 보존되어 있습니다. 입력 가정을 직접 확인해 주세요.'; }
    return rememberDraft(result,storage,saved);
  }
  function saveDraft(storage, draft, options = {}) {
    if (!storage || !draft || typeof draft !== 'object') return false;
    const origin = options.replaceFrom || draft;
    let revision = draftRevisions.get(origin);
    const fail = warning => {
      if (!revision) { revision={storage,raw:undefined,blocked:true,warning};draftRevisions.set(origin,revision); }
      revision.warning=warning;return false;
    };
    try {
      const current=storage.getItem(DRAFT_KEY);
      if (!revision) {
        if (current!==null) return fail('기존 초안을 먼저 불러와야 합니다. 원본을 덮어쓰지 않았습니다.');
        revision={storage,raw:null,blocked:false,warning:''};draftRevisions.set(origin,revision);
      }
      if (revision.storage!==storage || revision.raw!==current) return fail('다른 탭에서 초안이 변경되었습니다. 현재 입력은 저장되지 않았습니다. CSV로 보관한 뒤 새로고침해 주세요.');
      if (revision.blocked && !options.allowRecovery) return fail('저장 초안이 손상되었거나 읽기 권한이 없습니다. 원본 보호를 위해 덮어쓰기를 중지했습니다.');
      const serialized=JSON.stringify(cleanDraft(draft));
      if(serialized.length>1000000)return fail('초안 크기가 저장 한도를 초과했습니다. 현재 입력은 저장되지 않았습니다.');
      storage.setItem(DRAFT_KEY,serialized);
      const committed={storage,raw:serialized,blocked:false,warning:''};
      draftRevisions.set(draft,committed);draftRevisions.set(origin,committed);
      return true;
    } catch (_) { return fail('자동 저장을 사용할 수 없습니다. 현재 입력은 이 탭에만 유지됩니다. 닫기 전에 CSV로 보관해 주세요.'); }
  }

  let mounted = false;
  function mount() {
    if (mounted || typeof document === 'undefined') return;
    const simHost = document.getElementById('page-simulator');
    const settleHost = document.getElementById('page-settlement');
    if (!simHost || !settleHost) return;
    if (!D || !R) { simHost.textContent='정확한 계산 모듈을 사용할 수 없습니다. 최신 브라우저에서 다시 열어 주세요.';settleHost.textContent=simHost.textContent;return; }
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
    const won = wonText;
    const percent = value => value === null ? '해당 없음' : '≈' + (value * 100).toFixed(1) + '%';
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
      storeStatuses.forEach(item => item.textContent = loaded.blocked ? loaded.warning : ok ? '이 브라우저에 초안이 저장되었습니다. 탭을 이동해도 입력은 유지됩니다.' : (draftRevisions.get(draft)?.warning || '자동 저장을 사용할 수 없습니다. 이 탭을 닫기 전에 CSV로 결과를 보관해 주세요.'));
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
      else { input.type = 'number'; input.min = '0'; input.max = String(max); input.step = 'any'; input.inputMode = 'decimal'; }
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
      ['feePct', '수수료율 (%)'], ['units', '월 판매 수량 (소수 허용)'], ['targetPct', '목표 잔액률 (%)'],
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
        simKpis.profit.textContent = won(exactValue(result,'profit')); simKpis.profit.className = D.compare(result.exact.profit,'0') < 0 ? 'suite-loss' : 'suite-gain';
        simKpis.margin.textContent = result.margin === null && result.fractions.margin !== null ? '표시 범위 초과 (CSV 분수 참조)' : percent(result.margin); simKpis.monthly.textContent = won(exactValue(result,'monthly'));
        simKpis.targetPrice.textContent = result.targetPrice === null ? '달성 불가' : won(result.targetPrice);
        simKpis.adMultiple.textContent = result.adMultiple === null ? (result.fractions.adMultiple === null ? '광고비 0원' : '표시 범위 초과 (CSV 분수 참조)') : '≈' + result.adMultiple.toFixed(2) + '배';
        simKpis.breakEvenAd.textContent = result.breakEvenAd === null ? '달성 불가' : won(exactValue(result,'beforeAd'));
        simSummary.textContent = D.compare(result.exact.beforeAd,'0') < 0 ? '광고비를 0원으로 내려도 잔액이 음수입니다. 판매가·원가·고정비 또는 수수료·충당금 가정을 조정하세요.' : '광고비 회수 배수는 광고 전 잔액 ÷ 광고비이며 1배가 손익분기입니다. 목표 판매가는 현재 비용·수수료·충당금 가정이 유지될 때의 1원 단위 올림 권장값이며 실제 정산 반올림 규칙은 아닙니다. 잔액률·배수는 표시용 근사입니다.';
        tableRows(breakdown.body, [['매입 원가', won(exactValue(result,'cost'))], ['배송·광고·배분 고정비', won(D.add(D.add(result.exact.ship,result.exact.ad),result.exact.fixed))], ['플랫폼 수수료', won(exactValue(result,'fee'))], ['별도 충당금', won(exactValue(result,'reserve'))], ['충당금 전 현금 잔액', won(exactValue(result,'cashProfit'))]]);
        tableRows(compare.body, CHANNELS.map(ch => { const row = calculateSimulator({ ...draft.simulator, feePct: ch.rate, units: 0 }); return [ch.name, ch.rate + '%', won(row.exact.fee), won(row.exact.profit), percent(row.margin), row.targetPrice === null ? '달성 불가' : won(row.targetPrice)]; }));
      } catch (error) {
        simResult = null; simExportButton.disabled = true; simCopyButton.disabled = true;
        if (simFields[error.message]) simFields[error.message].setAttribute('aria-invalid', 'true');
        simError.textContent = '입력을 확인해 주세요. 금액은 0~1조 원, 비율은 0~100%, 수량은 0~10억이며 소수도 허용합니다. 지나치게 긴 숫자·처리 한도 초과 입력은 나누어 주세요. 빈칸에는 0을 입력해 주세요.';
        Object.values(simKpis).forEach(item => item.textContent = '—');
        breakdown.body.replaceChildren(); compare.body.replaceChildren(); simSummary.textContent = '입력값을 수정하면 결과와 내보내기를 사용할 수 있습니다.';
      }
    }
    SIM_KEYS.forEach(key => simFields[key].addEventListener('input', () => { if (key === 'feePct') simFields.platform.value = 'custom'; renderSimulator(); save(); }));
    simFields.platform.addEventListener('change', () => { if (simFields.platform.value !== 'custom') simFields.feePct.value = simFields.platform.value; renderSimulator(); save(); });
    reserveToggle.addEventListener('change', () => { renderSimulator(); save(); });

    createHeader(settleHost, 'MANUAL SETTLEMENT', '월간 수기 정산', '파일이 없을 때 채널별 월 매출과 수수료를 직접 적는 요약입니다. 파일 분석 데이터와 합산하거나 덮어쓰지 않습니다.');
    settleHost.append(el('p', 'suite-note', '수수료 차감 수령액은 원가·배송비·세금 차감 전 금액입니다. VAT 성분은 선택한 가정으로 매출에 포함된 금액만 분리합니다. 매입세액·공제 미반영으로 실제 납부세액이 아닙니다. 반복소수는 ≈ 표시로 소수 12자리까지만 보여 주며 정확한 분수는 CSV에 함께 제공합니다. 실제 정산 반올림 규칙을 적용한 값이 아닙니다.'));
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
        Object.entries(settlementKpis).forEach(([key,item])=>item.textContent=(settlementResult.totals.approximate[key]?'≈':'')+won(settlementValue(settlementResult.totals,key)));
        tableRows(settlementTable.body, settlementResult.rows.map(row => [row.channel, won(row.exact.sales), won(row.exact.fee), row.vatPct + '%', (row.approximate.vat?'≈':'')+won(settlementValue(row,'vat')), won(row.exact.take)]));
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
      if (!saveDraft(storage, fresh, { replaceFrom: draft, allowRecovery: true })) {
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
    api.current = {
      readSimulator() {
        renderSimulator();
        const copy = cleanDraft(draft).simulator;
        try { calculateSimulator(copy); } catch (_) { throw new Error('현재 시뮬레이터 입력을 확인해 주세요 시뮬레이터 화면의 잘못된 항목을 수정한 뒤 저장할 수 있습니다'); }
        return copy;
      },
      readSettlement() {
        readSettlement();
        const copy = cleanDraft(draft).settlement;
        try { calculateSettlement(copy); } catch (_) { throw new Error('현재 수기 정산 입력을 확인해 주세요 채널별 매출과 요율을 수정한 뒤 저장할 수 있습니다'); }
        return copy;
      },
      read() {
        renderSimulator(); readSettlement();
        const copy = cleanDraft(draft);
        calculateSimulator(copy.simulator); calculateSettlement(copy.settlement);
        return copy;
      },
      loadSimulator(value) { return applySaved({ simulator: value }); },
      loadSettlement(value) { return applySaved({ settlement: value }); }
    };
    function applySaved(part) {
      const next = cleanDraft({ ...draft, ...part });
      if (part.simulator) calculateSimulator(next.simulator);
      if (part.settlement) calculateSettlement(next.settlement);
      if (!saveDraft(storage, next, { replaceFrom: draft })) throw new Error('현재 초안을 저장하지 못해 불러오지 않았습니다 다른 탭의 변경이나 브라우저 저장 공간을 확인해 주세요');
      Object.assign(draft, next);
      SIM_KEYS.forEach(key => simFields[key].value = draft.simulator[key]);
      simFields.platform.value = draft.simulator.platform; reserveToggle.checked = draft.simulator.reserveEnabled;
      renderSettlementInputs(); renderSettlement(); renderSimulator();
      return true;
    }
    for (const host of [simHost, settleHost]) {
      const entry = el('a', 'suite-premium-entry', host === simHost ? '이 시나리오를 저장하고 비교하기 →' : '월별 기록을 저장하고 비교하기 →');
      entry.href = '#premium'; entry.dataset.pageLink = 'premium'; host.append(entry);
    }
  }
  const api = { mount, calculateSimulator, calculateSettlement, recommendedPrice, exactTargetPrice, makeCsv, simulatorExport, settlementExport, simulatorSummary, settlementSummary, defaults, cleanDraft, migrateLegacy, loadDraft, saveDraft, DRAFT_KEY, LEGACY_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MarginKitSuite = api;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }
})(typeof window !== 'undefined' ? window : globalThis);
