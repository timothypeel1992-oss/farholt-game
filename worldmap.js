/* ============================================================
   ui/worldmap.js — Weltkarte
   Makro-Karte im JRPG-Stil, Kontinente, Randübergänge
   und die Routinen der Dorfbewohner.
============================================================ */

import { clamp, hash2, mulberry32 } from '../engine/rng.js';
import { sfxBuildDone, sfxCraft, sfxEvent, sfxPlace } from '../engine/audio.js';
/* ============================================================
   Overworld: mehrere Kontinente über der Regionsebene.
   Farholm ist die Heimatinsel; weitere Landmassen erreicht man
   per Schiff von einer Küstenregion aus.
============================================================ */
const CONTINENTS = {
  farholm: {
    name:'Farholm', short:'Heimat', ox:0.30, oy:0.52, r:0.13,
    biomes:['wildwood','meadow','coast','deepwood','highland'],
    danger:0, unlocked:true,
    desc:'Die Küste, an der ihr angelegt habt. Milde Wälder, fruchtbare Auen — und der einzige Ort, den ihr wirklich kennt.'
  },
  altfarholt: {
    name:'Alt-Farholt', short:'Ruinen', ox:0.58, oy:0.34, r:0.115,
    biomes:['ruins','highland','deepwood','thorn'],
    danger:2, cost:{planks:12, cloth:6},
    desc:'Jenseits der Meerenge liegen die Überreste dessen, was vor euch hier war. Zerborstene Säulen, überwucherte Straßen — und niemand, der erklären könnte, wohin alle verschwunden sind.'
  },
  nordfels: {
    name:'Nordfels', short:'Frost', ox:0.44, oy:0.14, r:0.10,
    biomes:['frost','highland','ruins'],
    danger:3, cost:{planks:18, cloth:10, metal:6},
    desc:'Eine Frostküste im Norden. Die Alten nannten sie den Amboss — wegen des Windes, der Tag und Nacht auf den Klippen hämmert.'
  },
  moorland: {
    name:'Sumpfmark', short:'Moor', ox:0.20, oy:0.80, r:0.105,
    biomes:['swamp','thorn','deepwood'],
    danger:2, cost:{planks:14, cloth:8},
    desc:'Südlich der Heimat verliert sich das Land im Nebel. Wer dort Handel treibt, kehrt reich zurück — oder gar nicht.'
  },
  weitmark: {
    name:'Weitmark', short:'Fern', ox:0.79, oy:0.68, r:0.12,
    biomes:['meadow','coast','wildwood','highland'],
    danger:4, cost:{planks:22, cloth:14, metal:10, gold:4},
    desc:'Die fernste Landmasse auf euren Karten. Was dort liegt, weiß niemand — die letzte Expedition kam nie zurück.'
  }
};
function currentContinent(){ return state.continentId || 'farholm'; }
function continentOf(regionId){
  if(regionId==='C') return 'farholm';
  const m = String(regionId).match(/^([a-z]+)::/);
  return m ? m[1] : 'farholm';
}
function isContinentUnlocked(id){
  if(id==='farholm') return true;
  return !!(state.unlockedContinents && state.unlockedContinents.includes(id));
}
// Baut das Regionsraster eines Kontinents auf, sobald er zum ersten Mal betreten wird
function ensureContinentRegions(cid){
  const cont = CONTINENTS[cid];
  if(!cont || cid==='farholm') return;
  const seedBase = worldSeedBase + cid.length*7919;
  for(let gy=-1; gy<=1; gy++){
    for(let gx=-1; gx<=1; gx++){
      const rid = cid+'::'+gx+'_'+gy;
      if(REGIONS[rid]) continue;
      const rng = mulberry32(seedBase + gx*104729 + gy*1299709);
      const biome = cont.biomes[Math.floor(rng()*cont.biomes.length)];
      const pool = BIOME_NAME_POOL[biome] || ['Unbekanntes Land'];
      REGIONS[rid] = { name: pool[Math.floor(rng()*pool.length)], biome,
                       gx, gy, continent:cid };
    }
  }
  return cid+'::0_0';
}
// Kosten prüfen und abziehen
function canAffordVoyage(cost){
  if(!cost) return true;
  return Object.keys(cost).every(k=>(state.inventory[k]||0) >= cost[k]);
}
function payVoyage(cost){
  if(!cost) return;
  Object.keys(cost).forEach(k=>{ state.inventory[k] -= cost[k]; bumpResource(k); });
}
// Seereise zu einem anderen Kontinent
function sailTo(cid){
  const cont = CONTINENTS[cid];
  if(!cont) return;
  if(cid === currentContinent()){ toast('⚓ Du bist bereits auf '+cont.name+'.'); return; }
  const firstTime = !isContinentUnlocked(cid);
  if(firstTime){
    if(!canAffordVoyage(cont.cost)){
      const need = Object.keys(cont.cost).map(k=>cont.cost[k]+' '+(RESOURCE_NAMES[k]||k)).join(', ');
      toast('⚓ Für die Überfahrt fehlt Ausrüstung: '+need);
      return;
    }
    payVoyage(cont.cost);
    state.unlockedContinents = state.unlockedContinents || [];
    state.unlockedContinents.push(cid);
    logEvent('⛵ Ihr habt nach '+cont.name+' übergesetzt — eine neue Landmasse liegt vor euch.');
  }
  const target = (cid==='farholm') ? 'C' : ensureContinentRegions(cid);
  state.continentId = cid;
  closeOverworld();
  fastTravel(target);
  toast('⛵ '+cont.name+' erreicht.');
  sfxEvent();
}
/* ---- Overworld-Karte zeichnen ---- */
/* ============================================================
   Makro-Weltkarte (JRPG-Stil)
   Eigene Spielebene: verkleinerte Figur läuft über eine große
   Übersichtskarte, Orte erscheinen als Symbole. Betreten eines
   Ortes wechselt in die Detailansicht (Mikro-Ebene).
============================================================ */
/* --- Gekapselt: 5 Bezeichner nach außen, 12 bleiben intern.
   Schnittstelle: macroMode, enterMacroMap, exitMacroMap, macroMove, macroEnter --- */
const MACRO_W = 48, MACRO_H = 30, MACRO_TILE = 18;
let macroMode = false;
let macroMap = null;          // {tiles, sites, continent}
let macroPlayer = {x:0, y:0, facing:'down'};
let onShip = false;
let shipAnchor = null;
function hasShip(){ return !!(state.hasShip); }

const MACRO_BIOME_COL = {
  ocean:['#1d4450','#153741'], coast:['#c9b184','#b09a6f'],
  wildwood:['#3f6b3f','#325733'], meadow:['#6fa03d','#5c8a33'],
  highland:['#6b7355','#575e46'], frost:['#b8c8d4','#9aabb8'],
  swamp:['#4a5940','#3c4a35'], ruins:['#7a7263','#635c50'],
  thorn:['#4a5c38','#3d4d2e'], deepwood:['#2c4a2c','#233d23']
};
const SITE_ICON = { colony:'🏠', village:'🏘️', city:'🏰', cave:'🕳️', ruin:'🏛️', camp:'⛺', free:'' };

function buildMacroMap(cid){
  const cont = CONTINENTS[cid] || CONTINENTS.farholm;
  const rng = mulberry32(worldSeedBase + cid.length*7919 + 4242);
  const tiles = [];
  const cxm = MACRO_W/2, cym = MACRO_H/2;
  for(let y=0;y<MACRO_H;y++){
    const row=[];
    for(let x=0;x<MACRO_W;x++){
      // Inselform: Rauschen auf einer Ellipse -> unregelmäßige Küste
      const dx=(x-cxm)/(MACRO_W*0.42), dy=(y-cym)/(MACRO_H*0.42);
      const d=Math.sqrt(dx*dx+dy*dy);
      const warp = 1 + Math.sin(Math.atan2(dy,dx)*3 + cid.length)*0.16
                     + Math.sin(Math.atan2(dy,dx)*7 + 1.3)*0.08;
      if(d > warp) { row.push('ocean'); continue; }
      if(d > warp-0.11){ row.push('coast'); continue; }
      const b = cont.biomes[Math.floor(hash2(x,y,worldSeedBase+cid.length)*cont.biomes.length)];
      row.push(b);
    }
    tiles.push(row);
  }
  // Orte verteilen
  const sites = [];
  const landAt = (x,y)=> tiles[y] && tiles[y][x] && tiles[y][x]!=='ocean' && tiles[y][x]!=='coast';
  const place = (kind, name, tries)=>{
    for(let t=0;t<(tries||120);t++){
      const x=2+Math.floor(rng()*(MACRO_W-4)), y=2+Math.floor(rng()*(MACRO_H-4));
      if(!landAt(x,y)) continue;
      if(sites.some(s=>Math.abs(s.x-x)<4 && Math.abs(s.y-y)<3)) continue;
      sites.push({x,y,kind,name});
      return sites[sites.length-1];
    }
    return null;
  };
  if(cid==='farholm'){
    const home = place('colony', state.colonyName||'Heimat');
    if(home){ home.regionId='C'; macroPlayerStart = {x:home.x, y:home.y+1}; }
  }
  const villageNames = ['Moosheim','Ahornfeld','Rabenstein','Wolfsgrund','Dornwald','Farholt-Ost','Salzbucht'];
  const cityNames = ['Farholm-Feste','Alt-Farholt','Sturmwacht'];
  for(let i=0;i<3+Math.floor(rng()*2);i++) place('village', villageNames[Math.floor(rng()*villageNames.length)]);
  if(rng()<0.8) place('city', cityNames[Math.floor(rng()*cityNames.length)]);
  for(let i=0;i<2+Math.floor(rng()*2);i++) place('cave','Höhle');
  if(cid==='altfarholt' || rng()<0.5) place('ruin','Ruine');
  return { tiles, sites, continent:cid };
}
let macroPlayerStart = null;

function enterMacroMap(){
  const cid = currentContinent();
  if(!macroMap || macroMap.continent!==cid) macroMap = buildMacroMap(cid);
  if(macroPlayerStart){ macroPlayer.x=macroPlayerStart.x; macroPlayer.y=macroPlayerStart.y; macroPlayerStart=null; }
  else if(!macroPlayer.x){ macroPlayer.x=Math.floor(MACRO_W/2); macroPlayer.y=Math.floor(MACRO_H/2); }
  macroMode = true;
  document.getElementById('macroOverlay').classList.remove('hidden');
  setMode('macro', {remember:true});
  drawMacro();
  toast('🗺️ Weltkarte betreten — WASD zum Reisen, Leertaste zum Betreten.');
}
function exitMacroMap(){
  macroMode = false;
  document.getElementById('macroOverlay').classList.add('hidden');
  popMode();
}
function macroTileAt(x,y){ return (macroMap && macroMap.tiles[y]) ? macroMap.tiles[y][x] : 'ocean'; }
function macroSiteAt(x,y){ return macroMap ? macroMap.sites.find(s=>s.x===x&&s.y===y) : null; }
// Küstenfeld = Land, das ans Meer grenzt. Nur dort kann man an- und ablegen.
function isShoreTile(x,y){
  if(macroTileAt(x,y)==='ocean') return false;
  return [[0,-1],[0,1],[-1,0],[1,0]].some(([dx,dy])=>macroTileAt(x+dx,y+dy)==='ocean');
}
function macroPassable(x,y){
  if(x<0||y<0||x>=MACRO_W||y>=MACRO_H) return false;
  const t = macroTileAt(x,y);
  if(onShip) return t==='ocean' || isShoreTile(x,y);
  return t!=='ocean';
}
function macroMove(dir){
  if(!macroMode) return;
  const d = {up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]}[dir];
  if(!d) return;
  macroPlayer.facing = dir;
  const nx=macroPlayer.x+d[0], ny=macroPlayer.y+d[1];
  if(!macroPassable(nx,ny)){
    if(macroTileAt(nx,ny)==='ocean'){
      toast(hasShip() ? '⛵ Leertaste am Ufer, um abzulegen.'
                      : '🌊 Ohne Schiff kommst du hier nicht weiter.');
    } else if(onShip){
      toast('⚓ Hier ist keine Anlegestelle — such eine Küste.');
    }
    drawMacro(); return;
  }
  macroPlayer.x=nx; macroPlayer.y=ny;
  if(onShip && macroTileAt(nx,ny)!=='ocean'){
    onShip = false; shipAnchor = {x:nx, y:ny};
    toast('⚓ Angelegt — dein Schiff wartet hier.');
  }
  drawMacro();
}
// Ein- und Aussteigen
function toggleShip(){
  if(!hasShip()) return false;
  const x=macroPlayer.x, y=macroPlayer.y;
  if(onShip){
    const spot = [[0,-1],[0,1],[-1,0],[1,0]].map(([dx,dy])=>({x:x+dx,y:y+dy}))
      .find(p=>macroTileAt(p.x,p.y)!=='ocean');
    if(!spot){ toast('⚓ Keine Küste in Reichweite.'); return true; }
    macroPlayer.x=spot.x; macroPlayer.y=spot.y;
    onShip=false; shipAnchor={x:spot.x,y:spot.y};
    toast('⚓ Du gehst an Land.'); sfxPlace(); drawMacro(); return true;
  }
  if(!isShoreTile(x,y)){ toast('⛵ Du musst am Ufer stehen, um abzulegen.'); return true; }
  onShip=true; toast('⛵ Leinen los!'); sfxEvent(); drawMacro(); return true;
}
// Ort betreten oder neuen Außenposten gründen
function macroEnter(){
  if(!macroMode) return;
  const onWater = macroTileAt(macroPlayer.x, macroPlayer.y)==='ocean';
  const atShore = isShoreTile(macroPlayer.x, macroPlayer.y);
  const site = macroSiteAt(macroPlayer.x, macroPlayer.y);
  // Am Ufer bzw. auf See schaltet die Leertaste das Schiff
  if(hasShip() && !site && (onWater || atShore)){ if(toggleShip()) return; }
  if(site){
    exitMacroMap();
    if(site.regionId){ fastTravel(site.regionId); }
    else {
      const rid = ensureRegion(site.x-Math.floor(MACRO_W/2), site.y-Math.floor(MACRO_H/2));
      REGIONS[rid].name = site.name;
      fastTravel(rid);
    }
    toast('📍 '+site.name+' betreten');
    return;
  }
  const biome = macroTileAt(macroPlayer.x, macroPlayer.y);
  if(biome==='ocean'){ toast('🌊 Hier ist nur Wasser.'); return; }
  showStoryDialog('Freies Land',
    `Hier ist noch nichts errichtet. Der Boden trägt ${BIOME_NAME_POOL[biome]?BIOME_NAME_POOL[biome][0]:'unbekanntes Land'}.\n\nWillst du hier einen Außenposten gründen?`,
    [
      {label:'⛺ Außenposten gründen', action:()=>{
        const site2 = {x:macroPlayer.x, y:macroPlayer.y, kind:'camp', name:'Außenposten'};
        macroMap.sites.push(site2);
        exitMacroMap();
        const rid = ensureRegion(site2.x-Math.floor(MACRO_W/2), site2.y-Math.floor(MACRO_H/2));
        REGIONS[rid].name = 'Außenposten';
        site2.regionId = rid;
        fastTravel(rid);
        logEvent('⛺ Ein neuer Außenposten wurde gegründet.');
      }},
      {label:'Weiterziehen', secondary:true, action:()=>{}}
    ]);
}
function drawMacro(){
  const cv = document.getElementById('macroCanvas'); if(!cv || !macroMap) return;
  const g = cv.getContext('2d');
  const W = MACRO_W*MACRO_TILE, H = MACRO_H*MACRO_TILE;
  cv.width = W; cv.height = H;
  const t = performance.now();
  for(let y=0;y<MACRO_H;y++){
    for(let x=0;x<MACRO_W;x++){
      const b = macroTileAt(x,y);
      const col = MACRO_BIOME_COL[b] || MACRO_BIOME_COL.wildwood;
      const sx=x*MACRO_TILE, sy=y*MACRO_TILE;
      g.fillStyle = ((x+y)%2===0) ? col[0] : col[1];
      g.fillRect(sx,sy,MACRO_TILE,MACRO_TILE);
      if(b==='ocean'){
        g.strokeStyle='rgba(255,255,255,.07)'; g.lineWidth=1;
        g.beginPath(); g.moveTo(sx, sy+MACRO_TILE*0.6+Math.sin(t/900+x)*1.5);
        g.lineTo(sx+MACRO_TILE, sy+MACRO_TILE*0.6+Math.sin(t/900+x+1)*1.5); g.stroke();
      } else if(b==='wildwood'||b==='deepwood'){
        g.fillStyle='rgba(0,0,0,.22)';
        g.beginPath(); g.arc(sx+MACRO_TILE*0.5, sy+MACRO_TILE*0.45, 3.2, 0, Math.PI*2); g.fill();
      } else if(b==='highland'||b==='frost'){
        g.fillStyle='rgba(255,255,255,.2)';
        g.beginPath(); g.moveTo(sx+4,sy+13); g.lineTo(sx+9,sy+5); g.lineTo(sx+14,sy+13); g.closePath(); g.fill();
      }
    }
  }
  // Orte
  macroMap.sites.forEach(s=>{
    const sx=s.x*MACRO_TILE, sy=s.y*MACRO_TILE;
    g.fillStyle='rgba(0,0,0,.35)';
    g.beginPath(); g.ellipse(sx+MACRO_TILE/2, sy+MACRO_TILE-2, 7, 3, 0, 0, Math.PI*2); g.fill();
    g.font='14px sans-serif'; g.textAlign='center'; g.textBaseline='middle';
    g.fillText(SITE_ICON[s.kind]||'⛺', sx+MACRO_TILE/2, sy+MACRO_TILE/2);
    if(Math.abs(s.x-macroPlayer.x)<=3 && Math.abs(s.y-macroPlayer.y)<=2){
      g.font='800 9px Nunito, sans-serif';
      g.strokeStyle='rgba(0,0,0,.8)'; g.lineWidth=3;
      g.strokeText(s.name, sx+MACRO_TILE/2, sy-6);
      g.fillStyle='#f2e8cc'; g.fillText(s.name, sx+MACRO_TILE/2, sy-6);
    }
  });
  // Miniaturfigur
  const px=macroPlayer.x*MACRO_TILE+MACRO_TILE/2, py=macroPlayer.y*MACRO_TILE+MACRO_TILE/2;
  g.fillStyle='rgba(0,0,0,.4)';
  g.beginPath(); g.ellipse(px,py+6,5,2.4,0,0,Math.PI*2); g.fill();
  if(onShip){
    g.save(); g.translate(px, py+2);
    g.rotate(Math.sin(performance.now()/600)*0.08);
    g.fillStyle='#5a3f26';
    g.beginPath(); g.moveTo(-7,0); g.quadraticCurveTo(0,5,7,0); g.lineTo(5,-2); g.lineTo(-5,-2); g.closePath(); g.fill();
    g.strokeStyle='#3a2814'; g.lineWidth=0.8; g.stroke();
    g.strokeStyle='#6b4a2b'; g.lineWidth=1;
    g.beginPath(); g.moveTo(0,-2); g.lineTo(0,-11); g.stroke();
    g.fillStyle='rgba(240,235,215,.95)';
    g.beginPath(); g.moveTo(0.5,-10.5); g.quadraticCurveTo(6,-6.5,1,-2.5); g.closePath(); g.fill();
    g.restore();
    g.strokeStyle='rgba(255,255,255,.25)'; g.lineWidth=1;
    g.beginPath(); g.arc(px, py+4, 8, 0.2, Math.PI-0.2); g.stroke();
  } else {
    g.save(); g.translate(px, py+2);
    try{ drawHumanoidBody(g, playerAppearance, 0.55, null, null, false, state.player.advClass||null); }catch(e){}
    g.restore();
  }
  if(!onShip && shipAnchor && hasShip()){
    const ax=shipAnchor.x*MACRO_TILE+MACRO_TILE/2, ay=shipAnchor.y*MACRO_TILE+MACRO_TILE/2;
    g.save(); g.globalAlpha=0.8; g.font='11px sans-serif'; g.textAlign='center'; g.textBaseline='middle';
    g.fillText('⛵', ax, ay); g.restore();
  }
  const pulse=0.5+Math.sin(t/380)*0.5;
  g.strokeStyle='rgba(232,169,77,'+(0.4+pulse*0.5)+')'; g.lineWidth=1.6;
  g.beginPath(); g.arc(px,py,10,0,Math.PI*2); g.stroke();
  // Hinweis auf begehbaren Ort
  const here = macroSiteAt(macroPlayer.x, macroPlayer.y);
  const info = document.getElementById('macroInfo');
  if(info){
    if(here) info.textContent = `${SITE_ICON[here.kind]||'⛺'} ${here.name} — Leertaste zum Betreten`;
    else if(onShip) info.textContent = '⛵ Auf See — Leertaste am Ufer zum Anlegen';
    else if(hasShip() && isShoreTile(macroPlayer.x, macroPlayer.y)) info.textContent = '⚓ Ufer — Leertaste zum Ablegen';
    else info.textContent = `${(BIOME_NAME_POOL[macroTileAt(macroPlayer.x,macroPlayer.y)]||['Freies Land'])[0]} — Leertaste: Außenposten gründen`;
  }
}


function drawOverworld(){
  const cv = document.getElementById('overworldCanvas');
  if(!cv) return;
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  const t = performance.now();
  // Meer
  const sea = g.createLinearGradient(0,0,0,H);
  sea.addColorStop(0,'#2b5560'); sea.addColorStop(1,'#173840');
  g.fillStyle=sea; g.fillRect(0,0,W,H);
  // Wellenmuster
  g.strokeStyle='rgba(255,255,255,.055)'; g.lineWidth=1;
  for(let r=0;r<16;r++){
    const wy=(r+0.5)*(H/16);
    g.beginPath();
    for(let x=0;x<=W;x+=10){ const yy=wy+Math.sin(t/2600+x*0.014+r)*2.4; if(x===0)g.moveTo(x,yy); else g.lineTo(x,yy); }
    g.stroke();
  }
  const cur = currentContinent();
  // Seewege von der Heimat aus
  Object.keys(CONTINENTS).forEach(cid=>{
    if(cid==='farholm') return;
    const a = CONTINENTS.farholm, b = CONTINENTS[cid];
    g.save();
    g.strokeStyle = isContinentUnlocked(cid) ? 'rgba(232,169,77,.35)' : 'rgba(255,255,255,.13)';
    g.lineWidth = 1.6; g.setLineDash([6,6]);
    g.lineDashOffset = -(t/90)%12;
    g.beginPath(); g.moveTo(a.ox*W, a.oy*H);
    const mx=(a.ox+b.ox)/2*W, my=(a.oy+b.oy)/2*H - 30;
    g.quadraticCurveTo(mx, my, b.ox*W, b.oy*H); g.stroke();
    g.restore();
  });
  // Landmassen
  Object.keys(CONTINENTS).forEach(cid=>{
    const c = CONTINENTS[cid];
    const cx = c.ox*W, cy = c.oy*H, rr = c.r*Math.min(W,H)*1.6;
    const known = isContinentUnlocked(cid);
    // unregelmäßige Küstenlinie
    g.beginPath();
    const pts = 14;
    for(let i=0;i<=pts;i++){
      const a = (i/pts)*Math.PI*2;
      const wob = 0.78 + ((Math.sin(i*2.3+cid.length)*0.5+0.5))*0.42;
      const px = cx + Math.cos(a)*rr*wob, py = cy + Math.sin(a)*rr*wob*0.82;
      if(i===0) g.moveTo(px,py); else g.lineTo(px,py);
    }
    g.closePath();
    // Brandungssaum
    g.save(); g.strokeStyle='rgba(180,225,220,.35)'; g.lineWidth=4; g.stroke(); g.restore();
    const lg = g.createRadialGradient(cx-rr*0.3,cy-rr*0.3,rr*0.1,cx,cy,rr);
    if(known){ lg.addColorStop(0,'#6f9a52'); lg.addColorStop(1,'#3c6236'); }
    else { lg.addColorStop(0,'#4a5560'); lg.addColorStop(1,'#2b333c'); }
    g.fillStyle=lg; g.fill();
    g.strokeStyle='rgba(20,35,25,.7)'; g.lineWidth=1.4; g.stroke();
    // aktueller Standort
    if(cid===cur){
      g.save();
      const pulse = 0.5+Math.sin(t/420)*0.5;
      g.strokeStyle='rgba(232,169,77,'+(0.5+pulse*0.5)+')'; g.lineWidth=3;
      g.beginPath(); g.arc(cx,cy,rr*1.12,0,Math.PI*2); g.stroke();
      g.restore();
    }
    // Beschriftung
    g.font='800 13px Nunito, sans-serif'; g.textAlign='center';
    g.strokeStyle='rgba(0,0,0,.75)'; g.lineWidth=3.5;
    const label = known ? c.name : '? ? ?';
    g.strokeText(label, cx, cy+4);
    g.fillStyle = known ? '#f2e8cc' : '#9aa5ae';
    g.fillText(label, cx, cy+4);
    if(known && c.danger>0){
      g.font='11px sans-serif';
      g.fillText('💀'.repeat(Math.min(c.danger,4)), cx, cy+19);
    }
    if(cid===cur){
      g.font='800 10px Nunito, sans-serif'; g.fillStyle='#ffd23f';
      g.fillText('▲ hier', cx, cy-rr*0.72);
    }
  });
}
function renderOverworldList(){
  const wrap = document.getElementById('overworldList');
  if(!wrap) return;
  wrap.innerHTML='';
  const cur = currentContinent();
  Object.keys(CONTINENTS).forEach(cid=>{
    const c = CONTINENTS[cid];
    const known = isContinentUnlocked(cid);
    const here = cid===cur;
    const card = document.createElement('button'); card.type='button';
    card.className='owCard'+(here?' here':'')+(known?'':' locked');
    let costTxt = '';
    if(!known && c.cost){
      costTxt = Object.keys(c.cost).map(k=>{
        const have = state.inventory[k]||0;
        const ok = have >= c.cost[k];
        return `<span class="${ok?'owOk':'owMiss'}">${RESOURCE_ICONS[k]||''} ${c.cost[k]}</span>`;
      }).join(' ');
    }
    card.innerHTML =
      `<span class="owName">${known?c.name:'Unbekanntes Land'}${here?' <span class="owHere">· hier</span>':''}</span>` +
      `<span class="owDesc">${known?c.desc:'Eure Karten enden hier. Eine Überfahrt wäre ein Wagnis.'}</span>` +
      (c.danger>0 ? `<span class="owDanger">Gefahr: ${'💀'.repeat(Math.min(c.danger,4))}</span>` : '') +
      (costTxt ? `<span class="owCost">Überfahrt benötigt: ${costTxt}</span>` : '');
    card.onclick = ()=>{ sailTo(cid); };
    if(here) card.disabled = true;
    wrap.appendChild(card);
  });
}
let overworldRaf = null;
function openOverworld(){
  openOverlay('overworldOverlay');
  renderOverworldList();
  const loop = ()=>{
    if(document.getElementById('overworldOverlay').classList.contains('hidden')){ overworldRaf=null; return; }
    drawOverworld();
    overworldRaf = requestAnimationFrame(loop);
  };
  if(!overworldRaf) overworldRaf = requestAnimationFrame(loop);
}
function closeOverworld(){
  closeOverlay('overworldOverlay');
  if(overworldRaf){ cancelAnimationFrame(overworldRaf); overworldRaf=null; }
}

function fastTravel(targetId){
  if(targetId===state.player.regionId){ closeWorldMap(); return; }
  const ctx = getOrCreateRegion(targetId);
  swapAmbientTo(ctx);
  state.player.regionId = targetId;
  if(targetId!=='C') state.visitedOtherRegion = true;
  state.player.x = Math.floor(WORLD_W/2); state.player.y = Math.floor(WORLD_H/2);
  snapMoveAnimToPlayer();
  state.player.path=[]; state.player.target=null; cameraFreeMode=false;
  deselectColonist();
  closeWorldMap();
  const label = targetId==='C' ? (state.colonyName||'Heimat') : REGIONS[targetId].name;
  toast('📍 '+label+' betreten (Schnellreise)');
  updateLocationLabel();
  saveGame();
  checkBiomeLore();
}

/* ============================================================
   Nahtlose Randübergänge: Wer über den Kartenrand läuft, betritt
   die angrenzende Region und erscheint dort auf der Gegenseite.
============================================================ */
let borderCooldown = 0;
function crossRegionBorder(d){
  if(Date.now() < borderCooldown) return;
  const curId = state.player.regionId;
  const cur = (curId==='C') ? REGIONS.C : REGIONS[curId];
  if(!cur){ toast('🧭 Hier endet das bekannte Land.'); return; }
  const cid = continentOf(curId);
  const ngx = cur.gx + d[0], ngy = cur.gy + d[1];
  // Zielregion suchen bzw. erzeugen — innerhalb desselben Kontinents
  let targetId = Object.keys(REGIONS).find(k=>{
    const r = REGIONS[k];
    return r.gx===ngx && r.gy===ngy && continentOf(k)===cid;
  });
  if(!targetId){
    if(cid==='farholm'){
      targetId = ensureRegion(ngx, ngy);
    } else {
      const rng = mulberry32(worldSeedBase + cid.length*7919 + ngx*104729 + ngy*1299709);
      const cont = CONTINENTS[cid];
      const biome = cont.biomes[Math.floor(rng()*cont.biomes.length)];
      const pool = BIOME_NAME_POOL[biome] || ['Unbekanntes Land'];
      targetId = cid+'::'+ngx+'_'+ngy;
      REGIONS[targetId] = { name: pool[Math.floor(rng()*pool.length)], biome, gx:ngx, gy:ngy, continent:cid };
    }
  }
  const ctx = getOrCreateRegion(targetId);
  swapAmbientTo(ctx);
  state.player.regionId = targetId;
  if(targetId!=='C') state.visitedOtherRegion = true;
  // Auf der gegenüberliegenden Seite erscheinen, gleiche Querposition beibehalten
  if(d[0]>0)      state.player.x = 0;
  else if(d[0]<0) state.player.x = WORLD_W-1;
  if(d[1]>0)      state.player.y = 0;
  else if(d[1]<0) state.player.y = WORLD_H-1;
  // Landet man auf unpassierbarem Grund, nächstes freies Feld daneben suchen
  if(!passable(state.player.x, state.player.y)){
    let found=false;
    for(let off=1; off<24 && !found; off++){
      for(const s of [-1,1]){
        const tx = d[0]!==0 ? state.player.x : clamp(state.player.x+off*s,0,WORLD_W-1);
        const ty = d[1]!==0 ? state.player.y : clamp(state.player.y+off*s,0,WORLD_H-1);
        const ax = d[0]!==0 ? tx : tx, ay = d[1]!==0 ? clamp(state.player.y,0,WORLD_H-1) : ty;
        const cx2 = d[0]!==0 ? ax : ax, cy2 = d[0]!==0 ? clamp(state.player.y+off*s,0,WORLD_H-1) : ay;
        if(passable(cx2, cy2)){ state.player.x=cx2; state.player.y=cy2; found=true; break; }
      }
    }
  }
  snapMoveAnimToPlayer();
  state.player.path=[]; state.player.target=null; cameraFreeMode=false;
  deselectColonist();
  borderCooldown = Date.now() + 400;   // verhindert sofortiges Zurückspringen
  const label = targetId==='C' ? (state.colonyName||'Heimat') : REGIONS[targetId].name;
  toast('🧭 '+label+' betreten');
  updateLocationLabel();
  saveGame();
  checkBiomeLore();
}
function attemptKeyMove(dir){
  if(paused || moveAnim.moving) return;
  const d = facingDelta[dir]; if(!d) return;
  state.player.facing = dir;
  state.player.path = []; state.player.target = null;
  const nx = state.player.x + d[0], ny = state.player.y + d[1];
  // Am Kartenrand nahtlos in die Nachbarregion wechseln
  if(nx<0 || ny<0 || nx>=WORLD_W || ny>=WORLD_H){ crossRegionBorder(d); return; }
  const wild = wildMonsters.find(w=>w.x===nx && w.y===ny);
  if(wild){ engageWildMonster(wild); return; }
  if(!passable(nx,ny)) return;
  moveAnim.moving = true; moveAnim.fromX = state.player.x; moveAnim.fromY = state.player.y;
  moveAnim.toX = nx; moveAnim.toY = ny; moveAnim.start = performance.now();
  const stormy = state.weather.type==='storm';
  moveAnim.dur = (state.stats.energy<=0 ? 260 : 150) * (stormy?1.35:1);
}
/* Steht ein NPC in Reichweite? Sucht die vier Nachbarfelder und das eigene
   ab und gibt den nächstgelegenen zurück. */
function npcInReichweite(){
  const px = state.player.x, py = state.player.y;
  const felder = [[0,0],[0,-1],[0,1],[-1,0],[1,0],[-1,-1],[1,-1],[-1,1],[1,1]];
  for(const [dx,dy] of felder){
    const x = px+dx, y = py+dy;
    const o = objAt(x,y);
    if(o && (o.type === 'quest_npc' || o.type === 'visitor')) return { x, y, o };
  }
  return null;
}

function interactKey(){
  if(paused) return;
  /* Gespräch hat Vorrang: steht jemand daneben, will E reden und nicht
     hacken. Vorher kannte die Taste nur Hacken, Trinken und Bauen — mit
     NPCs ließ sich per Tastatur gar nicht sprechen. */
  const nah = npcInReichweite();
  if(nah && nah.o.type === 'quest_npc'){ talkToQuestNpc(nah.x, nah.y, nah.o); return; }
  if(chopOrMine()){ saveGame(); return; }
  if(tryDrink()){ saveGame(); return; }
  if(tryBuildBlueprint()){ saveGame(); return; }
}
function stepPlayerPath(now){
  if(!state.player.path || state.player.path.length===0) return;
  const next = state.player.path[0];
  if(!passable(next.x,next.y)){ state.player.path=[]; state.player.target=null; return; }
  const wild = wildMonsters.find(w=>w.x===next.x && w.y===next.y);
  if(wild){ state.player.path=[]; engageWildMonster(wild); return; }
  state.player.path.shift();
  faceToward(next.x, next.y);
  moveAnim.moving = true; moveAnim.fromX = state.player.x; moveAnim.fromY = state.player.y;
  moveAnim.toX = next.x; moveAnim.toY = next.y; moveAnim.start = now;
  const stormy = state.weather.type==='storm';
  moveAnim.dur = (state.stats.energy<=0 ? 260 : 150) * (stormy?1.35:1);
}
function finishMoveIfDone(now){
  if(!moveAnim.moving) return;
  const t = clamp((now-moveAnim.start)/moveAnim.dur, 0, 1);
  if(t>=1){
    state.player.x = moveAnim.toX; state.player.y = moveAnim.toY; moveAnim.moving = false;
    pickBushIfHere(state.player.x, state.player.y);
    pickGroundItemIfHere(state.player.x, state.player.y);
    checkRegionTransition();
  }
}
function setPlayerTarget(target){
  const adj=[[0,-1],[0,1],[-1,0],[1,0]].map(d=>({x:target.x+d[0],y:target.y+d[1]})).filter(p=>passable(p.x,p.y));
  if(adj.length===0){ toast('Nicht erreichbar.'); return; }
  adj.sort((a,b)=> Math.hypot(a.x-state.player.x,a.y-state.player.y) - Math.hypot(b.x-state.player.x,b.y-state.player.y));
  const dest=adj[0];
  const path = findPath(state.player.x,state.player.y,dest.x,dest.y);
  if(!path){ toast('Kein Weg dorthin gefunden.'); return; }
  state.player.path = path; state.player.target = target;
}

/* ============================================================
   Wild monster wandering
============================================================ */
/* ============================================================
   Dorfbewohner: laufen tagsüber umher, gehen nachts heim ins Bett.
   Der Händler steht tagsüber am Handelsposten und schläft nachts.
============================================================ */
function villagersHere(){
  const c = (state.player.regionId==='C') ? homeCtx : regionsRegistry[state.player.regionId];
  return (c && c.villagers) ? c.villagers : [];
}
function updateVillagers(now){
  const list = villagersHere();
  if(!list.length) return;
  const phase = dayPhaseNow();
  // Drei Tagesabschnitte statt nur Tag/Nacht
  const evening = phase >= 0.68 && phase < 0.84;   // Feierabend am Feuer
  const night = isNightNow() && !evening;
  const ctxR = (state.player.regionId==='C') ? homeCtx : regionsRegistry[state.player.regionId];
  const gather = (ctxR && ctxR.villageCenter) ? ctxR.villageCenter : null;
  list.forEach(v=>{
    const interval = night ? 900 : (evening ? 1100 : 1400);
    if(now - v.lastMove < interval) return;
    v.lastMove = now;
    let tx, ty;
    if(evening && gather && !v.isTrader){
      // Abends treffen sich die Bewohner in der Dorfmitte
      v.sleeping = false;
      const seat = (v.name.charCodeAt(0) % 6);
      tx = gather.x + [0,2,-2,1,-1,2][seat];
      ty = gather.y + [2,1,1,-1,-2,-1][seat];
      if(v.x===tx && v.y===ty){ v.atGathering = true; return; }
      v.atGathering = false;
    } else if(night){
      // nachts: heim ins Bett
      tx = v.bedX!==undefined ? v.bedX : v.homeX;
      ty = v.bedY!==undefined ? v.bedY : v.homeY;
      if(v.x===tx && v.y===ty){ v.sleeping = true; return; }
      v.sleeping = false;
    } else {
      v.sleeping = false;
      if(v.isTrader){
        // Händler zurück an den Posten
        tx = v.postX; ty = v.postY;
        if(v.x===tx && v.y===ty) return;
      } else {
        // tagsüber gemächlich um das eigene Haus streifen
        if(Math.random()<0.4) return;
        const dirs = [[0,1],[0,-1],[1,0],[-1,0]];
        const d = dirs[Math.floor(Math.random()*dirs.length)];
        const nx = v.x+d[0], ny = v.y+d[1];
        const dist = Math.hypot(nx-v.homeX, ny-v.homeY);
        if(dist<9 && passable(nx,ny) && !list.some(o=>o!==v && o.x===nx && o.y===ny)){ v.x=nx; v.y=ny; }
        return;
      }
    }
    // Zielgerichteter Schritt (einfaches Verfolgen, weicht Hindernissen seitlich aus)
    const stepX = tx>v.x?1:(tx<v.x?-1:0), stepY = ty>v.y?1:(ty<v.y?-1:0);
    const tries = Math.abs(tx-v.x) > Math.abs(ty-v.y)
      ? [[stepX,0],[0,stepY],[0,stepY?stepY:1],[0,-1]]
      : [[0,stepY],[stepX,0],[stepX?stepX:1,0],[-1,0]];
    for(const [dx,dy] of tries){
      if(!dx && !dy) continue;
      const nx=v.x+dx, ny=v.y+dy;
      const o = objAt(nx,ny);
      const isDoorOrFloor = o && (o.type==='vdoor'||o.type==='vfloor');
      if((isDoorOrFloor || passable(nx,ny)) && !list.some(q=>q!==v && q.x===nx && q.y===ny)){
        v.x=nx; v.y=ny; break;
      }
    }
  });
}
function drawVillagers(now){
  const list = villagersHere();
  list.forEach(v=>{
    const sx = (v.x-camera.x)*TILE, sy = (v.y-camera.y)*TILE;
    if(sx<-TILE || sx>canvas.width+TILE || sy<-TILE || sy>canvas.height+TILE) return;
    const px = sx+TILE/2, py = sy+TILE/2;
    if(v.sleeping){
      // schlafend: nur ein Zzz über dem Bett
      ctx.save(); ctx.globalAlpha = 0.55+Math.sin(now/700)*0.25;
      ctx.fillStyle='#cfe0ff'; ctx.font='bold 11px sans-serif'; ctx.textAlign='center';
      ctx.fillText('z', px+6, py-10+Math.sin(now/500)*2);
      ctx.font='bold 8px sans-serif'; ctx.fillText('z', px+11, py-15+Math.sin(now/500+1)*2);
      ctx.restore();
      return;
    }
    ctx.save(); ctx.translate(px, py+4);
    if(v.appearance) drawHumanoidBody(ctx, v.appearance, 1.05, null, null, false, null);
    ctx.restore();
    // Händler bekommt ein Marker-Symbol
    if(v.isTrader){
      ctx.save(); ctx.globalAlpha=0.8+Math.sin(now/420)*0.2;
      ctx.font='11px sans-serif'; ctx.textAlign='center';
      ctx.fillText('🪙', px, py-16); ctx.restore();
    }
  });
}
/* --- Gespräche: mehrschichtige Texte statt Einzeiler --- */
const VILLAGER_TALK = {
  'Bäckerin':[
    'Der Ofen ist seit dem Morgengrauen an. Wenn der Wind von Osten kommt, riecht das halbe Dorf nach Brot — und dann stehen sie alle vor meiner Tür.',
    'Mein Vater hat hier gebacken, und sein Vater davor. Wir haben drei Überfälle überstanden. Der Ofen ist älter als jede Mauer hier.',
    'Getreide wird knapp. Die Felder im Norden tragen nicht mehr wie früher — irgendetwas im Boden hat sich verändert, seit die Ruinen freigelegt wurden.'
  ],
  'Schmied':[
    'Gutes Eisen singt, wenn man es trifft. Schlechtes klirrt nur. Hör genau hin, dann weißt du, was du in der Hand hältst.',
    'Ich habe Klingen für Leute geschmiedet, die nicht zurückkamen. Manche hängen noch bei mir an der Wand — abgeholt hat sie nie jemand.',
    'Bring mir Kupfer und Silber, und ich zeige dir, was daraus wird. Aber Titanerz — davon lass die Finger, wenn du nicht weißt, woher es kommt.'
  ],
  'Weberin':[
    'Jeder Faden hat seine Richtung. Zwingst du ihn, reißt er. Das gilt für Stoff wie für Menschen.',
    'Die Muster hier im Dorf erzählen Geschichten. Diese Raute bedeutet Heimkehr. Ich webe sie in jeden Mantel, der ins Wildholz geht.',
    'Faser aus dem Moor ist zäher, aber sie riecht monatelang nach Sumpf. Die Jäger nehmen sie trotzdem — sie hält Regen ab wie nichts sonst.'
  ],
  'Jäger':[
    'Die Wesen im Wildholz sind nicht wild geworden. Sie waren immer so. Wir haben nur vergessen, wie man sich benimmt.',
    'Nachts ändern sie sich. Was tagsüber vor dir flieht, steht im Dunkeln still und schaut zurück. Geh nicht allein nach Sonnenuntergang.',
    'Ich lege keine Fallen mehr für alles. Nur für das, was ich auch esse. Alles andere ist Verschwendung — und es merkt sich so etwas.'
  ],
  'Kräuterfrau':[
    'Drei Blätter Wundkraut, in kaltem Wasser gezogen, nicht gekocht. Kochst du es, tötest du genau das, wofür du es sammelst.',
    'Ich habe mehr Leute wieder auf die Beine gebracht als der Schmied Klingen gemacht hat. Nur redet darüber niemand.',
    'Bei den Ruinen wächst etwas, das ich nicht kenne. Blaue Blüten, die sich nachts schließen. Ich lasse die Finger davon — vorerst.'
  ],
  'Fischer':[
    'Der See gibt, was er will. Manche Tage nichts, manche Tage mehr, als der Kahn trägt. Streiten hilft nicht.',
    'Ganz unten, wo das Wasser dunkel wird, bewegt sich etwas Großes. Ich fahre da nicht mehr raus. Zweimal hat mein Netz gerissen — beim dritten Mal wäre ich mitgegangen.',
    'Salz und Rauch, das ist alles. So hält der Fang bis in den Winter. Frisch schmeckt er besser, aber im Frost zählt nur, was noch da ist.'
  ],
  'Zimmermann':[
    'Kiefer für Dächer, Dunkelholz für Balken. Wer das vertauscht, baut ein Haus für einen Winter statt für ein Leben.',
    'Ich habe die halbe Siedlung hier hochgezogen. Jedes Haus hat meinen Namen unter der Schwelle — das machen wir so, seit ich Lehrling war.',
    'Bruchholz wirft niemand weg. Daraus werden Schemel, Griffe, Zaunlatten. Verschwendung ist der Anfang vom Hunger.'
  ],
  'Töpferin':[
    'Der Ton hier hat viel Eisen. Deshalb sind meine Krüge rot statt grau — man erkennt sie noch drei Dörfer weiter.',
    'Ein Riss beim Brennen bedeutet, dass ich zu schnell war. Der Ofen verzeiht vieles, aber keine Eile.',
    'Ich mache auch Urnen. Darüber redet man nicht gern, aber jemand muss es tun, und meine halten.'
  ],
  'Händler':[
    'Ich reise die Runde: Farholt, Alt-Farholt, dann die Küstendörfer. Zwei Wochen, wenn die Wege trocken sind. Vier, wenn nicht.',
    'Gold ist nicht das Wertvollste, was ich mitführe. Nachrichten sind es. Und die gebe ich billiger her als Silber.',
    'Ich handle mit jedem, der ehrlich zahlt. Was du mit den Waren machst, geht mich nichts an — solange du wiederkommst.'
  ]
};
const VILLAGER_SMALLTALK = [
  'Bleib nicht zu lange draußen, wenn das Licht geht.',
  'Farholt ist einen Tagesmarsch entfernt. Der Weg ist sicher — meistens.',
  'Wenn du etwas zu handeln hast, der Posten ist mitten im Dorf.',
  'Die Alten sagen, das Dorf stand schon vor den Ruinen hier. Ich glaube, es war umgekehrt.'
];
/* --- Ladengeschäft: eigenes Sortiment je Beruf --- */
function openShop(v){
  const sh = SHOP_TYPES[v.shop];
  if(!sh) return;
  const affordable = (t)=> Object.keys(t.give).every(k=>(state.inventory[k]||0) >= t.give[k]);
  const choices = sh.trades.map(t=>({
    label: t.label + (affordable(t) ? '' : '  (zu wenig)'),
    disabled: !affordable(t),
    action: ()=>{
      Object.keys(t.give).forEach(k=>{ state.inventory[k] -= t.give[k]; bumpResource(k); });
      Object.keys(t.get).forEach(k=>{ addResource(k, t.get[k]); bumpResource(k); });
      sfxCraft(); updateHUD(); saveGame();
      toast('🤝 Handel abgeschlossen bei '+v.name+'.');
      logEvent(`${sh.sign} Handel in der ${sh.name}: ${t.label}`);
      openShop(v);   // Laden bleibt offen für weitere Geschäfte
    }
  }));
  choices.push({label:'Laden verlassen', secondary:true, action:()=>{}});
  showStoryDialog(`${sh.sign} ${sh.name} · ${v.name}`, sh.greet, choices);
}
/* --- Aufträge: Bewohner bitten um Material, zahlen mit Waren und Gold --- */
const VILLAGE_TASKS = [
  {need:{wood:8},    pay:{gold:2, planks:2},  text:'Der Winter kommt und mein Holzvorrat reicht nicht. Bringst du mir {n}?'},
  {need:{stone:10},  pay:{gold:3},            text:'Die Mauer am Westrand bröckelt. Für {n} wäre ich dir sehr verbunden.'},
  {need:{kraeuter:4},pay:{potion:2, gold:1},  text:'Das halbe Dorf hustet. Ich bräuchte dringend {n}.'},
  {need:{berries:6}, pay:{cloth:2, gold:1},   text:'Für das Erntefest fehlen mir noch {n}. Hilfst du aus?'},
  {need:{metal:4},   pay:{gold:5},            text:'Mein Werkzeug ist durch. Ohne {n} kann ich nicht weiterarbeiten.'},
  {need:{fiber:8},   pay:{cloth:3, gold:2},   text:'Der Webstuhl steht still. Bring mir {n}, dann läuft es wieder.'}
];
function taskLabel(obj){
  return Object.keys(obj).map(k=>`${obj[k]} ${RESOURCE_ICONS[k]||''} ${RESOURCE_NAMES[k]||k}`).join(' und ');
}
function villagerTaskFor(v){
  if(!v.task){
    // Auftrag deterministisch aus dem Namen ableiten, bleibt also gleich
    const idx = (v.name.charCodeAt(0) + v.name.length*7) % VILLAGE_TASKS.length;
    v.task = { ...VILLAGE_TASKS[idx], done:false };
  }
  return v.task;
}
function offerVillagerTask(v){
  const t = villagerTaskFor(v);
  if(t.done){
    showStoryDialog(`${v.name} · ${v.job}`,
      'Du hast mir schon geholfen — das vergesse ich nicht. Wenn du wieder vorbeikommst, ist immer ein Platz am Feuer für dich frei.',
      [{label:'Verabschieden', action:()=>{}}]);
    return;
  }
  const can = Object.keys(t.need).every(k=>(state.inventory[k]||0) >= t.need[k]);
  const choices = [];
  if(can){
    choices.push({label:'✔ '+taskLabel(t.need)+' übergeben', action:()=>{
      Object.keys(t.need).forEach(k=>{ state.inventory[k] -= t.need[k]; bumpResource(k); });
      Object.keys(t.pay).forEach(k=>{ addResource(k, t.pay[k]); bumpResource(k); });
      t.done = true;
      sfxBuildDone(); updateHUD(); saveGame();
      toast('🤝 Auftrag erfüllt — '+taskLabel(t.pay)+' erhalten.');
      logEvent(`📜 Auftrag für ${v.name} erfüllt: ${taskLabel(t.need)} gegen ${taskLabel(t.pay)}.`);
    }});
  } else {
    choices.push({label:'Dir fehlt: '+taskLabel(t.need), disabled:true, action:()=>{}});
  }
  choices.push({label:'Später wiederkommen', secondary:true, action:()=>{}});
  showStoryDialog(`📜 ${v.name} bittet um Hilfe`,
    t.text.replace('{n}', taskLabel(t.need)) + `\n\nAls Dank: ${taskLabel(t.pay)}.`,
    choices);
}
function talkToVillager(v){
  const pool = VILLAGER_TALK[v.job] || VILLAGER_SMALLTALK;
  const idx = (v.talkIdx||0) % pool.length;
  v.talkIdx = idx+1;
  const first = !v.greeted; v.greeted = true;
  const intro = first
    ? `${v.name} hebt den Blick und mustert dich kurz. "Fremdes Gesicht. Willkommen in unserer Siedlung."\n\n`
    : '';
  const extra = (v.talkIdx>=pool.length)
    ? `\n\n— ${v.name} nickt dir zu und wendet sich wieder der Arbeit zu.`
    : '';
  /* Auswahlmenü statt reinem Vorlesen. Handeln erscheint nur bei Händlern —
     der Laden existierte zwar, war über das Gespräch aber gar nicht
     erreichbar, obwohl der Händler ein 🪙 über dem Kopf trägt. */
  const opts = [{label:'Verabschieden', secondary:true, action:()=>{}}];
  const t = villagerTaskFor(v);
  if(!t.done) opts.unshift({label:'📜 Kann ich dir helfen?', action:()=>offerVillagerTask(v)});
  if(v.isTrader) opts.unshift({label:'🪙 Handeln', action:()=>openVillageShop()});
  opts.unshift({label:'💬 Weiter plaudern', action:()=>talkToVillager(v)});
  showStoryDialog(`${v.name} · ${v.job}`, intro + pool[idx] + extra, opts);
}

function updateWildMonsters(now){
  wildMonsters.forEach(w=>{
    if(now - w.lastMove < 700) return;
    w.lastMove = now; if(Math.random()<0.35) return;
    const dirs = Object.values(facingDelta);
    const d = dirs[Math.floor(Math.random()*dirs.length)];
    const nx = w.x+d[0], ny=w.y+d[1];
    if(passable(nx,ny) && !wildMonsters.some(o=>o!==w && o.x===nx && o.y===ny)){ w.x = nx; w.y = ny; }
  });
  updateVillagers(now);
  const spawnChance = isNightNow() ? 0.025 : 0.014;
  const spawnFloor = isNightNow() ? 18 : 12;
  if(!state.raid && wildMonsters.length<spawnFloor && Math.random()<spawnChance) trySpawnWild();
}

/* ============================================================
   Zeitgeber der Weltkarte
   Wird von main.js aufgerufen, sobald die Seite steht.
============================================================ */
function initWorldMapTimers(){
  setInterval(()=>{
    if(paused) return;
    const target = state.player.target;
    if(!target) return;
    if(moveAnim.moving || (state.player.path && state.player.path.length>0)) return;
    const dist = Math.abs(state.player.x-target.x)+Math.abs(state.player.y-target.y);
    if(dist>1){ state.player.target=null; return; }
    faceToward(target.x, target.y);
    if(target.type==='gather'){
      const o=objAt(target.x,target.y);
      if(!o){ state.player.target=null; return; }
      chopOrMine(); saveGame();
    } else if(target.type==='drink'){
      tryDrink(); state.player.target=null; saveGame();
    } else if(target.type==='build'){
      const bp = state.buildings.find(b=>b.x===target.x&&b.y===target.y&&(b.regionId||'C')===state.player.regionId);
      if(!bp || bp.built){ state.player.target=null; return; }
      tryBuildBlueprint(); saveGame();
    } else if(target.type==='monster'){
      const wm = wildMonsters.find(w=>w.uid===target.uid);
      if(!wm){ state.player.target=null; return; }
      state.player.target=null; engageWildMonster(wm);
    } else if(target.type==='enter'){
      const b = state.buildings.find(bb=>bb.id===target.buildingId);
      state.player.target=null;
      if(b && b.built) openBuildingInterior(b);
    } else if(target.type==='harvest_field'){
      const b = state.buildings.find(bb=>bb.id===target.buildingId);
      state.player.target=null;
      if(b && b.built) harvestField(b);
    }
  }, 450);
}

/* ---------- Rückschreibe-Setter für die globale Brücke ----------
   Diese Bindings werden von anderen Modulen überschrieben. Ohne diese
   Funktionen käme die Zuweisung hier nie an und dieses Modul würde mit
   einem veralteten Wert weiterarbeiten. Siehe bridgeModule() in main.js. */
function __set_macroMode(v){ macroMode = v; }

export {
  npcInReichweite,
  __set_macroMode,

  initWorldMapTimers,
  CONTINENTS,
  MACRO_BIOME_COL,
  MACRO_H,
  MACRO_TILE,
  MACRO_W,
  SITE_ICON,
  VILLAGER_SMALLTALK,
  VILLAGER_TALK,
  VILLAGE_TASKS,
  attemptKeyMove,
  borderCooldown,
  buildMacroMap,
  canAffordVoyage,
  closeOverworld,
  continentOf,
  crossRegionBorder,
  currentContinent,
  drawMacro,
  drawOverworld,
  drawVillagers,
  ensureContinentRegions,
  enterMacroMap,
  exitMacroMap,
  fastTravel,
  finishMoveIfDone,
  hasShip,
  interactKey,
  isContinentUnlocked,
  isShoreTile,
  macroEnter,
  macroMap,
  macroMode,
  macroMove,
  macroPassable,
  macroPlayer,
  macroPlayerStart,
  macroSiteAt,
  macroTileAt,
  offerVillagerTask,
  onShip,
  openOverworld,
  openShop,
  overworldRaf,
  payVoyage,
  renderOverworldList,
  sailTo,
  setPlayerTarget,
  shipAnchor,
  stepPlayerPath,
  talkToVillager,
  taskLabel,
  toggleShip,
  updateVillagers,
  updateWildMonsters,
  villagerTaskFor,
  villagersHere
};
