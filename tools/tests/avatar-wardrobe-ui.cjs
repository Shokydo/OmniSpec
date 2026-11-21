// Avatar layout and cape wardrobe in a browser. Minecraft responses are synthetic;
// this test never signs in or modifies a real account.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const server = http.createServer((req,res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try {
    const mime = ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':mime}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function setup(page) {
  await page.addInitScript(() => {
    const makeSkin = () => {
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const x = c.getContext('2d'); x.fillStyle = '#cc967a'; x.fillRect(0,0,64,64);
      x.fillStyle = '#4a85bb'; x.fillRect(16,16,32,32); return c.toDataURL('image/png');
    };
    const makeCape = index => {
      const c = document.createElement('canvas'); c.width = 64; c.height = 32;
      const x = c.getContext('2d');
      x.fillStyle = index % 2 ? '#dc283c' : '#e63838'; x.fillRect(1,1,10,16); // outer face
      x.fillStyle = '#16d040'; x.fillRect(0,1,1,16); // one narrow side
      x.fillStyle = '#ffe020'; x.fillRect(11,1,1,16); // other narrow side
      x.fillStyle = '#2848ed'; x.fillRect(12,1,10,16); // lining
      x.fillStyle = '#ffffff'; x.fillRect(1,0,10,1);
      x.fillStyle = '#9040ec'; x.fillRect(11,0,10,1);
      return c.toDataURL('image/png');
    };
    const skin = makeSkin();
    const capes = Array.from({length:20}, (_,i) => ({id:`cape-${i}`, alias:`Cape ${String(i).padStart(2,'0')}`, active:i===0, data_url:makeCape(i)}));
    const settings = {theme:'dark', click_fx:'off', ambient:'off', trail:false, onboarded:true, discord_rpc:false,
      update_enabled:false, ui_scale:100, wallpaper:null, wallpaper_fit:'cover', wallpaper_blur:0, wallpaper_dim:40, wallpaper_recent:[],
      skin_presets:Array.from({length:72},(_,i)=>({id:`skin-${i}`,name:`Skin ${String(i).padStart(2,'0')}`,path:`/skins/${i}.png`,variant:'classic',angle:0})),
      skin_favorites:[{id:'favorite',name:'Сохранённый образ',skinPath:'/skins/0.png',skinDataUrl:skin,skinName:'Skin 00',variant:'classic',capeId:'cape-0',capeAlias:'Cape 00',capeDataUrl:capes[0].data_url}]};
    const mock = window.__avatarTest = {
      skin, capes, settings, calls:[], active:'licensed',
      accounts:[{uuid:'licensed',username:'Alex',kind:'microsoft'},{uuid:'offline',username:'Offline',kind:'offline'}],
      async invoke(command,args={}) {
        this.calls.push({command,args:JSON.parse(JSON.stringify(args))});
        switch(command) {
          case 'get_settings': return JSON.parse(JSON.stringify(this.settings));
          case 'save_settings': this.settings=JSON.parse(JSON.stringify(args.settings)); return null;
          case 'accounts_info': return {accounts:this.accounts,active:this.active};
          case 'account_set_active': this.active=args.uuid; return {accounts:this.accounts,active:this.active};
          case 'account_skin': return {account_uuid:this.active,licensed:this.active==='licensed',variant:'classic',data_url:this.skin};
          case 'account_capes': return {account_uuid:this.active,licensed:this.active==='licensed',capes:this.active==='licensed'?this.capes.map(c=>({...c})):[]};
          case 'set_cape': this.capes.forEach(c=>c.active=c.id===args.capeId); return {ok:true};
          case 'image_data_url': return this.skin;
          case 'apply_skin': return null;
          case 'system_memory': return {total_mb:16384};
          case 'list_instances': case 'running_instances': case 'running_sessions': case 'list_java': return [];
          case 'version_info': return {version:'test',enabled:false};
          case 'app_info': return {home:'/data',version:'test',platform:'linux',demo:false};
          default: return null;
        }
      }
    };
    window.__TAURI__={core:{invoke:(command,args)=>mock.invoke(command,args),convertFileSrc:p=>p},event:{listen:async()=>()=>{}}};
  });
}

async function layout(page, width, height) {
  await page.setViewportSize({width,height});
  await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(150);
  const x=await page.evaluate(()=>{
    const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const body=document.querySelector('#prefs-body'), library=document.querySelector('#skin-library'), capes=document.querySelector('#skin-capes');
    const canvas=document.querySelector('#skin-canvas');
    return {body:rect('#prefs-body'),model:rect('.profile-model'),favorite:rect('.profile-favorites'),skins:rect('.profile-skins'),capes:rect('.profile-capes'),stage:rect('.skin-stage'),canvas:rect('#skin-canvas'),
      canvasPixels:{width:canvas.width,height:canvas.height,dpr:Math.min(2,window.devicePixelRatio||1)},
      bodyScroll:body.scrollHeight-body.clientHeight, skinOverflow:library.scrollHeight-library.clientHeight, capeOverflow:capes.scrollWidth-capes.clientWidth};
  });
  const label=`${width}x${height}`;
  assert(x.bodyScroll<=1,`${label}: page scrolls ${x.bodyScroll}px`);
  for (const name of ['model','favorite','skins','capes']) {
    const r=x[name], b=x.body;
    assert(r.left>=b.left-1 && r.right<=b.right+1 && r.top>=b.top-1 && r.bottom<=b.bottom+1,`${label}: ${name} outside viewport ${JSON.stringify(x)}`);
  }
  assert(x.model.right<=x.skins.left+1 && x.favorite.bottom<=x.skins.top+1,`${label}: model left, favorite/skins right`);
  assert(x.capes.top>=Math.max(x.model.bottom,x.skins.bottom)-1 && Math.abs(x.capes.left-x.model.left)<1 && Math.abs(x.capes.right-x.skins.right)<1,`${label}: capes below full width`);
  assert(x.stage.height>=90,`${label}: model preview too short`);
  assert(x.canvas.left>=x.stage.left-1 && x.canvas.right<=x.stage.right+1 && x.canvas.top>=x.stage.top-1 && x.canvas.bottom<=x.stage.bottom+1,`${label}: model canvas clipped after resize ${JSON.stringify(x)}`);
  assert(Math.abs(x.canvasPixels.height-Math.round(x.canvas.height*x.canvasPixels.dpr))<=2,`${label}: model backing canvas not resized ${JSON.stringify(x)}`);
  assert(x.skinOverflow>100 && x.capeOverflow>100,`${label}: lists did not overflow within their panels`);
  return x;
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1080,height:640}, reducedMotion:'reduce'});
  const errors=[]; page.on('pageerror',error=>errors.push(String(error)));
  try {
    await setup(page);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>window.omnispecDebug?.state.accounts?.active==='licensed');
    await page.locator('#btn-quick-settings').click();
    await page.locator('[data-pref="profile"]').click();
    assert.equal(await page.locator('.profile-accounts, .profile-active').count(),2);
    assert.equal(await page.locator('#skin-capes, #skin-library, #skin-favorites').count(),0);
    await page.locator('[data-pref="avatar"]').click();
    await page.waitForSelector('#skin-capes [data-cape-id="cape-19"]');
    await page.waitForSelector('#skin-capes [data-cape-id="cape-0"] canvas[data-cape-rendered="3d"]');
    await page.waitForSelector('#skin-library [data-skin-id="skin-71"]');
    assert.equal(await page.locator('#skin-favorites [data-fav="favorite"]').count(),1);
    for (const [w,h] of [[1080,640],[1280,720],[1400,880],[1920,1080]]) await layout(page,w,h);
    await layout(page,1080,640);
    if (process.env.OMNISPEC_UI_SHOTS) await page.screenshot({path:path.join(process.env.OMNISPEC_UI_SHOTS,'avatar-1080x640.png')});
    console.log('AVATAR_LAYOUT_AT_100_PERCENT_OK');

    // The resized canvas must still receive drag events and reset on double-click.
    const modelBox=await page.locator('#skin-canvas').boundingBox();
    const initialYaw=await page.evaluate(()=>window.omnispecDebug.state.skin.yaw);
    await page.mouse.move(modelBox.x+modelBox.width/2,modelBox.y+modelBox.height/2);
    await page.mouse.down();
    await page.mouse.move(modelBox.x+modelBox.width/2+45,modelBox.y+modelBox.height/2+12,{steps:4});
    await page.mouse.up();
    assert(Math.abs((await page.evaluate(()=>window.omnispecDebug.state.skin.yaw))-initialYaw)>5,'3D player does not rotate after resizing');
    await page.locator('#skin-canvas').dblclick();
    assert.equal(await page.evaluate(()=>window.omnispecDebug.state.skin.yaw),-18);
    console.log('AVATAR_MODEL_DRAG_AND_RESET_OK');

    // The mini is an actual angled cuboid rendered from the official texture's
    // different faces: both the outer face and an edge must produce pixels.
    const pixels=await page.locator('#skin-capes [data-cape-id="cape-0"] canvas').evaluate(canvas=>{
      const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
      let opaque=0,red=0,green=0,yellow=0;
      for(let i=0;i<data.length;i+=4) if(data[i+3]>200) {
        opaque++;
        if(data[i]>180 && data[i+1]<90 && data[i+2]<90) red++;
        if(data[i]<80 && data[i+1]>150 && data[i+2]<110) green++;
        if(data[i]>180 && data[i+1]>150 && data[i+2]<100) yellow++;
      }
      return {opaque,red,green,yellow,corner:data[3],total:canvas.width*canvas.height};
    });
    assert(pixels.opaque>1500 && pixels.opaque<pixels.total*.8 && pixels.corner===0,`cape is a shaped transparent 3D object: ${JSON.stringify(pixels)}`);
    assert(pixels.red>500 && pixels.green+pixels.yellow>20,`outer face AND edge visible: ${JSON.stringify(pixels)}`);
    console.log('CAPE_3D_FRONT_AND_EDGE_OK',JSON.stringify(pixels));

    const countCalls=()=>page.evaluate(()=>window.__avatarTest.calls.filter(c=>c.command==='set_cape').length);
    const chosen=()=>page.locator('#skin-capes .cape-card[aria-pressed="true"]').getAttribute('data-cape-id');
    const settled=()=>page.waitForFunction(()=>document.querySelector('#skin-capes')?.getAttribute('aria-busy')==='false');
    assert(await page.locator('#cape-prev').isEnabled(),'previous selects the no-cape card even without overflow');
    assert(await page.locator('#cape-next').isEnabled());
    const beforeBrowse=await countCalls();
    await page.locator('#cape-next').click();
    assert.equal(await chosen(),'cape-1','arrow immediately selects the next cape');
    assert.equal(await page.locator('#cape-status').innerText(),'Применяем плащ…');
    await page.waitForFunction(()=>window.omnispecDebug.state.capeTextureSrc===window.__avatarTest.capes[1].data_url);
    await settled();
    assert.equal(await countCalls(),beforeBrowse+1);
    assert.equal(await page.evaluate(()=>window.__avatarTest.calls.filter(c=>c.command==='set_cape').at(-1).args.capeId),'cape-1');

    // A continuous wheel gesture selects the final card and makes just one
    // request once the gesture stops, rather than one request per intermediate cape.
    const beforeWheel=await countCalls();
    const box=await page.locator('#skin-capes').boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.wheel(0,380);
    await page.waitForFunction(()=>document.querySelector('#skin-capes [data-cape-id="cape-8"]')?.getAttribute('aria-pressed')==='true');
    await page.waitForFunction(()=>document.querySelector('#skin-capes').scrollLeft>20);
    await page.mouse.wheel(0,-200);
    await page.waitForFunction(()=>document.querySelector('#skin-capes [data-cape-id="cape-4"]')?.getAttribute('aria-pressed')==='true');
    await settled();
    assert.equal(await countCalls(),beforeWheel+1,'one gesture coalesces to one account change');
    assert.equal(await page.evaluate(()=>window.__avatarTest.calls.filter(c=>c.command==='set_cape').at(-1).args.capeId),'cape-4');
    assert.equal(await page.locator('#prefs-body').evaluate(el=>el.scrollTop),0,'wheel does not scroll the whole page');

    // Choosing back the already active cape before the debounce expires is a no-op.
    const beforeCancel=await countCalls();
    await page.locator('#cape-prev').click();
    assert.equal(await chosen(),'cape-3');
    await page.locator('#cape-next').click();
    assert.equal(await chosen(),'cape-4');
    await page.waitForTimeout(800);
    assert.equal(await countCalls(),beforeCancel,'returning to the active cape must not send a request');
    console.log('CAPE_ARROW_WHEEL_SELECTION_AND_COALESCING_OK');

    await page.locator('#skin-capes [data-cape-id="cape-4"]').focus();
    const beforeKeyboard=await countCalls();
    await page.keyboard.press('End');
    assert.equal(await chosen(),'cape-19','End selects, not merely focuses, the last cape');
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset.capeId),'cape-19');
    await page.keyboard.press('Enter');
    await settled();
    assert.equal(await countCalls(),beforeKeyboard+1);
    assert.equal(await page.evaluate(()=>window.__avatarTest.calls.filter(c=>c.command==='set_cape').at(-1).args.capeId),'cape-19');
    assert(await page.locator('#skin-capes [data-cape-id="cape-19"]').evaluate(el=>el.classList.contains('is-active')));
    const chosenScroll=await page.locator('#skin-capes').evaluate(el=>el.scrollLeft);
    assert(chosenScroll>100,'selected cape remains in the visible, scrolled section');
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset.capeId),'cape-19','selection keeps keyboard focus');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await chosen(),'cape-18','keyboard arrows directly select');
    assert.equal(await page.evaluate(()=>document.activeElement?.dataset.capeId),'cape-18');
    await settled();
    assert.equal(await countCalls(),beforeKeyboard+2);
    console.log('CAPE_KEYBOARD_AND_ACTUAL_SELECTION_OK');

    // Selection rerenders all panels; the independently scrolling skin and cape
    // lists, and their position after switching categories, must not jump.
    await page.locator('[data-skin-id="skin-65"]').scrollIntoViewIfNeeded();
    const prior=await page.evaluate(()=>({skin:document.querySelector('#skin-library').scrollTop,cape:document.querySelector('#skin-capes').scrollLeft,body:document.querySelector('#prefs-body').scrollTop}));
    assert(prior.skin>100 && prior.cape>100 && prior.body===0,JSON.stringify(prior));
    await page.locator('[data-skin-id="skin-65"]').click();
    await page.waitForFunction(()=>document.querySelector('[data-skin-id="skin-65"]')?.closest('.skin-library-item')?.classList.contains('is-active'));
    let after=await page.evaluate(()=>({skin:document.querySelector('#skin-library').scrollTop,cape:document.querySelector('#skin-capes').scrollLeft,body:document.querySelector('#prefs-body').scrollTop}));
    assert(Math.abs(after.skin-prior.skin)<2 && Math.abs(after.cape-prior.cape)<2 && after.body===0,JSON.stringify({prior,after}));
    await page.locator('[data-pref="profile"]').click();
    await page.locator('[data-pref="avatar"]').click();
    after=await page.evaluate(()=>({skin:document.querySelector('#skin-library').scrollTop,cape:document.querySelector('#skin-capes').scrollLeft}));
    assert(Math.abs(after.skin-prior.skin)<2 && Math.abs(after.cape-prior.cape)<2,JSON.stringify({prior,after}));
    console.log('BOTH_AVATAR_SCROLL_POSITIONS_PERSIST_OK');

    // All newly introduced labels and ARIA descriptions are localized.
    const labels={
      ru:['Аватар','Избранные образы','Гардероб плащей','Выбрать предыдущий плащ','Стрелки и колесо — выбор плаща','Применяем плащ…'],
      en:['Avatar','Favorite outfits','Cape wardrobe','Select previous cape','Arrows and wheel select a cape','Applying cape…'],
      be:['Аватар','Выбраныя вобразы','Гардэроб плашчоў','Выбраць папярэдні плашч','Стрэлкі і колца — выбар плашча','Ужываем плашч…'],
      kk:['Аватар','Таңдаулы бейнелер','Плащтар гардеробы','Алдыңғы плащты таңдау','Көрсеткілер мен дөңгелек — плащ таңдау','Плащ қолданылуда…'],
      uk:['Аватар','Улюблені образи','Гардероб плащів','Вибрати попередній плащ','Стрілки й коліщатко — вибір плаща','Застосовуємо плащ…']};
    for (const lang of ['en','be','kk','uk','ru']) {
      await page.evaluate(lang=>window.OmniI18n.setLanguage(lang),lang);
      assert.equal(await page.locator('[data-pref="avatar"]').innerText(),labels[lang][0]);
      assert.equal((await page.locator('.profile-favorites .prefs-label').textContent()).trim(),labels[lang][1]);
      assert.equal(await page.locator('#skin-capes').getAttribute('aria-label'),labels[lang][2]);
      assert.equal(await page.locator('#cape-prev').getAttribute('aria-label'),labels[lang][3]);
      assert.equal(await page.locator('#cape-status').innerText(),labels[lang][4]);
      assert.equal(await page.evaluate(text=>window.OmniI18n.translate(text),'Применяем плащ…'),labels[lang][5]);
    }
    console.log('AVATAR_FIVE_LANGUAGES_OK');

    // The ordinary offline warning should fit without a tiny internal scrollbar.
    await page.locator('[data-pref="profile"]').click();
    await page.locator('[data-uuid="offline"] [data-acc="pick"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.accounts.active==='offline' && !window.omnispecDebug.state.skin.licensed);
    await page.locator('[data-pref="avatar"]').click();
    await page.locator('[data-skin-id="skin-0"]').click();
    await page.waitForFunction(()=>window.omnispecDebug.state.skin.currentName==='Skin 00');
    const warning=await page.locator('#skin-status').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight,text:el.textContent}));
    assert.match(warning.text,/только лицензионному аккаунту/);
    assert(warning.scroll<=warning.height+1,`ordinary offline message is clipped: ${JSON.stringify(warning)}`);
    assert(await page.locator('#skin-apply').isDisabled());
    assert(await page.locator('#cape-prev').isDisabled() && await page.locator('#cape-next').isDisabled());
    const offlineCapeCalls=await countCalls();
    await page.locator('#skin-capes [data-cape-id=""]').click();
    const offlineBox=await page.locator('#skin-capes').boundingBox();
    await page.mouse.move(offlineBox.x+offlineBox.width/2,offlineBox.y+offlineBox.height/2);
    await page.mouse.wheel(0,250);
    await page.waitForTimeout(750);
    assert.equal(await countCalls(),offlineCapeCalls,'offline accounts must never send cape mutations');
    assert.equal(await page.locator('#prefs-body').evaluate(el=>el.scrollTop),0);
    assert.deepEqual(errors,[]);
    console.log('AVATAR_OFFLINE_WARNING_VISIBLE_OK');
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
