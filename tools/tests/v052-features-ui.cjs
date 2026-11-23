// 0.52: visual editor, dynamic categories and server catalog pagination.
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
    const type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      const calls = [];
      const settings = { onboarded: true, onboarding_pending: false, update_enabled: false, discord_rpc: false, discord_instance_icon: false, theme: 'dark', click_fx: 'off', ambient: 'off', trail: false, ui_scale: 100, categories: [] };
      const instances = [
        { id: 'fabric', name: 'Fabric Pack', mc_version: '1.21.1', loader: { type: 'fabric', version: '0.16.9' }, source: 'manual', notes: '' },
        { id: 'paper', name: 'Paper Server', mc_version: '1.21.1', loader: { type: 'vanilla' }, source: 'manual', notes: '', is_server: true, kind: 'server', server: { kernel: 'paper', mc_version: '1.21.1', kernel_version: '1.21.1', memory_mb: 4096, port: 25565 } },
        { id: 'forge', name: 'Forge Pack', mc_version: '1.20.1', loader: { type: 'forge', version: '47.2' }, source: 'import', notes: 'shaders' }
      ];
      const invoke = async (command, args = {}) => {
        calls.push({ command, args });
        if (command === 'get_settings') return JSON.parse(JSON.stringify(settings));
        if (command === 'save_settings') { Object.assign(settings, JSON.parse(JSON.stringify(args.settings))); return null; }
        if (command === 'list_instances') return instances.map((item) => ({ ...item }));
        if (command === 'accounts_info') return { accounts: [], active: null };
        if (command === 'app_info') return { home: '/test', version: '0.52.0', demo: false };
        if (command === 'version_info') return { version: '0.52.0', enabled: false };
        if (command === 'system_memory') return { total_mb: 8192 };
        if (command === 'list_java') return [];
        if (command === 'running_instances' || command === 'running_sessions') return [];
        if (command === 'server_snapshot') return { id: 'paper', config: instances[1].server, root: '/test/paper/server', eula_accepted: true, running: false, metrics: { pid: null, memory_bytes: 0, cpu_percent: 0, uptime_secs: 0, tps: null }, players: [], files: [], log_tail: [] };
        if (command === 'server_addons') return [];
        if (command === 'server_search_addons') {
          const all = Array.from({ length: 48 }, (_, index) => ({ project_id: `plugin-${index}`, title: `Plugin ${index}`, description: 'Test plugin', downloads: 1000 - index }));
          const offset = Number(args.offset || 0); const limit = Number(args.limit || 24);
          return { hits: all.slice(offset, offset + limit), total_hits: all.length, offset, limit };
        }
        if (command === 'server_addon_versions') return [];
        return null;
      };
      window.__v052 = { calls, settings };
      window.__TAURI__ = { core: { invoke }, event: { listen: async () => () => {} } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('[data-id="fabric"]');

    assert.equal(await page.locator('.sidebar-foot [data-open-customizer]').count(), 0, 'old sidebar customizer button is removed');
    await page.locator('#btn-quick-settings').click();
    await page.locator('[data-pref="interface"]').click();
    await page.waitForSelector('#modal-prefs [data-editor-root]');
    assert(await page.locator('#modal-prefs .visual-editor').count(), 'inline visual editor is mounted in launcher settings');
    const iconSizes = await page.locator('#prefs-nav .prefs-tab-icon .ic').evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect(); return [Math.round(rect.width), Math.round(rect.height)];
    }));
    assert(iconSizes.every((size) => size[0] === iconSizes[0][0] && size[1] === iconSizes[0][1]), 'settings icons have equal dimensions');
    const filterRadii = await page.evaluate(() => {
      const home = document.createElement('aside');
      home.className = 'home-catalog-sidebar';
      const download = document.createElement('aside');
      download.className = 'download-catalog-sidebar';
      const category = document.createElement('button');
      category.className = 'home-category';
      download.append(category);
      document.body.append(home, download);
      const radius = (node) => getComputedStyle(node).borderTopLeftRadius;
      const previousShape = document.body.dataset.shape;
      document.body.dataset.shape = 'rounded';
      const rounded = { home: radius(home), download: radius(download), category: radius(category) };
      document.body.dataset.shape = 'pill';
      const pill = { home: radius(home), download: radius(download), category: radius(category) };
      home.remove(); download.remove();
      document.body.dataset.shape = previousShape;
      return { rounded, pill };
    });
    assert.deepEqual(filterRadii.rounded, { home: '20px', download: '20px', category: '12px' }, 'filter shells follow rounded shape');
    assert.deepEqual(filterRadii.pill, { home: '999px', download: '999px', category: '999px' }, 'filter controls follow pill shape');

    await page.locator('.visual-element[data-visual-id="tabs"]').click();
    await page.locator('[data-element-select="mode"]').selectOption('free');
    await page.locator('[data-element-control="x"]').fill('120');
    await page.locator('[data-element-control="x"]').dispatchEvent('input');
    await page.waitForFunction(() => window.__v052.settings.ui_layout?.elements?.find((item) => item.id === 'tabs')?.x === 120);
    await page.locator('[data-ui-preset="prism"]').click();
    await page.waitForFunction(() => window.__v052.settings.ui_layout?.preset === 'prism');

    // Создать динамическую категорию через штатное контекстное меню списка.
    await page.locator('#modal-prefs [data-close-prefs]').click();
    await page.locator('#instance-list').dispatchEvent('contextmenu');
    await page.waitForSelector('#ctx-menu:not([hidden])');
    await page.locator('#ctx-menu [data-act="dynamic-category"]').click();
    await page.locator('#category-editor-name').fill('Серверы 1.21');
    await page.locator('#category-editor-versions').fill('1.21.1');
    await page.locator('#category-editor-loaders').fill('paper');
    await page.locator('#category-editor-kind').selectOption('server');
    await page.locator('#category-editor-save').click();
    await page.waitForSelector('#instance-list .cat-dynamic');
    assert.equal(await page.locator('#instance-list .cat-dynamic .cat-count').textContent(), '1', 'dynamic server category matches metadata');

    await page.locator('[data-id="paper"]').click();
    await page.locator('[data-tab="download"]').click();
    await page.locator('#server-download-query').fill('plugin');
    await page.locator('#server-download-search').click();
    await page.waitForSelector('.server-download-card');
    assert.equal(await page.locator('.server-download-card').count(), 24, 'first catalog page is shown');
    await page.locator('.server-download-sentinel').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('.server-download-card').length === 48);
    assert.equal(await page.locator('.server-download-sentinel').textContent(), 'Показано всё: 48');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('V052_UI: editor placement, presets, icon sizes, dynamic categories and server infinite scroll — OK');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; server.close(); });
