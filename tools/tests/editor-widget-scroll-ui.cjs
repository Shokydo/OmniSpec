// 0.52: fullscreen visual editor, editable CSS, build context actions, dynamic categories and server catalog pagination.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try {
    const type = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.stack || String(error)));
    page.on('dialog', dialog => { errors.push(`Unexpected native dialog: ${dialog.type()}`); dialog.dismiss(); });
    await page.addInitScript(() => {
      const calls = [];
      const settings = { onboarded: true, onboarding_pending: false, update_enabled: false, discord_rpc: false, discord_instance_icon: false, theme: 'dark', click_fx: 'off', ambient: 'off', trail: false, ui_scale: 100, categories: [] };
      try { Object.assign(settings, JSON.parse(sessionStorage.getItem('v052-settings') || '{}')); } catch {}
      const instances = [
        { id: 'fabric', name: 'Fabric Pack', playtime_secs: 7200, mc_version: '1.21.1', loader: { type: 'fabric', version: '0.16.9' }, source: 'manual', notes: '' },
        { id: 'paper', name: 'Paper Server', mc_version: '1.21.1', loader: { type: 'vanilla' }, source: 'manual', notes: '', is_server: true, kind: 'server', server: { kernel: 'paper', mc_version: '1.21.1', kernel_version: '1.21.1', memory_mb: 4096, port: 25565 } },
        { id: 'forge', name: 'Forge Pack', mc_version: '1.20.1', loader: { type: 'forge', version: '47.2' }, source: 'import', notes: 'shaders' }
      ];
      const invoke = async (command, args = {}) => {
        calls.push({ command, args });
        if (command === 'get_settings') return JSON.parse(JSON.stringify(settings));
        if (command === 'save_settings') { Object.assign(settings, JSON.parse(JSON.stringify(args.settings))); sessionStorage.setItem('v052-settings', JSON.stringify(settings)); return null; }
        if (command === 'list_instances') return instances.map((item) => ({ ...item }));
        if (command === 'accounts_info') return { accounts: [], active: null };
        if (command === 'app_info') return { home: '/test', version: '0.52.1', demo: false };
        if (command === 'version_info') return { version: '0.52.1', enabled: false };
        if (command === 'check_update') return window.__v052.updateInfo || null;
        if (command === 'system_memory') return { total_mb: 8192 };
        if (command === 'list_java') return [];
        if (command === 'running_instances' || command === 'running_sessions') return [];
        if (command === 'server_snapshot') return { id: 'paper', config: instances[1].server, root: '/test/paper/server', eula_accepted: true, running: false, metrics: { pid: null, memory_bytes: 0, cpu_percent: 0, uptime_secs: 0, tps: null }, players: [], files: [], log_tail: [] };
        if (['server_addons', 'list_mods', 'list_dir', 'content_list'].includes(command)) return [];
        if (command === 'mod_icons') return {};
        if (command === 'server_search_addons') {
          const all = Array.from({ length: 48 }, (_, index) => ({ project_id: `plugin-${index}`, title: `Plugin ${index}`, description: 'Test plugin', downloads: 1000 - index }));
          const offset = Number(args.offset || 0); const limit = Number(args.limit || 24);
          return { hits: all.slice(offset, offset + limit), total_hits: all.length, offset, limit };
        }
        if (command === 'server_addon_versions') return [];
        return null;
      };
      window.__v052 = { calls, settings, instances };
      window.__TAURI__ = { core: { invoke }, event: { listen: async () => () => {} } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForSelector('[data-id="fabric"]');
    await page.waitForFunction(()=>window.omnispecDebug?.state?.settings);
    await page.evaluate(()=>window.omnispecCustomizer.open());
    await page.waitForSelector('#modal-customizer:not([hidden]) .visual-editor');
    await page.waitForTimeout(300);
    for (const [w,h,scale] of [[1280,800,100],[1080,640,100],[1080,640,150],[1280,800,70]]) {
      await page.setViewportSize({width:w,height:h});
      await page.evaluate(scale=>{const f=scale/100;document.body.style.zoom=scale===100?'':String(f);document.body.style.width=scale===100?'':`calc(100vw / ${f})`;document.body.style.height=scale===100?'':`calc(100vh / ${f})`;window.dispatchEvent(new Event('resize'))},scale);
      await page.waitForTimeout(100);
      const metrics=await page.evaluate(()=>{const b=s=>{const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};return {left:b('.visual-elements'),center:b('.visual-canvas-panel'),right:b('.visual-properties'),stage:b('.visual-stage'),editor:b('.visual-editor'),listMax:document.querySelector('.visual-element-list').scrollHeight-document.querySelector('.visual-element-list').clientHeight,propsMax:document.querySelector('.visual-properties').scrollHeight-document.querySelector('.visual-properties').clientHeight}});
      assert(metrics.left.right<=metrics.center.left+1 && metrics.center.right<=metrics.right.left+1,JSON.stringify({w,h,scale,metrics}));
      assert(metrics.stage.height>80 && metrics.center.top>=0 && metrics.center.bottom<=h+1 && metrics.right.bottom<=h+1,JSON.stringify({w,h,scale,metrics}));
      assert(metrics.listMax>10 && metrics.propsMax>10,JSON.stringify({w,h,scale,metrics}));
      const before=await page.locator('.visual-stage').boundingBox();
      await page.locator('.visual-element-list').hover();await page.mouse.wheel(0,550);await page.waitForTimeout(350);
      assert(await page.locator('.visual-element-list').evaluate(el=>el.scrollTop)>0);
      await page.locator('.visual-properties').hover();await page.mouse.wheel(0,420);await page.waitForTimeout(350);
      assert(await page.locator('.visual-properties').evaluate(el=>el.scrollTop)>0);
      const after=await page.locator('.visual-stage').boundingBox();assert(Math.abs(before.y-after.y)<1 && Math.abs(before.x-after.x)<1,'canvas moves when side panels scroll: '+JSON.stringify({w,h,scale,before,after}));
      const positions=await page.evaluate(()=>[document.querySelector('.visual-element-list').scrollTop,document.querySelector('.visual-properties').scrollTop]);
      await page.evaluate(()=>window.omnispecCustomizer.render());
      const restored=await page.evaluate(()=>[document.querySelector('.visual-element-list').scrollTop,document.querySelector('.visual-properties').scrollTop]);
      assert(positions.every((n,i)=>Math.abs(n-restored[i])<2),JSON.stringify({positions,restored}));
    }
    await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>{document.body.style.zoom='';document.body.style.width='';document.body.style.height='';window.dispatchEvent(new Event('resize'))});
    await page.locator('[data-widget-action="add"]').click();await page.locator('[data-widget-name]').fill('Проверка');await page.locator('[data-widget-kind]').selectOption('html');
    const original='  <b id="one">Первый</b>\n';await page.locator('[data-widget-content]').fill(original);await page.locator('[data-widget-action="save"]').click();
    await page.waitForFunction(()=>window.__v052.settings.ui_layout?.custom_widgets?.length===1);const id=await page.evaluate(()=>window.__v052.settings.ui_layout.custom_widgets[0].id);
    assert.equal(await page.evaluate(()=>window.__v052.settings.ui_layout.custom_widgets[0].content),original);
    await page.locator(`[data-widget-edit-id="${id}"]`).click();assert.equal(await page.locator('[data-widget-content]').inputValue(),original);
    const changed='<div id="two">Изменён</div><script>document.body.dataset.edited="yes"</script>';
    await page.locator('[data-widget-content]').fill(changed);await page.evaluate(()=>window.omnispecCustomizer.render());assert.equal(await page.locator('[data-widget-content]').inputValue(),changed,'draft survives redraw');
    await page.locator('[data-widget-action="save"]').click();await page.waitForFunction(changed=>window.__v052.settings.ui_layout.custom_widgets[0].content===changed,changed);
    await page.frameLocator(`.os-custom-widget[data-custom-widget="${id}"] iframe`).locator('#two').waitFor();
    assert.equal(await page.frameLocator(`.os-custom-widget[data-custom-widget="${id}"] iframe`).locator('body').getAttribute('data-edited'),'yes');
    await page.locator(`[data-widget-edit-id="${id}"]`).click();await page.locator('[data-widget-kind]').selectOption('url');await page.locator('[data-widget-content]').fill('bad address');await page.locator('[data-widget-action="save"]').click();
    assert((await page.locator('[data-widget-error]').innerText()).includes('URL'));assert.equal(await page.evaluate(()=>window.__v052.settings.ui_layout.custom_widgets[0].kind),'html');
    await page.locator('[data-widget-action="cancel"]').click();assert.equal(await page.evaluate(()=>window.__v052.settings.ui_layout.custom_widgets[0].content),changed);
    await page.locator(`[data-widget-edit-id="${id}"]`).click();await page.locator('[data-widget-kind]').selectOption('url');await page.locator('[data-widget-content]').fill('https://example.com/');await page.locator('[data-widget-action="save"]').click();await page.waitForFunction(()=>window.__v052.settings.ui_layout.custom_widgets[0].kind==='url');
    assert.equal(await page.evaluate(()=>window.__v052.settings.ui_layout.custom_widgets[0].content),'https://example.com/');
    await page.locator(`[data-widget-edit-id="${id}"]`).click();await page.locator('[data-widget-kind]').selectOption('html');await page.locator('[data-widget-content]').fill(changed);await page.locator('[data-widget-action="save"]').click();await page.waitForFunction(()=>window.__v052.settings.ui_layout.custom_widgets[0].kind==='html');
    await page.reload();await page.waitForFunction(()=>window.__v052.settings.ui_layout?.custom_widgets?.length===1);await page.evaluate(()=>window.omnispecCustomizer.open());
    await page.locator(`[data-widget-edit-id="${id}"]`).click();assert.equal(await page.locator('[data-widget-content]').inputValue(),changed);assert.equal(await page.locator('[data-widget-kind]').inputValue(),'html');
    assert.deepEqual(errors,[]); console.log('EDITOR_SIDE_SCROLL_AND_WIDGET_EDIT_PERSISTENCE_OK');
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
