// Browser UI regression with explicitly delayed fake Minecraft responses.
// It does NOT authenticate with Microsoft or contact a Minecraft account.
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
    const mime = ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':mime}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function setup(page) {
  await page.addInitScript(() => {
    function png(color) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 64, 64);
      return canvas.toDataURL('image/png');
    }
    const images = { A: png('#e01010'), B: png('#1020e0'), local: png('#10d020') };
    const state = window.__raceTest = {
      images, calls: [], pending: [], active: 'A',
      accounts: [{uuid:'A', username:'Alpha', kind:'microsoft'}, {uuid:'B', username:'Beta', kind:'microsoft'}, {uuid:'O', username:'Offline', kind:'offline'}],
      skinMode: {A:'ok', B:'ok'}, capeMode: {A:'defer', B:'ok'}, capeSetMode: 'ok', saveMode: 'ok', applyMode: 'ok',
      settings: {theme:'dark', click_fx:'off', ambient:'off', trail:false, onboarded:true, discord_rpc:false,
        update_enabled:false, ui_scale:100, wallpaper:null, wallpaper_fit:'cover', wallpaper_blur:0, wallpaper_dim:40,
        wallpaper_recent:[], skin_presets:[{id:'local',name:'Локальный',path:'/skins/local.png',variant:'classic',angle:0}], skin_favorites:[]},
      defer(key, value) { return new Promise(resolve => this.pending.push({key, resolve:()=>resolve(value)})); },
      release(key) { const pending=this.pending.filter(p=>p.key===key); this.pending=this.pending.filter(p=>p.key!==key); pending.forEach(p=>p.resolve()); return pending.length; },
      async invoke(command, args={}) {
        this.calls.push({command,args:JSON.parse(JSON.stringify(args))});
        switch(command) {
          case 'get_settings': return JSON.parse(JSON.stringify(this.settings));
          case 'save_settings': this.settings=JSON.parse(JSON.stringify(args.settings)); return null;
          case 'accounts_info': return {accounts:this.accounts,active:this.active};
          case 'account_set_active': this.active=args.uuid; return {accounts:this.accounts,active:this.active};
          case 'account_skin': {
            const id=args.accountUuid || this.active;
            const value={account_uuid:id,licensed:true,variant:id==='A'?'slim':'classic',name:id,data_url:this.images[id]};
            const mode=this.skinMode[id];
            if(mode==='defer') return this.defer('skin-'+id,value);
            if(mode==='fail') throw 'Minecraft HTTP 503: недоступен';
            if(mode==='empty') return {...value,data_url:null,message:'Нет активной текстуры'};
            return value;
          }
          case 'account_capes': {
            const id=args.accountUuid || this.active;
            const value={account_uuid:id,licensed:true,capes:[{id:'cape-'+id,alias:'Cape '+id,active:true,data_url:this.images[id]},
              {id:'cape-'+id+'2',alias:'Second '+id,active:false,data_url:this.images[id]}]};
            const mode=this.capeMode[id];
            if(mode==='defer') return this.defer('capes-'+id,value);
            if(mode==='fail') throw 'Плащи: HTTP 429';
            if(mode==='warning') return {...value,warning:'Не удалось загрузить некоторые изображения плащей'};
            return value;
          }
          case 'set_cape':
            if(this.capeSetMode==='defer') return this.defer('set-cape', {ok:true,account_uuid:args.accountUuid});
            if(this.capeSetMode==='fail') throw 'Плащ не разрешён: HTTP 403';
            return {ok:true,account_uuid:args.accountUuid};
          case 'image_data_url': return this.images.local;
          case 'save_skin_png':
            if(this.saveMode==='defer') return this.defer('save', '/skins/favorite.png');
            return '/skins/favorite.png';
          case 'apply_skin':
            if(this.applyMode==='defer') return this.defer('apply', {ok:true,account_uuid:args.accountUuid});
            return {ok:true,account_uuid:args.accountUuid};
          case 'system_memory': return {total_mb:16384};
          case 'list_instances': case 'running_instances': case 'running_sessions': case 'list_java': return [];
          case 'version_info': return {version:'test',enabled:false};
          case 'app_info': return {home:'/data',version:'test',platform:'windows',demo:false};
          default: return null;
        }
      }
    };
    window.__TAURI__={core:{invoke:(command,args)=>state.invoke(command,args),convertFileSrc:p=>p},event:{listen:async()=>()=>{}}};
  });
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:850}});
  const errors=[]; page.on('pageerror',error=>errors.push(String(error)));
  try {
    await setup(page);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    // A licensed account loads its own Mojang avatar at startup, without the
    // user having to open settings or rely on the third-party image service.
    await page.waitForFunction(()=>window.omnispecDebug?.state.accounts?.active==='A' && window.omnispecDebug.state.skin?.accountTexture);
    assert.match(await page.locator('#account-chip-avatar img').getAttribute('src'),/^data:image\/png/);
    await page.evaluate(()=>window.__raceTest.skinMode.A='defer');
    await page.locator('#btn-quick-settings').click({force:true});
    await page.locator('[data-pref="profile"]').click();
    await page.waitForFunction(()=>window.__raceTest.pending.some(x=>x.key==='skin-A') && window.__raceTest.pending.some(x=>x.key==='capes-A'));

    // A starts first but finishes after B. Neither A's skin nor cape may leak into B.
    await page.locator('[data-uuid="B"] [data-acc="pick"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.accounts.active==='B' && window.omnispecDebug.state.skin?.currentName==='B' && window.omnispecDebug.state.capes?.list[0]?.id==='cape-B');
    await page.evaluate(()=>{window.__raceTest.release('skin-A');window.__raceTest.release('capes-A');});
    await page.waitForTimeout(200);
    let snapshot=await page.evaluate(()=>{
      const s=window.omnispecDebug.state;
      return {account:s.accounts.active,name:s.skin.currentName,pixel:Array.from(s.skin.texture.getContext('2d').getImageData(0,0,1,1).data),cape:s.capes.list[0].id,
        avatar:document.querySelector('[data-uuid="B"] .acc-avatar img')?.getAttribute('src')};
    });
    assert.equal(snapshot.account,'B'); assert.equal(snapshot.name,'B'); assert(snapshot.pixel[2]>200 && snapshot.pixel[0]<40);
    assert.equal(snapshot.cape,'cape-B'); assert.match(snapshot.avatar,/^data:image\/png/,'own Mojang texture supplies the avatar');

    // Choosing a local file while a refresh is pending must not be overwritten.
    await page.evaluate(()=>window.__raceTest.skinMode.B='defer');
    await page.locator('#skin-refresh').click();
    await page.waitForFunction(()=>window.__raceTest.pending.some(x=>x.key==='skin-B'));
    await page.locator('[data-skin-id="local"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.skin.currentPath==='/skins/local.png');
    await page.evaluate(()=>window.__raceTest.release('skin-B'));
    await page.waitForFunction(()=>!window.omnispecDebug.state.skin.loading);
    snapshot=await page.evaluate(()=>{
      const s=window.omnispecDebug.state.skin;
      return {path:s.currentPath,local:Array.from(s.texture.getContext('2d').getImageData(0,0,1,1).data),account:Array.from(s.accountTexture.getContext('2d').getImageData(0,0,1,1).data)};
    });
    assert.equal(snapshot.path,'/skins/local.png'); assert(snapshot.local[1]>180 && snapshot.local[2]<40);
    assert(snapshot.account[2]>200,'server avatar remains separate from local preview');

    // Explicit refresh must report network errors and an absent skin, not success.
    await page.evaluate(()=>window.__raceTest.skinMode.B='fail');
    await page.locator('#skin-refresh').click();
    await page.waitForFunction(()=>document.querySelector('#skin-status')?.textContent.includes('HTTP 503'));
    assert.equal(await page.evaluate(()=>window.omnispecDebug.state.skin.currentPath),'/skins/local.png');
    await page.evaluate(()=>window.__raceTest.skinMode.B='empty');
    await page.locator('#skin-refresh').click();
    await page.waitForFunction(()=>document.querySelector('#skin-status')?.textContent.includes('Нет активной текстуры'));
    assert.equal(await page.evaluate(()=>window.omnispecDebug.state.skin.currentPath),'/skins/local.png');
    await page.evaluate(()=>{window.__raceTest.skinMode.B='ok';window.__raceTest.capeMode.B='fail';});
    await page.locator('#cape-refresh').click();
    await page.waitForFunction(()=>document.querySelector('#skin-capes')?.textContent.includes('HTTP 429'));
    assert.equal(await page.locator('#skin-capes [data-cape-id="cape-B"]').count(),1,'previous capes remain visible on network failure');
    // A partial texture failure keeps the list, shows a warning and must not
    // announce unconditional success when explicitly refreshing.
    await page.evaluate(()=>window.__raceTest.capeMode.B='warning');
    await page.locator('#cape-refresh').click();
    await page.waitForFunction(()=>document.querySelector('#skin-capes')?.textContent.includes('Не удалось загрузить некоторые изображения плащей'));
    assert.equal(await page.locator('#skin-capes [data-cape-id="cape-B"]').count(),1);
    assert(await page.locator('#toasts .toast.err').filter({hasText:'Не удалось загрузить некоторые изображения плащей'}).count());

    // Two clicks and a refresh while the first cape mutation is pending must
    // result in just one network mutation. Afterwards the desired cape wins.
    await page.evaluate(()=>{window.__raceTest.capeMode.B='ok';window.__raceTest.capeSetMode='defer';});
    await page.locator('#skin-capes [data-cape-id="cape-B2"]').click();
    await page.waitForFunction(()=>window.__raceTest.pending.some(p=>p.key==='set-cape'));
    const capeCalls=await page.evaluate(()=>window.__raceTest.calls.filter(c=>c.command==='set_cape').length);
    const refreshCalls=await page.evaluate(()=>window.__raceTest.calls.filter(c=>c.command==='account_capes').length);
    await page.locator('#skin-capes [data-cape-id=""]').click();
    await page.locator('#cape-refresh').click();
    assert.equal(await page.evaluate(()=>window.__raceTest.calls.filter(c=>c.command==='set_cape').length),capeCalls);
    assert.equal(await page.evaluate(()=>window.__raceTest.calls.filter(c=>c.command==='account_capes').length),refreshCalls);
    const capeCall=await page.evaluate(()=>window.__raceTest.calls.filter(c=>c.command==='set_cape').at(-1));
    assert.equal(capeCall.args.accountUuid,'B'); assert.equal(capeCall.args.capeId,'cape-B2');
    await page.evaluate(()=>window.__raceTest.release('set-cape'));
    await page.waitForFunction(()=>document.querySelector('#skin-capes [data-cape-id="cape-B2"]')?.classList.contains('is-active'));

    // A rejected mutation does not mark the requested cape as active.
    await page.evaluate(()=>window.__raceTest.capeSetMode='fail');
    await page.locator('#skin-capes [data-cape-id=""]').click();
    await page.waitForFunction(()=>[...document.querySelectorAll('#toasts .toast.err')].some(t=>t.textContent.includes('HTTP 403')));
    assert(await page.locator('#skin-capes [data-cape-id="cape-B2"]').evaluate(el=>el.classList.contains('is-active')));

    // A delayed mutation still targets B and cannot change A's cape after an
    // account switch. The two service responses are only synthetic mocks.
    await page.evaluate(()=>{window.__raceTest.skinMode.A='ok';window.__raceTest.capeMode.A='ok';window.__raceTest.capeSetMode='defer';});
    await page.locator('#skin-capes [data-cape-id=""]').click();
    await page.waitForFunction(()=>window.__raceTest.pending.some(p=>p.key==='set-cape'));
    assert.equal(await page.evaluate(()=>window.__raceTest.calls.filter(c=>c.command==='set_cape').at(-1).args.accountUuid),'B');
    await page.locator('[data-uuid="A"] [data-acc="pick"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.accounts.active==='A' && window.omnispecDebug.state.capes?.list[0]?.id==='cape-A');
    await page.evaluate(()=>window.__raceTest.release('set-cape'));
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>window.omnispecDebug.state.capes.list.find(c=>c.active)?.id),'cape-A');
    await page.locator('[data-uuid="B"] [data-acc="pick"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.accounts.active==='B' && window.omnispecDebug.state.skin?.currentName==='B');

    // Applying A while switching to B targets A; a late response never edits B.
    await page.evaluate(()=>{window.__raceTest.skinMode.A='ok';window.__raceTest.capeMode.A='ok';window.__raceTest.applyMode='defer';});
    await page.locator('[data-uuid="A"] [data-acc="pick"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.accounts.active==='A' && window.omnispecDebug.state.skin?.currentName==='A');
    await page.locator('[data-skin-id="local"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.skin.currentPath==='/skins/local.png');
    await page.locator('#skin-apply').click();
    await page.waitForFunction(()=>window.__raceTest.pending.some(x=>x.key==='apply'));
    const applied=await page.evaluate(()=>window.__raceTest.calls.filter(c=>c.command==='apply_skin').at(-1));
    assert.equal(applied.args.accountUuid,'A'); assert.equal(applied.args.path,'/skins/local.png');
    await page.locator('[data-uuid="B"] [data-acc="pick"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.accounts.active==='B' && window.omnispecDebug.state.skin?.currentName==='B');
    await page.evaluate(()=>window.__raceTest.release('apply'));
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>window.omnispecDebug.state.skin.currentName),'B');

    // If switching accounts while a favorite is being saved, do not submit it at all.
    await page.evaluate(()=>{
      const s=window.omnispecDebug.state.skin; s.currentPath=''; s.dataUrl=window.__raceTest.images.B; s.fromAccount=false;
      window.__raceTest.saveMode='defer';
    });
    const before=await page.evaluate(()=>window.__raceTest.calls.filter(c=>c.command==='apply_skin').length);
    await page.locator('#skin-apply').click();
    await page.waitForFunction(()=>window.__raceTest.pending.some(x=>x.key==='save'));
    await page.locator('[data-uuid="A"] [data-acc="pick"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.accounts.active==='A');
    await page.evaluate(()=>window.__raceTest.release('save'));
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>window.__raceTest.calls.filter(c=>c.command==='apply_skin').length),before);

    await page.locator('[data-uuid="O"] [data-acc="pick"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.accounts.active==='O' && !window.omnispecDebug.state.skin.licensed);
    assert(await page.locator('#skin-apply').isDisabled());
    assert.deepEqual(errors,[]);
    console.log('profile-account-races-ui: stale responses, switching, local preview, errors, capes and target UUID passed (mocked services)');
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
