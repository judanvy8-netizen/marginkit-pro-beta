// Local-only browser QA with synthetic storage; no installed user profile is used.
const {chromium}=require('playwright');
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
 const file=path.join(root,decodeURIComponent(req.url.split('?')[0])==='/'?'index.html':decodeURIComponent(req.url.split('?')[0]));
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(data);});
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 let browser;
 try{
 browser=await chromium.launch({headless:true,chromiumSandbox:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const context=await browser.newContext({acceptDownloads:true});
 await context.route('**/*',r=>r.request().url().startsWith(base)?r.continue():r.abort());
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);const saved=JSON.stringify([['sku:A',{product:'판매 상품',sku:'A',unitCost:0}],['sku:B',{product:'미판매 상품',sku:'B',unitCost:250}]]);
 await page.evaluate(value=>localStorage.setItem('marginkit_costs_v2',value),saved);await page.reload();await page.goto(base+'/#products');
 const download=async(selector='#btnExportRegisteredCosts')=>{const promise=page.waitForEvent('download');await page.click(selector);const d=await promise;return {name:d.suggestedFilename(),csv:fs.readFileSync(await d.path(),'utf8')};};
 const first=await download();assert.match(first.csv,/미판매 상품,B,250/);assert.match(first.csv,/판매 상품,A,0/);console.log('PASS full CSV download without sales includes all 2 registered products and zero cost');
 assert.equal(await page.evaluate(()=>localStorage.getItem('marginkit_costs_v2')),saved);console.log('PASS export does not mutate stored data');
 const json=JSON.parse((await download('#btnBackupCostRegister')).csv);assert.deepEqual(json.costs,JSON.parse(saved));console.log('PASS JSON browser download preserves all original cost entries');
 assert.equal((await download()).csv,first.csv);console.log('PASS repeated download is stable');
 await page.screenshot({path:path.join(root,'review/cost-export-desktop.png'),fullPage:true});
 await page.goto(base+'/#dashboard');await page.click('#btnDemo');await page.goto(base+'/#products');const demo=await download();assert.match(demo.name,/demo/);assert.equal(await page.evaluate(()=>localStorage.getItem('marginkit_costs_v2')),saved);console.log('PASS demo export labeled separately; real storage preserved');
 await page.reload();await page.goto(base+'/#products');assert.equal((await download()).csv,first.csv);console.log('PASS reload restores real cost export');
 const restoreSnapshot={format:'marginkit-cost-register',version:1,mode:'real',exportedAt:new Date().toISOString(),costs:[['sku:A',{product:'Do not overwrite',sku:'A',unitCost:999}],['sku:=NEW',{product:'한글 \"인용\"\n새 상품',sku:'=NEW',unitCost:12.5}]]};
 const upload=async data=>page.locator('#costRestoreFile').setInputFiles({name:'restore.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
 await upload(restoreSnapshot);await page.locator('#costRestoreBackdrop.show').waitFor();
 assert.match(await page.locator('#costRestoreSummary').textContent(),/건너뜀 1개/);
 assert.equal(await page.evaluate(()=>localStorage.getItem('marginkit_costs_v2')),saved);
 await page.click('#btnCancelCostRestore');assert.equal(await page.evaluate(()=>localStorage.getItem('marginkit_costs_v2')),saved);console.log('PASS restore preview/cancel preserve storage');
 await upload(restoreSnapshot);await page.locator('#costRestoreBackdrop.show').waitFor();await page.click('#btnConfirmCostRestore');
 const restored=JSON.parse(await page.evaluate(()=>localStorage.getItem('marginkit_costs_v2')));
 assert.equal(restored.length,3);assert.equal(new Map(restored).get('sku:A').unitCost,0);assert.equal(new Map(restored).get('sku:=NEW').unitCost,12.5);console.log('PASS explicit merge restore adds new key and preserves conflicting existing cost');
 await page.reload();await page.goto(base+'/#products');assert.equal(JSON.parse((await download('#btnBackupCostRegister')).csv).costs.length,3);console.log('PASS restored data survives reload and re-exports');
 await upload({...restoreSnapshot,version:999});await page.waitForTimeout(100);assert.equal(await page.locator('#costRestoreBackdrop').evaluate(el=>el.classList.contains('show')),false);assert.equal(JSON.parse(await page.evaluate(()=>localStorage.getItem('marginkit_costs_v2'))).length,3);console.log('PASS unsupported backup version rejected without changing storage');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(root,'review/cost-export-mobile.png'),fullPage:true});
 assert.ok(await page.locator('#btnExportRegisteredCosts').isVisible());assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);console.log('PASS mobile button visible and no horizontal overflow');
 await page.evaluate(()=>localStorage.removeItem('marginkit_costs_v2'));await page.reload();await page.goto(base+'/#products');let downloads=0;page.on('download',()=>downloads++);await page.click('#btnExportRegisteredCosts');await page.waitForTimeout(300);assert.equal(downloads,0);console.log('PASS empty register creates no misleading sample file');
 await page.setViewportSize({width:1280,height:900});await page.goto(base+'/#import');
 const precise='0.1234567890123456789012345';
 const salesCsv='상품명,상품코드,상품 매출,판매 수량,판매 수수료\r\nZero,Z,0.3,1,0.1\r\nLarge,L,1000000000000,1000000000000,0\r\nFraction,F,1,0.125,0.025\r\nPrecise,P,'+precise+',1,0\r\n';
 const costsCsv='상품명,상품코드,단위당 매입 원가\r\nZero,Z,0.2\r\nLarge,L,999999999999\r\nFraction,F,0.2\r\nPrecise,P,'+precise+'\r\n';
 await page.locator('#salesFile').setInputFiles({name:'exact-sales.csv',mimeType:'text/csv',buffer:Buffer.from(salesCsv)});
 await page.waitForFunction(()=>document.querySelector('#salesFileStatus').textContent.includes('✓'));
 await page.locator('#costFile').setInputFiles({name:'exact-costs.csv',mimeType:'text/csv',buffer:Buffer.from(costsCsv)});
 await page.waitForFunction(()=>document.querySelector('#costFileStatus').textContent.includes('✓'));
 await page.click('#btnProcessImport');await page.locator('#page-results.active').waitFor();
 const zeroRow=page.locator('#resultTable tr').filter({hasText:'Zero'});assert.match(await zeroRow.textContent(),/정상 마진/);assert.doesNotMatch(await zeroRow.textContent(),/손실/);
 assert.match(await page.locator('#resultTable').textContent(),/999,999,999,999,000,000,000,000/);
 assert.match(await page.locator('#resultTable').textContent(),/0\.125/);assert.match(await page.locator('#resultTable').textContent(),/0\.95/);
 const report=await download('#btnExport');assert.ok(report.csv.includes('999999999999000000000000'));assert.ok(report.csv.includes(precise));console.log('PASS actual CSV worker import preserves zero profit, large exact cost, fractional quantity and precise decimal report');
 await page.goto(base+'/#products');const decimalBackup=JSON.parse((await download('#btnBackupCostRegister')).csv);assert.equal(decimalBackup.version,2);assert.equal(new Map(decimalBackup.costs).get('sku:P').unitCostExact,precise);
 await page.reload();assert.equal(new Map(JSON.parse((await download('#btnBackupCostRegister')).csv).costs).get('sku:P').unitCostExact,precise);console.log('PASS precise JSONv2 cost backup persists through reload');
 assert.deepEqual(errors,[]);console.log('PASS no JavaScript page errors');
 }finally{if(browser)await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
