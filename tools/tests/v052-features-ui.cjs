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
    page.on('pageerror', (error) => errors.push(error.stack || String(error)));
    await page.addInitScript(() => {
      const calls = [];
      const settings = { onboarded: true, onboarding_pending: false, update_enabled: false, discord_rpc: false, discord_instance_icon: false, theme: 'dark', click_fx: 'off', ambient: 'off', trail: false, ui_scale: 100, categories: [] };
      try { Object.assign(settings, JSON.parse(sessionStorage.getItem('v052-settings') || '{}')); } catch {}
      const instances = [
        { id: 'fabric', name: 'Fabric Pack', playtime_secs: 7200, mc_version: '1.21.1', loader: { type: 'fabric', version: '0.16.9' }, source: 'manual', notes: '' },
        { id: 'paper', name: 'Paper Server', mc_version: '1.21.1', loader: { type: 'vanilla' }, source: 'manual', notes: '', is_server: true, kind: 'server', server: { kernel: 'paper', mc_version: '1.21.1', kernel_version: '1.21.1', memory_mb: 4096, port: 25565 } },
        { id: 'forge', name: 'Forge Pack', mc_version: '1.20.1', loader: { type: 'forge', version: '47.2' }, source: 'import', notes: 'shaders' }
      ];
      const invoke = async (command, args = {}) => {
        calls.push({ command, args });
        if (command === 'get_settings') return JSON.parse(JSON.stringify(settings));
        if (command === 'save_settings') { Object.assign(settings, JSON.parse(JSON.stringify(args.settings))); sessionStorage.setItem('v052-settings', JSON.stringify(settings)); return null; }
        if (command === 'list_instances') return instances.map((item) => ({ ...item }));
        if (command === 'accounts_info') return { accounts: [], active: null };
        if (command === 'app_info') return { home: '/test', version: '0.52.1', demo: false };
        if (command === 'version_info') return { version: '0.52.1', enabled: false };
        if (command === 'system_memory') return { total_mb: 8192 };
        if (command === 'list_java') return [];
        if (command === 'running_instances' || command === 'running_sessions') return [];
        if (command === 'server_snapshot') return { id: 'paper', config: instances[1].server, root: '/test/paper/server', eula_accepted: true, running: false, metrics: { pid: null, memory_bytes: 0, cpu_percent: 0, uptime_secs: 0, tps: null }, players: [], files: [], log_tail: [] };
        if (['server_addons', 'list_mods', 'list_dir', 'content_list'].includes(command)) return [];
        if (command === 'mod_icons') return {};
        if (command === 'server_search_addons') {
          const all = Array.from({ length: 48 }, (_, index) => ({ project_id: `plugin-${index}`, title: `Plugin ${index}`, description: 'Test plugin', downloads: 1000 - index }));
          const offset = Number(args.offset || 0); const limit = Number(args.limit || 24);
          return { hits: all.slice(offset, offset + limit), total_hits: all.length, offset, limit };
        }
        if (command === 'server_addon_versions') return [];
        return null;
      };
      window.__v052 = { calls, settings, instances };
      window.__TAURI__ = { core: { invoke }, event: { listen: async () => () => {} } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('[data-id="fabric"]');

    await page.locator('[data-id="fabric"]').first().click();
    assert.equal(await page.locator('#tb-playtime').innerText(), 'Время игры: 2 ч', 'selected build playtime is shown in its toolbar');
    await page.evaluate(() => { window.__v052.instances[0].playtime_secs = 10800; });
    await page.keyboard.press('Control+r');
    await page.waitForFunction(() => document.querySelector('#tb-playtime').textContent === 'Время игры: 3 ч');
    await page.evaluate(() => { window.__v052.instances[0].playtime_secs = 7200; });
    await page.keyboard.press('Control+r');
    await page.waitForFunction(() => document.querySelector('#tb-playtime').textContent === 'Время игры: 2 ч');
    assert.equal(await page.locator('.sidebar-foot [data-open-customizer]').count(), 0, 'old sidebar customizer button is removed');
    await page.locator('#btn-quick-settings').click();
    const iconSizes = await page.locator('#prefs-nav .prefs-tab-icon .ic').evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect(); return [Math.round(rect.width), Math.round(rect.height)];
    }));
    assert(iconSizes.length > 0 && iconSizes.every((size) => size[0] === iconSizes[0][0] && size[1] === iconSizes[0][1]), 'settings icons have equal dimensions');
    await page.locator('[data-pref="interface"]').click();
    assert.equal(await page.locator('[data-theme-toggle]').count(), 3, 'built-in CSS themes are listed in interface settings');
    assert.equal(await page.locator('.preset-preview-grid [data-theme-layout]').count(), 3);
    await page.locator('.preset-preview-grid img').first().scrollIntoViewIfNeeded();
    await page.waitForFunction(() => [...document.querySelectorAll('.preset-preview-grid img')].every(img => img.complete && img.naturalWidth > 0));
    await page.locator('[data-theme-toggle="builtin-glass"]').click();
    assert.equal(await page.locator('[data-theme-toggle="builtin-glass"]').getAttribute('aria-checked'), 'true');
    assert(await page.locator('#omnispec-theme-modules').textContent().then(s => s.includes('backdrop-filter')), 'switch applies theme CSS');
    await page.locator('[data-theme-toggle="builtin-glass"]').click();
    assert.equal(await page.locator('[data-theme-toggle="builtin-glass"]').getAttribute('aria-checked'), 'false');
    await page.locator('[data-theme-file]').setInputFiles({ name: 'custom-test.css', mimeType: 'text/css', buffer: Buffer.from('body { --theme-test: yes; }') });
    await page.waitForSelector('[data-theme-row]:has-text("custom-test.css")');
    await page.locator('[data-theme-row]:has-text("custom-test.css") [data-theme-toggle]').click();
    assert((await page.locator('#omnispec-theme-modules').textContent()).includes('--theme-test'), 'imported CSS can be enabled');
    await page.waitForFunction(() => window.__v052.settings.ui_theme_modules?.some(m => m.name === 'custom-test.css' && m.enabled));
    await page.locator('[data-open-customizer]').click();
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
    const measured = await page.evaluate(() => {
      const app = document.querySelector('.app').getBoundingClientRect();
      const actual = document.querySelector('.app .toolbar').getBoundingClientRect();
      const stage = document.querySelector('.visual-stage-inner').getBoundingClientRect();
      const preview = document.querySelector('.visual-canvas-item[data-visual-id="toolbar"]').getBoundingClientRect();
      return { expectedWidth: actual.width / app.width, previewWidth: preview.width / stage.width,
        expectedHeight: actual.height / app.width, previewHeight: preview.height / stage.width };
    });
    assert(Math.abs(measured.expectedWidth - measured.previewWidth) < 0.005, 'preview width reflects real launcher geometry');
    assert(Math.abs(measured.expectedHeight - measured.previewHeight) < 0.005, 'preview height reflects real launcher geometry');
    assert.equal(await page.locator('[data-snap-grid]').inputValue(), '16', 'grid snapping defaults to 16 pixels');
    await page.evaluate(() => { document.body.style.zoom = '1.5'; document.body.style.width = 'calc(100vw / 1.5)'; document.body.style.height = 'calc(100vh / 1.5)'; window.dispatchEvent(new Event('resize')); });
    const zoomed = await page.evaluate(() => {
      const app = document.querySelector('.app').getBoundingClientRect(), actual = document.querySelector('.app .toolbar').getBoundingClientRect();
      const stage = document.querySelector('.visual-stage-inner').getBoundingClientRect(), preview = document.querySelector('.visual-canvas-item[data-visual-id="toolbar"]').getBoundingClientRect();
      return [actual.width / app.width, preview.width / stage.width, actual.height / app.width, preview.height / stage.width];
    });
    assert(Math.abs(zoomed[0] - zoomed[1]) < .008 && Math.abs(zoomed[2] - zoomed[3]) < .008, 'preview geometry follows 150 percent UI scale');
    await page.evaluate(() => { document.body.style.zoom = ''; document.body.style.width = ''; document.body.style.height = ''; window.dispatchEvent(new Event('resize')); });
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

    const allVisibleList = await page.locator('.visual-element-list').evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight, max: getComputedStyle(el).maxHeight }));
    assert.equal(allVisibleList.max, 'none', 'complete element list is not clipped by an inner fixed height');
    assert(allVisibleList.client >= allVisibleList.scroll, 'all rows can be reached using the editor scroll');
    assert(await page.locator('.visual-element[data-visual-id="build-path"]').count(), 'build path is available in the editor');
    assert(await page.locator('.visual-canvas-item[data-visual-id="build-path"] .visual-snapshot').count(), 'real build path appears on the canvas for a selected instance');
    await page.locator('.visual-element[data-visual-id="build-path"]').click();
    await page.locator('[data-element-select="mode"]').selectOption('absolute');
    await page.locator('[data-element-number="x"]').fill('176');
    await page.locator('[data-element-number="x"]').dispatchEvent('input');
    assert.equal(await page.locator('#build-path').evaluate(el => getComputedStyle(el).position), 'fixed');
    assert.equal(await page.locator('#build-path').evaluate(el => el.style.left), '176px');
    await page.locator('[data-element-control="surface_opacity"]').fill('0');
    await page.locator('[data-element-control="surface_opacity"]').dispatchEvent('input');
    await page.locator('[data-element-control="backdrop_blur"]').fill('12');
    await page.locator('[data-element-control="backdrop_blur"]').dispatchEvent('input');
    assert.match(await page.locator('#build-path').evaluate(el => getComputedStyle(el).backgroundColor), /(?:\/ 0|, 0)\)$/, 'zero opacity hides background without hiding text');
    assert.equal(await page.locator('#build-path').evaluate(el => getComputedStyle(el).backdropFilter), 'blur(12px)');
    assert.equal(await page.locator('#build-path').evaluate(el => getComputedStyle(el).opacity), '1', 'transparent background does not hide text or controls');
    await page.waitForFunction(() => {const e=window.__v052.settings.ui_layout?.elements?.find(x=>x.id==='build-path');return e?.surface_opacity===0 && e?.backdrop_blur===12;});
    await page.locator('[data-surface-reset]').click();
    assert.equal(await page.locator('#build-path').evaluate(el => el.style.getPropertyValue('backdrop-filter')), '', 'theme reset clears custom blur');
    await page.locator('[data-ui-preset="omnispec"]').click();
    await page.locator('.visual-element[data-visual-id="build-list"]').click();
    await page.locator('[data-element-select="list_view"]').selectOption('grid');
    assert.equal(await page.locator('#instance-list .cat.is-open .cat-items').first().evaluate(el => getComputedStyle(el).display), 'grid', 'compact cards use actual grid layout');
    await page.waitForFunction(() => window.__v052.settings.ui_layout?.elements?.find(x=>x.id==='build-list')?.list_view==='grid');
    await page.locator('[data-element-select="list_view"]').selectOption('list');
    assert.equal(await page.locator('#instance-list .cat.is-open .cat-items').first().evaluate(el => getComputedStyle(el).display), 'flex', 'list layout can be restored');
    await page.locator('[data-ui-preset="omnispec"]').click();

    await page.locator('.visual-element[data-visual-id="account"]').click();
    await page.locator('[data-element-select="mode"]').selectOption('absolute');
    await page.locator('[data-element-number="width"]').fill('64');
    await page.locator('[data-element-number="width"]').dispatchEvent('input');
    await page.waitForFunction(() => document.querySelector('#account-chip').classList.contains('is-avatar-only'));
    assert.equal(await page.locator('#account-chip .acc-main').isVisible(), false, 'compact profile hides text');
    assert.equal(await page.locator('#account-chip .chev').isVisible(), false, 'compact profile hides chevron');
    assert.equal(await page.locator('#account-chip .acc-avatar').isVisible(), true, 'compact profile keeps avatar');
    assert((await page.locator('#account-chip').getAttribute('aria-label')).length > 0, 'profile has an accessible name');
    await page.waitForFunction(() => document.querySelector('.visual-canvas-item[data-visual-id="account"] .account-chip')?.classList.contains('is-avatar-only'));
    await page.waitForFunction(() => /, 0\)$/.test(getComputedStyle(document.querySelector('.app .account-chip')).borderBottomColor));
    await page.locator('[data-element-number="width"]').fill('224');
    await page.locator('[data-element-number="width"]').dispatchEvent('input');
    await page.waitForFunction(() => !document.querySelector('#account-chip').classList.contains('is-avatar-only'));
    assert.equal(await page.locator('#account-chip .acc-main').isVisible(), true, 'profile text returns on expansion');
    await page.locator('[data-ui-preset="omnispec"]').click();

    await page.locator('.visual-element[data-visual-id="build-list"]').click();
    await page.locator('[data-element-select="mode"]').selectOption('absolute');
    await page.locator('[data-element-number="width"]').fill('80');
    await page.locator('[data-element-number="width"]').dispatchEvent('input');
    await page.waitForFunction(() => document.querySelector('#instance-list').classList.contains('is-narrow'));
    const compactRow = page.locator('#instance-list .instance[data-id="fabric"]').first();
    assert.equal(await compactRow.locator('.instance-time').isVisible(), false, 'compact rows hide playtime');
    assert.equal(await compactRow.locator('.instance-body').isVisible(), false, 'compact rows hide build text');
    assert.equal(await compactRow.locator('.instance-icon').isVisible(), true, 'compact rows retain the build icon');
    assert.equal(await compactRow.getAttribute('title'), 'Fabric Pack', 'compact icon retains build name in tooltip');
    assert.equal(await page.locator('#tb-playtime').innerText(), 'Время игры: 2 ч');
    await page.locator('[data-element-number="width"]').fill('224');
    await page.locator('[data-element-number="width"]').dispatchEvent('input');
    await page.waitForFunction(() => !document.querySelector('#instance-list').classList.contains('is-narrow'));
    assert.equal(await page.locator('#instance-list .instance[data-id="fabric"] .instance-time').first().isVisible(), true, 'expanded rows restore playtime');
    await page.locator('[data-ui-preset="omnispec"]').click();

    await page.locator('.visual-element[data-visual-id="sidebar-actions"]').click();
    for (const select of await page.locator('.visual-properties [data-element-select]').all()) {
      const within = await select.evaluate(el => { const a = el.getBoundingClientRect(), b = el.closest('.customizer-control').getBoundingClientRect(); return a.left >= b.left && a.right <= b.right && a.bottom <= b.bottom; });
      assert(within, 'property dropdown is completely inside its cell');
    }
    await page.locator('[data-element-select="mode"]').selectOption('absolute');
    await page.locator('[data-element-number="width"]').fill('64');
    await page.locator('[data-element-number="width"]').dispatchEvent('input');
    await page.waitForFunction(() => document.querySelector('#btn-quick-settings').classList.contains('is-icon-only'));
    assert.equal(await page.locator('#btn-quick-settings span').isVisible(), false, 'independently narrowed actions show only the settings icon');
    await page.waitForFunction(() => document.querySelector('.visual-canvas-item[data-visual-id="sidebar-actions"] .sidebar-quick')?.classList.contains('is-icon-only'));
    await page.locator('[data-element-number="width"]').fill('224');
    await page.locator('[data-element-number="width"]').dispatchEvent('input');
    await page.waitForFunction(() => !document.querySelector('#btn-quick-settings').classList.contains('is-icon-only'));
    assert.equal(await page.locator('#btn-quick-settings span').isVisible(), true, 'caption returns when the independent actions panel grows');
    await page.locator('[data-ui-preset="omnispec"]').click();
    await page.locator('.visual-element[data-visual-id="tabs"]').click();
    await page.locator('[data-element-select="mode"]').selectOption('free');
    await page.locator('[data-element-select="variant"]').selectOption('prominent');
    for (const [key, value] of [['x', '120'], ['y', '44'], ['width', '510'], ['height', '80'], ['margin', '6'], ['padding', '8'], ['radius', '18']]) {
      const control = page.locator(`[data-element-control="${key}"]`);
      await control.fill(value);
      await control.dispatchEvent('input');
    }
    const resized = await page.locator('.app .tabs').evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
    assert(Math.abs(resized.width - 510) < 2 && Math.abs(resized.height - 80) < 2, 'width and height inputs resize the actual element, not just its preview');
    await page.locator('[data-element-visibility="hide"]').click();
    await page.locator('[data-element-visibility="show"]').click();
    await page.waitForTimeout(900);
    await page.waitForFunction(() => {
      const item = window.__v052.settings.ui_layout?.elements?.find((entry) => entry.id === 'tabs');
      return item?.mode === 'free' && item?.variant === 'prominent' && item?.x === 120 && item?.y === 44
        && item?.width === 510 && item?.height === 80 && item?.margin === 6 && item?.padding === 8 && item?.radius === 18 && item?.visible === true;
    });
    await page.locator('[data-ui-preset="omnispec"]').click();
    await page.locator('.visual-element[data-visual-id="tabs"]').click();
    await page.locator('[data-element-select="tabs_orientation"]').selectOption('vertical');
    await page.waitForFunction(() => window.__v052.settings.ui_layout?.elements?.find(e => e.id === 'tabs')?.tabs_orientation === 'vertical');
    const navLayout = await page.evaluate(() => { const nav = document.querySelector('.app .tabs'), content = document.querySelector('.app .tab-body'); const a=nav.getBoundingClientRect(), b=content.getBoundingClientRect(); return { direction:getComputedStyle(nav).flexDirection, navRight:a.right, bodyLeft:b.left, navHeight:a.height, bodyHeight:b.height }; });
    assert.equal(navLayout.direction, 'column');
    assert(navLayout.navRight <= navLayout.bodyLeft + 1 && navLayout.navHeight > 100 && navLayout.bodyHeight > 100, 'vertical navigation sits beside independent workspace');
    await page.locator('#modal-customizer [data-custom-close]').last().click();
    await page.locator('.app .tabs [data-tab="errors"]').click();
    await page.waitForFunction(() => window.omnispecDebug.state.tab === 'errors');
    await page.locator('.app .tabs [data-tab="console"]').click();
    await page.waitForFunction(() => window.omnispecDebug.state.tab === 'console');
    await page.evaluate(() => window.omnispecCustomizer.open());
    await page.locator('.visual-element[data-visual-id="tabs"]').click();
    await page.locator('[data-element-select="tabs_orientation"]').selectOption('horizontal');
    assert.equal(await page.locator('.app .tabs').evaluate(el => getComputedStyle(el).flexDirection), 'row', 'horizontal navigation restored');
    await page.locator('[data-ui-preset="prism"]').click();
    await page.waitForFunction(() => window.__v052.settings.ui_layout?.preset === 'prism');
    const prism = await page.evaluate(() => {
      const sidebar = document.querySelector('.app .sidebar').getBoundingClientRect();
      const main = document.querySelector('.app .main').getBoundingClientRect();
      const group = document.querySelector('.app .cat:not(.cat-running) .cat-items');
      return { sidebarWidth: sidebar.width, mainWidth: main.width, grid: getComputedStyle(group).display };
    });
    assert(prism.sidebarWidth > 250 && prism.mainWidth > 250 && prism.grid === 'grid', 'Prism preset rearranges real panels and uses a grid');
    assert.equal(await page.locator('.app .main').getAttribute('data-tabs-orientation'), 'vertical', 'Prism uses sidebar navigation');
    await page.locator('[data-ui-preset="modrinth"]').click();
    await page.waitForFunction(() => window.__v052.settings.ui_layout?.preset === 'modrinth');
    assert.equal(await page.locator('.app .main').getAttribute('data-tabs-orientation'), 'horizontal', 'Modrinth restores horizontal pages');
    const modrinth = await page.evaluate(() => ({sidebar:document.querySelector('.app .sidebar').getBoundingClientRect().width, main:document.querySelector('.app .main').getBoundingClientRect().width}));
    assert(modrinth.main > modrinth.sidebar, 'Modrinth gives main content more space than its sidebar');

    // Живой редактируемый базовый CSS применён к документу и сохранён.
    await page.locator('[data-custom-tab="css"]').click();
    await page.waitForFunction(() => !document.querySelector('#custom-css-editor')?.readOnly);
    const original = await page.locator('#custom-css-editor').inputValue();
    assert(original.length > 120000 && original.includes('.sidebar {'), 'editor loads the complete original styles.css');
    const css = '[data-os="sidebar"] { outline: 2px solid rgb(1, 2, 3); }';
    // Full mode replaces the base sheet at its original cascade position; do not
    // remove the complete CSS here, otherwise the editor itself has no layout.
    await page.locator('#custom-css-editor').evaluate((el, value) => { el.value += '\n' + value; el.dispatchEvent(new Event('input', { bubbles: true })); }, css);
    await page.waitForFunction((expected) => window.__v052.settings.custom_css.includes(expected), css);
    assert((await page.locator('#omnispec-replacement-base-css').textContent()).includes(css), 'edited base CSS is applied live');
    assert(await page.locator('link[href="styles.css"]').evaluate(node => node.disabled), 'original stylesheet is replaced, not layered on top');

    // Отдельный drag-and-drop на холсте записывает координаты и режим.
    await page.locator('[data-custom-tab="editor"]').click();
    const canvasItem = page.locator('.visual-canvas-item[data-visual-id="toolbar"]');
    assert(await canvasItem.locator('.visual-snapshot .toolbar').count(), 'canvas previews the actual toolbar contents');
    const beforeOthers = await page.evaluate(() => ['#account-chip', '#instance-list', '.app .tab-body'].map(sel => {
      const r = document.querySelector(sel).getBoundingClientRect(); return [r.left, r.top, r.width, r.height];
    }));
    const box = await canvasItem.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const before = await canvasItem.evaluate(node => node.offsetLeft);
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 5 });
    const during = await canvasItem.evaluate(node => node.offsetLeft);
    assert(during > before + 50, 'the visible block follows the pointer before release');
    await page.mouse.up();
    await page.waitForFunction(() => {
      const item = window.__v052.settings.ui_layout?.elements?.find((entry) => entry.id === 'toolbar');
      return item?.mode === 'absolute' && item?.x !== 0 && item?.y !== 0;
    });
    const afterOthers = await page.evaluate(() => ['#account-chip', '#instance-list', '.app .tab-body'].map(sel => {
      const r = document.querySelector(sel).getBoundingClientRect(); return [r.left, r.top, r.width, r.height];
    }));
    assert(beforeOthers.every((entry, i) => entry.every((value, j) => Math.abs(value - afterOthers[i][j]) < 2)), 'other real regions do not shift when a region is detached and moved');
    assert.equal(await page.locator('.app .toolbar').evaluate(el => getComputedStyle(el).position), 'fixed', 'moved real control is independent of its old container');
    await page.locator('.visual-element[data-visual-id="toolbar"]').click();
    const resizedItem = page.locator('.visual-canvas-item[data-visual-id="toolbar"]');
    await page.waitForFunction(() => { const node = document.querySelector('.visual-canvas-item[data-visual-id="toolbar"]'); return node?.classList.contains('is-selected') && getComputedStyle(node).zIndex === '30'; });
    await resizedItem.locator('[data-edge="w"]').hover();
    const edgeBox = await resizedItem.locator('[data-edge="w"]').boundingBox();
    const edgeStart = await resizedItem.evaluate(el => +el.dataset.logicalWidth);
    await page.mouse.move(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2);
    await page.mouse.down(); await page.mouse.move(edgeBox.x - 55, edgeBox.y + edgeBox.height / 2, { steps: 5 }); await page.mouse.up();
    const resizedWidth = await page.locator('.visual-canvas-item[data-visual-id="toolbar"]').evaluate(el => +el.dataset.logicalWidth);
    assert(resizedWidth > edgeStart + 30 && Math.abs(resizedWidth / 16 - Math.round(resizedWidth / 16)) < 0.08, 'dragging edge resizes the real area with grid snapping');
    const snapped = await page.locator('.visual-canvas-item[data-visual-id="toolbar"]').evaluate(el => ({ x: +el.dataset.logicalLeft, y: +el.dataset.logicalTop }));
    assert(Math.abs(snapped.x / 16 - Math.round(snapped.x / 16)) < 0.08 && Math.abs(snapped.y / 16 - Math.round(snapped.y / 16)) < 0.08, 'drag aligns real element geometry with grid');
    await page.locator('[data-align-grid]').click();
    const aligned = await page.evaluate(() => window.__v052.settings.ui_layout.elements.filter(x => x.mode === 'absolute'));
    assert(aligned.length >= 7 && aligned.every(x => x.x % 16 === 0 && x.y % 16 === 0 && x.width % 16 === 0 && x.height % 16 === 0), 'align all snaps positions and sizes');
    const keyItem = page.locator('.visual-canvas-item[data-visual-id="toolbar"]');
    const initialPosition = await page.evaluate(() => window.omnispecDebug.state.settings.ui_layout.elements.find(e => e.id === 'toolbar'));
    await keyItem.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
    const movedByKeys = await page.evaluate(() => window.omnispecDebug.state.settings.ui_layout.elements.find(e => e.id === 'toolbar'));
    assert.equal(movedByKeys.x, initialPosition.x + 16, 'right arrow moves one grid cell');
    assert.equal(movedByKeys.y, initialPosition.y + 16, 'down arrow moves one grid cell');
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowUp');
    for (const [id, selector] of [['build-search', '#instance-search'], ['new-build', '#btn-new-build'], ['account', '#account-chip'], ['action-play', '#btn-play'], ['tab-mods', '.tabs [data-tab="mods"]']]) {
      const toggle = page.locator(`[data-visual-toggle="${id}"]`);
      await toggle.click();
      assert.equal(await page.locator(selector).first().isVisible(), false, `${id} is actually hidden`);
      await page.waitForFunction(id => window.__v052.settings.ui_layout?.elements?.some(e => e.id === id && e.visible === false), id);
      assert.equal(await page.locator(`[data-visual-toggle="${id}"]`).innerText(), 'Показать', `${id} can be restored from the list`);
      await page.locator(`[data-visual-toggle="${id}"]`).click();
      assert.equal(await page.locator(selector).first().isVisible(), true, `${id} is restored`);
    }
    await page.locator('[data-snap-grid]').selectOption('0');
    const offPos = await page.evaluate(() => window.omnispecDebug.state.settings.ui_layout.elements.find(e => e.id === 'toolbar'));
    await page.locator('.visual-canvas-item[data-visual-id="toolbar"]').focus(); await page.keyboard.press('ArrowRight');
    const offMoved = await page.evaluate(() => window.omnispecDebug.state.settings.ui_layout.elements.find(e => e.id === 'toolbar'));
    assert.equal(offMoved.x, offPos.x + 1, 'arrows move one pixel when grid is off');
    assert.equal(await page.locator('.visual-stage-inner').getAttribute('data-grid'), 'off', 'grid can be disabled');

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
    // Скрытый элемент восстанавливает состояние после перезапуска.
    await page.evaluate(() => window.omnispecCustomizer.open());
    await page.locator('.visual-element[data-visual-id="tabs"]').click();
    await page.locator('[data-element-select="tabs_orientation"]').selectOption('vertical');
    await page.locator('[data-visual-toggle="build-search"]').click();
    await page.locator('.visual-element[data-visual-id="build-list"]').click();
    await page.locator('[data-element-select="list_view"]').selectOption('grid');
    await page.locator('[data-element-control="surface_opacity"]').fill('20');
    await page.locator('[data-element-control="surface_opacity"]').dispatchEvent('input');
    await page.locator('[data-element-control="backdrop_blur"]').fill('8');
    await page.locator('[data-element-control="backdrop_blur"]').dispatchEvent('input');
    await page.locator('[data-element-control="surface_radius"]').fill('24');
    await page.locator('[data-element-control="surface_radius"]').dispatchEvent('input');
    await page.locator('[data-element-control="build_card_size"]').fill('130');
    await page.locator('[data-element-control="build_card_size"]').dispatchEvent('input');
    assert.equal(await page.locator('#instance-list').evaluate(el => getComputedStyle(el).borderRadius), '24px');
    assert.equal(await page.locator('#instance-list').evaluate(el => el.style.getPropertyValue('--os-build-card-size')), '130px');
    await page.waitForFunction(() => {const es=window.__v052.settings.ui_layout?.elements || []; const e=es.find(x=>x.id==='build-list'); return es.some(x=>x.id==='build-search'&&!x.visible) && e?.list_view==='grid' && e?.surface_opacity===20 && e?.backdrop_blur===8 && e?.surface_radius===24 && e?.build_card_size===130;});
    // Полный файл переживает перезапуск и может быть безопасно отключён.
    await page.reload();
    await page.waitForFunction(() => document.querySelector('link[href="styles.css"]')?.disabled === true);
    assert((await page.locator('#omnispec-replacement-base-css').textContent()).includes(css), 'edited base restored after reload');
    await page.waitForFunction(() => document.querySelector('#omnispec-theme-modules')?.textContent.includes('--theme-test'));
    await page.evaluate(() => window.omnispecCustomizer.open());
    assert.equal(await page.locator('.app .main').getAttribute('data-tabs-orientation'), 'vertical', 'vertical orientation survives reload');
    assert.equal(await page.locator('#instance-search').isVisible(), false, 'hidden search stays hidden after reload');
    assert.equal(await page.locator('#instance-list').getAttribute('data-build-view'), 'grid', 'chosen grid survives reload');
    assert.equal(await page.locator('#instance-list').evaluate(el => getComputedStyle(el).borderRadius), '24px', 'background rounding survives reload');
    assert.equal(await page.locator('#instance-list').evaluate(el => el.style.getPropertyValue('--os-build-card-size')), '130px', 'build card size survives reload');
    assert.equal(await page.locator('#instance-list').evaluate(el => getComputedStyle(el).backdropFilter), 'blur(8px)', 'blur survives reload');
    assert.equal((await page.locator('#instance-list').evaluate(el => el.style.getPropertyValue('background-color'))).includes('20%'), true, 'background opacity survives reload');
    await page.locator('[data-visual-toggle="build-search"]').click();
    assert.equal(await page.locator('#instance-search').isVisible(), true, 'hidden search can be restored after reload');
    await page.locator('[data-custom-tab="css"]').click();
    assert((await page.locator('#custom-css-editor').inputValue()).includes(css), 'full stylesheet remains editable after reload');
    await page.locator('#custom-css-find').fill('sidebar');
    await page.locator('[data-css-action="find"]').click();
    const found = await page.locator('#custom-css-editor').evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd));
    assert.equal(found.toLowerCase(), 'sidebar', 'find selects a match in the CSS editor');
    page.once('dialog', dialog => dialog.accept());
    await page.keyboard.press('Control+Shift+Backspace');
    await page.waitForFunction(() => !document.querySelector('link[href="styles.css"]').disabled && window.__v052.settings.custom_css === '');
    // Plain CSS remains an override; saved old themes must not disable the base.
    await page.locator('#custom-theme-file').setInputFiles({ name: 'legacy.css', mimeType: 'text/css', buffer: Buffer.from(css) });
    await page.waitForFunction(expected => window.__v052.settings.custom_css === expected, css);
    assert.equal(await page.locator('link[href="styles.css"]').evaluate(el => el.disabled), false, 'plain CSS import keeps the original stylesheet');
    assert((await page.locator('#omnispec-custom-css').textContent()).includes(css));
    // Explicit full-sheet import replaces the original and keeps its identity.
    const fullCss = '/* OmniSpec: full base stylesheet */\n' + original + '\n' + css;
    await page.locator('#custom-theme-file').setInputFiles({ name: 'full.css', mimeType: 'text/css', buffer: Buffer.from(fullCss) });
    await page.waitForFunction(() => document.querySelector('link[href="styles.css"]').disabled);
    assert((await page.locator('#omnispec-replacement-base-css').textContent()).includes(css));
    // Реальный список переезжает в рабочую область, а не дублируется.
    await page.locator('[data-custom-tab="editor"]').click();
    await page.locator('[data-ui-preset="omnispec"]').click();
    await page.locator('.visual-element[data-visual-id="build-list"]').click();
    await page.locator('[data-element-select="merged_workspace"]').selectOption('true');
    await page.waitForFunction(() => window.__v052.settings.ui_layout?.elements?.find(e => e.id === 'build-list')?.merged_workspace === true);
    assert.equal(await page.locator('#workspace-library-body #instance-list').count(), 1);
    await page.evaluate(() => window.omnispecCustomizer.close());
    await page.locator('#instance-list .instance[data-id="fabric"]').first().click();
    assert.equal(await page.locator('#workspace-library-body').isVisible(), true, 'single click selects without leaving the library');
    assert.equal(await page.locator('#tb-name').innerText(), 'Fabric Pack');
    assert.equal(await page.locator('#workspace-open').isEnabled(), true);
    await page.locator('#workspace-open').click();
    assert.equal(await page.locator('#workspace-library-body').isVisible(), false);
    await page.locator('.tab[data-tab="files"]').click();
    await page.locator('.tab[data-tab="mods"]').click();
    await page.locator('#tab-back').click();
    assert.equal(await page.locator('.tab[data-tab="files"]').evaluate(el => el.classList.contains('is-active')), true);
    await page.locator('#tab-forward').click();
    assert.equal(await page.locator('.tab[data-tab="mods"]').evaluate(el => el.classList.contains('is-active')), true);
    await page.locator('#workspace-library').click();
    assert.equal(await page.locator('#workspace-library-body').isVisible(), true);
    await page.locator('#instance-list .instance[data-id="paper"]').first().dblclick();
    assert.equal(await page.locator('#workspace-library-body').isVisible(), false, 'double click opens selected build');
    assert.equal(await page.locator('#tb-name').innerText(), 'Paper Server');
    assert.equal(await page.locator('#tab-back').isDisabled(), true, 'history resets for another build');
    await page.locator('#workspace-library').click();
    await page.reload();
    await page.waitForSelector('#workspace-library-body #instance-list');
    assert.equal(await page.locator('#workspace-library-body').isVisible(), true, 'merged layout survives reload');
    await page.evaluate(() => window.omnispecCustomizer.open());
    await page.locator('.visual-element[data-visual-id="build-list"]').click();
    await page.locator('[data-element-select="merged_workspace"]').selectOption('false');
    assert.equal(await page.locator('.sidebar > #instance-list').count(), 1, 'separate layout is restored');
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('V052_UI: fullscreen editor, CSS persistence, drag/properties, custom context menus, export actions, dynamic categories and server infinite scroll — OK');
  } finally {
    await browser.close();
    server.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; server.close(); });
