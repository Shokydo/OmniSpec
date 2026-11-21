// Localisation regression: real DOM, persisted Tauri mock, races and user data.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const context = {window:{}};
vm.runInNewContext(fs.readFileSync(path.join(root,'i18n-data.js'),'utf8'),context);
const dictionaries = context.window.OMNISPEC_LOCALES;
const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match=>match[0]).sort();
const keys = Object.keys(dictionaries.en).sort();
assert(keys.length >= 1400, 'offline dictionaries must cover the UI');
for (const lang of ['en','be','kk','uk']) {
  assert.deepEqual(Object.keys(dictionaries[lang]).sort(),keys,`${lang}: same source keys`);
  for(const [source,translation] of Object.entries(dictionaries[lang])) {
    assert.equal(typeof translation,'string');
    assert(translation.trim(),`${lang}: empty translation for ${source}`);
    assert.deepEqual(placeholders(translation),placeholders(source),`${lang}: placeholders for ${source}`);
  }
}

const server = http.createServer((req,res)=>{
  const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
  if(!file.startsWith(root+path.sep)) return res.writeHead(403).end();
  try {
    const type=({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
      '.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200,{'Content-Type':type}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function setup(page) {
  await page.addInitScript(()=>{
    const initial={theme:'dark',click_fx:'off',ambient:'off',trail:true,trail_style:'sparks',trail_size:50,trail_length:20,trail_opacity:15,
      onboarded:true,discord_rpc:false,update_enabled:false,ui_scale:100,username:'Kept',launcher_icon:'ua',
      categories:[{id:'group',name:'Моды',collapsed:false}],
      wallpaper:'workshop',wallpaper_workshop_project:'/old/scene',wallpaper_steam_path:'/old/steam',wallpaper_workshop_audio:true,
      skin_presets:[{id:'a',name:'Настройки',path:'/skins/keep.png',variant:'classic'}]};
    const clone=x=>JSON.parse(JSON.stringify(x));
    const mock=window.__languageTest={
      settings:JSON.parse(localStorage.getItem('language-settings') || JSON.stringify(initial)),
      calls:[], holdNextLanguage:false, failNextLanguage:false, languageHeld:[], holdNextSave:false, saveHeld:[],
      store() { localStorage.setItem('language-settings',JSON.stringify(this.settings)); },
      releaseLanguage() { const release=this.languageHeld.shift(); if(!release) throw Error('no held language'); release(); },
      releaseSave() { const release=this.saveHeld.shift(); if(!release) throw Error('no held save'); release(); },
      async invoke(command,args={}) {
        this.calls.push({command,args:clone(args)});
        switch(command) {
          case 'get_settings': return clone(this.settings);
          case 'set_language': {
            const fail=this.failNextLanguage; this.failNextLanguage=false;
            if(this.holdNextLanguage) {this.holdNextLanguage=false;await new Promise(resolve=>this.languageHeld.push(resolve));}
            if(fail) throw Error('test language save failure');
            if(!['ru','be','kk','uk','en'].includes(args.language)) throw Error('unknown language');
            this.settings={...this.settings,language:args.language}; this.store(); return null;
          }
          case 'save_settings': {
            if(this.holdNextSave) {this.holdNextSave=false;await new Promise(resolve=>this.saveHeld.push(resolve));}
            // Match the backend lock: generic snapshots cannot overwrite these addressable settings.
            this.settings={...clone(args.settings),language:this.settings.language || 'ru',launcher_icon:this.settings.launcher_icon || 'default'};
            this.store(); return null;
          }
          case 'accounts_info': return {accounts:[{uuid:'u',username:'Моды',kind:'offline'}],active:'u'};
          case 'account_skin': case 'account_capes': return {licensed:false,capes:[]};
          case 'system_memory': return {total_mb:16384};
          case 'list_instances': return [{id:'one',name:'Настройки',category:'group',mc_version:'1.21.1',loader:{type:'vanilla'},created:1,playtime_secs:9000,java_path:'Сборка 1',icon:null}];
          case 'instance_path': return 'Моды';
          case 'pick_file': return 'Настройки';
          case 'running_instances': case 'running_sessions': case 'list_java': case 'catalog_installed_mods': return [];
          case 'list_dir': return [{name:'Моды',path:'Моды',is_dir:true,size:0,modified:1760481296},
            {name:'Настройки',path:'Настройки',is_dir:false,size:1024,modified:1760481296}];
          case 'content_list': return [{filename:'Настройки',title:'Настройки',enabled:false,size:1024,version_number:null}];
          case 'mod_icons': case 'world_icons': return {};
          case 'search_modrinth': case 'search_curseforge': return {hits:[{project_id:'x',slug:'x',title:'Моды',description:'Настройки',categories:['Моды'],downloads:123,project_type:args.projectType}],total_hits:1};
          case 'modrinth_project': case 'curseforge_project': return {id:'x',slug:'x',title:'Моды',description:'Настройки',body:'Моды',categories:['Настройки'],downloads:123,project_type:'modpack',
            gallery:[{title:'Настройки',url:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}]};
          case 'version_info': return {version:'test',enabled:false};
          case 'app_info': return {home:'/data',version:'test',platform:'windows',demo:false};
          default: return null;
        }
      }
    };
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.__copied=text;}}});
    window.__TAURI__={core:{invoke:(command,args)=>mock.invoke(command,args),convertFileSrc:p=>p},event:{listen:async()=>()=>{}}};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>window.omnispecDebug?.state?.accounts?.active==='u' && document.querySelector('.instance[data-id="one"]'));
}
async function openLook(page) {
  if(await page.locator('#modal-prefs').isHidden()) await page.locator('#btn-quick-settings').click();
  await page.locator('[data-pref="look"]').click();
  await page.locator('#prefs-language').waitFor();
}
async function choose(page,lang,save=true) {
  await page.selectOption('#prefs-language',lang);
  await page.waitForFunction(l=>document.documentElement.lang===l,lang);
  if(save) await page.waitForFunction(l=>window.__languageTest.settings.language===l,lang);
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:950}});
  const errors=[]; page.on('pageerror',error=>errors.push(String(error)));
  try {
    await setup(page);
    // An old settings file without a language defaults to Russian.
    assert.equal(await page.evaluate(()=>document.documentElement.lang),'ru');
    assert.equal(await page.locator('.instance-time').innerText(),'2,5 ч','Russian playtime uses a decimal comma');
    await page.locator('.instance[data-id="one"]').click();
    await page.waitForFunction(()=>document.querySelector('#build-path span')?.textContent==='Моды');
    await page.locator('[data-tab="files"]').click();
    await page.waitForSelector('.fm-item .nm');
    const originalDate=await page.locator('.fdate[data-fm-modified]').first().innerText();
    await page.locator('#instance-search').fill('пользовательский текст');
    await openLook(page);

    const navLabels={be:'Афармленне',kk:'Сыртқы көрініс',uk:'Оформлення',en:'Appearance',ru:'Оформление'};
    for(const lang of ['be','kk','uk','en','ru']) {
      await choose(page,lang);
      assert.equal(await page.locator('[data-pref="look"]').innerText(),navLabels[lang]);
      assert.deepEqual(await page.locator('#prefs-language option').allTextContents(),['Русский','Беларуская','Қазақша','Українська','English']);
      assert.deepEqual((await page.locator('#launcher-icon-grid label').allTextContents()).map(x=>x.trim()).slice(1),['Россия','Беларусь','Қазақстан','Україна','USA']);
      assert.equal(await page.locator('#instance-search').inputValue(),'пользовательский текст');
      assert.equal(await page.locator('#build-path span').innerText(),'Моды','actual path is not translated');
      assert.equal(await page.locator('#tb-name').innerText(),'Настройки','instance name is not translated');
      assert.equal(await page.locator('#account-chip-name').innerText(),'Моды','account name is not translated');
      assert.equal(await page.locator('.fm-item .nm').last().innerText(),'Настройки','filename is not translated');
    }
    assert.equal(await page.locator('.fdate[data-fm-modified]').first().innerText(),originalDate,'locale dates return to original Russian');
    console.log('FIVE_LANGUAGES_AND_USER_DATA_OK');

    // Translate dynamically added UI and attributes, but never code, logs or opted-out data.
    await page.evaluate(()=>{
      const div=document.createElement('div');div.id='i18n-probe';
      div.innerHTML='<span class="label">Настройки</span><input placeholder="Поиск сборки" value="Моды"><span translate="no">Настройки</span><pre>Настройки</pre><span class="log-text">Моды</span><div class="errors-card-head"><p>Fabric сообщает, что необходимая зависимость fabric-api не найдена. Требуется версия 0.145.1 или новее.</p></div>';
      document.body.appendChild(div);
    });
    await choose(page,'en');
    // A release asset name is external data. An unfortunate exact dictionary
    // match must remain untouched, including after a later DOM mutation.
    await page.evaluate(()=>{document.querySelector('#upd-asset').textContent='Настройки';});
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#upd-asset').textContent(),'Настройки','update asset name is never translated');
    assert.equal(await page.locator('#i18n-probe .label').innerText(),'Settings');
    assert.equal(await page.locator('#i18n-probe input').getAttribute('placeholder'),'Search instances');
    assert.equal(await page.locator('#i18n-probe input').inputValue(),'Моды');
    assert.equal(await page.locator('#i18n-probe [translate=no]').innerText(),'Настройки');
    assert.equal(await page.locator('#i18n-probe pre').innerText(),'Настройки');
    assert.equal(await page.locator('#i18n-probe .log-text').innerText(),'Моды');
    assert.match(await page.locator('#i18n-probe p').innerText(),/required fabric-api dependency.*Requires version 0\.145\.1 or later\./);
    // A prefix pattern must not swallow a more specific placeholder-first pattern.
    assert.equal(await page.evaluate(()=>window.OmniI18n.translate('Сборка «Test» · последний запуск вчера')),
      'Instance “Test” · last played yesterday');
    assert.equal(await page.evaluate(()=>window.OmniI18n.translate('сервер вернул HTTP 404')),'server returned HTTP 404');
    assert.equal(await page.evaluate(()=>window.OmniI18n.translate('файл больше 512 МБ')),'file is larger than 512 MB');
    await page.evaluate(()=>{
      const error=document.createElement('div');error.className='toast';error.id='backend-error-probe';
      error.textContent='на странице Imgur не найден поддерживаемый файл. Попробуй прямую ссылку на изображение или видео';
      document.body.appendChild(error);
    });
    await page.waitForFunction(()=>document.querySelector('#backend-error-probe').textContent.startsWith('No supported file was found'));
    await page.evaluate(()=>{document.querySelector('#i18n-probe .label').textContent='Моды';});
    await page.waitForFunction(()=>document.querySelector('#i18n-probe .label').textContent==='Mods');
    const enDate=await page.locator('.fdate[data-fm-modified]').first().innerText();
    assert.notEqual(enDate,originalDate,'the existing file date uses the selected locale');
    await choose(page,'ru');
    assert.equal(await page.locator('#i18n-probe .label').innerText(),'Моды','reversible after a dynamic change');
    console.log('DYNAMIC_DOM_ATTRIBUTES_LOGS_AND_DATES_OK');

    // A partially typed wallpaper URL is not lost when changing tabs/language.
    await page.locator('[data-pref="wall"]').click();
    await page.locator('#wall-link').fill('https://imgur.com/Моды');
    await page.locator('[data-pref="look"]').click();
    await choose(page,'en');
    await page.locator('[data-pref="wall"]').click();
    assert.equal(await page.locator('#wall-link').inputValue(),'https://imgur.com/Моды');
    assert.match(await page.locator('#prefs-body').innerText(),/original files have not been deleted/);
    await page.locator('[data-pref="look"]').click();

    // Two fast choices are serialized. A generic settings write cannot revert them.
    await page.evaluate(()=>window.__languageTest.holdNextLanguage=true);
    await choose(page,'be',false);
    await page.waitForFunction(()=>window.__languageTest.languageHeld.length===1);
    await choose(page,'kk',false);
    assert.equal(await page.locator('[data-pref="look"]').innerText(),navLabels.kk);
    const beforeRelease=await page.evaluate(()=>window.__languageTest.calls.filter(x=>x.command==='set_language').map(x=>x.args.language));
    assert.equal(beforeRelease.at(-1),'be','second request waits for first');
    await page.locator('[data-theme-id="navy"]').click();
    await page.waitForFunction(()=>window.__languageTest.settings.theme==='navy');
    await page.evaluate(()=>window.__languageTest.releaseLanguage());
    await page.waitForFunction(()=>window.__languageTest.settings.language==='kk');
    assert.deepEqual((await page.evaluate(()=>window.__languageTest.calls.filter(x=>x.command==='set_language').map(x=>x.args.language))).slice(-2),['be','kk']);

    // Failed latest choice reverts to the last successful language.
    await page.evaluate(()=>window.__languageTest.failNextLanguage=true);
    await page.selectOption('#prefs-language','uk');
    await page.waitForFunction(()=>document.documentElement.lang==='kk' && document.querySelector('#toasts').textContent.includes('test language save failure'));
    assert.equal(await page.locator('#prefs-language').inputValue(),'kk');
    assert.equal(await page.evaluate(()=>window.__languageTest.settings.language),'kk');

    // A failing superseded request must not undo the subsequent choice.
    await page.evaluate(()=>{window.__languageTest.holdNextLanguage=true;window.__languageTest.failNextLanguage=true;});
    await choose(page,'be',false);await page.waitForFunction(()=>window.__languageTest.languageHeld.length===1);
    await choose(page,'en',false);await page.evaluate(()=>window.__languageTest.releaseLanguage());
    await page.waitForFunction(()=>window.__languageTest.settings.language==='en');
    assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');

    // A late generic Save response may not roll back the UI language either.
    await page.evaluate(()=>window.__languageTest.holdNextSave=true);
    await page.locator('#prefs-save').click();
    await page.waitForFunction(()=>window.__languageTest.saveHeld.length===1);
    await choose(page,'uk');
    await page.evaluate(()=>window.__languageTest.releaseSave());
    await page.waitForFunction(()=>document.querySelector('#modal-prefs').hidden);
    assert.equal(await page.evaluate(()=>window.omnispecDebug.state.settings.language),'uk');
    assert.equal(await page.evaluate(()=>window.__languageTest.settings.language),'uk');
    console.log('LANGUAGE_QUEUE_FAILURE_AND_STALE_SAVE_OK');

    // Save and restart keep legacy settings, user data, and the selected locale.
    await page.reload();
    await page.waitForFunction(()=>window.omnispecDebug?.state?.accounts?.active==='u');
    assert.equal(await page.evaluate(()=>document.documentElement.lang),'uk');
    const saved=await page.evaluate(()=>window.__languageTest.settings);
    assert.equal(saved.theme,'navy');assert.equal(saved.username,'Kept');
    assert.equal(saved.wallpaper_workshop_project,'/old/scene');assert.equal(saved.wallpaper_steam_path,'/old/steam');
    assert.equal(saved.wallpaper_workshop_audio,true);assert.equal(saved.skin_presets[0].name,'Настройки');
    await openLook(page);assert.equal(await page.locator('#prefs-language').inputValue(),'uk');
    await choose(page,'en');
    await page.locator('[data-close-prefs]').first().click();
    await page.locator('.instance[data-id="one"]').click();
    await page.waitForFunction(()=>document.querySelector('#build-path span')?.textContent==='Моды');
    assert.equal(await page.locator('.instance-time').innerText(),'2.5 h','English playtime uses a decimal point');
    await page.locator('#build-path-copy').click();
    assert.equal(await page.evaluate(()=>window.__copied),'Моды','clipboard receives original path');
    await page.locator('[data-tab="settings"]').click();
    await page.waitForSelector('#inst-java');
    assert.equal(await page.locator('#inst-java option:checked').innerText(),'Сборка 1','saved Java path is not translated');
    assert.equal(await page.locator('.instance-playtime').innerText(),'2.5 h','English instance playtime is formatted');
    assert.equal(await page.locator('.settings-row .label').filter({hasText:'Time played'}).innerText(),'Time played');
    await page.locator('#inst-java-pick').click();
    await page.waitForFunction(()=>document.querySelector('#inst-java')?.value==='Настройки');
    assert.equal(await page.locator('#inst-java option:checked').innerText(),'Настройки','chosen Java path is not translated');
    await page.locator('[data-tab="mods"]').click();
    await page.waitForSelector('.item-title');
    assert.equal(await page.locator('.item-title [translate=no]').first().innerText(),'Настройки');
    assert.equal(await page.locator('.item-title .tag').first().innerText(),'off','UI badge inside user title translates');
    console.log('RESTART_AND_COPY_PATH_OK');

    // Externally supplied project title, description, categories and image title
    // must stay byte-for-byte unchanged even when they equal UI dictionary keys.
    await page.locator('#btn-home').click();
    await page.waitForSelector('.card[data-project="x"]');
    const card=page.locator('.card[data-project="x"]').first();
    assert.equal(await card.locator('.card-title').innerText(),'Моды');
    assert.equal(await card.locator('.card-desc').innerText(),'Настройки');
    assert.equal(await card.locator('.card-meta [translate=no]').first().innerText(),'Моды');
    await card.click();
    await page.waitForSelector('#proj-body .proj-desc');
    assert.equal(await page.locator('#proj-title').innerText(),'Моды');
    assert.equal(await page.locator('#proj-body .proj-desc').innerText(),'Моды');
    assert.equal(await page.locator('#proj-body .proj-tags [translate=no]').innerText(),'Настройки');
    await page.locator('#proj-body [data-project-image]').first().click();
    assert.equal(await page.locator('#project-image-title').innerText(),'Настройки');
    assert.equal(await page.locator('#project-image-full').getAttribute('alt'),'Настройки');
    assert.deepEqual(errors,[]);
    console.log('EXTERNAL_PROJECT_DATA_OK');
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
