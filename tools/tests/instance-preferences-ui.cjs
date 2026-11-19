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
      memory:{total_mb:16384}, calls:[], held:[], holdRule:null,
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
            return [{filename,name:filename,enabled:true,size:1}];
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
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try {
    const {page,errors}=await openPage(browser);
    await selectHome(page,'alpha');
    await activeTab(page,'console','alpha');
    await prefs(page,'look');
    assert((await page.locator('#prefs-initial-tab').innerText()).includes('Консоль'));
    await page.locator('#prefs-initial-tab').click();
    assert.equal(await page.locator('[data-initial-tab]').count(),10);
    const dialogStyle=await page.locator('#modal-initial-tab [role="dialog"]').evaluate(el => ({background:getComputedStyle(el).backgroundColor,border:getComputedStyle(el).borderStyle}));
    assert.notEqual(dialogStyle.background,'rgba(0, 0, 0, 0)');
    assert.equal(dialogStyle.border,'solid');
    assert.equal(await page.locator('[data-initial-tab="console"]').getAttribute('aria-pressed'),'true');
    await page.keyboard.press('Escape');
    assert(await page.locator('#modal-initial-tab').isHidden());
    assert(!(await page.locator('#modal-prefs').isHidden()),'Escape закрывает только вложенное окно');
    assert.equal(await page.evaluate(() => document.activeElement.id),'prefs-initial-tab');
    await closePrefs(page);

    for (const id of ['console','errors','files','mods','resourcepacks','shaders','worlds','screenshots','download','settings']) {
      await chooseInitial(page,id);
      await selectHome(page,'alpha');
      await activeTab(page,id,'alpha');
      // Ручная смена вкладки не меняет настройку; клик по другой сборке её применяет.
      const manual=id === 'console' ? 'mods' : 'console';
      await page.locator(`[data-tab="${manual}"]`).click();
      await activeTab(page,manual,'alpha');
      await page.locator('.instance[data-id="beta"]').click();
      await activeTab(page,id,'beta');
    }
    // Ошибка старой записи не должна откатывать более поздний выбор, даже такой же.
    await chooseInitial(page,'mods');
    await prefs(page,'look');
    await page.evaluate(() => {window.__instancePrefsTest.holdNextSave=true;});
    await page.locator('#prefs-initial-tab').click();
    await page.locator('[data-initial-tab="files"]').click();
    await page.waitForFunction(() => window.__instancePrefsTest.pendingSettings.length === 1);
    await page.locator('#prefs-initial-tab').click();
    await page.locator('[data-initial-tab="worlds"]').click();
    await page.locator('#prefs-initial-tab').click();
    await page.locator('[data-initial-tab="files"]').click();
    await page.evaluate(() => window.__instancePrefsTest.pendingSettings.shift().reject(new Error('первая запись не удалась')));
    await page.waitForFunction(() => window.__instancePrefsTest.settings.initial_tab === 'files');
    assert.equal(await page.evaluate(() => window.omnispecDebug.state.settings.initial_tab),'files');
    // Если и следующая запись не удалась, возвращаем последний подтверждённый выбор.
    await page.evaluate(() => {window.__instancePrefsTest.holdNextSave=true;});
    await page.locator('#prefs-initial-tab').click();
    await page.locator('[data-initial-tab="settings"]').click();
    await page.waitForFunction(() => window.__instancePrefsTest.pendingSettings.length === 1);
    await page.locator('#prefs-initial-tab').click();
    await page.locator('[data-initial-tab="screenshots"]').click();
    await page.evaluate(() => {
      window.__instancePrefsTest.failNextSave=true;
      window.__instancePrefsTest.pendingSettings.shift().reject(new Error('первая запись не удалась'));
    });
    await page.waitForFunction(() => window.omnispecDebug.state.settings.initial_tab === 'files'
      && window.__instancePrefsTest.calls.filter(call => call.command === 'save_settings').at(-1)?.args.settings.initial_tab === 'files');
    assert((await page.locator('#prefs-initial-tab').innerText()).includes('Файлы'));
    assert.equal(await page.evaluate(() => window.__instancePrefsTest.settings.initial_tab),'files');
    await closePrefs(page);
    console.log('INITIAL_TAB_SAVE_RACES: поздний сбой не отменяет новый выбор, неуспешные записи откатываются — OK');

    // Меню «Настройки сборки» должно открывать их независимо от начальной вкладки.
    await chooseInitial(page,'mods');
    await selectHome(page,'alpha');
    await activeTab(page,'mods','alpha');
    await page.locator('.instance[data-id="alpha"]').click({button:'right'});
    await page.locator('#ctx-menu [data-act="settings"]').click();
    await activeTab(page,'settings','alpha');
    // Выбор плитки в окне «Все сборки» тоже соблюдает начальную вкладку.
    await page.locator('#btn-grid').click();
    await page.locator('[data-build-tile="beta"]').click();
    await activeTab(page,'mods','beta');
    await page.reload();
    await page.waitForSelector('[data-home-id="alpha"]');
    await page.locator('[data-home-id="alpha"]').click();
    await activeTab(page,'mods','alpha');
    await page.evaluate(() => {window.omnispecDebug.state.settings.initial_tab='incorrect';});
    await page.locator('.instance[data-id="beta"]').click();
    await activeTab(page,'console','beta');
    console.log('INITIAL_TAB: все 10 вкладок, ручное переключение, меню, плитка, перезапуск, fallback — OK');

    // ПКМ «Играть» по другой сборке должен переключить всю видимую сборку,
    // а не только selectedId с оставшимся на экране содержимым прежней.
    await chooseInitial(page,'mods');
    await selectHome(page,'alpha');
    await page.waitForFunction(() => document.querySelector('#tab-body')?.textContent.includes('alpha-mod.jar'));
    await page.locator('.instance[data-id="beta"]').click({button:'right'});
    await page.locator('#ctx-menu [data-act="play"]').click();
    await activeTab(page,'mods','beta');
    await page.waitForFunction(() => document.querySelector('#tab-body')?.textContent.includes('beta-mod.jar'));
    assert.equal((await page.locator('#tb-name').innerText()).trim(),'Beta');
    await page.waitForFunction(() => window.__instancePrefsTest.calls.some(x => x.command === 'launch_instance' && x.args.instanceId === 'beta'));
    // Повторное действие по выбранной сборке не сбрасывает ручную вкладку.
    await page.locator('[data-tab="files"]').click();
    await page.waitForFunction(() => document.querySelector('#tab-body')?.textContent.includes('beta.txt'));
    await page.locator('.instance[data-id="beta"]').click({button:'right'});
    await page.locator('#ctx-menu [data-act="play"]').click();
    await activeTab(page,'files','beta');
    assert.equal((await page.locator('#tb-name').innerText()).trim(),'Beta');
    console.log('CONTEXT_PLAY: новая сборка и её начальная вкладка отображаются целиком — OK');

    // ОЗУ: предел всех трёх ползунков, сохранение старых значений и ручная правка.
    await prefs(page,'game');
    assert.equal(await page.locator('#set-memory').getAttribute('max'),'16384');
    assert((await page.locator('#set-memory-hint').innerText()).includes('ОЗУ, доступная системе: 16384 МБ'));
    assert((await page.locator('#set-memory-hint').innerText()).includes('не более 14336 МБ'));
    assert((await page.locator('#set-memory-hint').innerText()).includes('запас меньше рекомендуемого'));
    assert((await page.locator('#set-memory-hint').innerText()).includes('Сохранено 32768 МБ'));
    await page.locator('#prefs-save').click();
    await page.waitForFunction(() => window.__instancePrefsTest.settings.memory_mb === 32768);
    await page.locator('.instance[data-id="alpha"]').click();
    await page.locator('[data-tab="settings"]').click();
    await page.waitForSelector('#inst-memory');
    assert.equal(await page.locator('#inst-memory').getAttribute('max'),'16384');
    assert.equal((await page.locator('#inst-memory-value').innerText()).trim(),'32768 МБ');
    await page.locator('#inst-save').click();
    await page.waitForFunction(() => window.__instancePrefsTest.calls.some(x => x.command === 'update_instance'));
    assert.equal(await page.evaluate(() => window.__instancePrefsTest.instances.find(x => x.id === 'alpha').memory_mb),32768,'сохранение других полей не обрезает память');
    await setRange(page,'#inst-memory',8192);
    await page.locator('#inst-save').click();
    await page.waitForFunction(() => window.__instancePrefsTest.instances.find(x => x.id === 'alpha').memory_mb === 8192);
    await page.evaluate(() => {
      window.__instancePrefsTest.instances.find(x => x.id === 'beta').memory_mb=256;
      window.omnispecDebug.state.instances.find(x => x.id === 'beta').memory_mb=256;
    });
    await page.locator('.instance[data-id="beta"]').click();
    await page.locator('[data-tab="settings"]').click();
    assert.equal((await page.locator('#inst-memory-value').innerText()).trim(),'256 МБ');
    assert((await page.locator('#inst-memory-hint').innerText()).includes('ниже минимума'));
    await page.locator('#inst-save').click();
    await page.waitForFunction(() => window.__instancePrefsTest.calls.some(x => x.command === 'update_instance' && x.args.meta.id === 'beta'));
    assert.equal(await page.evaluate(() => window.__instancePrefsTest.instances.find(x => x.id === 'beta').memory_mb),256,'значение ниже минимума не меняется без действий пользователя');
    await page.locator('#btn-new-build').click();
    await page.waitForSelector('#c-memory');
    assert.equal(await page.locator('#c-memory').getAttribute('max'),'16384');
    assert.equal(await page.locator('#c-memory').inputValue(),'16384','новая сборка не наследует значение выше ОЗУ ПК');
    await page.locator('#modal-create [data-close-modal]').first().click();
    await prefs(page,'game');
    for (const [total,max] of [[512,512],[768,768],[4096,4096],[8192,8192],[16000,15872],[16384,16384],[32768,32768],[65536,65536],[131072,65536]]) {
      await page.evaluate(total => {window.omnispecDebug.state.systemMemory={total_mb:total};},total);
      await page.locator('[data-pref="game"]').click();
      assert.equal(Number(await page.locator('#set-memory').getAttribute('max')),max,`неверный предел при ОЗУ ${total}`);
    }
    await page.evaluate(() => {window.omnispecDebug.state.systemMemory={total_mb:384};});
    await page.locator('[data-pref="game"]').click();
    assert(await page.locator('#set-memory').isDisabled(),'при ОЗУ ниже минимума ядра ползунок недоступен');
    assert((await page.locator('#set-memory-hint').innerText()).includes('ОЗУ, доступная системе: 384 МБ'));
    assert((await page.locator('#set-memory-hint').innerText()).includes('не менее 512 МБ'));
    await page.evaluate(() => {window.omnispecDebug.state.systemMemory=null;});
    await page.locator('[data-pref="game"]').click();
    assert((await page.locator('#set-memory-hint').innerText()).includes('Не удалось определить ОЗУ'));
    await page.evaluate(() => {window.omnispecDebug.state.systemMemory={total_mb:16384};});
    await page.locator('[data-pref="game"]').click();
    await setRange(page,'#set-memory',6144);
    await page.waitForFunction(() => window.__instancePrefsTest.settings.memory_mb === 6144);
    assert(!(await page.locator('#set-memory-hint').innerText()).includes('запас меньше рекомендуемого'));
    await closePrefs(page);
    console.log('RAM: физический максимум, 4–128 ГБ, неизвестная ОЗУ, старые значения и ручная правка — OK');

    // Ответы старой сборки не должны заменять содержимое выбранной вкладки.
    for (const [tab,command,sub,unexpected] of [
      ['screenshots','list_screenshots',null,'OLD_SCREEN'],
      ['worlds','list_dir','saves','OLD_WORLD'],
      ['files','list_dir','', 'alpha.txt']
    ]) {
      await chooseInitial(page,tab);
      await selectHome(page,'beta');
      await page.evaluate(({command,sub}) => window.__instancePrefsTest.hold(command,'alpha',sub),{command,sub});
      await page.locator('.instance[data-id="alpha"]').click();
      await page.waitForFunction(() => window.__instancePrefsTest.held.length === 1);
      await page.locator('.instance[data-id="beta"]').click();
      await activeTab(page,tab,'beta');
      if (tab === 'files') await page.waitForFunction(() => document.querySelector('#fm-list')?.textContent.includes('beta.txt'));
      await page.evaluate(() => window.__instancePrefsTest.release());
      await page.waitForTimeout(100);
      assert(!(await page.locator('#tab-body').innerText()).includes(unexpected),`старый ${tab} не должен перезаписать новую сборку`);
      if (tab === 'files') assert((await page.locator('#fm-list').innerText()).includes('beta.txt'));
    }
    // А → Б → А: старый ответ первой загрузки А не должен перекрыть вторую.
    for (const [tab,kind] of [['mods','mod'],['resourcepacks','resourcepack'],['shaders','shader']]) {
      await chooseInitial(page,tab);
      await selectHome(page,'beta');
      await page.evaluate(kind => window.__instancePrefsTest.hold('content_list','alpha',kind),kind);
      await page.locator('.instance[data-id="alpha"]').click();
      await page.waitForFunction(() => window.__instancePrefsTest.held.length === 1);
      await page.locator('.instance[data-id="beta"]').click();
      await page.waitForFunction(kind => document.querySelector('#tab-body')?.textContent.includes(`beta-${kind}.jar`),kind);
      await page.locator('.instance[data-id="alpha"]').click();
      await page.waitForFunction(kind => document.querySelector('#tab-body')?.textContent.includes(`alpha-${kind}.jar`),kind);
      await page.evaluate(() => window.__instancePrefsTest.release());
      await page.waitForTimeout(100);
      assert(!(await page.locator('#tab-body').innerText()).includes('STALE_CONTENT'),`${tab}: старый ответ А перезаписал новый`);
      assert((await page.locator('#tab-body').innerText()).includes(`alpha-${kind}.jar`));
    }
    await chooseInitial(page,'settings');
    await selectHome(page,'beta');
    await page.evaluate(() => window.__instancePrefsTest.hold('list_java','alpha'));
    await page.locator('.instance[data-id="alpha"]').click();
    await page.waitForFunction(() => window.__instancePrefsTest.held.length === 1);
    await page.locator('.instance[data-id="beta"]').click();
    await page.waitForFunction(() => document.querySelector('#inst-name')?.value === 'Beta');
    await page.locator('.instance[data-id="alpha"]').click();
    await page.waitForFunction(() => document.querySelector('#inst-name')?.value === 'Alpha');
    await page.locator('#inst-name').fill('Несохранённое имя');
    await page.evaluate(() => window.__instancePrefsTest.release());
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#inst-name').inputValue(),'Несохранённое имя','старые настройки А не стирают новую правку');
    await chooseInitial(page,'mods');
    await selectHome(page,'alpha');
    await page.waitForFunction(() => document.querySelector('#tab-body')?.textContent.includes('alpha-mod.jar'));
    await page.evaluate(() => {
      window.omnispecDebug.state.modIcons={'shared.jar':'data:image/png;base64,AA=='};
      window.omnispecDebug.state.contentUpdates={mod:[{filename:'shared.jar'}]};
    });
    await page.locator('.instance[data-id="beta"]').click();
    await page.waitForFunction(() => document.querySelector('#tab-body')?.textContent.includes('beta-mod.jar'));
    assert.deepEqual(await page.evaluate(() => window.omnispecDebug.state.modIcons),{});
    assert.deepEqual(await page.evaluate(() => window.omnispecDebug.state.contentUpdates),{});
    await page.evaluate(() => window.__instancePrefsTest.hold('mod_icons','alpha'));
    await page.locator('.instance[data-id="alpha"]').click();
    await page.waitForFunction(() => window.__instancePrefsTest.held.length === 1);
    await page.locator('.instance[data-id="beta"]').click();
    await page.waitForFunction(() => document.querySelector('#tab-body')?.textContent.includes('beta-mod.jar'));
    await page.evaluate(() => window.__instancePrefsTest.release());
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.omnispecDebug.state.modIcons),{},'иконки прежней сборки не попадают в текущую');
    console.log('INITIAL_TAB_ASYNC: все вкладки защищены от запоздалых ответов и чужих иконок — OK');

    // Длинное ПКМ-меню целиком находится в окне и прокручивается до обеих границ.
    const categories=Array.from({length:36},(_,i)=>({id:`cat-${i}`,name:`Категория ${i}`,collapsed:false}));
    await page.evaluate(categories => {window.omnispecDebug.state.settings.categories=categories;},categories);
    await page.setViewportSize({width:1080,height:640});
    for (const zoom of [80,100,125,150]) {
      await prefs(page,'look');
      await page.locator(`[data-ui-scale="${zoom}"]`).click();
      const prefsRect=await page.locator('#modal-prefs .prefs-box').evaluate(el => {const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});
      assert(prefsRect.left >= 0 && prefsRect.top >= 0 && prefsRect.right <= prefsRect.width && prefsRect.bottom <= prefsRect.height, `настройки выходят за экран при ${zoom}%`);
      await page.locator('#prefs-initial-tab').click();
      const dialogRect=await page.locator('#modal-initial-tab [role="dialog"]').evaluate(el => {const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});
      assert(dialogRect.left >= 0 && dialogRect.top >= 0 && dialogRect.right <= dialogRect.width && dialogRect.bottom <= dialogRect.height, `выбор вкладки выходит за экран при ${zoom}%`);
      await page.keyboard.press('Escape');
      assert(await page.locator('#modal-initial-tab').isHidden());
      await closePrefs(page);
      await page.locator('#btn-new-build').click();
      const createRect=await page.locator('#modal-create > .modal').evaluate(el => {const r=el.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};});
      assert(createRect.left >= 0 && createRect.top >= 0 && createRect.right <= createRect.width && createRect.bottom <= createRect.height, `создание сборки выходит за экран при ${zoom}%`);
      await page.locator('#c-memory').scrollIntoViewIfNeeded();
      assert(await page.locator('#c-memory').isVisible(),`ползунок новой сборки недоступен при ${zoom}%`);
      await page.keyboard.press('Escape');
      assert(await page.locator('#modal-create').isHidden());
      await page.evaluate(() => {
        const row=document.querySelector('.instance[data-id="beta"]');
        row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-2,clientY:innerHeight-2}));
      });
      const geometry=await page.locator('#ctx-menu').evaluate(menu => {
        const r=menu.getBoundingClientRect();
        return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,scrollHeight:menu.scrollHeight,clientHeight:menu.clientHeight,overflow:getComputedStyle(menu).overflowY,width:innerWidth,height:innerHeight};
      });
      assert(geometry.left >= -0.5 && geometry.top >= -0.5 && geometry.right <= geometry.width+0.5 && geometry.bottom <= geometry.height+0.5, `меню выходит за окно при ${zoom}%: ${JSON.stringify(geometry)}`);
      assert(geometry.scrollHeight>geometry.clientHeight && geometry.overflow==='auto',`нет прокрутки при ${zoom}%`);
      await page.locator('#ctx-menu [data-act="delete"]').scrollIntoViewIfNeeded();
      const bottom=await page.locator('#ctx-menu [data-act="delete"]').evaluate(el => {const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return r.top>=p.top-.5 && r.bottom<=p.bottom+.5;});
      assert(bottom,`нижняя кнопка недоступна при ${zoom}%`);
      await page.locator('#ctx-menu [data-act="play"]').scrollIntoViewIfNeeded();
      const top=await page.locator('#ctx-menu [data-act="play"]').evaluate(el => {const r=el.getBoundingClientRect(),p=el.parentElement.getBoundingClientRect();return r.top>=p.top-.5 && r.bottom<=p.bottom+.5;});
      assert(top,`верхняя кнопка недоступна при ${zoom}%`);
      await page.keyboard.press('Escape');
      assert(await page.locator('#ctx-menu').isHidden());
    }
    console.log('CONTEXT_MENU: окно 1080×640, 36 категорий и масштаб 80–150%, обе границы доступны — OK');

    // Нет пересоздания и скачков при многократных событиях resize.
    await prefs(page,'look'); await page.locator('[data-ui-scale="100"]').click(); await closePrefs(page);
    const same=await page.evaluate(() => {
      const a=window.omnispecDebug.ambientSnapshot();
      for (let i=0;i<20;i++) window.dispatchEvent(new Event('resize'));
      const b=window.omnispecDebug.ambientSnapshot();
      return {a,b};
    });
    assert(same.a.particles.length > 0,'эффект снега включён');
    assert.deepEqual(same.b.particles,same.a.particles,'resize без изменения размера не должен перезапускать частицы');
    const before=await page.evaluate(() => window.omnispecDebug.ambientSnapshot());
    const start=Date.now();
    await page.setViewportSize({width:1460,height:900});
    await page.waitForTimeout(120);
    const after=await page.evaluate(() => window.omnispecDebug.ambientSnapshot());
    const elapsed=(Date.now()-start)/1000;
    const byPhase=new Map(after.particles.map(p => [p.phase,p]));
    const shared=before.particles.filter(p => byPhase.has(p.phase));
    assert(shared.length >= before.particles.length*.9,'при увеличении окна существующие частицы сохраняются');
    for (const p of shared) {
      const q=byPhase.get(p.phase);
      assert(Math.abs(q.y-p.y) <= 34*elapsed+4,`ускорился вертикальный эффект: ${q.y-p.y}`);
      assert(Math.abs(q.x-p.x) <= 50*elapsed+4,`ускорился горизонтальный эффект: ${q.x-p.x}`);
    }
    // Та же проверка для всех доступных типов частиц, включая летящую вверх пыль.
    await prefs(page,'fx');
    for (const style of ['stars','dust','sticks','snow','flakes','leaves','petals','butterflies','hearts']) {
      await page.setViewportSize({width:1080,height:640});
      await page.locator(`[data-ambient="${style}"]`).click();
      const snapshots=await page.evaluate(() => {
        const a=window.omnispecDebug.ambientSnapshot();
        for (let i=0;i<12;i++) window.dispatchEvent(new Event('resize'));
        return {a,b:window.omnispecDebug.ambientSnapshot()};
      });
      assert(snapshots.a.particles.length > 0,`нет частиц ${style}`);
      assert.deepEqual(snapshots.b.particles,snapshots.a.particles,`${style}: resize изменил частицы без движения времени`);
      const began=Date.now();
      await page.setViewportSize({width:1320,height:800});
      await page.waitForTimeout(55);
      const expanded=await page.evaluate(() => window.omnispecDebug.ambientSnapshot());
      const duration=(Date.now()-began)/1000;
      const seen=new Map(expanded.particles.map(p => [p.phase,p]));
      const retained=snapshots.b.particles.filter(p => seen.has(p.phase));
      assert(retained.length >= snapshots.b.particles.length*.9,`${style}: старые частицы исчезли при расширении`);
      for (const p of retained) {
        const q=seen.get(p.phase);
        assert(Math.abs(q.y-p.y) <= 34*duration+4,`${style}: ускорилось движение по вертикали`);
        assert(Math.abs(q.x-p.x) <= 50*duration+4,`${style}: ускорилось движение по горизонтали`);
      }
    }
    console.log('EFFECTS_RESIZE: все 9 эффектов сохраняют частицы и скорость — OK');

    // След курсора не должен стираться на каждом движении; после resize
    // сохранённые точки заново рисуются на изменённом canvas.
    await page.locator('#set-trail').click();
    await page.locator('[data-trail-style="line"]').click();
    await setRange(page,'#set-trail-length',300);
    await setRange(page,'#set-trail-opacity',100);
    await closePrefs(page);
    await page.waitForTimeout(1700);
    const trail=await page.evaluate(async () => {
      const canvas=document.querySelector('#trail');
      const descriptor=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,'width');
      let writes=0;
      Object.defineProperty(HTMLCanvasElement.prototype,'width',{...descriptor,set(value) {
        if (this === canvas) writes++;
        descriptor.set.call(this,value);
      }});
      const alphaPixels=() => {
        const data=canvas.getContext('2d').getImageData(70,70,250,60).data;
        let count=0;
        for (let i=3;i<data.length;i+=4) if (data[i]) count++;
        return count;
      };
      const frame=() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      try {
        for (let x=100;x<=260;x+=10) window.dispatchEvent(new MouseEvent('mousemove',{clientX:x,clientY:100,bubbles:true}));
        const starts=writes;
        await frame();
        const before=alphaPixels();
        for (let i=0;i<8;i++) window.dispatchEvent(new Event('resize'));
        await frame();
        return {starts,before,after:alphaPixels()};
      } finally { Object.defineProperty(HTMLCanvasElement.prototype,'width',descriptor); }
    });
    assert(trail.starts <= 1,`canvas трейса пересоздаётся при каждом движении: ${trail.starts}`);
    assert(trail.before>0 && trail.after>0,`след не перерисовался после resize: ${JSON.stringify(trail)}`);
    assert.deepEqual(errors,[],'ошибки интерфейса');
    console.log('TRAIL_RESIZE: точки следа сохраняются, canvas не сбрасывается на каждом движении — OK');
    await page.close();
  } finally { await browser.close(); server.close(); }
})().catch(error => {console.error(error);process.exitCode=1;server.close();});
