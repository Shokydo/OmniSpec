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
      projects:[
        {title:'Видео закат',directory:'/steam/123',kind:'video',workshop_id:'123',preview:'/steam/123/preview.gif',playable:true},
        {title:'Сцена <script>alert(1)</script>',directory:'/steam/456',kind:'scene',workshop_id:'456',preview:null,playable:false},
        {title:'Веб обои',directory:'/steam/789',kind:'web',workshop_id:'789',preview:null,playable:false},
        {title:'Приложение',directory:'/steam/444',kind:'application',workshop_id:'444',preview:null,playable:false}
      ], serial:0, png, gif, scanDelay:120, sceneCapture:false, failScene:false, sceneAlive:true, failRestore:false,
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
          case 'apply_skin': case 'open_wallpaper_engine': case 'open_url': return null;
          case 'save_skin_png': return '/skins/from-favorite.png';
          case 'pick_files': return this.files;
          case 'pick_file': return this.pick;
          case 'pick_dir': return '/custom/SteamLibrary';
          case 'import_skin':
            if (args.path.includes('bad')) throw 'повреждённый PNG';
            return {path:`/skins/copied-${++this.serial}.png`,name:'same',data_url:this.png};
          case 'image_data_url': return args.path.includes('preview') ? this.gif : this.png;
          case 'scan_wallpaper_library':
            await new Promise(resolve=>setTimeout(resolve,this.scanDelay));
            return {projects:this.projects,searched:['/steam'],engine:'wallpaper64.exe',scene_capture:this.sceneCapture,truncated:false};
          case 'parse_wallpaper_workshop_link': {
            try { const u=new URL(args.url); const a=u.searchParams.getAll('id'); return u.hostname==='steamcommunity.com' && a.length===1 && /^\d+$/.test(a[0]) ? a[0] : null; }
            catch { return null; }
          }
          case 'set_custom_wallpaper':
            this.settings={...this.settings,wallpaper:'custom',custom_wallpaper:args.path}; return JSON.parse(JSON.stringify(this.settings));
          case 'download_custom_wallpaper':
            this.settings={...this.settings,wallpaper:'custom',custom_wallpaper:args.url.endsWith('.gif')?'download.gif':'download.mp4'}; return JSON.parse(JSON.stringify(this.settings));
          case 'set_workshop_wallpaper':
            if (this.failScene && args.directory==='/steam/fail') throw 'кадры сцены недоступны';
            this.settings={...this.settings,wallpaper:'workshop',wallpaper_workshop_project:args.directory}; return JSON.parse(JSON.stringify(this.settings));
          case 'wallpaper_scene_status': return this.sceneAlive;
          case 'wallpaper_source':
            if(args.source==='workshop' && this.failRestore) throw 'Wallpaper Engine остановлен';
            if(args.source==='workshop' && this.settings.wallpaper==='workshop' && this.settings.wallpaper_workshop_project==='/steam/456') return {path:'/steam/456',src:this.gif,kind:'scene'};
            if(args.source==='workshop' && this.settings.wallpaper_workshop_project) return {path:'/steam/123/movie.mp4',src:'data:video/mp4;base64,AAAAHGZ0eXBpc29t',kind:'video'};
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

    await openPrefs(page,'wall');
    await page.waitForSelector('#we-grid [data-we-card="0"]');
    assert.equal(await page.locator('#we-grid .we-card').count(),4);
    assert.equal(await page.locator('#we-grid script').count(),0,'название проекта не может встроить JS');
    assert.equal(await page.locator('[data-we-card="1"] [data-we-apply]').count(),0,'сцену нельзя выдать за встроенное видео');
    await page.locator('#wall-pick').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.customWall?.kind==='gif' && window.omnispecDebug.state.wall.wallpaper==='custom');
    assert.equal(await page.locator('#wall-video').isHidden(),true);
    assert.equal(await page.locator('#wall').getAttribute('data-prepared'),'','GIF не запекается в JPEG');
    assert.match(await page.locator('#wall').evaluate(el=>el.style.backgroundImage),/data:image\/gif/);
    await page.locator('#wall-dim').evaluate(el=>{el.value='65';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
    await waitSaved(page,()=>window.__profileTest.settings.wallpaper_dim===65);

    await page.locator('[data-we-apply="0"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.wall.wallpaper==='workshop' && !document.querySelector('#wall-video').hidden);
    assert(await page.locator('#wall-video').evaluate(v=>v.muted && v.loop && v.playsInline),'видео без звука, зациклено');
    await page.locator('[data-wall=""]').click();
    assert(await page.locator('#wall-video').isHidden());
    await page.locator('[data-wall="workshop"]').click();
    await page.waitForFunction(()=>!document.querySelector('#wall-video').hidden && !!document.querySelector('#wall-video').getAttribute('src'));

    await page.locator('#wall-link').fill('https://steamcommunity.com/sharedfiles/filedetails/?id=123');
    await page.locator('#wall-link-add').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.wallpaperLibrary.highlight==='123');
    assert(await page.locator('[data-we-card="0"]').isVisible());
    assert(!(await page.locator('[data-we-card="1"]').isVisible()),'поиск по ссылке фильтрует библиотеку');
    await page.locator('#we-search').fill('');
    await page.locator('[data-we-open="1"]').click();
    await page.locator('#confirm-cancel').click();
    await assertCalls(page,'open_wallpaper_engine',0);
    await page.locator('[data-we-open="1"]').click();
    assert.match(await page.locator('#confirm-text').innerText(),/отдельном окне/);
    await page.locator('#confirm-ok').click();
    await page.waitForFunction(()=>window.__profileTest.calls.some(c=>c.command==='open_wallpaper_engine' && c.args.directory==='/steam/456'));
    await page.locator('#wall-link').fill('https://steamcommunity.com/workshop/filedetails/?id=999');
    await page.locator('#wall-link-add').click();
    await page.waitForSelector('#modal-confirm:not([hidden])');
    await page.locator('#confirm-ok').click();
    await page.waitForFunction(()=>window.__profileTest.calls.some(c=>c.command==='open_url' && c.args.url==='https://steamcommunity.com/sharedfiles/filedetails/?id=999'));
    await page.locator('#wall-link').fill('https://example.com/wall.gif');
    await page.locator('#wall-link-add').click();
    await page.waitForFunction(()=>window.__profileTest.settings.custom_wallpaper==='download.gif' && window.omnispecDebug.state.customWall?.kind==='gif');
    await page.locator('#we-folder').click();
    await waitSaved(page,()=>window.__profileTest.settings.wallpaper_steam_path==='/custom/SteamLibrary');
    await page.waitForFunction(()=>!window.omnispecDebug.state.wallpaperLibrary.loading);
    if (process.env.OMNISPEC_UI_SHOTS) await page.screenshot({path:path.join(process.env.OMNISPEC_UI_SHOTS,'wallpaper.png')});

    // Положительный Windows-сценарий использует мок кадров; реальный WE/WGC
    // этим браузерным тестом не проверяется.
    await page.evaluate(()=>{
      const t=window.__profileTest; t.sceneCapture=true; t.failScene=true;
      t.projects.push({title:'Сцена с ошибкой',directory:'/steam/fail',kind:'scene',workshop_id:'9999',playable:false});
    });
    await page.locator('#we-refresh').click();
    await page.waitForSelector('[data-we-card="4"] [data-we-apply]');
    const before=await page.evaluate(()=>window.__profileTest.calls.filter(c=>c.command==='set_workshop_wallpaper').length);
    await page.locator('[data-we-apply="1"]').click();
    assert.match(await page.locator('#confirm-text').innerText(),/вспомогательное окно/);
    await page.locator('#confirm-cancel').click();
    await assertCalls(page,'set_workshop_wallpaper',before);
    await page.locator('[data-we-apply="1"]').click();
    await page.locator('#confirm-ok').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.workshopWall?.kind==='scene' && !document.querySelector('#wall-scene').hidden);
    assert(await page.locator('#wall-video').isHidden());
    assert.match(await page.locator('#wall-scene').getAttribute('src'),/^data:image\/gif/);
    assert.equal(await page.evaluate(()=>window.__profileTest.settings.wallpaper_workshop_project),'/steam/456');
    // Emulate the external capture stopping after the first frame. A failed
    // retry keeps the saved selection; a later successful retry clears the warning.
    await page.evaluate(()=>{window.__profileTest.sceneAlive=false;window.__profileTest.failRestore=true;});
    await page.waitForFunction(()=>window.omnispecDebug.state.wallpaperLibrary.sceneError.includes('Поток сцены остановлен'),null,{timeout:9000});
    assert(await page.locator('#we-retry').isVisible());
    await page.locator('#we-retry').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.wallpaperLibrary.sceneError.includes('Wallpaper Engine остановлен'));
    assert.equal(await page.evaluate(()=>window.__profileTest.settings.wallpaper_workshop_project),'/steam/456');
    assert(!(await page.locator('#wall-scene').isHidden()),'failed restart does not drop the last frame');
    await page.evaluate(()=>{window.__profileTest.sceneAlive=true;window.__profileTest.failRestore=false;});
    await page.locator('#we-retry').click();
    await page.waitForFunction(()=>!window.omnispecDebug.state.wallpaperLibrary.sceneError && !window.omnispecDebug.state.wallpaperLibrary.retrying);
    await page.locator('[data-we-apply="4"]').click();
    await page.locator('#confirm-ok').click();
    await page.waitForFunction(()=>window.__profileTest.calls.some(c=>c.command==='set_workshop_wallpaper' && c.args.directory==='/steam/fail'));
    assert.equal(await page.evaluate(()=>window.__profileTest.settings.wallpaper_workshop_project),'/steam/456','неудачный выбор сохраняет прошлую сцену');
    assert(!(await page.locator('#wall-scene').isHidden()));
    await page.reload();
    await page.waitForFunction(()=>window.omnispecDebug?.state.workshopWall?.kind==='scene' && !document.querySelector('#wall-scene').hidden);
    assert.equal(await page.evaluate(()=>window.__profileTest.settings.wallpaper_workshop_project),'/steam/456','сцена восстанавливается после перезапуска UI');
    assert.deepEqual(errors,[],'ошибок JS нет');
    console.log('profile-wallpaper-ui: layout, migration, favorites, capes, media, Steam, scene selection/failure/restore and links passed (scene mocked)');
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
