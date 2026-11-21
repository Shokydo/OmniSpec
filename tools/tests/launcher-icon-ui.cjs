// Настройки иконки: восемь вариантов, клавиатура, очередь, откат и рестарт.
// Native Windows/Discord IPC проверяются отдельными тестами, здесь только WebView.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try {
    const type = ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
      '.css':'text/css; charset=utf-8','.png':'image/png'})[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, {'Content-Type':type}).end(fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});

async function openPage(browser) {
  const page = await browser.newPage({viewport:{width:1280,height:800}});
  const errors=[];
  page.on('pageerror', error => errors.push(String(error)));
  await page.addInitScript(() => {
    const defaults={theme:'dark',click_fx:'off',ambient:'off',trail:false,trail_style:'sparks',
      trail_size:50,trail_length:20,trail_opacity:15,onboarded:true,discord_rpc:false,
      update_enabled:false,ui_scale:100,categories:[],username:'Alex'};
    const stored=localStorage.getItem('launcher-icon-settings');
    const mock=window.__launcherIconTest={
      settings: stored ? JSON.parse(stored) : defaults,
      iconCalls:[], calls:[], holdNextIcon:false, failNextIcon:false, pendingIcons:[],
      holdNextSave:false, pendingSaves:[],
      store() { localStorage.setItem('launcher-icon-settings',JSON.stringify(this.settings)); },
      releaseIcon() { const pending=this.pendingIcons.shift(); if(!pending) throw new Error('No held icon'); pending(); },
      releaseSave() { const pending=this.pendingSaves.shift(); if(!pending) throw new Error('No held save'); pending(); },
      async invoke(command,args={}) {
        this.calls.push({command,args});
        switch(command) {
          case 'get_settings': return {...this.settings};
          case 'save_settings': {
            if(this.holdNextSave) {
              this.holdNextSave=false;
              await new Promise(resolve=>this.pendingSaves.push(resolve));
            }
            // Как настоящий backend: старый общий снимок не владеет иконкой.
            const icon=this.settings.launcher_icon || 'default';
            this.settings={...args.settings,launcher_icon:icon}; this.store(); return null;
          }
          case 'set_launcher_icon': {
            this.iconCalls.push(args.icon);
            if(this.holdNextIcon) {
              this.holdNextIcon=false;
              await new Promise(resolve=>this.pendingIcons.push(resolve));
            }
            if(this.failNextIcon) { this.failNextIcon=false; throw new Error('тестовый сбой записи'); }
            if(!['default','ru','by','kz','ua','us','icon_star_boom','icon_star_eye'].includes(args.icon)) throw new Error('неизвестная иконка');
            this.settings={...this.settings,launcher_icon:args.icon}; this.store(); return null;
          }
          case 'system_memory': return {total_mb:16384};
          case 'accounts_info': return {accounts:[{uuid:'u',username:'Alex',kind:'offline'}],active:'u'};
          case 'list_instances': return [{id:'alpha',name:'Alpha',mc_version:'1.21.1',loader:{type:'vanilla'},created:1,playtime_secs:0,icon:null}];
          case 'running_instances': case 'running_sessions': return [];
          case 'search_modrinth': case 'search_curseforge': return {hits:[],total_hits:0};
          case 'app_info': return {home:'/test',version:'test',platform:'test',demo:false};
          case 'version_info': return {version:'test',enabled:false};
          default: return null;
        }
      }
    };
    window.__TAURI__={core:{invoke:(command,args)=>mock.invoke(command,args)},event:{listen:async()=>()=>{}}};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(()=>window.omnispecDebug?.state?.settings);
  return {page,errors};
}

async function prefs(page) {
  if(await page.locator('#modal-prefs').isHidden()) await page.locator('#btn-quick-settings').click();
  await page.locator('[data-pref="look"]').click();
  await page.waitForSelector('#launcher-icon-grid');
}
async function choose(page,id) {
  await page.locator(`#launcher-icon-grid label:has(input[value="${id}"])`).click();
}
async function saved(page,id) {
  await page.waitForFunction(id=>window.__launcherIconTest.settings.launcher_icon===id,id);
  await page.waitForFunction(id=>document.querySelector('.tb-logo img')?.dataset.launcherIcon===id,id);
}

(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  try {
    const {page,errors}=await openPage(browser);
    assert.equal(await page.locator('.tb-logo img').getAttribute('src'),'assets/logo.png');
    await prefs(page);
    const options=[['default','Оригинал'],['ru','Россия'],['by','Беларусь'],
      ['kz','Қазақстан'],['ua','Україна'],['us','USA'],
      ['icon_star_boom','Звездный взрыв'],['icon_star_eye','Звезда']];
    assert.equal(await page.getByRole('radiogroup',{name:'Иконка лаунчера'}).count(),1);
    assert.equal(await page.getByRole('radio').count(),8);
    assert.equal(await page.locator('.language-hint').innerText(),'Язык сохраняется автоматически и применяется сразу.');
    assert.equal(await page.locator('.language-hint').evaluate(el=>getComputedStyle(el).color),
      await page.locator('.launcher-icon-hint').evaluate(el=>getComputedStyle(el).color),'both helper texts use the same grey');
    assert.notEqual(await page.locator('.language-hint').evaluate(el=>getComputedStyle(el).color),
      await page.locator('#prefs-language').evaluate(el=>getComputedStyle(el).color),'helper text is not the bright control text');
    await page.locator('[data-theme-id="light"]').click();
    assert.equal(await page.locator('.language-hint').evaluate(el=>getComputedStyle(el).color),
      await page.locator('.launcher-icon-hint').evaluate(el=>getComputedStyle(el).color),'grey follows the light theme');
    assert.notEqual(await page.locator('.language-hint').evaluate(el=>getComputedStyle(el).color),
      await page.locator('#prefs-language').evaluate(el=>getComputedStyle(el).color));
    await page.locator('[data-theme-id="dark"]').click();
    assert(await page.getByRole('radio',{name:'Оригинал'}).isChecked());
    for(const [id,name] of options.slice(1)) {
      const image=page.locator(`#launcher-icon-grid label:has(input[value="${id}"]) img`);
      await image.waitFor();
      assert.equal(await image.evaluate(el=>el.complete && el.naturalWidth===295),true,name);
      await choose(page,id); await saved(page,id);
      assert(await page.getByRole('radio',{name}).isChecked());
      assert.equal(await page.locator('.tb-logo img').getAttribute('src'),`assets/launcher-icons/${id}.png`);
    }
    console.log('ALL_VARIANTS_OK', options.map(x=>x[0]).join(','));

    // Поздняя первая операция, более новый выбор и общий снимок темы.
    await page.evaluate(()=>{window.__launcherIconTest.holdNextIcon=true;});
    await choose(page,'icon_star_boom');
    await page.waitForFunction(()=>window.__launcherIconTest.pendingIcons.length===1);
    await choose(page,'kz');
    assert.equal(await page.locator('.tb-logo img').getAttribute('data-launcher-icon'),'kz');
    await page.locator('[data-theme-id="navy"]').click();
    await page.waitForFunction(()=>window.__launcherIconTest.settings.theme==='navy');
    assert.equal(await page.evaluate(()=>window.__launcherIconTest.settings.launcher_icon),'icon_star_eye');
    await page.evaluate(()=>window.__launcherIconTest.releaseIcon());
    await saved(page,'kz');
    assert.deepEqual((await page.evaluate(()=>window.__launcherIconTest.iconCalls)).slice(-2),['icon_star_boom','kz']);
    assert.equal(await page.evaluate(()=>window.__launcherIconTest.settings.theme),'navy');
    console.log('FAST_CHOICES_AND_STALE_GENERAL_SAVE_OK');

    // Сбой последней операции возвращает последнее подтверждённое значение.
    await page.evaluate(()=>{window.__launcherIconTest.failNextIcon=true;});
    await choose(page,'icon_star_eye');
    await page.waitForFunction(()=>document.querySelector('#toasts')?.textContent.includes('тестовый сбой записи'));
    assert.equal(await page.locator('.tb-logo img').getAttribute('data-launcher-icon'),'kz');
    assert(await page.getByRole('radio',{name:'Қазақстан'}).isChecked());
    assert.equal(await page.evaluate(()=>window.__launcherIconTest.settings.launcher_icon),'kz');
    console.log('FAILED_SAVE_ROLLS_BACK_OK');

    // Общая кнопка «Готово» вернула старый снимок после нового выбора.
    await page.evaluate(()=>{window.__launcherIconTest.holdNextSave=true;});
    await page.locator('#prefs-save').click();
    await page.waitForFunction(()=>window.__launcherIconTest.pendingSaves.length===1);
    await choose(page,'icon_star_boom'); await saved(page,'icon_star_boom');
    await page.evaluate(()=>window.__launcherIconTest.releaseSave());
    await page.waitForFunction(()=>document.querySelector('#modal-prefs').hidden);
    assert.equal(await page.evaluate(()=>window.omnispecDebug.state.settings.launcher_icon),'icon_star_boom');
    assert.equal(await page.evaluate(()=>window.__launcherIconTest.settings.launcher_icon),'icon_star_boom');
    console.log('LATE_SAVE_RESPONSE_CANNOT_REVERT_ICON_OK');

    await page.reload();
    await page.waitForFunction(()=>window.omnispecDebug?.state?.settings);
    assert.equal(await page.locator('.tb-logo img').getAttribute('data-launcher-icon'),'icon_star_boom');
    await prefs(page);
    assert(await page.getByRole('radio',{name:'Звездный взрыв'}).isChecked());
    assert.equal(await page.evaluate(()=>window.__launcherIconTest.settings.theme),'navy');
    const burst=page.getByRole('radio',{name:'Звездный взрыв'});
    await burst.focus(); await page.keyboard.press('ArrowRight'); await saved(page,'icon_star_eye');
    assert(await page.getByRole('radio',{name:'Звезда'}).isChecked());
    await page.reload();
    await page.waitForFunction(()=>window.omnispecDebug?.state?.settings);
    assert.equal(await page.locator('.tb-logo img').getAttribute('data-launcher-icon'),'icon_star_eye');
    await prefs(page);
    assert(await page.getByRole('radio',{name:'Звезда'}).isChecked());
    console.log('RESTART_AND_KEYBOARD_OK');

    // На 150% все варианты остаются в контейнере и доступны после прокрутки.
    await page.evaluate(()=>{
      document.body.style.zoom='1.5';document.body.style.width='calc(100vw / 1.5)';document.body.style.height='calc(100vh / 1.5)';
      document.documentElement.dataset.uiScale='150';document.documentElement.style.setProperty('--ui-zoom','1.5');
      window.dispatchEvent(new Event('resize'));
    });
    for(const [id] of options) {
      const label=page.locator(`#launcher-icon-grid label:has(input[value="${id}"])`);
      await label.scrollIntoViewIfNeeded();
      const size=await label.boundingBox(); assert(size && size.width>30 && size.height>30,id);
      assert(await label.locator('.launcher-icon-card > span').evaluate(el=>{
        const text=el.getBoundingClientRect(), card=el.parentElement.getBoundingClientRect();
        return el.scrollWidth<=el.clientWidth+1 && text.left>=card.left-1 && text.right<=card.right+1 && text.bottom<=card.bottom+1;
      }),`${id}: text stays inside card`);
    }
    await choose(page,'icon_star_boom'); await saved(page,'icon_star_boom');
    await choose(page,'icon_star_eye'); await saved(page,'icon_star_eye');
    assert.deepEqual(errors,[]);
    console.log('SCALE_150_OK');
    await page.close();
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
