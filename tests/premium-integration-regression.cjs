const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS',name);}
function dom(){
  const listeners={};
  function matches(node,selector){return selector.split(',').some(part=>{const s=part.trim();if(s.startsWith('#'))return node.id===s.slice(1);const data=/^\[data-field="([^"]+)"\]$/.exec(s);if(data)return node.dataset.field===data[1];return node.tagName===s;});}
  class Element{
    constructor(tag){this.tagName=tag;this.nodeType=1;this.children=[];this.listeners={};this.dataset={};this.attrs={};this.value='';this.className='';this._text='';this.style={};this.files=[];this.disabled=false;}
    set textContent(value){this._text=String(value);this.children=[];}get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
    get classList(){return {add:(...names)=>{const s=new Set(this.className.split(' '));names.forEach(n=>s.add(n));this.className=[...s].join(' ');},remove:(name)=>{this.className=this.className.split(' ').filter(n=>n!==name).join(' ');},toggle:(name,on)=>{const present=this.className.split(' ').includes(name);if(on===undefined)on=!present;on?this.classList.add(name):this.classList.remove(name);return on;},contains:name=>this.className.split(' ').includes(name)};}
    append(...nodes){for(const n of nodes){n.parent=this;this.children.push(n);}}
    replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
    setAttribute(k,v){this.attrs[k]=String(v);}removeAttribute(k){delete this.attrs[k];}
    addEventListener(k,fn){(this.listeners[k]||=[]).push(fn);}
    async dispatch(k){for(const fn of this.listeners[k]||[])await fn({target:this});}
    click(){if(this.tagName==='a'&&this.download)downloads.push({name:this.download,url:this.href});else return this.dispatch('click');}
    querySelectorAll(s){return this.children.flatMap(c=>[...(matches(c,s)?[c]:[]),...c.querySelectorAll(s)]);}
    querySelector(s){return this.querySelectorAll(s)[0]||null;}focus(){}select(){}scrollIntoView(){}
  }
  const downloads=[],body=new Element('body');
  for(const id of ['page-simulator','page-settlement','page-premium']){const n=new Element('section');n.id=id;body.append(n);}
  const document={body,readyState:'complete',createElement:tag=>new Element(tag),getElementById:id=>body.querySelector('#'+id),addEventListener(k,fn){(listeners[k]||=[]).push(fn);},dispatchEvent(event){for(const fn of listeners[event.type]||[])fn(event);}};
  return {document,downloads};
}
function harness(initial={}){
  const {document,downloads}=dom(),values=new Map(Object.entries(initial)),blobs=new Map();let mode=false,prints=0,navigation='',installed=[];
  const storage={getItem:k=>values.has(k)?values.get(k):null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const base={isDemo:false,source:'synthetic.csv',costs:[['sku:A',{sku:'A',product:'기준 상품',unitCost:2}]],matches:[],totals:{products:[{product:'합성 상품',sku:'0001',qty:'1',revenue:'10',refunds:'0',netRevenue:'10',unitCost:'2',cost:'2',commission:'1',shipping:'0',ads:'3',other:'0',profit:'4',hasCost:true}],totalRevenue:'10',totalRefunds:'0',profit:'4',missing:0}};
  const context={document,localStorage:storage,console,Blob,URL:{createObjectURL:b=>{const key='blob:'+blobs.size;blobs.set(key,b);return key;},revokeObjectURL(){}},setTimeout:fn=>fn(),navigator:{},confirm:()=>true,print:()=>prints++,addEventListener(){},crypto:{randomUUID:()=>Math.random().toString(16).slice(2)},MarginKitApp:{snapshot:()=>({...base,isDemo:mode}),checkRules:r=>r,installRules:r=>{installed=r;},previewRules:()=>[],navigate:p=>{navigation=p;document.dispatchEvent({type:'marginkit:change'});}}};context.window=context;context.globalThis=context;
  vm.createContext(context);for(const file of ['exact-decimal.js','exact-rational.js','suite-tools.js','premium-core.js','premium-export.js','vendor/xlsx-0.20.3.full.min.js','premium.js'])vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
  return {context,storage,values,document,get:id=>document.getElementById(id),downloads,blobs,get prints(){return prints;},get navigation(){return navigation;},get installed(){return installed;},setDemo(value){mode=value;document.dispatchEvent({type:'marginkit:change'});}};
}
(async()=>{
  await check('Premium page mounts with all five working areas and honest local/cloud labels',()=>{
    const h=harness();for(const id of ['premium-scenarios','premium-months','premium-budget','premium-rules','premium-reports'])assert.ok(h.get(id));
    assert.match(h.get('page-premium').textContent,/서버 연결이 필요한 기능/);assert.match(h.get('premium-mode').textContent,/이 브라우저/);
  });
  await check('saving named scenarios preserves exact decimal input and comparison, reload restores records',async()=>{
    const h=harness();h.get('suite-cost').value='0.123456789012345678901';await h.get('suite-cost').dispatch('input');h.get('premium-scenario-name').value='정밀 가정';await h.get('premium-save-scenario').dispatch('click');
    const data=JSON.parse(h.storage.getItem('marginkit_premium_v1'));assert.equal(data.scenarios.length,1);assert.equal(data.scenarios[0].simulator.cost,'0.123456789012345678901');assert.match(h.get('premium-comparison').textContent,/정밀 가정/);
    const reloaded=harness(Object.fromEntries(h.values));assert.match(reloaded.get('premium-scenario-list').textContent,/정밀 가정/);
    h.get('suite-cost').value='900';await h.get('suite-cost').dispatch('input');const load=h.get('premium-scenario-list').querySelectorAll('button').find(b=>b.textContent==='불러오기');await load.dispatch('click');assert.equal(h.get('suite-cost').value,'0.123456789012345678901');assert.equal(h.navigation,'simulator');
  });
  await check('saving nonconsecutive months compares actual stored months and loads channel inputs',async()=>{
    const h=harness();h.get('suite-row-0-sales').value='1000';await h.get('suite-settlement-rows').dispatch('input');h.get('premium-month').value='2026-01';await h.get('premium-save-month').dispatch('click');
    h.get('suite-row-0-sales').value='2000';await h.get('suite-settlement-rows').dispatch('input');h.get('premium-month').value='2026-03';await h.get('premium-save-month').dispatch('click');
    const saved=JSON.parse(h.storage.getItem('marginkit_premium_v1'));assert.equal(saved.months.length,2);assert.match(h.get('premium-timeline').textContent,/2개월 간격/);
    const load=h.get('premium-timeline').querySelectorAll('button').find(b=>b.textContent==='불러오기');await load.dispatch('click');assert.equal(h.get('suite-row-0-sales').value,'1000');assert.equal(h.navigation,'settlement');
  });
  await check('ad budget alert uses imported dataset spend without adding simulator projections',async()=>{
    const h=harness();h.get('premium-budget-limit').value='2';h.get('premium-budget-warning').value='80';await h.get('premium-save-budget').dispatch('click');assert.match(h.get('premium-budget-results').textContent,/한도 초과 1원/);assert.equal(JSON.parse(h.storage.getItem('marginkit_premium_v1')).budget.limit,'2');
  });
  await check('actual XLSX download and print report are generated from current analysis',async()=>{
    const h=harness();h.get('premium-report-kind').value='analysis';await h.get('premium-export-xlsx').dispatch('click');assert.equal(h.downloads[0].name,'marginkit-analysis.xlsx');
    const bytes=await h.blobs.get(h.downloads[0].url).arrayBuffer(),XLSX=require('../vendor/xlsx-0.20.3.full.min.js');const book=XLSX.read(bytes,{type:'array'});assert.ok(book.SheetNames.includes('상품별 분석'));assert.equal(book.Sheets['상품별 분석'].B2.v,'0001');
    await h.get('premium-print-report').dispatch('click');assert.equal(h.prints,1);assert.match(h.get('premium-print').textContent,/합성 상품/);
  });
  await check('demo hides saved real records, blocks programmatic writes and exports only sample analysis',async()=>{
    const h=harness();h.get('premium-budget-limit').value='12345';await h.get('premium-save-budget').dispatch('click');h.get('premium-scenario-name').value='PRIVATE SCENARIO';await h.get('premium-save-scenario').dispatch('click');h.get('premium-rule-preview').textContent='PRIVATE COST PREVIEW';h.get('premium-report-kind').value='analysis';await h.get('premium-print-report').dispatch('click');const before=h.storage.getItem('marginkit_premium_v1');h.setDemo(true);
    assert.equal(h.get('premium-budget-limit').value,'');assert.equal(h.get('premium-scenario-name').value,'');assert.equal(h.get('premium-rule-preview').textContent,'');assert.equal(h.get('premium-print'),null);
    assert.doesNotMatch(h.get('premium-scenario-list').textContent,/PRIVATE/);assert.equal(h.get('premium-save-scenario').disabled,true);h.get('premium-scenario-name').value='intrusion';await h.get('premium-save-scenario').dispatch('click');assert.equal(h.storage.getItem('marginkit_premium_v1'),before);
    h.get('premium-report-kind').value='scenarios';await h.get('premium-export-xlsx').dispatch('click');assert.equal(h.downloads.length,0);h.get('premium-report-kind').value='analysis';await h.get('premium-export-xlsx').dispatch('click');assert.match(h.downloads[0].name,/demo/);h.setDemo(false);assert.match(h.get('premium-scenario-list').textContent,/PRIVATE/);
  });
  await check('scientific-notation scenario inputs export normalized amounts and calculate planned ad spend',async()=>{
    const h=harness();h.get('suite-ad').value='1e-2';h.get('suite-units').value='1e2';h.get('suite-cost').value='1e-3';await h.get('suite-cost').dispatch('input');h.get('premium-scenario-name').value='지수 입력';await h.get('premium-save-scenario').dispatch('click');
    assert.match(h.get('premium-budget-results').textContent,/월 예상 광고비1원/);h.get('premium-report-kind').value='scenarios';await h.get('premium-export-xlsx').dispatch('click');assert.equal(h.downloads.length,1);
    const XLSX=require('../vendor/xlsx-0.20.3.full.min.js'),book=XLSX.read(await h.blobs.get(h.downloads[0].url).arrayBuffer(),{type:'array'});assert.equal(book.Sheets['시나리오 입력값'].C2.v,0.001);assert.equal(book.Sheets['시나리오 입력값'].E2.v,0.01);
  });
  await check('a delayed JSON file cannot apply after another same-tab write',async()=>{
    const h=harness();let finish;const incoming={format:'marginkit-premium',version:1,data:{version:1,rules:[],scenarios:[],months:[{id:'late',month:'2026-01',name:'old backup',lines:[{channel:'A',sales:'1',feePct:'0',vatPct:'0'}]}],budget:{limit:'0',warnPct:'80'}}};
    h.get('premium-restore-file').files=[{size:400,text:()=>new Promise(resolve=>finish=resolve)}];const pending=h.get('premium-restore-file').dispatch('change');h.get('premium-budget-limit').value='500';await h.get('premium-save-budget').dispatch('click');finish(JSON.stringify(incoming));await pending;
    const saved=JSON.parse(h.storage.getItem('marginkit_premium_v1'));assert.equal(saved.months.length,0);assert.equal(saved.budget.limit,'500');assert.match(h.get('premium-status').textContent,/모드가 변경/);
  });
  await check('failed Premium storage write reports failure and never displays a phantom saved scenario',async()=>{
    const h=harness();h.storage.setItem=()=>{throw Error('quota');};h.get('premium-scenario-name').value='never saved';await h.get('premium-save-scenario').dispatch('click');assert.equal(h.storage.getItem('marginkit_premium_v1'),null);assert.doesNotMatch(h.get('premium-scenario-list').textContent,/never saved/);assert.match(h.get('premium-status').textContent,/저장하지 못했습니다/);
  });
  await check('other-tab revision cannot be overwritten by current UI save',async()=>{
    const h=harness();h.get('premium-scenario-name').value='first';await h.get('premium-save-scenario').dispatch('click');const newer=JSON.parse(h.storage.getItem('marginkit_premium_v1'));newer.budget.limit='777';const bytes=JSON.stringify(newer);h.storage.setItem('marginkit_premium_v1',bytes);h.get('premium-scenario-name').value='stale';await h.get('premium-save-scenario').dispatch('click');assert.equal(h.storage.getItem('marginkit_premium_v1'),bytes);assert.match(h.get('premium-status').textContent,/다른 탭/);
  });
  await check('corrupt Premium storage is preserved and does not silently clear existing records',()=>{
    const h=harness({marginkit_premium_v1:'{original broken'});assert.equal(h.storage.getItem('marginkit_premium_v1'),'{original broken');assert.equal(h.get('premium-save-scenario').disabled,true);assert.match(h.get('premium-status').textContent,/덮어쓰기를 중지/);
  });
  await check('saved markup-like scenario names remain literal text with no injected element',async()=>{
    const h=harness(),name='<img src=x onerror=alert(1)>';h.get('premium-scenario-name').value=name;await h.get('premium-save-scenario').dispatch('click');
    assert.match(h.get('premium-scenario-list').textContent,/<img src=x onerror=alert\(1\)>/);assert.equal(h.get('premium-scenario-list').querySelectorAll('img').length,0);
  });
  await check('app integration preserves exact SKU and name precedence, rejects ambiguous rules, ignores rules in demo',()=>{
    const source=fs.readFileSync(path.join(root,'app.js'),'utf8'),slice=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
    const ctx=vm.createContext({console});for(const f of ['exact-decimal.js','premium-core.js'])vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),ctx);
    vm.runInContext("const state={costs:new Map([['sku:A',{unitCost:1}],['name:shared',{unitCost:2}],['sku:R1',{unitCost:3}],['sku:R2',{unitCost:4}]]),isDemo:false};let premiumRules=[{id:'r1',field:'sku',match:'prefix',value:'A',costKey:'sku:R1',enabled:true}];",ctx);
    vm.runInContext(slice('function norm(s)','function findHeader(')+slice('function resolveProductCost(', 'function aggregate()'),ctx);
    assert.equal(vm.runInContext("getCost({sku:'A',product:'shared'}).unitCost",ctx),1);
    assert.equal(vm.runInContext("getCost({sku:'AB',product:'shared'}).unitCost",ctx),2);
    assert.equal(vm.runInContext("getCost({sku:'AB',product:'unregistered'}).unitCost",ctx),3);
    vm.runInContext("premiumRules.push({id:'r2',field:'sku',match:'contains',value:'B',costKey:'sku:R2',enabled:true})",ctx);assert.equal(vm.runInContext("getCost({sku:'AB',product:'unregistered'})",ctx),null);
    vm.runInContext("premiumRules.pop();state.isDemo=true",ctx);assert.equal(vm.runInContext("getCost({sku:'AB',product:'unregistered'})",ctx),null);
    vm.runInContext(slice('function aggregate()', '// --- Dashboard Rendering ---'),ctx);
    vm.runInContext("state.isDemo=false;state.costs.set('sku:R1',{unitCost:0.2,unitCostExact:'0.2'});premiumRules=MarginKitPremiumCore.compileRules(premiumRules);state.transactions=[{sku:'AB',product:'unregistered',exact:{qty:'1',revenue:'0.3',refunds:'0',commission:'0.1',shipping:'0',ads:'0',other:'0'}}];state.sortColumn='revenue';state.sortAsc=false",ctx);
    assert.equal(vm.runInContext('totalUp().profit',ctx),'0');
  });
  console.log(`${passed} Premium integration checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
