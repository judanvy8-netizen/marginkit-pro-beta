(function (global) {
  'use strict';
  function mount() {
    const host = document.getElementById('page-premium');
    const C = global.MarginKitPremiumCore, S = global.MarginKitSuite, A = global.MarginKitApp, E = global.MarginKitPremiumExport, D = global.MKDecimal;
    if (!host) return;
    if (!C || !S || !A || !E || !D) { host.textContent = 'Premium 도구를 불러오지 못했습니다 새로고침 후 다시 시도해 주세요'; return; }
    let storage;
    try { storage = global.localStorage; } catch (_) { storage = null; }
    const loaded = C.load(storage);
    const selected = new Set(loaded.document.scenarios.map(item => item.id));
    let app = A.snapshot(), warning = loaded.warning, restoreGeneration = 0, previousDemo = null, realFormDraft = null;
    const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    const money = value => value === null || value === undefined ? '—' : D.format(value) + '원';
    const id = () => 'p_' + (global.crypto?.randomUUID ? global.crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2));
    const currentDoc = () => app.isDemo ? C.defaults() : loaded.document;
    const status = el('p', 'premium-status'); status.id = 'premium-status'; status.setAttribute('role', 'status');
    const mode = el('p', 'premium-mode'); mode.id = 'premium-mode';
    function message(text, error = false) { status.textContent = text; status.classList.toggle('is-error', error); }
    function guard() { if (app.isDemo) throw new Error('예시 모드에서는 실제 Premium 저장 데이터를 읽거나 바꾸지 않습니다 분석 초기화로 예시 모드를 종료해 주세요'); }
    function act(fn) { return async () => { try { await fn(); } catch (error) { message(error.message || '작업을 완료하지 못했습니다', true); } }; }
    function button(text, fn, primary = false, buttonId) { const b = el('button', 'btn' + (primary ? ' btn-primary' : ''), text); b.type = 'button'; b.addEventListener('click', act(fn)); if (buttonId) b.id = buttonId; return b; }
    function field(parent, key, text, options) {
      const wrap = el('div', 'premium-field'), label = el('label', '', text), input = el(options ? 'select' : 'input');
      input.id = key; label.htmlFor = key;
      if (options) options.forEach(([value, text]) => { const o = el('option', '', text); o.value = value; input.append(o); });
      else { input.type = 'text'; input.maxLength = 80; }
      wrap.append(label, input); parent.append(wrap); return input;
    }
    function card(title, note, key) { const c = el('section', 'premium-card'); c.id = key; c.append(el('h2', '', title), el('p', 'premium-note', note)); host.append(c); return c; }
    function table(target, headers, rows) {
      target.replaceChildren();
      if (!rows.length) { target.append(el('p', 'premium-empty', '아직 저장된 항목이 없습니다')); return; }
      const wrap = el('div', 'premium-table-wrap'), t = el('table', 'premium-table'), head = el('thead'), tr = el('tr'), body = el('tbody');
      headers.forEach(text => tr.append(el('th', '', text))); head.append(tr);
      rows.forEach(values => { const r = el('tr'); values.forEach(value => { const td = el('td'); if (value && value.nodeType) td.append(value); else td.textContent = String(value ?? '—'); r.append(td); }); body.append(r); });
      t.append(head, body); wrap.append(t); target.append(wrap);
    }
    function mutate(fn, text) {
      guard(); const next = JSON.parse(JSON.stringify(loaded.document)); fn(next);
      const checked = C.validateDocument(next); A.checkRules(checked.rules);
      const result = C.save(storage, checked, loaded); if (!result.ok) throw new Error(result.error);
      restoreGeneration++;
      A.installRules(loaded.document.rules); app = A.snapshot(); warning = ''; render(); message(text);
    }
    function controls(...nodes) { const wrap = el('div', 'premium-actions'); wrap.append(...nodes); return wrap; }
    function remove(kind, key, title) {
      guard(); if (!global.confirm('저장한 ' + title + ' 항목을 삭제할까요?')) return;
      mutate(doc => { doc[kind] = doc[kind].filter(item => item.id !== key); selected.delete(key); }, '선택한 저장 항목을 삭제했습니다');
    }
    const heading = el('header', 'premium-heading');
    heading.append(el('div', 'premium-eyebrow', 'PREMIUM TOOLS · OPEN BETA'), el('h1', '', '한 번의 계산에서, 반복하는 업무로'), el('p', '', '원가 규칙부터 시나리오 비교와 월별 기록까지 이 브라우저에서 직접 사용하세요'));
    host.append(heading, mode, status);
    const jump = el('nav', 'premium-jump'); jump.setAttribute('aria-label', 'Premium 도구 바로가기');
    [['premium-scenarios','시나리오'],['premium-months','월별 정산'],['premium-budget','광고비'],['premium-rules','원가 규칙'],['premium-reports','리포트']].forEach(([key,text]) => jump.append(button(text, () => document.getElementById(key).scrollIntoView({ behavior:'smooth',block:'start' })))); host.append(jump);
    const scenario = card('시나리오 저장과 비교', '시뮬레이터의 현재 입력을 이름별로 보관하고 선택한 가정을 비교합니다 저장한 시나리오를 불러오면 현재 시뮬레이터 초안이 바뀝니다', 'premium-scenarios');
    const scenarioForm = el('div', 'premium-form'); const scenarioName = field(scenarioForm, 'premium-scenario-name', '시나리오 이름'); scenarioName.placeholder = '예: 광고비 20% 절감';
    const saveScenario = button('현재 시뮬레이션 저장', () => {
      guard(); const name = scenarioName.value.trim(); if (!name) throw new Error('시나리오 이름을 입력해 주세요');
      const old = loaded.document.scenarios.find(item => item.name === name);
      if (old && !global.confirm('같은 이름의 시나리오를 현재 입력으로 교체할까요?')) return;
      const item = C.validateScenario({ id: old?.id || id(), name, simulator:S.current.readSimulator() });
      mutate(doc => { doc.scenarios = doc.scenarios.filter(s => s.id !== item.id); doc.scenarios.push(item); selected.add(item.id); }, '현재 시뮬레이션을 이 브라우저에 저장했습니다');
    }, true, 'premium-save-scenario');
    scenarioForm.append(controls(saveScenario,button('시뮬레이터 열기 →',()=>A.navigate('simulator')))); scenario.append(scenarioForm);
    const scenarioList = el('div'); scenarioList.id = 'premium-scenario-list'; const comparison = el('div'); comparison.id = 'premium-comparison';
    scenario.append(scenarioList,el('h3','','선택한 가정 비교'),comparison);

    const months = card('다개월 정산 타임라인', '월간 수기 정산의 현재 채널 입력을 월별로 저장합니다 정산 파일 분석과 별개이며 수령액은 원가·배송비·세금 차감 전 금액입니다', 'premium-months');
    const monthForm = el('div','premium-form'); const monthInput=field(monthForm,'premium-month','정산 월'); monthInput.type='month';
    const now=new Date(); monthInput.value=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0');
    const monthName=field(monthForm,'premium-month-name','기록 이름'); monthName.placeholder='예: 11월 채널 정산';
    monthForm.append(controls(button('현재 수기 정산 저장',()=>{
      guard(); const month=monthInput.value, name=monthName.value.trim()||month+' 정산';
      const old=loaded.document.months.find(item=>item.month===month);
      if(old&&!global.confirm(month+'에 저장한 정산을 현재 입력으로 교체할까요?'))return;
      const item=C.validateMonth({id:old?.id||id(),month,name,lines:S.current.readSettlement()});
      mutate(doc=>{doc.months=doc.months.filter(m=>m.month!==month);doc.months.push(item);},month+' 정산을 저장했습니다');
    },true,'premium-save-month'),button('수기 정산 열기 →',()=>A.navigate('settlement')))); months.append(monthForm);
    const timeline=el('div');timeline.id='premium-timeline';months.append(timeline,el('p','premium-note','변화량은 바로 이전에 저장한 월과 비교합니다 기록이 없는 달을 0원으로 간주하지 않습니다'));

    const budget=card('광고비 상한 알림','분석 파일의 전체 광고비 합계와 시뮬레이터의 월 예상 광고비를 각각 비교합니다 두 금액을 합하지 않으며 이 화면에서 확인하는 알림입니다','premium-budget');
    const budgetForm=el('div','premium-form'),limitInput=field(budgetForm,'premium-budget-limit','광고비 한도 (원 · 0이면 꺼짐)'),warnInput=field(budgetForm,'premium-budget-warning','주의 표시 시작 (%)');
    for(const input of [limitInput,warnInput]){input.inputMode='decimal';input.maxLength=10000;}
    limitInput.value=loaded.document.budget.limit;warnInput.value=loaded.document.budget.warnPct;
    budgetForm.append(button('한도 저장',()=>mutate(doc=>{doc.budget={limit:limitInput.value,warnPct:warnInput.value};},'광고비 한도를 저장했습니다'),true,'premium-save-budget'));budget.append(budgetForm);
    const budgetResults=el('div','premium-budget-results');budgetResults.id='premium-budget-results';budget.append(budgetResults);

    const rules=card('자동 원가 매칭 규칙','등록된 정확한 상품코드와 정규화 상품명이 먼저 적용됩니다 규칙은 두 기본 매칭이 모두 없는 상품에만 적용하며 서로 다른 원가가 겹치면 원가 미확인으로 남깁니다','premium-rules');
    const ruleForm=el('div','premium-form');
    const ruleField=field(ruleForm,'premium-rule-field','비교할 필드',[['sku','상품코드'],['name','상품명']]);
    const ruleMatch=field(ruleForm,'premium-rule-match','조건',[['exact','문자 일치'],['prefix','이 문자로 시작'],['contains','이 문자 포함']]);
    const ruleValue=field(ruleForm,'premium-rule-value','찾을 문자');ruleValue.maxLength=200;
    const ruleCost=field(ruleForm,'premium-rule-cost','연결할 등록 원가',[]);
    const newRule=()=>C.validateRule({id:id(),field:ruleField.value,match:ruleMatch.value,value:ruleValue.value,costKey:ruleCost.value,enabled:true});
    const rulePreview=el('div');rulePreview.id='premium-rule-preview';
    const matchName={sku:'상품코드 일치',name:'상품명 일치',matched:'규칙 적용',conflict:'규칙 충돌 · 미적용',missing:'연결 원가 없음',none:'원가 미등록'};
    function showMatches(target,rows){table(target,['상품','상품코드','적용 결과','단위원가'],rows.map(row=>[row.product,row.sku,matchName[row.status]||row.status,row.cost?money(row.cost.unitCostExact??row.cost.unitCost):'—']));}
    ruleForm.append(controls(button('적용 결과 미리보기',()=>{guard();const rows=A.previewRules([...loaded.document.rules,newRule()]);showMatches(rulePreview,rows);message(rows.length?'저장 전 규칙 적용 결과를 확인해 주세요':'규칙을 미리 볼 분석 상품이 없습니다 정산 파일을 먼저 분석해 주세요');},false,'premium-preview-rule'),button('규칙 저장하고 적용',()=>{
      const item=newRule();mutate(doc=>{doc.rules.push(item);},'규칙을 저장하고 현재 분석에 적용했습니다');rulePreview.replaceChildren();
    },true,'premium-save-rule')));
    const ruleList=el('div');ruleList.id='premium-rule-list';const matchList=el('div');matchList.id='premium-matches';
    rules.append(ruleForm,el('p','premium-note','상품코드는 대소문자를 구분합니다 상품명은 공백·일부 구분자와 대소문자를 정리해 비교합니다 기존 원가표의 값은 변경하지 않습니다'),rulePreview,ruleList,el('h3','','현재 분석의 원가 연결'),matchList);

    const reports=card('Excel 리포트와 인쇄 · PDF','상품 분석, 선택한 시나리오 또는 월별 정산을 내보냅니다 Excel 정밀도를 넘는 수는 정확한 텍스트 셀로 보존하고 인쇄창에서 PDF로 저장할 수 있습니다','premium-reports');
    const reportForm=el('div','premium-form'),reportKind=field(reportForm,'premium-report-kind','내보낼 데이터',[['analysis','현재 상품 분석'],['scenarios','선택한 시나리오 비교'],['timeline','저장한 월별 정산']]);
    const sheets=()=>{
      app=A.snapshot();if(app.isDemo&&reportKind.value!=='analysis')throw new Error('예시 모드에서는 예시 상품 분석만 내보낼 수 있습니다');
      return reportKind.value==='analysis'?E.analysisSheets(app):reportKind.value==='scenarios'?E.scenarioSheets(currentDoc().scenarios.filter(s=>selected.has(s.id))):E.timelineSheets(currentDoc().months);
    };
    reportForm.append(controls(button('Excel 다운로드',()=>{
      const data=sheets(),book=E.workbook(global.XLSX,data),bytes=global.XLSX.write(book,{type:'array',bookType:'xlsx'});
      download(new Blob([bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),'marginkit-'+(app.isDemo?'demo-':'')+reportKind.value+'.xlsx');message('Excel 다운로드를 시작했습니다');
    },true,'premium-export-xlsx'),button('인쇄 · PDF 저장',()=>{
      const data=sheets();if(data.reduce((n,s)=>n+s.rows.length,0)>2000)throw new Error('인쇄는 2,000행까지 지원합니다 전체 상세 기록은 Excel로 내보내 주세요');
      let print=document.getElementById('premium-print');if(print)print.remove();print=el('div');print.id='premium-print';
      print.append(el('h1','','MarginKit '+(app.isDemo?'예시 데이터':'리포트')),el('p','','작성 시각 '+new Date().toLocaleString('ko-KR')));
      for(const dataSheet of data){print.append(el('h2','',dataSheet.name));const t=el('table');dataSheet.rows.forEach((row,i)=>{const tr=el('tr');row.forEach(value=>tr.append(el(i===0?'th':'td','',E.display(value))));t.append(tr);});print.append(t);}
      document.body.append(print);global.print();message('인쇄창에서 대상 프린터 또는 PDF로 저장을 선택해 주세요');
    },false,'premium-print-report')));reports.append(reportForm);
    const backup=card('이 브라우저의 기록 보관','Premium 규칙·시나리오·월별 기록·광고비 한도만 JSON으로 보관합니다 상품 원가와 원본 정산 파일은 포함하지 않습니다','premium-backup');
    const restoreInput=el('input');restoreInput.type='file';restoreInput.accept='.json,application/json';restoreInput.id='premium-restore-file';restoreInput.hidden=true;
    backup.append(controls(button('Premium JSON 백업',()=>{guard();download(new Blob([JSON.stringify({format:'marginkit-premium',version:1,data:loaded.document},null,2)],{type:'application/json'}),'marginkit-premium-backup.json');message('Premium JSON 백업을 다운로드했습니다');},false,'premium-backup-json'),button('JSON 백업 병합',()=>{guard();restoreInput.click();},false,'premium-restore-json')),restoreInput,el('p','premium-note','복원은 기존 이름·ID·정산 월과 충돌하는 항목을 건너뛰며 기존 광고비 한도를 유지합니다 손상된 저장 원본은 자동으로 덮어쓰지 않습니다'));
    restoreInput.addEventListener('change',act(async()=>{
      guard();const file=restoreInput.files[0];if(!file)return;restoreInput.value='';if(file.size>1100000)throw new Error('JSON 백업은 1MB 이내로 선택해 주세요');
      const generation=++restoreGeneration, revision=loaded.revision, text=await file.text();
      if(generation!==restoreGeneration||revision!==loaded.revision||app.isDemo)throw new Error('파일을 읽는 동안 기록이나 모드가 변경되었습니다 현재 상태에서 백업을 다시 선택해 주세요');
      const raw=JSON.parse(text);if(!raw||raw.format!=='marginkit-premium'||raw.version!==1||Object.keys(raw).sort().join(',')!=='data,format,version')throw new Error('MarginKit Premium 백업 파일이 아닙니다');
      const incoming=C.validateDocument(raw.data),plan=JSON.parse(JSON.stringify(loaded.document));let added=0,skipped=0;
      for(const kind of ['rules','scenarios','months'])for(const item of incoming[kind]){
        const conflict=plan[kind].some(old=>old.id===item.id||(kind==='months'&&old.month===item.month)||(kind==='scenarios'&&old.name===item.name));
        if(conflict){skipped++;continue;}plan[kind].push(item);added++;
      }
      C.validateDocument(plan);A.checkRules(plan.rules);
      if(!global.confirm('백업에서 '+added+'개를 추가하고 중복 '+skipped+'개는 건너뜁니다 기존 광고비 한도는 유지합니다 계속할까요?'))return;
      mutate(doc=>{for(const kind of ['rules','scenarios','months'])doc[kind]=plan[kind];},added+'개를 병합하고 중복 '+skipped+'개를 유지했습니다');
      plan.scenarios.forEach(s=>selected.add(s.id));render();
    }));
    const future=el('aside','premium-future');future.append(el('h2','','서버 연결이 필요한 기능'),el('p','','팀 멤버와 권한, 계정 간 클라우드 동기화, 판매 채널 API 자동 수집, 예약 이메일은 아직 제공하지 않습니다 별도 인증·서버·판매 채널·메일 서비스 연결이 필요합니다'),el('p','','현재 도구는 무료 베타이며 결제·구독은 없습니다 이 기기와 브라우저에서만 기록이 유지되므로 JSON 백업을 보관해 주세요'));host.append(future);
    function download(blob,name){const url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();global.setTimeout(()=>URL.revokeObjectURL(url),1000);}
    function render() {
      if(previousDemo!==app.isDemo){
        const fields=[scenarioName,monthInput,monthName,limitInput,warnInput,ruleValue,ruleCost];
        if(app.isDemo){realFormDraft=fields.map(input=>input.value);fields.forEach(input=>input.value='');}
        else if(realFormDraft){fields.forEach((input,i)=>input.value=realFormDraft[i]);realFormDraft=null;}
        previousDemo=app.isDemo;restoreGeneration++;rulePreview.replaceChildren();restoreInput.value='';
        const oldPrint=document.getElementById('premium-print');if(oldPrint)oldPrint.remove();
        message('');
      }
      const doc=currentDoc();mode.textContent=app.isDemo?'예시 모드 · 실제 Premium 기록은 숨기고 저장·규칙 적용을 중지합니다 예시 상품 리포트는 내보낼 수 있습니다':'기기 내 저장 · 로그인이나 서버 전송 없이 이 브라우저에 저장됩니다';
      host.classList.toggle('premium-demo',app.isDemo);
      [scenario,months,budget,rules,backup].forEach(c=>c.querySelectorAll('input,select,button').forEach(node=>node.disabled=app.isDemo||loaded.blocked));
      if(warning)message(warning,true);
      table(scenarioList,['비교','시나리오','관리'],doc.scenarios.map(s=>{
        const check=el('input');check.type='checkbox';check.checked=selected.has(s.id);check.setAttribute('aria-label',s.name+' 비교에 포함');check.addEventListener('change',()=>{check.checked?selected.add(s.id):selected.delete(s.id);renderComparison();});
        return[check,s.name,controls(button('불러오기',()=>{guard();if(!global.confirm('현재 시뮬레이터 입력을 '+s.name+' 저장값으로 바꿀까요?'))return;S.current.loadSimulator(s.simulator);A.navigate('simulator');message('저장한 시나리오를 불러왔습니다');}),button('삭제',()=>remove('scenarios',s.id,s.name)))];
      }));renderComparison();
      table(timeline,['월 · 이름','매출','수수료','수령액','이전 저장 월 대비','관리'],C.timeline(doc.months).map(m=>[m.month+' · '+m.name,money(m.result.totals.exact.sales),money(m.result.totals.exact.fee),money(m.result.totals.exact.take),m.change?m.previousMonth+' 대비 '+money(m.change.take)+(m.gapMonths>1?' ('+m.gapMonths+'개월 간격)':''):'첫 기록',controls(button('불러오기',()=>{guard();if(!global.confirm('현재 수기 정산 입력을 '+m.month+' 기록으로 바꿀까요?'))return;S.current.loadSettlement(doc.months.find(x=>x.id===m.id).lines);A.navigate('settlement');}),button('삭제',()=>remove('months',m.id,m.month)))]));
      budgetResults.replaceChildren();
      const spend=app.totals.products.reduce((sum,p)=>D.add(sum,p.ads),'0');
      showBudget('분석 파일 전체 광고비',app.totals.products.length?spend:null,doc.budget);
      let planned=null;if(!app.isDemo)try{const sim=S.calculateSimulator(S.current.readSimulator()).exact;planned=D.mul(sim.ad,sim.units);}catch(_){}
      showBudget('시뮬레이터 월 예상 광고비',planned,doc.budget);
      const oldCost=ruleCost.value;ruleCost.replaceChildren();const blank=el('option','','등록 원가 선택');blank.value='';ruleCost.append(blank);
      if(!app.isDemo)app.costs.forEach(([key,c])=>{const o=el('option','',(c.sku?c.sku+' · ':'')+c.product+' · '+money(c.unitCostExact??c.unitCost));o.value=key;ruleCost.append(o);});if(app.costs.some(([key])=>key===oldCost))ruleCost.value=oldCost;
      table(ruleList,['상태','조건','연결 원가','관리'],doc.rules.map(r=>{const toggle=el('input');toggle.type='checkbox';toggle.checked=r.enabled;toggle.setAttribute('aria-label',r.value+' 규칙 사용');toggle.addEventListener('change',act(()=>mutate(d=>{d.rules.find(x=>x.id===r.id).enabled=toggle.checked;},'규칙 상태를 변경했습니다')));return[toggle,(r.field==='sku'?'상품코드':'상품명')+' '+({exact:'일치',prefix:'시작',contains:'포함'}[r.match])+' '+r.value,r.costKey,button('삭제',()=>remove('rules',r.id,r.value))];}));
      showMatches(matchList,app.matches);
    }
    function renderComparison(){const rows=C.compareScenarios(currentDoc().scenarios.filter(s=>selected.has(s.id)));table(comparison,['이름','판매가','광고비 / 건','잔액 / 건','월 예상 잔액','목표 판매가'],rows.map(({name,result:r})=>[name,money(r.exact.sell),money(r.exact.ad),money(r.exact.profit),money(r.exact.monthly),r.targetPrice===null?'달성 불가':money(r.targetPrice)]));}
    function showBudget(label,spend,value){const box=el('div','premium-budget-item');box.append(el('h3','',label));if(spend===null){box.append(el('p','','입력 또는 분석 데이터 없음'));}else{const b=C.budgetStatus(spend,value);box.dataset.level=b.status;box.append(el('strong','',money(spend)),el('p','',b.status==='disabled'?'한도 알림 꺼짐':b.status==='exceeded'?'한도 초과 '+money(b.over):b.status==='warning'?'주의 · 남은 한도 '+money(b.remaining):'한도 이내 · 남은 금액 '+money(b.remaining)));}budgetResults.append(box);}
    try { A.installRules(loaded.document.rules); app=A.snapshot(); } catch(error){warning='저장 규칙을 적용하지 못했습니다 '+error.message;}
    document.addEventListener('marginkit:change',()=>{app=A.snapshot();render();});
    global.addEventListener('storage',event=>{if(event.key===C.KEY||event.key===null){restoreGeneration++;warning='다른 탭에서 Premium 기록이 변경되었습니다 현재 화면을 새로고침한 뒤 저장해 주세요';message(warning,true);}});
    render();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
})(window);
