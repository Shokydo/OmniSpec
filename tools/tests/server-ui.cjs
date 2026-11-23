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
    page.on('dialog', (dialog) => dialog.accept());
    await page.addInitScript(() => {
      const test = window.__serverTest = {
        calls: [],
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
            case 'server_files': return [{name: 'plugins', path: 'plugins', size: 0, modified: 1700000000, kind: 'directory'}, {name: 'server.properties', path: 'server.properties', size: 64, modified: 1700000000, kind: 'config'}];
            case 'server_get': return {...this.instance.server, stop_command: 'stop', tps_command: 'tps', jar: 'paper.jar'};
            case 'server_save': this.instance.server = {...args.config}; return this.instance.server;
            case 'server_set_eula': this.eula = Boolean(args.accepted); return null;
            case 'server_write_icon': return null;
            case 'server_start': this.running = [{instance_id: 'srv', run_id: 'srv#server', account: 'server', started_at: 1700000000}]; return {instance_id: 'srv', run_id: 'srv#server', pid: 42, started_at: 1700000000};
            case 'server_stop': this.running = []; return null;
            case 'server_kill': this.running = []; return null;
            case 'server_command': return null;
            case 'server_backup_list': return this.backups.map((item) => ({...item}));
            case 'server_backup_create': { const item = {name: 'manual_1.zip', path: '/test/backups/manual_1.zip', size: 123, created: 1700000000}; this.backups.push(item); return item; }
            case 'server_backup_restore': return null;
            case 'server_backup_delete': this.backups = this.backups.filter((item) => item.name !== args.name); return null;
            case 'search_modrinth': return {hits: [], total_hits: 0};
            case 'server_search_addons': return {hits: [{project_id: 'luckperms', title: 'LuckPerms', description: 'Permissions plugin', downloads: 12345}], total_hits: 1};
            case 'server_addon_versions': return [{id: 'luck-v1', project_id: 'luckperms', name: '5.4.0', version_number: '5.4.0', game_versions: ['1.21.4'], loaders: [], files: [{url: 'https://cdn.example.test/LuckPerms.jar', filename: 'LuckPerms.jar', primary: true, size: 40, hashes: {sha1: '0123456789abcdef0123456789abcdef01234567'}}]}];
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
        event: {listen: async () => () => {}}
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
    assert.equal(await page.locator('#server-eula').count(), 1, 'new/imported servers expose an EULA action');
    await page.locator('#server-eula').click();
    await page.waitForFunction(() => window.__serverTest.eula === true);
    await page.waitForFunction(() => document.querySelector('#server-eula') === null);
    await page.locator('#btn-play').click();
    await page.waitForFunction(() => window.__serverTest.calls.some((item) => item.command === 'server_start'));
    await page.waitForFunction(() => window.omnispecDebug.state.running.has('srv'));
    const groupOrder = await page.locator('#instance-list > .cat').evaluateAll((groups) => groups.map((group) => group.dataset.cat));
    assert.equal(groupOrder[0], '__running', 'running servers stay in the pinned category');
    assert.equal(await page.locator('#instance-list > .cat.cat-running').count(), 1, 'running category has sticky marker');
    await page.locator('[data-tab="server"]').click();
    await page.waitForSelector('.server-overview-hero');
    assert.equal(await page.locator('[data-server-action="start"]').count(), 1);
    assert.equal(await page.locator('[data-server-action="restart"]').count(), 1);
    assert.equal(await page.locator('[data-server-action="stop"]').count(), 1);
    assert.equal(await page.locator('[data-server-action="kill"]').count(), 1);
    await page.locator('[data-tab="download"]').click();
    await page.waitForSelector('#server-download-query');
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
    await page.locator('[data-tab="server"]').click();
    await page.waitForSelector('.server-overview-hero');
    await page.locator('[data-server-action="kill"]').click();
    await page.waitForFunction(() => window.__serverTest.calls.some((item) => item.command === 'server_kill'));
    await page.waitForFunction(() => window.omnispecDebug.state.running.has('srv') === false);
    await page.locator('[data-tab="files"]').click();
    await page.waitForSelector('.fm-list');
    await page.waitForFunction(() => window.__serverTest.calls.some((item) => item.command === 'server_files'));
    assert.equal(await page.evaluate(() => window.__serverTest.calls.some((item) => item.command === 'list_dir')), false, 'server files use the guarded server_files endpoint');
    await page.locator('[data-tab="backups"]').click();
    await page.waitForSelector('#backup-create');
    await page.locator('#backup-create').click();
    await page.waitForFunction(() => window.__serverTest.calls.some((item) => item.command === 'server_backup_create'));
    assert.deepEqual(errors, []);
    console.log('SERVER_UI: EULA, sticky running category, server controls, guarded files, ZIP backup and Modrinth plugin flow — OK');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); server.close(); process.exitCode = 1; });
