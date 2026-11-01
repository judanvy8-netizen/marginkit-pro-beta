import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const requireXlsx = () => createRequire(import.meta.url)('../vendor/xlsx-0.20.3.full.min.js');
const root = new URL('../', import.meta.url);
const source = fs.readFileSync(process.env.APP_SOURCE || new URL('app.js', root), 'utf8');
const slice = (a,b) => source.slice(source.indexOf(a), source.indexOf(b,source.indexOf(a)));
const downloads = [], notices = [];
const state = {isDemo:false,costs:new Map([
 ['sku:A',{product:'판매 상품',sku:'A',unitCost:0}],
 ['sku:B',{product:'미판매 상품',sku:'B',unitCost:250}]
])};
const ctx = vm.createContext({state, downloads, notices, Date,
 toast: x=>notices.push(x), downloadBlob:(csv,name,type)=>downloads.push({csv,name,type}),
 totalUp:()=>({products:[{product:'판매 상품',sku:'A',unitCost:0}]}),
 downloadCostTemplate:()=>{throw Error('must not substitute sample data');}
});
vm.runInContext(fs.readFileSync(new URL('exact-decimal.js', root), 'utf8'), ctx);
vm.runInContext(slice('function parseNum(v)', 'function norm(s)')+
 slice('function ingestSalesRows(rows, map)', 'function ingestCostRows(')+
 slice('function csvCell(v)', 'function downloadBlob')+
 slice('function exportCurrentProductsCostTemplate()', 'function downloadResults()'),ctx);
let passed=0,failed=0;
function check(name, fn) {try{fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.message);}}
const map={product:'product',revenue:'revenue',commission:'fee'};
const row=(fee)=>({product:'P',revenue:1000,fee});
check('full registered-cost export includes unsold products and zero cost',()=>{
 ctx.exportRegisteredCosts();assert.match(downloads.at(-1).csv,/미판매 상품,B,250/);assert.match(downloads.at(-1).csv,/판매 상품,A,0/);
});
check('full export works without analyzed sales',()=>{
 ctx.totalUp=()=>({products:[]});ctx.exportRegisteredCosts();assert.match(downloads.at(-1).csv,/미판매 상품,B,250/);
});
check('export does not mutate the active register or depend on filtered results',()=>{
 const before=JSON.stringify([...state.costs]);
 ctx.totalUp=()=>{throw Error('full register export must not read filtered sales');};
 ctx.exportRegisteredCosts();assert.equal(JSON.stringify([...state.costs]),before);
});
check('demo export cannot be mistaken for real stored cost export',()=>{
 state.isDemo=true;state.costs=new Map([['sku:DEMO',{product:'데모 전용',sku:'DEMO',unitCost:1}]]);
 ctx.exportRegisteredCosts();assert.match(downloads.at(-1).name,/demo/);assert.match(downloads.at(-1).csv,/데모 전용/);assert.doesNotMatch(downloads.at(-1).csv,/미판매 상품/);state.isDemo=false;
});
check('CSV preserves BOM, Korean text, commas, quotes and newlines',()=>{
 state.costs=new Map([['sku:X',{product:'한글,"상품"\n다음줄',sku:'x,y',unitCost:12}]]);ctx.exportRegisteredCosts();
 const csv=downloads.at(-1).csv;assert.equal(csv.charCodeAt(0),0xfeff);
 const XLSX = requireXlsx();
 const wb=XLSX.read(csv,{type:'string',raw:true});
 const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:true});
 assert.equal(rows[1][0],'한글,"상품"\n다음줄');assert.equal(rows[1][1],'x,y');assert.equal(String(rows[1][2]),'12');
});
check('formula-like text is intentionally prefixed for spreadsheet safety',()=>{
 for(const text of ['=1+1','+SUM(A1)','-SUM(A1)','@SUM(A1)',' \t=1+1']) {
  state.costs=new Map([['sku:X',{product:text,sku:text,unitCost:12}]]);ctx.exportRegisteredCosts();
  assert.ok(downloads.at(-1).csv.includes("'"+text));
 }
});
check('empty full export produces no fake sample and no download',()=>{
 state.costs=new Map();const n=downloads.length;ctx.exportRegisteredCosts();assert.equal(downloads.length,n);assert.match(notices.at(-1),/없/);
});
check('JSON round-trip preserves exact keys, formula-like identifiers, Unicode and zero',()=>{
 state.costs=new Map([
  ['sku:=A',{product:'=SUM(1)',sku:'=A',unitCost:0}],
  ['name:한글',{product:'한글,"이름"\r\n다음줄',sku:'',unitCost:123.45}],
  ['sku:00001',{product:'emoji 🐱',sku:'00001',unitCost:1000000000000}]
 ]);
 const before=JSON.stringify([...state.costs]);ctx.exportCostRegisterJson();
 const file=downloads.at(-1),snapshot=JSON.parse(file.csv);
 assert.equal(snapshot.format,'marginkit-cost-register');assert.equal(snapshot.version,1);assert.equal(snapshot.mode,'real');
 assert.ok(Number.isFinite(Date.parse(snapshot.exportedAt)));assert.equal(file.type,'application/json;charset=utf-8');assert.match(file.name,/\.json$/);
 assert.equal(JSON.stringify([...new Map(snapshot.costs)]),before);
 assert.equal(JSON.stringify([...state.costs]),before);
 // This validates serialization only, not a UI importer or persistence restore.
});
check('JSON demo snapshot contains only demo register and declares demo mode',()=>{
 state.isDemo=true;state.costs=new Map([['sku:DEMO',{product:'Only demo',sku:'DEMO',unitCost:1}]]);
 ctx.exportCostRegisterJson();const file=downloads.at(-1),snapshot=JSON.parse(file.csv);
 assert.match(file.name,/demo/);assert.equal(snapshot.mode,'demo');assert.equal(snapshot.costs.length,1);assert.equal(snapshot.costs[0][0],'sku:DEMO');
 state.isDemo=false;
});
check('empty JSON register never downloads a sample or misleading backup',()=>{
 state.costs=new Map();const count=downloads.length;ctx.exportCostRegisterJson();assert.equal(downloads.length,count);assert.match(notices.at(-1),/없/);
});
check('CSV fallback accepts BOM with Windows CRLF, Unix LF and legacy CR',()=>{
 const parser=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('import-parser.js',root),'utf8'),parser);
 for(const newline of ['\r\n','\n','\r']) {
  const workbook=parser.parseCsvToWorkbook('\ufeff상품명,상품코드'+newline+'한글,00001'+newline,'test.csv');
  const data=parser.sheetToRows(workbook,'Sheet1');assert.equal(data.rows[0]['상품코드'],'00001');assert.equal(data.rows[0]['상품명'],'한글');
 }
});
check('download helper creates, attaches, clicks and removes anchor then revokes URL',()=>{
 const events=[],timers=[];const anchor={click(){events.push('click');},remove(){events.push('remove');}};
 const sandbox=vm.createContext({Blob,URL:{createObjectURL(blob){assert.equal(blob.type,'application/json;charset=utf-8');events.push('url');return 'blob:test';},revokeObjectURL(url){assert.equal(url,'blob:test');events.push('revoke');}},document:{createElement(tag){assert.equal(tag,'a');return anchor;},body:{appendChild(a){assert.equal(a,anchor);events.push('append');}}},setTimeout(fn,ms){assert.ok(ms>=1000);timers.push(fn);}});
 vm.runInContext(slice('function downloadBlob(', 'function downloadSalesTemplate()'),sandbox);
 sandbox.downloadBlob('{}','snapshot.json','application/json;charset=utf-8');
 assert.equal(anchor.href,'blob:test');assert.equal(anchor.download,'snapshot.json');assert.deepEqual(events,['url','append','click','remove']);timers[0]();assert.equal(events.at(-1),'revoke');
});
check('oversized legacy JSON exports every record and warns it cannot restore directly',()=>{
 state.costs=new Map(Array.from({length:20001},(_,i)=>['sku:'+i,{product:'P',sku:String(i),unitCost:1}]));
 const before=JSON.stringify([...state.costs]);ctx.exportCostRegisterJson();
 assert.equal(JSON.stringify(JSON.parse(downloads.at(-1).csv).costs),before);
 assert.match(notices.at(-1),/20,000.*초과/);assert.equal(state.costs.size,20001);
});
console.log(`${passed} passed; ${failed} failed`);if(failed)process.exitCode=1;
