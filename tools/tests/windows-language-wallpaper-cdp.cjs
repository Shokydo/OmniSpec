// Real Tauri/WebView2 and Rust commands in a disposable, isolated Windows CI
// profile. Only the native picker itself is bypassed: import is invoked with a
// real local fixture. The temporary debugging policy is removed by the caller.
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
const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'omnispec-language-media-'));
const data=path.join(root,'data'), settingsFile=path.join(data,'settings.json');
const steam=path.join(root,'legacy Steam'), marker=path.join(steam,'keep.txt');
const fixture=path.join(root,'своё видео.webm');
const legacy=path.join(data,'wallpapers','legacy.gif');
fs.mkdirSync(path.dirname(legacy),{recursive:true});fs.mkdirSync(steam,{recursive:true});
fs.copyFileSync(path.join(__dirname,'fixtures/profile/workshop-tone.webm'),fixture);
fs.copyFileSync(path.join(__dirname,'fixtures/profile/animated.gif'),legacy);
fs.writeFileSync(marker,'Do not delete or modify');
fs.writeFileSync(settingsFile,JSON.stringify({
  onboarded:true,update_enabled:false,discord_rpc:false,click_fx:'off',ambient:'off',trail:false,
  sound_fx:false,ui_scale:100,username:'WindowsFixture',launcher_icon:'kz',
  wallpaper:'workshop',custom_wallpaper:'legacy.gif',wallpaper_steam_path:steam,
  wallpaper_workshop_project:path.join(steam,'old-project'),wallpaper_engine_enabled:true,
  wallpaper_workshop_audio:true,wallpaper_fit:'cover',wallpaper_blur:0,wallpaper_dim:0,
  skin_presets:[{id:'keep',name:'Скин',path:'C:\\kept\\skin.png',variant:'classic'}]
}));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child=null,browser=null,page=null,lock=null;
async function waitFor(fn,label,timeout=30000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    if(await fn())return;
    if(child && child.exitCode!==null)throw new Error(`Launcher exited: ${child.exitCode}`);
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
function saved(){return JSON.parse(fs.readFileSync(settingsFile,'utf8'));}
async function waitSaved(predicate,label){await waitFor(()=>{try{return predicate(saved());}catch{return false;}},label);}
async function launch() {
  child=spawn(launcher,[],{stdio:'ignore',env:{...process.env,OMNISPEC_HOME:data,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview')}});
  let error=null;child.on('error',e=>{error=e;});
  await waitFor(async()=>{
    if(error)throw error;
    try{return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}
  },'WebView2 debugger',90000);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context=browser.contexts()[0];
  page=context.pages()[0] || await context.waitForEvent('page',{timeout:30000});
  // Settings are loaded before the initial wallpaper state is constructed.
  // Wait for both so a slow runner cannot open the old-Workshop page early.
  await page.waitForFunction(()=>{
    const state=window.omnispecDebug?.state;
    return state?.settings && state.wall.wallpaper===(state.settings.wallpaper || null);
  },null,{timeout:60000});
}
async function stop() {
  if(page && !page.isClosed())await page.evaluate(()=>window.__TAURI__.core.invoke('window_action',{action:'close'})).catch(()=>{});
  if(child && child.exitCode===null) {
    const done=new Promise(resolve=>child.once('exit',resolve));
    await Promise.race([done,delay(8000)]);
    if(child.exitCode===null){child.kill();await Promise.race([done,delay(5000)]);}
  }
  if(browser)await browser.close().catch(()=>{});
  child=null;browser=null;page=null;
  await waitFor(async()=>{try{await fetch(`http://127.0.0.1:${port}/json/version`);return false;}catch{return true;}},'old CDP shutdown',15000);
}
async function prefs(category) {
  if(await page.locator('#modal-prefs').isHidden())await page.locator('#btn-quick-settings').click();
  await page.locator(`[data-pref="${category}"]`).click();
}
async function chooseLanguage(code) {
  await page.selectOption('#prefs-language',code);
  await page.waitForFunction(code=>document.documentElement.lang===code,code);
  await waitSaved(s=>s.language===code,`saved ${code}`);
}
async function lockSettings() {
  lock=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',
    'tools/tests/windows-launcher-icon-lock.ps1','-Path',settingsFile],{stdio:['ignore','pipe','pipe']});
  let out='',err='';lock.stdout.on('data',v=>{out+=v;});lock.stderr.on('data',v=>{err+=v;});
  await waitFor(()=>{if(lock.exitCode!==null)throw new Error('settings lock failed: '+err);return out.includes('SETTINGS_LOCKED');},'settings lock');
}
async function unlockSettings() {
  if(lock && lock.exitCode===null){const done=new Promise(resolve=>lock.once('exit',resolve));lock.kill();await Promise.race([done,delay(5000)]);}
  lock=null;
}
async function visibleVideo() {
  await page.waitForFunction(()=>{const v=document.querySelector('#wall-video');
    return v && !v.hidden && v.muted && v.loop && v.playsInline && !v.paused && v.readyState>=2;},null,{timeout:30000});
  const start=await page.locator('#wall-video').evaluate(v=>v.currentTime);
  await page.waitForFunction(start=>Math.abs(document.querySelector('#wall-video').currentTime-start)>0.12,start,{timeout:10000});
  assert.match(await page.locator('#wall-video').evaluate(v=>v.currentSrc),/^http:\/\/127\.0\.0\.1:\d+\//);
}
(async()=>{
  try {
    await launch();
    assert(await page.locator('#wall').isHidden(),'old Workshop background is not launched');
    await prefs('wall');
    assert.match(await page.locator('#prefs-body').innerText(),/исходные файлы не удалены/);
    assert.equal(await page.locator('#we-enabled, #we-grid, #we-audio, #wall-scene').count(),0);
    assert.equal(saved().wallpaper,'workshop','legacy selection remains in settings');
    await prefs('look');
    const labels={be:'Афармленне',kk:'Сыртқы көрініс',uk:'Оформлення',en:'Appearance',ru:'Оформление'};
    const stars={be:['Зорны выбух','Зорка'],kk:['Жұлдыз жарылысы','Жұлдыз'],
      uk:['Зоряний вибух','Зірка'],en:['Starburst','Star'],ru:['Звездный взрыв','Звезда']};
    for(const lang of ['be','kk','uk','en','ru']) {
      await chooseLanguage(lang);
      assert.equal(await page.locator('[data-pref="look"]').innerText(),labels[lang]);
      const iconLabels=(await page.locator('#launcher-icon-grid label').allTextContents()).map(x=>x.trim());
      assert.deepEqual(iconLabels.slice(1,6),['Россия','Беларусь','Қазақстан','Україна','USA']);
      assert.deepEqual(iconLabels.slice(6),stars[lang]);
      for(const [id,index] of [['icon_star_boom',0],['icon_star_eye',1]]) {
        const label=page.locator(`#launcher-icon-grid label:has(input[value="${id}"])`);
        assert.equal(await label.locator('input').getAttribute('aria-label'),stars[lang][index]);
        await label.click();await waitSaved(s=>s.launcher_icon===id,`icon ${lang}/${id}`);
        assert(await page.getByRole('radio',{name:stars[lang][index],exact:true}).isChecked());
        assert.equal(await page.locator('.tb-logo img').getAttribute('src'),`assets/launcher-icons/${id}.png`);
      }
      assert.equal(await page.locator('.language-hint').evaluate(el=>getComputedStyle(el).color),
        await page.locator('.launcher-icon-hint').evaluate(el=>getComputedStyle(el).color));
      console.log('WINDOWS_WEBVIEW2_LANGUAGE_OK',lang);
    }
    await page.locator('#launcher-icon-grid label:has(input[value="kz"])').click();
    await waitSaved(s=>s.launcher_icon==='kz','original icon restored');
    await lockSettings();
    await page.selectOption('#prefs-language','en');
    await page.waitForFunction(()=>document.documentElement.lang==='ru' &&
      document.querySelector('#toasts')?.textContent.includes('Не удалось сохранить язык'),null,{timeout:25000});
    assert.equal(await page.locator('#prefs-language').inputValue(),'ru');
    await unlockSettings();await waitSaved(s=>s.language==='ru','failed language rollback');
    console.log('WINDOWS_LANGUAGE_FAILED_SAVE_ROLLBACK_OK');
    await chooseLanguage('en');

    // Invoke the actual Rust file importer; exercise Windows Unicode paths,
    // settings lock, original media preservation, and the stale-Save guard.
    const stale=await page.evaluate(()=>window.__TAURI__.core.invoke('get_settings'));
    const imported=await page.evaluate(file=>window.__TAURI__.core.invoke('set_custom_wallpaper',{path:file}),fixture);
    assert.equal(imported.wallpaper,'custom');assert(imported.custom_wallpaper.endsWith('.webm'));
    const copied=path.join(data,'wallpapers',imported.custom_wallpaper);
    assert.deepEqual(fs.readFileSync(copied),fs.readFileSync(fixture));
    stale.wallpaper='aurora';
    await page.evaluate(settings=>window.__TAURI__.core.invoke('save_settings',{settings}),stale);
    await waitSaved(s=>s.wallpaper==='custom' && s.custom_wallpaper===imported.custom_wallpaper,'stale Save protected');
    await page.evaluate(async()=>{
      let failed=false;
      try{await window.__TAURI__.core.invoke('download_custom_wallpaper',{url:'http://127.0.0.1/not-public.mp4'});}catch{failed=true;}
      if(!failed)throw new Error('private address should be rejected');
    });
    assert.equal(saved().custom_wallpaper,imported.custom_wallpaper,'failed download preserves media');
    assert.equal(fs.readFileSync(marker,'utf8'),'Do not delete or modify');assert(fs.existsSync(legacy));
    console.log('WINDOWS_RUST_MEDIA_IMPORT_AND_STALE_SAVE_OK');

    await stop();await launch();
    assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
    await visibleVideo();
    await prefs('wall');
    await page.locator('[data-wall=""]').click();
    await waitSaved(s=>s.wallpaper===null,'remove background');
    assert(await page.locator('#wall-video').isHidden());
    await page.locator('[data-wall="custom"]').click();
    await waitSaved(s=>s.wallpaper==='custom','restore custom background');
    await visibleVideo();
    const final=saved();
    assert.equal(final.language,'en');assert.equal(final.username,'WindowsFixture');assert.equal(final.launcher_icon,'kz');
    assert.equal(final.wallpaper_workshop_audio,true);assert.equal(final.wallpaper_steam_path,steam);
    assert.equal(final.wallpaper_workshop_project,path.join(steam,'old-project'));assert.equal(final.skin_presets[0].name,'Скин');
    assert.equal(fs.readFileSync(marker,'utf8'),'Do not delete or modify');assert(fs.existsSync(legacy));
    console.log('WINDOWS_WEBVIEW2_RESTART_MUTED_VIDEO_AND_USER_DATA_OK');
  } finally {
    await unlockSettings().catch(()=>{});
    await stop().catch(()=>{});
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:300});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
