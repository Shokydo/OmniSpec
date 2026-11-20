const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try {
    const mime = ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':mime}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function newPage(browser, options = {}) {
  const page = await browser.newPage({ viewport:{width:1280,height:800} });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript((opts) => {
    const now = Math.floor(Date.now()/1000);
    let instances = opts.empty ? [] : [
      {id:'fabric-new',name:'Fabric 1.21',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16.0'},created:now,icon:null},
      {id:'forge-old',name:'Forge 1.20',mc_version:'1.20.1',loader:{type:'forge',version:'47.3.0'},created:now,icon:null},
      {id:'fabric-old',name:'Fabric 1.20',mc_version:'1.20.1',loader:{type:'fabric',version:'0.16.0'},created:now,icon:null},
      {id:'vanilla',name:'Без загрузчика',mc_version:'1.21.1',loader:{type:'vanilla'},created:now,icon:null}
    ];
    const callbacks = {};
    const image = n => ({title:`Картинка ${n}`,url:`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 24"><rect width="32" height="24" fill="rgb(${n * 20},80,100)"/></svg>`)}`});
    const mock = window.__homeTest = {
      calls:[], held:[], holdQueries:new Set(), failCompatibility:false, failVersions:false,
      heldLoaders:[], holdLoaderKey:'', callbacks,
      versions(projectId) { return [
        {id:'fabric-version',project_id:projectId,name:'Версия Fabric',version_number:'f1',game_versions:['1.21.1'],loaders:['fabric'],date_published:'2026-01-01'},
        {id:'forge-version',project_id:projectId,name:'Версия Forge',version_number:'g1',game_versions:['1.20.1'],loaders:['forge'],date_published:'2025-01-01'},
        {id:'no-metadata',project_id:projectId,name:'Без меток',version_number:'x',game_versions:['Client'],loaders:[],date_published:'2024-01-01'}
      ]; },
      search(command,args) {
        const cf = command === 'search_curseforge';
        const base = args.projectType === 'modpack' ? (cf ? 'cf-pack' : 'mr-pack') : (cf ? 'cf-mod' : 'mr-mod');
        const all = Array.from({length:30}, (_,i) => ({
          project_id:i ? `${base}-${i}` : base, slug:base, title:`${base} ${args.query || ''} ${i}`,
          description:i%3===0 ? '' : i%3===1 ? 'Короткое описание.' : 'Очень длинное описание проекта с большим количеством текста, которое должно быть аккуратно ограничено и не раздвигать карточки. '.repeat(3), project_type:args.projectType, categories:i%2 ? ['optimization','very-long-category-name','fabric'] : [], downloads:100, icon_url:null
        }));
        const offset = Number(args.offset)||0, limit = Number(args.limit)||24;
        return {hits:all.slice(offset,offset+limit),offset,limit,total_hits:all.length};
      },
      releaseSearch(query) {
        for (const entry of this.held.filter(item => item.query === query)) entry.resolve(entry.result);
        this.held = this.held.filter(item => item.query !== query);
      },
      releaseLoader(key) {
        for (const entry of this.heldLoaders.filter(item => item.key === key)) entry.resolve(entry.result);
        this.heldLoaders = this.heldLoaders.filter(item => item.key !== key);
      },
      async invoke(command, args = {}) {
        this.calls.push({command,args:JSON.parse(JSON.stringify(args))});
        switch (command) {
          case 'get_settings': return {theme:'dark',click_fx:'off',ambient:'off',trail:false,onboarded:true,discord_rpc:false,update_enabled:false,feed_grid:2,mods_grid:1,mods_view:'grid',feed_source:'modrinth',ui_scale:opts.scale || 100};
          case 'save_settings': return null;
          case 'accounts_info': return {accounts:[{uuid:'u',username:'Steve',kind:'offline'}],active:'u'};
          case 'list_instances': return instances.map(item => ({...item}));
          case 'running_instances': return [];
          case 'system_memory': return {total_mb:16384};
          case 'version_info': return {version:'test',enabled:false};
          case 'list_java': return [];
          case 'minecraft_versions': return [
            {id:'1.21.1',type:'release'},{id:'1.20.1',type:'release'}, {id:'1.19.4',type:'release'}
          ];
          case 'loader_versions': {
            const key = `${args.kind}:${args.mcVersion}`;
            const result = [{version:`${args.kind}-${args.mcVersion}-stable`,stable:true},{version:'old',stable:false}];
            if (this.holdLoaderKey === key) return new Promise(resolve => this.heldLoaders.push({key,result,resolve}));
            return result;
          }
          case 'search_modrinth': case 'search_curseforge': {
            const result = this.search(command,args);
            const key = `${command}:${args.projectType}:${args.query}`;
            if (this.holdQueries.has(key)) return new Promise(resolve => this.held.push({query:args.query,result,resolve}));
            return result;
          }
          case 'modrinth_versions': case 'curseforge_versions': {
            if (this.failVersions) throw 'нет связи для проверки';
            let result = this.versions(args.projectId);
            if (args.mcVersion) result = result.filter(v => v.game_versions.includes(args.mcVersion));
            if (args.loader) result = result.filter(v => v.loaders.includes(args.loader));
            return result;
          }
          case 'curseforge_compatibility_versions':
            if (this.failCompatibility) throw 'нет данных CurseForge';
            return this.versions(args.projectId);
          case 'modrinth_project': case 'curseforge_project': {
            const pack = String(args.projectId).includes('pack');
            return {id:args.projectId,slug:args.projectId,title:`Проект ${args.projectId}`,project_type:pack?'modpack':'mod',description:'Сведения',body:'Описание сборки',categories:['adventure'],gallery:Array.from({length:8},(_,i)=>image(i+1)),downloads:123};
          }
          case 'install_mod_version': case 'install_mod': case 'install_curseforge': return this.installOutcome || {installed:['mod.jar'],skipped:[]};
          case 'install_curseforge_modpack': {
            const created = {id:'cf-created',name:'Готовая сборка CF',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16'},created:now};
            instances = [created,...instances]; return created;
          }
          case 'create_instance_for_mod': {
            const created = {id:`created-${instances.length}`,name:args.req.name,mc_version:args.req.mc_version,loader:args.req.loader,created:now};
            instances = [created,...instances];
            return {instance:created,outcome:{installed:['mod.jar'],skipped:[]},install_error:null,profile_warning:null};
          }
          case 'catalog_installed_mods': return [];
          case 'instance_path': return `/test/${args.instanceId}`;
          case 'open_url': case 'open_path': return null;
          default: return null;
        }
      }
    };
    window.__TAURI__ = {core:{invoke:(command,args) => mock.invoke(command,args)},event:{listen:async (name,callback) => {callbacks[name]=callback; return ()=>delete callbacks[name];}}};
  }, options);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('#dv-results .card');
  return {page,errors};
}


async function settled(page, selector) {
  await page.waitForSelector(`${selector} .card`);
  await page.waitForTimeout(120);
}
async function setLevel(page, selector, level) {
  await page.locator(selector).evaluate((input,level) => { input.value=level; input.dispatchEvent(new Event('input',{bubbles:true})); },String(level));
  await page.waitForTimeout(100);
}
async function geometry(page, selector, label, scale) {
  const data = await page.locator(selector).evaluate(root => {
    const rr=root.getBoundingClientRect(); const cards=[...root.querySelectorAll('.card')].slice(0,24);
    return {
      root:{left:rr.left,right:rr.right,width:rr.width,scroll:root.scrollWidth,client:root.clientWidth},
      cols:getComputedStyle(root).gridTemplateColumns.split(' ').length,
      gap:parseFloat(getComputedStyle(root).columnGap),
      cards:cards.map(card=>{
        const r=card.getBoundingClientRect(); const ir=card.querySelector('.card-icon').getBoundingClientRect();
        const actions=[...card.querySelectorAll('.card-actions button')].filter(b=>getComputedStyle(b).display!=='none').map(b=>{let x=b.getBoundingClientRect();return {l:x.left,r:x.right,t:x.top,b:x.bottom};});
        return {l:r.left,r:r.right,t:r.top,b:r.bottom,w:r.width,h:r.height, icon:{l:ir.left,r:ir.right,t:ir.top,b:ir.bottom},actions};
      })
    };
  });
  assert(data.cards.length>=12,`${label}: insufficient cards`);
  const first=data.cards[0];
  assert(data.root.scroll <= data.root.client + 1,`${label}: horizontal overflow: ${JSON.stringify(data.root)}`);
  for (const c of data.cards) {
    assert(Math.abs(c.w-first.w)<1,`${label}: widths differ: ${JSON.stringify(data.cards.slice(0,12))}`);
    assert(Math.abs(c.h-first.h)<1.2,`${label}: heights differ: ${JSON.stringify(data.cards.slice(0,12))}`);
    assert(c.w >= Math.min(120*scale,data.root.width)-3,`${label}: card too narrow: ${c.w}; ${JSON.stringify(data.root)}`);
    assert(c.icon.l>=c.l-1 && c.icon.r<=c.r+1 && c.icon.t>=c.t-1 && c.icon.b<=c.b+1,`${label}: icon escaped card`);
    assert(c.actions.length>=2,`${label}: missing install/versions buttons`);
    for(const b of c.actions) assert(b.l>=c.l-1 && b.r<=c.r+1 && b.t>=c.t-1 && b.b<=c.b+1,`${label}: action escaped card ${JSON.stringify({c,b})}`);
  }
  for(let i=1;i<data.cards.length;i++) {
    const c=data.cards[i], prev=data.cards[i-1];
    if(c.t===prev.t) assert(c.l>=prev.r-1,`${label}: horizontal overlap`);
    else assert(c.t>=prev.b-1,`${label}: vertical overlap`);
  }
  return data;
}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try {
    for(const scale of [100,150,70]) {
      const {page,errors}=await newPage(browser,{scale});
      await page.locator('[data-dv-type="mod"]').click();
      await settled(page,'#dv-results');
      for(const width of [1080,1280,1600,1920]) {
        await page.setViewportSize({width,height:850});
        for(const level of [1,2,3]) {
          await setLevel(page,'#feed-size',level);
          await geometry(page,'#dv-results',`home ${width}/${scale}%/level${level}`,scale/100);
        }
      }
      // Исходный выбор фильтра и поиск остаются неизменны при скрытии панели.
      await page.setViewportSize({width:1280,height:850});
      await page.locator('#dv-loader').click(); await page.locator('[data-dv-loader="fabric"]').click();
      await page.locator('#dv-query').fill('stable-query'); await page.waitForTimeout(450);
      let before=await page.locator('#dv-results').boundingBox();
      const toggle=page.locator('#home-filters-toggle');
      assert.equal(await toggle.getAttribute('aria-expanded'),'true');
      await toggle.focus(); await page.keyboard.press('Enter');
      assert.equal(await toggle.getAttribute('aria-expanded'),'false');
      assert(await page.locator('#home-catalog-filters').isHidden());
      assert.equal(await page.locator('#dv-query').inputValue(),'stable-query');
      assert.equal(await page.evaluate(()=>window.omnispecDebug.state.discover.loader),'fabric');
      assert(await toggle.evaluate(el=>el===document.activeElement));
      let after=await page.locator('#dv-results').boundingBox();
      assert(after.width>before.width+40,`collapse should release space: ${JSON.stringify({before,after})}`);
      await geometry(page,'#dv-results',`collapsed ${scale}%`,scale/100);
      await page.locator('[data-dv-source="curseforge"]').click(); await settled(page,'#dv-results');
      assert.equal(await page.locator('#home-filters-toggle').getAttribute('aria-expanded'),'false');
      assert.equal(await page.evaluate(()=>window.omnispecDebug.state.discover.loader),'fabric');
      await page.locator('#home-filters-toggle').click();
      assert.equal(await page.locator('#dv-loader-label').innerText(),'Fabric');
      await page.locator('#dv-loader').click();
      const rects=await page.evaluate(()=>{
        const m=document.querySelector('#dv-loader-options').getBoundingClientRect(),o=document.querySelector('[data-dv-loader="neoforge"]').getBoundingClientRect();
        const hit=document.elementFromPoint(o.left+o.width/2,o.top+o.height/2);
        return {menu:{l:m.left,r:m.right,t:m.top,b:m.bottom},option:{l:o.left,r:o.right,t:o.top,b:o.bottom},hit:hit?.closest('[data-dv-loader]')?.dataset.dvLoader};
      });
      assert.equal(rects.hit,'neoforge',`loader popup must not be clipped by sidebar ${JSON.stringify(rects)}`);
      await page.keyboard.press('Escape');
      await geometry(page,'#dv-results',`curseforge ${scale}%`,scale/100);
      // В каталоге выбранной сборки те же гарантии, включая изменение ширины окна.
      await page.locator('[data-home-id="fabric-new"]').click();
      await page.locator('[data-tab="download"]').click();
      await settled(page,'#mr-results');
      for(const width of [1080,1280,1920]) {
        await page.setViewportSize({width,height:850});
        for(const level of [1,2,3]) {
          await setLevel(page,'#dl-size',level);
          await geometry(page,'#mr-results',`instance modrinth ${width}/${scale}%/level${level}`,scale/100);
        }
      }
      await page.locator('[data-dl-source="curseforge"]').click(); await settled(page,'#cf-results');
      for(const level of [1,2,3]) { await setLevel(page,'#dl-size',level); await geometry(page,'#cf-results',`instance curseforge ${scale}%/level${level}`,scale/100); }
      assert.deepEqual(errors,[]);
      console.log(`CATALOG_LAYOUT_AND_COLLAPSIBLE_FILTER scale=${scale}% OK`);
      await page.close();
    }
  } finally {await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
