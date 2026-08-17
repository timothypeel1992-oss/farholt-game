/* ============================================================
   engine/renderer.js — Darstellung
   Alles Zeichnen: Geländekacheln mit weichen Übergängen, der
   prozedurale Sprite-Zwischenspeicher, Gebäude in Dreiviertel-
   Ansicht mit sichtbarer Betriebsamkeit, sowie die männlichen
   und weiblichen Figurenmodelle.

   Kampfszene und Statuseffekte liegen bewusst nicht hier —
   sie gehören zur Kampfsteuerung in ui/interface.js.
============================================================ */
import { DAY_CYCLE_MS, HAIR_SHAPES, clamp, hash2, lerp, mulberry32 } from './rng.js';
import { TILE, VIEW_W, VIEW_H, WORLD_W, WORLD_H,
         TILE_WATER, TILE_SAND, TILE_GRASS, objAt, passable, atHome, atDungeon } from './world.js';
import { SPECIES, TYPE_COLORS, TYPE_PALETTE, drawMonster, RARITY_AURA, RARITY_SIZE } from '../data/species.js';

/* ============================================================
   Zeichenfläche
   Das Modul bindet sich nicht selbst an ein Canvas, sondern
   bekommt es von außen zugewiesen. So lässt es sich auch ohne
   Browser laden und prüfen.
============================================================ */
/* Skaliert die Zeichenflaeche auf die groesste Flaeche, die im Buehnenbereich
   Platz hat und das Seitenverhaeltnis der internen Aufloesung (800x480) haelt.
   Der Rest bleibt als Rand stehen. Rein per CSS geht das nicht zuverlaessig:
   width/height in Prozent zerren das Bild, object-fit wuerde zwar richtig
   aussehen, aber getBoundingClientRect lieferte dann die ungenutzte Randflaeche
   mit — und die Klickumrechnung in ui/input.js rechnet genau damit. */
function fitCanvasToStage(){
  if(!canvas) return;
  const stage = canvas.parentElement;
  if(!stage) return;
  const bw = stage.clientWidth, bh = stage.clientHeight;
  if(!bw || !bh) return;
  const scale = Math.min(bw / canvas.width, bh / canvas.height);
  const w = Math.max(1, Math.round(canvas.width  * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  canvas.style.left   = Math.round((bw - w) / 2) + 'px';
  canvas.style.top    = Math.round((bh - h) / 2) + 'px';
  return { w, h };
}

let ctx = null;
let canvas = null;

/* Bindet die Zeichenflaeche und veroeffentlicht Kontext + Canvas sofort
   global. Wichtig: die Bruecke in main.js reicht Modulexporte weiter —
   ohne diese beiden Zuweisungen bliebe globalThis.ctx auf null stehen,
   weil ctx zum Ladezeitpunkt noch nicht existiert. */
function attachCanvas(el){
  const target = (typeof el === 'string')
    ? document.getElementById(el)
    : (el || document.getElementById('game'));

  if(!target){
    throw new Error('[renderer] Canvas nicht gefunden — erwartet <canvas id="game"> in index.html.');
  }
  if(typeof target.getContext !== 'function'){
    throw new Error('[renderer] Element "'+(target.id || target.tagName)+'" ist kein <canvas>.');
  }
  const c2d = target.getContext('2d');
  if(!c2d){
    throw new Error('[renderer] 2D-Kontext konnte nicht erzeugt werden (Canvas evtl. schon anderweitig belegt).');
  }

  canvas = target;
  ctx = c2d;
  /* Ohne Kantenglättung bleiben zwischengespeicherte Sprites beim drawImage
     scharf und erzeugen keine halbtransparenten Ränder, die als Fuge
     zwischen den Kacheln sichtbar würden. */
  ctx.imageSmoothingEnabled = false;
  globalThis.ctx = ctx;
  globalThis.canvas = canvas;

  // Einmal passend einrichten und danach bei jeder Groessenaenderung nachziehen
  fitCanvasToStage();
  if(typeof ResizeObserver === 'function' && canvas.parentElement){
    try{ new ResizeObserver(()=>fitCanvasToStage()).observe(canvas.parentElement); }catch(e){}
  }
  window.addEventListener('resize', fitCanvasToStage);
  window.addEventListener('orientationchange', fitCanvasToStage);
  document.addEventListener('fullscreenchange', ()=>setTimeout(fitCanvasToStage, 60));

  return ctx;
}

function getCtx(){ return ctx; }
function getCanvas(){ return canvas; }
function ctxReady(){ return ctx !== null; }

function drawTile(x,y,screenX,screenY){
  /* Die Grundflächen werden bewusst einen Pixel zu groß gezeichnet. Beim
     Hochskalieren der Zeichenfläche auf die Bildschirmgröße fallen
     Kachelkanten nicht immer auf ganze Bildschirmpixel; die Überlappung
     deckt die entstehende Fuge ab. Nachbarkacheln überschreiben den
     Überstand ohnehin. */
  if(atDungeon()){
    const isCave = dungeonCtx && dungeonCtx.instanceType==='cave';
    const t = tileAt(x,y);
    if(t===TILE_WATER){
      ctx.fillStyle = isCave ? '#1a1410' : '#26221c'; ctx.fillRect(screenX,screenY,TILE+1,TILE+1);
      ctx.strokeStyle='rgba(0,0,0,.35)'; ctx.lineWidth=1; ctx.strokeRect(screenX+1,screenY+1,TILE-2,TILE-2);
      if(isCave){ ctx.strokeStyle='rgba(0,0,0,.5)'; ctx.lineWidth=1.2; ctx.beginPath(); ctx.moveTo(screenX+4,screenY+8); ctx.lineTo(screenX+14,screenY+22); ctx.stroke(); }
    } else {
      const shade = hash2(x,y,(dungeonCtx?dungeonCtx.seed:1)*3+1);
      if(isCave){
        ctx.fillStyle = shade>0.6 ? '#5c4a36' : (shade>0.3 ? '#4f3f2e' : '#453527');
      } else {
        ctx.fillStyle = shade>0.6 ? '#4a463e' : (shade>0.3 ? '#433f38' : '#3c3832');
      }
      ctx.fillRect(screenX,screenY,TILE+1,TILE+1);
      ctx.strokeStyle='rgba(0,0,0,.15)'; ctx.lineWidth=1;
      ctx.strokeRect(screenX,screenY,TILE,TILE);
      if(isCave && shade>0.7){ ctx.fillStyle='rgba(111,160,53,.25)'; ctx.beginPath(); ctx.arc(screenX+10,screenY+20,3,0,Math.PI*2); ctx.fill(); }
      if(shade>0.92){ ctx.fillStyle='rgba(0,0,0,.2)'; ctx.fillRect(screenX+9,screenY+9,5,3); }
      if(shade>0.8 && shade<0.87){
        const cx2=screenX+16, cy2=screenY+16;
        ctx.fillStyle = isCave ? '#3a2e20' : '#2a2620';
        ctx.beginPath(); ctx.moveTo(cx2-7,cy2+6); ctx.lineTo(cx2-4,cy2-4); ctx.lineTo(cx2+2,cy2-7); ctx.lineTo(cx2+7,cy2+3); ctx.lineTo(cx2+3,cy2+7); ctx.closePath(); ctx.fill();
        ctx.strokeStyle='rgba(0,0,0,.35)'; ctx.lineWidth=1; ctx.stroke();
        ctx.strokeStyle='rgba(255,255,255,.1)'; ctx.lineWidth=0.8;
        ctx.beginPath(); ctx.moveTo(cx2-4,cy2-4); ctx.lineTo(cx2+2,cy2-7); ctx.stroke();
      }
    }
    if(hoverTile && hoverTile.x===x && hoverTile.y===y && !paused){
      ctx.save(); ctx.strokeStyle='rgba(255,255,255,.5)'; ctx.lineWidth=1.4; ctx.strokeRect(screenX+1,screenY+1,TILE-2,TILE-2); ctx.restore();
    }
    return;
  }
  const t = tileAt(x,y);
  const shade = hash2(x,y,worldSeed*3+1);
  // Weiche, über Kachelgrenzen interpolierte Variation (verhindert Schachbrettmuster)
  const smoothCell = (cell, salt) => {
    const gx = x/cell, gy = y/cell;
    const gx0 = Math.floor(gx), gy0 = Math.floor(gy);
    const sm = v => v*v*(3-2*v);
    const fx = sm(gx-gx0), fy = sm(gy-gy0);
    const a = hash2(gx0,gy0,salt), b = hash2(gx0+1,gy0,salt);
    const c = hash2(gx0,gy0+1,salt), d = hash2(gx0+1,gy0+1,salt);
    const top = a+(b-a)*fx, bot = c+(d-c)*fx;
    return top+(bot-top)*fy;
  };
  if(t===TILE_WATER){
    const tms = performance.now();
    const depth = smoothCell(5, worldSeed*37);
    // Nachbarschaft bestimmen -> Ufer wird abgerundet statt hart rechteckig
    const wN = tileAt(x,y-1)===TILE_WATER, wS = tileAt(x,y+1)===TILE_WATER;
    const wW = tileAt(x-1,y)===TILE_WATER, wE = tileAt(x+1,y)===TILE_WATER;
    // Untergrund (Land) zuerst, damit die abgerundeten Ecken Land zeigen
    if(!(wN&&wS&&wW&&wE)){
      const landPal = PALETTE_GRASS[currentBiome] || PALETTE_GRASS.wildwood;
      const nearSand = tileAt(x-1,y)===TILE_SAND||tileAt(x+1,y)===TILE_SAND||tileAt(x,y-1)===TILE_SAND||tileAt(x,y+1)===TILE_SAND;
      ctx.fillStyle = nearSand ? '#d8c489' : landPal[1];
      ctx.fillRect(screenX,screenY,TILE+1,TILE+1);
    }
    // Wasserfläche als Pfad mit abgerundeten Ecken an Landseiten
    const R = 11; // Rundungsradius am Ufer
    const L=screenX, T=screenY, Rt=screenX+TILE, B=screenY+TILE;
    const rTL = (!wN && !wW) ? R : 0, rTR = (!wN && !wE) ? R : 0;
    const rBR = (!wS && !wE) ? R : 0, rBL = (!wS && !wW) ? R : 0;
    const waterPath = new Path2D();
    waterPath.moveTo(L+rTL, T);
    waterPath.lineTo(Rt-rTR, T);
    if(rTR) waterPath.quadraticCurveTo(Rt, T, Rt, T+rTR); else waterPath.lineTo(Rt, T);
    waterPath.lineTo(Rt, B-rBR);
    if(rBR) waterPath.quadraticCurveTo(Rt, B, Rt-rBR, B); else waterPath.lineTo(Rt, B);
    waterPath.lineTo(L+rBL, B);
    if(rBL) waterPath.quadraticCurveTo(L, B, L, B-rBL); else waterPath.lineTo(L, B);
    waterPath.lineTo(L, T+rTL);
    if(rTL) waterPath.quadraticCurveTo(L, T, L+rTL, T); else waterPath.lineTo(L, T);
    waterPath.closePath();
    ctx.fillStyle = mixHex('#296266','#3a7d82', depth);
    ctx.fill(waterPath);
    ctx.save();
    ctx.clip(waterPath);
    // animierte Wellenlinien (auf die Wasserform geclippt)
    ctx.lineCap='round';
    for(let w=0; w<2; w++){
      const yOff = TILE*(0.32+w*0.34);
      const ph = tms/(700+w*260) + x*0.7 + y*0.45 + w*1.7;
      ctx.strokeStyle = w===0 ? 'rgba(255,255,255,.15)' : 'rgba(255,255,255,.07)';
      ctx.lineWidth = w===0 ? 1.3 : 1;
      ctx.beginPath();
      for(let px=0; px<=TILE; px+=4){
        const wy = screenY + yOff + Math.sin(ph + px*0.22)*1.8;
        if(px===0) ctx.moveTo(screenX+px, wy); else ctx.lineTo(screenX+px, wy);
      }
      ctx.stroke();
    }
    // Flachwasser-Saum: an Landkanten heller, gibt Tiefenwirkung zum Ufer hin
    const rim = 7;
    if(!wN){ const g2=ctx.createLinearGradient(0,T,0,T+rim); g2.addColorStop(0,'rgba(150,215,215,.34)'); g2.addColorStop(1,'rgba(150,215,215,0)'); ctx.fillStyle=g2; ctx.fillRect(L,T,TILE,rim); }
    if(!wS){ const g2=ctx.createLinearGradient(0,B,0,B-rim); g2.addColorStop(0,'rgba(150,215,215,.34)'); g2.addColorStop(1,'rgba(150,215,215,0)'); ctx.fillStyle=g2; ctx.fillRect(L,B-rim,TILE,rim); }
    if(!wW){ const g2=ctx.createLinearGradient(L,0,L+rim,0); g2.addColorStop(0,'rgba(150,215,215,.34)'); g2.addColorStop(1,'rgba(150,215,215,0)'); ctx.fillStyle=g2; ctx.fillRect(L,T,rim,TILE); }
    if(!wE){ const g2=ctx.createLinearGradient(Rt,0,Rt-rim,0); g2.addColorStop(0,'rgba(150,215,215,.34)'); g2.addColorStop(1,'rgba(150,215,215,0)'); ctx.fillStyle=g2; ctx.fillRect(Rt-rim,T,rim,TILE); }
    // vereinzelte Lichtreflexe auf tieferem Wasser
    if(depth>0.62){
      const gl = 0.5+Math.sin(tms/540 + x*1.3 + y*0.9)*0.5;
      ctx.fillStyle = `rgba(255,255,255,${0.05+gl*0.09})`;
      ctx.beginPath(); ctx.ellipse(screenX+TILE*0.62,screenY+TILE*0.42,3.2,1.3,0.5,0,Math.PI*2); ctx.fill();
    }
    ctx.restore();
    // sanfte Uferlinie (Schaumkante) an Landseiten
    ctx.save(); ctx.strokeStyle='rgba(215,240,235,.3)'; ctx.lineWidth=1.4;
    ctx.stroke(waterPath); ctx.restore();
  } else if(t===TILE_SAND){
    const dry = smoothCell(4, worldSeed*43);
    ctx.fillStyle = mixHex('#d3bd80','#dcc98f', dry);
    ctx.fillRect(screenX,screenY,TILE+1,TILE+1);
    // feine Sandkörnung + gelegentliche Rippelmarken
    for(let s=0;s<3;s++){
      const sh = hash2(x*11+s*5, y*11+s*7, worldSeed*19+s);
      if(sh>0.5){
        ctx.fillStyle = sh>0.75 ? 'rgba(255,255,255,.07)' : 'rgba(120,95,50,.1)';
        ctx.beginPath(); ctx.arc(screenX+((sh*191+s*53)%TILE), screenY+((sh*113+s*37)%TILE), 0.85, 0, Math.PI*2); ctx.fill();
      }
    }
    if(shade>0.72){
      ctx.strokeStyle='rgba(120,95,50,.13)'; ctx.lineWidth=0.9;
      ctx.beginPath();
      ctx.moveTo(screenX+3, screenY+TILE*0.6);
      ctx.quadraticCurveTo(screenX+TILE*0.5, screenY+TILE*0.5, screenX+TILE-3, screenY+TILE*0.64);
      ctx.stroke();
    }
    // Strand-Deko: näher am Wasser häufiger (Muscheln, Treibholz, Algen)
    const atWater = tileAt(x-1,y)===TILE_WATER||tileAt(x+1,y)===TILE_WATER||tileAt(x,y-1)===TILE_WATER||tileAt(x,y+1)===TILE_WATER;
    const dh = hash2(x,y,worldSeed*107);
    if(dh > (atWater ? 0.74 : 0.93)){
      const dx2 = screenX + 6 + ((dh*167)%18), dy2 = screenY + 8 + ((dh*211)%16);
      const kind = Math.floor(dh*1000)%3;
      if(kind===0){
        // Muschel
        ctx.fillStyle='#f0e2cf'; ctx.beginPath(); ctx.ellipse(dx2,dy2,3,2.4,0.3,0,Math.PI*2); ctx.fill();
        ctx.strokeStyle='rgba(170,140,110,.6)'; ctx.lineWidth=0.6;
        for(let f=-1;f<=1;f++){ ctx.beginPath(); ctx.moveTo(dx2-0.4,dy2+1.8); ctx.lineTo(dx2+f*2,dy2-1.8); ctx.stroke(); }
      } else if(kind===1){
        // Treibholz
        ctx.strokeStyle='#a08967'; ctx.lineWidth=2.2; ctx.lineCap='round';
        ctx.beginPath(); ctx.moveTo(dx2-4,dy2+1); ctx.lineTo(dx2+4,dy2-1.5); ctx.stroke();
        ctx.strokeStyle='rgba(255,255,255,.2)'; ctx.lineWidth=0.7;
        ctx.beginPath(); ctx.moveTo(dx2-3.5,dy2+0.3); ctx.lineTo(dx2+3.5,dy2-2); ctx.stroke();
      } else {
        // angespülte Algen
        ctx.strokeStyle='rgba(90,120,70,.65)'; ctx.lineWidth=1.2; ctx.lineCap='round';
        ctx.beginPath(); ctx.moveTo(dx2-3,dy2+2); ctx.quadraticCurveTo(dx2,dy2-1,dx2+3,dy2+1.5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(dx2-1,dy2+2.5); ctx.quadraticCurveTo(dx2+1.5,dy2,dx2+4,dy2+2); ctx.stroke();
      }
    }
  } else {
    const pal = PALETTE_GRASS[currentBiome] || PALETTE_GRASS.wildwood;
    const distHi = Math.hypot(x-highlandAnchor.x,y-highlandAnchor.y);
    const distMe = Math.hypot(x-meadowAnchor.x,y-meadowAnchor.y);
    // Weiche, über Kachelgrenzen hinweg interpolierte Variation statt harter Dreistufen-Umschaltung.
    // Große Zellgröße -> sehr flacher Farbverlauf, dadurch keine sichtbaren Stufen pro Kachel.
    const lush = smoothCell(9, worldSeed*29);
    let baseCol;
    if(distHi<9){ baseCol = mixHex('#526047','#5c6a4f', lush); }
    else if(distMe<9){ baseCol = mixHex('#67973a','#6fa03d', lush); }
    else { baseCol = lush<0.5 ? mixHex(pal[2],pal[1], lush*2) : mixHex(pal[1],pal[0], (lush-0.5)*2); }
    ctx.fillStyle = baseCol;
    ctx.fillRect(screenX,screenY,TILE+1,TILE+1);
    // Weltweit kontinuierliche Helligkeitsvariation (keine Kachelkanten, da nahtlos interpoliert)
    const lightVar = smoothCell(7, worldSeed*97);
    if(lightVar>0.55){
      ctx.fillStyle = `rgba(255,255,255,${(lightVar-0.55)*0.13})`;
      ctx.fillRect(screenX,screenY,TILE+1,TILE+1);
    } else if(lightVar<0.45){
      ctx.fillStyle = `rgba(0,0,0,${(0.45-lightVar)*0.14})`;
      ctx.fillRect(screenX,screenY,TILE+1,TILE+1);
    }
    // feines Sprenkel-Rauschen für mehr Tiefe (ersetzt platte Einfärbung)
    for(let s=0;s<3;s++){
      const sh = hash2(x*7+s*3, y*7+s*5, worldSeed*17+s);
      if(sh>0.45){
        const spx = screenX + ((sh*173+s*61)%TILE);
        const spy = screenY + ((sh*97+s*41)%TILE);
        ctx.fillStyle = sh>0.72 ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.065)';
        ctx.beginPath(); ctx.arc(spx,spy,0.9,0,Math.PI*2); ctx.fill();
      }
    }
    // Grasbüschel: mehrere kleine Cluster statt nur eines, mit Licht-/Schattenlinien
    if(shade>0.5 && shade<0.92){
      const tuftCount = shade>0.75 ? 2 : 1;
      for(let t=0;t<tuftCount;t++){
        const tsh = hash2(x*13+t*5, y*11+t*3, worldSeed*23+t);
        const bx = screenX + 5 + ((tsh*113+t*37)%22), by = screenY + 15 + ((tsh*67+t*19)%11);
        ctx.strokeStyle = shadeColor(baseCol, tsh>0.6?26:-22); ctx.lineWidth=1; ctx.lineCap='round';
        ctx.beginPath(); ctx.moveTo(bx,by); ctx.lineTo(bx+1.4,by-6); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx+3.2,by+1); ctx.lineTo(bx+4.1,by-5); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx+1.6,by+1); ctx.lineTo(bx+2,by-7); ctx.stroke();
      }
    }
    const flowerChance = currentBiome==='meadow' ? 0.93 : (currentBiome==='wildwood'||currentBiome==='coast' ? 0.965 : 1.01);
    if(shade>flowerChance){
      const fx = screenX + 10 + ((shade*211)%13), fy = screenY + 12 + ((shade*173)%12);
      const fcols = ['#e8a94d','#efe6cd','#c94f8f','#d9542d'];
      const fcol = fcols[Math.floor(shade*40)%fcols.length];
      ctx.fillStyle = fcol;
      [[0,-1.6],[1.4,0.5],[-1.4,0.5]].forEach(([dx,dy])=>{ ctx.beginPath(); ctx.arc(fx+dx,fy+dy,1,0,Math.PI*2); ctx.fill(); });
      ctx.fillStyle='#f2c65a'; ctx.beginPath(); ctx.arc(fx,fy,0.9,0,Math.PI*2); ctx.fill();
    }
    if(shade>0.85){ ctx.fillStyle='rgba(0,0,0,.08)'; ctx.fillRect(screenX+6,screenY+18,6,4); }
    if(pathTiles && pathTiles.has(x+','+y)){
      // getretener Erdweg: Farbe weich variierend, Ränder ausgefranst statt hart quadratisch
      const wear = hash2(x,y,worldSeed*59);
      // Deckend zeichnen: Wegfarbe mit dem Untergrund vormischen, statt
      // sie halbtransparent darüberzulegen — sonst schien der Boden durch.
      const pathCol = mixAny(mixHex('#9c7f52','#b39463', wear), baseCol, 0.18);
      ctx.fillStyle = pathCol;
      ctx.beginPath();
      const inset = 0.5 + wear*1.5;
      ctx.moveTo(screenX+inset, screenY);
      ctx.lineTo(screenX+TILE-inset*0.6, screenY);
      ctx.lineTo(screenX+TILE, screenY+TILE-inset*0.7);
      ctx.lineTo(screenX+inset*0.8, screenY+TILE);
      ctx.closePath(); ctx.fill();
      // Spurrinnen längs des Wegs
      ctx.strokeStyle='rgba(90,68,40,.16)'; ctx.lineWidth=1.1;
      ctx.beginPath(); ctx.moveTo(screenX+TILE*0.3, screenY); ctx.lineTo(screenX+TILE*0.34, screenY+TILE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(screenX+TILE*0.68, screenY); ctx.lineTo(screenX+TILE*0.64, screenY+TILE); ctx.stroke();
      // eingetretene Kiesel
      for(let k=0;k<2;k++){
        const kh = hash2(x*17+k*3, y*17+k*5, worldSeed*67+k);
        if(kh>0.55){
          ctx.fillStyle = kh>0.8 ? 'rgba(255,255,255,.13)' : 'rgba(70,52,30,.2)';
          ctx.beginPath(); ctx.ellipse(screenX+((kh*157+k*41)%TILE), screenY+((kh*103+k*29)%TILE), 1.5, 1.1, kh*2, 0, Math.PI*2); ctx.fill();
        }
      }
    }
  }
  if(huntHotspots && huntHotspots.length>0){
    for(const hs of huntHotspots){
      const d = Math.hypot(x-hs.x, y-hs.y);
      if(d<3.2){
        const pulse = 0.12+Math.sin(performance.now()/700)*0.05;
        ctx.save(); ctx.globalAlpha = pulse*(1-d/3.2);
        ctx.fillStyle = '#d9542d'; ctx.fillRect(screenX,screenY,TILE+1,TILE+1);
        ctx.restore();
        if(d<0.6){
          ctx.font='13px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillStyle='#efe6cd';
          ctx.fillText('🐾', screenX+TILE/2, screenY+TILE/2);
        } else if(hash2(x,y,worldSeed*7+3)>0.88){
          ctx.font='9px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
          ctx.save(); ctx.globalAlpha=0.6; ctx.fillText('🐾', screenX+TILE/2, screenY+TILE/2);
          ctx.restore();
        }
        break;
      }
    }
  }
  if(hoverTile && hoverTile.x===x && hoverTile.y===y && !paused){
    ctx.save(); ctx.strokeStyle='rgba(255,255,255,.5)'; ctx.lineWidth=1.4; ctx.strokeRect(screenX+1,screenY+1,TILE-2,TILE-2); ctx.restore();
  }
}
/* ============================================================
   Sprite-Cache (prozedural im Speicher erzeugt, keine externe Datei)
   Jede Objekt-Variante wird EINMAL in ein Offscreen-Canvas gerendert
   und danach nur noch geblittet. Das ersetzt tausende Gradient-
   Allokationen pro Sekunde durch einfache drawImage-Aufrufe.
============================================================ */
const spriteCache = new Map();
let spriteCacheHits = 0, spriteCacheMisses = 0;
function getCachedSprite(key, w, h, paintFn){
  let c = spriteCache.get(key);
  if(c){ spriteCacheHits++; return c; }
  spriteCacheMisses++;
  c = document.createElement('canvas');
  c.width = Math.ceil(w); c.height = Math.ceil(h);
  paintFn(c.getContext('2d'));
  spriteCache.set(key, c);
  return c;
}
// Cache leeren, wenn sich das Biom ändert (andere Farbpaletten)
function invalidateSpriteCache(){ spriteCache.clear(); }

// Deterministischer Pseudo-Zufall aus einem einzelnen Seed (ersetzt hash2(x,y,..) im Cache)
function vrand(seed, i){
  let t = (seed*374761393 + i*668265263) >>> 0;
  t = (t ^ (t >>> 13)) >>> 0; t = (t * 1274126177) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

const TREE_SPR_W = 52, TREE_SPR_H = 56, TREE_SPR_AX = 26, TREE_SPR_AY = 32;
const TREE_VARIANTS = 8, TREE_DMG_STEPS = 5;
// Malt einen Baum in einen beliebigen Kontext, relativ zu (cx,cy)
function paintTree(g, cx, cy, style, tScale, dmgShrink, vseed){
  g.fillStyle='rgba(0,0,0,.14)'; g.beginPath(); g.ellipse(cx,cy+14,13*tScale,4.6*tScale,0,0,Math.PI*2); g.fill();
  g.fillStyle='rgba(0,0,0,.22)'; g.beginPath(); g.ellipse(cx,cy+13,10*tScale,3.4*tScale,0,0,Math.PI*2); g.fill();
  const trunkW = 6*tScale, trunkH = 12*tScale;
  const trunkGrad = g.createLinearGradient(cx-trunkW/2,cy,cx+trunkW/2,cy);
  trunkGrad.addColorStop(0, shadeColor(style.trunk,-18));
  trunkGrad.addColorStop(0.4, style.trunk);
  trunkGrad.addColorStop(1, shadeColor(style.trunk,20));
  g.fillStyle=trunkGrad;
  g.beginPath();
  g.moveTo(cx-trunkW*0.62, cy+2+trunkH);
  g.lineTo(cx-trunkW*0.40, cy+2);
  g.lineTo(cx+trunkW*0.40, cy+2);
  g.lineTo(cx+trunkW*0.62, cy+2+trunkH);
  g.closePath(); g.fill();
  g.strokeStyle='rgba(0,0,0,.2)'; g.lineWidth=0.7;
  g.beginPath(); g.moveTo(cx-trunkW*0.1, cy+3); g.lineTo(cx-trunkW*0.16, cy+2+trunkH*0.9); g.stroke();
  g.beginPath(); g.moveTo(cx+trunkW*0.18, cy+4); g.lineTo(cx+trunkW*0.24, cy+2+trunkH*0.85); g.stroke();
  g.fillStyle='rgba(255,255,255,.1)'; g.fillRect(cx-trunkW*0.4,cy+2,1.2,trunkH);
  if(style.shape==='pine'||style.shape==='pine_snow'){
    const tiers = [ {tipY:-20, baseY:-9, w:9}, {tipY:-13, baseY:1, w:11} ];
    tiers.forEach(t=>{
      const tipY=cy+t.tipY*dmgShrink, baseY=cy+t.baseY*dmgShrink, w=t.w*dmgShrink;
      const gr = g.createLinearGradient(cx-w,baseY,cx+w*0.6,tipY);
      gr.addColorStop(0, shadeColor(style.canopy,-20));
      gr.addColorStop(0.5, style.canopy);
      gr.addColorStop(1, style.canopyLight);
      g.fillStyle=gr; g.strokeStyle=shadeColor(style.canopy,-32); g.lineWidth=1;
      g.beginPath(); g.moveTo(cx,tipY); g.lineTo(cx-w,baseY); g.lineTo(cx+w,baseY); g.closePath();
      g.fill(); g.stroke();
      g.fillStyle='rgba(255,255,255,.14)';
      g.beginPath(); g.moveTo(cx,tipY); g.lineTo(cx-w*0.25,baseY); g.lineTo(cx,baseY); g.closePath(); g.fill();
    });
    if(style.shape==='pine_snow'){
      const snowGrad = g.createLinearGradient(cx,cy-20*dmgShrink,cx,cy-14*dmgShrink);
      snowGrad.addColorStop(0,'rgba(255,255,255,.95)'); snowGrad.addColorStop(1,'rgba(220,235,240,.55)');
      g.fillStyle=snowGrad;
      g.beginPath(); g.moveTo(cx,cy-20*dmgShrink); g.lineTo(cx-4*dmgShrink,cy-14*dmgShrink); g.lineTo(cx+4*dmgShrink,cy-14*dmgShrink); g.closePath(); g.fill();
    }
  } else if(style.shape==='sparse'){
    [[-5,-8],[4,-11],[-1,-16]].forEach(([dx,dy])=>{
      const lr=4.5*dmgShrink, lx=cx+dx*dmgShrink, ly=cy+dy*dmgShrink;
      const gr = g.createRadialGradient(lx-lr*0.3,ly-lr*0.3,lr*0.1,lx,ly,lr);
      gr.addColorStop(0, style.canopyLight); gr.addColorStop(1, shadeColor(style.canopy,-16));
      g.fillStyle=gr; g.strokeStyle=shadeColor(style.canopy,-30); g.lineWidth=1;
      g.beginPath(); g.arc(lx,ly,lr,0,Math.PI*2); g.fill(); g.stroke();
    });
    g.strokeStyle=style.trunk; g.lineWidth=1.3;
    g.beginPath(); g.moveTo(cx,cy); g.lineTo(cx-6,cy-10); g.stroke();
    g.beginPath(); g.moveTo(cx,cy-2); g.lineTo(cx+5,cy-12); g.stroke();
  } else if(style.shape==='gnarled'){
    g.strokeStyle=style.trunk; g.lineWidth=2.4; g.lineCap='round';
    g.beginPath(); g.moveTo(cx,cy+3); g.quadraticCurveTo(cx+5,cy-4,cx-2,cy-9); g.stroke();
    const grr=10*dmgShrink, glx=cx-3, gly=cy-12;
    const gr = g.createRadialGradient(glx-grr*0.3,gly-grr*0.3,grr*0.08,glx,gly,grr);
    gr.addColorStop(0, style.canopyLight); gr.addColorStop(1, shadeColor(style.canopy,-18));
    g.fillStyle=gr; g.strokeStyle=shadeColor(style.canopy,-30); g.lineWidth=1;
    g.beginPath(); g.ellipse(glx,gly,grr,7*dmgShrink,0.15,0,Math.PI*2); g.fill(); g.stroke();
    g.fillStyle='rgba(0,0,0,.15)'; g.beginPath(); g.ellipse(cx+2,cy-10,5*dmgShrink,4*dmgShrink,0,0,Math.PI*2); g.fill();
  } else {
    const crownR = 12.5*dmgShrink, crownY = cy-6;
    const puffs = 11;
    const wobAt = p => 0.78 + vrand(vseed, 100+p)*0.34;
    g.beginPath();
    for(let p=0;p<puffs;p++){
      const ang = (p/puffs)*Math.PI*2;
      const wob = wobAt(p);
      const px = cx + Math.cos(ang)*crownR*wob;
      const py = crownY + Math.sin(ang)*crownR*wob*0.88;
      const nAng = ((p+1)/puffs)*Math.PI*2;
      const nWob = wobAt((p+1)%puffs);
      const nx = cx + Math.cos(nAng)*crownR*nWob;
      const ny = crownY + Math.sin(nAng)*crownR*nWob*0.88;
      const mAng = (ang+nAng)/2, bulge = 1.16;
      const mx = cx + Math.cos(mAng)*crownR*((wob+nWob)/2)*bulge;
      const my = crownY + Math.sin(mAng)*crownR*((wob+nWob)/2)*bulge*0.88;
      if(p===0) g.moveTo(px,py);
      g.quadraticCurveTo(mx,my,nx,ny);
    }
    g.closePath();
    const crownGrad = g.createRadialGradient(cx-crownR*0.4,crownY-crownR*0.45,crownR*0.1,cx,crownY,crownR*1.15);
    crownGrad.addColorStop(0, style.canopyLight);
    crownGrad.addColorStop(0.55, style.canopy);
    crownGrad.addColorStop(1, shadeColor(style.canopy,-26));
    g.fillStyle=crownGrad; g.fill();
    g.strokeStyle=shadeColor(style.canopy,-34); g.lineWidth=1; g.stroke();
    const lobes = [[-5,-3,5.5],[5,-4,5],[1,-8,4.6],[-2,3,4.8],[6,2,4]];
    lobes.forEach(([lx,ly,lr],li)=>{
      const jx = (vrand(vseed,200+li)-0.5)*2.2;
      const jy = (vrand(vseed,300+li)-0.5)*1.8;
      const r=lr*dmgShrink, ex=cx+(lx+jx)*dmgShrink, ey=crownY+(ly+jy)*dmgShrink;
      const gr = g.createRadialGradient(ex-r*0.4,ey-r*0.4,r*0.05,ex,ey,r);
      gr.addColorStop(0, `rgba(255,255,255,${0.13-li*0.015})`);
      gr.addColorStop(0.7, 'rgba(255,255,255,.02)');
      gr.addColorStop(1, 'rgba(0,0,0,.07)');
      g.fillStyle=gr;
      g.beginPath(); g.arc(ex,ey,r,0,Math.PI*2); g.fill();
    });
    const shineR = 6*dmgShrink;
    const shine = g.createRadialGradient(cx-5*dmgShrink,crownY-6*dmgShrink,0,cx-5*dmgShrink,crownY-6*dmgShrink,shineR);
    shine.addColorStop(0,'rgba(255,255,255,.22)'); shine.addColorStop(1,'rgba(255,255,255,0)');
    g.fillStyle=shine; g.beginPath(); g.arc(cx-5*dmgShrink,crownY-6*dmgShrink,shineR,0,Math.PI*2); g.fill();
    const shade2 = g.createRadialGradient(cx+6*dmgShrink,crownY+4*dmgShrink,0,cx+6*dmgShrink,crownY+4*dmgShrink,7*dmgShrink);
    shade2.addColorStop(0,'rgba(0,0,0,.14)'); shade2.addColorStop(1,'rgba(0,0,0,0)');
    g.fillStyle=shade2; g.beginPath(); g.arc(cx+6*dmgShrink,crownY+4*dmgShrink,7*dmgShrink,0,Math.PI*2); g.fill();
  }
}

const ROCK_SPR_W = 40, ROCK_SPR_H = 38, ROCK_SPR_AX = 20, ROCK_SPR_AY = 18;
// Malt einen Felsen relativ zu (cx,cy); vseed steuert Größe, Rotation und Eck-Jitter
function paintRock(g, cx, cy, rockStyle, vseed){
  let baseA, baseB;
  if(rockStyle==='crystal'){ baseA='#a3b3c2'; baseB='#71818f'; }
  else if(rockStyle==='weathered'){ baseA='#a89a7a'; baseB='#7a6d54'; }
  else { baseA='#9a7f60'; baseB='#6f5940'; }
  const rScale = 0.82 + vrand(vseed,1)*0.34;
  const rRot = (vrand(vseed,2)-0.5)*0.7;
  const rSin = Math.sin(rRot), rCos = Math.cos(rRot);
  g.fillStyle='rgba(0,0,0,.14)'; g.beginPath(); g.ellipse(cx,cy+10,12*rScale,4*rScale,0,0,Math.PI*2); g.fill();
  g.fillStyle='rgba(0,0,0,.2)'; g.beginPath(); g.ellipse(cx,cy+9,9*rScale,2.8*rScale,0,0,Math.PI*2); g.fill();
  const rvBase = [[-11,8],[-9,-1],[-6,-8],[0,-11],[6,-7],[10,-2],[11,8]];
  const rv = rvBase.map(([vx,vy],i)=>{
    const jit = 0.85 + vrand(vseed,10+i)*0.3;
    const sx = vx*rScale*jit, sy = vy*rScale*jit;
    return [cx + sx*rCos - sy*rSin, cy + sx*rSin + sy*rCos];
  });
  const rockGrad = g.createLinearGradient(rv[2][0],rv[2][1],rv[6][0],rv[0][1]);
  rockGrad.addColorStop(0, shadeColor(baseA,10));
  rockGrad.addColorStop(0.5, baseA);
  rockGrad.addColorStop(1, baseB);
  g.fillStyle = rockGrad;
  g.beginPath(); g.moveTo(rv[0][0],rv[0][1]);
  rv.slice(1).forEach(p=>g.lineTo(p[0],p[1])); g.closePath(); g.fill();
  g.strokeStyle=shadeColor(baseB,-18); g.lineWidth=1.4; g.stroke();
  g.strokeStyle='rgba(255,255,255,.32)'; g.lineWidth=1.6;
  g.beginPath(); g.moveTo(rv[1][0],rv[1][1]); g.lineTo(rv[2][0],rv[2][1]); g.lineTo(rv[3][0],rv[3][1]); g.stroke();
  g.strokeStyle='rgba(0,0,0,.28)'; g.lineWidth=1.6;
  g.beginPath(); g.moveTo(rv[4][0],rv[4][1]); g.lineTo(rv[5][0],rv[5][1]); g.lineTo(rv[6][0],rv[6][1]); g.stroke();
  g.strokeStyle='rgba(0,0,0,.22)'; g.lineWidth=0.9;
  g.beginPath(); g.moveTo(cx-3*rScale,cy-6*rScale); g.lineTo(cx-1*rScale,cy+2*rScale); g.lineTo(cx+4*rScale,cy+5*rScale); g.stroke();
  if(rockStyle==='mossy'){
    g.fillStyle='rgba(111,160,53,.55)';
    g.beginPath(); g.ellipse(cx-4*rScale,cy-3*rScale,4*rScale,2.4*rScale,0.3,0,Math.PI*2); g.fill();
    g.beginPath(); g.ellipse(cx+3*rScale,cy+3*rScale,3*rScale,2*rScale,0,0,Math.PI*2); g.fill();
  } else if(rockStyle==='crystal'){
    g.strokeStyle='rgba(200,230,255,.5)'; g.lineWidth=0.8;
    g.beginPath(); g.moveTo(cx-2*rScale,cy-8*rScale); g.lineTo(cx+2*rScale,cy-2*rScale); g.lineTo(cx-3*rScale,cy+2*rScale); g.stroke();
  } else if(rockStyle==='weathered'){
    g.strokeStyle='rgba(0,0,0,.25)'; g.lineWidth=0.8;
    g.beginPath(); g.moveTo(cx-5*rScale,cy-2*rScale); g.lineTo(cx-1*rScale,cy+4*rScale); g.moveTo(cx+2*rScale,cy-5*rScale); g.lineTo(cx+5*rScale,cy+1*rScale); g.stroke();
  }
}

const BUSH_SPR_W = 32, BUSH_SPR_H = 32, BUSH_SPR_AX = 16, BUSH_SPR_AY = 14;
// Malt einen Beerenbusch relativ zu (cx,cy)
function paintBush(g, cx, cy, vseed){
  const bScale = 0.85 + vrand(vseed,1)*0.3;
  g.fillStyle='rgba(0,0,0,.18)'; g.beginPath(); g.ellipse(cx,cy+9,8*bScale,2.6*bScale,0,0,Math.PI*2); g.fill();
  const bR = 9.5*bScale, bY = cy+2, bp = 8;
  const wobAt = p => 0.8 + vrand(vseed,20+p)*0.36;
  g.beginPath();
  for(let p=0;p<bp;p++){
    const a1=(p/bp)*Math.PI*2, a2=((p+1)/bp)*Math.PI*2;
    const w1=wobAt(p), w2=wobAt((p+1)%bp);
    const x1=cx+Math.cos(a1)*bR*w1, y1=bY+Math.sin(a1)*bR*w1*0.85;
    const x2=cx+Math.cos(a2)*bR*w2, y2=bY+Math.sin(a2)*bR*w2*0.85;
    const am=(a1+a2)/2, mx=cx+Math.cos(am)*bR*((w1+w2)/2)*1.18, my=bY+Math.sin(am)*bR*((w1+w2)/2)*1.18*0.85;
    if(p===0) g.moveTo(x1,y1);
    g.quadraticCurveTo(mx,my,x2,y2);
  }
  g.closePath();
  const bGrad = g.createRadialGradient(cx-bR*0.4,bY-bR*0.45,bR*0.08,cx,bY,bR*1.1);
  bGrad.addColorStop(0,'#5d8a52'); bGrad.addColorStop(0.6,'#3f6b3f'); bGrad.addColorStop(1,'#2c4d2c');
  g.fillStyle=bGrad; g.fill();
  g.strokeStyle='rgba(30,55,30,.55)'; g.lineWidth=0.9; g.stroke();
  [[-4,-1],[3,-3],[0,3]].forEach(p=>{
    g.fillStyle='rgba(0,0,0,.25)'; g.beginPath(); g.arc(cx+p[0]*bScale+0.5,cy+p[1]*bScale+0.6,2*bScale,0,Math.PI*2); g.fill();
    const berryGrad = g.createRadialGradient(cx+p[0]*bScale-0.7,cy+p[1]*bScale-0.7,0.2,cx+p[0]*bScale,cy+p[1]*bScale,2.1*bScale);
    berryGrad.addColorStop(0,'#e0603f'); berryGrad.addColorStop(1,'#a8331f');
    g.fillStyle=berryGrad; g.beginPath(); g.arc(cx+p[0]*bScale,cy+p[1]*bScale,2*bScale,0,Math.PI*2); g.fill();
    g.fillStyle='rgba(255,255,255,.5)'; g.beginPath(); g.arc(cx+p[0]*bScale-0.6,cy+p[1]*bScale-0.7,0.6*bScale,0,Math.PI*2); g.fill();
  });
}

function drawObject(o,x,y,screenX,screenY){
  const cx = screenX+TILE/2, cy = screenY+TILE/2;
  if(o.type==='tree'){
    const style = BIOME_TREE_STYLE[currentBiome] || BIOME_TREE_STYLE.wildwood;
    // Variante + Schadensstufe quantisieren -> begrenzte Zahl cachebarer Sprites
    const variant = Math.floor(hash2(x,y,worldSeed*61+3)*TREE_VARIANTS) % TREE_VARIANTS;
    const dmgRaw = clamp(1 - (o.maxHp-o.hp)*0.12, 0.3, 1);
    const dmgStep = Math.round(dmgRaw*(TREE_DMG_STEPS-1));
    const key = `tree|${currentBiome}|${style.shape}|${variant}|${dmgStep}`;
    const spr = getCachedSprite(key, TREE_SPR_W, TREE_SPR_H, g=>{
      const tScale = 0.82 + (variant/(TREE_VARIANTS-1))*0.32;
      const dmgShrink = (dmgStep/(TREE_DMG_STEPS-1)) * tScale;
      paintTree(g, TREE_SPR_AX, TREE_SPR_AY, style, tScale, dmgShrink, variant+1);
    });
    ctx.drawImage(spr, cx-TREE_SPR_AX, cy-TREE_SPR_AY);
  } else if(o.type==='rock'){
    const rockStyle = BIOME_ROCK_STYLE[currentBiome] || 'mossy';
    // Pro-Instanz-Variante + Offscreen-Cache (0 Gradienten pro Frame)
    const rVar = Math.floor(hash2(x,y,worldSeed*41+7)*10)%10;
    const rSpr = getCachedSprite(`rock|${rockStyle}|${rVar}`, ROCK_SPR_W, ROCK_SPR_H, g=>{
      paintRock(g, ROCK_SPR_AX, ROCK_SPR_AY, rockStyle, rVar+1);
    });
    ctx.drawImage(rSpr, cx-ROCK_SPR_AX, cy-ROCK_SPR_AY);
  } else if(o.type==='orevein'){
    ctx.fillStyle='rgba(0,0,0,.2)'; ctx.beginPath(); ctx.ellipse(cx,cy+9,10,3,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#6b7580'; ctx.beginPath();
    ctx.moveTo(cx-11,cy+8); ctx.lineTo(cx-8,cy-6); ctx.lineTo(cx,cy-11); ctx.lineTo(cx+9,cy-4); ctx.lineTo(cx+11,cy+8); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#40474e'; ctx.lineWidth=1.4; ctx.stroke();
    ctx.strokeStyle='rgba(255,255,255,.2)'; ctx.lineWidth=1.4;
    ctx.beginPath(); ctx.moveTo(cx-8,cy-6); ctx.lineTo(cx,cy-11); ctx.stroke();
    const oreGlow = 0.7+Math.sin(performance.now()/500)*0.25;
    ctx.save(); ctx.globalAlpha=oreGlow;
    ctx.fillStyle='#7fd1d1'; [[-3,-1],[4,2],[0,-5]].forEach(p=>{ ctx.beginPath(); ctx.arc(cx+p[0],cy+p[1],1.6,0,Math.PI*2); ctx.fill(); });
    ctx.restore();
  } else if(o.type==='bush'){
    const bVar = Math.floor(hash2(x,y,worldSeed*83)*8)%8;
    const bSpr = getCachedSprite(`bush|${bVar}`, BUSH_SPR_W, BUSH_SPR_H, g=>{
      paintBush(g, BUSH_SPR_AX, BUSH_SPR_AY, bVar+1);
    });
    ctx.drawImage(bSpr, cx-BUSH_SPR_AX, cy-BUSH_SPR_AY);
  } else if(o.type==='fiberbush'){
    const fh = hash2(x,y,worldSeed*89);
    ctx.fillStyle='rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(cx,cy+9,7,2.2,0,0,Math.PI*2); ctx.fill();
    // mehr Halme, leicht gebogen und in zwei Grüntönen für Tiefe
    const stalks = [[-7,8,-5,-7],[-3,8,-1,-9],[1,8,3,-8],[5,8,7,-5],[7,8,9,-2]];
    stalks.forEach((p,i)=>{
      const lean = (hash2(x*7+i,y*7+i,worldSeed*91+i)-0.5)*2.5;
      ctx.strokeStyle = i%2===0 ? '#8fc93a' : '#6fa32c';
      ctx.lineWidth = 1.8; ctx.lineCap='round';
      ctx.beginPath();
      ctx.moveTo(cx+p[0],cy+p[1]);
      ctx.quadraticCurveTo(cx+p[0]+lean, cy+(p[1]+p[3])/2, cx+p[2]+lean*1.6, cy+p[3]);
      ctx.stroke();
    });
    ctx.fillStyle='#c9b988'; ctx.beginPath(); ctx.ellipse(cx,cy+9,3.2,2.2,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='rgba(255,255,255,.2)'; ctx.beginPath(); ctx.ellipse(cx-0.8,cy+8.4,1.4,0.9,0,0,Math.PI*2); ctx.fill();
  } else if(o.type==='wildgemuese'){
    ctx.fillStyle='#5a4530'; ctx.beginPath(); ctx.ellipse(cx,cy+9,9,3,0,0,Math.PI*2); ctx.fill();
    [[-5,0],[0,-2],[5,0]].forEach(([dx,dy])=>{
      ctx.fillStyle='#c9702c'; ctx.beginPath(); ctx.ellipse(cx+dx,cy+6+dy,3,4,0,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle='#8fc93a'; ctx.lineWidth=1.6;
      ctx.beginPath(); ctx.moveTo(cx+dx,cy+3+dy); ctx.lineTo(cx+dx-2,cy-5+dy); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx+dx,cy+3+dy); ctx.lineTo(cx+dx+2,cy-5+dy); ctx.stroke();
    });
  } else if(o.type==='mountain'){
    const dmg = 1-(o.hp/o.maxHp);
    // Pro-Instanz-Variante + Offscreen-Cache: identische Wiederholung vermeiden, 0 Gradienten pro Frame
    const mVar = Math.floor(hash2(x,y,worldSeed*101)*6)%6;
    const mSpr = getCachedSprite(`mtn|${mVar}`, TILE, TILE, g=>{
      const baseGrad = g.createLinearGradient(0,0,0,TILE);
      baseGrad.addColorStop(0,'#726657'); baseGrad.addColorStop(1,'#4a4038');
      g.fillStyle = baseGrad; g.fillRect(0,0,TILE,TILE);
      const peakGrad = g.createLinearGradient(0,0,TILE,TILE);
      peakGrad.addColorStop(0,'#8a7d68'); peakGrad.addColorStop(0.5,'#6b6154'); peakGrad.addColorStop(1,'#544a3d');
      g.fillStyle = peakGrad;
      // Gipfelposition und -höhe variieren pro Variante
      const pk = 0.34 + vrand(mVar+1, 1)*0.32;          // Hauptgipfel-X (0.34–0.66)
      const pkY = 1.5 + vrand(mVar+1, 2)*4;              // Gipfelhöhe
      const sh1 = 9 + vrand(mVar+1, 3)*5, sh2 = 8 + vrand(mVar+1, 4)*6;
      g.beginPath();
      g.moveTo(2,TILE-2);
      g.lineTo(6+vrand(mVar+1,5)*3, sh1+2); g.lineTo(12,sh1+7);
      g.lineTo(TILE*pk, pkY); g.lineTo(TILE-11, sh2+5);
      g.lineTo(TILE-6-vrand(mVar+1,6)*3, sh2); g.lineTo(TILE-2,TILE-2);
      g.closePath(); g.fill();
      g.strokeStyle='rgba(0,0,0,.35)'; g.lineWidth=1.2; g.stroke();
      // Schneekappe am Hauptgipfel
      g.fillStyle='rgba(255,255,255,.35)';
      g.beginPath(); g.moveTo(TILE*pk,pkY); g.lineTo(TILE*pk-5,pkY+7); g.lineTo(TILE*pk+3,pkY+7); g.closePath(); g.fill();
      // Gesteinsschichten
      g.strokeStyle='rgba(0,0,0,.18)'; g.lineWidth=0.8;
      g.beginPath(); g.moveTo(5,22); g.lineTo(TILE-6,19+vrand(mVar+1,7)*3); g.stroke();
      g.beginPath(); g.moveTo(6,27); g.lineTo(TILE-5,25+vrand(mVar+1,8)*2); g.stroke();
      g.strokeStyle='rgba(0,0,0,.3)'; g.lineWidth=1.4; g.strokeRect(1,1,TILE-2,TILE-2);
    });
    ctx.drawImage(mSpr, screenX, screenY);
    if(dmg>0.15){
      ctx.strokeStyle='rgba(0,0,0,.4)'; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(cx-6,cy-8); ctx.lineTo(cx-1,cy); ctx.lineTo(cx-7,cy+7); ctx.stroke();
    }
    if(dmg>0.5){
      ctx.beginPath(); ctx.moveTo(cx+4,cy-6); ctx.lineTo(cx+2,cy+3); ctx.lineTo(cx+8,cy+9); ctx.stroke();
    }
  } else if(o.type==='ruins_loot'){
    const glow = 0.5+Math.sin(performance.now()/500)*0.15;
    ctx.save(); ctx.globalAlpha = glow*0.4;
    ctx.fillStyle='#e8a94d'; ctx.beginPath(); ctx.arc(cx,cy,13,0,Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.fillStyle='#8b8478';
    ctx.fillRect(cx-9,cy+4,18,4);
    ctx.fillRect(cx-4,cy-10,8,15);
    ctx.fillStyle='#6f6a5f';
    ctx.fillRect(cx-4,cy-10,8,3);
    ctx.strokeStyle='#4a463d'; ctx.lineWidth=1;
    ctx.strokeRect(cx-9,cy+4,18,4); ctx.strokeRect(cx-4,cy-10,8,15);
    ctx.fillStyle='#3f6b3f';
    ctx.beginPath(); ctx.arc(cx-7,cy+6,2,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx+6,cy+2,1.6,0,Math.PI*2); ctx.fill();
  } else if(o.type==='vfloor'){
    // Dielenboden im Haus
    const fh = hash2(x,y,worldSeed*151);
    ctx.fillStyle = mixHex('#8a6a44','#a07f56', fh);
    ctx.fillRect(screenX,screenY,TILE,TILE);
    ctx.strokeStyle='rgba(60,40,22,.28)'; ctx.lineWidth=1;
    for(let i=1;i<3;i++){ ctx.beginPath(); ctx.moveTo(screenX,screenY+i*TILE/3); ctx.lineTo(screenX+TILE,screenY+i*TILE/3); ctx.stroke(); }
    ctx.fillStyle='rgba(0,0,0,.10)'; ctx.fillRect(screenX,screenY,TILE,3);
  } else if(o.type==='vdoor'){
    const fh = hash2(x,y,worldSeed*151);
    ctx.fillStyle = mixHex('#8a6a44','#a07f56', fh);
    ctx.fillRect(screenX,screenY,TILE,TILE);
    // Türrahmen + Tür
    ctx.fillStyle='#5c4326'; ctx.fillRect(screenX+3,screenY+4,TILE-6,TILE-8);
    const dg = ctx.createLinearGradient(screenX+5,0,screenX+TILE-5,0);
    dg.addColorStop(0,'#8a5f33'); dg.addColorStop(0.5,'#a97b45'); dg.addColorStop(1,'#7a5228');
    ctx.fillStyle=dg; ctx.fillRect(screenX+5,screenY+6,TILE-10,TILE-12);
    ctx.strokeStyle='rgba(50,32,14,.7)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(screenX+TILE/2,screenY+6); ctx.lineTo(screenX+TILE/2,screenY+TILE-6); ctx.stroke();
    ctx.fillStyle='#e8c45a'; ctx.beginPath(); ctx.arc(screenX+TILE-10,cy,1.7,0,Math.PI*2); ctx.fill();
    // Ladenschild über der Tür
    if(o.shop && SHOP_TYPES[o.shop]){
      const sh = SHOP_TYPES[o.shop];
      const bob = Math.sin(performance.now()/900 + x)*0.8;
      ctx.save();
      // Ausleger
      ctx.strokeStyle='#4a3018'; ctx.lineWidth=1.4;
      ctx.beginPath(); ctx.moveTo(screenX+TILE-6, screenY-2); ctx.lineTo(screenX+TILE-6, screenY-9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(screenX+TILE-6, screenY-9); ctx.lineTo(screenX+TILE-15, screenY-9); ctx.stroke();
      // Schild
      ctx.fillStyle='rgba(0,0,0,.3)';
      ctx.fillRect(screenX+TILE-20, screenY-8+bob, 15, 11);
      ctx.fillStyle = sh.signCol;
      ctx.fillRect(screenX+TILE-21, screenY-9+bob, 15, 11);
      ctx.strokeStyle='#3a2814'; ctx.lineWidth=1;
      ctx.strokeRect(screenX+TILE-21, screenY-9+bob, 15, 11);
      ctx.font='9px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(sh.sign, screenX+TILE-13.5, screenY-3.5+bob);
      ctx.textBaseline='alphabetic';
      ctx.restore();
    }
  } else if(o.type==='vwall'){
    const tones = [['#b9855a','#8d6038'],['#a8907a','#7c6650'],['#c09a63','#8f7040']];
    const [wa,wb] = tones[(o.roofTone||0)%3];
    // Wandsockel
    const wg = ctx.createLinearGradient(screenX,screenY,screenX,screenY+TILE);
    wg.addColorStop(0, wa); wg.addColorStop(1, wb);
    ctx.fillStyle=wg; ctx.fillRect(screenX,screenY,TILE,TILE);
    // Fachwerkbalken
    ctx.strokeStyle='rgba(70,45,22,.55)'; ctx.lineWidth=2;
    ctx.strokeRect(screenX+1,screenY+1,TILE-2,TILE-2);
    ctx.lineWidth=1.4;
    ctx.beginPath(); ctx.moveTo(screenX+2,screenY+TILE-2); ctx.lineTo(screenX+TILE-2,screenY+2); ctx.stroke();
    // Dachkante oben
    ctx.fillStyle='rgba(0,0,0,.16)'; ctx.fillRect(screenX,screenY,TILE,4);
    ctx.fillStyle='rgba(255,255,255,.10)'; ctx.fillRect(screenX,screenY+4,TILE,2);
    // gelegentliches Fenster (nachts beleuchtet)
    const wh = hash2(x,y,worldSeed*157);
    if(!o.corner && wh>0.55){
      const lit = isNightNow();
      ctx.fillStyle = lit ? '#f2c65a' : '#4c6a72';
      ctx.fillRect(screenX+9,screenY+10,TILE-18,TILE-20);
      if(lit){
        ctx.save(); ctx.globalAlpha=0.35;
        const glow=ctx.createRadialGradient(cx,cy,1,cx,cy,14);
        glow.addColorStop(0,'rgba(255,210,110,.8)'); glow.addColorStop(1,'rgba(255,210,110,0)');
        ctx.fillStyle=glow; ctx.beginPath(); ctx.arc(cx,cy,14,0,Math.PI*2); ctx.fill(); ctx.restore();
      }
      ctx.strokeStyle='#4a3419'; ctx.lineWidth=1.2; ctx.strokeRect(screenX+9,screenY+10,TILE-18,TILE-20);
      ctx.beginPath(); ctx.moveTo(cx,screenY+10); ctx.lineTo(cx,screenY+TILE-10); ctx.stroke();
    }
  } else if(o.type==='vfurn'){
    // Boden unter dem Möbel
    ctx.fillStyle = mixHex('#8a6a44','#a07f56', hash2(x,y,worldSeed*151));
    ctx.fillRect(screenX,screenY,TILE,TILE);
    ctx.fillStyle='rgba(0,0,0,.18)'; ctx.beginPath(); ctx.ellipse(cx,cy+10,10,3,0,0,Math.PI*2); ctx.fill();
    const k = o.kind;
    if(k==='bed'){
      ctx.fillStyle='#7a5533'; ctx.fillRect(cx-11,cy-9,22,20);
      ctx.fillStyle='#d8cbb0'; ctx.fillRect(cx-9,cy-7,18,10);
      ctx.fillStyle='#8f5a4a'; ctx.fillRect(cx-9,cy+3,18,6);
      ctx.fillStyle='#f0ead8'; ctx.fillRect(cx-7,cy-6,8,5);
      ctx.strokeStyle='#4f371f'; ctx.lineWidth=1.2; ctx.strokeRect(cx-11,cy-9,22,20);
    } else if(k==='table'){
      ctx.fillStyle='#8a6038'; ctx.fillRect(cx-11,cy-6,22,5);
      ctx.fillStyle='#a97b45'; ctx.fillRect(cx-11,cy-8,22,3);
      ctx.fillStyle='#6b4a2b'; ctx.fillRect(cx-9,cy-1,3,9); ctx.fillRect(cx+6,cy-1,3,9);
      ctx.fillStyle='#c9b988'; ctx.beginPath(); ctx.arc(cx+3,cy-9,2.2,0,Math.PI*2); ctx.fill();
    } else if(k==='shelf'){
      ctx.fillStyle='#7a5533'; ctx.fillRect(cx-10,cy-11,20,21);
      ctx.fillStyle='#5c4326'; ctx.fillRect(cx-10,cy-4,20,2); ctx.fillRect(cx-10,cy+3,20,2);
      ['#c94f8f','#3d6b4f','#e8a94d','#5a7fa8'].forEach((c,i)=>{
        ctx.fillStyle=c; ctx.fillRect(cx-8+i*4, cy-10+ (i%2?7:0), 3, 6);
      });
      ctx.strokeStyle='#4f371f'; ctx.lineWidth=1.2; ctx.strokeRect(cx-10,cy-11,20,21);
    } else if(k==='hearth'){
      ctx.fillStyle='#6f6a62'; ctx.fillRect(cx-11,cy-10,22,20);
      ctx.fillStyle='#3a352f'; ctx.fillRect(cx-7,cy-2,14,12);
      const fl = 0.6+Math.sin(performance.now()/180+x)*0.4;
      ctx.fillStyle=`rgba(232,140,45,${0.75*fl})`;
      ctx.beginPath(); ctx.moveTo(cx-4,cy+9); ctx.quadraticCurveTo(cx,cy-1,cx+4,cy+9); ctx.closePath(); ctx.fill();
      ctx.fillStyle=`rgba(250,220,120,${0.8*fl})`;
      ctx.beginPath(); ctx.moveTo(cx-2,cy+9); ctx.quadraticCurveTo(cx,cy+3,cx+2,cy+9); ctx.closePath(); ctx.fill();
      ctx.strokeStyle='#4a453e'; ctx.lineWidth=1.2; ctx.strokeRect(cx-11,cy-10,22,20);
    } else if(k==='oven'){
      ctx.fillStyle='#8a7a68'; ctx.beginPath(); ctx.moveTo(cx-11,cy+10); ctx.lineTo(cx-9,cy-8);
      ctx.quadraticCurveTo(cx,cy-14,cx+9,cy-8); ctx.lineTo(cx+11,cy+10); ctx.closePath(); ctx.fill();
      ctx.fillStyle='#3a322a'; ctx.beginPath(); ctx.ellipse(cx,cy+2,6,5,0,0,Math.PI*2); ctx.fill();
      const fl=0.5+Math.sin(performance.now()/200+y)*0.5;
      ctx.fillStyle=`rgba(240,150,50,${0.7*fl})`; ctx.beginPath(); ctx.ellipse(cx,cy+3,4,3,0,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle='#5a4c3c'; ctx.lineWidth=1.2; ctx.stroke();
    } else if(k==='anvil'){
      ctx.fillStyle='#5c5f66'; ctx.fillRect(cx-4,cy+2,8,8);
      ctx.fillStyle='#7a7f88'; ctx.beginPath();
      ctx.moveTo(cx-10,cy-4); ctx.lineTo(cx+7,cy-4); ctx.lineTo(cx+11,cy-1);
      ctx.lineTo(cx+5,cy+2); ctx.lineTo(cx-6,cy+2); ctx.closePath(); ctx.fill();
      ctx.strokeStyle='#3d4046'; ctx.lineWidth=1.2; ctx.stroke();
      ctx.fillStyle='#9aa0a8'; ctx.fillRect(cx-9,cy-6,14,2);
    } else if(k==='loom'){
      ctx.fillStyle='#7a5533'; ctx.fillRect(cx-10,cy-10,3,20); ctx.fillRect(cx+7,cy-10,3,20);
      ctx.fillRect(cx-10,cy-10,20,3);
      ctx.strokeStyle='#e8dcc0'; ctx.lineWidth=0.8;
      for(let i=0;i<6;i++){ ctx.beginPath(); ctx.moveTo(cx-7+i*3,cy-7); ctx.lineTo(cx-7+i*3,cy+8); ctx.stroke(); }
      ctx.fillStyle='#5a7fa8'; ctx.fillRect(cx-7,cy+2,14,5);
    } else if(k==='rack'){
      ctx.fillStyle='#6b4a2b'; ctx.fillRect(cx-11,cy-9,22,3);
      ['#8a5a3a','#a06844','#7a4e30'].forEach((c,i)=>{
        ctx.fillStyle=c; ctx.fillRect(cx-8+i*7,cy-6,5,11);
      });
      ctx.strokeStyle='#4a3018'; ctx.lineWidth=1; ctx.strokeRect(cx-11,cy-9,22,3);
    } else if(k==='herbs'){
      ctx.fillStyle='#6b4a2b'; ctx.fillRect(cx-11,cy-10,22,2);
      for(let i=0;i<4;i++){
        const bx=cx-8+i*5.5;
        ctx.strokeStyle='#5a7a3a'; ctx.lineWidth=1.2;
        ctx.beginPath(); ctx.moveTo(bx,cy-8); ctx.lineTo(bx,cy+2); ctx.stroke();
        ctx.fillStyle=['#7aa33a','#8fbf4a','#6f9330','#a3c95a'][i];
        ctx.beginPath(); ctx.ellipse(bx,cy+3,2.6,4,0,0,Math.PI*2); ctx.fill();
      }
    } else if(k==='barrel'){
      const bg2=ctx.createLinearGradient(cx-9,0,cx+9,0);
      bg2.addColorStop(0,'#7a5533'); bg2.addColorStop(0.5,'#a2764a'); bg2.addColorStop(1,'#6b4a2b');
      ctx.fillStyle=bg2; ctx.fillRect(cx-9,cy-9,18,19);
      ctx.fillStyle='#5f6670'; ctx.fillRect(cx-9,cy-6,18,2.5); ctx.fillRect(cx-9,cy+5,18,2.5);
      ctx.fillStyle='#8a6038'; ctx.beginPath(); ctx.ellipse(cx,cy-9,9,3,0,0,Math.PI*2); ctx.fill();
      ctx.strokeStyle='#4a3018'; ctx.lineWidth=1.1; ctx.strokeRect(cx-9,cy-9,18,19);
    } else if(k==='counter'){
      // Verkaufstresen mit Waren
      ctx.fillStyle='#7a5533'; ctx.fillRect(cx-12,cy-3,24,6);
      ctx.fillStyle='#a07f56'; ctx.fillRect(cx-12,cy-5,24,3);
      ctx.fillStyle='#5c4326'; ctx.fillRect(cx-11,cy+3,22,7);
      ctx.strokeStyle='#3f2c16'; ctx.lineWidth=1; ctx.strokeRect(cx-12,cy-5,24,15);
      ['#c94f8f','#e8a94d','#5a7fa8'].forEach((c2,i)=>{
        ctx.fillStyle=c2; ctx.fillRect(cx-8+i*6, cy-9, 4, 4);
      });
      ctx.fillStyle='#e8c45a'; ctx.beginPath(); ctx.arc(cx+8,cy-7,1.6,0,Math.PI*2); ctx.fill();
    } else if(k==='bench'){
      ctx.fillStyle='#8a6038'; ctx.fillRect(cx-11,cy-3,22,5);
      ctx.fillStyle='#6b4a2b'; ctx.fillRect(cx-9,cy+2,3,8); ctx.fillRect(cx+6,cy+2,3,8);
      ctx.fillStyle='#9aa0a8'; ctx.fillRect(cx-5,cy-7,10,3);
      ctx.fillStyle='#7a5533'; ctx.fillRect(cx+2,cy-9,2,6);
    } else if(k==='pots'){
      [[-6,2,5],[2,3,6],[7,-1,4]].forEach(([px,py,pr],i)=>{
        ctx.fillStyle=['#a8613a','#8f4f2e','#b57046'][i];
        ctx.beginPath(); ctx.ellipse(cx+px,cy+py,pr,pr*0.9,0,0,Math.PI*2); ctx.fill();
        ctx.fillStyle='rgba(255,255,255,.18)';
        ctx.beginPath(); ctx.ellipse(cx+px-pr*0.3,cy+py-pr*0.3,pr*0.3,pr*0.25,0,0,Math.PI*2); ctx.fill();
        ctx.strokeStyle='#5f3720'; ctx.lineWidth=1;
        ctx.beginPath(); ctx.ellipse(cx+px,cy+py,pr,pr*0.9,0,0,Math.PI*2); ctx.stroke();
      });
    }
  } else if(o.type==='hut'){
    ctx.fillStyle='#8b6f4e'; ctx.fillRect(cx-10,cy-2,20,12);
    ctx.strokeStyle='#5c4a30'; ctx.lineWidth=1.2; ctx.strokeRect(cx-10,cy-2,20,12);
    ctx.fillStyle='#c9822c'; ctx.beginPath();
    ctx.moveTo(cx-13,cy-2); ctx.lineTo(cx,cy-14); ctx.lineTo(cx+13,cy-2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#8a5a1f'; ctx.stroke();
    ctx.fillStyle='#3f2f22'; ctx.fillRect(cx-3,cy+2,6,8);
  } else if(o.type==='trader'){
    ctx.fillStyle='#c9822c'; ctx.fillRect(cx-13,cy-1,26,3);
    ctx.fillStyle='#8b6f4e'; ctx.fillRect(cx-12,cy+2,3,10); ctx.fillRect(cx+9,cy+2,3,10);
    const flutter = Math.sin(performance.now()/300)*2;
    ctx.fillStyle='#d9542d';
    ctx.beginPath(); ctx.moveTo(cx-11,cy-1); ctx.lineTo(cx-11+flutter,cy-10); ctx.lineTo(cx-4,cy-1); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#3d6b4f';
    ctx.beginPath(); ctx.moveTo(cx+4,cy-1); ctx.lineTo(cx+11+flutter,cy-9); ctx.lineTo(cx+11,cy-1); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#e8c9a0'; ctx.beginPath(); ctx.arc(cx,cy+8,4,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#5a3d6b'; ctx.beginPath(); ctx.arc(cx,cy+13,5,0,Math.PI); ctx.fill();
  } else if(o.type==='dungeon_portal'){
    const pulse = 0.6+Math.sin(performance.now()/450)*0.3;
    ctx.fillStyle='rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(cx,cy+15,15,5,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#3a2e40';
    ctx.beginPath(); ctx.moveTo(cx-15,cy+11); ctx.lineTo(cx-12,cy-5); ctx.lineTo(cx-4,cy-13); ctx.lineTo(cx+5,cy-12); ctx.lineTo(cx+14,cy-3); ctx.lineTo(cx+15,cy+11); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#241c2c'; ctx.lineWidth=1.6; ctx.stroke();
    ctx.save(); ctx.globalAlpha=pulse*0.55;
    ctx.fillStyle='#7a5ba0'; ctx.beginPath(); ctx.ellipse(cx,cy+3,10,13,0,0,Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.fillStyle='#15101c'; ctx.beginPath(); ctx.ellipse(cx,cy+4,7,10,0,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#9a7fc0'; ctx.lineWidth=1.8; ctx.beginPath(); ctx.ellipse(cx,cy+4,7,10,0,0,Math.PI*2); ctx.stroke();
    ctx.strokeStyle='rgba(180,150,220,.5)'; ctx.lineWidth=0.8;
    ctx.beginPath(); ctx.ellipse(cx,cy+4,10,13,0,Math.PI*1.1,Math.PI*1.6); ctx.stroke();
  } else if(o.type==='cave_entrance'){
    ctx.fillStyle='rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(cx,cy+15,16,5,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#5f4d38';
    ctx.beginPath(); ctx.moveTo(cx-16,cy+11); ctx.lineTo(cx-13,cy-6); ctx.lineTo(cx-5,cy-14); ctx.lineTo(cx+4,cy-13); ctx.lineTo(cx+13,cy-4); ctx.lineTo(cx+16,cy+11); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#3a2e20'; ctx.lineWidth=1.6; ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,.12)';
    ctx.beginPath(); ctx.moveTo(cx-13,cy-6); ctx.lineTo(cx-5,cy-14); ctx.lineTo(cx-8,cy-9); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#1a1410'; ctx.beginPath(); ctx.ellipse(cx,cy+5,8,10,0,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#2a2018'; ctx.lineWidth=1; ctx.beginPath(); ctx.ellipse(cx,cy+5,8,10,0,0,Math.PI*2); ctx.stroke();
    ctx.fillStyle='rgba(111,160,53,.5)';
    ctx.beginPath(); ctx.ellipse(cx-10,cy-3,2.6,4,0.3,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx+10,cy-1,2.2,3.4,-0.3,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx-6,cy+12,2.4,1.6,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#8a7a5c';
    [[-9,10],[7,11],[0,13]].forEach(([dx,dy])=>{ ctx.beginPath(); ctx.arc(cx+dx,cy+dy,1.8,0,Math.PI*2); ctx.fill(); });
  } else if(o.type==='dungeon_exit'){
    ctx.fillStyle='#8b8478'; ctx.beginPath(); ctx.moveTo(cx-11,cy+10); ctx.lineTo(cx,cy-11); ctx.lineTo(cx+11,cy+10); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#5a564c'; ctx.lineWidth=1.5; ctx.stroke();
    ctx.fillStyle='#efe6cd'; ctx.font='12px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('⬆️', cx, cy+2);
  } else if(o.type==='dungeon_chest'){
    const glow = 0.4+Math.sin(performance.now()/300)*0.2;
    ctx.save(); ctx.globalAlpha=glow; ctx.fillStyle='#ffd23f'; ctx.beginPath(); ctx.arc(cx,cy,14,0,Math.PI*2); ctx.fill(); ctx.restore();
    ctx.fillStyle='#8b6f4e'; ctx.fillRect(cx-10,cy-2,20,10);
    ctx.fillStyle='#6b4a2b'; ctx.beginPath(); ctx.moveTo(cx-10,cy-2); ctx.quadraticCurveTo(cx,cy-12,cx+10,cy-2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#4a3018'; ctx.lineWidth=1.2; ctx.strokeRect(cx-10,cy-2,20,10);
    ctx.fillStyle='#ffd23f'; ctx.beginPath(); ctx.arc(cx,cy-2,2.4,0,Math.PI*2); ctx.fill();
  } else if(o.type==='visitor'){
    ctx.fillStyle='rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(cx,cy+13,9,3,0,0,Math.PI*2); ctx.fill();
    ctx.save(); ctx.translate(cx,cy+2);
    drawHumanoidBody(ctx, o.appearance||{outfitColor:'#7a6a9a',hairstyle:2,hairColor:'#5b4327'}, 1.15, null);
    ctx.restore();
    const bob = Math.sin(performance.now()/450)*2;
    ctx.font='11px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText('💬', cx+11, cy-14+bob);
    ctx.font='800 9px Nunito, sans-serif'; ctx.fillStyle='#efe6cd';
    ctx.fillText(o.name||'', cx, cy-20);
  } else if(o.type==='quest_npc'){
    ctx.fillStyle='rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(cx,cy+13,9,3,0,0,Math.PI*2); ctx.fill();
    ctx.save(); ctx.translate(cx,cy+2);
    drawHumanoidBody(ctx, o.appearance||{outfitColor:'#e8a94d',hairstyle:4,hairColor:'#5b4327'}, 1.15, null);
    ctx.restore();
    /* Symbol und Farbe kommen aus NPC_TYPES, damit jede Figur ihr eigenes
       Zeichen über dem Kopf trägt statt eines festen Ausrufezeichens. */
    const def = (typeof NPC_TYPES !== 'undefined' && NPC_TYPES[o.npcTyp]) || null;
    const zeichen = def ? def.icon : '❗';
    const farbe = def ? def.farbe : '#ffd23f';
    const bob2 = Math.sin(performance.now()/380)*3;
    const pulse = 0.7+Math.sin(performance.now()/300)*0.3;
    ctx.save(); ctx.globalAlpha=pulse*0.5; ctx.fillStyle=farbe;
    ctx.beginPath(); ctx.arc(cx,cy-18+bob2,7,0,Math.PI*2); ctx.fill(); ctx.restore();
    ctx.fillStyle='#8a651c'; ctx.font='800 14px Nunito, sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(zeichen, cx, cy-18+bob2);
    ctx.font='800 9px Nunito, sans-serif'; ctx.fillStyle='#efe6cd';
    ctx.fillText(o.name||'', cx, cy-27);
  }
}
function drawCampfire(screenX,screenY){
  const cx=screenX+TILE/2, cy=screenY+TILE/2;
  ctx.fillStyle='#5c4a36'; [[-7,4],[7,4],[0,7]].forEach(p=>{ ctx.fillRect(cx+p[0]-2,cy+p[1]-2,4,10); });
  const flick = 1+Math.sin(performance.now()/120)*0.15;
  ctx.fillStyle='#e8a94d';
  ctx.beginPath(); ctx.moveTo(cx,cy-14*flick); ctx.quadraticCurveTo(cx+7,cy-2,cx,cy+2); ctx.quadraticCurveTo(cx-7,cy-2,cx,cy-14*flick); ctx.fill();
  ctx.fillStyle='#d9542d';
  ctx.beginPath(); ctx.moveTo(cx,cy-7*flick); ctx.quadraticCurveTo(cx+3,cy-1,cx,cy+2); ctx.quadraticCurveTo(cx-3,cy-1,cx,cy-7*flick); ctx.fill();
}
const BUILD_EMOJI = {campfire:'🔥',tent:'🛏️',door:'🚪',sawmill:'🪚',furnace:'⚒️',loom:'🧵',stockpile:'📦',wall:'🧱',tower:'🗼',workbench:'🛠️',forge:'⚒️',research:'📚',barber:'💈',brunnen:'⛲',zaun:'🪵',vorratskammer:'🍯',krankenstube:'⚕️',bibliothek:'📖',wachhaus:'🏹',zwinger:'🐾',copperwall:'🟠',silverwall:'⚪',goldwall:'🟡',titanwall:'🔷',stuhl:'🪑',bank:'🛋️',holzboden:'🟫',steinboden:'⬜',kuechenherd:'🍳',schutzzone:'🚫',feld_beeren:'🫐',feld_gemuese:'🥕',feld_kraeuter:'🌱',feld_fasern:'🌿',feld_getreide:'🌾',tiergehege:'🐾',
  toepferei:'🏺',gerberei:'🧴',muehle:'🌬️',baeckerei:'🥖',alchemielabor:'⚗️',schreinerei:'🪚',steinmetz:'🔨',
  schreibtisch:'🗒️',kommode:'🗄️',fackel:'🔦',kamin:'🧱',teppich:'🟥',statue:'🗿',blumentopf:'🪴',
  schachtisch:'♟️',kegelbahn:'🎳',musikecke:'🎻',
  spitzenfalle:'⚠️',ballista:'🏹',marmorboden:'⬜',gartenweg:'🟤',
  primitivbank:'🪵',werkstatt:'🔧',schmiede:'⚒️',werft:'⛵',lagerkiste:'🧰',
  holzwand1:'🪵',holzwand2:'🪵',holzwand3:'🪵',
  fensterwand1:'🪟',fensterwand2:'🪟',fensterwand3:'🪟',
  metallwand1:'⚙️',metallwand2:'⚙️',metallwand3:'⚙️'};
function drawStoneBlocks(sx,sy,baseCol,darkCol,lightCol,mortarCol){
  ctx.fillStyle = mortarCol; ctx.fillRect(sx,sy,TILE,TILE);
  const blocks = [[0,0,16,10],[16,0,16,10],[0,10,10,11],[10,10,22,11],[0,21,14,11],[14,21,18,11]];
  blocks.forEach(([bx,by,bw,bh],i)=>{
    ctx.fillStyle = i%2===0 ? baseCol : shadeColor(baseCol,-6);
    ctx.fillRect(sx+bx+1,sy+by+1,bw-2,bh-2);
    ctx.fillStyle = lightCol; ctx.globalAlpha=0.35;
    ctx.fillRect(sx+bx+1,sy+by+1,bw-2,2);
    ctx.globalAlpha=1;
    ctx.fillStyle = darkCol; ctx.globalAlpha=0.3;
    ctx.fillRect(sx+bx+1,sy+by+bh-3,bw-2,2);
    ctx.globalAlpha=1;
  });
  ctx.fillStyle='rgba(255,255,255,.05)'; ctx.fillRect(sx,sy,TILE,TILE*0.4);
  ctx.fillStyle='rgba(0,0,0,.1)'; ctx.fillRect(sx,sy+TILE*0.6,TILE,TILE*0.4);
}
function drawWoodPlanks(sx,sy,baseCol){
  ctx.fillStyle = baseCol; ctx.fillRect(sx,sy,TILE,TILE);
  ctx.strokeStyle = shadeColor(baseCol,-30); ctx.lineWidth=1;
  for(let i=1;i<4;i++){ ctx.beginPath(); ctx.moveTo(sx,sy+i*TILE/4); ctx.lineTo(sx+TILE,sy+i*TILE/4); ctx.stroke(); }
  ctx.strokeStyle = shadeColor(baseCol,18); ctx.globalAlpha=0.4;
  for(let i=0;i<4;i++){ ctx.beginPath(); ctx.moveTo(sx,sy+i*TILE/4+1); ctx.lineTo(sx+TILE,sy+i*TILE/4+1); ctx.stroke(); }
  ctx.globalAlpha=1;
  ctx.fillStyle='rgba(255,255,255,.05)'; ctx.fillRect(sx,sy,TILE,TILE*0.4);
  ctx.fillStyle='rgba(0,0,0,.1)'; ctx.fillRect(sx,sy+TILE*0.6,TILE,TILE*0.4);
}
// Nachbar-Erkennung für Zäune und Mauern (oben, unten, links, rechts)
const FENCE_LIKE = ['wall','zaun','copperwall','silverwall','goldwall','titanwall','door','tower',
  'holzwand1', 'holzwand2', 'holzwand3', 'fensterwand1', 'fensterwand2', 'fensterwand3', 'metallwand1', 'metallwand2', 'metallwand3'];
/* ---------- Wandfamilien mit Stufen ----------
   Alle neuen Wände teilen sich dieselbe Autotiling-Grundlage: Steinwerk oder
   Bretter zeichnen, die Fugen zu vorhandenen Nachbarn überdecken und an
   freien Kanten einen Abschluss setzen. Die Stufe steuert nur Farbe, Muster
   und Beschläge — dadurch bleiben Aussehen und Verhalten konsistent. */
const WAND_STUFEN = {
  holzwand1:    { art:'holz',   basis:'#8b6f4e', dunkel:'#5a3d22', hell:'#b08a5e', stufe:1 },
  holzwand2:    { art:'holz',   basis:'#9a7a55', dunkel:'#5f4227', hell:'#c39a68', stufe:2 },
  holzwand3:    { art:'holz',   basis:'#a4855e', dunkel:'#63472a', hell:'#d0a877', stufe:3 },
  fensterwand1: { art:'fenster',basis:'#8b6f4e', dunkel:'#5a3d22', hell:'#b08a5e', glas:'#7fb8c9', stufe:1 },
  fensterwand2: { art:'fenster',basis:'#8f887c', dunkel:'#585349', hell:'#b8b1a2', glas:'#8fd0dd', stufe:2 },
  fensterwand3: { art:'fenster',basis:'#958e80', dunkel:'#5d574c', hell:'#c2bbac', glas:'#a8dbe8', stufe:3 },
  metallwand1:  { art:'metall', basis:'#7b828a', dunkel:'#464c52', hell:'#a3abb3', stufe:1 },
  metallwand2:  { art:'metall', basis:'#6f767e', dunkel:'#3f454b', hell:'#99a1a9', stufe:2 },
  metallwand3:  { art:'metall', basis:'#7d8894', dunkel:'#414850', hell:'#b3c0cc', stufe:3 },
};

/* Laufrichtung einer Wand aus ihren Nachbarn ableiten.
   'h' = waagerecht, 'v' = senkrecht, 'kreuz' = beides, 'frei' = allein
   stehendes Stück. Fenster und Türen richten sich danach aus, damit sie
   in der Mauer sitzen statt quer dazu. */
function wandRichtung(b){
  const c = fenceConnections(b);
  const waag = c.w || c.e, senk = c.n || c.s;
  if(waag && senk) return 'kreuz';
  if(waag) return 'h';
  if(senk) return 'v';
  return 'frei';
}

/* Zeichnet ein Wandband der angegebenen Dicke, mittig auf der Kachel und in
   Laufrichtung der Mauer. An angeschlossenen Kanten läuft das Band bis zum
   Kachelrand durch, damit die Naht zum vollbreiten Nachbarn dicht ist. */
function wandBand(b, sx, sy, dicke, malen){
  const c = fenceConnections(b);
  const r = wandRichtung(b);
  const halb = dicke/2, m = TILE/2;
  const teile = [];
  if(r === 'h' || r === 'kreuz' || r === 'frei'){
    const x0 = (r === 'frei') ? sx + m - halb : sx + (c.w ? -1 : m - halb);
    const x1 = (r === 'frei') ? sx + m + halb : sx + (c.e ? TILE + 1 : m + halb);
    teile.push([x0, sy + m - halb, x1 - x0, dicke]);
  }
  if(r === 'v' || r === 'kreuz'){
    const y0 = sy + (c.n ? -1 : m - halb);
    const y1 = sy + (c.s ? TILE + 1 : m + halb);
    teile.push([sx + m - halb, y0, dicke, y1 - y0]);
  }
  teile.forEach(([x,y,w,h])=> malen(x,y,w,h));
  return teile;
}

/* Risse auf beschädigten Wänden. Die Anzahl richtet sich nach dem
   Schadensanteil, ihre Lage ist über hash2 an die Kachel gebunden — sie
   springen also nicht von Bild zu Bild. Ohne das wäre die neue Haltbarkeit
   für den Spieler unsichtbar. */
function drawWallDamage(b, sx, sy, cx, cy){
  if(typeof wallMaxHp !== 'function') return;
  const max = wallMaxHp(b.type);
  if(!max || b.hp == null || b.hp >= max) return;
  const anteil = Math.max(0, Math.min(1, b.hp / max));
  const risse = anteil > 0.66 ? 1 : anteil > 0.33 ? 2 : 4;
  ctx.save();
  ctx.strokeStyle = 'rgba(20,14,10,.62)';
  ctx.lineWidth = 1.2;
  for(let i=0;i<risse;i++){
    const h = hash2(b.x*31 + i*7, b.y*17 + i*13);
    const ax = sx + 4 + (h % 22);
    const ay = sy + 4 + ((h >> 5) % 22);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax + ((h >> 3) % 7) - 3, ay + 5 + ((h >> 7) % 5));
    ctx.lineTo(ax + ((h >> 11) % 9) - 4, ay + 10 + ((h >> 9) % 4));
    ctx.stroke();
  }
  // stark beschädigt: Bruchstellen an den Kanten
  if(anteil < 0.34){
    ctx.fillStyle = 'rgba(0,0,0,.30)';
    const h2 = hash2(b.x*5, b.y*9);
    ctx.beginPath();
    ctx.moveTo(sx + (h2 % 12), sy);
    ctx.lineTo(sx + (h2 % 12) + 6, sy);
    ctx.lineTo(sx + (h2 % 12) + 3, sy + 5);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

function drawWandStufe(b, sx, sy, cx, cy){
  const cfg = WAND_STUFEN[b.type]; if(!cfg) return;
  const conn = fenceConnections(b);

  // --- Grundfläche ---
  if(cfg.art === 'holz'){
    // Grundfläche mit sanftem Verlauf statt flacher Fläche
    const hg = ctx.createLinearGradient(sx, sy, sx, sy+TILE);
    hg.addColorStop(0, shadeColor(cfg.basis, 12));
    hg.addColorStop(0.6, cfg.basis);
    hg.addColorStop(1, shadeColor(cfg.basis, -14));
    ctx.fillStyle = hg; ctx.fillRect(sx, sy, TILE, TILE);
    // senkrechte Bretter, ab Stufe 2 schmaler und zahlreicher
    const bretter = cfg.stufe >= 2 ? 5 : 4;
    for(let i=1;i<bretter;i++){
      const bx = sx + i*TILE/bretter;
      ctx.fillStyle = cfg.dunkel; ctx.fillRect(bx-0.5, sy+1, 1, TILE-2);
      ctx.fillStyle = 'rgba(255,255,255,.13)'; ctx.fillRect(bx+0.6, sy+1, 0.7, TILE-2);
    }
    // feine Maserung, je Kachel gleichbleibend über hash2
    ctx.strokeStyle = 'rgba(70,48,26,.20)'; ctx.lineWidth = 0.6;
    for(let i=0;i<bretter;i++){
      const mx = sx + (i+0.5)*TILE/bretter;
      const off = (hash2(b.x*7+i, b.y*13) % 100)/100;
      ctx.beginPath();
      ctx.moveTo(mx-1.5, sy+3 + off*4);
      ctx.quadraticCurveTo(mx+1.5, sy+TILE/2, mx-1, sy+TILE-3 - off*4);
      ctx.stroke();
    }
    // Querriegel mit Licht- und Schattenkante
    const riegel = (ry, hh)=>{
      ctx.fillStyle = shadeColor(cfg.dunkel, 16); ctx.fillRect(sx+1, ry, TILE-2, hh);
      ctx.fillStyle = 'rgba(255,255,255,.14)';    ctx.fillRect(sx+1, ry, TILE-2, 0.9);
      ctx.fillStyle = 'rgba(0,0,0,.24)';          ctx.fillRect(sx+1, ry+hh-1, TILE-2, 1);
    };
    if(cfg.stufe >= 2) riegel(cy-2, 3.5);
    if(cfg.stufe >= 3) riegel(sy+5, 3);
  } else if(cfg.art === 'metall'){
    // gebürstete Platte: Verlauf quer plus feine Schliffspuren
    const mg = ctx.createLinearGradient(sx, sy, sx+TILE, sy+TILE);
    mg.addColorStop(0, shadeColor(cfg.basis, 16));
    mg.addColorStop(0.45, cfg.basis);
    mg.addColorStop(1, shadeColor(cfg.basis, -14));
    ctx.fillStyle = mg; ctx.fillRect(sx, sy, TILE, TILE);
    ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.lineWidth = 0.6;
    for(let i=2;i<TILE;i+=5){
      ctx.beginPath(); ctx.moveTo(sx+1, sy+i); ctx.lineTo(sx+TILE-1, sy+i); ctx.stroke();
    }
    // Plattenstoß mit Fase
    ctx.fillStyle = cfg.dunkel;            ctx.fillRect(sx+1, cy-1, TILE-2, 2);
    ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(sx+1, cy+1, TILE-2, 0.8);
    // Nieten mit Glanzpunkt und Schattenkante
    const nieten = cfg.stufe >= 3 ? [[7,7],[TILE-7,7],[7,TILE-7],[TILE-7,TILE-7],[TILE/2,TILE/2]]
                 : cfg.stufe === 2 ? [[7,7],[TILE-7,7],[7,TILE-7],[TILE-7,TILE-7]]
                 : [[7,7],[TILE-7,TILE-7]];
    nieten.forEach(([dx,dy])=>{
      ctx.fillStyle = 'rgba(0,0,0,.30)';
      ctx.beginPath(); ctx.arc(sx+dx+0.5, sy+dy+0.7, 1.7, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = cfg.hell;
      ctx.beginPath(); ctx.arc(sx+dx, sy+dy, 1.6, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.beginPath(); ctx.arc(sx+dx-0.5, sy+dy-0.6, 0.6, 0, Math.PI*2); ctx.fill();
    });
    if(cfg.stufe >= 3){
      ctx.strokeStyle = 'rgba(168,216,232,.85)'; ctx.lineWidth = 1;
      ctx.strokeRect(sx+4.5, sy+4.5, TILE-9, TILE-9);
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 0.6;
      ctx.strokeRect(sx+5.6, sy+5.6, TILE-11.2, TILE-11.2);
    }
  } else {
    /* Fensterwand: nimmt bewusst nur die halbe Kachelbreite ein, damit die
       Mauer luftiger wirkt und man hindurchblickt. Das Band läuft in
       Mauerrichtung und weitet sich an angeschlossenen Kanten auf volle
       Breite, damit die Naht zum vollbreiten Nachbarn dicht bleibt. */
    const dicke = TILE * 0.5;
    const r = wandRichtung(b);

    // Schulterstücke: an jeder Anschlusskante ein kurzes Stück in voller Breite
    const c = fenceConnections(b);
    ctx.fillStyle = shadeColor(cfg.basis, -10);
    const schulter = 5;
    if(c.n) ctx.fillRect(sx+3,           sy-1,             TILE-6,   schulter);
    if(c.s) ctx.fillRect(sx+3,           sy+TILE-schulter+1, TILE-6, schulter);
    if(c.w) ctx.fillRect(sx-1,           sy+3,             schulter, TILE-6);
    if(c.e) ctx.fillRect(sx+TILE-schulter+1, sy+3,         schulter, TILE-6);

    // Rahmenband
    wandBand(b, sx, sy, dicke, (x,y,w,h)=>{
      const g = ctx.createLinearGradient(x, y, x, y+h);
      g.addColorStop(0, shadeColor(cfg.basis, 14));
      g.addColorStop(0.55, cfg.basis);
      g.addColorStop(1, shadeColor(cfg.basis, -16));
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,.16)'; ctx.fillRect(x, y, w, 1.2);
      ctx.fillStyle = 'rgba(0,0,0,.22)';       ctx.fillRect(x, y+h-1.4, w, 1.4);
    });

    // Scheibe: liegt mittig im Band, längs zur Mauerrichtung
    const laengs = (r === 'v');
    const gw = laengs ? dicke - 8 : (r === 'frei' ? dicke - 8 : TILE - 12);
    const gh = laengs ? TILE - 12 : dicke - 8;
    const gx = cx - gw/2, gy = cy - gh/2;

    ctx.fillStyle = shadeColor(cfg.dunkel, -6);
    ctx.fillRect(gx-1.6, gy-1.6, gw+3.2, gh+3.2);

    const scheibe = ctx.createLinearGradient(gx, gy, gx+gw, gy+gh);
    scheibe.addColorStop(0,   shadeColor(cfg.glas, 16));
    scheibe.addColorStop(0.5, cfg.glas);
    scheibe.addColorStop(1,   shadeColor(cfg.glas, -26));
    ctx.fillStyle = scheibe; ctx.fillRect(gx, gy, gw, gh);

    // schräger Lichtreflex
    ctx.save();
    ctx.beginPath(); ctx.rect(gx, gy, gw, gh); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,.30)';
    ctx.beginPath();
    ctx.moveTo(gx-2, gy+gh*0.85); ctx.lineTo(gx+gw*0.45, gy-2);
    ctx.lineTo(gx+gw*0.62, gy-2); ctx.lineTo(gx-2, gy+gh*1.05);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    // Sprossen ab Stufe 2, Bleiverglasung ab Stufe 3
    ctx.strokeStyle = shadeColor(cfg.dunkel, 10); ctx.lineWidth = 1;
    if(cfg.stufe >= 2){
      ctx.beginPath();
      if(laengs){ ctx.moveTo(gx, cy); ctx.lineTo(gx+gw, cy); }
      else       { ctx.moveTo(cx, gy); ctx.lineTo(cx, gy+gh); }
      ctx.stroke();
    }
    if(cfg.stufe >= 3){
      ctx.strokeStyle = 'rgba(92,82,60,.75)'; ctx.lineWidth = 0.7;
      for(let i=1;i<=2;i++){
        ctx.beginPath();
        if(laengs){ const yy = gy + gh*i/3; ctx.moveTo(gx, yy); ctx.lineTo(gx+gw, yy); }
        else       { const xx = gx + gw*i/3; ctx.moveTo(xx, gy); ctx.lineTo(xx, gy+gh); }
        ctx.stroke();
      }
    }
    // feine Rahmenkante
    ctx.strokeStyle = 'rgba(0,0,0,.30)'; ctx.lineWidth = 0.8;
    ctx.strokeRect(gx-1.6, gy-1.6, gw+3.2, gh+3.2);
    return;   // Fenster füllt die Kachel bewusst nicht — kein Kantenabschluss
  }

  // --- Fugen zu Nachbarn schließen (das eigentliche Autotiling) ---
  ctx.fillStyle = cfg.basis;
  if(conn.n) ctx.fillRect(sx+3,      sy-1,      TILE-6, 4);
  if(conn.s) ctx.fillRect(sx+3,      sy+TILE-3, TILE-6, 4);
  if(conn.w) ctx.fillRect(sx-1,      sy+3,      4,      TILE-6);
  if(conn.e) ctx.fillRect(sx+TILE-3, sy+3,      4,      TILE-6);

  // --- freie Kanten abschließen ---
  ctx.fillStyle = 'rgba(0,0,0,.28)';
  if(!conn.n) ctx.fillRect(sx, sy,        TILE, 2);
  if(!conn.s) ctx.fillRect(sx, sy+TILE-2, TILE, 2);
  if(!conn.w) ctx.fillRect(sx, sy,        2,    TILE);
  if(!conn.e) ctx.fillRect(sx+TILE-2, sy,  2,    TILE);

  // --- Höhe andeuten ---
  ctx.fillStyle='rgba(255,255,255,.16)'; ctx.fillRect(sx, sy, TILE, 2.5);
  ctx.fillStyle='rgba(0,0,0,.22)';       ctx.fillRect(sx, sy+TILE-3, TILE, 3);

  // --- Schadensbild: Risse, sobald die Haltbarkeit sinkt ---
  drawWallDamage(b, sx, sy, cx, cy);

  // --- Pfosten an Enden, Ecken und Kreuzungen ---
  const offen = [conn.n,conn.s,conn.w,conn.e].filter(v=>!v).length;
  if(offen >= 3 || (conn.n&&conn.e) || (conn.n&&conn.w) || (conn.s&&conn.e) || (conn.s&&conn.w)){
    ctx.fillStyle = cfg.dunkel;
    ctx.fillRect(cx-5, cy-5, 10, 10);
    ctx.fillStyle = 'rgba(255,255,255,.16)'; ctx.fillRect(cx-5, cy-5, 10, 2);
  }
}

function fenceConnections(b){
  const reg = b.regionId || 'C';
  const at = (dx,dy)=> state.buildings.some(bb =>
    bb.built && bb.x===b.x+dx && bb.y===b.y+dy &&
    FENCE_LIKE.includes(bb.type) && (bb.regionId||'C')===reg);
  return { n:at(0,-1), s:at(0,1), w:at(-1,0), e:at(1,0) };
}
// Merkt die gerade wirkende Drehung, damit Beschriftungen sie ausgleichen können
let activeBuildingRotation = 0;
// Zeichnet Text/Symbole immer aufrecht und an der ursprünglichen Position,
// unabhängig davon, wie das Gebäudesprite gedreht ist
function uprightText(txt, x, y, pivotX, pivotY){
  ctx.save();
  if(activeBuildingRotation){
    ctx.translate(pivotX, pivotY);
    ctx.rotate(-activeBuildingRotation*Math.PI/180);
    ctx.translate(-pivotX, -pivotY);
  }
  ctx.fillText(txt, x, y);
  ctx.restore();
}
/* ============================================================
   Dreiviertel-Ansicht: Körper mit sichtbarer Höhe
   Zeichnet einen Quader mit Deckfläche, Vorderkante und Schatten,
   damit Möbel wie Gegenstände wirken statt wie Aufkleber.
============================================================ */
/* Möbel mit Vorderseite in vier Ansichten: Statt das ganze Sprite zu
   drehen (wobei die Beine zur Seite kippen), bleibt der Sockel unten
   und nur der Aufbau wechselt die Seite — dieselbe Logik wie beim Stuhl. */
/* Fassadenmöbel: Korpus mit Höhe, dessen Vorderseite je nach
   Blickrichtung die Seite wechselt. Sockel und Schatten bleiben unten,
   damit nichts kippt — dieselbe Grundregel wie beim Stuhl. */
function drawFacadeFurniture(sx, sy, rot, opts){
  const o = opts || {};
  const col = o.color || '#8b6f4e';
  const dark = shadeColor(col, -36);
  const light = shadeColor(col, 20);
  const top = o.top !== undefined ? o.top : 5;
  const h = o.height !== undefined ? o.height : TILE - top - 6;
  // Schatten immer unten
  ctx.fillStyle = 'rgba(0,0,0,.24)';
  ctx.beginPath(); ctx.ellipse(sx+TILE/2, sy+TILE-5, o.shadowW||12, 3.4, 0, 0, Math.PI*2); ctx.fill();
  // Korpus
  const g = ctx.createLinearGradient(sx, sy+top, sx, sy+top+h);
  g.addColorStop(0, light); g.addColorStop(0.45, col); g.addColorStop(1, dark);
  ctx.fillStyle = g;
  ctx.fillRect(sx+3, sy+top, TILE-6, h);
  ctx.strokeStyle = shadeColor(dark,-14); ctx.lineWidth = 1;
  ctx.strokeRect(sx+3, sy+top, TILE-6, h);
  // Deckfläche als schmaler heller Streifen
  ctx.fillStyle = shadeColor(light, 12);
  ctx.fillRect(sx+3, sy+top, TILE-6, 2.4);
  const pal = {col, dark, light, top:sy+top, h};
  ctx.save();
  if(rot === 0){
    if(o.front) o.front(sx, sy, ctx, pal);
  } else if(rot === 180){
    // Rückseite: schlichte Fläche mit Fugen
    ctx.fillStyle = shadeColor(col,-18);
    ctx.fillRect(sx+5, sy+top+4, TILE-10, h-7);
    ctx.strokeStyle = dark; ctx.lineWidth=0.7;
    for(let i=1;i<3;i++){
      const yy = sy+top+4 + (h-7)*i/3;
      ctx.beginPath(); ctx.moveTo(sx+5,yy); ctx.lineTo(sx+TILE-5,yy); ctx.stroke();
    }
    if(o.back) o.back(sx, sy, ctx, pal);
  } else {
    // Seitenansicht: schmale Fassade zur Zielseite
    const east = (rot === 270);
    const fx = east ? sx+TILE-11 : sx+5;
    ctx.fillStyle = shadeColor(col,-10);
    ctx.fillRect(fx, sy+top+4, 6, h-8);
    ctx.strokeStyle = dark; ctx.lineWidth=0.8;
    ctx.strokeRect(fx, sy+top+4, 6, h-8);
    ctx.fillStyle = light;
    ctx.fillRect(fx+1, sy+top+5, 4, 1.6);
    if(o.side) o.side(sx, sy, ctx, pal, east);
  }
  ctx.restore();
}
function drawFrontedFurniture(sx, sy, rot, opts){
  const o = opts || {};
  const bodyCol = o.color || '#8b6f4e';
  const dark = shadeColor(bodyCol, -34);
  const light = shadeColor(bodyCol, 22);
  const legs = (o.legs !== false);
  // Schatten und Beine bleiben immer unten
  ctx.fillStyle='rgba(0,0,0,.25)';
  ctx.beginPath(); ctx.ellipse(sx+TILE/2, sy+TILE-6, (o.shadowW||10), 3.2, 0, 0, Math.PI*2); ctx.fill();
  if(legs){
    ctx.fillStyle = shadeColor(bodyCol,-40);
    ctx.fillRect(sx+6, sy+19, 2.5, 8); ctx.fillRect(sx+TILE-8.5, sy+19, 2.5, 8);
  }
  const bodyY = legs ? sy+9 : sy+7;
  const bodyH = legs ? 11 : 15;
  // Korpus mit Höhe
  drawSolid(sx+3, bodyY, TILE-6, 7, bodyH*0.55, bodyCol);
  // Vorderseite je nach Blickrichtung
  ctx.save();
  if(rot===0){
    // nach Süden: Front zeigt zum Betrachter
    if(o.front) o.front(sx, sy, ctx, {bodyCol, dark, light});
  } else if(rot===180){
    // nach Norden: schlichte Rückseite
    ctx.fillStyle = shadeColor(bodyCol,-16);
    ctx.fillRect(sx+5, bodyY+3, TILE-10, bodyH*0.45);
    ctx.strokeStyle = dark; ctx.lineWidth=0.8;
    ctx.strokeRect(sx+5, bodyY+3, TILE-10, bodyH*0.45);
  } else {
    // Seitenansicht: schmale Front an der Zielseite
    const east = (rot===270);
    const fx = east ? sx+TILE-11 : sx+5;
    ctx.fillStyle = shadeColor(bodyCol,-10);
    ctx.fillRect(fx, bodyY+2, 6, bodyH*0.5);
    ctx.strokeStyle = dark; ctx.lineWidth=0.8;
    ctx.strokeRect(fx, bodyY+2, 6, bodyH*0.5);
    ctx.fillStyle = light;
    ctx.fillRect(fx+1, bodyY+3, 4, 1.5);
  }
  ctx.restore();
}
function drawSolid(x, y, w, d, h, topCol, opts){
  const o = opts || {};
  const frontCol = o.front || shadeColor(topCol, -26);
  const sideCol  = o.side  || shadeColor(topCol, -14);
  const outline  = o.outline || 'rgba(48,32,16,.75)';
  // Bodenschatten
  if(o.shadow !== false){
    ctx.fillStyle = 'rgba(0,0,0,.26)';
    ctx.beginPath();
    ctx.ellipse(x + w/2, y + d + 1.5, w*0.55, Math.max(2, d*0.32), 0, 0, Math.PI*2);
    ctx.fill();
  }
  // Vorderkante (die eigentliche Höhe)
  ctx.fillStyle = frontCol;
  ctx.fillRect(x, y + d - h*0.15, w, h);
  // rechte Seitenfläche für zusätzliche Tiefe
  ctx.fillStyle = sideCol;
  ctx.beginPath();
  ctx.moveTo(x + w, y + d - h*0.15);
  ctx.lineTo(x + w + Math.min(3, h*0.3), y + d - h*0.15 - Math.min(2, h*0.2));
  ctx.lineTo(x + w + Math.min(3, h*0.3), y + d - h*0.15 + h - Math.min(2, h*0.2));
  ctx.lineTo(x + w, y + d - h*0.15 + h);
  ctx.closePath(); ctx.fill();
  // Deckfläche mit leichtem Verlauf
  const g = ctx.createLinearGradient(x, y, x, y + d);
  g.addColorStop(0, shadeColor(topCol, 12));
  g.addColorStop(1, topCol);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, d);
  // Konturen
  ctx.strokeStyle = outline; ctx.lineWidth = 0.9;
  ctx.strokeRect(x, y, w, d);
  ctx.strokeRect(x, y + d - h*0.15, w, h);
  // Lichtkante oben
  ctx.fillStyle = 'rgba(255,255,255,.16)';
  ctx.fillRect(x, y, w, 1.4);
}
/* ============================================================
   Sichtbare Betriebsamkeit: Rauch, Funken, Dampf
   Zeigt auf einen Blick, welche Gebäude gerade arbeiten.
============================================================ */
// Aufsteigende Rauchwolken aus einem Schornstein
function drawSmoke(x, y, opts){
  const o = opts || {};
  const n = o.puffs || 4;
  const speed = o.speed || 2600;
  const rise = o.rise || 22;
  const col = o.color || '200,196,188';
  const seed = o.seed || 0;
  const t = performance.now();
  ctx.save();
  for(let i=0;i<n;i++){
    const phase = ((t/speed) + i/n + seed*0.13) % 1;
    const py = y - phase*rise;
    const drift = Math.sin(phase*Math.PI*1.6 + seed) * (o.drift||4);
    const size = (o.size||2.4) + phase*(o.grow||3.2);
    const alpha = (1 - phase) * (o.alpha||0.42);
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle = `rgb(${col})`;
    ctx.beginPath(); ctx.arc(x + drift, py, size, 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();
}
// Funken über einer Esse
function drawSparks(x, y, seed){
  const t = performance.now();
  ctx.save();
  for(let i=0;i<5;i++){
    const phase = ((t/700) + i/5 + seed*0.2) % 1;
    const py = y - phase*12;
    const px = x + Math.sin(phase*7 + i)*3.5;
    ctx.globalAlpha = (1-phase)*0.85;
    ctx.fillStyle = phase<0.4 ? '#ffd98a' : '#e8623b';
    ctx.beginPath(); ctx.arc(px, py, 1.1*(1-phase*0.5), 0, Math.PI*2); ctx.fill();
  }
  ctx.restore();
}
// Kleiner Schornstein als Aufsatz
function drawChimney(x, y, w, h, col){
  ctx.fillStyle = col || '#6b6a5f';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x, y, w, 1.5);
  ctx.strokeStyle = 'rgba(40,36,30,.7)'; ctx.lineWidth = 0.8;
  ctx.strokeRect(x, y, w, h);
}
function drawBuilding(b, sx, sy){
  const cx=sx+TILE/2, cy=sy+TILE/2;
  // Baustellen-Anzeige: nie mitdrehen, die Prozentzahl muss lesbar bleiben
  if(!b.built){
    ctx.save();
    ctx.strokeStyle='#e8a94d'; ctx.setLineDash([4,3]); ctx.lineWidth=2;
    ctx.strokeRect(sx+4,sy+4,TILE-8,TILE-8); ctx.setLineDash([]);
    ctx.fillStyle='rgba(232,169,77,.18)'; ctx.fillRect(sx+4,sy+4,TILE-8,TILE-8);
    ctx.fillStyle='#efe6cd'; ctx.font='9px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(Math.round(b.work/b.workReq*100)+'%', cx, cy);
    ctx.restore(); return;
  }
  // Sitzmöbel zeichnen ihre vier Ansichten selbst — eine gedrehte Grafik
  // würde die Beine zur Seite kippen lassen statt nach unten.
  /* Möbel mit erkennbarer Vorderseite zeichnen vier eigene Ansichten.
     Rundum gleiche Objekte (Brunnen, Statue, Blumentopf, Fackel) und
     Zonen brauchen das nicht — sie sehen aus jeder Richtung gleich aus. */
  const SELF_ORIENTED = ['stuhl','bank','kommode','schreibtisch','bibliothek','vorratskammer',
                         'krankenstube','barber','kamin','lagerkiste','tent'];
  /* Rundum gleiche Bauten bekommen gar keine Ausrichtung. Das Lagerfeuer
     stand versehentlich nicht in dieser Liste: bei 90/270 Grad legte die
     Seitenansicht eine dunkle Wand an den Rand — das war der schwarze
     Balken links neben der Feuerstelle. Eine Feuerstelle hat keine
     Vorderseite, eine Spitzenfalle ebenso wenig. */
  const NO_ROTATE = ['brunnen','statue','blumentopf','fackel','stockpile','schutzzone',
                     'campfire','spitzenfalle',
                     'holzboden','steinboden','teppich','marmorboden','gartenweg'];
  /* Ausrichtung für alle übrigen Bauten.

     Vorher wurde hier das komplette Sprite um 90/180/270 Grad gedreht — ein
     Sägewerk lag dadurch bei 90 Grad auf der Seite, Beine und Schornsteine
     zeigten waagerecht. Der Stuhl macht es richtig: Boden und Beine bleiben
     unten, nur die sichtbare Seite wechselt.

     Diese Behandlung überträgt das Prinzip auf alle Bauten, ohne für jedes
     einzelne vier Grafiken von Hand zu zeichnen: Die Grundgrafik bleibt
     aufrecht, wird zur Seite hin gestaucht (Verkürzung) und bekommt je nach
     Richtung eine Rück- oder Seitenwand aufgelegt. */
  if(b.rotation && !SELF_ORIENTED.includes(b.type) && !NO_ROTATE.includes(b.type)){
    const prevRot = activeBuildingRotation;
    activeBuildingRotation = b.rotation;      // Beschriftungen bleiben waagerecht
    const flach = Object.assign({}, b, {rotation:0});
    const rotB = b.rotation;

    if(rotB === 180){
      // Rückansicht: Grundgrafik, darüber eine schlichte Rückwand
      drawBuilding(flach, sx, sy);
      ctx.save();
      ctx.fillStyle = 'rgba(58,44,30,.82)';
      ctx.fillRect(sx+4, sy+5, TILE-8, TILE-13);
      ctx.strokeStyle = 'rgba(30,22,14,.9)'; ctx.lineWidth = 1;
      ctx.strokeRect(sx+4.5, sy+5.5, TILE-9, TILE-14);
      ctx.strokeStyle = 'rgba(255,255,255,.10)'; ctx.lineWidth = 0.7;
      for(let i=1;i<3;i++){
        const yy = sy+5 + (TILE-13)*i/3;
        ctx.beginPath(); ctx.moveTo(sx+6, yy); ctx.lineTo(sx+TILE-6, yy); ctx.stroke();
      }
      ctx.restore();
    } else {
      // Seitenansicht: gestaucht, bei Ost zusätzlich gespiegelt
      const ost = (rotB === 270);
      ctx.save();
      ctx.translate(cx, 0);
      ctx.scale(ost ? -0.72 : 0.72, 1);
      ctx.translate(-cx, 0);
      drawBuilding(flach, sx, sy);
      ctx.restore();
      /* Andeutung der abgewandten Seite. Bewusst ein weicher Schatten, der
         zum Rand hin ausläuft — eine deckende Platte las sich auf hellen
         Bauten wie ein schwarzer Balken statt wie eine Wand. */
      ctx.save();
      ctx.beginPath(); ctx.rect(sx, sy, TILE, TILE); ctx.clip();
      const wx = ost ? sx+3 : sx+TILE-10;
      const g = ctx.createLinearGradient(ost ? wx+7 : wx, 0, ost ? wx : wx+7, 0);
      g.addColorStop(0, 'rgba(38,28,18,.46)');
      g.addColorStop(1, 'rgba(38,28,18,0)');
      ctx.fillStyle = g;
      ctx.fillRect(wx, sy+7, 7, TILE-15);
      ctx.fillStyle = 'rgba(255,255,255,.09)';
      ctx.fillRect(ost ? wx : wx+5.8, sy+7, 1.2, TILE-15);
      ctx.restore();
    }

    activeBuildingRotation = prevRot;
    return;
  }
  if(b.type==='lagerkiste'){
    // Truhe: Deckel bleibt oben, Schloss wandert auf die Blickseite
    const rotL = b.rotation||0;
    ctx.fillStyle='rgba(0,0,0,.22)';
    ctx.beginPath(); ctx.ellipse(cx,sy+TILE-5,11,3.4,0,0,Math.PI*2); ctx.fill();
    const body = ctx.createLinearGradient(sx, sy+14, sx, sy+TILE-6);
    body.addColorStop(0,'#a4794a'); body.addColorStop(1,'#6b4a2b');
    ctx.fillStyle=body; ctx.fillRect(sx+5, sy+14, TILE-10, TILE-20);
    ctx.strokeStyle='#3a2814'; ctx.lineWidth=1; ctx.strokeRect(sx+5, sy+14, TILE-10, TILE-20);
    // gewölbter Deckel
    ctx.fillStyle='#8b6f4e';
    ctx.beginPath();
    ctx.moveTo(sx+5, sy+14);
    ctx.quadraticCurveTo(cx, sy+4, sx+TILE-5, sy+14);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#3a2814'; ctx.lineWidth=1; ctx.stroke();
    ctx.fillStyle='rgba(255,255,255,.18)';
    ctx.beginPath();
    ctx.moveTo(sx+7, sy+13); ctx.quadraticCurveTo(cx-3, sy+7, cx+2, sy+8.5);
    ctx.lineTo(cx, sy+10); ctx.quadraticCurveTo(cx-3, sy+9, sx+8, sy+13.5);
    ctx.closePath(); ctx.fill();
    // Metallbänder
    ctx.fillStyle='#6f6a5c';
    [9, TILE-12].forEach(bx=>{ ctx.fillRect(sx+bx, sy+13, 3, TILE-19); });
    // Schloss auf der Blickseite
    ctx.fillStyle='#c9a23d';
    if(rotL===0)        ctx.fillRect(cx-2.5, sy+17, 5, 5);
    else if(rotL===180) ctx.fillRect(cx-2.5, sy+TILE-11, 5, 5);
    else if(rotL===90)  ctx.fillRect(sx+6, sy+19, 5, 5);
    else                ctx.fillRect(sx+TILE-11, sy+19, 5, 5);
    ctx.strokeStyle='#8a6f1e'; ctx.lineWidth=0.8;
    return;
  } else if(b.type==='copperwall'||b.type==='silverwall'||b.type==='goldwall'||b.type==='titanwall'){
    const tint = {copperwall:['#c9702c','#8a4a1c','#e8a05a'], silverwall:['#a8adb3','#6f747a','#e0e4e8'], goldwall:['#c9962c','#8a651c','#f2d477'], titanwall:['#5a7a9a','#3a5266','#a8ccec']}[b.type];
    drawStoneBlocks(sx,sy,tint[0],tint[1],tint[2],shadeColor(tint[1],-15));
    ctx.fillStyle='rgba(255,255,255,.2)'; ctx.fillRect(sx,sy,TILE,3);
    ctx.fillStyle='rgba(0,0,0,.3)'; ctx.fillRect(sx,sy+TILE-4,TILE,4);
    const glow = 0.35+Math.sin(performance.now()/450 + sx*0.05)*0.15;
    ctx.save(); ctx.globalAlpha=glow; ctx.fillStyle=tint[2]; ctx.fillRect(sx+3,sy+3,TILE-6,4); ctx.restore();
  } else if(b.type==='zaun'){
    /* Auto-Tiling: Latten laufen nur in Richtungen mit Nachbarn,
       Pfosten stehen an Enden, Ecken und Kreuzungen. */
    const conn = fenceConnections(b);
    const RAIL_A = 10, RAIL_B = TILE-14, RAIL_T = 4;   // Höhe der beiden Querlatten
    const rail = '#8b6f4e', railDark = '#6f5539', post = '#6b4a2b', outline = '#4a3018';
    const drawRail = (x,y,w,h)=>{
      ctx.fillStyle = rail; ctx.fillRect(x,y,w,h);
      ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(x,y,w,1.2);
      ctx.fillStyle = railDark; ctx.fillRect(x,y+h-1.2,w,1.2);
      ctx.strokeStyle = outline; ctx.lineWidth=0.7; ctx.strokeRect(x,y,w,h);
    };
    const mid = TILE/2;
    // Waagerechte Latten: von der Mitte bis über den jeweiligen Rand hinaus
    if(conn.w){ drawRail(sx-1,        sy+RAIL_A, mid+1,   RAIL_T);
                drawRail(sx-1,        sy+RAIL_B, mid+1,   RAIL_T); }
    if(conn.e){ drawRail(sx+mid,      sy+RAIL_A, mid+1,   RAIL_T);
                drawRail(sx+mid,      sy+RAIL_B, mid+1,   RAIL_T); }
    // Senkrechte Latten für vertikale Verläufe
    if(conn.n){ drawRail(sx+8,        sy-1,      RAIL_T,  mid+1);
                drawRail(sx+TILE-12,  sy-1,      RAIL_T,  mid+1); }
    if(conn.s){ drawRail(sx+8,        sy+mid,    RAIL_T,  mid+1);
                drawRail(sx+TILE-12,  sy+mid,    RAIL_T,  mid+1); }
    // Einzelstück ohne Nachbarn: kurzes Stück Zaun, damit es nicht leer wirkt
    if(!conn.n && !conn.s && !conn.w && !conn.e){
      drawRail(sx+5, sy+RAIL_A, TILE-10, RAIL_T);
      drawRail(sx+5, sy+RAIL_B, TILE-10, RAIL_T);
    }
    // Pfosten: an Enden, Ecken und Kreuzungen — nicht mitten auf gerader Strecke
    const count = (conn.n?1:0)+(conn.s?1:0)+(conn.w?1:0)+(conn.e?1:0);
    const straightH = conn.w && conn.e && !conn.n && !conn.s;
    const straightV = conn.n && conn.s && !conn.w && !conn.e;
    if(!straightH && !straightV){
      ctx.fillStyle = post;
      ctx.fillRect(sx+mid-3, sy+3, 6, TILE-6);
      ctx.fillStyle='rgba(255,255,255,.14)'; ctx.fillRect(sx+mid-3, sy+3, 2, TILE-6);
      ctx.strokeStyle=outline; ctx.lineWidth=0.8; ctx.strokeRect(sx+mid-3, sy+3, 6, TILE-6);
      // Pfostenkappe
      ctx.fillStyle='#7d5a36';
      ctx.beginPath(); ctx.moveTo(sx+mid-4, sy+3); ctx.lineTo(sx+mid, sy); ctx.lineTo(sx+mid+4, sy+3);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    } else if(count===2){
      // auf gerader Strecke nur ein schmaler Zwischenpfosten
      ctx.fillStyle = post;
      if(straightH) ctx.fillRect(sx+mid-2, sy+6, 4, TILE-12);
      else          ctx.fillRect(sx+6, sy+mid-2, TILE-12, 4);
    }
  } else if(b.type==='door'){
    /* Die Tür sitzt jetzt exakt mittig in der Mauer und richtet sich nach
       deren Laufrichtung aus. Vorher war es ein volles Quadrat mit fester
       senkrechter Mittelfuge — in einer waagerechten Mauer stand das Blatt
       dadurch quer. */
    const rD = wandRichtung(b);
    const quer = (rD === 'v');            // senkrechte Mauer -> Blatt liegt quer
    const rahmenD = TILE * 0.62;

    // Mauerstummel links und rechts der Öffnung, damit die Tür eingefasst ist
    const cD = fenceConnections(b);
    ctx.fillStyle = '#7d766a';
    const st = 5;
    if(cD.n) ctx.fillRect(sx+4,          sy-1,          TILE-8, st);
    if(cD.s) ctx.fillRect(sx+4,          sy+TILE-st+1,  TILE-8, st);
    if(cD.w) ctx.fillRect(sx-1,          sy+4,          st,     TILE-8);
    if(cD.e) ctx.fillRect(sx+TILE-st+1,  sy+4,          st,     TILE-8);

    // Zarge
    const zw = quer ? rahmenD : TILE-6;
    const zh = quer ? TILE-6  : rahmenD;
    const zx = cx - zw/2, zy = cy - zh/2;
    const zg = ctx.createLinearGradient(zx, zy, zx, zy+zh);
    zg.addColorStop(0, '#6b5340'); zg.addColorStop(1, '#4a3728');
    ctx.fillStyle = zg; ctx.fillRect(zx, zy, zw, zh);

    // Türblatt mit Holzmaserung
    const bw = zw - 5, bh = zh - 5;
    const bx = cx - bw/2, by = cy - bh/2;
    const bg = ctx.createLinearGradient(bx, by, bx+bw, by+bh);
    bg.addColorStop(0, '#9a7a55'); bg.addColorStop(0.5, '#8b6f4e'); bg.addColorStop(1, '#75593c');
    ctx.fillStyle = bg; ctx.fillRect(bx, by, bw, bh);

    // Füllungen: zwei eingelassene Felder, längs zum Blatt
    ctx.strokeStyle = 'rgba(74,48,24,.75)'; ctx.lineWidth = 0.9;
    for(let i=0;i<2;i++){
      let fx, fy, fw, fh;
      if(quer){ fw = bw - 6; fh = bh/2 - 5; fx = bx + 3; fy = by + 3 + i*(bh/2); }
      else    { fw = bw/2 - 5; fh = bh - 6; fx = bx + 3 + i*(bw/2); fy = by + 3; }
      ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fillRect(fx, fy, fw, fh);
      ctx.strokeRect(fx+0.5, fy+0.5, fw-1, fh-1);
    }

    // Mittelfuge in Laufrichtung des Blattes
    ctx.strokeStyle = '#4a3018'; ctx.lineWidth = 1;
    ctx.beginPath();
    if(quer){ ctx.moveTo(bx, cy); ctx.lineTo(bx+bw, cy); }
    else    { ctx.moveTo(cx, by); ctx.lineTo(cx, by+bh); }
    ctx.stroke();

    // Bänder und Griffe
    ctx.fillStyle = '#6b7278';
    if(quer){
      ctx.fillRect(bx+1.5, by+2.5, 2.5, 4); ctx.fillRect(bx+bw-4, by+2.5, 2.5, 4);
      ctx.fillRect(bx+1.5, by+bh-6.5, 2.5, 4); ctx.fillRect(bx+bw-4, by+bh-6.5, 2.5, 4);
    } else {
      ctx.fillRect(bx+2.5, by+1.5, 4, 2.5); ctx.fillRect(bx+bw-6.5, by+1.5, 4, 2.5);
      ctx.fillRect(bx+2.5, by+bh-4, 4, 2.5); ctx.fillRect(bx+bw-6.5, by+bh-4, 4, 2.5);
    }
    ctx.fillStyle = '#e8a94d';
    if(quer){
      ctx.beginPath(); ctx.arc(cx, cy-4, 1.7, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, cy+4, 1.7, 0, Math.PI*2); ctx.fill();
    } else {
      ctx.beginPath(); ctx.arc(cx-4, cy, 1.7, 0, Math.PI*2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx+4, cy, 1.7, 0, Math.PI*2); ctx.fill();
    }

    // saubere Außenkante der Zarge
    ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 0.9;
    ctx.strokeRect(zx+0.45, zy+0.45, zw-0.9, zh-0.9);
  } else if(b.type==='tent'){
    /* Bett in vier Ansichten: Beine bleiben unten, Kopfteil und Kissen
       wandern auf die Seite, zu der das Bett ausgerichtet ist. */
    const rotB = b.rotation||0;
    const vert = (rotB===0 || rotB===180);
    ctx.fillStyle='rgba(0,0,0,.24)';
    ctx.beginPath(); ctx.ellipse(cx, sy+TILE-5, 12, 3.4, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle='#5a3d22';
    ctx.fillRect(sx+4, sy+23, 2.5, 6); ctx.fillRect(sx+TILE-6.5, sy+23, 2.5, 6);
    // Matratze — längs oder quer je nach Ausrichtung
    const mx = vert ? sx+4 : sx+3, my = vert ? sy+7 : sy+9;
    const mw = vert ? TILE-8 : TILE-6, mh = vert ? 16 : 13;
    const mg = ctx.createLinearGradient(sx, my, sx, my+mh);
    mg.addColorStop(0,'#6a4a7d'); mg.addColorStop(1,'#4a3159');
    ctx.fillStyle=mg; ctx.fillRect(mx, my, mw, mh);
    ctx.strokeStyle='#33224a'; ctx.lineWidth=1; ctx.strokeRect(mx, my, mw, mh);
    // Kopfteil und Kissen an der Blickseite
    ctx.fillStyle='#6b4a2b';
    ctx.fillStyle='#efe6cd';
    if(rotB===0){        // Kopf oben
      ctx.fillStyle='#6b4a2b'; ctx.fillRect(sx+3, sy+3, TILE-6, 3.5);
      ctx.fillStyle='#efe6cd'; ctx.fillRect(sx+7, my+2, TILE-14, 5);
      ctx.fillStyle='#c9822c'; ctx.fillRect(mx, my+mh-6, mw, 5);
    } else if(rotB===180){ // Kopf unten
      ctx.fillStyle='#6b4a2b'; ctx.fillRect(sx+3, sy+TILE-6.5, TILE-6, 3.5);
      ctx.fillStyle='#efe6cd'; ctx.fillRect(sx+7, my+mh-7, TILE-14, 5);
      ctx.fillStyle='#c9822c'; ctx.fillRect(mx, my+1, mw, 5);
    } else {              // Kopf links oder rechts
      const east = (rotB===270);
      const hx = east ? sx+TILE-6.5 : sx+3;
      ctx.fillStyle='#6b4a2b'; ctx.fillRect(hx, sy+6, 3.5, TILE-13);
      ctx.fillStyle='#efe6cd';
      ctx.fillRect(east ? mx+mw-7 : mx+2, my+3, 5, mh-6);
      ctx.fillStyle='#c9822c';
      ctx.fillRect(east ? mx+1 : mx+mw-6, my, 5, mh);
    }
    ctx.strokeStyle='#8a5a1e'; ctx.lineWidth=0.8;
  } else if(b.type==='sawmill'){
    drawWoodPlanks(sx,sy,'#8b6f4e');
    ctx.fillStyle='#c9a15a'; ctx.fillRect(sx+3,sy+TILE-11,TILE-6,7);
    ctx.strokeStyle='#6b4a2b'; ctx.lineWidth=1;
    for(let i=0;i<3;i++){ ctx.beginPath(); ctx.arc(sx+8+i*7,sy+TILE-8,2,0,Math.PI*2); ctx.stroke(); }
    // Sägeblatt dreht sich sichtbar
    const bladeX = sx+TILE-9, bladeY = sy+9;
    const spin = performance.now()/260 + b.x;
    ctx.fillStyle='#c9c9c9'; ctx.beginPath(); ctx.arc(bladeX,bladeY,7,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#7a7a7a'; ctx.lineWidth=1;
    for(let i=0;i<8;i++){
      const ang = spin + i/8*Math.PI*2;
      ctx.beginPath(); ctx.moveTo(bladeX,bladeY);
      ctx.lineTo(bladeX+Math.cos(ang)*7, bladeY+Math.sin(ang)*7); ctx.stroke();
    }
    // Zähne am Rand
    ctx.strokeStyle='#9a9a9a'; ctx.lineWidth=1.4;
    for(let i=0;i<10;i++){
      const ang = -spin*0.6 + i/10*Math.PI*2;
      ctx.beginPath();
      ctx.moveTo(bladeX+Math.cos(ang)*6.4, bladeY+Math.sin(ang)*6.4);
      ctx.lineTo(bladeX+Math.cos(ang)*8, bladeY+Math.sin(ang)*8); ctx.stroke();
    }
    // Sägemehl stiebt gelegentlich
    const dust = (performance.now()/900 + b.x*0.3) % 1;
    if(dust < 0.5){
      ctx.save(); ctx.globalAlpha = (0.5-dust)*0.9;
      ctx.fillStyle='#e0cfa8';
      for(let i=0;i<3;i++){
        ctx.beginPath();
        ctx.arc(bladeX-4-dust*8+i*2, bladeY+6+dust*5+i, 1.1, 0, Math.PI*2); ctx.fill();
      }
      ctx.restore();
    }
  } else if(b.type==='furnace'||b.type==='forge'){
    drawSolid(sx+2, sy+4, TILE-4, 13, 12, '#7a7268', {front:'#4a453e', side:'#5f584f'});
    const flick=1+Math.sin(performance.now()/160)*0.15;
    ctx.fillStyle='#3a352e'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(sx+9,sy+14,TILE-18,12,3) : ctx.rect(sx+9,sy+14,TILE-18,12); ctx.fill();
    ctx.fillStyle='#e8623b'; ctx.beginPath(); ctx.ellipse(cx,sy+20,6*flick,4*flick,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#f2c65a'; ctx.beginPath(); ctx.ellipse(cx,sy+20,3*flick,2*flick,0,0,Math.PI*2); ctx.fill();
    if(b.type==='forge'){ ctx.fillStyle='#2a2a2a'; ctx.fillRect(sx+6,sy+5,TILE-12,6); ctx.strokeStyle='#111'; ctx.strokeRect(sx+6,sy+5,TILE-12,6); }
    // Betrieb sichtbar machen: Schornstein mit Rauch, dazu Funken
    drawChimney(sx+TILE-12, sy+1, 6, 7, '#5f584f');
    drawSmoke(sx+TILE-9, sy+1, {seed:b.x+b.y, puffs:5, rise:24, size:2.2, grow:3.4});
    drawSparks(cx, sy+16, b.x*0.7+b.y);
  } else if(b.type==='loom'){
    ctx.fillStyle='#6b4a2b'; ctx.fillRect(sx+3,sy+3,3,TILE-6); ctx.fillRect(sx+TILE-6,sy+3,3,TILE-6);
    ctx.fillRect(sx+3,sy+3,TILE-6,3); ctx.fillRect(sx+3,sy+TILE-6,TILE-6,3);
    ctx.strokeStyle='#efe6cd'; ctx.lineWidth=0.9;
    for(let i=1;i<6;i++){ ctx.beginPath(); ctx.moveTo(sx+3,sy+3+i*4); ctx.lineTo(sx+TILE-3,sy+3+i*4); ctx.stroke(); }
    ctx.strokeStyle='#c94f3d';
    for(let i=1;i<7;i++){ ctx.beginPath(); ctx.moveTo(sx+3+i*3.7,sy+3); ctx.lineTo(sx+3+i*3.7,sy+TILE-3); ctx.stroke(); }
    // Schiffchen läuft hin und her — sichtbarer Betrieb
    const shuttle = (Math.sin(performance.now()/620 + b.x)*0.5+0.5);
    const shx = sx+5 + shuttle*(TILE-14);
    ctx.fillStyle='#8b6f4e'; ctx.beginPath();
    ctx.ellipse(shx, sy+TILE/2, 3.4, 1.8, 0, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle='#4a3018'; ctx.lineWidth=0.7; ctx.stroke();
  } else if(b.type==='stockpile'){
    ctx.strokeStyle='#c9822c'; ctx.setLineDash([3,2]); ctx.lineWidth=1.5;
    ctx.strokeRect(sx+2,sy+2,TILE-4,TILE-4); ctx.setLineDash([]);
    ctx.fillStyle='#8b6f4e'; ctx.fillRect(sx+6,sy+14,9,9);
    ctx.strokeStyle='#4a3018'; ctx.lineWidth=0.8; ctx.strokeRect(sx+6,sy+14,9,9);
    ctx.fillStyle='#a8875c'; ctx.beginPath(); ctx.ellipse(sx+21,sy+19,5,7,0,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#6b4a2b'; ctx.beginPath(); ctx.ellipse(sx+21,sy+15,5,1.6,0,0,Math.PI*2); ctx.stroke();
  } else if(b.type==='schutzzone'){
    ctx.strokeStyle='#c9484a'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(sx+3,sy+9); ctx.lineTo(sx+3,sy+3); ctx.lineTo(sx+9,sy+3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx+TILE-9,sy+3); ctx.lineTo(sx+TILE-3,sy+3); ctx.lineTo(sx+TILE-3,sy+9); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx+3,sy+TILE-9); ctx.lineTo(sx+3,sy+TILE-3); ctx.lineTo(sx+9,sy+TILE-3); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx+TILE-9,sy+TILE-3); ctx.lineTo(sx+TILE-3,sy+TILE-3); ctx.lineTo(sx+TILE-3,sy+TILE-9); ctx.stroke();
    ctx.font='11px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillStyle='#c9484a';
    uprightText('🚫', cx, cy, cx, cy);
  } else if(b.type==='feld_beeren'||b.type==='feld_gemuese'||b.type==='feld_kraeuter'||b.type==='feld_fasern' || b.type==='feld_getreide'){
    // Beet deckend zeichnen — vorher schien der Untergrund durch
    const soil = ctx.createLinearGradient(sx,sy,sx,sy+TILE);
    soil.addColorStop(0,'#6b5238'); soil.addColorStop(1,'#4a3826');
    ctx.fillStyle=soil; ctx.fillRect(sx,sy,TILE,TILE);
    // gepflügte Furchen mit Licht- und Schattenkante
    for(let i=0;i<4;i++){
      const ry = sy + i*TILE/4;
      ctx.fillStyle='rgba(0,0,0,.22)'; ctx.fillRect(sx, ry+TILE/8, TILE, 2.5);
      ctx.fillStyle='rgba(255,255,255,.07)'; ctx.fillRect(sx, ry+TILE/8+2.5, TILE, 1.2);
    }
    // Beetrand
    ctx.strokeStyle='rgba(40,28,16,.55)'; ctx.lineWidth=1.4;
    ctx.strokeRect(sx+0.7,sy+0.7,TILE-1.4,TILE-1.4);
    /* Deckende Zeichenfarbe wiederherstellen. Aus der Furchenschleife stand
       hier noch rgba(255,255,255,.07) — damit wurden die Pflanzensymbole mit
       7 % Weiß gezeichnet und das reife Feld sah durchsichtig aus. */
    ctx.fillStyle='#efe6cd';
    const cropIcon = {feld_beeren:'🫐',feld_gemuese:'🥕',feld_kraeuter:'🌱',feld_getreide:'🌾'}[b.type];
    const progress = fieldGrowthProgress(b);
    const sway = Math.sin(performance.now()/500 + sx*0.03)*1.5;
    if(progress>=1){
      const glow = 0.35+Math.sin(performance.now()/300)*0.2;
      ctx.save(); ctx.globalAlpha=glow; ctx.fillStyle='#ffd23f';
      ctx.beginPath(); ctx.arc(cx,cy,15,0,Math.PI*2); ctx.fill(); ctx.restore();
      ctx.font='14px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      uprightText(cropIcon, cx-6+sway*0.4, cy-3, cx, cy);
      uprightText(cropIcon, cx+7-sway*0.4, cy+6, cx, cy);
      ctx.font='10px sans-serif'; uprightText('✨', cx, cy-14, cx, cy);
    } else if(progress>0.55){
      // Wachsende Pflanze skaliert statt zu verblassen
      ctx.save();
      ctx.font=Math.round(9+progress*5)+'px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      uprightText(cropIcon, cx+sway*0.3, cy, cx, cy);
      ctx.restore();
    } else if(progress>0.25){
      ctx.strokeStyle='#8fc93a'; ctx.lineWidth=1.6;
      ctx.beginPath(); ctx.moveTo(cx,cy+6); ctx.lineTo(cx+sway*0.5,cy-3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx-2,cy+3); ctx.lineTo(cx-4,cy-1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx+2,cy+3); ctx.lineTo(cx+4,cy-1); ctx.stroke();
    } else {
      ctx.strokeStyle='#8fc93a'; ctx.lineWidth=1.4;
      ctx.beginPath(); ctx.moveTo(cx,cy+6); ctx.lineTo(cx,cy+1); ctx.stroke();
    }
  } else if(b.type==='tiergehege'){
    ctx.save(); ctx.globalAlpha=0.35;
    ctx.fillStyle='#6b8f4e'; ctx.fillRect(sx+1,sy+1,TILE-2,TILE-2);
    ctx.restore();
    ctx.strokeStyle='#8b6f4e'; ctx.lineWidth=2;
    ctx.strokeRect(sx+3,sy+3,TILE-6,TILE-6);
    ctx.strokeStyle='#6b4a2b'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(sx+3,sy+3); ctx.lineTo(sx+9,sy+9); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx+TILE-3,sy+3); ctx.lineTo(sx+TILE-9,sy+9); ctx.stroke();
    ctx.font='12px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    uprightText('🐾', cx, cy, cx, cy);
  } else if(b.type==='tower'){
    ctx.fillStyle='rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-4,11,4,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#6b4a2b';
    [[sx+4,sy+6],[sx+TILE-8,sy+6],[sx+4,sy+TILE-12],[sx+TILE-8,sy+TILE-12]].forEach(([px,py])=>ctx.fillRect(px,py,4,10));
    ctx.fillStyle='#8b6f4e'; ctx.fillRect(sx+3,sy+3,TILE-6,10);
    ctx.strokeStyle='#4a3018'; ctx.lineWidth=1; ctx.strokeRect(sx+3,sy+3,TILE-6,10);
    ctx.fillStyle='#d9542d'; ctx.beginPath(); ctx.moveTo(sx+TILE-7,sy+1); ctx.lineTo(sx+TILE-7,sy+7); ctx.lineTo(sx+TILE-1,sy+4); ctx.closePath(); ctx.fill();
  } else if(b.type==='workbench'){
    ctx.fillStyle='#5a3d22'; ctx.fillRect(sx+5,sy+21,2.5,8); ctx.fillRect(sx+TILE-7.5,sy+21,2.5,8);
    drawSolid(sx+2, sy+9, TILE-4, 12, 6, '#8b6f4e');
    ctx.strokeStyle='#6b4a2b'; ctx.lineWidth=1.1;
    ctx.beginPath(); ctx.moveTo(sx+7,sy+12); ctx.lineTo(sx+TILE-9,sy+19); ctx.stroke();
    ctx.fillStyle='#9a9a9a'; ctx.beginPath(); ctx.moveTo(sx+TILE-11,sy+TILE-13); ctx.lineTo(sx+TILE-5,sy+TILE-9); ctx.lineTo(sx+TILE-9,sy+TILE-4); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#c9822c'; ctx.fillRect(sx+6,sy+TILE-11,9,4);
    ctx.strokeStyle='#4a3018'; ctx.lineWidth=0.8; ctx.strokeRect(sx+6,sy+TILE-11,9,4);
  } else if(b.type==='research'){
    ctx.fillStyle='#4a3018'; ctx.fillRect(sx+5,sy+21,2.5,8); ctx.fillRect(sx+TILE-7.5,sy+21,2.5,8);
    drawSolid(sx+2, sy+9, TILE-4, 12, 6, '#6b4a2b');
    ctx.fillStyle='#efe6cd'; ctx.fillRect(sx+6,sy+10,10,6);
    ctx.fillStyle='#c94f3d'; ctx.fillRect(sx+6,sy+8,10,2);
    ctx.fillStyle='#3e8e8e'; ctx.beginPath(); ctx.arc(sx+TILE-11,sy+TILE-11,6,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#26261f'; ctx.lineWidth=0.8; ctx.beginPath(); ctx.arc(sx+TILE-11,sy+TILE-11,6,0,Math.PI*2); ctx.stroke();
  } else if(b.type==='barber'){
    /* Vier Ansichten über drawFacadeFurniture. Diese Fassung lag beim
       Aufteilen des Monolithen in ui/panels.js und ist hier wieder an
       ihrem Platz — im Renderer stand nur noch eine ältere Variante,
       die jede Drehung gleich zeichnete. */
    drawFacadeFurniture(sx, sy, b.rotation||0, {
      color:'#8b6f4e', top:5, height:TILE-11, shadowW:13,
      front:(fx,fy,c,pal)=>{
        // ovaler Spiegel mit Rahmen, darunter Scheren
        c.fillStyle='#c9c9c9';
        c.beginPath(); c.ellipse(fx+TILE/2, pal.top+7, 6.5, 8, 0, 0, Math.PI*2); c.fill();
        c.strokeStyle='#c9a23d'; c.lineWidth=1.6; c.stroke();
        c.fillStyle='rgba(255,255,255,.55)';
        c.beginPath(); c.ellipse(fx+TILE/2-2, pal.top+4.5, 2, 3, -0.4, 0, Math.PI*2); c.fill();
        c.strokeStyle='#8f96a0'; c.lineWidth=1.2; c.lineCap='round';
        c.beginPath(); c.moveTo(fx+9, pal.top+pal.h-6); c.lineTo(fx+14, pal.top+pal.h-2); c.stroke();
        c.beginPath(); c.moveTo(fx+14, pal.top+pal.h-6); c.lineTo(fx+9, pal.top+pal.h-2); c.stroke();
        c.fillStyle='#c94f3d';
        c.fillRect(fx+TILE-11, pal.top+pal.h-7, 3, 6);
      }
    });
  } else if(b.type==='brunnen'){
    ctx.fillStyle='#8b8478'; ctx.beginPath(); ctx.arc(cx,cy+2,12,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#3e8e8e'; ctx.beginPath(); ctx.arc(cx,cy+2,8,0,Math.PI*2); ctx.fill();
    const ripple=1+Math.sin(performance.now()/300)*0.1;
    ctx.strokeStyle='rgba(255,255,255,.35)'; ctx.lineWidth=1; ctx.beginPath(); ctx.arc(cx,cy+2,4*ripple,0,Math.PI*2); ctx.stroke();
    ctx.strokeStyle='#5a5148'; ctx.lineWidth=1.4; ctx.beginPath(); ctx.arc(cx,cy+2,12,0,Math.PI*2); ctx.stroke();
    ctx.fillStyle='#6b4a2b'; ctx.fillRect(cx-1,sy+2,2,10);
  } else if(b.type==='vorratskammer'){
    drawFacadeFurniture(sx, sy, b.rotation||0, {
      color:'#7a5f42', top:6, height:TILE-13, shadowW:13,
      front:(fx,fy,c,pal)=>{
        // zwei Fässer und ein Sack
        [[8,'#8b6f4e'],[19,'#7a5430']].forEach(([bx,bc],i)=>{
          c.fillStyle = bc;
          c.fillRect(fx+bx-4, pal.top+5+i, 8, pal.h-9-i);
          c.strokeStyle='#4a3018'; c.lineWidth=0.8;
          c.strokeRect(fx+bx-4, pal.top+5+i, 8, pal.h-9-i);
          c.fillStyle='#5c4326';
          c.fillRect(fx+bx-4, pal.top+8+i, 8, 1.4);
          c.fillRect(fx+bx-4, pal.top+pal.h-13+i, 8, 1.4);
        });
        c.fillStyle='#c9b27a';
        c.beginPath(); c.ellipse(fx+TILE/2, pal.top+pal.h-5, 4.5, 3.5, 0, 0, Math.PI*2); c.fill();
        c.strokeStyle='#8a7245'; c.lineWidth=0.7; c.stroke();
      }
    });
  } else if(b.type==='krankenstube'){
    /* Vier Ansichten über drawFacadeFurniture. Diese Fassung lag beim
       Aufteilen des Monolithen in ui/panels.js und ist hier wieder an
       ihrem Platz — im Renderer stand nur noch eine ältere Variante,
       die jede Drehung gleich zeichnete. */
    drawFacadeFurniture(sx, sy, b.rotation||0, {
      color:'#efe6cd', top:7, height:TILE-14, shadowW:13,
      front:(fx,fy,c,pal)=>{
        // Liege mit Decke und rotem Kreuz
        c.fillStyle='#c9d6e8';
        c.fillRect(fx+5, pal.top+4, TILE-10, pal.h-9);
        c.strokeStyle='#8b9bb0'; c.lineWidth=0.8;
        c.strokeRect(fx+5, pal.top+4, TILE-10, pal.h-9);
        c.fillStyle='#fff'; c.fillRect(fx+7, pal.top+5.5, 7, 4);
        c.fillStyle='#c94f3d';
        c.fillRect(fx+TILE/2-1.4, pal.top+pal.h-11, 2.8, 8);
        c.fillRect(fx+TILE/2-4, pal.top+pal.h-8.4, 8, 2.8);
      }
    });
  } else if(b.type==='bibliothek'){
    /* Vier Ansichten über drawFacadeFurniture. Diese Fassung lag beim
       Aufteilen des Monolithen in ui/panels.js und ist hier wieder an
       ihrem Platz — im Renderer stand nur noch eine ältere Variante,
       die jede Drehung gleich zeichnete. */
    drawFacadeFurniture(sx, sy, b.rotation||0, {
      color:'#6b4a2b', top:5, height:TILE-11, shadowW:13,
      front:(fx,fy,c,pal)=>{
        // drei Regalböden mit bunten Buchrücken
        const cols=['#c94f3d','#3e8e8e','#c9822c','#5a3d6b','#4c7a3d'];
        for(let r=0;r<3;r++){
          const ry = pal.top + 3 + r*(pal.h-6)/3;
          c.fillStyle = shadeColor(pal.col,-24);
          c.fillRect(fx+5, ry+(pal.h-6)/3-2, TILE-10, 1.6);
          for(let i=0;i<5;i++){
            c.fillStyle = cols[(r*5+i)%cols.length];
            c.fillRect(fx+6+i*4, ry, 3, (pal.h-6)/3-3);
          }
        }
      }
    });
  } else if(b.type==='wachhaus'){
    drawStoneBlocks(sx,sy,'#8a8478','#5a564c','#b0aa9c','#4a463e');
    ctx.strokeStyle='#6b4a2b'; ctx.lineWidth=1.6;
    ctx.beginPath(); ctx.moveTo(sx+9,sy+TILE-4); ctx.lineTo(sx+TILE-9,sy+5); ctx.stroke();
    ctx.fillStyle='#9a9a9a'; ctx.beginPath(); ctx.moveTo(sx+TILE-11,sy+3); ctx.lineTo(sx+TILE-6,sy+7); ctx.lineTo(sx+TILE-10,sy+10); ctx.closePath(); ctx.fill();
  } else if(b.type==='zwinger'){
    ctx.fillStyle='rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-3,13,3,0,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#8b6f4e'; ctx.lineWidth=2;
    for(let i=0;i<4;i++){ ctx.beginPath(); ctx.moveTo(sx+3+i*8,sy+4); ctx.lineTo(sx+3+i*8,sy+TILE-4); ctx.stroke(); }
    ctx.fillStyle='#c9822c'; ctx.fillRect(sx+9,sy+18,12,9);
    ctx.fillStyle='#8a5a1f'; ctx.beginPath(); ctx.moveTo(sx+7,sy+18); ctx.lineTo(sx+15,sy+11); ctx.lineTo(sx+23,sy+18); ctx.closePath(); ctx.fill();
    ctx.fillStyle='#3a2a1a'; ctx.beginPath(); ctx.arc(sx+15,sy+23,2.4,0,Math.PI*2); ctx.fill();
  } else if(b.type==='stuhl'){
    /* Vier eigene Ansichten statt einer gedrehten Grafik:
       Die Beine stehen immer unten, nur Lehne und Sitz wechseln
       je nach Blickrichtung die Seite. rotation: 0=Süd 90=West 180=Nord 270=Ost */
    const rot = b.rotation||0;
    const dark='#4a3018', wood='#8b6f4e', woodD='#6b4a2b', woodL='#a4835c';
    // Bodenschatten — immer unten, unabhängig von der Richtung
    ctx.fillStyle='rgba(0,0,0,.25)';
    ctx.beginPath(); ctx.ellipse(cx, sy+TILE-7, 9, 3.2, 0, 0, Math.PI*2); ctx.fill();
    // Beine — immer unten
    ctx.fillStyle=woodD;
    ctx.fillRect(sx+9, sy+17, 2.5, 8); ctx.fillRect(sx+TILE-11.5, sy+17, 2.5, 8);
    ctx.fillStyle=wood;
    ctx.fillRect(sx+8, sy+19, 2.5, 7); ctx.fillRect(sx+TILE-10.5, sy+19, 2.5, 7);
    const seatTop = sy+16.5, seatBot = sy+20.5;
    const drawSeat = ()=>{
      const g2 = ctx.createLinearGradient(sx, seatTop, sx, seatBot);
      g2.addColorStop(0, woodL); g2.addColorStop(1, wood);
      ctx.fillStyle=g2;
      ctx.beginPath();
      ctx.moveTo(sx+7.5, seatTop); ctx.lineTo(sx+TILE-7.5, seatTop);
      ctx.lineTo(sx+TILE-6, seatBot); ctx.lineTo(sx+6, seatBot);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle=dark; ctx.lineWidth=0.9; ctx.stroke();
      ctx.strokeStyle='rgba(74,48,24,.3)'; ctx.lineWidth=0.6;
      ctx.beginPath(); ctx.moveTo(sx+9, sy+18.4); ctx.lineTo(sx+TILE-9, sy+18.4); ctx.stroke();
    };
    if(rot===0){
      // Blick nach Süden: Lehne hinten oben, Sitz davor
      ctx.fillStyle=woodD; ctx.fillRect(sx+8.5, sy+4, 2.6, 13); ctx.fillRect(sx+TILE-11, sy+4, 2.6, 13);
      ctx.fillStyle=wood; for(let i=0;i<3;i++) ctx.fillRect(sx+10.5, sy+5.5+i*3.4, TILE-21, 2);
      ctx.fillStyle=woodL; ctx.fillRect(sx+8, sy+3, TILE-16, 3);
      ctx.strokeStyle=dark; ctx.lineWidth=0.9; ctx.strokeRect(sx+8, sy+3, TILE-16, 3);
      ctx.strokeRect(sx+8.5, sy+4, 2.6, 13); ctx.strokeRect(sx+TILE-11, sy+4, 2.6, 13);
      drawSeat();
    } else if(rot===180){
      // Blick nach Norden: Sitz liegt hinten, die Lehne steht davor
      // (wir schauen von hinten auf den Stuhl)
      const g4 = ctx.createLinearGradient(sx, sy+9, sx, sy+13);
      g4.addColorStop(0, woodL); g4.addColorStop(1, wood);
      ctx.fillStyle=g4;
      ctx.beginPath();
      ctx.moveTo(sx+7.5, sy+9); ctx.lineTo(sx+TILE-7.5, sy+9);
      ctx.lineTo(sx+TILE-6, sy+13); ctx.lineTo(sx+6, sy+13);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle=dark; ctx.lineWidth=0.9; ctx.stroke();
      // Lehnenrückseite davor — geschlossene Fläche, keine Sprossen sichtbar
      ctx.fillStyle=shadeColor(woodD,-10);
      ctx.fillRect(sx+8, sy+13, TILE-16, 9);
      ctx.strokeStyle=dark; ctx.lineWidth=0.9; ctx.strokeRect(sx+8, sy+13, TILE-16, 9);
      ctx.fillStyle=shadeColor(woodL,-6); ctx.fillRect(sx+7.5, sy+12, TILE-15, 2.5);
      ctx.strokeStyle=dark; ctx.strokeRect(sx+7.5, sy+12, TILE-15, 2.5);
      ctx.strokeStyle='rgba(74,48,24,.35)'; ctx.lineWidth=0.6;
      ctx.beginPath(); ctx.moveTo(sx+9, sy+17.5); ctx.lineTo(sx+TILE-9, sy+17.5); ctx.stroke();
    } else {
      // Seitenansicht: Lehne links (Blick nach Osten) bzw. rechts (nach Westen)
      const east = (rot===270);
      const bx = east ? sx+7 : sx+TILE-10.5;   // Lehne auf der dem Ziel abgewandten Seite
      ctx.fillStyle=woodD; ctx.fillRect(bx, sy+4, 3.5, 14);
      ctx.fillStyle=wood;  ctx.fillRect(bx+0.6, sy+5.5, 2.3, 11);
      ctx.fillStyle=woodL; ctx.fillRect(bx-0.5, sy+3, 4.5, 3);
      ctx.strokeStyle=dark; ctx.lineWidth=0.9;
      ctx.strokeRect(bx, sy+4, 3.5, 14); ctx.strokeRect(bx-0.5, sy+3, 4.5, 3);
      // Sitzfläche zeigt zur Zielseite
      const sxA = east ? sx+9.5 : sx+6, sxB = east ? sx+TILE-6 : sx+TILE-9.5;
      const g3 = ctx.createLinearGradient(sx, seatTop, sx, seatBot);
      g3.addColorStop(0, woodL); g3.addColorStop(1, wood);
      ctx.fillStyle=g3;
      ctx.beginPath();
      ctx.moveTo(sxA, seatTop); ctx.lineTo(sxB, seatTop);
      ctx.lineTo(sxB+(east?0.5:-0.5), seatBot); ctx.lineTo(sxA-(east?0.5:-0.5), seatBot);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle=dark; ctx.lineWidth=0.9; ctx.stroke();
      ctx.strokeStyle='rgba(74,48,24,.3)'; ctx.lineWidth=0.6;
      ctx.beginPath(); ctx.moveTo(sxA+1.5, sy+18.4); ctx.lineTo(sxB-1.5, sy+18.4); ctx.stroke();
    }
  } else if(b.type==='bank'){
    /* Vier eigene Ansichten wie beim Stuhl: Die Beine bleiben immer
       unten, nur Lehne und Sitzfläche wechseln je nach Blickrichtung.
       rotation: 0=Süd 90=West 180=Nord 270=Ost */
    const rotB = b.rotation||0;
    const dk='#4a3018', wd='#8b6f4e', wdD='#6b4a2b', wdL='#a4835c';
    ctx.fillStyle='rgba(0,0,0,.25)';
    ctx.beginPath(); ctx.ellipse(cx, sy+TILE-6, 12, 3.2, 0, 0, Math.PI*2); ctx.fill();
    // Beine — bei der Bank vier Stück, immer unten
    ctx.fillStyle=wdD;
    ctx.fillRect(sx+5, sy+17, 2.5, 8); ctx.fillRect(sx+TILE-7.5, sy+17, 2.5, 8);
    ctx.fillStyle=wd;
    ctx.fillRect(sx+4, sy+19, 2.5, 7); ctx.fillRect(sx+TILE-6.5, sy+19, 2.5, 7);
    const stB = sy+15.5, sbB = sy+20;
    const seatB = ()=>{
      const gB = ctx.createLinearGradient(sx, stB, sx, sbB);
      gB.addColorStop(0, wdL); gB.addColorStop(1, wd);
      ctx.fillStyle=gB;
      ctx.beginPath();
      ctx.moveTo(sx+3.5, stB); ctx.lineTo(sx+TILE-3.5, stB);
      ctx.lineTo(sx+TILE-2, sbB); ctx.lineTo(sx+2, sbB);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle=dk; ctx.lineWidth=0.9; ctx.stroke();
      // Sitzbretter längs
      ctx.strokeStyle='rgba(74,48,24,.3)'; ctx.lineWidth=0.6;
      ctx.beginPath(); ctx.moveTo(sx+5, sy+17.6); ctx.lineTo(sx+TILE-5, sy+17.6); ctx.stroke();
    };
    if(rotB===0){
      // Blick nach Süden: lange Lehne hinten, zwei Pfosten
      ctx.fillStyle=wdD; ctx.fillRect(sx+4.5, sy+4, 2.4, 12); ctx.fillRect(sx+TILE-7, sy+4, 2.4, 12);
      ctx.fillStyle=wd;
      ctx.fillRect(sx+4, sy+6, TILE-8, 2.4); ctx.fillRect(sx+4, sy+10, TILE-8, 2.4);
      ctx.fillStyle=wdL; ctx.fillRect(sx+3.5, sy+3, TILE-7, 2.8);
      ctx.strokeStyle=dk; ctx.lineWidth=0.9; ctx.strokeRect(sx+3.5, sy+3, TILE-7, 2.8);
      seatB();
    } else if(rotB===180){
      // Blick nach Norden: Sitz hinten, geschlossene Lehnenrückseite davor
      const gN = ctx.createLinearGradient(sx, sy+8, sx, sy+12);
      gN.addColorStop(0, wdL); gN.addColorStop(1, wd);
      ctx.fillStyle=gN;
      ctx.beginPath();
      ctx.moveTo(sx+3.5, sy+8); ctx.lineTo(sx+TILE-3.5, sy+8);
      ctx.lineTo(sx+TILE-2, sy+12); ctx.lineTo(sx+2, sy+12);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle=dk; ctx.lineWidth=0.9; ctx.stroke();
      ctx.fillStyle=shadeColor(wdD,-10); ctx.fillRect(sx+4, sy+12, TILE-8, 9);
      ctx.strokeStyle=dk; ctx.strokeRect(sx+4, sy+12, TILE-8, 9);
      ctx.fillStyle=shadeColor(wdL,-6); ctx.fillRect(sx+3.5, sy+11, TILE-7, 2.4);
      ctx.strokeRect(sx+3.5, sy+11, TILE-7, 2.4);
    } else {
      // Seitenansicht: Lehne auf der dem Ziel abgewandten Seite
      const eastB = (rotB===270);
      const bxB = eastB ? sx+4 : sx+TILE-7.5;
      ctx.fillStyle=wdD; ctx.fillRect(bxB, sy+4, 3.5, 13);
      ctx.fillStyle=wd;  ctx.fillRect(bxB+0.6, sy+5.5, 2.3, 10);
      ctx.fillStyle=wdL; ctx.fillRect(bxB-0.5, sy+3, 4.5, 2.8);
      ctx.strokeStyle=dk; ctx.lineWidth=0.9;
      ctx.strokeRect(bxB, sy+4, 3.5, 13); ctx.strokeRect(bxB-0.5, sy+3, 4.5, 2.8);
      const aB = eastB ? sx+7 : sx+2, bB = eastB ? sx+TILE-2 : sx+TILE-7;
      const gS = ctx.createLinearGradient(sx, stB, sx, sbB);
      gS.addColorStop(0, wdL); gS.addColorStop(1, wd);
      ctx.fillStyle=gS;
      ctx.beginPath();
      ctx.moveTo(aB, stB); ctx.lineTo(bB, stB);
      ctx.lineTo(bB+(eastB?0.5:-0.5), sbB); ctx.lineTo(aB-(eastB?0.5:-0.5), sbB);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle=dk; ctx.lineWidth=0.9; ctx.stroke();
      ctx.strokeStyle='rgba(74,48,24,.3)'; ctx.lineWidth=0.6;
      ctx.beginPath(); ctx.moveTo(aB+1.5, sy+17.6); ctx.lineTo(bB-1.5, sy+17.6); ctx.stroke();
    }
  } else if(b.type==='holzboden'){
    ctx.fillStyle='#a8875c'; ctx.fillRect(sx,sy,TILE,TILE);
    ctx.strokeStyle='#8b6f4e'; ctx.lineWidth=1;
    for(let i=1;i<4;i++){ ctx.beginPath(); ctx.moveTo(sx,sy+i*TILE/4); ctx.lineTo(sx+TILE,sy+i*TILE/4); ctx.stroke(); }
  } else if(b.type==='kuechenherd'){
    drawStoneBlocks(sx,sy,'#7a7268','#4a453e','#a29a8c','#3a352e');
    const flick=1+Math.sin(performance.now()/150)*0.15;
    ctx.fillStyle='#3a352e'; ctx.fillRect(sx+9,sy+16,TILE-18,9);
    ctx.fillStyle='#e8623b'; ctx.beginPath(); ctx.ellipse(cx,sy+20,5*flick,3*flick,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#f2c65a'; ctx.beginPath(); ctx.ellipse(cx,sy+20,2.4*flick,1.4*flick,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#9a9a9a'; ctx.beginPath(); ctx.ellipse(cx,sy+9,7,3,0,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#5f5f5f'; ctx.lineWidth=1; ctx.beginPath(); ctx.ellipse(cx,sy+9,7,3,0,0,Math.PI*2); ctx.stroke();
  } else if(b.type==='toepferei'){
    drawSmoke(sx+TILE-9, sy+3, {seed:b.x*2+b.y, puffs:3, rise:16, size:2, grow:2.6, color:'205,198,186', alpha:0.32});
    ctx.fillStyle='rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-4,12,3,0,0,Math.PI*2); ctx.fill();
    drawWoodPlanks(sx,sy,'#8b6f4e');
    ctx.fillStyle='#c9702c'; ctx.beginPath(); ctx.ellipse(cx-6,sy+TILE-10,4,6,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#a8551f'; ctx.beginPath(); ctx.ellipse(cx+6,sy+TILE-9,3.4,5,0,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#5a4230'; ctx.lineWidth=0.8;
    ctx.beginPath(); ctx.ellipse(cx-6,sy+TILE-10,4,6,0,0,Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx+6,sy+TILE-9,3.4,5,0,0,Math.PI*2); ctx.stroke();
  } else if(b.type==='gerberei'){
    ctx.fillStyle='rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-4,12,3,0,0,Math.PI*2); ctx.fill();
    drawWoodPlanks(sx,sy,'#7a5f42');
    ctx.fillStyle='#3e8e8e'; ctx.fillRect(sx+7,sy+9,TILE-14,10);
    ctx.strokeStyle='#26565a'; ctx.lineWidth=1; ctx.strokeRect(sx+7,sy+9,TILE-14,10);
    ctx.fillStyle='#8b6f4e'; ctx.fillRect(sx+9,sy+TILE-9,TILE-18,3);
  } else if(b.type==='muehle'){
    ctx.fillStyle='rgba(0,0,0,.2)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-4,12,3,0,0,Math.PI*2); ctx.fill();
    drawStoneBlocks(sx,sy,'#a8875c','#6b4a2b','#c9a878','#5a4230');
    const rot = performance.now()/900;
    ctx.save(); ctx.translate(cx,sy+10);
    for(let i=0;i<4;i++){ const a=rot+i*Math.PI/2; ctx.strokeStyle='#efe6cd'; ctx.lineWidth=2; ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(Math.cos(a)*8,Math.sin(a)*8); ctx.stroke(); }
    ctx.restore();
  } else if(b.type==='baeckerei'){
    ctx.fillStyle='rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-4,12,3,0,0,Math.PI*2); ctx.fill();
    drawStoneBlocks(sx,sy,'#a8875c','#6b4a2b','#c9a878','#5a4230');
    const flick=1+Math.sin(performance.now()/180)*0.12;
    ctx.fillStyle='#3a352e'; ctx.beginPath(); ctx.arc(cx,sy+TILE-11,8,0,Math.PI);
    ctx.fill();
    ctx.fillStyle='#e8623b'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-11,4*flick,2.4*flick,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#e8c98a'; ctx.beginPath(); ctx.ellipse(cx-8,sy+8,4,3,0.3,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#d9a95a'; ctx.beginPath(); ctx.ellipse(cx+7,sy+8,3.4,2.6,-0.3,0,Math.PI*2); ctx.fill();
    drawChimney(sx+4, sy+1, 5, 6, '#8a6b48');
    drawSmoke(sx+6.5, sy+1, {seed:b.x+b.y, puffs:4, rise:20, color:'214,206,190', alpha:0.38});
  } else if(b.type==='alchemielabor'){
    drawSmoke(cx, sy+4, {seed:b.x+b.y*3, puffs:4, rise:18, size:1.8, grow:2.4, color:'150,205,180', alpha:0.4, drift:5});
    ctx.fillStyle='rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-4,12,3,0,0,Math.PI*2); ctx.fill();
    drawWoodPlanks(sx,sy,'#6b4a2b');
    const bub = 0.5+Math.sin(performance.now()/300)*0.3;
    ctx.strokeStyle='#c9b988'; ctx.lineWidth=1.4;
    ctx.beginPath(); ctx.moveTo(cx-3,sy+6); ctx.lineTo(cx-3,sy+13); ctx.lineTo(cx-7,sy+20); ctx.lineTo(cx+7,sy+20); ctx.lineTo(cx+3,sy+13); ctx.lineTo(cx+3,sy+6); ctx.stroke();
    ctx.save(); ctx.globalAlpha=bub; ctx.fillStyle='#8fd1c9';
    ctx.beginPath(); ctx.moveTo(cx-6,sy+19); ctx.lineTo(cx+6,sy+19); ctx.lineTo(cx+3,sy+13); ctx.lineTo(cx-3,sy+13); ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle='#c94f8f'; ctx.beginPath(); ctx.arc(cx-2,sy+16,1.2,0,Math.PI*2); ctx.fill();
  } else if(b.type==='schreinerei'){
    ctx.fillStyle='rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-4,12,3,0,0,Math.PI*2); ctx.fill();
    drawWoodPlanks(sx,sy,'#8b6f4e');
    ctx.strokeStyle='#4a3018'; ctx.lineWidth=1.4;
    ctx.beginPath(); ctx.moveTo(sx+7,sy+8); ctx.lineTo(sx+TILE-8,sy+TILE-9); ctx.stroke();
    ctx.strokeStyle='#c9822c'; ctx.lineWidth=2.6;
    ctx.beginPath(); ctx.moveTo(sx+9,sy+TILE-8); ctx.lineTo(sx+TILE-9,sy+9); ctx.stroke();
  } else if(b.type==='steinmetz'){
    ctx.fillStyle='rgba(0,0,0,.2)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-4,12,3,0,0,Math.PI*2); ctx.fill();
    drawStoneBlocks(sx,sy,'#a8a898','#6b6a5f','#c9c9ba','#5a5850');
    ctx.fillStyle='#efe6cd'; ctx.beginPath(); ctx.moveTo(cx,sy+8); ctx.lineTo(cx+6,sy+18); ctx.lineTo(cx-6,sy+18); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#8a8478'; ctx.lineWidth=1; ctx.stroke();
  } else if(b.type==='schreibtisch'){
    drawFrontedFurniture(sx, sy, b.rotation||0, {
      color:'#8b6f4e', legs:true, shadowW:11,
      front:(fx,fy,c,pal)=>{
        // Schublade und Arbeitsutensilien auf der Vorderseite
        c.fillStyle = shadeColor(pal.bodyCol,-14);
        c.fillRect(fx+6, fy+13, TILE-12, 4);
        c.strokeStyle = pal.dark; c.lineWidth=0.8;
        c.strokeRect(fx+6, fy+13, TILE-12, 4);
        c.fillStyle = '#e8c45a';
        c.beginPath(); c.arc(fx+TILE/2, fy+15, 1.2, 0, Math.PI*2); c.fill();
        c.fillStyle='#efe6cd'; c.fillRect(fx+7, fy+6, 7, 3);
        c.fillStyle='#3e8e8e'; c.beginPath(); c.arc(fx+TILE-9, fy+7, 1.8, 0, Math.PI*2); c.fill();
      }
    });
  } else if(b.type==='kommode'){
    drawFrontedFurniture(sx, sy, b.rotation||0, {
      color:'#8b6f4e', legs:false, shadowW:11,
      front:(fx,fy,c,pal)=>{
        // zwei Schubladen mit Griffen — nur vorn sichtbar
        for(let i=0;i<2;i++){
          const dy = fy+10+i*6;
          c.fillStyle = shadeColor(pal.bodyCol,-12);
          c.fillRect(fx+6, dy, TILE-12, 5);
          c.strokeStyle = pal.dark; c.lineWidth=0.8;
          c.strokeRect(fx+6, dy, TILE-12, 5);
          c.fillStyle = '#e8c45a';
          c.beginPath(); c.arc(fx+TILE/2, dy+2.5, 1.3, 0, Math.PI*2); c.fill();
        }
      }
    });
    ctx.strokeStyle='#5a4230'; ctx.lineWidth=0.8;
    for(let i=1;i<3;i++){ ctx.beginPath(); ctx.moveTo(sx+6,sy+6+i*6); ctx.lineTo(sx+TILE-6,sy+6+i*6); ctx.stroke(); }
    ctx.fillStyle='#c9822c'; [0,1,2].forEach(i=>{ ctx.beginPath(); ctx.arc(cx,sy+9+i*6,1,0,Math.PI*2); ctx.fill(); });
  } else if(b.type==='fackel'){
    const flick=1+Math.sin(performance.now()/130)*0.2;
    ctx.fillStyle='#6b4a2b'; ctx.fillRect(cx-1.5,sy+10,3,16);
    ctx.fillStyle='#e8623b'; ctx.beginPath(); ctx.ellipse(cx,sy+9,4*flick,6*flick,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#f2c65a'; ctx.beginPath(); ctx.ellipse(cx,sy+9,2*flick,3.4*flick,0,0,Math.PI*2); ctx.fill();
    ctx.save(); ctx.globalAlpha=0.3+Math.sin(performance.now()/200)*0.1; ctx.fillStyle='#ffd23f';
    ctx.beginPath(); ctx.arc(cx,sy+9,12,0,Math.PI*2); ctx.fill(); ctx.restore();
  } else if(b.type==='kamin'){
    const rotK = b.rotation||0;
    drawStoneBlocks(sx,sy,'#8a8478','#5a564c','#b0aa9c','#4a463e');
    ctx.fillStyle='rgba(255,255,255,.16)'; ctx.fillRect(sx,sy,TILE,3);
    ctx.fillStyle='rgba(0,0,0,.26)'; ctx.fillRect(sx,sy+TILE-4,TILE,4);
    const flick=1+Math.sin(performance.now()/150 + sx)*0.15;
    // Feueröffnung wandert auf die Blickseite
    let ox=sx+8, oy=sy+16, ow=TILE-16, oh=10;
    if(rotK===180){ oy=sy+6; }
    else if(rotK===90){ ox=sx+TILE-14; oy=sy+11; ow=10; oh=TILE-22; }
    else if(rotK===270){ ox=sx+4; oy=sy+11; ow=10; oh=TILE-22; }
    ctx.fillStyle='#2a2620'; ctx.fillRect(ox,oy,ow,oh);
    ctx.strokeStyle='#4a463e'; ctx.lineWidth=1; ctx.strokeRect(ox,oy,ow,oh);
    const fcx=ox+ow/2, fcy=oy+oh*0.62;
    const fg=ctx.createRadialGradient(fcx,fcy,1,fcx,fcy,ow*0.8);
    fg.addColorStop(0,`rgba(255,228,150,${0.95*flick})`);
    fg.addColorStop(0.5,`rgba(240,150,50,${0.7*flick})`);
    fg.addColorStop(1,'rgba(200,80,30,0)');
    ctx.fillStyle=fg; ctx.beginPath(); ctx.arc(fcx,fcy,ow*0.8,0,Math.PI*2); ctx.fill();
    ctx.fillStyle=`rgba(255,220,140,${0.9*flick})`;
    ctx.beginPath(); ctx.moveTo(fcx-3,fcy+2); ctx.quadraticCurveTo(fcx,fcy-oh*0.55,fcx+3,fcy+2);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle='#6b4a2b';
    ctx.fillRect(fcx-4, fcy+2, 8, 2);
    drawChimney(sx+TILE/2-3, sy-1, 6, 6, '#5a564c');
    drawSmoke(sx+TILE/2, sy-1, {seed:b.x+b.y, puffs:4, rise:20, size:2, grow:3});
  } else if(b.type==='statue'){
    ctx.fillStyle='rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-4,12,4,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#a8a898'; ctx.fillRect(sx+7,sy+TILE-11,TILE-14,7);
    ctx.strokeStyle='#6b6a5f'; ctx.lineWidth=1; ctx.strokeRect(sx+7,sy+TILE-11,TILE-14,7);
    ctx.fillStyle='#c9c9ba';
    ctx.beginPath(); ctx.ellipse(cx,sy+11,3.6,4.4,0,0,Math.PI*2); ctx.fill();
    ctx.fillRect(cx-4,sy+14,8,10);
    ctx.strokeStyle='#8a8478'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.ellipse(cx,sy+11,3.6,4.4,0,0,Math.PI*2); ctx.stroke();
    ctx.strokeRect(cx-4,sy+14,8,10);
  } else if(b.type==='blumentopf'){
    ctx.fillStyle='rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-8,5,2,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#c9702c'; ctx.beginPath(); ctx.moveTo(cx-5,sy+TILE-16); ctx.lineTo(cx+5,sy+TILE-16); ctx.lineTo(cx+4,sy+TILE-9); ctx.lineTo(cx-4,sy+TILE-9); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#8a4a1c'; ctx.lineWidth=0.8; ctx.stroke();
    ['#c9432f','#e8a94d','#c94f8f'].forEach((col,i)=>{
      ctx.strokeStyle='#4c7a3d'; ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(cx-3+i*3,sy+TILE-16); ctx.lineTo(cx-4+i*3,sy+TILE-21); ctx.stroke();
      ctx.fillStyle=col; ctx.beginPath(); ctx.arc(cx-4+i*3,sy+TILE-22,1.8,0,Math.PI*2); ctx.fill();
    });
  } else if(b.type==='schachtisch'){
    ctx.fillStyle='rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-4,11,3,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#6b4a2b'; ctx.fillRect(sx+6,sy+10,3,13); ctx.fillRect(sx+TILE-9,sy+10,3,13);
    ctx.fillStyle='#8b6f4e'; ctx.fillRect(sx+4,sy+8,TILE-8,7);
    ctx.strokeStyle='#4a3018'; ctx.lineWidth=0.8; ctx.strokeRect(sx+4,sy+8,TILE-8,7);
    for(let r=0;r<3;r++){ for(let cI=0;cI<4;cI++){ if((r+cI)%2===0){ ctx.fillStyle='#3a2e22'; ctx.fillRect(sx+5+cI*4.4,sy+9+r*2,4.4,2); } } }
  } else if(b.type==='kegelbahn'){
    ctx.fillStyle='rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-4,13,3,0,0,Math.PI*2); ctx.fill();
    drawWoodPlanks(sx,sy,'#c9a878');
    ctx.fillStyle='#efe6cd';
    [[-4,-3],[0,-3],[4,-3],[-2,-8],[2,-8],[0,-12]].forEach(([dx,dy])=>{ ctx.beginPath(); ctx.arc(cx+dx,sy+16+dy,1.6,0,Math.PI*2); ctx.fill(); });
    ctx.fillStyle='#8b1a1a'; ctx.beginPath(); ctx.arc(cx-2,sy+TILE-6,2.4,0,Math.PI*2); ctx.fill();
  } else if(b.type==='musikecke'){
    ctx.fillStyle='rgba(0,0,0,.15)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-5,10,3,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#c9822c'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-10,6,8,0,0,Math.PI*2); ctx.fill();
    ctx.strokeStyle='#5a4230'; ctx.lineWidth=1; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-10,6,8,0,0,Math.PI*2); ctx.stroke();
    ctx.strokeStyle='#3a2e22'; ctx.lineWidth=0.8;
    ctx.beginPath(); ctx.moveTo(cx-2,sy+TILE-16); ctx.lineTo(cx-1,sy+6); ctx.moveTo(cx+2,sy+TILE-16); ctx.lineTo(cx+1,sy+6); ctx.stroke();
    ctx.fillStyle='#2a2620'; ctx.fillRect(cx-1.6,sy+4,3.2,4);
  } else if(b.type==='spitzenfalle'){
    ctx.fillStyle='#5a4530'; ctx.fillRect(sx+2,sy+2,TILE-4,TILE-4);
    ctx.fillStyle='#9a9a9a';
    for(let i=0;i<3;i++){ for(let j=0;j<3;j++){ ctx.beginPath(); ctx.moveTo(sx+7+i*8,sy+7+j*8); ctx.lineTo(sx+10+i*8,sy+1+j*8); ctx.lineTo(sx+13+i*8,sy+7+j*8); ctx.closePath(); ctx.fill(); } }
    ctx.strokeStyle='#4a4a4a'; ctx.lineWidth=0.6;
    for(let i=0;i<3;i++){ for(let j=0;j<3;j++){ ctx.beginPath(); ctx.moveTo(sx+7+i*8,sy+7+j*8); ctx.lineTo(sx+10+i*8,sy+1+j*8); ctx.lineTo(sx+13+i*8,sy+7+j*8); ctx.closePath(); ctx.stroke(); } }
  } else if(b.type==='ballista'){
    ctx.fillStyle='rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(cx,sy+TILE-4,13,4,0,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#6b4a2b'; ctx.fillRect(sx+6,sy+TILE-12,TILE-12,9);
    ctx.strokeStyle='#4a3018'; ctx.lineWidth=1; ctx.strokeRect(sx+6,sy+TILE-12,TILE-12,9);
    ctx.strokeStyle='#9a9a9a'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(sx+4,sy+8); ctx.quadraticCurveTo(cx,sy+2,sx+TILE-4,sy+8); ctx.stroke();
    ctx.strokeStyle='#efe6cd'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(cx,sy+TILE-14); ctx.lineTo(cx,sy+5); ctx.stroke();
  } else if(b.type==='teppich'){
    ctx.fillStyle='#8b1a1a'; ctx.fillRect(sx+2,sy+2,TILE-4,TILE-4);
    ctx.strokeStyle='#5a0f0f'; ctx.lineWidth=2; ctx.strokeRect(sx+4,sy+4,TILE-8,TILE-8);
    ctx.strokeStyle='#c9a04a'; ctx.lineWidth=1; ctx.strokeRect(sx+6,sy+6,TILE-12,TILE-12);
  } else if(b.type==='marmorboden'){
    ctx.fillStyle='#e8e6dc'; ctx.fillRect(sx,sy,TILE,TILE);
    ctx.strokeStyle='#c9c6ba'; ctx.lineWidth=1;
    ctx.strokeRect(sx+1,sy+1,TILE/2-1,TILE/2-1); ctx.strokeRect(sx+TILE/2,sy+1,TILE/2-1,TILE/2-1);
    ctx.strokeRect(sx+1,sy+TILE/2,TILE/2-1,TILE/2-1); ctx.strokeRect(sx+TILE/2,sy+TILE/2,TILE/2-1,TILE/2-1);
    ctx.strokeStyle='rgba(180,175,160,.4)'; ctx.lineWidth=0.6;
    ctx.beginPath(); ctx.moveTo(sx+4,sy+6); ctx.lineTo(sx+TILE-8,sy+TILE-10); ctx.stroke();
  } else if(WAND_STUFEN[b.type]){
    drawWandStufe(b, sx, sy, cx, cy);
  } else if(b.type==='wall'){
    /* Auto-Tiling: Die Mauer zeichnet erst ihr Steinwerk und schließt dann
       die Fugen zu vorhandenen Nachbarn, damit ein durchgehender Wall
       entsteht. An freien Seiten bleibt eine sichtbare Kante mit Pfosten,
       sonst würden Enden wie abgeschnitten wirken. */
    const conn = fenceConnections(b);
    drawStoneBlocks(sx, sy, '#8f887c', '#5e584e', '#c2bbac', '#6b655b');
    // Fugen zu den Nachbarn überdecken — das macht die Naht unsichtbar
    ctx.fillStyle = '#8f887c';
    if(conn.n) ctx.fillRect(sx+3,      sy-1,        TILE-6, 4);
    if(conn.s) ctx.fillRect(sx+3,      sy+TILE-3,   TILE-6, 4);
    if(conn.w) ctx.fillRect(sx-1,      sy+3,        4,      TILE-6);
    if(conn.e) ctx.fillRect(sx+TILE-3, sy+3,        4,      TILE-6);
    // Freie Kanten bekommen eine Abschlusskante
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    if(!conn.n) ctx.fillRect(sx, sy,          TILE, 2);
    if(!conn.s) ctx.fillRect(sx, sy+TILE-2,   TILE, 2);
    if(!conn.w) ctx.fillRect(sx, sy,          2,    TILE);
    if(!conn.e) ctx.fillRect(sx+TILE-2, sy,   2,    TILE);
    // Kantenlicht oben, Schatten unten — gibt der Mauer Höhe
    ctx.fillStyle='rgba(255,255,255,.18)'; ctx.fillRect(sx, sy, TILE, 2.5);
    ctx.fillStyle='rgba(0,0,0,.24)';       ctx.fillRect(sx, sy+TILE-3, TILE, 3);
    drawWallDamage(b, sx, sy, cx, cy);
    // Eckpfosten an Enden, Ecken und Kreuzungen
    const openSides = [conn.n,conn.s,conn.w,conn.e].filter(v=>!v).length;
    if(openSides >= 3 || (conn.n&&conn.e) || (conn.n&&conn.w) || (conn.s&&conn.e) || (conn.s&&conn.w)){
      ctx.fillStyle='#7d766a';
      ctx.fillRect(cx-5, cy-5, 10, 10);
      ctx.fillStyle='rgba(255,255,255,.16)'; ctx.fillRect(cx-5, cy-5, 10, 2);
      ctx.strokeStyle='#544e45'; ctx.lineWidth=0.8; ctx.strokeRect(cx-5, cy-5, 10, 10);
    }
  } else if(b.type==='campfire'){
    /* Zeichnet die vorhandene Feuergrafik samt Glutschein und Rauch,
       statt wie bisher in den Emoji-Notbehelf zu fallen. */
    ctx.fillStyle='rgba(0,0,0,.22)';
    ctx.beginPath(); ctx.ellipse(cx, sy+TILE-5, 12, 4, 0, 0, Math.PI*2); ctx.fill();
    // Steinkranz
    ctx.fillStyle='#8b8478';
    [[-11,4],[-7,9],[0,11],[7,9],[11,4],[7,-1],[-7,-1]].forEach(([dx,dy])=>{
      ctx.beginPath(); ctx.ellipse(cx+dx, cy+dy, 3.2, 2.4, 0, 0, Math.PI*2); ctx.fill();
    });
    ctx.fillStyle='#6b655b';
    [[-11,4],[0,11],[11,4]].forEach(([dx,dy])=>{
      ctx.beginPath(); ctx.ellipse(cx+dx, cy+dy+1, 2.4, 1.4, 0, 0, Math.PI*2); ctx.fill();
    });
    // Warmer Lichtschein auf dem Boden
    const pulse = 0.5 + Math.sin(performance.now()/260 + sx*0.07)*0.14;
    ctx.save();
    ctx.globalAlpha = pulse * 0.5;
    const glow = ctx.createRadialGradient(cx, cy+2, 2, cx, cy+2, 17);
    glow.addColorStop(0, 'rgba(255,186,92,.85)');
    glow.addColorStop(1, 'rgba(255,150,50,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy+2, 17, 0, Math.PI*2); ctx.fill();
    ctx.restore();
    // Holzscheite und Flamme
    drawCampfire(sx, sy);
    drawSmoke(cx, sy+6, { puffs:3, rise:16, size:1.8, grow:2.4, alpha:0.30, seed:b.x+b.y });
  } else if(b.type==='primitivbank'){
    /* Primitive Werkbank: grobe Planke auf zwei Aststützen, davor
       Feuerstein und Schnitzholz — bewusst roher als die Werkbank. */
    ctx.fillStyle='rgba(0,0,0,.2)';
    ctx.beginPath(); ctx.ellipse(cx, sy+TILE-4, 12, 3.2, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle='#5a3d22';
    ctx.fillRect(sx+6, sy+20, 3, 9);
    ctx.fillRect(sx+TILE-9, sy+20, 3, 9);
    drawSolid(sx+3, sy+11, TILE-6, 10, 5, '#7d6242', {front:'#4f3d26', side:'#63502f'});
    // Astwerk und Bindung
    ctx.strokeStyle='#4a3018'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(sx+6, sy+23); ctx.lineTo(sx+TILE-6, sy+23); ctx.stroke();
    // Feuerstein
    ctx.fillStyle='#9a9a90';
    ctx.beginPath(); ctx.moveTo(sx+7, sy+16); ctx.lineTo(sx+12, sy+13);
    ctx.lineTo(sx+14, sy+17); ctx.lineTo(sx+9, sy+18); ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#6b6a5f'; ctx.lineWidth=0.7; ctx.stroke();
    // Schnitzholz
    ctx.fillStyle='#a4794a';
    ctx.fillRect(sx+TILE-15, sy+14, 9, 3);
    ctx.fillStyle='#c9a878';
    ctx.beginPath(); ctx.moveTo(sx+TILE-6, sy+14); ctx.lineTo(sx+TILE-3, sy+15.5);
    ctx.lineTo(sx+TILE-6, sy+17); ctx.closePath(); ctx.fill();
  } else if(b.type==='werkstatt'){
    /* Werkstatt: Werkbank mit Schraubstock und Werkzeugbrett. */
    ctx.fillStyle='rgba(0,0,0,.2)';
    ctx.beginPath(); ctx.ellipse(cx, sy+TILE-4, 13, 3.2, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle='#4a3018';
    ctx.fillRect(sx+5, sy+21, 2.5, 8); ctx.fillRect(sx+TILE-7.5, sy+21, 2.5, 8);
    // Werkzeugbrett an der Rückwand
    drawWoodPlanks(sx+3, sy+2, '#7d6242');
    ctx.fillStyle='#6b6a5f';
    ctx.fillRect(sx+7, sy+4, 2, 7);
    ctx.fillRect(sx+12, sy+4, 2, 7);
    ctx.fillStyle='#9a9a90';
    ctx.beginPath(); ctx.moveTo(sx+17, sy+4); ctx.lineTo(sx+22, sy+7);
    ctx.lineTo(sx+17, sy+10); ctx.closePath(); ctx.fill();
    // Arbeitsplatte
    drawSolid(sx+2, sy+13, TILE-4, 11, 6, '#8b6f4e');
    // Schraubstock
    ctx.fillStyle='#5f6a72'; ctx.fillRect(sx+TILE-13, sy+11, 9, 5);
    ctx.fillStyle='#8a949c'; ctx.fillRect(sx+TILE-11, sy+9, 5, 3);
    ctx.strokeStyle='#3a4148'; ctx.lineWidth=0.8; ctx.strokeRect(sx+TILE-13, sy+11, 9, 5);
    // Metallspäne
    ctx.fillStyle='#c9c2b2';
    [[8,20],[13,22],[19,21]].forEach(([dx,dy])=>{ ctx.fillRect(sx+dx, sy+dy, 2, 1.4); });
  } else if(b.type==='schmiede'){
    /* Schmiede: Esse mit Glut, Amboss davor, Rauch und Funken. */
    ctx.fillStyle='rgba(0,0,0,.22)';
    ctx.beginPath(); ctx.ellipse(cx, sy+TILE-4, 13, 3.4, 0, 0, Math.PI*2); ctx.fill();
    drawStoneBlocks(sx, sy+3, '#8a8478', '#585349', '#b8b1a2', '#615c52');
    // Essenöffnung mit Glut
    const gl = 1 + Math.sin(performance.now()/170 + b.x)*0.16;
    ctx.fillStyle='#2e2a24';
    ctx.beginPath();
    if(ctx.roundRect) ctx.roundRect(sx+7, sy+9, TILE-14, 10, 3); else ctx.rect(sx+7, sy+9, TILE-14, 10);
    ctx.fill();
    ctx.fillStyle='#e8623b';
    ctx.beginPath(); ctx.ellipse(cx, sy+14, 6*gl, 3.6*gl, 0, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle='#f2c65a';
    ctx.beginPath(); ctx.ellipse(cx, sy+14, 3*gl, 1.8*gl, 0, 0, Math.PI*2); ctx.fill();
    // Amboss
    ctx.fillStyle='#4a4f55'; ctx.fillRect(sx+8, sy+TILE-8, 10, 4);
    ctx.fillStyle='#5f6a72';
    ctx.beginPath();
    ctx.moveTo(sx+6, sy+TILE-11); ctx.lineTo(sx+19, sy+TILE-11);
    ctx.lineTo(sx+17, sy+TILE-8); ctx.lineTo(sx+9, sy+TILE-8);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#2f353a'; ctx.lineWidth=0.8; ctx.stroke();
    // Hammer
    ctx.fillStyle='#8b6f4e'; ctx.fillRect(sx+TILE-12, sy+TILE-13, 2, 9);
    ctx.fillStyle='#6b7278'; ctx.fillRect(sx+TILE-15, sy+TILE-15, 8, 4);
    drawChimney(sx+TILE-11, sy+1, 6, 7, '#5f584f');
    drawSmoke(sx+TILE-8, sy+1, { seed:b.x+b.y, puffs:5, rise:24, size:2.2, grow:3.4 });
    drawSparks(cx, sy+12, b.x*0.7 + b.y);
  } else if(b.type==='werft'){
    /* Werft: Steg über Wasser mit Bootsrumpf im Bau und Mast. */
    ctx.fillStyle='#2f5a63'; ctx.fillRect(sx, sy+TILE-11, TILE, 11);
    ctx.fillStyle='rgba(255,255,255,.10)';
    ctx.fillRect(sx, sy+TILE-9, TILE, 1.6);
    ctx.fillRect(sx, sy+TILE-5, TILE, 1.2);
    // Steg
    /* drawWoodPlanks füllt immer eine volle Kachel ab dem Ursprung. Der Steg
       beginnt hier 12 Pixel tiefer und lief deshalb auf die Nachbarkachel
       über — deswegen auf die eigene Kachel begrenzen. */
    ctx.save();
    ctx.beginPath(); ctx.rect(sx, sy, TILE, TILE); ctx.clip();
    drawWoodPlanks(sx, sy+TILE-20, '#8b6f4e');
    ctx.restore();
    ctx.fillStyle='#5a3d22';
    [[4,0],[14,0],[24,0]].forEach(([dx])=>{ ctx.fillRect(sx+dx, sy+TILE-11, 2.5, 8); });
    // Rumpf im Bau
    ctx.fillStyle='#a4794a';
    ctx.beginPath();
    ctx.moveTo(sx+5, sy+TILE-16); ctx.lineTo(sx+TILE-5, sy+TILE-16);
    ctx.quadraticCurveTo(sx+TILE-9, sy+TILE-9, cx, sy+TILE-8);
    ctx.quadraticCurveTo(sx+9, sy+TILE-9, sx+5, sy+TILE-16);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#5a3d22'; ctx.lineWidth=1; ctx.stroke();
    ctx.strokeStyle='#7d5b34'; ctx.lineWidth=0.7;
    ctx.beginPath(); ctx.moveTo(sx+7, sy+TILE-13); ctx.lineTo(sx+TILE-7, sy+TILE-13); ctx.stroke();
    // Mast und Segeltuch
    ctx.fillStyle='#6b4a2b'; ctx.fillRect(cx-1, sy+4, 2, 14);
    ctx.fillStyle='#efe6cd';
    ctx.beginPath();
    ctx.moveTo(cx+1, sy+5); ctx.lineTo(cx+9, sy+13); ctx.lineTo(cx+1, sy+15);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle='#c9bfa2'; ctx.lineWidth=0.7; ctx.stroke();
  } else if(b.type==='gartenweg'){
    ctx.fillStyle='#9a8a68'; ctx.fillRect(sx+1,sy+1,TILE-2,TILE-2);
    ctx.fillStyle='#8a7a5c';
    [[7,7],[19,9],[12,18],[22,22],[5,22]].forEach(([dx,dy])=>{ ctx.beginPath(); ctx.arc(sx+dx,sy+dy,2.6,0,Math.PI*2); ctx.fill(); });
  } else if(b.type==='steinboden'){
    ctx.fillStyle='#b0aa9c'; ctx.fillRect(sx,sy,TILE,TILE);
    ctx.strokeStyle='#8a8478'; ctx.lineWidth=1;
    ctx.strokeRect(sx+1,sy+1,TILE/2-1,TILE/2-1); ctx.strokeRect(sx+TILE/2,sy+1,TILE/2-1,TILE/2-1);
    ctx.strokeRect(sx+1,sy+TILE/2,TILE/2-1,TILE/2-1); ctx.strokeRect(sx+TILE/2,sy+TILE/2,TILE/2-1,TILE/2-1);
  } else {
    ctx.fillStyle='rgba(40,30,20,.85)'; ctx.beginPath();
    if(ctx.roundRect){ ctx.roundRect(sx+4,sy+4,TILE-8,TILE-8,6); } else { ctx.rect(sx+4,sy+4,TILE-8,TILE-8); }
    ctx.fill(); ctx.strokeStyle='#e8a94d'; ctx.lineWidth=1.5; ctx.stroke();
    ctx.font='16px sans-serif';
    ctx.fillStyle='#efe6cd';
    ctx.fillText(BUILD_EMOJI[b.type]||'❔', cx, cy+1);
  }
  // Kein restore hier: In dieser Funktion wird kein zusätzliches save()
  // offen gelassen. Der Aufruf räumte sonst einen fremden Canvas-Zustand
  // ab — bei jedem einzelnen Gebäude.
}
function shadeColor(hex, amt){
  let r,g,b;
  if(typeof hex==='string' && hex.startsWith('rgb')){
    const m = hex.match(/\d+/g);
    r=+m[0]+amt; g=+m[1]+amt; b=+m[2]+amt;
  } else {
    const num = parseInt(hex.slice(1),16);
    r=(num>>16)+amt; g=((num>>8)&0xff)+amt; b=(num&0xff)+amt;
  }
  r=clamp(r,0,255); g=clamp(g,0,255); b=clamp(b,0,255);
  return 'rgb('+r+','+g+','+b+')';
}
// Mischt zwei Hex-Farben linear (t=0 -> a, t=1 -> b) — für weiche Boden-Farbverläufe über Kachelgrenzen
function mixHex(a, b, t){
  t = clamp(t,0,1);
  const na = parseInt(a.slice(1),16), nb = parseInt(b.slice(1),16);
  const ar=(na>>16)&0xff, ag=(na>>8)&0xff, ab=na&0xff;
  const br=(nb>>16)&0xff, bg=(nb>>8)&0xff, bb=nb&0xff;
  return 'rgb('+Math.round(ar+(br-ar)*t)+','+Math.round(ag+(bg-ag)*t)+','+Math.round(ab+(bb-ab)*t)+')';
}
/* Mischt zwei Farben und akzeptiert dabei sowohl #rrggbb als auch
   rgb(r,g,b). mixHex liefert rgb() zurück — ein verschachtelter Aufruf
   ergab deshalb NaN und damit Schwarz. */
function parseCol(c){
  if(typeof c !== 'string') return [0,0,0];
  if(c[0] === '#'){
    const n = parseInt(c.slice(1),16);
    return [(n>>16)&0xff, (n>>8)&0xff, n&0xff];
  }
  const m = c.match(/-?\d+/g);
  return m ? [ +m[0]||0, +m[1]||0, +m[2]||0 ] : [0,0,0];
}
function mixAny(a, b, t){
  t = clamp(t,0,1);
  const A = parseCol(a), B = parseCol(b);
  return 'rgb('+Math.round(A[0]+(B[0]-A[0])*t)+','+
                Math.round(A[1]+(B[1]-A[1])*t)+','+
                Math.round(A[2]+(B[2]-A[2])*t)+')';
}
function drawWorkTool(targetCtx, x, y, s, kind){
  targetCtx.save(); targetCtx.translate(x,y);
  if(kind==='chop'){
    targetCtx.strokeStyle='#6b4a2b'; targetCtx.lineWidth=1.3*s;
    targetCtx.beginPath(); targetCtx.moveTo(0,0); targetCtx.lineTo(3.2*s,-4.5*s); targetCtx.stroke();
    targetCtx.fillStyle='#9a9a9a'; targetCtx.beginPath();
    targetCtx.moveTo(2*s,-6.5*s); targetCtx.lineTo(6.5*s,-4.5*s); targetCtx.lineTo(3*s,-2.3*s); targetCtx.closePath(); targetCtx.fill();
    targetCtx.strokeStyle='#5f5f5f'; targetCtx.lineWidth=0.6*s; targetCtx.stroke();
  } else if(kind==='mine'){
    targetCtx.strokeStyle='#6b4a2b'; targetCtx.lineWidth=1.3*s;
    targetCtx.beginPath(); targetCtx.moveTo(0,0); targetCtx.lineTo(3*s,-4.5*s); targetCtx.stroke();
    targetCtx.strokeStyle='#9a9a9a'; targetCtx.lineWidth=1.8*s; targetCtx.lineCap='round';
    targetCtx.beginPath(); targetCtx.moveTo(-1*s,-6.5*s); targetCtx.lineTo(6.5*s,-3.5*s); targetCtx.stroke();
    targetCtx.lineCap='butt';
  } else if(kind==='harvest'){
    targetCtx.strokeStyle='#8fc93a'; targetCtx.lineWidth=1.5*s;
    targetCtx.beginPath(); targetCtx.arc(2*s,-3.5*s,3.2*s,0.2,2.8,false); targetCtx.stroke();
  } else if(kind==='build'){
    targetCtx.strokeStyle='#6b4a2b'; targetCtx.lineWidth=1.3*s;
    targetCtx.beginPath(); targetCtx.moveTo(0,0); targetCtx.lineTo(2*s,-5*s); targetCtx.stroke();
    targetCtx.fillStyle='#9a9a9a'; targetCtx.fillRect(-0.5*s,-7.5*s,4.5*s,3*s);
    targetCtx.strokeStyle='#5f5f5f'; targetCtx.lineWidth=0.6*s; targetCtx.strokeRect(-0.5*s,-7.5*s,4.5*s,3*s);
  }
  targetCtx.restore();
}
function tierPalette(val){
  if(val>=5) return { base:'#e8a94d', light:'#ffe08a', dark:'#a8721c', glow:'rgba(255,214,90,.55)' };
  if(val>=3) return { base:'#a8adb3', light:'#e8ecf0', dark:'#6f747a', glow:'rgba(200,220,240,.4)' };
  if(val>=1) return { base:'#8a6a4a', light:'#c99a6a', dark:'#5a4230', glow:'rgba(200,160,110,.25)' };
  return { base:'#5a5850', light:'#7a7868', dark:'#3f3d38', glow:'rgba(0,0,0,0)' };
}
function drawEquipIcon(canvasEl, kind, val){
  const c = canvasEl.getContext('2d');
  const W = canvasEl.width, H = canvasEl.height;
  c.clearRect(0,0,W,H);
  const pal = tierPalette(val);
  if(val<=0){
    c.strokeStyle = 'rgba(90,80,60,.35)'; c.lineWidth=1.5; c.setLineDash([3,3]);
    c.strokeRect(6,6,W-12,H-12); c.setLineDash([]);
    return;
  }
  c.save(); c.translate(W/2,H/2);
  if(val>=3){
    c.save(); c.globalAlpha=0.5+Math.sin(performance.now()/400)*0.15;
    c.fillStyle=pal.glow; c.beginPath(); c.arc(0,0,W*0.42,0,Math.PI*2); c.fill();
    c.restore();
  }
  if(kind==='weapon'){
    c.strokeStyle=pal.dark; c.lineWidth=3; c.lineCap='round';
    c.beginPath(); c.moveTo(0,H*0.32); c.lineTo(0,-H*0.36); c.stroke();
    c.strokeStyle=pal.light; c.lineWidth=1.3;
    c.beginPath(); c.moveTo(-1.5,H*0.28); c.lineTo(-1.5,-H*0.34); c.stroke();
    c.strokeStyle=pal.base; c.lineWidth=6; c.lineCap='butt';
    c.beginPath(); c.moveTo(-W*0.16,H*0.1); c.lineTo(W*0.16,H*0.1); c.stroke();
    c.fillStyle=pal.dark; c.beginPath(); c.arc(0,H*0.22,3,0,Math.PI*2); c.fill();
  } else if(kind==='armor'){
    c.fillStyle=pal.base;
    c.beginPath();
    c.moveTo(0,-H*0.34); c.lineTo(W*0.28,-H*0.2); c.lineTo(W*0.24,H*0.2); c.lineTo(0,H*0.36); c.lineTo(-W*0.24,H*0.2); c.lineTo(-W*0.28,-H*0.2);
    c.closePath(); c.fill();
    c.strokeStyle=pal.dark; c.lineWidth=1.6; c.stroke();
    c.strokeStyle=pal.light; c.lineWidth=1;
    c.beginPath(); c.moveTo(0,-H*0.3); c.lineTo(0,H*0.28); c.stroke();
    c.fillStyle=pal.light; c.globalAlpha=0.4;
    c.beginPath(); c.moveTo(0,-H*0.34); c.lineTo(W*0.14,-H*0.26); c.lineTo(0,-H*0.16); c.closePath(); c.fill();
    c.globalAlpha=1;
  } else if(kind==='trinket'){
    c.strokeStyle=pal.base; c.lineWidth=4;
    c.beginPath(); c.arc(0,H*0.12,H*0.22,0,Math.PI*2); c.stroke();
    c.strokeStyle=pal.light; c.lineWidth=1.2;
    c.beginPath(); c.arc(0,H*0.12,H*0.22,Math.PI*1.1,Math.PI*1.7); c.stroke();
    const gGrad = c.createRadialGradient(0,-H*0.22,1,0,-H*0.2,6);
    gGrad.addColorStop(0,pal.light); gGrad.addColorStop(1,pal.dark);
    c.fillStyle=gGrad;
    c.beginPath(); c.moveTo(0,-H*0.32); c.lineTo(5,-H*0.22); c.lineTo(0,-H*0.14); c.lineTo(-5,-H*0.22); c.closePath(); c.fill();
    c.strokeStyle=pal.dark; c.lineWidth=1; c.stroke();
  } else if(kind==='kopf'){
    c.fillStyle=pal.base;
    c.beginPath(); c.arc(0,-H*0.06,H*0.24,Math.PI,0); c.lineTo(H*0.24,H*0.18); c.lineTo(-H*0.24,H*0.18); c.closePath(); c.fill();
    c.strokeStyle=pal.dark; c.lineWidth=1.4; c.stroke();
    c.fillStyle='rgba(0,0,0,.4)'; c.fillRect(-H*0.14,-H*0.02,H*0.28,H*0.07);
    c.strokeStyle=pal.light; c.lineWidth=1;
    c.beginPath(); c.arc(0,-H*0.06,H*0.24,Math.PI*1.1,Math.PI*1.5); c.stroke();
    c.fillStyle=pal.light; c.beginPath(); c.moveTo(0,-H*0.32); c.lineTo(-3,-H*0.24); c.lineTo(3,-H*0.24); c.closePath(); c.fill();
  } else if(kind==='oberkoerper'){
    c.fillStyle=pal.base;
    c.beginPath();
    c.moveTo(0,-H*0.32); c.lineTo(H*0.24,-H*0.18); c.lineTo(H*0.2,H*0.3); c.lineTo(-H*0.2,H*0.3); c.lineTo(-H*0.24,-H*0.18);
    c.closePath(); c.fill();
    c.strokeStyle=pal.dark; c.lineWidth=1.4; c.stroke();
    c.strokeStyle=pal.light; c.lineWidth=1;
    c.beginPath(); c.moveTo(0,-H*0.28); c.lineTo(0,H*0.26); c.stroke();
    for(let i=-1;i<=1;i+=2){ c.strokeStyle=pal.dark; c.lineWidth=0.8; c.beginPath(); c.moveTo(i*H*0.06,-H*0.14); c.lineTo(i*H*0.06,H*0.18); c.stroke(); }
  } else if(kind==='unterkoerper'){
    c.fillStyle=pal.base;
    c.fillRect(-H*0.2,-H*0.28,H*0.4,H*0.2);
    c.fillRect(-H*0.2,-H*0.1,H*0.16,H*0.42);
    c.fillRect(H*0.04,-H*0.1,H*0.16,H*0.42);
    c.strokeStyle=pal.dark; c.lineWidth=1.2;
    c.strokeRect(-H*0.2,-H*0.28,H*0.4,H*0.2);
    c.strokeRect(-H*0.2,-H*0.1,H*0.16,H*0.42);
    c.strokeRect(H*0.04,-H*0.1,H*0.16,H*0.42);
    c.strokeStyle=pal.light; c.lineWidth=0.8;
    c.beginPath(); c.moveTo(-H*0.12,-H*0.24); c.lineTo(H*0.12,-H*0.24); c.stroke();
  } else if(kind==='schild'){
    c.fillStyle=pal.base;
    c.beginPath(); c.moveTo(0,-H*0.32); c.lineTo(H*0.22,-H*0.2); c.lineTo(H*0.2,H*0.1); c.quadraticCurveTo(H*0.1,H*0.32,0,H*0.36); c.quadraticCurveTo(-H*0.1,H*0.32,-H*0.2,H*0.1); c.lineTo(-H*0.22,-H*0.2); c.closePath(); c.fill();
    c.strokeStyle=pal.dark; c.lineWidth=1.4; c.stroke();
    c.strokeStyle=pal.light; c.lineWidth=1;
    c.beginPath(); c.moveTo(0,-H*0.28); c.lineTo(0,H*0.28); c.stroke();
    c.fillStyle=pal.dark; c.beginPath(); c.arc(0,-H*0.02,H*0.06,0,Math.PI*2); c.fill();
  }
  c.restore();
}
function drawClassWeapon(targetCtx, cls, s){
  if(!cls) return;
  const sway = Math.sin(performance.now()/500)*1.2;
  const hx = 8*s, hy = 6*s + sway*0.4*s;
  targetCtx.save();
  if(cls==='Krieger'){
    targetCtx.strokeStyle='#9a9a9a'; targetCtx.lineWidth=1.8*s; targetCtx.lineCap='round';
    targetCtx.beginPath(); targetCtx.moveTo(hx,hy); targetCtx.lineTo(hx+3.2*s,hy-9.5*s); targetCtx.stroke();
    targetCtx.strokeStyle='#e0e0e0'; targetCtx.lineWidth=0.6*s;
    targetCtx.beginPath(); targetCtx.moveTo(hx+0.6*s,hy-0.5*s); targetCtx.lineTo(hx+3.6*s,hy-9.3*s); targetCtx.stroke();
    targetCtx.strokeStyle='#c9822c'; targetCtx.lineWidth=2.6*s; targetCtx.lineCap='butt';
    targetCtx.beginPath(); targetCtx.moveTo(hx-1.6*s,hy+0.8*s); targetCtx.lineTo(hx+1.6*s,hy+0.8*s); targetCtx.stroke();
  } else if(cls==='Magier'){
    targetCtx.strokeStyle='#6b4a2b'; targetCtx.lineWidth=1.5*s; targetCtx.lineCap='round';
    targetCtx.beginPath(); targetCtx.moveTo(hx,hy+2.5*s); targetCtx.lineTo(hx+1.2*s,hy-10*s); targetCtx.stroke();
    const glow=0.55+Math.sin(performance.now()/400)*0.3;
    targetCtx.fillStyle='rgba(110,160,255,'+glow+')';
    targetCtx.beginPath(); targetCtx.arc(hx+1.2*s,hy-10.5*s,2.1*s,0,Math.PI*2); targetCtx.fill();
    targetCtx.strokeStyle='rgba(110,160,255,.6)'; targetCtx.lineWidth=0.7*s;
    targetCtx.beginPath(); targetCtx.arc(hx+1.2*s,hy-10.5*s,3.2*s,0,Math.PI*2); targetCtx.stroke();
  } else if(cls==='Heiler'){
    targetCtx.fillStyle='#efe6cd'; targetCtx.fillRect(hx-2.3*s,hy-3*s,4.6*s,5.6*s);
    targetCtx.strokeStyle='#8b7355'; targetCtx.lineWidth=1*s; targetCtx.strokeRect(hx-2.3*s,hy-3*s,4.6*s,5.6*s);
    const glow=0.7+Math.sin(performance.now()/450)*0.25;
    targetCtx.strokeStyle='rgba(201,79,61,'+glow+')'; targetCtx.lineWidth=1.3*s; targetCtx.lineCap='round';
    targetCtx.beginPath(); targetCtx.moveTo(hx,hy-1.6*s); targetCtx.lineTo(hx,hy+1.2*s);
    targetCtx.moveTo(hx-1.3*s,hy-0.2*s); targetCtx.lineTo(hx+1.3*s,hy-0.2*s); targetCtx.stroke();
  } else if(cls==='Waldläufer'){
    targetCtx.strokeStyle='#6b4a2b'; targetCtx.lineWidth=1.4*s; targetCtx.lineCap='round';
    targetCtx.beginPath(); targetCtx.arc(hx-2*s,hy-2*s,6*s,-0.55,0.95); targetCtx.stroke();
    targetCtx.strokeStyle='rgba(239,230,205,.7)'; targetCtx.lineWidth=0.5*s;
    const x1=hx-2*s+6*s*Math.cos(-0.55), y1=hy-2*s+6*s*Math.sin(-0.55);
    const x2=hx-2*s+6*s*Math.cos(0.95), y2=hy-2*s+6*s*Math.sin(0.95);
    targetCtx.beginPath(); targetCtx.moveTo(x1,y1); targetCtx.lineTo(x2,y2); targetCtx.stroke();
  }
  targetCtx.restore();
}
/* ============================================================
   Getrennte Basis-Modelle für männliche und weibliche Figuren.
   Jedes Modell bringt eigene Geometrie mit — Schulterlinie,
   Taillenverlauf, Hüfte und Ansatzpunkte für Arme und Beine.
   Die Kleidung richtet sich nach diesen Werten, statt einer
   universellen Form aufgezwungen zu werden.
============================================================ */
const AVATAR_MODELS = {
  male: {
    id:'male',
    shoulder: 8.6, waist: 7.4, hip: 7.2,      // Rumpfbreiten
    top: -5.4, waistY: 3.2, bottom: 13.2,     // Höhenmarken
    shoulderSlope: -1.6,                       // gerade, kantige Schulterlinie
    waistPull: 0.06,                           // kaum Einzug
    hipFlare: 0.02,
    limbW: 1.06, armX: 8.6, legX: 3.2,
    headR: 1.0, neckW: 3.0
  },
  female: {
    id:'female',
    shoulder: 6.3, waist: 4.4, hip: 8.0,
    top: -5.0, waistY: 2.6, bottom: 13.2,
    shoulderSlope: -2.2,                       // weicher abfallende Schulter
    waistPull: 0.34,                           // deutliche Taillierung
    hipFlare: 0.22,
    limbW: 0.86, armX: 6.8, legX: 2.9,
    headR: 0.96, neckW: 2.3
  }
};
/* Zwei benannte Render-Einstiege. Beide teilen sich den Zeichenkörper,
   bringen aber ihr eigenes Modell mit und können unabhängig voneinander
   erweitert werden, ohne das jeweils andere zu berühren. */
function renderMaleAvatar(ctx2, appearance, scale, eyeDir, action, walking, cls){
  const a = Object.assign({}, appearance, {gender:'m'});
  return drawHumanoidBody(ctx2, a, scale, eyeDir, action, walking, cls);
}
function renderFemaleAvatar(ctx2, appearance, scale, eyeDir, action, walking, cls){
  const a = Object.assign({}, appearance, {gender:'f'});
  return drawHumanoidBody(ctx2, a, scale, eyeDir, action, walking, cls);
}
// Wählt den passenden Einstieg — hier läuft der dynamische Wechsel zusammen
function renderAvatar(ctx2, appearance, scale, eyeDir, action, walking, cls){
  return (appearance && appearance.gender === 'f')
    ? renderFemaleAvatar(ctx2, appearance, scale, eyeDir, action, walking, cls)
    : renderMaleAvatar(ctx2, appearance, scale, eyeDir, action, walking, cls);
}
function avatarModel(appearance){
  return (appearance && appearance.gender === 'f') ? AVATAR_MODELS.female : AVATAR_MODELS.male;
}
/* Rumpfkontur aus den Modellwerten — jede Figur bekommt so ihre
   eigene Linienführung statt einer angepassten Einheitsform. */
function torsoPathFor(ctx2, s, M){
  const shW = M.shoulder*s, wsW = M.waist*s, hipW = M.hip*s;
  const top = M.top*s, waist = M.waistY*s, bottom = M.bottom*s;
  const pull = M.waistPull, flare = M.hipFlare;
  ctx2.beginPath();
  ctx2.moveTo(-shW, top);
  // Schulter zur Taille — pull steuert, wie stark die Linie einzieht
  ctx2.bezierCurveTo(-shW*(1+pull*0.30), top+1.6*s,
                     -wsW*(1+pull*0.55), waist-2.8*s, -wsW, waist);
  // Taille zur Hüfte — flare steuert die Ausladung
  ctx2.bezierCurveTo(-hipW*(0.86+flare*0.30), waist+2.6*s,
                     -hipW*(1+flare*0.10), bottom-3.6*s, -hipW*0.94, bottom);
  ctx2.lineTo(hipW*0.94, bottom);
  ctx2.bezierCurveTo(hipW*(1+flare*0.10), bottom-3.6*s,
                     hipW*(0.86+flare*0.30), waist+2.6*s, wsW, waist);
  ctx2.bezierCurveTo(wsW*(1+pull*0.55), waist-2.8*s,
                     shW*(1+pull*0.30), top+1.6*s, shW, top);
  // Schulterlinie: gerade beim männlichen, abfallend beim weiblichen Modell
  ctx2.bezierCurveTo(shW*0.55, top+M.shoulderSlope*s,
                     -shW*0.55, top+M.shoulderSlope*s, -shW, top);
  ctx2.closePath();
}
/* Plastische Füllung: Radialverlauf mit Lichtkern oben links, satter
   Grundton in der Fläche und Tiefton am Rand — dieselbe Logik wie bei
   den Monstern, damit die Figur Volumen bekommt statt flach zu wirken. */
function volumeFill(ctx2, cxv, cyv, rxv, ryv, baseCol){
  const g = ctx2.createRadialGradient(cxv - rxv*0.38, cyv - ryv*0.42, Math.max(0.5, rxv*0.08),
                                      cxv, cyv + ryv*0.12, Math.max(rxv, ryv)*1.25);
  g.addColorStop(0,   shadeColor(baseCol, 34));
  g.addColorStop(0.34, shadeColor(baseCol, 10));
  g.addColorStop(0.74, baseCol);
  g.addColorStop(1,   shadeColor(baseCol, -30));
  return g;
}
function drawHumanoidBody(targetCtx, appearance, scale, eyeDir, action, walking, cls){
  const s = scale;
  const outline = '#26261f';
  /* Geschlecht wirkt sich auf die Proportionen aus — vorher wurde es
     zwar gespeichert, aber nirgends dargestellt. */
  // Eigenständiges Basis-Modell je Geschlecht
  const baseM = avatarModel(appearance);
  /* Die Fülle-Stufe (schmal / normal / voll) wirkt jetzt auch auf die
     Statur — vorher änderte sie nur die Haarmenge. */
  const buildStep = Math.floor((appearance.hairstyle||0) / (typeof HAIR_SHAPES!=='undefined' ? HAIR_SHAPES.length : 16));
  const buildF = [0.90, 1.0, 1.13][clamp(buildStep,0,2)];
  const M = Object.assign({}, baseM, {
    shoulder: baseM.shoulder * (1 + (buildF-1)*0.85),
    waist:    baseM.waist    * (1 + (buildF-1)*1.35),   // Taille reagiert am stärksten
    hip:      baseM.hip      * (1 + (buildF-1)*0.95),
    limbW:    baseM.limbW    * (1 + (buildF-1)*0.70),
    armX:     baseM.armX     * (1 + (buildF-1)*0.60)
  });
  const fem = (M.id === 'female');
  const limbW = M.limbW;
  const headR = M.headR;
  const now = performance.now();
  targetCtx.save();
  targetCtx.fillStyle='rgba(0,0,0,.25)';
  targetCtx.beginPath(); targetCtx.ellipse(0,13*s,9*s,3*s,0,0,Math.PI*2); targetCtx.fill();
  const walkPhase = walking ? Math.sin(now/110) : 0;
  targetCtx.fillStyle = shadeColor(appearance.outfitColor,-35);
  [-1,1].forEach(side=>{
    const legShift = walking ? side*walkPhase*2.4*s : 0;
    const lx = side*M.legX*s+legShift*0.3, ly = 11*s-Math.abs(legShift)*0.15;
    targetCtx.fillStyle = volumeFill(targetCtx, lx, ly, 2.6*s*limbW, 4*s, appearance.outfitColor);
    targetCtx.beginPath(); targetCtx.ellipse(lx, ly, 2.6*s*limbW, 4*s, 0,0,Math.PI*2); targetCtx.fill();
    targetCtx.strokeStyle=outline; targetCtx.lineWidth=0.9*s; targetCtx.stroke();
    targetCtx.fillStyle='rgba(255,255,255,.1)';
    targetCtx.beginPath(); targetCtx.ellipse(lx-0.7*s, ly-1.5*s, 1*s, 2*s, 0,0,Math.PI*2); targetCtx.fill();
    targetCtx.fillStyle = shadeColor(appearance.outfitColor,-35);
  });
  const workPhase = action ? Math.sin(now/160) : 0; // -1..1
  const skinCol = appearance.skinColor||'#e8c9a0';
  let toolHandX=0, toolHandY=0;
  [-1,1].forEach(side=>{
    let armX = side*M.armX*s, armY = 3*s, armLen = 5.5*s;
    if(action && side===1){
      armX = side*7.5*s + workPhase*2.2*s;
      armY = 1.5*s - workPhase*4.5*s;
    } else if(walking){
      armY += side*walkPhase*-1.6*s;
    }
    targetCtx.fillStyle = volumeFill(targetCtx, armX, armY, 2.6*s*limbW, armLen, skinCol);
    targetCtx.beginPath(); targetCtx.ellipse(armX, armY, 2.6*s*limbW, armLen, side*0.15, 0, Math.PI*2); targetCtx.fill();
    targetCtx.strokeStyle=outline; targetCtx.lineWidth=0.9*s; targetCtx.stroke();
    if(action && side===1){ toolHandX = armX; toolHandY = armY + armLen*0.75; }
  });
  const outfitStyle = appearance.outfitStyle||0;
  const oc = appearance.outfitColor;
  // Grundsilhouette zuerst — sie bestimmt die Körperform unter der Kleidung
  torsoPathFor(targetCtx, s, M);
  targetCtx.fillStyle = volumeFill(targetCtx, 0, 3*s, (fem?7.8:8.4)*s, 9*s, oc);
  targetCtx.fill();
  targetCtx.strokeStyle = outline; targetCtx.lineWidth = 1.25*s; targetCtx.stroke();
  // Taillenschatten betont die Körperlinie
  targetCtx.save();
  torsoPathFor(targetCtx, s, M); targetCtx.clip();
  if(fem){
    targetCtx.fillStyle='rgba(0,0,0,.16)';
    targetCtx.beginPath(); targetCtx.ellipse(-7.2*s, 3*s, 2.6*s, 4.2*s, 0,0,Math.PI*2); targetCtx.fill();
    targetCtx.beginPath(); targetCtx.ellipse( 7.2*s, 3*s, 2.6*s, 4.2*s, 0,0,Math.PI*2); targetCtx.fill();
  }
  // Kleidung folgt der Silhouette
  targetCtx.fillStyle = oc;
  if(outfitStyle===1){
    targetCtx.beginPath();
    const cW=M.shoulder*0.82, cO=M.shoulder*1.11, cH=M.hip*0.97;
    targetCtx.moveTo(-cW*s,-4*s); targetCtx.lineTo(-cO*s,-1*s); targetCtx.lineTo(-cH*s,13*s); targetCtx.lineTo(cH*s,13*s); targetCtx.lineTo(cO*s,-1*s); targetCtx.lineTo(cW*s,-4*s);
    targetCtx.closePath(); targetCtx.fill();
    targetCtx.strokeStyle=outline; targetCtx.lineWidth=1.2*s; targetCtx.stroke();
    targetCtx.fillStyle=shadeColor(oc,-25);
    targetCtx.beginPath(); targetCtx.ellipse(-M.shoulder*1.0*s,-2*s,3*s*limbW,2.6*s,0,0,Math.PI*2); targetCtx.fill();
    targetCtx.beginPath(); targetCtx.ellipse( M.shoulder*1.0*s,-2*s,3*s*limbW,2.6*s,0,0,Math.PI*2); targetCtx.fill();
    targetCtx.strokeStyle='rgba(0,0,0,.22)'; targetCtx.lineWidth=1*s;
    targetCtx.beginPath(); targetCtx.moveTo(0,-2*s); targetCtx.lineTo(0,11*s); targetCtx.stroke();
  } else if(outfitStyle===2){
    targetCtx.beginPath();
    targetCtx.moveTo(-4*s,-7*s); targetCtx.lineTo(0,-3.5*s); targetCtx.lineTo(4*s,-7*s);
    targetCtx.lineTo(3*s,-2*s); targetCtx.lineTo(11*s,13*s); targetCtx.lineTo(-11*s,13*s); targetCtx.lineTo(-3*s,-2*s);
    targetCtx.closePath(); targetCtx.fill();
    targetCtx.strokeStyle=outline; targetCtx.lineWidth=1.2*s; targetCtx.stroke();
    targetCtx.fillStyle=shadeColor(oc,22);
    targetCtx.beginPath(); targetCtx.moveTo(-4*s,-7*s); targetCtx.lineTo(0,-3.5*s); targetCtx.lineTo(4*s,-7*s); targetCtx.closePath(); targetCtx.fill();
  } else if(outfitStyle===3){
    targetCtx.beginPath(); targetCtx.ellipse(0,1*s,M.shoulder*0.90*s,6.2*s,0,0,Math.PI*2); targetCtx.fill();
    targetCtx.strokeStyle=outline; targetCtx.lineWidth=1.2*s; targetCtx.stroke();
    targetCtx.fillStyle='#6b4a2b';
    const bw=M.waist*1.02;
    targetCtx.fillRect(-bw*s,5.5*s,bw*2*s,2.2*s);
    targetCtx.strokeStyle='rgba(0,0,0,.3)'; targetCtx.lineWidth=0.8*s; targetCtx.strokeRect(-bw*s,5.5*s,bw*2*s,2.2*s);
  } else {
    targetCtx.beginPath(); targetCtx.ellipse(0,4*s,M.shoulder*0.95*s,10*s,0,0,Math.PI*2); targetCtx.fill();
    targetCtx.strokeStyle=outline; targetCtx.lineWidth=1.2*s; targetCtx.stroke();
    targetCtx.fillStyle='rgba(0,0,0,.28)';
    targetCtx.fillRect(-M.waist*1.05*s, 6.4*s, M.waist*2.1*s, 1.8*s);
  }
  targetCtx.fillStyle='rgba(255,255,255,.16)';
  targetCtx.beginPath(); targetCtx.ellipse(-2.6*s, 0, 3*s, 5*s, -0.2, 0, Math.PI*2); targetCtx.fill();
  targetCtx.restore();
  // Konturlinie der Silhouette zum Schluss, damit sie über der Kleidung liegt
  torsoPathFor(targetCtx, s, M);
  targetCtx.strokeStyle = outline; targetCtx.lineWidth = 1.15*s; targetCtx.stroke();
  // Kopf plastisch: Radialverlauf statt flacher Fläche
  const hR = 7*s*headR;
  targetCtx.fillStyle = volumeFill(targetCtx, 0, -9*s, hR, hR, skinCol);
  targetCtx.beginPath(); targetCtx.arc(0,-9*s,hR,0,Math.PI*2); targetCtx.fill();
  targetCtx.strokeStyle=outline; targetCtx.lineWidth=1.2*s; targetCtx.stroke();
  // Streulicht am Kinn — wirkt wie durchscheinende Haut
  targetCtx.save();
  targetCtx.beginPath(); targetCtx.arc(0,-9*s,hR,0,Math.PI*2); targetCtx.clip();
  const chin = targetCtx.createRadialGradient(0,-9*s+hR*0.55,hR*0.05,0,-9*s+hR*0.55,hR*0.75);
  chin.addColorStop(0, shadeColor(skinCol, 22)); chin.addColorStop(1,'rgba(255,255,255,0)');
  targetCtx.globalAlpha=0.35; targetCtx.fillStyle=chin;
  targetCtx.fillRect(-hR,-9*s-hR,hR*2,hR*2);
  targetCtx.restore();
  targetCtx.fillStyle='rgba(190,120,90,.2)';
  targetCtx.beginPath(); targetCtx.arc(3.4*s,-6.8*s,1.6*s,0,Math.PI*2); targetCtx.fill();
  /* Rückansicht: der Hinterkopf ist vollständig behaart. drawHair() setzt
     nur eine Kappe auf den oberen Kopf — von vorn richtig, von hinten sah
     man darunter blanke Haut. Deshalb hier zuerst eine geschlossene
     Haarmasse über den ganzen Schädel, danach die Frisur darüber. */
  if(eyeDir === 'up'){
    const hc = appearance.hairColor || '#3a2a1a';
    targetCtx.save();
    // geschlossener Hinterkopf
    const hv = targetCtx.createRadialGradient(-hR*0.30, -9*s-hR*0.40, hR*0.12,
                                              0, -9*s, hR*1.10);
    hv.addColorStop(0, shadeColor(hc, 24));
    hv.addColorStop(0.55, hc);
    hv.addColorStop(1, shadeColor(hc, -28));
    targetCtx.fillStyle = hv;
    targetCtx.beginPath();
    targetCtx.ellipse(0, -9*s, hR*1.03, hR*1.06, 0, 0, Math.PI*2);
    targetCtx.fill();
    // Nackenpartie, die unter dem Kopf hervorschaut
    targetCtx.fillStyle = shadeColor(hc, -16);
    targetCtx.beginPath();
    targetCtx.ellipse(0, -9*s + hR*0.62, hR*0.72, hR*0.46, 0, 0, Math.PI*2);
    targetCtx.fill();
    // Scheitel und ein paar Strähnen, damit es nicht wie ein Helm wirkt
    targetCtx.strokeStyle = shadeColor(hc, -34);
    targetCtx.lineWidth = 0.7*s;
    targetCtx.beginPath();
    targetCtx.moveTo(0, -9*s - hR*0.95); targetCtx.lineTo(0, -9*s + hR*0.55);
    targetCtx.stroke();
    targetCtx.strokeStyle = shadeColor(hc, 30);
    targetCtx.lineWidth = 0.55*s;
    [-0.52, -0.24, 0.24, 0.52].forEach(f=>{
      targetCtx.beginPath();
      targetCtx.moveTo(hR*f*0.9, -9*s - hR*0.80);
      targetCtx.quadraticCurveTo(hR*f*1.15, -9*s, hR*f*0.85, -9*s + hR*0.50);
      targetCtx.stroke();
    });
    targetCtx.strokeStyle = shadeColor(hc, -40);
    targetCtx.lineWidth = 0.8*s;
    targetCtx.beginPath();
    targetCtx.ellipse(0, -9*s, hR*1.03, hR*1.06, 0, 0, Math.PI*2);
    targetCtx.stroke();
    targetCtx.restore();
  }
  // Frisur sitzt auf dem Kopf des jeweiligen Modells: Radius und
  // Ansatzhöhe kommen aus dem Modell, nicht aus festen Zahlen.
  drawHair(targetCtx, 0, -9*s, hR*(fem?1.02:1.05), appearance.hairstyle, appearance.hairColor);
  // Haaransatz an der Stirn verankert die Frisur optisch am Kopf
  targetCtx.save();
  targetCtx.beginPath(); targetCtx.arc(0,-9*s,hR,0,Math.PI*2); targetCtx.clip();
  // schmaler Schattensaum, wo das Haar den Kopf berührt
  targetCtx.fillStyle = shadeColor(appearance.hairColor||'#3a2a1a', -34);
  targetCtx.globalAlpha = 0.22;
  targetCtx.beginPath();
  targetCtx.ellipse(0, -9*s-hR*0.30, hR*0.94, hR*0.24, 0, 0, Math.PI*2);
  targetCtx.fill();
  targetCtx.restore();
  {
    let ex=0,ey=-9*s;
    if(eyeDir==='left'){ ex=-3*s; } else if(eyeDir==='right'){ ex=3*s; } else if(eyeDir==='up'){ ey=-11*s; }
    if(eyeDir!=='up'){
      const face = appearance.faceStyle||0;
      if(face===1){
        targetCtx.fillStyle='#26261f';
        [ex-2*s,ex+2*s].forEach(x=>{ targetCtx.beginPath(); targetCtx.ellipse(x,ey,1.3*s,0.7*s,0,0,Math.PI*2); targetCtx.fill(); });
      } else if(face===2){
        targetCtx.fillStyle='#26261f';
        [ex-2*s,ex+2*s].forEach(x=>{ targetCtx.beginPath(); targetCtx.arc(x,ey,1.5*s,0,Math.PI*2); targetCtx.fill(); });
        targetCtx.fillStyle='rgba(255,255,255,.85)';
        [ex-2*s,ex+2*s].forEach(x=>{ targetCtx.beginPath(); targetCtx.arc(x-0.4*s,ey-0.4*s,0.45*s,0,Math.PI*2); targetCtx.fill(); });
      } else if(face===3){
        targetCtx.strokeStyle='#26261f'; targetCtx.lineWidth=1*s; targetCtx.lineCap='round';
        [ex-2*s,ex+2*s].forEach(x=>{ targetCtx.beginPath(); targetCtx.arc(x,ey+0.6*s,1.3*s,Math.PI*1.15,Math.PI*1.85); targetCtx.stroke(); });
      } else {
        targetCtx.fillStyle='#26261f';
        [ex-2*s,ex+2*s].forEach(x=>{ targetCtx.beginPath(); targetCtx.arc(x,ey,1.2*s,0,Math.PI*2); targetCtx.fill(); });
      }
      /* Mund — er fehlte bisher ganz. Form richtet sich nach dem
         Gesichtstyp, Position sitzt unterhalb der Augen am Kinn. */
      const my = ey + 3.4*s;
      targetCtx.strokeStyle = '#26261f';
      targetCtx.lineWidth = 0.85*s;
      targetCtx.lineCap = 'round';
      targetCtx.beginPath();
      if(face===1){
        // ernst: gerader, leicht gesenkter Strich
        targetCtx.moveTo(ex-1.5*s, my);
        targetCtx.quadraticCurveTo(ex, my+0.35*s, ex+1.5*s, my);
      } else if(face===2){
        // offen: kleiner Bogen nach oben
        targetCtx.moveTo(ex-1.7*s, my-0.3*s);
        targetCtx.quadraticCurveTo(ex, my+1.5*s, ex+1.7*s, my-0.3*s);
      } else if(face===3){
        // verschmitzt: einseitig angehoben
        targetCtx.moveTo(ex-1.6*s, my+0.3*s);
        targetCtx.quadraticCurveTo(ex+0.2*s, my+1.0*s, ex+1.7*s, my-0.5*s);
      } else {
        // freundlich: sanftes Lächeln
        targetCtx.moveTo(ex-1.6*s, my-0.15*s);
        targetCtx.quadraticCurveTo(ex, my+1.15*s, ex+1.6*s, my-0.15*s);
      }
      targetCtx.stroke();
      // Lippenschatten gibt dem Mund etwas Tiefe
      targetCtx.strokeStyle = 'rgba(190,120,110,.35)';
      targetCtx.lineWidth = 0.5*s;
      targetCtx.beginPath();
      targetCtx.moveTo(ex-1.2*s, my+0.7*s);
      targetCtx.quadraticCurveTo(ex, my+1.35*s, ex+1.2*s, my+0.7*s);
      targetCtx.stroke();
    }
  }
  if(action){ drawWorkTool(targetCtx, toolHandX, toolHandY, s, action); }
  else if(cls){ drawClassWeapon(targetCtx, cls, s); }
  targetCtx.restore();
}
function actionForJobKind(kind){
  if(kind==='chop') return 'chop';
  if(kind==='mine') return 'mine';
  if(kind==='harvest') return 'harvest';
  if(kind==='build') return 'build';
  return null;
}
function drawColonistSprite(cx,cy,c,now){
  const ap = c.appearance || (c.appearance = randomAppearance());
  // Schlafend: liegende Figur mit Zzz statt stehender Darstellung
  if(c.sleeping){
    ctx.save();
    ctx.fillStyle='rgba(0,0,0,.22)';
    ctx.beginPath(); ctx.ellipse(cx,cy+9,13,4,0,0,Math.PI*2); ctx.fill();
    ctx.translate(cx, cy+4); ctx.rotate(-Math.PI/2);
    ctx.globalAlpha = 0.9;
    try{ drawHumanoidBody(ctx, ap, 0.95, null, null, false, null); }catch(e){}
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.5+Math.sin(now/650)*0.3;
    ctx.fillStyle='#cfe0ff'; ctx.textAlign='center';
    ctx.font='bold 10px sans-serif'; ctx.fillText('z', cx+9, cy-9+Math.sin(now/520)*1.5);
    ctx.font='bold 7px sans-serif';  ctx.fillText('z', cx+14, cy-14+Math.sin(now/520+1)*1.5);
    ctx.restore();
    return;
  }
  // Freizeitaktivität: Symbol über dem Kopf, Sitzhaltung bei ruhigen Tätigkeiten
  if(c.leisure && !c.sleeping){
    const def = leisureInfo(c.leisure.kind);
    if(def){
      ctx.save();
      const wob = Math.sin(now/600 + (c.x+c.y))*2;
      // kleine Sprechblase mit Symbol
      ctx.globalAlpha = 0.9;
      ctx.fillStyle='rgba(19,42,32,.78)';
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(cx-10, cy-32+wob, 20, 16, 6)
                                     : ctx.rect(cx-10, cy-32+wob, 20, 16);
      ctx.fill();
      ctx.strokeStyle='rgba(233,230,205,.35)'; ctx.lineWidth=1; ctx.stroke();
      ctx.font='11px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(def.icon, cx, cy-24+wob);
      ctx.textBaseline='alphabetic';
      ctx.restore();
      // Bei Schach/Essen eine Verbindungslinie zum Partner
      if(c.leisure.partnerId){
        const p = state.colonists.find(o=>o.id===c.leisure.partnerId);
        if(p && p.leisure){
          const px2 = (p.x-camera.x)*TILE + TILE/2, py2 = (p.y-camera.y)*TILE + TILE/2;
          ctx.save();
          ctx.globalAlpha = 0.22;
          ctx.strokeStyle='#e8a94d'; ctx.lineWidth=1.4; ctx.setLineDash([3,3]);
          ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(px2, py2); ctx.stroke();
          ctx.restore();
        }
      }
    }
  }
  // Pfeilflug bei Fernkampf kurz einzeichnen
  if(c.combatFx && Date.now() < c.combatFx.until && c.combatFx.ranged){
    const t = 1 - (c.combatFx.until - Date.now())/400;
    const sx = (c.combatFx.fx - camera.x)*TILE + TILE/2;
    const sy = (c.combatFx.fy - camera.y)*TILE + TILE/2;
    const ex = (c.combatFx.tx - camera.x)*TILE + TILE/2;
    const ey = (c.combatFx.ty - camera.y)*TILE + TILE/2;
    const ax = sx+(ex-sx)*t, ay = sy+(ey-sy)*t;
    ctx.save();
    ctx.strokeStyle='#e8d9a8'; ctx.lineWidth=1.6; ctx.lineCap='round';
    const ang = Math.atan2(ey-sy, ex-sx);
    ctx.beginPath();
    ctx.moveTo(ax-Math.cos(ang)*5, ay-Math.sin(ang)*5);
    ctx.lineTo(ax, ay); ctx.stroke();
    ctx.fillStyle='#c9b988';
    ctx.beginPath(); ctx.arc(ax,ay,1.8,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }
  const bob = Math.sin(now/300 + (c.id.length||1))*1.5;
  if(selectedColonistId===c.id){
    ctx.save(); ctx.strokeStyle='#e8a94d'; ctx.lineWidth=2; ctx.beginPath(); ctx.arc(cx,cy+3,16,0,Math.PI*2); ctx.stroke(); ctx.restore();
  }
  const action = c.state==='working' && c.job ? actionForJobKind(c.job.kind) : null;
  const walking = c.state==='moving' && c.anim && c.anim.moving;
  ctx.save(); ctx.translate(cx,cy+bob);
  drawHumanoidBody(ctx, ap, 0.82, null, action, walking, c.advClass);
  ctx.restore();
  const sick = c.sickUntil && Date.now()<c.sickUntil;
  ctx.font='11px sans-serif'; ctx.textAlign='center';
  ctx.fillText(sick?'🤒':workIconOf(c), cx, cy-20);
  ctx.beginPath(); ctx.arc(cx+9,cy-16,2.4,0,Math.PI*2); ctx.fillStyle=moodColor(c.mood); ctx.fill();
  if(c.carrying){
    ctx.font='10px sans-serif'; ctx.fillStyle='#efe6cd';
    ctx.fillText(RESOURCE_ICONS[c.carrying.resource]||'📦', cx-9, cy-20);
  }
  if(c.spouseId || c.partnerId){
    ctx.font='9px sans-serif'; ctx.fillStyle='#efe6cd';
    ctx.fillText(c.spouseId?'💍':'💕', cx-9, cy-30);
  }
}
/* Einzelner Kolonist. Ausgelöst aus drawColonists(), damit die Figur in
   die gemeinsame Y-Sortierung von main.js eingereiht werden kann statt in
   einem eigenen Durchgang danach zu laufen. */
function drawOneColonist(c, now){
  let rx=c.x, ry=c.y;
  if(c.anim && c.anim.moving){
    const raw = clamp((now-c.anim.start)/c.anim.dur,0,1);
    const t = raw*raw*(3-2*raw);
    rx = lerp(c.anim.fromX,c.anim.toX,t); ry = lerp(c.anim.fromY,c.anim.toY,t);
  }
  const sx=(rx-camera.x)*TILE, sy=(ry-camera.y)*TILE;
  if(sx>-TILE && sx<canvas.width+TILE && sy>-TILE && sy<canvas.height+TILE){
    drawColonistSprite(sx+TILE/2, sy+TILE/2, c, now);
  }
}

/* Einzelnes Wildwesen, aus demselben Grund ausgelöst. */
function drawOneWildMonster(wm, now){
  const sx=(wm.x-camera.x)*TILE+TILE/2, sy=(wm.y-camera.y)*TILE+TILE/2;
  if(sx<-TILE || sx>canvas.width+TILE || sy<-TILE || sy>canvas.height+TILE) return;
  const sp = SPECIES[wm.speciesId]; if(!sp) return;
  const rar = sp.rarity;
  if(wm.hostile){
    ctx.save(); ctx.strokeStyle='#d9542d'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.arc(sx,sy,17,0,Math.PI*2); ctx.stroke(); ctx.restore();
  }
  drawMonster(ctx, sx, sy, RARITY_SIZE[rar] || 26, sp, true);
}

function drawColonists(now){
  // Nach tatsächlicher (animierter) Y-Position sortieren, damit sich
  // Figuren beim Aneinandervorbeigehen korrekt überlagern
  const order = state.colonists.slice().sort((a,b)=>{
    const ay = (a.anim && a.anim.moving) ? lerp(a.anim.fromY,a.anim.toY,clamp((now-a.anim.start)/a.anim.dur,0,1)) : a.y;
    const by = (b.anim && b.anim.moving) ? lerp(b.anim.fromY,b.anim.toY,clamp((now-b.anim.start)/b.anim.dur,0,1)) : b.y;
    return ay-by;
  });
  order.forEach(c=>{
    let rx=c.x, ry=c.y;
    if(c.anim && c.anim.moving){
      const raw = clamp((now-c.anim.start)/c.anim.dur,0,1);
      // Smoothstep: sanftes Anlaufen und Auslaufen statt harter linearer Bewegung
      const t = raw*raw*(3-2*raw);
      rx = lerp(c.anim.fromX,c.anim.toX,t); ry = lerp(c.anim.fromY,c.anim.toY,t);
    }
    const sx=(rx-camera.x)*TILE, sy=(ry-camera.y)*TILE;
    if(sx>-TILE && sx<canvas.width+TILE && sy>-TILE && sy<canvas.height+TILE){ drawColonistSprite(sx+TILE/2, sy+TILE/2, c, now); }
  });
  drawVillagers(now);
}
let playerActionType = null, playerActionUntil = 0;
function drawPlayer(screenX,screenY,facing,walking,now){
  const cx=screenX+TILE/2, cy=screenY+TILE/2;
  const bob = walking ? Math.sin(now/70)*2 : 0;
  const ap = state.player.appearance || (state.player.appearance = randomAppearance());
  const action = now<playerActionUntil ? playerActionType : null;
  ctx.save(); ctx.translate(cx,cy+bob);
  drawHumanoidBody(ctx, ap, 1, facing, action, walking && !action, state.player.advClass);
  ctx.restore();
}
function currentPlayerRender(){
  if(moveAnim.moving){
    const t = clamp((performance.now()-moveAnim.start)/moveAnim.dur,0,1);
    return { x: lerp(moveAnim.fromX,moveAnim.toX,t), y: lerp(moveAnim.fromY,moveAnim.toY,t) };
  }
  return { x:state.player.x, y:state.player.y };
}
function drawWeatherOverlay(now){
  if(state.weather.type==='rain' || state.weather.type==='storm'){
    ctx.save(); ctx.strokeStyle='rgba(180,210,230,.35)'; ctx.lineWidth=1.4;
    const count = state.weather.type==='storm'?60:36;
    for(let i=0;i<count;i++){
      const seedv = i*97.31;
      const x = ((seedv*13 + now*0.25) % (canvas.width+40)) - 20;
      const y = ((seedv*7 + now*0.6) % (canvas.height+40)) - 20;
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x-6,y+14); ctx.stroke();
    }
    ctx.restore();
  } else if(state.weather.type==='cold'){
    ctx.save(); ctx.fillStyle='rgba(180,220,240,.08)'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.restore();
  }
}

/* ---------- day / night cycle ---------- */
/* ---------- sleep / bed time-skip ---------- */
function nextDawnDelta(){
  const targetPos = 0.22 * DAY_CYCLE_MS;
  const cyclePos = (((Date.now() - state.dayCycleOffset) % DAY_CYCLE_MS) + DAY_CYCLE_MS) % DAY_CYCLE_MS;
  let delta = targetPos - cyclePos;
  if(delta <= DAY_CYCLE_MS*0.15) delta += DAY_CYCLE_MS;
  return delta;
}
function sleepUntilMorning(){
  const fade = document.getElementById('sleepFade');
  fade.style.pointerEvents='auto';
  fade.style.opacity='1';
  setTimeout(()=>{
    const delta = nextDawnDelta();
    state.dayCycleOffset -= delta;
    state.stats.energy = 100;
    state.stats.hunger = clamp(state.stats.hunger-10, 0, 100);
    state.stats.thirst = clamp(state.stats.thirst-10, 0, 100);
    // Schlafen im Bett heilt vollständig, ohne Bett nur teilweise
    const hasBed = state.buildings.some(b=>b.type==='tent' && b.built);
    const healed = hasBed ? 100 : Math.min(100, state.stats.hp + 45);
    if(healed > state.stats.hp){
      state.stats.hp = healed;
      logEvent(hasBed ? '❤️ Ausgeruht im Bett — Leben voll regeneriert.' : '❤️ Etwas erholt (ein Bett würde mehr bringen).');
    }
    state.colonists.forEach(c=>{ if(c.hp!==undefined && c.maxHp) c.hp = c.maxHp; });
    if(state.activeId!=null && state.collection[state.activeId]){
      const c = state.collection[state.activeId]; const sp = SPECIES[state.activeId];
      c.currentHp = sp.stats.hp;
    }
    state.colonists.forEach(c=>{ c.mood = clamp(c.mood+8,0,100); });
    logEvent('🛏️ Du hast bis zum Morgen geschlafen.');
    updateHUD(); updateDayNightIndicator(); saveGame();
    toast('☀️ Ein neuer Tag beginnt.');
    setTimeout(()=>{
      fade.style.opacity='0';
      setTimeout(()=>{ fade.style.pointerEvents='none'; }, 850);
    }, 300);
  }, 850);
}
/* ---------- Rückschreibe-Setter für die globale Brücke ----------
   Diese Bindings werden von anderen Modulen überschrieben. Ohne diese
   Funktionen käme die Zuweisung hier nie an und dieses Modul würde mit
   einem veralteten Wert weiterarbeiten. Siehe bridgeModule() in main.js. */
function __set_playerActionType(v){ playerActionType = v; }
function __set_playerActionUntil(v){ playerActionUntil = v; }

export {
  __set_playerActionType,
  __set_playerActionUntil,

  attachCanvas,
  drawOneColonist,
  drawOneWildMonster,
  drawWallDamage,
  drawWandStufe,
  wandRichtung,
  wandBand,
  WAND_STUFEN,
  fitCanvasToStage,
  getCtx,
  getCanvas,
  ctxReady,
  AVATAR_MODELS,
  BUILD_EMOJI,
  BUSH_SPR_AX,
  BUSH_SPR_AY,
  BUSH_SPR_H,
  BUSH_SPR_W,
  FENCE_LIKE,
  ROCK_SPR_AX,
  ROCK_SPR_AY,
  ROCK_SPR_H,
  ROCK_SPR_W,
  TREE_DMG_STEPS,
  TREE_SPR_AX,
  TREE_SPR_AY,
  TREE_SPR_H,
  TREE_SPR_W,
  TREE_VARIANTS,
  actionForJobKind,
  activeBuildingRotation,
  avatarModel,
  ctx,
  currentPlayerRender,
  drawBuilding,
  drawCampfire,
  drawChimney,
  drawClassWeapon,
  drawColonistSprite,
  drawColonists,
  drawEquipIcon,
  drawFacadeFurniture,
  drawFrontedFurniture,
  drawHumanoidBody,
  drawObject,
  drawPlayer,
  drawSmoke,
  drawSolid,
  drawSparks,
  drawStoneBlocks,
  drawTile,
  drawWeatherOverlay,
  drawWoodPlanks,
  drawWorkTool,
  fenceConnections,
  getCachedSprite,
  invalidateSpriteCache,
  mixAny,
  mixHex,
  nextDawnDelta,
  paintBush,
  paintRock,
  paintTree,
  parseCol,
  playerActionType,
  playerActionUntil,
  renderAvatar,
  renderFemaleAvatar,
  renderMaleAvatar,
  shadeColor,
  sleepUntilMorning,
  spriteCache,
  spriteCacheHits,
  spriteCacheMisses,
  tierPalette,
  torsoPathFor,
  uprightText,
  volumeFill,
  vrand
};
