/* ============================================================
   ui/input.js — Eingabe
   Maussteuerung auf dem Spielfeld, frei belegbare Tasten,
   Kolonistenauswahl und Möbelausrichtung.
============================================================ */

import { genId } from '../engine/rng.js';
import { activeMusicTrackKey, ensureAudio, musicEnabled, setMusicEnabled, setSoundEnabled, sfxDemolish, sfxError, sfxPlace, soundEnabled, startMusicTrack, stopMusic } from '../engine/audio.js';
/* ============================================================
   Sitzmöbel richten sich selbst aus
   Ein Stuhl neben Feuerstelle, Tisch oder Spieltisch dreht sich
   automatisch dorthin — wie in RimWorld. Kein Verdrehen mehr.
============================================================ */
const SEATING_TYPES = ['stuhl','bank'];
// Dinge, zu denen man sich hinsetzt
const SEAT_FOCUS_TYPES = ['campfire','kamin','schachtisch','kegelbahn','musikecke',
                          'tisch','esstisch','kuechenherd','brunnen','research','bibliothek'];
// rotation 0 = Blick nach Süden. Die Werte ergeben sich aus der Drehrichtung des Canvas.
const FACE_ROTATION = { north:180, west:90, east:270, south:0 };
// Sucht in den vier Nachbarfeldern ein Objekt, zu dem man sich setzt
function seatFocusRotation(x, y, regionId){
  const reg = regionId || 'C';
  const dirs = [
    {dx:0, dy:-1, face:'north'}, {dx:0, dy:1,  face:'south'},
    {dx:-1,dy:0,  face:'west'},  {dx:1, dy:0,  face:'east'}
  ];
  for(const d of dirs){
    const hit = state.buildings.find(bb => bb.x===x+d.dx && bb.y===y+d.dy &&
      (bb.regionId||'C')===reg && SEAT_FOCUS_TYPES.includes(bb.type));
    if(hit) return FACE_ROTATION[d.face];
  }
  return null;   // nichts in der Nähe -> Standardausrichtung behalten
}
// Richtet alle bestehenden Sitzmöbel an ihrem Bezugspunkt aus
function realignSeating(){
  let n = 0;
  (state.buildings||[]).forEach(b=>{
    if(!SEATING_TYPES.includes(b.type)) return;
    const rot = seatFocusRotation(b.x, b.y, b.regionId);
    const target = (rot===null) ? 0 : rot;
    if(b.rotation !== target){ b.rotation = target; n++; }
  });
  return n;
}
/* --- Einmalige Bereinigung: Möbel, die durch den alten Mausrad-Fehler
   zufällig verdreht platziert wurden, wieder einheitlich ausrichten. --- */
function alignFurnitureOnce(){
  if(state.furnitureAligned) return;
  let n = 0;
  (state.buildings||[]).forEach(b=>{
    if(SEATING_TYPES.includes(b.type)) return;
    if(b.rotation && BUILDING_MENU_CATEGORY[b.type]==='moebel'){ b.rotation = 0; n++; }
  });
  n += realignSeating();
  state.furnitureAligned = true;
  if(n>0){
    toast(`🪑 ${n} verdrehte Möbel wurden einheitlich ausgerichtet.`);
    logEvent(`🪑 ${n} Möbelstücke neu ausgerichtet — sie waren durch einen Fehler verdreht.`);
    saveGame();
  }
}
// Manuell auslösbar, falls später wieder etwas schiefsteht
function alignAllFurniture(){
  let n = 0;
  (state.buildings||[]).forEach(b=>{
    if(SEATING_TYPES.includes(b.type)) return;   // Sitzmöbel gesondert behandeln
    if(b.rotation && BUILDING_MENU_CATEGORY[b.type]==='moebel'){ b.rotation = 0; n++; }
  });
  n += realignSeating();   // Stühle und Bänke zum Tisch bzw. Feuer drehen
  toast(n ? `🪑 ${n} Möbel ausgerichtet.` : '🪑 Alle Möbel stehen bereits richtig.');
  saveGame();
}
function applyRecipeDescriptions(){
  if(typeof PRODUCTION_RECIPES === 'undefined') return;
  Object.keys(PRODUCTION_RECIPES).forEach(t=>{
    if(!BUILDING_TYPES[t]) return;
    BUILDING_TYPES[t].desc = PRODUCTION_RECIPES[t].map(r=>r.label).join(' · ');
  });
}
const RECREATION_TYPES = ['schachtisch','kegelbahn','musikecke'];
const DECOR_TYPES = ['teppich','statue','blumentopf','kamin','fackel','kommode','schreibtisch','marmorboden'];
const BUILD_CATEGORY = { wall:'line', door:'line', stockpile:'area', zaun:'line', copperwall:'line', silverwall:'line', goldwall:'line', titanwall:'line', holzboden:'area', steinboden:'area', schutzzone:'area', feld_beeren:'area', feld_gemuese:'area', feld_kraeuter:'area', feld_fasern:'area', feld_getreide:'area', tiergehege:'area', teppich:'area', marmorboden:'area', gartenweg:'area', spitzenfalle:'line', holzwand1:'line', holzwand2:'line', holzwand3:'line', fensterwand1:'line', fensterwand2:'line', fensterwand3:'line', metallwand1:'line', metallwand2:'line', metallwand3:'line' };
const BUILDING_MENU_CATEGORY = {
  holzwand1:'struktur', holzwand2:'struktur', holzwand3:'struktur', fensterwand1:'struktur', fensterwand2:'struktur', fensterwand3:'struktur', metallwand1:'struktur', metallwand2:'struktur', metallwand3:'struktur',
  wall:'struktur', zaun:'struktur', copperwall:'struktur', silverwall:'struktur', goldwall:'struktur', titanwall:'struktur', door:'struktur', tower:'struktur', wachhaus:'struktur', spitzenfalle:'struktur', ballista:'struktur',
  campfire:'produktion', sawmill:'produktion', furnace:'produktion', loom:'produktion', workbench:'produktion', forge:'produktion', research:'produktion', zwinger:'produktion', kuechenherd:'produktion',
  toepferei:'produktion', gerberei:'produktion', muehle:'produktion', baeckerei:'produktion', alchemielabor:'produktion', schreinerei:'produktion', steinmetz:'produktion',
  schmiede:'produktion', werkstatt:'produktion', werft:'produktion', primitivbank:'produktion',
  lagerkiste:'moebel',
  tent:'moebel', barber:'moebel', bibliothek:'moebel', krankenstube:'moebel', vorratskammer:'moebel', stockpile:'moebel', brunnen:'moebel', stuhl:'moebel', bank:'moebel', schutzzone:'struktur', feld_beeren:'struktur', feld_gemuese:'struktur', feld_kraeuter:'struktur', feld_fasern:'struktur', feld_getreide:'struktur', tiergehege:'struktur',
  schreibtisch:'moebel', kommode:'moebel', fackel:'moebel', kamin:'moebel', statue:'moebel', blumentopf:'moebel',
  schachtisch:'freizeit', kegelbahn:'freizeit', musikecke:'freizeit',
  holzboden:'boeden', steinboden:'boeden', teppich:'boeden', marmorboden:'boeden', gartenweg:'boeden'
};
const BUILD_MENU_CATEGORIES = [
  {key:'struktur', label:'🧱 Struktur'},
  {key:'produktion', label:'⚒️ Produktion'},
  {key:'moebel', label:'🪑 Möbel'},
  {key:'freizeit', label:'🎲 Freizeit'},
  {key:'boeden', label:'🟫 Böden'},
  {key:'sonstiges', label:'🎒 Sonstiges'}
];
function costWorkReq(cost){ let units=0; Object.values(cost).forEach(v=>units+=v); return Math.max(20, Math.round(units*6)); }
/* Bauliste erst aufbauen, wenn die Gebäudedaten bereitstehen —
   sie liegen in main.js und sind beim Laden dieses Moduls noch
   nicht verfügbar. */
let RECIPES = [];
function buildRecipeList(){
  RECIPES = Object.keys(BUILDING_TYPES).map(type=>({type, building:true, ...BUILDING_TYPES[type]}))
    .concat([{type:'trap_item', building:false, name:'🪤 Falle', cost:{wood:3,stone:3}, desc:'Zum Fangen wilder Kreaturen'}]);
  return RECIPES;
}

function canAfford(cost){ return Object.keys(cost).every(k => state.inventory[k]>=cost[k]); }
function pay(cost){ Object.keys(cost).forEach(k => state.inventory[k]-=cost[k]); }

function computeBuildTiles(type, start, end){
  const cat = BUILD_CATEGORY[type]||'single';
  if(cat==='single' || !start) return [end];
  if(cat==='line'){
    const dx=Math.abs(end.x-start.x), dy=Math.abs(end.y-start.y);
    const tiles=[];
    if(dx>=dy){ const y=start.y; const x0=Math.min(start.x,end.x), x1=Math.max(start.x,end.x); for(let x=x0;x<=x1;x++) tiles.push({x,y}); }
    else { const x=start.x; const y0=Math.min(start.y,end.y), y1=Math.max(start.y,end.y); for(let y=y0;y<=y1;y++) tiles.push({x,y}); }
    return tiles;
  }
  if(cat==='area'){
    const x0=Math.min(start.x,end.x), x1=Math.max(start.x,end.x);
    const y0=Math.min(start.y,end.y), y1=Math.max(start.y,end.y);
    const tiles=[]; for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++) tiles.push({x,y});
    return tiles;
  }
  return [end];
}
const FLOOR_TYPES = ['holzboden','steinboden','teppich','marmorboden','gartenweg'];
/* Eine Regel für Vorschau und Platzierung: Böden und Zonen zählen als
   Untergrund, nicht als Hindernis. Vorher blockierte jedes Gebäude —
   auch ein Holzboden — jedes weitere Bauen auf dem Feld. */
const FLOOR_LIKE_TYPES = ['holzboden','steinboden','teppich','marmorboden','gartenweg','schutzzone','stockpile'];
/* Boden und Aufbau liegen auf getrennten Ebenen — genau so werden sie auch
   gezeichnet (siehe FLAT_BUILDINGS in main.js). Bisher galten beide als
   dieselbe Ebene: sobald eine Wand auf dem Feld stand, ließ sich kein Boden
   mehr darunter legen. Jetzt stört nur, was auf derselben Ebene liegt. */
function istBodenTyp(t){ return FLOOR_LIKE_TYPES.includes(t); }

function tileBlocked(x, y, newType){
  const reg = state.player.regionId;
  const neuIstBoden = istBodenTyp(newType);
  return state.buildings.some(b=>{
    if(b.x!==x || b.y!==y || (b.regionId||'C')!==reg) return false;
    if(istBodenTyp(b.type) !== neuIstBoden) return false;   // andere Ebene: stört nicht
    return b.type !== newType;                              // gleiche Ebene: nur ein Stück
  });
}
/* ---------- Markierungsmodus ----------
   designationMode hält die aktive Aktion ('mine' | 'chop' | 'harvest') oder
   null. Ziehen mit links markiert, Ziehen mit rechts löscht — dafür braucht
   es kein eigenes Werkzeug. */
let designationMode = null;
let designationDrag = { start:null, current:null, loeschen:false };

function setDesignationMode(art){
  designationMode = (designationMode === art) ? null : art;
  designationDrag = { start:null, current:null, loeschen:false };
  if(designationMode){
    // Andere Werkzeuge ausschalten, sonst reagieren zwei auf denselben Zug
    if(buildMode.active) cancelBuildMode();
    if(demolishMode) exitDemolishMode();
    const d = DESIGNATION_ARTEN[designationMode];
    toast(`${d.icon} ${d.label}: Fläche ziehen zum Markieren, rechte Maustaste zum Löschen.`);
  }
  aktualisiereDesignationKnoepfe();
  if(typeof updateCmdCursor === 'function') updateCmdCursor();
  return designationMode;
}
function aktualisiereDesignationKnoepfe(){
  document.querySelectorAll('[data-designation]').forEach(b=>{
    b.classList.toggle('active-designation', b.dataset.designation === designationMode);
  });
}
function finalizeDesignationDrag(endTile){
  const s = designationDrag.start;
  if(!s || !designationMode){ designationDrag = {start:null,current:null,loeschen:false}; return; }
  const e = endTile || designationDrag.current || s;
  let n;
  if(designationDrag.loeschen){
    n = clearArea(s.x, s.y, e.x, e.y);
    if(n) toast(`🧹 ${n} Markierung${n===1?'':'en'} entfernt.`);
  } else {
    n = designateArea(s.x, s.y, e.x, e.y, designationMode, state.player.regionId);
    const d = DESIGNATION_ARTEN[designationMode];
    toast(n ? `${d.icon} ${n} Kachel${n===1?'':'n'} zum ${d.label} markiert.`
            : 'Auf dieser Fläche gibt es nichts Passendes.');
    if(n) sfxEvent(); else sfxError();
  }
  designationDrag = {start:null,current:null,loeschen:false};
  saveGame();
}

function canBuildAt(x, y, newType){
  if(objAt(x,y)) return false;                 // Baum oder Fels im Weg
  if(tileBlocked(x,y,newType)) return false;   // Ebene schon belegt
  if(istBodenTyp(newType)){
    /* Böden dürfen unter Wänden und Fenstern durchgelegt werden. passable()
       verneint jedes Feld mit Wand — für die Bodenebene ist das die falsche
       Frage. Entscheidend ist nur, ob der Untergrund taugt. */
    const t = tileAt(x,y);
    return t===TILE_GRASS || t===TILE_SAND;
  }
  return passable(x,y);
}
function buildingAt(x,y,regionId){
  regionId = regionId || state.player.regionId;
  return state.buildings.find(b=>b.x===x&&b.y===y&&(b.regionId||'C')===regionId);
}
function buildingsAt(x,y,regionId){
  regionId = regionId || state.player.regionId;
  return state.buildings.filter(b=>b.x===x&&b.y===y&&(b.regionId||'C')===regionId);
}
function placeBlueprintAt(type,x,y,cost){
  if(!passable(x,y) || objAt(x,y)) return false;
  const existing = buildingsAt(x,y);
  for(const b of existing){
    const stackableWithZone = (b.type==='schutzzone' || type==='schutzzone') && b.type!==type;
    const stackableWithFloor = (FLOOR_TYPES.includes(b.type) || FLOOR_TYPES.includes(type)) && b.type!==type;
    if(!stackableWithZone && !stackableWithFloor) return false;
  }
  if(!canAfford(cost)) return false;
  pay(cost);
  // Sitzmöbel richten sich selbst zum nächsten Tisch bzw. Feuer aus
  let rot = buildMode.rotation||0;
  if(SEATING_TYPES.includes(type) && !buildMode.keepRotation){
    const auto = seatFocusRotation(x, y, state.player.regionId);
    if(auto !== null) rot = auto;
  }
  state.buildings.push({id:genId(), type, x, y, built:false, work:0, workReq:costWorkReq(cost), regionId: state.player.regionId, rotation: rot});
  // Ausrichtung nach jeder Platzierung zurücksetzen, damit Möbelreihen
  // standardmäßig einheitlich stehen statt zufällig verdreht
  if(!buildMode.keepRotation) buildMode.rotation = 0;
  if(atHome() && !state.colonyCenter) state.colonyCenter = {x,y};
  return true;
}
function finalizeBuildDrag(endTile){
  const type = buildMode.type;
  const start = buildMode.dragStart || endTile;
  const tiles = computeBuildTiles(type, start, endTile);
  let placed = 0;
  tiles.forEach(t=>{ if(placeBlueprintAt(type, t.x, t.y, BUILDING_TYPES[type].cost)) placed++; });
  if(placed>0){ sfxPlace(); toast(placed+' Baustelle(n) für '+BUILDING_TYPES[type].name+' errichtet!'); updateHUD(); saveGame(); }
  else { sfxError(); toast('Keine gültigen Felder oder zu wenig Rohstoffe.'); }
  cancelBuildMode();
}
function cancelBuildMode(){
  buildMode = { active:false, type:null, dragStart:null, dragCurrent:null, rotation:0, keepRotation:false };
  document.getElementById('buildModeBanner').style.display='none';
}
let craftActiveTab = 'struktur';
function renderCraftTabs(){
  const wrap = document.getElementById('craftTabs'); wrap.innerHTML='';
  BUILD_MENU_CATEGORIES.forEach(cat=>{
    const btn = document.createElement('button'); btn.className = 'mmTab'+(craftActiveTab===cat.key?' active':'');
    btn.textContent = cat.label;
    btn.onclick = ()=>{ craftActiveTab = cat.key; renderCraftTabs(); renderRecipes(); };
    wrap.appendChild(btn);
  });
}
/* ============================================================
   Colonist selection & command bar (mouse commands)
============================================================ */
function selectColonist(id){
  selectedColonistId = id; awaitingDestination = false;
  updateCommandBar(); updateColonyIfOpen();
}
function deselectColonist(){ selectedColonistId = null; awaitingDestination = false; updateCommandBar(); updateColonyIfOpen(); }
function updateCommandBar(){
  const bar = document.getElementById('commandBar');
  const c = state.colonists.find(cc=>cc.id===selectedColonistId);
  if(!c){ bar.classList.remove('show'); return; }
  bar.classList.add('show');
  // zeigt die aktuell wichtigste Arbeit statt einer festen Rolle
  const p = ensurePriorities(c);
  document.getElementById('cbName').textContent = c.name+' — '+colonistActivity(c);
  document.getElementById('cbGoto').textContent = awaitingDestination ? '📍 Ziel im Feld anklicken…' : '📍 Ziel wählen';
}
const cbWorkBtn = document.getElementById('cbWork');

function issueManualOrder(id, tile){
  const c = state.colonists.find(cc=>cc.id===id); if(!c) return;
  if(c.job) releaseJob(c);
  const o = objAt(tile.x,tile.y);
  const bp = state.buildings.find(b=>b.x===tile.x&&b.y===tile.y&&!b.built&&(b.regionId||'C')===state.player.regionId);
  if(bp){ if(startJobTo(c,bp.x,bp.y,{kind:'build',refId:bp.id})){ toast(c.name+' baut jetzt an '+BUILDING_TYPES[bp.type].name+'.'); } }
  else if(o && o.type==='tree'){ if(startJobTo(c,tile.x,tile.y,{kind:'chop',refKey:tile.x+','+tile.y})){ toast(c.name+' fällt einen Baum.'); } }
  else if(o && (o.type==='rock'||o.type==='orevein'||o.type==='mountain')){ if(startJobTo(c,tile.x,tile.y,{kind:'mine',refKey:tile.x+','+tile.y})){ toast(c.name+' baut ab.'); } }
  else if(o && (o.type==='bush'||o.type==='fiberbush'||o.type==='wildgemuese')){ if(startJobTo(c,tile.x,tile.y,{kind:'harvest',refKey:tile.x+','+tile.y})){ toast(c.name+' erntet.'); } }
  else if(passable(tile.x,tile.y)){
    const path=findPath(c.x,c.y,tile.x,tile.y);
    if(path){ c.job={kind:'goto',reserveKey:null}; c.path=path; c.state='moving'; c.anim=null; toast(c.name+' geht dorthin.'); }
  }
  updateColonyIfOpen();
}

/* ============================================================
   Mouse input on canvas
============================================================ */
const canvas = document.getElementById('game');
function canvasToTile(clientX, clientY){
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width/rect.width, scaleY = canvas.height/rect.height;
  const cx = (clientX-rect.left)*scaleX, cy=(clientY-rect.top)*scaleY;
  return { x: Math.floor(camera.x + cx/TILE), y: Math.floor(camera.y + cy/TILE) };
}
function demolishBuildingAt(t){
  const reg = state.player.regionId;
  const treffer = (pruef)=> state.buildings.findIndex(b=>
    b.x===t.x && b.y===t.y && (b.regionId||'C')===reg && pruef(b));
  /* Seit Boden und Aufbau übereinander liegen dürfen, muss der Abriss den
     Aufbau zuerst nehmen — sonst verschwände der Boden unter einer
     stehenbleibenden Wand. */
  let idx = treffer(b=>!istBodenTyp(b.type));
  if(idx<0) idx = treffer(()=>true);
  if(idx<0) return null;
  const b = state.buildings[idx];
  const cost = BUILDING_TYPES[b.type].cost;
  const refunded = {};
  if(b.built){
    Object.keys(cost).forEach(k=>{ const refund=Math.floor(cost[k]*0.5); if(refund>0){ addResource(k, refund); bumpResource(k); refunded[k]=refund; } });
  } else {
    Object.keys(cost).forEach(k=>{ addResource(k, cost[k]); bumpResource(k); refunded[k]=cost[k]; });
  }
  state.buildings.splice(idx,1);
  return { type:b.type, wasBuilt:b.built };
}
function tryDemolishAt(t){
  const result = demolishBuildingAt(t);
  if(!result){ sfxError(); toast('Dort steht nichts zum Abreißen.'); return; }
  sfxDemolish();
  toast(result.wasBuilt ? (BUILDING_TYPES[result.type].name)+' abgerissen (50% Rohstoffe zurückerhalten).' : 'Baustelle abgebrochen, Rohstoffe zurückerhalten.');
  demolishMode=false; demolishDrag={start:null,current:null}; document.getElementById('btnDemolish').classList.remove('active-demolish');
  updateHUD(); updateColonyIfOpen(); saveGame();
}
function finalizeDemolishDrag(endTile){
  const start = demolishDrag.start || endTile;
  const x0=Math.min(start.x,endTile.x), x1=Math.max(start.x,endTile.x);
  const y0=Math.min(start.y,endTile.y), y1=Math.max(start.y,endTile.y);
  let count = 0;
  for(let y=y0;y<=y1;y++){ for(let x=x0;x<=x1;x++){
    const result = demolishBuildingAt({x,y});
    if(result) count++;
  } }
  if(count>0){ sfxDemolish(); toast(count+' Gebäude abgerissen (50% Rohstoffe zurückerhalten).'); }
  else { sfxError(); toast('Dort stand nichts zum Abreißen.'); }
  demolishMode=false; document.getElementById('btnDemolish').classList.remove('active-demolish');
  demolishDrag = {start:null, current:null};
  updateHUD(); updateColonyIfOpen(); saveGame();
}
function handleMapClick(t){
  if(paused) return;
  if(demolishMode){ tryDemolishAt(t); return; }
  const clickedColonist = atHome() ? state.colonists.find(c=> Math.round(c.x)===t.x && Math.round(c.y)===t.y) : null;
  if(clickedColonist){ selectColonist(clickedColonist.id); return; }
  if(selectedColonistId && awaitingDestination){ issueManualOrder(selectedColonistId, t); awaitingDestination=false; updateCommandBar(); return; }
  const wm = wildMonsters.find(w=>w.x===t.x && w.y===t.y);
  if(wm){ setPlayerTarget({type:'monster', uid:wm.uid, x:t.x, y:t.y}); return; }
  const bp = state.buildings.find(b=>b.x===t.x&&b.y===t.y&&!b.built&&(b.regionId||'C')===state.player.regionId);
  if(bp){ setPlayerTarget({type:'build', x:t.x, y:t.y}); return; }
  const eb = state.buildings.find(b=>b.x===t.x&&b.y===t.y&&b.built&&ENTERABLE_TYPES.includes(b.type)&&(b.regionId||'C')===state.player.regionId);
  if(eb){ setPlayerTarget({type:'enter', x:t.x, y:t.y, buildingId:eb.id}); return; }
  const fb = state.buildings.find(b=>b.x===t.x&&b.y===t.y&&b.built&&FIELD_YIELD[b.type]&&(b.regionId||'C')===state.player.regionId);
  if(fb && fieldGrowthProgress(fb)>=1){ setPlayerTarget({type:'harvest_field', x:t.x, y:t.y, buildingId:fb.id}); return; }
  // Dorfbewohner anklicken -> Gespräch (nur wenn nah genug)
  const vHit = villagersHere().find(v=>v.x===t.x && v.y===t.y && !v.sleeping);
  if(vHit){
    if(Math.abs(state.player.x-vHit.x)<=1 && Math.abs(state.player.y-vHit.y)<=1){
      if(vHit.isTrader){ openVillageShop(); }
      else if(vHit.shop && SHOP_TYPES[vHit.shop]){ openShop(vHit); }
      else { talkToVillager(vHit); }
    } else {
      const p = findPath(state.player.x,state.player.y,t.x,t.y);
      if(p && p.length){ p.pop(); state.player.path=p; state.player.target=null; }
      toast('💬 Geh näher heran, um zu sprechen.');
    }
    return;
  }
  const o = objAt(t.x,t.y);
  if(o && (o.type==='tree'||o.type==='rock'||o.type==='orevein'||o.type==='mountain'||o.type==='ruins_loot'||o.type==='trader'||o.type==='dungeon_portal'||o.type==='cave_entrance'||o.type==='dungeon_exit'||o.type==='dungeon_chest'||o.type==='visitor'||o.type==='quest_npc')){ setPlayerTarget({type:'gather', x:t.x, y:t.y, kind:o.type}); return; }
  if(o && (o.type==='bush'||o.type==='fiberbush'||o.type==='wildgemuese')){
    const path = findPath(state.player.x,state.player.y,t.x,t.y);
    if(path){ state.player.path=path; state.player.target=null; }
    return;
  }
  if(tileAt(t.x,t.y)===TILE_WATER){ setPlayerTarget({type:'drink', x:t.x, y:t.y}); return; }
  if(passable(t.x,t.y)){
    const path = findPath(state.player.x,state.player.y,t.x,t.y);
    if(path){ state.player.path = path; state.player.target = null; }
  }
}
/* ============================================================
   Frei belegbare Tastatursteuerung
   Alle Aktionen laufen über KEYBIND_ACTIONS; die Belegung wird
   in localStorage gespeichert und im Optionsmenü geändert.
============================================================ */
const KEYBIND_ACTIONS = [
  {id:'up',        label:'Nach oben',        group:'Bewegung', def:['w','arrowup']},
  {id:'down',      label:'Nach unten',       group:'Bewegung', def:['s','arrowdown']},
  {id:'left',      label:'Nach links',       group:'Bewegung', def:['a','arrowleft']},
  {id:'right',     label:'Nach rechts',      group:'Bewegung', def:['d','arrowright']},
  {id:'interact',  label:'Interagieren',     group:'Aktionen', def:[' ','e']},
  {id:'rest',      label:'Ausruhen',         group:'Aktionen', def:['z']},
  {id:'demolish',  label:'Abreißen',         group:'Aktionen', def:['x']},
  {id:'rotate',    label:'Gebäude drehen',   group:'Aktionen', def:['r']},
  {id:'craft',     label:'Werkbank',         group:'Menüs',    def:['c']},
  {id:'dex',       label:'Feldbuch',         group:'Menüs',    def:['i']},
  {id:'journal',   label:'Chronik',          group:'Menüs',    def:['t']},
  {id:'inventory', label:'Inventar',         group:'Menüs',    def:['u']},
  {id:'character', label:'Charakter',        group:'Menüs',    def:['p']},
  {id:'colony',    label:'Kolonie',          group:'Menüs',    def:['k']},
  {id:'work',      label:'Arbeitsübersicht', group:'Menüs',    def:['o']},
  {id:'research',  label:'Forschung',        group:'Menüs',    def:['g']},
  {id:'worldmap',  label:'Weltkarte',        group:'Menüs',    def:['m']},
  {id:'camtoggle', label:'Kamera/Figur',     group:'System',   def:['v']},
  {id:'fullscreen',label:'Vollbild',         group:'System',   def:['f']}
];
const KEYBIND_STORAGE = 'wildwood_keybinds_v1';
let keybinds = {};
function defaultKeybinds(){
  const m = {};
  KEYBIND_ACTIONS.forEach(a=> m[a.id] = a.def.slice());
  return m;
}
function loadKeybinds(){
  keybinds = defaultKeybinds();
  try{
    const raw = localStorage.getItem(KEYBIND_STORAGE);
    if(raw){
      const saved = JSON.parse(raw);
      // Auch leere Arrays übernehmen: eine bewusst geleerte Belegung darf nicht
      // stillschweigend auf den Standard zurückfallen (erzeugte sonst Doppelbelegungen)
      KEYBIND_ACTIONS.forEach(a=>{ if(Array.isArray(saved[a.id])) keybinds[a.id] = saved[a.id]; });
    }
  }catch(e){}
}
function saveKeybinds(){
  try{ localStorage.setItem(KEYBIND_STORAGE, JSON.stringify(keybinds)); }catch(e){}
}
// Welche Aktion gehört zu dieser Taste?
function actionForKey(k){
  for(const a of KEYBIND_ACTIONS){
    if((keybinds[a.id]||[]).includes(k)) return a.id;
  }
  return null;
}
// Lesbare Darstellung einer Taste
function keyLabel(k){
  if(k===' ') return 'Leertaste';
  if(k.startsWith('arrow')) return {arrowup:'↑',arrowdown:'↓',arrowleft:'←',arrowright:'→'}[k]||k;
  if(k==='escape') return 'Esc';
  return k.toUpperCase();
}

/* ---- Optionsmenü zur Tastenbelegung ---- */
let listeningFor = null;   // {actionId, slotIdx}
function renderKeybindEditor(container){
  container.innerHTML = '';
  const groups = {};
  KEYBIND_ACTIONS.forEach(a=>{ (groups[a.group] = groups[a.group] || []).push(a); });
  Object.keys(groups).forEach(gName=>{
    const h = document.createElement('div'); h.className='kbGroup'; h.textContent = gName;
    container.appendChild(h);
    groups[gName].forEach(a=>{
      const row = document.createElement('div'); row.className='kbRow';
      const lbl = document.createElement('span'); lbl.className='kbLabel'; lbl.textContent = a.label;
      row.appendChild(lbl);
      const keysWrap = document.createElement('div'); keysWrap.className='kbKeys';
      const list = keybinds[a.id] || [];
      for(let i=0;i<2;i++){
        const btn = document.createElement('button'); btn.type='button'; btn.className='kbKey';
        const cur = list[i];
        const isListening = listeningFor && listeningFor.actionId===a.id && listeningFor.slotIdx===i;
        btn.textContent = isListening ? '… drücke Taste' : (cur ? keyLabel(cur) : '—');
        if(isListening) btn.classList.add('listening');
        if(!cur && !isListening) btn.classList.add('empty');
        btn.onclick = ()=>{
          listeningFor = {actionId:a.id, slotIdx:i};
          renderKeybindEditor(container);
        };
        keysWrap.appendChild(btn);
      }
      row.appendChild(keysWrap);
      container.appendChild(row);
    });
  });
  const reset = document.createElement('button');
  reset.className='secondary'; reset.style.marginTop='10px';
  reset.textContent='↺ Standardbelegung wiederherstellen';
  reset.onclick = ()=>{ keybinds = defaultKeybinds(); saveKeybinds(); listeningFor=null; renderKeybindEditor(container); toast('⌨️ Standardbelegung wiederhergestellt.'); };
  container.appendChild(reset);
}
// Fängt den nächsten Tastendruck ab, wenn gerade eine Belegung gesetzt wird
function captureKeybind(e){
  if(!listeningFor) return false;
  e.preventDefault(); e.stopPropagation();
  const k = e.key.toLowerCase();
  if(k==='escape'){ listeningFor=null; renderKeybindEditor(document.getElementById('keybindEditor')); return true; }
  // Taste zuerst überall sonst entfernen, damit keine Doppelbelegung entsteht
  KEYBIND_ACTIONS.forEach(a=>{
    keybinds[a.id] = (keybinds[a.id]||[]).filter(x=>x!==k);
  });
  const list = keybinds[listeningFor.actionId] || [];
  list[listeningFor.slotIdx] = k;
  keybinds[listeningFor.actionId] = list.filter(Boolean);
  saveKeybinds();
  listeningFor = null;
  renderKeybindEditor(document.getElementById('keybindEditor'));
  return true;
}


/* ============================================================
   Eingabe verdrahten
   Maus- und Berührungsereignisse auf dem Spielfeld, Tastatur,
   Werkzeugleiste und Kommandoleiste. Wird von main.js aufgerufen,
   sobald die Seite steht.
============================================================ */
/* ---------- Richtungstasten ----------
   Gehalten wird die physische Taste (e.code), nicht das erzeugte Zeichen.
   Über e.key ging das Loslassen verloren, sobald sich das Zeichen zwischen
   Drücken und Loslassen änderte — etwa wenn zwischendurch Umschalt oder
   AltGr dazukam. Die beiden Mengen darunter werden immer neu aus dieser
   Karte abgeleitet und können deshalb nicht auseinanderlaufen. */
const richtungsCodes = new Map();   // physische Taste -> 'up' | 'down' | 'left' | 'right'

function mengenAusCodes(){
  cameraKeysHeld.clear();
  movementKeysHeld.clear();
  const ziel = keyboardCameraEnabled ? cameraKeysHeld : movementKeysHeld;
  richtungsCodes.forEach(act => ziel.add(act));
}
function richtungGedrueckt(code, act){
  richtungsCodes.set(code, act);
  mengenAusCodes();
}
function richtungLosgelassen(code){
  if(!richtungsCodes.has(code)) return;
  richtungsCodes.delete(code);
  mengenAusCodes();
}
function alleTastenLoslassen(){
  richtungsCodes.clear();
  cameraKeysHeld.clear();
  movementKeysHeld.clear();
}

function initInput(){
  applyRecipeDescriptions();
  if(cbWorkBtn) cbWorkBtn.addEventListener('click', ()=>{ openWork(); });
  document.getElementById('cbGoto').onclick = ()=>{ if(!selectedColonistId) return; awaitingDestination = !awaitingDestination; updateCommandBar(); };
  document.getElementById('cbDeselect').onclick = deselectColonist;
  canvas.addEventListener('mousedown', (e)=>{
    const t = canvasToTile(e.clientX,e.clientY);
    // Markierungsmodus zuerst: links markieren, rechts löschen
    if(designationMode && (e.button===0 || e.button===2)){
      designationDrag = { start:t, current:t, loeschen: e.button===2 };
      return;
    }
    if(e.button!==0) return;
    if(buildMode.active){ buildMode.dragStart = t; buildMode.dragCurrent = t; }
    else if(demolishMode){ demolishDrag.start = t; demolishDrag.current = t; }
  });
  canvas.addEventListener('mousemove', (e)=>{
    const t = canvasToTile(e.clientX,e.clientY);
    hoverTile = t;
    if(designationMode && designationDrag.start){ designationDrag.current = t; }
    else if(buildMode.active && buildMode.dragStart){ buildMode.dragCurrent = t; }
    else if(demolishMode && demolishDrag.start){ demolishDrag.current = t; }
  });
  canvas.addEventListener('mouseup', (e)=>{
    const t = canvasToTile(e.clientX,e.clientY);
    if(designationMode && designationDrag.start){ finalizeDesignationDrag(t); return; }
    if(e.button!==0) return;
    if(buildMode.active){ finalizeBuildDrag(t); return; }
    if(demolishMode && demolishDrag.start){ finalizeDemolishDrag(t); return; }
    handleMapClick(t);
  });
  canvas.addEventListener('touchstart', (e)=>{
    const touch=e.touches[0]; const t=canvasToTile(touch.clientX,touch.clientY);
    if(buildMode.active){ buildMode.dragStart=t; buildMode.dragCurrent=t; }
    else if(demolishMode){ demolishDrag.start=t; demolishDrag.current=t; }
  }, {passive:true});
  canvas.addEventListener('touchmove', (e)=>{
    const touch=e.touches[0]; const t=canvasToTile(touch.clientX,touch.clientY);
    hoverTile=t; if(buildMode.active && buildMode.dragStart){ buildMode.dragCurrent=t; }
    else if(demolishMode && demolishDrag.start){ demolishDrag.current=t; }
  }, {passive:true});
  canvas.addEventListener('touchend', (e)=>{
    if(!hoverTile) return;
    if(buildMode.active){ finalizeBuildDrag(hoverTile); return; }
    if(demolishMode && demolishDrag.start){ finalizeDemolishDrag(hoverTile); return; }
    handleMapClick(hoverTile);
  });
  /* Ein einziger Handler für die rechte Maustaste. Vorher gab es zwei auf
     demselben Canvas: einer unterdrückte das Kontextmenü im Markierungs-
     modus, der andere brach Bau- und Abrissmodus ab — bei jedem Rechtsklick
     liefen beide. Jetzt eine Kette mit klarer Rangfolge. */
  canvas.addEventListener('contextmenu', (e)=>{
    e.preventDefault();
    // Im Markierungsmodus dient Rechtsklick dem Löschen — nichts abbrechen
    if(designationMode) return;
    if(buildMode.active) cancelBuildMode();
    if(demolishMode){ demolishMode=false; demolishDrag={start:null,current:null}; document.getElementById('btnDemolish').classList.remove('active-demolish'); toast('Abriss-Modus beendet.'); }
  });
  document.getElementById('btnDemolish').onclick = ()=>{
    if(atDungeon()){ toast('In Dungeons und Höhlen gibt es nichts abzureißen.'); return; }
    demolishMode = !demolishMode;
    if(demolishMode) cancelBuildMode();
    document.getElementById('btnDemolish').classList.toggle('active-demolish', demolishMode);
    toast(demolishMode ? '⛏️ Abriss-Modus: Klicken oder ziehen für mehrere Felder (Rechtsklick zum Abbrechen)' : 'Abriss-Modus beendet.');
  };
  document.getElementById('btnKeyToggle').onclick = ()=>{
    keyboardCameraEnabled = !keyboardCameraEnabled;
    const btn = document.getElementById('btnKeyToggle');
    btn.textContent = keyboardCameraEnabled ? '⌨️ WASD: Kamera' : '⌨️ WASD: Bewegen';
    btn.classList.toggle('on', keyboardCameraEnabled);
    alleTastenLoslassen();
    if(!keyboardCameraEnabled){ cameraFreeMode = false; }
  };
  document.getElementById('btnFullscreen').onclick = ()=>{
    if(!document.fullscreenElement){
      document.documentElement.requestFullscreen().catch(()=>{});
    } else {
      document.exitFullscreen().catch(()=>{});
    }
  };
  document.addEventListener('fullscreenchange', ()=>{
    const btn = document.getElementById('btnFullscreen');
    if(btn) btn.textContent = document.fullscreenElement ? '⛶ Vollbild verlassen' : '⛶ Vollbild';
  });
  document.getElementById('btnGuide').onclick = ()=>{ showWelcomeStep1(); };
  document.getElementById('btnSaveGame').onclick = ()=>{ openSlotsOverlay('save'); };
  document.getElementById('btnSoundToggle').onclick = ()=>{
    setSoundEnabled(!soundEnabled);
    const btn = document.getElementById('btnSoundToggle');
    btn.textContent = soundEnabled ? '🔊 Sound: An' : '🔇 Sound: Aus';
    btn.classList.toggle('on', soundEnabled);
    if(soundEnabled) ensureAudio();
  };
  document.getElementById('btnMusicToggle').onclick = ()=>{
    setMusicEnabled(!musicEnabled);
    const btn = document.getElementById('btnMusicToggle');
    btn.textContent = musicEnabled ? '🎵 Musik: An' : '🎵 Musik: Aus';
    btn.classList.toggle('on', musicEnabled);
    if(musicEnabled){ ensureAudio(); if(activeMusicTrackKey) startMusicTrack(activeMusicTrackKey); }
    else { stopMusic(); }
  };
  loadKeybinds();
  window.addEventListener('keydown', (e)=>{
    // Belegungsmodus fängt jeden Tastendruck ab
    if(listeningFor && captureKeybind(e)) return;
    if(document.activeElement && (document.activeElement.tagName==='INPUT' || document.activeElement.tagName==='TEXTAREA')) return;
    const k = e.key.toLowerCase();
    if(k==='escape'){
      if(buildMode.active) cancelBuildMode();
      if(demolishMode){ demolishMode=false; demolishDrag={start:null,current:null}; document.getElementById('btnDemolish').classList.remove('active-demolish'); }
      if(macroMode){ exitMacroMap(); return; }
      // Das Register kennt alle Fenster — schließt das oberste offene
      if(closeTopOverlay()) return;
      // Nichts offen: Hauptmenü öffnen, aber nicht im Kampf, Baumodus oder Startbildschirm
      if(!buildMode.active && !demolishMode && !encounter &&
         document.getElementById('startOverlay').classList.contains('hidden')){
        openMainMenu();
      }
      return;
    }
    const act = actionForKey(k);
    if(!act) return;
    // Makro-Karte hat eigene Steuerung
    if(macroMode){
      if(['up','down','left','right'].includes(act)){ e.preventDefault(); macroMove(act); return; }
      if(act==='interact'){ e.preventDefault(); if(!e.repeat) macroEnter(); return; }
      return;
    }
    if(['up','down','left','right','interact'].includes(act)) e.preventDefault();
    const toggleOverlay = (id, openFn, closeFn)=>{
      if(e.repeat) return;
      if(document.getElementById(id).classList.contains('hidden')) openFn(); else closeFn();
    };
    const toggleCharTab = (tab, openFn)=>{
      if(e.repeat) return;
      const zu = document.getElementById('characterOverlay').classList.contains('hidden');
      if(zu){ openFn(); return; }
      if(charTabAktiv !== tab){ switchCharTab(tab); return; }
      closeCharacter();
    };
    switch(act){
      case 'up': case 'down': case 'left': case 'right':
        richtungGedrueckt(e.code || ('key:'+e.key.toLowerCase()), act);
        break;
      case 'interact':  if(!e.repeat) interactKey(); break;
      case 'craft':     toggleOverlay('craftOverlay', openCraft, closeCraft); break;
      case 'dex':       toggleOverlay('dexOverlay', openDex, closeDex); break;
      case 'journal':   toggleOverlay('journalOverlay', openJournal, closeJournal); break;
      /* U und P teilen sich ein Fenster. Ist es bereits offen, aber auf dem
         anderen Reiter, wird umgeschaltet statt geschlossen — sonst müsste
         man zweimal drücken, um vom Charakter ins Inventar zu kommen. */
      case 'inventory': toggleCharTab('inventar', openInventory); break;
      case 'character': toggleCharTab('charakter', openCharacter); break;
      case 'colony':    toggleOverlay('colonyOverlay', openColony, closeColony); break;
      case 'work':      toggleOverlay('workOverlay', openWork, closeWork); break;
      case 'worldmap':  toggleOverlay('worldMapOverlay', openWorldMap, closeWorldMap); break;
      case 'rest':      if(!e.repeat) tryRest(); break;
      case 'demolish':  if(!e.repeat) document.getElementById('btnDemolish').click(); break;
      case 'rotate':    if(!e.repeat) rotateBuildGhost(1); break;
      case 'research':  if(!e.repeat) openResearch(); break;
      case 'camtoggle': if(!e.repeat) document.getElementById('btnKeyToggle').click(); break;
      case 'fullscreen':if(!e.repeat) document.getElementById('btnFullscreen').click(); break;
    }
  });
  window.addEventListener('keyup', (e)=>{
    richtungLosgelassen(e.code || ('key:'+e.key.toLowerCase()));
  });

  /* Verliert das Fenster den Fokus, kommt kein keyup mehr an — die Taste
     gilt dann für immer als gedrückt und die Figur läuft weiter. Deshalb
     bei jedem Fokusverlust, Tabwechsel und Vollbildwechsel alles lösen. */
  window.addEventListener('blur', alleTastenLoslassen);
  window.addEventListener('pagehide', alleTastenLoslassen);
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden) alleTastenLoslassen();
  });
  document.addEventListener('fullscreenchange', alleTastenLoslassen);
}

function __set_designationMode(v){ designationMode = v; }
function __set_designationDrag(v){ designationDrag = v; }

/* ---------- Rückschreibe-Setter für die globale Brücke ----------
   Diese Bindings werden von anderen Modulen überschrieben. Ohne diese
   Funktionen käme die Zuweisung hier nie an und dieses Modul würde mit
   einem veralteten Wert weiterarbeiten. Siehe bridgeModule() in main.js. */
function __set_listeningFor(v){ listeningFor = v; }

export {
  __set_designationMode,
  __set_designationDrag,
  designationMode,
  designationDrag,
  setDesignationMode,
  finalizeDesignationDrag,
  aktualisiereDesignationKnoepfe,
  istBodenTyp,
  alleTastenLoslassen,
  richtungsCodes,
  richtungGedrueckt,
  richtungLosgelassen,
  __set_listeningFor,

  initInput,
  buildRecipeList,
  BUILDING_MENU_CATEGORY,
  BUILD_CATEGORY,
  BUILD_MENU_CATEGORIES,
  DECOR_TYPES,
  FACE_ROTATION,
  FLOOR_LIKE_TYPES,
  FLOOR_TYPES,
  KEYBIND_ACTIONS,
  KEYBIND_STORAGE,
  RECIPES,
  RECREATION_TYPES,
  SEATING_TYPES,
  SEAT_FOCUS_TYPES,
  actionForKey,
  alignAllFurniture,
  alignFurnitureOnce,
  applyRecipeDescriptions,
  buildingAt,
  buildingsAt,
  canAfford,
  canBuildAt,
  cancelBuildMode,
  canvas,
  canvasToTile,
  captureKeybind,
  cbWorkBtn,
  computeBuildTiles,
  costWorkReq,
  craftActiveTab,
  defaultKeybinds,
  demolishBuildingAt,
  deselectColonist,
  finalizeBuildDrag,
  finalizeDemolishDrag,
  handleMapClick,
  issueManualOrder,
  keyLabel,
  keybinds,
  listeningFor,
  loadKeybinds,
  pay,
  placeBlueprintAt,
  realignSeating,
  renderCraftTabs,
  renderKeybindEditor,
  saveKeybinds,
  seatFocusRotation,
  selectColonist,
  tileBlocked,
  tryDemolishAt,
  updateCommandBar
};
