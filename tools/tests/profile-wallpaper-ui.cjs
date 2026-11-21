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
    const mime = ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':mime}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function setup(page) {
  await page.addInitScript(() => {
    const pngCanvas = document.createElement('canvas');
    pngCanvas.width = pngCanvas.height = 64;
    const ctx = pngCanvas.getContext('2d'); ctx.fillStyle = '#9d6a55'; ctx.fillRect(0,0,64,64);
    ctx.fillStyle = '#5a80b0'; ctx.fillRect(16,16,32,32);
    const png = pngCanvas.toDataURL('image/png');
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const initial = {
      theme:'dark', click_fx:'off', ambient:'off', trail:false, onboarded:true, discord_rpc:false,
      update_enabled:false, ui_scale:100, wallpaper:null, wallpaper_fit:'cover', wallpaper_blur:0, wallpaper_dim:40,
      wallpaper_recent:[], skin_presets:[{id:'legacy',name:'Прежний скин',path:'/skins/old.png',variant:'slim',angle:10}],
      skin_favorites:[{id:'saved-fav',name:'Сохранённый образ',skinPath:'/skins/old.png',skinDataUrl:png,skinName:'Прежний скин',variant:'slim',capeId:'cape-1',capeAlias:'Migrator',capeDataUrl:png,angle:10}]
    };
    const state = window.__profileTest = {
      calls:[], settings:JSON.parse(localStorage.getItem('profile-settings') || JSON.stringify(initial)),
      active:'licensed', files:['/a/same.png','/b/same.png','/b/bad.png'], pick:'/tmp/anim.gif',
      serial:0, png, gif,
      accounts:[{uuid:'licensed',username:'Alex',kind:'microsoft'},{uuid:'offline',username:'Offline',kind:'offline'}],
      capes:[{id:'cape-1',alias:'Migrator',active:true,data_url:png},{id:'cape-2',alias:'Vanilla',active:false,data_url:png}],
      async invoke(command,args={}) {
        this.calls.push({command,args:JSON.parse(JSON.stringify(args))});
        switch(command) {
          case 'get_settings': return JSON.parse(JSON.stringify(this.settings));
          case 'save_settings': this.settings=JSON.parse(JSON.stringify(args.settings)); localStorage.setItem('profile-settings',JSON.stringify(this.settings)); return null;
          case 'accounts_info': return {accounts:this.accounts,active:this.active};
          case 'account_set_active': this.active=args.uuid; return {accounts:this.accounts,active:this.active};
          case 'account_skin': return {licensed:this.active==='licensed',variant:'classic',data_url:this.png};
          case 'account_capes': return {licensed:this.active==='licensed',capes:this.active==='licensed'?this.capes.map(x=>({...x})):[]};
          case 'set_cape': this.capes.forEach(c=>c.active=c.id===args.capeId); return {ok:true};
          case 'apply_skin': case 'open_url': return null;
          case 'save_skin_png': return '/skins/from-favorite.png';
          case 'pick_files': return this.files;
          case 'pick_file': return this.pick;
          case 'pick_dir': return '/custom/SteamLibrary';
          case 'import_skin':
            if (args.path.includes('bad')) throw 'повреждённый PNG';
            return {path:`/skins/copied-${++this.serial}.png`,name:'same',data_url:this.png};
          case 'image_data_url': return args.path.includes('preview') ? this.gif : this.png;
          case 'set_custom_wallpaper':
            this.settings={...this.settings,wallpaper:'custom',custom_wallpaper:args.path}; return JSON.parse(JSON.stringify(this.settings));
          case 'download_custom_wallpaper':
            this.settings={...this.settings,wallpaper:'custom',custom_wallpaper:args.url.endsWith('.gif')?'download.gif':'download.mp4'}; return JSON.parse(JSON.stringify(this.settings));
          case 'wallpaper_source':
            if(args.source==='custom' && this.settings.custom_wallpaper) return this.settings.custom_wallpaper.endsWith('.gif')
              ? {path:'/wall/anim.gif',src:this.gif,kind:'gif'}
              : {path:'/wall/movie.mp4',src:'data:video/mp4;base64,AAAAHGZ0eXBpc29t',kind:'video'};
            return null;
          case 'system_memory': return {total_mb:16384};
          case 'list_instances': case 'running_instances': case 'list_java': return [];
          case 'version_info': return {version:'test',enabled:false};
          case 'app_info': return {home:'/data',version:'test',platform:'windows',demo:false};
          default: return null;
        }
      }
    };
    window.__TAURI__={core:{invoke:(command,args)=>state.invoke(command,args),convertFileSrc:p=>p},event:{listen:async()=>()=>{}}};
  });
}

async function openPrefs(page, category) {
  if (await page.locator('#modal-prefs').isHidden()) await page.locator('#btn-quick-settings').click();
  await page.locator(`[data-pref="${category}"]`).click();
}
async function waitSaved(page, expr) { await page.waitForFunction(expr); }
async function assertCalls(page, command, count) {
  assert.equal(await page.evaluate(c=>window.__profileTest.calls.filter(x=>x.command===c).length,command),count,command);
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:850}});
  const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
  try {
    await setup(page);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>window.omnispecDebug?.state.accounts?.active==='licensed');
    await openPrefs(page,'profile');
    await page.waitForSelector('#skin-library [data-skin-id="legacy"]');
    await page.waitForSelector('#skin-capes [data-cape-id="cape-1"]');
    assert.equal(await page.locator('#skin-favorites [data-fav="saved-fav"]').count(),1,'старый образ загружается');
    assert(!((await page.locator('#prefs-body').innerText()).includes('Пресеты')),'нет интерфейса пресетов');
    const boxes=await page.evaluate(()=>{
      const r=s=>{const x=document.querySelector(s).getBoundingClientRect();return {x:x.x,y:x.y,w:x.width,h:x.height};};
      return {accounts:r('.profile-accounts'),profile:r('.profile-active'),favorites:r('.profile-favorites'),model:r('.profile-model'),capes:r('.profile-capes'),skins:r('.profile-skins')};
    });
    assert(boxes.accounts.x < boxes.profile.x && boxes.favorites.y > boxes.profile.y,'верхние блоки по схеме');
    assert(boxes.model.x < boxes.capes.x && boxes.skins.y > boxes.capes.y,'нижние блоки по схеме');
    if (process.env.OMNISPEC_UI_SHOTS) await page.screenshot({path:path.join(process.env.OMNISPEC_UI_SHOTS,'profile.png')});

    await page.locator('[data-skin-id="legacy"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.skin.currentPath==='/skins/old.png');
    await page.locator('#skin-upload').click();
    await page.waitForFunction(()=>window.__profileTest.settings.skin_presets?.length===3);
    assert.equal(await page.locator('#skin-library [data-skin-id]').count(),3);
    assert.match(await page.locator('.skin-import-errors').innerText(),/bad\.png:.*повреждённый PNG/);
    const paths=await page.evaluate(()=>window.__profileTest.settings.skin_presets.map(x=>x.path));
    assert.deepEqual(paths,['/skins/old.png','/skins/copied-1.png','/skins/copied-2.png']);
    await page.locator('#skin-variant [data-variant="slim"]').click();
    await waitSaved(page,()=>window.__profileTest.settings.skin_presets[1].variant==='slim');
    await page.locator('#skin-apply').click();
    await page.waitForFunction(()=>window.__profileTest.calls.some(c=>c.command==='apply_skin' && c.args.path==='/skins/copied-1.png' && c.args.variant==='slim'));
    await page.locator('#fav-add').click();
    await page.locator('#prompt-input').fill('Новый образ');
    await page.locator('#prompt-ok').click();
    await waitSaved(page,()=>window.__profileTest.settings.skin_favorites.length===2);
    assert.equal(await page.locator('#skin-favorites [data-fav]').count(),2);
    await page.reload();
    await page.waitForFunction(()=>window.omnispecDebug?.state.accounts?.active==='licensed');
    await openPrefs(page,'profile');
    await page.waitForSelector('#skin-library [data-skin-id="legacy"]');
    assert.equal(await page.locator('#skin-library [data-skin-id]').count(),3,'библиотека переживает перезапуск');
    assert.equal(await page.locator('#skin-favorites [data-fav]').count(),2,'избранное переживает перезапуск');

    await page.locator('[data-del-skin="legacy"]').click();
    await page.locator('#confirm-cancel').click();
    assert.equal(await page.locator('#skin-library [data-skin-id]').count(),3);
    await page.locator('[data-del-skin="legacy"]').click();
    await page.locator('#confirm-ok').click();
    await waitSaved(page,()=>window.__profileTest.settings.skin_presets.length===2);
    assert.equal(await page.locator('#skin-favorites [data-fav]').count(),2,'удаление из списка не удаляет образы');
    await page.locator('[data-uuid="offline"] [data-acc="pick"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.accounts.active==='offline' && !window.omnispecDebug.state.skin.licensed);
    assert(await page.locator('#skin-apply').isDisabled(),'смена скина недоступна офлайн');
    assert.equal(await page.locator('#skin-capes [data-cape-id="cape-1"]').count(),0,'не показываем плащ другого аккаунта');
    await page.locator('[data-uuid="licensed"] [data-acc="pick"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.accounts.active==='licensed' && window.omnispecDebug.state.skin.licensed);

    // Перерисовка после выбора скина не должна возвращать ни вложенную,
    // ни внешнюю прокрутку к началу. Список заметно превышает высоту ячейки.
    await page.evaluate(() => {
      const settings=window.omnispecDebug.state.settings;
      window.__savedSkinList=settings.skin_presets;
      settings.skin_presets=[...settings.skin_presets,...Array.from({length:64},(_,n)=>({
        id:`bulk-${n}`,name:`Skin ${n}`,path:`/skins/bulk-${n}.png`,variant:'classic',angle:0
      }))];
    });
    await page.locator('[data-pref="profile"]').click();
    await page.waitForSelector('#skin-library [data-skin-id="bulk-50"]');
    await page.locator('[data-skin-id="bulk-50"]').scrollIntoViewIfNeeded();
    const beforeScroll=await page.evaluate(()=>({
      body:document.querySelector('#prefs-body').scrollTop,
      skins:document.querySelector('#skin-library').scrollTop,
      max:document.querySelector('#skin-library').scrollHeight-document.querySelector('#skin-library').clientHeight
    }));
    assert(beforeScroll.skins > 100 && beforeScroll.max > 100,'библиотека реально прокручена');
    assert(beforeScroll.body > 0,'внешний контейнер тоже прокручен');
    await page.locator('[data-skin-id="bulk-50"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.skin.currentPath==='/skins/bulk-50.png'
      && document.querySelector('[data-skin-id="bulk-50"]')?.closest('.skin-library-item')?.classList.contains('is-active'));
    const afterScroll=await page.evaluate(()=>({
      body:document.querySelector('#prefs-body').scrollTop,
      skins:document.querySelector('#skin-library').scrollTop
    }));
    assert(Math.abs(afterScroll.skins-beforeScroll.skins)<2,`вложенная прокрутка: ${JSON.stringify({beforeScroll,afterScroll})}`);
    assert(Math.abs(afterScroll.body-beforeScroll.body)<2,`внешняя прокрутка: ${JSON.stringify({beforeScroll,afterScroll})}`);
    await page.locator('#skin-refresh').evaluate(el=>el.click());
    await page.waitForFunction(()=>!window.omnispecDebug.state.skin.loading);
    const afterAsync=await page.evaluate(()=>({body:document.querySelector('#prefs-body').scrollTop,skins:document.querySelector('#skin-library').scrollTop}));
    assert(Math.abs(afterAsync.skins-beforeScroll.skins)<2,'асинхронная перерисовка сохраняет вложенную прокрутку');
    assert(Math.abs(afterAsync.body-beforeScroll.body)<2,'асинхронная перерисовка сохраняет внешнюю прокрутку');
    await page.evaluate(()=>{window.omnispecDebug.state.settings.skin_presets=window.__savedSkinList;});

    await openPrefs(page,'wall');
    assert.equal(await page.locator('#we-grid, #we-enabled, #wall-scene').count(),0,'интеграция удалена');
    await page.locator('#wall-pick').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.customWall?.kind==='gif' && window.omnispecDebug.state.wall.wallpaper==='custom');
    assert.equal(await page.locator('#wall-video').isHidden(),true);
    assert.equal(await page.locator('#wall').getAttribute('data-prepared'),'','GIF не запекается в JPEG');
    assert.match(await page.locator('#wall').evaluate(el=>el.style.backgroundImage),/data:image\/gif/);
    await page.locator('#wall-dim').evaluate(el=>{el.value='65';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
    await waitSaved(page,()=>window.__profileTest.settings.wallpaper_dim===65);
    await page.locator('#wall-link').fill('https://example.com/wall.gif');
    await page.locator('#wall-link-add').click();
    await page.waitForFunction(()=>window.__profileTest.settings.custom_wallpaper==='download.gif' && window.omnispecDebug.state.customWall?.kind==='gif');
    assert.equal(await page.evaluate(()=>window.__profileTest.calls.filter(c=>/wallpaper_engine|workshop|scene/.test(c.command)).length),0);
    if (process.env.OMNISPEC_UI_SHOTS) await page.screenshot({path:path.join(process.env.OMNISPEC_UI_SHOTS,'wallpaper.png')});
    assert.deepEqual(errors,[],'ошибок JS нет');
    console.log('profile-wallpaper-ui: layout, migration, favorites, capes, nested scroll, own media and links passed');
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
