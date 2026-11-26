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
 const page=await browser.newPage({viewport:{width:1280,height:850}}); const errors=[];
 page.on('pageerror', e => errors.push(String(e)));
 await page.route('https://www.youtube-nocookie.com/embed/**', route=>route.fulfill({status:200,contentType:'text/html',body:'<html>mock video</html>'}));
 try {
  await setup(page); await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>window.omnispecDebug?.state.accounts?.active==='licensed');
  await openPrefs(page,'wall');
  await page.locator('#wall-link').fill('https://www.youtube.com/watch?v=qDz-JtxT2gE&list=RDqDz-JtxT2gE&start_radio=1');
  await page.locator('#wall-link-add').click();
  await page.waitForFunction(()=>window.__profileTest.settings.wallpaper==='youtube:qDz-JtxT2gE');
  const src=await page.locator('#wall-youtube').getAttribute('src');
  const u=new URL(src); assert.equal(u.hostname,'www.youtube-nocookie.com'); assert.equal(u.pathname,'/embed/qDz-JtxT2gE');
  assert.equal(u.searchParams.get('playlist'),'qDz-JtxT2gE'); assert.equal(u.searchParams.get('mute'),'1');
  assert.equal(u.searchParams.get('loop'),'1'); assert.equal(u.searchParams.get('autoplay'),'1');
  assert.equal(await page.locator('#wall-youtube').isVisible(),true);
  assert.equal(await page.evaluate(()=>window.__profileTest.calls.filter(c=>c.command==='download_custom_wallpaper').length),0);
  assert.equal(await page.locator('[data-wall-history-select="youtube:qDz-JtxT2gE"]').count(),1);
  await page.evaluate(() => { Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(await page.locator('#wall-youtube').getAttribute('src'),null,'hidden window unloads YouTube');
  await page.evaluate(() => { Object.defineProperty(document,'hidden',{configurable:true,value:false}); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForSelector('#wall-youtube:not([hidden])');
  await page.reload(); await page.waitForSelector('#wall-youtube:not([hidden])');
  assert((await page.locator('#wall-youtube').getAttribute('src')).includes('/qDz-JtxT2gE?'),'restored');
  await openPrefs(page,'wall');
  await page.locator('[data-wall="aurora"]').click();
  assert.equal(await page.locator('#wall-youtube').getAttribute('src'),null);
  await page.locator('[data-wall-history-select="youtube:qDz-JtxT2gE"]').click();
  await page.waitForSelector('#wall-youtube:not([hidden])');
  await page.locator('#wall-link').fill('https://youtu.be/dQw4w9WgXcQ?t=12');
  await page.locator('#wall-link-add').click();
  await page.waitForFunction(()=>window.__profileTest.settings.wallpaper==='youtube:dQw4w9WgXcQ');
  await page.locator('#wall-link').fill('https://www.youtube.com/playlist?list=abc');
  await page.locator('#wall-link-add').click();
  assert.equal(await page.evaluate(()=>window.__profileTest.settings.wallpaper),'youtube:dQw4w9WgXcQ');
  assert.equal(await page.evaluate(()=>window.__profileTest.calls.filter(c=>c.command==='download_custom_wallpaper').length),0);
  assert.deepEqual(errors,[]);
  console.log('YOUTUBE_WALL_UI: watch, short link, secure iframe, persist, reload, history, switching and invalid links — OK (mock iframe; no live playback)');
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
