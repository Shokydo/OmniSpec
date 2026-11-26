const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
 const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
 try {
  const page = await browser.newPage({viewport:{width:1280,height:800}}); const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const markup='<style>.app{width:1000px;height:600px}.switch{width:32px;height:25px}</style><div class="app"><div class="app-body"><div class="sidebar"></div><div class="main"><div class="toolbar"></div><div class="tabs"></div><div class="tab-body"></div></div></div></div><div id="themes"></div>';
  const source=fs.readFileSync(path.resolve(__dirname,'../../apps/omnispec-app/ui/customization.js'),'utf8');
  async function setup(settings={}) {
    await page.setContent(markup);
    await page.evaluate(s=>{window.saved=s;window.folderCalls=[];window.omnispecDebug={state:{settings:s}};window._confirm=false;window.omnispecDialogs={confirm:async()=>window._confirm};window.__TAURI__={core:{invoke:async(c,a)=>{if(c==='open_customization_folder'){window.folderCalls.push(a.kind);return null;}if(c==='get_settings')return window.saved;if(c==='save_settings'){window.saved=JSON.parse(JSON.stringify(a.settings));return null;}}}}},settings);
    await page.addScriptTag({content:source}); await page.evaluate(()=>window.omnispecCustomizer.renderThemes(document.querySelector('#themes')));
  }
  await page.goto('about:blank'); await setup();
  await page.locator('[data-theme-folder]').click(); await page.locator('[data-script-folder]').click();
  assert.deepEqual(await page.evaluate(()=>window.folderCalls), ['themes','scripts']);
  assert((await page.locator('[data-theme-status]').innerText()).includes('не добавляется автоматически'));
  assert((await page.locator('[data-script-status]').innerText()).includes('не добавляется автоматически'));
  await page.locator('[data-script-file]').setInputFiles({name:'example.js',mimeType:'text/javascript',buffer:Buffer.from('document.body.dataset.ran="isolated"; try { parent.escapeAttempt=1 } catch(e) {}')});
  await page.waitForSelector('[data-script-row]'); assert.equal(await page.locator('[data-script-toggle]').getAttribute('aria-checked'),'false');
  assert.equal(await page.locator('[data-script-mode]').inputValue(),'isolated'); assert.equal(await page.evaluate(()=>window.escapeAttempt),undefined);
  await page.locator('[data-script-toggle]').click(); await page.waitForFunction(()=>[...document.querySelectorAll('iframe')].some(f=>f.getAttribute('sandbox')==='allow-scripts'));
  const frame=page.frames().find(f=>f!==page.mainFrame()); assert(frame); await frame.waitForFunction(()=>document.body.dataset.ran==='isolated'); assert.equal(await page.evaluate(()=>window.escapeAttempt),undefined);
  await page.locator('[data-script-toggle]').click(); assert.equal(await page.locator('iframe').count(),0);
  await page.locator('[data-script-mode]').selectOption('trusted'); await page.locator('[data-script-toggle]').click(); assert.equal(await page.evaluate(()=>window.escapeAttempt),undefined);assert.equal(await page.locator('[data-script-toggle]').getAttribute('aria-checked'),'false');
  await page.evaluate(()=>window._confirm=true); await page.locator('[data-script-toggle]').click(); await page.waitForFunction(()=>window.escapeAttempt===1); assert.equal(await page.locator('[data-script-toggle]').getAttribute('aria-checked'),'true');
  await page.locator('[data-script-toggle]').click(); assert.equal(await page.locator('[data-script-toggle]').isDisabled(),true); assert((await page.locator('[data-script-row]').innerText()).includes('перезапустите'));
  await page.waitForFunction(()=>window.saved.ui_script_modules?.length===1 && window.saved.ui_script_modules[0].mode==='trusted'); const saved=await page.evaluate(()=>window.saved);
  await page.reload(); await setup(saved); assert.equal(await page.evaluate(()=>window.escapeAttempt),undefined); assert.equal(await page.locator('[data-script-toggle]').getAttribute('aria-checked'),'false');
  assert.deepEqual(errors,[]); console.log('CUSTOM_SCRIPTS_UI: import, isolation, consent, disable/restart and persistence — OK');
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exit(1)});
