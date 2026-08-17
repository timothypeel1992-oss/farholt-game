/* ============================================================
   main.js — Herzstück
   Spielzustand, Zustandsautomat, Interaktion mit der Welt,
   Produktionsketten, Werkzeuge und Waffen, Hauptschleife
   und Initialisierung.

   Bindet alle übrigen Module ein und startet das Spiel.
============================================================ */
import { DAY_CYCLE_MS, clamp, genId, hash2 } from './engine/rng.js';
import * as Designations from './engine/designations.js';
import * as World    from './engine/world.js';
import * as Renderer from './engine/renderer.js';
import * as Species  from './data/species.js';
import * as Colonist from './entities/colonist.js';
import * as Panels   from './ui/panels.js';
import * as Battle   from './ui/battle.js';
import * as Input    from './ui/input.js';
import * as WorldMap from './ui/worldmap.js';
import * as Screens  from './ui/screens.js';
import { sfxBuildDone, sfxBuildTick, sfxCatchSuccess, sfxChop, sfxCraft, sfxDrink, sfxError, sfxEvent, sfxHarvest, sfxMine, sfxPlace, startMusicTrack } from './engine/audio.js';
import * as Main     from './main.js';   // Selbstimport: eigene Exporte als Live-Namespace

/* Übergangslösung: Die Module greifen derzeit noch über gemeinsame
   Namen aufeinander zu, nicht über einzelne Importe. Bis das
   umgestellt ist, werden alle Schnittstellen global bereitgestellt.

   Object.assign() taugt dafür nicht — es kopiert den Wert zum
   Ladezeitpunkt. Bindings, die später neu zugewiesen werden (ctx,
   tileGrid, worldSeed, buildMode, paused, encounter, macroMode …),
   blieben dadurch für immer auf ihrem Startwert stehen. Genau daran
   scheiterte der Start: renderer.js exportiert ctx, das beim Import
   noch null ist — attachCanvas() änderte danach nur die modulinterne
   Variable, während globalThis.ctx null blieb.

   bridgeModule() legt stattdessen Getter an, die bei jedem Zugriff den
   aktuellen Wert aus dem Modul lesen.

   Für Bindings, die ein FREMDES Modul überschreibt (buildMode aus input.js,
   worldSeed aus main.js, wildMonsters aus battle.js …), reicht ein Getter
   nicht: die Zuweisung müsste im Besitzermodul ankommen, sonst arbeitet es
   weiter mit seiner eigenen Kopie. Solche Module exportieren daher eine
   Funktion `__set_<name>`; die Brücke verdrahtet sie als Setter. */
function bridgeModule(ns){
  for(const key of Object.keys(ns)){
    if(key === 'default' || key.startsWith('__set_')) continue;
    const writeBack = ns['__set_' + key];
    let overridden = false, ownValue;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      enumerable: true,
      get(){
        if(typeof writeBack === 'function') return ns[key];   // Besitzer ist die Quelle
        return overridden ? ownValue : ns[key];
      },
      set(v){
        if(typeof writeBack === 'function'){ writeBack(v); return; }
        overridden = true; ownValue = v;
      }
    });
  }
}

/* rng.js und audio.js sind bereits umgestellt: alle Module holen sich ihre
   Namen per echtem Import und stehen deshalb nicht mehr in dieser Liste.
   Fehlt dort künftig ein Name, meldet der Browser das sofort — statt wie
   bisher erst zur Laufzeit als stiller undefined-Zugriff. */
[World, Renderer, Species, Colonist, Designations,
 Panels, Battle, Input, WorldMap, Screens].forEach(bridgeModule);

/* ============================================================
   Game state
============================================================ */
let state = {
  colonyName: '',
  player:{ x:spawnX, y:spawnY, facing:'down', path:[], target:null, regionId:'C', appearance:randomAppearance(), gear:{weapon:0,armor:0,trinket:0}, advClass:null, level:1, xp:0, unspentPoints:0, allocatedStats:{hp:0,atk:0,def:0,spd:0} },
  stats:{ hp:100, hunger:100, thirst:100, energy:100 },
  inventory:{ wood:0, stone:0, berries:0, trap:0, ore:0, fiber:0, planks:0, metal:0, cloth:0, copper:0, silver:0, gold:0, potion:0,
    fell:0, leder:0, ton:0, keramik:0, mehl:0, harz:0, tinktur:0, werkzeugteile:0, beschlag:0, griff:0,
    gemuese:0, getreide:0, kraeuter:0, meat_fire:0, meat_water:0, meat_grass:0, meat_electric:0, meat_ice:0, meat_rock:0, meat_poison:0, meat_ghost:0, meat_flying:0, meat_bug:0, meat_normal:0, meat_dragon:0,
    meal_simple:0, meal_veggie:0, meal_deluxe:0, meal_brot:0,
    holz_kiefer:0, holz_dunkel:0, holz_bruch:0, stein_marmor:0, stein_sand:0, erz_titan:0 },
  collection:{}, activeId:null,
  buildings:[], colonists:[], colonyCenter:null,
  eventLog:[], raid:null, weather:{type:'clear', until:0}, dayCycleOffset:null, party:[], research:{points:0, unlocked:[]}, relationships:{}, loreDiscovered:[], brunnenUses:{day:0,count:0}, classScrolls:0, visitedOtherRegion:false,
  quests:{ mainStage:0, mainCompleted:false, side:[], killCount:0, nextSideQuestAt: Date.now()+90000 }
};

const moveAnim = { moving:false, fromX:spawnX, fromY:spawnY, toX:spawnX, toY:spawnY, start:0, dur:150 };
function snapMoveAnimToPlayer(){
  moveAnim.moving = false;
  moveAnim.fromX = state.player.x; moveAnim.fromY = state.player.y;
  moveAnim.toX = state.player.x; moveAnim.toY = state.player.y;
}
let camera = { x:0, y:0 };
let paused = true;   // abgeleitet aus gameMode — nicht mehr direkt setzen, sondern setMode() verwenden
/* ============================================================
   Zustandsautomat für Spielmodi
   Eine einzige Quelle der Wahrheit statt sechs unabhängiger Flags.
   `paused` wird daraus abgeleitet, nicht mehr von Hand gesetzt.
============================================================ */
/* --- Gekapselt: nur die 7 Bezeichner der Schnittstelle werden freigegeben,
   die restlichen 10 bleiben im Block eingeschlossen. Muster für weitere
   Bereiche, siehe Inhaltsverzeichnis oben. --- */
const MODES = {
  boot:   { paused:true,  desc:'Startbildschirm, Spiel läuft noch nicht' },
  micro:  { paused:false, desc:'Normale Detailansicht — die Welt läuft' },
  macro:  { paused:true,  desc:'Makro-Weltkarte — Detailwelt ruht' },
  battle: { paused:true,  desc:'Kampf — nur der Kampf läuft' },
  overlay:{ paused:true,  desc:'Ein Fenster ist offen (Menü, Inventar, Dialog …)' }
};
let gameMode = 'boot';
let modeStack = [];      // erlaubt Rückkehr zum vorigen Modus (z.B. Menü über Makro-Karte)
// Wird beim Verlassen eines Modus aufgerufen — hier räumen wir laufende Schleifen ab
const MODE_EXIT = {
  macro: ()=>{ if(typeof macroMode!=='undefined') macroMode = false; },
  battle: ()=>{ if(typeof stopAutoBattle==='function') stopAutoBattle(); }
};
function setMode(next, opts){
  if(!MODES[next]){ console.warn('Unbekannter Spielmodus:', next); return; }
  if(next===gameMode) return;
  const prev = gameMode;
  if(MODE_EXIT[prev]) MODE_EXIT[prev]();
  gameMode = next;
  paused = MODES[next].paused;
  if(opts && opts.remember && prev!=='boot') modeStack.push(prev);
  if(typeof onModeChanged==='function') onModeChanged(prev, next);
}
// Zurück zum Modus, aus dem heraus gewechselt wurde (Fallback: micro)
function popMode(){
  const back = modeStack.pop() || 'micro';
  setMode(back);
}
function isMode(m){ return gameMode===m; }
// Darf die Detailwelt gerade rechnen? Ersetzt verstreute paused-Abfragen
function worldRunning(){ return gameMode==='micro'; }
/* ============================================================
   Persistence
============================================================ */
async function saveGame(key){
  key = key || 'wildwood-save';
  try{ await window.storage.set(key, JSON.stringify({ state, worldSeed: worldSeedBase, savedAt: Date.now() })); }catch(e){}
}
async function loadGame(key){
  key = key || 'wildwood-save';
  try{
    const res = await window.storage.get(key);
    if(res && res.value){
      const data = JSON.parse(res.value);
      if(data.state){
        state.colonyName = data.state.colonyName || COLONY_NAME_POOL[0];
        state.player = Object.assign({x:spawnX,y:spawnY,facing:'down',path:[],target:null,regionId:'C',appearance:null}, data.state.player||{}, {path:[], target:null});
        if(!state.player.appearance) state.player.appearance = randomAppearance();
        if(!state.player.gear) state.player.gear = {weapon:0,armor:0,trinket:0};
        if(state.player.advClass===undefined) state.player.advClass = null;
        if(state.player.level===undefined) state.player.level = 1;
        if(state.player.xp===undefined) state.player.xp = 0;
        if(state.player.unspentPoints===undefined) state.player.unspentPoints = 0;
        if(!state.player.allocatedStats) state.player.allocatedStats = {hp:0,atk:0,def:0,spd:0};
        state.stats = data.state.stats || state.stats;
        state.inventory = Object.assign(state.inventory, data.state.inventory||{});
        state.collection = data.state.collection || {};
        state.activeId = (data.state.activeId!==undefined)? data.state.activeId : null;
        state.buildings = (data.state.buildings||[]).map(b=>({ built:true, work:b.workReq||0, workReq:b.workReq||1, ...b }));
        state.colonists = (data.state.colonists||[]).map(c=>({ path:[], job:null, anim:null, state:'idle', carrying:null, appearance:null, advClass:null, gear:{weapon:0,armor:0,trinket:0}, partnerId:null, spouseId:null, level:1, xp:0, unspentPoints:0, allocatedStats:{hp:0,atk:0,def:0,spd:0}, ...c }));
        state.colonists.forEach(c=>{ if(!c.appearance) c.appearance = randomAppearance(); });
        state.colonyCenter = data.state.colonyCenter || null;
        state.eventLog = data.state.eventLog || [];
        state.raid = data.state.raid || null;
        state.weather = data.state.weather || {type:'clear',until:0};
        state.dayCycleOffset = (data.state.dayCycleOffset!=null) ? data.state.dayCycleOffset : (Date.now() - DAY_CYCLE_MS*0.5);
        state.party = (data.state.party||[]).filter(id=>state.colonists.some(c=>c.id===id));
        state.research = data.state.research || {points:0, unlocked:[]};
        state.relationships = data.state.relationships || {};
        state.loreDiscovered = data.state.loreDiscovered || [];
        state.brunnenUses = data.state.brunnenUses || {day:0,count:0};
        state.classScrolls = data.state.classScrolls || 0;
        state.visitedOtherRegion = data.state.visitedOtherRegion || false;
        state.quests = data.state.quests || { mainStage:0, mainCompleted:false, side:[], killCount:0, nextSideQuestAt:0 };
      }
      if(data.worldSeed!==undefined){ worldSeed = data.worldSeed; buildWorld(); }
      return true;
    }
  }catch(e){}
  return false;
}

/* ============================================================
   Interaction: chop / mine / drink / bush / fiber / build
============================================================ */
function facingTile(){ const d = facingDelta[state.player.facing]; return { x: state.player.x + d[0], y: state.player.y + d[1] }; }
function faceToward(tx,ty){
  const dx = tx-state.player.x, dy = ty-state.player.y;
  if(dx===1) state.player.facing='right'; else if(dx===-1) state.player.facing='left';
  else if(dy===1) state.player.facing='down'; else if(dy===-1) state.player.facing='up';
}
function rollPreciousMetalBonus(){
  const bt = hasTech('bergbautechnik');
  const r = Math.random();
  if(r<(bt?0.02:0.008)){ state.inventory.erz_titan += 1; bumpResource('erz_titan'); toast('🔷 Ein Titanerz-Splitter — extrem selten!'); }
  else if(r<(bt?0.07:0.028)){ state.inventory.gold += 1; bumpResource('gold'); toast('✨ Ein Goldnugget im Gestein!'); }
  else if(r<(bt?0.22:0.12)){ state.inventory.silver += 1; bumpResource('silver'); toast('⚪ Ein Silberader freigelegt!'); }
  else if(r<(bt?0.57:0.37)){ state.inventory.copper += 1; bumpResource('copper'); toast('🟠 Etwas Kupfer gefunden!'); }
}
function gatherTechBonus(){ return (hasTech('werkzeugkunde') && Math.random()<0.3) ? 1 : 0; }
const TREE_SHAPE_WOOD = { pine:'holz_kiefer', pine_snow:'holz_kiefer', sparse:'holz_bruch', gnarled:'holz_dunkel' };
const ROCK_STYLE_STONE = { crystal:'stein_marmor', weathered:'stein_sand' };
/* --- Biom-exklusive Ressourcen: nur dort zu finden, zwingt zur Expansion --- */
const BIOME_EXCLUSIVE = {
  wildwood: {key:'harz',   from:'tree', chance:0.30, label:'Baumharz'},
  deepwood: {key:'harz',   from:'tree', chance:0.45, label:'Baumharz'},
  swamp:    {key:'ton',    from:'rock', chance:0.45, label:'Sumpfton'},
  coast:    {key:'ton',    from:'rock', chance:0.35, label:'Uferton'},
  highland: {key:'silver', from:'rock', chance:0.22, label:'Silberader'},
  frost:    {key:'silver', from:'rock', chance:0.28, label:'Frostsilber'},
  ruins:    {key:'gold',   from:'rock', chance:0.18, label:'Altgold'},
  thorn:    {key:'fiber',  from:'tree', chance:0.50, label:'Dornenfaser'},
  meadow:   {key:'kraeuter',from:'tree',chance:0.35, label:'Wiesenkräuter'}
};
// Liefert die Sonderressource beim Abbau — nur im passenden Biom
function biomeExclusiveDrop(from){
  const ex = BIOME_EXCLUSIVE[currentBiome];
  if(!ex || ex.from!==from) return null;
  if(Math.random() >= ex.chance) return null;
  state.inventory[ex.key] = (state.inventory[ex.key]||0)+1;
  bumpResource(ex.key);
  toast(`${RESOURCE_ICONS[ex.key]||''} ${ex.label} gefunden!`);
  return ex.key;
}
function biomeWoodBonus(){
  const style = BIOME_TREE_STYLE[currentBiome];
  const key = style && TREE_SHAPE_WOOD[style.shape];
  if(!key || Math.random()>=0.4) return null;
  addResource(key, 1);
  bumpResource(key);
  return key;
}
function biomeStoneBonus(){
  const rockStyle = BIOME_ROCK_STYLE[currentBiome];
  const key = ROCK_STYLE_STONE[rockStyle];
  if(!key) return null;
  const chance = state.buildings.some(b=>b.type==='steinmetz' && b.built) ? 0.65 : 0.4;
  if(Math.random()>=chance) return null;
  addResource(key, 1);
  bumpResource(key);
  return key;
}
function chopOrMine(){
  const {x,y} = facingTile(); const o = objAt(x,y);
  if(!o) return false;
  if(o.type==='tree'){
    if(!requireTool('chop')) return false;
    o.hp--; state.inventory.wood += 2+gatherTechBonus()+toolYield('chop'); bumpResource('wood'); wearTool('chop'); sfxChop();
    biomeWoodBonus(); biomeExclusiveDrop('tree');
    playerActionType='chop'; playerActionUntil=performance.now()+420;
    if(o.hp<=0){ objects.delete(x+','+y); respawnQueue.push({x,y,type:'tree',at:Date.now()+220000}); }
    updateHUD(); return true;
  }
  if(o.type==='rock'){
    if(!requireTool('mine')) return false;
    o.hp--; state.inventory.stone += 2+gatherTechBonus()+toolYield('mine'); bumpResource('stone'); wearTool('mine'); sfxMine();
    biomeStoneBonus(); biomeExclusiveDrop('rock');
    playerActionType='mine'; playerActionUntil=performance.now()+420;
    if(o.hp<=0){ objects.delete(x+','+y); respawnQueue.push({x,y,type:'rock',at:Date.now()+250000}); }
    updateHUD(); return true;
  }
  if(o.type==='orevein'){
    if(!requireTool('mine')) return false;
    o.hp--; state.inventory.ore += 1+gatherTechBonus()+toolYield('mine'); wearTool('mine'); sfxMine();
    playerActionType='mine'; playerActionUntil=performance.now()+420;
    rollPreciousMetalBonus();
    if(o.hp<=0){ objects.delete(x+','+y); respawnQueue.push({x,y,type:'orevein',at:Date.now()+300000}); }
    updateHUD(); return true;
  }
  if(o.type==='mountain'){
    if(!requireTool('mine')) return false;
    o.hp--; state.inventory.stone += 2+gatherTechBonus()+toolYield('mine'); wearTool('mine'); sfxMine();
    playerActionType='mine'; playerActionUntil=performance.now()+420;
    rollPreciousMetalBonus();
    if(o.hp<=0){
      objects.delete(x+','+y);
      toast('⛏️ Ein Tunnel wurde durch den Berg geschlagen!');
      if(Math.random()<0.25){ objects.set(x+','+y, {type:'orevein', hp:4, maxHp:4}); }
    }
    updateHUD(); return true;
  }
  if(o.type==='ruins_loot'){
    objects.delete(x+','+y);
    resolveRuinsLoot();
    return true;
  }
  if(o.type==='trader'){
    state.player.target = null;
    openVillageShop();
    return true;
  }
  if(o.type==='dungeon_portal'){
    state.player.target = null;
    showStoryDialog('🕳️ Ein Dungeon-Eingang', 'Ein dunkler, verwitterter Eingang führt in die Tiefe. Wer weiß, was — und wer — dort unten wartet. Am Ende soll es Beute geben, wenn man den Wächter besiegt.', [
      { label:'⚔ Hinabsteigen', action:()=>{ enterDungeon('dungeon'); } },
      { label:'Lieber nicht', secondary:true, action:()=>{} }
    ]);
    return true;
  }
  if(o.type==='cave_entrance'){
    state.player.target = null;
    showStoryDialog('🕳️ Ein Höhleneingang', 'Ein natürlicher Spalt im Fels führt in eine kleine Höhle. Kürzer als ein Dungeon, aber auch dort lauert ein Wächter mit etwas Beute.', [
      { label:'⛏ Hineinklettern', action:()=>{ enterDungeon('cave'); } },
      { label:'Lieber nicht', secondary:true, action:()=>{} }
    ]);
    return true;
  }
  if(o.type==='dungeon_exit'){
    state.player.target = null;
    exitDungeon();
    return true;
  }
  if(o.type==='dungeon_chest'){
    objects.delete(x+','+y);
    resolveDungeonChest();
    return true;
  }
  if(o.type==='visitor'){
    state.player.target = null;
    talkToVisitor(x,y,o);
    return true;
  }
  if(o.type==='quest_npc'){
    state.player.target = null;
    talkToQuestNpc(x,y,o);
    return true;
  }
  return false;
}
function resolveDungeonChest(){
  sfxCatchSuccess();
  const isCave = dungeonCtx && dungeonCtx.instanceType==='cave';
  const dl = dungeonCtx ? dungeonCtx.dangerLevel : 1;
  const scale = isCave ? 0.6 : 1;
  const goldAmt = Math.max(1, Math.round((2+Math.floor(Math.random()*2)+Math.floor(dl*0.5))*scale));
  const potionAmt = Math.max(1, Math.round((1+Math.floor(Math.random()*2))*scale));
  state.inventory.gold = (state.inventory.gold||0)+goldAmt; bumpResource('gold');
  state.inventory.potion = (state.inventory.potion||0)+potionAmt;
  let extra = '';
  const r = Math.random();
  if(r<(isCave?0.015:0.03)){ state.classScrolls=(state.classScrolls||0)+1; extra=' Außerdem eine seltene 📜 Klassen-Schriftrolle!'; }
  else if(r<0.45){ const m=Math.random()<0.5?'silver':'copper'; addResource(m, (isCave?2:3)); bumpResource(m); extra=' Außerdem '+(isCave?2:3)+' '+RESOURCE_ICONS[m]+' '+RESOURCE_NAMES[m]+'!'; }
  else { state.inventory.metal=(state.inventory.metal||0)+(isCave?2:3); bumpResource('metal'); extra=' Außerdem '+(isCave?2:3)+' ⚙️ Metall!'; }
  showStoryDialog('💰 Beutetruhe!', `Die Truhe des Wächters enthält +${goldAmt} 🟡 Gold und +${potionAmt} 🧪 Heiltränke.${extra}`, [{label:'Nehmen!', action:()=>{}}]);
  logEvent(isCave ? '💰 Höhlen-Beutetruhe geöffnet.' : '💰 Dungeon-Beutetruhe geöffnet.');
  updateHUD(); saveGame();
}
function resolveRuinsLoot(){
  sfxEvent();
  const r = Math.random();
  if(r<0.25){
    const gains = { stone: 4+Math.floor(Math.random()*4), metal: 1+Math.floor(Math.random()*2) };
    if(Math.random()<0.4) gains.copper = 1+Math.floor(Math.random()*2);
    if(Math.random()<0.15) gains.silver = 1;
    Object.keys(gains).forEach(k=>{ addResource(k, gains[k]); bumpResource(k); });
    const desc = 'Zwischen bemoosten Steinen findest du: '+Object.entries(gains).map(([k,v])=>v+' '+RESOURCE_NAMES[k]).join(', ')+'.';
    showStoryDialog('🏛️ Ruinenfund', desc, [{label:'Weiter', action:()=>{}}]);
    logEvent('🏛️ Ruinenfund: Rohstoffe entdeckt.');
    updateHUD();
  } else if(r<0.45){
    const pts = 8+Math.floor(Math.random()*10);
    state.research.points += pts;
    showStoryDialog('🏛️ Altes Wissen', 'Verwitterte Schriftzeichen an der Wand geben dir Einblicke in vergessene Techniken. +'+pts+' Forschungspunkte.', [{label:'Weiter', action:()=>{}}]);
    logEvent('🏛️ Altes Wissen entdeckt: +'+pts+' Forschungspunkte.');
    updateResearchIfOpen(); saveGame();
  } else if(r<0.65){
    showStoryDialog('🏛️ Ein Wächter erwacht!', 'Etwas rührt sich in den Trümmern — eine wilde Kreatur bewacht diesen Ort und will nicht kampflos weichen.', [
      { label:'⚔ Kämpfen', action:()=>{
        const sp = weightedSpecies(currentBiome);
        startEncounter([{speciesId:sp.id, uid:null}], false);
      }}
    ]);
    logEvent('🏛️ Ein Wächter bewachte einen Ruinenschatz.');
  } else if(r<0.8){
    const rareSpecies = SPECIES.filter(s=>s.rarity==='rare');
    const sp = rareSpecies[Math.floor(Math.random()*rareSpecies.length)];
    let placedNear = false;
    for(let tries=0;tries<20 && !placedNear;tries++){
      const nx = state.player.x + Math.floor(Math.random()*5)-2, ny = state.player.y + Math.floor(Math.random()*5)-2;
      if(passable(nx,ny)){ wildMonsters.push({ uid:newUid(), speciesId:sp.id, x:nx, y:ny, lastMove:0, hostile:false, raid:false }); placedNear=true; }
    }
    showStoryDialog('🏛️ Seltene Spur', 'Du entdeckst frische Spuren eines seltenen Wesens ganz in der Nähe: '+sp.name+'.', [{label:'Weiter', action:()=>{}}]);
    logEvent('🏛️ Seltene Spur entdeckt: '+sp.name+' in der Nähe.');
  } else {
    if(!discoverNextRuinsFragment()){
      const gains = { stone: 4+Math.floor(Math.random()*4) };
      Object.keys(gains).forEach(k=>{ addResource(k, gains[k]); bumpResource(k); });
      showStoryDialog('🏛️ Ruinenfund', 'Nur noch Schutt und Staub — aber immerhin ein paar brauchbare Steine: +'+gains.stone+' Stein.', [{label:'Weiter', action:()=>{}}]);
      updateHUD();
    }
  }
}
function tryDrink(){
  const {x,y} = facingTile();
  if(tileAt(x,y)===TILE_WATER){
    state.stats.thirst = clamp(state.stats.thirst+25,0,100);
    sfxDrink(); toast('💧 Erfrischend! Durst +25'); updateHUD(); return true;
  }
  return false;
}
function tryBuildBlueprint(){
  if(atDungeon()) return false;
  const {x,y} = facingTile();
  const b = state.buildings.find(bb=>bb.x===x&&bb.y===y&&!bb.built&&(bb.regionId||'C')===state.player.regionId);
  if(!b) return false;
  b.work = clamp(b.work+15, 0, b.workReq);
  sfxBuildTick();
  playerActionType='build'; playerActionUntil=performance.now()+420;
  if(b.work>=b.workReq){
    b.built = true;
    if(FIELD_YIELD[b.type]){ b.plantedAt = Date.now(); b.growth = 0; }
    onBuildingFinished(b);
    sfxBuildDone();
    toast((BUILDING_TYPES[b.type].name)+' fertiggestellt!');
    logEvent((BUILDING_TYPES[b.type].name)+' wurde fertiggestellt.');
  }
  updateHUD(); return true;
}
function pickBushIfHere(x,y){
  const o = objAt(x,y);
  if(o && o.type==='bush'){
    state.inventory.berries += 2; bumpResource('berries'); sfxHarvest();
    objects.delete(x+','+y); respawnQueue.push({x,y,type:'bush',at:Date.now()+120000});
    toast('🫐 Beeren gesammelt +2'); updateHUD();
  } else if(o && o.type==='fiberbush'){
    state.inventory.fiber += 2; sfxHarvest();
    objects.delete(x+','+y); respawnQueue.push({x,y,type:'fiberbush',at:Date.now()+135000});
    toast('🌾 Faser gesammelt +2'); updateHUD();
  } else if(o && o.type==='wildgemuese'){
    state.inventory.gemuese += 2; bumpResource('gemuese'); sfxHarvest();
    objects.delete(x+','+y); respawnQueue.push({x,y,type:'wildgemuese',at:Date.now()+130000});
    toast('🥕 Wildgemüse gesammelt +2'); updateHUD();
  }
}
/* Startvorrat am Boden: Ohne Werkzeug ist Abbau gesperrt, also müssen
   die ersten Rohstoffe lose herumliegen — Reisig, Lesesteine, Fasern. */
function scatterStarterResources(){
  if(state.starterScattered) return;
  state.starterScattered = true;
  const px = state.player.x, py = state.player.y;
  /* Mehr Ertrag je Stapel und enger am Lager. Vorher lagen 20 kleine Stapel
     im Radius 3 bis 14 verstreut — die Menge reichte zwar (21 Holz gegen 6
     Holz Baukosten), aber man lief den halben Anfang nur ab. Weniger
     Laufwege bei gleichem Suchgefühl. */
  const kinds = [
    {res:'wood',    amount:5, count:8},
    {res:'stone',   amount:4, count:7},
    {res:'fiber',   amount:3, count:5},
    {res:'berries', amount:3, count:4}
  ];
  let placed = 0;
  kinds.forEach(k=>{
    for(let i=0;i<k.count;i++){
      for(let t=0;t<40;t++){
        const a = Math.random()*Math.PI*2;
        const d = 2 + Math.random()*7;   // dichter am Lager als bisher (war 3..14)
        const x = Math.round(px + Math.cos(a)*d);
        const y = Math.round(py + Math.sin(a)*d);
        if(x<1||y<1||x>=WORLD_W-1||y>=WORLD_H-1) continue;
        if(!passable(x,y) || objAt(x,y)) continue;
        if(groundItems.some(g=>g.x===x&&g.y===y)) continue;
        dropGroundItem(x, y, k.res, k.amount);
        placed++;
        break;
      }
    }
  });
  if(placed) logEvent('🌿 Rund um das Lager liegt allerlei Brauchbares — sammle es auf, du hast noch kein Werkzeug.');
}
function dropGroundItem(x,y,resource,amount){
  const existing = groundItems.find(g=>g.x===x&&g.y===y&&g.resource===resource);
  if(existing){ existing.amount += amount; } else { groundItems.push({id:genId(), x, y, resource, amount}); }
}
function pickGroundItemIfHere(x,y){
  const idx = groundItems.findIndex(g=>g.x===x&&g.y===y);
  if(idx>=0){
    const g = groundItems[idx];
    state.inventory[g.resource] = (state.inventory[g.resource]||0) + g.amount;
    bumpResource(g.resource);
    toast('+'+g.amount+' '+(RESOURCE_ICONS[g.resource]||'')+' aufgesammelt');
    groundItems.splice(idx,1);
    updateHUD();
  }
}
/* Abstand, den nachwachsende Ressourcen zu bebauten Feldern halten.
   2 bedeutet: rund um jedes Gebäude bleibt ein Ring von zwei Feldern frei. */
const RESPAWN_ABSTAND = 2;

/* Darf an dieser Stelle etwas nachwachsen? Vorher wurde nur geprüft, ob das
   Feld selbst belegt ist — deshalb wuchsen Bäume mitten in der Basis und
   auf Wasser bzw. außerhalb der Karte, wo gar kein Boden liegt. */
function respawnErlaubt(x, y){
  // 1) Innerhalb der Karte
  if(x<0 || y<0 || x>=WORLD_W || y>=WORLD_H) return false;
  // 2) Gültiger Boden — kein Wasser, kein Nichts
  const t = tileAt(x,y);
  if(t!==TILE_GRASS && t!==TILE_SAND) return false;
  // 3) Feld selbst frei
  if(objects.has(x+','+y)) return false;
  if(atDungeon()) return true;
  const reg = state.player.regionId;
  // 4) Kein Gebäude auf dem Feld …
  if(state.buildings.some(bb=>bb.x===x && bb.y===y && (bb.regionId||'C')===reg)) return false;
  // 5) … und Abstand zur bebauten Fläche halten
  const nah = state.buildings.some(bb=>
    (bb.regionId||'C')===reg &&
    Math.abs(bb.x-x)<=RESPAWN_ABSTAND && Math.abs(bb.y-y)<=RESPAWN_ABSTAND);
  if(nah) return false;
  return true;
}

function processRespawns(){
  const now = Date.now();
  respawnQueue = respawnQueue.filter(r=>{
    const zoned = !atDungeon() && state.buildings.some(bb=>bb.x===r.x && bb.y===r.y && bb.type==='schutzzone' && bb.built && (bb.regionId||'C')===state.player.regionId);
    if(zoned) return false;
    if(now < r.at) return true;
    // Dauerhaft ungeeignete Felder (Wasser, außerhalb der Karte) nicht endlos
    // in der Warteschlange behalten — sie werden nie frei.
    if(r.x<0 || r.y<0 || r.x>=WORLD_W || r.y>=WORLD_H) return false;
    const t = tileAt(r.x, r.y);
    if(t!==TILE_GRASS && t!==TILE_SAND) return false;
    if(!respawnErlaubt(r.x, r.y)) return true;   // vorübergehend belegt: später erneut versuchen
    const maxHp = (r.type==='bush'||r.type==='fiberbush'||r.type==='wildgemuese')?1:(r.type==='orevein'?4:3);
    objects.set(r.x+','+r.y, {type:r.type, hp:maxHp, maxHp});
    return false;
  });
}

/* ============================================================
   Buildings & crafting (blueprint / construction system)
============================================================ */
const RESOURCE_ICONS = {fell:'🦫',leder:'🟫',ton:'🧱',keramik:'🏺',mehl:'🌾',harz:'🟠',tinktur:'⚗️',werkzeugteile:'🔩',beschlag:'⚙️',griff:'🪵',wood:'🪵',stone:'🪨',berries:'🫐',ore:'⛏️',fiber:'🌾',planks:'🪚',metal:'⚙️',cloth:'🧵',trap:'🪤',copper:'🟠',silver:'⚪',gold:'🟡',potion:'🧪',
  gemuese:'🥕', getreide:'🌾', kraeuter:'🌱',
  holz_kiefer:'🌲', holz_dunkel:'🪵', holz_bruch:'🥢', stein_marmor:'⬜', stein_sand:'🟨', erz_titan:'🔷',
  meat_fire:'🔥',meat_water:'🐟',meat_grass:'🌿',meat_electric:'⚡',meat_ice:'❄️',meat_rock:'🪨',meat_poison:'☠️',meat_ghost:'👻',meat_flying:'🪶',meat_bug:'🐛',meat_normal:'🍖',meat_dragon:'🐉',
  meal_simple:'🍳',meal_veggie:'🍲',meal_deluxe:'🍽️',meal_brot:'🍞'};
const MEAT_BY_TYPE = { Fire:'meat_fire', Water:'meat_water', Grass:'meat_grass', Electric:'meat_electric', Ice:'meat_ice', Rock:'meat_rock', Poison:'meat_poison', Ghost:'meat_ghost', Flying:'meat_flying', Bug:'meat_bug', Normal:'meat_normal', Dragon:'meat_dragon' };
/* Feldarten. Wachstumszeit und Ertrag sind bewusst gegenläufig gestaffelt:
   Beeren reifen schnell für wenig, Getreide braucht lange und liefert viel.
   Fasern waren als Feld noch nicht anlegbar, obwohl der Rohstoff überall
   gebraucht wird — man war auf wilde Sträucher angewiesen. */
const FIELD_YIELD = {
  feld_beeren:  {res:'berries',  icon:'🫐', growTime:180000, amt:3},
  feld_fasern:  {res:'fiber',    icon:'🌾', growTime:210000, amt:4},
  feld_kraeuter:{res:'kraeuter', icon:'🌱', growTime:270000, amt:2},
  feld_gemuese: {res:'gemuese',  icon:'🥕', growTime:300000, amt:4},
  feld_getreide:{res:'getreide', icon:'🌾', growTime:420000, amt:7}
};
/* ---------- Wachstumsstadien ----------
   Vier benannte Stufen statt reiner Prozentzahlen. Die Schwellen sind
   dieselben, nach denen der Renderer schon vorher unterschieden hat — sie
   haben jetzt nur einen Namen und sind an einer Stelle festgelegt statt
   in der Zeichenfunktion verstreut. */
const FIELD_STAGES = [
  { key:'gepfluegt', ab:0.00, label:'Gepflügt',  icon:'🟫' },
  { key:'gesaet',    ab:0.25, label:'Gesät',     icon:'🌱' },
  { key:'wachsend',  ab:0.55, label:'Wachsend',  icon:'🌿' },
  { key:'reif',      ab:1.00, label:'Erntereif', icon:'✨' },
];

function fieldStage(b){
  const p = fieldGrowthProgress(b);
  let s = FIELD_STAGES[0];
  for(const st of FIELD_STAGES){ if(p >= st.ab) s = st; }
  return s;
}

/* Wachstum ist an den Tag/Nacht-Zyklus gekoppelt: nachts ruhen die Pflanzen
   weitgehend. Deshalb wird der Fortschritt fortgeschrieben statt aus der
   verstrichenen Uhrzeit berechnet — sonst würden Felder auch durchwachsen,
   während es dunkel ist. Ältere Spielstände ohne growth-Feld fallen auf die
   alte Zeitrechnung zurück. */
const NACHT_WACHSTUM = 0.30;

function fieldGrowthProgress(b){
  const cfg = FIELD_YIELD[b.type]; if(!cfg) return 1;
  if(b.growth != null) return clamp(b.growth, 0, 1);
  if(!b.plantedAt) return 0;
  return clamp((Date.now()-b.plantedAt)/cfg.growTime, 0, 1);
}

function tickFields(dtMs){
  const dunkel = darknessAt(dayPhaseNow()) / NACHT_MAX;
  const tempo = 1 - dunkel * (1 - NACHT_WACHSTUM);
  state.buildings.forEach(b=>{
    const cfg = FIELD_YIELD[b.type];
    if(!cfg || !b.built) return;
    if(b.growth == null){
      // Umstieg aus einem alten Spielstand: Stand einmal übernehmen
      b.growth = b.plantedAt ? clamp((Date.now()-b.plantedAt)/cfg.growTime, 0, 1) : 0;
    }
    if(b.growth >= 1) return;
    b.growth = clamp(b.growth + (dtMs / cfg.growTime) * tempo, 0, 1);
  });
}
function harvestField(b){
  const cfg = FIELD_YIELD[b.type]; if(!cfg) return;
  if(fieldGrowthProgress(b)<1) return;
  state.inventory[cfg.res] = (state.inventory[cfg.res]||0)+cfg.amt;
  bumpResource(cfg.res);
  sfxHarvest();
  toast(`${cfg.icon} +${cfg.amt} ${RESOURCE_NAMES[cfg.res]} geerntet!`);
  b.plantedAt = Date.now();
  updateHUD(); saveGame();
}
const MEAT_TYPES = Object.values(MEAT_BY_TYPE);
const COOKING_RECIPES = [
  { key:'meal_simple', label:'🍳 Gebratenes Fleisch', desc:'Einfach und deftig — beliebiges Jagdfleisch gebraten.', meatCost:2, extraCost:{}, output:'meal_simple', outputAmt:1 },
  { key:'meal_veggie', label:'🍲 Gemüseeintopf', desc:'Herzhafter Eintopf aus Wildgemüse und Beeren.', meatCost:0, extraCost:{gemuese:4, berries:2}, output:'meal_veggie', outputAmt:1 },
  { key:'meal_brot', label:'🍞 Frisches Brot', desc:'Einfaches, sättigendes Brot aus eigenem Getreide.', meatCost:0, extraCost:{getreide:4}, output:'meal_brot', outputAmt:2 },
  { key:'meal_deluxe', label:'🍽️ Deluxe-Mahlzeit', desc:'Fleisch, Wildgemüse und Beeren fein kombiniert — die nahrhafteste Mahlzeit.', meatCost:2, extraCost:{gemuese:3, berries:2}, output:'meal_deluxe', outputAmt:1 }
];
const RESOURCE_NAMES = {fell:'Fell',leder:'Leder',ton:'Ton',keramik:'Keramik',mehl:'Mehl',harz:'Harz',tinktur:'Tinktur',werkzeugteile:'Werkzeugteile',beschlag:'Beschlag',griff:'Griff',wood:'Holz',stone:'Stein',berries:'Beeren',ore:'Erz',fiber:'Faser',planks:'Planken',metal:'Metall',cloth:'Stoff',trap:'Fallen',copper:'Kupfer',silver:'Silber',gold:'Gold',potion:'Heiltrank',
  gemuese:'Wildgemüse', getreide:'Getreide', kraeuter:'Heilkräuter',
  holz_kiefer:'Kiefernholz', holz_dunkel:'Dunkelholz', holz_bruch:'Bruchholz', stein_marmor:'Marmor', stein_sand:'Sandstein', erz_titan:'Titanerz',
  meat_fire:'Feuriges Fleisch',meat_water:'Fischfilet',meat_grass:'Blattfleisch',meat_electric:'Knisterfleisch',meat_ice:'Frostfleisch',meat_rock:'Zähes Fleisch',meat_poison:'Giftfleisch',meat_ghost:'Geisteressenz',meat_flying:'Federwild',meat_bug:'Chitinfleisch',meat_normal:'Wildfleisch',meat_dragon:'Drachenfleisch',
  meal_simple:'Gebratenes Fleisch',meal_veggie:'Gemüseeintopf',meal_deluxe:'Deluxe-Mahlzeit',meal_brot:'Frisches Brot'};

/* Lagerlimit: Grundkapazität pro Rohstoff, erweiterbar durch Lagerkisten */
const STORAGE_BASE = 200;
const STORAGE_PER_CHEST = 150;
function storageCap(){
  const chests = (state.buildings||[]).filter(b=>b.type==='lagerkiste' && b.built).length;
  return STORAGE_BASE + chests*STORAGE_PER_CHEST;
}
// Zentrale Einlagerung: respektiert das Limit und meldet, wenn etwas verloren geht
function addResource(key, amount){
  if(amount<=0) return 0;
  const cap = storageCap();
  const cur = state.inventory[key]||0;
  const room = Math.max(0, cap-cur);
  const stored = Math.min(amount, room);
  state.inventory[key] = cur + stored;
  if(stored < amount){
    toast('🧰 Lager voll für '+(RESOURCE_NAMES[key]||key)+' — baue eine Lagerkiste!');
  }
  return stored;
}
/* ============================================================
   Produktionsketten
   Jedes Produktionsgebäude verarbeitet echte Waren zu echten
   Produkten — statt eines abstrakten Prozent-Bonus.
============================================================ */
const PRODUCTION_RECIPES = {
  sawmill:   [{in:{wood:2},              out:{planks:1},        label:'Holz → Planken'},
              {in:{planks:2, fiber:1},   out:{griff:2},         label:'Planken + Faser → Griffe'}],
  furnace:   [{in:{ore:2},               out:{metal:1},         label:'Erz → Metall'},
              {in:{metal:2, wood:1},     out:{beschlag:2},      label:'Metall + Holz → Beschläge'}],
  loom:      [{in:{fiber:2},             out:{cloth:1},         label:'Faser → Stoff'},
              {in:{leder:1, cloth:1},    out:{werkzeugteile:1}, label:'Leder + Stoff → Werkzeugteile'}],
  gerberei:  [{in:{fell:2},              out:{leder:1},         label:'Fell → Leder'},
              {in:{leder:2, cloth:1},    out:{werkzeugteile:2}, label:'Leder + Stoff → Werkzeugteile'}],
  toepferei: [{in:{ton:2},               out:{keramik:1},       label:'Ton → Keramik'},
              {in:{keramik:2, silver:1}, out:{tinktur:2},       label:'Keramik + Silber → Tinkturen'}],
  muehle:    [{in:{getreide:3},          out:{mehl:2},          label:'Getreide → Mehl'}],
  baeckerei: [{in:{mehl:2},              out:{meal_brot:2},     label:'Mehl → Brot'},
              {in:{mehl:1, gemuese:2},   out:{meal_veggie:1},   label:'Mehl + Gemüse → Eintopf'}],
  alchemielabor:[{in:{kraeuter:2, harz:1}, out:{tinktur:2},     label:'Kräuter + Harz → Tinktur'},
              {in:{tinktur:2},           out:{potion:3},        label:'Tinktur → Heiltränke'}],
  schreinerei:[{in:{planks:2},           out:{griff:3},         label:'Planken → Griffe'},
              {in:{griff:2, beschlag:1}, out:{werkzeugteile:2}, label:'Griffe + Beschläge → Werkzeugteile'}],
  steinmetz: [{in:{stone:3},             out:{ton:2},           label:'Stein → Ton'},
              {in:{stone:4, metal:1},    out:{beschlag:3},      label:'Stein + Metall → Beschläge'}]
};
function hasRecipes(type){ return !!PRODUCTION_RECIPES[type]; }
function canCraftRecipe(r){
  return Object.keys(r.in).every(k=>(state.inventory[k]||0) >= r.in[k]);
}
function craftRecipe(r, times){
  const n = times||1;
  for(let i=0;i<n;i++){
    if(!canCraftRecipe(r)) return i;
    Object.keys(r.in).forEach(k=>{ state.inventory[k]-=r.in[k]; bumpResource(k); });
    Object.keys(r.out).forEach(k=>{ addResource(k, r.out[k]); bumpResource(k); });
  }
  return n;
}
function craftRecipeAll(r){
  let made = 0;
  while(canCraftRecipe(r) && made < 200){ craftRecipe(r,1); made++; }
  return made;
}

/* ============================================================
   Werkzeuge mit Verschleiß
   Physische Gegenstände statt abstrakter Boni: Sie werden in
   Werkstätten hergestellt, nutzen sich beim Arbeiten ab und
   bestimmen direkt, wie viel ein Abbauvorgang einbringt.
============================================================ */
const TOOL_TYPES = {
  axt:        { name:'Axt',        icon:'🪓', use:'chop', desc:'Fällt Bäume schneller' },
  spitzhacke: { name:'Spitzhacke', icon:'⛏️', use:'mine', desc:'Bricht Stein und Erz' },
  sichel:     { name:'Sichel',     icon:'🌾', use:'harvest', desc:'Erntet Pflanzen sauberer' }
};
// Materialstufen: bessere Stufe = mehr Ertrag und mehr Haltbarkeit
const TOOL_TIERS = {
  holz:   { name:'Holz',   yield:1, dur:40,  cost:{wood:4, stone:2},                 col:'#8a6038' },
  stein:  { name:'Stein',  yield:2, dur:80,  cost:{griff:1, stone:4, beschlag:1},     col:'#7f8791' },
  eisen:  { name:'Eisen',  yield:3, dur:160, cost:{griff:1, metal:3, werkzeugteile:1},col:'#9aa3ad' },
  silber: { name:'Silber', yield:4, dur:300, cost:{griff:1, silver:3, werkzeugteile:2, beschlag:1}, col:'#d5dde5' }
};
const TOOL_TIER_ORDER = ['holz','stein','eisen','silber'];
function toolKey(type, tier){ return type+'_'+tier; }
// Bestes vorhandenes Werkzeug für eine Arbeit finden
/* ============================================================
   Fortschrittszwang: Ohne Werkzeug kein Abbau
   Bäume, Fels und Erz lassen sich nicht mehr mit bloßen Händen
   ernten. Der Einstieg läuft über lose Bodenfunde -> Werkbank
   -> Werkzeuge -> voller Zugriff auf die Karte.
============================================================ */
const TOOL_REQUIRED = { chop:'Axt', mine:'Spitzhacke' };
let lastToolHint = 0;
function requireTool(use){
  if(!TOOL_REQUIRED[use]) return true;          // Ernten geht auch ohne
  if(bestTool(use)) return true;
  const now = Date.now();
  if(now - lastToolHint > 2500){
    lastToolHint = now;
    const what = TOOL_REQUIRED[use];
    toast(`✋ Dafür brauchst du eine ${what}. Sammle Holz und Stein vom Boden und baue eine Werkstatt.`);
  }
  return false;
}
function bestTool(use){
  if(!state.tools) state.tools = {};
  let best = null;
  Object.keys(TOOL_TYPES).forEach(t=>{
    if(TOOL_TYPES[t].use !== use) return;
    TOOL_TIER_ORDER.forEach(tier=>{
      const k = toolKey(t,tier);
      const it = state.tools[k];
      if(!it || it.dur<=0) return;
      if(!best || TOOL_TIERS[tier].yield > TOOL_TIERS[best.tier].yield) best = {key:k, type:t, tier, item:it};
    });
  });
  return best;
}
// Ertragsbonus durch Werkzeug — ohne Werkzeug arbeitet man mit bloßen Händen
function toolYield(use){
  const b = bestTool(use);
  return b ? TOOL_TIERS[b.tier].yield : 0;
}
// Abnutzung nach einem Arbeitsschritt
function wearTool(use){
  const b = bestTool(use);
  if(!b) return null;
  b.item.dur -= 1;
  if(b.item.dur <= 0){
    delete state.tools[b.key];
    const t = TOOL_TYPES[b.type];
    toast(`${t.icon} Deine ${TOOL_TIERS[b.tier].name}-${t.name} ist zerbrochen.`);
    logEvent(`🔧 ${TOOL_TIERS[b.tier].name}-${t.name} zerbrochen — stelle in der Werkstatt eine neue her.`);
    sfxError();
  } else if(b.item.dur === Math.round(TOOL_TIERS[b.tier].dur*0.15)){
    toast(`${TOOL_TYPES[b.type].icon} Deine ${TOOL_TIERS[b.tier].name}-${TOOL_TYPES[b.type].name} ist fast durch.`);
  }
  return b;
}
function craftTool(type, tier){
  const t = TOOL_TIERS[tier];
  if(!t) return false;
  if(!Object.keys(t.cost).every(k=>(state.inventory[k]||0) >= t.cost[k])) return false;
  Object.keys(t.cost).forEach(k=>{ state.inventory[k] -= t.cost[k]; bumpResource(k); });
  if(!state.tools) state.tools = {};
  const key = toolKey(type,tier);
  const existing = state.tools[key];
  // Vorhandenes Werkzeug derselben Art auffrischen statt doppelt anlegen
  state.tools[key] = { dur: (existing ? existing.dur : 0) + t.dur, maxDur: t.dur };
  sfxCraft(); updateHUD(); saveGame();
  toast(`${TOOL_TYPES[type].icon} ${t.name}-${TOOL_TYPES[type].name} hergestellt.`);
  logEvent(`🔧 ${t.name}-${TOOL_TYPES[type].name} in der Werkstatt gefertigt.`);
  return true;
}
// Zustandstext für die Anzeige
function toolCondition(item, tier){
  const max = TOOL_TIERS[tier].dur;
  const p = item.dur / max;
  if(p > 0.66) return {label:'gut', col:'#3d7a35'};
  if(p > 0.33) return {label:'abgenutzt', col:'#c9a23d'};
  return {label:'fast durch', col:'#b03a2e'};
}

/* ============================================================
   Waffen-Arsenal
   Klassengebundene Waffen aus echten Bauteilen. Jede Klasse
   führt eigene Waffentypen — Ausrüstung anderer Klassen bringt
   nur einen Bruchteil ihrer Wirkung.
============================================================ */
const WEAPON_TYPES = {
  schwert:      { name:'Schwert',       icon:'🗡️', cls:'Krieger',    desc:'Ausgewogen — solider Schaden, gute Deckung' },
  doppelklinge: { name:'Doppelklingen', icon:'⚔️', cls:'Krieger',    desc:'Zwei Klingen — hoher Schaden, weniger Deckung' },
  streitaxt:    { name:'Streitaxt',     icon:'🪓', cls:'Krieger',    desc:'Schwer und wuchtig — langsam, aber durchschlagend' },
  bogen:        { name:'Bogen',         icon:'🏹', cls:'Waldläufer', desc:'Trifft aus der Ferne, bevor der Gegner heran ist' },
  jagdspeer:    { name:'Jagdspeer',     icon:'🔱', cls:'Waldläufer', desc:'Reichweite und Wucht — hält Gegner auf Abstand' },
  stab:         { name:'Zauberstab',    icon:'🪄', cls:'Magier',     desc:'Bündelt Mana — mehr Wirkung bei Zaubern' },
  runenstab:    { name:'Runenstab',     icon:'📿', cls:'Magier',     desc:'In Leder gewickelte Runen — verstärkt Flächenzauber' },
  heilstab:     { name:'Heilstab',      icon:'⚕️', cls:'Heiler',     desc:'Verstärkt Heilung spürbar' },
  segensstab:   { name:'Segensstab',    icon:'✨', cls:'Heiler',     desc:'Silberbeschlagen — heilt und schützt zugleich' }
};
// Materialstufen wie bei Werkzeugen — Bauteile aus den Produktionsketten
const WEAPON_TIERS = {
  einfach: { name:'Einfach', atk:2, cost:{griff:1, metal:2} },
  gehaertet:{name:'Gehärtet',atk:4, cost:{griff:1, metal:3, beschlag:1, leder:1} },
  silber:  { name:'Silber',  atk:6, cost:{griff:1, silver:3, beschlag:2, leder:2} },
  meister: { name:'Meister', atk:9, cost:{griff:2, silver:4, gold:2, werkzeugteile:2, leder:3} }
};
const WEAPON_TIER_ORDER = ['einfach','gehaertet','silber','meister'];
// Bogen und Stäbe brauchen andere Materialien als Klingen
const WEAPON_EXTRA_COST = {
  bogen:      {fiber:3, leder:1},
  jagdspeer:  {planks:2},
  stab:       {harz:2},
  runenstab:  {leder:2, tinktur:1},
  heilstab:   {kraeuter:3},
  segensstab: {tinktur:2, silver:1}
};
function weaponCost(type, tier){
  const base = {...WEAPON_TIERS[tier].cost};
  const extra = WEAPON_EXTRA_COST[type];
  if(extra) Object.keys(extra).forEach(k=>{ base[k] = (base[k]||0) + extra[k]; });
  return base;
}
function weaponKey(type, tier){ return type+'_'+tier; }
// Passt die Waffe zur Klasse? Fremde Waffen wirken nur zu 40 %
function weaponFitsClass(type, cls){ return WEAPON_TYPES[type].cls === cls; }
function weaponAtkFor(type, tier, cls){
  const base = WEAPON_TIERS[tier].atk;
  return weaponFitsClass(type, cls) ? base : Math.max(1, Math.round(base*0.4));
}
function craftWeapon(type, tier){
  const cost = weaponCost(type, tier);
  if(!Object.keys(cost).every(k=>(state.inventory[k]||0) >= cost[k])) return false;
  Object.keys(cost).forEach(k=>{ state.inventory[k] -= cost[k]; bumpResource(k); });
  state.weapons = state.weapons || {};
  state.weapons[weaponKey(type,tier)] = true;
  sfxCraft(); updateHUD(); saveGame();
  const w = WEAPON_TYPES[type];
  toast(`${w.icon} ${WEAPON_TIERS[tier].name}e ${w.name} geschmiedet.`);
  logEvent(`⚒️ ${WEAPON_TIERS[tier].name}e ${w.name} in der Schmiede gefertigt.`);
  return true;
}
function equipWeapon(type, tier){
  const key = weaponKey(type,tier);
  if(!state.weapons || !state.weapons[key]) return false;
  const cls = state.player.advClass;
  state.player.equippedWeapon = {type, tier};
  state.player.gear = state.player.gear || {};
  state.player.gear.weapon = weaponAtkFor(type, tier, cls);
  const w = WEAPON_TYPES[type];
  const fits = weaponFitsClass(type, cls);
  toast(fits ? `${w.icon} ${w.name} angelegt (+${state.player.gear.weapon} Angriff)`
             : `${w.icon} ${w.name} angelegt — als ${cls||'Klassenlose'} nur +${state.player.gear.weapon} Angriff`);
  updateHUD(); saveGame();
  return true;
}
function ownedWeapons(){
  if(!state.weapons) return [];
  return Object.keys(state.weapons).filter(k=>state.weapons[k]).map(k=>{
    const i = k.lastIndexOf('_');
    return {key:k, type:k.slice(0,i), tier:k.slice(i+1)};
  });
}

const BUILDING_TYPES = {
  campfire:{name:'🔥 Lagerfeuer', cost:{wood:5,stone:2}, desc:'Zum Ausruhen: Energie & Begleiter heilen'},
  tent:{name:'🛏️ Bett', cost:{wood:8,fiber:3}, desc:'Wohnraum für +1 Kolonist'},
  door:{name:'🚪 Tür', cost:{wood:2,stone:1}, desc:'Durchgang, immer passierbar'},
  sawmill:{name:'🪚 Sägewerk', cost:{wood:8,stone:3}, desc:'Schaltet Veredelung Holz→Planken frei'},
  furnace:{name:'⚒️ Schmelzofen', cost:{stone:10,wood:3}, desc:'Schaltet Veredelung Erz→Metall frei'},
  loom:{name:'🧵 Webstuhl', cost:{wood:6,fiber:4}, desc:'Schaltet Veredelung Faser→Stoff frei'},
  stockpile:{name:'📦 Lagerzone', cost:{planks:4,stone:3}, desc:'Ziehen für eine Fläche — sammelt passiv Rohstoffe'},
  schmiede:{name:'⚒️ Schmiede', cost:{stone:12,planks:6,metal:4}, desc:'Schmiedet Waffen — Schwerter, Bögen und Stäbe passend zur Klasse'},
  primitivbank:{name:'🪵 Primitive Werkbank', cost:{wood:6,stone:3}, desc:'Erster Bauplatz — fertigt einfache Werkzeuge aus Holz und Stein'},
  werkstatt:{name:'🔧 Werkstatt', cost:{planks:8,stone:4,metal:2}, desc:'Stellt Werkzeuge her — Äxte, Spitzhacken und Sicheln aus Griffen, Beschlägen und Metall'},
  lagerkiste:{name:'🧰 Lagerkiste', cost:{planks:5,metal:2}, desc:'Erhöht das Lagerlimit deutlich — Kolonisten legen Fundstücke hier ab'},
  werft:{name:'⛵ Werft', cost:{planks:20,cloth:10,metal:5}, desc:'Baut ein Segelboot — damit befährst du auf der Weltkarte das offene Meer'},
  wall:{name:'🧱 Wand', cost:{stone:6}, desc:'Ziehen für eine Linie — blockiert den Weg, verringert Überfallschaden'},
  tower:{name:'🗼 Wachturm', cost:{planks:6,metal:2}, desc:'Mildert Überfälle zusätzlich ab'},
  workbench:{name:'🛠️ Produktionsbank', cost:{planks:5,metal:3}, desc:'Verbessert Fallen: höhere Fangchance'},
  forge:{name:'⚒️ Schmiede', cost:{wood:6,stone:4,metal:3}, desc:'Schmiedet Waffen & Rüstungen aus Kupfer, Silber und Gold'},
  research:{name:'📚 Forschungstisch', cost:{wood:8,planks:3}, desc:'Schaltet fortgeschrittene Schmiedekunst frei (Silber/Gold)'},
  barber:{name:'💈 Barbier', cost:{wood:5,cloth:2}, desc:'Ändere dein Aussehen oder das eines Kolonisten'},
  brunnen:{name:'⛲ Brunnen', cost:{stone:6,wood:2}, desc:'Trinken ohne Weg zum See'},
  zaun:{name:'🪵 Zaun', cost:{wood:3}, desc:'Ziehen für eine Linie — günstige, leichte Barriere'},
  vorratskammer:{name:'🍯 Vorratskammer', cost:{planks:5,stone:3}, desc:'Kolonisten werden 20% langsamer hungrig'},
  krankenstube:{name:'⚕️ Krankenstube', cost:{planks:6,cloth:3}, desc:'Krankheiten heilen zusätzlich schneller', requiresTech:'kraeutermedizin'},
  bibliothek:{name:'📖 Bibliothek', cost:{planks:8,metal:2}, desc:'Kolonisten lernen passiv dazu (Bonus-Erfahrung)', requiresTech:'werkzeugkunde'},
  wachhaus:{name:'🏹 Wachhaus', cost:{stone:8,metal:2}, desc:'Zusätzliche Verteidigung gegen Überfälle', requiresTech:'belagerungsbau'},
  zwinger:{name:'🐾 Zwinger', cost:{wood:6,fiber:4}, desc:'Höhere Fangchance bei wilden Kreaturen', requiresTech:'faehrtenlesen'},
  copperwall:{name:'🟠 Kupferwand', cost:{copper:4,stone:3}, desc:'Ziehen für eine Linie — stärker als Stein, mit Prestige-Glanz'},
  silverwall:{name:'⚪ Silberwand', cost:{silver:3,stone:4}, desc:'Ziehen für eine Linie — deutlich robuster, edler Glanz', requiresTech:'schmiedekunst'},
  goldwall:{name:'🟡 Goldwand', cost:{gold:2,stone:5}, desc:'Ziehen für eine Linie — prunkvoller Goldglanz', requiresTech:'meisterhandwerk'},
  titanwall:{name:'🔷 Titanwand', cost:{erz_titan:1,stone:6}, desc:'Ziehen für eine Linie — die widerstandsfähigste Mauer überhaupt, aus seltenem Titanerz', requiresTech:'festungsbau'},
  /* ---- Holzwände (3 Stufen) ---- */
  holzwand1:{name:'🪵 Holzwand I', cost:{wood:4}, desc:'Ziehen für eine Linie — schnell gebaut, hält wenig aus'},
  holzwand2:{name:'🪵 Holzwand II', cost:{wood:6,planks:2}, desc:'Ziehen für eine Linie — verbrettert und deutlich stabiler'},
  holzwand3:{name:'🪵 Holzwand III', cost:{planks:5,fiber:3}, desc:'Ziehen für eine Linie — verstrebte Palisade, beste Holzstufe'},
  /* ---- Fensterwände (3 Stufen) ---- */
  fensterwand1:{name:'🪟 Fensterwand I', cost:{wood:4,stone:2}, desc:'Ziehen für eine Linie — Luke im Holz, lässt Licht herein'},
  fensterwand2:{name:'🪟 Fensterwand II', cost:{stone:5,keramik:2}, desc:'Ziehen für eine Linie — verglaste Öffnung im Steinrahmen'},
  fensterwand3:{name:'🪟 Fensterwand III', cost:{stone:6,keramik:3,silver:1}, desc:'Ziehen für eine Linie — Bleiglasfenster, hell und wehrhaft', requiresTech:'schmiedekunst'},
  /* ---- Metallwände (3 Stufen) ---- */
  metallwand1:{name:'⚙️ Metallwand I', cost:{metal:3,stone:3}, desc:'Ziehen für eine Linie — genietete Blechplatten'},
  metallwand2:{name:'⚙️ Metallwand II', cost:{metal:5,beschlag:2}, desc:'Ziehen für eine Linie — verstärkte Panzerung mit Beschlägen', requiresTech:'schmiedekunst'},
  metallwand3:{name:'⚙️ Metallwand III', cost:{metal:6,erz_titan:1,beschlag:3}, desc:'Ziehen für eine Linie — titanverstärkt, die härteste Metallstufe', requiresTech:'festungsbau'},
  stuhl:{name:'🪑 Stuhl', cost:{wood:3}, desc:'Kurz hinsetzen und ausruhen — kleine Energie-Erholung'},
  bank:{name:'🛋️ Bank', cost:{wood:5,fiber:2}, desc:'Größere Sitzgelegenheit — etwas mehr Energie-Erholung'},
  holzboden:{name:'🟫 Holzboden', cost:{wood:2}, desc:'Ziehen für eine Fläche — hübscher Bodenbelag, rein optisch'},
  steinboden:{name:'⬜ Steinboden', cost:{stone:2}, desc:'Ziehen für eine Fläche — robuster Bodenbelag, rein optisch'},
  kuechenherd:{name:'🍳 Küchenherd', cost:{stone:8,metal:2}, desc:'Koche nahrhafte Gerichte aus Jagdbeute und Wildgemüse'},
  schutzzone:{name:'🚫 Schutzzone', cost:{stone:1}, desc:'Ziehen für eine Fläche — hier wachsen Bäume, Sträucher & Gestein nie wieder nach'},
  feld_beeren:{name:'🫐 Beerenfeld', cost:{fiber:1}, desc:'Ziehen für eine Fläche — gezielter Beerenanbau statt nur Sammeln'},
  feld_gemuese:{name:'🥕 Gemüsefeld', cost:{fiber:1}, desc:'Ziehen für eine Fläche — gezielter Wildgemüse-Anbau'},
  feld_kraeuter:{name:'🌱 Kräuterfeld', cost:{fiber:1}, desc:'Ziehen für eine Fläche — Heilkräuter für Medizin & Handel'},
  feld_fasern:{name:'🌿 Faserfeld', cost:{fiber:2,wood:1}, desc:'Ziehen für eine Fläche — liefert Fasern für Stoff und Seile'},
  feld_getreide:{name:'🌾 Getreidefeld', cost:{fiber:1}, desc:'Ziehen für eine Fläche — Getreide für Brot'},
  tiergehege:{name:'🐾 Tiergehege', cost:{wood:2,fiber:1}, desc:'Ziehen für eine Fläche — gefangene Kreaturen wohnen hier und liefern passiv Material'},
  toepferei:{name:'🏺 Töpferei', cost:{wood:5,stone:5}, desc:'Formt Ton zu Krügen — steigert den passiven Ertrag des Lagerplatzes'},
  gerberei:{name:'🧴 Gerberei', cost:{wood:6,stone:3}, desc:'Verarbeitet Jagdbeute weiter — steigert den passiven Ertrag des Lagerplatzes'},
  muehle:{name:'🌬️ Mühle', cost:{wood:10,stone:4}, desc:'Mahlt Getreide zu Mehl — mehr Brot pro Backvorgang'},
  baeckerei:{name:'🥖 Bäckerei', cost:{planks:6,stone:4}, desc:'Professioneller Backofen — bessere Mahlzeiten am Küchenherd'},
  alchemielabor:{name:'⚗️ Alchemistenlabor', cost:{planks:5,metal:2,kraeuter:3}, desc:'Braut stärkere Heiltränke — Heiltrank-Herstellung verbessert', requiresTech:'kraeutermedizin'},
  schreinerei:{name:'🪚 Schreinerei', cost:{wood:8,metal:2}, desc:'Feine Holzverarbeitung — mehr Planken pro Veredelung'},
  steinmetz:{name:'🔨 Steinmetzwerkstatt', cost:{stone:10,metal:2}, desc:'Feine Steinbearbeitung — höhere Chance auf Marmor & Sandstein beim Abbau'},
  schreibtisch:{name:'🗒️ Schreibtisch', cost:{planks:4,metal:1}, desc:'Ruhiger Arbeitsplatz — kleiner Stimmungsbonus für die Kolonie'},
  kommode:{name:'🗄️ Kommode', cost:{wood:5,metal:1}, desc:'Ordentlicher Stauraum — kleiner Stimmungsbonus für die Kolonie'},
  fackel:{name:'🔦 Fackel', cost:{wood:2,fiber:1}, desc:'Spendet Licht in der Nacht — kleiner Stimmungsbonus'},
  kamin:{name:'🧱 Kamin', cost:{stone:6,wood:2}, desc:'Wärme und Behaglichkeit — kleiner Stimmungsbonus für die Kolonie'},
  teppich:{name:'🟥 Teppich', cost:{cloth:4}, desc:'Ziehen für eine Fläche — dekorativer Bodenbelag mit Stimmungsbonus'},
  statue:{name:'🗿 Statue', cost:{stone:12,metal:4}, desc:'Beeindruckendes Kunstwerk — spürbarer Stimmungsbonus für die ganze Kolonie'},
  blumentopf:{name:'🪴 Blumentopf', cost:{wood:1,fiber:1}, desc:'Etwas Grün fürs Auge — winziger Stimmungsbonus'},
  schachtisch:{name:'♟️ Schachtisch', cost:{planks:4,metal:2}, desc:'Freizeit & Geselligkeit — Stimmungsbonus für die Kolonie'},
  kegelbahn:{name:'🎳 Kegelbahn', cost:{wood:10,stone:4}, desc:'Freizeit & Geselligkeit — größerer Stimmungsbonus für die Kolonie'},
  musikecke:{name:'🎻 Musikecke', cost:{wood:6,fiber:3,metal:1}, desc:'Freizeit & Geselligkeit — Stimmungsbonus für die Kolonie'},
  spitzenfalle:{name:'⚠️ Spitzenfalle', cost:{wood:4,metal:2}, desc:'Versteckte Fallen verletzen angreifende Kreaturen bei Überfällen', requiresTech:'belagerungsbau'},
  ballista:{name:'🏹 Balliste', cost:{planks:10,metal:6}, desc:'Schwere Belagerungswaffe — starke zusätzliche Verteidigung gegen Überfälle', requiresTech:'festungsbau'},
  marmorboden:{name:'⬜ Marmorboden', cost:{stein_marmor:3}, desc:'Ziehen für eine Fläche — edler Bodenbelag mit Stimmungsbonus'},
  gartenweg:{name:'🟤 Gartenweg', cost:{stone:1,wood:1}, desc:'Ziehen für eine Fläche — einfacher, günstiger Weg'}
};
// Beschreibungen der Produktionsgebäude aus ihren Rezepten ableiten,
// damit Text und tatsächliche Funktion nicht auseinanderlaufen
/* ============================================================
   Player movement (mouse path-follow) & auto-actions
============================================================ */
/* ============================================================
   Stat decay loop (player)
============================================================ */
function renderMinimap(){
  const canvas = document.getElementById('minimapCanvas');
  if(!canvas) return;
  const mctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  mctx.clearRect(0,0,W,H);
  if(atDungeon()){
    mctx.fillStyle = '#2a2620'; mctx.fillRect(0,0,W,H);
    mctx.fillStyle = '#ffd23f';
    mctx.beginPath(); mctx.arc(W/2,H/2,2.5,0,Math.PI*2); mctx.fill();
    mctx.font='9px sans-serif'; mctx.fillStyle='rgba(255,255,255,.5)'; mctx.textAlign='center';
    mctx.fillText(dungeonCtx && dungeonCtx.instanceType==='cave' ? 'Höhle' : 'Dungeon', W/2, H-6);
    return;
  }
  const rangeX = 22, rangeY = 15;
  const px0 = Math.round(state.player.x - rangeX), py0 = Math.round(state.player.y - rangeY);
  const scaleX = W/(rangeX*2), scaleY = H/(rangeY*2);
  mctx.fillStyle = '#2f4a2a'; mctx.fillRect(0,0,W,H);
  for(let ty=0; ty<rangeY*2; ty++){
    for(let tx=0; tx<rangeX*2; tx++){
      const wx = px0+tx, wy = py0+ty;
      const t = tileAt(wx,wy);
      let col = null;
      if(t===TILE_WATER) col='#2e6d72';
      else if(t===TILE_SAND) col='#d3bd80';
      const o = objAt(wx,wy);
      if(o){
        if(o.type==='tree') col='#1f3d1a';
        else if(o.type==='rock'||o.type==='orevein'||o.type==='mountain') col='#5a564c';
        else if(o.type==='dungeon_portal') col='#9a6fc9';
        else if(o.type==='trader'||o.type==='hut') col='#c9822c';
        else if(o.type==='vwall') col='#8d6038';
        else if(o.type==='vdoor'||o.type==='vfloor'||o.type==='vfurn') col='#a97b45';
      }
      if(col){ mctx.fillStyle=col; mctx.fillRect(tx*scaleX, ty*scaleY, scaleX+0.6, scaleY+0.6); }
    }
  }
  if(!atDungeon()){
    state.buildings.filter(b=>(b.regionId||'C')===state.player.regionId).forEach(b=>{
      if(b.x<px0||b.y<py0||b.x>=px0+rangeX*2||b.y>=py0+rangeY*2) return;
      mctx.fillStyle='#ffd23f';
      mctx.fillRect((b.x-px0)*scaleX,(b.y-py0)*scaleY,scaleX+0.6,scaleY+0.6);
    });
  }
  mctx.fillStyle = '#fff'; mctx.strokeStyle='#000'; mctx.lineWidth=1;
  mctx.beginPath(); mctx.arc(W/2, H/2, 3, 0, Math.PI*2); mctx.fill(); mctx.stroke();
}

/* ============================================================
   Lebensregeneration
   - Schaden setzt einen Zeitstempel; erst nach REGEN_DELAY_MS
     ohne Treffer beginnt die langsame Selbstheilung.
   - In der Basis (Nähe zu Gebäuden) regeneriert es schneller.
   - Essen/Trinken/Tränke und Schlafen heilen zusätzlich sofort.
============================================================ */
let lastDamageAt = 0;
const REGEN_DELAY_MS = 150000;   // 2,5 Min ohne Schaden, dann startet die Heilung
const REGEN_TICK_MS  = 6000;     // alle 6 Sekunden ein Heiltick
function damagePlayer(amount, reason){
  state.stats.hp = clamp(state.stats.hp - amount, 0, 100);
  lastDamageAt = Date.now();
  if(reason) logEvent(reason);
  updateHUD();
}
function healPlayer(amount, silent){
  const before = state.stats.hp;
  state.stats.hp = clamp(state.stats.hp + amount, 0, 100);
  const gained = Math.round(state.stats.hp - before);
  if(gained>0 && !silent) toast('❤️ +'+gained+' Leben');
  updateHUD();
  return gained;
}

function dayPhaseNow(){
  const offset = state.dayCycleOffset;
  if(offset==null) return 0.5; // no game running yet -> keep it bright behind the start screen
  const elapsed = Date.now() - offset;
  return (((elapsed % DAY_CYCLE_MS) + DAY_CYCLE_MS) % DAY_CYCLE_MS) / DAY_CYCLE_MS;
} // 0=midnight, 0.5=noon
/* Weiche Stufenfunktion: startet und endet mit Steigung null, deshalb gibt
   es keine spürbaren Knicke im Verlauf. */
function smoothstep(rand0, rand1, x){
  const t = clamp((x - rand0) / (rand1 - rand0), 0, 1);
  return t * t * (3 - 2 * t);
}

const NACHT_MAX = 0.80;

/* Dunkelheit über den Tag. Vorher war das eine Gerade mit harten Ecken bei
   0.2 und 0.4 — die Dämmerung setzte schlagartig ein und hörte schlagartig
   auf. Mit smoothstep läuft sie sanft an und sanft aus. */
function darknessAt(phase){
  const distFromNoon = Math.abs(phase-0.5); // 0 = Mittag, 0.5 = Mitternacht
  return smoothstep(0.17, 0.42, distFromNoon) * NACHT_MAX;
}

/* Farbe des Himmelsschleiers. Nachts kühl blau, in der Dämmerung warm —
   morgens rosig, abends bernsteinfarben. Der Schleier liegt über der
   gesamten Welt, dadurch verfärben sich Wiese, Wege und Objekte mit. */
const HIMMEL_NACHT  = [8, 14, 32];
const HIMMEL_MORGEN = [64, 34, 44];
const HIMMEL_ABEND  = [78, 40, 16];

function skyTintAt(phase){
  const distFromNoon = Math.abs(phase-0.5);
  const nachtAnteil = smoothstep(0.30, 0.46, distFromNoon);
  // Dämmerung ist im Übergangsbereich am stärksten und verschwindet zu
  // beiden Seiten wieder — daher die Sinuskurve statt einer Geraden.
  const uebergang = smoothstep(0.17, 0.42, distFromNoon);
  const daemmerAnteil = Math.sin(uebergang * Math.PI) * (1 - nachtAnteil * 0.55);
  const abends = phase > 0.5;
  const warm = abends ? HIMMEL_ABEND : HIMMEL_MORGEN;
  const mischung = [0,1,2].map(i=>
    Math.round(HIMMEL_NACHT[i] * (1 - daemmerAnteil) + warm[i] * daemmerAnteil));
  return mischung;
}

/* Wie warm leuchten Lichtquellen? Am Tag gar nicht, nachts voll. */
function lightWarmthAt(phase){
  return smoothstep(0.19, 0.40, Math.abs(phase-0.5));
}
function isNightNow(){ return darknessAt(dayPhaseNow()) > 0.35; }
function dayPhaseLabel(){
  const p = dayPhaseNow();
  if(p<0.06 || p>0.94) return {icon:'🌙', text:'Tiefe Nacht'};
  if(p<0.24) return {icon:'🌅', text:'Morgendämmerung'};
  if(p<0.45) return {icon:'☀️', text:'Vormittag'};
  if(p<0.55) return {icon:'🌞', text:'Mittag'};
  if(p<0.76) return {icon:'☀️', text:'Nachmittag'};
  if(p<0.9) return {icon:'🌇', text:'Abenddämmerung'};
  return {icon:'🌙', text:'Nacht'};
}
function updateDayNightIndicator(){
  const l = dayPhaseLabel();
  const el = document.getElementById('dayNightIndicator');
  if(el) el.firstChild.textContent = l.icon+' ';
  const lbl = document.getElementById('dayNightLabel');
  if(lbl) lbl.textContent = l.text;
  drawClock();
}
// Ingame-Uhr: ein voller Zyklus (DAY_CYCLE_MS) entspricht 24 Ingame-Stunden
function ingameTime(){
  const phase = dayPhaseNow();          // 0 = Mitternacht, 0.5 = Mittag
  const totalMin = phase * 24 * 60;
  const h = Math.floor(totalMin/60) % 24;
  const m = Math.floor(totalMin % 60);
  return { h, m, phase };
}
function drawClock(){
  const txt = document.getElementById('clockText');
  const cv = document.getElementById('clockDial');
  const t = ingameTime();
  if(txt) txt.textContent = String(t.h).padStart(2,'0')+':'+String(t.m).padStart(2,'0');
  if(!cv) return;
  const g = cv.getContext('2d'); const W=cv.width, H=cv.height, R=W/2-2;
  g.clearRect(0,0,W,H);
  // Zifferblatt färbt sich mit der Tageszeit (dunkel nachts, hell mittags)
  const dark = darknessAt(t.phase);
  const face = g.createRadialGradient(W/2,H/2,1,W/2,H/2,R);
  face.addColorStop(0, dark>0.5 ? '#2a3550' : '#f2e4c4');
  face.addColorStop(1, dark>0.5 ? '#161d2e' : '#d8c08a');
  g.fillStyle=face; g.beginPath(); g.arc(W/2,H/2,R,0,Math.PI*2); g.fill();
  g.strokeStyle='#c9b988'; g.lineWidth=1.6; g.stroke();
  // Stundenmarken
  g.strokeStyle = dark>0.5 ? 'rgba(210,225,255,.5)' : 'rgba(60,45,20,.45)';
  g.lineWidth=1;
  for(let i=0;i<12;i++){
    const a=i*Math.PI/6;
    g.beginPath();
    g.moveTo(W/2+Math.sin(a)*(R-2.5), H/2-Math.cos(a)*(R-2.5));
    g.lineTo(W/2+Math.sin(a)*(R-(i%3===0?5.5:3.5)), H/2-Math.cos(a)*(R-(i%3===0?5.5:3.5)));
    g.stroke();
  }
  // Zeiger
  const hA = ((t.h%12)+t.m/60)*Math.PI/6, mA = t.m*Math.PI/30;
  g.strokeStyle = dark>0.5 ? '#e8eeff' : '#3a2c14'; g.lineCap='round';
  g.lineWidth=2.2; g.beginPath(); g.moveTo(W/2,H/2);
  g.lineTo(W/2+Math.sin(hA)*R*0.5, H/2-Math.cos(hA)*R*0.5); g.stroke();
  g.lineWidth=1.5; g.beginPath(); g.moveTo(W/2,H/2);
  g.lineTo(W/2+Math.sin(mA)*R*0.75, H/2-Math.cos(mA)*R*0.75); g.stroke();
  g.fillStyle='#d9542d'; g.beginPath(); g.arc(W/2,H/2,1.8,0,Math.PI*2); g.fill();
}
let nightLayerCanvas = null, nightLayerCtx = null;
function getNightLayer(){
  if(!nightLayerCanvas){
    nightLayerCanvas = document.createElement('canvas');
    nightLayerCanvas.width = canvas.width; nightLayerCanvas.height = canvas.height;
    nightLayerCtx = nightLayerCanvas.getContext('2d');
  }
  return nightLayerCtx;
}
function drawLightHoleOn(targetCtx, cx,cy,radius){
  const grad = targetCtx.createRadialGradient(cx,cy,0,cx,cy,radius);
  grad.addColorStop(0,'rgba(0,0,0,1)');
  grad.addColorStop(0.65,'rgba(0,0,0,0.65)');
  grad.addColorStop(1,'rgba(0,0,0,0)');
  targetCtx.fillStyle = grad;
  targetCtx.beginPath(); targetCtx.arc(cx,cy,radius,0,Math.PI*2); targetCtx.fill();
}
/* Lichtquellen der Kolonie: Reichweite in Pixeln, Flackerstaerke als Anteil
   des Radius, Tempo in Millisekunden je Schwingung. Wer hier eintraegt,
   leuchtet nachts automatisch mit. */
const LIGHT_SOURCES = {
  campfire:     { radius: 120, flacker: 0.05, tempo: 280 },
  kamin:        { radius:  96, flacker: 0.04, tempo: 340 },
  fackel:       { radius:  74, flacker: 0.08, tempo: 190 },
  kuechenherd:  { radius:  58, flacker: 0.03, tempo: 420 },
  forge:        { radius:  66, flacker: 0.05, tempo: 260 },
  furnace:      { radius:  66, flacker: 0.05, tempo: 300 },
  schmiede:     { radius:  70, flacker: 0.05, tempo: 240 },
};

function drawNightOverlay(now, pr){
  const phase = dayPhaseNow();
  const darkness = darknessAt(phase);
  if(darkness<=0.02) return;
  const nctx = getNightLayer();
  nctx.clearRect(0,0,nightLayerCanvas.width,nightLayerCanvas.height);
  // Farbiger Schleier statt festem Blaugrau: Dämmerung wärmt die Welt an
  const [hr,hg,hb] = skyTintAt(phase);
  nctx.fillStyle = `rgba(${hr},${hg},${hb},${darkness})`;
  nctx.fillRect(0,0,nightLayerCanvas.width,nightLayerCanvas.height);
  nctx.globalCompositeOperation = 'destination-out';
  const psx=(pr.x-camera.x)*TILE+TILE/2, psy=(pr.y-camera.y)*TILE+TILE/2;
  drawLightHoleOn(nctx, psx,psy,65);
  if(!atDungeon()){
    /* Vorher leuchtete ausschliesslich das Lagerfeuer — Fackeln und Kamin
       standen nachts im Dunkeln, obwohl sie sichtbar brennen. Die Tabelle
       LIGHT_SOURCES haelt Reichweite und Flackerstaerke je Bauart. */
    state.buildings.filter(b=>(b.regionId||'C')===state.player.regionId).forEach(b=>{
      const q = LIGHT_SOURCES[b.type];
      if(!q || !b.built) return;
      const sx=(b.x-camera.x)*TILE+TILE/2, sy=(b.y-camera.y)*TILE+TILE/2;
      if(sx < -q.radius || sy < -q.radius ||
         sx > nightLayerCanvas.width + q.radius || sy > nightLayerCanvas.height + q.radius) return;
      // Ruhiges Flackern, je Gebaeude leicht versetzt, damit nichts im Gleichtakt pulst
      const takt = Math.sin(now/q.tempo + b.x*1.7 + b.y*2.3);
      const radius = q.radius * (1 + takt * q.flacker);
      drawLightHoleOn(nctx, sx, sy, radius);
    });
  }
  nctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(nightLayerCanvas, 0, 0);

  /* Zweiter Durchgang direkt auf der Spielfläche: warmer Lichtschein der
     Feuerstellen. Der Schleier oben nimmt nur Dunkelheit weg — erst dieser
     additive Schein färbt die Umgebung wirklich warm ein und lässt das
     Lagerfeuer leuchten statt nur ein Loch zu hinterlassen. */
  const waerme = lightWarmthAt(phase);
  if(waerme > 0.02 && !atDungeon()){
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    state.buildings.filter(b=>(b.regionId||'C')===state.player.regionId).forEach(b=>{
      const q = LIGHT_SOURCES[b.type];
      if(!q || !b.built) return;
      const sx=Math.round((b.x-camera.x)*TILE)+TILE/2, sy=Math.round((b.y-camera.y)*TILE)+TILE/2;
      if(sx < -q.radius || sy < -q.radius ||
         sx > canvas.width + q.radius || sy > canvas.height + q.radius) return;
      const takt = Math.sin(now/q.tempo + b.x*1.7 + b.y*2.3);
      const r = q.radius * (1 + takt * q.flacker) * 0.82;
      const g = ctx.createRadialGradient(sx, sy, 1, sx, sy, r);
      g.addColorStop(0,   `rgba(255,186,92,${0.30*waerme})`);
      g.addColorStop(0.45,`rgba(224,132,48,${0.14*waerme})`);
      g.addColorStop(1,   'rgba(180,90,30,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI*2); ctx.fill();
    });
    ctx.restore();
  }
}
// Dreht das Geisterbild in 90-Grad-Schritten
function rotateBuildGhost(dir){
  if(!buildMode.active) return;
  if(!isRotatable(buildMode.type)){
    toast('↻ Dieses Gebäude hat keine feste Ausrichtung.');
    return;
  }
  buildMode.rotation = (((buildMode.rotation||0) + (dir>=0?90:-90)) % 360 + 360) % 360;
  // Bewusst gedreht -> Ausrichtung für weitere Platzierungen beibehalten
  buildMode.keepRotation = buildMode.rotation !== 0;
  const names = {0:'Norden',90:'Osten',180:'Süden',270:'Westen'};
  toast('↻ Ausrichtung: '+names[buildMode.rotation]+(buildMode.keepRotation?' (bleibt erhalten)':''));
  sfxPlace();
}
// Mausrad dreht ebenfalls, solange der Baumodus aktiv ist
// Mausrad dreht nur mit gedrückter Umschalttaste — sonst verdrehte
// sich beim normalen Scrollen ungewollt jedes Gebäude.

function drawBuildPreview(){
  if(!buildMode.active) return;
  const previewEnd = buildMode.dragCurrent || hoverTile;
  if(!previewEnd) return;
  const tiles = computeBuildTiles(buildMode.type, buildMode.dragStart, previewEnd);
  const cost = BUILDING_TYPES[buildMode.type].cost;
  const rot = buildMode.rotation||0;
  const rotatable = isRotatable(buildMode.type);
  ctx.save();
  tiles.forEach(t=>{
    const sx=(t.x-camera.x)*TILE, sy=(t.y-camera.y)*TILE;
    // Befestigte Böden und Zonen sind regulärer Untergrund — auf ihnen
    // darf gebaut werden. Nur echte Aufbauten blockieren das Feld.
    const valid = canBuildAt(t.x, t.y, buildMode.type);
    ctx.fillStyle = valid ? 'rgba(143,201,58,.30)' : 'rgba(217,84,45,.35)';
    ctx.fillRect(sx+2,sy+2,TILE-4,TILE-4);
    ctx.strokeStyle = valid ? '#8fc93a' : '#d9542d'; ctx.lineWidth=1.5; ctx.strokeRect(sx+2,sy+2,TILE-4,TILE-4);
    // Durchsichtige Vorschau des fertigen Gebäudes.
    // Die Drehung übernimmt drawBuilding selbst — damit gelten dort auch
    // die aufrechten Beschriftungen, genau wie beim fertig gebauten Objekt.
    if(valid){
      ctx.save();
      ctx.globalAlpha = 0.55;
      try{
        drawBuilding({type:buildMode.type, x:t.x, y:t.y, built:true,
                      rotation:(rotatable?rot:0), work:1, workReq:1,
                      regionId: state.player.regionId}, sx, sy);
      }catch(e){}
      ctx.restore();
    }
    // Richtungspfeil zeigt, wo die Vorderseite liegt
    if(valid && rotatable){
      ctx.save();
      ctx.translate(sx+TILE/2, sy+TILE/2);
      ctx.rotate(rot*Math.PI/180);
      ctx.fillStyle='rgba(255,210,90,.95)';
      ctx.strokeStyle='rgba(40,30,10,.7)'; ctx.lineWidth=1;
      ctx.beginPath();
      ctx.moveTo(0, TILE*0.42);        // Pfeilspitze nach unten = Vorderseite
      ctx.lineTo(-5, TILE*0.28);
      ctx.lineTo(5, TILE*0.28);
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  });
  ctx.restore();
  // Hinweis auf die Drehmöglichkeit
  if(rotatable && tiles.length){
    const first = tiles[0];
    const hx = (first.x-camera.x)*TILE + TILE/2, hy = (first.y-camera.y)*TILE - 10;
    ctx.save();
    ctx.font='800 10px Nunito, sans-serif'; ctx.textAlign='center';
    ctx.strokeStyle='rgba(0,0,0,.7)'; ctx.lineWidth=3;
    const names = {0:'Norden',90:'Osten',180:'Süden',270:'Westen'};
    const txt = '↻ R / Mausrad · '+names[rot];
    ctx.strokeText(txt, hx, hy);
    ctx.fillStyle='#ffd23f'; ctx.fillText(txt, hx, hy);
    ctx.restore();
  }
}
function drawDemolishPreview(){
  if(!demolishMode || !demolishDrag.start) return;
  const endTile = demolishDrag.current || hoverTile;
  if(!endTile) return;
  const start = demolishDrag.start;
  const x0=Math.min(start.x,endTile.x), x1=Math.max(start.x,endTile.x);
  const y0=Math.min(start.y,endTile.y), y1=Math.max(start.y,endTile.y);
  ctx.save();
  for(let y=y0;y<=y1;y++){ for(let x=x0;x<=x1;x++){
    const sx=(x-camera.x)*TILE, sy=(y-camera.y)*TILE;
    const hasBuilding = state.buildings.some(b=>b.x===x&&b.y===y&&(b.regionId||'C')===state.player.regionId);
    ctx.fillStyle = hasBuilding ? 'rgba(217,84,45,.4)' : 'rgba(217,84,45,.12)';
    ctx.fillRect(sx+2,sy+2,TILE-4,TILE-4);
    ctx.strokeStyle = '#d9542d'; ctx.lineWidth=1.5; ctx.strokeRect(sx+2,sy+2,TILE-4,TILE-4);
  } }
  ctx.restore();
}
function drawGroundItems(){
  groundItems.forEach(g=>{
    const sx=(g.x-camera.x)*TILE, sy=(g.y-camera.y)*TILE;
    if(sx>-TILE && sx<canvas.width+TILE && sy>-TILE && sy<canvas.height+TILE){
      const cx=sx+TILE/2, cy=sy+TILE/2;
      ctx.save();
      ctx.fillStyle='rgba(40,30,20,.55)'; ctx.beginPath(); ctx.arc(cx,cy+8,7,0,Math.PI*2); ctx.fill();
      ctx.font='11px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(RESOURCE_ICONS[g.resource]||'📦', cx, cy+8);
      if(g.amount>1){ ctx.font='8px sans-serif'; ctx.fillStyle='#efe6cd'; ctx.textAlign='left'; ctx.fillText(''+g.amount, cx+7, cy+2); }
      ctx.restore();
    }
  });
}
function applyCameraPan(){
  if(!keyboardCameraEnabled || cameraKeysHeld.size===0) return;
  cameraFreeMode = true;
  const speed = 0.45;
  if(cameraKeysHeld.has('up')) camera.y -= speed;
  if(cameraKeysHeld.has('down')) camera.y += speed;
  if(cameraKeysHeld.has('left')) camera.x -= speed;
  if(cameraKeysHeld.has('right')) camera.x += speed;
  camera.x = clamp(camera.x, 0, WORLD_W-VIEW_W);
  camera.y = clamp(camera.y, 0, WORLD_H-VIEW_H);
}
const cloudGradCache = {};
function getCloudGrad(size){
  if(cloudGradCache[size]) return cloudGradCache[size];
  const grad = ctx.createRadialGradient(0,0,0,0,0,size);
  grad.addColorStop(0,'rgba(0,0,0,.09)'); grad.addColorStop(1,'rgba(0,0,0,0)');
  cloudGradCache[size] = grad;
  return grad;
}
function drawCloudShadows(now){
  if(atDungeon()) return;
  const t = now/1000;
  const clouds = [
    {baseX:0.15, baseY:0.25, speed:0.007, size:95},
    {baseX:0.65, baseY:0.55, speed:0.005, size:130},
    {baseX:0.4, baseY:0.1, speed:0.009, size:75}
  ];
  clouds.forEach((c,i)=>{
    const cx = (((c.baseX + t*c.speed) % 1.5) - 0.25) * canvas.width;
    const cy = c.baseY*canvas.height + Math.sin(t*0.1+i)*18;
    ctx.save();
    ctx.translate(cx,cy);
    ctx.fillStyle = getCloudGrad(c.size);
    ctx.beginPath(); ctx.arc(0,0,c.size,0,Math.PI*2); ctx.fill();
    ctx.restore();
  });
}
function drawAmbientLeaves(now){
  if(atDungeon()) return;
  const t = now/1000;
  ctx.save();
  for(let i=0;i<6;i++){
    const seed = i*137.5;
    const px = (((seed*0.618)%1)*(canvas.width+40) + t*7) % (canvas.width+40) - 20;
    const py = (((seed*0.382)%1)*(canvas.height+40) + t*20) % (canvas.height+40) - 20;
    const sway = Math.sin(t*2+i)*8;
    ctx.save();
    ctx.translate(px+sway, py);
    ctx.rotate(t*1.4+i);
    ctx.fillStyle = i%2===0 ? 'rgba(143,201,58,.45)' : 'rgba(201,130,44,.45)';
    ctx.beginPath(); ctx.ellipse(0,0,3,1.5,0,0,Math.PI*2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}
/* Flache Bauten gehören in die Bodenschicht: sie liegen auf dem Boden auf
   und dürfen nie etwas verdecken, das aufrecht steht. Alles andere wird
   gemeinsam mit Bäumen und Felsen nach Y sortiert. */
const FLAT_BUILDINGS = ['holzboden','steinboden','marmorboden','teppich','gartenweg',
  'stockpile','schutzzone','tiergehege',
  'feld_beeren','feld_fasern','feld_gemuese','feld_kraeuter','feld_getreide'];

/* Wirft für jede Feuerstelle in Reichweite Schatten von Objekten und Bauten
   auf den Boden. Länge und Deckkraft richten sich nach Abstand und
   Dunkelheit, die Richtung zeigt vom Feuer weg. */
function zeichneFeuerschatten(startX, startY){
  const phase = dayPhaseNow();
  const staerke = lightWarmthAt(phase);
  if(staerke <= 0.05 || atDungeon()) return;
  const reg = state.player.regionId;
  const feuer = state.buildings.filter(b=>
    b.built && (b.regionId||'C')===reg && LIGHT_SOURCES[b.type]);
  if(!feuer.length) return;

  const werfer = [];
  state.buildings.forEach(b=>{
    if((b.regionId||'C')!==reg) return;
    if(FLAT_BUILDINGS.includes(b.type) || LIGHT_SOURCES[b.type]) return;
    werfer.push({x:b.x, y:b.y, hoch:1});
  });
  for(let y=-1;y<=VIEW_H+1;y++){ for(let x=-1;x<=VIEW_W+1;x++){
    const o = objAt(startX+x, startY+y);
    if(o) werfer.push({x:startX+x, y:startY+y, hoch: (o.type==='tree'?1.35:0.8)});
  } }

  ctx.save();
  werfer.forEach(t=>{
    let besteQ = null, besteDist = 1e9;
    feuer.forEach(f=>{
      const d = Math.hypot(t.x-f.x, t.y-f.y);
      if(d < besteDist && d > 0.01){ besteDist = d; besteQ = f; }
    });
    if(!besteQ) return;
    const reichweite = LIGHT_SOURCES[besteQ.type].radius / TILE;
    if(besteDist > reichweite) return;
    const nah = 1 - besteDist / reichweite;          // 1 direkt am Feuer
    const dx = (t.x - besteQ.x) / besteDist, dy = (t.y - besteQ.y) / besteDist;
    const laenge = TILE * (0.5 + besteDist * 0.22) * t.hoch;
    const sx = Math.round((t.x - camera.x)*TILE) + TILE/2;
    const sy = Math.round((t.y - camera.y)*TILE) + TILE*0.78;
    ctx.globalAlpha = clamp(nah * 0.34 * staerke, 0, 0.34);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(sx + dx*laenge*0.45, sy + dy*laenge*0.28,
                laenge*0.42, laenge*0.17,
                Math.atan2(dy*0.6, dx), 0, Math.PI*2);
    ctx.fill();
  });
  ctx.restore();
}

/* Markierungen als farbige Kachelrahmen mit Symbol. Wird zwischen Boden und
   Objekten gezeichnet, damit Bäume darüber stehen und die Markierung
   trotzdem sichtbar bleibt. */
function zeichneMarkierungen(startX, startY){
  if(atDungeon()) return;
  const reg = state.player.regionId;
  const puls = 0.62 + Math.sin(performance.now()/420)*0.16;
  ctx.save();
  for(let y=-1;y<=VIEW_H+1;y++){ for(let x=-1;x<=VIEW_W+1;x++){
    const wx=startX+x, wy=startY+y;
    const d = designationAt(wx, wy, reg);
    if(!d) continue;
    const def = DESIGNATION_ARTEN[d.art];
    const sx = Math.round((wx-camera.x)*TILE), sy = Math.round((wy-camera.y)*TILE);
    /* Helle Fläche mit Rahmen: deutlich sichtbar, aber durchscheinend
       genug, dass Baum und Boden darunter erkennbar bleiben. Solange der
       Befehl aktiv ist, leuchtet die Markierung kräftiger — danach tritt
       sie zurück und stört die Sicht nicht mehr. */
    const aktiv = (designationMode === d.art);
    ctx.globalAlpha = (aktiv ? 0.26 : 0.15) * (0.75 + puls*0.35);
    ctx.fillStyle = def.farbe;
    ctx.fillRect(sx+1, sy+1, TILE-2, TILE-2);
    ctx.globalAlpha = (aktiv ? 0.95 : 0.6) * puls;
    ctx.strokeStyle = def.farbe; ctx.lineWidth = aktiv ? 2 : 1.4;
    ctx.strokeRect(sx+1.5, sy+1.5, TILE-3, TILE-3);
    // Eckwinkel — machen die Fläche auch bei vielen Kacheln gut lesbar
    ctx.lineWidth = 2.2; ctx.globalAlpha = puls * (aktiv ? 1 : 0.7);
    const e = 6;
    ctx.beginPath();
    ctx.moveTo(sx+1.5, sy+1.5+e); ctx.lineTo(sx+1.5, sy+1.5); ctx.lineTo(sx+1.5+e, sy+1.5);
    ctx.moveTo(sx+TILE-1.5-e, sy+TILE-1.5); ctx.lineTo(sx+TILE-1.5, sy+TILE-1.5); ctx.lineTo(sx+TILE-1.5, sy+TILE-1.5-e);
    ctx.stroke();
    if(aktiv){
      ctx.globalAlpha = puls;
      ctx.font = '700 11px Nunito, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(def.icon, sx+3, sy+2);
    }
  } }
  ctx.restore();
}

/* Vorschau des aufgezogenen Rechtecks während des Ziehens. */
function zeichneMarkierungsVorschau(){
  if(!designationMode || !designationDrag.start) return;
  const a = designationDrag.start, b = designationDrag.current || a;
  const x0 = Math.min(a.x,b.x), x1 = Math.max(a.x,b.x);
  const y0 = Math.min(a.y,b.y), y1 = Math.max(a.y,b.y);
  const def = DESIGNATION_ARTEN[designationMode];
  const farbe = designationDrag.loeschen ? '#d9542d' : def.farbe;
  const sx = Math.round((x0-camera.x)*TILE), sy = Math.round((y0-camera.y)*TILE);
  const w = (x1-x0+1)*TILE, h = (y1-y0+1)*TILE;
  ctx.save();
  ctx.globalAlpha = 0.18; ctx.fillStyle = farbe; ctx.fillRect(sx, sy, w, h);
  ctx.globalAlpha = 0.9; ctx.strokeStyle = farbe; ctx.lineWidth = 2;
  ctx.setLineDash([5,4]); ctx.strokeRect(sx+1, sy+1, w-2, h-2);
  ctx.restore();
}

/* Dezenter Hinweis über dem Kopf eines NPC in Reichweite. Bewusst auf dem
   Canvas statt als HTML-Element: er gehört zur Figur und wandert mit ihr,
   statt am Bildrand zu kleben. */
function zeichneGespraechsHinweis(){
  if(atDungeon() || typeof npcInReichweite !== 'function') return;
  const nah = npcInReichweite();
  if(!nah || nah.o.type !== 'quest_npc') return;
  const sx = Math.round((nah.x - camera.x)*TILE) + TILE/2;
  const sy = Math.round((nah.y - camera.y)*TILE);
  const schweben = Math.sin(performance.now()/420) * 2;
  ctx.save();
  ctx.font = '800 11px Nunito, sans-serif';
  ctx.textBaseline = 'middle';
  const br = ctx.measureText('Sprechen').width + 34;
  const y = sy - 26 + schweben;
  ctx.fillStyle = 'rgba(14,28,20,.92)';
  ctx.strokeStyle = 'rgba(232,169,77,.85)'; ctx.lineWidth = 1.2;
  ctx.beginPath();
  if(ctx.roundRect) ctx.roundRect(sx - br/2, y - 9, br, 18, 7);
  else ctx.rect(sx - br/2, y - 9, br, 18);
  ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - 4, y + 8); ctx.lineTo(sx, y + 13); ctx.lineTo(sx + 4, y + 8);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#e8a94d';
  ctx.beginPath();
  if(ctx.roundRect) ctx.roundRect(sx - br/2 + 5, y - 6, 13, 12, 3);
  else ctx.rect(sx - br/2 + 5, y - 6, 13, 12);
  ctx.fill();
  ctx.fillStyle = '#3a2c10'; ctx.textAlign = 'center';
  ctx.fillText('E', sx - br/2 + 11.5, y);
  ctx.fillStyle = '#efe6cd'; ctx.textAlign = 'left';
  ctx.fillText('Sprechen', sx - br/2 + 22, y);
  ctx.restore();
}

/* ---------- Partikel ----------
   Reine Codegrafik, kein Bildmaterial. Die Partikel werden nicht einzeln
   gespeichert und fortgeschrieben, sondern aus Position und Zeit berechnet:
   jedes Korn hat einen festen Startpunkt im Weltraster und schwebt in einer
   Schleife. Dadurch kostet das System keinen Speicher, flackert beim
   Kamerafahren nicht und braucht keine Aufräumlogik.

   Tagsüber Staub in Lichtstrahlen, nachts kühle Glimmpartikel. */
const PARTIKEL_DICHTE = 46;

function zeichnePartikel(now, startX, startY){
  if(atDungeon()) return;
  const phase = dayPhaseNow();
  const nacht = darknessAt(phase) / NACHT_MAX;      // 0 = Tag, 1 = tiefe Nacht
  const t = now / 1000;
  ctx.save();
  for(let i = 0; i < PARTIKEL_DICHTE; i++){
    // Fester Startpunkt je Korn, an das sichtbare Feld gekoppelt
    const h = hash2(i * 37, i * 91);
    const bx = startX + (h % (VIEW_W + 2));
    const by = startY + ((h >> 6) % (VIEW_H + 2));
    const tempo = 0.25 + ((h >> 3) % 40) / 100;
    const drift = Math.sin(t * tempo + i) * 0.55;
    const steig = ((t * tempo * 0.42 + (h % 100) / 100) % 1);
    const sx = Math.round((bx - camera.x) * TILE) + TILE/2 + drift * TILE;
    const sy = Math.round((by - camera.y) * TILE) + TILE - steig * TILE * 2.6;
    if(sx < -20 || sx > canvas.width + 20 || sy < -20 || sy > canvas.height + 20) continue;

    // Am Anfang und Ende der Schleife aus- und einblenden
    const rand = Math.min(steig, 1 - steig) * 4;
    const sicht = Math.max(0, Math.min(1, rand));
    const gr = 0.7 + ((h >> 9) % 12) / 10;

    if(nacht > 0.35){
      // Nacht: kühle Glimmpunkte mit sanftem Pulsieren
      const puls = 0.55 + Math.sin(t * 1.7 + i * 0.9) * 0.45;
      ctx.globalAlpha = sicht * nacht * 0.42 * puls;
      ctx.fillStyle = '#bcd8ea';
      ctx.beginPath(); ctx.arc(sx, sy, gr, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = sicht * nacht * 0.14 * puls;
      ctx.beginPath(); ctx.arc(sx, sy, gr * 2.6, 0, Math.PI*2); ctx.fill();
    } else {
      // Tag: feiner Staub, warm angeleuchtet
      ctx.globalAlpha = sicht * (1 - nacht) * 0.20;
      ctx.fillStyle = '#f2e6c6';
      ctx.beginPath(); ctx.arc(sx, sy, gr * 0.8, 0, Math.PI*2); ctx.fill();
    }
  }
  ctx.restore();
}

function render(now){
  // Solange das Spiel nicht gestartet ist, bleibt die Welt dunkel —
  // vorher lief sie sichtbar hinter dem Erstellungsmenü weiter.
  if(gameMode === 'boot'){
    ctx.fillStyle = '#0d1a13';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    return;
  }
  const pr = currentPlayerRender();
  if(!cameraFreeMode){
    camera.x = clamp(pr.x - VIEW_W/2, 0, WORLD_W-VIEW_W);
    camera.y = clamp(pr.y - VIEW_H/2, 0, WORLD_H-VIEW_H);
  }
  ctx.clearRect(0,0,canvas.width,canvas.height);
  const startX = Math.floor(camera.x), startY = Math.floor(camera.y);
  /* Auf ganze Pixel runden. Die Kamera bewegt sich in 0,45er Schritten, der
     Versatz war deshalb ein Bruchteil eines Pixels — benachbarte Kacheln
     landeten auf z.B. 100,4 und 132,4, und der Browser hat die Kanten
     weichgezeichnet. Genau dort schimmerte der dunkle Hintergrund als feine
     Linie durch. Ganzzahlig teilen sich zwei Kacheln exakt dieselbe Kante. */
  const offX = Math.round((camera.x-startX)*TILE), offY = Math.round((camera.y-startY)*TILE);
  for(let y=-1;y<=VIEW_H+1;y++){ for(let x=-1;x<=VIEW_W+1;x++){
    const wx=startX+x, wy=startY+y;
    try{ drawTile(wx,wy, x*TILE-offX, y*TILE-offY); }
    catch(e){ try{ctx.restore();ctx.restore();ctx.restore();}catch(e2){} ctx.fillStyle='#1c3a2b'; ctx.fillRect(x*TILE-offX, y*TILE-offY, TILE, TILE); }
  } }
  drawCloudShadows(now);
  /* Tiefenstaffelung in drei Schichten.

     Vorher liefen Gebäude und Objekte in zwei getrennten Durchgängen: erst
     alle Gebäude nach Y, danach alle Bäume und Felsen. Dadurch lag ein Baum
     am oberen Bildrand immer über einem Wachturm am unteren — und flache
     Böden, Teppiche und Felder verdeckten Wände, die eigentlich davor
     stehen. Beides zusammen ließ die Perspektive kippen.

     1) flache Bauten als Bodenschicht,
     2) aufrechte Bauten UND Objekte gemeinsam nach Y sortiert,
     3) Kolonisten und Wesen darüber. */
  const sichtbareBauten = atDungeon() ? [] :
    state.buildings.filter(b=>(b.regionId||'C')===state.player.regionId);

  sichtbareBauten
    .filter(b=>FLAT_BUILDINGS.includes(b.type))
    .slice().sort((a,b)=> (a.y-b.y) || (a.x-b.x))
    .forEach(b=>{
      // Gleiche Rundung wie beim Kachelraster, sonst verrutschen Bauten um
      // bis zu einen Pixel gegen den Boden, auf dem sie stehen.
      const sx=Math.round((b.x-camera.x)*TILE), sy=Math.round((b.y-camera.y)*TILE);
      if(sx>-TILE&&sx<canvas.width+TILE&&sy>-TILE&&sy<canvas.height+TILE){
        try{ drawBuilding(b,sx,sy); }catch(e){ try{ctx.restore();ctx.restore();ctx.restore();}catch(e2){} }
      }
    });

  /* Schattenwurf der Feuerstellen: In der Dunkelheit bekommen Bäume, Felsen
     und Bauten in Reichweite einen langen Schatten, der vom Feuer wegzeigt.
     Er wird vor den Objekten gezeichnet, damit er unter ihnen liegt. */
  zeichneFeuerschatten(startX, startY);
  zeichneMarkierungen(startX, startY);
  zeichneGespraechsHinweis();

  const tiefenListe = [];
  sichtbareBauten.forEach(b=>{
    if(FLAT_BUILDINGS.includes(b.type)) return;
    tiefenListe.push({ y:b.y, x:b.x, bau:b });
  });
  for(let y=-1;y<=VIEW_H+1;y++){ for(let x=-1;x<=VIEW_W+1;x++){
    const wx=startX+x, wy=startY+y; const o = objAt(wx,wy);
    if(o) tiefenListe.push({ y:wy, x:wx, obj:o, sx:x*TILE-offX, sy:y*TILE-offY });
  } }
  /* Figuren kommen mit in dieselbe Sortierung. Vorher liefen Kolonisten,
     Wesen und Spieler in eigenen Durchgängen danach — sie standen dadurch
     immer vor jedem Gebäude, selbst wenn sie dahinter sein sollten. */
  if(atHome()){
    state.colonists.forEach(c=>{
      if((c.regionId||'C') !== state.player.regionId) return;
      tiefenListe.push({ y: c.y, x: c.x, kolonist: c });
    });
  }
  wildMonsters.forEach(w=> tiefenListe.push({ y: w.y, x: w.x, wesen: w }));
  tiefenListe.push({ y: pr.y, x: pr.x, spieler: true });

  tiefenListe.sort((a,b)=> (a.y-b.y) || (a.x-b.x));

  /* Tiefenoptik: Was weiter oben im Bild steht, ist weiter weg und tritt
     leicht zurück — geringere Deckkraft plus ein Hauch Blau, wie atmosphä-
     rische Trübung in der Ferne. Bewusst sehr dezent (höchstens 22 %) und
     ohne filter:blur(), weil Weichzeichnen pro Objekt die Bildrate
     spürbar kostet und bei 32-Pixel-Kacheln matschig aussieht. */
  const tiefeVon = (wy)=>{
    const rel = clamp((wy - camera.y) / VIEW_H, 0, 1);   // 0 = oben/fern, 1 = unten/nah
    return 1 - (1 - rel) * 0.22;
  };

  tiefenListe.forEach(e=>{
    const fern = tiefeVon(e.y);
    ctx.save();
    ctx.globalAlpha = fern;
    try{
      if(e.bau){
        const sx=Math.round((e.bau.x-camera.x)*TILE), sy=Math.round((e.bau.y-camera.y)*TILE);
        if(sx>-TILE&&sx<canvas.width+TILE&&sy>-TILE&&sy<canvas.height+TILE) drawBuilding(e.bau,sx,sy);
      } else if(e.kolonist){
        drawOneColonist(e.kolonist, now);
      } else if(e.wesen){
        drawOneWildMonster(e.wesen, now);
      } else if(e.spieler){
        drawPlayer(Math.round((pr.x-camera.x)*TILE), Math.round((pr.y-camera.y)*TILE),
                   state.player.facing, moveAnim.moving, now);
      } else {
        drawObject(e.obj, e.x, e.y, e.sx, e.sy);
      }
    }catch(err){ try{ctx.restore();ctx.restore();ctx.restore();}catch(e2){} }
    ctx.restore();
  });
  drawGroundItems();
  zeichnePartikel(now, startX, startY);
  drawBuildPreview();
  zeichneMarkierungsVorschau();
  drawDemolishPreview();
  drawWeatherOverlay(now);
  drawNightOverlay(now, pr);
  drawAmbientLeaves(now);
  drawVignette();
  updateHint(); updateRaidBanner(); updateWeatherBanner();
}
let vignetteGrad = null;
function drawVignette(){
  if(!vignetteGrad){
    vignetteGrad = ctx.createRadialGradient(canvas.width/2,canvas.height/2,canvas.height*0.32,canvas.width/2,canvas.height/2,canvas.height*0.75);
    vignetteGrad.addColorStop(0,'rgba(0,0,0,0)');
    vignetteGrad.addColorStop(1,'rgba(0,0,0,.32)');
  }
  ctx.fillStyle = vignetteGrad;
  ctx.fillRect(0,0,canvas.width,canvas.height);
}
function updateHint(){
  const hint = document.getElementById('hint');
  if(paused || buildMode.active){ hint.style.opacity=0; return; }
  if(!hoverTile){ hint.style.opacity=0; return; }
  const {x,y} = hoverTile;
  const o = objAt(x,y);
  const bp = state.buildings.find(b=>b.x===x&&b.y===y&&!b.built&&(b.regionId||'C')===state.player.regionId);
  const wm = wildMonsters.find(w=>w.x===x&&w.y===y);
  const cc = atHome() ? state.colonists.find(c=>Math.round(c.x)===x&&Math.round(c.y)===y) : null;
  const gi = groundItems.find(g=>g.x===x&&g.y===y);
  let msg = '';
  if(demolishMode) msg = 'Klicken: Gebäude hier abreißen';
  else if(cc) msg = 'Klicken: '+cc.name+' auswählen';
  else if(gi) msg = 'Klicken: '+gi.amount+' '+(RESOURCE_ICONS[gi.resource]||'')+' aufsammeln';
  else if(wm) msg = 'Klicken: Begegnung mit '+SPECIES[wm.speciesId].name;
  else if(bp) msg = 'Klicken: Bauen ('+Math.round(bp.work/bp.workReq*100)+'%)';
  else if(state.buildings.some(b=>b.x===x&&b.y===y&&b.built&&ENTERABLE_TYPES.includes(b.type)&&(b.regionId||'C')===state.player.regionId)) msg = 'Klicken: Betreten 🚪';
  else if(state.buildings.find(b=>b.x===x&&b.y===y&&b.built&&FIELD_YIELD[b.type]&&(b.regionId||'C')===state.player.regionId)){
    const fb = state.buildings.find(b=>b.x===x&&b.y===y&&b.built&&FIELD_YIELD[b.type]&&(b.regionId||'C')===state.player.regionId);
    const progress = fieldGrowthProgress(fb);
    if(progress>=1){ msg = 'Klicken: Ernten 🌾'; }
    else {
      const cfg = FIELD_YIELD[fb.type];
      const remainMs = Math.max(0, cfg.growTime - (Date.now()-(fb.plantedAt||Date.now())));
      const remainS = Math.ceil(remainMs/1000);
      msg = `⏳ Wächst noch... ${remainS}s`;
    }
  }
  else if(o && o.type==='tree') msg = 'Klicken: Baum fällen 🪵';
  else if(o && o.type==='rock') msg = 'Klicken: Stein abbauen 🪨';
  else if(o && o.type==='orevein') msg = 'Klicken: Erz abbauen ⛏️';
  else if(o && o.type==='mountain') msg = 'Klicken: Berg durchgraben ⛏️ ('+o.hp+'/'+o.maxHp+')';
  else if(o && o.type==='ruins_loot') msg = 'Klicken: Ruinen durchsuchen 🏛️';
  else if(o && o.type==='trader') msg = 'Klicken: Mit Händler handeln 🏪';
  else if(o && o.type==='dungeon_portal') msg = 'Klicken: Dungeon betreten 🕳️';
  else if(o && o.type==='cave_entrance') msg = 'Klicken: Höhle betreten ⛏️';
  else if(o && o.type==='dungeon_exit') msg = 'Klicken: Dungeon verlassen ⬆️';
  else if(o && o.type==='dungeon_chest') msg = 'Klicken: Beutetruhe öffnen 💰';
  else if(o && o.type==='visitor') msg = 'Klicken: Reden 💬';
  else if(o && o.type==='quest_npc'){
    const nd = NPC_TYPES[o.npcTyp];
    msg = 'Klicken: mit ' + (o.name||'jemandem') + ' sprechen ' + (nd ? nd.icon : '❗');
  }
  else if(tileAt(x,y)===TILE_WATER) msg = 'Klicken: Trinken 💧';
  else if(edgeDirectionAt(x,y) && neighborOf(state.player.regionId, edgeDirectionAt(x,y))){
    const nb = neighborOf(state.player.regionId, edgeDirectionAt(x,y));
    msg = 'Klicken: weiter nach '+(nb==='C'?(state.colonyName||'Heimat'):REGIONS[nb].name);
  }
  else if(passable(x,y)) msg = 'Klicken: Hingehen';
  if(msg){ hint.textContent = msg; hint.style.opacity=1; } else { hint.style.opacity=0; }
}
function updateRaidBanner(){
  const el = document.getElementById('raidBanner');
  if(state.raid){
    const secs = Math.max(0, Math.ceil((state.raid.until-Date.now())/1000));
    el.style.display='block'; el.textContent = `⚠️ Überfall! Verteidige die Kolonie — ${secs}s`;
  } else { el.style.display='none'; }
}
function updateWeatherBanner(){
  const el = document.getElementById('weatherBanner');
  if(state.weather.type==='clear'){ el.style.display='none'; return; }
  const map = {rain:'🌧️ Regen', storm:'⛈️ Sturm', cold:'❄️ Kälteeinbruch'};
  el.style.display='block'; el.textContent = map[state.weather.type]||'';
}

/* ============================================================
   Main loop
============================================================ */
let lastWildTick = 0;
let loopErrorCount = 0;
function loop(now){
  try {
    if(!paused){
      if(!moveAnim.moving){
        if(!keyboardCameraEnabled && movementKeysHeld.size>0){
          if(movementKeysHeld.has('up')) attemptKeyMove('up');
          else if(movementKeysHeld.has('down')) attemptKeyMove('down');
          else if(movementKeysHeld.has('left')) attemptKeyMove('left');
          else if(movementKeysHeld.has('right')) attemptKeyMove('right');
        } else {
          stepPlayerPath(now);
        }
      }
      finishMoveIfDone(now);
      if(now-lastWildTick>200){ updateWildMonsters(now); lastWildTick=now; }
    }
    applyCameraPan();
    render(now);
  } catch(e) {
    loopErrorCount++;
    console.error('Game loop error (frame skipped, loop continues):', e);
    if(loopErrorCount<=3){
      try{ toast('⚠️ Kleiner Ruckler — falls das Spiel jetzt hängen bleibt, bitte kurz neu laden.'); }catch(e2){}
    }
  }
  requestAnimationFrame(loop);
}

/* ============================================================
   Init
============================================================ */
async function renderTitleContinueList(){
  const wrap = document.getElementById('titleContinueList'); wrap.innerHTML = '<div class="desc">Lade Speicherstände…</div>';
  const entries = [];
  const autoMeta = await getMetaByKey('wildwood-save');
  if(autoMeta) entries.push({ label: 'Letzter Stand (automatisch)', key: 'wildwood-save', meta: autoMeta });
  for(let n=1;n<=3;n++){
    const meta = await getSlotMeta(n);
    if(meta) entries.push({ label: 'Platz '+n, key: slotKey(n), meta });
  }
  wrap.innerHTML = '';
  if(entries.length===0){
    const none = document.createElement('div'); none.className='desc'; none.textContent = 'Noch kein Spielstand vorhanden — starte einen neuen.'; wrap.appendChild(none);
    return;
  }
  entries.forEach(entry=>{
    const card = document.createElement('div'); card.className='slotCard';
    const info = document.createElement('div'); info.className='slotCardInfo';
    info.innerHTML = `<div class="slotCardName">▶️ ${entry.label} — ${entry.meta.colonyName}</div><div class="slotCardMeta">Lv.${entry.meta.lvl} · ${entry.meta.colCount} Kolonisten${entry.meta.dateStr?' · '+entry.meta.dateStr:''}</div>`;
    card.appendChild(info);
    const btns = document.createElement('div'); btns.className='slotCardBtns';
    const btn = document.createElement('button'); btn.textContent = 'Fortsetzen';
    btn.onclick = ()=> startFromSave(entry.key);
    btns.appendChild(btn);
    const delBtn = document.createElement('button'); delBtn.textContent = '🗑️'; delBtn.className='secondary'; delBtn.title = 'Spielstand löschen';
    delBtn.onclick = ()=>{
      showStoryDialog('🗑️ Spielstand löschen?', `"${entry.meta.colonyName}" (${entry.label}) wird unwiderruflich gelöscht. Fortfahren?`, [
        { label:'🗑️ Löschen', action: async ()=>{ await window.storage.delete(entry.key); await renderTitleContinueList(); } },
        { label:'Abbrechen', secondary:true, action:()=>{} }
      ]);
    };
    btns.appendChild(delBtn);
    card.appendChild(btns);
    wrap.appendChild(card);
  });
}
async function startFromSave(key){
  const hadSave = await loadGame(key);
  if(!hadSave){ toast('⚠️ Dieser Spielstand konnte nicht geladen werden.'); return; }
  worldSeedBase = worldSeed;
  buildWorld();
  homeCtx = { tileGrid, objects, respawnQueue, wildMonsters, groundItems, highlandAnchor, meadowAnchor, seed:worldSeed, biome:'wildwood', regionId:'C', huntHotspots, pathTiles };
  regionsRegistry = { C: homeCtx };
  currentBiome = 'wildwood';
  clearEdgeCorridors(homeCtx);
  if(!state.player.regionId || state.player.regionId==='DUNGEON') state.player.regionId = 'C';
  if(state.player.regionId !== 'C'){
    const ctx = getOrCreateRegion(state.player.regionId);
    swapAmbientTo(ctx);
  }
  snapMoveAnimToPlayer();
  camera.x = state.player.x - VIEW_W/2; camera.y = state.player.y - VIEW_H/2;
  updateHUD(); updateLocationLabel(); updateDayNightIndicator();
  document.getElementById('startOverlay').classList.add('hidden');
  document.title = (state.colonyName || COLONY_NAME_POOL[0]) + ' — Kolonie';
  document.getElementById('colonyTitleText').textContent = state.colonyName || COLONY_NAME_POOL[0];
  setMode('micro');
  startMusicTrack('colony');
  checkBiomeLore();
}

/* ============================================================
   Takte und Verdrahtung des Hauptmoduls
   Minikarte, Uhr, automatisches Speichern, Bedürfnisse, Wetter
   und die Steuerung im Baumodus. Wird vom Init-Block aufgerufen,
   sobald Welt und Oberfläche stehen.
============================================================ */
function startGameLoops(){
  /* Wachstumstakt der Felder, getrennt vom Bedarfstakt. 2 s sind fein genug
     für einen weichen Verlauf und grob genug, um bei vielen Feldern nichts
     zu kosten. */
  let letzterFeldTick = Date.now();
  setInterval(()=>{
    const jetzt = Date.now();
    const dt = jetzt - letzterFeldTick;
    letzterFeldTick = jetzt;
    if(paused) return;
    tickFields(dt);
  }, 2000);

  setInterval(()=>{
    if(paused) return;
    const s = state.stats;
    let hungerDrain=1, thirstDrain=1.3, energyDrain=0.6;
    if(state.weather.type==='cold'){ hungerDrain+=0.6; thirstDrain+=0.4; }
    if(isNightNow()){ energyDrain+=0.4; }
    s.hunger = clamp(s.hunger-hungerDrain, 0, 100);
    s.thirst = clamp(s.thirst-thirstDrain, 0, 100);
    s.energy = clamp(s.energy-energyDrain, 0, 100);
    if(s.hunger<=0) s.hp = clamp(s.hp-1.2,0,100);
    if(s.thirst<=0) s.hp = clamp(s.hp-1.8,0,100);
    if(s.hunger>0 && s.thirst>0 && s.hp<100 && s.hunger>50 && s.thirst>50) s.hp = clamp(s.hp+0.3,0,100);
    updateHUD(); checkGameOver(); processRespawns();
  }, 4000);
  setInterval(renderMinimap, 400);
  setInterval(()=>{
    if(paused) return;
    checkMainQuestProgress();
    checkSideQuests();
    if(Date.now()>=(state.quests.nextSideQuestAt||0) && (state.quests.side||[]).length<3){
      generateSideQuest();
      state.quests.nextSideQuestAt = Date.now() + 100000 + Math.random()*60000;
    }
  }, 5000);
  document.getElementById('minimapCanvas').style.cursor = 'pointer';
  document.getElementById('minimapCanvas').addEventListener('click', ()=>{ openWorldMap(); });
  document.getElementById('btnWorldMapUnderMap').onclick = ()=>{ openWorldMap(); };
  setInterval(saveGame, 20000);
  setInterval(()=>{
    if(atDungeon()) return;
    const now = Date.now();
    for(const [key,o] of objects){
      if(o.type==='visitor' && o.expiresAt && now>o.expiresAt){
        objects.delete(key);
        toast(`🚶 ${o.name} ist weitergezogen.`);
        logEvent(`🚶 ${o.name} hat die Kolonie wieder verlassen.`);
      }
      if(o.type==='quest_npc' && o.expiresAt && now>o.expiresAt){
        objects.delete(key);
        toast(`❗ ${o.name} ist weitergezogen.`);
        logEvent(`❗ ${o.name} hat auf dich gewartet, ist aber weitergezogen.`);
      }
    }
  }, 15000);
  setInterval(updateDayNightIndicator, 5000);
  setInterval(drawClock, 1000); // Uhr tickt sichtbar mit
  setInterval(()=>{
    if(state.dayCycleOffset==null) return;            // Spiel läuft noch nicht
    if(state.stats.hp >= 100) return;
    if(typeof encounter!=='undefined' && encounter) return;  // nicht im Kampf
    if(Date.now() - lastDamageAt < REGEN_DELAY_MS) return;   // zu kurz nach einem Treffer
    // ohne Nahrung/Wasser keine Regeneration — der Körper braucht Reserven
    if(state.stats.hunger < 20 || state.stats.thirst < 20) return;
    const inBase = state.buildings.some(b=>b.built &&
      Math.abs(b.x-state.player.x)<=6 && Math.abs(b.y-state.player.y)<=6);
    const hasBed = state.buildings.some(b=>b.type==='tent' && b.built);
    let rate = 1;                       // Grundheilung pro Tick
    if(inBase) rate += 1;               // in der Basis schneller
    if(inBase && hasBed) rate += 1;     // mit Bett noch schneller
    healPlayer(rate, true);
  }, REGEN_TICK_MS);
  canvas.addEventListener('wheel', (e)=>{
    if(!buildMode.active || !e.shiftKey) return;
    e.preventDefault();
    rotateBuildGhost(e.deltaY > 0 ? 1 : -1);
  }, {passive:false});
  document.getElementById('btnTitleNewGame').onclick = ()=>{
    // Über die Startnavigation, damit der Zurück-Knopf den Weg kennt
    zeigeStartSchritt('modeStep');
  };
}

/* Eigene Namen ebenfalls bereitstellen — über den Selbstimport statt über
   eine handgepflegte Liste. Die alte Liste war um saveGame und loadGame
   unvollständig, weshalb battle.js beim Speichern ins Leere griff. */
bridgeModule(Main);

(async function init(){
  /* Reihenfolge des Starts: erst die Zeichenfläche binden, dann die
     Oberfläche verdrahten, zuletzt die Zeitgeber starten. Diese Aufrufe
     lagen früher verstreut auf oberster Ebene der Module — dort greifen
     sie ins Leere, weil beim Laden weder Elemente noch Zustand da sind. */
  try {
    Renderer.attachCanvas('game');
  } catch(err) {
    console.error(err);
    document.body.insertAdjacentHTML('afterbegin',
      '<div style="position:fixed;inset:0;z-index:99999;background:#1a0d0d;color:#f2b8b8;'
      + 'font:14px/1.6 system-ui;padding:32px;white-space:pre-wrap;">'
      + '⚠️ Start abgebrochen\n\n' + err.message + '</div>');
    return;   // Loop gar nicht erst starten
  }

  applyRecipeDescriptions();
  initDesignationTools();
  initPauseMenu();
  buildRecipeList();   // braucht BUILDING_TYPES, das oben global gesetzt wurde
  initPlayerAppearance();
  initInput();
  initPanelHandlers();
  initScreens();
  initBattleUI();
  initPanels();

  /* Erst die Welt erzeugen, dann den Regionskontext daraus bauen —
     homeCtx greift auf tileGrid zu, das initWorld() erst füllt. */
  const w0 = initWorld();
  worldSeedBase = worldSeed;
  homeCtx = { ...w0, seed:worldSeed, biome:'wildwood', regionId:'C' };
  regionsRegistry = { C: homeCtx };
  currentBiome = 'wildwood';
  clearEdgeCorridors(homeCtx);

  /* Zeitgeber zuletzt: Sie greifen auf Welt und Spielzustand zu und
     dürfen erst laufen, wenn beides steht. */
  seedWildMonsters();
  initScreenTimers();
  initWorldMapTimers();
  startColonistLoops();
  startGameLoops();

  await renderTitleContinueList();
  requestAnimationFrame(loop);
})();
export {
  FIELD_STAGES,
  fieldStage,
  tickFields,
  NACHT_WACHSTUM,
  zeichnePartikel,
  PARTIKEL_DICHTE,
  zeichneGespraechsHinweis,
  zeichneMarkierungen,
  zeichneMarkierungsVorschau,
  zeichneFeuerschatten,
  smoothstep,
  skyTintAt,
  lightWarmthAt,
  NACHT_MAX,
  LIGHT_SOURCES,
  respawnErlaubt,
  RESPAWN_ABSTAND,
  FLAT_BUILDINGS,
  BIOME_EXCLUSIVE,
  BUILDING_TYPES,
  COOKING_RECIPES,
  FIELD_YIELD,
  MEAT_BY_TYPE,
  MEAT_TYPES,
  MODES,
  MODE_EXIT,
  PRODUCTION_RECIPES,
  REGEN_DELAY_MS,
  REGEN_TICK_MS,
  RESOURCE_ICONS,
  RESOURCE_NAMES,
  ROCK_STYLE_STONE,
  STORAGE_BASE,
  STORAGE_PER_CHEST,
  TOOL_REQUIRED,
  TOOL_TIERS,
  TOOL_TIER_ORDER,
  TOOL_TYPES,
  TREE_SHAPE_WOOD,
  WEAPON_EXTRA_COST,
  WEAPON_TIERS,
  WEAPON_TIER_ORDER,
  WEAPON_TYPES,
  addResource,
  applyCameraPan,
  bestTool,
  biomeExclusiveDrop,
  biomeStoneBonus,
  biomeWoodBonus,
  camera,
  canCraftRecipe,
  chopOrMine,
  cloudGradCache,
  craftRecipe,
  craftRecipeAll,
  craftTool,
  craftWeapon,
  damagePlayer,
  darknessAt,
  dayPhaseLabel,
  dayPhaseNow,
  drawAmbientLeaves,
  drawBuildPreview,
  drawClock,
  drawCloudShadows,
  drawDemolishPreview,
  drawGroundItems,
  drawLightHoleOn,
  drawNightOverlay,
  drawVignette,
  dropGroundItem,
  equipWeapon,
  faceToward,
  facingTile,
  fieldGrowthProgress,
  gameMode,
  gatherTechBonus,
  getCloudGrad,
  getNightLayer,
  harvestField,
  hasRecipes,
  healPlayer,
  ingameTime,
  isMode,
  isNightNow,
  lastDamageAt,
  lastToolHint,
  lastWildTick,
  loadGame,
  loop,
  loopErrorCount,
  modeStack,
  moveAnim,
  nightLayerCanvas,
  nightLayerCtx,
  ownedWeapons,
  paused,
  pickBushIfHere,
  pickGroundItemIfHere,
  popMode,
  processRespawns,
  render,
  renderMinimap,
  requireTool,
  resolveDungeonChest,
  resolveRuinsLoot,
  rollPreciousMetalBonus,
  rotateBuildGhost,
  saveGame,
  scatterStarterResources,
  setMode,
  snapMoveAnimToPlayer,
  state,
  storageCap,
  toolCondition,
  toolKey,
  toolYield,
  tryBuildBlueprint,
  tryDrink,
  updateDayNightIndicator,
  updateHint,
  updateRaidBanner,
  updateWeatherBanner,
  vignetteGrad,
  weaponAtkFor,
  weaponCost,
  weaponFitsClass,
  weaponKey,
  wearTool,
  worldRunning
};
