/* ============================================================
   entities/colonist.js — Kolonisten
   Erzeugung mit Fertigkeiten und Hintergrund, Arbeitsprioritäten
   nach RimWorld-Vorbild, Wegfindung über Breitensuche, Schlaf,
   Freizeit und soziale Bindungen.

   Reine Logik ohne Oberflächenbezug: Kolonie-Fenster, Arbeits-
   übersicht und Kommandoleiste liegen in ui/interface.js.
============================================================ */
import { clamp, genId, HAIR_SHAPES, HAIR_STYLE_COUNT, HAIR_COLORS, SKIN_COLORS, OUTFIT_COLORS, OUTFIT_STYLES, FACE_STYLES } from '../engine/rng.js';
import { WORLD_W, WORLD_H } from '../engine/world.js';
import { SPECIES } from '../data/species.js';
import { sfxBuildDone, sfxJoin, sfxVictory } from '../engine/audio.js';

/* ============================================================
   Colonist generation (skills, backstory)
============================================================ */
const NAME_POOL = ['Finn','Mira','Joran','Talia','Beorn','Sina','Ravi','Elka','Torin','Wendel','Liora','Bram'];
const COLONY_NAME_POOL = ['Farholt','Steinbach','Nebelhain','Ahornfeld','Wolfsgrund','Silberbach','Dornwald','Eschenhorst','Moosheim','Rabenstein'];

/* ---------- Adventure classes (separate from the work role) & party combat ---------- */
const ADVENTURE_CLASSES = ['Krieger','Magier','Heiler','Waldläufer'];
const ADV_CLASS_ICON = { Krieger:'⚔️', Magier:'🔮', Heiler:'💚', Waldläufer:'🏹' };
const ADV_CLASS_DESC = {
  Krieger:'Tank & Nahkampf — viel Leben, solider Schaden',
  Magier:'Elementarschaden — hoher Schaden, wenig Leben',
  Heiler:'Unterstützung — heilt die Party statt anzugreifen',
  Waldläufer:'Fernkampf & Zähmen — ausgewogen, gut im Fangen'
};
const CLASS_STARTING_GEAR = {
  Krieger: {weapon:2, armor:1, trinket:0},
  Magier: {weapon:1, armor:0, trinket:1},
  Heiler: {weapon:0, armor:2, trinket:0},
  Waldläufer: {weapon:1, armor:1, trinket:0}
};
function grantStartingGear(target, cls){
  const bonus = CLASS_STARTING_GEAR[cls];
  if(!bonus) return;
  if(!target.gear) target.gear = {weapon:0,armor:0,trinket:0};
  target.gear.weapon = (target.gear.weapon||0) + bonus.weapon;
  target.gear.armor = (target.gear.armor||0) + bonus.armor;
  target.gear.trinket = (target.gear.trinket||0) + bonus.trinket;
}
function combatStatsFor(c){
  const cls = c.advClass;
  let base = null;
  if(cls==='Krieger') base = { hp:32+c.skills.Nahkampf*2, atk:5+Math.round(c.skills.Nahkampf*0.6), def:5+Math.round(c.skills.Nahkampf*0.3), spd:5+Math.round(c.skills.Nahkampf*0.2), heal:0 };
  else if(cls==='Magier') base = { hp:18+c.skills.Handwerk, atk:6+Math.round(c.skills.Handwerk*0.7), def:1+Math.round(c.skills.Handwerk*0.15), spd:6+Math.round(c.skills.Handwerk*0.25), heal:0 };
  else if(cls==='Heiler') base = { hp:21+c.skills.Pflanzenbau, atk:3+Math.round(c.skills.Pflanzenbau*0.3), def:3+Math.round(c.skills.Pflanzenbau*0.2), spd:5+Math.round(c.skills.Pflanzenbau*0.2), heal:5+Math.round(c.skills.Pflanzenbau*0.6) };
  else if(cls==='Waldläufer'){
    const avg=(c.skills.Nahkampf+c.skills.Pflanzenbau+c.skills.Handwerk)/3;
    base = { hp:22+Math.round(avg*1.2), atk:3+Math.round(avg*0.5), def:2+Math.round(avg*0.2), spd:7+Math.round(avg*0.25), heal:0 };
  }
  if(!base) return null;
  const gear = c.gear || {weapon:0,armor:0,trinket:0};
  base.atk += gear.weapon||0;
  base.def += (gear.armor||0)+(gear.kopf||0)+(gear.oberkoerper||0)+(gear.unterkoerper||0)+(gear.schild||0);
  base.hp += (gear.trinket||0)*3;
  const lb = levelBonus(c);
  base.atk += lb.atk; base.def += lb.def; base.hp += lb.hp; base.spd += lb.spd;
  const alloc = c.allocatedStats || {hp:0,atk:0,def:0,spd:0};
  base.hp += (alloc.hp||0)*3; base.atk += alloc.atk||0; base.def += alloc.def||0; base.spd += alloc.spd||0;
  return base;
}
const PLAYER_CLASS_STATS = {
  Krieger:{ hp:46, atk:10, def:8, spd:6, heal:0 },
  Magier:{ hp:28, atk:12, def:3, spd:7, heal:0 },
  Heiler:{ hp:33, atk:7, def:5, spd:6, heal:10 },
  Waldläufer:{ hp:34, atk:8, def:4, spd:8, heal:0 }
};
function playerCombatStats(){
  const cls = state.player.advClass;
  if(!cls || !PLAYER_CLASS_STATS[cls]) return null;
  const base = Object.assign({}, PLAYER_CLASS_STATS[cls]);
  const gear = state.player.gear || {weapon:0,armor:0,trinket:0};
  base.atk += (gear.weapon||0)+(gear.trinket||0);
  base.def += (gear.armor||0)+(gear.trinket||0)+(gear.kopf||0)+(gear.oberkoerper||0)+(gear.unterkoerper||0)+(gear.schild||0);
  const lb = levelBonus(state.player);
  base.atk += lb.atk; base.def += lb.def; base.hp += lb.hp; base.spd += lb.spd;
  const alloc = state.player.allocatedStats || {hp:0,atk:0,def:0,spd:0};
  base.hp += (alloc.hp||0)*3; base.atk += alloc.atk||0; base.def += alloc.def||0; base.spd += alloc.spd||0;
  return base;
}
const EQUIPMENT_RECIPES = [
  { key:'weapon_copper', label:'🗡️ Kupferklinge', cost:{metal:2,copper:2}, bonus:{weapon:2}, requiresTech:null, slot:'weapon' },
  { key:'armor_copper', label:'🛡️ Kupferrüstung', cost:{metal:2,copper:2}, bonus:{oberkoerper:2}, requiresTech:null, slot:'oberkoerper' },
  { key:'weapon_silver', label:'⚔️ Silberklinge', cost:{metal:3,silver:3}, bonus:{weapon:4}, requiresTech:'schmiedekunst', slot:'weapon' },
  { key:'armor_silver', label:'🛡️✨ Silberrüstung', cost:{metal:3,silver:3}, bonus:{oberkoerper:4}, requiresTech:'schmiedekunst', slot:'oberkoerper' },
  { key:'trinket_gold', label:'👑 Goldamulett', cost:{metal:2,gold:2}, bonus:{weapon:2,armor:2,trinket:1}, requiresTech:'schmiedekunst', slot:'trinket' },
  { key:'legendary', label:'✨ Legendäre Klinge des Farholt', cost:{metal:4,gold:4,silver:2}, bonus:{weapon:6,armor:6,trinket:2}, requiresTech:'legende', slot:'weapon' },
  { key:'kopf_copper', label:'🪖 Kupferhelm', cost:{metal:2,copper:1}, bonus:{kopf:2}, requiresTech:null, slot:'kopf' },
  { key:'kopf_silver', label:'⛑️✨ Silberhelm', cost:{metal:3,silver:2}, bonus:{kopf:4}, requiresTech:'schmiedekunst', slot:'kopf' },
  { key:'unterkoerper_copper', label:'👖 Kupferbeinschienen', cost:{metal:2,copper:1}, bonus:{unterkoerper:2}, requiresTech:null, slot:'unterkoerper' },
  { key:'unterkoerper_silver', label:'👖✨ Silberbeinschienen', cost:{metal:3,silver:2}, bonus:{unterkoerper:4}, requiresTech:'schmiedekunst', slot:'unterkoerper' },
  { key:'schild_copper', label:'🛡️ Kupferschild', cost:{metal:3,copper:2}, bonus:{schild:3}, requiresTech:null, slot:'schild' },
  { key:'schild_silver', label:'🛡️✨ Silberschild', cost:{metal:4,silver:3}, bonus:{schild:5}, requiresTech:'schmiedekunst', slot:'schild' }
];
function partyCount(){ return state.party.length; }
function isInParty(id){ return state.party.includes(id); }
function partyMax(){ if(hasTech('elitetruppe')) return 5; if(hasTech('expedition')) return 4; return 3; }

/* ---------- Relationships: friendship, romance, marriage ---------- */
function relKey(a,b){ return [a,b].sort().join('|'); }
function getRelationship(a,b){ return state.relationships[relKey(a,b)] || {value:0}; }
function bumpRelationship(cA, cB, amount){
  const key = relKey(cA.id, cB.id);
  const rel = state.relationships[key] || {value:0};
  rel.value = clamp(rel.value+amount, 0, 100);
  state.relationships[key] = rel;
  if(rel.value>=70 && !cA.partnerId && !cB.partnerId && !cA.spouseId && !cB.spouseId){
    cA.partnerId = cB.id; cB.partnerId = cA.id;
    toast('💕 '+cA.name+' und '+cB.name+' haben sich ineinander verliebt!');
    logEvent('💕 '+cA.name+' und '+cB.name+' sind jetzt ein Paar.');
    sfxJoin();
  }
  if(rel.value>=95 && cA.partnerId===cB.id && cB.partnerId===cA.id && !cA.spouseId && !cB.spouseId){
    cA.spouseId = cB.id; cB.spouseId = cA.id; cA.partnerId = null; cB.partnerId = null;
    cA.mood = clamp(cA.mood+30,0,100); cB.mood = clamp(cB.mood+30,0,100);
    state.colonists.forEach(c=>{ c.mood = clamp(c.mood+10,0,100); });
    toast('💍 '+cA.name+' und '+cB.name+' haben geheiratet! Die Kolonie feiert.');
    logEvent('💍 Hochzeit: '+cA.name+' und '+cB.name+' haben geheiratet. Die ganze Kolonie ist beschwingt.');
    sfxVictory();
  }
}
function relationshipLabel(c){
  if(c.spouseId){ const p = state.colonists.find(x=>x.id===c.spouseId); return p ? '💍 verheiratet mit '+p.name : ''; }
  if(c.partnerId){ const p = state.colonists.find(x=>x.id===c.partnerId); return p ? '💕 liiert mit '+p.name : ''; }
  return '';
}

/* ---------- Colonist leveling (1–50) ---------- */
const LEVEL_CAP = 50;
function xpToNext(level){ return Math.round(20 + level*12); }
function levelBonus(c){
  const lvl = c.level||1;
  return { atk: Math.floor(lvl/5), def: Math.floor(lvl/5), hp: Math.floor(lvl/3)*2, spd: Math.floor(lvl/8), gather: Math.floor(lvl/10) };
}
const CLASS_MAX_MP = { Krieger:20, Magier:40, Heiler:35, Waldläufer:25 };
const CLASS_RESOURCE_NAME = { Krieger:'Wut', Magier:'Mana', Heiler:'Segen', Waldläufer:'Fokus' };
const CLASS_RESOURCE_ICON = { Krieger:'🔥', Magier:'🔷', Heiler:'✨', Waldläufer:'🎯' };
const CLASS_ABILITIES = {
  Krieger: [
    {lvl:1, name:'Hieb', kind:'single', mult:1.0, cost:0, desc:'Ein einfacher Schwerthieb.'},
    {lvl:10, name:'Wuchtschlag', kind:'single', mult:1.3, cost:4, desc:'Ein kraftvoller Hieb mit mehr Wucht.'},
    {lvl:20, name:'Wirbelschlag', kind:'aoe', mult:0.65, cost:8, desc:'Eine Drehattacke, trifft alle Gegner.'},
    {lvl:30, name:'Berserkerhieb', kind:'single', mult:1.7, cost:10, desc:'Rücksichtsloser Schlag mit hohem Schaden.'},
    {lvl:40, name:'Adrenalinstoß', kind:'single', mult:1.4, cost:12, lifesteal:0.25, desc:'Kraftvoller Hieb, der ordentlich Leben zurückgibt.'},
    {lvl:50, name:'Todesstoß', kind:'execute', mult:2.4, cost:16, desc:'Ein finaler, verheerender Stoß.'}
  ],
  Magier: [
    {lvl:1, name:'Funkenstoß', kind:'single', mult:1.0, cost:3, desc:'Ein kleiner Feuerfunke.'},
    {lvl:10, name:'Frostpfeil', kind:'single', mult:1.15, cost:5, desc:'Ein Eispfeil trifft den Gegner.'},
    {lvl:20, name:'Blitzschlag', kind:'single', mult:1.3, cost:7, desc:'Ein greller Blitz schlägt ein.'},
    {lvl:30, name:'Sturmböe', kind:'aoe', mult:0.65, cost:10, desc:'Windzauber, trifft alle Gegner.'},
    {lvl:40, name:'Feuersturm', kind:'aoe', mult:0.9, cost:13, desc:'Eine Feuerwoge über das ganze Feld.'},
    {lvl:50, name:'Urgewalt', kind:'aoe', mult:1.15, cost:18, desc:'Die volle Macht der Elemente auf einmal.'}
  ],
  Waldläufer: [
    {lvl:1, name:'Pfeilschuss', kind:'single', mult:1.0, cost:0, desc:'Ein gezielter Pfeilschuss.'},
    {lvl:1, name:'Kreaturenruf', kind:'creature', mult:1.0, cost:5, desc:'Befiehl deiner gefangenen Kreatur anzugreifen. Benötigt einen aktiven, kampffähigen Begleiter.'},
    {lvl:10, name:'Zielschuss', kind:'single', mult:1.25, cost:4, desc:'Präziser Schuss auf eine Schwachstelle.'},
    {lvl:20, name:'Mehrfachschuss', kind:'multi', mult:0.7, targets:2, cost:7, desc:'Zwei Pfeile auf zwei Ziele.'},
    {lvl:30, name:'Präzisionsschuss', kind:'single', mult:1.6, guaranteedCrit:true, cost:9, desc:'Garantierter kritischer Treffer.'},
    {lvl:40, name:'Giftpfeil', kind:'single', mult:1.4, cost:8, desc:'Ein Pfeil mit Gift getränkt.'},
    {lvl:50, name:'Sturmwind', kind:'aoe', mult:1.3, cost:14, desc:'Ein Hagel aus Pfeilen auf alle Gegner.'}
  ],
  Heiler: [
    {lvl:1, name:'Heilung', kind:'heal', healMult:1.0, cost:4, desc:'Heilt einen Verbündeten.'},
    {lvl:10, name:'Segenshauch', kind:'heal', healMult:1.25, cost:6, desc:'Stärkere Heilung für einen Verbündeten.'},
    {lvl:20, name:'Gruppenheilung', kind:'healAll', healMult:0.6, cost:10, desc:'Heilt die ganze Party etwas.'},
    {lvl:30, name:'Reinigung', kind:'heal2', healMult:1.0, cost:9, desc:'Heilt zwei Verbündete.'},
    {lvl:40, name:'Wiederbelebung', kind:'revive', healMult:0.3, cost:14, desc:'Erweckt einen gefallenen Verbündeten.'},
    {lvl:50, name:'Göttliches Licht', kind:'healAllDmgAll', healMult:0.7, mult:0.4, cost:18, desc:'Heilt alle Verbündeten und schadet allen Gegnern.'}
  ]
};
function unlockedAbilities(cls, level){ return (CLASS_ABILITIES[cls]||[]).filter(a=>a.lvl<=(level||1)); }
function hasUsableCompanion(){
  if(state.activeId==null) return false;
  const c = state.collection[state.activeId];
  return !!(c && !c.penned && c.currentHp>0);
}
function bestAbilityFor(p, livingEnemyCount){
  const companionOk = hasUsableCompanion();
  const full = unlockedAbilities(p.cls, p.level).filter(a=>a.kind!=='creature' || companionOk);
  if(full.length===0) return null;
  const mp = p.mp!=null ? p.mp : Infinity;
  const list = full.filter(a=>(a.cost||0)<=mp);
  if(list.length===0) return full[0]; // basic move (cost 0) always available as fallback
  if(p.cls==='Heiler'){
    const hasFainted = encounter.party.some(x=>x.hp<=0);
    if(hasFainted && list.some(a=>a.kind==='revive')) return list.find(a=>a.kind==='revive');
    return list[list.length-1];
  }
  if(p.cls==='Waldläufer'){
    const creatureAbility = list.find(a=>a.kind==='creature');
    if(creatureAbility) return creatureAbility;
  }
  const aoe = list.filter(a=>a.kind==='aoe');
  if(livingEnemyCount>=2 && aoe.length>0) return aoe[aoe.length-1];
  const singleLike = list.filter(a=>a.kind==='single'||a.kind==='execute'||a.kind==='multi');
  return singleLike[singleLike.length-1] || list[list.length-1];
}
function partyMemberCharacter(p){
  if(p.id==='__player__') return state.player;
  return state.colonists.find(cc=>cc.id===p.id);
}
function gainXp(c, amount){
  if(!c || (c.level||1)>=LEVEL_CAP) return;
  c.xp = (c.xp||0) + amount;
  let leveled = false, levelsGained = 0;
  while((c.level||1) < LEVEL_CAP && c.xp >= xpToNext(c.level||1)){
    c.xp -= xpToNext(c.level||1);
    c.level = (c.level||1) + 1;
    levelsGained++;
    leveled = true;
  }
  if(leveled){
    c.unspentPoints = (c.unspentPoints||0) + levelsGained*2;
    const label = c.name || 'Du';
    sfxBuildDone();
    toast('⭐ '+label+' erreicht Level '+c.level+'! +'+(levelsGained*2)+' Attributpunkte.');
    logEvent('⭐ '+label+' ist auf Level '+c.level+' aufgestiegen.');
    if(c.level>=LEVEL_CAP) c.xp = 0;
  }
}

/* ---------- Research tree ---------- */
const TECH_TREE = [
  // Stufe 1 — Grundlagen
  { key:'werkzeugkunde', name:'Werkzeugkunde', desc:'Chance auf zusätzlichen Ertrag beim Sammeln (du selbst)', cost:12, prereq:[], icon:'🛠️' },
  { key:'vorratshaltung', name:'Vorratshaltung', desc:'Lagerzonen liefern doppelt so viel passiven Nachschub', cost:12, prereq:[], icon:'📦' },
  { key:'kraeutermedizin', name:'Kräutermedizin', desc:'Krankheiten heilen 40% schneller', cost:10, prereq:[], icon:'🌿' },
  // Stufe 2 — Handwerk
  { key:'schmiedekunst', name:'Fortschrittliche Schmiedekunst', desc:'Schaltet Silber- & Gold-Ausrüstung in der Schmiede frei', cost:20, prereq:['werkzeugkunde'], icon:'⚒️' },
  { key:'belagerungsbau', name:'Belagerungsbau', desc:'Wände & Wachturm schützen deutlich besser vor Überfällen', cost:20, prereq:['vorratshaltung'], icon:'🧱' },
  { key:'faehrtenlesen', name:'Fährtenlesen', desc:'+10% Fangchance bei allen Kreaturen', cost:20, prereq:['kraeutermedizin'], icon:'🐾' },
  { key:'landwirtschaft', name:'Landwirtschaft', desc:'Bauer-Kolonisten ernten häufiger einen Bonus an Beeren & Faser', cost:18, prereq:['vorratshaltung'], icon:'🌾' },
  // Stufe 3 — Meisterschaft
  { key:'meisterhandwerk', name:'Meisterhandwerk', desc:'Geschmiedete Ausrüstung ist 50% wirkungsvoller', cost:32, prereq:['schmiedekunst'], icon:'👑' },
  { key:'bergbautechnik', name:'Bergbautechnik', desc:'Deutlich höhere Chance auf Kupfer, Silber & Gold beim Erzabbau', cost:30, prereq:['belagerungsbau'], icon:'⛏️' },
  { key:'tierbund', name:'Tierbund', desc:'Dein gezähmter Begleiter richtet 15% mehr Kampfschaden an', cost:30, prereq:['faehrtenlesen'], icon:'🐉' },
  { key:'effiziente_arbeit', name:'Effiziente Arbeit', desc:'Holzfäller & Bergmann sammeln häufiger einen Bonus-Ertrag', cost:28, prereq:['landwirtschaft'], icon:'⚙️' },
  // Stufe 4 — Expedition
  { key:'expedition', name:'Expeditionsausrüstung', desc:'Party-Obergrenze auf 4 Kolonisten (+ dich = 5 insgesamt), höhere Fluchtchance', cost:45, prereq:['bergbautechnik','tierbund'], icon:'🎒' },
  { key:'festungsbau', name:'Festungsbau', desc:'Noch stärkere Überfall-Verteidigung als Belagerungsbau', cost:42, prereq:['meisterhandwerk','effiziente_arbeit'], icon:'🏰' },
  { key:'jagdmeister', name:'Jagdmeister', desc:'Waldläufer in der Party erhalten spürbar mehr Angriffskraft', cost:38, prereq:['tierbund'], icon:'🏹' },
  // Stufe 5 — Meisterschaft der Kolonie
  { key:'elitetruppe', name:'Elitetruppe', desc:'Party-Obergrenze auf 5 Kolonisten (+ dich = 6 insgesamt), alle Party-Mitglieder +10% auf alle Kampfwerte', cost:60, prereq:['expedition'], icon:'⚔️' },
  { key:'meisterforschung', name:'Meisterforschung', desc:'Der Forschungstisch erzeugt doppelt so viele Forschungspunkte', cost:55, prereq:['festungsbau'], icon:'📖' },
  // Stufe 6 — Vermächtnis
  { key:'legende', name:'Legendäre Schmiedekunst', desc:'Schaltet ein legendäres Ausrüstungsstück in der Schmiede frei', cost:85, prereq:['elitetruppe','meisterforschung','jagdmeister'], icon:'✨' },
  { key:'erleuchtung', name:'Erleuchtung der Kolonie', desc:'Einmaliger Festakt: alle Kolonisten erhalten +20 Laune und +1 auf einen zufälligen Skill', cost:70, prereq:['legende'], icon:'🌟' }
];
function hasTech(key){ return state.research.unlocked.includes(key); }
function techAvailable(t){ return !hasTech(t.key) && t.prereq.every(p=>hasTech(p)); }
function unlockTech(t){
  if(hasTech(t.key) || state.research.points<t.cost || !t.prereq.every(p=>hasTech(p))) return false;
  state.research.points -= t.cost;
  state.research.unlocked.push(t.key);
  if(t.key==='erleuchtung'){
    const skillKeys=['Nahkampf','Pflanzenbau','Handwerk'];
    state.colonists.forEach(c=>{
      c.mood = clamp(c.mood+20,0,100);
      const sk = skillKeys[Math.floor(Math.random()*skillKeys.length)];
      c.skills[sk] = clamp(c.skills[sk]+1,1,20);
    });
    logEvent('🌟 Die ganze Kolonie feiert die Erleuchtung — alle Kolonisten wachsen daran.');
  }
  return true;
}

/* ---------- Appearance: gender, hairstyle, colors ---------- */
function randomAppearance(){
  return {
    gender: Math.random()<0.5?'m':'f',
    hairstyle: Math.floor(Math.random()*HAIR_STYLE_COUNT),
    hairColor: HAIR_COLORS[Math.floor(Math.random()*HAIR_COLORS.length)],
    outfitColor: OUTFIT_COLORS[Math.floor(Math.random()*OUTFIT_COLORS.length)],
    outfitStyle: Math.floor(Math.random()*OUTFIT_STYLES.length),
    skinColor: SKIN_COLORS[Math.floor(Math.random()*SKIN_COLORS.length)],
    faceStyle: Math.floor(Math.random()*FACE_STYLES.length)
  };
}
function drawHair(targetCtx, headCx, headCy, headR, styleIndex, color){
  const shape = HAIR_SHAPES[styleIndex % HAIR_SHAPES.length];
  const sizeMul = [0.85,1.0,1.15][Math.floor(styleIndex/HAIR_SHAPES.length) % 3];
  const r = headR * sizeMul;
  const g = targetCtx;
  const dark = shadeColor(color, -30);   // Schattenpartie
  const light = shadeColor(color, 26);   // Glanzsträhnen
  g.save(); g.translate(headCx, headCy);
  // Grundkappe mit Volumen: erst dunkle Basis, dann normale Farbe leicht versetzt
  /* Grundkappe als gewölbte Haarmasse statt flachem Bogen:
     Radialverlauf für die Schädelrundung, unregelmäßiger Haaransatz
     und ein Glanzband — davon profitieren alle Frisuren, die darauf
     aufbauen (lang, dutt, zöpfe, wellen, pferdeschwanz …). */
  const cap = (rad, yOff)=>{
    const cy2 = (yOff !== undefined ? yOff : -r*0.35);
    // Tiefenschicht dahinter
    g.fillStyle = shadeColor(dark, -12);
    g.beginPath(); g.arc(0, cy2 + r*0.06, rad*1.05, Math.PI, Math.PI*2); g.fill();
    // Hauptmasse mit welligem Haaransatz statt gerader Kante
    g.beginPath();
    g.moveTo(-rad, cy2);
    g.arc(0, cy2, rad, Math.PI, Math.PI*2);
    const waves = 5;
    for(let i=waves; i>=0; i--){
      const t = i/waves;
      const px = -rad + t*rad*2;
      const dip = r*(0.05 + Math.sin(t*Math.PI*2.2)*0.045);
      g.quadraticCurveTo(px + rad*0.06, cy2 + dip*1.5, px, cy2 + dip);
    }
    g.closePath();
    // Wölbung: Licht oben links, Tiefton am Rand
    const cg = g.createRadialGradient(-rad*0.34, cy2 - rad*0.46, rad*0.06, 0, cy2, rad*1.14);
    cg.addColorStop(0, light);
    cg.addColorStop(0.42, color);
    cg.addColorStop(1, dark);
    g.fillStyle = cg; g.fill();
    // Glanzband folgt der Rundung
    g.save(); g.globalAlpha = 0.34;
    g.strokeStyle = light; g.lineWidth = Math.max(0.8, rad*0.13); g.lineCap='round';
    g.beginPath(); g.arc(0, cy2, rad*0.72, Math.PI*1.12, Math.PI*1.62); g.stroke();
    g.restore();
  };
  // Glanzsträhnen auf der Kappe
  const strands = (rad, yOff)=>{
    g.save();
    g.beginPath(); g.arc(0,(yOff||-r*0.35), rad, Math.PI, Math.PI*2); g.clip();
    g.strokeStyle = light; g.lineWidth = Math.max(0.8, r*0.09); g.lineCap='round';
    for(let i=-2;i<=2;i++){
      g.beginPath();
      g.moveTo(i*rad*0.3 - rad*0.1, (yOff||-r*0.35) - rad*0.72);
      g.quadraticCurveTo(i*rad*0.36, (yOff||-r*0.35) - rad*0.3, i*rad*0.42, (yOff||-r*0.35) + rad*0.05);
      g.stroke();
    }
    g.restore();
  };
  // Volumen-Helfer für runde Haarmassen (Strähne mit Licht/Schatten)
  const blob = (x,y,rx,ry,rot)=>{
    g.fillStyle = dark;
    g.beginPath(); g.ellipse(x+rx*0.12, y+ry*0.1, rx, ry, rot||0, 0, Math.PI*2); g.fill();
    g.fillStyle = color;
    g.beginPath(); g.ellipse(x, y, rx*0.93, ry*0.93, rot||0, 0, Math.PI*2); g.fill();
    g.fillStyle = light;
    g.beginPath(); g.ellipse(x-rx*0.28, y-ry*0.3, rx*0.26, ry*0.34, rot||0, 0, Math.PI*2); g.fill();
  };

  if(shape==='glatze'){
    // kahl — nur ein dezenter Ansatz an den Schläfen
    g.fillStyle = dark; g.globalAlpha=0.5;
    g.beginPath(); g.arc(0,-r*0.2, r*0.98, Math.PI*1.12, Math.PI*1.32); g.lineTo(0,-r*0.2); g.fill();
    g.beginPath(); g.arc(0,-r*0.2, r*0.98, Math.PI*1.68, Math.PI*1.88); g.lineTo(0,-r*0.2); g.fill();
    g.globalAlpha=1;
  }
  else if(shape==='kurz'){ cap(r*1.02); strands(r*1.02); }
  else if(shape==='lang'){
    blob(-r*0.9, r*0.6, r*0.34, r*1.12, 0.1);
    blob( r*0.9, r*0.6, r*0.34, r*1.12,-0.1);
    cap(r*1.02); strands(r*1.02);
  }
  else if(shape==='pferdeschwanz'){
    blob(r*0.95, r*0.35, r*0.3, r*0.92, 0.5);
    cap(r*1.02); strands(r*1.02);
    g.fillStyle = dark; g.beginPath(); g.ellipse(r*0.72,-r*0.05,r*0.16,r*0.1,0.4,0,Math.PI*2); g.fill();
  }
  else if(shape==='dutt'){
    cap(r*1.02); strands(r*1.02);
    blob(0,-r*1.15, r*0.44, r*0.42, 0);
    g.strokeStyle = dark; g.lineWidth=Math.max(1,r*0.1);
    g.beginPath(); g.arc(0,-r*1.15,r*0.44,Math.PI*0.15,Math.PI*0.85); g.stroke();
  }
  else if(shape==='irokese'){
    g.fillStyle = dark;
    g.beginPath(); g.arc(0,-r*0.1,r*0.72,Math.PI,Math.PI*2); g.fill();
    g.fillStyle = color;
    g.beginPath(); g.arc(0,-r*0.12,r*0.68,Math.PI,Math.PI*2); g.fill();
    // gezackter Kamm statt glattem Dreieck
    g.fillStyle = color; g.beginPath(); g.moveTo(-r*0.16,-r*0.2);
    for(let i=0;i<4;i++){
      const t=i/3, px=-r*0.16+t*r*0.32;
      g.lineTo(px - r*0.03, -r*(1.1 + Math.sin(i*1.7)*0.35));
      g.lineTo(px + r*0.05, -r*(0.75 + Math.sin(i*1.1)*0.2));
    }
    g.lineTo(r*0.16,-r*0.2); g.closePath(); g.fill();
    g.fillStyle = light; g.beginPath(); g.moveTo(-r*0.05,-r*0.25); g.lineTo(0,-r*1.25); g.lineTo(r*0.04,-r*0.3); g.closePath(); g.fill();
  }
  else if(shape==='zöpfe'){
    [-1,1].forEach(side=>{
      for(let i=0;i<3;i++) blob(side*r*0.88, r*(0.12+i*0.32), r*0.22, r*0.21, 0);
      g.strokeStyle = dark; g.lineWidth=Math.max(0.8,r*0.07);
      for(let i=0;i<3;i++){ g.beginPath(); g.arc(side*r*0.88, r*(0.12+i*0.32), r*0.2, 0.2, Math.PI-0.2); g.stroke(); }
    });
    cap(r*1.02); strands(r*1.02);
  }
  else if(shape==='afro'){
    /* Aus vielen einzelnen Lockenbüscheln aufgebaut, nicht als Scheibe.
       Jedes Büschel hat eigene Wölbung, Schatten und Glanz — dadurch
       entsteht eine Haarmasse statt eines massiven Blocks. */
    const AR = r*1.20, ay = -r*0.16;
    // dunkle Grundmasse als Tiefe hinter den Locken
    g.beginPath();
    for(let i=0;i<=20;i++){
      const a2=(i/20)*Math.PI*2;
      const w2=1+Math.sin(i*3.1)*0.07;
      const px=Math.cos(a2)*AR*w2*0.92, py=ay+Math.sin(a2)*AR*w2*0.86;
      if(i===0) g.moveTo(px,py); else g.lineTo(px,py);
    }
    g.closePath();
    g.fillStyle = shadeColor(dark,-16); g.fill();
    // Locken in mehreren Ringen, außen kleiner
    const rings = [
      {rad:0.00, n:1,  size:0.34},
      {rad:0.42, n:7,  size:0.30},
      {rad:0.74, n:11, size:0.26},
      {rad:0.98, n:15, size:0.21}
    ];
    rings.forEach((ring,ri)=>{
      for(let i=0;i<ring.n;i++){
        const a3 = (i/ring.n)*Math.PI*2 + ri*0.62;
        const cx3 = Math.cos(a3)*AR*ring.rad;
        const cy3 = ay + Math.sin(a3)*AR*ring.rad*0.88;
        const cr = AR*ring.size;
        // jede Locke mit eigenem Verlauf -> plastische Wölbung
        const lg = g.createRadialGradient(cx3-cr*0.36, cy3-cr*0.40, cr*0.06, cx3, cy3, cr*1.05);
        lg.addColorStop(0, light);
        lg.addColorStop(0.44, color);
        lg.addColorStop(1, dark);
        g.fillStyle = lg;
        g.beginPath(); g.arc(cx3, cy3, cr, 0, Math.PI*2); g.fill();
        // Kringel innerhalb der Locke
        g.strokeStyle = 'rgba(0,0,0,.26)';
        g.lineWidth = Math.max(0.4, cr*0.16);
        g.beginPath(); g.arc(cx3, cy3, cr*0.52, a3+0.4, a3+3.0); g.stroke();
        g.strokeStyle = light; g.globalAlpha = 0.34;
        g.lineWidth = Math.max(0.3, cr*0.10);
        g.beginPath(); g.arc(cx3-cr*0.06, cy3-cr*0.06, cr*0.52, a3+0.2, a3+2.2); g.stroke();
        g.globalAlpha = 1;
      }
    });
    // Gesamtglanz oben links über die Haarmasse
    g.save(); g.globalAlpha = 0.30;
    const gl = g.createRadialGradient(-AR*0.42, ay-AR*0.46, 0, -AR*0.42, ay-AR*0.46, AR*0.68);
    gl.addColorStop(0, light); gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl;
    g.beginPath(); g.arc(-AR*0.42, ay-AR*0.46, AR*0.68, 0, Math.PI*2); g.fill();
    g.restore();
  }
  else if(shape==='pony'){
    cap(r*1.02);
    /* Einzelne Strähnen, die unterschiedlich weit über die Stirn fallen.
       Jede hat eine eigene Kontur mit weicher Spitze — keine harte Kante. */
    const strandCount = 9;
    const baseY = -r*0.34;
    for(let i=0;i<strandCount;i++){
      const t = i/(strandCount-1);
      const px = -r*0.96 + t*r*1.92;
      // Länge variiert wellenförmig, Mitte hängt tiefer
      const len = r*(0.34 + Math.sin(t*Math.PI)*0.26 + ((i%2)?0.09:0));
      const wid = r*(0.15 + Math.sin(t*Math.PI)*0.05);
      const lean = (t-0.5)*r*0.26;   // Strähnen fallen nach außen
      g.beginPath();
      g.moveTo(px - wid, baseY);
      // äußere Kante schwingt nach unten zur Spitze
      g.bezierCurveTo(px - wid*1.05, baseY + len*0.45,
                      px - wid*0.55 + lean*0.5, baseY + len*0.82,
                      px + lean, baseY + len);
      // innere Kante zurück nach oben
      g.bezierCurveTo(px + wid*0.55 + lean*0.5, baseY + len*0.82,
                      px + wid*1.05, baseY + len*0.45,
                      px + wid, baseY);
      g.closePath();
      // Verlauf entlang der Strähne
      const sg = g.createLinearGradient(px, baseY - r*0.1, px + lean, baseY + len);
      sg.addColorStop(0, light);
      sg.addColorStop(0.4, color);
      sg.addColorStop(1, shadeColor(dark, -8));
      g.fillStyle = sg; g.fill();
      g.strokeStyle = 'rgba(0,0,0,.22)';
      g.lineWidth = Math.max(0.35, r*0.028);
      g.stroke();
      // Glanzlinie auf der Strähne
      g.strokeStyle = light; g.globalAlpha = 0.42;
      g.lineWidth = Math.max(0.3, r*0.030);
      g.beginPath();
      g.moveTo(px - wid*0.25, baseY + len*0.12);
      g.quadraticCurveTo(px - wid*0.1 + lean*0.3, baseY + len*0.5, px + lean*0.8, baseY + len*0.8);
      g.stroke();
      g.globalAlpha = 1;
    }
    // weicher Übergang zur Kappe, damit kein harter Absatz entsteht
    g.save(); g.globalAlpha = 0.35;
    const bl = g.createLinearGradient(0, baseY - r*0.22, 0, baseY + r*0.18);
    bl.addColorStop(0, color); bl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = bl;
    g.fillRect(-r*1.0, baseY - r*0.22, r*2.0, r*0.40);
    g.restore();
    strands(r*1.02);
  }
  else if(shape==='lockig'){
    for(let i=-2;i<=2;i++) blob(i*r*0.42, -r*0.55+Math.abs(i)*r*0.12, r*0.42, r*0.4, 0);
    for(let i=-1;i<=1;i++) blob(i*r*0.5, -r*0.85, r*0.34, r*0.32, 0);
  }
  else if(shape==='wuschel'){
    cap(r*1.0);
    for(let i=0;i<7;i++){
      const a = Math.PI + (i/6)*Math.PI;
      blob(Math.cos(a)*r*0.85, -r*0.35+Math.sin(a)*r*0.62, r*0.3, r*0.27, 0);
    }
  }
  else if(shape==='seitenscheitel'){
    cap(r*1.02);
    // schräge, über die Stirn gelegte Partie
    g.fillStyle = color; g.beginPath();
    g.moveTo(-r*1.0,-r*0.32);
    g.quadraticCurveTo(-r*0.2,-r*0.05, r*0.95,-r*0.5);
    g.quadraticCurveTo(r*0.5,-r*1.05, -r*1.0,-r*0.32);
    g.closePath(); g.fill();
    g.strokeStyle = light; g.lineWidth=Math.max(0.8,r*0.07); g.lineCap='round';
    for(let i=0;i<4;i++){
      g.beginPath(); g.moveTo(-r*0.85+i*r*0.1,-r*0.42);
      g.quadraticCurveTo(r*0.1,-r*0.3+i*r*0.05, r*0.8,-r*0.55+i*r*0.06); g.stroke();
    }
  }
  else if(shape==='undercut'){
    // rasierte Seiten, volles Deckhaar
    g.fillStyle = dark; g.globalAlpha=0.55;
    g.beginPath(); g.arc(0,-r*0.3, r*1.02, Math.PI, Math.PI*2); g.fill();
    g.globalAlpha=1;
    g.fillStyle = color;
    g.beginPath(); g.ellipse(0,-r*0.62, r*0.82, r*0.55, 0, Math.PI, Math.PI*2); g.fill();
    g.beginPath(); g.ellipse(0,-r*0.6, r*0.82, r*0.4, 0, 0, Math.PI*2); g.fill();
    g.fillStyle = light;
    g.beginPath(); g.ellipse(-r*0.28,-r*0.78, r*0.26, r*0.16, 0.2, 0, Math.PI*2); g.fill();
  }
  else if(shape==='wellen'){
    cap(r*1.02);
    // wellige, schulterlange Partien
    [-1,1].forEach(side=>{
      g.fillStyle = dark;
      g.beginPath(); g.moveTo(side*r*0.98,-r*0.5);
      g.quadraticCurveTo(side*r*1.4, r*0.1, side*r*0.95, r*0.5);
      g.quadraticCurveTo(side*r*1.35, r*0.9, side*r*0.8, r*1.2);
      g.lineTo(side*r*0.45, r*1.0); g.quadraticCurveTo(side*r*0.7,-r*0.1, side*r*0.6,-r*0.5);
      g.closePath(); g.fill();
      g.fillStyle = color;
      g.beginPath(); g.moveTo(side*r*0.9,-r*0.5);
      g.quadraticCurveTo(side*r*1.28, r*0.1, side*r*0.85, r*0.48);
      g.quadraticCurveTo(side*r*1.22, r*0.85, side*r*0.72, r*1.12);
      g.lineTo(side*r*0.45, r*0.95); g.quadraticCurveTo(side*r*0.66,-r*0.1, side*r*0.56,-r*0.5);
      g.closePath(); g.fill();
    });
    strands(r*1.02);
  }
  else if(shape==='zopfkranz'){
    cap(r*1.02);
    // geflochtener Kranz rund um den Kopf
    for(let i=0;i<9;i++){
      const a = Math.PI + (i/8)*Math.PI;
      blob(Math.cos(a)*r*0.92, -r*0.3+Math.sin(a)*r*0.55, r*0.19, r*0.17, a);
    }
    g.strokeStyle = dark; g.lineWidth=Math.max(0.8,r*0.06);
    g.beginPath(); g.arc(0,-r*0.3, r*0.92, Math.PI, Math.PI*2); g.stroke();
  }
  else if(shape==='strubbel'){
    cap(r*1.0);
    // abstehende Strähnen in alle Richtungen
    g.strokeStyle = color; g.lineWidth=Math.max(1.2, r*0.16); g.lineCap='round';
    for(let i=0;i<9;i++){
      const a = Math.PI + (i/8)*Math.PI + 0.1;
      const bx = Math.cos(a)*r*0.85, by = -r*0.35+Math.sin(a)*r*0.7;
      g.beginPath(); g.moveTo(bx*0.75, by*0.85);
      g.lineTo(bx*1.35, by*1.3 - r*0.12);
      g.stroke();
    }
    g.strokeStyle = light; g.lineWidth=Math.max(0.7, r*0.07);
    for(let i=0;i<4;i++){
      const a = Math.PI + (i/3.5)*Math.PI + 0.25;
      g.beginPath(); g.moveTo(Math.cos(a)*r*0.6, -r*0.35+Math.sin(a)*r*0.5);
      g.lineTo(Math.cos(a)*r*1.15, -r*0.45+Math.sin(a)*r*0.95); g.stroke();
    }
  }
  g.restore();
}
// Läuft für die animierte Charaktervorschau (wird bei jedem Neuaufbau zurückgesetzt)
let apPreviewRaf = null;
/* Auswahl-Raster statt Pfeil-Zeilen: alle Optionen auf einen Blick,
   aktive Wahl deutlich markiert. */
function buildOptionGrid(items, activeIdx, onPick, opts){
  const o = opts || {};
  const wrap = document.createElement('div');
  wrap.className = 'apGrid' + (o.compact ? ' apGridCompact' : '');
  items.forEach((label, i)=>{
    const b = document.createElement('button'); b.type='button';
    b.className = 'apOpt' + (i===activeIdx ? ' active' : '');
    b.textContent = label;
    b.title = label;
    b.onclick = ()=> onPick(i);
    wrap.appendChild(b);
  });
  return wrap;
}
// Farbfelder: größer, klar markiert
function buildSwatchGrid(colors, activeCol, onPick){
  const wrap = document.createElement('div'); wrap.className='apSwatchGrid';
  colors.forEach(col=>{
    const sw = document.createElement('button'); sw.type='button';
    sw.className = 'apSwatchBig' + (activeCol===col ? ' active' : '');
    sw.style.background = col;
    sw.onclick = ()=> onPick(col);
    wrap.appendChild(sw);
  });
  return wrap;
}
function renderAppearanceEditor(container, appearance, onChange){
  container.innerHTML = '';
  if(apPreviewRaf){ cancelAnimationFrame(apPreviewRaf); apPreviewRaf = null; }
  const wrap = document.createElement('div'); wrap.className='apEditor';
  /* Die Vorschau wandert in die linke Spalte der Figurenerstellung — aber nur,
     wenn diese gerade sichtbar ist. Beim Barbier liegt #avatarStage in einem
     geschlossenen Fenster; die Vorschau landete dort im Verborgenen und der
     Charakter fehlte im Barbier-Menü. */
  const stage = (()=>{
    const st = document.getElementById('avatarStage');
    if(!st) return null;
    if(st.closest('.hidden')) return null;       // Fenster ist zu
    return st;
  })();
  const previewWrap = document.createElement('div'); previewWrap.className='apPreviewWrap';
  const preview = document.createElement('canvas'); preview.width=170; preview.height=170; preview.className='apPreview';
  previewWrap.appendChild(preview);
  // Zufalls-Button für schnellen Start
  const diceBtn = document.createElement('button'); diceBtn.className='apDice'; diceBtn.type='button';
  diceBtn.textContent='🎲 Zufall'; diceBtn.title='Zufälliges Aussehen würfeln';
  if(stage) diceBtn.style.display='none';   // links vorhanden, dort gibt es einen eigenen Knopf
  diceBtn.onclick = ()=>{
    const pick = a => a[Math.floor(Math.random()*a.length)];
    appearance.gender = Math.random()<0.5 ? 'm' : 'f';
    appearance.skinColor = pick(SKIN_COLORS);
    appearance.faceStyle = Math.floor(Math.random()*FACE_STYLES.length);
    appearance.hairstyle = Math.floor(Math.random()*HAIR_STYLE_COUNT);
    appearance.hairColor = pick(HAIR_COLORS);
    if(typeof OUTFIT_STYLES!=='undefined' && OUTFIT_STYLES.length) appearance.outfit = Math.floor(Math.random()*OUTFIT_STYLES.length);
    if(typeof OUTFIT_COLORS!=='undefined' && OUTFIT_COLORS.length) appearance.outfitColor = pick(OUTFIT_COLORS);
    renderAppearanceEditor(container, appearance, onChange); if(onChange) onChange();
  };
  previewWrap.appendChild(diceBtn);
  if(stage){ stage.innerHTML=''; stage.appendChild(previewWrap); }
  else wrap.appendChild(previewWrap);
  const pctx = preview.getContext('2d');
  // Animierte Vorschau: echter Lauf-Zyklus + langsam wechselnde Blickrichtung
  const FACINGS = ['down','right','up','left'];
  const t0 = performance.now();
  let previewStarted = false;
  const animatePreview = ()=>{
    // Abbruch nur, wenn das Canvas schon einmal im DOM war und dann entfernt wurde
    if(previewStarted && !preview.isConnected){ apPreviewRaf = null; return; }
    if(preview.isConnected) previewStarted = true;
    const t = performance.now() - t0;
    pctx.clearRect(0,0,preview.width,preview.height);
    const cycle = Math.floor(t/2400)%4;
    const eyeDir = FACINGS[cycle];
    const walking = (t % 2400) > 700;   // kurz stehen, dann laufen
    pctx.save(); pctx.translate(85, 112);
    renderAvatar(pctx, appearance, 3.0, eyeDir, null, walking, null);
    pctx.restore();
    apPreviewRaf = requestAnimationFrame(animatePreview);
  };
  // erst im nächsten Frame starten — dann ist wrap bereits an container angehängt
  apPreviewRaf = requestAnimationFrame(animatePreview);
  const controls = document.createElement('div'); controls.className='apControls';

  const genderGroup = document.createElement('div'); genderGroup.className='apGroup';
  const genderRow = document.createElement('div'); genderRow.className='apRow';
  ['m','f'].forEach(g=>{
    const b=document.createElement('button'); b.textContent = g==='m'?'♂ Männlich':'♀ Weiblich';
    if(appearance.gender!==g) b.className='secondary';
    b.onclick=()=>{ appearance.gender=g; renderAppearanceEditor(container, appearance, onChange); if(onChange) onChange(); };
    genderRow.appendChild(b);
  });
  genderGroup.appendChild(genderRow);
  controls.appendChild(genderGroup);

  const scGroup = document.createElement('div'); scGroup.className='apGroup';
  const scLbl = document.createElement('div'); scLbl.className='apGroupLabel'; scLbl.textContent='Hautfarbe'; scGroup.appendChild(scLbl);
  scGroup.appendChild(buildSwatchGrid(SKIN_COLORS, appearance.skinColor, (col)=>{
    appearance.skinColor=col; renderAppearanceEditor(container, appearance, onChange); if(onChange) onChange();
  }));
  controls.appendChild(scGroup);

  const faceGroup = document.createElement('div'); faceGroup.className='apGroup';
  const faceLbl = document.createElement('div'); faceLbl.className='apGroupLabel'; faceLbl.textContent='Gesicht'; faceGroup.appendChild(faceLbl);
  faceGroup.appendChild(buildOptionGrid(FACE_STYLES, appearance.faceStyle||0, (i)=>{
    appearance.faceStyle=i; renderAppearanceEditor(container, appearance, onChange); if(onChange) onChange();
  }));
  controls.appendChild(faceGroup);

  const hairGroup = document.createElement('div'); hairGroup.className='apGroup';
  const hairLbl = document.createElement('div'); hairLbl.className='apGroupLabel'; hairLbl.textContent='Frisur & Haarfarbe'; hairGroup.appendChild(hairLbl);
  // Schnitt aus dem Raster wählen, Länge/Größe darunter
  const curShape = appearance.hairstyle % HAIR_SHAPES.length;
  const curSize = Math.floor(appearance.hairstyle / HAIR_SHAPES.length);
  // Frisuren als gezeichnete Vorschau statt Textknöpfe
  const hairGrid = document.createElement('div'); hairGrid.className='hairGrid';
  HAIR_SHAPES.forEach((name,i)=>{
    const btn = document.createElement('button'); btn.type='button';
    btn.className = 'hairTile' + (i===curShape ? ' active' : '');
    btn.title = name;
    const cv = document.createElement('canvas'); cv.width=42; cv.height=42;
    const g = cv.getContext('2d');
    g.save(); g.translate(21, 24);
    // Kopfform als Bezug
    g.fillStyle = appearance.skinColor || '#e8c9a0';
    g.beginPath(); g.arc(0,0,10,0,Math.PI*2); g.fill();
    g.strokeStyle='#26261f'; g.lineWidth=1.1; g.stroke();
    try{ drawHair(g, 0, 0, 10, i + curSize*HAIR_SHAPES.length, appearance.hairColor); }catch(e){}
    g.restore();
    btn.appendChild(cv);
    const lb = document.createElement('span'); lb.className='hairName'; lb.textContent=name;
    btn.appendChild(lb);
    btn.onclick = ()=>{
      appearance.hairstyle = curSize*HAIR_SHAPES.length + i;
      renderAppearanceEditor(container, appearance, onChange); if(onChange) onChange();
    };
    hairGrid.appendChild(btn);
  });
  hairGroup.appendChild(hairGrid);
  const sizeLbl = document.createElement('div'); sizeLbl.className='apSubLabel'; sizeLbl.textContent='Fülle';
  hairGroup.appendChild(sizeLbl);
  hairGroup.appendChild(buildOptionGrid(['schmal','normal','voll'], curSize, (i)=>{
    appearance.hairstyle = i*HAIR_SHAPES.length + curShape;
    renderAppearanceEditor(container, appearance, onChange); if(onChange) onChange();
  }));
  hairGroup.appendChild(buildSwatchGrid(HAIR_COLORS, appearance.hairColor, (col)=>{
    appearance.hairColor=col; renderAppearanceEditor(container, appearance, onChange); if(onChange) onChange();
  }));
  controls.appendChild(hairGroup);

  const outfitGroup = document.createElement('div'); outfitGroup.className='apGroup';
  const outfitLbl = document.createElement('div'); outfitLbl.className='apGroupLabel'; outfitLbl.textContent='Kleidung & Farbe'; outfitGroup.appendChild(outfitLbl);
  outfitGroup.appendChild(buildOptionGrid(OUTFIT_STYLES, appearance.outfitStyle||0, (i)=>{
    appearance.outfitStyle=i; renderAppearanceEditor(container, appearance, onChange); if(onChange) onChange();
  }));
  outfitGroup.appendChild(buildSwatchGrid(OUTFIT_COLORS, appearance.outfitColor, (col)=>{
    appearance.outfitColor=col; renderAppearanceEditor(container, appearance, onChange); if(onChange) onChange();
  }));
  controls.appendChild(outfitGroup);

  wrap.appendChild(controls);
  container.appendChild(wrap);
}
const BACKSTORY_POOL = [
  {text:'Ehemalige Wildhüterin, kennt sich mit Pflanzen aus.', bonus:{skill:'Pflanzenbau',amount:4}},
  {text:'Deserteur aus einer fernen Garnison, geschickt im Kampf.', bonus:{skill:'Nahkampf',amount:4}},
  {text:'Wanderhandwerker, baute schon Dutzende Hütten.', bonus:{skill:'Handwerk',amount:4}},
  {text:'Verlorene Forscherin auf der Suche nach einem neuen Zuhause.', bonus:null},
  {text:'Ehemaliger Schmied, dessen Dorf niedergebrannt ist.', bonus:{skill:'Handwerk',amount:3}},
  {text:'Kräuterkundige mit einem Talent fürs Überleben.', bonus:{skill:'Pflanzenbau',amount:3}},
  {text:'Söldnerin im Ruhestand, misstraut der Stille.', bonus:{skill:'Nahkampf',amount:3}},
  {text:'Jäger, der sein Rudel verloren hat.', bonus:{skill:'Nahkampf',amount:2}},
  {text:'Bäuerin, die vor einer Dürre floh.', bonus:{skill:'Pflanzenbau',amount:2}},
  {text:'Tüftler mit einer Vorliebe für seltsame Erfindungen.', bonus:{skill:'Handwerk',amount:2}}
];
function makeColonist(usedNames){
  const avail = NAME_POOL.filter(n=>!usedNames.has(n));
  const name = avail.length ? avail[Math.floor(Math.random()*avail.length)] : ('Wanderer'+Math.floor(Math.random()*1000));
  usedNames.add(name);
  const bs = BACKSTORY_POOL[Math.floor(Math.random()*BACKSTORY_POOL.length)];
  const skills = { Nahkampf: 1+Math.floor(Math.random()*20), Pflanzenbau: 1+Math.floor(Math.random()*20), Handwerk: 1+Math.floor(Math.random()*20) };
  if(bs.bonus) skills[bs.bonus.skill] = clamp(skills[bs.bonus.skill]+bs.bonus.amount,1,20);
  const roll = Math.random();
  return { id:genId(), name, backstory:bs.text, skills, hunger:100, mood:75, sickUntil:0,
    x:spawnX, y:spawnY, state:'idle', path:[], job:null, anim:null, carrying:null, appearance: randomAppearance(), advClass:null, gear:{weapon:0,armor:0,trinket:0}, partnerId:null, spouseId:null, level:1, xp:0, unspentPoints:0, allocatedStats:{hp:0,atk:0,def:0,spd:0} };
}

/* ============================================================
   Pathfinding (BFS) + Colonist AI
============================================================ */
function findPath(sx,sy,tx,ty){
  sx=Math.round(sx); sy=Math.round(sy);
  if(sx===tx && sy===ty) return [];
  const key=(x,y)=>x+','+y;
  const visited=new Set([key(sx,sy)]);
  const queue=[{x:sx,y:sy,path:[]}];
  const dirs=[[0,-1],[0,1],[-1,0],[1,0]];
  let iterations=0;
  while(queue.length && iterations<2500){
    iterations++;
    const cur=queue.shift();
    for(const d of dirs){
      const nx=cur.x+d[0], ny=cur.y+d[1];
      if(nx<0||ny<0||nx>=WORLD_W||ny>=WORLD_H) continue;
      const k=key(nx,ny);
      if(visited.has(k)) continue;
      const isTarget = nx===tx && ny===ty;
      if(!isTarget && !passable(nx,ny)) continue;
      visited.add(k);
      const newPath=cur.path.concat([{x:nx,y:ny}]);
      if(isTarget) return newPath;
      queue.push({x:nx,y:ny,path:newPath});
    }
  }
  return null;
}
function isReservedKey(k){ return reservedTargets.has(k); }
function releaseJob(c){ if(c.job && c.job.reserveKey) reservedTargets.delete(c.job.reserveKey); c.job=null; }
function nearestObject(c, type){
  /* Markierte Kacheln zuerst: Hat der Spieler eine Fläche für diese Arbeit
     ausgewiesen, arbeiten die Kolonisten dort, statt sich das nächstbeste
     Ziel irgendwo zu suchen. Die Abfrage läuft über eine Map und kostet
     deshalb auch bei vielen Markierungen kaum etwas. */
  const artFuerTyp = Object.keys(DESIGNATION_ARTEN)
    .find(a => DESIGNATION_ARTEN[a].objekte.includes(type));
  if(artFuerTyp){
    const markiert = designationsOfKind(artFuerTyp, c.regionId || 'C', c.x, c.y);
    for(const m of markiert){
      const key = m.x + ',' + m.y;
      const o = objects.get(key);
      if(!o || o.type !== type) continue;
      if(isReservedKey(key)) continue;
      return { x:m.x, y:m.y, markiert:true };
    }
  }
  let best=null, bd=Infinity;
  objects.forEach((o,key)=>{
    if(o.type!==type) return;
    if(isReservedKey(key)) return;
    const parts = key.split(','); const x=+parts[0], y=+parts[1];
    const d = Math.hypot(x-c.x,y-c.y);
    if(d<bd){ bd=d; best={x,y}; }
  });
  return best;
}
function startJobTo(c, tx, ty, jobInfo){
  const adjCandidates = [[0,-1],[0,1],[-1,0],[1,0]].map(d=>({x:tx+d[0],y:ty+d[1]})).filter(p=>passable(p.x,p.y));
  const dest = adjCandidates.length ? adjCandidates[0] : {x:tx,y:ty};
  const path = findPath(c.x, c.y, dest.x, dest.y);
  if(!path) return false;
  const reserveKey = jobInfo.kind==='build' ? ('build_'+jobInfo.refId) : jobInfo.refKey;
  if(reserveKey && isReservedKey(reserveKey)) return false;
  if(reserveKey) reservedTargets.add(reserveKey);
  c.job = Object.assign({tx,ty,reserveKey}, jobInfo);
  c.path = path; c.state='moving'; c.anim=null;
  return true;
}
function tryAssignHaulJob(c){
  const item = groundItems.find(g=>!isReservedKey('haul_'+g.id));
  if(!item) return false;
  const path = findPath(c.x, c.y, item.x, item.y);
  if(!path) return false;
  const reserveKey = 'haul_'+item.id;
  reservedTargets.add(reserveKey);
  c.job = { kind:'haul_pickup', itemId:item.id, reserveKey };
  c.path = path; c.state='moving'; c.anim=null;
  return true;
}
/* ============================================================
   Arbeitsprioritäten (Rimworld-Stil)
   Jeder Kolonist hat pro Arbeitsart eine Priorität 0–3:
   0 = aus, 1 = höchste, 3 = niedrigste. Es wird immer die
   dringlichste verfügbare Arbeit mit der besten Priorität gewählt.
============================================================ */
const WORK_TYPES = [
  {id:'build',   label:'Bauen',     icon:'🔨'},
  {id:'chop',    label:'Holzen',    icon:'🪓'},
  {id:'mine',    label:'Bergbau',   icon:'⛏️'},
  {id:'farm',    label:'Ernten',    icon:'🌾'},
  {id:'haul',    label:'Tragen',    icon:'📦'},
  {id:'melee',   label:'Nahkampf',  icon:'⚔️', combat:true},
  {id:'ranged',  label:'Fernkampf', icon:'🏹', combat:true}
];
// Arbeitsarten, die keinen laufenden Job erzeugen, sondern die Verteidigung bestimmen
const COMBAT_WORK = WORK_TYPES.filter(w=>w.combat).map(w=>w.id);
// Standardprioritäten aus der Rolle ableiten (Rolle bleibt als Grobeinstellung erhalten)
// Startprioritäten aus den Fertigkeiten ableiten: worin jemand gut ist,
// das macht er zuerst. Ohne Fertigkeiten gibt es eine ausgewogene Vorgabe.
function defaultPriorities(colonist){
  const sk = (colonist && colonist.skills) || {};
  const nah = sk.Nahkampf||0, pfl = sk.Pflanzenbau||0, hnd = sk.Handwerk||0;
  const p = {};
  // Fertigkeit -> zugehörige Arbeitsarten
  const strength = {
    build: hnd, chop: hnd*0.6 + pfl*0.4, mine: hnd*0.5,
    farm: pfl, haul: 0, melee: nah, ranged: nah*0.8
  };
  const best = Object.keys(strength).reduce((a,b)=>strength[a]>=strength[b]?a:b);
  WORK_TYPES.forEach(w=>{
    if(w.id === best)            p[w.id] = 1;   // Stärke zuerst
    else if(w.id === 'haul')     p[w.id] = 2;   // tragen alle mit
    else if(w.id === 'ranged')   p[w.id] = nah >= 5 ? 2 : 0;
    else if(w.id === 'melee')    p[w.id] = nah >= 5 ? 2 : 3;
    else                         p[w.id] = 3;   // Rest als Lückenfüller
  });
  return p;
}
function ensurePriorities(c){
  if(!c.priorities){ c.priorities = defaultPriorities(c); }
  // fehlende Arbeitsarten ergänzen (z.B. nach einem Update)
  WORK_TYPES.forEach(w=>{ if(c.priorities[w.id]===undefined) c.priorities[w.id] = 3; });
  return c.priorities;
}
// Versucht eine bestimmte Arbeitsart zuzuweisen; liefert true bei Erfolg
function tryWork(c, workId){
  if(workId==='build'){
    const bp = state.buildings.find(b=>!b.built && !isReservedKey('build_'+b.id) && (b.regionId||'C')==='C');
    return bp ? startJobTo(c, bp.x, bp.y, {kind:'build', refId:bp.id}) : false;
  }
  if(workId==='chop'){
    const t = nearestObject(c,'tree');
    return t ? startJobTo(c,t.x,t.y,{kind:'chop', refKey:t.x+','+t.y}) : false;
  }
  if(workId==='mine'){
    const t = nearestObject(c,'rock') || nearestObject(c,'orevein') || nearestObject(c,'mountain');
    return t ? startJobTo(c,t.x,t.y,{kind:'mine', refKey:t.x+','+t.y}) : false;
  }
  if(workId==='farm'){
    const field = nearestMatureField(c);
    if(field) return startJobTo(c, field.x, field.y, {kind:'harvest_field', refId:field.id, refKey:'field_'+field.id});
    const t = nearestObject(c,'bush') || nearestObject(c,'fiberbush') || nearestObject(c,'wildgemuese');
    return t ? startJobTo(c,t.x,t.y,{kind:'harvest', refKey:t.x+','+t.y}) : false;
  }
  if(workId==='haul') return tryAssignHaulJob(c);
  return false;   // Kampfarten erzeugen keinen laufenden Job — sie greifen bei Überfällen
}

/* --- Nachtruhe: Kolonisten suchen sich ein Bett und schlafen bis zum Morgen --- */
function tryAssignSleep(c){
  if(c.sleeping) return true;
  if(c.leisure) c.leisure = null;   // Pause endet mit der Nacht
  const beds = state.buildings.filter(b=>b.type==='tent' && b.built && (b.regionId||'C')==='C');
  if(!beds.length) return false;
  // freies Bett suchen (eines pro Kolonist)
  const taken = new Set(state.colonists.filter(o=>o!==c && o.bedId).map(o=>o.bedId));
  const free = beds.filter(b=>!taken.has(b.id));
  const bed = (c.bedId && beds.find(b=>b.id===c.bedId)) || free[0];
  if(!bed) return false;
  c.bedId = bed.id;
  if(c.x===bed.x && c.y===bed.y){ c.sleeping = true; c.state='idle'; return true; }
  const path = findPath(c.x, c.y, bed.x, bed.y);
  if(!path) return false;
  if(c.job) releaseJob(c);
  c.job = {kind:'goto_bed', reserveKey:null};
  c.path = path; c.state='moving'; c.anim=null;
  return true;
}
/* --- Verteidiger ergeben sich aus den Kampfprioritäten, nicht mehr aus der Rolle --- */
// Gewichtung: Priorität 1 zählt voll, 2 zu zwei Dritteln, 3 zu einem Drittel, 0 gar nicht
function combatWeight(c, workId){
  const p = ensurePriorities(c)[workId] || 0;
  return p===0 ? 0 : (4-p)/3;
}
function meleeDefenders(){ return state.colonists.filter(c=>combatWeight(c,'melee')>0); }
function rangedDefenders(){ return state.colonists.filter(c=>combatWeight(c,'ranged')>0); }
function allDefenders(){ return state.colonists.filter(c=>combatWeight(c,'melee')>0 || combatWeight(c,'ranged')>0); }
// Gesamter Verteidigungsbonus: Nahkämpfer und Fernkämpfer, nach Fertigkeit und Priorität gewichtet
function defenseBonus(){
  return state.colonists.reduce((sum,c)=>{
    const skill = (c.skills && c.skills.Nahkampf) || 0;
    const m = combatWeight(c,'melee')  * skill * 0.006;
    const r = combatWeight(c,'ranged') * skill * 0.005;   // Fernkampf wirkt etwas schwächer, aber sicherer
    return sum + m + r;
  }, 0);
}

// Zeigt die aktuell höchste Arbeitspriorität als Symbol bzw. Text an
function topWorkOf(c){
  const p = ensurePriorities(c);
  const first = WORK_TYPES.find(w=>p[w.id]===1);
  return first || WORK_TYPES.find(w=>p[w.id]===2) || null;
}
function workIconOf(c){ const w = topWorkOf(c); return w ? w.icon : '🙂'; }
// Was tut der Kolonist gerade? (für Listen und Befehlsleiste)
function colonistActivity(c){
  if(c.sleeping) return '💤 schläft';
  if(c.leisure){
    const def = leisureInfo(c.leisure.kind);
    if(def){
      const p = c.leisure.partnerId && state.colonists.find(o=>o.id===c.leisure.partnerId);
      return def.icon+' '+def.label+(p?' mit '+p.name:'');
    }
  }
  if(c.job){
    const map = {chop:'🪓 fällt Bäume', mine:'⛏️ baut ab', harvest:'🌾 erntet',
      harvest_field:'🌾 erntet ein Feld', build:'🔨 baut', haul_pickup:'📦 holt Material',
      haul_deliver:'📦 bringt Material ins Lager', goto:'🚶 unterwegs',
      goto_bed:'🛏️ geht schlafen', goto_leisure:'🚶 macht Pause'};
    return map[c.job.kind] || '⚙️ arbeitet';
  }
  return workLabelOf(c);
}
function workLabelOf(c){ const w = topWorkOf(c); return w ? w.label : 'Vielseitig'; }

/* ============================================================
   Freizeit & soziale Interaktionen
   Kolonisten legen Pausen ein, wenn keine Arbeit anliegt oder
   die Laune sinkt. Sie treffen sich am Lagerfeuer, spielen
   Schach, essen gemeinsam oder unterhalten sich zu zweit.
============================================================ */
/* --- Gekapselt: 3 Bezeichner nach außen, 4 bleiben intern.
   Statt der ganzen Tabelle geht nur eine schmale Abfrage nach außen —
   die Balancing-Werte (Laune, Dauer) bleiben im Block. --- */
const LEISURE_KINDS = {
  chess:    {label:'spielt Schach',        icon:'♟️', mood:9,  dur:14000, social:true,  needs:'table'},
  campfire: {label:'sitzt am Feuer',       icon:'🔥', mood:7,  dur:12000, social:true,  needs:'campfire'},
  meal:     {label:'isst gemeinsam',       icon:'🍲', mood:6,  dur:9000,  social:true,  needs:'table'},
  chat:     {label:'unterhält sich',       icon:'💬', mood:5,  dur:7000,  social:true,  needs:null},
  stroll:   {label:'macht einen Spaziergang', icon:'🚶', mood:3, dur:9000, social:false, needs:null},
  stargaze: {label:'schaut in den Himmel', icon:'✨', mood:4,  dur:8000,  social:false, needs:null}
};
// Findet ein passendes Möbel/Gebäude in der Kolonie
function findLeisureSpot(c, needs){
  if(!needs) return null;
  const typeMap = { campfire:['campfire'], table:['tisch','table','campfire'] };
  const types = typeMap[needs] || [needs];
  const cands = state.buildings.filter(b=>b.built && types.includes(b.type) && (b.regionId||'C')==='C');
  if(!cands.length) return null;
  cands.sort((a,b)=>(Math.abs(a.x-c.x)+Math.abs(a.y-c.y)) - (Math.abs(b.x-c.x)+Math.abs(b.y-c.y)));
  return cands[0];
}
// Sucht einen Kolonisten in der Nähe, der auch gerade frei ist
function findLeisurePartner(c){
  return state.colonists.find(o =>
    o !== c && !o.sleeping && !o.job && !o.leisure &&
    Math.abs(o.x-c.x) <= 6 && Math.abs(o.y-c.y) <= 6);
}
// Entscheidet, ob und welche Pause gemacht wird
function tryStartLeisure(c){
  if(c.leisure || c.sleeping || c.job) return false;
  // Bei sehr niedriger Laune dringend, sonst nur gelegentlich
  const urgent = (c.mood||70) < 45;
  if(!urgent && Math.random() > 0.35) return false;
  const now = Date.now();
  if(c.leisureCooldown && now < c.leisureCooldown) return false;
  // Passende Aktivitäten sammeln (nur die, deren Voraussetzung erfüllt ist)
  const options = [];
  Object.keys(LEISURE_KINDS).forEach(k=>{
    const def = LEISURE_KINDS[k];
    if(def.needs){
      const spot = findLeisureSpot(c, def.needs);
      if(!spot) return;
      options.push({kind:k, def, spot});
    } else {
      if(k==='stargaze' && !isNightNow()) return;   // Sterne nur nachts
      options.push({kind:k, def, spot:null});
    }
  });
  if(!options.length) return false;
  const pick = options[Math.floor(Math.random()*options.length)];
  // Gesellige Aktivitäten brauchen einen Partner
  let partner = null;
  if(pick.def.social){
    partner = findLeisurePartner(c);
    if(!partner && (pick.kind==='chess' || pick.kind==='meal')) return false;  // allein sinnlos
  }
  const target = pick.spot ? {x:pick.spot.x, y:pick.spot.y}
                           : {x:c.x + Math.floor(Math.random()*7)-3, y:c.y + Math.floor(Math.random()*7)-3};
  const startLeisure = (person, tx, ty, withWhom)=>{
    person.leisure = { kind:pick.kind, until: now + pick.def.dur, partnerId: withWhom ? withWhom.id : null };
    if(person.x!==tx || person.y!==ty){
      const path = findPath(person.x, person.y, tx, ty);
      if(path){ person.job = {kind:'goto_leisure', reserveKey:null}; person.path = path; person.state='moving'; person.anim=null; }
    }
  };
  startLeisure(c, target.x, target.y, partner);
  if(partner){
    // Partner setzt sich daneben
    const px = target.x + (Math.random()<0.5 ? 1 : -1), py = target.y;
    startLeisure(partner, passable(px,py) ? px : target.x, py, c);
    if(Math.random() < 0.5) logSocial(c, partner, pick.kind);
  }
  return true;
}
// Kurze Meldungen über soziale Begegnungen
const SOCIAL_LINES = [
  '{a} und {b} lachen über eine alte Geschichte.',
  '{a} erzählt {b} vom Wildholz jenseits der Hügel.',
  '{a} und {b} tauschen Neuigkeiten aus.',
  '{a} zeigt {b} einen Fund vom Wegesrand.',
  '{a} und {b} streiten freundschaftlich über den besten Bauplatz.',
  '{a} teilt eine Ration mit {b}.'
];
function logSocial(a, b, kind){
  const def = LEISURE_KINDS[kind];
  const line = SOCIAL_LINES[Math.floor(Math.random()*SOCIAL_LINES.length)]
    .replace('{a}', a.name).replace('{b}', b.name);
  logEvent(`${def.icon} ${line}`);
}
// Läuft jede Runde: beendet abgelaufene Pausen und hebt die Laune
function tickLeisure(c){
  if(!c.leisure) return false;
  if(Date.now() < c.leisure.until) return true;   // noch beschäftigt
  const def = LEISURE_KINDS[c.leisure.kind];
  const bonus = def ? def.mood : 4;
  c.mood = clamp((c.mood||70) + bonus, 0, 100);
  // gemeinsame Aktivitäten stärken die Bindung
  if(c.leisure.partnerId){
    const p = state.colonists.find(o=>o.id===c.leisure.partnerId);
    if(p){
      c.bonds = c.bonds || {};
      c.bonds[p.id] = (c.bonds[p.id]||0) + 1;
      p.bonds = p.bonds || {};
      p.bonds[c.id] = (p.bonds[c.id]||0) + 1;
    }
  }
  c.leisure = null;
  c.leisureCooldown = Date.now() + 45000;   // nicht sofort wieder pausieren
  c.state = 'idle';
  return false;
}

// Nur Symbol und Beschriftung nach außen, keine Balancing-Werte
function leisureInfo(kind){
  const d = LEISURE_KINDS[kind];
  return d ? {icon:d.icon, label:d.label} : null;
};

function assignJob(c){
  // Nachts erst schlafen gehen, wenn ein Bett da ist
  if(isNightNow() && tryAssignSleep(c)) return;
  const prio = ensurePriorities(c);
  // Arbeitsarten nach Priorität sortieren (1 = zuerst), 0 wird übersprungen
  const order = WORK_TYPES
    .filter(w => prio[w.id] > 0 && !w.combat)
    .sort((a,b) => prio[a.id] - prio[b.id]);
  for(const w of order){
    if(tryWork(c, w.id)) return;
  }
}
function nearestMatureField(c){
  let best=null, bestD=Infinity;
  state.buildings.forEach(b=>{
    if(!b.built || !FIELD_YIELD[b.type]) return;
    if(fieldGrowthProgress(b)<1) return;
    if(isReservedKey('field_'+b.id)) return;
    const d = Math.abs(b.x-c.x)+Math.abs(b.y-c.y);
    if(d<bestD){ bestD=d; best=b; }
  });
  return best;
}
function moodMultiplier(c){ return clamp(0.6 + (c.mood/100)*0.6, 0.6, 1.2); }
function stepColonistMovement(c, now){
  if(c.anim && c.anim.moving){
    const t = clamp((now-c.anim.start)/c.anim.dur,0,1);
    if(t<1) return;
    c.x=c.anim.toX; c.y=c.anim.toY; c.anim.moving=false;
  }
  if(c.path.length===0){
    if(c.job && c.job.kind==='goto'){ releaseJob(c); c.state='idle'; return; }
    if(c.job && c.job.kind==='goto_bed'){ releaseJob(c); c.sleeping = true; c.state='idle'; return; }
    if(c.job && c.job.kind==='goto_leisure'){ releaseJob(c); c.state='idle'; return; }
    c.state='working'; return;
  }
  if(c.carrying && c.job && c.job.kind==='haul_deliver'){ /* keep carrying visible while en route */ }
  const next=c.path.shift();
  if(!passable(next.x,next.y)){ releaseJob(c); c.state='idle'; c.path=[]; return; }
  const stormy = state.weather.type==='storm';
  // Dauer entspricht der tatsächlichen Schrittzeit — dadurch geht eine
  // Bewegung nahtlos in die nächste über, ohne Pause dazwischen.
  c.anim={moving:true, fromX:c.x, fromY:c.y, toX:next.x, toY:next.y, start:now, dur: stormy?600:400};
}
function performWork(c){
  const job=c.job; if(!job){ c.state='idle'; return; }
  if(state.weather.type==='storm' && Math.random()<0.4) return;
  const mult = moodMultiplier(c) * (isNightNow() ? 0.85 : 1);
  if(job.kind==='chop'){
    const o=objAt(job.tx,job.ty);
    if(!o || o.type!=='tree'){ releaseJob(c); c.state='idle'; return; }
    if(!bestTool('chop')){ releaseJob(c); c.state='idle'; return; }
    // Grundertrag 2 wie beim Spieler — sonst lohnt Handarbeit mehr als
    // eine ganze Kolonie, und der Ausbau fühlt sich wie ein Rückschritt an.
    o.hp -= 1; let amt = Math.max(1, Math.round(2*mult)) + toolYield('chop');
    wearTool('chop');
    if(hasTech('effiziente_arbeit') && Math.random()<0.3) amt += 1;
    amt += levelBonus(c).gather;
    dropGroundItem(job.tx, job.ty, 'wood', amt);
    if(Math.random()<0.4){
      const wKey = TREE_SHAPE_WOOD[(BIOME_TREE_STYLE[currentBiome]||{}).shape];
      if(wKey) dropGroundItem(job.tx, job.ty, wKey, 1);
    }
    if(o.hp<=0){ objects.delete(job.tx+','+job.ty); respawnQueue.push({x:job.tx,y:job.ty,type:'tree',at:Date.now()+220000}); releaseJob(c); c.state='idle'; gainXp(c,3); }
  } else if(job.kind==='mine'){
    const o=objAt(job.tx,job.ty);
    if(!o){ releaseJob(c); c.state='idle'; return; }
    if(!bestTool('mine')){ releaseJob(c); c.state='idle'; return; }
    o.hp -= 1; let amt = Math.max(1, Math.round((o.type==='mountain'?3:2)*mult)) + toolYield('mine');
    wearTool('mine');
    if(hasTech('effiziente_arbeit') && Math.random()<0.3) amt += 1;
    amt += levelBonus(c).gather;
    dropGroundItem(job.tx, job.ty, (o.type==='rock' || o.type==='mountain') ? 'stone' : 'ore', amt);
    if(o.type==='rock' && Math.random()<0.4){
      const sKey = ROCK_STYLE_STONE[BIOME_ROCK_STYLE[currentBiome]];
      if(sKey) dropGroundItem(job.tx, job.ty, sKey, 1);
    }
    if(o.type==='orevein' || o.type==='mountain'){
      const bt = hasTech('bergbautechnik');
      const r = Math.random();
      if(r<(bt?0.02:0.008)) dropGroundItem(job.tx, job.ty, 'erz_titan', 1);
      else if(r<(bt?0.07:0.028)) dropGroundItem(job.tx, job.ty, 'gold', 1);
      else if(r<(bt?0.22:0.12)) dropGroundItem(job.tx, job.ty, 'silver', 1);
      else if(r<(bt?0.57:0.37)) dropGroundItem(job.tx, job.ty, 'copper', 1);
    }
    if(o.hp<=0){
      objects.delete(job.tx+','+job.ty);
      if(o.type==='mountain'){
        logEvent('⛏️ '+c.name+' hat einen Tunnel durch den Berg geschlagen.');
        if(Math.random()<0.25) objects.set(job.tx+','+job.ty, {type:'orevein', hp:4, maxHp:4});
      } else {
        respawnQueue.push({x:job.tx,y:job.ty,type:o.type,at:Date.now()+(o.type==='orevein'?300000:250000)});
      }
      releaseJob(c); c.state='idle'; gainXp(c,o.type==='mountain'?6:4);
    }
  } else if(job.kind==='harvest'){
    const o=objAt(job.tx,job.ty);
    if(!o){ releaseJob(c); c.state='idle'; return; }
    let bonus = Math.random() < c.skills.Pflanzenbau/24 ? 1 : 0;
    if(hasTech('landwirtschaft') && Math.random()<0.35) bonus += 1;
    const dropType = o.type==='bush' ? 'berries' : (o.type==='wildgemuese' ? 'gemuese' : 'fiber');
    dropGroundItem(job.tx, job.ty, dropType, 2+bonus);
    objects.delete(job.tx+','+job.ty);
    respawnQueue.push({x:job.tx,y:job.ty,type:o.type,at:Date.now()+(o.type==='bush'?120000:(o.type==='wildgemuese'?130000:135000))});
    releaseJob(c); c.state='idle'; gainXp(c,2);
  } else if(job.kind==='harvest_field'){
    const b = state.buildings.find(bb=>bb.id===job.refId);
    if(!b || !b.built || fieldGrowthProgress(b)<1){ releaseJob(c); c.state='idle'; return; }
    const cfg = FIELD_YIELD[b.type];
    if(cfg){
      dropGroundItem(job.tx, job.ty, cfg.res, cfg.amt);
      b.plantedAt = Date.now();
    }
    releaseJob(c); c.state='idle'; gainXp(c,3);
  } else if(job.kind==='build'){
    const b = state.buildings.find(bb=>bb.id===job.refId);
    if(!b || b.built){ releaseJob(c); c.state='idle'; return; }
    b.work = clamp(b.work + (5 + c.skills.Handwerk*0.7)*mult, 0, b.workReq);
    if(b.work>=b.workReq){
      b.built = true;
      if(FIELD_YIELD[b.type]) b.plantedAt = Date.now();
      onBuildingFinished(b);
      sfxBuildDone();
      toast((BUILDING_TYPES[b.type].name)+' von '+c.name+' fertiggestellt!');
      logEvent(c.name+' hat '+(BUILDING_TYPES[b.type].name)+' fertiggestellt.');
      releaseJob(c); c.state='idle'; gainXp(c,8);
    }
  } else if(job.kind==='haul_pickup'){
    const item = groundItems.find(g=>g.id===job.itemId);
    if(!item){ releaseJob(c); c.state='idle'; return; }
    c.carrying = { resource:item.resource, amount:item.amount };
    groundItems = groundItems.filter(g=>g.id!==item.id);
    releaseJob(c);
    // Lagerkiste bevorzugen, sonst Lagerzone, sonst Koloniemitte
    const chest = state.buildings.find(b=>b.type==='lagerkiste' && b.built);
    const stock = chest || state.buildings.find(b=>b.type==='stockpile' && b.built);
    const dest = stock ? {x:stock.x,y:stock.y} : (state.colonyCenter || {x:c.x,y:c.y});
    const path2 = findPath(c.x, c.y, dest.x, dest.y);
    if(path2 && path2.length>0){ c.job = {kind:'haul_deliver', reserveKey:null}; c.path=path2; c.state='moving'; }
    else {
      state.inventory[c.carrying.resource] = (state.inventory[c.carrying.resource]||0)+c.carrying.amount;
      bumpResource(c.carrying.resource); c.carrying=null; c.state='idle';
    }
  } else if(job.kind==='haul_deliver'){
    if(c.carrying){
      state.inventory[c.carrying.resource] = (state.inventory[c.carrying.resource]||0)+c.carrying.amount;
      bumpResource(c.carrying.resource);
      toast(c.name+' liefert '+c.carrying.amount+' '+(RESOURCE_NAMES[c.carrying.resource]||c.carrying.resource)+' ins Lager.');
      c.carrying = null;
    }
    releaseJob(c); c.state='idle';
  }
  updateHUD();
}
function updateColonistAI(now){
  const night = isNightNow();
  state.colonists.forEach(c=>{
    if(c.sickUntil && Date.now()<c.sickUntil) return;
    // Schlafende wachen bei Tagesanbruch auf und erholen sich über Nacht
    if(c.sleeping){
      if(!night){
        c.sleeping = false;
        c.mood = clamp((c.mood||60)+12, 0, 100);
        if(c.maxHp) c.hp = c.maxHp;
        c.state = 'idle';
      }
      return;
    }
    // Laufende Pause abwickeln
    if(tickLeisure(c)) return;
    if(c.state==='idle'){
      assignJob(c);
      // Keine Arbeit gefunden? Dann Freizeit — das belebt die Kolonie
      if(!c.job && !c.leisure && !night) tryStartLeisure(c);
    }
    else if(c.state==='moving') stepColonistMovement(c, now);
    else if(c.state==='working') performWork(c);
  });
}
/* Bewegung getrennt und deutlich häufiger takten: Vorher lief die Animation
   240ms und der nächste Schritt kam erst nach 450ms — daraus entstand das
   ruckartige Stehenbleiben zwischen den Feldern. */

/* ---------- colonist needs (hunger / mood) ---------- */

/* ---------- story / event system ---------- */
/* ============================================================
   Takte der Kolonisten
   Arbeits-KI, Bewegung, Bedürfnisse und Freizeit. Wird von main.js
   gestartet, sobald Welt und Spielzustand stehen.
============================================================ */
function startColonistLoops(){
  setInterval(()=>{
    if(paused || !atHome()) return;
    const list = state.colonists;
    for(let i=0;i<list.length;i++){
      for(let j=i+1;j<list.length;j++){
        const cA=list[i], cB=list[j];
        const dist = Math.hypot(cA.x-cB.x, cA.y-cB.y);
        const close = dist < 3;
        const chance = close ? 0.3 : 0.07;
        if(Math.random() < chance){
          const amount = 1 + (close?1:0);
          bumpRelationship(cA, cB, amount);
        }
      }
      if(list[i].spouseId){ list[i].mood = clamp(list[i].mood+0.6,0,100); }
      else if(list[i].partnerId){ list[i].mood = clamp(list[i].mood+0.3,0,100); }
    }
    if(list.length>0 && state.buildings.some(b=>b.type==='bibliothek' && b.built) && Math.random()<0.4){
      gainXp(list[Math.floor(Math.random()*list.length)], 2);
    }
    saveGame();
  }, 25000);
  setInterval(()=>{
    const tables = state.buildings.filter(b=>b.type==='research' && b.built).length;
    if(tables>0){ state.research.points += tables * (hasTech('meisterforschung')?2:1); updateResearchIfOpen(); saveGame(); }
  }, 20000);
  setInterval(()=>{ if(!paused && atHome()) updateColonistAI(performance.now()); }, 450);
  setInterval(()=>{
    if(paused || !atHome()) return;
    const now = performance.now();
    state.colonists.forEach(c=>{
      if(c.state==='moving' && !c.sleeping) stepColonistMovement(c, now);
    });
  }, 55);
  setInterval(()=>{
    if(paused) return;
    let changed=false;
    const homeB = state.buildings.filter(b=>(b.regionId||'C')==='C');
    const pantryMult = homeB.some(b=>b.type==='vorratskammer' && b.built) ? 0.8 : 1;
    const recCount = homeB.filter(b=>RECREATION_TYPES.includes(b.type) && b.built).length;
    const decorCount = homeB.filter(b=>DECOR_TYPES.includes(b.type) && b.built).length;
    const ambientMood = Math.min(recCount*0.25 + decorCount*0.08, 2.5);
    state.colonists.forEach(c=>{
      c.hunger = clamp(c.hunger-2*pantryMult, 0, 100);
      if(c.hunger<50 && state.inventory.berries>0){ state.inventory.berries-=1; c.hunger=clamp(c.hunger+20,0,100); changed=true; bumpResource('berries'); }
      if(c.hunger<30) c.mood = clamp(c.mood-1.2,0,100);
      else if(c.hunger>60) c.mood = clamp(c.mood+0.4,0,100);
      if(c.sickUntil && Date.now()<c.sickUntil) c.mood = clamp(c.mood-0.6,0,100);
      if(state.weather.type==='cold') c.hunger = clamp(c.hunger-1,0,100);
      if(ambientMood>0) c.mood = clamp(c.mood+ambientMood*0.15,0,100);
    });
    if(homeB.some(b=>b.type==='stockpile' && b.built)){
      const keys=['wood','stone','berries']; const k=keys[Math.floor(Math.random()*keys.length)];
      let amt = hasTech('vorratshaltung') ? 2 : 1;
      const artisanCount = homeB.filter(b=>(b.type==='toepferei'||b.type==='gerberei') && b.built).length;
      amt += artisanCount;
      addResource(k, amt); bumpResource(k); changed=true;
    }
    if(homeB.some(b=>b.type==='alchemielabor' && b.built) && state.inventory.kraeuter>=2 && Math.random()<0.15){
      state.inventory.kraeuter-=2; state.inventory.potion=(state.inventory.potion||0)+1; bumpResource('potion'); changed=true;
    }
    if(changed){ updateHUD(); updateColonyIfOpen(); saveGame(); }
  }, 6000);
  setInterval(()=>{
    if(paused || !atHome()) return;
    let changed = false;
    const penTiles = state.buildings.filter(b=>b.type==='tiergehege' && b.built).length;
    if(penTiles>0){
      Object.keys(state.collection).map(Number).filter(id=>state.collection[id].penned).forEach(id=>{
        if(state.inventory.berries>=1){
          state.inventory.berries -= 1; bumpResource('berries');
          const sp = SPECIES[id];
          const key = MEAT_BY_TYPE[sp.type] || 'meat_normal';
          addResource(key, 1);
          bumpResource(key);
          changed = true;
        }
      });
    }
    if(changed){ updateHUD(); updateColonyIfOpen(); saveGame(); }
  }, 18000);
}

export {
  startColonistLoops,
  ADVENTURE_CLASSES,
  ADV_CLASS_DESC,
  ADV_CLASS_ICON,
  BACKSTORY_POOL,
  CLASS_ABILITIES,
  CLASS_MAX_MP,
  CLASS_RESOURCE_ICON,
  CLASS_RESOURCE_NAME,
  CLASS_STARTING_GEAR,
  COLONY_NAME_POOL,
  COMBAT_WORK,
  EQUIPMENT_RECIPES,
  LEISURE_KINDS,
  LEVEL_CAP,
  NAME_POOL,
  PLAYER_CLASS_STATS,
  SOCIAL_LINES,
  TECH_TREE,
  WORK_TYPES,
  allDefenders,
  apPreviewRaf,
  assignJob,
  bestAbilityFor,
  buildOptionGrid,
  buildSwatchGrid,
  bumpRelationship,
  colonistActivity,
  combatStatsFor,
  combatWeight,
  defaultPriorities,
  defenseBonus,
  drawHair,
  ensurePriorities,
  findLeisurePartner,
  findLeisureSpot,
  findPath,
  gainXp,
  getRelationship,
  grantStartingGear,
  hasTech,
  hasUsableCompanion,
  isInParty,
  isReservedKey,
  leisureInfo,
  levelBonus,
  logSocial,
  makeColonist,
  meleeDefenders,
  moodMultiplier,
  nearestMatureField,
  nearestObject,
  partyCount,
  partyMax,
  partyMemberCharacter,
  performWork,
  playerCombatStats,
  randomAppearance,
  rangedDefenders,
  relKey,
  relationshipLabel,
  releaseJob,
  renderAppearanceEditor,
  startJobTo,
  stepColonistMovement,
  techAvailable,
  tickLeisure,
  topWorkOf,
  tryAssignHaulJob,
  tryAssignSleep,
  tryStartLeisure,
  tryWork,
  unlockTech,
  unlockedAbilities,
  updateColonistAI,
  workIconOf,
  workLabelOf,
  xpToNext
};
