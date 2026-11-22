// Клавиатурные регрессии: выбор фильтров не должен запускать игру, а
// перерисовка не должна забирать фокус у изменённого элемента управления.
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
    res.writeHead(200, {'Content-Type': type}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function createPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.addInitScript(() => {
    const now = Math.floor(Date.now() / 1000);
    const instance = {id:'keyboard-test',name:'Клавиатура',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16.0'},created:now,playtime_secs:0,icon:null};
    const calls = window.__keyboardCalls = [];
    const invoke = async (command, args = {}) => {
      calls.push({command, args});
      switch (command) {
        case 'get_settings': return {theme:'dark',click_fx:'off',ambient:'off',trail:false,onboarded:true,discord_rpc:false,update_enabled:false};
        case 'save_settings': return null;
        case 'accounts_info': return {accounts:[{uuid:'user',username:'Steve',kind:'offline'}],active:'user'};
        case 'list_instances': return [{...instance}];
        case 'running_instances': return [];
        case 'version_info': return {version:'test',enabled:false};
        case 'list_java': case 'content_list': return [];
        case 'search_modrinth': case 'search_curseforge': {
          // Есть и промежуточная, и финальная перерисовка.
          if (window.__heldSearch && window.__heldSearch.command === command && !window.__heldSearch.resolve) {
            await new Promise(resolve => { window.__heldSearch.resolve = resolve; });
          } else {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          const source = command === 'search_modrinth' ? 'mr' : 'cf';
          return {hits:[{project_id:`${source}-test`,slug:`${source}-test`,title:`${source} test`,description:'test',project_type:args.projectType || 'mod',categories:['fabric'],downloads:1,icon_url:null}],total_hits:1};
        }
        case 'launch_instance': return {run_id:'keyboard-run',java:'java',java_major:21,memory_mb:2048,classpath_entries:0};
        default: return null;
      }
    };
    window.__TAURI__ = {core:{invoke},event:{listen:async () => () => {}}};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('[data-home-id="keyboard-test"]');
  await page.locator('[data-home-id="keyboard-test"]').click();
  await page.locator('[data-tab="download"]').click();
  await page.waitForSelector('#mr-results .card');
  return {page, errors};
}

const launches = page => page.evaluate(() => window.__keyboardCalls.filter(x => x.command === 'launch_instance').length);
async function noLaunch(page, label) {
  await page.waitForTimeout(150);
  assert.equal(await launches(page), 0, `${label}: игра не должна запускаться`);
}
async function changeSelect(page, selector, key, resultRoot) {
  await page.locator(selector).focus();
  const before = await page.evaluate(() => window.__keyboardCalls.filter(x => x.command.startsWith('search_')).length);
  await page.keyboard.press(key); // открывает стилизованный listbox и ставит фокус на option
  await page.keyboard.press('Enter'); // выбрать Home/End-позицию
  await page.waitForFunction(n => window.__keyboardCalls.filter(x => x.command.startsWith('search_')).length > n, before);
  await page.waitForSelector(`${resultRoot} .card`);
  await page.waitForTimeout(180); // ответ поиска тоже мог перерисовать фильтры
  assert.equal(await page.evaluate(() => document.activeElement.id), selector.slice(1), `${selector}: фокус потерялся`);
  await page.keyboard.press('Enter'); // снова открыть меню
  await noLaunch(page, selector);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement.id), selector.slice(1), `${selector}: фокус потерялся после Escape`);
}
async function changeSource(page, scope, source, key = 'Enter') {
  const selector = `[data-${scope}-source="${source}"]`;
  const root = scope === 'dv' ? '#dv-results' : (source === 'curseforge' ? '#cf-results' : '#mr-results');
  await page.locator(selector).focus();
  await page.keyboard.press(key);
  await page.waitForSelector(`${root} .card`);
  assert.equal(await page.locator(selector).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.id), `${scope}-source-${source}`, 'кнопка источника потеряла фокус');
  await noLaunch(page, `${scope}: выбор источника клавишей ${key}`);
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true});
  try {
    const {page, errors} = await createPage(browser);
    await changeSource(page, 'dl', 'curseforge', 'Space');
    await changeSource(page, 'dl', 'modrinth', 'Enter');
    await changeSource(page, 'dl', 'curseforge', 'Enter');
    await changeSelect(page, '#cf-type', 'End', '#cf-results');
    await changeSelect(page, '#cf-type', 'Home', '#cf-results');
    await changeSelect(page, '#cf-mc', 'End', '#cf-results');
    await changeSelect(page, '#cf-loader', 'End', '#cf-results');
    await changeSelect(page, '#cf-sort', 'End', '#cf-results');
    await changeSource(page, 'dl', 'modrinth', 'Space');
    await changeSelect(page, '#mr-type', 'End', '#mr-results');
    await changeSelect(page, '#mr-type', 'Home', '#mr-results');
    // Версия и загрузчик пришли из CurseForge, поэтому здесь выбираем начало.
    await changeSelect(page, '#mr-mc', 'Home', '#mr-results');
    await changeSelect(page, '#mr-loader', 'Home', '#mr-results');

    // Если пользователь сам перевёл фокус, запоздавший ответ не должен его красть.
    await page.evaluate(() => { window.__heldSearch = {command:'search_modrinth', resolve:null}; });
    await page.locator('#mr-type').focus();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => typeof window.__heldSearch.resolve === 'function');
    await page.locator('#dl-query').focus();
    await page.evaluate(() => window.__heldSearch.resolve());
    await page.waitForSelector('#mr-results .card');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'dl-query', 'ответ поиска не должен красть фокус');
    await page.evaluate(() => { window.__heldSearch = null; });
    await changeSelect(page, '#mr-type', 'Home', '#mr-results');

    await page.locator('[data-dl-view="grid"]').focus();
    await page.keyboard.press('Enter');
    assert(await page.locator('[data-dl-view="grid"]').evaluate(el => el.classList.contains('is-active')));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.dlView), 'grid', 'фокус кнопки вида каталога потерялся');
    await page.keyboard.press('Enter');
    await noLaunch(page, 'кнопка вида каталога');

    const searches = await page.evaluate(() => window.__keyboardCalls.filter(x => x.command === 'search_modrinth').length);
    await page.locator('#dl-query').fill('keyboard search');
    await page.keyboard.press('Enter');
    await page.waitForFunction(n => window.__keyboardCalls.filter(x => x.command === 'search_modrinth').length > n, searches);
    assert.equal(await page.locator('#dl-query').inputValue(), 'keyboard search');
    await page.waitForSelector('#mr-results .card');
    await noLaunch(page, 'поиск по Enter');

    // Запоздавший ответ предыдущего источника не подменяет текущий каталог.
    for (const [oldSource, newSource, newRoot, oldRoot] of [
      ['modrinth', 'curseforge', '#cf-results', '#mr-results'],
      ['curseforge', 'modrinth', '#mr-results', '#cf-results'],
    ]) {
      await page.evaluate(command => { window.__heldSearch = {command, resolve:null}; }, `search_${oldSource}`);
      await page.locator('#dl-query').fill(`held ${oldSource}`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => typeof window.__heldSearch.resolve === 'function');
      await changeSource(page, 'dl', newSource, 'Space');
      await page.evaluate(() => window.__heldSearch.resolve());
      await page.waitForTimeout(250);
      assert.equal(await page.locator(oldRoot).count(), 0, 'старый ответ не должен рисовать чужой источник');
      assert(await page.locator(`${newRoot} .card`).count(), 'текущий источник должен оставаться на экране');
      assert.equal(await page.evaluate(() => document.activeElement.id), `dl-source-${newSource}`);
      await noLaunch(page, 'поздний ответ другого источника');
      await page.evaluate(() => { window.__heldSearch = null; });
    }

    await page.locator('#btn-home').click();
    await page.waitForSelector('[data-dv-source="curseforge"]');
    await changeSource(page, 'dv', 'curseforge', 'Enter');
    await page.locator('[data-dv-view="list"]').focus();
    await page.keyboard.press('Enter');
    assert(await page.locator('[data-dv-view="list"]').evaluate(el => el.classList.contains('is-active')));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.dvView), 'list', 'фокус кнопки вида главной потерялся');
    await page.keyboard.press('Enter');
    await noLaunch(page, 'кнопка вида главной');

    await page.evaluate(() => document.activeElement.blur());
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'BODY');
    await page.keyboard.press('Enter');
    await noLaunch(page, 'Enter без выбранной кнопки');
    await page.evaluate(() => { document.querySelector('#modal-project').hidden = false; });
    await page.keyboard.press('Enter');
    await noLaunch(page, 'Enter в открытом диалоге');
    await page.evaluate(() => { document.querySelector('#modal-project').hidden = true; });
    assert.deepEqual(errors, []);
    await page.close();

    // Нормальное управление сохраняется: явно выбранная кнопка запуска
    // по-прежнему нажимается как Enter, так и пробелом.
    for (const key of ['Enter', 'Space']) {
      const check = await createPage(browser);
      await check.page.locator('#btn-play').focus();
      await check.page.keyboard.press(key);
      await check.page.waitForFunction(() => window.__keyboardCalls.some(x => x.command === 'launch_instance'));
      assert.equal(await launches(check.page), 1, `кнопка «Играть» должна запускаться клавишей ${key}`);
      assert.deepEqual(check.errors, []);
      await check.page.close();
    }
    console.log('Клавиатура: источники, фильтры, виды, поиск и явный запуск — OK');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
