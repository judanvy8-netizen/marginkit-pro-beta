const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),D=require('../exact-decimal.js');
const source=fs.readFileSync(process.env.APP_SOURCE||path.join(root,'app.js'),'utf8');
const between=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const state={costs:new Map(),transactions:[],products:[],sortColumn:'revenue',sortAsc:false,isDemo:false};
const downloads=[];const storage=new Map();
const ctx=vm.createContext({state,premiumRules:[],MKDecimal:D,TextEncoder,Date,STORAGE_KEY_COSTS:'costs',toast(){},downloadBlob:(text,name,type)=>downloads.push({text,name,type}),localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v)},console});
vm.runInContext(between('function loadCostsFromStorage()', 'function restoreCostsFromStorage()')+
 between('function parseNum(v)', 'function findHeader(')+
 between('function ingestSalesRows(rows, map)', '// --- Dashboard Rendering ---')+
 between('function csvCell(v)', 'function downloadBlob(')+
 between('function exportCurrentProductsCostTemplate()', '// --- Validated, non-destructive JSON cost restoration ---'),ctx);
ctx.loadCostsFromStorage();
// Pure validator from full restore section, without DOM actions.
vm.runInContext(between('function validateCostSnapshot(text)', 'function planCostMerge('),ctx);
const map={product:'product',sku:'sku',revenue:'revenue',qty:'qty',commission:'fee',refunds:'refunds'};
function setup(rows,costs){state.costs=new Map();const parsed=ctx.ingestSalesRows(rows,map);assert.equal(parsed.ok,true);state.transactions=parsed.rows;for(const [sku,cost] of costs)assert.equal(ctx.setCost({product:sku,sku},cost),true);return ctx.totalUp();}
let pass=0,fail=0;function check(name,fn){try{fn();pass++;console.log('PASS',name);}catch(e){fail++;console.error('FAIL',name,e.stack);}}
check('0.3 minus 0.1 fee minus 0.2 cost is exactly zero, not a loss',()=>{
 const t=setup([{product:'P',sku:'P',revenue:'.3',qty:'1',fee:'.1'}],[['P','.2']]);assert.equal(D.normalize(t.profit),'0');assert.equal(D.compare(t.products[0].profit,'0'),0);
});
check('large quantity times cost retains all 24 integer digits',()=>{
 const t=setup([{product:'P',sku:'P',revenue:'1000000000000',qty:'1000000000000'}],[['P','999999999999']]);assert.equal(BigInt(t.products[0].cost),999999999999000000000000n);assert.equal(typeof t.products[0].cost,'string');
});
check('fractional quantity and cost remain fractional without implicit rounding',()=>{
 const t=setup([{product:'P',sku:'P',revenue:'1',qty:'.125',fee:'.025'}],[['P','.2']]);assert.equal(D.normalize(t.products[0].cost),'.025'.replace(/^\./,'0.'));assert.equal(D.normalize(t.profit),'0.95');assert.equal(D.normalize(t.qty),'0.125');
});
check('CSV decimal text survives Number projection in sales and persisted cost metadata',()=>{
 const precise='0.123456789012345678901234567890123456789';
 const t=setup([{product:'P',sku:'P',revenue:precise,qty:'1'}],[['P',precise]]);assert.equal(D.normalize(t.profit),'0');assert.equal(t.products[0].revenue,precise);assert.equal(state.costs.get('sku:P').unitCostExact,precise);assert.equal(ctx.loadCostsFromStorage().get('sku:P').unitCostExact,precise);
});
check('subnormal tiny positive and negative values keep exact sign in core classification',()=>{
 const tiny='0.'+'0'.repeat(330)+'1';
 const t=setup([{product:'P',sku:'P',revenue:'0',qty:'1'}],[['P',tiny]]);assert.equal(D.compare(t.profit,'0'),-1);assert.equal(t.profit,'-'+tiny);
 assert.equal(ctx.setCost({product:'bad',sku:'BAD'},'-'+tiny),false);
});
check('exact aggregate totals cancel across rows/products rather than accumulating epsilon',()=>{
 const t=setup([{product:'A',sku:'A',revenue:'.1',qty:'.1'},{product:'A',sku:'A',revenue:'.2',qty:'.2'},{product:'B',sku:'B',revenue:'-.3',qty:'0'}],[['A','0'],['B','0']]);assert.equal(D.normalize(t.totalRevenue),'0');assert.equal(D.normalize(t.profit),'0');assert.equal(D.normalize(t.qty),'0.3');
});
check('core sort distinguishes totals separated below binary floating precision',()=>{
 const t=setup([{product:'A',sku:'A',revenue:'100000000000',qty:1},{product:'B',sku:'B',revenue:'100000000000.0000001',qty:1}],[['A',0],['B',0]]);assert.equal(t.products[0].sku,'B');
});
check('result CSV preserves long decimals and numeric negatives without formula prefixes',()=>{
 const t=setup([{product:'=FORMULA',sku:'P',revenue:'0',qty:'1000000000000'}],[['P','999999999999']]);ctx.downloadResults();const text=downloads.at(-1).text;assert.ok(text.includes("'=FORMULA"));assert.ok(text.includes('-999999999999000000000000'));assert.ok(!text.includes("'-999999999999000000000000"));
});
check('version2 JSON retains exact cost text through validated restore and v1 still valid',()=>{
 const precise='0.1234567890123456789012345';setup([{product:'P',sku:'P',revenue:1,qty:1}],[['P',precise]]);ctx.exportCostRegisterJson();const snapshot=JSON.parse(downloads.at(-1).text);assert.equal(snapshot.version,2);const parsed=ctx.validateCostSnapshot(downloads.at(-1).text);assert.equal(parsed.costs.get('sku:P').unitCostExact,precise);
 const v1={format:'marginkit-cost-register',version:1,mode:'real',exportedAt:'2026-10-31T00:00:00.000Z',costs:[['sku:A',{product:'A',sku:'A',unitCost:0.2}]]};assert.equal(ctx.validateCostSnapshot(JSON.stringify(v1)).costs.size,1);
});
check('forged precision metadata cannot override a different projected value or bypass v1 schema',()=>{
 const base={format:'marginkit-cost-register',version:2,mode:'real',exportedAt:'2026-10-31T00:00:00.000Z',costs:[['sku:A',{product:'A',sku:'A',unitCost:1,unitCostExact:'2'}]]};assert.throws(()=>ctx.validateCostSnapshot(JSON.stringify(base)));base.costs[0][1].unitCostExact='1';base.version=1;assert.throws(()=>ctx.validateCostSnapshot(JSON.stringify(base)));
});
check('input keeps existing finite numeric magnitude bounds and rejects giant text exponents',()=>{
 for(const bad of ['1e999999999','1e-999999999','1'.repeat(10001),'1000000000000.0000001','Infinity'])assert.equal(D.input(bad),null);
 assert.equal(D.input(1e-7),'0.0000001');assert.equal(D.input('(₩1,234.125)'),'-1234.125');
});
check('monetary formatting preserves fractional digits and full large integers',()=>{
 assert.equal(D.format('999999999999000000000000'),'999,999,999,999,000,000,000,000');assert.equal(D.format('.125'),'0.125');assert.equal(D.format('-0.0001'),'-0.0001');
});
check('percentage is explicitly display-only approximation, zero denominator unavailable',()=>{assert.equal(D.percentage(1,3),33.333333333333);assert.equal(D.percentage(1,0),null);});
check('independent Python Decimal reference: 100 seeded cases x add/sub/mul/compare',()=>{
 for(const c of JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/decimal-reference.json'),'utf8')).cases){for(const op of ['add','sub','mul','compare'])assert.equal(D[op](c.a,c.b),c[op],`${op} ${c.a} ${c.b}`);}
});
check('maximum supported fractional literal remains exact in multirow arithmetic',()=>{
 const tiny='0.'+'0'.repeat(9997)+'1';assert.equal(D.input(tiny),tiny);
 let total='0';for(let i=0;i<20;i++)total=D.add(total,D.mul(tiny,'0.5'));
 assert.equal(total,'0.'+'0'.repeat(9996)+'1');
});
check('aggregate numeric-text budget rejects oversized payload without reducing precision',()=>{
 assert.equal(ctx.withinDecimalBudget(Array.from({length:20000},()=>({a:'1000000000000',b:'1000000000000',c:'1000000000000',d:'1000000000000',e:'1000000000000',f:'1000000000000',g:'1000000000000'})),['a','b','c','d','e','f','g']),true);
 const literal='0.'+'0'.repeat(9997)+'1';const rows=Array.from({length:301},()=>({product:'P',sku:'P',revenue:literal,qty:'1'}));
 const result=ctx.ingestSalesRows(rows,map);assert.equal(result.ok,false);assert.match(result.error,/처리 한도/);
});
check('tiny negative exact profit colors margin as loss even when display ratio truncates to zero',()=>{
 const t=setup([{product:'P',sku:'P',revenue:'1',qty:'1'}],[['P','1.000000000000000000000001']]);assert.equal(t.products[0].margin,0);assert.equal(D.compare(t.products[0].profit,'0'),-1);
 assert.ok(source.includes("p.margin === null ? '' : (MKDecimal.compare(p.profit, '0') < 0"));
});
check('long malformed literal is rejected with unambiguous decimal grammar',()=>{
 assert.equal(D.input('0'.repeat(9999)+'x'),null);assert.equal(D.input('1'.repeat(9999)+'x'),null);
 assert.equal(D.normalize('1.'),'1');assert.equal(D.normalize('.1'),'0.1');assert.equal(D.normalize('+1.20'),'1.2');
});
check('shared name precision cannot expand across hundreds of SKUs beyond derived budget',()=>{
 const tiny='0.'+'0'.repeat(9997)+'1';const rows=Array.from({length:400},(_,i)=>({product:'Shared',sku:'S'+i,revenue:1,qty:1,commission:0,shipping:0,ads:0,refunds:0,other:0}));
 const costs=new Map([['name:shared',{product:'Shared',sku:'',unitCost:0,unitCostExact:tiny}]]);
 assert.equal(ctx.calculationWithinBudget(rows,costs),false);
 state.transactions=rows;state.costs=new Map();const before=storage.get('costs');
 assert.equal(ctx.setCost({product:'Shared',sku:''},tiny),false);assert.equal(state.costs.size,0);assert.equal(storage.get('costs'),before);state.transactions=[];
});
check('ordinary 20000 distinct SKU calculations stay within derived budget',()=>{
 const rows=Array.from({length:20000},(_,i)=>({product:'P',sku:'S'+i,revenue:1e12,qty:1e12,commission:1e12,shipping:1e12,ads:1e12,refunds:1e12,other:1e12}));
 const costs=new Map([['name:p',{product:'P',sku:'',unitCost:1e12}]]);assert.equal(ctx.calculationWithinBudget(rows,costs),true);
});
check('clearing inherited name-based cost is a truthful no-op, never deletes shared record',()=>{
 state.isDemo=true;state.transactions=[];state.costs=new Map([['name:shared',{product:'Shared',sku:'',unitCost:12}]]);
 const before=JSON.stringify([...state.costs]);assert.equal(ctx.removeRegisteredCost('sku:A'),false);assert.equal(JSON.stringify([...state.costs]),before);
 assert.equal(ctx.getCost({product:'Shared',sku:'A'}).unitCost,12);
});
check('SKU override deletion restores name fallback without deleting shared cost',()=>{
 assert.equal(ctx.setCost({product:'Shared',sku:'A'},'15.5'),true);assert.equal(ctx.getCost({product:'Shared',sku:'A'}).unitCost,15.5);
 assert.equal(ctx.removeRegisteredCost('sku:A'),true);assert.equal(ctx.getCost({product:'Shared',sku:'A'}).unitCost,12);assert.ok(state.costs.has('name:shared'));
 assert.equal(ctx.removeRegisteredCost('name:shared'),true);assert.equal(ctx.getCost({product:'Shared',sku:'A'}),null);state.isDemo=false;
});
console.log(`${pass} decimal-core checks passed; ${fail} failed`);if(fail)process.exitCode=1;
