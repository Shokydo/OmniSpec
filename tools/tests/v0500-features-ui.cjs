// Browser regression for 0.50.0: real layout/events, mocked Tauri persistence and audio output.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { checkSettingsLayout } = require('./settings-layout-assert.cjs');
const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const server = http.createServer((req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)) return res.writeHead(403).end();
  try { const mime=({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg'})[path.extname(file)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':mime}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function setup(page,options={}) {
  await page.addInitScript(opts=>{
    const clone=x=>JSON.parse(JSON.stringify(x));
    const defaults={theme:'dark',click_fx:'off',ambient:'off',trail:false,trail_style:'sparks',
      trail_size:50,trail_length:20,trail_opacity:15,discord_rpc:false,update_enabled:false,
      ui_scale:opts.scale||100,language:opts.language||'ru',sound_fx:true,sound_volume:60,sound_style:'soft',sound_custom:{},
      wallpaper:null,custom_wallpaper:null,wallpaper_fit:'cover',wallpaper_blur:0,wallpaper_dim:40,wallpaper_recent:[],
      onboarded:!opts.fresh,onboarding_pending:Boolean(opts.fresh)};
    if(opts.legacy || opts.legacyEmpty) { delete defaults.onboarded; delete defaults.onboarding_pending; }
    const now=Math.floor(Date.now()/1000);
    const instances=(opts.fresh || opts.legacyEmpty) ? [] : Array.from({length:8},(_,i)=>({id:`build-${i}`,name:`Build ${i}`,mc_version:'1.21.1',loader:{type:'fabric',version:'0.16'},created:now-i,icon:null}));
    const gif='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const mock=window.__v0500={settings:JSON.parse(localStorage.getItem('v0500-settings')||JSON.stringify(defaults)),calls:[],sounds:[],picks:[],serial:0,failLanguage:false,failSound:false,
      save(){localStorage.setItem('v0500-settings',JSON.stringify(this.settings));},
      async invoke(command,args={}) {
        this.calls.push({command,args:clone(args)});
        switch(command) {
          case 'get_settings': return clone(this.settings);
          case 'set_language': if(this.failLanguage) throw 'disk full'; this.settings.language=args.language; this.save(); return null;
          case 'save_settings': {
            const incoming=clone(args.settings),current=this.settings;
            incoming.language=current.language;
            if(incoming.custom_wallpaper!==current.custom_wallpaper) { incoming.wallpaper=current.wallpaper; incoming.wallpaper_recent=clone(current.wallpaper_recent||[]); }
            incoming.custom_wallpaper=current.custom_wallpaper;
            const sounds=incoming.sound_custom||{};
            for(const [name,old] of Object.entries(current.sound_custom||{})) {
              sounds[name] ||= clone(old);
              sounds[name].file=old.file; sounds[name].path=old.path;
            }
            for(const name of Object.keys(sounds)) if(!current.sound_custom?.[name]) {sounds[name].file=null;sounds[name].path='';}
            incoming.sound_custom=sounds; this.settings=incoming; this.save(); return null;
          }
          case 'set_custom_sound': {
            if(this.failSound || args.path.includes('invalid')) throw 'invalid sound';
            const previous=this.settings.sound_custom?.[args.event]||{volume:100};
            const sound={...previous,path:args.path,file:args.path?`${args.event}-${++this.serial}.wav`:null};
            this.settings.sound_custom={...(this.settings.sound_custom||{}),[args.event]:sound}; this.save(); return clone(this.settings);
          }
          case 'custom_sound_data': return this.settings.sound_custom?.[args.event]?.file ? 'data:audio/wav;base64,'+btoa(args.event) : null;
          case 'pick_file': return this.picks.shift()||null;
          case 'set_custom_wallpaper': {
            const name=args.path.split(/[\\/]/).pop().replace(/\.(\w+)$/,`-${++this.serial}.$1`);
            const recent=(this.settings.wallpaper_recent||[]).filter(x=>x!==`custom:${name}`);
            this.settings={...this.settings,custom_wallpaper:name,wallpaper:'custom',wallpaper_recent:[`custom:${name}`,...recent]}; this.save(); return clone(this.settings);
          }
          case 'download_custom_wallpaper': {
            const name=`download-${++this.serial}.gif`;
            this.settings={...this.settings,custom_wallpaper:name,wallpaper:'custom',wallpaper_recent:[`custom:${name}`,...(this.settings.wallpaper_recent||[])]}; this.save(); return clone(this.settings);
          }
          case 'select_wallpaper_history': {
            const id=`custom:${args.name}`;
            if(!this.settings.wallpaper_recent.includes(id)) throw 'not in history';
            this.settings={...this.settings,custom_wallpaper:args.name,wallpaper:'custom',wallpaper_recent:[id,...this.settings.wallpaper_recent.filter(x=>x!==id)]}; this.save(); return clone(this.settings);
          }
          case 'wallpaper_history_preview': return {path:`/wall/${args.name}`,src:gif,kind:'gif'};
          case 'wallpaper_source': return this.settings.custom_wallpaper ? {path:`/wall/${this.settings.custom_wallpaper}`,src:gif,kind:'gif'} : null;
          case 'accounts_info': return (opts.fresh || opts.legacyEmpty) ? {accounts:[],active:null} : {accounts:[{uuid:'u',username:'Alex',kind:'offline'}],active:'u'};
          case 'account_skin': case 'account_capes': return {licensed:false,capes:[]};
          case 'system_memory': return {total_mb:16384};
          case 'list_instances': return instances;
          case 'running_instances': case 'list_java': return [];
          case 'search_modrinth': case 'search_curseforge': {
            const hits=Array.from({length:24},(_,i)=>({project_id:`p${i}`,slug:`p${i}`,title:`Project ${i}`,description:'Example',downloads:1}));
            return {hits,total_hits:48};
          }
          case 'version_info': return {version:'test',enabled:false};
          case 'app_info': return {home:'/data',version:'test',platform:'linux',demo:false};
          default: return null;
        }
      }
    };
    window.AudioContext=class {
      constructor(){this.state='running';this.currentTime=0;this.destination={};}
      resume(){return Promise.resolve();}
      createGain(){const node={gain:{value:1,setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){return this;}};return node;}
      createOscillator(){return {frequency:{setValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){return {connect(){}};},start(){},stop(){}};}
      createBufferSource(){return {buffer:null,gainNode:null,connect(node){this.gainNode=node;return node;},start(){mock.sounds.push({event:this.buffer.event,gain:this.gainNode.gain.value});}};}
      decodeAudioData(bytes){return Promise.resolve({event:new TextDecoder().decode(bytes)});}
    };
    window.__TAURI__={core:{invoke:(command,args)=>mock.invoke(command,args),convertFileSrc:p=>p},event:{listen:async()=>()=>{}}};
  },options);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>window.omnispecDebug?.state?.settings);
}
async function openPrefs(page,category){
  if(await page.locator('#modal-prefs').isHidden()) await page.locator('#btn-quick-settings').click();
  await page.locator(`[data-pref="${category}"]`).click();
}
async function clearSounds(page){await page.waitForTimeout(120); await page.evaluate(()=>window.__v0500.sounds=[]);}
async function sounds(page){await page.waitForTimeout(120);return page.evaluate(()=>window.__v0500.sounds);}
async function setRange(page,selector,value){
  await page.locator(selector).evaluate((input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));},String(value));
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  try {
    // A genuinely empty first run has the language step, persists it, and never reopens after completion.
    {
      const page=await browser.newPage({viewport:{width:1280,height:850}}), errors=[]; page.on('pageerror',e=>errors.push(String(e)));
      await setup(page,{fresh:true});
      await page.waitForSelector('#modal-onboard:not([hidden])');
      assert.equal(await page.locator('[data-onboard-language]').count(),5);
      assert.equal(await page.locator('#onboard-count').innerText(),'1 / 8');
      await page.evaluate(()=>window.__v0500.failLanguage=true);
      await page.locator('[data-onboard-language="en"]').click();
      await page.waitForFunction(()=>!document.querySelector('#onboard-next').disabled);
      assert.equal(await page.evaluate(()=>window.__v0500.settings.language),'ru','failed language change rolls back');
      await page.evaluate(()=>window.__v0500.failLanguage=false);
      await page.locator('[data-onboard-language="en"]').click();
      await page.waitForFunction(()=>window.__v0500.settings.language==='en' && document.documentElement.lang==='en');
      await page.waitForFunction(()=>document.querySelector('#onboard-body').textContent.includes('Choose a language'));
      await page.locator('#onboard-next').click();
      assert.equal(await page.locator('#onboard-count').innerText(),'2 / 8');
      assert.equal(await page.locator('[data-onboard-layout]').count(),3);
      await page.waitForFunction(() => [...document.querySelectorAll('[data-onboard-layout] img')].every(img => img.complete && img.naturalWidth > 0));
      await page.locator('[data-onboard-layout="prism"]').click();
      await page.waitForFunction(() => window.__v0500.settings.ui_layout?.preset === 'prism' && !document.querySelector('#onboard-next').disabled);
      assert.equal(await page.locator('[data-onboard-layout="prism"]').getAttribute('aria-pressed'),'true');
      await page.reload();
      await page.waitForSelector('#modal-onboard:not([hidden])');
      assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
      assert.equal(await page.locator('[data-onboard-language="en"]').getAttribute('aria-pressed'),'true');
      await page.locator('#onboard-next').click();
      assert.equal(await page.locator('[data-onboard-layout="prism"]').getAttribute('aria-pressed'),'true', 'layout survives restart during first run');
      await page.locator('[data-onboard-layout="modrinth"]').click();
      await page.waitForFunction(() => window.__v0500.settings.ui_layout?.preset === 'modrinth' && !document.querySelector('#onboard-next').disabled);
      await page.locator('#onboard-prev').click();
      for(let i=0;i<8;i++) await page.locator('#onboard-next').click();
      await page.waitForFunction(()=>window.__v0500.settings.onboarded===true);
      await page.reload(); await page.waitForFunction(()=>window.omnispecDebug?.state?.settings?.onboarded===true);
      assert(await page.locator('#modal-onboard').isHidden());
      assert.deepEqual(errors,[]);
      await page.close();
      console.log('V0500_ONBOARD: first install, five languages, error rollback, resume and no repeat — OK');
    }
    // Older installs without the marker but with existing data must not see onboarding.
    for (const options of [{legacy:true},{legacyEmpty:true}]) {
      const page=await browser.newPage({viewport:{width:1280,height:850}});
      await setup(page,options);
      await page.waitForFunction(()=>window.__v0500.settings.onboarded===true);
      assert(await page.locator('#modal-onboard').isHidden());
      await page.close();
    }
    console.log('V0500_UPGRADE: existing and empty legacy profiles skip onboarding — OK');

    // Exercise the actual supported minimum window and all UI zooms/languages.
    // Click each choice with a real pointer rather than DOM click(), so an
    // offscreen or covered button cannot pass just by existing in the DOM.
    for(const c of [
      {width:1080,height:640,scale:100,language:'ru'},
      {width:1080,height:640,scale:150,language:'kk',dpr:1.25},
      {width:1080,height:640,scale:125,language:'uk',dpr:2},
      {width:1400,height:880,scale:80,language:'be'},
      {width:1400,height:880,scale:90,language:'ru'},
      {width:1400,height:880,scale:110,language:'en'},
      {width:1920,height:1080,scale:100,language:'ru'}
    ]){
      const label=`${c.width}x${c.height} ${c.scale}% ${c.language} dpr=${c.dpr||1}`;
      const page=await browser.newPage({viewport:{width:c.width,height:c.height},deviceScaleFactor:c.dpr||1}),errors=[];
      page.on('pageerror',e=>errors.push(String(e)));
      await setup(page,{scale:c.scale,language:c.language});
      await page.waitForFunction(c=>document.documentElement.dataset.uiScale===String(c.scale) && document.documentElement.lang===c.language,c);
      await openPrefs(page,'sound'); await page.waitForTimeout(300);
      await checkSettingsLayout(page,label);
      if(c.width===1920){
        await page.setViewportSize({width:1080,height:640}); await page.waitForTimeout(300);
        await checkSettingsLayout(page,`${label} resized down`);
        await page.setViewportSize({width:c.width,height:c.height}); await page.waitForTimeout(300);
        await checkSettingsLayout(page,`${label} resized back`);
      }
      const styles=await page.locator('#sound-style-chips [data-sound-style]').evaluateAll(nodes=>nodes.map(n=>n.dataset.soundStyle));
      for(const style of styles){
        const button=page.locator(`[data-sound-style="${style}"]`);
        await button.scrollIntoViewIfNeeded();
        const hit=await button.evaluate(el=>{const r=el.getBoundingClientRect(),target=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);return target===el || el.contains(target);});
        assert(hit,`${label}: ${style} is not reachable by pointer`);
        await button.click();
        await page.waitForFunction(style=>window.__v0500.settings.sound_style===style,style);
        assert(await button.evaluate(el=>el.classList.contains('is-active')),`${label}: ${style} was not selected`);
      }
      assert.equal(styles.at(-1),'custom');
      if(c.scale===150){
        await page.locator('[data-sound-style="bubble"]').focus(); await page.keyboard.press('Enter');
        await page.waitForFunction(()=>window.__v0500.settings.sound_style==='bubble');
        await page.locator('[data-sound-style="custom"]').focus(); await page.keyboard.press('Space');
        await page.waitForFunction(()=>window.__v0500.settings.sound_style==='custom');
      }
      await checkSettingsLayout(page,`${label} custom`);
      // The long custom-sounds form must still scroll vertically, and its last
      // event and test button must remain reachable after restoring the choice.
      await page.reload(); await page.waitForFunction(()=>window.omnispecDebug?.state?.sound?.style==='custom');
      await openPrefs(page,'sound'); await page.waitForTimeout(300);
      await checkSettingsLayout(page,`${label} reloaded`);
      await page.locator('[data-sound-volume="error"]').scrollIntoViewIfNeeded();
      assert(await page.locator('#prefs-body').evaluate(el=>el.scrollTop)>0,`${label}: custom sounds must scroll vertically`);
      assert(await page.locator('[data-sound-volume="error"]').isVisible());
      await page.locator('#sound-test').click();
      const prefs=c.width===1080 && c.scale===100 && c.language==='ru'
        ? await page.locator('#prefs-nav [data-pref]').evaluateAll(nodes=>nodes.map(n=>n.dataset.pref))
        : ['discord','sound'];
      for(const pref of prefs){
        await page.locator(`[data-pref="${pref}"]`).click();
        if(pref==='interface'){
          await page.locator('#prefs-body [data-open-customizer]').click();
          await page.waitForSelector('#modal-customizer:not([hidden]) [data-editor-root]');
          assert.equal(await page.locator('#modal-prefs:not([hidden]) [data-editor-root]').count(),0,`${label}: customizer must not render inside the narrow preferences pane`);
          await page.locator('#modal-customizer [data-custom-close]').last().click();
          await page.locator('#btn-quick-settings').click();
          await page.waitForSelector('#modal-prefs:not([hidden])');
        }
        assert.equal(await page.locator('#prefs-body').getAttribute('data-pref-category'),pref);
        const nav=await page.locator('#prefs-nav').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));
        assert.equal(nav.scroll,nav.client,`${label}: nav overflows after choosing ${pref}: ${JSON.stringify(nav)}`);
      }
      if(c.width===1080 && c.scale===100 && c.language==='ru'){
        // Simulate a constrained nav without hiding vertical overflow.
        await page.locator('#prefs-nav').evaluate(el=>{el.style.maxHeight='80px';});
        const before=await page.locator('#prefs-nav').evaluate(el=>({client:el.clientHeight,scroll:el.scrollHeight}));
        assert(before.scroll>before.client,`${label}: constrained nav needs vertical scrolling`);
        await page.locator('[data-pref="discord"]').scrollIntoViewIfNeeded();
        await page.locator('[data-pref="discord"]').click();
        const nav=await page.locator('#prefs-nav').evaluate(el=>({top:el.scrollTop,client:el.clientWidth,scroll:el.scrollWidth}));
        assert(nav.top>0 && nav.scroll===nav.client,`${label}: final nav item is reachable vertically without horizontal overflow ${JSON.stringify(nav)}`);
      }
      assert.deepEqual(errors,[],`${label}: unexpected JavaScript errors`);
      await page.close();
    }
    console.log('SETTINGS_LAYOUT: sound choices and labels accessible; no horizontal nav overflow at supported sizes, zooms and languages — OK');
    {
      const page=await browser.newPage({viewport:{width:1280,height:850}}),errors=[]; page.on('pageerror',e=>errors.push(String(e)));
      await setup(page);
      await page.waitForSelector('#dv-results .card');
      const positions=await page.evaluate(()=>{
        const r=s=>document.querySelector(s).getBoundingClientRect();
        return {filters:r('#home-filters-toggle').left,pack:r('[data-dv-type="modpack"]').left,mod:r('[data-dv-type="mod"]').left,search:r('#dv-query').left};
      });
      assert(positions.filters<positions.pack && positions.pack<positions.mod && positions.mod<positions.search,JSON.stringify(positions));
      assert.equal(await page.locator('#home-filters-toggle').getAttribute('aria-expanded'),'false');
      assert(await page.locator('#home-catalog-filters').isHidden());
      const wide=(await page.locator('#dv-results').boundingBox()).width;
      await page.locator('#home-filters-toggle').click();
      await page.waitForTimeout(250);
      assert(await page.locator('#home-catalog-filters').isVisible());
      const narrow=(await page.locator('#dv-results').boundingBox()).width;
      assert(wide>narrow+100,`opening filters must make results narrower: ${wide}/${narrow}`);
      await page.locator('#dv-loader').click(); await page.locator('[data-dv-loader="fabric"]').click();
      await page.locator('#home-filters-toggle').click();
      assert(await page.locator('#home-catalog-filters').isHidden());
      assert.equal(await page.evaluate(()=>window.omnispecDebug.state.discover.loader),'fabric');
      // The scroll container intentionally has 4px of top padding; compare
      // with its padded edge instead of allowing unexplained header movement.
      const stickyAt = async fraction => {
        await page.locator('#home-scroll').evaluate((el,f)=>{el.scrollTop=(el.scrollHeight-el.clientHeight)*f;},fraction);
        await page.waitForTimeout(80);
        return page.evaluate(()=>{
          const scroller=document.querySelector('#home-scroll'),head=document.querySelector('.home-feed-head');
          const rect=scroller.getBoundingClientRect(),zoom=Number(getComputedStyle(document.body).zoom)||1;
          return {head:head.getBoundingClientRect().top,edge:rect.top+(scroller.clientTop+parseFloat(getComputedStyle(scroller).paddingTop))*zoom,
                  search:document.querySelector('#dv-query').getBoundingClientRect().top,scroll:scroller.scrollTop};
        });
      };
      const middle=await stickyAt(.55),sticky=await stickyAt(1);
      assert(sticky.scroll>middle.scroll && Math.abs(sticky.head-sticky.edge)<1.5 &&
             Math.abs(middle.head-sticky.head)<1.5 && sticky.search>=sticky.edge,
             `whole header stays pinned at the padded edge: ${JSON.stringify({middle,sticky})}`);
      await page.locator('#home-scroll').evaluate(el=>{el.scrollTop=0;});
      const box=await page.locator('#home-scroll').boundingBox();
      await page.mouse.move(box.x+box.width-50,box.y+box.height-40);
      await page.mouse.wheel(0,450); await page.waitForTimeout(50);
      const mid=await page.locator('#home-scroll').evaluate(el=>el.scrollTop);
      await page.waitForTimeout(500); const end=await page.locator('#home-scroll').evaluate(el=>el.scrollTop);
      assert(mid>0 && mid<end && end>350,`wheel down should animate: ${mid}/${end}`);
      await page.mouse.wheel(0,-350); await page.waitForTimeout(50); const midUp=await page.locator('#home-scroll').evaluate(el=>el.scrollTop);
      await page.waitForTimeout(500); const endUp=await page.locator('#home-scroll').evaluate(el=>el.scrollTop);
      assert(midUp<end && midUp>endUp,`wheel up should animate: ${end}/${midUp}/${endUp}`);
      await page.locator('[data-dv-type="modpack"]').click();
      const oldX=await page.locator('.home-catalog-tabs').evaluate(el=>getComputedStyle(el,'::before').transform);
      await page.locator('[data-dv-type="mod"]').click(); await page.waitForTimeout(300);
      const newX=await page.locator('.home-catalog-tabs').evaluate(el=>getComputedStyle(el,'::before').transform);
      assert.notEqual(oldX,newX,'active indicator moves between adjacent catalog tabs');
      await page.emulateMedia({reducedMotion:'reduce'});
      const transition=await page.locator('.home-catalog-tabs').evaluate(el=>getComputedStyle(el,'::before').transitionDuration);
      assert.equal(transition,'0s');
      await page.emulateMedia({reducedMotion:'no-preference'});
      console.log('V0500_CATALOG: pinned row, collapsed filters, layout, scroll and animated selection — OK');

      await openPrefs(page,'sound');
      assert.equal(await page.locator('#set-sound-volume').getAttribute('max'),'200');
      assert(await page.locator('[data-sound-style]').count()>=10);
      await setRange(page,'#set-sound-volume',200);
      await page.waitForFunction(()=>window.__v0500.settings.sound_volume===200);
      await page.locator('[data-sound-style="custom"]').click();
      const events=['click','toggle','tab','open','close','success','error'];
      assert.equal(await page.locator('[data-sound-event]').count(),events.length);
      for(const event of events){
        const input=page.locator(`[data-sound-path="${event}"]`);
        await input.fill(`/my sounds/${event}.wav`); await input.press('Enter');
        await page.waitForFunction(name=>Boolean(window.__v0500.settings.sound_custom?.[name]?.file),event);
        await page.waitForSelector(`[data-sound-preview="${event}"]:not([disabled])`);
      }
      await setRange(page,'[data-sound-volume="click"]',150);
      await page.waitForFunction(()=>window.__v0500.settings.sound_custom.click.volume===150);
      await clearSounds(page);
      await page.locator('[data-sound-preview="click"]').click();
      let played=await sounds(page);
      assert.deepEqual(played,[{event:'click',gain:3}],'master 200% × event 150% is applied exactly once');
      await clearSounds(page); await page.locator('#sound-test').click();
      await page.waitForTimeout(events.length*280);
      played=await sounds(page);
      assert.deepEqual(played.map(x=>x.event),events,'every configured event is previewed');
      await clearSounds(page);
      const errPath=page.locator('[data-sound-path="click"]');
      await errPath.fill('/invalid/file.wav'); await errPath.press('Enter');
      await page.waitForFunction(()=>document.querySelector('#toasts').textContent.includes('invalid sound'));
      played=await sounds(page); assert(played.some(x=>x.event==='error'));
      assert.equal(await page.evaluate(()=>window.__v0500.settings.sound_custom.click.path),'/my sounds/click.wav');
      await clearSounds(page); await page.locator('[data-close-prefs]').click();
      played=await sounds(page); assert.deepEqual(played.map(x=>x.event),['close'],'closing a modal replaces a generic click');
      await clearSounds(page); await page.locator('#btn-quick-settings').click();
      played=await sounds(page); assert.deepEqual(played.map(x=>x.event),['open'],'opening a modal replaces a generic click');
      await clearSounds(page); await page.locator('[data-pref="fx"]').click();
      played=await sounds(page); assert.deepEqual(played.map(x=>x.event),['tab']);
      await clearSounds(page); await page.locator('#set-trail').click();
      played=await sounds(page); assert.deepEqual(played.map(x=>x.event),['toggle']);
      await page.reload(); await page.waitForFunction(()=>window.omnispecDebug?.state?.sound?.style==='custom');
      assert.equal(await page.evaluate(()=>window.omnispecDebug.state.sound.volume),200);
      await openPrefs(page,'sound');
      assert.equal(await page.locator('[data-sound-path="click"]').inputValue(),'/my sounds/click.wav');
      assert.equal(await page.locator('[data-sound-volume="click"]').inputValue(),'150');
      console.log('V0500_SOUNDS: imports, error rollback, individual gain, real event routing, no double click and persistence — OK');

      await openPrefs(page,'wall');
      await page.evaluate(()=>window.__v0500.picks.push('/images/first.gif'));
      await page.locator('#wall-pick').click();
      await page.waitForFunction(()=>window.__v0500.settings.custom_wallpaper?.startsWith('first-'));
      const first=await page.evaluate(()=>window.__v0500.settings.custom_wallpaper);
      await page.waitForSelector(`[data-wall-history-select="custom:${first}"]`);
      await page.evaluate(()=>window.__v0500.picks.push('/images/second.gif'));
      await page.locator('#wall-pick').click();
      await page.waitForFunction(()=>window.__v0500.settings.custom_wallpaper?.startsWith('second-'));
      const second=await page.evaluate(()=>window.__v0500.settings.custom_wallpaper);
      await page.waitForSelector(`[data-wall-history-select="custom:${second}"]`);
      assert.equal(await page.locator('[data-wall-history-preview]').count(),2);
      await page.locator('[data-wall="aurora"]').click();
      await page.waitForSelector('[data-wall-history-select="aurora"]');
      await page.locator(`[data-wall-history-select="custom:${first}"]`).click();
      await page.waitForFunction(first=>window.__v0500.settings.custom_wallpaper===first && window.__v0500.settings.wallpaper==='custom',first);
      await page.locator(`[data-wall-history-remove="custom:${first}"]`).click();
      await page.waitForFunction(first=>!window.__v0500.settings.wallpaper_recent.includes(`custom:${first}`),first);
      assert.equal(await page.evaluate(()=>window.__v0500.settings.wallpaper),'custom');
      assert.equal(await page.evaluate(()=>window.__v0500.settings.custom_wallpaper),first,'deleting active history entry keeps active file');
      assert.equal(await page.locator(`[data-wall-history-select="custom:${first}"]`).count(),0);
      await page.reload(); await openPrefs(page,'wall');
      assert.equal(await page.locator(`[data-wall-history-select="custom:${first}"]`).count(),0);
      assert.equal(await page.locator(`[data-wall-history-select="custom:${second}"]`).count(),1);
      assert.equal(await page.locator('[data-wall-history-select="aurora"]').count(),1);
      assert.equal(await page.evaluate(()=>window.omnispecDebug.state.settings.custom_wallpaper),first);
      assert.deepEqual(errors,[]);
      await page.close();
      console.log('V0500_WALLPAPER: multiple custom files and presets, select, remove, active background and restart — OK');
    }
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
