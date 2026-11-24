// Generate representative screenshots from OmniSpec itself, with local fixture data.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const out = path.join(root, 'assets/preset-previews');
fs.mkdirSync(out, {recursive:true});
const server = http.createServer((req,res)=>{
  const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));
  if (!file.startsWith(root+path.sep)) return res.writeHead(403).end();
  try {res.writeHead(200, {'Content-Type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'}).end(fs.readFileSync(file));}catch{return res.writeHead(404).end();}
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1100,height:700},deviceScaleFactor:1});
  await page.addInitScript(()=>{
   const settings={onboarded:true,onboarding_pending:false,update_enabled:false,discord_rpc:false,theme:'dark',click_fx:'off',ambient:'off',trail:false,ui_scale:100,categories:[]};
   const instances=[{id:'fabric',name:'Fabric 1.21',playtime_secs:7200,mc_version:'1.21.1',loader:{type:'fabric',version:'0.16.9'},source:'manual'}, {id:'survival',name:'Survival Plus',mc_version:'1.20.1',loader:{type:'forge',version:'47.2'},source:'manual'}, {id:'creative',name:'Creative',mc_version:'1.21.1',loader:{type:'vanilla'},source:'manual'}];
   const invoke=async(command,args={})=>{ if(command==='get_settings')return {...settings};if(command==='save_settings'){Object.assign(settings,args.settings);return null}if(command==='list_instances')return instances;if(command==='accounts_info')return {accounts:[],active:null};if(command==='app_info')return {home:'/demo',version:'0.55.0',demo:false};if(command==='version_info')return {version:'0.55.0',enabled:false};if(command==='system_memory')return {total_mb:8192};if(['running_instances','running_sessions','list_java','list_mods','content_list','list_dir'].includes(command))return [];if(command==='mod_icons')return {};return null;};
   window.__TAURI__={core:{invoke},event:{listen:async()=>()=>{}}};
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
  await page.waitForSelector('#instance-list [data-id="fabric"]');
  await page.locator('#instance-list [data-id="fabric"]').first().click();
  await page.waitForTimeout(500);
  for(const id of ['omnispec','modrinth','prism']) {
   await page.evaluate(id=>window.omnispecCustomizer.applyUiPreset(id),id);
   await page.waitForTimeout(400);
   await page.screenshot({path:path.join(out,id+'.png')});
  }
 }finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1});
