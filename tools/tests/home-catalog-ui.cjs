const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try {
    const mime = ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':mime}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function newPage(browser, options = {}) {
  const page = await browser.newPage({ viewport:{width:1280,height:800} });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript((opts) => {
    const now = Math.floor(Date.now()/1000);
    let instances = opts.empty ? [] : [
      {id:'fabric-new',name:'Fabric 1.21',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16.0'},created:now,icon:null},
      {id:'forge-old',name:'Forge 1.20',mc_version:'1.20.1',loader:{type:'forge',version:'47.3.0'},created:now,icon:null},
      {id:'fabric-old',name:'Fabric 1.20',mc_version:'1.20.1',loader:{type:'fabric',version:'0.16.0'},created:now,icon:null},
      {id:'vanilla',name:'Без загрузчика',mc_version:'1.21.1',loader:{type:'vanilla'},created:now,icon:null}
    ];
    const callbacks = {};
    const image = n => ({title:`Картинка ${n}`,url:`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 24"><rect width="32" height="24" fill="rgb(${n * 20},80,100)"/></svg>`)}`});
    const mock = window.__homeTest = {
      calls:[], held:[], holdQueries:new Set(), failCompatibility:false, failVersions:false,
      heldLoaders:[], holdLoaderKey:'', callbacks,
      versions(projectId) { return [
        {id:'fabric-version',project_id:projectId,name:'Версия Fabric',version_number:'f1',game_versions:['1.21.1'],loaders:['fabric'],date_published:'2026-01-01'},
        {id:'forge-version',project_id:projectId,name:'Версия Forge',version_number:'g1',game_versions:['1.20.1'],loaders:['forge'],date_published:'2025-01-01'},
        {id:'no-metadata',project_id:projectId,name:'Без меток',version_number:'x',game_versions:['Client'],loaders:[],date_published:'2024-01-01'}
      ]; },
      search(command,args) {
        const cf = command === 'search_curseforge';
        const base = args.projectType === 'modpack' ? (cf ? 'cf-pack' : 'mr-pack') : (cf ? 'cf-mod' : 'mr-mod');
        const all = Array.from({length:30}, (_,i) => ({
          project_id:i ? `${base}-${i}` : base, slug:base, title:`${base} ${args.query || ''} ${i}`,
          description:'Описание', project_type:args.projectType, categories:[], downloads:100, icon_url:null
        }));
        const offset = Number(args.offset)||0, limit = Number(args.limit)||24;
        return {hits:all.slice(offset,offset+limit),offset,limit,total_hits:all.length};
      },
      releaseSearch(query) {
        for (const entry of this.held.filter(item => item.query === query)) entry.resolve(entry.result);
        this.held = this.held.filter(item => item.query !== query);
      },
      releaseLoader(key) {
        for (const entry of this.heldLoaders.filter(item => item.key === key)) entry.resolve(entry.result);
        this.heldLoaders = this.heldLoaders.filter(item => item.key !== key);
      },
      async invoke(command, args = {}) {
        this.calls.push({command,args:JSON.parse(JSON.stringify(args))});
        switch (command) {
          case 'get_settings': return {theme:'dark',click_fx:'off',ambient:'off',trail:false,onboarded:true,discord_rpc:false,update_enabled:false,feed_grid:2,feed_source:'modrinth',ui_scale:100};
          case 'save_settings': return null;
          case 'accounts_info': return {accounts:[{uuid:'u',username:'Steve',kind:'offline'}],active:'u'};
          case 'list_instances': return instances.map(item => ({...item}));
          case 'running_instances': return [];
          case 'system_memory': return {total_mb:16384};
          case 'version_info': return {version:'test',enabled:false};
          case 'list_java': return [];
          case 'minecraft_versions': return [
            {id:'1.21.1',type:'release'},{id:'1.20.1',type:'release'}, {id:'1.19.4',type:'release'}
          ];
          case 'loader_versions': {
            const key = `${args.kind}:${args.mcVersion}`;
            const result = [{version:`${args.kind}-${args.mcVersion}-stable`,stable:true},{version:'old',stable:false}];
            if (this.holdLoaderKey === key) return new Promise(resolve => this.heldLoaders.push({key,result,resolve}));
            return result;
          }
          case 'search_modrinth': case 'search_curseforge': {
            const result = this.search(command,args);
            const key = `${command}:${args.projectType}:${args.query}`;
            if (this.holdQueries.has(key)) return new Promise(resolve => this.held.push({query:args.query,result,resolve}));
            return result;
          }
          case 'modrinth_versions': case 'curseforge_versions': {
            if (this.failVersions) throw 'нет связи для проверки';
            let result = this.versions(args.projectId);
            if (args.mcVersion) result = result.filter(v => v.game_versions.includes(args.mcVersion));
            if (args.loader) result = result.filter(v => v.loaders.includes(args.loader));
            return result;
          }
          case 'curseforge_compatibility_versions':
            if (this.failCompatibility) throw 'нет данных CurseForge';
            return this.versions(args.projectId);
          case 'modrinth_project': case 'curseforge_project': {
            const pack = String(args.projectId).includes('pack');
            return {id:args.projectId,slug:args.projectId,title:`Проект ${args.projectId}`,project_type:pack?'modpack':'mod',description:'Сведения',body:'Описание сборки',categories:['adventure'],gallery:Array.from({length:8},(_,i)=>image(i+1)),downloads:123};
          }
          case 'install_mod_version': case 'install_mod': case 'install_curseforge': return this.installOutcome || {installed:['mod.jar'],skipped:[]};
          case 'install_curseforge_modpack': {
            const created = {id:'cf-created',name:'Готовая сборка CF',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16'},created:now};
            instances = [created,...instances]; return created;
          }
          case 'create_instance_for_mod': {
            const created = {id:`created-${instances.length}`,name:args.req.name,mc_version:args.req.mc_version,loader:args.req.loader,created:now};
            instances = [created,...instances];
            return {instance:created,outcome:{installed:['mod.jar'],skipped:[]},install_error:null,profile_warning:null};
          }
          case 'catalog_installed_mods': return [];
          case 'instance_path': return `/test/${args.instanceId}`;
          case 'open_url': case 'open_path': return null;
          default: return null;
        }
      }
    };
    window.__TAURI__ = {core:{invoke:(command,args) => mock.invoke(command,args)},event:{listen:async (name,callback) => {callbacks[name]=callback; return ()=>delete callbacks[name];}}};
  }, options);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('#dv-results .card');
  return {page,errors};
}

async function waitHome(page, source, type, query = null) {
  await page.waitForFunction(({source,type,query}) => {
    const cfg = window.omnispecDebug?.state.discover;
    return cfg && cfg.source === source && cfg.type === type && !cfg.loading && !cfg.error && (query === null || cfg.query === query);
  },{source,type,query});
}
async function checkBounds(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const view = page.viewportSize();
  assert(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= view.width + 1 && box.y + box.height <= view.height + 1,
    `${selector} выходит за окно: ${JSON.stringify({box,view})}`);
}
async function calls(page, command) { return page.evaluate(command => window.__homeTest.calls.filter(c => c.command === command), command); }
async function clickMods(page) { await page.locator('[data-dv-type="mod"]').click(); await waitHome(page,'modrinth','mod'); }

(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({headless:true});
  try {
    // Фильтры передаются серверу, сохраняются между страницами, типами и источниками.
    {
      const {page,errors} = await newPage(browser);
      assert.equal(await page.locator('[data-dv-category]').count(),11);
      for (const category of ['adventure','challenging','combat','kitchen-sink','lightweight','magic','multiplayer','optimization','quests','technology']) {
        assert.equal(await page.locator(`[data-dv-category="${category}"]`).count(),1,category);
      }
      await page.locator('[data-dv-category="magic"]').click();
      await page.locator('#dv-loader').selectOption('fabric');
      await page.locator('#dv-query').fill('magic test');
      await waitHome(page,'modrinth','modpack','magic test');
      let last = (await calls(page,'search_modrinth')).filter(c => c.args.query === 'magic test').at(-1);
      assert.deepEqual(last.args.categories,['magic']); assert.equal(last.args.loader,'fabric'); assert.equal(last.args.projectType,'modpack');
      await page.locator('#home-scroll').evaluate(el => {el.scrollTop=el.scrollHeight;});
      await page.waitForFunction(() => window.__homeTest.calls.some(c => c.command === 'search_modrinth' && c.args.query === 'magic test' && c.args.offset === 24));
      last = (await calls(page,'search_modrinth')).find(c => c.args.query === 'magic test' && c.args.offset === 24);
      assert.deepEqual(last.args.categories,['magic']); assert.equal(last.args.loader,'fabric');
      await page.locator('[data-dv-source="curseforge"]').click();
      await waitHome(page,'curseforge','modpack','magic test');
      await page.locator('[data-dv-category="4473"]').click();
      await waitHome(page,'curseforge','modpack','magic test');
      last = (await calls(page,'search_curseforge')).at(-1);
      assert.deepEqual(last.args.categories,['4473']); assert.equal(last.args.loader,'fabric');
      await page.locator('[data-dv-type="mod"]').click();
      await waitHome(page,'curseforge','mod','magic test');
      last = (await calls(page,'search_curseforge')).at(-1);
      assert.equal(last.args.projectType,'mod'); assert.deepEqual(last.args.categories,[]); assert.equal(last.args.loader,'fabric');
      assert.equal(await page.locator('[data-dv-category]').count(),0);
      await page.locator('[data-dv-source="modrinth"]').click();
      await waitHome(page,'modrinth','mod','magic test');
      assert.equal(await page.locator('#dv-query').inputValue(),'magic test');
      assert.equal((await calls(page,'search_modrinth')).at(-1).args.projectType,'mod');
      await page.locator('[data-dv-type="modpack"]').click();
      await waitHome(page,'modrinth','modpack','magic test');
      assert.equal(await page.locator('[data-dv-category="magic"]').getAttribute('aria-pressed'),'true');
      assert.deepEqual((await calls(page,'search_modrinth')).at(-1).args.categories,['magic']);

      // Старый ответ первого типа не подменит моды после переключения.
      await page.evaluate(() => window.__homeTest.holdQueries.add('search_modrinth:modpack:late'));
      await page.locator('#dv-query').fill('late');
      await page.waitForFunction(() => window.__homeTest.held.some(x => x.query === 'late'));
      await page.locator('[data-dv-type="mod"]').click();
      await waitHome(page,'modrinth','mod','late');
      await page.evaluate(() => window.__homeTest.releaseSearch('late'));
      await page.waitForTimeout(100);
      assert.equal(await page.locator('#dv-results [data-project="mr-pack"]').count(),0);
      assert.equal(await page.locator('#dv-results [data-project="mr-mod"]').count(),1);
      assert.deepEqual(errors,[]);
      console.log('HOME_FILTERS: server filters, categories, loader, paging and stale responses — OK');
      await page.close();
    }

    // Явный выбор совместимой существующей сборки и конкретной версии для каждого источника.
    for (const source of ['modrinth','curseforge']) {
      const {page,errors} = await newPage(browser);
      await clickMods(page);
      if (source === 'curseforge') { await page.locator('[data-dv-source="curseforge"]').click(); await waitHome(page,'curseforge','mod'); }
      const card = source === 'modrinth' ? '#dv-results [data-project="mr-mod"]' : '#dv-results [data-cf-project="cf-mod"]';
      const install = source === 'modrinth' ? '[data-install]' : '[data-cf-install]';
      await page.locator(`${card} ${install}`).click();
      await page.waitForSelector('#modal-mod-target:not([hidden])');
      await page.waitForFunction(() => document.querySelectorAll('#mod-target-body .mod-target-status.is-ok').length === 2);
      assert(await page.locator('#mod-target-submit').isDisabled(),'выбор должен быть явным');
      assert(await page.locator('input[value="fabric-old"]').isDisabled());
      assert(await page.locator('input[value="vanilla"]').isDisabled());
      assert.equal((await calls(page,'create_instance_for_mod')).length,0);
      assert.equal((await calls(page,source === 'modrinth' ? 'install_mod_version' : 'install_curseforge')).length,0);
      await page.locator('input[value="forge-old"]').check();
      await page.locator('#mod-target-submit').click();
      await page.waitForFunction(command => window.__homeTest.calls.some(c => c.command === command),source === 'modrinth' ? 'install_mod_version' : 'install_curseforge');
      const item = (await calls(page,source === 'modrinth' ? 'install_mod_version' : 'install_curseforge')).at(-1).args;
      assert.equal(item.instanceId,'forge-old');
      assert.equal(source === 'modrinth' ? item.versionId : item.fileId,'forge-version');
      if (source === 'modrinth') assert.equal(item.projectId,'mr-mod');
      assert.equal((await calls(page,'create_instance_for_mod')).length,0);
      // Окно выбора версии: конкретный файл не подменяется другим, отмена ничего не ставит.
      await page.locator(`${card} ${source === 'modrinth' ? '[data-versions]' : '[data-cf-versions]'}`).click();
      await page.waitForSelector(source === 'modrinth' ? '[data-install-version="fabric-version"]' : '[data-cf-install-version="fabric-version"]');
      await page.locator(source === 'modrinth' ? '[data-install-version="fabric-version"]' : '[data-cf-install-version="fabric-version"]').click();
      await page.waitForSelector('#modal-mod-target:not([hidden])');
      await page.waitForFunction(() => document.querySelector('#mod-target-body input[value="fabric-new"]') && !document.querySelector('#mod-target-body input[value="fabric-new"]').disabled);
      assert(await page.locator('input[value="forge-old"]').isDisabled());
      await page.keyboard.press('Escape');
      assert(await page.locator('#modal-mod-target').isHidden());
      assert(await page.locator('#modal-versions').isVisible());
      assert.equal((await calls(page,source === 'modrinth' ? 'install_mod_version' : 'install_curseforge')).length,1);
      await page.keyboard.press('Escape');
      assert.deepEqual(errors,[]);
      console.log(`HOME_EXISTING_${source.toUpperCase()}: compatibility, explicit target, exact version, cancellation — OK`);
      await page.close();
    }

    // Конфликт имени основного файла не маскируется успехом зависимости.
    for (const source of ['modrinth','curseforge']) {
      const {page,errors} = await newPage(browser);
      await clickMods(page);
      if (source === 'curseforge') { await page.locator('[data-dv-source="curseforge"]').click(); await waitHome(page,'curseforge','mod'); }
      await page.evaluate(() => { window.__homeTest.installOutcome = {installed:['dependency.jar'],skipped:['mod.jar']}; });
      const card = source === 'modrinth' ? '#dv-results [data-project="mr-mod"]' : '#dv-results [data-cf-project="cf-mod"]';
      await page.locator(`${card} ${source === 'modrinth' ? '[data-install]' : '[data-cf-install]'}`).click();
      await page.waitForFunction(() => document.querySelector('#mod-target-body input[value="fabric-new"]') && !document.querySelector('#mod-target-body input[value="fabric-new"]').disabled);
      await page.locator('input[value="fabric-new"]').check();
      await page.locator('#mod-target-submit').click();
      await page.waitForFunction(() => document.querySelector('#toasts')?.innerText.includes('mod.jar'));
      const message = await page.locator('#toasts').innerText();
      assert(message.includes('не перезаписаны') && message.includes('dependency.jar'));
      assert(!message.includes('Мод установлен'));
      assert.deepEqual(errors,[]);
      console.log(`HOME_COLLISION_${source.toUpperCase()}: no false mod success when only dependency was installed — OK`);
      await page.close();
    }

    // Пустой список: сначала подтверждение сочетания, никакого создания до нажатия.
    for (const source of ['modrinth','curseforge']) {
      const {page,errors} = await newPage(browser,{empty:true});
      await clickMods(page);
      if (source === 'curseforge') { await page.locator('[data-dv-source="curseforge"]').click(); await waitHome(page,'curseforge','mod'); }
      const card = source === 'modrinth' ? '#dv-results [data-project="mr-mod"]' : '#dv-results [data-cf-project="cf-mod"]';
      await page.locator(`${card} ${source === 'modrinth' ? '[data-install]' : '[data-cf-install]'}`).click();
      await page.waitForFunction(() => document.querySelector('#mod-target-loader-version option[value="fabric-1.21.1-stable"]'));
      assert.equal(await page.locator('#mod-target-mc option').count(),2,'только официальные версии с метками мода');
      assert.equal(await page.locator('#mod-target-loader').inputValue(),'fabric');
      assert.equal((await calls(page,'create_instance_for_mod')).length,0);
      await page.locator('#mod-target-mc').selectOption('1.20.1');
      await page.waitForFunction(() => document.querySelector('#mod-target-loader-version option[value="forge-1.20.1-stable"]'));
      assert.equal(await page.locator('#mod-target-loader').inputValue(),'forge');
      assert.equal(await page.locator('#mod-target-loader option').count(),1,'нельзя скрестить Fabric от другой версии');
      await page.locator('#mod-target-name').fill('Моя новая сборка');
      await page.locator('#mod-target-cancel').click();
      assert.equal((await calls(page,'create_instance_for_mod')).length,0);
      await page.locator(`${card} ${source === 'modrinth' ? '[data-install]' : '[data-cf-install]'}`).click();
      await page.waitForFunction(() => document.querySelector('#mod-target-loader-version option[value="fabric-1.21.1-stable"]'));
      await page.locator('#mod-target-mc').selectOption('1.20.1');
      await page.waitForFunction(() => document.querySelector('#mod-target-loader-version option[value="forge-1.20.1-stable"]'));
      await page.locator('#mod-target-name').fill('Моя новая сборка');
      await page.locator('#mod-target-submit').click();
      await page.waitForFunction(() => window.__homeTest.calls.some(c => c.command === 'create_instance_for_mod'));
      const args = (await calls(page,'create_instance_for_mod')).at(-1).args;
      assert.equal(args.source,source); assert.equal(args.versionId,'forge-version');
      assert.equal(args.req.name,'Моя новая сборка'); assert.equal(args.req.mc_version,'1.20.1');
      assert.equal(args.req.loader.type,'forge'); assert.equal(args.req.loader.version,'forge-1.20.1-stable');
      assert.equal(args.req.game_dir,null);
      if (source === 'curseforge') assert((await calls(page,'curseforge_compatibility_versions')).length >= 1);
      assert.deepEqual(errors,[]);
      console.log(`HOME_CREATE_${source.toUpperCase()}: correct game/loader pairs and confirmation — OK`);
      await page.close();
    }

    // Сбой каталога не превращается в «несовместимо» и не создаёт сборку.
    {
      const {page,errors} = await newPage(browser,{empty:true});
      await clickMods(page);
      await page.locator('[data-dv-source="curseforge"]').click(); await waitHome(page,'curseforge','mod');
      await page.evaluate(() => {window.__homeTest.failCompatibility=true;});
      await page.locator('#dv-results [data-cf-project="cf-mod"] [data-cf-install]').click();
      await page.waitForSelector('#mod-target-retry-new');
      assert(await page.locator('#mod-target-submit').isDisabled());
      assert.equal((await calls(page,'create_instance_for_mod')).length,0);
      await page.evaluate(() => {window.__homeTest.failCompatibility=false;});
      await page.locator('#mod-target-retry-new').click();
      await page.waitForFunction(() => document.querySelector('#mod-target-loader-version option[value="fabric-1.21.1-stable"]'));
      assert(await page.locator('#mod-target-submit').isEnabled());
      await page.locator('#mod-target-cancel').click();
      assert.equal((await calls(page,'create_instance_for_mod')).length,0);
      assert.deepEqual(errors,[]);
      console.log('HOME_FAILURE: no implicit creation on network error; retry works — OK');
      await page.close();
    }

    // Галерея доступна с обоих сайтов: в описании, отдельной вкладке и полноэкранном просмотре.
    for (const source of ['modrinth','curseforge']) {
      const {page,errors} = await newPage(browser);
      if (source === 'curseforge') { await page.locator('[data-dv-source="curseforge"]').click(); await waitHome(page,'curseforge','modpack'); }
      const card = source === 'modrinth' ? '#dv-results [data-project="mr-pack"]' : '#dv-results [data-cf-project="cf-pack"]';
      await page.locator(`${card} .card-body`).click();
      await page.waitForSelector('#proj-panel-description .proj-shot');
      assert.equal(await page.locator('#proj-panel-description .proj-shot').count(),6);
      await page.locator('#proj-panel-description [data-project-image="0"]').click();
      assert(await page.locator('#modal-project-image').isVisible());
      assert.equal(await page.locator('#project-image-count').innerText(),'1 / 8');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.locator('#project-image-count').innerText(),'2 / 8');
      await page.keyboard.press('Escape');
      assert(await page.locator('#modal-project').isVisible());
      assert(await page.locator('#modal-project-image').isHidden());
      await page.locator('#proj-tab-gallery').click();
      assert.equal(await page.locator('#proj-panel-gallery .proj-shot').count(),8);
      assert(await page.locator('#proj-panel-description').isHidden());
      await page.locator('#proj-panel-gallery [data-project-image="7"]').click();
      assert.equal(await page.locator('#project-image-count').innerText(),'8 / 8');
      assert.equal(await page.locator('#project-image-full').getAttribute('alt'),'Картинка 8');
      await page.locator('#project-image-next').click();
      assert.equal(await page.locator('#project-image-count').innerText(),'1 / 8');
      await page.keyboard.press('Escape');
      if (source === 'curseforge') {
        await page.locator('#proj-install').click();
        await page.waitForFunction(() => window.__homeTest.calls.some(c => c.command === 'install_curseforge_modpack'));
        assert.equal((await calls(page,'install_curseforge')).length,0,'модпак не устанавливается как мод');
      } else await page.locator('[data-close-project]').click();
      assert.deepEqual(errors,[]);
      console.log(`PROJECT_IMAGES_${source.toUpperCase()}: all images, enlargement, keyboard and correct pack action — OK`);
      await page.close();
    }

    // Окна остаются внутри минимального окна при максимальном масштабе.
    {
      const {page,errors} = await newPage(browser,{empty:true});
      await page.setViewportSize({width:1080,height:640});
      await page.evaluate(() => { document.body.style.zoom = '1.5'; document.documentElement.style.setProperty('--ui-zoom','1.5'); });
      await clickMods(page);
      await page.locator('#dv-results [data-project="mr-mod"] [data-install]').click();
      await page.waitForFunction(() => document.querySelector('#mod-target-loader-version option[value="fabric-1.21.1-stable"]'));
      await checkBounds(page,'.mod-target-box');
      await page.locator('#mod-target-cancel').click();
      await page.locator('[data-dv-type="modpack"]').click(); await waitHome(page,'modrinth','modpack');
      await page.locator('#dv-results [data-project="mr-pack"] .card-body').click();
      await page.waitForSelector('#proj-panel-description .proj-shot');
      await checkBounds(page,'.proj-box');
      await page.locator('#proj-panel-description [data-project-image="0"]').click();
      await checkBounds(page,'.project-image-modal');
      assert.deepEqual(errors,[]);
      console.log('HOME_MODAL_BOUNDS: minimum window, 150% scale — OK');
      await page.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode=1; server.close(); });
