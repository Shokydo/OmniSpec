const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
let app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
function replaceOnce(from, to) {
  assert(app.includes(from), `instrumentation anchor not found: ${from.slice(0, 80)}`);
  app = app.replace(from, to);
}
// Only the served copy is instrumented; production code is unchanged.
replaceOnce('const DV_RETRY_MS = [5000, 10000, 20000, 40000, 60000, 120000]', 'const DV_RETRY_MS = window.__mockDiscover?.slowRetry ? [5000, 10000] : [1000, 1200, 1400, 1600, 1800, 2000]');
replaceOnce('    searchCurseforge: async (q) => {', '    searchCurseforge: async (q) => {\n      if (window.__mockDiscover) return window.__mockDiscover.fetch("curseforge", q);');
replaceOnce('    search: async (q) => {', '    search: async (q) => {\n      if (window.__mockDiscover) return window.__mockDiscover.fetch("modrinth", q);');
replaceOnce('  function syncPresence(forceMode) {\n    if (!IS_APP) return;', '  function syncPresence(forceMode) {\n    if (!IS_APP && !window.__rpcTest) return;');
replaceOnce('    setPresence: async () => null,', '    setPresence: async (...args) => { if (window.__rpcTest) await window.__rpcTest.send(args); return null; },');
replaceOnce('    saveSettings: async (s) => { DEMO.settings = s; return null; },', '    saveSettings: async (s) => { if (window.__rpcTest?.failSaves > 0) { window.__rpcTest.failSaves--; throw new Error("диск недоступен"); } DEMO.settings = s; return null; },');
replaceOnce('    resolvePresenceIcon: async () => null,', '    resolvePresenceIcon: async (id) => window.__rpcTest ? window.__rpcTest.resolve(id) : null,');
replaceOnce('icon: null, created: now - 86400 * 9', 'icon: window.__rpcTest ? "icon.png" : null, created: now - 86400 * 9');
replaceOnce('icon: null, created: now - 86400 * 20', 'icon: window.__rpcTest ? "icon.png" : null, created: now - 86400 * 20');

const server = http.createServer((req,res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const data = pathname === '/app.js' ? Buffer.from(app) : fs.readFileSync(file);
    const ext = path.extname(file);
    res.writeHead(200, {'Content-Type': ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[ext] || 'application/octet-stream'});
    res.end(data);
  } catch { res.writeHead(404).end(); }
});

async function newPage(browser, scenario, rpc = false) {
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(({ scenario, rpc }) => {
    const hit = (id,title) => ({project_id:id,slug:id,title,description:'тест',categories:[],downloads:1,icon_url:null});
    window.__mockDiscover = {
      calls: [], slowRetry: ['page-manual','online'].includes(scenario),
      async fetch(source,q) {
        this.calls.push({source, query:q.query, offset:q.offset});
        const calls = this.calls.filter(c => c.source === source && c.offset === q.offset).length;
        if (scenario === 'retry' && source === 'modrinth' && q.offset === 0 && calls <= 2) throw new Error('error sending request: соединение разорвано');
        if (scenario === 'permanent' && source === 'modrinth') throw new Error('Modrinth /search → HTTP 403 Forbidden');
        if ((scenario === 'switch' || scenario === 'leave') && source === 'modrinth') throw new Error('error sending request');
        if (scenario === 'online' && source === 'modrinth' && calls === 1) throw new Error('error sending request');
        if (scenario === 'race' && !q.query) {
          await new Promise(r => setTimeout(r, 1300));
          return {hits:[hit('old','СТАРЫЙ ОТВЕТ')],total_hits:1};
        }
        if (scenario === 'race' && q.query) return {hits:[hit('new','НОВЫЙ ОТВЕТ')],total_hits:1};
        if (scenario === 'page' || scenario === 'page-manual') {
          if (q.offset === 0) return {hits:Array.from({length:24}, (_,i)=>hit(`first-${i}`,`Первая ${i}`)),total_hits:26};
          if (q.offset === 24 && calls === 1) throw new Error('error sending request');
          return {hits:[hit('more-24','Доп 24'),hit('more-25','Доп 25')],total_hits:26};
        }
        return {hits:[hit(source+'-ok', source === 'curseforge' ? 'CurseForge OK' : 'Modrinth OK')],total_hits:1};
      }
    };
    if (rpc) {
      window.__rpcTest = {
        events: [], starts: [], resolves: [], finished: [], failSaves: 0,
        async send(args) {
          this.starts.push(args);
          if (scenario === 'rpc-write-race' && args[1] === 'Fabulously Optimized') {
            await new Promise(r => setTimeout(r, 600));
          }
          this.events.push(args);
        },
        async resolve(id) {
          this.resolves.push(id);
          await new Promise(r => setTimeout(r, id === 'fabulously-optimized' ? 850 : 90));
          this.finished.push(id);
          return `https://cdn.modrinth.com/data/${id}/icon.png`;
        }
      };
    }
  }, { scenario, rpc });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  return {page,errors};
}

(async () => {
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const browser = await chromium.launch();
  try {
    {
      const {page,errors} = await newPage(browser,'retry');
      await page.waitForSelector('#dv-retry');
      assert((await page.locator('#dv-results').innerText()).includes('автоматически'));
      const geom = await page.locator('.dv-error').evaluate(el => ({w:el.getBoundingClientRect().width, root:el.parentElement.getBoundingClientRect().width}));
      assert(geom.w > geom.root * 0.85, `error clipped: ${JSON.stringify(geom)}`);
      await page.locator('#dv-query').fill('текст, который ещё печатаю');
      await page.waitForFunction(() => document.querySelector('#dv-results')?.textContent.includes('Modrinth OK'), null, {timeout:7000});
      assert.equal(await page.locator('#dv-query').inputValue(),'текст, который ещё печатаю');
      const calls = await page.evaluate(() => window.__mockDiscover.calls);
      assert.deepEqual(calls.map(c=>c.query),['','','']);
      assert.deepEqual(errors,[]);
      console.log('AUTO_RETRY', JSON.stringify({calls, inputPreserved:true, fullWidth:true}));
      await page.close();
    }
    {
      const {page,errors} = await newPage(browser,'race');
      await page.locator('#dv-query').fill('new');
      await page.locator('#dv-query').press('Enter');
      await page.waitForFunction(() => document.querySelector('#dv-results')?.textContent.includes('НОВЫЙ ОТВЕТ'));
      await page.waitForTimeout(1500);
      const text = await page.locator('#dv-results').innerText();
      assert(text.includes('НОВЫЙ ОТВЕТ') && !text.includes('СТАРЫЙ ОТВЕТ'));
      assert.deepEqual(errors,[]); console.log('STALE_RESPONSE', 'ignored'); await page.close();
    }
    {
      const {page,errors} = await newPage(browser,'switch');
      await page.waitForSelector('#dv-retry');
      await page.selectOption('#dv-source','curseforge');
      await page.waitForFunction(() => document.querySelector('#dv-results')?.textContent.includes('CurseForge OK'));
      await page.waitForTimeout(1500);
      const calls = await page.evaluate(() => window.__mockDiscover.calls);
      assert.equal(calls.filter(c=>c.source==='modrinth').length,1);
      assert.equal(calls.filter(c=>c.source==='curseforge').length,1);
      assert.deepEqual(errors,[]); console.log('SOURCE_SWITCH', JSON.stringify(calls)); await page.close();
    }
    {
      const {page,errors} = await newPage(browser,'online');
      await page.waitForSelector('#dv-retry');
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.waitForFunction(() => document.querySelector('#dv-results')?.textContent.includes('Modrinth OK'), null, {timeout:3000});
      assert.equal(await page.evaluate(() => window.__mockDiscover.calls.length),2);
      assert.deepEqual(errors,[]); console.log('ONLINE', 'retried immediately'); await page.close();
    }
    {
      const {page,errors} = await newPage(browser,'permanent');
      await page.waitForSelector('#dv-retry');
      await page.waitForTimeout(1500);
      assert.equal(await page.evaluate(() => window.__mockDiscover.calls.length),1);
      assert((await page.locator('#dv-results').innerText()).includes('Проверь'));
      await page.locator('#dv-retry').click();
      await page.waitForFunction(() => window.__mockDiscover.calls.length === 2);
      assert.deepEqual(errors,[]); console.log('PERMANENT_ERROR', 'no automatic retry; manual works'); await page.close();
    }
    {
      const {page,errors} = await newPage(browser,'leave');
      await page.waitForSelector('#dv-retry');
      await page.locator('[data-home-id]').first().click();
      await page.waitForTimeout(1500);
      assert.equal(await page.evaluate(() => window.__mockDiscover.calls.length),1);
      await page.click('#btn-home');
      await page.waitForFunction(() => window.__mockDiscover.calls.length >= 2, null, {timeout:3500});
      assert.deepEqual(errors,[]); console.log('NAVIGATION', 'paused away, resumed on return'); await page.close();
    }
    {
      const {page,errors} = await newPage(browser,'page');
      await page.waitForSelector('#dv-results .card');
      await page.locator('#dv-sentinel').scrollIntoViewIfNeeded();
      await page.waitForSelector('#dv-more-retry', {timeout:5000});
      assert.equal(await page.locator('#dv-results .card').count(),24);
      await page.waitForFunction(() => document.querySelectorAll('#dv-results .card').length === 26, null, {timeout:5000});
      const calls = await page.evaluate(() => window.__mockDiscover.calls.map(c=>c.offset));
      assert.deepEqual(calls,[0,24,24]);
      assert.deepEqual(errors,[]); console.log('PAGINATION', JSON.stringify({calls,preserved:24,final:26})); await page.close();
    }
    {
      const {page,errors} = await newPage(browser,'page-manual');
      await page.waitForSelector('#dv-results .card');
      await page.locator('#dv-sentinel').scrollIntoViewIfNeeded();
      await page.waitForSelector('#dv-more-retry');
      await page.locator('[data-dv-view="list"]').click();
      await page.locator('#dv-more-retry').click();
      await page.waitForFunction(() => document.querySelectorAll('#dv-results .card').length === 26, null, {timeout:3000});
      assert.deepEqual(await page.evaluate(() => window.__mockDiscover.calls.map(c=>c.offset)),[0,24,24]);
      assert.deepEqual(errors,[]); console.log('PAGINATION_MANUAL', 'works after view change'); await page.close();
    }
    {
      const {page,errors} = await newPage(browser,'normal',true);
      await page.locator('[data-home-id="fabulously-optimized"]').click();
      await page.waitForFunction(() => window.__rpcTest.resolves.includes('fabulously-optimized'));
      await page.locator('.instance[data-id="fabulously-optimized"]').click({button:'right'});
      await page.locator('#ctx-menu [data-act="icon-reset"]').click();
      await page.waitForFunction(() => String(window.__rpcTest.events.at(-1)?.[4]).endsWith('/letter-0046.png'));
      await page.waitForFunction(() => window.__rpcTest.finished.includes('fabulously-optimized'));
      await page.waitForTimeout(100);
      assert((await page.evaluate(() => String(window.__rpcTest.events.at(-1)?.[4]))).endsWith('/letter-0046.png'));
      assert.deepEqual(errors,[]); console.log('RPC_RESET_RACE', 'old response ignored'); await page.close();
    }
    {
      const {page,errors} = await newPage(browser,'rpc-write-race',true);
      await page.locator('[data-home-id="fabulously-optimized"]').click();
      await page.waitForFunction(() => window.__rpcTest.starts.some(e => e[1] === 'Fabulously Optimized'));
      await page.locator('.instance[data-id="atm10"]').click();
      await page.waitForFunction(() => String(window.__rpcTest.events.at(-1)?.[4]).includes('/atm10/'));
      await page.waitForTimeout(750);
      const events = await page.evaluate(() => window.__rpcTest.events);
      assert.equal(events.at(-1)[1], 'All the Mods 10', JSON.stringify(events));
      assert(events.at(-1)[4].includes('/atm10/'));
      assert.deepEqual(errors,[]); console.log('RPC_WRITE_ORDER', 'newest selection wins'); await page.close();
    }
    {
      const {page,errors} = await newPage(browser,'normal',true);
      await page.locator('[data-home-id="fabulously-optimized"]').click();
      await page.locator('.instance[data-id="atm10"]').click();
      await page.waitForFunction(() => window.__rpcTest.finished.includes('fabulously-optimized') && String(window.__rpcTest.events.at(-1)?.[4]).includes('/atm10/'));
      await page.waitForTimeout(100);
      const events = await page.evaluate(() => window.__rpcTest.events);
      const last = events[events.length-1];
      assert.equal(last[1],'All the Mods 10');
      assert(last[4].includes('/atm10/'), JSON.stringify(last));
      const atmFirst = events.findIndex(e=>e[1]==='All the Mods 10');
      assert(!events.slice(atmFirst).some(e=>e[1]==='Fabulously Optimized'), 'late icon overwrote selection');
      await page.click('#btn-quick-settings');
      await page.click('.prefs-tab[data-pref="discord"]');
      for (const id of ['rpc','icon','upload']) {
        assert.equal(await page.locator(`#set-discord-${id}`).getAttribute('role'),'switch');
        assert(await page.locator(`#set-discord-${id}`).evaluate(el => el.classList.contains('switch')));
      }
      assert.equal(await page.locator('#set-discord-icon').getAttribute('aria-checked'),'true');
      assert.equal(await page.locator('#set-discord-upload').getAttribute('aria-checked'),'false');
      const copy = await page.locator('#prefs-body').innerText();
      assert(copy.includes('tmpfile.link') && copy.includes('7 дней') && copy.includes('досрочно'));
      await page.locator('#set-discord-icon').focus();
      await page.locator('#set-discord-icon').press('Space');
      await page.waitForFunction(() => window.__rpcTest.events.at(-1)?.[4] === null);
      assert.equal(await page.locator('#set-discord-icon').getAttribute('aria-checked'),'false');
      await page.locator('#set-discord-icon + span').click();
      await page.waitForFunction(() => String(window.__rpcTest.events.at(-1)?.[4]).includes('/atm10/'));
      // A failed attempt to grant permission must be visible and rolled back.
      await page.evaluate(() => { window.__rpcTest.failSaves = 1; });
      await page.locator('#set-discord-upload').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(e=>e.textContent.includes('Не удалось сохранить настройки Discord')));
      assert.equal(await page.locator('#set-discord-upload').getAttribute('aria-checked'),'false');
      await page.evaluate(() => document.querySelectorAll('.toast').forEach(el => el.remove()));
      await page.locator('#set-discord-upload').click();
      await page.click('.prefs-tab[data-pref="look"]');
      await page.click('.prefs-tab[data-pref="discord"]');
      assert.equal(await page.locator('#set-discord-upload').getAttribute('aria-checked'),'true');
      // On a failed revocation, leave it off in the UI and warn about persistence.
      await page.evaluate(() => { window.__rpcTest.failSaves = 1; });
      await page.locator('#set-discord-upload').click();
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(e=>e.textContent.includes('Не удалось сохранить настройки Discord')));
      assert.equal(await page.locator('#set-discord-upload').getAttribute('aria-checked'),'false');
      await page.click('[data-close-prefs]');
      await page.locator('.instance[data-id="atm10"]').click({button:'right'});
      await page.locator('#ctx-menu [data-act="icon-reset"]').click();
      await page.waitForFunction(() => String(window.__rpcTest.events.at(-1)?.[4]).endsWith('/letter-0041.png'));
      await page.locator('.instance[data-id="atm10"]').click({button:'right'});
      await page.locator('#ctx-menu [data-act="settings"]').click();
      await page.locator('#inst-icons [data-icon="i-star"]').click();
      await page.locator('#inst-save').click();
      await page.waitForFunction(() => String(window.__rpcTest.events.at(-1)?.[4]).endsWith('/i-star.png'));
      await page.locator('#inst-icon-file').click();
      await page.waitForFunction(() => String(window.__rpcTest.events.at(-1)?.[4]).includes('/atm10/'));
      await page.locator('#inst-icon-reset').click();
      await page.waitForFunction(() => String(window.__rpcTest.events.at(-1)?.[4]).endsWith('/letter-0041.png'));
      assert.deepEqual(errors,[]);
      console.log('RPC_UI', JSON.stringify({lastImage:last[4], staleGuard:true, switches:true, keyboard:true, uploadDefault:false, privacyNotice:true, saveFailures:true, iconResetAndChanges:true}));
      await page.close();
    }
  } finally {
    await browser.close(); server.close();
  }
})().catch(err => { console.error(err); server.close(); process.exitCode=1; });
