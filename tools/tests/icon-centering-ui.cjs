// Геометрия иконок в реальных экранах OmniSpec. Backend подменён: файлы и сеть не меняются.
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
    const type = ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
      '.css':'text/css; charset=utf-8','.png':'image/png'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':type}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function makePage(browser, options) {
  const page = await browser.newPage({viewport:{width:1280,height:850},deviceScaleFactor:options.dpr});
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(({scale,shape,noAccounts}) => {
    function image(w, h) {
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ee5544'; ctx.fillRect(0,0,w/3,h);
      ctx.fillStyle = '#44bb88'; ctx.fillRect(w/3,0,w/3,h);
      ctx.fillStyle = '#5577ee'; ctx.fillRect(w*2/3,0,w/3,h);
      return canvas.toDataURL('image/png');
    }
    const square = image(64,64), wide = image(180,60);
    let settings = {
      theme:'dark', shape, ui_scale:scale, click_fx:'off', ambient:'off', trail:false,
      sound_fx:false, onboarded:true, discord_rpc:false, update_enabled:false,
      feed_source:'modrinth', feed_grid:2, wallpaper_engine_enabled:true,
      skin_presets:[{id:'legacy',name:'Legacy skin',path:'/skins/legacy.png',variant:'classic'}],
      skin_favorites:[{id:'fav',name:'Favorite',skinDataUrl:square}]
    };
    let instances = [
      {id:'alpha',name:'Alpha',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16'},icon:null,created:3},
      {id:'beta',name:'Beta',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16'},icon:'i-star',created:2},
      {id:'gamma',name:'Gamma',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16'},icon:'custom.png',created:1}
    ];
    const mock = window.__iconTest = {
      calls:[],
      async invoke(cmd, args = {}) {
        this.calls.push({cmd,args});
        switch (cmd) {
          case 'get_settings': return settings;
          case 'save_settings': settings=args.settings; return null;
          case 'list_instances': return instances.map(item => ({...item}));
          case 'update_instance': instances=instances.map(item => item.id===args.meta.id ? {...args.meta} : item); return args.meta;
          case 'running_instances': return [];
          case 'instance_icon': return wide;
          case 'accounts_info': return noAccounts ? {accounts:[],active:null} : {accounts:[{uuid:'on',username:'Alex',kind:'microsoft'},{uuid:'off',username:'Steve',kind:'offline'}],active:'on'};
          case 'account_skin': return {licensed:true,variant:'classic',data_url:square};
          case 'account_capes': return {licensed:true,capes:[{id:'cape',alias:'Example',active:true,data_url:square}]};
          case 'system_memory': return {total_mb:16384};
          case 'version_info': return {version:'test',enabled:false};
          case 'app_info': return {home:'/data',version:'test',platform:'test',demo:false};
          case 'minecraft_versions': return [{id:'1.21.1',type:'release'}];
          case 'loader_versions': return [{version:'0.16.1',stable:true}];
          case 'list_java': case 'catalog_installed_mods': return [];
          case 'search_modrinth': case 'search_curseforge':
            return {hits:Array.from({length:6},(_,i)=>({project_id:'project'+i,slug:'project'+i,
              title:i%2?'Image project':'Missing image',description:'Описание',project_type:args.projectType,
              categories:[],downloads:100,icon_url:i%2?wide:null})),total_hits:6};
          case 'modrinth_project': case 'curseforge_project':
            return {id:args.projectId,title:args.projectId,project_type:'mod',description:'Описание',
              body:'Описание',categories:[],downloads:100,icon_url:String(args.projectId).endsWith('1')?wide:null};
          case 'content_list': return [
            {filename:'one.jar',name:'One',enabled:true,size:1234},
            {filename:'two.jar',name:'Two',enabled:false,size:1234}
          ];
          case 'mod_icons': return {'two.jar':wide};
          case 'world_icons': return {};
          case 'list_dir': return [
            {name:'folder',path:'folder',is_dir:true,size:0},
            {name:'notes.txt',path:'notes.txt',is_dir:false,size:100}
          ];
          case 'list_screenshots': return [{name:'shot.png',size:100}];
          case 'screenshot_thumb': return null;
          case 'scan_external_launchers': return [{launcher:'prism',name:'External',path:'/external',mc_version:'1.21.1',loader:'fabric',icon:null}];
          case 'scan_wallpaper_library': return {projects:[
            {title:'Preview',directory:'/steam/1',kind:'video',workshop_id:'1',preview:'/preview.png',playable:true},
            {title:'No preview',directory:'/steam/2',kind:'web',workshop_id:'2',preview:null,playable:false}
          ],searched:['/steam'],engine:null,scene_capture:false,truncated:false};
          case 'pick_file': return '/fixture/custom.png';
          case 'image_data_url': return args.path.startsWith('/skins/') ? square : wide;
          case 'instance_path': return `/data/${args.instanceId}`;
          default: return null;
        }
      }
    };
    window.__TAURI__ = {core:{invoke:(command,args)=>mock.invoke(command,args),convertFileSrc:p=>p},event:{listen:async()=>()=>{}}};
  }, options);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('#dv-results .card');
  // Загрузка своей картинки асинхронная; видимую геометрию проверяем отдельно.
  await page.waitForSelector('[data-home-id="gamma"] .home-card-icon img', {state:'attached'});
  return {page,errors};
}

// Проверяем сами ячейки и отдельно иконки рядом с текстом: последние не должны
// перемещаться в горизонтальный центр кнопки, а только совпадать по вертикали.
async function audit(page, label, scale, seen) {
  const result = await page.evaluate(() => {
    const paired = [
      '.icon-btn > .ic', '.catalog-source > .ic', '.home-filters-toggle > .ic',
      '.icon-chip > .ic', '.icon-chip.img > img', '.tb-icon > .ic', '.tb-icon > img', '.tb-icon > .tb-letter',
      '.home-card-icon > .ic', '.home-card-icon > img', '.home-card-icon > .card-letter',
      '.instance-icon > .ic', '.instance-icon > img', '.tb-logo > img',
      '.card-icon > .card-letter', '.card-icon > img', '.proj-icon > .card-letter', '.proj-icon > img',
      '.mod-icon > .ic', '.mod-icon > img', '.ext-icon > .ic', '.ext-icon > img',
      '.acc-avatar > .ic', '.acc-avatar > img', '.acc-avatar > .acc-letter',
      '.fm-row .ico > .ic', '.fm-item .fname .ico > .ic', '.errors-status-icon > .ic',
      '.errors-card-mark > .ic', '.cape-thumb-off > .ic', '.build-tile-icon.is-symbol > .ic',
      '.build-tile-shot > .build-tile-icon', '.shot-img > .ic', '.shot-img > img',
      '.we-thumb > img', '.we-thumb > span:not(.we-type)'
    ];
    const text = ['.icon-chip.letter', '.skin-library-remove', '.instance-icon',
      '.build-tile-icon.is-letter', '.fav-slot .preset-del'];
    const inline = ['.btn > .ic', '.ctx-item > .ic', '.pop-item > .ic', '.home-category > .ic',
      '.search > .ic', '.mr-view button > .ic', '.initial-tab-option > .ic'];
    const items = [];
    function add(selector, parent, rect, kind, child) {
      const box=parent.getBoundingClientRect();
      if (!box.width || !box.height || !rect.width || !rect.height) return;
      const s=getComputedStyle(child || parent);
      if (s.visibility==='hidden' || s.display==='none') return;
      items.push({selector,kind,dx:(rect.left+rect.right-box.left-box.right)/2,
        dy:(rect.top+rect.bottom-box.top-box.bottom)/2,
        overflow:{left:box.left-rect.left,right:rect.right-box.right,top:box.top-rect.top,bottom:rect.bottom-box.bottom},
        html:parent.outerHTML.slice(0,220),
        fit:child?.tagName==='IMG' ? s.objectFit : null,
        position:child?.tagName==='IMG' ? s.objectPosition : null});
    }
    for (const selector of paired) for (const child of document.querySelectorAll(selector)) {
      add(selector,child.parentElement,child.getBoundingClientRect(),'box',child);
    }
    for (const selector of text) for (const parent of document.querySelectorAll(selector)) {
      if (parent.children.length || !parent.firstChild || parent.firstChild.nodeType!==Node.TEXT_NODE || !parent.textContent.trim()) continue;
      const range=document.createRange(); range.selectNodeContents(parent);
      add(selector+' [text]',parent,range.getBoundingClientRect(),'text',null);
    }
    for (const selector of inline) for (const child of document.querySelectorAll(selector)) {
      const parent=child.parentElement, style=getComputedStyle(parent);
      if (style.alignItems!=='center' || !style.display.includes('flex') || style.flexDirection.startsWith('column')) continue;
      add(selector+' [inline]',parent,child.getBoundingClientRect(),'inline',child);
    }
    return items;
  });
  assert(result.length > 8, `${label}: no icons were measured`);
  const tolerance = 0.12 + Math.max(1,scale/100)*0.35;
  for (const item of result) {
    seen.add(item.selector);
    const limit = item.kind==='text' ? 0.4 + scale/100 : tolerance;
    if (item.kind !== 'inline') assert(Math.abs(item.dx)<=limit, `${label}: сдвиг по X ${JSON.stringify(item)}`);
    assert(Math.abs(item.dy)<=limit, `${label}: сдвиг по Y ${JSON.stringify(item)}`);
    // Буквенные заглушки в каталоге и сведения о проекте не должны обрезаться.
    if (item.selector==='.card-icon > .card-letter' || item.selector==='.proj-icon > .card-letter') {
      assert(Math.max(...Object.values(item.overflow))<=tolerance, `${label}: обрезанная заглушка ${JSON.stringify(item)}`);
    }
    if (item.fit) {
      assert(['cover','contain'].includes(item.fit), `${label}: картинка теряет пропорции ${JSON.stringify(item)}`);
      assert.equal(item.position,'50% 50%', `${label}: картинка обрезается не по центру ${JSON.stringify(item)}`);
    }
  }
}

async function checkSvgArtwork(page) {
  const symbols = await page.evaluate(() => {
    const ns='http://www.w3.org/2000/svg', host=document.createElement('div');
    host.style.cssText='position:fixed;left:-9999px;top:0'; document.body.append(host);
    const result=[...document.querySelectorAll('symbol')].map(symbol => {
      const svg=document.createElementNS(ns,'svg'), use=document.createElementNS(ns,'use');
      svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('width','24'); svg.setAttribute('height','24');
      use.setAttribute('href','#'+symbol.id); svg.append(use); host.append(svg);
      const b=use.getBBox();
      return {id:symbol.id,x:b.x,y:b.y,width:b.width,height:b.height};
    });
    host.remove(); return result;
  });
  assert(symbols.length>=40, 'не измерен набор встроенных значков');
  for (const b of symbols) {
    assert(b.width>0 && b.height>0, `пустая SVG-иконка: ${b.id}`);
    assert(b.x>=-0.05 && b.y>=-0.05 && b.x+b.width<=24.05 && b.y+b.height<=24.05,
      `контур иконки обрезается её viewBox: ${JSON.stringify(b)}`);
  }
  for (const id of ['i-heart','i-bolt','i-refresh','i-chev']) {
    const b=symbols.find(item=>item.id===id); assert(b,`нет ${id}`);
    assert(Math.abs(b.x+b.width/2-12)<0.1, `не центрирован контур ${id} по X`);
    if (id!=='i-heart') assert(Math.abs(b.y+b.height/2-12)<0.1, `не центрирован контур ${id} по Y`);
  }
}

async function checkSmallCells(page, scale, seen) {
  await page.evaluate(() => {
    const host=document.createElement('div'); host.id='centering-fixture';
    host.style.cssText='position:fixed;left:-9999px;top:0;display:flex;align-items:center;gap:10px';
    host.innerHTML=`<div class="skin-col-head"><button class="icon-btn"><svg class="ic"><use href="#i-refresh"></use></svg></button></div>
      <div class="build-path"><button class="icon-btn"><svg class="ic"><use href="#i-copy"></use></svg></button></div>
      <div class="account-row"><button class="icon-btn"><svg class="ic"><use href="#i-pencil"></use></svg></button></div>`;
    document.body.append(host);
  });
  try { await audit(page,'минимальные кнопки',scale,seen); }
  finally { await page.locator('#centering-fixture').evaluate(el=>el.remove()); }
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try {
    for (const options of [
      {scale:70,shape:'square',dpr:1.25}, {scale:100,shape:'soft',dpr:1}, {scale:150,shape:'rounded',dpr:2}
    ]) {
      const {page,errors}=await makePage(browser,options), seen=new Set();
      const scale=options.scale;
      try {
        await checkSvgArtwork(page);
        await checkSmallCells(page,scale,seen);
        for (const width of [1080,1280,1600,1920]) {
          await page.setViewportSize({width,height:850});
          await audit(page,`главная: плитка ${width}/${scale}%`,scale,seen);
        }
        await page.locator('[data-dv-view="list"]').click();
        await page.waitForSelector('#dv-results:not(.is-grid) .card');
        for (const width of [1080,1280,1600,1920]) {
          await page.setViewportSize({width,height:850});
          await audit(page,`главная: список ${width}/${scale}%`,scale,seen);
        }
        await page.setViewportSize({width:1600,height:900});
        await page.locator('#dv-results .card .card-title').first().click();
        await page.waitForSelector('.proj-icon .card-letter');
        await audit(page,'проект без картинки',scale,seen);
        await page.locator('[data-close-project]').click();
        await page.locator('#dv-results .card .card-title').nth(1).click();
        await page.waitForSelector('.proj-icon img');
        await audit(page,'проект с широкой картинкой',scale,seen);
        await page.locator('[data-close-project]').click();
        await page.locator('[data-dv-source="curseforge"]').click();
        await page.waitForSelector('#dv-results .card[data-cf-project]');
        await audit(page,'каталог CurseForge',scale,seen);
        await page.locator('#imp-toggle').click();
        await page.locator('#imp-ext').click();
        await page.waitForSelector('.imp-list .ext-icon .ic');
        await audit(page,'импорт сборок',scale,seen);
        await page.locator('#btn-grid').click();
        await page.waitForSelector('.build-tile-icon.is-symbol .ic');
        for (const viewport of [{width:1080,height:640},{width:1280,height:800},{width:1600,height:900},{width:1920,height:1080}]) {
          await page.setViewportSize(viewport);
          await audit(page,`все сборки: ${viewport.width}×${viewport.height}`,scale,seen);
          const buildsBox=await page.locator('#modal-builds .builds-box').boundingBox();
          assert(buildsBox.x>=0 && buildsBox.y>=0 && buildsBox.x+buildsBox.width<=viewport.width+1 && buildsBox.y+buildsBox.height<=viewport.height+1,
            `окно сборок выходит за экран при ${scale}%: ${JSON.stringify({viewport,buildsBox})}`);
        }
        await page.setViewportSize({width:1600,height:900});
        await page.locator('[data-close-builds]').click();
        await page.locator('#btn-new-build').click();
        await page.waitForSelector('#c-icons .icon-chip .ic');
        assert.equal(await page.locator('#c-icons .icon-chip .ic').count(),16);
        await audit(page,'выбор встроенной иконки новой сборки',scale,seen);
        await page.locator('#c-icons [data-icon="i-heart"]').click();
        assert(await page.locator('#c-icons [data-icon="i-heart"]').evaluate(el=>el.classList.contains('is-active')));
        await page.locator('#c-icon-file').click();
        await page.waitForSelector('#c-icons .icon-chip.img img');
        await audit(page,'своя иконка новой сборки',scale,seen);
        await page.locator('#modal-create [data-close-modal]').first().click();
        await page.locator('[data-home-id="beta"]').click();
        await page.waitForFunction(()=>window.omnispecDebug.state.selectedId==='beta');
        await page.waitForSelector('#build-path-copy:not([hidden])');
        await audit(page,'шапка сборки',scale,seen);
        await page.locator('.instance[data-id="beta"]').click({button:'right'});
        await page.waitForSelector('#ctx-menu .ctx-item');
        await audit(page,'контекстное меню',scale,seen);
        await page.keyboard.press('Escape');
        await page.locator('[data-tab="errors"]').click();
        await page.waitForSelector('.errors-status-icon .ic');
        await audit(page,'ошибки',scale,seen);
        await page.locator('[data-tab="files"]').click();
        await page.waitForSelector('.fm-row .ico .ic');
        await page.waitForSelector('.fm-item .ico .ic');
        await audit(page,'файлы',scale,seen);
        await page.locator('[data-tab="mods"]').click();
        await page.waitForSelector('.mod-icon .ic');
        await page.waitForSelector('.mod-icon img');
        await audit(page,'моды',scale,seen);
        await page.locator('[data-tab="screenshots"]').click();
        await page.waitForSelector('.shot-img .ic');
        await audit(page,'скриншоты',scale,seen);
        await page.locator('[data-tab="settings"]').click();
        await page.waitForSelector('#inst-icons .icon-chip .ic');
        await audit(page,'настройки сборки',scale,seen);
        await page.locator('#inst-icons [data-icon="i-heart"]').click();
        assert(await page.locator('#inst-icons [data-icon="i-heart"]').evaluate(el=>el.classList.contains('is-active')));
        await page.locator('#inst-save').click();
        await page.waitForFunction(()=>document.querySelector('#tb-icon use')?.getAttribute('href')==='#i-heart');
        await audit(page,'сохранённая иконка в шапке',scale,seen);
        await page.locator('.instance[data-id="gamma"]').click();
        await page.waitForFunction(()=>window.omnispecDebug.state.selectedId==='gamma');
        await page.locator('[data-tab="settings"]').click();
        await page.waitForSelector('#inst-icons .icon-chip.img img');
        await audit(page,'своя иконка в настройках сборки',scale,seen);
        await page.locator('.instance[data-id="alpha"]').click();
        await page.waitForFunction(()=>window.omnispecDebug.state.selectedId==='alpha');
        await audit(page,'буква в шапке',scale,seen);
        await page.locator('#btn-quick-settings').click();
        await page.locator('[data-pref="profile"]').click();
        await page.waitForSelector('#skin-library [data-skin-id]');
        await page.waitForSelector('.cape-thumb-off .ic');
        await audit(page,'профиль и скины',scale,seen);
        await page.locator('[data-pref="look"]').click();
        await page.locator('#prefs-initial-tab').click();
        await page.waitForSelector('.initial-tab-option .ic');
        await audit(page,'выбор начальной вкладки',scale,seen);
        await page.locator('#modal-initial-tab [data-close-initial-tab]').click();
        await page.locator('[data-pref="wall"]').click();
        await page.waitForSelector('#we-grid .we-thumb img');
        await page.waitForSelector('#we-grid .we-thumb > span:not(.we-type)');
        await audit(page,'превью Wallpaper Engine',scale,seen);
        await page.locator('[data-close-prefs]').click();
        const empty=await makePage(browser,{...options,noAccounts:true});
        try {
          await empty.page.waitForSelector('#account-chip-avatar .ic');
          await audit(empty.page,'нет аккаунта',scale,seen);
          assert.deepEqual(empty.errors,[]);
        } finally { await empty.page.close(); }
        for (const required of [
          '.icon-btn > .ic','.catalog-source > .ic','.home-filters-toggle > .ic','.icon-chip > .ic',
          '.icon-chip.img > img','.tb-icon > .ic','.tb-icon > img','.tb-icon > .tb-letter',
          '.home-card-icon > .ic','.home-card-icon > img','.home-card-icon > .card-letter',
          '.instance-icon > .ic','.instance-icon > img','.tb-logo > img','.card-icon > .card-letter',
          '.card-icon > img','.proj-icon > .card-letter','.proj-icon > img','.mod-icon > .ic','.mod-icon > img',
          '.ext-icon > .ic','.acc-avatar > .ic','.acc-avatar > .acc-letter','.fm-row .ico > .ic',
          '.fm-item .fname .ico > .ic','.errors-status-icon > .ic','.cape-thumb-off > .ic',
          '.build-tile-icon.is-symbol > .ic','.build-tile-shot > .build-tile-icon','.shot-img > .ic',
          '.we-thumb > img','.we-thumb > span:not(.we-type)',
          '.icon-chip.letter [text]','.skin-library-remove [text]','.instance-icon [text]',
          '.build-tile-icon.is-letter [text]','.fav-slot .preset-del [text]',
          '.ctx-item > .ic [inline]','.initial-tab-option > .ic [inline]'
        ]) assert(seen.has(required), `не проверена ячейка ${required} при масштабе ${scale}%`);
        assert.deepEqual(errors,[]);
        console.log(`ICON_CENTERING scale=${scale}% dpr=${options.dpr} shape=${options.shape}: 1080–1920, каталоги, сборки, кнопки, файлы, профиль, диалоги and SVG — OK`);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
