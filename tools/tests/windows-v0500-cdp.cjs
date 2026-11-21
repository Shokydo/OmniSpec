// Actual WebView2, Tauri commands, WAV decoder and on-disk settings; no Minecraft login.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { checkSettingsLayout } = require('./settings-layout-assert.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !process.env.RUNNER_TEMP) {
  throw new Error('Run only on a disposable GitHub-hosted Windows runner');
}
const launcher=path.resolve(process.argv[2]||''),port=Number(process.argv[3]);
assert(fs.existsSync(launcher) && Number.isInteger(port) && port>=1024 && port<=65535);
const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'omnispec-v0500-'));
const data=path.join(root,'data');fs.mkdirSync(data,{recursive:true});
const settingsFile=path.join(data,'settings.json');
fs.writeFileSync(settingsFile,JSON.stringify({onboarded:false,onboarding_pending:true,update_enabled:false,discord_rpc:false,
  click_fx:'off',ambient:'off',trail:false,trail_style:'sparks',trail_size:50,trail_length:20,trail_opacity:15,
  sound_fx:true,sound_volume:60,sound_style:'soft',ui_scale:100,language:'ru'}));
function wav(){
  const samples=4410,b=Buffer.alloc(44+samples*2);
  b.write('RIFF',0);b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(44100,24);b.writeUInt32LE(88200,28);
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(samples*2,40);
  for(let i=0;i<samples;i++)b.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/44100)*4000),44+i*2);
  return b;
}
const original=path.join(root,'event-tone.wav'),wavBytes=wav();fs.writeFileSync(original,wavBytes);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child=null,browser=null,page=null;
function saved(){try{return JSON.parse(fs.readFileSync(settingsFile,'utf8'));}catch{return {};}}
async function waitFor(fn,label,timeout=30000){
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await fn())return;if(child && child.exitCode!==null)throw Error(`Launcher exited: ${child.exitCode}`);await delay(100);}
  throw Error(`Timed out: ${label}`);
}
async function waitSaved(fn,label){await waitFor(()=>fn(saved()),label);}
async function openPrefs(category){if(await page.locator('#modal-prefs').isHidden())await page.locator('#btn-quick-settings').click();await page.locator(`[data-pref="${category}"]`).click();}
async function watchActualAudio(){await page.evaluate(()=>{
  window.__realSoundPlays=[];
  if(window.__soundWatchInstalled)return;
  window.__soundWatchInstalled=true;
  const old=AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource=function(){
    const source=old.call(this),connect=source.connect.bind(source),start=source.start.bind(source);
    source.connect=function(node,...rest){source.__gain=node;return connect(node,...rest);};
    source.start=function(...args){window.__realSoundPlays.push({duration:source.buffer?.duration,gain:source.__gain?.gain?.value});return start(...args);};
    return source;
  };
});}
async function startLauncher(errors){
  child=spawn(launcher,[],{stdio:'ignore',env:{...process.env,OMNISPEC_HOME:data,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview')}});
  let spawnError=null;child.on('error',error=>{spawnError=error;});
  await waitFor(async()=>{if(spawnError)throw spawnError;try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}},'WebView2 debugger',90000);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context=browser.contexts()[0];page=context.pages()[0]||await context.waitForEvent('page',{timeout:30000});
  page.on('pageerror',e=>errors.push(String(e)));
}
async function stopLauncher(){
  if(page && !page.isClosed())await page.evaluate(()=>window.__TAURI__.core.invoke('window_action',{action:'close'})).catch(()=>{});
  if(child && child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));await Promise.race([done,delay(8000)]);if(child.exitCode===null){child.kill();await Promise.race([done,delay(5000)]);}}
  if(browser)await browser.close().catch(()=>{});
  page=browser=child=null;
}
async function restartLauncher(errors){
  const previous=child.pid;
  await stopLauncher();
  await waitFor(async()=>{try{await fetch(`http://127.0.0.1:${port}/json/version`);return false;}catch{return true;}},'old WebView2 debugger to exit',30000);
  await startLauncher(errors);
  assert.notEqual(child.pid,previous,'test must restart the actual launcher process');
}
(async()=>{
  const errors=[];
  try{
    await startLauncher(errors);
    await page.waitForSelector('#modal-onboard:not([hidden])',{timeout:60000});
    assert.equal(await page.locator('[data-onboard-language]').count(),5);
    await page.locator('[data-onboard-language="en"]').click();
    await waitSaved(s=>s.language==='en','English language saved');
    await page.waitForFunction(()=>document.documentElement.lang==='en' && !document.querySelector('#onboard-next').disabled);
    await page.locator('[data-onboard-language="ru"]').click();
    await waitSaved(s=>s.language==='ru','Russian language saved');
    await page.waitForFunction(()=>!document.querySelector('#onboard-next').disabled);
    for(let i=0;i<6;i++)await page.locator('#onboard-next').click();
    await waitSaved(s=>s.onboarded===true,'first-run wizard completed');
    await page.waitForSelector('#dv-results');
    assert.equal(await page.locator('#home-filters-toggle').getAttribute('aria-expanded'),'false');
    const wide=(await page.locator('#dv-results').boundingBox()).width;
    await page.locator('#home-filters-toggle').click();
    await page.waitForTimeout(250);
    const narrow=(await page.locator('#dv-results').boundingBox()).width;
    assert(wide>narrow+70,`filter opening does not reserve space ${wide}/${narrow}`);
    await page.evaluate(()=>{document.querySelector('#dv-results').style.minHeight='2000px';const s=document.querySelector('#home-scroll');s.scrollTop=s.scrollHeight;});
    await page.waitForTimeout(100);
    const pinned=await page.evaluate(()=>Math.abs(document.querySelector('.home-feed-head').getBoundingClientRect().top-document.querySelector('#home-scroll').getBoundingClientRect().top));
    assert(pinned<8,`catalog header not pinned: ${pinned}`);
    console.log('WINDOWS_V0500_ONBOARD_AND_STICKY_CATALOG_OK');

    await watchActualAudio();
    await openPrefs('sound');
    for(const scale of [100,150]){
      if(scale!==100){
        await openPrefs('look');await page.locator(`[data-ui-scale="${scale}"]`).click();
        await page.waitForFunction(scale=>document.documentElement.dataset.uiScale===String(scale),scale);
        await waitSaved(s=>s.ui_scale===scale,`${scale}% scale`);await openPrefs('sound');
      }
      await page.waitForTimeout(300);
      const styles=await checkSettingsLayout(page,`real WebView2 ${scale}%`);
      for(const style of styles){
        const button=page.locator(`[data-sound-style="${style}"]`);
        await button.scrollIntoViewIfNeeded();
        await button.click();
        await waitSaved(s=>s.sound_style===style,`sound style ${style}`);
        assert(await button.evaluate(el=>el.classList.contains('is-active')),`${style} was not selected`);
      }
      await checkSettingsLayout(page,`real WebView2 ${scale}% custom`);
      assert(await page.locator('#prefs-body').evaluate(el=>el.scrollHeight>el.clientHeight),'custom sounds must overflow vertically');
      await page.locator('#sound-test').click();
      assert(await page.locator('#prefs-body').evaluate(el=>el.scrollTop)>0,'last control must be reachable vertically');
    }
    await openPrefs('look');await page.locator('[data-ui-scale="100"]').click();
    await page.waitForFunction(()=>document.documentElement.dataset.uiScale==='100');
    await waitSaved(s=>s.ui_scale===100,'restore 100% scale');
    await openPrefs('sound');await page.waitForTimeout(300);
    await checkSettingsLayout(page,'real WebView2 restored');
    console.log('WINDOWS_WEBVIEW2_SETTINGS_SOUND_LAYOUT_AND_SCROLL_OK');
    assert.equal(await page.locator('#set-sound-volume').getAttribute('max'),'200');
    await page.locator('#set-sound-volume').evaluate(el=>{el.value='200';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
    await waitSaved(s=>s.sound_volume===200,'master volume 200%');
    await page.locator('[data-sound-style="custom"]').click();
    const soundPath=page.locator('[data-sound-path="click"]');
    await soundPath.fill(original);await soundPath.press('Enter');
    await waitSaved(s=>Boolean(s.sound_custom?.click?.file),'custom click imported');
    await page.waitForSelector('[data-sound-preview="click"]:not([disabled])');
    const copiedName=saved().sound_custom.click.file,copied=path.join(data,'sounds',copiedName);
    assert.deepEqual(fs.readFileSync(copied),wavBytes,'import keeps exact selected audio bytes');
    const raw=await page.evaluate(()=>window.__TAURI__.core.invoke('custom_sound_data',{event:'click'}));
    assert.deepEqual(Buffer.from(raw.split(',')[1],'base64'),wavBytes);
    const rejected=await page.evaluate(async()=>{try{await window.__TAURI__.core.invoke('custom_sound_data',{event:'../secret'});return false;}catch{return true;}});
    assert(rejected,'custom sound event must be whitelisted');
    await page.locator('[data-sound-volume="click"]').evaluate(el=>{el.value='150';el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));});
    await waitSaved(s=>s.sound_custom.click.volume===150,'individual volume');
    await page.evaluate(()=>window.__realSoundPlays=[]);
    await page.locator('[data-sound-preview="click"]').click();
    await page.waitForFunction(()=>window.__realSoundPlays?.some(p=>p.duration>0 && Math.abs(p.gain-3)<.01),null,{timeout:15000});
    fs.unlinkSync(original);
    await restartLauncher(errors);await page.waitForFunction(()=>window.omnispecDebug?.state?.sound?.style==='custom');
    assert(await page.locator('#modal-onboard').isHidden());
    await watchActualAudio();await openPrefs('sound');
    assert.equal(await page.locator('[data-sound-path="click"]').inputValue(),original);
    assert.equal(await page.locator('[data-sound-volume="click"]').inputValue(),'150');
    await page.evaluate(()=>window.__realSoundPlays=[]);
    await page.locator('[data-sound-preview="click"]').click();
    await page.waitForFunction(()=>window.__realSoundPlays?.some(p=>p.duration>0 && Math.abs(p.gain-3)<.01),null,{timeout:15000});
    console.log('WINDOWS_V0500_REAL_WAV_DECODE_GAIN_COPY_AND_RESTART_OK');

    const image1=path.resolve('tools/tests/fixtures/profile/one.png'),image2=path.resolve('tools/tests/fixtures/profile/two.png');
    const first=await page.evaluate(file=>window.__TAURI__.core.invoke('set_custom_wallpaper',{path:file}),image1);
    const second=await page.evaluate(file=>window.__TAURI__.core.invoke('set_custom_wallpaper',{path:file}),image2);
    assert.notEqual(first.custom_wallpaper,second.custom_wallpaper);
    assert(second.wallpaper_recent.includes(`custom:${first.custom_wallpaper}`));
    assert(second.wallpaper_recent.includes(`custom:${second.custom_wallpaper}`));
    await page.reload();await page.waitForFunction(()=>window.omnispecDebug?.state?.settings?.custom_wallpaper);
    await openPrefs('wall');
    const firstId=`custom:${first.custom_wallpaper}`,secondId=`custom:${second.custom_wallpaper}`;
    await page.waitForSelector(`[data-wall-history-select="${firstId}"]`);
    await page.waitForSelector(`[data-wall-history-select="${secondId}"]`);
    await page.waitForFunction(id=>getComputedStyle(document.querySelector(`[data-wall-history-select="${id}"]`)).backgroundImage!=='none',firstId,{timeout:15000});
    await page.locator(`[data-wall-history-select="${firstId}"]`).click();
    await waitSaved(s=>s.custom_wallpaper===first.custom_wallpaper && s.wallpaper==='custom','select previous custom background');
    await page.locator(`[data-wall-history-remove="${firstId}"]`).click();
    await waitSaved(s=>!s.wallpaper_recent.includes(firstId),'remove history entry');
    assert.equal(saved().wallpaper,'custom');assert.equal(saved().custom_wallpaper,first.custom_wallpaper);
    assert(fs.existsSync(path.join(data,'wallpapers',first.custom_wallpaper)),'removing history never deletes the active file');
    await restartLauncher(errors);await page.waitForFunction(()=>window.omnispecDebug?.state?.settings?.custom_wallpaper);
    await openPrefs('wall');
    assert.equal(await page.locator(`[data-wall-history-select="${firstId}"]`).count(),0);
    assert.equal(await page.locator(`[data-wall-history-select="${secondId}"]`).count(),1);
    assert.equal(saved().custom_wallpaper,first.custom_wallpaper);
    assert.deepEqual(errors,[]);
    console.log('WINDOWS_V0500_REAL_WALLPAPER_HISTORY_AND_ACTIVE_FILE_OK');
  } finally {
    await stopLauncher();
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:300});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
