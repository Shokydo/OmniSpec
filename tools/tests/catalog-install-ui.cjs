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

async function createPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    const now = Math.floor(Date.now() / 1000);
    const instances = [
      {id:'pack-a',name:'Первая сборка',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16.0'},created:now,playtime_secs:0,icon:null},
      {id:'pack-b',name:'Вторая сборка',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16.0'},created:now,playtime_secs:0,icon:null}
    ];
    const callbacks = {};
    const mock = window.__catalogTest = {
      callbacks, calls: [], pending: [], held: [], holdNext: {},
      entries: {
        'pack-a': [
          {project_id:'m-5',source:'modrinth',enabled:true}, {project_id:'m-6',source:'modrinth',enabled:false},
          {project_id:'m-7',source:'modrinth',enabled:true,latest:false},
          {project_id:'m-8',source:'modrinth',enabled:true,imported:true},
          {project_id:'c-5',source:'curseforge',enabled:true}, {project_id:'12345678',source:'curseforge',enabled:true},
          {project_id:'87654321',source:'modrinth',enabled:true}, {project_id:'11111111',source:null,enabled:true}
        ],
        'pack-b': [{project_id:'m-9',source:'modrinth',enabled:true}]
      },
      emit(name,payload) { if (!callbacks[name]) throw new Error(`Нет обработчика ${name}`); callbacks[name]({payload}); },
      progress(index, extra = {}) {
        const {args,command} = this.pending[index];
        const pack = command === 'install_modpack' || command === 'install_curseforge_modpack';
        this.emit('progress', {instance:args.instanceId || 'modpack',stage:pack ? 'modpack' : 'mods',done:0,total:0,state:'active',op:args.opId || '',...extra});
      },
      completePack(index) {
        this.pending[index].resolve({...instances[0]});
      },
      complete(index, persist = true) {
        const task = this.pending[index];
        const projectId = task.command === 'install_mod_version' ? task.args.versionId.replace(/^version-/, '') : task.args.projectId;
        const source = task.command === 'install_curseforge' ? 'curseforge' : 'modrinth';
        if (persist) this.entries[task.args.instanceId].push({project_id:projectId,source,enabled:true});
        this.progress(index, {state:'done',detail:'готово'});
        task.resolve({installed:persist ? [`${projectId}.jar`] : [],skipped:persist ? [] : [`${projectId}.jar`]});
      },
      fail(index, message = 'сеть недоступна') { this.pending[index].reject(message); },
      releaseHeld(id) {
        const held = this.held.filter(x => x.id === id);
        this.held = this.held.filter(x => x.id !== id);
        held.forEach(item => item.resolve(item.snapshot));
      },
      async invoke(command, args = {}) {
        this.calls.push({command,args});
        switch (command) {
          case 'get_settings': return {theme:'dark',click_fx:'off',ambient:'off',trail:false,onboarded:true,discord_rpc:false,update_enabled:false,mods_grid:3};
          case 'save_settings': return null;
          case 'accounts_info': return {accounts:[{uuid:'user-1',username:'Steve',kind:'offline'}],active:'user-1'};
          case 'list_instances': return instances.map(x => ({...x}));
          case 'running_instances': return [];
          case 'custom_wallpaper': case 'startup_file': case 'set_presence': case 'resolve_presence_icon': case 'instance_icon': return null;
          case 'version_info': return {version:'test',enabled:false};
          case 'list_java': return [];
          case 'instance_path': return `/test/${args.instanceId}`;
          case 'content_list': return (this.entries[args.instanceId] || []).map(x => ({...x}));
          case 'catalog_installed_mods': {
            if (this.failCatalog) throw 'сеть недоступна';
            const snapshot = (this.entries[args.instanceId] || [])
              .filter(x => x.source === args.source).map(x => x.project_id);
            if (this.holdNext[args.instanceId] > 0) {
              this.holdNext[args.instanceId]--;
              return new Promise(resolve => this.held.push({id:args.instanceId,source:args.source,snapshot,resolve}));
            }
            return snapshot;
          }
          case 'search_modrinth': case 'search_curseforge': {
            const prefix = command === 'search_curseforge' ? 'c' : 'm';
            if (args.projectType === 'modpack') return {hits:[{project_id:`pack-${prefix}`,slug:`pack-${prefix}`,title:`Сборка ${prefix}`,description:'тест',project_type:'modpack',categories:[],downloads:1,icon_url:null}],total_hits:1};
            const hits = Array.from({length:140}, (_,i) => {
              const id = ({30:'12345678',31:'87654321',32:'11111111'})[i] || `${prefix}-${i}`;
              return {project_id:id,slug:id,title:`Мод ${prefix} ${i}`,description:'Описание тестового мода',project_type:args.projectType || 'mod',categories:['fabric'],downloads:100,icon_url:null};
            });
            const offset = Number(args.offset) || 0;
            const limit = Number(args.limit) || 24;
            return {hits:hits.slice(offset,offset + limit),total_hits:hits.length};
          }
          case 'modrinth_project': case 'curseforge_project': return {id:args.projectId,slug:args.projectId,title:`Проект ${args.projectId}`,project_type:'mod',description:'тест',categories:[],gallery:[]};
          case 'modrinth_versions': case 'curseforge_versions': return [{id:`version-${args.projectId}`,project_id:args.projectId,name:'1.0',version_number:'1.0',game_versions:['1.21.1'],loaders:['fabric'],date_published:'2026-01-01'}];
          case 'install_mod': case 'install_mod_version': case 'install_curseforge':
          case 'install_modpack': case 'install_curseforge_modpack': {
            const task = {command,args};
            this.pending.push(task);
            return new Promise((resolve,reject) => {task.resolve=resolve; task.reject=reject;});
          }
          case 'open_url': case 'open_path': return null;
          default: return null;
        }
      }
    };
    window.__TAURI__ = {
      core: {invoke: (command,args) => mock.invoke(command,args)},
      event: {listen: async (name,callback) => {callbacks[name] = callback; return () => delete callbacks[name];}}
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('[data-home-id="pack-a"]');
  await page.locator('[data-home-id="pack-a"]').click();
  await page.locator('[data-tab="download"]').click();
  await page.waitForSelector('#mr-results .card[data-project="m-5"]');
  return {page,errors};
}

async function ensureCard(page, rootSelector, cardSelector) {
  for (let i = 0; i < 8 && !(await page.locator(cardSelector).count()); i++) {
    const count = await page.locator(`${rootSelector} .card`).count();
    await page.locator(rootSelector).evaluate(root => { root.scrollTop = root.scrollHeight; });
    await page.waitForFunction(({rootSelector,count,cardSelector}) =>
      document.querySelector(cardSelector) || document.querySelectorAll(`${rootSelector} .card`).length > count,
      {rootSelector,count,cardSelector}, {timeout:10000});
  }
  assert(await page.locator(cardSelector).count(),`не найдена карточка ${cardSelector}`);
}
async function preparePosition(page, rootSelector, cardSelector, query) {
  // Поиск живой: сначала дожидаемся выдачи, затем прокручиваем и устанавливаем.
  await page.locator('#dl-query').fill(query);
  await page.waitForFunction(({rootSelector,query}) => {
    const state = window.omnispecDebug.state;
    const cfg = rootSelector === '#mr-results' ? state.modrinth : state.curseforge;
    return cfg.query === query && cfg.tried && !cfg.loading && !cfg.error;
  }, {rootSelector,query});
  await ensureCard(page,rootSelector,cardSelector);
  const card = page.locator(cardSelector);
  await card.scrollIntoViewIfNeeded();
  await card.locator('.card-actions button').first().scrollIntoViewIfNeeded();
  return await page.evaluate(({rootSelector,cardSelector}) => {
    const root = document.querySelector(rootSelector);
    window.__savedResultRoot = root;
    window.__savedCard = document.querySelector(cardSelector);
    return {top:root.scrollTop, height:root.scrollHeight, client:root.clientHeight, cardHeight:window.__savedCard.getBoundingClientRect().height};
  }, {rootSelector,cardSelector});
}
async function assertPosition(page, rootSelector, cardSelector, before, query) {
  const after = await page.evaluate(({rootSelector,cardSelector}) => ({
    sameRoot: document.querySelector(rootSelector) === window.__savedResultRoot,
    sameCard: document.querySelector(cardSelector) === window.__savedCard,
    top: document.querySelector(rootSelector)?.scrollTop,
    query: document.querySelector('#dl-query')?.value
  }), {rootSelector,cardSelector});
  assert(before.top > 100 && before.height > before.client, `тест должен быть прокручен: ${JSON.stringify(before)}`);
  assert(after.sameRoot && after.sameCard, `список нельзя пересоздавать: ${JSON.stringify(after)}`);
  assert(Math.abs(after.top - before.top) <= 2, `позиция прокрутки изменилась: ${JSON.stringify({before,after})}`);
  assert.equal(after.query,query,'поисковый запрос должен сохраниться');
}
async function pendingCount(page,count) {
  await page.waitForFunction(n => window.__catalogTest.pending.length === n,count);
}
async function clickInstall(page, selector) {
  const index = await page.evaluate(() => window.__catalogTest.pending.length);
  await page.locator(selector).click();
  await pendingCount(page,index + 1);
  return index;
}
async function selectCatalog(page, source, view, gridSize = 3) {
  const button = page.locator(`[data-dl-source="${source}"]`);
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  const root = source === 'modrinth' ? '#mr-results' : '#cf-results';
  await page.waitForSelector(`${root} .card`);
  if (!(await page.locator(`[data-dl-view="${view}"]`).evaluate(el => el.classList.contains('is-active')))) {
    await page.locator(`[data-dl-view="${view}"]`).click();
  }
  if (view === 'grid') {
    await page.locator('#dl-size').evaluate((el,value) => {el.value = String(value); el.dispatchEvent(new Event('input',{bubbles:true}));},gridSize);
  }
}
async function verifyInstallation(page, source, view, mode, number) {
  const prefix = source === 'modrinth' ? 'm' : 'c';
  const id = `${prefix}-${number}`;
  const root = source === 'modrinth' ? '#mr-results' : '#cf-results';
  const card = source === 'modrinth' ? `[data-project="${id}"]` : `[data-cf-project="${id}"]`;
  const query = `${source} ${view} ${mode}`;
  await selectCatalog(page,source,view,view === 'grid' ? 1 : 3);
  const before = await preparePosition(page,root,card,query);
  let selector;
  if (mode === 'version') {
    await page.locator(`${card} ${source === 'modrinth' ? '[data-versions]' : '[data-cf-versions]'}`).click();
    selector = source === 'modrinth' ? `[data-install-version="version-${id}"]` : `[data-cf-install-version="version-${id}"]`;
    await page.waitForSelector(selector);
  } else {
    selector = `${card} ${source === 'modrinth' ? '[data-install]' : '[data-cf-install]'}`;
  }
  // Playwright сам прокручивает элемент, чтобы он стал кликабельным, особенно
  // у высоких плиток и при открытой панели загрузок. Фиксируем позицию ПОСЛЕ
  // этого шага, но ДО реального клика и появления статуса установки.
  await page.locator(selector).click({trial:true});
  before.top = await page.locator(root).evaluate(el => el.scrollTop);
  const index = await clickInstall(page,selector);
  const afterClick = await page.locator(root).evaluate(el => el.scrollTop);
  assert(Math.abs(afterClick - before.top) <= 12,`клик не должен возвращать каталог наверх: до=${before.top}, после=${afterClick}`);
  before.top = afterClick;
  assert(await page.locator(card).evaluate(el => el.classList.contains('is-downloading')));
  assert(!(await page.locator(card).evaluate(el => el.classList.contains('is-installed'))),'не подтверждённый мод не отмечается');
  await page.evaluate(i => window.__catalogTest.complete(i),index);
  await page.waitForFunction(sel => document.querySelector(sel)?.classList.contains('is-installed'),card);
  await assertPosition(page,root,card,before,query);
  assert(await page.locator(`${card} [data-project-status="installed"]`).isVisible(),'текстовый бейдж должен оставаться видимым');
  assert((await page.locator(card).getAttribute('aria-label')).includes('установлен'));
  if (view === 'grid') {
    const height = await page.locator(card).evaluate(el => el.getBoundingClientRect().height);
    assert(Math.abs(height - before.cardHeight) < 1,'статус не должен менять высоту самой мелкой плитки');
  }
  if (mode === 'version') await page.waitForFunction(() => document.querySelector('#modal-versions')?.hidden);
  console.log(`${source.toUpperCase()} ${view} ${mode}: scroll, badge, outline — OK`);
}

(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({headless:true});
  try {
    const {page,errors} = await createPage(browser);
    // Enabled, disabled, imported and old versions all mark the installed project.
    await page.waitForFunction(() => document.querySelector('[data-project="m-5"]')?.classList.contains('is-installed'));
    assert(await page.locator('[data-project="m-6"]').evaluate(el => el.classList.contains('is-installed')));
    assert(await page.locator('[data-project="m-8"]').evaluate(el => el.classList.contains('is-installed')));
    assert(await page.locator('[data-project="m-7"]').evaluate(el => el.classList.contains('is-installed')),'старая версия тоже отмечается');
    assert(await page.locator('#dl-installed-check').isHidden(), 'поясняющая надпись не должна занимать место');
    assert(!(await page.locator('[data-project="m-8"]').getAttribute('aria-label')).includes('актуальная версия'),'наличие не означает актуальность');
    // A delayed answer from the other source must not overwrite the current one.
    await page.evaluate(() => { window.__catalogTest.holdNext['pack-a'] = 1; });
    await page.locator('[data-dl-source="curseforge"]').click();
    await page.waitForFunction(() => window.__catalogTest.held.some(x => x.source === 'curseforge'));
    await page.locator('[data-dl-source="modrinth"]').click();
    await page.waitForFunction(() => document.querySelector('[data-project="m-5"]')?.classList.contains('is-installed'));
    await page.evaluate(() => window.__catalogTest.releaseHeld('pack-a'));
    await page.waitForTimeout(150);
    assert(await page.locator('[data-project="m-5"]').evaluate(el => el.classList.contains('is-installed')));
    // An unavailable service must clear old marks and say the check failed; online retries.
    await page.evaluate(() => { window.__catalogTest.failCatalog = true; });
    await page.locator('[data-dl-source="curseforge"]').click();
    await page.waitForFunction(() => document.querySelector('#dl-installed-check')?.textContent.includes('Не удалось'));
    await page.waitForSelector('[data-cf-project="c-5"]');
    assert(!(await page.locator('[data-cf-project="c-5"]').evaluate(el => el.classList.contains('is-installed'))));
    await page.evaluate(() => { window.__catalogTest.failCatalog = false; window.dispatchEvent(new Event('online')); });
    await page.waitForFunction(() => document.querySelector('[data-cf-project="c-5"]')?.classList.contains('is-installed'));
    assert(await page.locator('#dl-installed-check').isHidden());
    await page.locator('[data-dl-source="modrinth"]').click();
    await page.waitForFunction(() => document.querySelector('[data-project="m-5"]')?.classList.contains('is-installed'));
    console.log('CATALOG_CURRENT: imported/disabled/old, source races, offline retry — OK');
    await ensureCard(page,'#mr-results','[data-project="11111111"]');
    assert(!(await page.locator('[data-project="12345678"]').evaluate(el => el.classList.contains('is-installed'))),'чужой источник с таким же id не отмечается');
    assert(await page.locator('[data-project="87654321"]').evaluate(el => el.classList.contains('is-installed')));
    assert(!(await page.locator('[data-project="11111111"]').evaluate(el => el.classList.contains('is-installed'))),'неизвестный источник не отмечается');
    const colors = await page.evaluate(() => {
      const installed = document.querySelector('[data-project="m-5"]');
      const other = document.querySelector('[data-project="m-10"]');
      return {border:getComputedStyle(installed).borderColor,other:getComputedStyle(other).borderColor,shadow:getComputedStyle(installed).boxShadow};
    });
    assert.notEqual(colors.border,colors.other,'установленный мод должен иметь видимую рамку');
    assert.notEqual(colors.shadow,'none','обводка должна быть толще обычной границы');

    // One file at 100%, and even an early core "done", are not the command result.
    let before = await preparePosition(page,'#mr-results','[data-project="m-60"]','неотправленный текст');
    const first = await clickInstall(page,'[data-project="m-60"] [data-install]');
    const op = await page.evaluate(i => window.__catalogTest.pending[i].args.opId,first);
    assert(op && op.startsWith('install:'),'прогресс установки должен быть привязан к конкретной операции');
    assert(!(await page.locator('[data-project="m-60"]').evaluate(el => el.classList.contains('is-installed'))));
    await page.evaluate(i => window.__catalogTest.progress(i,{done:100,total:100,bytes_done:100,bytes_total:100,file:'m-60.jar'}),first);
    await page.waitForTimeout(3200);
    assert.equal(await page.locator('#dl-panel').isHidden(),false,'100% файла — ещё не конец установки');
    await page.evaluate(i => window.__catalogTest.progress(i,{state:'done',detail:'раннее событие'}),first);
    await page.waitForTimeout(3200);
    assert.equal(await page.evaluate(() => window.omnispecDebug.state.downloads.state),'active','ждём окончательного ответа команды');
    await page.evaluate(i => window.__catalogTest.complete(i),first);
    await page.waitForFunction(() => document.querySelector('[data-project="m-60"]')?.classList.contains('is-installed'));
    await assertPosition(page,'#mr-results','[data-project="m-60"]',before,'неотправленный текст');
    assert((await page.locator('[data-project="m-60"]').getAttribute('aria-label')).includes('установлен'));
    await page.waitForTimeout(2000);
    assert.equal(await page.locator('#dl-panel').isHidden(),false,'сразу после завершения панель остаётся видимой');
    await page.waitForTimeout(1350);
    assert.equal(await page.locator('#dl-panel').isHidden(),true,'панель закрывается примерно через 3 секунды');
    console.log('MODRINTH list direct: file/early done wait, 3s timer, preserved position — OK');

    // All combinations: list/grid × direct/explicit version × both sources.
    await verifyInstallation(page,'modrinth','list','version',61);
    await verifyInstallation(page,'modrinth','grid','direct',75);
    await verifyInstallation(page,'modrinth','grid','version',76);
    await page.setViewportSize({width:840,height:680});
    await verifyInstallation(page,'modrinth','grid','direct',77);
    await page.setViewportSize({width:1280,height:800});
    await selectCatalog(page,'curseforge','list');
    assert(await page.locator('[data-cf-project="c-5"]').evaluate(el => el.classList.contains('is-installed')));
    await ensureCard(page,'#cf-results','[data-cf-project="11111111"]');
    assert(await page.locator('[data-cf-project="12345678"]').evaluate(el => el.classList.contains('is-installed')));
    assert(!(await page.locator('[data-cf-project="87654321"]').evaluate(el => el.classList.contains('is-installed'))));
    assert(!(await page.locator('[data-cf-project="11111111"]').evaluate(el => el.classList.contains('is-installed'))));
    await verifyInstallation(page,'curseforge','list','direct',60);
    await verifyInstallation(page,'curseforge','list','version',61);
    await verifyInstallation(page,'curseforge','grid','direct',75);
    await verifyInstallation(page,'curseforge','grid','version',76);

    // The next request can be silent while it fetches metadata. It must cancel
    // the previous timer immediately; an error must not mark a project installed.
    before = await preparePosition(page,'#cf-results','[data-cf-project="c-85"]','ошибка сети');
    const failed = await clickInstall(page,'[data-cf-project="c-85"] [data-cf-install]');
    const failedOp = await page.evaluate(i => window.__catalogTest.pending[i].args.opId,failed);
    await page.waitForTimeout(3200);
    assert.equal(await page.locator('#dl-panel').isHidden(),false,'новый запрос без событий отменяет старый таймер');
    assert.equal(await page.evaluate(() => window.omnispecDebug.state.downloads.op),failedOp);
    await page.evaluate(i => window.__catalogTest.fail(i),failed);
    await page.waitForFunction(() => window.omnispecDebug.state.downloads.state === 'error');
    await page.waitForFunction(() => !document.querySelector('[data-cf-project="c-85"]')?.classList.contains('is-downloading'));
    assert(!(await page.locator('[data-cf-project="c-85"]').evaluate(el => el.classList.contains('is-installed'))));
    await page.waitForFunction(() => !document.querySelector('[data-cf-project="c-85"] [data-cf-install]')?.disabled);
    await assertPosition(page,'#cf-results','[data-cf-project="c-85"]',before,'ошибка сети');
    await page.waitForTimeout(3200);
    assert(await page.locator('#dl-panel').isHidden(),'панель ошибки также скрывается через 3 секунды');

    before = await preparePosition(page,'#cf-results','[data-cf-project="c-86"]','без подтверждения');
    const unknown = await clickInstall(page,'[data-cf-project="c-86"] [data-cf-install]');
    await page.evaluate(i => window.__catalogTest.complete(i,false),unknown);
    await page.waitForFunction(() => !document.querySelector('[data-cf-project="c-86"]')?.classList.contains('is-downloading'));
    assert(!(await page.locator('[data-cf-project="c-86"]').evaluate(el => el.classList.contains('is-installed'))),'пропущенный файл без записи не подтверждает проект');
    await assertPosition(page,'#cf-results','[data-cf-project="c-86"]',before,'без подтверждения');
    console.log('ERROR_AND_UNCONFIRMED: no false installed status; new requests cancel old timer — OK');

    // Parallel tracked installations: older events cannot hide or replace a newer
    // active operation, and after the newer one finishes we return to the older one.
    await selectCatalog(page,'modrinth','grid',1);
    await ensureCard(page,'#mr-results','[data-project="m-93"]');
    let older = await clickInstall(page,'[data-project="m-90"] [data-install]');
    let newer = await clickInstall(page,'[data-project="m-91"] [data-install]');
    let newerOp = await page.evaluate(i => window.__catalogTest.pending[i].args.opId,newer);
    await page.evaluate(i => window.__catalogTest.complete(i),older);
    await page.waitForFunction(() => document.querySelector('[data-project="m-90"]')?.classList.contains('is-installed'));
    await page.evaluate(i => window.__catalogTest.progress(i,{done:20,total:100,file:'late.jar',bytes_done:20,bytes_total:100}),older);
    await page.waitForTimeout(3200);
    assert.equal(await page.evaluate(() => window.omnispecDebug.state.downloads.op),newerOp);
    assert.equal(await page.evaluate(() => window.omnispecDebug.state.downloads.state),'active');
    assert.equal(await page.locator('#dl-panel').isHidden(),false);
    await page.evaluate(i => window.__catalogTest.complete(i),newer);
    await page.waitForFunction(() => document.querySelector('[data-project="m-91"]')?.classList.contains('is-installed'));

    older = await clickInstall(page,'[data-project="m-92"] [data-install]');
    newer = await clickInstall(page,'[data-project="m-93"] [data-install]');
    const olderOp = await page.evaluate(i => window.__catalogTest.pending[i].args.opId,older);
    await page.evaluate(i => window.__catalogTest.progress(i,{done:20,total:100,file:'older.jar',bytes_done:20,bytes_total:100}),older);
    await page.evaluate(i => window.__catalogTest.complete(i),newer);
    await page.waitForFunction(opId => window.omnispecDebug.state.downloads.op === opId,olderOp);
    await page.waitForTimeout(3200);
    assert.equal(await page.evaluate(() => window.omnispecDebug.state.downloads.state),'active');
    assert.equal(await page.locator('#dl-panel').isHidden(),false);
    await page.evaluate(i => window.__catalogTest.complete(i),older);
    await page.waitForFunction(() => document.querySelector('[data-project="m-92"]')?.classList.contains('is-installed'));
    console.log('PROGRESS_RACES: old/new completion order and delayed events — OK');

    // Finish in pack A while pack B is selected; then deliver a stale B response
    // after returning to A. Neither response can mark the wrong pack.
    const previousPack = await clickInstall(page,'[data-project="m-82"] [data-install]');
    await page.evaluate(() => {window.__catalogTest.holdNext['pack-b']=1;});
    await page.locator('.instance[data-id="pack-b"]').last().click();
    await page.locator('[data-tab="download"]').click();
    await page.waitForFunction(() => window.__catalogTest.held.some(x => x.id === 'pack-b'));
    await ensureCard(page,'#mr-results','[data-project="m-82"]');
    await page.evaluate(i => window.__catalogTest.complete(i),previousPack);
    await page.waitForFunction(i => window.omnispecDebug.state.downloads.op === window.__catalogTest.pending[i].args.opId
      && window.omnispecDebug.state.downloads.state === 'done',previousPack);
    assert(!(await page.locator('[data-project="m-82"]').evaluate(el => el.classList.contains('is-installed'))),'фоновая установка не отмечается в чужой сборке');
    await page.locator('.instance[data-id="pack-a"]').last().click();
    await page.locator('[data-tab="download"]').click();
    await page.evaluate(() => window.__catalogTest.releaseHeld('pack-b'));
    await ensureCard(page,'#mr-results','[data-project="m-82"]');
    await page.waitForFunction(() => document.querySelector('[data-project="m-82"]')?.classList.contains('is-installed'));
    assert(!(await page.locator('[data-project="m-9"]').evaluate(el => el.classList.contains('is-installed'))),'опоздавший ответ другой сборки проигнорирован');
    await page.locator('.instance[data-id="pack-b"]').last().click();
    await page.locator('[data-tab="download"]').click();
    await page.waitForFunction(() => document.querySelector('[data-project="m-9"]')?.classList.contains('is-installed'));
    await ensureCard(page,'#mr-results','[data-project="m-82"]');
    assert(!(await page.locator('[data-project="m-82"]').evaluate(el => el.classList.contains('is-installed'))));
    console.log('INSTANCE_RACES: background install and stale responses stay isolated — OK');

    // Modpack downloads can hit 4/4 before the archive is unpacked. Both
    // sources must keep the panel open until the install command returns.
    await page.locator('#btn-home').click();
    await page.waitForSelector('#dv-results [data-project="pack-m"] [data-install]');
    let pack = await clickInstall(page,'#dv-results [data-project="pack-m"] [data-install]');
    await page.evaluate(i => window.__catalogTest.progress(i,{done:4,total:4,detail:'файлов 4/4'}),pack);
    await page.waitForTimeout(3200);
    assert.equal(await page.evaluate(() => window.omnispecDebug.state.downloads.state),'active','4/4 модпака не означает конец распаковки');
    assert.equal(await page.locator('#dl-panel').isHidden(),false);
    await page.evaluate(i => window.__catalogTest.completePack(i),pack);
    await page.waitForFunction(() => window.omnispecDebug.state.downloads.state === 'done');
    await page.waitForFunction(() => window.omnispecDebug.state.selectedId === 'pack-a');
    await page.locator('#btn-home').click();
    await page.locator('[data-dv-source="curseforge"]').click();
    await page.waitForSelector('#dv-results [data-cf-project="pack-c"] [data-cf-pack-install]');
    pack = await clickInstall(page,'#dv-results [data-cf-project="pack-c"] [data-cf-pack-install]');
    await page.evaluate(i => window.__catalogTest.progress(i,{done:4,total:4,detail:'файлов 4/4'}),pack);
    await page.waitForTimeout(3200);
    assert.equal(await page.evaluate(() => window.omnispecDebug.state.downloads.state),'active');
    assert.equal(await page.locator('#dl-panel').isHidden(),false);
    await page.evaluate(i => window.__catalogTest.completePack(i),pack);
    await page.waitForFunction(() => window.omnispecDebug.state.downloads.state === 'done');
    assert.equal(await page.evaluate(() => window.__catalogTest.calls.filter(x => x.command === 'open_url').length),0,'установка не открывает сайт');
    console.log('MODPACK_PROGRESS: both sources wait for the full command; no redirect — OK');
    assert.deepEqual(errors,[]);
    await page.close();
  } finally {
    await browser.close(); server.close();
  }
})().catch(err => {console.error(err); server.close(); process.exitCode=1;});
