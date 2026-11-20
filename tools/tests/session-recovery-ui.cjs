// UI regression with a mocked Tauri backend. Does not start Minecraft or Discord.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const server = http.createServer((req,res)=>{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  if(!file.startsWith(root+path.sep)) return res.writeHead(403).end();
  try { const type=({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png'})[path.extname(file)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':type}).end(fs.readFileSync(file));
  } catch {res.writeHead(404).end();}
});
async function pageWith(browser, race=false) {
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
  await page.addInitScript((race)=>{
    const data=window.__sessionsTest={
      events:{}, presence:[], calls:[], race, release:null,
      list:[
        {id:'alpha',name:'Alpha',mc_version:'1.21.1',loader:{type:'fabric',version:'0.16.0'},icon:null,created:1,playtime_secs:0},
        {id:'beta',name:'Beta',mc_version:'1.20.1',loader:{type:'vanilla'},icon:null,created:1,playtime_secs:0}
      ],
      running:[
        {instance_id:'alpha',run_id:'alpha#a',account:'Alex',started_at:1700000000},
        {instance_id:'alpha',run_id:'alpha#b',account:'Bob',started_at:1700000010},
        {instance_id:'beta',run_id:'beta#c',account:'Sam',started_at:1700000020},
        {instance_id:'missing',run_id:'missing#x',account:'Nobody',started_at:1700000030}
      ],
      async invoke(command,args={}) {
        this.calls.push(command);
        switch(command) {
          case 'get_settings': return {onboarded:true,update_enabled:false,discord_rpc:true,discord_instance_icon:false,theme:'dark',click_fx:'off',ambient:'off',trail:false,ui_scale:100,categories:[]};
          case 'save_settings': return null;
          case 'list_instances': return this.list.map(x=>({...x}));
          case 'running_sessions': {
            const snapshot=this.running.map(x=>({...x}));
            if(this.race && !this.release) return new Promise(resolve=>{this.release=()=>resolve(snapshot)});
            return snapshot;
          }
          case 'running_instances': return [...new Set(this.running.map(x=>x.instance_id))];
          case 'set_presence': this.presence.push({...args}); return null;
          case 'accounts_info': return {accounts:[],active:null};
          case 'app_info': return {home:'/test',version:'test',platform:'windows',demo:false};
          case 'system_memory': return {total_mb:8192};
          case 'version_info': return {enabled:false,version:'test'};
          case 'search_modrinth': return {hits:[],total_hits:0};
          case 'list_java': return [];
          case 'instance_path': return '/test';
          default:return null;
        }
      },
      exit(run,instance,code=null) {
        this.running=this.running.filter(x=>x.run_id!==run);
        this.events['game-exit']?.({payload:{instance,run_id:run,code,stopped:false,recovered:true}});
      }
    };
    window.__TAURI__={core:{invoke:(cmd,args)=>data.invoke(cmd,args),convertFileSrc:p=>p},event:{listen:async(name,cb)=>{data.events[name]=cb;return ()=>{};}}};
  },race);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  return {page,errors};
}
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch();
  try {
    {
      const {page,errors}=await pageWith(browser);
      await page.waitForFunction(()=>window.omnispecDebug?.state.running.size===2 && window.__sessionsTest.presence.some(x=>x.mode==='playing'));
      const state=await page.evaluate(()=>({running:[...window.omnispecDebug.state.running],sessions:[...window.omnispecDebug.state.sessions].map(([k,v])=>[k,[...v.keys()]]),presence:window.__sessionsTest.presence.at(-1)}));
      assert.deepEqual(state.running,['alpha','beta']);
      assert.deepEqual(state.sessions,[['alpha',['alpha#a','alpha#b']],['beta',['beta#c']]]);
      assert.equal(state.presence.details,'Alpha'); assert.equal(state.presence.startedAt,1700000000);
      assert.equal(await page.locator('[data-dup-of="alpha"]').count(),1);
      await page.locator('.instance[data-id="beta"]').first().click();
      await page.waitForFunction(()=>window.__sessionsTest.presence.at(-1)?.details==='Beta');
      assert.equal((await page.evaluate(()=>window.__sessionsTest.presence.at(-1))).startedAt,1700000020);
      await page.evaluate(()=>window.__sessionsTest.exit('alpha#b','alpha'));
      await page.waitForFunction(()=>window.omnispecDebug.state.sessions.get('alpha')?.size===1);
      await page.evaluate(()=>window.__sessionsTest.exit('beta#c','beta'));
      await page.waitForFunction(()=>!window.omnispecDebug.state.running.has('beta') && window.__sessionsTest.presence.at(-1)?.details==='Alpha');
      assert.match(await page.locator('#tb-status').innerText(),/остановлена/);
      assert(!(await page.locator('body').innerText()).includes('ошибкой (код null)'));
      await page.evaluate(()=>window.__sessionsTest.exit('alpha#a','alpha'));
      await page.waitForFunction(()=>window.omnispecDebug.state.running.size===0 && window.__sessionsTest.presence.at(-1)?.mode==='idle');
      assert.deepEqual(errors,[]); await page.close();
      console.log('SESSION_UI: restored duplicates, accurate timestamp, RPC switching, unknown exits and final idle passed');
    }
    {
      const {page,errors}=await pageWith(browser,true);
      await page.waitForFunction(()=>!!window.__sessionsTest.release && !!window.__sessionsTest.events['game-exit']);
      await page.evaluate(()=>{window.__sessionsTest.exit('alpha#a','alpha');window.__sessionsTest.release();});
      await page.waitForFunction(()=>window.__sessionsTest.calls.filter(x=>x==='running_sessions').length>=2 && window.omnispecDebug.state.running.has('beta'));
      const sessions=await page.evaluate(()=>[...window.omnispecDebug.state.sessions].map(([id,items])=>[id,[...items.keys()]]));
      assert.deepEqual(sessions,[['alpha',['alpha#b']],['beta',['beta#c']]],'a stale first response must not resurrect an exited run or lose other running games');
      assert.deepEqual(errors,[]); await page.close();
      console.log('SESSION_UI_RACE: stale snapshot ignored and retried without losing other live games');
    }
  } finally {await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1});
