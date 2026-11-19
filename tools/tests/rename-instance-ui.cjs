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
    const type = ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':type}); res.end(data);
  } catch { res.writeHead(404).end(); }
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1280,height:800}});
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      const base = {id:'old',name:'Моя сборка',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16.0'},created:1,playtime_secs:0,icon:null};
      const callbacks = {};
      const mock = window.__renameTest = {
        instances:[base], running:[], calls:[], block:false, failRunning:false, callbacks,
        rename(from,to) {
          this.instances = this.instances.map(item => item.id === from ? {...item,id:to,renamed_from:from,renamed_froms:[...(item.renamed_froms || []),from]} : item);
        },
        async invoke(command,args={}) {
          this.calls.push({command,args});
          switch (command) {
            case 'get_settings': return {theme:'dark',click_fx:'off',ambient:'off',trail:false,onboarded:true,discord_rpc:false,update_enabled:false,last_instance:'old'};
            case 'save_settings': return null;
            case 'accounts_info': return {accounts:[{uuid:'u',username:'Steve',kind:'offline'}],active:'u'};
            case 'list_instances': {
              if (this.block) throw 'Папка переименована во время работы. Останови игру и обнови список';
              return this.instances.map(item => ({...item}));
            }
            case 'acknowledge_instance_renames': {
              for (const {id,previousIds} of args.acknowledgements) {
                this.instances = this.instances.map(item => item.id === id ? {...item,renamed_from:undefined,renamed_froms:(item.renamed_froms || []).filter(x => !previousIds.includes(x))} : item);
              }
              return null;
            }
            case 'running_instances': if (this.failRunning) throw 'running unavailable'; return [...this.running];
            case 'instance_path': return `/data/instances/${args.instanceId}`;
            case 'custom_wallpaper': case 'startup_file': case 'set_presence': case 'resolve_presence_icon': case 'instance_icon': return null;
            case 'version_info': return {version:'test',enabled:false};
            case 'list_java': case 'catalog_current_mods': case 'content_list': return [];
            case 'search_modrinth': case 'search_curseforge': return {hits:[],total_hits:0};
            case 'launch_instance': {
              this.running = [args.instanceId];
              return {instance_id:args.instanceId,run_id:`${args.instanceId}#1`,java:'java',java_major:21,account:'Steve'};
            }
            case 'stop_instance': this.running=[]; return null;
            case 'open_path': return null;
            default: return null;
          }
        }
      };
      window.__TAURI__ = {
        core: {invoke:(command,args) => mock.invoke(command,args)},
        event: {listen:async (name,callback) => {callbacks[name]=callback; return () => delete callbacks[name];}}
      };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('[data-home-id="old"]');
    await page.locator('[data-home-id="old"]').click();
    await page.waitForFunction(() => window.omnispecDebug.state.selectedId === 'old');
    await page.waitForFunction(() => document.querySelector('#build-path span')?.textContent.includes('/old'));

    // A copied JSON does not steal the existing selection from the original.
    await page.evaluate(() => {
      const t=window.__renameTest;
      t.instances.push({...t.instances[0],id:'copy',renamed_from:'old',renamed_froms:['old']});
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForFunction(() => window.omnispecDebug.state.instances.some(x => x.id === 'copy'));
    assert.equal(await page.evaluate(() => window.omnispecDebug.state.selectedId),'old');
    await page.evaluate(() => {window.__renameTest.instances = window.__renameTest.instances.filter(x => x.id !== 'copy');});

    // External rename is found on returning from the file manager, without a ghost.
    await page.evaluate(() => {
      const t=window.__renameTest; t.failRunning=true;
      t.rename('old','intermediate'); t.rename('intermediate','Новая сборка #1');
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForFunction(() => window.omnispecDebug.state.selectedId === 'Новая сборка #1');
    await page.waitForFunction(() => window.__renameTest.calls.some(x => x.command === 'acknowledge_instance_renames' && x.args.acknowledgements.some(y => y.previousIds.includes('old') && y.previousIds.includes('intermediate'))));
    await page.evaluate(() => {window.__renameTest.failRunning=false;});
    await page.waitForFunction(() => document.querySelector('#build-path span')?.textContent.includes('Новая сборка #1'));
    assert.deepEqual(await page.evaluate(() => window.omnispecDebug.state.instances.map(x => x.id)),['Новая сборка #1']);
    assert.equal(await page.evaluate(() => window.omnispecDebug.state.settings.last_instance),'Новая сборка #1');
    await page.locator('#btn-folder').click();
    await page.waitForFunction(() => window.__renameTest.calls.some(x => x.command === 'open_path'));
    assert.equal(await page.evaluate(() => window.__renameTest.calls.filter(x => x.command === 'open_path').at(-1).args.path),'/instances/Новая сборка #1/minecraft');
    await page.locator('#btn-play').click();
    await page.waitForFunction(() => window.__renameTest.calls.some(x => x.command === 'launch_instance'));
    assert.equal(await page.evaluate(() => window.__renameTest.calls.find(x => x.command === 'launch_instance').args.instanceId),'Новая сборка #1');
    await page.waitForFunction(() => window.omnispecDebug.state.running.has('Новая сборка #1'));

    // While running, backend refuses to switch identities; stop still targets the old id.
    await page.evaluate(() => {window.__renameTest.block=true; window.dispatchEvent(new Event('focus'));});
    await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some(x => x.textContent.includes('Останови игру')));
    assert.equal(await page.evaluate(() => window.omnispecDebug.state.selectedId),'Новая сборка #1');
    assert(await page.evaluate(() => window.omnispecDebug.state.running.has('Новая сборка #1')));
    await page.locator('#btn-stop').click();
    await page.waitForFunction(() => window.__renameTest.calls.some(x => x.command === 'stop_instance'));
    assert.equal(await page.evaluate(() => window.__renameTest.calls.find(x => x.command === 'stop_instance').args.instanceId),'Новая сборка #1');
    await page.evaluate(() => {
      const t=window.__renameTest; t.block=false; t.rename('Новая сборка #1','после остановки');
      t.callbacks['game-exit']({payload:{instance:'Новая сборка #1',run_id:'Новая сборка #1#1',code:0,stopped:true}});
    });
    await page.waitForFunction(() => window.omnispecDebug.state.selectedId === 'после остановки');
    assert.deepEqual(await page.evaluate(() => window.omnispecDebug.state.instances.map(x => x.id)),['после остановки']);
    assert(await page.evaluate(() => !!window.omnispecDebug.state.logs['после остановки']));

    // Multiple directories claiming the previous id are ambiguous: do not guess.
    await page.evaluate(() => {
      const t=window.__renameTest, item=t.instances[0];
      t.instances=[{...item,id:'candidate-1',renamed_from:'после остановки',renamed_froms:['после остановки']},{...item,id:'candidate-2',renamed_from:'после остановки',renamed_froms:['после остановки']}];
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForFunction(() => window.omnispecDebug.state.selectedId === null);
    assert.equal(await page.locator('#tb-name').textContent(),'OmniSpec');
    assert.deepEqual(errors,[]);
    console.log('RENAME_UI: focus refresh, copy conflict, selected path, launch/stop, active guard, ambiguity — OK');
    await page.close();
  } finally { await browser.close(); server.close(); }
})().catch(error => {console.error(error); server.close(); process.exitCode=1;});
