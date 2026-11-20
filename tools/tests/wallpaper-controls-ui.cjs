// Browser-level tests: backend, scene and Steam are fixtures, not real WE/WGC.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const tone = path.resolve(__dirname, 'fixtures/profile/workshop-tone.webm');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__tone.webm') return res.writeHead(200, {'Content-Type':'video/webm'}).end(fs.readFileSync(tone));
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try {
    const mime = ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':mime}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function setup(page, opts = {}) {
  await page.addInitScript((opts) => {
    const initial = {
      theme:'dark', click_fx:'off', ambient:'off', trail:false, onboarded:true,
      discord_rpc:false, sound_fx:true, update_enabled:false, ui_scale:opts.scale || 100,
      wallpaper:opts.wallpaper || 'workshop', wallpaper_fit:'cover', wallpaper_blur:0,
      wallpaper_dim:40, wallpaper_recent:[], wallpaper_workshop_project:opts.scene ? '/steam/scene' : '/steam/video',
      wallpaper_engine_enabled:opts.enabled !== false, wallpaper_workshop_audio:opts.audio === true,
      ...(opts.wallpaper === 'custom' ? {custom_wallpaper:'tone.webm'} : {})
    };
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const mock = window.__weTest = {
      calls:[], settings:JSON.parse(localStorage.getItem('we-settings') || JSON.stringify(initial)),
      holdSource:!!opts.holdSource, holdScan:!!opts.holdScan, sourceWaiters:[], scanWaiters:[],
      failEnable:false, failAudio:false, sceneAlive:true,
      projects:[
        {title:'Видео со звуком',directory:'/steam/video',kind:'video',workshop_id:'123',playable:true,preview:null},
        {title:'Тестовая сцена',directory:'/steam/scene',kind:'scene',workshop_id:'456',playable:false,preview:null}
      ],
      save() { localStorage.setItem('we-settings', JSON.stringify(this.settings)); },
      releaseSources() { const waiters=this.sourceWaiters.splice(0); for (const fn of waiters) fn(); },
      releaseScans() { const waiters=this.scanWaiters.splice(0); for (const fn of waiters) fn(); },
      async invoke(command, args={}) {
        this.calls.push({command,args:clone(args)});
        switch (command) {
          case 'get_settings': return clone(this.settings);
          case 'save_settings': {
            // Mirrors the native invariant: dedicated commands own these fields.
            const before=this.settings;
            this.settings={...clone(args.settings),wallpaper_engine_enabled:before.wallpaper_engine_enabled,
              wallpaper_workshop_audio:before.wallpaper_workshop_audio,wallpaper_workshop_project:before.wallpaper_workshop_project};
            this.save(); return null;
          }
          case 'set_wallpaper_engine_enabled':
            if (this.failEnable) throw 'ошибка записи';
            this.settings={...this.settings,wallpaper_engine_enabled:args.enabled}; this.save(); return clone(this.settings);
          case 'set_wallpaper_workshop_audio':
            if (this.failAudio) throw 'ошибка записи звука';
            this.settings={...this.settings,wallpaper_workshop_audio:args.enabled}; this.save(); return clone(this.settings);
          case 'wallpaper_source': {
            if (args.source === 'custom') return this.settings.custom_wallpaper
              ? {path:'/custom/tone.webm',src:location.origin+'/__tone.webm',kind:'video'} : null;
            if (!this.settings.wallpaper_engine_enabled || !this.settings.wallpaper_workshop_project) return null;
            const scene=this.settings.wallpaper_workshop_project === '/steam/scene';
            const media=scene ? {path:'/steam/scene',src:gif,kind:'scene'}
              : {path:'/steam/video/tone.webm',src:location.origin+'/__tone.webm',kind:'video'};
            if (this.holdSource) return new Promise(resolve => this.sourceWaiters.push(() => resolve(media)));
            return media;
          }
          case 'wallpaper_scene_status': return this.sceneAlive;
          case 'scan_wallpaper_library': {
            if (!this.settings.wallpaper_engine_enabled) throw 'выключено';
            const result={projects:clone(this.projects),searched:['/steam'],engine:'wallpaper64.exe',scene_capture:true,truncated:false};
            if (this.holdScan) return new Promise(resolve => this.scanWaiters.push(() => resolve(result)));
            return result;
          }
          case 'set_workshop_wallpaper':
            if (!this.settings.wallpaper_engine_enabled) throw 'выключено';
            this.settings={...this.settings,wallpaper:'workshop',wallpaper_workshop_project:args.directory}; this.save(); return clone(this.settings);
          case 'pick_file': return '/custom/tone.webm';
          case 'set_custom_wallpaper':
            this.settings={...this.settings,wallpaper:'custom',custom_wallpaper:'tone.webm'}; this.save(); return clone(this.settings);
          case 'parse_wallpaper_workshop_link': return /steamcommunity\.com/.test(args.url) ? '123' : null;
          case 'accounts_info': return {accounts:[{uuid:'u',username:'Alex',kind:'offline'}],active:'u'};
          case 'account_skin': return {licensed:false};
          case 'account_capes': return {licensed:false,capes:[]};
          case 'system_memory': return {total_mb:16384};
          case 'list_instances': case 'running_instances': case 'list_java': return [];
          case 'search_modrinth': case 'search_curseforge': return {hits:[],total_hits:0};
          case 'version_info': return {version:'test',enabled:false};
          case 'app_info': return {home:'/data',version:'test',platform:'windows',demo:false};
          default: return null;
        }
      }
    };
    window.__TAURI__={core:{invoke:(command,args)=>mock.invoke(command,args),convertFileSrc:p=>p},event:{listen:async()=>()=>{}}};
  }, opts);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>window.omnispecDebug?.state.accounts?.active==='u');
}
async function openWall(page) {
  if (await page.locator('#modal-prefs').isHidden()) await page.locator('#btn-quick-settings').click();
  await page.locator('[data-pref="wall"]').click();
  await page.waitForSelector('#we-enabled');
}
async function waitEnabled(page, enabled) {
  await page.waitForFunction(enabled => window.__weTest.settings.wallpaper_engine_enabled === enabled
    && !window.omnispecDebug.state.wallpaperLibrary.controlBusy, enabled);
}
async function waitAudio(page, enabled) {
  await page.waitForFunction(enabled => window.__weTest.settings.wallpaper_workshop_audio === enabled
    && !window.omnispecDebug.state.wallpaperLibrary.audioBusy, enabled);
}
async function calls(page, name, filter = () => true) {
  return (await page.evaluate(name => window.__weTest.calls.filter(c => c.command === name), name)).filter(filter);
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try {
    // Browser autoplay policy can reject a saved audible video. It must still
    // animate muted, explain why, and restore audio on a real user gesture.
    {
      const page=await browser.newPage({viewport:{width:1280,height:850}});
      const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
      await setup(page,{audio:true});
      await page.waitForFunction(()=>window.omnispecDebug.state.workshopWall?.kind==='video' && !document.querySelector('#wall-video').hidden);
      await page.waitForFunction(()=>{const v=document.querySelector('#wall-video');return v.muted && !v.paused && v.readyState >= 2;},null,{timeout:10000});
      assert.match(await page.locator('#toasts').innerText(),/звук видео.*нажми/i);
      assert.equal(await page.evaluate(()=>window.__weTest.settings.wallpaper_workshop_audio),true);
      await page.locator('#btn-quick-settings').click();
      await page.waitForFunction(()=>{const v=document.querySelector('#wall-video');return !v.muted && !v.paused;});
      assert.deepEqual(errors,[]);
      console.log('WE_AUTOPLAY_FALLBACK: video keeps moving and sound resumes on gesture — OK (mock backend)');
      await page.close();
    }
    // Wry/WebView2 opts in to this Chromium autoplay policy by default.
    {
      const autoplayBrowser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
      try {
        const page=await autoplayBrowser.newPage({viewport:{width:1280,height:850}});
        const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
        await setup(page,{audio:true});
        await page.waitForFunction(()=>{const v=document.querySelector('#wall-video');return !v.hidden && !v.muted && !v.paused && v.readyState >= 2;},null,{timeout:10000});
        assert.deepEqual(errors,[]);
        console.log('WE_AUDIO_RESTART: saved audio starts under Wry autoplay policy — OK (mock backend)');
        await page.close();
      } finally {await autoplayBrowser.close();}
    }
    // Off at startup: no workshop read, no automatic scan or previews. On restores.
    {
      const page=await browser.newPage({viewport:{width:1280,height:850}});
      const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
      await setup(page,{enabled:false});
      await openWall(page);
      await page.waitForTimeout(350);
      assert.equal((await calls(page,'wallpaper_source',c=>c.args.source==='workshop')).length,0);
      assert.equal((await calls(page,'scan_wallpaper_library')).length,0);
      assert(await page.locator('#wall-video').isHidden());
      assert.equal(await page.locator('#we-enabled').getAttribute('aria-checked'),'false');
      assert(await page.locator('#we-refresh').isDisabled());
      assert.match(await page.locator('.we-empty').innerText(),/проект сохранён/i);
      assert.match(await page.locator('.we-section').innerText(),/звук сцен.*рабочий стол/i);
      await page.locator('#wall-link').fill('https://steamcommunity.com/sharedfiles/filedetails/?id=123');
      await page.locator('#wall-link-add').click();
      await page.waitForFunction(()=>document.querySelector('#toasts')?.innerText.includes('Включи Wallpaper Engine'));
      assert.equal((await calls(page,'scan_wallpaper_library')).length,0);
      await page.locator('#we-enabled').click();
      await waitEnabled(page,true);
      await page.waitForFunction(()=>window.omnispecDebug.state.workshopWall?.kind==='video' && !document.querySelector('#wall-video').hidden);
      await page.waitForSelector('#we-grid [data-we-card="0"]');
      assert.equal(await page.locator('#we-enabled').getAttribute('aria-checked'),'true');
      assert.equal(await page.locator('#we-audio').getAttribute('aria-checked'),'false');
      assert(await page.locator('#wall-video').evaluate(v=>v.muted && v.loop));
      await page.waitForFunction(()=>!document.querySelector('#wall-video').paused);

      // Actual short WebM contains VP8 video + Opus sound; the system audio is
      // muted by headless Chromium, but playback and the media mute property are real.
      await page.locator('#we-audio').click();
      await waitAudio(page,true);
      assert.equal(await page.locator('#we-audio').getAttribute('aria-checked'),'true');
      assert(await page.locator('#wall-video').evaluate(v=>!v.muted && !v.paused && v.readyState >= 2));
      assert.equal(await page.evaluate(()=>window.__weTest.settings.sound_fx),true,'UI sound setting remains independent');
      await page.locator('#we-audio').click();
      await waitAudio(page,false);
      assert(await page.locator('#wall-video').evaluate(v=>v.muted && !v.paused));
      assert.equal((await calls(page,'open_wallpaper_engine')).length,0,'no global WE command for sound');

      await page.locator('#we-enabled').click();
      await waitEnabled(page,false);
      assert(await page.locator('#wall-video').evaluate(v=>v.hidden && v.paused && !v.hasAttribute('src')));
      assert.equal(await page.evaluate(()=>window.__weTest.settings.wallpaper_workshop_project),'/steam/video');
      assert.equal(await page.evaluate(()=>window.__weTest.settings.wallpaper),'workshop');
      await page.reload();
      await page.waitForFunction(()=>window.omnispecDebug?.state.accounts?.active==='u');
      await openWall(page);
      await page.waitForTimeout(250);
      assert.equal((await calls(page,'wallpaper_source',c=>c.args.source==='workshop')).length,0);
      assert.equal((await calls(page,'scan_wallpaper_library')).length,0);
      assert.equal(await page.locator('#we-enabled').getAttribute('aria-checked'),'false');
      assert.equal(await page.locator('#we-audio').getAttribute('aria-checked'),'false');
      assert.deepEqual(errors,[]);
      console.log('WE_CONTROLS: persisted off/on, no disabled scanning, WebM audio toggle, saved selection — OK (mock backend)');
      await page.close();
    }

    // Cancel an in-flight scene restore and an in-flight scan; late responses
    // must not resurrect the scene, previews, or an error after disabling.
    {
      const page=await browser.newPage({viewport:{width:1280,height:850}});
      const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
      await setup(page,{scene:true,holdSource:true,holdScan:true});
      await openWall(page);
      await page.waitForFunction(()=>window.__weTest.sourceWaiters.length && window.__weTest.scanWaiters.length);
      await page.locator('#we-enabled').click();
      await waitEnabled(page,false);
      await page.evaluate(()=>window.__weTest.releaseSources());
      await page.evaluate(()=>window.__weTest.releaseScans());
      await page.waitForTimeout(150);
      assert(await page.locator('#wall-scene').isHidden());
      assert.equal(await page.locator('#we-grid').count(),0);
      assert.equal(await page.evaluate(()=>window.omnispecDebug.state.workshopWall),null);
      assert.equal(await page.evaluate(()=>window.omnispecDebug.state.wallpaperLibrary.projects.length),0);
      assert.equal(await page.evaluate(()=>window.omnispecDebug.state.wallpaperLibrary.sceneError),'');
      assert.equal(await page.evaluate(()=>window.__weTest.settings.wallpaper_workshop_project),'/steam/scene');
      await page.evaluate(()=>{window.__weTest.holdSource=false;window.__weTest.holdScan=false;});
      await page.locator('#we-enabled').click();
      await waitEnabled(page,true);
      await page.waitForFunction(()=>window.omnispecDebug.state.workshopWall?.kind==='scene' && !document.querySelector('#wall-scene').hidden);
      await page.waitForSelector('#we-grid [data-we-card="1"]');
      assert.equal(await page.evaluate(()=>window.__weTest.settings.wallpaper_workshop_project),'/steam/scene');
      await page.locator('#we-audio').click(); await waitAudio(page,true);
      assert(!(await page.locator('#wall-scene').isHidden()),'video-only sound control does not stop a scene');
      assert.deepEqual(errors,[]);
      console.log('WE_LATE_RESPONSES: pending scan and scene cannot revive after disable; restore works — OK (scene mocked)');
      await page.close();
    }

    // A different custom video keeps running and stays muted, even if the
    // Workshop sound option is on and WE integration is switched off.
    {
      const page=await browser.newPage({viewport:{width:1080,height:700}});
      const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
      await setup(page,{wallpaper:'custom',audio:true});
      await page.waitForFunction(()=>window.omnispecDebug.state.customWall?.kind==='video' && !document.querySelector('#wall-video').hidden);
      await openWall(page);
      assert(await page.locator('#wall-video').evaluate(v=>v.muted && !v.hidden));
      await page.locator('#we-enabled').click(); await waitEnabled(page,false);
      assert(await page.locator('#wall-video').evaluate(v=>v.muted && !v.hidden && v.hasAttribute('src')));
      assert.equal(await page.evaluate(()=>window.__weTest.settings.wallpaper),'custom');
      assert.equal(await page.evaluate(()=>window.__weTest.settings.wallpaper_workshop_project),'/steam/video');
      await page.locator('#we-enabled').click(); await waitEnabled(page,true);
      await page.locator('[data-wall="workshop"]').click();
      await page.waitForFunction(()=>window.omnispecDebug.state.wall.wallpaper==='workshop' && !document.querySelector('#wall-video').muted);
      assert.equal(await page.evaluate(()=>window.__weTest.settings.wallpaper_workshop_project),'/steam/video');
      assert.deepEqual(errors,[]);
      console.log('WE_CUSTOM_ISOLATION: unrelated video unaffected; saved project is reselectable — OK');
      await page.close();
    }

    // Failures roll controls back and do not silently claim persistence.
    {
      const page=await browser.newPage({viewport:{width:1280,height:850}});
      const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
      await setup(page,{}); await openWall(page);
      await page.waitForSelector('#we-grid [data-we-card="0"]');
      await page.evaluate(()=>{window.__weTest.failEnable=true;});
      await page.locator('#we-enabled').click();
      await page.waitForFunction(()=>!window.omnispecDebug.state.wallpaperLibrary.controlBusy && document.querySelector('#toasts')?.innerText.includes('ошибка записи'));
      assert.equal(await page.locator('#we-enabled').getAttribute('aria-checked'),'true');
      assert.equal(await page.evaluate(()=>window.__weTest.settings.wallpaper_engine_enabled),true);
      await page.evaluate(()=>{window.__weTest.failAudio=true;});
      await page.locator('#we-audio').click();
      await page.waitForFunction(()=>!window.omnispecDebug.state.wallpaperLibrary.audioBusy && document.querySelector('#toasts')?.innerText.includes('ошибка записи звука'));
      assert.equal(await page.locator('#we-audio').getAttribute('aria-checked'),'false');
      assert.equal(await page.evaluate(()=>window.__weTest.settings.wallpaper_workshop_audio),false);
      assert(await page.locator('#wall-video').evaluate(v=>v.muted));
      assert.deepEqual(errors,[]);
      console.log('WE_SAVE_FAILURES: rollback and visible error — OK');
      await page.close();
    }
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
