(function (global) {
  'use strict';
  const D = global.MKDecimal || (typeof module === 'object' ? require('./exact-decimal.js') : null);
  const Suite = global.MarginKitSuite || (typeof module === 'object' ? require('./suite-tools.js') : null);
  const Core = global.MarginKitPremiumCore || (typeof module === 'object' ? require('./premium-core.js') : null);
  const decimal = value => value === null || value === undefined ? '' : ({ decimal: D.normalize(value) });
  function cell(value) {
    if (value && typeof value === 'object' && typeof value.decimal === 'string') {
      const exact = D.normalize(value.decimal), number = Number(exact);
      // Excel stores only 15 significant digits; longer values remain exact text
      const digits = exact.replace(/[-.]/g, '').replace(/^0+/, '').length;
      if (Number.isFinite(number) && digits <= 15 && D.normalize(number) === exact) return { t: 'n', v: number };
      return { t: 's', v: exact };
    }
    // Explicit string cells preserve leading-zero identifiers and never create formulas
    return { t: 's', v: String(value ?? '') };
  }
  function workbook(XLSX, sheets) {
    if (!XLSX || typeof XLSX.write !== 'function') throw new Error('엑셀 모듈을 사용할 수 없습니다');
    const book = XLSX.utils.book_new();
    for (const sheet of sheets) {
      const ws = XLSX.utils.aoa_to_sheet(sheet.rows.map(row => row.map(cell)));
      const count = Math.max(...sheet.rows.map(row => row.length), 1);
      ws['!cols'] = Array.from({ length: count }, (_, i) => ({ wch: i === 0 ? 28 : 22 }));
      XLSX.utils.book_append_sheet(book, ws, sheet.name);
    }
    return book;
  }
  function analysisSheets(snapshot) {
    if (!snapshot.totals.products.length) throw new Error('정산 파일을 먼저 분석해 주세요');
    const t = snapshot.totals;
    return [{ name: '안내와 요약', rows: [
      ['MarginKit 분석 리포트', snapshot.isDemo ? '가상 예시 데이터' : '현재 정산 파일 분석'],
      ['원본 파일', snapshot.source || '이름 없음'], ['금액 기준', '금액과 수량은 원본 소수 정밀도를 보존'],
      ['Excel 정밀도', '15자리 이하로 손실 없이 표현되는 수는 숫자 셀, 나머지는 정확한 텍스트 셀'],
      ['주의', '추정 순이익은 등록된 원가가 있는 상품만 포함하며 세무 신고 자료가 아님'],
      ['총 매출', decimal(t.totalRevenue)], ['환불 조정액', decimal(t.totalRefunds)],
      ['원가 등록 상품 추정 순이익', decimal(t.profit)], ['원가 미등록 상품 수', String(t.missing)],
      ['광고비 합계', decimal(t.products.reduce((sum, p) => D.add(sum, p.ads), '0'))]
    ] }, { name: '상품별 분석', rows: [
      ['상품명', '상품코드', '판매 수량', '총 매출', '환불 조정', '순매출', '단위원가', '총원가', '수수료', '배송비', '광고비', '기타비용', '추정 순이익', '원가 상태'],
      ...t.products.map(p => [p.product, p.sku, ...['qty','revenue','refunds','netRevenue','unitCost','cost','commission','shipping','ads','other','profit'].map(k => decimal(p[k])), p.hasCost ? '원가 확인' : '원가 미등록'])
    ] }];
  }
  function scenarioSheets(scenarios) {
    const rows = Core.compareScenarios(scenarios);
    if (!rows.length) throw new Error('비교할 시나리오를 먼저 저장해 주세요');
    return [{ name: '시나리오 비교', rows: [
      ['MarginKit 저장 시나리오', '사용자가 입력한 가정이며 실제 실적 또는 납부세액이 아님'],
      ['정밀도', 'Excel 숫자 정밀도를 넘는 값은 정확한 텍스트 셀로 저장'],
      ['이름', '판매가', '매입원가', '건당 광고비', '월 수량', '건당 잔액', '월 예상 잔액', '목표 판매가', '잔액률 정확한 분수'],
      ...rows.map(({ name, result: r }) => [name, ...['sell','cost','ad','units','profit','monthly'].map(k => decimal(r.exact[k])), decimal(r.targetPrice), r.fractions.margin ?? '해당 없음'])
    ] }, { name: '시나리오 입력값', rows: [
      ['이름','판매가','원가','배송비','광고비','배분 고정비','수수료율 %','월 수량','목표 잔액률 %','충당금 사용','충당금 %'],
      ...scenarios.map((s,i) => [s.name,...['sell','cost','ship','ad','fixed','feePct','units','targetPct'].map(k => decimal(rows[i].result.exact[k])),s.simulator.reserveEnabled?'사용':'꺼짐',s.simulator.reservePct])
    ] }];
  }
  function timelineSheets(months) {
    const timeline = Core.timeline(months);
    if (!timeline.length) throw new Error('월별 정산을 먼저 저장해 주세요');
    return [{ name: '월별 정산', rows: [
      ['MarginKit 월별 수기 정산', '파일 분석과 별도로 직접 입력한 월별 기록'],
      ['주의', '수수료 차감 수령액은 원가·배송비·세금 차감 전 금액이며 VAT 성분은 납부세액이 아님'],
      ['비교 기준', '이전 저장 월과 비교하며 빠진 달을 0원으로 채우지 않음'],
      ['월','기록 이름','매출','수수료','수수료 차감 수령액','이전 기록 대비 수령액 변화','VAT 정확한 분수'],
      ...timeline.map(m => [m.month,m.name,decimal(m.result.totals.exact.sales),decimal(m.result.totals.exact.fee),decimal(m.result.totals.exact.take),decimal(m.change && m.change.take),m.result.totals.fractions.vat])
    ] }, { name: '월별 채널 상세', rows: [
      ['월','기록 이름','채널','매출','수수료율 %','VAT 가정 %','수수료','수령액','공급가액 정확한 분수','VAT 정확한 분수'],
      ...timeline.flatMap(m => m.result.rows.map(r => [m.month,m.name,r.channel,decimal(r.exact.sales),decimal(r.exact.feePct),decimal(r.exact.vatPct),decimal(r.exact.fee),decimal(r.exact.take),r.fractions.supply,r.fractions.vat]))
    ] }];
  }
  function display(value) { return value && typeof value === 'object' && typeof value.decimal === 'string' ? D.format(value.decimal) : String(value ?? ''); }
  const api = { decimal, cell, workbook, analysisSheets, scenarioSheets, timelineSheets, display };
  if (typeof module === 'object' && module.exports) module.exports = api;
  global.MarginKitPremiumExport = api;
})(typeof window !== 'undefined' ? window : globalThis);
