// Геометрия и кликабельность иконок в настоящем Tauri/WebView2.
// Запускать только на одноразовом GitHub-hosted Windows runner через
// windows-icon-centering-cdp.ps1; настройки и сборки — исключительно тестовые.
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
const root=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP,'omnispec-icons-cdp-'));
const data=path.join(root,'data');
fs.mkdirSync(data,{recursive:true});
fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({onboarded:true,update_enabled:false,
  discord_rpc:false,click_fx:'off',ambient:'off',trail:false,trail_style:'sparks',sound_fx:false,ui_scale:100}));
for (const item of [{id:'heart',name:'Heart fixture',icon:'i-heart'},
                    {id:'bolt',name:'Bolt fixture',icon:'i-bolt'},
                    {id:'letter',name:'Letter fixture',icon:null}]) {
  const dir=path.join(data,'instances',item.id);
  fs.mkdirSync(path.join(dir,'minecraft'),{recursive:true});
  fs.writeFileSync(path.join(dir,'instance.json'),JSON.stringify({...item,mc_version:'1.21.1',loader:{type:'vanilla'}}));
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let child=null,browser=null,page=null;
async function launch() {
  child=spawn(launcher,[],{stdio:'ignore',env:{...process.env,OMNISPEC_HOME:data,WEBVIEW2_USER_DATA_FOLDER:path.join(root,'webview')}});
  let childError=null; child.on('error',e=>{childError=e;});
  const deadline=Date.now()+60000; let ready=false;
  while(Date.now()<deadline) {
    if(childError) throw childError;
    if(child.exitCode!==null) throw new Error(`Launcher exited during startup: ${child.exitCode}`);
    try {const r=await fetch(`http://127.0.0.1:${port}/json/version`);if(r.ok){ready=true;break;}}catch{}
    await delay(300);
  }
  if(!ready) throw new Error('WebView2 CDP did not open; temporary policy was not honoured');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context=browser.contexts()[0];
  page=context.pages()[0] || await context.waitForEvent('page',{timeout:30000});
  await page.waitForSelector('.instance[data-id="heart"]',{timeout:60000});
  await page.waitForFunction(()=>window.omnispecDebug?.state?.settings,null,{timeout:30000});
}
async function stop() {
  if(page && !page.isClosed()) await page.evaluate(()=>window.__TAURI__.core.invoke('window_action',{action:'close'})).catch(()=>{});
  if(child && child.exitCode===null) {
    const done=new Promise(resolve=>child.once('exit',resolve));
    await Promise.race([done,delay(8000)]);
    if(child.exitCode===null){child.kill();await Promise.race([done,delay(4000)]);}
  }
  if(browser) await browser.close().catch(()=>{});
  child=null;browser=null;page=null;
  const end=Date.now()+15000;
  while(Date.now()<end) {try {await fetch(`http://127.0.0.1:${port}/json/version`);}catch{return;}await delay(250);}
  throw new Error('Old WebView2 CDP port survived shutdown');
}
async function setScale(scale) {
  // Та же геометрия, что applyUiScale; не сохраняем её в настоящие настройки.
  await page.evaluate(scale=>{
    const factor=scale/100, body=document.body;
    body.style.zoom=scale===100?'':String(factor);
    body.style.width=scale===100?'':`calc(100vw / ${factor})`;
    body.style.height=scale===100?'':`calc(100vh / ${factor})`;
    document.documentElement.dataset.uiScale=String(scale);
    document.documentElement.style.setProperty('--ui-zoom',String(factor));
    window.dispatchEvent(new Event('resize'));
  },scale);
}
async function addFixture() {
  await page.evaluate(()=>{
    const host=document.createElement('div'); host.id='test-icon-geometry';
    host.style.cssText='position:fixed;left:-10000px;top:0;display:flex;align-items:center;gap:10px';
    const icon='<svg class="ic"><use href="#i-star"></use></svg>';
    host.innerHTML=`<div class="skin-col-head"><button class="icon-btn">${icon}</button></div>
      <div class="build-path"><button class="icon-btn">${icon}</button></div>
      <div class="account-row"><button class="icon-btn">${icon}</button></div>
      <div class="card-icon"><span class="card-letter">M</span></div>
      <div class="proj-icon"><span class="card-letter">M</span></div>
      <div class="fm-row"><span class="ico">${icon}</span></div>`;
    document.body.append(host);
  });
}
async function audit(label, scale) {
  const items=await page.evaluate(()=>{
    const sels=['.icon-btn > .ic','.catalog-source > .ic','.home-filters-toggle > .ic',
      '.instance-icon > .ic','.tb-icon > .ic','.tb-icon > .tb-letter',
      '.home-card-icon > .ic','.home-card-icon > .card-letter','.card-icon > .card-letter',
      '.proj-icon > .card-letter','.icon-chip > .ic','.build-tile-icon.is-symbol > .ic',
      '.build-tile-shot > .build-tile-icon','.fm-row .ico > .ic'];
    return sels.flatMap(selector=>[...document.querySelectorAll(selector)].map(child=>{
      const a=child.parentElement.getBoundingClientRect(),b=child.getBoundingClientRect();
      if(!a.width||!a.height||!b.width||!b.height||getComputedStyle(child).visibility==='hidden')return null;
      return {selector,dx:(b.left+b.right-a.left-a.right)/2,dy:(b.top+b.bottom-a.top-a.bottom)/2,
        overflow:Math.max(a.left-b.left,b.right-a.right,a.top-b.top,b.bottom-a.bottom),
        html:child.parentElement.outerHTML.slice(0,180)};
    }).filter(Boolean));
  });
  assert(items.length>=10,`${label}: too few actual icons`);
  const tolerance=.15+Math.max(1,scale/100)*.4;
  for(const x of items) {
    assert(Math.abs(x.dx)<=tolerance && Math.abs(x.dy)<=tolerance,`${label}: icon shifted: ${JSON.stringify(x)}`);
    if(x.selector==='.card-icon > .card-letter'||x.selector==='.proj-icon > .card-letter')
      assert(x.overflow<=tolerance,`${label}: clipped letter: ${JSON.stringify(x)}`);
  }
  return items.length;
}
async function checkArtwork() {
  const data=await page.evaluate(()=>{
    const ns='http://www.w3.org/2000/svg', container=document.querySelector('#test-icon-geometry');
    return ['i-heart','i-bolt','i-refresh','i-chev'].map(id=>{
      const svg=document.createElementNS(ns,'svg'),use=document.createElementNS(ns,'use');
      svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('width','24');svg.setAttribute('height','24');
      use.setAttribute('href','#'+id);svg.append(use);container.append(svg);
      const b=use.getBBox();svg.remove();return {id,dx:b.x+b.width/2-12,dy:b.y+b.height/2-12,w:b.width,h:b.height};
    });
  });
  for(const d of data) assert(d.w>0 && d.h>0 && Math.abs(d.dx)<.1 && (d.id==='i-heart'||Math.abs(d.dy)<.1),`SVG artwork ${JSON.stringify(d)}`);
}
(async()=>{
  try {
    await launch(); await addFixture(); await checkArtwork();
    fs.mkdirSync('diagnostic-icon-centering',{recursive:true});
    for(const scale of [70,100,150]) {
      await setScale(scale);
      let count=await audit('основное окно',scale);
      await page.locator('#btn-grid').click();
      await page.waitForSelector('.build-tile-icon.is-symbol .ic');
      count+=await audit('все сборки',scale);
      const dimensions=await page.evaluate(()=>{
        const r=document.querySelector('#modal-builds .builds-box').getBoundingClientRect();
        return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight};
      });
      assert(dimensions.left>=-.5 && dimensions.top>=-.5 && dimensions.right<=dimensions.width+.5 && dimensions.bottom<=dimensions.height+.5,
        `modal outside window at ${scale}%: ${JSON.stringify(dimensions)}`);
      await page.locator('[data-close-builds]').click();
      await page.locator('#btn-new-build').click();
      await page.waitForSelector('#c-icons .icon-chip .ic');
      assert.equal(await page.locator('#c-icons .icon-chip .ic').count(),16);
      count+=await audit('выбор иконки',scale);
      await page.locator('#c-icons [data-icon="i-heart"]').click();
      assert(await page.locator('#c-icons [data-icon="i-heart"]').evaluate(el=>el.classList.contains('is-active')));
      if(scale===100 || scale===150) {
        await page.screenshot({path:`diagnostic-icon-centering/windows-icons-${scale}.png`}).catch(()=>{});
      }
      await page.locator('#modal-create [data-close-modal]').first().click();
      console.log(`WINDOWS_WEBVIEW2_ICON_CENTERING_OK scale=${scale}% measured=${count} (real Tauri, isolated fixtures)`);
    }
  } finally {
    try {if(child||browser) await stop();}catch(error){console.error('CLEANUP',error.message);if(child)child.kill();}
    try {fs.rmSync(root,{recursive:true,force:true});}catch(error){console.error('TEMP_CLEANUP',error.message);}
  }
})().catch(async error=>{
  console.error(error);
  process.exitCode=1;
});
