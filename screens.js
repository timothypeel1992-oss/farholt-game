/* ============================================================
   ui/screens.js — Bildschirme
   Titelbild, Story-Intro, Charaktererstellung und
   der Spielende-Bildschirm.
============================================================ */

import { DAY_CYCLE_MS, clamp } from '../engine/rng.js';
import { sfxError, sfxEvent, sfxJoin, sfxRaid, startMusicTrack } from '../engine/audio.js';
/* ============================================================
   Story-Intro: Ankunft an der Küste von Farholt
   Jede Szene wird prozedural gezeichnet — kein einziges Bild.
============================================================ */
const INTRO_SCENES = [
  {
    chapter:'I · Die Überfahrt',
    text:'Neun Tage auf offener See. Die Karten der Alten enden westlich von Farholm — dahinter nur weißes Pergament und die Randnotiz eines längst verstorbenen Kartografen: „Hier war einmal Land."\n\nDrei Boote sind aufgebrochen. Eines ist noch übrig.',
    scene:'sea'
  },
  {
    chapter:'II · Landfall',
    text:'Im Morgengrauen des zehnten Tages schiebt sich eine dunkle Linie aus dem Dunst. Kein Riff, kein Nebelbank — eine Küste. Salzgras, dahinter Wald, und weit im Landesinneren die Silhouette von etwas, das zu gerade ist, um von der Natur gemacht zu sein.\n\nFarholt. Der Landstrich, den es nicht mehr geben sollte.',
    scene:'coast'
  },
  {
    chapter:'III · Das Boot',
    text:'Der Kiel läuft auf Sand. Ihr zerrt das Boot über die Flutlinie, stapelt Kisten, zählt Vorräte — und stellt fest, dass die Rückreise mit dem, was übrig ist, niemand überstehen würde.\n\nJemand schlägt vor, das Holz für den ersten Unterstand zu verwenden. Niemand widerspricht.',
    scene:'landing'
  },
  {
    chapter:'IV · Alt-Farholt',
    text:'Von der Düne aus seht ihr sie zum ersten Mal deutlich: zerborstene Säulen jenseits der Baumgrenze, überwuchert von Jahrzehnten. Wer immer hier lebte, baute größer als alles, was ihr kennt.\n\nUnd hat es zurückgelassen.',
    scene:'ruins'
  },
  {
    chapter:'V · Der erste Tag',
    text:'Was vor euch liegt, hat keinen Namen mehr — bis ihr ihm einen gebt.\n\nSchlagt Holz, brecht Stein, errichtet ein Dach für die erste Nacht. Der Wald wird euch geben, was ihr braucht. Was er dafür verlangt, werdet ihr noch herausfinden.',
    scene:'colony'
  }
];
let introIndex = 0, introRaf = null, introTypeStart = 0;

function drawIntroScene(g, W, H, kind, t){
  g.clearRect(0,0,W,H);
  const horizon = H*0.62;
  // Himmel: Morgendämmerung
  const sky = g.createLinearGradient(0,0,0,horizon);
  if(kind==='sea'){ sky.addColorStop(0,'#1b2a3d'); sky.addColorStop(0.6,'#39506a'); sky.addColorStop(1,'#7d7a86'); }
  else if(kind==='ruins'){ sky.addColorStop(0,'#2a3348'); sky.addColorStop(0.7,'#5c5f74'); sky.addColorStop(1,'#9a8f8a'); }
  else { sky.addColorStop(0,'#243a52'); sky.addColorStop(0.5,'#6b6f7e'); sky.addColorStop(1,'#d8a878'); }
  g.fillStyle=sky; g.fillRect(0,0,W,horizon);
  // Sonne knapp über dem Horizont
  const sunX = W*0.72, sunY = horizon-28;
  const sg = g.createRadialGradient(sunX,sunY,3,sunX,sunY,70);
  sg.addColorStop(0,'rgba(255,226,160,.85)'); sg.addColorStop(1,'rgba(255,190,120,0)');
  g.fillStyle=sg; g.beginPath(); g.arc(sunX,sunY,70,0,Math.PI*2); g.fill();
  g.fillStyle='#f4d79a'; g.beginPath(); g.arc(sunX,sunY,13,0,Math.PI*2); g.fill();
  // Wolkenbänder
  for(let i=0;i<4;i++){
    const cy2 = H*0.12 + i*H*0.07, cw = W*(0.3+i*0.12), cx2 = (i%2? W*0.15 : W*0.5);
    g.fillStyle='rgba(255,255,255,'+(0.05+i*0.015)+')';
    g.beginPath(); g.ellipse(cx2+Math.sin(t/3000+i)*12, cy2, cw*0.5, 9, 0, 0, Math.PI*2); g.fill();
  }
  const drawSea = (topY)=>{
    const sea = g.createLinearGradient(0,topY,0,H);
    sea.addColorStop(0,'#2d5b66'); sea.addColorStop(1,'#173a44');
    g.fillStyle=sea; g.fillRect(0,topY,W,H-topY);
    g.strokeStyle='rgba(255,255,255,.13)'; g.lineWidth=1.4;
    for(let r=0;r<9;r++){
      const wy = topY + 12 + r*((H-topY)/9);
      g.beginPath();
      for(let x=0;x<=W;x+=8){
        const yy = wy + Math.sin(t/700 + x*0.02 + r)*(2+r*0.35);
        if(x===0) g.moveTo(x,yy); else g.lineTo(x,yy);
      }
      g.stroke();
    }
    // Sonnenpfad auf dem Wasser
    g.save(); g.globalAlpha=0.22;
    const path = g.createLinearGradient(sunX,topY,sunX,H);
    path.addColorStop(0,'rgba(255,214,150,.9)'); path.addColorStop(1,'rgba(255,214,150,0)');
    g.fillStyle=path; g.fillRect(sunX-34,topY,68,H-topY); g.restore();
  };
  const drawBoat = (bx,by,s,tilt)=>{
    g.save(); g.translate(bx,by); g.rotate(tilt);
    g.fillStyle='#5a3f26';
    g.beginPath(); g.moveTo(-26*s,0); g.quadraticCurveTo(0,16*s,26*s,0);
    g.lineTo(20*s,-6*s); g.lineTo(-20*s,-6*s); g.closePath(); g.fill();
    g.strokeStyle='#3a2814'; g.lineWidth=1.4*s; g.stroke();
    g.strokeStyle='#6b4a2b'; g.lineWidth=2*s;
    g.beginPath(); g.moveTo(0,-6*s); g.lineTo(0,-40*s); g.stroke();
    g.fillStyle='rgba(232,226,200,.92)';
    g.beginPath(); g.moveTo(1*s,-38*s); g.quadraticCurveTo(20*s,-24*s,2*s,-8*s); g.closePath(); g.fill();
    g.strokeStyle='rgba(120,100,70,.7)'; g.lineWidth=1*s; g.stroke();
    g.restore();
  };
  const drawTreeline = (baseY, col, count, scale)=>{
    for(let i=0;i<count;i++){
      const px = (i+0.5)/count*W + Math.sin(i*3.7)*10;
      const s = scale*(0.8+((i*37)%5)/5*0.5);
      g.fillStyle=col;
      g.fillRect(px-1.5*s, baseY-14*s, 3*s, 14*s);
      g.beginPath();
      if(i%3===0){ g.moveTo(px,baseY-40*s); g.lineTo(px-11*s,baseY-11*s); g.lineTo(px+11*s,baseY-11*s); g.closePath(); }
      else g.arc(px,baseY-24*s,13*s,0,Math.PI*2);
      g.fill();
    }
  };
  if(kind==='sea'){
    drawSea(horizon);
    drawBoat(W*0.34, horizon+58+Math.sin(t/900)*5, 1.5, Math.sin(t/1100)*0.05);
  }
  else if(kind==='coast'){
    drawSea(horizon);
    g.fillStyle='rgba(22,40,34,.9)';
    g.beginPath(); g.moveTo(0,horizon+4);
    g.quadraticCurveTo(W*0.4,horizon-14,W,horizon+2); g.lineTo(W,horizon+22); g.lineTo(0,horizon+26); g.closePath(); g.fill();
    drawTreeline(horizon+16,'rgba(20,38,28,.95)',26,0.7);
    drawBoat(W*0.3, horizon+72+Math.sin(t/900)*4, 1.2, Math.sin(t/1100)*0.04);
  }
  else if(kind==='landing'){
    // Strand im Vordergrund
    const sand = g.createLinearGradient(0,horizon,0,H);
    sand.addColorStop(0,'#c9b184'); sand.addColorStop(1,'#8f7a54');
    drawSea(horizon-30);
    g.fillStyle=sand;
    g.beginPath(); g.moveTo(0,horizon+18);
    g.quadraticCurveTo(W*0.5,horizon-6,W,horizon+14); g.lineTo(W,H); g.lineTo(0,H); g.closePath(); g.fill();
    // gestrandetes Boot
    drawBoat(W*0.33, horizon+62, 1.5, -0.12);
    // Kisten am Strand
    [[0.52,0.80],[0.58,0.86],[0.47,0.90]].forEach(([fx,fy],i)=>{
      const bx=W*fx, by=H*fy, s=13+i*2;
      g.fillStyle='#8a6038'; g.fillRect(bx-s/2,by-s/2,s,s);
      g.strokeStyle='#4a3018'; g.lineWidth=1.4; g.strokeRect(bx-s/2,by-s/2,s,s);
      g.fillStyle='#6b4a2b'; g.fillRect(bx-s/2,by-2,s,3);
    });
  }
  else if(kind==='ruins'){
    g.fillStyle='#4d5a44'; g.fillRect(0,horizon,W,H-horizon);
    drawTreeline(horizon+6,'rgba(24,44,32,.92)',20,0.9);
    // zerborstene Säulen
    [[0.28,1],[0.38,0.72],[0.5,1.15],[0.62,0.6],[0.72,0.95]].forEach(([fx,hs])=>{
      const px=W*fx, ph=90*hs, py=horizon+18;
      const cg = g.createLinearGradient(px-9,0,px+9,0);
      cg.addColorStop(0,'#8d8677'); cg.addColorStop(0.5,'#b3ab99'); cg.addColorStop(1,'#6f6959');
      g.fillStyle=cg; g.fillRect(px-9,py-ph,18,ph);
      g.strokeStyle='#4f4a3d'; g.lineWidth=1.2; g.strokeRect(px-9,py-ph,18,ph);
      // gebrochene Oberkante
      g.fillStyle='#4d5a44';
      g.beginPath(); g.moveTo(px-9,py-ph); g.lineTo(px-3,py-ph+7); g.lineTo(px+4,py-ph-3); g.lineTo(px+9,py-ph+4); g.lineTo(px+9,py-ph-8); g.lineTo(px-9,py-ph-8); g.closePath(); g.fill();
      g.fillStyle='rgba(90,130,70,.5)';
      g.fillRect(px-9,py-ph*0.35,18,4);
    });
    g.fillStyle='rgba(0,0,0,.2)'; g.fillRect(0,horizon,W,3);
  }
  else if(kind==='colony'){
    const grass = g.createLinearGradient(0,horizon,0,H);
    grass.addColorStop(0,'#4f7a44'); grass.addColorStop(1,'#2f5230');
    g.fillStyle=grass; g.fillRect(0,horizon,W,H-horizon);
    drawTreeline(horizon+4,'rgba(26,50,34,.9)',22,0.85);
    // Lagerfeuer mit Figuren
    const fx2=W*0.5, fy2=H*0.86;
    const fl = 0.6+Math.sin(t/180)*0.4;
    g.fillStyle='rgba(0,0,0,.3)'; g.beginPath(); g.ellipse(fx2,fy2+6,42,10,0,0,Math.PI*2); g.fill();
    for(let i=0;i<7;i++){ const a=i/7*Math.PI*2;
      g.fillStyle='#6f6a5c'; g.beginPath(); g.arc(fx2+Math.cos(a)*20,fy2+Math.sin(a)*7,4.5,0,Math.PI*2); g.fill(); }
    g.fillStyle='#6b4a2b';
    g.fillRect(fx2-14,fy2-4,28,4); g.save(); g.translate(fx2,fy2-2); g.rotate(0.5); g.fillRect(-14,-2,28,4); g.restore();
    const flame = g.createRadialGradient(fx2,fy2-14,2,fx2,fy2-10,26);
    flame.addColorStop(0,'rgba(255,238,170,'+(0.95*fl)+')');
    flame.addColorStop(0.5,'rgba(240,150,50,'+(0.7*fl)+')');
    flame.addColorStop(1,'rgba(200,80,30,0)');
    g.fillStyle=flame; g.beginPath(); g.arc(fx2,fy2-12,26,0,Math.PI*2); g.fill();
    g.fillStyle='rgba(255,220,140,'+(0.9*fl)+')';
    g.beginPath(); g.moveTo(fx2-6,fy2-4); g.quadraticCurveTo(fx2,fy2-30,fx2+6,fy2-4); g.closePath(); g.fill();
    // Silhouetten am Feuer
    [[-58,0.95],[-34,0.85],[38,0.9],[62,0.8]].forEach(([ox,s])=>{
      g.fillStyle='rgba(18,24,20,.88)';
      g.beginPath(); g.ellipse(fx2+ox, fy2-16*s, 7*s, 10*s, 0, 0, Math.PI*2); g.fill();
      g.beginPath(); g.arc(fx2+ox, fy2-30*s, 5.5*s, 0, Math.PI*2); g.fill();
    });
  }
  // Vignette
  const vg = g.createRadialGradient(W/2,H/2,H*0.3,W/2,H/2,H*0.95);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,.55)');
  g.fillStyle=vg; g.fillRect(0,0,W,H);
}

function renderIntroScene(){
  const sc = INTRO_SCENES[introIndex];
  document.getElementById('introChapter').textContent = sc.chapter;
  const textEl = document.getElementById('introText');
  document.getElementById('introNext').textContent =
    (introIndex === INTRO_SCENES.length-1) ? '⚑ Farholt betreten' : 'Weiter ▶';
  // Punkte-Anzeige
  const dots = document.getElementById('introDots'); dots.innerHTML='';
  INTRO_SCENES.forEach((_,i)=>{
    const d=document.createElement('span'); d.className='introDot'+(i===introIndex?' active':'');
    dots.appendChild(d);
  });
  introTypeStart = performance.now();
  const cv = document.getElementById('introCanvas');
  const g = cv.getContext('2d');
  const step = ()=>{
    const overlay = document.getElementById('introOverlay');
    if(overlay.classList.contains('hidden')){ introRaf=null; return; }
    const now = performance.now();
    drawIntroScene(g, cv.width, cv.height, sc.scene, now);
    // Text erscheint schreibmaschinenartig
    const chars = Math.floor((now-introTypeStart)/14);
    textEl.textContent = sc.text.slice(0, chars);
    introRaf = requestAnimationFrame(step);
  };
  if(introRaf) cancelAnimationFrame(introRaf);
  introRaf = requestAnimationFrame(step);
}

function startIntro(){
  introIndex = 0;
  openOverlay('introOverlay');
  renderIntroScene();
}
function finishIntro(){
  if(introRaf){ cancelAnimationFrame(introRaf); introRaf=null; }
  closeOverlay('introOverlay');
  logEvent('⚑ Ihr habt an der Küste von Farholt angelegt. Die Kolonie beginnt.');
  showWelcomeStep1();
}

/* ---------- Mehrseitige Dialoge ----------
   Lange Texte wurden bisher als ein Block ausgegeben und liefen im Fenster
   über. Jetzt werden sie in Seiten zerlegt: an Absätzen, und zu lange
   Absätze zusätzlich an Satzenden. Die Auswahlknöpfe erscheinen erst auf
   der letzten Seite — davor blättert ein „Weiter"-Knopf, wie in klassischen
   RPGs. Kurze Texte bleiben unverändert einseitig. */
const DIALOG_ZEICHEN_PRO_SEITE = 320;

function dialogSeiten(text){
  const absaetze = String(text).split(/\n\s*\n/).map(a=>a.trim()).filter(Boolean);
  const seiten = [];
  absaetze.forEach(abs=>{
    if(abs.length <= DIALOG_ZEICHEN_PRO_SEITE){ seiten.push(abs); return; }
    // zu lang: an Satzenden aufteilen, ohne Sätze zu zerschneiden
    const saetze = abs.match(/[^.!?…]+[.!?…]*\s*/g) || [abs];
    let puffer = '';
    saetze.forEach(satz=>{
      if((puffer + satz).length > DIALOG_ZEICHEN_PRO_SEITE && puffer){
        seiten.push(puffer.trim()); puffer = satz;
      } else puffer += satz;
    });
    if(puffer.trim()) seiten.push(puffer.trim());
  });
  return seiten.length ? seiten : [''];
}

function showStoryDialog(title, desc, choices){
  const seiten = dialogSeiten(desc);
  zeigeDialogSeite(title, seiten, 0, choices);
}

function zeigeDialogSeite(title, seiten, idx, choices){
  const letzte = idx >= seiten.length - 1;
  const anzeige = seiten[idx] + (letzte ? '' : '\n\n▾');
  const knoepfe = letzte
    ? choices
    : [{ label:`Weiter ▸  (${idx+1}/${seiten.length})`,
         action: ()=> zeigeDialogSeite(title, seiten, idx+1, choices) }];
  renderStoryDialog(title, anzeige, knoepfe);
}

function renderStoryDialog(title, desc, choices){
  openOverlay('storyOverlay');
  sfxEvent();
  document.getElementById('storyTitle').textContent = title;
  document.getElementById('storyDesc').textContent = desc;
  const wrap = document.getElementById('storyChoices'); wrap.innerHTML='';
  choices.forEach(c=>{
    const btn = document.createElement('button');
    btn.textContent = c.label;
    if(c.secondary) btn.className='secondary';
    if(c.disabled) btn.disabled = true;
    btn.onclick = ()=>{ if(c.disabled) return; closeStoryDialog(); c.action(); };
    wrap.appendChild(btn);
  });
  document.getElementById('storyOverlay').classList.remove('hidden');
}
function closeStoryDialog(){ closeOverlay('storyOverlay'); }

function startRaid(){
  if(state.raid) return;
  sfxRaid();
  showStoryDialog('⚠️ Wilde Kreaturen nähern sich!',
    'Eine Gruppe wilder Kreaturen bewegt sich auf die Kolonie zu. Wie reagiert ihr?',
    [
      { label:'⚔ Zur Verteidigung rüsten', action: beginRaidFight },
      { label:'📦 Vorräte in Sicherheit bringen (kein Kampf, kleiner garantierter Verlust)', secondary:true, action: evacuateSupplies }
    ]
  );
}
function beginRaidFight(){
  const n = (isNightNow() ? 3 : 2) + Math.floor(Math.random()*2);
  const center = state.colonyCenter || {x:Math.floor(WORLD_W/2), y:Math.floor(WORLD_H/2)};
  for(let i=0;i<n;i++){
    for(let tries=0;tries<25;tries++){
      const ang = Math.random()*Math.PI*2, rad = 3+Math.random()*4;
      const x = clamp(Math.round(center.x+Math.cos(ang)*rad),0,WORLD_W-1);
      const y = clamp(Math.round(center.y+Math.sin(ang)*rad),0,WORLD_H-1);
      if(passable(x,y,homeCtx)){ const sp = weightedSpecies('wildwood'); homeCtx.wildMonsters.push({ uid:newUid(), speciesId:sp.id, x, y, lastMove:0, hostile:true, raid:true, hp:sp.stats.hp, maxHp:sp.stats.hp }); break; }
    }
  }
  const towerBonus = state.buildings.some(b=>b.type==='tower' && b.built) ? (hasTech('festungsbau') ? 38000 : (hasTech('belagerungsbau') ? 25000 : 15000)) : 0;
  state.raid = { until: Date.now()+50000+towerBonus };
  logEvent('⚠️ Wilde Kreaturen greifen die Kolonie an!');
  toast(atHome() ? '⚠️ Überfall! Verteidige die Kolonie!' : '⚠️ Deine Kolonie wird überfallen, während du unterwegs bist!');
  updateColonyIfOpen(); saveGame();
}
function evacuateSupplies(){
  const lossPct = 0.10;
  ['wood','stone','berries','ore','fiber','planks','metal','cloth'].forEach(k=>{
    state.inventory[k] = Math.max(0, Math.round(state.inventory[k]*(1-lossPct)));
  });
  logEvent('📦 Die Kolonie hat rechtzeitig Vorräte in Sicherheit gebracht (kleiner Verlust, kein Kampf nötig).');
  toast('📦 Vorräte evakuiert – kein Kampf, aber kleiner Verlust.');
  updateHUD(); updateColonyIfOpen(); saveGame();
}
/* Verteidigungswert je Wandart, als Vielfaches des Grundbonus.
   Vorher stand diese Staffelung als lange Kette einzelner Zählungen hier —
   mit jeder neuen Wandart wuchs sie weiter. Als Tabelle ist auf einen Blick
   erkennbar, wie die Stufen zueinander stehen. */
/* Haltbarkeit je Wandart. Bisher hatten Wände nur einen Verteidigungswert,
   der die Plünderquote senkte — kaputtgehen konnte nichts, und Holz war
   damit außer im Preis nicht von Titan zu unterscheiden.

   Jetzt hält jede Wand eine feste Zahl Treffer aus. Bei jedem Überfall
   nehmen die Wände Schaden; sinkt die Haltbarkeit auf null, bricht das
   Stück und verschwindet. Holz ist billig und schnell weg, Stein hält,
   Metall hält lange. */
const WALL_MAX_HP = {
  zaun: 12,
  wall: 40,
  holzwand1: 18,  holzwand2: 26,  holzwand3: 34,
  fensterwand1: 22, fensterwand2: 34, fensterwand3: 44,
  metallwand1: 55,  metallwand2: 72,  metallwand3: 95,
  copperwall: 50, silverwall: 62, goldwall: 78, titanwall: 110,
  door: 30, tower: 80,
};

function wallMaxHp(type){ return WALL_MAX_HP[type] || 0; }
function isWallType(type){ return !!WALL_MAX_HP[type]; }

/* Wand beschädigen. Gibt zurück, ob sie dabei zerstört wurde. */
function damageWall(b, menge){
  if(!isWallType(b.type)) return false;
  if(b.hp == null) b.hp = wallMaxHp(b.type);
  b.hp -= menge;
  if(b.hp > 0) return false;
  const idx = state.buildings.indexOf(b);
  if(idx >= 0) state.buildings.splice(idx, 1);
  return true;
}

/* Beim Überfall knabbern die Angreifer an den Wänden. Getroffen werden
   bevorzugt schwache Stücke — so bricht die Holzseite zuerst, was dem
   Spieler zeigt, wo nachgebessert werden muss. */
function angreiferBeschaedigenWaende(staerke){
  const reg = 'C';
  const waende = state.buildings.filter(b=>
    b.built && (b.regionId||'C')===reg && isWallType(b.type));
  if(!waende.length) return { getroffen:0, zerstoert:0 };
  waende.forEach(b=>{ if(b.hp == null) b.hp = wallMaxHp(b.type); });
  // schwächste zuerst
  waende.sort((a,b)=> (a.hp/wallMaxHp(a.type)) - (b.hp/wallMaxHp(b.type)));
  const anzahl = Math.min(waende.length, Math.max(1, Math.round(staerke)));
  let zerstoert = 0;
  for(let i=0;i<anzahl;i++){
    const schaden = 6 + Math.floor(Math.random()*10);
    if(damageWall(waende[i], schaden)) zerstoert++;
  }
  return { getroffen: anzahl, zerstoert };
}

const WALL_DEFENSE_FACTOR = {
  zaun: 0.4,
  wall: 1.0,
  holzwand1: 0.6,  holzwand2: 0.9,  holzwand3: 1.2,
  fensterwand1: 0.7, fensterwand2: 1.1, fensterwand3: 1.5,
  metallwand1: 1.8,  metallwand2: 2.6,  metallwand3: 3.4,
  copperwall: 1.6, silverwall: 2.2, goldwall: 3.0, titanwall: 4.0,
  spitzenfalle: 1.2, ballista: 2.5,
};

function applyRaidLoss(){
  const homeB = state.buildings.filter(b=>(b.regionId||'C')==='C' && b.built);
  const guardhouseCount = homeB.filter(b=>b.type==='wachhaus').length;
  const wallDefBonus = hasTech('festungsbau') ? 0.06 : (hasTech('belagerungsbau') ? 0.045 : 0.03);
  const guardBonus = defenseBonus();
  const wallDefense = homeB.reduce((summe, b)=>
    summe + wallDefBonus * (WALL_DEFENSE_FACTOR[b.type] || 0), 0);
  const lossPct = clamp(0.22 - wallDefense - guardhouseCount*0.05 - guardBonus, 0.05, 0.22);
  ['wood','stone','berries','ore','fiber','planks','metal','cloth'].forEach(k=>{
    state.inventory[k] = Math.max(0, Math.round(state.inventory[k]*(1-lossPct)));
  });
  /* Die Wände nehmen Schaden — je größer der Überfall, desto mehr Stücke. */
  const schaden = angreiferBeschaedigenWaende(2 + (state.raid ? state.raid.size||2 : 2));
  if(schaden.zerstoert){
    logEvent(`🧱 ${schaden.zerstoert} Wandstück${schaden.zerstoert===1?'':'e'} wurde${schaden.zerstoert===1?'':'n'} zerschlagen.`);
  }
  homeCtx.wildMonsters = homeCtx.wildMonsters.filter(w=>!w.raid);
  if(atHome()) wildMonsters = homeCtx.wildMonsters;
  state.raid = null;
  logEvent('💢 Die Kolonie wurde überfallen! Vorräte wurden geplündert.'); toast('💢 Überfall! Vorräte geplündert.');
  updateHUD(); updateColonyIfOpen(); saveGame();
}
function traderEvent(){
  const options = [
    {cost:{wood:6}, gain:{metal:2}, label:'6 🪵 Holz → 2 ⚙️ Metall'},
    {cost:{stone:6}, gain:{cloth:2}, label:'6 🪨 Stein → 2 🧵 Stoff'},
    {cost:{berries:8}, gain:{ore:2}, label:'8 🫐 Beeren → 2 ⛏️ Erz'}
  ];
  const choices = options.map(opt=>{
    const key = Object.keys(opt.cost)[0], gainKey = Object.keys(opt.gain)[0];
    const affordable = state.inventory[key] >= opt.cost[key];
    return { label: opt.label, disabled: !affordable, action: ()=>{
      state.inventory[key]-=opt.cost[key];
      addResource(gainKey, opt.gain[gainKey]);
      bumpResource(key); bumpResource(gainKey);
      logEvent(`🛒 Handel mit der Karawane: -${opt.cost[key]} ${RESOURCE_NAMES[key]}, +${opt.gain[gainKey]} ${RESOURCE_NAMES[gainKey]}.`);
      toast('🛒 Handel abgeschlossen!');
      updateHUD(); updateColonyIfOpen(); saveGame();
    }};
  });
  choices.push({ label:'🚫 Kein Interesse', secondary:true, action: ()=>{
    logEvent('🛒 Eine Karawane zog vorbei, ohne dass gehandelt wurde.'); updateColonyIfOpen();
  }});
  showStoryDialog('🛒 Eine Handelskarawane hält an', 'Fahrende Händler bieten dir einen Tausch an. Worauf hast du Lust?', choices);
}
function sicknessEvent(){
  if(state.colonists.length===0) return;
  const c = state.colonists[Math.floor(Math.random()*state.colonists.length)];
  showStoryDialog('🤒 '+c.name+' fühlt sich krank',
    c.name+' klagt über Fieber und Schwäche. Wie reagiert ihr?',
    [
      { label:'🌿 Mit Kräutern behandeln (2 🌾 Faser, schnellere Genesung)', disabled: state.inventory.fiber<2, action: ()=>{
          state.inventory.fiber-=2;
          const infMult = state.buildings.some(b=>b.type==='krankenstube' && b.built) ? 0.7 : 1;
          c.sickUntil = Date.now()+Math.round(15000*(hasTech('kraeutermedizin')?0.6:1)*infMult);
          logEvent(`🌿 ${c.name} wurde mit Kräutern behandelt und erholt sich schnell.`);
          toast(c.name+' erholt sich bald wieder.');
          updateColonyIfOpen(); saveGame();
      }},
      { label:'🛏️ Ausruhen lassen (kostenlos, dauert länger)', secondary:true, action: ()=>{
          const infMult = state.buildings.some(b=>b.type==='krankenstube' && b.built) ? 0.7 : 1;
          c.sickUntil = Date.now()+Math.round(45000*(hasTech('kraeutermedizin')?0.6:1)*infMult);
          logEvent(`🤒 ${c.name} ruht sich aus und arbeitet vorübergehend langsamer.`);
          toast(c.name+' ruht sich aus.');
          updateColonyIfOpen(); saveGame();
      }}
    ]
  );
}
function bountyEvent(){
  const finds = [
    {key:'wood', safe:5, risky:10, icon:'🌲', label:'Treibholz'},
    {key:'stone', safe:4, risky:8, icon:'⛰️', label:'Gestein'},
    {key:'berries', safe:5, risky:9, icon:'🍇', label:'Beeren'}
  ];
  const f = finds[Math.floor(Math.random()*finds.length)];
  showStoryDialog(f.icon+' Ein Vorratsfund',
    'Du entdeckst ein verstecktes Lager mit '+f.label+'. Es wirkt leicht instabil.',
    [
      { label:'🐢 Vorsichtig bergen (+'+f.safe+' garantiert)', action: ()=>{
          state.inventory[f.key]+=f.safe; bumpResource(f.key);
          logEvent('📦 Vorsichtig geborgen: +'+f.safe+' '+RESOURCE_NAMES[f.key]+'.');
          updateHUD(); updateColonyIfOpen(); saveGame();
      }},
      { label:'⚡ Schnell einsammeln (mehr Beute, aber riskant)', secondary:true, action: ()=>{
          if(Math.random()<0.7){
            state.inventory[f.key]+=f.risky; bumpResource(f.key);
            logEvent('📦 Schnell geborgen: +'+f.risky+' '+RESOURCE_NAMES[f.key]+'!');
            toast('Geschafft! Extra Beute.');
          } else {
            damagePlayer(8, '💥 Beim hastigen Bergen löst sich eine Falle. -8 Leben.');
            toast('Autsch! Eine Falle hat ausgelöst.');
          }
          updateHUD(); updateColonyIfOpen(); saveGame();
      }}
    ]
  );
}
const VISITOR_LINES = [
  '„Schöne Kolonie habt ihr hier aufgebaut", sagt der Besucher und schaut sich um.',
  '„Ich bin nur auf der Durchreise, wollte aber kurz Hallo sagen."',
  '„Man hört Geschichten über Farholt bis weit über die Grenzen hinaus."',
  '„Die Wälder hier sind gefährlicher, als sie aussehen. Seid vorsichtig."',
  '„Ich habe selbst mal überlegt, mich niederzulassen. Vielleicht eines Tages."',
  '„Habt ihr auch schon von den Ruinen im Osten gehört?"'
];
/* ============================================================
   NPCs mit eigenem Text und Aufträgen

   Bisher gab es genau eine Sorte NPC ohne eigenen Text, und
   questNpcEvent() stürzte bei jedem Aufruf ab (canBuildAt(x,y,type) —
   die Variable type existierte dort nie), es ist also nie einer
   erschienen.

   NPC_TYPES ist die Tabelle, über die neue Figuren dazukommen: Name,
   Symbol, Begrüßung, mehrere Gesprächszeilen und ob es einen Auftrag
   gibt. Wer hier einträgt, kann sofort platziert werden — an Rendering
   oder Interaktion muss nichts angefasst werden.
   ============================================================ */
const NPC_TYPES = {
  wanderer: {
    label: 'Wanderer',
    icon: '❗',
    farbe: '#ffd23f',
    dauer: 300000,                     // verschwindet nach 5 Minuten
    begruessung: (n)=> `${n} lehnt am Wegrand und mustert dich.`,
    zeilen: [
      'Weit gelaufen bin ich, und weit habe ich noch vor mir.',
      'Wenn du mir zur Hand gehst, teile ich, was ich entbehren kann.',
    ],
    auftrag: true,
  },
  kraeuterfrau: {
    label: 'Kräuterfrau',
    icon: '🌿',
    farbe: '#8fd08a',
    dauer: 420000,
    begruessung: (n)=> `${n} sortiert Bündel getrockneter Kräuter.`,
    zeilen: [
      'Der Wald gibt reichlich, wenn man weiß, wohin man schaut.',
      'Bring mir, wonach ich frage, und ich zeige dir, was hier wächst.',
    ],
    auftrag: true,
    geschenk: { key:'herbs', min:2, max:5 },
  },
  haendler: {
    label: 'Fahrender Händler',
    icon: '💰',
    farbe: '#e8a94d',
    dauer: 360000,
    begruessung: (n)=> `${n} stellt seinen Packen ab und grinst.`,
    zeilen: [
      'Zwischen zwei Dörfern lässt sich gut Geschäft machen.',
      'Kein Auftrag heute? Dann nimm wenigstens eine Kleinigkeit mit.',
    ],
    auftrag: true,
    geschenk: { key:'gold', min:3, max:8 },
  },
  bote: {
    label: 'Alter Bote',
    icon: '📜',
    farbe: '#e8c96d',
    dauer: 0,                          // wartet dauerhaft an seinem Platz
    fest: true,                        // wandert nicht, verschwindet nicht
    begruessung: (n)=> `${n} stützt sich auf einen abgewetzten Wanderstab und mustert dich lange.`,
    zeilen: [
      'Ich bin die Straßen abgelaufen, seit deine Boote noch Bäume waren.',
      'Hier draußen zählt nicht, was du mitgebracht hast, sondern was du errichtest.',
    ],
    auftrag: false,
    hauptquest: true,                  // erzählt die Hauptquest statt eines Nebenauftrags
  },
  chronist: {
    label: 'Chronist',
    icon: '📖',
    farbe: '#b8c8e8',
    dauer: 0,                          // bleibt dauerhaft stehen
    begruessung: (n)=> `${n} notiert etwas und blickt kurz auf.`,
    zeilen: [
      'Farholt hat mehr Geschichte, als die Karten verraten.',
      'Erzähl mir, was du siehst — ich schreibe es auf.',
    ],
    auftrag: false,
  },
};

/* Setzt einen NPC auf ein freies Feld in der Nähe der angegebenen Stelle.
   Ohne Koordinaten wird die Kartenmitte genommen. Gibt die Position
   zurück oder null, wenn kein Platz gefunden wurde. */
function spawnNpc(typId, x, y, radius){
  const def = NPC_TYPES[typId];
  if(!def){ console.warn('[npc] Unbekannter Typ:', typId); return null; }
  const mx = (x != null) ? x : Math.floor(WORLD_W/2);
  const my = (y != null) ? y : Math.floor(WORLD_H/2);
  const r = radius || 14;
  for(let versuch=0; versuch<60; versuch++){
    const px = clamp(mx + Math.floor((Math.random()*2-1)*r), 1, WORLD_W-2);
    const py = clamp(my + Math.floor((Math.random()*2-1)*r), 1, WORLD_H-2);
    // freies, begehbares Feld ohne Objekt und ohne Gebäude
    if(objects.has(px+','+py)) continue;
    if(!passable(px, py)) continue;
    if(state.buildings.some(b=>b.x===px && b.y===py && (b.regionId||'C')===state.player.regionId)) continue;
    const name = NAME_POOL[Math.floor(Math.random()*NAME_POOL.length)];
    objects.set(px+','+py, {
      type: 'quest_npc',
      npcTyp: typId,
      hp: 1, maxHp: 1,
      name,
      appearance: randomAppearance(),
      zeile: 0,
      expiresAt: def.dauer ? Date.now()+def.dauer : 0,
    });
    return { x: px, y: py, name };
  }
  return null;
}

/* Setzt den Boten einmalig in Sichtweite der Basis. Wird beim ersten Start
   gerufen; ein Merker im Spielstand verhindert Doppelgänger beim Laden. */
function spawnStartBote(){
  if(state.quests.boteGesetzt) return null;
  const px = state.colonyCenter ? state.colonyCenter.x : state.player.x;
  const py = state.colonyCenter ? state.colonyCenter.y : state.player.y;
  const pos = spawnNpc('bote', px, py, 5);
  if(!pos) return null;
  state.quests.boteGesetzt = true;
  logEvent(`📜 ${pos.name}, ein alter Bote, wartet in der Nähe. Geh zu ihm und drücke E.`);
  toast('📜 Ein alter Bote wartet in der Nähe — sprich mit ihm.');
  return pos;
}

function questNpcEvent(){
  // Zufällig eine der zeitlich begrenzten Sorten
  const auswahl = Object.keys(NPC_TYPES).filter(k=>NPC_TYPES[k].dauer > 0);
  const typId = auswahl[Math.floor(Math.random()*auswahl.length)];
  const pos = spawnNpc(typId);
  if(!pos) return;
  const def = NPC_TYPES[typId];
  toast(`${def.icon} ${pos.name} (${def.label}) möchte mit dir sprechen.`);
  logEvent(`${def.icon} ${pos.name} — ${def.label} — wartet in der Nähe.`);
}

/* Gespräch: geht die Zeilen des NPC nacheinander durch und bietet am Ende
   den Auftrag an. Der NPC verschwindet erst, wenn das Gespräch zu Ende
   ist — vorher wurde er sofort beim ersten Klick gelöscht. */
function talkToQuestNpc(x, y, o){
  const def = NPC_TYPES[o.npcTyp] || NPC_TYPES.wanderer;
  const titel = `${def.icon} ${o.name} — ${def.label}`;

  if(o.zeile == null) o.zeile = 0;

  // Erste Zeile: Begrüßung
  if(o.zeile === 0){
    o.zeile = 1;
    showStoryDialog(titel, def.begruessung(o.name),
      [{ label: 'Weiter →', action: ()=> talkToQuestNpc(x, y, o) }]);
    return;
  }
  // Mittlere Zeilen
  if(o.zeile <= def.zeilen.length){
    const text = def.zeilen[o.zeile - 1];
    o.zeile++;
    showStoryDialog(titel, text,
      [{ label: 'Weiter →', action: ()=> talkToQuestNpc(x, y, o) }]);
    return;
  }

  /* Der Bote ist fest: er bleibt stehen und erzählt bei jedem Gespräch die
     aktuelle Stufe der Hauptquest. Normale NPCs verschwinden danach. */
  if(def.hauptquest){
    o.zeile = 0;                       // beim nächsten Mal wieder von vorn
    const stufe = MAIN_QUEST_STAGES[state.quests.mainStage];
    if(state.quests.mainCompleted || !stufe){
      showStoryDialog(titel,
        `${o.name} nickt langsam. „Du hast alles getan, was ich dir auftragen konnte. Der Rest ist deine Geschichte."`,
        [{ label: 'Leb wohl.', action: ()=>{} }]);
      return;
    }
    const erfuellt = stufe.check();
    if(erfuellt){
      // Belohnung wird von checkMainQuestProgress vergeben — hier nur der Text
      showStoryDialog(titel,
        `„${stufe.title}" — ${o.name} lächelt zum ersten Mal. „Das hast du geschafft. Sieh in deinem Questbuch nach, was als Nächstes ansteht."`,
        [{ label: 'Weiter so!', action: ()=>{ checkMainQuestProgress(); } }]);
    } else {
      showStoryDialog(titel,
        `„${stufe.title}"\n\n${stufe.desc}`,
        [{ label: 'Ich kümmere mich darum.', action: ()=>{} }]);
    }
    return;
  }

  // Abschluss: Auftrag oder Geschenk
  objects.delete(x+','+y);
  if(def.auftrag && (state.quests.side||[]).length < 3){
    generateSideQuest();
    showStoryDialog(titel,
      `${o.name} hat einen Auftrag für dich — die Einzelheiten stehen im ☰ Menü unter „📖 Quests".`,
      [{ label: 'Wird gemacht!', action: ()=>{} }]);
    return;
  }
  const g = def.geschenk || { key:'wood', min:3, max:6 };
  const menge = g.min + Math.floor(Math.random()*(g.max - g.min + 1));
  state.inventory[g.key] = (state.inventory[g.key]||0) + menge;
  bumpResource(g.key);
  const auftragVoll = def.auftrag ? `${o.name} hat gerade keinen freien Auftrag, ` : `${o.name} hat keine Aufgabe für dich, `;
  showStoryDialog(titel,
    `${auftragVoll}drückt dir aber ${menge} ${RESOURCE_ICONS[g.key]||''} ${RESOURCE_NAMES[g.key]||g.key} in die Hand.`,
    [{ label: 'Danke!', action: ()=>{} }]);
  updateHUD(); saveGame();
}
function visitorEvent(){
  const cx = state.colonyCenter ? state.colonyCenter.x : spawnX;
  const cy = state.colonyCenter ? state.colonyCenter.y : spawnY;
  for(let tries=0;tries<40;tries++){
    const x = clamp(cx + Math.floor((Math.random()*2-1)*9), 1, WORLD_W-2);
    const y = clamp(cy + Math.floor((Math.random()*2-1)*9), 1, WORLD_H-2);
    /* Hier stand canBuildAt(x, y, type) — die Variable type gibt es in
       dieser Funktion nicht, der Besucher ist deshalb nie erschienen.
       Gefragt ist ohnehin nur, ob das Feld frei und begehbar ist. */
    if(passable(x, y) && !objAt(x, y)){
      const name = NAME_POOL[Math.floor(Math.random()*NAME_POOL.length)];
      const appearance = randomAppearance();
      objects.set(x+','+y, {type:'visitor', hp:1, maxHp:1, name, appearance, expiresAt:Date.now()+240000});
      toast(`🚶 ${name} besucht die Kolonie.`);
      logEvent(`🚶 ${name} ist zu Besuch gekommen.`);
      return;
    }
  }
}
function talkToVisitor(x,y,o){
  const line = VISITOR_LINES[Math.floor(Math.random()*VISITOR_LINES.length)];
  const roll = Math.random();
  if(roll<0.28){
    const keys=['wood','stone','berries','fiber']; const k=keys[Math.floor(Math.random()*keys.length)];
    const amt = 1+Math.floor(Math.random()*3);
    addResource(k, amt); bumpResource(k);
    showStoryDialog('🚶 '+o.name, line+` Zum Abschied lässt ${o.name} dir ${amt} ${RESOURCE_ICONS[k]} ${RESOURCE_NAMES[k]} da.`, [{label:'Danke!', action:()=>{}}]);
  } else if(roll<0.5){
    const undiscovered = LORE_ORDER.filter(k=>!state.loreDiscovered.includes(k));
    if(undiscovered.length>0){
      const key = undiscovered[Math.floor(Math.random()*undiscovered.length)];
      state.loreDiscovered.push(key);
      showStoryDialog('🚶 '+o.name, line+` „Übrigens — ${LORE_ENTRIES[key].text}"`, [{label:'Interessant!', action:()=>{}}]);
    } else {
      showStoryDialog('🚶 '+o.name, line, [{label:'Auf Wiedersehen', action:()=>{}}]);
    }
  } else {
    showStoryDialog('🚶 '+o.name, line, [{label:'Auf Wiedersehen', action:()=>{}}]);
  }
  objects.delete(x+','+y);
  logEvent(`🚶 Mit ${o.name} gesprochen.`);
  saveGame();
}
function wandererEvent(){
  showStoryDialog('🚶 Ein Wanderer bittet um Aufnahme',
    'Eine erschöpfte Gestalt taucht am Rand der Kolonie auf und bittet um Aufnahme. Habt ihr Platz und Nahrung übrig?',
    [
      { label:'✅ Aufnehmen', action: ()=>{
          const c = recruitColonist();
          if(c){ sfxJoin(); logEvent(`🚶 ${c.name} schließt sich der Kolonie an!`); toast(`${c.name} ist jetzt Teil der Kolonie.`); }
          else { sfxError(); toast('Kein Platz mehr frei.'); }
          updateHUD(); updateColonyIfOpen(); saveGame();
      }},
      { label:'🚫 Wegschicken', secondary:true, action: ()=>{
          state.inventory.berries += 3; bumpResource('berries');
          logEvent('🚶 Ein Wanderer wurde weggeschickt und ließ zum Abschied ein paar Vorräte da.');
          toast('Der Wanderer zog weiter, ließ aber ein paar Beeren da.');
          updateHUD(); updateColonyIfOpen(); saveGame();
      }}
    ]
  );
}
function startWeather(type,durationMs){
  state.weather = {type, until: Date.now()+durationMs};
  const msg = type==='rain' ? '🌧️ Regen zieht auf.' : type==='storm' ? '⛈️ Ein Sturm zieht auf – die Arbeit verlangsamt sich.' : '❄️ Ein Kälteeinbruch setzt ein.';
  logEvent(msg); toast('Wetterwechsel!'); updateColonyIfOpen();
}
const STORY_EVENTS = [
  { id:'wanderer', weight:2, condition: ()=> housingCap() > state.colonists.length && state.stats.hunger>40, run: wandererEvent },
  { id:'visitor', weight:3, condition: ()=> atHome(), run: visitorEvent },
  { id:'quest_npc', weight:2, condition: ()=> !atDungeon(), run: questNpcEvent },
  { id:'bounty', weight:2, condition: null, run: bountyEvent },
  { id:'trader', weight:1, condition: null, run: traderEvent },
  { id:'sick', weight:2, condition: ()=> state.colonists.length>0, run: sicknessEvent },
  { id:'raid', weight:2, condition: ()=> !state.raid, run: startRaid },
  { id:'rain', weight:2, condition: ()=> state.weather.type==='clear', run: ()=>startWeather('rain',40000) },
  { id:'storm', weight:1, condition: ()=> state.weather.type==='clear', run: ()=>startWeather('storm',35000) },
  { id:'cold', weight:1, condition: ()=> state.weather.type==='clear', run: ()=>startWeather('cold',30000) }
];
function rollStoryEvent(){
  if(paused) return;
  const valid = STORY_EVENTS.filter(e=> !e.condition || e.condition());
  if(valid.length===0) return;
  const total = valid.reduce((a,e)=>a+e.weight,0);
  let r = Math.random()*total;
  for(const e of valid){ r-=e.weight; if(r<=0){ e.run(); saveGame(); return; } }
}

/* ============================================================
   Game over
============================================================ */
function checkGameOver(){
  if(state.stats.hp<=0){ setMode('overlay'); document.getElementById('gameOverOverlay').classList.remove('hidden'); }
}

/* ============================================================
   Start / character creation screen
============================================================ */
let pendingColonists = [];
// Erst beim Start würfeln — randomAppearance liegt in einem anderen
// Modul und ist beim Laden dieser Datei noch nicht verfügbar.
let playerAppearance = null;
function initPlayerAppearance(){
  if(!playerAppearance) playerAppearance = randomAppearance();
  return playerAppearance;
}
let playerAdvClass = null;
/* ============================================================
   Titelbildschirm: prozedural gezeichnete Küstenszene mit
   ziehenden Wolken, davor Titel und Menü.
============================================================ */
let titleRaf = null;
function drawTitleBg(){
  const cv = document.getElementById('titleBg'); if(!cv) return;
  const W = cv.width = cv.clientWidth || window.innerWidth;
  const H = cv.height = cv.clientHeight || window.innerHeight;
  const g = cv.getContext('2d'); const t = performance.now();
  const horizon = H*0.66;
  // Abendhimmel
  const sky = g.createLinearGradient(0,0,0,horizon);
  sky.addColorStop(0,'#131e33'); sky.addColorStop(0.45,'#2f3f57');
  sky.addColorStop(0.8,'#7a6a6a'); sky.addColorStop(1,'#c98a5a');
  g.fillStyle=sky; g.fillRect(0,0,W,horizon);
  // Sonne tief über dem Wasser
  const sx2=W*0.68, sy2=horizon-40;
  const sg=g.createRadialGradient(sx2,sy2,4,sx2,sy2,110);
  sg.addColorStop(0,'rgba(255,220,150,.75)'); sg.addColorStop(1,'rgba(255,180,110,0)');
  g.fillStyle=sg; g.beginPath(); g.arc(sx2,sy2,110,0,Math.PI*2); g.fill();
  g.fillStyle='#f6dd9e'; g.beginPath(); g.arc(sx2,sy2,17,0,Math.PI*2); g.fill();
  // ziehende Wolkenbänder
  for(let i=0;i<5;i++){
    const cy=H*0.10+i*H*0.075;
    const cx2=((t/(9000+i*2600))*W + i*W*0.31) % (W*1.5) - W*0.25;
    g.fillStyle='rgba(255,255,255,'+(0.045+i*0.012)+')';
    g.beginPath(); g.ellipse(cx2,cy,W*0.22,10,0,0,Math.PI*2); g.fill();
  }
  // Meer
  const sea=g.createLinearGradient(0,horizon,0,H);
  sea.addColorStop(0,'#2d5b66'); sea.addColorStop(1,'#122e38');
  g.fillStyle=sea; g.fillRect(0,horizon,W,H-horizon);
  g.strokeStyle='rgba(255,255,255,.10)'; g.lineWidth=1.3;
  for(let r=0;r<12;r++){
    const wy=horizon+14+r*((H-horizon)/12);
    g.beginPath();
    for(let x=0;x<=W;x+=12){ const yy=wy+Math.sin(t/1100+x*0.011+r)*2.6; if(x===0)g.moveTo(x,yy); else g.lineTo(x,yy); }
    g.stroke();
  }
  // Sonnenpfad
  g.save(); g.globalAlpha=0.18;
  const pth=g.createLinearGradient(sx2,horizon,sx2,H);
  pth.addColorStop(0,'rgba(255,214,150,.9)'); pth.addColorStop(1,'rgba(255,214,150,0)');
  g.fillStyle=pth; g.fillRect(sx2-48,horizon,96,H-horizon); g.restore();
  // Küstenstreifen und Baumsilhouetten
  g.fillStyle='rgba(16,30,24,.95)';
  g.beginPath(); g.moveTo(0,horizon+6);
  g.quadraticCurveTo(W*0.35,horizon-10,W,horizon+2);
  g.lineTo(W,horizon+30); g.lineTo(0,horizon+34); g.closePath(); g.fill();
  const tc=Math.max(14,Math.round(W/58));
  for(let i=0;i<tc;i++){
    const px=(i+0.5)/tc*W+Math.sin(i*3.1)*9, s2=0.7+((i*37)%5)/5*0.55, base=horizon+20;
    g.fillStyle='rgba(10,22,16,.95)';
    g.fillRect(px-1.6*s2, base-16*s2, 3.2*s2, 16*s2);
    g.beginPath();
    if(i%3===0){ g.moveTo(px,base-44*s2); g.lineTo(px-12*s2,base-13*s2); g.lineTo(px+12*s2,base-13*s2); g.closePath(); }
    else g.arc(px,base-28*s2,14*s2,0,Math.PI*2);
    g.fill();
  }
  // Vignette
  const vg=g.createRadialGradient(W/2,H*0.45,H*0.25,W/2,H*0.5,H*0.95);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,.68)');
  g.fillStyle=vg; g.fillRect(0,0,W,H);
  titleRaf = requestAnimationFrame(drawTitleBg);
}
function showTitleScreen(){
  document.getElementById('mainTitleScreen').classList.remove('hidden');
  if(!titleRaf) titleRaf = requestAnimationFrame(drawTitleBg);
}
function hideTitleScreen(){
  document.getElementById('mainTitleScreen').classList.add('hidden');
  if(titleRaf){ cancelAnimationFrame(titleRaf); titleRaf=null; }
}
// Reiter im Erstellungsmenü
// --- Titelbildschirm-Knöpfe ---

/* ---------- Navigation im Startablauf ----------
   Der Ablauf besteht aus drei Schritten im startOverlay (Titel -> Startart
   -> Figurenerstellung) und darin nochmals drei Reitern. Bisher schalteten
   die Knöpfe die Schritte einzeln per classList um; einen Rückweg gab es
   nirgends, man kam nur durch Neuladen wieder heraus.

   Statt für jeden Übergang einen eigenen Rücksprung zu verdrahten, merkt
   sich startVerlauf die besuchten Schritte. Der Zurück-Knopf, Escape und
   die Rücktaste nutzen denselben Weg. */
const START_STEPS = ['titleStep','modeStep','crewStep'];
let startVerlauf = [];

function aktiverStartSchritt(){
  // Bei geschlossenem Fenster ist kein Schritt aktiv, auch wenn die Divs
  // darin noch sichtbar markiert sind.
  const ov = document.getElementById('startOverlay');
  if(!ov || ov.classList.contains('hidden')) return null;
  return START_STEPS.find(id=>{
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  }) || null;
}
function aktiverWizSchritt(){
  const tab = document.querySelector('.wizTab.active');
  return tab ? parseInt(tab.dataset.step,10) || 1 : 1;
}
function zeigeStartSchritt(id, opts){
  const o = opts || {};
  const jetzt = aktiverStartSchritt();
  if(o.merken !== false && jetzt && jetzt !== id) startVerlauf.push(jetzt);
  if(o.zuruecksetzen) startVerlauf = [];
  START_STEPS.forEach(s=>{
    const el = document.getElementById(s);
    if(el) el.classList.toggle('hidden', s !== id);
  });
  if(id === 'crewStep') switchWizStep(1);
  aktualisiereZurueckKnopf();
}
function aktualisiereZurueckKnopf(){
  const btn = document.getElementById('btnStartBack');
  if(!btn) return;
  const offen = !document.getElementById('startOverlay').classList.contains('hidden');
  // Auf dem ersten Schritt führt Zurück zum Titelbildschirm — also immer sichtbar
  btn.classList.toggle('hidden', !offen);
  const imAssistenten = aktiverStartSchritt() === 'crewStep' && aktiverWizSchritt() > 1;
  btn.textContent = imAssistenten ? '← Vorheriger Schritt' : '← Zurück';
}
function startSchrittZurueck(){
  if(document.getElementById('startOverlay').classList.contains('hidden')) return false;
  // Innerhalb der Figurenerstellung erst die Reiter rückwärts durchgehen
  if(aktiverStartSchritt() === 'crewStep' && aktiverWizSchritt() > 1){
    switchWizStep(aktiverWizSchritt() - 1);
    aktualisiereZurueckKnopf();
    return true;
  }
  const vorher = startVerlauf.pop();
  if(vorher){ zeigeStartSchritt(vorher, {merken:false}); return true; }
  // Nichts mehr im Verlauf: zurück auf den Titelbildschirm
  document.getElementById('startOverlay').classList.add('hidden');
  aktualisiereZurueckKnopf();
  showTitleScreen();
  return true;
}

function switchWizStep(n){
  document.querySelectorAll('.wizTab').forEach(t=>t.classList.toggle('active', t.dataset.step===String(n)));
  document.querySelectorAll('.wizPane').forEach(p=>p.classList.toggle('hidden', p.dataset.pane!==String(n)));
  aktualisiereZurueckKnopf();
}
function renderPlayerClassEditor(){
  const wrap = document.getElementById('playerClassEditor'); wrap.innerHTML='';
  // Kartenbasierte Auswahl mit Symbol, Name und Kurzbeschreibung
  const cards = document.createElement('div'); cards.className='classCards';
  ADVENTURE_CLASSES.forEach(cls=>{
    const c = document.createElement('button'); c.type='button';
    c.className = 'classCard' + (playerAdvClass===cls ? ' active' : '');
    c.innerHTML = `<span class="ccIcon">${ADV_CLASS_ICON[cls]}</span>`+
                  `<span class="ccName">${cls}</span>`+
                  `<span class="ccDesc">${ADV_CLASS_DESC[cls]||''}</span>`;
    c.onclick = ()=>{ playerAdvClass = (playerAdvClass===cls) ? null : cls; renderPlayerClassEditor(); };
    cards.appendChild(c);
  });
  wrap.appendChild(cards);
}
function renderCrewPreview(){
  renderAppearanceEditor(document.getElementById('playerAppearanceEditor'), playerAppearance);
  renderPlayerClassEditor();
  const grid = document.getElementById('crewGrid'); grid.innerHTML='';
  if(pendingColonists.length===0){
    document.getElementById('crewDesc').textContent = 'Du beginnst allein. Errichte später ein Bett, um Gefährten aufzunehmen.';
    return;
  }
  document.getElementById('crewDesc').textContent = 'Diese Kolonisten brechen mit dir auf — wähle Job und Abenteuer-Klasse:';
  pendingColonists.forEach(c=>{
    const card = document.createElement('div'); card.className='colCard';
    card.innerHTML = `<div class="ctop"><span class="cname">${workIconOf(c)} ${c.name}</span></div>
      <div class="cback">${c.backstory}</div>
      <div class="skillRow">
        <span class="skillChip">⚔ Nahkampf ${c.skills.Nahkampf}</span>
        <span class="skillChip">🌾 Pflanzenbau ${c.skills.Pflanzenbau}</span>
        <span class="skillChip">🔨 Handwerk ${c.skills.Handwerk}</span>
      </div>`;
    const apDiv = document.createElement('div');
    card.appendChild(apDiv);
    renderAppearanceEditor(apDiv, c.appearance);
    const roleRow = document.createElement('div');
    roleRow.style.cssText='margin-top:6px;font-size:10.5px;color:#7a6f4e;line-height:1.35;';
    roleRow.textContent = 'Arbeitet nach Talent — die Verteilung stellst du später unter 🧑‍🌾 Arbeit ein.';
    card.appendChild(roleRow);
    const advRow = document.createElement('div'); advRow.className='advClassRow';
    advRow.innerHTML = `<div style="font-size:10px;font-weight:800;color:#5a5138;margin-top:6px;">Abenteuer-Klasse:</div>`;
    const btnRow = document.createElement('div'); btnRow.className='apRow'; btnRow.style.flexWrap='wrap';
    ADVENTURE_CLASSES.forEach(cls=>{
      const b = document.createElement('button'); b.textContent = ADV_CLASS_ICON[cls]+' '+cls;
      b.title = ADV_CLASS_DESC[cls];
      if(c.advClass!==cls) b.className='secondary';
      b.type = 'button';
      b.onclick = ()=>{ c.advClass = (c.advClass===cls) ? null : cls; renderCrewPreview(); };
      btnRow.appendChild(b);
    });
    advRow.appendChild(btnRow);
    card.appendChild(advRow);
    grid.appendChild(card);
  });
}
function showWelcomeStep8(){
  showStoryDialog('💾 Speicherstände', 'Automatisches Speichern läuft immer im Hintergrund. Zusätzlich hast du 3 eigene Speicherplätze — erreichbar über ☰ Menü → Speichern/Laden. Beim Start des Spiels landest du auf einem Titelbildschirm, wo du einen der 4 Spielstände fortsetzen, einen neuen beginnen oder alte löschen kannst.', [{ label: 'Los geht' + String.fromCharCode(39) + 's! 🚀', action: ()=>{} }]);
}
function showWelcomeStep7(){
  showStoryDialog('🕳️ Dungeons & Höhlen', 'In der Welt findest du Dungeon-Eingänge und kleinere Höhlen. Beide sind zufällig aufgebaut, mit wilden Kreaturen und einem stärkeren Wächter am Ende — besiege ihn für eine Beutetruhe mit Gold, Tränken und seltenem Material. Je weiter du von zuhause entfernt bist, desto gefährlicher (aber lohnender) wird es. Eigene, düstere Musik läuft automatisch, sobald du hinabsteigst.', [{ label: 'Weiter →', action: showWelcomeStep8 }]);
}
function showWelcomeStep6(){
  showStoryDialog('📖 Quests & Ziele', 'Im ☰ Menü unter "📖 Quests" findest du drei Dinge: eine mehrstufige Hauptquest, die dich Schritt für Schritt durch die wichtigsten Systeme führt, laufend neu generierte Nebenquests (Sammeln, Jagen, Kochen — mit Gold-Belohnung), und eine Liste erster Ziele für den Einstieg. Schau da öfter mal rein.', [{ label: 'Weiter →', action: showWelcomeStep7 }]);
}
function showWelcomeStep5(){
  showStoryDialog('🔬 Forschung & Rohstoffe', 'Ein Forschungstisch erzeugt passiv Forschungspunkte für den Technologiebaum (☰ Menü oder Taste R) — 6 Stufen mit spürbaren Boni. Neben Holz und Stein gibt es besondere Materialien wie Kiefernholz, Marmor oder das seltene Titanerz, die du beim Fällen/Abbauen zusätzlich finden kannst — nützlich für besondere Gebäude und Ausrüstung.', [{ label: 'Weiter →', action: showWelcomeStep6 }]);
}
function showWelcomeStep4(){
  showStoryDialog('⚔️ Kämpfe & Kreaturen',
    'Berührst du eine wilde Kreatur, beginnt ein rundenbasierter Kampf. Wirf eine 🪤 Falle, um sie zu fangen — gefangene Kreaturen erscheinen im Feldbuch (I) und können als Begleiter mitkämpfen. Gib dir und Kolonisten im Kolonie-Panel eine Abenteuer-Klasse für eigene Fähigkeiten und Startausrüstung. Essen und Trinken läuft übers Inventar (U), deine Klasse, Attribute und Ausrüstungsplätze siehst du im Charakter-Fenster (P) — dort kannst du auch Material aus dem Inventar direkt auf ein Ausrüstungsfeld ziehen.',
    [{ label: 'Weiter →', action: showWelcomeStep5 }]
  );
}
function showWelcomeStep3(){
  showStoryDialog('🔨 Bauen & Kolonie',
    'Drücke C, um das Baumenü zu öffnen — über 50 Gebäude in Kategorien sortiert, von Produktion bis Freizeit. Du kannst inzwischen überall in der Welt bauen, nur nicht in Dungeons/Höhlen. Neue Kolonisten kommen von selbst vorbei und bitten um Aufnahme. Im Kolonie-Panel (unten links) weist du ihnen Rollen zu und siehst alle Ressourcen. Mit X schaltest du den Abriss-Modus um — auch per Ziehen für mehrere Felder auf einmal.',
    [{ label: 'Weiter →', action: showWelcomeStep4 }]
  );
}
function showWelcomeStep2(){
  showStoryDialog('⌨️ Tastenkürzel im Überblick',
    'C Bauen · X Abreißen · R Forschung · M Weltkarte · I Feldbuch · T Tagebuch · U Inventar/Essen · P Charakter · K Kolonie · Z Ausruhen · F Vollbild. Alles auch über eigene Fenster erreichbar (Ressourcen oben links, Minikarte oben rechts — anklickbar für die volle Weltkarte, darunter auch als Knopf). Das ☰ Menü oben ist dein Schnellzugriff auf alle Fenster.',
    [{ label: 'Weiter →', action: showWelcomeStep3 }]
  );
}
function showWelcomeStep1(){
  showStoryDialog('🌲 Willkommen in Farholt!',
    'Bewege dich mit WASD/Pfeiltasten oder klicke auf ein Ziel, um dorthin zu laufen. Bäume, Steine und Sträucher erntest du automatisch im Vorbeigehen oder per Klick. Drücke E oder klicke auf Gebäude/Personen, um mit ihnen zu interagieren. Dieses Tutorial hat 8 kurze Schritte — du kannst es jederzeit über den ❓ Guide-Knopf oben erneut aufrufen.',
    [{ label: 'Weiter →', action: showWelcomeStep2 }]
  );
}

/* ============================================================
   Verdrahtung der Bildschirme
   Wird von main.js aufgerufen, sobald die Seite steht — beim
   Laden des Moduls gibt es die Elemente noch nicht.
============================================================ */
function initScreens(){
  const introNextBtn = document.getElementById('introNext');
  if(introNextBtn) introNextBtn.onclick = ()=>{
    const sc = INTRO_SCENES[introIndex];
    const shown = document.getElementById('introText').textContent.length;
    if(shown < sc.text.length){ introTypeStart = performance.now() - sc.text.length*14; return; } // erst Text fertig
    if(introIndex < INTRO_SCENES.length-1){ introIndex++; sfxEvent(); renderIntroScene(); }
    else finishIntro();
  };
  const introSkipBtn = document.getElementById('introSkip');
  if(introSkipBtn) introSkipBtn.onclick = finishIntro;
  document.getElementById('btnRespawn').onclick = ()=>{
    state.player.x = spawnX; state.player.y = spawnY; state.player.path=[]; state.player.target=null;
    state.stats.hp = 50; state.stats.hunger = clamp(state.stats.hunger,30,100);
    state.stats.thirst = clamp(state.stats.thirst,30,100); state.stats.energy = 50;
    document.getElementById('gameOverOverlay').classList.add('hidden');
    setMode('micro'); updateHUD(); saveGame();
  };
  document.getElementById('colonyNameInput').value = COLONY_NAME_POOL[Math.floor(Math.random()*COLONY_NAME_POOL.length)];
  document.getElementById('btnSolo').onclick = ()=>{
    pendingColonists = [];
    zeigeStartSchritt('crewStep');
    renderCrewPreview();
  };
  document.getElementById('btnMulti').onclick = ()=>{
    const used = new Set();
    pendingColonists = [makeColonist(used), makeColonist(used), makeColonist(used)];
    zeigeStartSchritt('crewStep');
    renderCrewPreview();
  };
  document.getElementById('btnReroll').onclick = ()=>{
    playerAppearance = randomAppearance();
    const used = new Set();
    pendingColonists = pendingColonists.map(()=>makeColonist(used));
    renderCrewPreview();
  };
  document.getElementById('btnConfirmCrew').onclick = async ()=>{
    state.colonists = pendingColonists;
    state.player.appearance = playerAppearance;
    state.player.advClass = playerAdvClass;
    if(playerAdvClass) grantStartingGear(state.player, playerAdvClass);
    state.colonists.forEach(c=>{ if(c.advClass) grantStartingGear(c, c.advClass); });
    const nameInput = document.getElementById('colonyNameInput').value.trim();
    state.colonyName = nameInput || COLONY_NAME_POOL[0];
    state.dayCycleOffset = Date.now() - DAY_CYCLE_MS*0.5;
    state.continentId = 'farholm';
    state.unlockedContinents = ['farholm'];
    document.title = state.colonyName + ' — Kolonie';
    document.getElementById('colonyTitleText').textContent = state.colonyName;
    document.getElementById('startOverlay').classList.add('hidden');
    setMode('micro');
    scatterStarterResources();
    spawnStartBote();   // Questgeber wartet von Anfang an in der Naehe
    // Eigener Schlüssel fürs Story-Intro — der alte gehörte dem Willkommensdialog
    // und war bei bestehenden Spielständen längst gesetzt.
    let alreadySeen = false;
    try{ const r = await window.storage.get('wildwood-seen-story-intro'); alreadySeen = !!(r && r.value); }catch(e){}
    updateHUD(); saveGame(); updateDayNightIndicator();
    startMusicTrack('colony');
    checkBiomeLore();
    if(!alreadySeen){
      startIntro();   // Story-Intro an der Küste, danach folgt der Willkommensdialog
      try{ await window.storage.set('wildwood-seen-story-intro','1'); }catch(e){}
    }
  };
}

/* ============================================================
   Zeitgeber und Verdrahtung der Bildschirme
   Wird von main.js aufgerufen, sobald die Seite steht.
============================================================ */
/* Eigener Wurf nur für Zuzug. Läuft parallel zu rollStoryEvent(), damit
   neue Kolonisten nicht jedes Mal gegen Wetter, Überfälle und Kopfgelder
   antreten müssen. */
const SIEDLER_EVENTS = [
  { id:'wanderer', weight:4, condition: ()=> housingCap() > state.colonists.length && state.stats.hunger>30, run: wandererEvent },
  { id:'visitor',  weight:3, condition: ()=> atHome(), run: visitorEvent },
  { id:'quest_npc',weight:2, condition: ()=> !atDungeon(), run: questNpcEvent },
];
function rollSiedlerEvent(){
  if(paused) return;
  const valid = SIEDLER_EVENTS.filter(e=> !e.condition || e.condition());
  if(!valid.length) return;
  const total = valid.reduce((a,e)=>a+e.weight,0);
  let r = Math.random()*total;
  for(const e of valid){ r-=e.weight; if(r<=0){ e.run(); saveGame(); return; } }
}

function initScreenTimers(){
  /* Ereignistakt: erstes Ereignis nach 45 s statt 100 s, danach alle 100 s
     statt alle 270 s. Vorher passierte in einer Viertelstunde Spielzeit
     dreimal etwas — zu wenig, damit sich die Basis lebendig anfühlt.
     Zusätzlich ein eigener, schnellerer Takt nur für Wanderer und Besucher,
     damit Zuwachs nicht mit Überfällen und Wetter um denselben Wurf
     konkurriert. */
  setTimeout(rollStoryEvent, 45000);
  setInterval(rollStoryEvent, 100000);
  setTimeout(rollSiedlerEvent, 70000);
  setInterval(rollSiedlerEvent, 130000);
  setInterval(()=>{ if(state.raid && Date.now()>state.raid.until && !(encounter && encounter.raid)) applyRaidLoss(); }, 1000);
  setInterval(()=>{ if(state.weather.type!=='clear' && Date.now()>state.weather.until){ state.weather={type:'clear',until:0}; logEvent('☀️ Das Wetter klart auf.'); updateColonyIfOpen(); } }, 2000);
  (function(){
    const on=(id,fn)=>{ const e=document.getElementById(id); if(e) e.onclick=fn; };
    on('tbStart', ()=>{ hideTitleScreen();
      document.getElementById('startOverlay').classList.remove('hidden');
      zeigeStartSchritt('modeStep', {zuruecksetzen:true, merken:false});
    });
    on('tbContinue', ()=>{ hideTitleScreen();
      document.getElementById('startOverlay').classList.remove('hidden');
      zeigeStartSchritt('titleStep', {zuruecksetzen:true, merken:false});
    });
    on('tbOptions', ()=>{ openOptions(); });
    on('tbCredits', ()=>{ document.getElementById('creditsOverlay').classList.remove('hidden'); });
    on('closeCredits', ()=>{ document.getElementById('creditsOverlay').classList.add('hidden'); });
    on('btnStartBack', ()=>{ sfxEvent(); startSchrittZurueck(); });
    /* Escape und die Rücktaste nehmen denselben Weg wie der Knopf. */
    window.addEventListener('keydown', (e)=>{
      if(e.key !== 'Escape' && e.key !== 'Backspace') return;
      const ov = document.getElementById('startOverlay');
      if(!ov || ov.classList.contains('hidden')) return;
      const t = e.target;
      if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      startSchrittZurueck();
    });
    document.querySelectorAll('.wizTab').forEach(t=>{
      t.onclick=()=>switchWizStep(t.dataset.step);
    });
    // Knöpfe der linken Spalte auf die vorhandene Logik legen
    on('edDice', ()=>{ const b=document.querySelector('.apDice'); if(b) b.click(); });
    on('edReroll', ()=>{ const b=document.getElementById('btnReroll'); if(b) b.click(); });
    showTitleScreen();
  })();
}

export {
  dialogSeiten,
  zeigeDialogSeite,
  renderStoryDialog,
  DIALOG_ZEICHEN_PRO_SEITE,
  spawnStartBote,
  WALL_MAX_HP,
  wallMaxHp,
  isWallType,
  damageWall,
  angreiferBeschaedigenWaende,
  SIEDLER_EVENTS,
  rollSiedlerEvent,
  NPC_TYPES,
  spawnNpc,
  zeigeStartSchritt,
  startSchrittZurueck,
  aktiverStartSchritt,
  aktiverWizSchritt,
  aktualisiereZurueckKnopf,
  WALL_DEFENSE_FACTOR,
  initPlayerAppearance,
  initScreenTimers,
  initScreens,
  INTRO_SCENES,
  STORY_EVENTS,
  VISITOR_LINES,
  applyRaidLoss,
  beginRaidFight,
  bountyEvent,
  checkGameOver,
  closeStoryDialog,
  drawIntroScene,
  drawTitleBg,
  evacuateSupplies,
  finishIntro,
  hideTitleScreen,
  introIndex,
  introRaf,
  introTypeStart,
  pendingColonists,
  playerAdvClass,
  playerAppearance,
  questNpcEvent,
  renderCrewPreview,
  renderIntroScene,
  renderPlayerClassEditor,
  rollStoryEvent,
  showStoryDialog,
  showTitleScreen,
  showWelcomeStep1,
  showWelcomeStep2,
  showWelcomeStep3,
  showWelcomeStep4,
  showWelcomeStep5,
  showWelcomeStep6,
  showWelcomeStep7,
  showWelcomeStep8,
  sicknessEvent,
  startIntro,
  startRaid,
  startWeather,
  switchWizStep,
  talkToQuestNpc,
  talkToVisitor,
  titleRaf,
  traderEvent,
  visitorEvent,
  wandererEvent
};
