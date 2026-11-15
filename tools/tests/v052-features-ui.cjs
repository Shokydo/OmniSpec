// 0.52: fullscreen visual editor, editable CSS, build context actions, dynamic categories and server catalog pagination.
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
        if (command === 'app_info') return { home: '/test', version: '0.52.1', demo: false };
        if (command === 'version_info') return { version: '0.52.1', enabled: false };
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
    const iconSizes = await page.locator('#prefs-nav .prefs-tab-icon .ic').evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect(); return [Math.round(rect.width), Math.round(rect.height)];
    }));
    assert(iconSizes.length > 0 && iconSizes.every((size) => size[0] === iconSizes[0][0] && size[1] === iconSizes[0][1]), 'settings icons have equal dimensions');
    await page.locator('[data-pref="interface"]').click();
    await page.waitForSelector('#modal-customizer:not([hidden]) [data-editor-root]');
    assert.equal(await page.locator('#modal-prefs:not([hidden]) [data-editor-root]').count(), 0, 'customizer is not mounted in the cramped preferences pane');
    assert.equal(await page.locator('#modal-customizer:not([hidden]) .visual-editor').count(), 1, 'visual editor is mounted in the fullscreen customizer');
    const customizerGeometry = await page.locator('#modal-customizer .customizer-box').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height), viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
    });
    assert(customizerGeometry.width >= customizerGeometry.viewportWidth - 52, 'customizer uses the full available width');
    assert(customizerGeometry.height >= customizerGeometry.viewportHeight - 52, 'customizer uses the full available height');
    assert.equal(await page.locator('[data-element-select="mode"].select').count(), 1, 'visual editor selects use launcher styling');
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
    await page.locator('[data-element-select="variant"]').selectOption('prominent');
    for (const [key, value] of [['x', '120'], ['y', '44'], ['width', '510'], ['height', '80'], ['margin', '6'], ['padding', '8'], ['radius', '18']]) {
      const control = page.locator(`[data-element-control="${key}"]`);
      await control.fill(value);
      await control.dispatchEvent('input');
    }
    await page.locator('[data-element-visibility="hide"]').click();
    await page.locator('[data-element-visibility="show"]').click();
    await page.waitForTimeout(900);
    await page.waitForFunction(() => {
      const item = window.__v052.settings.ui_layout?.elements?.find((entry) => entry.id === 'tabs');
      return item?.mode === 'free' && item?.variant === 'prominent' && item?.x === 120 && item?.y === 44
        && item?.width === 510 && item?.height === 80 && item?.margin === 6 && item?.padding === 8 && item?.radius === 18 && item?.visible === true;
    });
    await page.locator('[data-ui-preset="prism"]').click();
    await page.waitForFunction(() => window.__v052.settings.ui_layout?.preset === 'prism');

    // Живой редактируемый базовый CSS применён к документу и сохранён.
    await page.locator('[data-custom-tab="css"]').click();
    const css = '[data-os="sidebar"] { outline: 2px solid rgb(1, 2, 3); }';
    await page.locator('#custom-css-editor').fill(css);
    await page.waitForFunction((expected) => window.__v052.settings.custom_css === expected, css);
    assert((await page.locator('#omnispec-custom-css').textContent()).includes(css), 'custom CSS is applied live');

    // Отдельный drag-and-drop на холсте записывает координаты и режим.
    await page.locator('[data-custom-tab="editor"]').click();
    const canvasItem = page.locator('.visual-canvas-item[data-visual-id="toolbar"]');
    await canvasItem.dragTo(page.locator('.visual-stage-inner'), { targetPosition: { x: 520, y: 210 } });
    await page.waitForFunction(() => {
      const item = window.__v052.settings.ui_layout?.elements?.find((entry) => entry.id === 'toolbar');
      return item?.mode === 'free' && item?.x !== 0 && item?.y !== 0;
    });

    // Порядок крупных областей тоже меняется перетаскиванием и сохраняется.
    await page.locator('[data-custom-tab="layout"]').click();
    const firstLayout = page.locator('.layout-item[data-layout-id="toolbar"]');
    await firstLayout.dragTo(page.locator('.layout-item[data-layout-id="content"]'), { targetPosition: { x: 20, y: 40 } });
    await page.waitForFunction(() => window.__v052.settings.ui_layout?.main_order?.[2] === 'toolbar');

    // Закрыть полноэкранный редактор и создать динамическую категорию через
    // штатное контекстное меню списка.
    await page.locator('#modal-customizer [data-custom-close]').last().click();
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

    // ПКМ по сборке и по заголовку категории всегда открывает только меню OmniSpec.
    await page.locator('[data-id="fabric"]').click({ button: 'right' });
    await page.waitForSelector('#ctx-menu:not([hidden])');
    assert.equal(await page.locator('#ctx-menu [data-act="export:mrpack"]').count(), 1, 'build context menu exposes mrpack export');
    assert.equal(await page.locator('#ctx-menu [data-act="export:zip"]').count(), 1, 'build context menu exposes zip export');
    await page.locator('#ctx-menu [data-act="export:mrpack"]').click();
    await page.waitForSelector('#modal-export:not([hidden])');
    assert.equal(await page.locator('#modal-export [data-exp-format="mrpack"].is-active').count(), 1, 'mrpack export keeps the existing export dialog parameters');
    await page.locator('#modal-export [data-close-export]').first().click();
    await page.locator('#instance-list .cat-dynamic .cat-head').click({ button: 'right' });
    await page.waitForSelector('#ctx-menu:not([hidden])');
    assert(await page.locator('#ctx-menu .ctx-item').count() > 0, 'category context menu is custom');
    await page.locator('body').click({ position: { x: 900, y: 700 } });
    const contextWasPrevented = await page.evaluate(() => {
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 1, clientY: 1 });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(contextWasPrevented, true, 'browser context menu is prevented globally');

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
    console.log('V052_UI: fullscreen editor, CSS persistence, drag/properties, custom context menus, export actions, dynamic categories and server infinite scroll — OK');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; server.close(); });
