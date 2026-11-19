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

async function createPage(browser, options = {}) {
  const page = await browser.newPage({viewport:{width:options.width || 1280,height:800}});
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(({slowUpdate,noEvents}) => {
    const now = Math.floor(Date.now() / 1000);
    const instances = [
      {id:'pack-a',name:'Тестовая сборка',mc_version:'1.20.1',loader:{type:'forge',version:'47.3.0'},created:now,playtime_secs:0,icon:null},
      {id:'pack-b',name:'Вторая сборка',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16.9'},created:now,playtime_secs:0,icon:null}
    ];
    const accounts = [{uuid:'user-1',username:'Steve',kind:'offline'}, {uuid:'user-2',username:'Alex',kind:'offline'}];
    const callbacks = {};
    const mock = window.__testTauri = {
      launches: [], opened: [], calls: [], active: new Map(), callbacks,
      emit(name, payload) { if (!callbacks[name]) throw new Error(`No listener: ${name}`); callbacks[name]({payload}); },
      log(index, line) {
        const run = this.launches[index];
        this.emit('game-log', {instance:run.args.instanceId,run_id:run.runId,attempt_id:run.args.attemptId,line});
      },
      start(index) {
        const run = this.launches[index];
        this.active.set(run.runId, run.args.instanceId);
        run.resolve({run_id:run.runId, account:run.args.accountUuid === 'user-2' ? 'Alex' : 'Steve',java_major:17,java:'java',memory_mb:4096,classpath_entries:50});
      },
      exit(index, code, stopped = false) {
        const run = this.launches[index];
        this.active.delete(run.runId);
        this.emit('game-exit',{instance:run.args.instanceId,run_id:run.runId,attempt_id:run.args.attemptId,code,stopped});
      },
      fail(index, message) { this.launches[index].reject(message); },
      async invoke(command, args = {}) {
        this.calls.push({command,args});
        switch (command) {
          case 'get_settings': return {theme:'dark',click_fx:'off',ambient:'off',trail:false,onboarded:true,discord_rpc:false,update_enabled:false};
          case 'save_settings': return null;
          case 'accounts_info': return {accounts,active:'user-1'};
          case 'list_instances': return instances.map(x => ({...x}));
          case 'running_instances': return [...new Set(this.active.values())];
          case 'custom_wallpaper': case 'startup_file': case 'set_presence': case 'resolve_presence_icon': case 'instance_icon': return null;
          case 'version_info':
            if (slowUpdate) return new Promise(resolve => setTimeout(() => resolve({version:'test',enabled:false}),5000));
            return {version:'test',enabled:false};
          case 'search_modrinth': case 'search_curseforge': return {hits:[],total_hits:0};
          case 'content_list': if (this.delayContent) await new Promise(resolve => setTimeout(resolve,350)); return [];
          case 'list_java': return [];
          case 'instance_path': return `/test/${args.instanceId}`;
          case 'open_path': this.opened.push(args.path); return null;
          case 'launch_instance': {
            const run = {args,runId:`${args.instanceId}#${this.launches.length+1}`};
            this.launches.push(run);
            return new Promise((resolve,reject) => { run.resolve=resolve; run.reject=reject; });
          }
          case 'stop_instance': {
            const targets = this.launches.filter(r => this.active.has(r.runId) && r.args.instanceId === args.instanceId && (!args.runId || args.runId === r.runId));
            if (!targets.length) throw 'сборка не запущена';
            for (const run of targets) this.exit(this.launches.indexOf(run), -1, true);
            if (this.delayStop) await new Promise(resolve => setTimeout(resolve,500));
            return null;
          }
          default: return null;
        }
      }
    };
    Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{writeText: async text => { mock.copied=text; }}});
    window.__TAURI__ = {
      core: {invoke: (command,args) => mock.invoke(command,args)},
      event: {listen: async (name,callback) => { if (noEvents && name === 'game-log') throw new Error('события недоступны'); callbacks[name] = callback; return () => delete callbacks[name]; }}
    };
  }, options);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('[data-home-id="pack-a"]');
  return {page,errors};
}

async function choosePack(page, id = 'pack-a') {
  await page.locator(`[data-home-id="${id}"]`).click();
  await page.locator('[data-tab="errors"]').click();
  await page.waitForSelector('#errors-dynamic');
}
async function attemptCount(page, count) {
  await page.waitForFunction(n => window.__testTauri.launches.length === n, count);
}
async function bodyContains(page, text) {
  await page.waitForFunction(s => document.querySelector('#errors-dynamic')?.innerText.includes(s), text);
}

(async () => {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const browser = await chromium.launch({headless:true});
  try {
    // Preparation error, actionable controls, escaping and history.
    {
      const {page,errors} = await createPage(browser, {slowUpdate:true,width:1080});
      await choosePack(page);
      assert((await page.locator('#errors-dynamic').innerText()).includes('Пока нет данных'));
      assert.equal(await page.locator('[data-tab="screenshots"] .tab-badge').count(),0);
      await page.click('#btn-play'); await attemptCount(page,1);
      await bodyContains(page,'Подготавливаем запуск');
      assert.equal(await page.locator('#tb-status').innerText(),'подготавливается');
      const args = await page.evaluate(() => window.__testTauri.launches[0].args);
      assert(args.attemptId && args.instanceId === 'pack-a' && args.accountUuid === null);
      await page.evaluate(() => {
        const m=window.__testTauri, op='launch:'+m.launches[0].args.attemptId;
        m.emit('progress',{instance:'pack-a',stage:'assets',done:1,total:20,state:'active',op});
        m.fail(0, 'Версия Quilt 66.1.8 не найдена для Minecraft 26.3. <img src=x onerror=alert(1)>');
      });
      await bodyContains(page,'Версия загрузчика не найдена');
      assert((await page.locator('#dl-title').innerText()).includes('ошибка'));
      await page.evaluate(() => {
        const m=window.__testTauri, op='launch:'+m.launches[0].args.attemptId;
        m.emit('progress',{instance:'pack-a',stage:'assets',done:2,total:20,state:'active',op});
      });
      assert((await page.locator('#dl-title').innerText()).includes('ошибка'),'поздний прогресс не возвращает ошибочный этап в работу');
      assert.equal(await page.locator('#badge-errors').innerText(),'1');
      assert.equal(await page.locator('#errors-dynamic img').count(),0,'сообщения лога не являются HTML');
      await page.locator('[data-evidence="preparation"] summary').focus();
      await page.locator('[data-evidence="preparation"] summary').press('Enter');
      assert((await page.locator('[data-evidence="preparation"] pre').innerText()).includes('<img'));
      assert.equal(await page.evaluate(() => window.__testTauri.launches.length),1,'Enter на раскрытии сообщения не запускает игру');
      await page.locator('[data-errors-action="folder"]').focus();
      await page.locator('[data-errors-action="folder"]').press('Enter');
      assert.deepEqual(await page.evaluate(() => window.__testTauri.opened), ['/instances/pack-a/minecraft']);
      assert.equal(await page.evaluate(() => window.__testTauri.launches.length),1,'Enter на кнопке не запускает игру');
      // The last tab must stay reachable at the app's minimum width.
      await page.locator('[data-tab="settings"]').click();
      await page.waitForSelector('#inst-java');
      await page.locator('[data-tab="errors"]').click();
      await bodyContains(page,'Версия загрузчика не найдена');
      assert.deepEqual(errors,[]);
      console.log('DIAGNOSTICS_PREPARATION: local, escaped, folder and minimum-width navigation — OK');
      await page.close();
    }

    // Independent preparation for two packs must not close each other's progress.
    {
      const {page,errors} = await createPage(browser);
      await choosePack(page); await page.click('#btn-play'); await attemptCount(page,1);
      await page.locator('.instance[data-id="pack-b"]').last().click();
      assert.equal(await page.locator('#btn-play').isEnabled(),true,'подготовка другой сборки не блокирует кнопку');
      await page.click('#btn-play'); await attemptCount(page,2);
      await page.evaluate(() => {
        const m=window.__testTauri;
        const a='launch:'+m.launches[0].args.attemptId, b='launch:'+m.launches[1].args.attemptId;
        m.emit('progress',{instance:'pack-a',stage:'assets',done:1,total:10,file:'a.jar',bytes_done:1,bytes_total:10,state:'active',op:a});
        m.emit('progress',{instance:'pack-b',stage:'assets',done:2,total:10,file:'b.jar',bytes_done:2,bytes_total:10,state:'active',op:b});
        m.fail(0,'ошибка первой сборки');
      });
      await page.waitForFunction(() => !window.omnispecDebug.state.preparing.has('pack-a'));
      assert.equal(await page.evaluate(() => window.omnispecDebug.state.progress.instance),'pack-b');
      assert.equal(await page.evaluate(() => window.omnispecDebug.state.downloads.state),'active');
      assert.deepEqual(await page.evaluate(() => [...window.omnispecDebug.state.downloads.files.keys()]),['b.jar'],'файлы параллельных операций не смешиваются');
      await page.evaluate(() => window.__testTauri.fail(1,'сетевая ошибка: error sending request'));
      await bodyContains(page,'Сетевая ошибка');
      assert.equal(await page.evaluate(() => window.omnispecDebug.state.downloads.state),'error');
      assert.deepEqual(errors,[]); console.log('DIAGNOSTICS_PREPARATION_RACES: parallel progress remains isolated — OK');
      await page.close();
    }

    // Fast game-exit before launch command response; late stderr must still be used.
    {
      const {page,errors} = await createPage(browser);
      await choosePack(page); await page.click('#btn-play'); await attemptCount(page,1);
      await page.evaluate(() => {
        const m = window.__testTauri;
        m.log(0,'[omnispec] запуск java');
        m.exit(0,1);
        m.log(0,'java.lang.module.ResolutionException: Modules minecraft and customskinloader export package net.minecraft.client.renderer to module ftblibrary');
        // A process may die before the invoke promise returns. Don't re-add it to running.
        const r = m.launches[0];
        r.resolve({run_id:r.runId,account:'Steve',java_major:17,java:'java',memory_mb:4096,classpath_entries:50});
      });
      await bodyContains(page,'Конфликт модулей Java');
      const text = await page.locator('#errors-dynamic').innerText();
      assert(text.includes('minecraft и customskinloader') && text.includes('ftblibrary читает'));
      assert(text.includes('не обязательно является источником конфликта'));
      assert(text.includes('резервную копию'));
      assert(!/удали(?:те)?\s+ftblibrary/i.test(text));
      assert(text.includes('Код завершения: 1'));
      await page.locator('[data-errors-action="copy"]').click();
      const copied = await page.evaluate(() => window.__testTauri.copied);
      assert(copied.includes('Конфликт модулей Java'));
      assert(!copied.includes('ResolutionException'), 'копируются подсказки, а не сырой лог');
      await page.waitForFunction(() => !window.omnispecDebug.state.preparing.has('pack-a'));
      assert.equal(await page.evaluate(() => window.omnispecDebug.state.running.has('pack-a')),false);
      assert.equal(await page.evaluate(() => window.omnispecDebug.state.sessions.has('pack-a')),false);
      if (process.env.DIAG_SCREENSHOT) {
        await page.waitForFunction(() => !document.querySelector('#toasts .toast'), null, {timeout:6000});
        await page.screenshot({path:process.env.DIAG_SCREENSHOT});
      }
      await page.evaluate(() => { window.__testTauri.delayContent=true; });
      await page.locator('[data-errors-action="mods"]').click();
      await page.locator('[data-tab="errors"]').click();
      await page.waitForTimeout(500);
      assert((await page.locator('#errors-dynamic').innerText()).includes('Конфликт модулей Java'), 'запоздавшая загрузка модов не подменяет вкладку');
      assert.deepEqual(errors,[]); console.log('DIAGNOSTICS_FAST_EXIT: no ghost process, late stderr, screenshot conflict — OK');
      await page.close();
    }

    // Two windows of the same pack: interleaved output, targeted stop, and run selector.
    {
      const {page,errors} = await createPage(browser);
      await choosePack(page); await page.click('#btn-play'); await attemptCount(page,1);
      await page.evaluate(() => { window.__testTauri.log(0,'Game process started'); window.__testTauri.start(0); });
      await page.waitForFunction(() => window.omnispecDebug.state.running.has('pack-a'));
      await page.locator('.instance[data-id="pack-a"]').first().click({button:'right'});
      await page.locator('#ctx-menu [data-act="dup"]').click();
      await page.locator('#modal-dup .dup-row[data-uuid="user-2"]').click();
      await attemptCount(page,2);
      await page.evaluate(() => {
        const m=window.__testTauri;
        m.log(1,'java.lang.OutOfMemoryError: Java heap space');
        m.log(0,'java.lang.module.ResolutionException: Modules minecraft and customskinloader export package net.minecraft.client.renderer to module ftblibrary');
        m.start(1);
      });
      await bodyContains(page,'Игре не хватило памяти Java');
      assert(!(await page.locator('#errors-dynamic').innerText()).includes('Конфликт модулей Java'));
      await page.locator('[data-errors-action="java"]').click();
      await page.waitForSelector('#modal-prefs #set-java');
      await page.locator('[data-close-prefs]').first().click();
      const options = await page.locator('#errors-run option').evaluateAll(xs => xs.map(x => ({value:x.value,text:x.textContent})));
      assert.equal(options.length,2);
      const ids = await page.evaluate(() => window.__testTauri.launches.map(x=>x.args.attemptId));
      await page.selectOption('#errors-run',ids[0]); await bodyContains(page,'Конфликт модулей Java');
      assert(!(await page.locator('#errors-dynamic').innerText()).includes('Игре не хватило памяти Java'));
      await page.locator('.instance-dup[data-dup-of="pack-a"]').first().click({button:'right'});
      await page.locator('#ctx-menu [data-act="stop-dup"]').click();
      await page.waitForFunction(() => window.__testTauri.calls.some(x=>x.command==='stop_instance' && x.args.runId==='pack-a#2'));
      await page.selectOption('#errors-run',ids[1]); await bodyContains(page,'Игра остановлена пользователем');
      assert((await page.locator('#errors-dynamic').innerText()).includes('Игре не хватило памяти Java'));
      assert.equal(await page.evaluate(() => window.omnispecDebug.state.running.has('pack-a')),true,'второе окно не останавливает первое');
      assert(!(await page.locator('#toasts').innerText()).includes('Игра закрылась с ошибкой (код -1)'));
      await page.evaluate(() => window.__testTauri.exit(0,1));
      await page.selectOption('#errors-run',ids[0]); await bodyContains(page,'Игра завершилась с ошибкой');
      assert((await page.locator('#errors-dynamic').innerText()).includes('Конфликт модулей Java'));
      await page.locator('.instance[data-id="pack-b"]').last().click();
      await bodyContains(page,'Пока нет данных');
      await page.locator('.instance[data-id="pack-a"]').last().click();
      await bodyContains(page,'Конфликт модулей Java');
      assert.deepEqual(errors,[]); console.log('DIAGNOSTICS_SESSIONS: isolated duplicates, targeted stop, profile isolation — OK');
      await page.close();
    }

    // Don't claim a clean log if event subscriptions are unavailable.
    {
      const {page,errors} = await createPage(browser,{noEvents:true});
      await choosePack(page); await page.click('#btn-play'); await attemptCount(page,1);
      await page.evaluate(() => window.__testTauri.start(0));
      await bodyContains(page,'Живой лог недоступен');
      assert(!(await page.locator('#errors-dynamic').innerText()).includes('Пока ничего подозрительного'));
      assert.deepEqual(errors,[]); console.log('DIAGNOSTICS_MISSING_EVENTS: no false clean status — OK');
      await page.close();
    }

    // A new window can start while the previous stop command is still resolving.
    {
      const {page,errors} = await createPage(browser);
      await choosePack(page); await page.click('#btn-play'); await attemptCount(page,1);
      await page.evaluate(() => { const m=window.__testTauri; m.log(0,'startup'); m.start(0); m.delayStop=true; });
      await page.waitForFunction(() => window.omnispecDebug.state.running.has('pack-a'));
      await page.locator('#btn-stop').click();
      await page.locator('.instance[data-id="pack-a"]').last().click({button:'right'});
      await page.locator('#ctx-menu [data-act="dup"]').click();
      await page.locator('#modal-dup .dup-row[data-uuid="user-2"]').click(); await attemptCount(page,2);
      await page.evaluate(() => { const m=window.__testTauri; m.log(1,'another startup'); m.start(1); });
      await page.waitForFunction(() => window.omnispecDebug.state.sessions.get('pack-a')?.has('pack-a#2'));
      await page.waitForTimeout(700);
      assert.equal(await page.evaluate(() => window.omnispecDebug.state.sessions.get('pack-a')?.has('pack-a#2')),true);
      assert.equal(await page.evaluate(() => window.omnispecDebug.state.running.has('pack-a')),true);
      assert.deepEqual(errors,[]); console.log('DIAGNOSTICS_STOP_RACE: new session survives old stop response — OK');
      await page.close();
    }

    // Unknown exit and repeated output must not cause DOM redraws.
    {
      const {page,errors} = await createPage(browser);
      await choosePack(page); await page.click('#btn-play'); await attemptCount(page,1);
      await page.evaluate(() => { window.__testTauri.log(0,'ordinary startup'); window.__testTauri.start(0); });
      await bodyContains(page,'Пока ничего подозрительного');
      await page.evaluate(() => {
        window.__changes = 0;
        window.__observer = new MutationObserver(() => window.__changes++);
        window.__observer.observe(document.querySelector('#errors-dynamic'),{subtree:true,childList:true,characterData:true});
        for (let i=0;i<6000;i++) window.__testTauri.log(0,'[INFO] ordinary line '+i);
      });
      await page.waitForTimeout(350);
      assert.equal(await page.evaluate(() => window.__changes),0,'нет перерисовки на каждую строку');
      assert(await page.evaluate(() => window.omnispecDebug.state.logs['pack-a'].length <= 4000));
      await page.evaluate(() => { window.__observer.disconnect(); window.__testTauri.exit(0,1); });
      await bodyContains(page,'Причину определить не удалось');
      const text = await page.locator('#errors-dynamic').innerText();
      assert(text.includes('Сам по себе код не объясняет причину'));
      assert(text.includes('полный лог') && text.includes('crash-reports'));
      assert.equal(await page.locator('#errors-dynamic [data-diagnostic]').count(),0);
      assert.equal(await page.locator('#badge-errors').innerText(),'!');
      await page.waitForFunction(() => !window.omnispecDebug.state.running.has('pack-a'));
      await page.click('#btn-play'); await attemptCount(page,2);
      await page.evaluate(() => { const m=window.__testTauri; m.log(1,'startup'); m.start(1); m.exit(1,0); });
      await bodyContains(page,'Известные ошибки не найдены');
      assert.equal(await page.locator('#badge-errors').isHidden(),true);
      const previous = await page.evaluate(() => window.__testTauri.launches[0].args.attemptId);
      await page.selectOption('#errors-run',previous); await bodyContains(page,'Причину определить не удалось');
      assert.deepEqual(errors,[]); console.log('DIAGNOSTICS_UNKNOWN_PERFORMANCE: no guessed cause and 6000 lines without redraw — OK');
      await page.close();
    }
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode=1; server.close(); });
