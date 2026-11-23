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
      const skin = document.createElement('canvas'); skin.width=skin.height=64; // transparent
      const cape = document.createElement('canvas'); cape.width=64; cape.height=32;
      const c=cape.getContext('2d');
      const fill=(color,x,y,w,h) => {c.fillStyle=color;c.fillRect(x,y,w,h);};
      // Different corners expose both horizontal and vertical mirroring.
      fill('#ff0000',1,1,5,8); fill('#00ff00',6,1,5,8);
      fill('#0000ff',1,9,5,8); fill('#ffff00',6,9,5,8);
      fill('#ff00ff',12,1,5,16); fill('#00ffff',17,1,5,16);
      fill('#ffa000',11,0,5,1); fill('#805000',16,0,5,1);
      const canvas=document.createElement('canvas'); canvas.width=240;canvas.height=380;
      const ctx=canvas.getContext('2d');
      const pixel=(x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
      window.__capeTest.drawSkinModel(canvas,skin,'classic',180,0,cape);
      const smoothing=ctx.imageSmoothingEnabled;
      const outside=[pixel(85,145),pixel(155,145),pixel(85,225),pixel(155,225)];
      window.__capeTest.drawSkinModel(canvas,skin,'classic',0,0,cape);
      const inside=[pixel(85,145),pixel(155,145)];

      // An opaque skin must never be visible through the opaque part of the
      // cape, both in the large preview and in the favorite/skin miniature.
      const solidSkin=document.createElement('canvas'); solidSkin.width=solidSkin.height=64;
      const solidSkinCtx=solidSkin.getContext('2d'); solidSkinCtx.fillStyle='#ffffff'; solidSkinCtx.fillRect(0,0,64,64);
      const solidCape=document.createElement('canvas'); solidCape.width=64; solidCape.height=32;
      const solidCapeCtx=solidCape.getContext('2d'); solidCapeCtx.fillStyle='#ff0000'; solidCapeCtx.fillRect(1,1,10,16);
      const opaqueCanvas=document.createElement('canvas'); opaqueCanvas.width=240; opaqueCanvas.height=380;
      const opaqueCtx=opaqueCanvas.getContext('2d');
      const opaquePixel=(x,y)=>Array.from(opaqueCtx.getImageData(x,y,1,1).data);
      window.__capeTest.drawSkinModel(opaqueCanvas,solidSkin,'classic',180,0,solidCape);
      const opaquePreview=[[120,145],[120,190],[120,235]].map(([x,y])=>opaquePixel(x,y));
      const slot=document.createElement('span');
      window.__capeTest.paintSkinMini(slot,solidSkin,solidCape);
      const mini=slot.querySelector('canvas');
      const miniCtx=mini.getContext('2d');
      const miniPixel=(x,y)=>Array.from(miniCtx.getImageData(x,y,1,1).data);
      const opaqueMini=[[58,50],[60,65],[62,80],[66,92]].map(([x,y])=>miniPixel(x,y));
      return {smoothing,outside,inside,opaquePreview,opaqueMini,uv:window.__capeTest.SKIN_CAPE.uv, bounds:window.__capeTest.SKIN_CAPE.b};
    });
    assert.equal(result.smoothing, false, 'skin canvas keeps pixel-art edges sharp');
    assert.deepEqual(result.outside, [[255,0,0,255],[0,255,0,255],[0,0,255,255],[255,255,0,255]], 'outer cape is upright and not mirrored');
    assert.deepEqual(result.inside, [[255,0,255,255],[0,255,255,255]], 'inside uses the other face in correct direction');
    for (const pixel of [...result.opaquePreview, ...result.opaqueMini]) {
      assert(pixel[0] > 220 && pixel[1] < 50 && pixel[2] < 50 && pixel[3] === 255,
        `skin is visible through an opaque cape pixel: ${JSON.stringify(pixel)}`);
    }
    assert.deepEqual(result.uv.down, [21,0,11,1], 'bottom samples all 10 pixels of the cape texture');
    assert(result.bounds[2] > 2, 'cape is behind the torso');
    console.log('CAPE PROJECTION: outside/inside orientation and bottom UV passed');
  } finally { await browser.close(); server.close(); }
})().catch(e=>{ console.error(e); process.exitCode=1; });
