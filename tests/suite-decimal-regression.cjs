const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const suite=require(process.env.SUITE_SOURCE||'../suite-tools.js'),D=require('../exact-decimal'),R=require('../exact-rational');
const base=suite.defaults().simulator;
let passed=0,failed=0;function check(name,fn){try{fn();passed++;console.log('PASS',name);}catch(error){failed++;console.error('FAIL',name,error.stack);}}
check('independent Python Fraction references for 36 finite simulator scenarios',()=>{
 const refs=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/suite-decimal-reference.json'),'utf8'));
 for(const fixture of refs.simulator){const result=suite.calculateSimulator(fixture.input);for(const [key,value] of Object.entries(fixture.exact))assert.equal(result.exact[key],value,key);assert.equal(result.targetPrice,fixture.targetPrice);}
});
check('independent VAT fractions preserve recurring and finite values for both documented VAT assumptions',()=>{
 for(const ref of JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/suite-decimal-reference.json'),'utf8')).vat){const row=suite.calculateSettlement([{channel:'A',sales:ref.sales,feePct:0,vatPct:ref.vatPct}]).rows[0];assert.equal(row.fractions.supply,ref.supply);assert.equal(row.fractions.vat,ref.vat);}
});
check('simulator zero residue and fractional quantity remain exact',()=>{
 const r=suite.calculateSimulator({...base,sell:'.3',cost:'.1',ship:'.2',ad:0,fixed:0,feePct:0,units:'1.5'});assert.equal(r.exact.profit,'0');assert.equal(r.exact.units,'1.5');assert.equal(r.exact.monthly,'0');
});
check('tiny exact loss survives Number underflow and summaries do not round to whole won',()=>{
 const tiny='0.'+'0'.repeat(330)+'1';const r=suite.calculateSimulator({...base,sell:0,cost:tiny,ship:0,ad:0,fixed:0,feePct:0,units:'.5'});assert.equal(D.compare(r.exact.profit,'0'),-1);assert.ok(suite.simulatorSummary(r).includes('-'+tiny+'원'));assert.ok(suite.simulatorExport(r).includes('-'+tiny));
});
check('fees and reserve keep original fractional rates rather than Number projections',()=>{
 const rate='0.12345678901234567890123456789';const r=suite.calculateSimulator({...base,sell:'100',cost:0,ship:0,ad:0,fixed:0,feePct:rate,reserveEnabled:true,reservePct:rate,units:1});assert.equal(r.exact.fee,rate);assert.equal(r.exact.reserve,rate);assert.ok(suite.simulatorSummary(r).includes(rate+'%'));assert.ok(!suite.simulatorSummary(r).includes('[object Object]'));
});
check('one-won ceil applies only to explicitly documented target-price recommendation',()=>{
 const r=suite.calculateSimulator({...base,sell:'1',cost:'0.123456789',ship:0,ad:0,fixed:0,feePct:0,targetPct:0,units:'0.5'});assert.equal(r.targetPrice,1);assert.equal(r.exact.cost,'0.123456789');assert.equal(r.exact.profit,'0.876543211');assert.equal(r.exact.monthly,'0.4382716055');
});
check('display-only VAT approximation is not stored as an exact finite decimal',()=>{
 const r=suite.calculateSettlement([{sales:'1',feePct:'3.3',vatPct:'10'}]);assert.equal(r.rows[0].exact.supply,null);assert.equal(r.rows[0].exact.vat,null);assert.equal(r.rows[0].fractions.supply,'10/11');assert.equal(r.rows[0].fractions.vat,'1/11');assert.equal(r.rows[0].approximate.vat,true);assert.equal(r.rows[0].display.vat,'0.090909090909');assert.equal(r.totals.exact.take,'0.967');
});
check('VAT totals sum rational values before display, not per-row truncated decimals',()=>{
 const r=suite.calculateSettlement(Array.from({length:11},()=>({sales:'1',feePct:0,vatPct:10})));assert.equal(r.totals.fractions.vat,'1');assert.equal(r.totals.exact.vat,'1');assert.equal(r.totals.approximate.vat,false);assert.equal(r.totals.exact.supply,'10');
});
check('mixed taxable and exempt exact totals retain finite cash amounts',()=>{
 const r=suite.calculateSettlement([{sales:'.3',feePct:'1',vatPct:10},{sales:'.2',feePct:'1.5',vatPct:0}]);assert.equal(r.totals.exact.sales,'0.5');assert.equal(r.totals.exact.fee,'0.006');assert.equal(r.totals.exact.take,'0.494');assert.equal(r.totals.fractions.vat,'3/110');
});
check('settlement CSV and summary disclose approximate VAT and preserve fraction evidence',()=>{
 const r=suite.calculateSettlement([{channel:'=SUM(1)',sales:1,feePct:'3.3',vatPct:10}]);const csv=suite.settlementExport(r);assert.ok(csv.includes("'=SUM(1)"));assert.ok(csv.includes('10/11'));assert.ok(csv.includes('1/11'));assert.ok(csv.includes('표시값은 근사'));assert.ok(suite.settlementSummary(r).includes('≈0.090909090909원'));
});
check('CSV fee and cash values retain long decimals and malicious numeric wrappers reject',()=>{
 const sales='0.12345678901234567890123456789';const r=suite.calculateSettlement([{sales,feePct:0,vatPct:0}]);assert.ok(suite.settlementExport(r).includes(sales));assert.throws(()=>suite.makeCsv([[{decimal:'=SUM(1)'}]]));
});
check('unsupported exponent/resource input fails before large allocation without clamping values',()=>{
 for(const bad of ['1e999999999','1e-999999999','0'.repeat(10001),'0x10','Infinity','-0.0001'])assert.throws(()=>suite.calculateSimulator({...base,sell:bad}),RangeError);
 assert.equal(suite.calculateSimulator({...base,sell:'1e-7'}).exact.sell,'0.0000001');assert.throws(()=>R.decimal('0.'+'0'.repeat(20001)+'1'),/resource/);
});
check('many large precision settlement rows exceed resource budget instead of freezing silently',()=>{
 const tiny='0.'+'0'.repeat(9997)+'1';assert.throws(()=>suite.calculateSettlement(Array.from({length:11},()=>({sales:tiny,feePct:0,vatPct:10}))),RangeError);
 const r=suite.calculateSettlement([{sales:tiny,feePct:'1',vatPct:10}]);assert.ok(r.rows[0].fractions.vat.length>9990);
});
check('ratio exports retain exact fraction when numeric projection cannot display huge magnitude',()=>{
 const tiny='0.'+'0'.repeat(330)+'1';const r=suite.calculateSimulator({...base,sell:1,cost:0,ship:0,fixed:0,feePct:0,ad:tiny});assert.equal(r.adMultiple,null);assert.notEqual(r.fractions.adMultiple,null);assert.ok(suite.simulatorExport(r).includes('표시 범위 초과'));assert.ok(!suite.simulatorSummary(r).includes('광고비 0원으로 해당 없음'));
});
check('raw long-decimal drafts round-trip unchanged and oversize save keeps previous bytes',()=>{
 const draft=suite.defaults();draft.simulator.cost='0.1234567890123456789012345678901234567890123456789';let stored=null;const storage={getItem:()=>stored,setItem:(k,v)=>{stored=v;}};assert.equal(suite.saveDraft(storage,draft),true);assert.equal(suite.loadDraft(storage).draft.simulator.cost,draft.simulator.cost);const before=stored;
 const huge=suite.defaults();huge.settlement=Array.from({length:100},()=>({channel:'A',sales:'1'.repeat(10000),feePct:'1'.repeat(10000),vatPct:'10'}));assert.equal(suite.saveDraft(storage,huge),false);assert.equal(stored,before);
});
check('legacy VAT-inclusive conversion retains fractional cost instead of rounding to cents',()=>{
 const legacy={costPrice:'0.123456789',sellPrice:'1',platform:'0.058',customFee:'5.8',shippingFee:'0',adFee:'0',fixedCostPerUnit:'0',taxType:'general',monthlyVolume:'1.5',targetMarginRate:'25'};const draft=suite.migrateLegacy(legacy);assert.equal(draft.simulator.cost,'0.1358024679');assert.equal(draft.simulator.units,'1.5');assert.equal(draft.simulator.reserveEnabled,false);
});
check('rational operations serialize exact fractions without leaking BigInt into public result',()=>{
 assert.equal(R.fraction(R.add(R.decimal('0.1'),R.decimal('0.2'))),'3/10');assert.equal(R.finite(R.ratio(1n,8n)),'0.125');assert.equal(R.finite(R.ratio(1n,7n)),null);assert.doesNotThrow(()=>JSON.stringify(suite.calculateSettlement([{sales:1,feePct:3.3,vatPct:10}])));
});
check('CSV margin overflow is distinguished from zero denominator, including channel comparison',()=>{
 const tiny='0.'+'0'.repeat(330)+'1';const r=suite.calculateSimulator({...base,sell:tiny,cost:1,ship:0,ad:0,fixed:0,feePct:0});assert.equal(r.margin,null);assert.notEqual(r.fractions.margin,null);
 const csv=suite.simulatorExport(r);const line=csv.split('\r\n').find(line=>line.startsWith('"잔액률 (표시용 근사)"'));assert.ok(line.includes('표시 범위 초과'));assert.ok(!line.includes('해당 없음'));
 for(const channel of ['스마트스토어 예시','쿠팡 예시','11번가·G마켓 예시','종합몰 예시'])assert.ok(csv.split('\r\n').find(line=>line.startsWith('"'+channel+'"')).includes('표시 범위 초과'));
});
check('all CSV exact fraction evidence is prefixed as text, avoiding spreadsheet dates or numeric rounding',()=>{
 const csv=suite.settlementExport(suite.calculateSettlement([{sales:1,feePct:0,vatPct:10}]));assert.ok(csv.includes('"fraction: 10/11"'));assert.ok(csv.includes('"fraction: 1/11"'));
 const sim=suite.simulatorExport(suite.calculateSimulator({...base,sell:1,cost:2,ship:0,ad:0,fixed:0,feePct:0}));assert.ok(sim.includes('"fraction: -1"'));
});
console.log(`${passed} suite-decimal checks passed; ${failed} failed`);if(failed)process.exitCode=1;
