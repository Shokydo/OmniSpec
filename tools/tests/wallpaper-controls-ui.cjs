// Browser-level test: local media, link form, legacy settings and no Wallpaper Engine calls.
// The video fixture is an actual short WebM with an audio track; playback is local.
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

async function setup(page) {
  await page.addInitScript(() => {
    const clone = x => JSON.parse(JSON.stringify(x));
    const initial = {
      theme:'dark', click_fx:'off', ambient:'off', trail:false, onboarded:true,
      discord_rpc:false, update_enabled:false, ui_scale:100,
      wallpaper:'workshop', wallpaper_workshop_project:'/steam/scene', wallpaper_steam_path:'/steam',
      wallpaper_engine_enabled:true, wallpaper_workshop_audio:true,
      wallpaper_fit:'cover', wallpaper_blur:0, wallpaper_dim:40, wallpaper_recent:[],
      custom_wallpaper:'old.gif', username:'Kept', skin_presets:[{id:'keep',name:'Keep',path:'/skins/keep.png'}]
    };
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const mock = window.__wallTest = {
      settings:JSON.parse(localStorage.getItem('wall-settings') || JSON.stringify(initial)), calls:[], savedSnapshots:[], failDownload:false,
      holdNextSave:false, saveHeld:[],
      save() { localStorage.setItem('wall-settings', JSON.stringify(this.settings)); },
      releaseSave() { const release=this.saveHeld.shift(); if(!release) throw Error('no held save'); release(); },
      async invoke(command, args={}) {
        this.calls.push({command,args:clone(args)});
        switch (command) {
          case 'get_settings': return clone(this.settings);
          case 'save_settings': {
            if(this.holdNextSave) { this.holdNextSave=false; await new Promise(resolve=>this.saveHeld.push(resolve)); }
            // Match the real backend: an old filename marks a stale source too.
            const incoming=clone(args.settings), stale=incoming.custom_wallpaper!==this.settings.custom_wallpaper;
            this.settings={...incoming,custom_wallpaper:this.settings.custom_wallpaper,
              wallpaper:stale ? this.settings.wallpaper : incoming.wallpaper};
            this.savedSnapshots.push(clone(this.settings));
            this.save(); return null;
          }
          case 'pick_file': return '/home/test/tone.webm';
          case 'set_custom_wallpaper':
            this.settings={...this.settings,wallpaper:'custom',custom_wallpaper:'tone.webm'};
            this.save(); return clone(this.settings);
          case 'download_custom_wallpaper':
            if (this.failDownload) throw 'test download failure';
            this.settings={...this.settings,wallpaper:'custom',custom_wallpaper:'download.gif'};
            this.save(); return clone(this.settings);
          case 'wallpaper_history_preview':
            return args.name.endsWith('.gif') ? {path:'/wall/file.gif',src:gif,kind:'gif'} : {path:'/wall/tone.webm',src:location.origin+'/__tone.webm',kind:'video'};
          case 'wallpaper_history_preview_release': return null;
          case 'wallpaper_source':
            if (args.source !== 'custom') throw 'unexpected external source';
            return this.settings.custom_wallpaper?.endsWith('.gif')
              ? {path:'/wall/file.gif',src:gif,kind:'gif'}
              : {path:'/wall/tone.webm',src:location.origin+'/__tone.webm',kind:'video'};
          case 'accounts_info': return {accounts:[{uuid:'u',username:'Alex',kind:'offline'}],active:'u'};
          case 'account_skin': case 'account_capes': return {licensed:false,capes:[]};
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
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>window.omnispecDebug?.state.accounts?.active==='u');
}
async function openWall(page) {
  if (await page.locator('#modal-prefs').isHidden()) await page.locator('#btn-quick-settings').click();
  await page.locator('[data-pref="wall"]').click();
  await page.waitForSelector('#wall-link');
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true, args:['--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage({viewport:{width:1280,height:850}});
  const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
  try {
    await setup(page);
    await page.evaluate(() => { window.omnispecDebug.state.settings.wallpaper_recent = ['custom:old.gif','custom:tone.webm']; });
    await openWall(page);
    await page.waitForFunction(() => [...document.querySelectorAll('[data-wall-history-preview]')].length === 2 && [...document.querySelectorAll('[data-wall-history-preview]')].every(e => e.style.backgroundImage.includes('data:image/jpeg')), null, {timeout:15000});
    assert.equal(await page.locator('#wall-history video, #wall-history img').count(), 0, 'history previews are static frames');
    assert(await page.locator('[data-wall-history-preview="tone.webm"]').evaluate(e => e.classList.contains('is-video')));
    await page.locator('[data-pref="look"]').click();
    assert.equal(await page.locator('#wall-history').count(), 0, 'inactive settings tab is unmounted');
    await page.locator('[data-close-prefs]').first().click();
    await page.waitForFunction(() => document.querySelector('#prefs-body').children.length === 0);
    assert.equal(await page.locator('#prefs-body').count(), 1, 'closed settings releases its content');
    await page.locator('.app-body > .sidebar').evaluate(el => { el.style.setProperty('width','80px','important'); el.style.setProperty('flex-basis','80px','important'); });
    await page.waitForFunction(() => document.querySelector('#btn-quick-settings').classList.contains('is-icon-only'),null,{timeout:5000});
    assert.equal(await page.locator('#btn-quick-settings span').isVisible(), false, 'narrow settings button becomes icon only');
    await page.locator('.app-body > .sidebar').evaluate(el => { el.style.removeProperty('width'); el.style.setProperty('flex-basis','264px'); });
    await page.waitForFunction(() => !document.querySelector('#btn-quick-settings').classList.contains('is-icon-only'));
    assert(await page.locator('#wall').isHidden(),'old Workshop background is not launched');
    await openWall(page);
    assert.match(await page.locator('#prefs-body').innerText(),/исходные файлы не удалены/);
    assert.equal(await page.locator('#we-enabled, #we-grid, #we-audio, #wall-scene').count(),0);
    assert.equal(await page.evaluate(()=>window.__wallTest.settings.wallpaper_workshop_project),'/steam/scene');
    assert.equal(await page.evaluate(()=>window.__wallTest.settings.wallpaper),'workshop','old choice stays in settings until explicitly changed');

    await page.locator('#wall-pick').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.customWall?.kind==='video' && !document.querySelector('#wall-video').hidden);
    await page.waitForFunction(()=>document.querySelector('#wall-video').currentTime > 0, null, {timeout:10000});
    assert(await page.locator('#wall-video').evaluate(v=>v.muted && v.loop && v.playsInline),'audio track is muted and video loops');
    await page.locator('[data-wall=""]').click();
    assert(await page.locator('#wall-video').isHidden());
    await page.locator('[data-wall="custom"]').click();
    await page.waitForFunction(()=>!document.querySelector('#wall-video').hidden);
    assert(await page.locator('#wall-video').evaluate(v=>v.muted && v.loop));

    await page.reload();
    await page.waitForFunction(()=>window.omnispecDebug?.state.customWall?.kind==='video' && !document.querySelector('#wall-video').hidden);
    assert(await page.locator('#wall-video').evaluate(v=>v.muted && v.loop),'video restores muted after restart');
    await openWall(page);
    await page.evaluate(()=>{window.__wallTest.failDownload=true;});
    await page.locator('#wall-link').fill('https://example.org/bad.gif');
    await page.locator('#wall-link-add').click();
    await page.waitForFunction(()=>document.querySelector('#toasts').textContent.includes('test download failure'));
    assert.equal(await page.locator('#wall-link').inputValue(),'https://example.org/bad.gif','failed link remains editable');
    assert.equal(await page.evaluate(()=>window.__wallTest.settings.custom_wallpaper),'tone.webm','failure does not replace previous background');
    assert(await page.locator('#wall-video').evaluate(v=>!v.hidden && v.muted));

    // A preset is active in the old Save. Importing a new GIF must protect
    // both the filename and the selected source from that delayed write.
    await page.locator('[data-wall="aurora"]').first().click();
    await page.waitForFunction(()=>window.__wallTest.settings.wallpaper==='aurora');
    await page.evaluate(()=>{window.__wallTest.failDownload=false;window.__wallTest.holdNextSave=true;window.__wallTest.savedSnapshots=[];});
    await page.locator('#prefs-save').click();
    await page.waitForFunction(()=>window.__wallTest.saveHeld.length===1);
    await page.locator('#wall-link').fill('https://imgur.com/5yS6GCZ');
    await page.locator('#wall-link').press('Enter');
    await page.waitForFunction(()=>window.omnispecDebug.state.customWall?.kind==='gif');
    await page.evaluate(()=>window.__wallTest.releaseSave());
    await page.waitForFunction(()=>!window.omnispecDebug.state.wallLink.busy && window.omnispecDebug.state.wallLink.value==='');
    assert.equal(await page.evaluate(()=>window.omnispecDebug.state.settings.custom_wallpaper),'download.gif','late Save response does not roll back the imported filename');
    assert.equal(await page.evaluate(()=>window.omnispecDebug.state.settings.wallpaper),'custom','late Save response does not roll back the selected source');
    const snapshots=await page.evaluate(()=>window.__wallTest.savedSnapshots);
    assert(snapshots.length>=2 && snapshots.every(s=>s.custom_wallpaper==='download.gif' && s.wallpaper==='custom'),
      'even the first delayed snapshot keeps the newly selected source');
    await openWall(page);
    assert.equal(await page.locator('#wall-link').inputValue(),'');
    assert(await page.locator('#wall-video').isHidden());
    assert.match(await page.locator('#wall').evaluate(el=>el.style.backgroundImage),/data:image\/gif/);
    const result=await page.evaluate(()=>({settings:window.__wallTest.settings,calls:window.__wallTest.calls}));
    assert.equal(result.settings.wallpaper_workshop_project,'/steam/scene');
    assert.equal(result.settings.wallpaper_steam_path,'/steam');
    assert.equal(result.settings.wallpaper_workshop_audio,true);
    assert.equal(result.settings.username,'Kept');
    assert.equal(result.settings.skin_presets[0].id,'keep');
    assert.equal(result.calls.filter(c=>/wallpaper_engine|workshop|scene/.test(c.command)).length,0,'no external wallpaper-engine operations');
    assert(result.calls.some(c=>c.command==='download_custom_wallpaper' && c.args.url==='https://imgur.com/5yS6GCZ'));
    assert.deepEqual(errors,[]);
    console.log('wallpaper-controls-ui: real muted looping video, GIF, failure, links, restart and legacy preservation passed');
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
