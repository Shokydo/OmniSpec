// Minimize-to-tray setting, quiet-mode event and first-run wizard regression.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try {
    const type = ({ '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function openPage(browser, fresh) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.addInitScript((isFresh) => {
    const state = {
      onboarded: !isFresh,
      onboarding_pending: Boolean(isFresh),
      minimize_to_tray: false,
      update_enabled: false,
      discord_rpc: false,
      discord_instance_icon: false,
      theme: 'dark', click_fx: 'off', ambient: 'off', trail: false,
      ui_scale: 100, categories: [], last_instance: null
    };
    window.__trayTest = {
      settings: state,
      calls: [],
      listeners: {},
      async invoke(command, args = {}) {
        this.calls.push({ command, args });
        switch (command) {
          case 'get_settings': return { ...this.settings };
          case 'save_settings': this.settings = { ...args.settings }; return null;
          case 'accounts_info': return { accounts: [], active: null };
          case 'app_info': return { home: '/test', version: 'test', platform: 'linux', demo: false };
          case 'system_memory': return { total_mb: 8192 };
          case 'version_info': return { enabled: false, version: 'test' };
          case 'list_instances': return [];
          case 'running_sessions': return [];
          case 'running_instances': return [];
          case 'list_java': return [];
          case 'check_update': return null;
          case 'set_presence': return null;
          default: return null;
        }
      }
    };
    window.__TAURI__ = {
      core: { invoke: (command, args) => window.__trayTest.invoke(command, args) },
      event: { listen: async (name, callback) => { window.__trayTest.listeners[name] = callback; return () => {}; } }
    };
  }, fresh);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.omnispecDebug?.state?.settings);
  return { page, errors };
}

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    {
      const { page, errors } = await openPage(browser, false);
      await page.locator('#btn-quick-settings').click();
      await page.locator('[data-pref="look"]').click();
      await page.waitForSelector('#set-minimize-to-tray');
      assert.equal(await page.locator('#set-minimize-to-tray').getAttribute('aria-checked'), 'false');
      await page.locator('#set-minimize-to-tray').click();
      await page.waitForFunction(() => window.__trayTest.settings.minimize_to_tray === true);
      assert.equal(await page.locator('#set-minimize-to-tray').getAttribute('aria-checked'), 'true');

      await page.evaluate(() => window.__trayTest.listeners['window-visibility']({ payload: { hidden: true } }));
      await page.waitForFunction(() => window.omnispecDebug.state.quiet === true);
      assert.equal(await page.locator('body').getAttribute('data-window-hidden'), 'true');
      await page.evaluate(() => window.__trayTest.listeners['window-visibility']({ payload: { hidden: false } }));
      await page.waitForFunction(() => window.omnispecDebug.state.quiet === false);
      assert.equal(await page.locator('body').getAttribute('data-window-hidden'), 'false');
      assert.deepEqual(errors, []);
      await page.close();
      console.log('TRAY_SETTING: persistent switch and quiet visibility event — OK');
    }

    {
      const { page, errors } = await openPage(browser, true);
      await page.waitForSelector('#modal-onboard:not([hidden])');
      assert.equal(await page.locator('#onboard-count').innerText(), '1 / 7');
      await page.locator('#onboard-next').click();
      await page.locator('#onboard-next').click();
      await page.locator('#onboard-next').click();
      await page.waitForSelector('#onboard-tray');
      assert.equal(await page.locator('#onboard-tray').getAttribute('aria-checked'), 'false');
      await page.locator('#onboard-tray').click();
      await page.waitForFunction(() => window.__trayTest.settings.minimize_to_tray === true);
      assert.equal(await page.locator('#onboard-tray').getAttribute('aria-checked'), 'true');
      assert.deepEqual(errors, []);
      await page.close();
      console.log('TRAY_ONBOARD: separate first-run step persists the choice — OK');
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); server.close(); process.exitCode = 1; });
