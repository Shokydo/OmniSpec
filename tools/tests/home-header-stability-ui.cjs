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
    const mime = ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':mime}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function setup(page, scale) {
  await page.addInitScript(scale => {
    const now=Math.floor(Date.now()/1000);
    const instances=Array.from({length:12},(_,i)=>({
      id:`build-${i}`,name:i===0?'Очень длинное название сборки которое не должно пересекаться с таймером':'Fabulously Optimized',
      mc_version:'1.21.11',loader:{type:'fabric',version:'0.19.3'},playtime_secs:i===0?18500000:19100,created:now-i,icon:null
    }));
    const mock=window.__headerTest={calls:[], async invoke(command,args={}) {
      this.calls.push({command,args});
      switch(command) {
        case 'get_settings': return {theme:'dark',click_fx:'off',ambient:'off',trail:false,onboarded:true,discord_rpc:false,update_enabled:false,ui_scale:scale,feed_grid:2,feed_source:'modrinth'};
        case 'accounts_info': return {accounts:[{uuid:'u',username:'Alex',kind:'offline'}],active:'u'};
        case 'list_instances': return instances;
        case 'running_instances': return ['build-0'];
        case 'system_memory': return {total_mb:16384};
        case 'version_info': return {version:'test',enabled:false};
        case 'list_java': return [];
        case 'search_modrinth': case 'search_curseforge': {
          await new Promise(resolve=>setTimeout(resolve,200));
          // Empty mods deliberately shrink the result list after the switch.
          const count=args.projectType==='mod'?0:48;
          const hits=Array.from({length:Math.min(24,count)},(_,i)=>({project_id:`${command}-${i}`,slug:`s-${i}`,title:`Project ${i}`,description:'Описание',categories:[],downloads:100}));
          return {hits,total_hits:count};
        }
        default: return null;
      }
    }};
    window.__TAURI__={core:{invoke:(command,args)=>mock.invoke(command,args)},event:{listen:async()=>()=>{}}};
  },scale);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForSelector('#dv-results .card');
}
async function metrics(page) {
  return page.evaluate(()=>{
    const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const head=document.querySelector('.home-feed-head');
    const card=document.querySelector('[data-home-id="build-0"]');
    const scroll=document.querySelector('#home-scroll');
    const metadata=card.querySelector('.home-card-sub');
    const s=getComputedStyle(metadata);
    return {head:rect(head),search:rect(document.querySelector('.home-search')),source:rect(document.querySelector('.catalog-sources')),
      tools:rect(document.querySelector('.home-tools')),card:rect(card),name:rect(card.querySelector('.home-card-name')),
      time:rect(card.querySelector('.home-card-time')),metadata:rect(metadata),metadataStyle:{whiteSpace:s.whiteSpace,lineHeight:s.lineHeight},
      maxWidth:getComputedStyle(document.querySelector('.home-search')).maxWidth,
      scrollWidth:scroll.scrollWidth,clientWidth:scroll.clientWidth,scrollTop:scroll.scrollTop,
      same:head===window.__savedHead,focus:document.activeElement?.dataset.dvType||''};
  });
}
async function setHeaderNearTop(page) {
  await page.evaluate(()=>{
    const scroll=document.querySelector('#home-scroll'),head=document.querySelector('.home-feed-head');
    const zoom=parseFloat(getComputedStyle(document.body).zoom)||1;
    const delta=head.getBoundingClientRect().top-scroll.getBoundingClientRect().top-35*zoom;
    scroll.scrollTop += Math.max(0,delta/zoom);
    window.__savedHead=head;
  });
}
async function clickAndCheck(page, selector, label) {
  const before=await metrics(page);
  await page.locator(selector).click();
  const immediate=await metrics(page);
  await page.waitForTimeout(350);
  const after=await metrics(page);
  for (const actual of [immediate,after]) {
    assert(actual.same,`${label}: header was replaced`);
    assert(Math.abs(actual.head.top-before.head.top)<=1.5,`${label}: header jumped vertically ${JSON.stringify({before,actual})}`);
    assert(Math.abs(actual.head.left-before.head.left)<=1.5,`${label}: header moved horizontally`);
    assert(Math.abs(actual.search.left-before.search.left)<=1.5 && Math.abs(actual.search.width-before.search.width)<=1.5,
      `${label}: search jumped ${JSON.stringify({before,actual})}`);
  }
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try {
    for (const scale of [70,100,150]) {
      const page=await browser.newPage({viewport:{width:1280,height:850}});
      const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
      await setup(page,scale);
      for (const width of [1080,1280,1600,1920]) {
        await page.setViewportSize({width,height:850});
        await page.waitForTimeout(100);
        const m=await metrics(page);
        assert.equal(m.maxWidth,'none',`search should not have an artificial cap ${width}/${scale}`);
        assert(m.name.right<=m.time.left+1,`name overlaps timer ${width}/${scale}: ${JSON.stringify(m)}`);
        assert(Math.abs(m.name.top-m.time.top)<3*scale/100,`timer must be next to title ${width}/${scale}: ${JSON.stringify(m)}`);
        assert(m.metadata.top>=m.name.bottom-1,`version is not beneath name ${width}/${scale}`);
        assert.equal(m.metadataStyle.whiteSpace,'nowrap',`version/loader should stay on one line ${width}/${scale}`);
        assert(m.metadata.height<=parseFloat(m.metadataStyle.lineHeight)*scale/100+2 || m.metadataStyle.lineHeight==='normal',`metadata wrapped ${width}/${scale}: ${JSON.stringify(m)}`);
        assert(m.scrollWidth<=m.clientWidth+1,`home has horizontal overflow ${width}/${scale}: ${JSON.stringify(m)}`);
        if (width===1920 && scale===100) {
          assert(m.search.width>520,`wide search still capped at 520px: ${JSON.stringify(m)}`);
          assert(Math.abs(m.source.left-m.search.right)<20,`search does not fill space before sources: ${JSON.stringify(m)}`);
        }
      }
      // Position the row inside the scroll viewport and switch both ways,
      // including a temporary loading state and an empty result page.
      await page.setViewportSize({width:1280,height:850});
      await setHeaderNearTop(page);
      await clickAndCheck(page,'[data-dv-type="mod"]',`mod ${scale}%`);
      assert.equal(await page.locator('[data-dv-type="mod"]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.locator('#dv-query').getAttribute('placeholder'),'Найти мод');
      await clickAndCheck(page,'[data-dv-type="modpack"]',`modpack ${scale}%`);
      assert.equal(await page.locator('[data-dv-type="modpack"]').getAttribute('aria-pressed'),'true');
      await clickAndCheck(page,'[data-dv-source="curseforge"]',`source ${scale}%`);
      await clickAndCheck(page,'[data-dv-view="list"]',`view ${scale}%`);
      await page.locator('[data-dv-type="mod"]').focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator('[data-dv-type="mod"]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.evaluate(()=>document.activeElement?.dataset.dvType),'mod');
      assert.deepEqual(errors,[]);
      console.log(`HOME_HEADER_AND_RECENT scale=${scale}%: stable controls, full search, single-line metadata and non-overlapping timer — OK`);
      await page.close();
    }
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
