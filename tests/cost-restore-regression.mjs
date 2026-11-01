import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const between=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const item=(sku='A',unitCost=10,product='상품')=>[`sku:${sku}`,{product,sku,unitCost}];
const snapshot=(costs=[item()],mode='real')=>({format:'marginkit-cost-register',version:1,mode,exportedAt:'2026-10-31T00:00:00.000Z',costs});
function harness({demo=false,writeFail=false}={}) {
 const state={isDemo:demo,costs:new Map([item('OLD',20)])};
 let stored=JSON.stringify([...state.costs]);const notices=[],elements=new Map();let writes=0,renders=0;
 const $=id=>{if(!elements.has(id))elements.set(id,{value:'',textContent:'',disabled:false,focus(){},classList:{add(){},remove(){}}});return elements.get(id);};
 const ctx=vm.createContext({state,$,TextEncoder,Date,STORAGE_KEY_COSTS:'costs',toast:x=>notices.push(x),
 localStorage:{getItem(){return stored;},setItem(k,v){if(writeFail)throw Error('QuotaExceededError');stored=v;writes++;}},
 renderProducts(){renders++;},renderDashboard(){},renderResults(){}});
 vm.runInContext(fs.readFileSync(new URL('../exact-decimal.js',import.meta.url),'utf8'),ctx);
 vm.runInContext(between('function loadCostsFromStorage()', 'function restoreCostsFromStorage()')+between('function parseNum(v)', 'function findHeader(')+between('// --- Validated, non-destructive JSON cost restoration ---','// --- Add Product Modal Handlers ---'),ctx);
 ctx.loadCostsFromStorage();
 return {ctx,state,$,notices,get stored(){return stored;},set stored(v){stored=v;},get writes(){return writes;},get renders(){return renders;}};
}
const file=data=>{const text=typeof data==='string'?data:JSON.stringify(data);return {size:Buffer.byteLength(text),text:async()=>text};};
let pass=0;
async function check(name,fn){await fn();pass++;console.log('PASS',name);}
await check('complete schema parses without mutation and preview requires separate confirmation',async()=>{
 const h=harness(),old=h.stored;await h.ctx.previewCostRestore(file(snapshot()));assert.equal(h.stored,old);assert.equal(h.state.costs.size,1);assert.equal(h.writes,0);assert.match(h.$('#costRestoreSummary').textContent,/새로 추가 1개/);
 h.ctx.confirmCostRestore();assert.equal(h.writes,1);assert.equal(h.state.costs.get('sku:A').unitCost,10);assert.equal(h.state.costs.get('sku:OLD').unitCost,20);assert.equal(h.renders,1);
 h.ctx.confirmCostRestore();assert.equal(h.writes,1);
});
await check('duplicate current keys are previewed and preserved, not overwritten',async()=>{
 const h=harness();await h.ctx.previewCostRestore(file(snapshot([item('OLD',999),item('NEW',0)])));assert.match(h.$('#costRestoreSummary').textContent,/건너뜀 1개/);h.ctx.confirmCostRestore();assert.equal(h.state.costs.get('sku:OLD').unitCost,20);assert.equal(h.state.costs.get('sku:NEW').unitCost,0);
});
await check('corrupt/unknown version/unknown fields/bad mode/date reject atomically',async()=>{
 const bad=['{', {...snapshot(),version:999},{...snapshot(),extra:1},{...snapshot(),mode:'other'},{...snapshot(),exportedAt:'yesterday'},[],null];
 for(const value of bad){const h=harness(),before=h.stored;await h.ctx.previewCostRestore(file(value));h.ctx.confirmCostRestore();assert.equal(h.stored,before);assert.equal(h.writes,0);assert.ok(h.notices.length);}
});
await check('invalid entries including later entry reject whole file',async()=>{
 const bad=[['__proto__',{product:'x',sku:'x',unitCost:1}],item('B',-1),item('B',1e12+1),item('B','10'),item('B',null),item('B',10,''),['sku:B',{product:'x',sku:'B',unitCost:1,extra:1}],['sku:WRONG',{product:'x',sku:'B',unitCost:1}],item('A',3)];
 for(const record of bad){const h=harness(),before=h.stored;await h.ctx.previewCostRestore(file(snapshot([item(),record])));h.ctx.confirmCostRestore();assert.equal(h.stored,before);assert.equal(h.writes,0);}
 const h=harness();await h.ctx.previewCostRestore(file(JSON.stringify(snapshot()).replace('"unitCost":10','"unitCost":1e309')));assert.equal(h.writes,0);assert.ok(h.notices.length);
});
await check('prototype field injection rejected but safe Map SKU __proto__ preserved',async()=>{
 const h=harness();const raw=JSON.stringify(snapshot()).replace('"unitCost":10','"unitCost":10,"__proto__":{"polluted":true}');await h.ctx.previewCostRestore(file(raw));h.ctx.confirmCostRestore();assert.equal(h.writes,0);
 await h.ctx.previewCostRestore(file(snapshot([item('__proto__',0),item('constructor',1),item('=SUM(A1)',2,'한글\n🐱')])));h.ctx.confirmCostRestore();assert.equal(h.state.costs.get('sku:__proto__').sku,'__proto__');assert.equal(h.state.costs.get('sku:=SUM(A1)').product,'한글\n🐱');assert.equal({}.polluted,undefined);
});
await check('quota failure preserves both state and stored bytes with no render',async()=>{
 const h=harness({writeFail:true}),old=h.state.costs,before=h.stored;await h.ctx.previewCostRestore(file(snapshot()));h.ctx.confirmCostRestore();assert.equal(h.state.costs,old);assert.equal(h.stored,before);assert.equal(h.renders,0);assert.match(h.notices.at(-1),/Quota/);
});
await check('cancel invalidates preview and pending read',async()=>{
 const h=harness();await h.ctx.previewCostRestore(file(snapshot()));h.ctx.cancelCostRestore();h.ctx.confirmCostRestore();assert.equal(h.writes,0);
 let resolve;const work=h.ctx.previewCostRestore({size:10,text:()=>new Promise(r=>resolve=r)});h.ctx.cancelCostRestore();resolve(JSON.stringify(snapshot()));await work;h.ctx.confirmCostRestore();assert.equal(h.writes,0);
});
await check('newer file wins over late previous file read',async()=>{
 const h=harness();let resolve;const work=h.ctx.previewCostRestore({size:10,text:()=>new Promise(r=>resolve=r)});await h.ctx.previewCostRestore(file(snapshot([item('NEW')])));resolve(JSON.stringify(snapshot([item('STALE')])));await work;h.ctx.confirmCostRestore();assert.ok(h.state.costs.has('sku:NEW'));assert.ok(!h.state.costs.has('sku:STALE'));
});
await check('mode switch, map replacement, map edit and other-tab write block stale confirmation',async()=>{
 for(const change of [h=>h.state.isDemo=true,h=>h.state.costs=new Map(h.state.costs),h=>h.state.costs.set(...item('EXTERNAL')),h=>h.stored='changed']){
 const h=harness();await h.ctx.previewCostRestore(file(snapshot()));change(h);const before=h.stored;h.ctx.confirmCostRestore();assert.equal(h.stored,before);assert.equal(h.writes,0);assert.ok(!h.state.costs.has('sku:A'));}
});
await check('mode switch during file read rejects stale preview',async()=>{
 const h=harness();let resolve;const work=h.ctx.previewCostRestore({size:10,text:()=>new Promise(r=>resolve=r)});h.state.isDemo=true;resolve(JSON.stringify(snapshot()));await work;h.ctx.confirmCostRestore();assert.equal(h.writes,0);
});
await check('demo restoration never reads or writes real storage and cross-mode backup rejects',async()=>{
 const h=harness({demo:true});h.ctx.localStorage={getItem(){throw Error('real storage touched');},setItem(){throw Error('real storage touched');}};
 await h.ctx.previewCostRestore(file(snapshot()));h.ctx.confirmCostRestore();assert.equal(h.state.costs.size,1);
 await h.ctx.previewCostRestore(file(snapshot([item()],'demo')));h.ctx.confirmCostRestore();assert.equal(h.state.costs.size,2);assert.equal(h.writes,0);
});
await check('empty or conflict-only backups never enable confirmation',async()=>{
 for(const costs of [[],[item('OLD',999)]]){const h=harness();await h.ctx.previewCostRestore(file(snapshot(costs)));assert.equal(h.$('#btnConfirmCostRestore').disabled,true);h.ctx.confirmCostRestore();assert.equal(h.writes,0);}
});
await check('size and record bounds reject before mutation',async()=>{
 const h=harness();await h.ctx.previewCostRestore({size:10485761,text(){throw Error('must not read');}});assert.match(h.notices.at(-1),/10MB/);
 await h.ctx.previewCostRestore(file(snapshot(Array(20001).fill(item()))));assert.equal(h.writes,0);assert.ok(h.notices.length>=2);
});
await check('BOM-prefixed exact exported JSON restores formula/leading-zero/name-key records',async()=>{
 const h=harness();const costs=[item('00001',123.45,'Name'),['name:한글',{product:'한글',sku:'',unitCost:0}],item('=A',1)];
 await h.ctx.previewCostRestore(file('\ufeff'+JSON.stringify(snapshot(costs))));h.ctx.confirmCostRestore();for(const [key,value] of costs)assert.equal(JSON.stringify(h.state.costs.get(key)),JSON.stringify(value));
});
await check('read failure and actual UTF-8 payload size reject even if advertised size is small',async()=>{
 const h=harness();await h.ctx.previewCostRestore({size:1,text:async()=>{throw Error('read failed');}});assert.equal(h.writes,0);assert.match(h.notices.at(-1),/read failed/);
 await h.ctx.previewCostRestore({size:1,text:async()=> '가'.repeat(3500000)});assert.equal(h.writes,0);assert.match(h.notices.at(-1),/10MB/);
});
await check('pure merge is non-mutating and bounds final register size',()=>{
 const h=harness(),current=new Map([item('OLD')]),incoming=new Map([item('NEW')]);
 const result=h.ctx.planCostMerge(current,incoming);assert.equal(current.size,1);assert.equal(incoming.size,1);assert.equal(result.added,1);
 assert.throws(()=>h.ctx.planCostMerge(new Map(Array.from({length:20000},(_,i)=>item(String(i)))),incoming),/20,000/);
});
await check('other-tab update before preview cannot be overwritten by stale active memory',async()=>{
 const h=harness();h.stored=JSON.stringify([...h.state.costs,item('OTHER_TAB',77)]);const before=h.stored;
 await h.ctx.previewCostRestore(file(snapshot()));h.ctx.confirmCostRestore();assert.equal(h.stored,before);assert.equal(h.writes,0);assert.ok(!h.state.costs.has('sku:A'));assert.ok(h.notices.length);
});
await check('missing persisted register with nonempty active memory is rejected',async()=>{
 const h=harness();h.stored=null;await h.ctx.previewCostRestore(file(snapshot()));h.ctx.confirmCostRestore();assert.equal(h.stored,null);assert.equal(h.writes,0);
});
await check('individually valid precision registers cannot merge beyond total resource budget',()=>{
 const h=harness(),tiny='0.'+'0'.repeat(9997)+'1';
 const entries=prefix=>new Map(Array.from({length:160},(_,i)=>[`sku:${prefix}${i}`,{product:'P',sku:prefix+i,unitCost:0,unitCostExact:tiny}]));
 const current=entries('OLD'),incoming=entries('NEW');
 assert.equal(h.ctx.withinDecimalBudget([...current.values()],['unitCost','unitCostExact']),true);
 assert.equal(h.ctx.withinDecimalBudget([...incoming.values()],['unitCost','unitCostExact']),true);
 assert.throws(()=>h.ctx.planCostMerge(current,incoming),/처리 한도/);assert.equal(current.size,160);assert.equal(incoming.size,160);
});
await check('20,000 normal registered entries serialize and validate for restore',()=>{
 const h=harness();h.state.costs=new Map();h.stored='[]';h.ctx.loadCostsFromStorage();
 const costs=new Map(Array.from({length:20000},(_,i)=>item(String(i))));
 assert.equal(h.ctx.commitCosts(costs),true);
 const restored=h.ctx.validateCostSnapshot(JSON.stringify(snapshot([...costs])));
 assert.equal(restored.costs.size,20000);assert.equal(h.state.costs.size,20000);
});
await check('ordinary 20,001st addition fails atomically in real and demo mode',()=>{
 for(const demo of [false,true]) {
  const h=harness({demo});h.state.costs=new Map(Array.from({length:20000},(_,i)=>item(String(i))));h.stored=JSON.stringify([...h.state.costs]);h.ctx.loadCostsFromStorage();
  const before=h.stored,original=h.state.costs,next=new Map(original);next.set(...item('EXTRA'));
  assert.equal(h.ctx.commitCosts(next),false);assert.equal(h.state.costs,original);assert.equal(h.stored,before);assert.match(h.notices.at(-1),/20,000/);
 }
});
await check('legacy oversized register loads intact and only deletion-only reduction persists',()=>{
 const h=harness();h.stored=JSON.stringify(Array.from({length:20003},(_,i)=>item(String(i))));h.state.costs=h.ctx.loadCostsFromStorage();
 assert.equal(h.state.costs.size,20003);assert.equal(h.ctx.loadCostsFromStorage.blocked,false);
 const before=h.stored,edited=new Map(h.state.costs);edited.set(...item('0',999));edited.delete('sku:1');
 assert.equal(h.ctx.commitCosts(edited),false);assert.equal(h.stored,before);
 const next=new Map(h.state.costs);next.delete('sku:1');assert.equal(h.ctx.commitCosts(next),true);assert.equal(h.state.costs.size,20002);
 const reduced=new Map(h.state.costs);reduced.delete('sku:2');reduced.delete('sku:3');assert.equal(h.ctx.commitCosts(reduced),true);assert.equal(h.state.costs.size,20000);
 const validEdit=new Map(h.state.costs);validEdit.set(...item('0',999));assert.equal(h.ctx.commitCosts(validEdit),true);
});
await check('stale legacy deletion cannot overwrite another tab',()=>{
 const h=harness();h.stored=JSON.stringify(Array.from({length:20002},(_,i)=>item(String(i))));h.state.costs=h.ctx.loadCostsFromStorage();
 const next=new Map(h.state.costs);next.delete('sku:1');h.stored='other tab';assert.equal(h.ctx.commitCosts(next),false);assert.equal(h.stored,'other tab');assert.equal(h.state.costs.size,20002);
});
console.log(`${pass} restore checks passed`);
