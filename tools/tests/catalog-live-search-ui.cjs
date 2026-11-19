// Живой поиск и общие контролы обоих каталогов: без реальной сети, с задержанными ответами.
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
    const ext = path.extname(file);
    const type = ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[ext] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type': type}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function openPage(browser) {
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(() => {
    const now = Math.floor(Date.now() / 1000);
    const instances = [
      {id:'alpha',name:'Alpha',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16'},created:now,playtime_secs:0,icon:null},
      {id:'beta',name:'Beta',mc_version:'1.20.1',loader:{type:'forge',version:'47'},created:now,playtime_secs:0,icon:null}
    ];
    const defaults = {theme:'dark',click_fx:'off',ambient:'off',trail:false,onboarded:true,discord_rpc:false,update_enabled:false,mr_grid:3};
    const saved = localStorage.getItem('omnispec-live-settings');
    const mock = window.__liveCatalog = {
      settings: saved ? JSON.parse(saved) : {...defaults}, calls:[], holdRules:[], held:[],
      hold(source, query, offset = 0) { this.holdRules.push({source,query,offset}); },
      release(source, query, offset = 0, fail = false) {
        const pending = this.held.find(x => x.source === source && x.query === query && x.offset === offset && !x.released);
        if (!pending) throw new Error(`No held request: ${source} ${query} ${offset}`);
        pending.released = true;
        if (fail) pending.reject(new Error('поздний сетевой сбой'));
        else pending.resolve();
      },
      async search(source, args) {
        const {query = '', offset = 0, projectType = 'mod'} = args;
        this.calls.push({source, ...args});
        const rule = this.holdRules.findIndex(x => x.source === source && x.query === query && x.offset === offset);
        if (rule >= 0) {
          this.holdRules.splice(rule, 1);
          await new Promise((resolve,reject) => this.held.push({source,query,offset,resolve,reject,released:false}));
        }
        const hit = (id,title) => ({project_id:id,slug:id,title,description:'тестовая карточка',project_type:projectType,categories:['fabric'],downloads:10,icon_url:null});
        if (query === 'no matches') return {hits:[],total_hits:0};
        if (query.startsWith('auto-fill-')) {
          const count = Math.max(0,Math.min(24,75-offset));
          return {hits:Array.from({length:count}, (_,i) => hit(`${source}-${query}-${offset+i}`,`${source} ${query} ${offset+i}`)),total_hits:75};
        }
        if (query.startsWith('page-old')) {
          if (offset === 0) return {hits:Array.from({length:24}, (_,i) => hit(`${source}-${query}-${i}`,`${source} ${query} ${i}`)),total_hits:25};
          return {hits:[hit(`${source}-late-page`,'УСТАРЕВШАЯ ДОГРУЗКА')],total_hits:25};
        }
        const instanceInfo = query.startsWith('instance-race-') ? ` ${args.mcVersion} ${args.loader}` : '';
        return {hits:[hit(`${source}-${query || 'popular'}`,`${source} ${query || 'popular'}${instanceInfo}`)],total_hits:1};
      },
      async invoke(command, args = {}) {
        switch (command) {
          case 'get_settings': return {...this.settings};
          case 'save_settings': this.settings = {...args.settings}; localStorage.setItem('omnispec-live-settings',JSON.stringify(this.settings)); return null;
          case 'accounts_info': return {accounts:[{uuid:'u',username:'Steve',kind:'offline'}],active:'u'};
          case 'list_instances': return instances.map(x => ({...x}));
          case 'running_instances': return [];
          case 'catalog_installed_mods': case 'content_list': case 'list_java': return [];
          case 'version_info': return {version:'test',enabled:false};
          case 'search_modrinth': return this.search('modrinth',args);
          case 'search_curseforge': return this.search('curseforge',args);
          default: return null;
        }
      }
    };
    window.__TAURI__ = {core:{invoke:(command,args) => mock.invoke(command,args)},event:{listen:async () => () => {}}};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('[data-home-id="alpha"]');
  await page.locator('[data-home-id="alpha"]').click();
  await page.locator('[data-tab="download"]').click();
  await page.waitForSelector('#mr-results .card');
  return {page,errors};
}

async function waitQuery(page, source, query, root) {
  await page.waitForFunction(({source,query}) => window.__liveCatalog.calls.some(c => c.source === source && c.query === query && c.offset === 0), {source,query});
  await page.waitForFunction(({root,query}) => {
    const el = document.querySelector(root);
    return !!el && (query === 'no matches' ? el.textContent.includes('Ничего не найдено') : el.textContent.includes(query || 'popular'));
  }, {root,query});
}
async function switchSource(page, scope, source) {
  await page.locator(`[data-${scope}-source="${source}"]`).click();
  assert.equal(await page.locator(`[data-${scope}-source="${source}"]`).getAttribute('aria-pressed'),'true');
  const other = source === 'modrinth' ? 'curseforge' : 'modrinth';
  assert.equal(await page.locator(`[data-${scope}-source="${other}"]`).getAttribute('aria-pressed'),'false');
}

(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({headless:true});
  try {
    const {page,errors} = await openPage(browser);
    assert.equal((await page.locator('[data-tab="download"]').innerText()).trim(),'Загрузить');
    assert.equal(await page.locator('#dl-source').count(),0,'выпадающего списка источника быть не должно');
    assert(await page.locator('#dl-installed-check').isHidden());
    assert.equal(await page.locator('[data-dl-source]').count(),2);
    assert.equal(await page.locator('[data-dl-source="modrinth"] use').getAttribute('href'),'#i-modrinth');
    assert.equal(await page.locator('[data-dl-source="curseforge"] use').getAttribute('href'),'#i-curseforge');
    assert.equal(await page.locator('[data-dl-source="modrinth"]').getAttribute('aria-pressed'),'true');
    assert(!(await page.locator('#mr-results').evaluate(e => e.classList.contains('is-grid'))),'оба источника начинают с одного вида');

    // Быстрый набор объединяется в один запрос; поиск запускается без Enter.
    await page.locator('#dl-query').fill('S');
    await page.locator('#dl-query').fill('So');
    await page.locator('#dl-query').fill('Sodium');
    await waitQuery(page,'modrinth','Sodium','#mr-results');
    assert.equal(await page.evaluate(() => window.__liveCatalog.calls.filter(c => c.source === 'modrinth' && ['S','So'].includes(c.query)).length),0);
    assert.equal(await page.locator('#dl-query').inputValue(),'Sodium');
    assert.equal(await page.evaluate(() => document.activeElement.id),'dl-query');
    const args = await page.evaluate(() => window.__liveCatalog.calls.find(c => c.source === 'modrinth' && c.query === 'Sodium'));
    assert.equal(args.mcVersion,'1.21.1'); assert.equal(args.loader,'fabric');

    // Ввод IME не должен отправлять неполную композицию.
    await page.locator('#dl-query').evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      el.value = 'черновик';
      // Некоторые WebView не выставляют isComposing даже во время композиции.
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'черновик',isComposing:false}));
      el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',isComposing:false}));
    });
    await page.waitForTimeout(420);
    assert.equal(await page.evaluate(() => window.__liveCatalog.calls.filter(c => c.query === 'черновик').length),0);
    await page.locator('#dl-query').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'черновик'})));
    await waitQuery(page,'modrinth','черновик','#mr-results');

    // Одинаковые фильтры следуют за пользователем в обоих направлениях.
    // Особенный тип «модпаки» и сортировка сохраняются только на CurseForge.
    await page.locator('#dl-query').fill('filter-check');
    await waitQuery(page,'modrinth','filter-check','#mr-results');
    await page.locator('#mr-mc').selectOption('1.20.1');
    await page.locator('#mr-loader').selectOption('forge');
    await page.locator('#mr-type').selectOption('resourcepack');
    await switchSource(page,'dl','curseforge');
    await waitQuery(page,'curseforge','filter-check','#cf-results');
    assert.equal(await page.locator('#cf-type').inputValue(),'resourcepack');
    assert.equal(await page.locator('#cf-mc').inputValue(),'1.20.1');
    let last = await page.evaluate(() => window.__liveCatalog.calls.filter(c => c.source === 'curseforge').at(-1));
    assert.equal(last.projectType,'resourcepack'); assert.equal(last.mcVersion,'1.20.1'); assert.equal(last.loader,null);
    await page.locator('#cf-sort').selectOption('newest');
    await page.locator('#cf-type').selectOption('mod');
    assert.equal(await page.locator('#cf-loader').inputValue(),'forge');
    await page.locator('#cf-loader').selectOption('fabric');
    await switchSource(page,'dl','modrinth');
    await waitQuery(page,'modrinth','filter-check','#mr-results');
    assert.equal(await page.locator('#mr-type').inputValue(),'mod');
    assert.equal(await page.locator('#mr-mc').inputValue(),'1.20.1');
    assert.equal(await page.locator('#mr-loader').inputValue(),'fabric');
    last = await page.evaluate(() => window.__liveCatalog.calls.filter(c => c.source === 'modrinth').at(-1));
    assert.equal(last.projectType,'mod'); assert.equal(last.mcVersion,'1.20.1'); assert.equal(last.loader,'fabric');
    await switchSource(page,'dl','curseforge');
    assert.equal(await page.locator('#cf-sort').inputValue(),'newest');
    await page.locator('#cf-type').selectOption('modpack');
    await switchSource(page,'dl','modrinth');
    assert.equal(await page.locator('#mr-type').inputValue(),'mod','тип, которого нет в Modrinth, не должен его ломать');
    await switchSource(page,'dl','curseforge');
    assert.equal(await page.locator('#cf-type').inputValue(),'modpack','особенный тип CurseForge сохраняется при возврате');
    await switchSource(page,'dl','modrinth');
    await page.locator('#mr-type').selectOption('shader');
    await switchSource(page,'dl','curseforge');
    assert.equal(await page.locator('#cf-type').inputValue(),'shader','явно изменённый общий тип синхронизируется');
    assert.equal(await page.locator('#cf-sort').inputValue(),'newest');
    await page.locator('#cf-type').selectOption('mod');
    await page.locator('#cf-mc').selectOption('');
    await page.locator('#cf-loader').selectOption('');
    await page.locator('#cf-sort').selectOption('downloads');
    await switchSource(page,'dl','modrinth');
    await waitQuery(page,'modrinth','filter-check','#mr-results');

    // Выбранный режим и размер одинаковы при переключении, а фраза не сбрасывается.
    await page.locator('[data-dl-view="grid"]').click();
    assert(await page.locator('#mr-results').evaluate(e => e.classList.contains('is-grid')));
    await page.locator('#dl-size').evaluate(el => {el.value='1'; el.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.locator('#dl-query').fill('общий запрос');
    await switchSource(page,'dl','curseforge'); // нажали до истечения debounce
    await waitQuery(page,'curseforge','общий запрос','#cf-results');
    assert.equal(await page.locator('#dl-query').inputValue(),'общий запрос');
    assert(await page.locator('#cf-results').evaluate(e => e.classList.contains('is-grid') && e.classList.contains('feed-grid-1')));
    assert.equal(await page.evaluate(() => window.__liveCatalog.calls.filter(c => c.source === 'modrinth' && c.query === 'общий запрос').length),0);
    await page.locator('[data-dl-view="list"]').click();
    assert(!(await page.locator('#cf-results').evaluate(e => e.classList.contains('is-grid'))));
    await switchSource(page,'dl','modrinth');
    await waitQuery(page,'modrinth','общий запрос','#mr-results');
    assert(!(await page.locator('#mr-results').evaluate(e => e.classList.contains('is-grid'))));
    const colors = await page.evaluate(() => ({
      active:getComputedStyle(document.querySelector('[data-dl-source="modrinth"]')).color,
      inactive:getComputedStyle(document.querySelector('[data-dl-source="curseforge"]')).color
    }));
    assert.notEqual(colors.active,colors.inactive,'активный источник должен подсвечиваться');

    // Старый первый запрос, включая ошибку, не может подменить новый ответ.
    await page.evaluate(() => window.__liveCatalog.hold('modrinth','slow'));
    await page.locator('#dl-query').fill('slow');
    await page.waitForFunction(() => window.__liveCatalog.held.some(x => x.query === 'slow'));
    await page.locator('#dl-query').fill('fresh');
    // Ошибка приходит ещё до истечения debounce: её нельзя показать даже на мгновение.
    await page.evaluate(() => window.__liveCatalog.release('modrinth','slow',0,true));
    await page.waitForTimeout(80);
    assert(!(await page.locator('#mr-results').innerText()).includes('поздний сетевой сбой'));
    await waitQuery(page,'modrinth','fresh','#mr-results');
    assert((await page.locator('#mr-results').innerText()).includes('fresh'));

    // Другая сборка требует новой версии MC и загрузчика, даже если фраза та же.
    for (const source of ['modrinth','curseforge']) {
      if (source === 'curseforge') await switchSource(page,'dl',source);
      const results = source === 'modrinth' ? '#mr-results' : '#cf-results';
      const query = `instance-race-${source}`;
      await page.evaluate(({source,query}) => window.__liveCatalog.hold(source,query),{source,query});
      await page.locator('#dl-query').fill(query);
      await page.waitForFunction(({source,query}) => window.__liveCatalog.held.some(x => x.source === source && x.query === query),{source,query});
      await page.locator('.instance[data-id="beta"]').last().click();
      await page.locator('[data-tab="download"]').click();
      await page.waitForFunction(({results}) => document.querySelector(results)?.textContent.includes('1.20.1 forge'),{results});
      await page.evaluate(({source,query}) => window.__liveCatalog.release(source,query),{source,query});
      await page.waitForTimeout(100);
      assert((await page.locator(results).innerText()).includes('1.20.1 forge'));
      assert(!(await page.locator(results).innerText()).includes('1.21.1 fabric'),'ответ прежней сборки должен игнорироваться');
      assert.equal(await page.locator('#dl-query').inputValue(),query);
      await page.locator('.instance[data-id="alpha"]').last().click();
      await page.locator('[data-tab="download"]').click();
      await page.waitForFunction(({results}) => document.querySelector(results)?.textContent.includes('1.21.1 fabric'),{results});
    }
    await switchSource(page,'dl','modrinth');

    // Поздняя догрузка прежней фразы не добавляется к новой выдаче (оба API).
    for (const source of ['modrinth','curseforge']) {
      if (source === 'curseforge') await switchSource(page,'dl',source);
      const results = source === 'modrinth' ? '#mr-results' : '#cf-results';
      const sentinel = source === 'modrinth' ? '#mr-sentinel' : '#cf-sentinel';
      const old = `page-old-${source}`;
      await page.evaluate(({source,old}) => window.__liveCatalog.hold(source,old,24),{source,old});
      await page.locator('#dl-query').fill(old);
      await page.waitForFunction(sel => document.querySelectorAll(`${sel} .card`).length === 24,results);
      await page.locator(sentinel).scrollIntoViewIfNeeded();
      await page.waitForFunction(({source,old}) => window.__liveCatalog.held.some(x => x.source === source && x.query === old && x.offset === 24),{source,old});
      await page.locator('#dl-query').fill(`new-${source}`);
      await page.evaluate(({source,old}) => window.__liveCatalog.release(source,old,24),{source,old});
      await page.waitForTimeout(80);
      assert(!(await page.locator(results).innerText()).includes('УСТАРЕВШАЯ ДОГРУЗКА'));
      await waitQuery(page,source,`new-${source}`,results);
      assert(!(await page.locator(results).innerText()).includes('УСТАРЕВШАЯ ДОГРУЗКА'));
    }

    // При высокой области выдачи sentinel остаётся видимым между страницами:
    // плитка должна продолжать догрузку до заполнения области или конца выдачи.
    await page.setViewportSize({width:1280,height:2400});
    await switchSource(page,'dl','modrinth');
    await page.locator('[data-dl-view="grid"]').click();
    for (const source of ['modrinth','curseforge']) {
      if (source === 'curseforge') await switchSource(page,'dl',source);
      const results = source === 'modrinth' ? '#mr-results' : '#cf-results';
      const query = `auto-fill-${source}`;
      await page.locator('#dl-query').fill(query);
      await page.waitForFunction(sel => document.querySelectorAll(`${sel} .card`).length === 75,results,{timeout:7000});
      const offsets = await page.evaluate(({source,query}) => window.__liveCatalog.calls.filter(c => c.source === source && c.query === query).map(c => c.offset),{source,query});
      assert.deepEqual(offsets,[0,24,48,72]);
    }
    await page.setViewportSize({width:1280,height:800});
    await page.locator('#dl-query').fill('no matches');
    await waitQuery(page,'curseforge','no matches','#cf-results');
    assert(!(await page.locator('#cf-results').innerText()).includes('Enter'));
    await page.locator('#dl-query').fill('');
    await waitQuery(page,'curseforge','','#cf-results');

    // Сохранение не зависит от источника и переживает перезапуск UI.
    await page.locator('[data-dl-view="grid"]').click();
    await page.waitForFunction(() => window.__liveCatalog.settings.mods_view === 'grid' && window.__liveCatalog.settings.mods_grid === 1);
    await page.reload();
    await page.waitForSelector('[data-home-id="alpha"]');
    await page.locator('[data-home-id="alpha"]').click();
    await page.locator('[data-tab="download"]').click();
    await page.waitForSelector('#mr-results .card');
    assert(await page.locator('#mr-results').evaluate(e => e.classList.contains('is-grid') && e.classList.contains('feed-grid-1')));
    assert.equal(await page.locator('#dl-size').inputValue(),'1');
    await switchSource(page,'dl','curseforge');
    await page.waitForSelector('#cf-results .card');
    assert(await page.locator('#cf-results').evaluate(e => e.classList.contains('is-grid') && e.classList.contains('feed-grid-1')));

    // Главная: те же две кнопки и живой поиск готовых сборок.
    await page.locator('#btn-home').click();
    await page.waitForSelector('#dv-results .card');
    assert.equal(await page.locator('#dv-source').count(),0);
    await page.locator('#dv-query').fill('home phrase');
    await waitQuery(page,'modrinth','home phrase','#dv-results');
    await page.locator('[data-dv-view="list"]').click();
    await switchSource(page,'dv','curseforge');
    await waitQuery(page,'curseforge','home phrase','#dv-results');
    assert.equal(await page.locator('#dv-query').inputValue(),'home phrase');
    assert(!(await page.locator('#dv-results').evaluate(e => e.classList.contains('is-grid'))));
    await page.locator('#dv-query').evaluate(el => {
      el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      el.value='home draft';
      el.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:false}));
      el.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter',isComposing:false}));
    });
    await page.waitForTimeout(420);
    assert.equal(await page.evaluate(() => window.__liveCatalog.calls.filter(c => c.query === 'home draft').length),0);
    await page.locator('#dv-query').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
    await waitQuery(page,'curseforge','home draft','#dv-results');
    await page.evaluate(() => window.__liveCatalog.hold('curseforge','page-old-home',24));
    await page.locator('#dv-query').fill('page-old-home');
    await page.waitForFunction(() => document.querySelectorAll('#dv-results .card').length === 24);
    await page.locator('#dv-sentinel').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => window.__liveCatalog.held.some(x => x.query === 'page-old-home' && x.offset === 24));
    await page.locator('#dv-query').fill('home-new');
    await page.evaluate(() => window.__liveCatalog.release('curseforge','page-old-home',24));
    await page.waitForTimeout(80);
    assert(!(await page.locator('#dv-results').innerText()).includes('УСТАРЕВШАЯ ДОГРУЗКА'));
    await waitQuery(page,'curseforge','home-new','#dv-results');

    // Фирменная подсветка остаётся контрастной на светлой теме.
    await page.evaluate(() => localStorage.setItem('omnispec-live-settings',JSON.stringify({...window.__liveCatalog.settings,theme:'light'})));
    await page.reload();
    await page.waitForSelector('[data-home-id="alpha"]');
    await page.locator('[data-home-id="alpha"]').click();
    await page.locator('[data-tab="download"]').click();
    assert.equal(await page.locator('[data-dl-source="modrinth"]').evaluate(e => getComputedStyle(e).color),'rgb(8, 123, 66)');
    await switchSource(page,'dl','curseforge');
    // Цвет анимируется: проверяем конечное значение, а не промежуточный кадр.
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-dl-source="curseforge"]')).color === 'rgb(191, 63, 25)');
    assert.deepEqual(errors,[]);
    console.log('LIVE_CATALOG: shared filters/view, persistence, colors, IME, instance/source races and pagination — OK');
    await page.close();
  } finally { await browser.close(); server.close(); }
})().catch(error => {console.error(error); server.close(); process.exitCode=1;});
