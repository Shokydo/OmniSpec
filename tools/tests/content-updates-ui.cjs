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
    const data = fs.readFileSync(file);
    const type = ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type}).end(data);
  } catch { res.writeHead(404).end(); }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1280, height: 800}});
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      const now = Math.floor(Date.now() / 1000);
      const instance = {
        id: 'pack', name: 'Тестовая сборка', mc_version: '1.21.1',
        loader: {type: 'fabric', version: '0.16.0'}, created: now,
        playtime_secs: 0, icon: null
      };
      const callbacks = {};
      const content = [
        {filename: 'alpha.jar', name: 'alpha.jar', title: 'Alpha', version_number: '1.0', enabled: true, size: 100},
        {filename: 'beta.jar', name: 'beta.jar', title: 'Beta', version_number: '1.0', enabled: false, size: 100},
        {filename: 'gamma.jar', name: 'gamma.jar', title: 'Gamma', version_number: '1.0', enabled: true, size: 100}
      ];
      const update = (filename, title) => ({
        filename, kind: 'mod', enabled: filename !== 'beta.jar', title,
        page_url: `https://modrinth.com/mod/${filename}`,
        project_id: 'AANobbMI', version_id: `new-${filename}`,
        current: '1.0', latest: '2.0', download_url: `https://example.test/${filename}`,
        new_filename: filename.replace('.jar', '-2.jar'), size: 20
      });
      const updates = [update('alpha.jar', 'Alpha'), update('beta.jar', 'Beta'), update('gamma.jar', 'Gamma')];
      const mock = window.__contentUpdatesTest = {
        callbacks, calls: [], compatibilityPending: [], updatePending: {}, updateStarted: [],
        instances: [instance], content,
        emit(name, payload) {
          if (!callbacks[name]) throw new Error(`Нет обработчика ${name}`);
          callbacks[name]({payload});
        },
        resolveCompatibility(report = {checked: 3, compatible: 3, updates, incompatible: []}) {
          const pending = this.compatibilityPending.shift();
          if (!pending) throw new Error('Нет ожидающей проверки совместимости');
          pending.resolve(report);
        },
        resolveUpdate(filename) {
          const pending = this.updatePending[filename];
          if (!pending) throw new Error(`Нет ожидающего обновления ${filename}`);
          delete this.updatePending[filename];
          pending.resolve({filename});
        },
        rejectUpdate(filename, message = 'ошибка обновления') {
          const pending = this.updatePending[filename];
          if (!pending) throw new Error(`Нет ожидающего обновления ${filename}`);
          delete this.updatePending[filename];
          pending.reject(new Error(message));
        },
        async invoke(command, args = {}) {
          this.calls.push({command, args});
          switch (command) {
            case 'get_settings':
              return {theme:'dark', click_fx:'off', ambient:'off', trail:false, onboarded:true,
                discord_rpc:false, update_enabled:false, show_snapshots:false, memory_mb:4096};
            case 'accounts_info': return {accounts:[{uuid:'u', username:'Steve', kind:'offline'}], active:'u'};
            case 'list_instances': return this.instances.map(item => ({...item}));
            case 'running_instances': return [];
            case 'custom_wallpaper': case 'startup_file': case 'set_presence':
            case 'resolve_presence_icon': case 'instance_icon': return null;
            case 'app_info': return {home:'/test', version:'test', platform:'test', demo:false};
            case 'version_info': return {version:'test', enabled:false};
            case 'list_java': return [];
            case 'content_list': return this.content.map(item => ({...item}));
            case 'mod_icons': return {};
            case 'content_compatibility': {
              const callNumber = this.calls.filter(item => item.command === command).length;
              return new Promise((resolve, reject) => {
                this.compatibilityPending.push({resolve, reject, callNumber, args});
                this.emit('progress', {
                  instance: args.instanceId, stage: 'check', done: 1, total: 3,
                  detail: 'проверяем файл', state: 'active', op: args.opId || ''
                });
              });
            }
            case 'content_update': {
              const filename = args.name;
              this.updateStarted.push(filename);
              this.emit('progress', {
                instance: args.instanceId, stage: 'update', done: 0, total: 0,
                detail: `обновляем ${filename}`, state: 'active', op: args.opId || ''
              });
              return new Promise((resolve, reject) => {
                this.updatePending[filename] = {resolve, reject, args};
              });
            }
            case 'minecraft_versions': return [
              {id:'1.21.1', type:'release'}, {id:'1.20.1', type:'release'}
            ];
            case 'loader_versions': return [{version:'0.16.0', stable:true}];
            case 'update_instance':
              this.instances = this.instances.map(item => item.id === args.meta.id ? {...args.meta} : item);
              return null;
            case 'open_path': return null;
            default: return null;
          }
        }
      };
      window.__TAURI__ = {
        core: {invoke: (command, args) => mock.invoke(command, args)},
        event: {listen: async (name, callback) => { callbacks[name] = callback; return () => delete callbacks[name]; }}
      };
    });

    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('[data-home-id="pack"]');
    await page.locator('[data-home-id="pack"]').click();
    await page.locator('[data-tab="mods"]').click();
    await page.waitForSelector('#content-check');

    const badge = page.locator('.content-count');
    assert.equal((await badge.innerText()).trim(), '2 вкл.');
    assert(!(await badge.innerText()).includes('/'), 'счётчик не должен показывать total');
    assert.equal(await badge.evaluate(element => getComputedStyle(element).whiteSpace), 'nowrap');

    await page.locator('#content-check').click();
    await page.waitForFunction(() => window.__contentUpdatesTest.calls.some(item => item.command === 'content_compatibility'));
    assert(await page.locator('#content-check').isDisabled(), 'повторная проверка блокируется');
    assert.equal(await page.locator('#dl-title').innerText(), 'Проверяем…');
    assert.equal(await page.locator('#dl-total-text').innerText(), '1/3 файлов');
    const compatibilityCall = await page.evaluate(() => window.__contentUpdatesTest.calls.find(item => item.command === 'content_compatibility'));
    assert.equal(compatibilityCall.args.mcVersion, '1.21.1');
    assert.deepEqual(compatibilityCall.args.loader, {type:'fabric', version:'0.16.0'});

    await page.evaluate(() => window.__contentUpdatesTest.resolveCompatibility());
    await page.waitForSelector('#modal-updates-list:not([hidden])');
    assert.equal(await page.locator('#upd-list-body [data-upd]').count(), 3);
    assert(!(await page.locator('#upd-list-all').isDisabled()), 'после проверки массовое обновление доступно');

    await page.locator('#upd-list-all').click();
    await page.waitForSelector('#modal-confirm:not([hidden])');
    assert.equal(await page.evaluate(() => window.__contentUpdatesTest.updateStarted.length), 0, 'обновление начинается только после подтверждения');
    await page.locator('#confirm-ok').click();
    await page.waitForFunction(() => window.__contentUpdatesTest.updateStarted.length === 1);
    assert.equal(await page.locator('#upd-list-all').isDisabled(), true, 'повторный запуск блокируется');
    assert.deepEqual(await page.evaluate(() => window.__contentUpdatesTest.updateStarted), ['alpha.jar']);
    await page.evaluate(() => window.__contentUpdatesTest.resolveUpdate('alpha.jar'));
    await page.waitForFunction(() => window.__contentUpdatesTest.updateStarted.length === 2);
    assert.deepEqual(await page.evaluate(() => window.__contentUpdatesTest.updateStarted), ['alpha.jar', 'beta.jar']);
    await page.evaluate(() => window.__contentUpdatesTest.rejectUpdate('beta.jar', 'Beta: файл занят'));
    await page.waitForFunction(() => window.__contentUpdatesTest.updateStarted.length === 3);
    assert.deepEqual(await page.evaluate(() => window.__contentUpdatesTest.updateStarted), ['alpha.jar', 'beta.jar', 'gamma.jar']);
    await page.evaluate(() => window.__contentUpdatesTest.resolveUpdate('gamma.jar'));
    await page.waitForFunction(() => window.omnispecDebug.state.contentTask === null);
    await page.waitForSelector('#modal-updates-list:not([hidden])');
    assert.equal(await page.locator('#upd-list-body [data-upd]').count(), 1, 'ошибочный файл остаётся в списке');
    assert.equal(await page.locator('#upd-list-body [data-upd]').getAttribute('data-upd'), 'beta.jar');
    assert.match(await page.locator('#upd-list-body').innerText(), /Beta: файл занят/);
    assert(!(await page.locator('#upd-list-all').isDisabled()), 'после частичного сбоя повтор разрешён');
    assert.equal(await page.locator('#upd-list-body [data-upd-one]').count(), 1);
    assert.equal(await page.evaluate(() => window.omnispecDebug.state.contentUpdates.mod.length), 1);
    assert((await page.locator('.toast').allTextContents()).some(text => /ошибок: 1/.test(text)), 'частичный сбой объявляется ошибкой');
    assert(!(await page.locator('.toast').allTextContents()).some(text => text === 'Обновления установлены'), 'нет ложного общего успеха');

    await page.locator('#modal-updates-list [data-close-upd-list]').first().click();
    await page.locator('[data-tab="settings"]').click();
    await page.waitForSelector('#inst-change-version');
    await page.locator('#inst-change-version').click();
    await page.waitForSelector('#modal-mcver:not([hidden])');
    await page.locator('[data-mcver-mc="1.20.1"]').click();
    await page.waitForSelector('[data-mcver-loader-version="0.16.0"]');
    await page.locator('#mcver-apply').click();
    await page.waitForSelector('#modal-confirm:not([hidden])');
    assert.equal(await page.evaluate(() => window.__contentUpdatesTest.calls.filter(item => item.command === 'content_compatibility').length), 1, 'до подтверждения preflight не запускается');
    await page.locator('#confirm-ok').click();
    await page.waitForFunction(() => window.__contentUpdatesTest.calls.filter(item => item.command === 'content_compatibility').length === 2);
    assert.equal(await page.locator('#dl-title').innerText(), 'Проверяем…');
    const versionCheck = await page.evaluate(() => window.__contentUpdatesTest.calls.filter(item => item.command === 'content_compatibility').at(-1));
    assert.equal(versionCheck.args.mcVersion, '1.20.1', 'передан выбранный target Minecraft');
    assert.deepEqual(versionCheck.args.loader, {type:'fabric', version:'0.16.0'}, 'передан выбранный loader');
    await page.evaluate(() => window.__contentUpdatesTest.resolveCompatibility({checked:3, compatible:0, updates:[], incompatible:[{filename:'beta.jar', reason:'нет версии'}]}));
    await page.waitForFunction(() => window.__contentUpdatesTest.calls.some(item => item.command === 'update_instance'));
    const versionWrite = await page.evaluate(() => window.__contentUpdatesTest.calls.find(item => item.command === 'update_instance'));
    assert.equal(versionWrite.args.meta.mc_version, '1.20.1');
    assert.deepEqual(versionWrite.args.meta.loader, {type:'fabric', version:'0.16.0'});
    assert.equal(await page.evaluate(() => window.__contentUpdatesTest.calls.filter(item => ['content_delete','delete_instance'].includes(item.command)).length), 0);
    await page.waitForFunction(() => window.omnispecDebug.state.progress === null);
    assert.notEqual(await page.locator('#dl-title').innerText(), 'Проверяем…');
    await page.waitForTimeout(3200);
    assert(await page.locator('#dl-panel').isHidden(), 'после проверки правая панель возвращается в обычное состояние');

    assert.deepEqual(errors, []);
    console.log('CONTENT_UPDATES_UI: enabled badge, sequential batch, partial errors, retry lock, target/confirmation/preflight/progress — OK');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
