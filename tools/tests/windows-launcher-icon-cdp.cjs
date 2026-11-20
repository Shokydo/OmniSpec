// Реальное окно Tauri/WebView2, Win32 ICON_SMALL/ICON_BIG и тестовый Discord IPC.
// Только одноразовый GitHub-hosted Windows runner; данные строго изолированы.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

if (process.platform!=='win32' || process.env.GITHUB_ACTIONS!=='true' ||
    process.env.RUNNER_ENVIRONMENT!=='github-hosted' || !process.env.RUNNER_TEMP) {
  throw new Error('Run only on a disposable GitHub-hosted Windows runner');
}
const launcher=path.resolve(process.argv[2] || ''), port=Number(process.argv[3]);
assert(fs.existsSync(launcher) && Number.isInteger(port) && port>=1024 && port<=65535);
const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'omnispec-launcher-icon-'));
const data=path.join(root,'data'), settings=path.join(data,'settings.json');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(settings,JSON.stringify({onboarded:true,update_enabled:false,discord_rpc:true,
  discord_instance_icon:false,discord_upload_local_icon:false,click_fx:'off',ambient:'off',
  trail:false,trail_style:'sparks',sound_fx:false,ui_scale:100,username:'IconFixture'}));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const events=[], connections=new Set();
let child=null,browser=null,page=null,lock=null,ipcError=null;

function frame(op,data) {
  const payload=Buffer.from(JSON.stringify(data)), head=Buffer.alloc(8);
  head.writeUInt32LE(op,0);head.writeUInt32LE(payload.length,4);
  return Buffer.concat([head,payload]);
}
const server=net.createServer(socket=>{
  connections.add(socket); socket.on('close',()=>connections.delete(socket));
  socket.on('error',e=>{if(e.code!=='ECONNRESET'&&e.code!=='EPIPE')ipcError=e;});
  let buffer=Buffer.alloc(0);
  socket.on('data',part=>{
    buffer=Buffer.concat([buffer,part]);
    while(buffer.length>=8) {
      const opcode=buffer.readUInt32LE(0), length=buffer.readUInt32LE(4);
      if(length>1024*1024){ipcError=new Error('oversized IPC frame');socket.destroy();return;}
      if(buffer.length<8+length)return;
      let value;try{value=JSON.parse(buffer.subarray(8,8+length).toString('utf8'));}catch(e){ipcError=e;return;}
      buffer=buffer.subarray(8+length);
      if(opcode===0) {
        if(value.client_id!=='1304864863830540439')ipcError=new Error('unexpected Discord client ID');
        socket.write(frame(1,{evt:'READY'}));
      } else if(opcode===1 && value.cmd==='SET_ACTIVITY') events.push(value.args.activity);
    }
  });
});
async function waitFor(fn,message,timeout=30000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    if(ipcError)throw ipcError;
    if(await fn())return;
    if(child && child.exitCode!==null)throw new Error('Launcher exited: '+child.exitCode);
    await delay(100);
  }
  throw new Error('Timed out: '+message);
}
async function waitIpc(id,start=0) {
  const suffix=id==='default'?'/icon-512.png':`/launcher-icons/${id}.png`;
  await waitFor(()=>events.slice(start).some(x=>x?.assets?.large_image?.endsWith(suffix)),`IPC ${id}`);
  const event=events.slice(start).find(x=>x?.assets?.large_image?.endsWith(suffix));
  assert(!('small_image' in event.assets),'disabled instance icon leaked');
  return event.assets.large_image;
}
async function verifyPublicImage(url,id) {
  const file=id==='default'?'apps/omnispec-app/icons/icon-512.png':`apps/omnispec-app/ui/assets/launcher-icons/${id}.png`;
  if(process.env.EXPECTED_LAUNCHER_ICON_REF) {
    assert.equal(url,`https://raw.githubusercontent.com/Shokydo/OmniSpec/${process.env.EXPECTED_LAUNCHER_ICON_REF}/${file}`,
      `${id}: incorrect published image URL`);
  }
  const response=await fetch(url);assert(response.ok,`${url} HTTP ${response.status}`);
  assert((response.headers.get('content-type')||'').startsWith('image/png'),url);
  const local=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const remote=crypto.createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
  assert.equal(remote,local,`${id}: public PNG differs from embedded source`);
}
function inspect(id) {
  const file=id==='default'?'apps/omnispec-app/icons/icon-512.png':`apps/omnispec-app/ui/assets/launcher-icons/${id}.png`;
  const output=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',
    'tools/tests/windows-launcher-icon-inspect.ps1','-ProcessId',String(child.pid),'-ExpectedImage',file],
    {encoding:'utf8',timeout:40000});
  const result=JSON.parse(output.trim().split(/\r?\n/).pop());
  assert(result.small.distance<14 && result.big.distance<14,`${id}: ${output}`);
  return result;
}
async function waitSaved(id) {
  await waitFor(()=>{try{return JSON.parse(fs.readFileSync(settings,'utf8')).launcher_icon===id;}catch{return false;}},`saved ${id}`);
  await page.waitForFunction(id=>document.querySelector('.tb-logo img')?.dataset.launcherIcon===id,id);
}
async function launch() {
  child=spawn(launcher,[],{stdio:'ignore',env:{...process.env,OMNISPEC_HOME:data,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview')}});
  let error=null;child.on('error',e=>{error=e;});
  await waitFor(async()=>{
    if(error)throw error;
    try{return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;}catch{return false;}
  },'WebView2 CDP',90000);
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context=browser.contexts()[0];
  page=context.pages()[0]||await context.waitForEvent('page',{timeout:30000});
  await page.waitForFunction(()=>window.omnispecDebug?.state?.settings,null,{timeout:60000});
}
async function stop() {
  if(page && !page.isClosed()) await page.evaluate(()=>window.__TAURI__.core.invoke('window_action',{action:'close'})).catch(()=>{});
  if(child && child.exitCode===null) {
    const done=new Promise(resolve=>child.once('exit',resolve));
    await Promise.race([done,delay(8000)]);
    if(child.exitCode===null){child.kill();await Promise.race([done,delay(5000)]);}
  }
  if(browser)await browser.close().catch(()=>{});
  child=null;browser=null;page=null;
  await waitFor(async()=>{try{await fetch(`http://127.0.0.1:${port}/json/version`);return false;}catch{return true;}},'old CDP shutdown',15000);
}
async function prefs() {
  if(await page.locator('#modal-prefs').isHidden())await page.locator('#btn-quick-settings').click();
  await page.locator('[data-pref="look"]').click();
  await page.waitForSelector('#launcher-icon-grid');
}
async function choose(id){await page.locator(`#launcher-icon-grid label:has(input[value="${id}"])`).click();}
async function lockSettings() {
  lock=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',
    'tools/tests/windows-launcher-icon-lock.ps1','-Path',settings],{stdio:['ignore','pipe','pipe']});
  let out='',err='';lock.stdout.on('data',v=>{out+=v;});lock.stderr.on('data',v=>{err+=v;});
  await waitFor(()=>{if(lock.exitCode!==null)throw new Error('lock exited: '+err);return out.includes('SETTINGS_LOCKED');},'settings lock');
}
async function unlockSettings() {
  if(lock && lock.exitCode===null) {
    const done=new Promise(resolve=>lock.once('exit',resolve));
    lock.kill();await Promise.race([done,delay(5000)]);
  }
  lock=null;
}

(async()=>{
  try {
    // Если настоящая труба Discord занята, тест прекращается до запуска приложения.
    await new Promise((resolve,reject)=>server.once('error',reject).listen('\\\\.\\pipe\\discord-ipc-0',resolve));
    await launch();
    let url=await waitIpc('default');await verifyPublicImage(url,'default');
    console.log('WINDOWS_STARTUP_NATIVE',JSON.stringify(inspect('default')));
    await prefs();
    for(const id of ['ru','by','kz','ua','us']) {
      const start=events.length;await choose(id);await waitSaved(id);
      url=await waitIpc(id,start);await verifyPublicImage(url,id);
      console.log('WINDOWS_ICON_SMALL_BIG_AND_IPC_OK',id,JSON.stringify(inspect(id)));
      assert.equal(JSON.parse(fs.readFileSync(settings,'utf8')).username,'IconFixture');
    }

    // Текущая запись занимает settings.json, из-за этого MoveFileEx должен
    // завершиться ошибкой и вернуть иконки в окно и настройки.
    const before=events.length;await lockSettings();await choose('ru');
    await page.waitForFunction(()=>document.querySelector('#toasts')?.textContent.includes('Не удалось сохранить иконку лаунчера'),null,{timeout:20000});
    await page.waitForFunction(()=>document.querySelector('.tb-logo img')?.dataset.launcherIcon==='us');
    await unlockSettings();await waitSaved('us');await delay(700);
    assert(!events.slice(before).some(x=>x?.assets?.large_image?.endsWith('/launcher-icons/ru.png')));
    console.log('WINDOWS_FAILED_SAVE_ROLLBACK_OK',JSON.stringify(inspect('us')));

    // Украина встречается только в конце: ожидание не может ошибочно принять
    // промежуточную запись или событие от предыдущего теста.
    const burstStart=events.length;
    await page.evaluate(()=>{
      for(const id of ['ru','us','kz','by','ua']) {
        const input=document.querySelector(`#launcher-icon-grid input[value="${id}"]`);
        input.checked=true;input.dispatchEvent(new Event('change',{bubbles:true}));
      }
    });
    await waitSaved('ua');await waitIpc('ua',burstStart);
    console.log('WINDOWS_FAST_SWITCH_OK',JSON.stringify(inspect('ua')));
    await stop();const after=events.length;await launch();
    await waitSaved('ua');await waitIpc('ua',after);
    console.log('WINDOWS_RESTART_RESTORE_OK',JSON.stringify(inspect('ua')));
    await prefs();const from=events.length;await choose('default');await waitSaved('default');await waitIpc('default',from);
    console.log('WINDOWS_DEFAULT_RESTORE_OK',JSON.stringify(inspect('default')));
    console.log('WINDOWS_LAUNCHER_ICON_NATIVE_IPC_TEST_OK');
  } finally {
    await unlockSettings().catch(()=>{});
    await stop().catch(()=>{});
    for(const c of connections)c.destroy();
    await new Promise(resolve=>server.close(()=>resolve()));
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:300});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
