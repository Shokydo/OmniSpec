// Начальная вкладка, реальные пределы ОЗУ, длинное ПКМ-меню и resize частиц.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try {
    const type = ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':type}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function openPage(browser) {
  const page = await browser.newPage({ viewport:{width:1280,height:800} });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    const now = Math.floor(Date.now() / 1000);
    const defaults = {
      theme:'dark', click_fx:'off', ambient:'snow', ambient_density:100,
      trail:false, trail_style:'sparks', trail_size:50, trail_length:20, trail_opacity:15,
      onboarded:true, discord_rpc:false, update_enabled:false, ui_scale:100, memory_mb:32768,
      categories:[]
    };
    const saved = localStorage.getItem('instance-prefs-settings');
    const mock = window.__instancePrefsTest = {
      settings:saved ? JSON.parse(saved) : defaults,
      memory:{total_mb:16384}, calls:[], held:[], holdRule:null, picked:[], imported:[],
      holdNextSave:false, failNextSave:false, pendingSettings:[],
      instances:[
        {id:'alpha',name:'Alpha',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16'},created:now,playtime_secs:0,icon:null,memory_mb:32768},
        {id:'beta',name:'Beta',mc_version:'1.20.1',loader:{type:'forge',version:'47'},created:now,playtime_secs:0,icon:null,memory_mb:null}
      ],
      hold(command, instanceId, sub = null) { this.holdRule={command,instanceId,sub}; },
      release() {
        const item = this.held.shift();
        if (!item) throw new Error('Нет ожидающего ответа');
        item.resolve(item.response);
      },
      async invoke(command,args={}) {
        this.calls.push({command,args});
        switch (command) {
          case 'get_settings': return {...this.settings};
          case 'save_settings': {
            if (this.holdNextSave) {
              this.holdNextSave=false;
              return new Promise((resolve,reject) => this.pendingSettings.push({resolve,reject}));
            }
            if (this.failNextSave) { this.failNextSave=false; throw new Error('тестовый сбой записи'); }
            this.settings=JSON.parse(JSON.stringify(args.settings));
            localStorage.setItem('instance-prefs-settings',JSON.stringify(this.settings));
            return null;
          }
          case 'pick_files': return this.picked;
          case 'import_mod_file': if (args.path.includes('duplicate')) throw new Error('уже существует'); this.imported.push({instanceId:args.instanceId,path:args.path}); return args.path.split('/').pop();
          case 'create_instance': { const item={...args.req,id:'created',created:now,playtime_secs:0}; this.instances.push(item); return item; }
          case 'system_memory': return this.memory;
          case 'accounts_info': return {accounts:[{uuid:'u',username:'Steve',kind:'offline'}],active:'u'};
          case 'list_instances': return this.instances.map(item => ({...item}));
          case 'update_instance': this.instances=this.instances.map(item => item.id === args.meta.id ? {...args.meta} : item); return args.meta;
          case 'running_instances': return [];
          case 'launch_instance': throw new Error('тестовый запуск без игры');
          case 'instance_path': return `/data/${args.instanceId}`;
          case 'catalog_installed_mods': return [];
          case 'list_java': {
            const instanceId=window.omnispecDebug?.state.selectedId;
            if (this.holdRule?.command === command && this.holdRule.instanceId === instanceId) {
              this.holdRule=null;
              return new Promise(resolve => this.held.push({resolve,response:[{major:17,path:'/stale/java'}]}));
            }
            return [];
          }
          case 'content_list': {
            const instanceId=args.instanceId, kind=args.kind;
            if (this.holdRule?.command === command && this.holdRule.instanceId === instanceId && this.holdRule.sub === kind) {
              this.holdRule=null;
              return new Promise(resolve => this.held.push({resolve,response:[{filename:'STALE_CONTENT.jar',name:'STALE_CONTENT.jar',enabled:true,size:1}]}));
            }
            const filename=`${instanceId}-${kind}.jar`;
            return [{filename,name:filename,enabled:true,size:1}, ...this.imported.filter(x=>kind==='mod' && x.instanceId===instanceId).map(x=>({filename:x.path.split('/').pop(),enabled:true,size:1}))];
          }
          case 'mod_icons': {
            if (this.holdRule?.command === command && this.holdRule.instanceId === args.instanceId) {
              this.holdRule=null;
              return new Promise(resolve => this.held.push({resolve,response:{'STALE_ICON.jar':'data:image/png;base64,AA=='}}));
            }
            return {};
          }
          case 'world_icons': return {};
          case 'list_dir': case 'list_screenshots': {
            const instanceId=args.instanceId;
            const response = command === 'list_screenshots' ? [] : args.sub === 'saves' ? [] : [
              {name:`${instanceId}.txt`,path:`${instanceId}.txt`,is_dir:false,size:5,modified:1}
            ];
            if (this.holdRule && this.holdRule.command === command && this.holdRule.instanceId === instanceId
                && (this.holdRule.sub === null || this.holdRule.sub === args.sub)) {
              this.holdRule=null;
              const oldResponse = command === 'list_screenshots'
                ? [{name:'OLD_SCREEN.png',path:'OLD_SCREEN.png'}]
                : args.sub === 'saves' ? [{name:'OLD_WORLD',path:'OLD_WORLD',is_dir:true,size:0}]
                : [{name:'alpha.txt',path:'alpha.txt',is_dir:false,size:5,modified:1}];
              return new Promise(resolve => this.held.push({resolve,response:oldResponse}));
            }
            return response;
          }
          case 'search_modrinth': case 'search_curseforge': return {hits:[],total_hits:0};
          case 'minecraft_versions': return [{id:'1.21.1',type:'release'}];
          case 'loader_versions': return [{version:'0.16.1',stable:true}];
          case 'app_info': return {home:'/data',version:'test',platform:'test',demo:false};
          case 'version_info': return {version:'test',enabled:false};
          default: return null;
        }
      }
    };
    window.__TAURI__={core:{invoke:(command,args) => mock.invoke(command,args)},event:{listen:async () => () => {}}};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('[data-home-id="alpha"]');
  return {page,errors};
}

async function prefs(page, category='look') {
  if (await page.locator('#modal-prefs').isHidden()) await page.locator('#btn-quick-settings').click();
  await page.locator(`[data-pref="${category}"]`).click();
}
async function closePrefs(page) { await page.locator('#modal-prefs [data-close-prefs]').click(); }
async function chooseInitial(page, id) {
  await prefs(page,'look');
  await page.locator('#prefs-initial-tab').click();
  assert(await page.locator('#modal-initial-tab [role="dialog"]').isVisible());
  await page.locator(`[data-initial-tab="${id}"]`).click();
  await page.waitForFunction(id => window.__instancePrefsTest.settings.initial_tab === id,id);
  assert(await page.locator('#modal-initial-tab').isHidden());
  assert(!(await page.locator('#modal-prefs').isHidden()));
  await closePrefs(page);
}
async function selectHome(page, id) {
  await page.locator('#btn-home').click();
  await page.waitForSelector(`[data-home-id="${id}"]`);
  await page.locator(`[data-home-id="${id}"]`).click();
}
async function activeTab(page, id, instance) {
  await page.waitForFunction(({id,instance}) => window.omnispecDebug.state.tab === id && window.omnispecDebug.state.selectedId === instance,{id,instance});
  assert(await page.locator(`[data-tab="${id}"]`).evaluate(el => el.classList.contains('is-active')));
}
async function setRange(page, selector, value) {
  await page.locator(selector).evaluate((el,value) => {
    el.value=String(value);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
  }, value);
}

(async () => {
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({headless:true});
 try {
  const {page,errors}=await openPage(browser);
  await page.locator('#btn-new-build').click();
  await page.waitForSelector('#c-icon-palette');
  await page.locator('#c-icon-palette [data-icon-background="#3b82f6"]').click();
  await page.locator('#c-icons [data-icon="i-star"]').click();
  assert.equal(await page.locator('#c-icon-preview').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(59, 130, 246)');
  assert.equal(await page.locator('#c-icon-preview svg use').getAttribute('href'),'#i-star');
  await page.locator('#create-submit').click();
  await page.waitForFunction(()=>window.__instancePrefsTest.calls.some(c=>c.command==='create_instance'));
  const request=await page.evaluate(()=>window.__instancePrefsTest.calls.find(c=>c.command==='create_instance').args.req);
  assert.equal(request.icon,'i-star'); assert.equal(request.icon_background,'#3b82f6');
  await page.waitForSelector('.instance[data-id="created"]');
  assert.equal(await page.locator('.instance[data-id="created"] .instance-icon').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(59, 130, 246)');
  await page.locator('.instance[data-id="alpha"]').click();
  await page.locator('[data-tab="settings"]').click();
  await page.locator('#inst-icon-palette [data-icon-background="#e65757"]').click();
  await page.locator('#inst-icon-color').evaluate(el => { el.value='#123456'; el.dispatchEvent(new Event('change',{bubbles:true})); });
  assert.equal(await page.locator('#inst-icon-preview').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(18, 52, 86)');
  await page.locator('#inst-icon-palette [data-icon-background="#e65757"]').click();
  await page.locator('#inst-icons [data-icon="i-cube"]').click();
  await page.locator('#inst-save').click();
  await page.waitForFunction(()=>window.__instancePrefsTest.instances.find(x=>x.id==='alpha').icon_background === '#e65757');
  assert.equal(await page.locator('.instance[data-id="alpha"] .instance-icon').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(230, 87, 87)');
  await page.locator('[data-tab="mods"]').click();
  await page.waitForSelector('#content-import');
  const widths=await page.evaluate(()=>({search:document.querySelector('#content-query').getBoundingClientRect().width,header:document.querySelector('.content-panel-head').clientWidth}));
  assert(widths.search > 220, `search should stretch: ${JSON.stringify(widths)}`);
  await page.evaluate(()=>window.__instancePrefsTest.picked=['/tmp/ok.jar','/tmp/duplicate.jar']);
  await page.locator('#content-import').click();
  await page.waitForFunction(()=>window.__instancePrefsTest.imported.length===1);
  await page.waitForSelector('[data-content="ok.jar"]');
  assert((await page.locator('#toasts').innerText()).includes('уже существует'));
  await page.evaluate(()=>window.__instancePrefsTest.picked=[]);
  await page.locator('#content-import').click();
  assert.equal(await page.evaluate(()=>window.__instancePrefsTest.imported.length),1, 'cancel does not import');
  await page.setViewportSize({width:800,height:600});
  const bad=await page.locator('.content-panel-head').evaluate(el=>{const r=el.getBoundingClientRect();return [...el.children].filter(x=>{let q=x.getBoundingClientRect();return q.right>r.right+1 || q.left<r.left-1}).map(x=>x.id)});
  assert.deepEqual(bad,[], 'toolbar does not overflow');
  assert.deepEqual(errors,[]);
  console.log('ICON_AND_MOD_IMPORT: create/edit icon, import, duplicates, responsive search — OK');
 } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exit(1)});
