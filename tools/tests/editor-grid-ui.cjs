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
    async function geometry() { return page.evaluate(()=>{const id='account', el=document.querySelector(`.visual-canvas-item[data-visual-id="${id}"]`), stage=document.querySelector('.visual-stage-inner'), app=document.querySelector('.app'), node=document.querySelector('[data-os-element="toolbar"]');const a=app.getBoundingClientRect(), z=a.width/app.offsetWidth;return {x:+el.dataset.logicalLeft,y:+el.dataset.logicalTop,w:+el.dataset.logicalWidth,h:+el.dataset.logicalHeight,scale:+el.dataset.stageScale,screen:+el.dataset.screenFactor,grid:parseFloat(stage.style.backgroundSize), appX:a.left/z, appY:a.top/z, actual:node?.getBoundingClientRect().toJSON()};}); }
    function aligned(g,step) {for(const k of ['x','y','w','h']) assert(Math.abs(g[k]/step-Math.round(g[k]/step))<.15,JSON.stringify({step,g,k}));assert(Math.abs(g.grid-g.scale*step)<.01);}
    for (const [width,height,zoom,step] of [[1280,800,1,16],[1080,640,1.5,8],[1280,800,.7,32]]) {
      await page.setViewportSize({width,height});await page.evaluate(z=>{document.body.style.zoom=z;document.body.style.width=`calc(100vw / ${z})`;document.body.style.height=`calc(100vh / ${z})`;window.dispatchEvent(new Event('resize'))},zoom);
      await page.locator('[data-snap-grid]').selectOption(String(step));await page.locator('[data-align-grid]').click(); await page.waitForTimeout(250);
      let g=await geometry(); aligned(g,step);
      await page.locator('.visual-element[data-visual-id="account"]').click();
      for(const edge of ['e','s','w','n','nw','ne','sw','se','move']) {
        const item=page.locator('.visual-canvas-item[data-visual-id="account"]');let box=await item.boundingBox();assert(box && box.width>10 && box.height>10,JSON.stringify(box));
        let x=box.x+box.width/2,y=box.y+box.height/2;
        if(edge.includes('e'))x=box.x+box.width-2;if(edge.includes('w'))x=box.x+2;if(edge.includes('n'))y=box.y+2;if(edge.includes('s'))y=box.y+box.height-2;
        await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+g.screen*step*1.4,y+g.screen*step*1.4,{steps:4});await page.mouse.up();await page.waitForTimeout(80);
        const old=g; g=await geometry();aligned(g,step);
        assert(['x','y','w','h'].some(k=>Math.abs(old[k]-g[k])>step*.5),`no change on ${edge}: ${JSON.stringify({old,g})}`);
      }
    }
    assert.deepEqual(errors,[]);console.log('EDITOR_GRID_DRAG_RESIZE_ZOOM_OK');
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1});
