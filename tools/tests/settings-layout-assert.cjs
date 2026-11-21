// Common geometry assertions for Chromium and the real Windows WebView2.
const assert = require('node:assert/strict');

async function checkSettingsLayout(page,label){
  const m=await page.evaluate(()=>{
    const nav=document.querySelector('#prefs-nav'),body=document.querySelector('#prefs-body'),row=document.querySelector('#sound-style-chips');
    const rect=el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
    const size=el=>({client:el.clientWidth,scroll:el.scrollWidth,overflowX:getComputedStyle(el).overflowX,overflowY:getComputedStyle(el).overflowY});
    const item=el=>{const text=document.createRange();text.selectNodeContents(el);const r=text.getBoundingClientRect();
      return {...rect(el),textLeft:r.left,textRight:r.right};};
    return {nav:{...size(nav),...rect(nav),indicatorBox:getComputedStyle(nav,'::before').boxSizing,
      tabs:Array.from(nav.querySelectorAll('[data-pref]'),el=>({id:el.dataset.pref,...item(el)}))},
      body:size(body),row:{...size(row),...rect(row)},chips:Array.from(row.querySelectorAll('[data-sound-style]'),el=>({id:el.dataset.soundStyle,...item(el)}))};
  });
  // WebKit rounds scrollWidth up at fractional zoom, even for an empty nav.
  // Hide that spurious horizontal bar, but verify real content still fits.
  assert.equal(m.nav.overflowX,'hidden',`${label}: nav must not show a horizontal scrollbar`);
  assert(m.nav.scroll<=m.nav.client+1,`${label}: nav has real horizontal overflow ${JSON.stringify(m.nav)}`);
  assert.equal(m.nav.indicatorBox,'border-box',`${label}: indicator border must fit its measured width`);
  for(const tab of m.nav.tabs){
    assert(tab.left>=m.nav.left-1 && tab.right<=m.nav.right+1,`${label}: clipped nav button ${JSON.stringify(tab)}`);
    assert(tab.textLeft>=tab.left-1 && tab.textRight<=tab.right+1,`${label}: clipped nav label ${JSON.stringify(tab)}`);
  }
  assert.equal(m.body.scroll,m.body.client,`${label}: sound page horizontal overflow ${JSON.stringify(m.body)}`);
  assert.equal(m.row.scroll,m.row.client,`${label}: sound choices horizontal overflow ${JSON.stringify(m.row)}`);
  assert.equal(m.chips.length,10,`${label}: all 10 sound styles present`);
  const epsilon=1;
  for(const chip of m.chips){
    assert(chip.left>=m.row.left-epsilon && chip.right<=m.row.right+epsilon,`${label}: clipped button ${JSON.stringify(chip)}`);
    assert(chip.textLeft>=chip.left-epsilon && chip.textRight<=chip.right+epsilon,`${label}: clipped label ${JSON.stringify(chip)}`);
  }
  for(let i=0;i<m.chips.length;i++) for(let j=i+1;j<m.chips.length;j++){
    const a=m.chips[i],b=m.chips[j];
    const overlapX=Math.min(a.right,b.right)-Math.max(a.left,b.left);
    const overlapY=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
    assert(overlapX<=epsilon || overlapY<=epsilon,`${label}: overlapping sound choices ${a.id}/${b.id}`);
  }
  assert.match(m.nav.overflowY,/^(auto|scroll|overlay)$/,`${label}: nav must remain vertically scrollable`);
  assert.match(m.body.overflowY,/^(auto|scroll|overlay)$/,`${label}: settings must remain vertically scrollable`);
  return m.chips.map(c=>c.id);
}

module.exports={checkSettingsLayout};
