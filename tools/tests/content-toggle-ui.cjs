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
        {filename: 'beta.jar', name: 'beta.jar.disabled', title: 'Beta', version_number: '1.0', enabled: false, size: 100},
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
            case 'content_toggle': {
              await new Promise(resolve=>setTimeout(resolve,100));
              const item=this.content.find(i=>i.name===args.name); if(!item)throw new Error('file not found: '+args.name);
              item.enabled=!item.enabled;item.name=item.enabled?item.filename:item.filename+'.disabled';return item.name;
            }
            case 'content_delete': {const i=this.content.findIndex(item=>item.name===args.name);if(i<0)throw new Error('file not found');this.content.splice(i,1);return null;}
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

    const row=page.locator('[data-content="alpha.jar"]');
    await row.locator('[data-toggle]').click();await page.waitForFunction(()=>window.__contentUpdatesTest.content[0].name==='alpha.jar.disabled');
    await page.waitForSelector('[data-content="alpha.jar"] [data-toggle="alpha.jar.disabled"]');
    await row.locator('[data-toggle]').click();await page.waitForFunction(()=>window.__contentUpdatesTest.content[0].name==='alpha.jar');
    await page.waitForSelector('[data-content="alpha.jar"] [data-toggle="alpha.jar"]');
    const before=await page.evaluate(()=>window.__contentUpdatesTest.calls.filter(c=>c.command==='content_toggle').length);
    await row.locator('[data-toggle]').evaluate(el=>{el.click();el.click();el.click()});
    await page.waitForFunction(n=>window.__contentUpdatesTest.calls.filter(c=>c.command==='content_toggle').length===n+1,before);
    await page.waitForSelector('[data-content="alpha.jar"] [data-toggle="alpha.jar.disabled"]');
    await row.click({button:'right'});await page.locator('[data-act="toggle"]').click();
    await page.waitForSelector('[data-content="alpha.jar"] [data-toggle="alpha.jar"]');
    assert.deepEqual(await page.evaluate(()=>window.__contentUpdatesTest.calls.filter(c=>c.command==='content_toggle').map(c=>c.args.name)),['alpha.jar','alpha.jar.disabled','alpha.jar','alpha.jar.disabled']);
    await page.locator('[data-content="beta.jar"] [data-delete]').click();await page.locator('#confirm-ok').click();
    await page.waitForFunction(()=>window.__contentUpdatesTest.calls.some(c=>c.command==='content_delete'));
    assert.equal(await page.evaluate(()=>window.__contentUpdatesTest.calls.find(c=>c.command==='content_delete').args.name),'beta.jar.disabled');
    assert.deepEqual(errors,[]);console.log('CONTENT_TOGGLE_REAL_FILENAME_ROUND_TRIP_RACE_AND_DELETE_OK');
  } finally { await browser.close(); server.close(); }
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
