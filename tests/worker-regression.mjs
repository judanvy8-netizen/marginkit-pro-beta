import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const workerSource = fs.readFileSync(path.join(root, 'import-worker.js'), 'utf8');
const parserSource = fs.readFileSync(path.join(root, 'import-parser.js'), 'utf8');
const XLSX = createRequire(import.meta.url)(path.join(root, 'vendor/xlsx-0.20.3.full.min.js'));
const readSource = source.slice(source.indexOf('function readFile(file, cb)'), source.indexOf('// --- Navigation ---'));
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log('PASS', name); };
function readerHarness() {
  const workers = [], readers = [], callbacks = [], timers = [];
  class FakeWorker {
    constructor(url) { assert.equal(url, './import-worker.js'); workers.push(this); this.terminated = false; }
    postMessage(message, transfer) { this.message = message; this.transfer = transfer; }
    terminate() { this.terminated = true; }
  }
  class FakeReader {
    constructor() { readers.push(this); this.readyState = 0; }
    readAsArrayBuffer(file) { this.file = file; this.readyState = 1; }
    abort() { this.aborted = true; this.readyState = 2; }
    complete(buffer = new ArrayBuffer(8)) { this.readyState = 2; this.onload({ target:{result:buffer} }); }
  }
  const ctx = vm.createContext({ Worker:FakeWorker, FileReader:FakeReader, MAX_IMPORT_BYTES:10*1024*1024, setTimeout(fn,ms){const t={fn,ms};timers.push(t);return t;}, clearTimeout(t){if(t)t.cleared=true;} });
  vm.runInContext(readSource, ctx);
  return { ctx, workers, readers, callbacks, timers, start: () => ctx.readFile({ name:'a.xlsx',size:8 }, (...args)=>callbacks.push(args)) };
}
check('binary data transfers to dedicated worker and success terminates it', () => {
  const h = readerHarness();h.start();h.readers[0].complete();
  assert.equal(h.workers[0].message.name,'a.xlsx');assert.equal(h.workers[0].transfer[0],h.workers[0].message.buffer);
  const wb={SheetNames:['a'],Sheets:{a:[['A'],[1]]}};h.workers[0].onmessage({data:{ok:true,workbook:wb}});
  assert.equal(h.callbacks[0][0],null);assert.equal(h.callbacks[0][1],wb);assert.ok(h.workers[0].terminated);assert.ok(h.timers[0].cleared);
});
check('10-second deadline terminates slow parsing without late callbacks', () => {
  const h=readerHarness();h.start();h.readers[0].complete();const late=h.workers[0].onmessage;
  assert.equal(h.timers[0].ms,10000);h.timers[0].fn();late({data:{ok:true,workbook:{}}});
  assert.ok(h.workers[0].terminated);assert.equal(h.callbacks.length,1);assert.match(h.callbacks[0][0].message,/10초/);
});
check('cancellation aborts file read and worker, without committing results', () => {
  const h=readerHarness();const cancel=h.start();const late=h.workers[0].onmessage;cancel();late({data:{ok:true,workbook:{}}});
  assert.ok(h.readers[0].aborted);assert.ok(h.workers[0].terminated);assert.equal(h.callbacks.length,0);
});
check('worker failure terminates processing and reports a retryable error', () => {
  const h=readerHarness();h.start();h.workers[0].onerror({});assert.ok(h.workers[0].terminated);assert.equal(h.callbacks.length,1);assert.ok(h.callbacks[0][0]);
});
check('unsupported Worker fails closed instead of parsing on main thread', () => {
  const ctx=vm.createContext({MAX_IMPORT_BYTES:10*1024*1024});vm.runInContext(readSource,ctx);let error;ctx.readFile({size:8},e=>error=e);assert.match(error.message,/최신 브라우저/);
});
function workerHarness() {
  const results=[];
  const context=vm.createContext({ArrayBuffer,Uint8Array,DataView,TextDecoder,XLSX, self:{postMessage:x=>results.push(x)},importScripts(){}});
  vm.runInContext(parserSource+'\n'+workerSource,context);
  return {context,results,run(buffer,name){context.self.onmessage({data:{buffer,name}});return results.at(-1);}};
}
function asArrayBuffer(buffer){ return buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+buffer.byteLength); }
function workbookBytes(type='xlsx'){
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['상품명','코드','판매 수량'],['테스트','0001',0]]),'정산');
  return XLSX.write(wb,{type:'buffer',bookType:type,compression:true});
}
check('worker parses actual XLSX and XLS binary fixtures into bounded row arrays', () => {
  for(const type of ['xlsx','xls']){const h=workerHarness();const result=h.run(asArrayBuffer(workbookBytes(type)),'sample.'+type);assert.equal(result.ok,true,result.error);assert.equal(result.workbook.Sheets['정산'][1][1],'0001');assert.equal(result.workbook.Sheets['정산'][1][2],0);}
});
check('worker CSV preserves quoted newlines and rejects excess total cells', () => {
  const h=workerHarness();const good=h.run(asArrayBuffer(Buffer.from('상품,코드\n"두\n줄",0001')), 'a.csv');assert.equal(good.ok,true);assert.equal(good.workbook.Sheets.Sheet1[1][0],'두\n줄');
  const huge=Array(1300).fill(Array(200).fill('1').join(',')).join('\n');const result=h.run(asArrayBuffer(Buffer.from(huge)), 'a.csv');assert.equal(result.ok,false);assert.match(result.error,/250,000/);
});
check('ZIP preflight accepts ordinary file and rejects claimed decompression bomb', () => {
  const original=workbookBytes();const h=workerHarness();assert.ok(h.context.inspectZip(asArrayBuffer(original)).entries>0);
  const modified=Buffer.from(original);const offset=modified.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));modified.writeUInt32LE(100*1024*1024,offset+24);
  const result=h.run(asArrayBuffer(modified),'a.xlsx');assert.equal(result.ok,false);assert.match(result.error,/圧|압축/);
});
check('corrupt, encrypted and unsupported input is rejected without execution', () => {
  const h=workerHarness();assert.equal(h.run(asArrayBuffer(Buffer.from('<script>alert(1)</script>')),'a.xls').ok,false);
  const modified=Buffer.from(workbookBytes());const offset=modified.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));modified.writeUInt16LE(1,offset+8);const result=h.run(asArrayBuffer(modified),'a.xlsx');assert.equal(result.ok,false);assert.match(result.error,/암호화/);
});
check('invalidating an import invokes actual cancellation for both file types', () => {
  let cancelled=0;const state={importGeneration:{sales:1,cost:2},importCancel:{sales:()=>cancelled++,cost:()=>cancelled++}};
  const ctx=vm.createContext({state});const fn=source.slice(source.indexOf('function invalidateImportReads('),source.indexOf('function exitDemoMode('));vm.runInContext(fn,ctx);ctx.invalidateImportReads();assert.equal(cancelled,2);assert.equal(state.importGeneration.sales,2);assert.equal(state.importCancel.cost,null);
});
check('suite hash routes are allowlisted and navigation creates browser history', () => {
  const names=['dashboard','import','products','results','simulator','settlement'];
  const pages=names.map(name=>({id:'page-'+name,classList:{toggle(key,value){this[key]=value;}}}));
  const nav=names.map(name=>({dataset:{page:name},classList:{toggle(key,value){this[key]=value;}}}));
  const state={isDemo:false};const win={location:{hash:''},scrollTo(){}};const historyCalls=[];
  const ctx=vm.createContext({state,window:win,history:{pushState(a,b,url){historyCalls.push(url);win.location.hash=url;}},$(){return{classList:{toggle(){}}};},$$(selector){return selector==='.page'?pages:nav;},renderDashboard(){},renderProducts(){},renderResults(){}});
  const fn=source.slice(source.indexOf('function setPage('),source.indexOf('// --- Data Ingestion'));
  vm.runInContext(fn,ctx);
  ctx.setPage('simulator');assert.equal(state.activeTab,'simulator');assert.equal(pages[4].classList.active,true);assert.deepEqual(historyCalls,['#simulator']);
  ctx.setPage('settlement',false);assert.equal(state.activeTab,'settlement');assert.equal(historyCalls.length,1);
  ctx.setPage('<img onerror=alert(1)>',false);assert.equal(state.activeTab,'dashboard');assert.equal(pages[0].classList.active,true);
  assert.ok(source.includes("window.addEventListener('hashchange'"));assert.ok(source.includes("window.addEventListener('popstate'"));
});
console.log(`SUMMARY pass=${passed} fail=0`);
