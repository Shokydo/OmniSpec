// Pixel regression for the actual canvas renderer (not a CSS or UV-table-only test).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../../apps/omnispec-app/ui');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(
  'window.omnispecDebug = { state, paletteFromImage',
  'window.__capeTest = { drawSkinModel, paintSkinMini, skinFaceCorners, SKIN_CAPE };\n  window.omnispecDebug = { state, paletteFromImage'
);
assert(app.includes('window.__capeTest ='), 'test hook must match source exactly');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  try {
    res.setHeader('Content-Type', ({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[path.extname(file)] || 'application/octet-stream');
    res.end(pathname === '/app.js' ? app : fs.readFileSync(file));
  } catch { res.writeHead(404).end(); }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.__capeTest);
    const result = await page.evaluate(() => {
      const result={};
      for (const variant of ['classic','slim']) {
        const skin=document.createElement('canvas');skin.width=skin.height=64;const sc=skin.getContext('2d');
        function fill(color,x,y,w,h){sc.fillStyle=color;sc.fillRect(x,y,w,h)}
        // Four different front face quadrants and unambiguous left/right limbs.
        fill('#ff0000',8,8,4,8);fill('#00ff00',12,8,4,8);
        fill('#0000ff',44,20,variant==='slim'?3:4,12); // character right arm
        fill('#ffff00',36,52,variant==='slim'?3:4,12); // character left arm
        fill('#ff00ff',4,20,4,12);fill('#00ffff',20,52,4,12);
        // Back and overlays use independent texture regions.
        fill('#ff8800',24,8,4,8);fill('#00aaff',28,8,4,8);
        fill('#8800ff',variant==='slim'?51:52,20,variant==='slim'?3:4,12);
        fill('#008844',variant==='slim'?43:44,52,variant==='slim'?3:4,12);
        fill('#ff8800',44,36,variant==='slim'?3:4,4);
        fill('#0088ff',52,52,variant==='slim'?3:4,4);
        const canvas=document.createElement('canvas');canvas.width=240;canvas.height=380;const ctx=canvas.getContext('2d');
        const pixel=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
        window.__capeTest.drawSkinModel(canvas,skin,variant,0,0,null);
        const front={head:[pixel(100,55),pixel(140,55)], arms:[pixel(65,170),pixel(175,170)], legs:[pixel(100,285),pixel(140,285)], overlays:[pixel(65,126),pixel(175,126)]};
        window.__capeTest.drawSkinModel(canvas,skin,variant,180,0,null);
        result[variant]={...front,back:{head:[pixel(100,55),pixel(140,55)],arms:[pixel(65,170),pixel(175,170)]}};
      }
      return result;
    });
    for(const [variant,p] of Object.entries(result)) {
      assert.deepEqual(p.head,[[255,0,0,255],[0,255,0,255]],`${variant} face must not mirror UV`);
      assert.deepEqual(p.arms,[[0,0,255,255],[255,255,0,255]],`${variant} character right arm must be on viewer left`);
      assert.deepEqual(p.overlays,[[255,136,0,255],[0,136,255,255]],`${variant} overlay arms`);
      assert.deepEqual(p.back.head,[[255,136,0,255],[0,170,255,255]],`${variant} back face`);
      assert.deepEqual(p.back.arms,[[0,136,68,255],[136,0,255,255]],`${variant} back arms`);
      assert.deepEqual(p.legs,[[255,0,255,255],[0,255,255,255]],`${variant} right leg must be on viewer left`);
    }
    console.log('SKIN_MODEL_ASYMMETRIC_FACE_ARMS_LEGS_CLASSIC_SLIM_OK');
  } finally { await browser.close(); server.close(); }
})().catch(e=>{ console.error(e); process.exitCode=1; });
