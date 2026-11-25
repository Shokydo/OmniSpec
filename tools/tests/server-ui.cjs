// Server workspace UI regression with a mocked Tauri backend.
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
    const type = ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 800}});
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('dialog', (dialog) => { errors.push('Unexpected native dialog: ' + dialog.type()); dialog.dismiss(); });
    await page.addInitScript(() => {
      const test = window.__serverTest = {
        calls: [],
        events: {},
        failStop: false,
        running: [],
        eula: false,
        backups: [],
        instance: {
          id: 'srv', name: 'Local Paper', mc_version: '1.21.4',
          loader: {type: 'vanilla'}, icon: null, created: 1, playtime_secs: 0,
          is_server: true, kind: 'server',
          server: {kernel: 'paper', mc_version: '1.21.4', kernel_version: '1.21.4', memory_mb: 4096, port: 25565}
        },
        async invoke(command, args = {}) {
          this.calls.push({command, args});
          switch (command) {
            case 'get_settings': return {onboarded: true, onboarding_pending: false, update_enabled: false, discord_rpc: false, discord_instance_icon: false, theme: 'dark', click_fx: 'off', ambient: 'off', trail: false, ui_scale: 100, categories: [], last_instance: null};
            case 'save_settings': return null;
            case 'accounts_info': return {accounts: [], active: null};
            case 'app_info': return {home: '/test', version: 'test', platform: 'linux', demo: false};
            case 'system_memory': return {total_mb: 8192};
            case 'version_info': return {enabled: false, version: 'test'};
            case 'list_java': return [];
            case 'list_instances': return [{...this.instance}];
            case 'running_sessions': return this.running.map((item) => ({...item}));
            case 'running_instances': return [...new Set(this.running.map((item) => item.instance_id))];
            case 'set_presence': return null;
            case 'instance_path': return '/test/instances/srv/server';
            case 'instance_icon': return null;
            case 'server_snapshot': return {id: 'srv', config: {...this.instance.server}, root: '/test/instances/srv/server', eula_accepted: this.eula, running: this.running.length > 0, metrics: {pid: null, memory_bytes: 0, cpu_percent: 0, uptime_secs: 0, tps: null}, players: [], files: [], log_tail: []};
            case 'server_addons': return [];
            case 'fm_import': return args.paths.length;
            case 'list_dir': return [{name:'config', path:'config', is_dir:true, size:0}];
            case 'server_files': return [{name: 'plugins', path: 'plugins', size: 0, modified: 1700000000, kind: 'directory'}, {name: 'server.properties', path: 'server.properties', size: 64, modified: 1700000000, kind: 'config'}];
            case 'server_get': return {...this.instance.server, stop_command: 'stop', tps_command: 'tps', jar: 'paper.jar'};
            case 'server_save': this.instance.server = {...args.config}; return this.instance.server;
            case 'server_set_eula': this.eula = Boolean(args.accepted); return null;
            case 'server_write_icon': return null;
            case 'server_start': this.running = [{instance_id: 'srv', run_id: 'srv#server', account: 'server', started_at: 1700000000}]; return {instance_id: 'srv', run_id: 'srv#server', pid: 42, started_at: 1700000000};
            case 'server_stop': if (this.failStop) throw new Error('stop failed'); this.running = []; return null;
            case 'server_kill': this.running = []; return null;
            case 'server_command': return null;
            case 'server_backup_list': return this.backups.map((item) => ({...item}));
            case 'server_backup_create': { const item = {name: 'manual_1.zip', path: '/test/backups/manual_1.zip', size: 123, created: 1700000000}; this.backups.push(item); return item; }
            case 'server_backup_restore': return null;
            case 'server_backup_delete': this.backups = this.backups.filter((item) => item.name !== args.name); return null;
            case 'search_modrinth': return {hits: [], total_hits: 0};
            case 'server_search_addons': return {hits: [{project_id: 'luckperms', title: 'LuckPerms', description: 'Permissions plugin', downloads: 12345, icon_url:'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2248%22 height=%2248%22%3E%3Crect width=%2248%22 height=%2248%22 fill=%22%2365d391%22/%3E%3C/svg%3E'}], total_hits: 1};
            case 'server_addon_versions': return [{id: 'luck-v1', project_id: 'luckperms', name: '5.4.0', version_number: '5.4.0', game_versions: ['1.21.4'], loaders: ['paper'], files: [{url: 'https://cdn.example.test/LuckPerms.jar', filename: 'LuckPerms.jar', primary: true, size: 40, hashes: {sha1: '0123456789abcdef0123456789abcdef01234567'}}]}];
            case 'server_install_catalog_addon': return {name: args.req.filename, path: `plugins/${args.req.filename}`, size: args.req.size, kind: 'plugins', enabled: true};
            case 'server_kernels': return [{id: 'paper', label: 'Paper', group: 'Bukkit', supports_plugins: true, supports_mods: false}];
            case 'server_kernel_versions': return [{id: '1.21.4', label: '1.21.4', mc_version: '1.21.4'}];
            case 'server_scan': return [];
            default: return null;
          }
        }
      };
      window.__TAURI__ = {
        core: {invoke: (command, args) => test.invoke(command, args)},
        event: {listen: async (name, cb) => { test.events[name] = cb; return () => {}; }}
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('[data-id="srv"]');
    await page.locator('[data-tab="servers"]').click();
    await page.waitForSelector('.server-card');
    assert.equal(await page.locator('.server-card .server-action').count(), 4, 'server list card exposes four process actions');
    await page.locator('[data-server-open="srv"]').click();
    await page.waitForSelector('.server-view');
    assert.match(await page.locator('.server-view').innerText(), /Local Paper/);
    const radii = await page.evaluate(() => {
      const body = document.body, prior = body.dataset.shape;
      const measure = () => [getComputedStyle(document.querySelector('.server-overview-hero')).borderRadius, getComputedStyle(document.querySelector('.stat-card')).borderRadius, getComputedStyle(document.querySelector('.panel')).borderRadius, getComputedStyle(document.querySelector('.build-head .tb-icon')).borderRadius];
      body.dataset.shape = 'square'; const square = measure();
      body.dataset.shape = 'rounded'; const rounded = measure();
      body.dataset.shape = prior; return {square, rounded};
    });
    assert(radii.square.every(r => r === '0px'), `all server panels and build icon square: ${JSON.stringify(radii)}`);
    assert(radii.rounded.every(r => r !== '0px'), `round shape restored: ${JSON.stringify(radii)}`);
    await page.locator('#server-settings').click();
    await page.waitForSelector('#modal-prompt:not([hidden])');
    assert.equal(await page.locator('#prompt-label').innerText(), 'Порт сервера');
    await page.locator('#prompt-input').fill('25570');
    await page.locator('#prompt-ok').click();
    await page.waitForFunction(() => document.querySelector('#prompt-label').textContent.includes('ОЗУ'));
    await page.locator('#prompt-input').fill('6144');
    await page.locator('#prompt-ok').click();
    await page.waitForFunction(() => window.__serverTest.calls.some(c => c.command === 'server_save' && c.args.config.port === 25570 && c.args.config.memory_mb === 6144));
    await page.waitForSelector('#server-eula');
    await page.locator('#server-settings').click();
    await page.waitForSelector('#modal-prompt:not([hidden])');
    const savesBeforeCancel = await page.evaluate(() => window.__serverTest.calls.filter(c => c.command === 'server_save').length);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#modal-prompt[hidden]', {state:'attached'});
    assert.equal(await page.evaluate(() => window.__serverTest.calls.filter(c => c.command === 'server_save').length), savesBeforeCancel, 'cancel input never saves');
    assert.equal(await page.locator('#server-eula').count(), 1, 'new/imported servers expose an EULA action');
    await page.locator('#server-eula').click();
    await page.locator('#modal-confirm:not([hidden]) #confirm-cancel').click();
    assert.equal(await page.evaluate(() => window.__serverTest.eula), false, 'cancelling EULA performs no action');
    await page.locator('#server-eula').click();
    await page.locator('#modal-confirm:not([hidden]) #confirm-ok').click();
    await page.waitForFunction(() => window.__serverTest.eula === true);
    await page.waitForFunction(() => document.querySelector('#server-eula') === null);
    await page.locator('#btn-play').click();
    await page.waitForFunction(() => window.__serverTest.calls.some((item) => item.command === 'server_start'));
    await page.waitForFunction(() => window.omnispecDebug.state.running.has('srv'));
    await page.waitForFunction(() => document.querySelector('#btn-play span')?.textContent.includes('Перезапустить'));
    const beforeRestart = await page.evaluate(() => window.__serverTest.calls.length);
    await page.locator('#btn-play').click();
    await page.waitForFunction(n => window.__serverTest.calls.slice(n).some(x => x.command === 'server_start'), beforeRestart);
    const actions = await page.evaluate(n => window.__serverTest.calls.slice(n).filter(x => ['server_start','server_stop'].includes(x.command)).map(x => x.command), beforeRestart);
    assert.deepEqual(actions, ['server_stop', 'server_start'], 'toolbar restart stops before starting');
    await page.waitForFunction(() => window.omnispecDebug.state.running.has('srv'));
    await page.evaluate(() => { window.__serverTest.failStop = true; });
    const beforeFailedRestart = await page.evaluate(() => window.__serverTest.calls.length);
    await page.locator('#btn-play').click();
    await page.waitForFunction(n => window.__serverTest.calls.slice(n).some(x => x.command === 'server_stop'), beforeFailedRestart);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(n => window.__serverTest.calls.slice(n).some(x => x.command === 'server_start'), beforeFailedRestart), false, 'failed stop must never start');
    await page.evaluate(() => { window.__serverTest.failStop = false; });
    const groupOrder = await page.locator('#instance-list > .cat').evaluateAll((groups) => groups.map((group) => group.dataset.cat));
    assert.equal(groupOrder[0], '__running', 'running servers stay in the pinned category');
    assert.equal(await page.locator('#instance-list > .cat.cat-running').count(), 1, 'running category has sticky marker');
    // Открытая длинная категория не должна сжимать закреплённые запуски.
    await page.evaluate(() => {
      const state = window.omnispecDebug.state;
      window.__runningLayoutOriginal = { instances: state.instances, categories: state.settings.categories };
      state.settings.categories = [{ id: 'many', name: 'Избранное', collapsed: false }];
      state.instances = [...state.instances, ...Array.from({ length: 35 }, (_, n) => ({
        id: `extra-${n}`, name: `Pack ${n}`, category: 'many', mc_version: '1.20.1', loader: { type: 'vanilla' }
      }))];
      document.querySelector('#instance-search').dispatchEvent(new Event('input', { bubbles: true }));
    });
    const geometry = await page.locator('#instance-list').evaluate((list) => {
      const pinned = list.querySelector('.cat-running'), row = pinned.querySelector('.instance');
      const before = { list: list.getBoundingClientRect().top, pinned: pinned.getBoundingClientRect().top,
        pinnedHeight: pinned.getBoundingClientRect().height, rowHeight: row.getBoundingClientRect().height,
        itemHeight: pinned.querySelector('.cat-items').getBoundingClientRect().height,
        scrollHeight: list.scrollHeight, height: list.clientHeight };
      list.scrollTop = 500;
      return { ...before, stickyTop: pinned.getBoundingClientRect().top };
    });
    assert(geometry.scrollHeight > geometry.height, 'open category overflows and scrolls');
    assert(geometry.pinnedHeight >= geometry.rowHeight + 20 && geometry.itemHeight >= geometry.rowHeight,
      'running row is not collapsed or clipped by other expanded categories');
    assert(Math.abs(geometry.stickyTop - geometry.list) < 5, 'running category remains pinned during scroll');
    await page.evaluate(() => {
      const state = window.omnispecDebug.state;
      window.__runningLayoutOriginal.running = new Set(state.running);
      for (let n = 0; n < 20; n++) state.running.add(`extra-${n}`);
      document.querySelector('#instance-search').dispatchEvent(new Event('input', { bubbles: true }));
    });
    const manyRunning = await page.locator('#instance-list').evaluate(list => {
      const pinned = list.querySelector('.cat-running'), items = pinned.querySelector('.cat-items');
      return { pinnedHeight: pinned.getBoundingClientRect().height, listHeight: list.clientHeight,
        scrollHeight: items.scrollHeight, itemsHeight: items.clientHeight };
    });
    assert(manyRunning.pinnedHeight <= manyRunning.listHeight * .5 + 2, 'many running instances leave space for other categories');
    assert(manyRunning.scrollHeight > manyRunning.itemsHeight, 'many running instances scroll inside the pinned block');
    await page.evaluate(() => {
      const state = window.omnispecDebug.state, saved = window.__runningLayoutOriginal;
      state.instances = saved.instances; state.settings.categories = saved.categories; state.running = saved.running;
      document.querySelector('#instance-search').dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.locator('[data-tab="server"]').click();
    await page.waitForSelector('.server-overview-hero');
    assert.equal(await page.locator('[data-server-action="start"]').count(), 1);
    assert.equal(await page.locator('[data-server-action="restart"]').count(), 1);
    assert.equal(await page.locator('[data-server-action="stop"]').count(), 1);
    assert.equal(await page.locator('[data-server-action="kill"]').count(), 1);
    await page.locator('[data-tab="download"]').click();
    await page.waitForSelector('#server-download-query');
    await page.waitForSelector('.server-download-card');
    assert.equal(await page.locator('.server-download-icon').count(), 1, 'project icon is rendered');
    assert.equal(await page.locator('[data-server-view="list"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.server-download-description').isVisible(), true);
    await page.locator('[data-server-view="grid"]').click();
    assert.equal(await page.locator('#server-download-results').evaluate(el => el.classList.contains('is-grid')), true);
    assert.equal(await page.locator('.server-download-description').isVisible(), false);
    for (let level=1; level<=6; level++) {
      await page.locator('#server-download-size').fill(String(level));
      assert.equal(await page.locator('#server-download-size-value').innerText(), String(level));
      assert.equal(await page.evaluate(() => window.omnispecDebug.state.settings.mods_grid), level);
      const card = await page.locator('.server-download-card').boundingBox();
      assert(card.width >= 110 && card.width < 1100, 'card remains usable at every size');
    }
    await page.locator('#server-download-size').fill('1');
    await page.locator('[data-server-download-load]').click();
    await page.waitForSelector('[data-server-download-install]');
    assert.equal(await page.locator('[data-server-download-install]').isVisible(), true, 'versions usable at smallest tile size');
    await page.locator('[data-server-view="list"]').click();
    assert.equal(await page.locator('[data-server-download-install]').isVisible(), true, 'switching layout preserves selected versions');
    assert.equal(await page.locator('.server-download-description').isVisible(), true);
    const filterRect = await page.locator('.server-catalog-sidebar').boundingBox();
    const resultRect = await page.locator('#server-download-results').boundingBox();
    assert(filterRect.x + filterRect.width <= resultRect.x, 'server filters appear left of results');
    await page.locator('[data-server-category="optimization"]').click();
    await page.waitForFunction(() => window.__serverTest.calls.some(x => x.command === 'server_search_addons' && x.args.category === 'optimization' && x.args.mcVersion === '1.21.4' && x.args.loader === 'paper'));
    assert.equal(await page.locator('[data-server-category="optimization"]').getAttribute('aria-pressed'), 'true');
    await page.locator('#server-download-sort').selectOption('updated');
    await page.waitForFunction(() => window.__serverTest.calls.some(x => x.command === 'server_search_addons' && x.args.sort === 'updated' && x.args.category === 'optimization'));
    await page.locator('#server-download-scope').selectOption('all');
    await page.waitForFunction(() => window.__serverTest.calls.some(x => x.command === 'server_search_addons' && x.args.mcVersion === null && x.args.loader === 'paper'));
    await page.locator('[data-server-category=""]').click();
    await page.locator('#server-download-scope').selectOption('compatible');
    await page.waitForFunction(() => window.__serverTest.calls.some(x => x.command === 'server_search_addons' && x.args.mcVersion === '1.21.4' && x.args.category === '' && x.args.sort === 'updated'));
    const initial = await page.evaluate(() => window.__serverTest.calls.find(c => c.command === 'server_search_addons'));
    assert.equal(initial.args.query, '', 'server catalog loads without search input');
    assert.equal(initial.args.mcVersion, '1.21.4');
    assert.equal(initial.args.loader, 'paper');
    assert.equal(initial.args.projectType, 'plugin');
    await page.locator('#server-download-query').fill('LuckPerms');
    await page.locator('#server-download-search').click();
    await page.waitForSelector('.server-download-card');
    await page.locator('[data-server-download-load]').click();
    await page.waitForSelector('[data-server-download-install]');
    await page.locator('[data-server-download-install]').click();
    await page.waitForFunction(() => window.__serverTest.calls.some((item) => item.command === 'server_install_catalog_addon'));
    const downloadCall = await page.evaluate(() => window.__serverTest.calls.find((item) => item.command === 'server_install_catalog_addon'));
    assert.equal(downloadCall.args.req.project_id, 'luckperms');
    assert.equal(downloadCall.args.req.filename, 'LuckPerms.jar');
    assert.equal(downloadCall.args.req.project_type, 'plugin');
    assert.equal(downloadCall.args.req.loader, 'paper');
    await page.evaluate(() => {
      const state = window.omnispecDebug.state;
      const meta = state.instances.find(x => x.id === 'srv');
      meta.server = { ...meta.server, kernel: 'fabric', mc_version: '1.20.1' };
    });
    await page.locator('[data-tab="server"]').click();
    await page.locator('[data-tab="download"]').click();
    await page.waitForFunction(() => window.__serverTest.calls.some(c => c.command === 'server_search_addons' && c.args.projectType === 'mod' && c.args.loader === 'fabric' && c.args.mcVersion === '1.20.1' && c.args.query === ''));
    await page.evaluate(() => { const meta = window.omnispecDebug.state.instances.find(x => x.id === 'srv'); meta.server = {...meta.server, kernel:'paper', mc_version:'1.21.4'}; });
    await page.locator('[data-tab="server"]').click();
    await page.waitForSelector('.server-overview-hero');
    await page.locator('[data-server-action="kill"]').click();
    await page.locator('#modal-confirm:not([hidden]) #confirm-ok').click();
    await page.waitForFunction(() => window.__serverTest.calls.some((item) => item.command === 'server_kill'));
    await page.waitForFunction(() => window.omnispecDebug.state.running.has('srv') === false);
    await page.locator('[data-tab="files"]').click();
    await page.waitForSelector('.fm-list');
    await page.waitForFunction(() => window.__serverTest.calls.some((item) => item.command === 'server_files'));
    assert.equal(await page.evaluate(() => window.__serverTest.calls.some((item) => item.command === 'list_dir')), false, 'server files use the guarded server_files endpoint');
    const listBox = await page.locator('#fm-list').boundingBox();
    await page.evaluate(({x,y}) => window.__serverTest.events['tauri://drag-drop']({payload:{paths:['/tmp/settings.json','/tmp/my-world'],position:{x,y}}}), {x:listBox.x+listBox.width-20,y:listBox.y+listBox.height-20});
    await page.waitForFunction(() => window.__serverTest.calls.filter(x => x.command === 'fm_import').length === 2);
    const imported = await page.evaluate(() => window.__serverTest.calls.filter(x => x.command === 'fm_import').map(x => x.args));
    assert.deepEqual(imported.map(x => [x.paths[0],x.dir]), [['/tmp/settings.json',''],['/tmp/my-world','']]);
    const folder = await page.locator('.fm-item[data-path="plugins"]').boundingBox();
    await page.evaluate(({x,y}) => window.__serverTest.events['tauri://drag-drop']({payload:{paths:['/tmp/Extra.jar'],position:{x,y}}}), {x:folder.x+folder.width/2,y:folder.y+folder.height/2});
    await page.waitForFunction(() => window.__serverTest.calls.some(x => x.command === 'fm_import' && x.args.dir === 'plugins'));


    await page.locator('[data-tab="backups"]').click();
    await page.waitForSelector('#backup-create');
    await page.locator('#backup-create').click();
    await page.waitForFunction(() => window.__serverTest.calls.some((item) => item.command === 'server_backup_create'));
    await page.evaluate(() => { const meta = window.omnispecDebug.state.instances.find(x => x.id === 'srv'); meta.is_server = false; meta.kind = 'instance'; delete meta.server; });
    await page.locator('[data-tab="files"]').click();
    await page.waitForSelector('.fm-item[data-path="config"]');
    const gameFolder = await page.locator('.fm-item[data-path="config"]').boundingBox();
    await page.evaluate(({x,y}) => window.__serverTest.events['tauri://drag-drop']({payload:{paths:['/tmp/game-settings.json'],position:{x,y}}}), {x:gameFolder.x+gameFolder.width/2,y:gameFolder.y+gameFolder.height/2});
    await page.waitForFunction(() => window.__serverTest.calls.some(x => x.command === 'fm_import' && x.args.paths[0] === '/tmp/game-settings.json' && x.args.dir === 'config'));
    assert.deepEqual(errors, []);
    console.log('SERVER_UI: EULA, sticky running category, server controls, guarded files, ZIP backup and Modrinth plugin flow — OK');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); server.close(); process.exitCode = 1; });
