// Disposable Windows runner: test real window state and settings, no real account.
const { chromium }=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process');
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||!process.env.RUNNER_TEMP) throw Error('Disposable Windows runner only');
const launcher=path.resolve(process.argv[2]||''),port=Number(process.argv[3]);assert(fs.existsSync(launcher)&&port>1024);
const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'omnispec-tray-')),data=path.join(root,'data');fs.mkdirSync(data);
fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({onboarded:true,onboarding_pending:false,minimize_to_tray:true,update_enabled:false,discord_rpc:false,click_fx:'off',ambient:'off',trail:false,ui_scale:100,language:'ru'}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));let child,browser,page;
async function waitFor(fn,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;if(child?.exitCode!==null)throw Error('Launcher exited during '+label);await delay(100)}throw Error('Timed out: '+label)}
function restore(handle){execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class W { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n); }'; [W]::ShowWindowAsync([IntPtr]::new(${handle}),9) | Out-Null`],{timeout:15000});}
(async()=>{const errors=[];try{
 child=spawn(launcher,[],{stdio:'ignore',env:{...process.env,OMNISPEC_HOME:data,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview')}});
 await waitFor(async()=>{try{return(await fetch(`http://127.0.0.1:${port}/json/version`)).ok}catch{return false}},'WebView2',90000);
 browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);const context=browser.contexts()[0];page=context.pages()[0]||await context.waitForEvent('page');page.on('pageerror',e=>errors.push(String(e)));
 await page.waitForFunction(()=>window.omnispecDebug?.state?.settings?.minimize_to_tray===true);
 const hwnd=Number(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${child.pid}).MainWindowHandle`],{encoding:'utf8'}).trim());assert(hwnd>0);
 const current=()=>page.evaluate(()=>window.__TAURI__.window.getCurrentWindow().isMinimized());
 const visible=()=>page.evaluate(()=>window.__TAURI__.window.getCurrentWindow().isVisible());
 await page.locator('[data-win="minimize"]').click();await waitFor(current,'minimize is a normal taskbar minimize');assert(await visible(),'minimized window must remain visible to the taskbar');
 restore(hwnd);await waitFor(async()=>!(await current()),'restore after minimize');
 await page.locator('[data-win="close"]').click();await waitFor(async()=>!(await visible()),'close hides to tray');assert.equal(child.exitCode,null,'process must remain alive');
 await page.waitForFunction(()=>window.omnispecDebug.state.quiet===true);
 restore(hwnd);await waitFor(visible,'restore hidden window');
 await page.locator('#btn-quick-settings').click();await page.locator('[data-pref="look"]').click();
 await page.locator('#set-minimize-to-tray').click();await page.waitForFunction(()=>window.omnispecDebug.state.settings.minimize_to_tray===false);
 await page.waitForFunction(()=>window.__TAURI__.core.invoke('get_settings').then(s=>s.minimize_to_tray===false));
 await page.locator('[data-close-prefs]').click();await page.locator('[data-win="close"]').click();
 await waitFor(()=>child.exitCode!==null,'close with tray disabled');assert.deepEqual(errors,[]);
 console.log('WINDOWS_TRAY_REAL_MINUS_TASKBAR_CLOSE_HIDES_SETTING_OFF_EXITS_OK');
 }finally{if(child&&child.exitCode===null)child.kill();if(browser)await browser.close().catch(()=>{});await delay(1000);try{fs.rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:250})}catch{}}
})().catch(e=>{console.error(e);process.exitCode=1});
