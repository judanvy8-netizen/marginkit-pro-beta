/**
 * F01: Demo mode must not mutate persisted real cost storage.
 * Runs against the real index.html via Chromium.
 *
 * Expectation: FAIL on unfixed code, PASS after isolation fix.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STORAGE_KEY = 'marginkit_costs_v2';
const PORT = 43127;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function parseCosts(raw) {
  if (!raw) return [];
  const arr = JSON.parse(raw);
  return arr
    .map(([key, val]) => [key, val])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function addRealCost(page, { name, sku, cost }) {
  await page.click('#btnAddProduct');
  await page.waitForSelector('#addProductModalBackdrop.show');
  await page.fill('#newProdName', name);
  await page.fill('#newProdSku', sku);
  await page.fill('#newProdCost', String(cost));
  await page.click('#btnSaveAddProd');
  await page.waitForSelector('#addProductModalBackdrop.show', { state: 'detached' }).catch(() => {});
  await page.waitForTimeout(200);
}

async function readStorage(page) {
  return page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY);
}

async function runDemoMutationCycle(page) {
  // Dashboard hosts the visible demo CTA
  await page.click('button.nav-item[data-page="dashboard"]');
  await page.waitForSelector('#page-dashboard:not(.hidden), #page-dashboard', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(150);

  const demoBtn = page.locator('#btnDemo');
  await demoBtn.waitFor({ state: 'visible', timeout: 5000 });
  await demoBtn.click();
  await page.waitForTimeout(400);

  // Mutate demo costs on products page
  await page.click('button.nav-item[data-page="products"]');
  await page.waitForTimeout(250);
  const input = page.locator('[data-cost-key]').first();
  assert(await input.count(), 'expected demo cost inputs');
  await input.fill('99999');
  await input.dispatchEvent('change');
  await page.waitForTimeout(200);

  const del = page.locator('[data-delete-cost]').first();
  assert(await del.count(), 'expected demo cost delete button');
  await del.click();
  await page.waitForTimeout(200);

  // Exit demo via reset ("종료")
  page.once('dialog', async (d) => {
    await d.accept();
  });
  await page.click('#btnReset');
  await page.waitForTimeout(400);
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  const base = `http://127.0.0.1:${PORT}/`;

  const failures = [];
  const pass = (name) => console.log(`PASS ${name}`);
  const fail = (name, err) => {
    console.error(`FAIL ${name}: ${err.message || err}`);
    failures.push(name);
  };

  try {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
    await page.reload({ waitUntil: 'domcontentloaded' });

    // --- Real mode save must work ---
    try {
      await page.click('button.nav-item[data-page="products"]');
      await addRealCost(page, { name: '실원가상품', sku: 'REAL-001', cost: 12345 });
      const raw = await readStorage(page);
      assert(raw, 'real cost missing from localStorage after save');
      const costs = parseCosts(raw);
      assert(
        costs.some(([k, v]) => k === 'sku:REAL-001' && v.unitCost === 12345),
        `expected REAL-001=12345, got ${raw}`
      );
      pass('real-mode cost save');
    } catch (e) {
      fail('real-mode cost save', e);
    }

    const baseline = await readStorage(page);
    assert(baseline, 'baseline storage empty');

    // --- Demo cycle must not change persisted real costs ---
    try {
      await runDemoMutationCycle(page);
      const after = await readStorage(page);
      assert(after === baseline, `storage changed after demo cycle\nbefore=${baseline}\nafter=${after}`);
      pass('demo enter/edit/delete/exit keeps real storage');
    } catch (e) {
      fail('demo enter/edit/delete/exit keeps real storage', e);
    }

    // --- Refresh ---
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      const afterReload = await readStorage(page);
      assert(afterReload === baseline, `storage changed after refresh\nbefore=${baseline}\nafter=${afterReload}`);
      const costs = parseCosts(afterReload);
      assert(
        costs.some(([k, v]) => k === 'sku:REAL-001' && v.unitCost === 12345),
        'real cost lost after refresh'
      );
      pass('refresh keeps real storage');
    } catch (e) {
      fail('refresh keeps real storage', e);
    }

    // --- Repeat demo cycle ---
    try {
      await runDemoMutationCycle(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const afterRepeat = await readStorage(page);
      assert(afterRepeat === baseline, `storage changed after repeat\nbefore=${baseline}\nafter=${afterRepeat}`);
      pass('repeat demo cycle keeps real storage');
    } catch (e) {
      fail('repeat demo cycle keeps real storage', e);
    }

    // --- Real mode save still works after demo ---
    try {
      await page.click('button.nav-item[data-page="products"]');
      await addRealCost(page, { name: '실원가상품2', sku: 'REAL-002', cost: 7777 });
      const raw = await readStorage(page);
      const costs = parseCosts(raw);
      assert(
        costs.some(([k, v]) => k === 'sku:REAL-001' && v.unitCost === 12345),
        'REAL-001 lost after post-demo real save'
      );
      assert(
        costs.some(([k, v]) => k === 'sku:REAL-002' && v.unitCost === 7777),
        'REAL-002 not saved in real mode'
      );
      pass('real-mode save after demo');
    } catch (e) {
      fail('real-mode save after demo', e);
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length) {
    console.error(`\n${failures.length} failing check(s)`);
    process.exit(1);
  }
  console.log('\nAll F01 isolation checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
