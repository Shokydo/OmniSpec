// Disposable Windows CI only. Uses real Tauri, Rust video server and WebView2
// with a synthetic Workshop video (not the commercial Wallpaper Engine).
// The caller enables a local-only CDP port for this test EXE using a temporary
// machine policy and removes it afterwards. No CDP setting ships in the app.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !process.env.RUNNER_TEMP) {
  throw new Error('Run only on a disposable GitHub-hosted Windows runner');
}
const launcher=path.resolve(process.argv[2] || '');
const port=Number(process.argv[3]);
assert(fs.existsSync(launcher) && Number.isInteger(port) && port>=1024 && port<=65535);
const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'omnispec-video-cdp-'));
const data=path.join(root,'data');
const steam=path.join(root,'Steam with spaces');
const project=path.join(steam,'steamapps','workshop','content','431960','123456');
const settingsFile=path.join(data,'settings.json');
fs.mkdirSync(project,{recursive:true});fs.mkdirSync(data,{recursive:true});
fs.copyFileSync(path.join(__dirname,'fixtures','profile','workshop-tone.webm'),path.join(project,'movie.webm'));
fs.writeFileSync(path.join(project,'project.json'),JSON.stringify({title:'Synthetic video with audio',type:'video',file:'movie.webm',workshopid:'123456'}));
fs.writeFileSync(settingsFile,JSON.stringify({onboarded:true,update_enabled:false,discord_rpc:false,click_fx:'off',ambient:'off',trail:false,sound_fx:false,ui_scale:100,
  wallpaper:'workshop',wallpaper_steam_path:steam,wallpaper_workshop_project:project,
  wallpaper_engine_enabled:true,wallpaper_workshop_audio:false,wallpaper_fit:'cover',wallpaper_dim:0,wallpaper_blur:0}));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child=null,browser=null,page=null;
async function launch() {
  child=spawn(launcher,[],{stdio:'ignore',env:{...process.env,OMNISPEC_HOME:data,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview')}});
  let childError=null; child.on('error',e=>{childError=e;});
  const deadline=Date.now()+60000;
  let ready=false;
  while(Date.now()<deadline) {
    if(childError) throw childError;
    if(child.exitCode!==null) throw new Error(`Launcher exited during startup: ${child.exitCode}`);
    try {const r=await fetch(`http://127.0.0.1:${port}/json/version`); if(r.ok){ready=true;break;}} catch {}
    await delay(300);
  }
  if(!ready) throw new Error('WebView2 CDP did not open; temporary policy was not honoured');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context=browser.contexts()[0];
  page=context.pages()[0] || await context.waitForEvent('page',{timeout:30000});
  await page.waitForSelector('#btn-quick-settings',{timeout:60000});
  await page.waitForFunction(()=>window.omnispecDebug?.state?.settings,null,{timeout:30000});
}
async function stop() {
  if(page && !page.isClosed()) {
    // The ordinary Tauri window close, not a mocked API.
    await page.evaluate(()=>window.__TAURI__.core.invoke('window_action',{action:'close'})).catch(()=>{});
  }
  if(child && child.exitCode===null) {
    const done=new Promise(resolve=>child.once('exit',resolve));
    await Promise.race([done,delay(8000)]);
    if(child.exitCode===null){child.kill();await Promise.race([done,delay(4000)]);}
  }
  if(browser) await browser.close().catch(()=>{});
  child=null;browser=null;page=null;
  // Wait for the old browser's local debugger port to close before restarting.
  const end=Date.now()+15000;
  while(Date.now()<end) {
    try {await fetch(`http://127.0.0.1:${port}/json/version`);} catch {return;}
    await delay(250);
  }
  throw new Error('Old WebView2 CDP port survived shutdown');
}
function saved(){return JSON.parse(fs.readFileSync(settingsFile,'utf8'));}
async function waitSaved(predicate,label) {
  const end=Date.now()+15000;
  while(Date.now()<end) {try {if(predicate(saved()))return;}catch{} await delay(100);}
  throw new Error(`Settings not saved: ${label}`);
}
async function visibleVideo(muted) {
  await page.waitForFunction(muted=>{const v=document.querySelector('#wall-video');
    return v && !v.hidden && v.muted===muted && !v.paused && v.readyState>=2;},muted,{timeout:30000});
  const start=await page.locator('#wall-video').evaluate(v=>v.currentTime);
  await page.waitForFunction(start=>{const v=document.querySelector('#wall-video');
    return !v.paused && Math.abs(v.currentTime-start)>0.12;},start,{timeout:8000});
}
async function prefs() {
  if(await page.locator('#modal-prefs').isHidden()) await page.locator('#btn-quick-settings').click();
  await page.locator('[data-pref="wall"]').click();
  await page.waitForSelector('#we-enabled');
}
(async()=>{
  try {
    await launch();
    await visibleVideo(true);
    const mediaUrl=await page.locator('#wall-video').evaluate(v=>v.currentSrc);
    assert.match(mediaUrl,/^http:\/\/127\.0\.0\.1:\d+\//,'real Rust loopback video URL');
    // Prove that the served video has a decodable nonzero audio track; this
    // does not assert a physical audio device exists on the hosted runner.
    const decoded=await page.evaluate(async url=>{
      const audio=new AudioContext();
      try {
        const response=await fetch(url); if(!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer=await audio.decodeAudioData(await response.arrayBuffer());
        const samples=buffer.getChannelData(0); let peak=0;
        for(let i=0;i<samples.length;i+=64)peak=Math.max(peak,Math.abs(samples[i]));
        return {channels:buffer.numberOfChannels,duration:buffer.duration,peak};
      } finally {await audio.close();}
    },mediaUrl);
    assert(decoded.channels>=1 && decoded.duration>1 && decoded.peak>0.001,`fixture has no decoded audio: ${JSON.stringify(decoded)}`);
    await prefs();
    await page.locator('#we-audio').click();
    await waitSaved(s=>s.wallpaper_workshop_audio===true,'video sound on');
    await visibleVideo(false);
    await page.locator('#we-audio').click();
    await waitSaved(s=>s.wallpaper_workshop_audio===false,'video sound off');
    await visibleVideo(true);
    await page.locator('#we-audio').click();
    await waitSaved(s=>s.wallpaper_workshop_audio===true,'video sound on again');
    await visibleVideo(false);
    assert.equal(saved().sound_fx,false,'UI sound preference must not change');
    console.log('WINDOWS_WEBVIEW2_VIDEO_AUDIO_TOGGLE_OK (real WebView2; synthetic media; no physical speaker assertion)');

    await page.locator('#we-enabled').click();
    await waitSaved(s=>s.wallpaper_engine_enabled===false,'WE integration off');
    await page.waitForFunction(()=>{const v=document.querySelector('#wall-video');return v.hidden && v.paused && !v.hasAttribute('src');});
    assert.equal(saved().wallpaper,'workshop');
    assert.equal(saved().wallpaper_workshop_project,project);
    // Revoked loopback access must no longer serve the old media.
    let revoked=false;
    try {const response=await fetch(mediaUrl);revoked=!response.ok;} catch {revoked=true;}
    assert(revoked,'disabled Workshop video URL is still served');
    await stop();
    await launch();
    await delay(1200);
    assert.equal(saved().wallpaper_engine_enabled,false);
    assert.equal(saved().wallpaper_workshop_audio,true);
    assert(await page.locator('#wall-video').evaluate(v=>v.hidden && !v.hasAttribute('src')));
    await prefs();
    await page.locator('#we-enabled').click();
    await waitSaved(s=>s.wallpaper_engine_enabled===true,'WE integration on');
    await visibleVideo(false);
    console.log('WINDOWS_WEBVIEW2_VIDEO_DISABLE_RESTORE_OK (synthetic media)');
    await stop();

    // Fresh launch with audio saved on, no click before checking playback.
    await launch();
    await visibleVideo(false);
    assert.equal(saved().wallpaper_workshop_audio,true);
    assert.equal(saved().wallpaper_workshop_project,project);
    console.log('WINDOWS_WEBVIEW2_VIDEO_AUDIO_RESTART_OK (synthetic media)');
  } finally {
    try {if(child || browser) await stop();} catch(error) {console.error('CLEANUP',error.message);if(child)child.kill();}
    try {fs.rmSync(root,{recursive:true,force:true});} catch(error){console.error('TEMP_CLEANUP',error.message);}
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
