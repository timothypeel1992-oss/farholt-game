/* ============================================================
   ui/panels.js — Fenster
   Overlay-Register, Kolonie, Feldbuch, Arbeitsübersicht,
   Gebäude-Innenansichten und das Baumenü.
============================================================ */

import { DAY_CYCLE_MS, clamp } from '../engine/rng.js';
import { sfxBuildDone, sfxCraft, sfxDrink, sfxEat, sfxError, sfxEvent, sfxJoin, sfxPlace, sfxRest, startMusicTrack } from '../engine/audio.js';
/* ============================================================
   Overlay-Register
   Eine Tabelle statt 20 einzelner open/close-Paare. Escape,
   Menüs und Moduswechsel arbeiten gegen diese eine Liste —
   dadurch kann kein Fenster mehr "vergessen" werden.
============================================================ */
const OVERLAYS = {};   // id -> {el, onOpen, onClose, mode}
function registerOverlay(id, opts){
  const el = document.getElementById(id);
  if(!el){ console.warn('Overlay nicht gefunden:', id); return; }
  OVERLAYS[id] = { el, onOpen:opts&&opts.onOpen, onClose:opts&&opts.onClose,
                   mode:(opts&&opts.mode)||'overlay' };
}
function isOverlayOpen(id){
  const o = OVERLAYS[id];
  return !!o && !o.el.classList.contains('hidden');
}
function anyOverlayOpen(){
  return Object.keys(OVERLAYS).some(isOverlayOpen);
}
// Merkt sich die Öffnungsreihenfolge — „oben" heißt zuletzt geöffnet,
// nicht zuletzt registriert.
let overlayStack = [];
/* Holt den Registereintrag. Fehlt er, wird das Fenster nachträglich
   registriert statt stumm zu verwerfen: ein nicht eingetragenes Fenster
   liess sich sonst nie wieder schliessen — der Klick lief ins Leere,
   ohne dass die Konsole etwas meldete. */
function overlayEntry(id){
  let o = OVERLAYS[id];
  if(o) return o;
  const el = document.getElementById(id);
  if(!el){ console.warn('[overlay] Unbekanntes Fenster:', id); return null; }
  console.warn('[overlay] "'+id+'" war nicht registriert — wird nachgetragen.');
  registerOverlay(id);
  return OVERLAYS[id] || null;
}
function openOverlay(id, ...args){
  const o = overlayEntry(id); if(!o) return;
  if(o.onOpen) o.onOpen(...args);
  o.el.classList.remove('hidden');
  overlayStack = overlayStack.filter(x=>x!==id);
  overlayStack.push(id);
  setMode(o.mode, {remember:true});
}
function closeOverlay(id){
  const o = overlayEntry(id); if(!o) return;
  o.el.classList.add('hidden');
  overlayStack = overlayStack.filter(x=>x!==id);
  if(o.onClose) o.onClose();
  // Erst wenn wirklich nichts mehr offen ist, zurück in den vorigen Modus
  if(!anyOverlayOpen()) popMode();
}
function closeAllOverlays(){
  overlayStack = [];
  Object.keys(OVERLAYS).forEach(id=>{
    if(isOverlayOpen(id)){
      OVERLAYS[id].el.classList.add('hidden');
      if(OVERLAYS[id].onClose) OVERLAYS[id].onClose();
    }
  });
}
// Schließt das oberste offene Fenster — für die Escape-Taste
function closeTopOverlay(){
  // zuletzt geöffnetes zuerst schließen
  for(let i=overlayStack.length-1; i>=0; i--){
    if(isOverlayOpen(overlayStack[i])){ closeOverlay(overlayStack[i]); return true; }
  }
  // Rückfall: ein Fenster wurde am Register vorbei geöffnet
  const open = Object.keys(OVERLAYS).filter(isOverlayOpen);
  if(!open.length) return false;
  closeOverlay(open[open.length-1]);
  return true;
}



let facingDelta = {up:[0,-1], down:[0,1], left:[-1,0], right:[1,0]};
let reservedTargets = new Set();
let selectedColonistId = null, awaitingDestination = false;
let buildMode = { active:false, type:null, dragStart:null, dragCurrent:null, rotation:0, keepRotation:false };
// Auto-Tiling-Gebäude richten sich nach ihren Nachbarn — eine freie Drehung
// würde ihre Verbindungen widersprüchlich darstellen, daher bleiben sie fest.
/* Autotiling-Wände richten sich nach ihren Nachbarn und dürfen deshalb
   nicht zusätzlich gedreht werden. */
const AUTOTILED = ['zaun','wall','copperwall','silverwall','goldwall','titanwall',
  'holzwand1', 'holzwand2', 'holzwand3', 'fensterwand1', 'fensterwand2', 'fensterwand3', 'metallwand1', 'metallwand2', 'metallwand3'];
function isRotatable(type){ return !AUTOTILED.includes(type); }
let hoverTile = null;
let keyboardCameraEnabled = false;
let cameraKeysHeld = new Set();
let movementKeysHeld = new Set();
let cameraFreeMode = false;
let demolishMode = false;
let demolishDrag = {start:null, current:null};
let groundItems = [];

/* ---------- wild monster spawns ---------- */
let wildMonsters = [];

/* Der UID-Zähler wird von world.js, main.js und screens.js mitbenutzt.
   Als blanke Zahl lief er auseinander, weil jedes Modul über globalThis
   nur eine Kopie sah. Als Objekt + Funktion teilen sich alle Module
   denselben Zustand. */
const uidCounter = { n: 1 };
function newUid(){ return uidCounter.n++; }
const BIOME_TYPE_BIAS = {
  wildwood:['Grass','Normal'], highland:['Rock','Electric'], frost:['Ice'], ruins:['Ghost','Rock'],
  swamp:['Poison','Water'], coast:['Water','Flying'], thorn:['Poison','Bug'], meadow:['Grass','Normal'], deepwood:['Grass','Bug']
};
function weightedSpecies(biome){
  biome = biome || currentBiome;
  const favored = BIOME_TYPE_BIAS[biome] || [];
  const total = SPECIES.reduce((a,s)=> a + (favored.includes(s.type) ? s.weight*3 : s.weight), 0);
  let r = Math.random()*total;
  for(const s of SPECIES){
    const w = favored.includes(s.type) ? s.weight*3 : s.weight;
    r -= w;
    if(r<=0) return s;
  }
  return SPECIES[0];
}
function trySpawnWild(){
  const cap = isNightNow() ? 18 : 12;
  if(globalThis.wildMonsters.length>=cap) return;
  const useHotspot = huntHotspots && huntHotspots.length>0 && Math.random()<0.55;
  for(let tries=0;tries<20;tries++){
    let x,y;
    if(useHotspot){
      const hs = huntHotspots[Math.floor(Math.random()*huntHotspots.length)];
      x = clamp(hs.x + Math.floor((Math.random()*2-1)*4), 0, WORLD_W-1);
      y = clamp(hs.y + Math.floor((Math.random()*2-1)*4), 0, WORLD_H-1);
    } else {
      x = Math.floor(Math.random()*WORLD_W); y = Math.floor(Math.random()*WORLD_H);
    }
    if(!passable(x,y)) continue;
    if(Math.hypot(x-state.player.x,y-state.player.y)<5) continue;
    if(atHome()){
      if(state.colonyCenter && Math.hypot(x-state.colonyCenter.x,y-state.colonyCenter.y)<14) continue;
      if(state.buildings.some(b=>b.type==='schutzzone' && b.built && Math.hypot(x-b.x,y-b.y)<4)) continue;
    }
    const sp = weightedSpecies();
    globalThis.wildMonsters.push({ uid:newUid(), speciesId:sp.id, x, y, lastMove:0, hostile:false, raid:false });
    return;
  }
}
/* Erstbesetzung mit Wildtieren — wird von main.js beim Start
   aufgerufen, nicht schon beim Laden des Moduls. */
function seedWildMonsters(){ for(let i=0;i<10;i++) trySpawnWild(); }

/* ============================================================
   UI helpers
============================================================ */
function toast(msg){
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div'); el.className='toast'; el.textContent=msg;
  wrap.appendChild(el); setTimeout(()=>el.remove(), 2300);
}
function logEvent(msg){
  const t = new Date();
  const stamp = t.getHours().toString().padStart(2,'0')+':'+t.getMinutes().toString().padStart(2,'0');
  state.eventLog.unshift(stamp+' — '+msg);
  if(state.eventLog.length>25) state.eventLog.length=25;
}
function bumpResource(key){
  const map={wood:'invWood',stone:'invStone',berries:'invBerry',trap:'invTrap'};
  const id=map[key]; if(!id) return;
  const span=document.getElementById(id); if(!span) return;
  const el=span.closest('.invItem'); if(!el) return;
  el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
}
/* Die Ressourcenanzeige ist #resourceOverlay in index.html und wird von
   updateHUD() befüllt. Ein zweites Dashboard hatte ich hier versehentlich
   danebengesetzt — es lag deckungsgleich darüber. Entfernt. */

/* ---------- Aufträge-Menü in der Architekt-Leiste ----------
   Das Menü klappt über der Leiste auf, damit nichts springt. Ein gewählter
   Befehl bleibt aktiv, bis er abgewählt wird — man markiert also mehrere
   Flächen hintereinander, ohne jedes Mal neu ins Menü zu müssen. */
function toggleDesMenu(offen){
  const menu = document.getElementById('desMenu');
  const btn = document.getElementById('btnDesignations');
  if(!menu || !btn) return;
  const zu = (offen === undefined) ? !menu.classList.contains('hidden') : !offen;
  menu.classList.toggle('hidden', zu);
  btn.setAttribute('aria-expanded', String(!zu));
  btn.textContent = '📋 Aufträge ' + (zu ? '▴' : '▾');
}

/* Der Mauszeiger trägt das Werkzeugsymbol des aktiven Befehls mit sich —
   so ist ohne Blick auf die Leiste erkennbar, was ein Zug bewirkt. */
function updateCmdCursor(){
  const stage = document.getElementById('stage');
  const marke = document.getElementById('cmdCursor');
  if(!stage || !marke) return;
  ['chop','mine','harvest'].forEach(a=> stage.classList.remove('cmd-'+a));
  if(designationMode){
    stage.classList.add('cmd-' + designationMode);
    marke.textContent = DESIGNATION_ARTEN[designationMode].icon;
    marke.classList.remove('hidden');
  } else {
    marke.classList.add('hidden');
  }
  document.querySelectorAll('[data-designation]').forEach(b=>
    b.classList.toggle('active-designation', b.dataset.designation === designationMode));
  const btn = document.getElementById('btnDesignations');
  if(btn) btn.classList.toggle('active-designation', !!designationMode);
}

let designationToolsBereit = false;
function initDesignationTools(){
  /* Schutz gegen Mehrfachaufruf: die Funktion hängt Listener an document,
     window und die Bühne. Würde sie ein zweites Mal laufen, reagierte jeder
     Klick doppelt. */
  if(designationToolsBereit) return;
  designationToolsBereit = true;
  const btn = document.getElementById('btnDesignations');
  if(btn) btn.onclick = (e)=>{ e.stopPropagation(); sfxEvent(); toggleDesMenu(); };

  document.querySelectorAll('[data-designation]').forEach(b=>{
    b.onclick = (e)=>{
      e.stopPropagation();
      sfxEvent();
      // Leerer Wert = Befehl beenden
      setDesignationMode(b.dataset.designation || null);
      toggleDesMenu(false);
      updateCmdCursor();
    };
  });

  // Klick daneben schließt das Menü, ohne den Befehl zu ändern
  document.addEventListener('click', (e)=>{
    const menu = document.getElementById('desMenu');
    if(!menu || menu.classList.contains('hidden')) return;
    if(e.target.closest && e.target.closest('.cmdWrap')) return;
    toggleDesMenu(false);
  });

  // Escape beendet den aktiven Befehl
  window.addEventListener('keydown', (e)=>{
    if(e.key !== 'Escape' || !designationMode) return;
    setDesignationMode(null);
    toggleDesMenu(false);
    updateCmdCursor();
  });

  // Zeiger folgt der Maus über der Bühne
  const stage = document.getElementById('stage');
  if(stage) stage.addEventListener('mousemove', (e)=>{
    const marke = document.getElementById('cmdCursor');
    if(!marke || marke.classList.contains('hidden')) return;
    const r = stage.getBoundingClientRect();
    marke.style.left = (e.clientX - r.left) + 'px';
    marke.style.top  = (e.clientY - r.top) + 'px';
  });
}

/* ---------- HUD ----------
   Wird bei jeder Ressourcenänderung gerufen, also sehr häufig. Vorher
   holte jeder Aufruf 19 Elemente per getElementById und schrieb blind
   alle Werte — auch die unveränderten. Jetzt werden die Elemente einmal
   nachgeschlagen und gemerkt, und geschrieben wird nur, was sich
   tatsächlich geändert hat. Ein Schreibzugriff auf textContent oder style
   löst im Browser Layout-Arbeit aus, ein Vergleich nicht. */
const hudEls = {};
const hudLetzte = {};

function hudEl(id){
  let el = hudEls[id];
  if(el === undefined){ el = hudEls[id] = document.getElementById(id) || null; }
  return el;
}
function hudText(id, wert){
  if(hudLetzte[id] === wert) return;
  const el = hudEl(id); if(!el) return;
  el.textContent = wert;
  hudLetzte[id] = wert;
}
function hudBreite(id, prozent){
  const key = id + ':w';
  if(hudLetzte[key] === prozent) return;
  const el = hudEl(id); if(!el) return;
  el.style.width = prozent + '%';
  hudLetzte[key] = prozent;
}

const HUD_RESSOURCEN = [
  ['invWood','wood'], ['invHolzKiefer','holz_kiefer'], ['invHolzDunkel','holz_dunkel'],
  ['invHolzBruch','holz_bruch'], ['invStone','stone'], ['invSteinMarmor','stein_marmor'],
  ['invSteinSand','stein_sand'], ['invErzTitan','erz_titan'], ['invBerry','berries'],
  ['invTrap','trap'],
];

function updateHUD(){
  const s = state.stats;
  [['barHp','lblHp',s.hp], ['barHunger','lblHunger',s.hunger],
   ['barThirst','lblThirst',s.thirst], ['barEnergy','lblEnergy',s.energy]].forEach(([bar,lbl,wert])=>{
    const v = clamp(wert, 0, 100);
    hudBreite(bar, v);
    hudText(lbl, Math.round(v));
  });
  HUD_RESSOURCEN.forEach(([id,key])=> hudText(id, state.inventory[key] || 0));
  hudText('invColonists', state.colonists.length);
}

/* ============================================================
   Fortschrittsordnung im Baumenü
   Gebäude erscheinen in der Reihenfolge, in der man sie im Spiel
   tatsächlich braucht — vorher folgte die Liste dem Zufall der
   Array-Reihenfolge.
============================================================ */
const BUILD_STAGE = {
  1: {label:'① Erste Schritte',  hint:'Damit fängst du an'},
  2: {label:'② Verarbeitung',    hint:'Rohstoffe veredeln'},
  3: {label:'③ Ausbau',          hint:'Handwerk und Versorgung'},
  4: {label:'④ Fortgeschritten', hint:'Späte Kolonie'}
};
const BUILD_ORDER = {
  // ① Start
  primitivbank:1, campfire:1, lagerkiste:1, stockpile:1, tent:1,
  holzboden:1, wall:1, door:1, zaun:1,
  // ② Erste Verarbeitung
  sawmill:2, werkstatt:2, furnace:2, feld_beeren:2, feld_gemuese:2,
  steinboden:2, schutzzone:2,
  // ③ Ausbau
  loom:3, schmiede:3, toepferei:3, gerberei:3, muehle:3, baeckerei:3,
  kuechenherd:3, research:3, workbench:3, forge:3, vorratskammer:3,
  krankenstube:3, brunnen:3, tower:3, feld_kraeuter:3, feld_fasern:2, feld_getreide:3,
  bibliothek:3, barber:3, stuhl:3, bank:3, schreibtisch:3, kommode:3,
  // ④ Fortgeschritten
  alchemielabor:4, schreinerei:4, steinmetz:4, werft:4, zwinger:4,
  tiergehege:4, wachhaus:4, ballista:4, spitzenfalle:4,
  copperwall:4, silverwall:4, goldwall:4, titanwall:4,
  // Neue Wandfamilien: Stufe 1 früh verfügbar, Stufe 3 im Ausbau
  holzwand1:1, holzwand2:2, holzwand3:3,
  fensterwand1:2, fensterwand2:3, fensterwand3:4,
  metallwand1:3, metallwand2:4, metallwand3:4,
  schachtisch:4, kegelbahn:4, musikecke:4, kamin:4, statue:4,
  blumentopf:4, fackel:4, teppich:4, marmorboden:4, gartenweg:4
};
function buildStageOf(type){ return BUILD_ORDER[type] || 3; }
function renderRecipes(){
  const wrap = document.getElementById('recipeList');
  wrap.innerHTML='';
  const filtered = RECIPES.filter(r=>{
    const cat = r.building ? (BUILDING_MENU_CATEGORY[r.type]||'sonstiges') : 'sonstiges';
    return cat===craftActiveTab;
  });
  if(filtered.length===0){
    wrap.innerHTML = '<div class="desc">Nichts in dieser Kategorie.</div>';
    return;
  }
  // Nach Fortschrittsstufe sortieren, innerhalb der Stufe nach Kosten
  filtered.sort((a,b)=>{
    const sa = a.building ? buildStageOf(a.type) : 3;
    const sb = b.building ? buildStageOf(b.type) : 3;
    if(sa!==sb) return sa-sb;
    const ca = Object.values(a.cost).reduce((x,y)=>x+y,0);
    const cb = Object.values(b.cost).reduce((x,y)=>x+y,0);
    return ca-cb;
  });
  let lastStage = null;
  filtered.forEach(r=>{
    // Zwischenüberschrift bei jedem Stufenwechsel
    const stage = r.building ? buildStageOf(r.type) : 3;
    if(stage !== lastStage){
      lastStage = stage;
      const h = document.createElement('div'); h.className='stageHeader';
      h.innerHTML = `<span class="shLabel">${BUILD_STAGE[stage].label}</span>`+
                    `<span class="shHint">${BUILD_STAGE[stage].hint}</span>`;
      wrap.appendChild(h);
    }
    const locked = r.requiresTech && !hasTech(r.requiresTech);
    const div = document.createElement('div');
    div.className='recipe'+(locked?' locked':'')+(stage===1?' starter':'');
    const affordable = canAfford(r.cost);
    const icon = r.building ? (BUILD_EMOJI[r.type]||'🏗️') : '🪤';
    const costBadges = Object.entries(r.cost).map(([k,v])=>{
      const have = state.inventory[k]||0;
      const short = have>=v;
      return `<span class="costPill${short?'':' costShort'}">${RESOURCE_ICONS[k]||''} ${v}</span>`;
    }).join('');
    const lockedNote = locked ? `<div class="lockNote">🔒 Benötigt: ${TECH_TREE.find(t=>t.key===r.requiresTech).name}</div>` : '';
    div.innerHTML = `<div class="recipeIcon">${icon}</div>
      <div style="flex:1">
        <div class="rname">${r.name}</div>
        <div class="rcost">${r.desc}</div>
        <div class="costPillRow">${costBadges}</div>
        ${lockedNote}
      </div>`;
    const btn = document.createElement('button'); btn.textContent = r.building ? 'Platzieren' : 'Herstellen'; btn.disabled=!affordable||locked;
    btn.onclick=()=>{
      if(!canAfford(r.cost) || locked) return;
      if(r.building){
        if(atDungeon()){ sfxError(); toast('In Dungeons und Höhlen kannst du nicht bauen.'); return; }
        buildMode = { active:true, type:r.type, dragStart:null, dragCurrent:null, rotation:0, keepRotation:false };
        if(demolishMode){ demolishMode=false; demolishDrag={start:null,current:null}; document.getElementById('btnDemolish').classList.remove('active-demolish'); }
        closeCraft();
        sfxPlace();
        const banner = document.getElementById('buildModeBanner');
        banner.style.display='block';
        banner.textContent = '🔨 Baumodus: '+r.name+' — Klicken oder Ziehen zum Platzieren (Rechtsklick = Abbrechen)';
      } else {
        pay(r.cost); state.inventory.trap += 1; bumpResource('trap'); sfxCraft(); toast('🪤 Falle hergestellt!');
      }
      renderRecipes(); updateHUD(); saveGame();
    };
    div.appendChild(btn); wrap.appendChild(div);
  });
}
function openCraft(){
  if(atDungeon()){ toast('🏗️ In Dungeons und Höhlen kannst du nicht bauen.'); return; }
  openOverlay('craftOverlay');
}
function closeCraft(){ closeOverlay('craftOverlay'); }

/* ---------- Rest / Eat ---------- */
function tryRest(){
  const near = state.buildings.some(b => b.type==='campfire' && b.built && Math.hypot(b.x-state.player.x,b.y-state.player.y)<=1.5);
  if(!near){ sfxError(); toast('Kein Lagerfeuer in der Nähe.'); return; }
  state.stats.energy = clamp(state.stats.energy+40,0,100);
  if(state.activeId!=null && state.collection[state.activeId]){
    const c = state.collection[state.activeId]; const sp = SPECIES[state.activeId];
    c.currentHp = clamp(c.currentHp+Math.round(sp.stats.hp*0.5),0,sp.stats.hp);
  }
  sfxRest(); toast('🔥 Du ruhst dich aus… Energie +40'); updateHUD(); saveGame();
}
function consumeFood(key){
  if((state.inventory[key]||0)<=0) return;
  state.inventory[key]--;
  if(key==='meal_deluxe'){
    state.stats.hunger = clamp(state.stats.hunger+55,0,100);
    state.stats.energy = clamp(state.stats.energy+20,0,100);
    if(state.activeId!=null && state.collection[state.activeId]){
      const c = state.collection[state.activeId]; const sp = SPECIES[state.activeId];
      c.currentHp = clamp(c.currentHp+Math.round(sp.stats.hp*0.3),0,sp.stats.hp);
    }
    healPlayer(18, true);
    toast('🍽️ Deluxe-Mahlzeit! Hunger +55, Energie +20, Leben +18');
  } else if(key==='meal_veggie'){
    state.stats.hunger = clamp(state.stats.hunger+35,0,100);
    healPlayer(10, true);
    toast('🍲 Gemüseeintopf! Hunger +35, Leben +10');
  } else if(key==='meal_simple'){
    state.stats.hunger = clamp(state.stats.hunger+30,0,100);
    healPlayer(8, true);
    toast('🍳 Gebratenes Fleisch! Hunger +30, Leben +8');
  } else if(key==='meal_brot'){
    state.stats.hunger = clamp(state.stats.hunger+22,0,100);
    toast('🍞 Frisches Brot! Hunger +22');
  } else if(key==='berries'){
    state.stats.hunger = clamp(state.stats.hunger+15,0,100);
    bumpResource('berries');
    toast('🫐 Beere gegessen! Hunger +15');
  } else if(key==='potion'){
    state.stats.thirst = clamp(state.stats.thirst+40,0,100);
    const h = healPlayer(35, true);
    toast('🧪 Heiltrank! Leben +'+h+', Durst +40');
    // heilt zusätzlich das aktive Monster
    if(state.activeId!=null && state.collection[state.activeId]){
      const c = state.collection[state.activeId]; const sp = SPECIES[state.activeId];
      c.currentHp = clamp(c.currentHp+Math.round(sp.stats.hp*0.4),0,sp.stats.hp);
    }
  }
  sfxEat(); updateHUD(); saveGame();
}

/* ============================================================
   Dex panel
============================================================ */
function renderDexContent(teamListId, gridId){
  const teamWrap = document.getElementById(teamListId); teamWrap.innerHTML='';
  const caughtIds = Object.keys(state.collection).map(Number).sort((a,b)=>a-b);
  if(caughtIds.length===0){
    teamWrap.innerHTML = '<div class="desc">Noch keine Kreaturen gefangen. Wirf im Kampf eine Falle, um eine zu fangen!</div>';
  } else {
    caughtIds.forEach(id=>{
      const sp = SPECIES[id]; const c = state.collection[id];
      const isActive = state.activeId===id;
      const isPenned = !!c.penned;
      const row = document.createElement('div'); row.className='techItem'+(isActive?' done':'')+(isPenned?' locked':'');
      const hpPct = clamp(c.currentHp/sp.stats.hp*100,0,100);
      row.innerHTML = `<div class="techTop"><span class="techName">${isActive?'⭐ ':''}${isPenned?'🏠 ':''}${sp.name}</span><span>${c.currentHp}/${sp.stats.hp} LP</span></div>
        <div class="techDesc">${sp.type} · ${sp.rarity}${isActive?' — aktueller Begleiter':''}${isPenned?' — lebt im Tiergehege':''}${sp.evolvesTo!=null?` · ✨ Entwicklung: ${c.wins||0}/${EVOLUTION_WINS_NEEDED} Siege`:''}</div>
        <div class="hpbar"><div class="hpfill" style="width:${hpPct}%"></div></div>`;
      if(!isActive && !isPenned){
        const btn=document.createElement('button'); btn.textContent='✅ Als Begleiter wählen'; btn.style.marginTop='6px';
        btn.onclick=()=>{ state.activeId=id; renderDexContent(teamListId,gridId); saveGame(); toast(`${sp.name} ist jetzt dein Begleiter.`); };
        row.appendChild(btn);
        const hasPen = state.buildings.some(b=>b.type==='tiergehege' && b.built);
        const penBtn=document.createElement('button'); penBtn.className='secondary'; penBtn.textContent='🏠 Ins Gehege geben'; penBtn.style.marginTop='6px';
        penBtn.disabled = !hasPen;
        if(!hasPen) penBtn.title = 'Baue erst ein Tiergehege.';
        penBtn.onclick=()=>{ c.penned = true; renderDexContent(teamListId,gridId); saveGame(); toast(`${sp.name} lebt jetzt im Tiergehege.`); };
        row.appendChild(penBtn);
      } else if(isPenned){
        const btn=document.createElement('button'); btn.className='secondary'; btn.textContent='↩ Aus dem Gehege holen'; btn.style.marginTop='6px';
        btn.onclick=()=>{ c.penned = false; renderDexContent(teamListId,gridId); saveGame(); toast(`${sp.name} verlässt das Gehege.`); };
        row.appendChild(btn);
      }
      teamWrap.appendChild(row);
    });
  }
  const grid = document.getElementById(gridId); grid.innerHTML='';
  SPECIES.forEach(sp=>{
    const caughtInfo = state.collection[sp.id];
    const card = document.createElement('div'); card.className='dexCard' + (state.activeId===sp.id ? ' active':'');
    const cv = document.createElement('canvas'); cv.width=100; cv.height=80; card.appendChild(cv);
    const nm = document.createElement('div'); nm.className='dname'; nm.textContent = caughtInfo ? sp.name : '???';
    const ty = document.createElement('div'); ty.className='dtype'; ty.textContent = caughtInfo ? sp.type + ' · ' + sp.rarity : 'unentdeckt';
    if(caughtInfo && sp.rarity!=='common'){
      card.classList.add('rar-'+sp.rarity);
      const badge = document.createElement('div'); badge.className='rarBadge rar-'+sp.rarity;
      badge.textContent = sp.rarity==='rare' ? '★★' : '★';
      card.appendChild(badge);
    }
    card.appendChild(nm); card.appendChild(ty); grid.appendChild(card);
    const ctx = cv.getContext('2d');
    // Seltenheits-Aura hinter dem Monster
    if(caughtInfo && sp.rarity!=='common'){
      const aur = RARITY_AURA[sp.rarity];
      const ag = ctx.createRadialGradient(50,46,4,50,46,42);
      ag.addColorStop(0, `rgba(${aur.rgb},.32)`);
      ag.addColorStop(0.6, `rgba(${aur.rgb},.13)`);
      ag.addColorStop(1, `rgba(${aur.rgb},0)`);
      ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(50,46,42,0,Math.PI*2); ctx.fill();
    }
    drawMonster(ctx, 50, 46, 60, sp, !!caughtInfo);
    if(caughtInfo){ card.onclick = ()=>{ state.activeId = sp.id; renderDexContent(teamListId,gridId); saveGame(); toast(`${sp.name} ist jetzt dein Begleiter.`); }; }
  });
}
function renderDex(){ renderDexContent('dexTeamList','dexGrid'); }
function openDex(){ openOverlay('dexOverlay'); }
function closeDex(){ closeOverlay('dexOverlay'); }

/* ---------- Central pause menu ---------- */
const FOOD_ITEMS = [
  { key:'meal_deluxe', label:'🍽️ Deluxe-Mahlzeit', restore:'Hunger +55, Energie +20' },
  { key:'meal_veggie', label:'🍲 Gemüseeintopf', restore:'Hunger +35' },
  { key:'meal_simple', label:'🍳 Gebratenes Fleisch', restore:'Hunger +30' },
  { key:'meal_brot', label:'🍞 Frisches Brot', restore:'Hunger +22' },
  { key:'berries', label:'🫐 Beeren', restore:'Hunger +15' },
  { key:'potion', label:'🧪 Heiltrank', restore:'Leben +35, Durst +40' }
];
function renderInventorySlots(){
  const grid = document.getElementById('invSlotGrid'); grid.innerHTML='';
  const items = [];
  Object.keys(RESOURCE_ICONS).forEach(k=>{
    const count = state.inventory[k]||0;
    if(count>0) items.push({key:k, icon:RESOURCE_ICONS[k], count, title:RESOURCE_NAMES[k]});
  });
  if((state.classScrolls||0)>0) items.push({key:'__scroll__', icon:'📜', count:state.classScrolls, title:'Klassen-Schriftrolle'});
  const TOTAL_SLOTS = 48;
  for(let i=0;i<TOTAL_SLOTS;i++){
    const item = items[i];
    const slot = document.createElement('div');
    if(item){
      slot.className = 'slotItem';
      slot.title = item.title + ' — auf ein Ausrüstungsfeld ziehen, um passende Ausrüstung zu schmieden';
      slot.innerHTML = `<span class="slotIcon">${item.icon}</span><span class="slotCount">${item.count}</span>`;
      if(item.key!=='__scroll__'){
        slot.draggable = true;
        slot.addEventListener('dragstart', (e)=>{ e.dataTransfer.setData('text/plain', item.key); });
      }
    } else {
      slot.className = 'slotItem empty';
    }
    grid.appendChild(slot);
  }
}
function craftForSlotFromDrag(slotKey){
  const candidates = EQUIPMENT_RECIPES.filter(r=>r.slot===slotKey && !(r.requiresTech && !hasTech(r.requiresTech)));
  const affordable = candidates.filter(r=>canAfford(r.cost));
  if(affordable.length===0){
    sfxError();
    toast(candidates.length===0 ? 'Für diesen Platz gibt es noch kein Rezept.' : 'Nicht genug Material für dieses Ausrüstungsteil.');
    return;
  }
  const best = affordable.sort((a,b)=>Object.values(b.cost).reduce((x,y)=>x+y,0)-Object.values(a.cost).reduce((x,y)=>x+y,0))[0];
  pay(best.cost);
  if(!state.player.gear) state.player.gear = {weapon:0,armor:0,trinket:0};
  const mhMult = hasTech('meisterhandwerk') ? 1.5 : 1;
  Object.keys(best.bonus).forEach(k=>{ state.player.gear[k] = (state.player.gear[k]||0)+Math.round(best.bonus[k]*mhMult); });
  sfxBuildDone();
  toast(`${best.label} geschmiedet und angelegt!`);
  logEvent(`⚒️ ${best.label} für dich geschmiedet (per Ziehen).`);
  updateHUD(); saveGame(); renderCharacterWindow();
}
function renderInventoryFood(){
  const wrap = document.getElementById('invFoodList'); wrap.innerHTML='';
  let anyFood = false;
  FOOD_ITEMS.forEach(item=>{
    const count = state.inventory[item.key]||0;
    if(count<=0) return;
    anyFood = true;
    const row = document.createElement('div'); row.className='techItem';
    row.innerHTML = `<div class="techTop"><span class="techName">${item.label} (${count})</span></div><div class="techDesc">${item.restore}</div>`;
    const btn = document.createElement('button'); btn.textContent = item.key==='potion' ? 'Trinken' : 'Essen';
    btn.onclick = ()=>{ consumeFood(item.key); renderInventorySlots(); renderInventoryFood(); };
    row.appendChild(btn);
    wrap.appendChild(row);
  });
  if(!anyFood){
    const none = document.createElement('div'); none.className='desc'; none.textContent = 'Nichts zu essen oder trinken im Vorrat.'; wrap.appendChild(none);
  }
}
/* ---------- Reiter im Charakterfenster ----------
   Charakter (P) und Inventar (U) teilen sich dasselbe Fenster, öffnen aber
   den jeweils passenden Reiter. Vorher rief openInventory() schlicht
   openCharacter() auf — beide Tasten zeigten dieselbe Ansicht, und das
   Inventar lag unsichtbar am Ende einer langen Liste. */
const CHAR_TABS = ['charakter','inventar','faehigkeiten'];
let charTabAktiv = 'charakter';
/* Sortierung der Lagerkiste, wird über das Schließen hinweg gemerkt. */
let kistenSortierung = 'menge';

function switchCharTab(name){
  if(!CHAR_TABS.includes(name)) name = 'charakter';
  charTabAktiv = name;
  document.querySelectorAll('#charTabs .wizTab').forEach(t=>
    t.classList.toggle('active', t.dataset.chartab === name));
  document.querySelectorAll('.charPane').forEach(p=>
    p.classList.toggle('hidden', p.dataset.charpane !== name));
  // Nach oben scrollen, sonst landet man im vorherigen Reiter mittendrin
  const panel = document.querySelector('#characterOverlay .panel');
  if(panel) panel.scrollTop = 0;
}
function initCharTabs(){
  document.querySelectorAll('#charTabs .wizTab').forEach(t=>{
    t.onclick = ()=>{ sfxEvent(); switchCharTab(t.dataset.chartab); };
  });
}
function openInventory(){ openCharacter(); switchCharTab('inventar'); }
function closeInventory(){ closeCharacter(); }

function renderAttributePoints(wrap, character, refreshFn){
  if((character.unspentPoints||0)<=0) return;
  const row = document.createElement('div'); row.style.cssText='margin-top:6px;font-size:11px;';
  const label = document.createElement('div'); label.style.cssText='font-weight:800;color:#8a6f2c;margin-bottom:4px;';
  label.textContent = '✨ '+character.unspentPoints+' freie Attributpunkte';
  row.appendChild(label);
  const btnRow = document.createElement('div'); btnRow.className='apRow'; btnRow.style.flexWrap='wrap';
  [['hp','❤️ LP'],['atk','⚔️ Angriff'],['def','🛡️ Verteidigung'],['spd','🏃 Tempo']].forEach(([key,lbl])=>{
    const b = document.createElement('button'); b.textContent='+'+lbl;
    b.onclick = ()=>{
      character.unspentPoints--;
      character.allocatedStats = character.allocatedStats || {hp:0,atk:0,def:0,spd:0};
      character.allocatedStats[key] = (character.allocatedStats[key]||0)+1;
      saveGame(); refreshFn();
    };
    btnRow.appendChild(b);
  });
  row.appendChild(btnRow);
  wrap.appendChild(row);
}
function renderAbilityList(wrap, cls, level){
  if(!cls) return;
  const list = CLASS_ABILITIES[cls]||[];
  const abWrap = document.createElement('div'); abWrap.style.cssText='margin-top:6px;font-size:10.5px;';
  const title = document.createElement('div'); title.style.cssText='font-weight:800;color:#5a5138;margin-bottom:2px;'; title.textContent='Fähigkeiten:';
  abWrap.appendChild(title);
  list.forEach(a=>{
    const unlocked = a.lvl<=(level||1);
    const line = document.createElement('div');
    line.style.cssText = 'opacity:'+(unlocked?'1':'.45')+';';
    line.textContent = (unlocked?'✅ ':'🔒 Lv.'+a.lvl+' ') + a.name;
    abWrap.appendChild(line);
  });
  wrap.appendChild(abWrap);
}
function renderCharClassEditor(){
  const pcWrap = document.getElementById('charClassEditor'); pcWrap.innerHTML='';
  if(state.player.advClass){
    if((state.classScrolls||0)>0){
      const scrollBtn = document.createElement('button');
      scrollBtn.textContent = '📜 Schriftrolle nutzen — Klasse neu wählen ('+state.classScrolls+')';
      scrollBtn.className = 'secondary';
      scrollBtn.onclick = ()=>{
        state.classScrolls--;
        state.player.advClass = null;
        sfxEvent(); toast('📜 Schriftrolle verbraucht — wähle deine neue Klasse.');
        saveGame(); renderCharacterWindow();
      };
      pcWrap.appendChild(scrollBtn);
    } else {
      const hint = document.createElement('div'); hint.className='desc'; hint.style.margin='0';
      hint.textContent = 'Nur mit einer Klassen-Schriftrolle (seltener Fund, ~3% Kampf-Beute oder Dungeon-Truhe) neu wählbar.';
      pcWrap.appendChild(hint);
    }
  } else {
    const label = document.createElement('div'); label.className='desc'; label.style.margin='0 0 6px';
    label.textContent = 'Wähle deine Abenteuer-Klasse — du kämpfst als vierte Kraft immer mit in der Party.';
    pcWrap.appendChild(label);
    const pcRow = document.createElement('div'); pcRow.className='apRow'; pcRow.style.flexWrap='wrap';
    ADVENTURE_CLASSES.forEach(cls=>{
      const b = document.createElement('button'); b.textContent = ADV_CLASS_ICON[cls]+' '+cls;
      b.title = ADV_CLASS_DESC[cls];
      b.onclick = ()=>{ state.player.advClass = cls; grantStartingGear(state.player, cls); sfxEvent(); toast('Du bist jetzt '+ADV_CLASS_ICON[cls]+' '+cls+'! Startausrüstung erhalten.'); saveGame(); renderCharacterWindow(); };
      pcRow.appendChild(b);
    });
    pcWrap.appendChild(pcRow);
  }
}
function renderCharacterWindow(){
  const pst = playerCombatStats();
  const plvl = state.player.level||1; const pxpNeed = xpToNext(plvl); const pxpPct = plvl>=LEVEL_CAP ? 100 : clamp(((state.player.xp||0)/pxpNeed)*100,0,100);
  const infoWrap = document.getElementById('charClassInfo'); infoWrap.innerHTML='';
  if(pst){
    const row = document.createElement('div'); row.className='techItem';
    row.innerHTML = `<div class="techTop"><span class="techName">${ADV_CLASS_ICON[state.player.advClass]} ${state.player.advClass}</span><span>Lv.${plvl}</span></div>
      <div class="techDesc">❤️ ${pst.hp} · ⚔️ ${pst.atk} · 🛡️ ${pst.def} · 🏃 ${pst.spd}${pst.heal?' · 💚 '+pst.heal:''}</div>
      <div class="miniBar"><div class="miniBarFill" style="width:${pxpPct}%;background:#e8a94d;"></div></div>`;
    renderAttributePoints(row, state.player, renderCharacterWindow);
    infoWrap.appendChild(row);
  }
  renderCharClassEditor();
  const slotsWrap = document.getElementById('charEquipSlots'); slotsWrap.innerHTML='';
  const pg = state.player.gear || {weapon:0,armor:0,trinket:0};
  const SLOT_DEFS = [
    ['weapon','Waffe'], ['kopf','Kopf'], ['oberkoerper','Oberkörper'],
    ['unterkoerper','Unterkörper'], ['schild','Schild'], ['trinket','Accessoire']
  ];
  SLOT_DEFS.forEach(([key,label])=>{
    const val = pg[key]||0;
    const slot = document.createElement('div'); slot.className='equipSlot'+(val>0?' filled':'')+' dropzone';
    slot.title = 'Ein Material aus dem Inventar hierher ziehen, um passende Ausrüstung zu schmieden';
    slot.dataset.slotKey = key;
    const iconCanvas = document.createElement('canvas'); iconCanvas.width=48; iconCanvas.height=48; iconCanvas.className='esIconCanvas';
    slot.appendChild(iconCanvas);
    const lbl = document.createElement('span'); lbl.className='esLabel'; lbl.textContent=label; slot.appendChild(lbl);
    const valSpan = document.createElement('span'); valSpan.className='esVal'; valSpan.textContent = val>0?'+'+val:'—'; slot.appendChild(valSpan);
    slot.addEventListener('dragover', (e)=>{ e.preventDefault(); slot.classList.add('dragover'); });
    slot.addEventListener('dragleave', ()=>{ slot.classList.remove('dragover'); });
    slot.addEventListener('drop', (e)=>{
      e.preventDefault(); slot.classList.remove('dragover');
      craftForSlotFromDrag(key);
    });
    slotsWrap.appendChild(slot);
    drawEquipIcon(iconCanvas, key==='trinket'?'trinket':key, val);
  });
  renderInventorySlots();
  renderInventoryFood();
  initCharTabs();
  const abilWrap = document.getElementById('charAbilityList'); abilWrap.innerHTML='';
  if(state.player.advClass) renderAbilityList(abilWrap, state.player.advClass, plvl);
  else abilWrap.innerHTML = '<div class="desc">Wähle zuerst eine Klasse im Kolonie-Panel.</div>';
}
function openCharacter(){
  openOverlay('characterOverlay');
  // P zeigt immer den Charakter-Reiter; U schaltet danach auf Inventar um
  switchCharTab('charakter');
}
function closeCharacter(){ closeOverlay('characterOverlay'); }

function renderJournalWindow(){
  const wrap = document.getElementById('journalList'); wrap.innerHTML='';
  const entries = (state.eventLog||[]).slice(-40).reverse();
  if(entries.length===0){
    const none=document.createElement('div'); none.className='desc'; none.textContent='Noch nichts zu berichten.'; wrap.appendChild(none);
  } else {
    entries.forEach(line=>{
      const row = document.createElement('div'); row.className='techItem';
      row.style.fontSize='12px'; row.style.padding='7px 10px';
      row.textContent = line;
      wrap.appendChild(row);
    });
  }
}
function openJournal(){ openOverlay('journalOverlay'); }
function closeJournal(){ closeOverlay('journalOverlay'); }

const MAIN_QUEST_STAGES = [
  { title:'Ein neuer Anfang', desc:'Farholt ist nur eine Handvoll Zelte und ein Feuer. Errichte dein erstes Gebäude, um den Grundstein zu legen.',
    check: ()=> state.buildings.length>0,
    reward: ()=>{ state.inventory.wood=(state.inventory.wood||0)+10; toast('🪵 +10 Holz für den Anfang!'); } },
  { title:'Das erste Bündnis', desc:'In der Wildnis leben Wesen, die sich zähmen lassen. Fange deine erste Kreatur und beginne dein Feldbuch.',
    check: ()=> Object.keys(state.collection).length>0,
    reward: ()=>{ state.inventory.trap=(state.inventory.trap||0)+3; toast('🪤 +3 Fallen als Belohnung!'); } },
  { title:'Der eigene Weg', desc:'Krieger, Magier, Heiler oder Waldläufer — wähle deine Abenteuer-Klasse im Kolonie-Panel und mache sie zu deiner eigenen.',
    check: ()=> !!state.player.advClass,
    reward: ()=>{ state.inventory.potion=(state.inventory.potion||0)+3; toast('🧪 +3 Heiltränke als Belohnung!'); } },
  { title:'Die Ruinen rufen', desc:'Alte Steine erzählen alte Geschichten. Reise in eine Ruinen-Region und entdecke ein Fragment ihrer Vergangenheit.',
    check: ()=> (state.loreDiscovered||[]).some(id=>id.startsWith('ruins_')),
    reward: ()=>{ state.inventory.gold=(state.inventory.gold||0)+5; toast('🟡 +5 Gold als Belohnung!'); } },
  { title:'In die Tiefe', desc:'Unter Farholt und seiner Umgebung liegen Dungeons und Höhlen. Besiege einen Wächter und beweise deine Stärke.',
    check: ()=> !!state.quests.bossDefeated,
    reward: ()=>{ state.classScrolls=(state.classScrolls||0)+1; toast('📜 +1 Klassen-Schriftrolle als Belohnung!'); } },
  { title:'Die Wandlung', desc:'Manche Kreaturen verändern sich, wenn sie genug erlebt haben. Führe eine deiner Kreaturen zur ersten Entwicklung.',
    check: ()=> !!state.quests.evolutionSeen,
    reward: ()=>{ state.inventory.metal=(state.inventory.metal||0)+5; toast('⚙️ +5 Metall als Belohnung!'); } },
  { title:'Farholts Geheimnis', desc:'Du hast viel erreicht. Besiege insgesamt 20 wilde Kreaturen und beweise, dass Farholt eine wahre Kolonie geworden ist.',
    check: ()=> (state.quests.killCount||0)>=20,
    reward: ()=>{ state.inventory.gold=(state.inventory.gold||0)+20; state.classScrolls=(state.classScrolls||0)+1; toast('🏆 +20 Gold und eine Schriftrolle — Hauptquest abgeschlossen!'); } }
];
function checkMainQuestProgress(){
  if(state.quests.mainCompleted) return;
  const stage = MAIN_QUEST_STAGES[state.quests.mainStage];
  if(!stage) return;
  if(stage.check()){
    stage.reward();
    logEvent('📖 Hauptquest: "'+stage.title+'" abgeschlossen.');
    state.quests.mainStage++;
    if(state.quests.mainStage>=MAIN_QUEST_STAGES.length){
      state.quests.mainCompleted = true;
      showStoryDialog('🏆 Farholts Geheimnis', 'Du hast die Hauptquest abgeschlossen! Farholt ist von einer Handvoll Zelten zu einer wahren Kolonie gewachsen — und du hast dabei mehr über diese Welt gelernt, als die meisten je erfahren werden. Deine Geschichte geht trotzdem weiter — es gibt immer mehr zu entdecken, zu bauen und zu erforschen.', [{label:'Weiter geht\'s!', action:()=>{}}]);
    } else {
      const next = MAIN_QUEST_STAGES[state.quests.mainStage];
      showStoryDialog('📖 '+stage.title, 'Abgeschlossen! Neues Ziel: "'+next.title+'" — '+next.desc, [{label:'Verstanden', action:()=>{}}]);
    }
    saveGame();
  }
}
const SIDE_QUEST_TEMPLATES = [
  { type:'collect', res:'wood', label:'Holz sammeln', icon:'🪵', amtRange:[15,30] },
  { type:'collect', res:'stone', label:'Stein sammeln', icon:'🪨', amtRange:[15,30] },
  { type:'collect', res:'berries', label:'Beeren sammeln', icon:'🫐', amtRange:[10,20] },
  { type:'collect', res:'fiber', label:'Fasern sammeln', icon:'🌾', amtRange:[10,20] },
  { type:'kill', label:'wilde Kreaturen besiegen', icon:'⚔️', amtRange:[3,7] },
  { type:'catch', label:'Kreaturen fangen', icon:'🪤', amtRange:[1,3] },
  { type:'cook', label:'Mahlzeiten kochen', icon:'🍳', amtRange:[2,5] }
];
function generateSideQuest(){
  if((state.quests.side||[]).length>=3) return;
  const tpl = SIDE_QUEST_TEMPLATES[Math.floor(Math.random()*SIDE_QUEST_TEMPLATES.length)];
  const amt = tpl.amtRange[0]+Math.floor(Math.random()*(tpl.amtRange[1]-tpl.amtRange[0]+1));
  const rewardGold = 2+Math.floor(amt*0.3);
  const q = { id:'q'+Date.now()+Math.floor(Math.random()*1000), type:tpl.type, res:tpl.res||null, label:tpl.label, icon:tpl.icon, amt, startCount: tpl.type==='collect' ? (state.inventory[tpl.res]||0) : 0, startKills: tpl.type==='kill' ? (state.quests.killCount||0) : 0, rewardGold };
  state.quests.side.push(q);
  toast('📋 Neue Nebenquest: '+tpl.icon+' '+amt+'x '+tpl.label);
  logEvent('📋 Neue Nebenquest angenommen: '+tpl.label+' ('+amt+')');
}
function sideQuestProgress(q){
  if(q.type==='collect') return clamp((state.inventory[q.res]||0)-q.startCount, 0, q.amt);
  if(q.type==='kill') return clamp((state.quests.killCount||0)-q.startKills, 0, q.amt);
  if(q.type==='catch') return clamp(Object.keys(state.collection).length - (q.startCatch||0), 0, q.amt);
  if(q.type==='cook') return clamp((q.cookedCount||0), 0, q.amt);
  return 0;
}
function checkSideQuests(){
  if(!state.quests.side) return;
  state.quests.side.forEach(q=>{
    if(q.startCatch==null && q.type==='catch') q.startCatch = Object.keys(state.collection).length - 1;
  });
  const done = state.quests.side.filter(q=>sideQuestProgress(q)>=q.amt);
  if(done.length>0){
    done.forEach(q=>{
      state.inventory.gold = (state.inventory.gold||0)+q.rewardGold;
      bumpResource('gold');
      toast('✅ Nebenquest erfüllt: '+q.label+'! +'+q.rewardGold+' 🟡 Gold');
      logEvent('✅ Nebenquest abgeschlossen: '+q.label+' (+'+q.rewardGold+' Gold)');
    });
    state.quests.side = state.quests.side.filter(q=>sideQuestProgress(q)<q.amt);
    saveGame();
  }
}
const STARTER_GOALS = [
  { icon:'🪵', label:'Errichte dein erstes Gebäude', check: ()=> state.buildings.length>0 },
  { icon:'🔥', label:'Baue ein Lagerfeuer', check: ()=> state.buildings.some(b=>b.type==='campfire'&&b.built) },
  { icon:'🛏️', label:'Baue ein Zelt zum Schlafen', check: ()=> state.buildings.some(b=>b.type==='tent'&&b.built) },
  { icon:'👥', label:'Nimm einen Kolonisten auf', check: ()=> state.colonists.length>0 },
  { icon:'⚔️', label:'Wähle deine Abenteuer-Klasse', check: ()=> !!state.player.advClass },
  { icon:'🐾', label:'Fange deine erste Kreatur', check: ()=> Object.keys(state.collection).length>0 },
  { icon:'🛠️', label:'Baue eine Werkbank', check: ()=> state.buildings.some(b=>b.type==='workbench'&&b.built) },
  { icon:'🗺️', label:'Bereise eine andere Region', check: ()=> !!state.visitedOtherRegion }
];
function renderGoalsWindow(){
  const wrap = document.getElementById('goalsList'); wrap.innerHTML='';

  const mainH = document.createElement('h3'); mainH.textContent='📖 Hauptquest'; wrap.appendChild(mainH);
  if(state.quests.mainCompleted){
    const row = document.createElement('div'); row.className='techItem done';
    row.innerHTML = `<div class="techTop"><span class="techName">🏆 Farholts Geheimnis — abgeschlossen!</span></div>`;
    wrap.appendChild(row);
  } else {
    const stage = MAIN_QUEST_STAGES[state.quests.mainStage];
    if(stage){
      const row = document.createElement('div'); row.className='techItem';
      row.innerHTML = `<div class="techTop"><span class="techName">${state.quests.mainStage+1}/${MAIN_QUEST_STAGES.length} ${stage.title}</span></div><div class="techDesc">${stage.desc}</div>`;
      wrap.appendChild(row);
    }
  }

  const sideH = document.createElement('h3'); sideH.style.marginTop='14px'; sideH.textContent='📋 Nebenquests'; wrap.appendChild(sideH);
  const sideList = state.quests.side||[];
  if(sideList.length===0){
    const none = document.createElement('div'); none.className='desc'; none.textContent='Gerade keine offenen Nebenquests — bald kommt eine neue.'; wrap.appendChild(none);
  } else {
    sideList.forEach(q=>{
      const prog = sideQuestProgress(q);
      const row = document.createElement('div'); row.className='techItem';
      row.innerHTML = `<div class="techTop"><span class="techName">${q.icon} ${q.label}</span><span>${prog}/${q.amt}</span></div>
        <div class="miniBar"><div class="miniBarFill" style="width:${clamp(prog/q.amt*100,0,100)}%;background:#e8a94d;"></div></div>
        <div class="techDesc">Belohnung: +${q.rewardGold} 🟡 Gold</div>`;
      wrap.appendChild(row);
    });
  }

  const goalH = document.createElement('h3'); goalH.style.marginTop='14px'; goalH.textContent='🎯 Erste Schritte'; wrap.appendChild(goalH);
  let doneCount = 0;
  STARTER_GOALS.forEach(g=>{
    const done = g.check();
    if(done) doneCount++;
    const row = document.createElement('div'); row.className='techItem'+(done?' done':'');
    row.innerHTML = `<div class="techTop"><span class="techName">${done?'✅':g.icon} ${g.label}</span></div>`;
    wrap.appendChild(row);
  });
  const desc = document.getElementById('goalsDesc');
  if(desc) desc.textContent = `Hauptquest, Nebenquests und deine ersten Schritte in Farholt. (${doneCount}/${STARTER_GOALS.length} erste Schritte)`;
}
function openGoals(){ openOverlay('goalsOverlay'); }
function closeGoals(){ closeOverlay('goalsOverlay'); }

function openMainMenu(){ openOverlay('mainMenuOverlay'); }
function closeMainMenu(){ closeOverlay('mainMenuOverlay'); }

/* ---------- Pausenmenü ----------
   Die Mechanik war schon da: paused folgt aus gameMode, und jedes offene
   Fenster hält die Schleife an. Es fehlte nur die Oberfläche — und ein Weg
   zurück zum Titelbildschirm, den es bisher überhaupt nicht gab. */
function pauseFortsetzen(){
  closeAllOverlays();
  setMode('micro');
}

async function pauseZumTitel(){
  await saveGame();
  showStoryDialog('🏔️ Zum Titelbildschirm',
    'Dein Fortschritt wurde gespeichert. Zurück zum Titelbildschirm?',
    [
      { label:'Ja, zurück zum Titel', action: async ()=>{
          closeAllOverlays();
          /* Reihenfolge ist wichtig: erst alle Fenster zu, dann der Modus,
             zuletzt das Titelbild. Andernfalls läuft die Welt weiter,
             während der Titel schon darüberliegt. */
          setMode('boot');
          alleTastenLoslassen();
          showTitleScreen();
        } },
      { label:'Abbrechen', secondary:true, action: ()=>{ openMainMenu(); } },
    ]);
}

function initPauseMenu(){
  const on = (id, fn)=>{ const el = document.getElementById(id); if(el) el.onclick = fn; };
  on('pauseResume',  ()=>{ sfxEvent(); pauseFortsetzen(); });
  on('pauseOptions', ()=>{ sfxEvent(); closeMainMenu(); openOptions(); });
  on('pauseSaveQuit',()=>{ sfxEvent(); closeMainMenu(); pauseZumTitel(); });
}
async function reloadGameMidSession(key){
  const hadSave = await loadGame(key);
  if(!hadSave) return false;
  worldSeedBase = worldSeed;
  buildWorld();
  homeCtx = { tileGrid, objects, respawnQueue, wildMonsters, groundItems, highlandAnchor, meadowAnchor, seed:worldSeed, biome:'wildwood', regionId:'C', huntHotspots, pathTiles };
  regionsRegistry = { C: homeCtx };
  currentBiome = 'wildwood';
  clearEdgeCorridors(homeCtx);
  dungeonCtx = null; dungeonReturn = null;
  if(!state.player.regionId || state.player.regionId === 'DUNGEON'){
    const wasInDungeon = state.player.regionId === 'DUNGEON';
    state.player.regionId = 'C';
    state.player.x = Math.floor(WORLD_W/2); state.player.y = Math.floor(WORLD_H/2);
    if(wasInDungeon) toast('🕳️ Dungeons/Höhlen werden nicht gespeichert — du startest zuhause.');
  }
  if(state.player.regionId !== 'C' && state.player.regionId !== 'DUNGEON'){
    const ctx = getOrCreateRegion(state.player.regionId);
    swapAmbientTo(ctx);
  }
  snapMoveAnimToPlayer();
  camera.x = state.player.x - VIEW_W/2; camera.y = state.player.y - VIEW_H/2;
  /* Alle Fenster abräumen, bevor die Welt wieder läuft. Ohne das blieb das
     Hauptmenü hinter der Speicherplatz-Liste offen stehen, während der Modus
     schon auf 'micro' sprang — die Welt lief also hinter einem Menü weiter. */
  closeAllOverlays();
  setMode('micro');
  alignFurnitureOnce();
  updateHUD(); updateLocationLabel(); updateDayNightIndicator();
  startMusicTrack(atDungeon() ? 'dungeon' : 'colony');
  return true;
}

/* ---- Optionen ---- */
function updateOptStyleButtons(){
  const mouseBtn = document.getElementById('optStyleMouse');
  const keysBtn  = document.getElementById('optStyleKeys');
  const desc     = document.getElementById('optStyleDesc');
  if(!mouseBtn) return;
  mouseBtn.classList.toggle('active', !keyboardCameraEnabled);
  keysBtn.classList.toggle('active', keyboardCameraEnabled);
  desc.textContent = keyboardCameraEnabled
    ? 'Tastatur bewegt die Kamera, die Figur folgt Mausklicks.'
    : 'Tastatur bewegt die Figur direkt, Klicken funktioniert weiterhin.';
}
function openOptions(){
  openOverlay('optionsOverlay');
  listeningFor = null;
  renderKeybindEditor(document.getElementById('keybindEditor'));
  updateOptStyleButtons();
}
function closeOptions(){
  closeOverlay('optionsOverlay');
  listeningFor = null;
}

/* ============================================================
   Arbeitsübersicht: Kolonisten als Zeilen, Arbeitsarten als Spalten.
   Ein Klick auf eine Zelle schaltet die Priorität weiter.
============================================================ */
function renderWorkTable(){
  const tbl = document.getElementById('workTable');
  if(!tbl) return;
  tbl.innerHTML = '';
  if(!state.colonists.length){
    tbl.innerHTML = '<tr><td class="wtEmpty">Noch keine Kolonisten. Errichte ein Bett, um Gefährten aufzunehmen.</td></tr>';
    document.getElementById('workLegend').textContent = '';
    return;
  }
  // Kopfzeile
  const head = document.createElement('tr');
  const corner = document.createElement('th'); corner.className='wtNameCol'; corner.textContent='Kolonist';
  head.appendChild(corner);
  WORK_TYPES.forEach(w=>{
    const th = document.createElement('th'); th.className='wtHead';
    th.innerHTML = `<span class="wtIcon">${w.icon}</span><span class="wtLabel">${w.label}</span>`;
    th.title = w.label;
    head.appendChild(th);
  });
  tbl.appendChild(head);
  // Eine Zeile je Kolonist
  state.colonists.forEach(c=>{
    const prio = ensurePriorities(c);
    const tr = document.createElement('tr');
    const nameCell = document.createElement('td'); nameCell.className='wtName';
    const busy = c.sleeping ? '💤' : (c.job ? '⚙️' : '');
    nameCell.innerHTML = `<span class="wtNameMain">${c.name}</span>` +
      `<span class="wtRole">${workLabelOf(c)}${busy?' '+busy:''}</span>`;
    nameCell.onclick = ()=>{ selectColonist(c.id); closeWork(); };
    nameCell.title = 'Anklicken, um zu diesem Kolonisten zu springen';
    tr.appendChild(nameCell);
    WORK_TYPES.forEach(w=>{
      const td = document.createElement('td'); td.className='wtCellWrap';
      const btn = document.createElement('button'); btn.type='button'; btn.className='wtCell';
      const setLook = ()=>{
        const v = prio[w.id];
        btn.textContent = v===0 ? '–' : v;
        btn.dataset.level = v;
        btn.title = `${c.name} · ${w.label}: ${v===0?'deaktiviert':'Priorität '+v}`;
      };
      setLook();
      btn.onclick = ()=>{
        prio[w.id] = (prio[w.id]+1) % 4;
        setLook();
        c.state='idle'; c.path=[]; if(c.job) releaseJob(c);
        saveGame();
        if(!document.getElementById('colonyOverlay').classList.contains('hidden')) renderColony();
      };
      td.appendChild(btn);
      tr.appendChild(td);
    });
    tbl.appendChild(tr);
  });
  // Zusammenfassung: wie viele arbeiten gerade woran
  const counts = {};
  WORK_TYPES.forEach(w=>{ counts[w.id] = state.colonists.filter(c=>ensurePriorities(c)[w.id]===1).length; });
  document.getElementById('workLegend').innerHTML =
    WORK_TYPES.map(w=>`<span class="wlItem">${w.icon} ${w.label}: <b>${counts[w.id]}</b></span>`).join('');
}
function openWork(){
  openOverlay('workOverlay');
}
function closeWork(){
  closeOverlay('workOverlay');
}

/* ---- Alle Fenster einmalig registrieren ---- */
 ['dexOverlay', renderDex],
 ['characterOverlay', renderCharacterWindow],
 ['journalOverlay', renderJournalWindow],
 ['goalsOverlay', renderGoalsWindow],
 ['colonyOverlay', renderColony],
 ['workOverlay', renderWorkTable],
 ['worldMapOverlay', renderWorldMap],
 ['researchOverlay', renderResearch],
 ['villageShopOverlay', renderVillageShop],
 ['chronikOverlay', renderChronik],
 ['mainMenuOverlay', null], ['slotsOverlay', null], ['optionsOverlay', null],
 ['overworldOverlay', null], ['storyOverlay', null], ['interiorOverlay', null],
 ['introOverlay', null]

/* ---- Spielstil-Auswahl auf dem Startbildschirm ---- */
function updateStartStyleButtons(){
  const m = document.getElementById('startStyleMouse');
  const c = document.getElementById('startStyleClick');
  if(!m) return;
  m.classList.toggle('active', !keyboardCameraEnabled);
  c.classList.toggle('active', keyboardCameraEnabled);
}
const ssMouse = document.getElementById('startStyleMouse');
const ssClick = document.getElementById('startStyleClick');
const replayIntroBtn = document.getElementById('optReplayIntro');
const alignBtn = document.getElementById('optAlignFurniture');
function slotKey(n){ return 'wildwood-slot-'+n; }
async function getMetaByKey(key){
  try{
    const res = await window.storage.get(key);
    if(!res || !res.value) return null;
    const data = JSON.parse(res.value);
    if(!data.state) return null;
    const colCount = (data.state.colonists||[]).length;
    const lvl = (data.state.player && data.state.player.level) || 1;
    const dateStr = data.savedAt ? new Date(data.savedAt).toLocaleString('de-DE', {day:'2-digit',month:'2-digit',year:'2-digit',hour:'2-digit',minute:'2-digit'}) : '';
    return { colonyName: data.state.colonyName || 'Farholt', colCount, lvl, dateStr };
  }catch(e){ return null; }
}
async function getSlotMeta(n){ return getMetaByKey(slotKey(n)); }
async function renderSlotsList(mode){
  const wrap = document.getElementById('slotsList'); wrap.innerHTML='<div class="desc">Lade Speicherplätze…</div>';
  document.getElementById('slotsTitle').textContent = mode==='save' ? '💾 Speichern' : '📂 Laden';
  document.getElementById('slotsDesc').textContent = mode==='save' ? 'Wähle einen der 3 Speicherplätze zum Überschreiben.' : 'Wähle einen der 3 Speicherplätze zum Laden.';
  const metas = await Promise.all([1,2,3].map(n=>getSlotMeta(n)));
  wrap.innerHTML='';
  metas.forEach((meta,i)=>{
    const n = i+1;
    const card = document.createElement('div'); card.className='slotCard'+(meta?'':' empty');
    const info = document.createElement('div'); info.className='slotCardInfo';
    if(meta){
      info.innerHTML = `<div class="slotCardName">Platz ${n} — ${meta.colonyName}</div><div class="slotCardMeta">Lv.${meta.lvl} · ${meta.colCount} Kolonisten${meta.dateStr?' · '+meta.dateStr:''}</div>`;
    } else {
      info.innerHTML = `<div class="slotCardName">Platz ${n} — leer</div><div class="slotCardMeta">Noch kein Spielstand gespeichert</div>`;
    }
    card.appendChild(info);
    const btns = document.createElement('div'); btns.className='slotCardBtns';
    if(mode==='save'){
      const btn = document.createElement('button'); btn.textContent = meta ? 'Überschreiben' : 'Speichern';
      btn.onclick = async ()=>{
        if(meta){
          showStoryDialog('💾 Überschreiben?', `Platz ${n} ("${meta.colonyName}") wird überschrieben und ist danach unwiderruflich weg. Fortfahren?`, [
            { label:'Überschreiben', action: async ()=>{ await saveGame(slotKey(n)); sfxEvent(); toast('💾 Auf Platz '+n+' gespeichert!'); closeSlots(); } },
            { label:'Abbrechen', secondary:true, action:()=>{ openSlotsOverlay('save'); } }
          ]);
        } else {
          await saveGame(slotKey(n)); sfxEvent(); toast('💾 Auf Platz '+n+' gespeichert!'); closeSlots();
        }
      };
      btns.appendChild(btn);
    } else {
      const btn = document.createElement('button'); btn.textContent = 'Laden'; btn.disabled = !meta;
      btn.onclick = ()=>{
        showStoryDialog('📂 Laden?', `Platz ${n} wird geladen — alle ungespeicherten Änderungen gehen verloren. Fortfahren?`, [
          { label:'📂 Laden', action: async ()=>{ const ok = await reloadGameMidSession(slotKey(n)); sfxEvent(); toast(ok ? '📂 Platz '+n+' geladen!' : '⚠️ Fehler beim Laden.'); closeSlots(); } },
          { label:'Abbrechen', secondary:true, action:()=>{ openSlotsOverlay('load'); } }
        ]);
      };
      btns.appendChild(btn);
    }
    if(meta){
      const delBtn = document.createElement('button'); delBtn.textContent = '🗑️'; delBtn.className='secondary'; delBtn.title = 'Spielstand löschen';
      delBtn.onclick = ()=>{
        showStoryDialog('🗑️ Platz löschen?', `Platz ${n} ("${meta.colonyName}") wird unwiderruflich gelöscht. Fortfahren?`, [
          { label:'🗑️ Löschen', action: async ()=>{ await window.storage.delete(slotKey(n)); await renderSlotsList(mode); } },
          { label:'Abbrechen', secondary:true, action:()=>{ openSlotsOverlay(mode); } }
        ]);
      };
      btns.appendChild(delBtn);
    }
    card.appendChild(btns);
    wrap.appendChild(card);
  });
}
function openSlotsOverlay(mode){
  openOverlay('slotsOverlay');
  renderSlotsList(mode);
  document.getElementById('slotsOverlay').classList.remove('hidden');
}
function closeSlots(){ closeOverlay('slotsOverlay'); }

/* ============================================================
   Colony panel
============================================================ */
function housingCap(){ return state.buildings.filter(b=>b.type==='tent' && b.built && (b.regionId||'C')==='C').length; }
function recruitColonist(){
  if(state.colonists.length>=housingCap()) return null;
  const used = new Set(state.colonists.map(c=>c.name));
  const c = makeColonist(used);
  state.colonists.push(c); return c;
}
function refine(rawKey, refinedKey, buildingType){
  const has = state.buildings.some(b=>b.type===buildingType && b.built);
  if(!has || state.inventory[rawKey]<2) return false;
  state.inventory[rawKey]-=2;
  let amt = 1;
  if(refinedKey==='planks' && state.buildings.some(b=>b.type==='schreinerei' && b.built) && Math.random()<0.4) amt += 1;
  addResource(refinedKey, amt);
  updateHUD(); saveGame(); return true;
}
function moodColor(m){ return m>66?'#3d8a3d':(m>33?'#c9a23d':'#b0392f'); }
let colonyResTab = 0;   // gemerkter Reiter im Vorräte-Menü
let colonyOpenId = null; // welcher Kolonist ist aufgeklappt
function renderColony(){
  const resWrap = document.getElementById('resGrid'); resWrap.innerHTML='';
  const RES_CATEGORIES = [
    { label:'🪵 Grundstoffe', keys:['wood','stone','berries','ore','fiber'] },
    { label:'🛠️ Handwerksmaterial', keys:['planks','metal','cloth','trap','copper','silver','gold','potion'] },
    { label:'💎 Seltene Materialien', keys:['holz_kiefer','holz_dunkel','holz_bruch','stein_marmor','stein_sand','erz_titan'] },
    { label:'🌿 Landwirtschaft', keys:['gemuese','getreide','kraeuter'] },
    { label:'🍖 Fleischsorten', keys:['meat_fire','meat_water','meat_grass','meat_electric','meat_ice','meat_rock','meat_poison','meat_ghost','meat_flying','meat_bug','meat_normal','meat_dragon'], compact:true },
    { label:'🍽️ Mahlzeiten', keys:['meal_simple','meal_veggie','meal_deluxe','meal_brot'] }
  ];
  // Vorräte als Reiter statt endloser Liste
  const tabBar = document.createElement('div'); tabBar.className='resTabs';
  const body = document.createElement('div'); body.className='resTabBody';
  const drawCat = (cat)=>{
    body.innerHTML = '';
    const grid = document.createElement('div'); grid.className = cat.compact ? 'resGrid resGridCompact' : 'resGrid';
    let total = 0;
    cat.keys.forEach(k=>{
      const amount = state.inventory[k]||0; total += amount;
      const div = document.createElement('div'); div.className='resItem'+(amount>0?' hasStock':'');
      div.innerHTML = `<span>${RESOURCE_ICONS[k]} ${RESOURCE_NAMES[k]}</span><span>${amount}</span>`;
      grid.appendChild(div);
    });
    body.appendChild(grid);
    if(total===0){
      const empty = document.createElement('div'); empty.className='desc'; empty.style.marginTop='6px';
      empty.textContent = 'In dieser Kategorie hast du noch nichts eingelagert.';
      body.appendChild(empty);
    }
  };
  RES_CATEGORIES.forEach((cat,i)=>{
    const owned = cat.keys.reduce((s,k)=>s+(state.inventory[k]||0),0);
    const tab = document.createElement('button'); tab.type='button';
    tab.className = 'resTab'+(i===colonyResTab?' active':'')+(owned>0?' hasStock':'');
    tab.innerHTML = `${cat.label}${owned>0?`<span class="rtCount">${owned}</span>`:''}`;
    tab.onclick = ()=>{
      colonyResTab = i;
      tabBar.querySelectorAll('.resTab').forEach((t,j)=>t.classList.toggle('active', j===i));
      drawCat(cat);
    };
    tabBar.appendChild(tab);
  });
  resWrap.appendChild(tabBar);
  resWrap.appendChild(body);
  drawCat(RES_CATEGORIES[colonyResTab] || RES_CATEGORIES[0]);
  document.getElementById('colCount').textContent = state.colonists.length;
  const colWrap = document.getElementById('colonistList'); colWrap.innerHTML='';
  if(state.colonists.length===0){
    colWrap.innerHTML = '<div class="desc">Noch keine Kolonisten. Baue ein Bett — mit genug Nahrung schließen sich Wanderer an.</div>';
  }
  // Kompakte Namensliste — Details erscheinen erst beim Anklicken
  state.colonists.forEach(c=>{
    const sick2 = c.sickUntil && Date.now()<c.sickUntil;
    const lvl2 = c.level||1;
    const row = document.createElement('button'); row.type='button';
    row.className = 'colRow'+(selectedColonistId===c.id?' active':'')+(colonyOpenId===c.id?' expanded':'');
    const rowInParty = (typeof isInParty==='function') ? isInParty(c.id) : false;
    row.innerHTML =
      `<span class="crIcon">${workIconOf(c)}</span>` +
      `<span class="crMain"><span class="crName">${c.name}${sick2?' 🤒':''}${c.sleeping?' 💤':''}</span>` +
      `<span class="crSub">${colonistActivity(c)} · Lv.${lvl2}</span></span>` +
      `<span class="crBars">` +
        `<span class="crBar" title="Laune ${Math.round(c.mood)}"><i style="width:${clamp(c.mood,0,100)}%;background:${moodColor(c.mood)}"></i></span>` +
        `<span class="crBar" title="Hunger ${Math.round(c.hunger)}"><i style="width:${clamp(c.hunger,0,100)}%;background:#c9822c"></i></span>` +
      `</span>` +
      `<span class="crFlags">${rowInParty?'<span class="crParty">⚔</span>':''}${c.advClass?ADV_CLASS_ICON[c.advClass]:''}</span>` +
      `<span class="crArrow">${colonyOpenId===c.id?'▾':'▸'}</span>`;
    row.onclick = ()=>{
      colonyOpenId = (colonyOpenId===c.id) ? null : c.id;
      selectColonist(c.id);
      renderColony();
    };
    colWrap.appendChild(row);
    // Detailansicht nur für den aufgeklappten Kolonisten
    if(colonyOpenId !== c.id) return;
    const detail = document.createElement('div'); detail.className='colDetail';
    const card = document.createElement('div'); card.className='colCardInner';
    const sick = c.sickUntil && Date.now()<c.sickUntil;
    const g = c.gear || {weapon:0,armor:0,trinket:0};
    const gearLine = (g.weapon||g.armor||g.trinket) ? `<div style="font-size:10px;font-weight:700;color:#8a6f2c;margin-top:2px;">${g.weapon?'🗡️+'+g.weapon+' ':''}${g.armor?'🛡️+'+g.armor+' ':''}${g.trinket?'👑+'+g.trinket:''}</div>` : '';
    const relLabel = relationshipLabel(c);
    const relLine = relLabel ? `<div style="font-size:10px;font-weight:700;color:#b0392f;margin-top:2px;">${relLabel}</div>` : '';
    const lvl = c.level||1; const xpNeed = xpToNext(lvl); const xpPct = lvl>=LEVEL_CAP ? 100 : clamp(((c.xp||0)/xpNeed)*100,0,100);
    card.innerHTML = `<div class="ctop"><span class="cname">${workIconOf(c)} ${c.name} <span style="color:#8a6f2c;">Lv.${lvl}</span>${sick?' 🤒':''}</span></div>
      <div class="cback">${c.backstory}</div>
      <div class="skillRow">
        <span class="skillChip">⚔ Nahkampf ${c.skills.Nahkampf}</span>
        <span class="skillChip">🌾 Pflanzenbau ${c.skills.Pflanzenbau}</span>
        <span class="skillChip">🔨 Handwerk ${c.skills.Handwerk}</span>
      </div>
      <div style="font-size:10px;font-weight:700;margin-top:2px;">${lvl>=LEVEL_CAP?'⭐ Max. Level erreicht':'⭐ XP '+Math.round(c.xp||0)+' / '+xpNeed}</div>
      <div class="miniBar"><div class="miniBarFill" style="width:${xpPct}%;background:#e8a94d;"></div></div>
      ${gearLine}
      ${relLine}
      <div style="font-size:10.5px;font-weight:700;margin-top:4px;">Laune ${Math.round(c.mood)} · Hunger ${Math.round(c.hunger)}</div>
      <div class="miniBar"><div class="miniBarFill" style="width:${clamp(c.mood,0,100)}%;background:${moodColor(c.mood)}"></div></div>`;
    card.addEventListener('click', (e)=>{ if(e.target.tagName==='SELECT'||e.target.closest('.advClassRow')) return; selectColonist(c.id); });
    const resetPrio = document.createElement('button');
    resetPrio.className='secondary'; resetPrio.type='button';
    resetPrio.style.cssText='font-size:10px;padding:3px 8px;margin-top:4px;';
    resetPrio.textContent='↺ Prioritäten aus Talenten';
    resetPrio.title='Setzt die Arbeitsprioritäten passend zu den Fertigkeiten dieses Kolonisten';
    resetPrio.onclick = (ev)=>{
      ev.stopPropagation();
      c.priorities = defaultPriorities(c);
      c.state='idle'; c.path=[]; if(c.job) releaseJob(c); saveGame(); renderColony();
    };
    card.appendChild(resetPrio);
    // Arbeitsprioritäten: 0 = aus, 1 = zuerst, 3 = zuletzt
    const prio = ensurePriorities(c);
    const prioWrap = document.createElement('div'); prioWrap.className='prioWrap';
    const prioHead = document.createElement('div'); prioHead.className='prioHead';
    prioHead.textContent = 'Arbeitsprioritäten (1 = zuerst)';
    // Klarstellen: die Rolle ist nur noch Vorlage + Kampfrolle
    const roleNote = document.createElement('div');
    roleNote.style.cssText = 'font-size:9.5px;color:#7a6f4e;margin:2px 0 4px;line-height:1.3;';
    roleNote.textContent = 'Die Rolle setzt nur die Startwerte. Nahkampf ⚔️ und Fernkampf 🏹 bestimmen, wer die Kolonie bei Überfällen verteidigt.';
    prioWrap.appendChild(roleNote);
    prioWrap.appendChild(prioHead);
    const prioGrid = document.createElement('div'); prioGrid.className='prioGrid';
    WORK_TYPES.forEach(w=>{
      const cell = document.createElement('button'); cell.type='button'; cell.className='prioCell';
      const val = prio[w.id];
      cell.innerHTML = `<span class="pcIcon">${w.icon}</span><span class="pcVal">${val===0?'–':val}</span>`;
      cell.title = w.label+' — klicken zum Ändern';
      cell.dataset.level = val;
      cell.onclick = (ev)=>{
        ev.stopPropagation();
        prio[w.id] = (prio[w.id]+1) % 4;   // 0→1→2→3→0
        c.state='idle'; c.path=[]; if(c.job) releaseJob(c);
        saveGame(); renderColony();
      };
      prioGrid.appendChild(cell);
    });
    prioWrap.appendChild(prioGrid);
    card.appendChild(prioWrap);
    const advRow = document.createElement('div'); advRow.className='advClassRow';
    advRow.innerHTML = `<div style="font-size:10px;font-weight:800;color:#5a5138;margin-top:6px;">Abenteuer-Klasse:</div>`;
    if(c.advClass){
      const lockedLine = document.createElement('div');
      lockedLine.style.cssText='font-size:11px;font-weight:800;margin:3px 0;';
      lockedLine.textContent = ADV_CLASS_ICON[c.advClass]+' '+c.advClass+' (festgelegt)';
      advRow.appendChild(lockedLine);
      if((state.classScrolls||0)>0){
        const scrollBtn = document.createElement('button');
        scrollBtn.textContent = '📜 Schriftrolle nutzen — Klasse neu wählen ('+state.classScrolls+')';
        scrollBtn.onclick = ()=>{
          state.classScrolls--;
          c.advClass = null;
          if(isInParty(c.id)) state.party = state.party.filter(id=>id!==c.id);
          sfxEvent(); toast('📜 Schriftrolle verbraucht — wähle eine neue Klasse für '+c.name+'.');
          saveGame(); renderColony();
        };
        advRow.appendChild(scrollBtn);
      } else {
        const hint = document.createElement('div'); hint.className='desc'; hint.style.margin='2px 0 0';
        hint.textContent = 'Nur mit einer Klassen-Schriftrolle (seltener Fund) neu wählbar.';
        advRow.appendChild(hint);
      }
    } else {
      const btnRow = document.createElement('div'); btnRow.className='apRow'; btnRow.style.flexWrap='wrap';
      ADVENTURE_CLASSES.forEach(cls=>{
        const b = document.createElement('button'); b.textContent = ADV_CLASS_ICON[cls]+' '+cls;
        b.title = ADV_CLASS_DESC[cls];
        b.className='secondary';
        b.onclick = ()=>{
          c.advClass = cls;
          grantStartingGear(c, cls);
          saveGame(); renderColony();
        };
        btnRow.appendChild(b);
      });
      advRow.appendChild(btnRow);
    }
    const partyBtn = document.createElement('button');
    partyBtn.style.marginTop='6px'; partyBtn.style.width='100%';
    const inParty = isInParty(c.id);
    partyBtn.textContent = inParty ? '⭐ In der Party (entfernen)' : '➕ Zur Party hinzufügen';
    partyBtn.className = inParty ? '' : 'secondary';
    partyBtn.disabled = !c.advClass || (!inParty && partyCount()>=partyMax());
    partyBtn.onclick = ()=>{
      if(inParty){ state.party = state.party.filter(id=>id!==c.id); }
      else if(c.advClass && partyCount()<partyMax()){ state.party.push(c.id); sfxJoin(); }
      saveGame(); renderColony();
    };
    advRow.appendChild(partyBtn);
    card.appendChild(advRow);
    detail.appendChild(card);
    colWrap.appendChild(detail);
  });
  document.getElementById('partyCount').textContent = partyCount();
  document.getElementById('partyMaxLabel').textContent = partyMax();
  document.getElementById('colonistHint').textContent = `Freie Wohnplätze: ${Math.max(0, housingCap()-state.colonists.length)} von ${housingCap()} (Betten).`;
  const buildWrap = document.getElementById('buildSummary'); buildWrap.innerHTML='';
  const counts = {};
  state.buildings.forEach(b=>{ const key=b.type+(b.built?'':' (Baustelle)'); counts[key]=(counts[key]||0)+1; });
  if(Object.keys(counts).length===0){ buildWrap.innerHTML = '<div class="desc">Noch keine Gebäude errichtet.</div>'; }
  else {
    Object.keys(counts).forEach(t=>{
      const baseType = t.split(' (')[0];
      const chip = document.createElement('div'); chip.className='buildChip';
      chip.textContent = (BUILDING_TYPES[baseType]?BUILDING_TYPES[baseType].name:baseType) + (t.includes('Baustelle')?' (Baustelle)':'') + ' × ' + counts[t];
      buildWrap.appendChild(chip);
    });
  }
  const logWrap = document.getElementById('eventLog'); logWrap.innerHTML='';
  if(state.eventLog.length===0){ logWrap.innerHTML = '<div class="desc">Noch nichts passiert.</div>'; }
  else { state.eventLog.forEach(e=>{ const d = document.createElement('div'); d.className='logEntry'; d.textContent = e; logWrap.appendChild(d); }); }
}
function updateColonyIfOpen(){ if(!document.getElementById('colonyOverlay').classList.contains('hidden')) renderColony(); }
function openColony(){ openOverlay('colonyOverlay'); }
function closeColony(){ closeOverlay('colonyOverlay'); }

// Biom-Farbschemata für die Weltkarten-Miniaturen
const WM_BIOME_ART = {
  wildwood:{ base:'#3f6b3f', accent:'#5a8f4a', deco:'tree',  label:'🌲' },
  frost:   { base:'#8fa8b8', accent:'#d5e6ee', deco:'peak',  label:'❄️' },
  highland:{ base:'#6b7355', accent:'#8a8f6a', deco:'peak',  label:'⛰️' },
  ruins:   { base:'#7a7263', accent:'#9c9280', deco:'ruin',  label:'🏛️' },
  swamp:   { base:'#4a5940', accent:'#6b7a4a', deco:'marsh', label:'🐸' },
  coast:   { base:'#5c8f6a', accent:'#d8c489', deco:'shore', label:'🌊' },
  thorn:   { base:'#4a5c38', accent:'#6e7a3a', deco:'thorn', label:'🌵' },
  meadow:  { base:'#6fa03d', accent:'#93c25a', deco:'flower',label:'🌼' },
  deepwood:{ base:'#2c4a2c', accent:'#436b3a', deco:'tree',  label:'🌳' }
};
// Zeichnet eine Regions-Miniatur (Terrain-Vorschau) in ein kleines Canvas
function paintRegionThumb(g, w, h, biome, seed){
  const art = WM_BIOME_ART[biome] || WM_BIOME_ART.wildwood;
  const bg = g.createLinearGradient(0,0,w,h);
  bg.addColorStop(0, art.accent); bg.addColorStop(1, art.base);
  g.fillStyle = bg; g.fillRect(0,0,w,h);
  const rnd = (i)=> vrand(seed+1, i);
  if(art.deco==='shore'){
    // Wasserfläche mit geschwungener Uferlinie
    g.fillStyle='#3a7d82';
    g.beginPath(); g.moveTo(0,h*0.62);
    g.quadraticCurveTo(w*0.35,h*0.5, w*0.6,h*0.66);
    g.quadraticCurveTo(w*0.85,h*0.8, w,h*0.68);
    g.lineTo(w,h); g.lineTo(0,h); g.closePath(); g.fill();
    g.strokeStyle='rgba(230,245,240,.5)'; g.lineWidth=1;
    g.beginPath(); g.moveTo(0,h*0.62);
    g.quadraticCurveTo(w*0.35,h*0.5, w*0.6,h*0.66);
    g.quadraticCurveTo(w*0.85,h*0.8, w,h*0.68); g.stroke();
  }
  for(let i=0;i<7;i++){
    const px = 4 + rnd(i*3)*(w-8), py = 4 + rnd(i*3+1)*(h-8);
    if(art.deco==='shore' && py>h*0.6) continue;
    if(art.deco==='tree'){
      g.fillStyle='rgba(0,0,0,.18)'; g.beginPath(); g.ellipse(px,py+3,3,1.2,0,0,Math.PI*2); g.fill();
      g.fillStyle='#6b4a2b'; g.fillRect(px-0.7,py,1.4,3.5);
      g.fillStyle=i%2? '#2f5a2f':'#3f6b3f';
      g.beginPath(); g.arc(px,py-1.5,3.2,0,Math.PI*2); g.fill();
    } else if(art.deco==='peak'){
      g.fillStyle='rgba(0,0,0,.15)'; g.beginPath(); g.moveTo(px-5,py+4); g.lineTo(px,py-4); g.lineTo(px+5,py+4); g.closePath(); g.fill();
      g.fillStyle='#8a8f80'; g.beginPath(); g.moveTo(px-4,py+3); g.lineTo(px,py-4); g.lineTo(px+4,py+3); g.closePath(); g.fill();
      g.fillStyle='rgba(255,255,255,.75)'; g.beginPath(); g.moveTo(px,py-4); g.lineTo(px-1.6,py-1.4); g.lineTo(px+1.6,py-1.4); g.closePath(); g.fill();
    } else if(art.deco==='ruin'){
      g.fillStyle='#b3a894'; g.fillRect(px-3,py-4,2,7); g.fillRect(px+1,py-2,2,5);
      g.fillStyle='rgba(0,0,0,.2)'; g.fillRect(px-3,py+2,6,1);
    } else if(art.deco==='marsh'){
      g.fillStyle='rgba(60,90,70,.6)'; g.beginPath(); g.ellipse(px,py,4,2,0,0,Math.PI*2); g.fill();
      g.strokeStyle='#7a8f52'; g.lineWidth=1;
      g.beginPath(); g.moveTo(px-1,py+1); g.lineTo(px-1.5,py-3.5); g.moveTo(px+1,py+1); g.lineTo(px+1.6,py-3); g.stroke();
    } else if(art.deco==='thorn'){
      g.strokeStyle='#5f6b30'; g.lineWidth=1.3; g.lineCap='round';
      g.beginPath(); g.moveTo(px,py+3); g.lineTo(px,py-3); g.moveTo(px,py-1); g.lineTo(px-2.4,py-3);
      g.moveTo(px,py); g.lineTo(px+2.4,py-2.4); g.stroke();
    } else if(art.deco==='flower'){
      g.fillStyle=['#e8a94d','#efe6cd','#c94f8f'][i%3];
      [[0,-1.5],[1.4,0.6],[-1.4,0.6]].forEach(([ox,oy])=>{ g.beginPath(); g.arc(px+ox,py+oy,1.1,0,Math.PI*2); g.fill(); });
      g.fillStyle='#f2c65a'; g.beginPath(); g.arc(px,py,0.9,0,Math.PI*2); g.fill();
    }
  }
  // Vignette für Tiefe
  const vg = g.createRadialGradient(w/2,h/2,h*0.3,w/2,h/2,h*0.8);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,.22)');
  g.fillStyle=vg; g.fillRect(0,0,w,h);
}
// Zählt errichtete Gebäude je Region — zeigt, wo Außenposten stehen
function outpostCounts(){
  const counts = {};
  (state.buildings||[]).forEach(b=>{
    if(!b.built) return;
    const r = b.regionId || 'C';
    counts[r] = (counts[r]||0) + 1;
  });
  return counts;
}
function renderWorldMapContent(gridId){
  const grid = document.getElementById(gridId); grid.innerHTML='';
  const outposts = outpostCounts();
  if(atDungeon()){
    grid.innerHTML = '<div class="desc">🕳️ Die Weltkarte ist im Dungeon nicht verfügbar — finde erst den Ausgang.</div>';
    return;
  }
  const cur = REGIONS[state.player.regionId];
  for(let gy=cur.gy-2; gy<=cur.gy+2; gy++){
    for(let gx=cur.gx-2; gx<=cur.gx+2; gx++){
      const foundId = Object.keys(REGIONS).find(k=>REGIONS[k].gx===gx && REGIONS[k].gy===gy);
      const visited = !!foundId && (foundId==='C' || !!regionsRegistry[foundId]);
      const isCur = state.player.regionId===foundId;
      const cell = document.createElement('div');
      cell.className = 'wmCell' + (isCur?' current':'') + (visited?'':' fog');
      if(visited){
        const reg = REGIONS[foundId];
        const nm = foundId==='C' ? (state.colonyName||'Heimat') : reg.name;
        const danger = foundId==='C' ? 0 : regionDangerLevel(foundId);
        // Terrain-Miniatur statt reinem Text
        const thumb = document.createElement('canvas');
        thumb.width = 76; thumb.height = 52; thumb.className='wmThumb';
        paintRegionThumb(thumb.getContext('2d'), 76, 52, reg.biome, (foundId.charCodeAt(0)*31 + (foundId.charCodeAt(1)||0)));
        cell.appendChild(thumb);
        const cap = document.createElement('div');
        cap.className='wmCap';
        cap.innerHTML = `<span class="wmName">${nm}</span>` +
          (danger>0 ? `<span class="wmDanger">${'💀'.repeat(clamp(Math.round(danger/2),1,4))}</span>` : '');
        cell.appendChild(cap);
        if(isCur){
          const you = document.createElement('div'); you.className='wmYou'; you.textContent='📍';
          cell.appendChild(you);
        }
        // Außenposten kennzeichnen
        const opCount = outposts[foundId] || 0;
        if(opCount > 0){
          const op = document.createElement('div'); op.className='wmOutpost';
          op.textContent = (foundId==='C' ? '🏠 ' : '⛺ ') + opCount;
          op.title = opCount + ' errichtete Gebäude';
          cell.appendChild(op);
        }
      } else if(foundId){
        cell.innerHTML = '<div class="wmUnknown">?</div><div class="wmCap"><span class="wmName">Unerforscht</span></div>';
      } else {
        cell.innerHTML = '<div class="wmVoid"></div>';
      }
      if(visited){ cell.onclick = ()=>{ fastTravel(foundId); if(gridId!=='worldMapGrid') closeMainMenu(); }; }
      grid.appendChild(cell);
    }
  }
}
function renderWorldMap(){ renderWorldMapContent('worldMapGrid'); }
function openWorldMap(){
  if(atDungeon()){ toast('🕳️ Die Weltkarte ist im Dungeon nicht verfügbar — finde erst den Ausgang.'); return; }
  openOverlay('worldMapOverlay');
}
function closeWorldMap(){ closeOverlay('worldMapOverlay'); }

const TECH_TIERS = {
  werkzeugkunde:1, vorratshaltung:1, kraeutermedizin:1,
  schmiedekunst:2, belagerungsbau:2, faehrtenlesen:2, landwirtschaft:2,
  meisterhandwerk:3, bergbautechnik:3, tierbund:3, effiziente_arbeit:3,
  expedition:4, festungsbau:4, jagdmeister:4,
  elitetruppe:5, meisterforschung:5,
  legende:6, erleuchtung:6
};
const TECH_TIER_LABELS = { 1:'Stufe 1 — Grundlagen', 2:'Stufe 2 — Handwerk', 3:'Stufe 3 — Meisterschaft', 4:'Stufe 4 — Expedition', 5:'Stufe 5 — Meisterschaft der Kolonie', 6:'Stufe 6 — Vermächtnis' };
function renderResearch(){
  document.getElementById('researchPoints').textContent = Math.floor(state.research.points);
  const wrap = document.getElementById('techList'); wrap.innerHTML='';
  let lastTier = null;
  TECH_TREE.forEach(t=>{
    const tier = TECH_TIERS[t.key]||1;
    if(tier!==lastTier){
      const header = document.createElement('div'); header.className='resCatHeader'; header.textContent = TECH_TIER_LABELS[tier];
      wrap.appendChild(header);
      lastTier = tier;
    }
    const done = hasTech(t.key);
    const available = techAvailable(t);
    const div = document.createElement('div');
    div.className = 'techItem' + (done ? ' done' : (!available ? ' locked' : ''));
    const prereqNames = t.prereq.map(p=>TECH_TREE.find(x=>x.key===p).name).join(', ');
    const pct = clamp((state.research.points/t.cost)*100,0,100);
    div.innerHTML = `<div class="techTop"><span class="techName">${t.icon} ${t.name}</span><span>${done?'✅':t.cost+' 🔬'}</span></div>
      <div class="techDesc">${t.desc}</div>
      ${!done && available ? `<div class="miniBar"><div class="miniBarFill" style="width:${pct}%;background:#8fc93a;"></div></div>` : ''}
      ${t.prereq.length ? `<div class="techPrereq">Voraussetzung: ${prereqNames}</div>` : ''}`;
    if(!done){
      const btn = document.createElement('button');
      btn.textContent = 'Erforschen';
      btn.disabled = !available || state.research.points < t.cost;
      btn.onclick = ()=>{
        if(unlockTech(t)){ sfxBuildDone(); toast(`🔬 ${t.name} erforscht!`); logEvent(`🔬 ${t.name} wurde erforscht.`); saveGame(); renderResearch(); updateHUD(); }
      };
      div.appendChild(btn);
    }
    wrap.appendChild(div);
  });
}
function updateResearchIfOpen(){ if(!document.getElementById('researchOverlay').classList.contains('hidden')) renderResearch(); }
function openResearch(){ openOverlay('researchOverlay'); }
function closeResearch(){ closeOverlay('researchOverlay'); }

const VILLAGE_TRADES = [
  { give:{wood:4}, get:{metal:2}, label:'4 🪵 Holz → 2 ⚙️ Metall' },
  { give:{stone:4}, get:{cloth:2}, label:'4 🪨 Stein → 2 🧵 Stoff' },
  { give:{berries:5}, get:{ore:2}, label:'5 🫐 Beeren → 2 ⛏️ Erz' },
  { give:{fiber:4}, get:{planks:2}, label:'4 🌾 Faser → 2 🪚 Planken' },
  { give:{copper:2}, get:{silver:1}, label:'2 🟠 Kupfer → 1 ⚪ Silber' },
  { give:{silver:2}, get:{gold:1}, label:'2 ⚪ Silber → 1 🟡 Gold' },
  { give:{kraeuter:3}, get:{silver:1}, label:'3 🌱 Heilkräuter → 1 ⚪ Silber' },
  { give:{getreide:4}, get:{metal:1,cloth:1}, label:'4 🌾 Getreide → 1 ⚙️ Metall + 1 🧵 Stoff' },
  { give:{holz_kiefer:3}, get:{planks:2}, label:'3 🌲 Kiefernholz → 2 🪚 Planken' },
  { give:{holz_dunkel:3}, get:{cloth:2}, label:'3 🪵 Dunkelholz → 2 🧵 Stoff' },
  { give:{holz_bruch:4}, get:{wood:3}, label:'4 🥢 Bruchholz → 3 🪵 Holz' },
  { give:{stein_marmor:3}, get:{gold:1}, label:'3 ⬜ Marmor → 1 🟡 Gold' },
  { give:{stein_sand:4}, get:{metal:1}, label:'4 🟨 Sandstein → 1 ⚙️ Metall' },
  { give:{erz_titan:1}, get:{gold:4}, label:'1 🔷 Titanerz → 4 🟡 Gold' },
  { give:{planks:3}, get:{gold:1}, label:'3 🪚 Planken → 1 🟡 Gold' },
  { give:{cloth:3}, get:{gold:1}, label:'3 🧵 Stoff → 1 🟡 Gold' }
];
function renderVillageShop(){
  const wrap = document.getElementById('villageTradeList'); wrap.innerHTML='';
  VILLAGE_TRADES.forEach(t=>{
    const row = document.createElement('div'); row.className='refineRow';
    row.innerHTML = `<span class="rr-name">${t.label}</span>`;
    const btn = document.createElement('button'); btn.textContent='Handeln';
    btn.disabled = !canAfford(t.give);
    btn.onclick = ()=>{
      if(!canAfford(t.give)) return;
      pay(t.give);
      Object.keys(t.get).forEach(k=>{ addResource(k, t.get[k]); bumpResource(k); });
      sfxCraft(); toast('🏪 Handel abgeschlossen!');
      updateHUD(); saveGame(); renderVillageShop();
    };
    row.appendChild(btn); wrap.appendChild(row);
  });
}
function openVillageShop(){
  if(!state.loreDiscovered.includes('village_rumor')){
    state.loreDiscovered.push('village_rumor');
    sfxEvent();
    const entry = LORE_ENTRIES.village_rumor;
    showStoryDialog('📜 '+entry.title, entry.text, [{ label:'Weiter zum Händler', action:()=>{
      openOverlay('villageShopOverlay');
    }}]);
    logEvent('📜 Neuer Chronik-Eintrag: '+entry.title);
    saveGame();
    return;
  }
  openOverlay('villageShopOverlay');
}
function closeVillageShop(){ closeOverlay('villageShopOverlay'); }

function renderChronikContent(listId){
  const wrap = document.getElementById(listId); wrap.innerHTML='';
  const discoveredCount = state.loreDiscovered.length;
  LORE_ORDER.forEach(key=>{
    const entry = LORE_ENTRIES[key];
    const discovered = state.loreDiscovered.includes(key);
    const div = document.createElement('div'); div.className='techItem'+(discovered?' done':' locked');
    if(discovered){
      div.innerHTML = `<div class="techTop"><span class="techName">📜 ${entry.title}</span></div><div class="techDesc">${entry.text}</div>`;
    } else {
      div.innerHTML = `<div class="techTop"><span class="techName">📜 ???</span></div><div class="techDesc">Noch nicht entdeckt.</div>`;
    }
    wrap.appendChild(div);
  });
  return discoveredCount;
}
function renderChronik(){
  const discoveredCount = renderChronikContent('chronikList');
  const desc = document.querySelector('#chronikOverlay .desc');
  if(desc) desc.textContent = `Fundstücke, Erinnerungen und Gerüchte, die du auf deinen Wegen entdeckt hast. (${discoveredCount}/${LORE_ORDER.length})`;
}
function openChronik(){ openOverlay('chronikOverlay'); }
function closeChronik(){ closeOverlay('chronikOverlay'); }

/* ============================================================
   Enterable building interiors
============================================================ */
/* Betretbare Gebäude. Alles mit Produktionsrezepten wird automatisch
   ergänzt — sonst wird beim Hinzufügen eines Gebäudes leicht vergessen,
   es hier einzutragen, und es reagiert dann stumm auf Klicks. */
const ENTERABLE_BASE = ['tent','sawmill','furnace','loom','workbench','stockpile','tower','forge',
  'research','barber','brunnen','bibliothek','zwinger','krankenstube','stuhl','bank','kuechenherd',
  'lagerkiste','primitivbank','werkstatt','schmiede','werft'];
const ENTERABLE_TYPES = ENTERABLE_BASE.slice();
// Produktionsgebäude nachtragen, sobald die Rezepte geladen sind
const INTERIOR_TITLE = { primitivbank:'🪵 Primitive Werkbank', werkstatt:'🔧 Werkstatt', schmiede:'⚒️ Schmiede', werft:'⛵ Werft',
  toepferei:'🏺 Töpferei', gerberei:'🧴 Gerberei', muehle:'🌬️ Mühle', baeckerei:'🥖 Bäckerei',
  alchemielabor:'⚗️ Alchemielabor', schreinerei:'🪚 Schreinerei', steinmetz:'🔨 Steinmetz',
  lagerkiste:'🧰 Lagerkiste', tent:'🛏️ Bett', sawmill:'🪚 Sägewerk', furnace:'⚒️ Schmelzofen', loom:'🧵 Webstuhl', workbench:'🛠️ Produktionsbank', stockpile:'📦 Lagerzone', tower:'🗼 Wachturm', forge:'⚒️ Schmiede', research:'📚 Forschungstisch', barber:'💈 Barbier', brunnen:'⛲ Brunnen', bibliothek:'📖 Bibliothek', zwinger:'🐾 Zwinger', krankenstube:'⚕️ Krankenstube', stuhl:'🪑 Stuhl', bank:'🛋️ Bank', kuechenherd:'🍳 Küchenherd' };
function drawInteriorScene(type){
  const c = document.getElementById('interiorCanvas');
  const ictx = c.getContext('2d');
  ictx.clearRect(0,0,c.width,c.height);
  ictx.fillStyle='#3f2f22'; ictx.fillRect(0,0,c.width,c.height*0.55);
  ictx.fillStyle='rgba(255,255,255,.04)';
  for(let y=0;y<c.height*0.55;y+=18){ ictx.fillRect(0,y,c.width,2); }
  ictx.fillStyle='#8a6b45'; ictx.fillRect(0,c.height*0.55,c.width,c.height*0.45);
  ictx.strokeStyle='rgba(0,0,0,.12)';
  for(let x=0;x<c.width;x+=24){ ictx.beginPath(); ictx.moveTo(x,c.height*0.55); ictx.lineTo(x,c.height); ictx.stroke(); }
  const cx=c.width/2, floorY=c.height*0.74;
  ictx.save(); ictx.translate(cx,floorY);
  if(type==='tent'){
    ictx.fillStyle='#8b5e3c'; ictx.fillRect(-52,-16,104,26);
    ictx.fillStyle='#efe6cd'; ictx.fillRect(-44,-30,88,16);
    ictx.fillStyle='#c9822c'; ictx.beginPath(); ictx.arc(-30,-30,10,0,Math.PI*2); ictx.fill();
  } else if(type==='sawmill'){
    ictx.fillStyle='#6b4a2b'; ictx.fillRect(-55,-8,110,20);
    ictx.fillStyle='#c9c9c9'; ictx.beginPath(); ictx.arc(0,-14,22,0,Math.PI*2); ictx.fill();
    ictx.strokeStyle='#8a8a8a'; ictx.lineWidth=2;
    for(let i=0;i<10;i++){ const a=i/10*Math.PI*2; ictx.beginPath(); ictx.moveTo(Math.cos(a)*14,-14+Math.sin(a)*14); ictx.lineTo(Math.cos(a)*24,-14+Math.sin(a)*24); ictx.stroke(); }
  } else if(type==='furnace'){
    ictx.fillStyle='#4a4a4a'; ictx.fillRect(-40,-52,80,52);
    const flick=1+Math.sin(Date.now()/150)*0.15;
    ictx.fillStyle='#e8623b'; ictx.beginPath(); ictx.arc(0,-20,14*flick,0,Math.PI*2); ictx.fill();
    ictx.fillStyle='#f2a65a'; ictx.beginPath(); ictx.arc(0,-20,7*flick,0,Math.PI*2); ictx.fill();
  } else if(type==='loom'){
    ictx.strokeStyle='#8b5e3c'; ictx.lineWidth=5; ictx.strokeRect(-40,-55,80,55);
    ictx.strokeStyle='#c9b988'; ictx.lineWidth=1.5;
    for(let x=-32;x<=32;x+=8){ ictx.beginPath(); ictx.moveTo(x,-55); ictx.lineTo(x,0); ictx.stroke(); }
  } else if(type==='workbench'){
    ictx.fillStyle='#6b4a2b'; ictx.fillRect(-55,-12,110,22);
    ictx.fillStyle='#8b7355'; ictx.fillRect(-10,-30,8,18);
    ictx.fillStyle='#c9822c'; ictx.beginPath(); ictx.arc(15,-24,8,0,Math.PI*2); ictx.fill();
  } else if(type==='stockpile'){
    for(let i=0;i<3;i++){ ictx.fillStyle= i%2===0?'#8b5e3c':'#6b4a2b'; ictx.fillRect(-50+i*36,-30,28,32); }
  } else if(type==='tower'){
    ictx.fillStyle='#6b6f63'; ictx.fillRect(-30,-70,60,70);
    ictx.fillStyle='#3f2f22'; ictx.fillRect(-18,-30,36,30);
    ictx.fillStyle='#7fa8d6'; ictx.fillRect(-30,-60,60,10);
  } else if(type==='forge'){
    ictx.fillStyle='#3a3a3a'; ictx.fillRect(-45,-50,90,50);
    const flick=1+Math.sin(Date.now()/140)*0.18;
    ictx.fillStyle='#e8623b'; ictx.beginPath(); ictx.arc(-10,-16,12*flick,0,Math.PI*2); ictx.fill();
    ictx.fillStyle='#f2a65a'; ictx.beginPath(); ictx.arc(-10,-16,6*flick,0,Math.PI*2); ictx.fill();
    ictx.fillStyle='#8b7355'; ictx.fillRect(14,-28,10,28);
    ictx.strokeStyle='#c9c9c9'; ictx.lineWidth=3;
    ictx.beginPath(); ictx.moveTo(22,-30); ictx.lineTo(34,-42); ictx.stroke();
  } else if(type==='research'){
    ictx.fillStyle='#6b4a2b'; ictx.fillRect(-55,-10,110,22);
    ictx.fillStyle='#efe6cd'; ictx.fillRect(-38,-24,32,16);
    ictx.fillStyle='#c94f3d'; ictx.fillRect(-34,-27,24,4);
    ictx.fillStyle='#7fd1d1'; ictx.beginPath(); ictx.arc(20,-20,9,0,Math.PI*2); ictx.fill();
  } else if(type==='barber'){
    ictx.fillStyle='#c9c9c9'; ictx.beginPath(); ictx.ellipse(0,-30,20,26,0,0,Math.PI*2); ictx.fill();
    ictx.strokeStyle='#8b7355'; ictx.lineWidth=3; ictx.strokeRect(-24,-46,48,32);
    ictx.fillStyle='#c9822c'; ictx.fillRect(-4,-6,8,20);
  } else if(type==='brunnen'){
    ictx.fillStyle='#8b8478'; ictx.beginPath(); ictx.arc(0,-6,26,0,Math.PI*2); ictx.fill();
    ictx.fillStyle='#3e8e8e'; ictx.beginPath(); ictx.arc(0,-6,19,0,Math.PI*2); ictx.fill();
    const ripple = 1+Math.sin(Date.now()/300)*0.08;
    ictx.strokeStyle='rgba(255,255,255,.3)'; ictx.lineWidth=1.4;
    ictx.beginPath(); ictx.arc(0,-6,10*ripple,0,Math.PI*2); ictx.stroke();
    ictx.fillStyle='#6b4a2b'; ictx.fillRect(-4,-46,8,22);
    ictx.fillRect(-16,-48,32,4);
  } else if(type==='bibliothek'){
    ictx.fillStyle='#6b4a2b'; ictx.fillRect(-50,-14,100,26);
    for(let i=0;i<6;i++){ ictx.fillStyle=['#c94f3d','#3e8e8e','#c9822c','#5a3d6b','#4c7a3d','#8b7355'][i]; ictx.fillRect(-42+i*14,-30,10,18); }
    ictx.fillStyle='#efe6cd'; ictx.fillRect(10,-6,22,14);
  } else if(type==='zwinger'){
    ictx.strokeStyle='#8b7355'; ictx.lineWidth=3;
    for(let i=-2;i<=2;i++){ ictx.beginPath(); ictx.moveTo(i*12,-40); ictx.lineTo(i*12,-2); ictx.stroke(); }
    ictx.fillStyle='#c9822c'; ictx.beginPath(); ictx.ellipse(0,-8,14,8,0,0,Math.PI*2); ictx.fill();
    ictx.fillStyle='#26261f'; ictx.beginPath(); ictx.arc(-6,-12,2,0,Math.PI*2); ictx.fill(); ictx.beginPath(); ictx.arc(6,-12,2,0,Math.PI*2); ictx.fill();
  } else if(type==='krankenstube'){
    ictx.fillStyle='#efe6cd'; ictx.fillRect(-40,-24,80,26);
    ictx.strokeStyle='#8b7355'; ictx.lineWidth=2; ictx.strokeRect(-40,-24,80,26);
    ictx.fillStyle='#c94f3d'; ictx.fillRect(-6,-40,12,32); ictx.fillRect(-16,-30,32,12);
    ictx.fillStyle='#3e8e8e'; ictx.beginPath(); ictx.arc(28,-30,8,0,Math.PI*2); ictx.fill();
  } else if(type==='stuhl'){
    ictx.fillStyle='#8b6f4e'; ictx.fillRect(-14,-30,28,26);
    ictx.strokeStyle='#4a3018'; ictx.lineWidth=2; ictx.strokeRect(-14,-30,28,26);
    ictx.fillRect(-14,-4,4,16); ictx.fillRect(10,-4,4,16);
  } else if(type==='bank'){
    ictx.fillStyle='#8b6f4e'; ictx.fillRect(-42,-20,84,14);
    ictx.strokeStyle='#4a3018'; ictx.lineWidth=2; ictx.strokeRect(-42,-20,84,14);
    ictx.fillRect(-38,-6,5,16); ictx.fillRect(33,-6,5,16);
  } else if(type==='kuechenherd'){
    ictx.fillStyle='#7a7268'; ictx.fillRect(-42,-30,84,34);
    ictx.strokeStyle='#4a453e'; ictx.lineWidth=2; ictx.strokeRect(-42,-30,84,34);
    const flick=1+Math.sin(Date.now()/150)*0.15;
    ictx.fillStyle='#3a352e'; ictx.fillRect(-16,-12,32,10);
    ictx.fillStyle='#e8623b'; ictx.beginPath(); ictx.ellipse(0,-8,10*flick,5*flick,0,0,Math.PI*2); ictx.fill();
    ictx.fillStyle='#f2c65a'; ictx.beginPath(); ictx.ellipse(0,-8,5*flick,2.5*flick,0,0,Math.PI*2); ictx.fill();
    ictx.fillStyle='#c9c9c9'; ictx.beginPath(); ictx.ellipse(28,-22,10,4,0,0,Math.PI*2); ictx.fill();
  }
  ictx.restore();
}
function renderInteriorBody(b){
  const wrap = document.getElementById('interiorBody'); wrap.innerHTML='';
  if(b.type==='tent'){
    wrap.innerHTML = '<div class="desc">Ein einfaches, aber gemütliches Lager. Hier kannst du bis zum Morgen durchschlafen.</div>';
    const btn=document.createElement('button'); btn.textContent='🛏️ Schlafen bis zum Morgen';
    btn.onclick=()=>{
      closeBuildingInterior();
      sleepUntilMorning();
    };
    wrap.appendChild(btn);
  } else if(b.type==='schmiede'){
    const cls = state.player.advClass;
    const d=document.createElement('div'); d.className='desc';
    d.textContent = cls ? `Waffen deiner Klasse (${cls}) wirken voll — fremde Waffen nur zu 40 %.`
                        : 'Ohne Abenteuer-Klasse wirken alle Waffen nur eingeschränkt.';
    wrap.appendChild(d);
    // Bereits geschmiedete Waffen zum Anlegen
    const owned = ownedWeapons();
    if(owned.length){
      const head=document.createElement('div'); head.className='rcHead'; head.textContent='Deine Waffen';
      wrap.appendChild(head);
      const row=document.createElement('div'); row.className='refineRow';
      owned.forEach(o=>{
        const w=WEAPON_TYPES[o.type];
        const eq = state.player.equippedWeapon &&
                   state.player.equippedWeapon.type===o.type && state.player.equippedWeapon.tier===o.tier;
        const btn=document.createElement('button');
        btn.className = eq ? '' : 'secondary';
        btn.style.fontSize='10.5px';
        btn.innerHTML = `${w.icon} ${WEAPON_TIERS[o.tier].name}<br><span style="font-size:9px">${w.name} · +${weaponAtkFor(o.type,o.tier,cls)}${eq?' ✔':''}</span>`;
        btn.onclick=()=>{ equipWeapon(o.type,o.tier); renderInteriorBody(b); };
        row.appendChild(btn);
      });
      wrap.appendChild(row);
    }
    // Schmieden — nach Klasse gruppiert, eigene zuerst
    const types = Object.keys(WEAPON_TYPES).sort((a,z)=>{
      const fa = weaponFitsClass(a,cls)?0:1, fz = weaponFitsClass(z,cls)?0:1;
      return fa-fz;
    });
    types.forEach(ty=>{
      const w=WEAPON_TYPES[ty];
      const fits = weaponFitsClass(ty, cls);
      const head=document.createElement('div'); head.className='rcHead'; head.style.marginTop='8px';
      head.innerHTML = `${w.icon} ${w.name} <span style="font-weight:600;font-size:10px;color:${fits?'#3d7a35':'#7a6f4e'}">`+
                       `${fits?'· deine Klasse':'· '+w.cls}</span><br>`+
                       `<span style="font-weight:600;font-size:10px;opacity:.8">${w.desc}</span>`;
      wrap.appendChild(head);
      const row=document.createElement('div'); row.className='refineRow';
      WEAPON_TIER_ORDER.forEach(tier=>{
        const cost = weaponCost(ty,tier);
        const can = Object.keys(cost).every(k=>(state.inventory[k]||0)>=cost[k]);
        const have = state.weapons && state.weapons[weaponKey(ty,tier)];
        const btn=document.createElement('button');
        btn.className = can && !have ? '' : 'secondary';
        btn.disabled = !can || have;
        btn.style.fontSize='10px';
        btn.innerHTML = `${WEAPON_TIERS[tier].name}${have?' ✔':''}<br><span style="font-size:9px;opacity:.85">`+
          Object.keys(cost).map(k=>`${cost[k]}${RESOURCE_ICONS[k]||''}`).join(' ')+
          `<br>+${weaponAtkFor(ty,tier,cls)} Angriff</span>`;
        btn.title = Object.keys(cost).map(k=>`${cost[k]} ${RESOURCE_NAMES[k]||k}`).join(', ');
        btn.onclick=()=>{ if(craftWeapon(ty,tier)) renderInteriorBody(b); };
        row.appendChild(btn);
      });
      wrap.appendChild(row);
    });
  } else if(b.type==='primitivbank' || b.type==='werkstatt'){
    const primitive = (b.type==='primitivbank');
    const desc=document.createElement('div'); desc.className='desc';
    desc.textContent = primitive
      ? 'Einfache Werkzeuge aus Holz und Stein. Für bessere Stufen brauchst du eine richtige Werkstatt.'
      : 'Werkzeuge nutzen sich beim Arbeiten ab. Bessere Stufen halten länger und bringen mehr Ertrag.';
    wrap.appendChild(desc);
    // Bestand
    const owned = Object.keys(state.tools||{}).filter(k=>state.tools[k].dur>0);
    if(owned.length){
      const inv=document.createElement('div'); inv.className='toolInv';
      owned.forEach(k=>{
        const [ty,tier]=k.split('_');
        const it=state.tools[k], cond=toolCondition(it,tier);
        const max=TOOL_TIERS[tier].dur;
        const row=document.createElement('div'); row.className='toolRow';
        row.innerHTML = `<span class="tiIcon">${TOOL_TYPES[ty].icon}</span>`+
          `<span class="tiName">${TOOL_TIERS[tier].name}-${TOOL_TYPES[ty].name}</span>`+
          `<span class="tiBar"><i style="width:${clamp(it.dur/max*100,0,100)}%;background:${cond.col}"></i></span>`+
          `<span class="tiNum" style="color:${cond.col}">${it.dur} · ${cond.label}</span>`;
        inv.appendChild(row);
      });
      wrap.appendChild(inv);
    } else {
      const e=document.createElement('div'); e.className='desc';
      e.textContent='Du besitzt noch kein Werkzeug — ohne eines arbeitest du mit bloßen Händen.';
      wrap.appendChild(e);
    }
    // Herstellen
    Object.keys(TOOL_TYPES).forEach(ty=>{
      const head=document.createElement('div'); head.className='rcHead';
      head.style.marginTop='8px';
      head.textContent = `${TOOL_TYPES[ty].icon} ${TOOL_TYPES[ty].name} — ${TOOL_TYPES[ty].desc}`;
      wrap.appendChild(head);
      const row=document.createElement('div'); row.className='refineRow';
      (primitive ? ['holz'] : TOOL_TIER_ORDER).forEach(tier=>{
        const t=TOOL_TIERS[tier];
        const can=Object.keys(t.cost).every(k=>(state.inventory[k]||0)>=t.cost[k]);
        const btn=document.createElement('button');
        btn.className = can ? '' : 'secondary';
        btn.disabled = !can;
        btn.style.fontSize='10.5px';
        btn.innerHTML = `${t.name}<br><span style="font-size:9px;opacity:.85">`+
          Object.keys(t.cost).map(k=>`${t.cost[k]}${RESOURCE_ICONS[k]||''}`).join(' ')+
          `<br>+${t.yield} Ertrag · ${t.dur} Nutzungen</span>`;
        btn.title = Object.keys(t.cost).map(k=>`${t.cost[k]} ${RESOURCE_NAMES[k]||k}`).join(', ');
        btn.onclick=()=>{ if(craftTool(ty,tier)) renderInteriorBody(b); };
        row.appendChild(btn);
      });
      wrap.appendChild(row);
    });
  } else if(hasRecipes(b.type)){
    // Produktionsgebäude: echte Rezepte statt abstrakter Boni
    const desc=document.createElement('div'); desc.className='desc';
    desc.textContent = 'Hier werden Rohstoffe zu Waren verarbeitet. Was du herstellst, landet direkt im Lager.';
    wrap.appendChild(desc);
    PRODUCTION_RECIPES[b.type].forEach(r=>{
      const card=document.createElement('div'); card.className='recipeCard';
      const inTxt = Object.keys(r.in).map(k=>`${r.in[k]} ${RESOURCE_ICONS[k]||''} ${RESOURCE_NAMES[k]||k}`).join(' + ');
      const outTxt= Object.keys(r.out).map(k=>`${r.out[k]} ${RESOURCE_ICONS[k]||''} ${RESOURCE_NAMES[k]||k}`).join(' + ');
      const head=document.createElement('div'); head.className='rcHead'; head.textContent=r.label;
      card.appendChild(head);
      const flow=document.createElement('div'); flow.className='rcFlow';
      flow.innerHTML = `<span class="rcIn">${inTxt}</span><span class="rcArrow">→</span><span class="rcOut">${outTxt}</span>`;
      card.appendChild(flow);
      // Vorrat je Zutat anzeigen
      const stock=document.createElement('div'); stock.className='rcStock';
      stock.innerHTML = Object.keys(r.in).map(k=>{
        const have=state.inventory[k]||0, need=r.in[k];
        return `<span class="${have>=need?'rcOk':'rcMiss'}">${RESOURCE_ICONS[k]||''} ${have}/${need}</span>`;
      }).join(' ');
      card.appendChild(stock);
      const row=document.createElement('div'); row.className='refineRow';
      const b1=document.createElement('button'); b1.textContent='Herstellen';
      b1.disabled=!canCraftRecipe(r);
      b1.onclick=()=>{ if(craftRecipe(r,1)){ sfxCraft(); updateHUD(); saveGame(); renderInteriorBody(b); } };
      const b2=document.createElement('button'); b2.textContent='Alles'; b2.className='secondary';
      b2.disabled=!canCraftRecipe(r);
      b2.onclick=()=>{ const n=craftRecipeAll(r); if(n){ sfxCraft(); toast(`${n}× ${r.label}`); updateHUD(); saveGame(); renderInteriorBody(b); } };
      row.appendChild(b1); row.appendChild(b2); card.appendChild(row);
      wrap.appendChild(card);
    });
  } else if(b.type==='workbench'){
    const desc=document.createElement('div'); desc.className='desc';
    desc.textContent = 'Fallen, die du bei dir trägst, halten dank der Werkbank 15% besser. Du kannst hier auch direkt eine Falle bauen.';
    wrap.appendChild(desc);
    const btn=document.createElement('button'); btn.textContent='🪤 Falle bauen (3 🪵, 3 🪨)';
    btn.disabled = state.inventory.wood<3 || state.inventory.stone<3;
    btn.onclick=()=>{
      if(state.inventory.wood>=3 && state.inventory.stone>=3){
        state.inventory.wood-=3; state.inventory.stone-=3; state.inventory.trap+=1;
        bumpResource('wood'); bumpResource('stone'); bumpResource('trap');
        toast('🪤 Falle hergestellt!'); updateHUD(); saveGame(); renderInteriorBody(b);
      }
    };
    wrap.appendChild(btn);
  } else if(b.type==='lagerkiste'){
    b.openedAt = performance.now();   // löst die Deckelanimation aus
    const chests = state.buildings.filter(x=>x.type==='lagerkiste'&&x.built).length;
    const d2=document.createElement('div'); d2.className='desc';
    d2.textContent = `Eine stabile Truhe aus Planken und Metallbeschlägen. ${chests} Kiste${chests===1?'':'n'} erhöhen dein Lagerlimit um ${chests*STORAGE_PER_CHEST} pro Rohstoff.`;
    wrap.appendChild(d2);
    /* Sortierleiste: die Reihenfolge steckt in kistenSortierung und wird
       gemerkt, damit sie beim erneuten Öffnen erhalten bleibt. */
    const leiste = document.createElement('div'); leiste.className='chestSortBar';
    [['menge','↕️ Menge'], ['name','🔤 Name'], ['voll','⚠️ Füllstand']].forEach(([key,label])=>{
      const sb = document.createElement('button');
      sb.textContent = label;
      sb.className = (kistenSortierung === key) ? '' : 'secondary';
      sb.onclick = ()=>{ kistenSortierung = key; sfxEvent(); renderInteriorBody(b); };
      leiste.appendChild(sb);
    });
    wrap.appendChild(leiste);

    const cap = storageCap();
    const eintraege = Object.keys(RESOURCE_ICONS)
      .map(k=>({ k, cnt: state.inventory[k]||0 }))
      .filter(e=>e.cnt > 0);
    eintraege.sort((a,b2)=>{
      if(kistenSortierung === 'name') return (RESOURCE_NAMES[a.k]||a.k).localeCompare(RESOURCE_NAMES[b2.k]||b2.k);
      if(kistenSortierung === 'voll') return (b2.cnt/cap) - (a.cnt/cap);
      return b2.cnt - a.cnt;
    });

    const g2=document.createElement('div'); g2.className='resGrid';
    eintraege.forEach(({k,cnt})=>{
      const anteil = Math.min(1, cnt/cap);
      const div=document.createElement('div'); div.className='resItem';
      if(anteil >= 1) div.classList.add('resVoll');
      else if(anteil >= 0.85) div.classList.add('resFast');
      // Füllbalken macht auf einen Blick sichtbar, was gleich überläuft
      div.innerHTML = `<span>${RESOURCE_ICONS[k]} ${RESOURCE_NAMES[k]}</span>`
        + `<span>${cnt} / ${cap}</span>`
        + `<div class="resBar"><div class="resBarFill" style="width:${Math.round(anteil*100)}%"></div></div>`;
      g2.appendChild(div);
    });
    if(!g2.children.length){ const e=document.createElement('div'); e.className='desc'; e.textContent='Die Kiste ist noch leer.'; wrap.appendChild(e); }
    else wrap.appendChild(g2);

    const volle = eintraege.filter(e=>e.cnt >= cap).length;
    if(volle){
      const warn=document.createElement('div'); warn.className='desc';
      warn.textContent = `⚠️ ${volle} Rohstoff${volle===1?'':'e'} am Limit — weitere Funde gehen verloren. Baue eine weitere Lagerkiste.`;
      wrap.appendChild(warn);
    }
  } else if(b.type==='stockpile'){
    const desc=document.createElement('div'); desc.className='desc';
    desc.textContent = 'Ein Überblick über alle eingelagerten Vorräte deiner Kolonie.';
    wrap.appendChild(desc);
    const grid=document.createElement('div'); grid.className='resGrid';
    Object.keys(RESOURCE_ICONS).forEach(k=>{
      const div=document.createElement('div'); div.className='resItem';
      div.innerHTML = `<span>${RESOURCE_ICONS[k]} ${RESOURCE_NAMES[k]}</span><span>${state.inventory[k]}</span>`;
      grid.appendChild(div);
    });
    wrap.appendChild(grid);
  } else if(b.type==='tower'){
    const wallCount = state.buildings.filter(x=>x.type==='wall'&&x.built).length;
    const guardCount = allDefenders().length;
    const guardBonus = defenseBonus();
    const lossPct = Math.round(clamp(0.22-wallCount*0.03-guardBonus,0.05,0.22)*100);
    const info=document.createElement('div');
    info.innerHTML = `<div class="desc">Von hier oben behältst du die Umgebung im Blick.</div>
      <div class="resItem" style="margin-bottom:6px;"><span>🧱 Wände</span><span>${wallCount}</span></div>
      <div class="resItem" style="margin-bottom:6px;"><span>🛡️ Wächter</span><span>${guardCount}</span></div>
      <div class="resItem" style="margin-bottom:10px;"><span>Verlust bei Überfall</span><span>${lossPct}%</span></div>`;
    wrap.appendChild(info);
    const btn=document.createElement('button'); btn.textContent='🔭 Umgebung beobachten';
    btn.onclick=()=>{
      const monCount = globalThis.wildMonsters.length;
      const nodeCount = objects.size;
      toast(`🔭 In Sichtweite: ${monCount} wilde Kreaturen, ${nodeCount} Ressourcenvorkommen.`);
    };
    wrap.appendChild(btn);
  } else if(b.type==='forge'){
    const desc=document.createElement('div'); desc.className='desc';
    desc.textContent = 'Schmiede Ausrüstung für dich selbst oder deine Abenteurer — dauerhafte Boni für Angriff und Verteidigung. Höherwertige Stücke brauchen passende Technologien aus der Forschung.';
    wrap.appendChild(desc);
    const selWrap=document.createElement('div'); selWrap.style.cssText='margin-bottom:8px;font-size:12px;font-weight:700;';
    const sel=document.createElement('select');
    const youOpt=document.createElement('option'); youOpt.value='__player__'; youOpt.textContent='🧍 Du (wirkt in jedem Kampf, auch solo)'; sel.appendChild(youOpt);
    state.colonists.forEach(c=>{ const opt=document.createElement('option'); opt.value=c.id; opt.textContent=(ADV_CLASS_ICON[c.advClass]||'❔')+' '+c.name; sel.appendChild(opt); });
    selWrap.appendChild(document.createTextNode('Für wen? ')); selWrap.appendChild(sel);
    wrap.appendChild(selWrap);
    const pg = state.player.gear || {weapon:0,armor:0,trinket:0};
    if(pg.weapon||pg.armor||pg.trinket||pg.kopf||pg.oberkoerper||pg.unterkoerper||pg.schild){
      const geInfo=document.createElement('div'); geInfo.className='desc';
      geInfo.textContent = `Deine aktuelle Ausrüstung: ${pg.weapon?'🗡️+'+pg.weapon+' ':''}${pg.kopf?'🪖+'+pg.kopf+' ':''}${pg.oberkoerper?'🛡️+'+pg.oberkoerper+' ':''}${pg.unterkoerper?'👖+'+pg.unterkoerper+' ':''}${pg.schild?'🛡️🔰+'+pg.schild+' ':''}${pg.armor?'✨+'+pg.armor+' ':''}${pg.trinket?'👑+'+pg.trinket:''}`;
      wrap.appendChild(geInfo);
    }
    EQUIPMENT_RECIPES.forEach(r=>{
      const locked = r.requiresTech && !hasTech(r.requiresTech);
      const lockedName = locked ? TECH_TREE.find(t=>t.key===r.requiresTech).name : '';
      const row=document.createElement('div'); row.className='refineRow';
      row.innerHTML = `<span class="rr-name">${r.label} ${locked?'🔒 ('+lockedName+' nötig)':''} — ${Object.entries(r.cost).map(([k,v])=>v+' '+(RESOURCE_ICONS[k]||k)).join(', ')}</span>`;
      const btn2=document.createElement('button'); btn2.textContent='Schmieden';
      btn2.disabled = locked || !canAfford(r.cost);
      btn2.onclick=()=>{
        if(locked || !canAfford(r.cost)) return;
        pay(r.cost);
        const target = sel.value==='__player__' ? state.player : state.colonists.find(c=>c.id===sel.value);
        const targetName = sel.value==='__player__' ? 'dich' : (target ? target.name : '');
        if(target){
          if(!target.gear) target.gear = {weapon:0,armor:0,trinket:0};
          const mhMult = hasTech('meisterhandwerk') ? 1.5 : 1;
          Object.keys(r.bonus).forEach(k=>{ target.gear[k] = (target.gear[k]||0)+Math.round(r.bonus[k]*mhMult); });
          sfxBuildDone();
          toast(`${r.label} für ${targetName} geschmiedet!`);
          logEvent(`⚒️ ${r.label} für ${targetName} geschmiedet.`);
        }
        updateHUD(); saveGame(); renderInteriorBody(b);
      };
      row.appendChild(btn2); wrap.appendChild(row);
    });
  } else if(b.type==='research'){
    const desc=document.createElement('div'); desc.className='desc';
    desc.textContent = 'Hier wird eines Tages ein umfangreicher Forschungsbaum entstehen. Fürs Erste schaltet dieser Tisch fortgeschrittene Schmiedekunst (Silber & Gold) in der Schmiede frei — und inspiriert deine Kolonie.';
    wrap.appendChild(desc);
    const cost = {berries:5, fiber:3};
    const btn3=document.createElement('button');
    btn3.textContent = '📖 Kolonie inspirieren (+15 Laune, 5 🫐, 3 🌾)';
    btn3.disabled = !canAfford(cost);
    btn3.onclick=()=>{
      if(!canAfford(cost)) return;
      pay(cost);
      state.colonists.forEach(c=>{ c.mood = clamp(c.mood+15,0,100); });
      sfxEvent(); toast('📖 Die Kolonie ist inspiriert! +15 Laune für alle Kolonisten.');
      updateHUD(); saveGame(); updateColonyIfOpen(); renderInteriorBody(b);
    };
    wrap.appendChild(btn3);
  } else if(b.type==='barber'){
    /* Hier stand versehentlich der Zeichencode des Gebäudes (drawFacadeFurniture
       mit sx/sy) — der gehört in engine/renderer.js und existiert dort auch.
       Weil er die Bedienoberfläche verdrängt hat, blieb der Barbier leer und
       der Klick wirkungslos. */
    const desc=document.createElement('div'); desc.className='desc';
    desc.textContent = 'Spiegel, Schere, ruhige Hand. Ändere dein Aussehen oder das eines Kolonisten — kostenlos, so oft du magst.';
    wrap.appendChild(desc);

    const sel=document.createElement('select'); sel.className='barberSelect';
    const optP=document.createElement('option'); optP.value='__player__'; optP.textContent='Du selbst';
    sel.appendChild(optP);
    state.colonists.forEach(c=>{
      const o=document.createElement('option'); o.value=c.id; o.textContent=c.name; sel.appendChild(o);
    });
    wrap.appendChild(sel);

    const editor=document.createElement('div'); editor.className='barberEditor';
    wrap.appendChild(editor);

    function zielVon(){
      return sel.value==='__player__'
        ? state.player
        : state.colonists.find(c=>c.id===sel.value);
    }
    function editorZeigen(){
      const ziel = zielVon();
      if(!ziel){ editor.innerHTML='<div class="desc">Diese Person ist nicht mehr da.</div>'; return; }
      if(!ziel.appearance) ziel.appearance = randomAppearance();
      renderAppearanceEditor(editor, ziel.appearance, ()=>{
        saveGame();
        updateColonyIfOpen();
      });
    }
    sel.onchange = ()=>{ sfxEvent(); editorZeigen(); };
    editorZeigen();

    const btnZufall=document.createElement('button');
    btnZufall.textContent='🎲 Komplett neu würfeln';
    btnZufall.onclick=()=>{
      const ziel = zielVon(); if(!ziel) return;
      ziel.appearance = randomAppearance();
      sfxEvent(); toast('💈 Frisch gestylt!');
      saveGame(); updateColonyIfOpen(); editorZeigen();
    };
    wrap.appendChild(btnZufall);
  } else if(b.type==='brunnen'){
    const desc=document.createElement('div'); desc.className='desc';
    desc.textContent = 'Klares, kühles Wasser — praktisch, ohne den weiten Weg zum See. Der Brunnen erschöpft sich aber, wenn er zu oft am selben Tag genutzt wird.';
    wrap.appendChild(desc);
    const currentDay = Math.floor((Date.now()-(state.dayCycleOffset||0))/DAY_CYCLE_MS);
    if(!state.brunnenUses || state.brunnenUses.day!==currentDay) state.brunnenUses = {day:currentDay, count:0};
    const usesLeft = Math.max(0, 3-state.brunnenUses.count);
    const btn=document.createElement('button'); btn.textContent = usesLeft>0 ? `💧 Trinken (Durst +25) — noch ${usesLeft}x heute` : '💧 Brunnen ist für heute erschöpft';
    btn.disabled = usesLeft<=0;
    btn.onclick=()=>{
      if(state.brunnenUses.count>=3) return;
      state.brunnenUses.count++;
      state.stats.thirst = clamp(state.stats.thirst+25,0,100);
      sfxDrink(); toast('💧 Erfrischend! Durst +25'); updateHUD(); saveGame(); renderInteriorBody(b);
    };
    wrap.appendChild(btn);
  } else if(b.type==='bibliothek'){
    /* Auch hier lag Zeichencode statt Bedienoberfläche. */
    const desc=document.createElement('div'); desc.className='desc';
    desc.textContent = 'Gesammeltes Wissen der Kolonie. Wer hier liest, hebt seine Stimmung und lernt nebenbei etwas.';
    wrap.appendChild(desc);
    const caught = Object.keys(state.collection).length;
    const info=document.createElement('div'); info.className='resItem';
    info.innerHTML = `<span>📖 Erforschte Arten</span><span>${caught} / ${SPECIES.length}</span>`;
    wrap.appendChild(info);
    const cost = {fiber:2};
    const btn=document.createElement('button');
    btn.textContent = '📖 Eine Weile lesen (Laune +8, 2 🌾)';
    btn.disabled = !canAfford(cost);
    btn.onclick=()=>{
      if(!canAfford(cost)) return;
      pay(cost);
      state.stats.mood = clamp((state.stats.mood||50)+8, 0, 100);
      sfxEvent(); toast('📖 Eine ruhige Stunde zwischen den Regalen. Laune +8');
      updateHUD(); saveGame(); renderInteriorBody(b);
    };
    wrap.appendChild(btn);
  } else if(b.type==='zwinger'){
    const desc=document.createElement('div'); desc.className='desc';
    desc.textContent = 'Ein Unterstand für gezähmte Wesen. Solange der Zwinger steht, halten deine Fallen spürbar besser.';
    wrap.appendChild(desc);
    const caught = Object.keys(state.collection).length;
    const info=document.createElement('div'); info.className='resItem';
    info.innerHTML = `<span>📖 Gefangene Arten</span><span>${caught} / ${SPECIES.length}</span>`;
    wrap.appendChild(info);
    if(state.activeId!=null && state.collection[state.activeId]){
      const sp = SPECIES[state.activeId]; const c = state.collection[state.activeId];
      const info2=document.createElement('div'); info2.className='resItem'; info2.style.marginTop='6px';
      info2.innerHTML = `<span>🐾 Aktueller Begleiter</span><span>${sp.name} (${c.currentHp}/${sp.stats.hp} LP)</span>`;
      wrap.appendChild(info2);
    }
  } else if(b.type==='krankenstube'){
    /* Auch hier lag Zeichencode statt Bedienoberfläche. */
    const desc=document.createElement('div'); desc.className='desc';
    desc.textContent = 'Saubere Liege, Verbandszeug, Kräuter. Hier kurierst du dich und deine Kolonisten.';
    wrap.appendChild(desc);
    const cost = {herbs:2};
    const btnIch=document.createElement('button');
    btnIch.textContent = '⚕️ Selbst behandeln (Gesundheit +30, 2 🌱)';
    btnIch.disabled = !canAfford(cost);
    btnIch.onclick=()=>{
      if(!canAfford(cost)) return;
      pay(cost);
      state.stats.health = clamp((state.stats.health||100)+30, 0, 100);
      sfxEvent(); toast('⚕️ Versorgt. Gesundheit +30');
      updateHUD(); saveGame(); renderInteriorBody(b);
    };
    wrap.appendChild(btnIch);

    const verletzt = state.colonists.filter(c=>(c.health!=null ? c.health : 100) < 100);
    if(verletzt.length){
      const head=document.createElement('div'); head.className='rcHead'; head.textContent='Kolonisten in Behandlung';
      wrap.appendChild(head);
      verletzt.forEach(c=>{
        const row=document.createElement('div'); row.className='refineRow';
        row.innerHTML = `<span class="rr-name">${c.name} — ${Math.round(c.health!=null?c.health:100)} % Gesundheit</span>`;
        const bh=document.createElement('button'); bh.textContent='Behandeln (2 🌱)';
        bh.disabled = !canAfford(cost);
        bh.onclick=()=>{
          if(!canAfford(cost)) return;
          pay(cost);
          c.health = clamp((c.health!=null?c.health:100)+30, 0, 100);
          sfxEvent(); toast(`⚕️ ${c.name} wurde versorgt.`);
          updateHUD(); saveGame(); updateColonyIfOpen(); renderInteriorBody(b);
        };
        row.appendChild(bh); wrap.appendChild(row);
      });
    } else {
      const ok=document.createElement('div'); ok.className='desc';
      ok.textContent = 'Zurzeit ist niemand verletzt.';
      wrap.appendChild(ok);
    }
  } else if(b.type==='kuechenherd'){
    const desc=document.createElement('div'); desc.className='desc';
    desc.textContent = 'Koche nahrhafte Gerichte aus erjagtem Fleisch und Wildgemüse — Mahlzeiten sättigen deutlich mehr als rohe Beeren.';
    wrap.appendChild(desc);
    const availableMeats = MEAT_TYPES.filter(k=>(state.inventory[k]||0)>0);
    COOKING_RECIPES.forEach(r=>{
      const row=document.createElement('div'); row.className='refineRow'; row.style.flexDirection='column'; row.style.alignItems='stretch'; row.style.gap='4px';
      let costText = Object.entries(r.extraCost).map(([k,v])=>v+' '+(RESOURCE_ICONS[k]||k)+' '+RESOURCE_NAMES[k]).join(', ');
      if(r.meatCost>0) costText = (costText?costText+', ':'') + r.meatCost+' 🍖 Fleisch (beliebige Sorte)';
      const topLine=document.createElement('div'); topLine.innerHTML = `<span class="rr-name">${r.label} — ${r.desc}<br><span style="font-size:10.5px;color:#5a5138;">Benötigt: ${costText}</span></span>`;
      row.appendChild(topLine);
      let meatSel=null;
      if(r.meatCost>0){
        const selWrap=document.createElement('div'); selWrap.style.fontSize='11px';
        meatSel=document.createElement('select');
        if(availableMeats.length===0){
          const opt=document.createElement('option'); opt.textContent='Kein Fleisch vorhanden'; opt.disabled=true; meatSel.appendChild(opt);
        } else {
          availableMeats.forEach(k=>{ const opt=document.createElement('option'); opt.value=k; opt.textContent=RESOURCE_ICONS[k]+' '+RESOURCE_NAMES[k]+' ('+state.inventory[k]+')'; meatSel.appendChild(opt); });
        }
        selWrap.appendChild(document.createTextNode('Fleischsorte: ')); selWrap.appendChild(meatSel);
        row.appendChild(selWrap);
      }
      const btn2=document.createElement('button'); btn2.textContent='Kochen';
      const canCook = ()=>{
        const extraOk = Object.entries(r.extraCost).every(([k,v])=>(state.inventory[k]||0)>=v);
        const meatOk = r.meatCost<=0 || (meatSel && meatSel.value && (state.inventory[meatSel.value]||0)>=r.meatCost);
        return extraOk && meatOk;
      };
      btn2.disabled = !canCook();
      if(meatSel) meatSel.onchange = ()=>{ btn2.disabled = !canCook(); };
      btn2.onclick=()=>{
        if(!canCook()) return;
        Object.entries(r.extraCost).forEach(([k,v])=>{ state.inventory[k]-=v; });
        if(r.meatCost>0){ state.inventory[meatSel.value]-=r.meatCost; }
        let outAmt = r.outputAmt;
        if(r.output==='meal_brot' && state.buildings.some(bb=>bb.type==='muehle' && bb.built)) outAmt += 1;
        if(state.buildings.some(bb=>bb.type==='baeckerei' && bb.built)) outAmt += 1;
        state.inventory[r.output] = (state.inventory[r.output]||0)+outAmt;
        (state.quests.side||[]).forEach(q=>{ if(q.type==='cook') q.cookedCount=(q.cookedCount||0)+1; });
        sfxCraft(); toast(r.label+' zubereitet!');
        logEvent('🍳 '+r.label+' am Küchenherd zubereitet.');
        updateHUD(); saveGame(); renderInteriorBody(b);
      };
      row.appendChild(btn2);
      wrap.appendChild(row);
    });
  }
}
function openBuildingInterior(b){
  openOverlay('interiorOverlay');
  document.getElementById('interiorTitle').textContent = INTERIOR_TITLE[b.type] || 'Gebäude';
  drawInteriorScene(b.type);
  renderInteriorBody(b);
  document.getElementById('interiorOverlay').classList.remove('hidden');
}
function closeBuildingInterior(){ closeOverlay('interiorOverlay'); }

/* ============================================================
   Erststart der Fenster
   Wird von main.js aufgerufen, sobald der Spielzustand steht.
============================================================ */
function initPanels(){
  updateHUD();
}

/* ============================================================
   Verdrahtung der Fenster
   Alle Knopf-Zuweisungen und die Overlay-Registrierung. Wird von
   main.js aufgerufen, sobald die Seite steht.
============================================================ */
function initPanelHandlers(){
  document.getElementById('btnCraft').onclick = openCraft;
  document.getElementById('closeCraft').onclick = closeCraft;
  document.getElementById('closeDex').onclick = closeDex;
  document.getElementById('closeCharacter').onclick = closeCharacter;
  document.getElementById('closeJournal').onclick = closeJournal;
  document.getElementById('closeGoals').onclick = closeGoals;
  document.getElementById('launchCharacter').onclick = ()=>{ closeMainMenu(); openCharacter(); };
  document.getElementById('launchDex').onclick = ()=>{ closeMainMenu(); openDex(); };
  document.getElementById('launchJournal').onclick = ()=>{ closeMainMenu(); openJournal(); };
  document.getElementById('launchChronik').onclick = ()=>{ closeMainMenu(); openChronik(); };
  document.getElementById('launchGoals').onclick = ()=>{ closeMainMenu(); openGoals(); };
  document.getElementById('launchWorldMap').onclick = ()=>{ closeMainMenu(); openWorldMap(); };
  document.getElementById('launchColony').onclick = ()=>{ closeMainMenu(); openColony(); };
  document.getElementById('launchCraft').onclick = ()=>{ closeMainMenu(); openCraft(); };
  document.getElementById('launchResearch').onclick = ()=>{ closeMainMenu(); openResearch(); };
  document.getElementById('launchOptions').onclick = ()=>{ closeMainMenu(); openOptions(); };
  document.getElementById('launchWork').onclick = ()=>{ closeMainMenu(); openWork(); };
  document.getElementById('launchOverworld').onclick = ()=>{ closeMainMenu(); openOverworld(); };
  document.getElementById('launchMacro').onclick = ()=>{
    closeMainMenu();
    document.getElementById('macroContName').textContent = (CONTINENTS[currentContinent()]||{}).name || 'Farholm';
    enterMacroMap();
  };
  document.getElementById('macroBack').onclick = exitMacroMap;
  document.getElementById('closeOverworld').onclick = closeOverworld;
  /* Register aller Fenster. Beim Aufteilen des Monolithen ist diese Liste
     bis auf craftOverlay verloren gegangen — nicht registrierte Fenster
     laufen in openOverlay/closeOverlay in den frühen return, wodurch sie
     sich nicht mehr schließen lassen (Story-Dialog blieb hängen) und
     weder Escape noch die Modusumschaltung greifen. */
  [['craftOverlay',       ()=>{ renderCraftTabs(); renderRecipes(); }],
   ['colonyOverlay',      ()=>{ renderColony(); }],
   ['dexOverlay',         ()=>{ renderDex(); }],
   ['researchOverlay',    ()=>{ renderResearch(); }],
   ['journalOverlay',     ()=>{ renderJournalWindow(); }],
   ['characterOverlay',   ()=>{ renderCharacterWindow(); }],
   ['chronikOverlay',     ()=>{ renderChronik(); }],
   ['goalsOverlay',       ()=>{ renderGoalsWindow(); }],
   ['workOverlay',        ()=>{ renderWorkTable(); }],
   ['worldMapOverlay',    ()=>{ renderWorldMap(); }],
   ['villageShopOverlay', ()=>{ renderVillageShop(); }],
   ['overworldOverlay',   ()=>{ renderOverworldList(); }],
   ['optionsOverlay',     null],   // openOptions() zeichnet selbst
   ['storyOverlay',       null],   // Inhalt kommt aus showStoryDialog()
   ['introOverlay',       null],
   ['mainMenuOverlay',    null],
   ['slotsOverlay',       null],
   ['interiorOverlay',    null],
  ].forEach(([id,fn])=>{ if(document.getElementById(id)) registerOverlay(id, fn ? {onOpen:fn} : undefined); });
  if(document.getElementById('macroOverlay')) registerOverlay('macroOverlay',{mode:'macro'});
  if(document.getElementById('encounter')) registerOverlay('encounter',{mode:'battle'});
  document.getElementById('closeWork').onclick = closeWork;
  if(ssMouse) ssMouse.onclick = ()=>{
    if(keyboardCameraEnabled) document.getElementById('btnKeyToggle').click();
    updateStartStyleButtons();
  };
  if(ssClick) ssClick.onclick = ()=>{
    if(!keyboardCameraEnabled) document.getElementById('btnKeyToggle').click();
    updateStartStyleButtons();
  };
  updateStartStyleButtons();
  document.getElementById('closeOptions').onclick = closeOptions;
  if(replayIntroBtn) replayIntroBtn.onclick = ()=>{ closeOptions(); startIntro(); };
  if(alignBtn) alignBtn.onclick = ()=>{ alignAllFurniture(); };
  document.getElementById('optStyleMouse').onclick = ()=>{
    if(keyboardCameraEnabled) document.getElementById('btnKeyToggle').click();
    updateOptStyleButtons();
  };
  document.getElementById('optStyleKeys').onclick = ()=>{
    if(!keyboardCameraEnabled) document.getElementById('btnKeyToggle').click();
    updateOptStyleButtons();
  };
  document.getElementById('closeSlots').onclick = closeSlots;
  document.getElementById('launchSave').onclick = ()=>{ closeMainMenu(); openSlotsOverlay('save'); };
  document.getElementById('launchLoad').onclick = ()=>{ closeMainMenu(); openSlotsOverlay('load'); };
  document.getElementById('btnMainMenu').onclick = openMainMenu;
  document.getElementById('closeMainMenu').onclick = closeMainMenu;
  document.getElementById('btnRest').onclick = tryRest;
  document.getElementById('btnColony').onclick = openColony;
  document.getElementById('closeColony').onclick = closeColony;
  document.getElementById('btnWorldMap').onclick = openWorldMap;
  document.getElementById('closeWorldMap').onclick = closeWorldMap;
  document.getElementById('btnResearch').onclick = openResearch;
  document.getElementById('closeResearch').onclick = closeResearch;
  document.getElementById('closeVillageShop').onclick = closeVillageShop;
  document.getElementById('closeChronik').onclick = closeChronik;
  (function(){
    if(typeof PRODUCTION_RECIPES === 'undefined') return;
    Object.keys(PRODUCTION_RECIPES).forEach(t=>{
      if(!ENTERABLE_TYPES.includes(t)) ENTERABLE_TYPES.push(t);
    });
  })();
  document.getElementById('closeInterior').onclick = closeBuildingInterior;
}

/* ---------- Rückschreibe-Setter für die globale Brücke ----------
   Diese Bindings werden von anderen Modulen überschrieben. Ohne diese
   Funktionen käme die Zuweisung hier nie an und dieses Modul würde mit
   einem veralteten Wert weiterarbeiten. Siehe bridgeModule() in main.js. */
function __set_awaitingDestination(v){ awaitingDestination = v; }
function __set_buildMode(v){ buildMode = v; }
function __set_cameraFreeMode(v){ cameraFreeMode = v; }
function __set_demolishDrag(v){ demolishDrag = v; }
function __set_demolishMode(v){ demolishMode = v; }
function __set_groundItems(v){ groundItems = v; }
function __set_hoverTile(v){ hoverTile = v; }
function __set_keyboardCameraEnabled(v){ keyboardCameraEnabled = v; }
function __set_selectedColonistId(v){ selectedColonistId = v; }
function __set_wildMonsters(v){ wildMonsters = v; }

export {
  hudEls,
  hudLetzte,
  HUD_RESSOURCEN,
  kistenSortierung,
  pauseFortsetzen,
  pauseZumTitel,
  initPauseMenu,
  toggleDesMenu,
  updateCmdCursor,
  initDesignationTools,
  charTabAktiv,
  switchCharTab,
  initCharTabs,
  CHAR_TABS,
  reloadGameMidSession,
  __set_awaitingDestination,
  __set_buildMode,
  __set_cameraFreeMode,
  __set_demolishDrag,
  __set_demolishMode,
  __set_groundItems,
  __set_hoverTile,
  __set_keyboardCameraEnabled,
  __set_selectedColonistId,
  __set_wildMonsters,

  newUid,
  uidCounter,
  AUTOTILED,
  BIOME_TYPE_BIAS,
  BUILD_ORDER,
  BUILD_STAGE,
  ENTERABLE_BASE,
  ENTERABLE_TYPES,
  FOOD_ITEMS,
  INTERIOR_TITLE,
  MAIN_QUEST_STAGES,
  OVERLAYS,
  SIDE_QUEST_TEMPLATES,
  STARTER_GOALS,
  TECH_TIERS,
  TECH_TIER_LABELS,
  VILLAGE_TRADES,
  WM_BIOME_ART,
  alignBtn,
  anyOverlayOpen,
  awaitingDestination,
  buildMode,
  buildStageOf,
  bumpResource,
  cameraFreeMode,
  cameraKeysHeld,
  checkMainQuestProgress,
  checkSideQuests,
  closeAllOverlays,
  closeBuildingInterior,
  closeCharacter,
  closeChronik,
  closeColony,
  closeCraft,
  closeDex,
  closeGoals,
  closeInventory,
  closeJournal,
  closeMainMenu,
  closeOptions,
  closeOverlay,
  closeResearch,
  closeSlots,
  closeTopOverlay,
  closeVillageShop,
  closeWork,
  closeWorldMap,
  colonyOpenId,
  colonyResTab,
  consumeFood,
  craftForSlotFromDrag,
  demolishDrag,
  demolishMode,
  drawInteriorScene,
  facingDelta,
  generateSideQuest,
  getMetaByKey,
  getSlotMeta,
  groundItems,
  housingCap,
  hoverTile,
  initPanelHandlers,
  initPanels,
  isOverlayOpen,
  isRotatable,
  keyboardCameraEnabled,
  logEvent,
  moodColor,
  movementKeysHeld,
  openBuildingInterior,
  openCharacter,
  openChronik,
  openColony,
  openCraft,
  openDex,
  openGoals,
  openInventory,
  openJournal,
  openMainMenu,
  openOptions,
  openOverlay,
  openResearch,
  openSlotsOverlay,
  openVillageShop,
  openWork,
  openWorldMap,
  outpostCounts,
  overlayStack,
  paintRegionThumb,
  recruitColonist,
  refine,
  registerOverlay,
  renderAbilityList,
  renderAttributePoints,
  renderCharClassEditor,
  renderCharacterWindow,
  renderChronik,
  renderChronikContent,
  renderColony,
  renderDex,
  renderDexContent,
  renderGoalsWindow,
  renderInteriorBody,
  renderInventoryFood,
  renderInventorySlots,
  renderJournalWindow,
  renderRecipes,
  renderResearch,
  renderVillageShop,
  renderWorkTable,
  renderWorldMap,
  renderWorldMapContent,
  replayIntroBtn,
  reservedTargets,
  seedWildMonsters,
  selectedColonistId,
  sideQuestProgress,
  slotKey,
  ssClick,
  ssMouse,
  toast,
  tryRest,
  trySpawnWild,
  updateColonyIfOpen,
  updateHUD,
  updateOptStyleButtons,
  updateResearchIfOpen,
  updateStartStyleButtons,
  weightedSpecies,
  wildMonsters
};
