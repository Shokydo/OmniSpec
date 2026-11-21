// The release executable in real Windows WebView2, with ONLY Minecraft
// account/skin/cape responses stubbed via Tauri's test bridge. The on-disk
// profile is offline and disposable; no real Minecraft account is contacted.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !process.env.RUNNER_TEMP) {
  throw new Error('Run only on a disposable GitHub-hosted Windows runner');
}
const launcher=path.resolve(process.argv[2] || ''), port=Number(process.argv[3]);
assert(fs.existsSync(launcher) && Number.isInteger(port) && port>=1024 && port<=65535);
const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'omnispec-avatar-webview-'));
const data=path.join(root,'data'); fs.mkdirSync(data,{recursive:true});
const uuid='00000000-0000-3000-8000-000000000001';
fs.writeFileSync(path.join(data,'accounts.json'),JSON.stringify({active:uuid,accounts:[
  {uuid,username:'OfflineFixture',kind:'offline',access_token:'',refresh_token:'',expires_at:0}
]}));
fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({
  onboarded:true,update_enabled:false,discord_rpc:false,click_fx:'off',ambient:'off',
  trail:false,sound_fx:false,ui_scale:100,username:'OfflineFixture'
}));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child=null,browser=null,page=null;
async function waitFor(fn,label,timeout=30000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    if(await fn())return;
    if(child && child.exitCode!==null)throw new Error(`Launcher exited: ${child.exitCode}`);
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
(async()=>{
  const errors=[];
  try {
    child=spawn(launcher,[],{stdio:'ignore',env:{...process.env,OMNISPEC_HOME:data,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview')}});
    let spawnError=null;child.on('error',error=>{spawnError=error;});
    await waitFor(async()=>{
      if(spawnError)throw spawnError;
      try{return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}
    },'WebView2 debugger',90000);
    browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context=browser.contexts()[0];
    page=context.pages()[0] || await context.waitForEvent('page',{timeout:30000});
    page.on('pageerror',error=>errors.push(String(error)));
    await page.waitForFunction(()=>window.omnispecDebug?.state?.accounts && window.__TAURI_INTERNALS__?.invoke,null,{timeout:60000});
    await page.evaluate(()=>{
      const internal=window.__TAURI_INTERNALS__, native=internal.invoke;
      const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#d78c62';ctx.fillRect(0,0,64,64);
      const skin=canvas.toDataURL('image/png');
      const capes=Array.from({length:12},(_,i)=>{
        const c=document.createElement('canvas');c.width=64;c.height=32;
        const x=c.getContext('2d');x.fillStyle=i%2?'#cc4444':'#3388bb';x.fillRect(1,1,10,16);
        x.fillStyle='#22ee77';x.fillRect(0,1,1,16);x.fillRect(11,1,1,16);
        return {id:'fixture-'+i,alias:'Fixture '+i,active:i===0,data_url:c.toDataURL('image/png')};
      });
      const mock=window.__avatarNativeMock={calls:[],fail:false,capes,native};
      internal.invoke=async function(command,args={},options) {
        if(command==='account_skin')return {account_uuid:'fixture-license',licensed:true,variant:'classic',data_url:skin};
        if(command==='account_capes')return {account_uuid:'fixture-license',licensed:true,capes:mock.capes.map(c=>({...c}))};
        if(command==='set_cape') {
          mock.calls.push({...args});
          if(mock.fail)throw 'TEST_ONLY_CAPE_FAILURE';
          mock.capes.forEach(c=>{c.active=c.id===args.capeId;});
          return {ok:true,account_uuid:'fixture-license'};
        }
        return native.call(internal,command,args,options);
      };
      if(internal.invoke===native)throw new Error('Tauri test bridge was not installed');
      const state=window.omnispecDebug.state;
      state.accounts={active:'fixture-license',accounts:[{uuid:'fixture-license',username:'Synthetic',kind:'microsoft'}]};
      state.profileAccountId='fixture-license';state.skin=null;state.capes=null;
    });
    await page.locator('#btn-quick-settings').click();
    await page.locator('[data-pref="avatar"]').click();
    await page.waitForSelector('#skin-capes [data-cape-id="fixture-11"]');
    await page.waitForSelector('#skin-capes [data-cape-id="fixture-0"] canvas[data-cape-rendered="3d"]');
    const selected=()=>page.locator('#skin-capes [aria-pressed="true"]').getAttribute('data-cape-id');
    const settled=()=>page.waitForFunction(()=>document.querySelector('#skin-capes')?.getAttribute('aria-busy')==='false');
    assert.equal(await selected(),'fixture-0');
    await page.locator('#cape-next').click();
    assert.equal(await selected(),'fixture-1');
    await settled();
    assert.equal(await page.evaluate(()=>window.__avatarNativeMock.calls.at(-1).capeId),'fixture-1');
    const count=await page.evaluate(()=>window.__avatarNativeMock.calls.length);
    const box=await page.locator('#skin-capes').boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
    await page.mouse.wheel(0,250);
    await page.waitForFunction(()=>document.querySelector('#skin-capes [data-cape-id="fixture-6"]')?.getAttribute('aria-pressed')==='true');
    await settled();
    assert.equal(await page.evaluate(()=>window.__avatarNativeMock.calls.length),count+1);
    assert.equal(await page.evaluate(()=>window.__avatarNativeMock.calls.at(-1).capeId),'fixture-6');
    assert.equal(await page.locator('#prefs-body').evaluate(el=>el.scrollTop),0);
    console.log('WINDOWS_WEBVIEW2_ARROW_WHEEL_3D_AND_COALESCING_OK');

    await page.evaluate(()=>window.__avatarNativeMock.fail=true);
    await page.locator('#skin-capes [data-cape-id="fixture-7"]').click();
    await page.waitForFunction(()=>document.querySelector('#toasts')?.textContent.includes('TEST_ONLY_CAPE_FAILURE'));
    await settled();
    assert.equal(await selected(),'fixture-6','failed network mutation must restore the confirmed cape');
    assert.deepEqual(errors,[]);
    console.log('WINDOWS_WEBVIEW2_CAPE_FAILURE_ROLLBACK_OK');
  } finally {
    if(page && !page.isClosed()) {
      await page.evaluate(()=>{
        if(window.__avatarNativeMock)window.__TAURI_INTERNALS__.invoke=window.__avatarNativeMock.native;
        return window.__TAURI__.core.invoke('window_action',{action:'close'});
      }).catch(()=>{});
    }
    if(child && child.exitCode===null){
      const done=new Promise(resolve=>child.once('exit',resolve));
      await Promise.race([done,delay(8000)]);
      if(child.exitCode===null){child.kill();await Promise.race([done,delay(5000)]);}
    }
    if(browser)await browser.close().catch(()=>{});
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:300});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
