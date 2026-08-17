/* ============================================================
   engine/world.js — Welt
   Weltgenerierung und Weltstruktur: Geländeraster mit Küsten-
   linien, Biome, das Regionsraster der Overworld, prozedurale
   Dungeons und Dörfer.

   Darstellung und Steuerung liegen nicht hier — die Makro-Karte
   und die Weltkarten-Oberfläche gehören zu ui/interface.js.
============================================================ */
import { mulberry32, hash2, clamp, genId } from './rng.js';
import { SPECIES } from '../data/species.js';


import { sfxEvent, startMusicTrack } from './audio.js';
/* ============================================================
   World generation (with resource biomes)
============================================================ */
const TILE = 32, VIEW_W = 25, VIEW_H = 15;
const WORLD_W = 100, WORLD_H = 70;
let worldSeed = Math.floor(Math.random()*100000);
let worldSeedBase = worldSeed;
let homeCtx = null;
let regionsRegistry = {};
let currentBiome = 'wildwood';
const lakeCx = WORLD_W*0.72, lakeCy = WORLD_H*0.28, lakeRw=6.5, lakeRh=4.5;
const spawnX = Math.floor(WORLD_W/2), spawnY = Math.floor(WORLD_H/2);
const TILE_WATER=1, TILE_SAND=2, TILE_GRASS=0;
let tileGrid = [], objects = new Map(), respawnQueue = [];
let highlandAnchor = {x:0,y:0}, meadowAnchor = {x:0,y:0};
let huntHotspots = [];
let pathTiles = new Set();
function computePathTiles(fromX, fromY){
  const paths = new Set();
  const b = edgeBands();
  const targets = [
    {x:0, y:Math.floor((b.y0+b.y1)/2)},
    {x:WORLD_W-1, y:Math.floor((b.y0+b.y1)/2)},
    {x:Math.floor((b.x0+b.x1)/2), y:0},
    {x:Math.floor((b.x0+b.x1)/2), y:WORLD_H-1}
  ];
  targets.forEach(t=>{
    const dx = t.x-fromX, dy = t.y-fromY;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    for(let i=0;i<=steps;i++){
      const px = Math.round(fromX + dx*i/steps);
      const py = Math.round(fromY + dy*i/steps);
      paths.add(px+','+py);
      if(Math.abs(dx)>Math.abs(dy)){ paths.add(px+','+(py+1)); paths.add(px+','+(py-1)); }
      else { paths.add((px+1)+','+py); paths.add((px-1)+','+py); }
    }
  });
  return paths;
}

/* ============================================================
   Küstenlinie: statt exakter Ellipse eine per Rauschen verformte
   Uferlinie mit variabler Strandbreite -> organische Buchten,
   Landzungen und mal schmale, mal breite Strände.
============================================================ */
function shoreNoise(angle, seed, octaves){
  // periodisch in angle (0..2PI), damit die Küste nahtlos rundum schließt
  let v = 0, amp = 1, wsum = 0, freq = 1;
  for(let o=0; o<octaves; o++){
    const ph = ((seed*(o+7)*2654435761)>>>0) % 10000 / 10000 * Math.PI*2;
    v += Math.sin(angle*freq + ph) * amp;
    wsum += amp; amp *= 0.5; freq *= 2;
  }
  return v/wsum; // -1..1
}
// Liefert den Kacheltyp (Wasser/Sand/Gras) für eine Position relativ zum Gewässer
function coastTileAt(x, y, cxL, cyL, rw, rh, seed){
  const dx = (x-cxL)/rw, dy = (y-cyL)/rh;
  const d = Math.sqrt(dx*dx + dy*dy);
  if(d > 1.9) return TILE_GRASS; // weit draußen: früh raus (spart Rechenzeit)
  const ang = Math.atan2(dy, dx);
  // Uferlinie verformen: ±18% Radius, dadurch Buchten und Landzungen
  const warp = 1 + shoreNoise(ang, seed, 3)*0.18;
  // Strandbreite variiert unabhängig davon (mal schmal, mal breite Bucht)
  const beach = 0.10 + (shoreNoise(ang*1.7+2.1, seed+91, 2)*0.5+0.5)*0.22; // 0.10–0.32
  if(d < warp) return TILE_WATER;
  if(d < warp + beach) return TILE_SAND;
  return TILE_GRASS;
}
function pickAnchor(offset){
  const r = mulberry32(worldSeed+offset);
  let x,y,tries=0;
  do{ x = Math.floor(r()*WORLD_W); y = Math.floor(r()*WORLD_H); tries++; }
  while((Math.hypot(x-spawnX,y-spawnY)<10 || Math.hypot(x-lakeCx,y-lakeCy)<8) && tries<60);
  return {x,y};
}
function buildWorld(){
  tileGrid = []; objects = new Map();
  highlandAnchor = pickAnchor(4001); meadowAnchor = pickAnchor(7002);
  for(let y=0;y<WORLD_H;y++){
    const row=[];
    for(let x=0;x<WORLD_W;x++){
      const t = coastTileAt(x, y, lakeCx, lakeCy, lakeRw, lakeRh, worldSeed);
      row.push(t);
    }
    tileGrid.push(row);
  }
  const distSpawn=(x,y)=>Math.hypot(x-spawnX,y-spawnY);
  for(let y=0;y<WORLD_H;y++){
    for(let x=0;x<WORLD_W;x++){
      if(tileGrid[y][x]!==TILE_GRASS) continue;
      if(distSpawn(x,y)<4) continue;
      const distHi = Math.hypot(x-highlandAnchor.x,y-highlandAnchor.y);
      const distMe = Math.hypot(x-meadowAnchor.x,y-meadowAnchor.y);
      const treeCluster = hash2(Math.floor(x/5),Math.floor(y/5), worldSeed);
      const rockCluster = hash2(Math.floor(x/6)+100,Math.floor(y/6)+100, worldSeed);
      const mountainNoise = hash2(Math.floor(x/3),Math.floor(y/3), worldSeed+9001);
      const fine = hash2(x+0.5,y+0.5, worldSeed);
      const fine2 = hash2(x+0.3,y+0.7, worldSeed+7);
      const fine3 = hash2(x+0.9,y+0.2, worldSeed+31);
      if(distHi<11 && mountainNoise>0.86 && distSpawn(x,y)>6){
        objects.set(x+','+y, {type:'mountain', hp:7, maxHp:7});
      } else if(distHi<9 && rockCluster>0.42 && fine2>0.35){
        if(fine>0.7){ objects.set(x+','+y, {type:'orevein', hp:4, maxHp:4}); } else { objects.set(x+','+y, {type:'rock', hp:3, maxHp:3}); }
      } else if(distMe<9 && fine3>0.5 && fine3<=0.75){
        objects.set(x+','+y, {type:'fiberbush', hp:1, maxHp:1});
      } else if(distMe<9 && fine3>0.75){
        objects.set(x+','+y, {type:'wildgemuese', hp:1, maxHp:1});
      } else if(treeCluster>0.68 && fine>0.55){
        objects.set(x+','+y, {type:'tree', hp:3, maxHp:3});
      } else if(rockCluster>0.82 && fine2>0.6){
        objects.set(x+','+y, {type:'rock', hp:3, maxHp:3});
      } else if(fine3>0.975){
        objects.set(x+','+y, {type:'bush', hp:1, maxHp:1});
      }
    }
  }
  huntHotspots = [];
  for(let i=0;i<2;i++){
    for(let tries=0;tries<200;tries++){
      const x = Math.floor(Math.random()*WORLD_W), y = Math.floor(Math.random()*WORLD_H);
      if(distSpawn(x,y)<15) continue;
      if(tileGrid[y][x]!==TILE_GRASS || objects.has(x+','+y)) continue;
      huntHotspots.push({x,y}); break;
    }
  }
  pathTiles = computePathTiles(spawnX, spawnY);
  pathTiles.forEach(key=>{
    const [px,py] = key.split(',').map(Number);
    if(px<0||py<0||px>=WORLD_W||py>=WORLD_H) return;
    if(tileGrid[py][px]===TILE_GRASS) objects.delete(key);
  });
}
function tileAt(x,y,ctx){
  const tg = ctx ? ctx.tileGrid : tileGrid;
  if(x<0||y<0||x>=WORLD_W||y>=WORLD_H) return TILE_WATER;
  return tg[y][x];
}
function objAt(x,y,ctx){ return (ctx ? ctx.objects : objects).get(x+','+y); }
function passable(x,y,ctx){
  if(tileAt(x,y,ctx)!==TILE_GRASS && tileAt(x,y,ctx)!==TILE_SAND) return false;
  const o = objAt(x,y,ctx);
  if(o && (o.type==='tree'||o.type==='rock'||o.type==='orevein'||o.type==='mountain'||o.type==='ruins_loot'||o.type==='trader'||o.type==='hut'||o.type==='dungeon_portal'||o.type==='cave_entrance'||o.type==='dungeon_exit'||o.type==='dungeon_chest'||o.type==='visitor'||o.type==='quest_npc'||o.type==='vwall'||o.type==='vfurn')) return false;
  const effectiveRegionId = ctx ? ctx.regionId : state.player.regionId;
  if(effectiveRegionId !== 'DUNGEON'){
    const bs = state.buildings.filter(bb=>bb.x===x&&bb.y===y&&(bb.regionId||'C')===effectiveRegionId);
    if(bs.some(bb=>!['door','stockpile','holzboden','steinboden','schutzzone','feld_beeren','feld_gemuese','feld_kraeuter','feld_getreide','tiergehege','teppich','marmorboden','gartenweg'].includes(bb.type))) return false;
  }
  return true;
}

/* ============================================================
   Overworld: multiple regions (JRPG-style world map)
============================================================ */
let REGIONS = {
  NW:{name:'Frostgebirge', biome:'frost', gx:-1,gy:-1}, N:{name:'Hochebene', biome:'highland', gx:0,gy:-1}, NE:{name:'Ruinen', biome:'ruins', gx:1,gy:-1},
  W:{name:'Sumpfland', biome:'swamp', gx:-1,gy:0}, C:{name:'Heimat', biome:'wildwood', gx:0,gy:0}, E:{name:'Küste', biome:'coast', gx:1,gy:0},
  SW:{name:'Dornwildnis', biome:'thorn', gx:-1,gy:1}, S:{name:'Wiesenland', biome:'meadow', gx:0,gy:1}, SE:{name:'Tiefwald', biome:'deepwood', gx:1,gy:1}
};
const BIOME_NAME_POOL = {
  frost:['Frostgebirge','Eiskliffs','Frosttundra','Gletscherfeld','Reifhügel'],
  highland:['Hochebene','Steinplateau','Kraterland','Windkamm','Felsrücken'],
  ruins:['Ruinen','Vergessene Stadt','Trümmerfeld','Schattenruinen','Verfallene Hallen'],
  swamp:['Sumpfland','Nebelmoor','Faulmoor','Schlammebene','Moderbruch'],
  coast:['Küste','Sturmklippen','Wellenbucht','Salzstrand','Nebelriff'],
  thorn:['Dornwildnis','Dornenfeld','Distelheide','Wildnisrand','Krallenbusch'],
  meadow:['Wiesenland','Blütenfeld','Graslandschaft','Sonnenau','Weideland'],
  deepwood:['Tiefwald','Schattenwald','Dickicht','Uralter Hain','Moosgrund'],
  wildwood:['Waldsaum','Lichtung','Farholt-Rand','Grünsaum','Talwald']
};
function ensureRegion(gx,gy){
  const found = Object.keys(REGIONS).find(k=>REGIONS[k].gx===gx && REGIONS[k].gy===gy);
  if(found) return found;
  const rng = mulberry32(worldSeedBase + gx*7919 + gy*104729 + 1337);
  const biomes = Object.keys(BIOME_NAME_POOL);
  const biome = biomes[Math.floor(rng()*biomes.length)];
  const pool = BIOME_NAME_POOL[biome];
  const name = pool[Math.floor(rng()*pool.length)];
  const newId = 'R'+gx+'_'+gy;
  REGIONS[newId] = { name, biome, gx, gy };
  return newId;
}

/* ---------- Exploration lore / chronicle ---------- */
const LORE_ENTRIES = {
  biome_wildwood:{title:'Der Aufbruch', text:'Die Boote sind verbrannt, der Weg zurück versperrt. Vor dir liegt Farholt – ein Landstrich, den die alten Karten nur als weißen Fleck kennen. Was auch immer hier einst war, es ist lange fort. Jetzt ist es deins.'},
  biome_highland:{title:'Die Steinbrecher', text:'Tief in den Hochebenen finden sich verwitterte Meißelspuren, zu regelmäßig für Wind und Wetter. Jemand hat hier einmal im großen Stil abgebaut – und ist nie zurückgekehrt, um die Werkzeuge zu holen.'},
  biome_frost:{title:'Das erfrorene Lager', text:'Zwischen den Eiskliffs liegen die Reste eines Zeltlagers, konserviert vom ewigen Frost. Die Feuerstelle ist kalt seit Generationen, doch die Schüsseln stehen noch ordentlich gestapelt da – als hätte man sie nur kurz verlassen wollen.'},
  biome_ruins:{title:'Alt-Farholt', text:'Zerborstene Säulen, überwuchert von Jahrzehnten. Wer auch immer hier lebte, baute in einem Maßstab, den deine kleine Kolonie erst noch erreichen muss. Und doch: von den Bewohnern selbst fehlt jede Spur.'},
  biome_swamp:{title:'Das versunkene Dorf', text:'Im Nebel des Moors ragen morsche Dachbalken aus dem schwarzen Wasser. Die Sümpfe haben sich geholt, was einst trockenes Land war – und mit ihm, so munkelt man, auch die, die zu langsam waren zu fliehen.'},
  biome_coast:{title:'Die verlorene Flotte', text:'Am Strand rosten Ankerketten, zu groß für jedes Fischerboot. Weiter draußen, kaum sichtbar bei Ebbe, ragen Mastspitzen aus dem Wasser. Was diese Schiffe suchten, als sie sanken, weiß niemand mehr zu sagen.'},
  biome_thorn:{title:'Die Wildnis kehrt zurück', text:'Dornenranken haben sich um etwas gewickelt, das einmal ein Zaun war. Die Natur hier nimmt sich zurück, was ihr genommen wurde – gründlich, geduldig, ohne Eile.'},
  biome_meadow:{title:'Das stille Feld', text:'Die Wiesen wirken friedlich, doch unter dem Gras liegen verrostete Klingenreste in geraden Reihen. Hier fand einmal etwas statt, das größer war als ein Scharmützel – und das Gras hat seither nichts vergessen.'},
  biome_deepwood:{title:'Der Wächter des Waldes', text:'Je tiefer man in den Wald vordringt, desto älter wirken die Bäume – und desto öfter hat man das Gefühl, beobachtet zu werden. Die ältesten Farholter erzählten von einem Wächter, der niemanden fürchtet außer dem Feuer.'},
  ruins_1:{title:'Fragment: Die Gründung', text:'"...im dritten Jahr nach der Landung gründeten wir Farholt, benannt nach dem Ersten, der diese Küste betrat. Wir schworen, aus dem Nichts etwas Dauerhaftes zu errichten..." — aus einem zerfledderten Gründungsdokument.'},
  ruins_2:{title:'Fragment: Das Experiment', text:'"...die Gelehrten versprachen, das Wesen der Kreaturen ergründen und lenken zu können. Wir hätten misstrauischer sein sollen, als die ersten Veränderungen sichtbar wurden..." — Tagebucheintrag, Autor unbekannt.'},
  ruins_3:{title:'Fragment: Die Wandlung', text:'"...sie sind nicht mehr, was sie waren, bevor die Gelehrten sie berührten. Manche fürchten sie. Andere, die Waldläufer unter uns, haben gelernt, mit ihnen zu leben, sie zu binden, ihnen zu vertrauen..." — spätere Ergänzung, andere Handschrift.'},
  ruins_4:{title:'Fragment: Der Fall', text:'"...die Stadt konnte nicht gehalten werden. Was auch immer wir freigesetzt hatten, ließ sich nicht zurückrufen. Wir haben beschlossen zu gehen, bevor Alt-Farholt uns alle mit sich reißt..." — letzter datierter Eintrag.'},
  ruins_5:{title:'Fragment: Der Neuanfang', text:'"Wer diese Zeilen liest, hat es weiter gebracht als wir. Baue vorsichtiger. Höre auf die Kreaturen, nicht nur auf den Ehrgeiz. Und wenn du kannst: mach es besser, als wir es taten." — unsigniert, letzte Seite.'},
  village_rumor:{title:'Marktgeflüster', text:'"Die Ruinen? Da geht keiner freiwillig rein", sagt der Händler und senkt die Stimme. "Aber wer sie überlebt, kommt manchmal mit Dingen zurück, die älter sind als Farholt selbst. Wenn du hingehst – pass auf, was dort noch wach ist."'}
};
const LORE_ORDER = ['biome_wildwood','biome_highland','biome_frost','biome_ruins','biome_swamp','biome_coast','biome_thorn','biome_meadow','biome_deepwood','ruins_1','ruins_2','ruins_3','ruins_4','ruins_5','village_rumor'];
function discoverLore(key){
  if(!LORE_ENTRIES[key]) return false;
  if(state.loreDiscovered.includes(key)) return false;
  state.loreDiscovered.push(key);
  const entry = LORE_ENTRIES[key];
  sfxEvent();
  showStoryDialog('📜 '+entry.title, entry.text, [{label:'Weiter', action:()=>{}}]);
  logEvent('📜 Neuer Chronik-Eintrag: '+entry.title);
  saveGame();
  return true;
}
function checkBiomeLore(){ discoverLore('biome_'+currentBiome); }
function discoverNextRuinsFragment(){
  const keys = ['ruins_1','ruins_2','ruins_3','ruins_4','ruins_5'];
  const next = keys.find(k=>!state.loreDiscovered.includes(k));
  return next ? discoverLore(next) : false;
}
const BIOME_TREE_STYLE = {
  wildwood:{shape:'round', canopy:'#3f6b3f', canopyLight:'#4c7a3d', trunk:'#5a3d20'},
  highland:{shape:'pine', canopy:'#3a5c46', canopyLight:'#4a7058', trunk:'#4a3826'},
  frost:{shape:'pine_snow', canopy:'#4a6b68', canopyLight:'#6b8f8a', trunk:'#4a3826'},
  ruins:{shape:'sparse', canopy:'#5c5648', canopyLight:'#6e685a', trunk:'#4a4238'},
  swamp:{shape:'gnarled', canopy:'#3a4a2c', canopyLight:'#465836', trunk:'#3a3020'},
  coast:{shape:'round', canopy:'#5c8f5a', canopyLight:'#6fa06a', trunk:'#6b5030'},
  thorn:{shape:'gnarled', canopy:'#4a3d52', canopyLight:'#5c4d66', trunk:'#3a2e40'},
  meadow:{shape:'round', canopy:'#4c8f4a', canopyLight:'#5ca058', trunk:'#5a3d20'},
  deepwood:{shape:'pine', canopy:'#1e3a1f', canopyLight:'#2a4a2a', trunk:'#3a2818'}
};
const BIOME_ROCK_STYLE = {
  wildwood:'mossy', highland:'crystal', frost:'crystal', ruins:'weathered',
  swamp:'mossy', coast:'weathered', thorn:'mossy', meadow:'mossy', deepwood:'mossy'
};
const BIOME_CONFIG = {
  wildwood:{treeMul:1, rockMul:1, bushMul:1, waterMul:1},
  highland:{treeMul:0.4, rockMul:1.8, bushMul:0.6, waterMul:0.5},
  frost:{treeMul:0.5, rockMul:1.4, bushMul:0.5, waterMul:0.6},
  ruins:{treeMul:0.3, rockMul:2.0, bushMul:0.4, waterMul:0.4},
  swamp:{treeMul:0.6, rockMul:0.5, bushMul:1.6, waterMul:2.2},
  coast:{treeMul:0.5, rockMul:0.6, bushMul:0.8, waterMul:2.5},
  thorn:{treeMul:0.7, rockMul:0.6, bushMul:2.0, waterMul:0.7},
  meadow:{treeMul:0.3, rockMul:0.4, bushMul:1.8, waterMul:0.8},
  deepwood:{treeMul:2.0, rockMul:0.5, bushMul:0.6, waterMul:0.6}
};
const PALETTE_GRASS = {
  wildwood:['#4c7a3d','#456f38','#3f6533'], highland:['#6b6f63','#5f6357','#565a4e'], frost:['#8fa8a8','#7f9898','#728a8a'],
  ruins:['#7a7468','#6e685c','#645e52'], swamp:['#4a5c3a','#3f5030','#354528'], coast:['#c9b878','#bfae6e','#b4a262'],
  thorn:['#6a5c6f','#5f5164','#544759'], meadow:['#7fb85a','#74ab4e','#699e44'], deepwood:['#254a26','#1e3f1f','#183419']
};
function thresh(base,mul){ return clamp(base/Math.max(0.15,mul), 0.05, 0.97); }
function edgeBands(){
  return { y0:Math.floor(WORLD_H*0.4), y1:Math.floor(WORLD_H*0.6), x0:Math.floor(WORLD_W*0.4), x1:Math.floor(WORLD_W*0.6) };
}
function edgeDirectionAt(x,y){
  const b = edgeBands();
  if(x<=0 && y>=b.y0 && y<=b.y1) return 'W';
  if(x>=WORLD_W-1 && y>=b.y0 && y<=b.y1) return 'E';
  if(y<=0 && x>=b.x0 && x<=b.x1) return 'N';
  if(y>=WORLD_H-1 && x>=b.x0 && x<=b.x1) return 'S';
  return null;
}
function clearEdgeCorridors(ctx){
  const b = edgeBands();
  for(let y=b.y0;y<=b.y1;y++){ ctx.objects.delete('0,'+y); ctx.objects.delete((WORLD_W-1)+','+y); ctx.tileGrid[y][0]=TILE_GRASS; ctx.tileGrid[y][WORLD_W-1]=TILE_GRASS; }
  for(let x=b.x0;x<=b.x1;x++){ ctx.objects.delete(x+',0'); ctx.objects.delete(x+','+(WORLD_H-1)); ctx.tileGrid[0][x]=TILE_GRASS; ctx.tileGrid[WORLD_H-1][x]=TILE_GRASS; }
}
function neighborOf(id,dir){
  const r = REGIONS[id]; if(!r) return null;
  let gx=r.gx, gy=r.gy;
  if(dir==='W') gx--; else if(dir==='E') gx++; else if(dir==='N') gy--; else if(dir==='S') gy++;
  return ensureRegion(gx,gy);
}
function pickAnchorGeneric(seedOffset, spawnCx, spawnCy, lcx, lcy){
  const r = mulberry32(seedOffset);
  let x,y,tries=0;
  do{ x=Math.floor(r()*WORLD_W); y=Math.floor(r()*WORLD_H); tries++; }
  while((Math.hypot(x-spawnCx,y-spawnCy)<10 || Math.hypot(x-lcx,y-lcy)<8) && tries<60);
  return {x,y};
}
function trySpawnWildInto(ctx){
  if(ctx.wildMonsters.length>=14) return;
  for(let tries=0;tries<20;tries++){
    const x = Math.floor(Math.random()*WORLD_W), y = Math.floor(Math.random()*WORLD_H);
    if(!passable(x,y,ctx)) continue;
    const sp = weightedSpecies(ctx.biome);
    ctx.wildMonsters.push({ uid:newUid(), speciesId:sp.id, x, y, lastMove:0, hostile:false, raid:false });
    return;
  }
}
function buildRegionContext(id){
  const region = REGIONS[id];
  const seed = worldSeedBase + id.split('').reduce((a,c)=>a+c.charCodeAt(0),0)*9973;
  const cfg = BIOME_CONFIG[region.biome];
  const ctx = { tileGrid:[], objects:new Map(), respawnQueue:[], wildMonsters:[], groundItems:[],
    highlandAnchor:{x:0,y:0}, meadowAnchor:{x:0,y:0}, seed, biome:region.biome, regionId:id };
  const lr = mulberry32(seed+55);
  const lcx = WORLD_W*(0.3+lr()*0.4), lcy = WORLD_H*(0.3+lr()*0.4);
  const lrw = 5*Math.sqrt(cfg.waterMul), lrh = 3.5*Math.sqrt(cfg.waterMul);
  for(let y=0;y<WORLD_H;y++){
    const row=[];
    for(let x=0;x<WORLD_W;x++){
      const t = coastTileAt(x, y, lcx, lcy, lrw, lrh, seed);
      row.push(t);
    }
    ctx.tileGrid.push(row);
  }
  const spawnCx = Math.floor(WORLD_W/2), spawnCy = Math.floor(WORLD_H/2);
  ctx.highlandAnchor = pickAnchorGeneric(seed+4001, spawnCx, spawnCy, lcx, lcy);
  ctx.meadowAnchor = pickAnchorGeneric(seed+7002, spawnCx, spawnCy, lcx, lcy);
  for(let y=0;y<WORLD_H;y++){
    for(let x=0;x<WORLD_W;x++){
      if(ctx.tileGrid[y][x]!==TILE_GRASS) continue;
      const distHi = Math.hypot(x-ctx.highlandAnchor.x,y-ctx.highlandAnchor.y);
      const distMe = Math.hypot(x-ctx.meadowAnchor.x,y-ctx.meadowAnchor.y);
      const distCenter = Math.hypot(x-spawnCx,y-spawnCy);
      const treeCluster = hash2(Math.floor(x/5),Math.floor(y/5), seed);
      const rockCluster = hash2(Math.floor(x/6)+100,Math.floor(y/6)+100, seed);
      const mountainNoise = hash2(Math.floor(x/3),Math.floor(y/3), seed+9001);
      const fine = hash2(x+0.5,y+0.5, seed);
      const fine2 = hash2(x+0.3,y+0.7, seed+7);
      const fine3 = hash2(x+0.9,y+0.2, seed+31);
      const tT=thresh(0.68,cfg.treeMul), rT=thresh(0.82,cfg.rockMul), bT=thresh(0.975,cfg.bushMul);
      const hiT=thresh(0.42,cfg.rockMul), meT=thresh(0.5,cfg.bushMul);
      const mT=0.86;
      if(distHi<11 && mountainNoise>mT && distCenter>6){
        ctx.objects.set(x+','+y, {type:'mountain', hp:7, maxHp:7});
      } else if(distHi<9 && rockCluster>hiT && fine2>0.35){
        if(fine>0.7){ ctx.objects.set(x+','+y, {type:'orevein', hp:4, maxHp:4}); } else { ctx.objects.set(x+','+y, {type:'rock', hp:3, maxHp:3}); }
      } else if(distMe<9 && fine3>meT && fine3<=(meT+(1-meT)/2)){
        ctx.objects.set(x+','+y, {type:'fiberbush', hp:1, maxHp:1});
      } else if(distMe<9 && fine3>(meT+(1-meT)/2)){
        ctx.objects.set(x+','+y, {type:'wildgemuese', hp:1, maxHp:1});
      } else if(treeCluster>tT && fine>0.55){
        ctx.objects.set(x+','+y, {type:'tree', hp:3, maxHp:3});
      } else if(rockCluster>rT && fine2>0.6){
        ctx.objects.set(x+','+y, {type:'rock', hp:3, maxHp:3});
      } else if(fine3>bT){
        ctx.objects.set(x+','+y, {type:'bush', hp:1, maxHp:1});
      }
    }
  }
  clearEdgeCorridors(ctx);
  for(let i=0;i<12;i++) trySpawnWildInto(ctx);
  if(region.biome==='ruins'){
    const rng = mulberry32(seed+55555);
    let placed = 0, tries = 0;
    while(placed<6 && tries<400){
      tries++;
      const x = Math.floor(rng()*WORLD_W), y = Math.floor(rng()*WORLD_H);
      if(Math.hypot(x-spawnCx,y-spawnCy)<6) continue;
      if(!passable(x,y,ctx) || ctx.objects.has(x+','+y)) continue;
      ctx.objects.set(x+','+y, {type:'ruins_loot', hp:1, maxHp:1});
      placed++;
    }
  }
  if(id!=='C'){
    const vrng = mulberry32(seed+77777);
    if(vrng()<0.6){
      generateVillage(ctx, vrng, spawnCx, spawnCy);
    }
  }
  ctx.huntHotspots = [];
  for(let i=0;i<2;i++){
    for(let tries=0;tries<200;tries++){
      const x = Math.floor(Math.random()*WORLD_W), y = Math.floor(Math.random()*WORLD_H);
      if(Math.hypot(x-spawnCx,y-spawnCy)<12) continue;
      if(ctx.tileGrid[y][x]!==TILE_GRASS || ctx.objects.has(x+','+y)) continue;
      ctx.huntHotspots.push({x,y}); break;
    }
  }
  const portalChance = region.biome==='ruins' ? 0.55 : 0.3;
  if(Math.random()<portalChance){
    for(let tries=0;tries<200;tries++){
      const x = Math.floor(Math.random()*WORLD_W), y = Math.floor(Math.random()*WORLD_H);
      if(Math.hypot(x-spawnCx,y-spawnCy)<10) continue;
      if(!passable(x,y,ctx) || ctx.objects.has(x+','+y)) continue;
      ctx.objects.set(x+','+y, {type:'dungeon_portal', hp:1, maxHp:1});
      break;
    }
  }
  const caveChance = (region.biome==='highland' || region.biome==='frost') ? 0.7 : 0.45;
  if(Math.random()<caveChance){
    for(let tries=0;tries<200;tries++){
      const x = Math.floor(Math.random()*WORLD_W), y = Math.floor(Math.random()*WORLD_H);
      if(Math.hypot(x-spawnCx,y-spawnCy)<8) continue;
      if(!passable(x,y,ctx) || ctx.objects.has(x+','+y)) continue;
      ctx.objects.set(x+','+y, {type:'cave_entrance', hp:1, maxHp:1});
      break;
    }
  }
  ctx.pathTiles = computePathTiles(spawnCx, spawnCy);
  ctx.pathTiles.forEach(key=>{
    const [px,py] = key.split(',').map(Number);
    if(px<0||py<0||px>=WORLD_W||py>=WORLD_H) return;
    if(ctx.tileGrid[py][px]===TILE_GRASS) ctx.objects.delete(key);
  });
  return ctx;
}
function getOrCreateRegion(id){
  if(regionsRegistry[id]) return regionsRegistry[id];
  const ctx = buildRegionContext(id);
  regionsRegistry[id] = ctx;
  return ctx;
}
function atHome(){ return state.player.regionId==='C'; }
function updateLocationLabel(){
  const sub = document.querySelector('#title .sub');
  if(!sub) return;
  if(atHome()){ sub.textContent = 'Kolonie-Aufbau'; return; }
  if(atDungeon()){
    const d = dungeonCtx ? dungeonCtx.dangerLevel : 1;
    const label = dungeonCtx && dungeonCtx.instanceType==='cave' ? '🕳️ Höhle' : '🕳️ Dungeon';
    sub.textContent = label+' '+'💀'.repeat(clamp(Math.round(d/2),1,4));
    return;
  }
  const name = REGIONS[state.player.regionId]?.name || '';
  const danger = regionDangerLevel(state.player.regionId);
  const skulls = danger<=0 ? '' : ' '+'💀'.repeat(clamp(Math.round(danger/2),1,4));
  sub.textContent = '📍 '+name+skulls;
}
function checkRegionTransition(){
  if(atDungeon()) return;
  const dir = edgeDirectionAt(state.player.x, state.player.y);
  if(!dir) return;
  const target = neighborOf(state.player.regionId, dir);
  if(target) travelToRegion(target, dir);
}
/* ============================================================
   Dungeons: procedurally generated room-and-corridor instances
============================================================ */
const DUNGEON_ROOM = 7;
const DUNGEON_PITCH = 9;
const DUNGEON_GRID_N = 5;
const DUNGEON_W = DUNGEON_GRID_N*DUNGEON_PITCH;
const DUNGEON_H = DUNGEON_GRID_N*DUNGEON_PITCH;
let dungeonCtx = null;
let dungeonReturn = null;
function atDungeon(){ return state.player.regionId==='DUNGEON'; }
function generateDungeonCtx(dangerLevel, instanceType){
  instanceType = instanceType || 'dungeon';
  const isCave = instanceType==='cave';
  const tileGrid = [];
  for(let y=0;y<DUNGEON_H;y++){ tileGrid.push(new Array(DUNGEON_W).fill(TILE_WATER)); }
  const objects = new Map();
  const idx = (sx,sy)=>sy*DUNGEON_GRID_N+sx;
  const slotOccupied = new Array(DUNGEON_GRID_N*DUNGEON_GRID_N).fill(null);
  const startSx = Math.floor(DUNGEON_GRID_N/2), startSy = DUNGEON_GRID_N-1;
  let cur = {sx:startSx, sy:startSy};
  slotOccupied[idx(cur.sx,cur.sy)] = 'start';
  const path = [cur];
  const roomTarget = isCave ? (4+Math.floor(Math.random()*3)) : (8+Math.floor(Math.random()*4));
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
  let guard = 0;
  while(path.length<roomTarget && guard<500){
    guard++;
    const d = dirs[Math.floor(Math.random()*4)];
    const nsx=cur.sx+d[0], nsy=cur.sy+d[1];
    if(nsx<0||nsy<0||nsx>=DUNGEON_GRID_N||nsy>=DUNGEON_GRID_N) continue;
    if(!slotOccupied[idx(nsx,nsy)]){ slotOccupied[idx(nsx,nsy)]='normal'; path.push({sx:nsx,sy:nsy}); }
    cur = {sx:nsx,sy:nsy};
  }
  const bossSlot = path[path.length-1];
  slotOccupied[idx(bossSlot.sx,bossSlot.sy)] = 'boss';
  function carveRoom(sx,sy){
    const ox = sx*DUNGEON_PITCH + Math.floor((DUNGEON_PITCH-DUNGEON_ROOM)/2);
    const oy = sy*DUNGEON_PITCH + Math.floor((DUNGEON_PITCH-DUNGEON_ROOM)/2);
    for(let y=0;y<DUNGEON_ROOM;y++){ for(let x=0;x<DUNGEON_ROOM;x++){ tileGrid[oy+y][ox+x]=TILE_GRASS; } }
    return { cx: ox+Math.floor(DUNGEON_ROOM/2), cy: oy+Math.floor(DUNGEON_ROOM/2) };
  }
  const roomCenters = {};
  for(let sy=0;sy<DUNGEON_GRID_N;sy++){ for(let sx=0;sx<DUNGEON_GRID_N;sx++){
    if(slotOccupied[idx(sx,sy)]) roomCenters[idx(sx,sy)] = carveRoom(sx,sy);
  } }
  for(let i=0;i<path.length-1;i++){
    const ca=roomCenters[idx(path[i].sx,path[i].sy)], cb=roomCenters[idx(path[i+1].sx,path[i+1].sy)];
    let x=ca.cx, y=ca.cy;
    while(x!==cb.cx){ tileGrid[y][x]=TILE_GRASS; x += x<cb.cx?1:-1; }
    while(y!==cb.cy){ tileGrid[y][x]=TILE_GRASS; y += y<cb.cy?1:-1; }
    tileGrid[cb.cy][cb.cx]=TILE_GRASS;
  }
  const wildMonsters = [];
  let bossUid = null;
  Object.keys(roomCenters).forEach(key=>{
    const info = slotOccupied[key]; const c = roomCenters[key];
    if(info==='normal' && Math.random()<0.9){
      const sp = weightedSpecies(currentBiome);
      wildMonsters.push({ uid:newUid(), speciesId:sp.id, x:c.cx, y:c.cy, lastMove:0, hostile:false, raid:false, dungeonMult: 1+dangerLevel*(isCave?0.08:0.15) });
      if(Math.random()<0.4){
        const sp2 = weightedSpecies(currentBiome);
        const ox = c.cx + (Math.random()<0.5?-2:2), oy = c.cy + (Math.random()<0.5?-1:1);
        if(tileGrid[oy] && tileGrid[oy][ox]===TILE_GRASS){
          wildMonsters.push({ uid:newUid(), speciesId:sp2.id, x:ox, y:oy, lastMove:0, hostile:false, raid:false, dungeonMult: 1+dangerLevel*(isCave?0.08:0.15) });
        }
      }
    } else if(info==='boss'){
      const bossPool = isCave
        ? SPECIES.filter(s=>s.evolvesFrom==null)
        : SPECIES.filter(s=>s.rarity!=='common' && s.evolvesFrom==null);
      const sp = bossPool[Math.floor(Math.random()*bossPool.length)] || SPECIES[0];
      bossUid = newUid();
      wildMonsters.push({ uid:bossUid, speciesId:sp.id, x:c.cx, y:c.cy, lastMove:0, hostile:false, raid:false, boss:true, dungeonMult: (isCave?1.3:1.8)+dangerLevel*(isCave?0.15:0.25) });
    }
  });
  const startCenter = roomCenters[idx(startSx,startSy)];
  objects.set(startCenter.cx+','+(startCenter.cy+2), {type:'dungeon_exit', hp:1, maxHp:1});
  return { tileGrid, objects, respawnQueue:[], wildMonsters, groundItems:[],
    highlandAnchor:{x:0,y:0}, meadowAnchor:{x:0,y:0}, seed:Math.floor(Math.random()*99999), biome:'dungeon', regionId:'DUNGEON',
    startPos:{x:startCenter.cx,y:startCenter.cy}, bossUid, cleared:false, dangerLevel, instanceType };
}
function enterDungeon(instanceType){
  if(atDungeon()) return;
  instanceType = instanceType || 'dungeon';
  const danger = 1+regionDangerLevel(state.player.regionId);
  dungeonReturn = { regionId: state.player.regionId, x: state.player.x, y: state.player.y };
  dungeonCtx = generateDungeonCtx(danger, instanceType);
  swapAmbientTo(dungeonCtx);
  state.player.regionId = 'DUNGEON';
  state.player.path=[]; state.player.target=null;
  state.player.x = dungeonCtx.startPos.x; state.player.y = dungeonCtx.startPos.y;
  snapMoveAnimToPlayer();
  camera.x = state.player.x - VIEW_W/2; camera.y = state.player.y - VIEW_H/2;
  if(instanceType==='cave'){ toast('🕳️ Du kletterst in die Höhle...'); logEvent('🕳️ Eine Höhle wurde betreten.'); }
  else { toast('🕳️ Du betrittst den Dungeon...'); logEvent('🕳️ Ein Dungeon wurde betreten.'); }
  if(!encounter) startMusicTrack('dungeon');
  updateLocationLabel(); saveGame();
}
function exitDungeon(){
  if(!atDungeon() || !dungeonReturn) return;
  const targetRegion = dungeonReturn.regionId;
  const targetCtx = targetRegion==='C' ? homeCtx : getOrCreateRegion(targetRegion);
  swapAmbientTo(targetCtx);
  state.player.regionId = targetRegion;
  state.player.x = dungeonReturn.x; state.player.y = dungeonReturn.y;
  snapMoveAnimToPlayer();
  state.player.path=[]; state.player.target=null;
  dungeonCtx = null; dungeonReturn = null;
  toast('Du verlässt den Untergrund.');
  if(!encounter) startMusicTrack('colony');
  updateLocationLabel(); saveGame();
}
function swapAmbientTo(ctx){
  tileGrid=ctx.tileGrid; objects=ctx.objects; respawnQueue=ctx.respawnQueue;
  wildMonsters=ctx.wildMonsters; groundItems=ctx.groundItems;
  highlandAnchor=ctx.highlandAnchor; meadowAnchor=ctx.meadowAnchor; worldSeed=ctx.seed;
  currentBiome = ctx.biome;
  huntHotspots = ctx.huntHotspots || [];
  pathTiles = ctx.pathTiles || new Set();
}
function travelToRegion(targetId, dir){
  const ctx = getOrCreateRegion(targetId);
  swapAmbientTo(ctx);
  state.player.regionId = targetId;
  if(targetId!=='C') state.visitedOtherRegion = true;
  if(dir==='W'){ state.player.x = WORLD_W-2; } else if(dir==='E'){ state.player.x = 1; }
  if(dir==='N'){ state.player.y = WORLD_H-2; } else if(dir==='S'){ state.player.y = 1; }
  snapMoveAnimToPlayer();
  state.player.path=[]; state.player.target=null; cameraFreeMode=false;
  deselectColonist();
  const label = targetId==='C' ? (state.colonyName||'Heimat') : REGIONS[targetId].name;
  toast('📍 '+label+' betreten');
  updateLocationLabel();
  saveGame();
  checkBiomeLore();
}
/* ============================================================
   Prozedurale Dörfer: echte Siedlungen aus 5–7 Häusern à 5x5,
   möbliert, mit umherlaufenden Bewohnern und einem Händler,
   der am Handelsposten sitzt und nachts schlafen geht.
============================================================ */
const HOUSE_SIZE = 5;
const VILLAGER_NAMES = ['Brenna','Aldric','Mirem','Tolvan','Silka','Hedda','Rurik','Nesta','Gorm','Ylva','Fenn','Marte','Dagur','Orla','Sten','Wilda'];
const VILLAGER_JOBS = [
  {job:'Bäckerin', furn:'oven',  shop:'bakery'},
  {job:'Schmied',  furn:'anvil', shop:'smithy'},
  {job:'Weberin',  furn:'loom',  shop:'weaver'},
  {job:'Jäger',    furn:'rack'},
  {job:'Kräuterfrau', furn:'herbs', shop:'herbalist'},
  {job:'Fischer',  furn:'barrel'},
  {job:'Zimmermann', furn:'bench'},
  {job:'Töpferin', furn:'pots'}
];
/* --- Ladengeschäfte: eigene Gebäude mit eigenem Sortiment --- */
const SHOP_TYPES = {
  smithy:{ name:'Schmiede', sign:'⚒️', signCol:'#8f96a0',
    greet:'Der Hammer verstummt, als du eintrittst. „Was brauchst du?"',
    trades:[
      {give:{ore:3}, get:{metal:2}, label:'3 ⛏️ Erz → 2 ⚙️ Metall'},
      {give:{metal:2, gold:1}, get:{trap:3}, label:'2 ⚙️ Metall + 1 🟡 Gold → 3 🪤 Fallen'},
      {give:{copper:2}, get:{metal:1, silver:1}, label:'2 🟠 Kupfer → 1 ⚙️ Metall + 1 ⚪ Silber'}
    ]},
  bakery:{ name:'Bäckerei', sign:'🥖', signCol:'#c9a23d',
    greet:'Es riecht nach frischem Brot. „Setz dich, iss etwas."',
    trades:[
      {give:{getreide:3}, get:{meal_brot:2}, label:'3 🌾 Getreide → 2 🍞 Brot'},
      {give:{gemuese:2, getreide:2}, get:{meal_veggie:1}, label:'2 🥕 Gemüse + 2 🌾 Getreide → 1 🍲 Eintopf'},
      {give:{berries:4}, get:{meal_brot:1, kraeuter:1}, label:'4 🫐 Beeren → 1 🍞 Brot + 1 🌱 Kraut'}
    ]},
  weaver:{ name:'Weberei', sign:'🧵', signCol:'#5a7fa8',
    greet:'Der Webstuhl klappert gleichmäßig weiter. „Sieh dich um."',
    trades:[
      {give:{fiber:3}, get:{cloth:2}, label:'3 🌾 Faser → 2 🧵 Stoff'},
      {give:{cloth:3, silver:1}, get:{potion:2}, label:'3 🧵 Stoff + 1 ⚪ Silber → 2 🧪 Heiltränke'},
      {give:{cloth:2}, get:{trap:1}, label:'2 🧵 Stoff → 1 🪤 Falle'}
    ]},
  herbalist:{ name:'Kräuterladen', sign:'🌿', signCol:'#6f9330',
    greet:'Getrocknete Bündel hängen von den Balken. „Vorsichtig, manches beißt."',
    trades:[
      {give:{kraeuter:2}, get:{potion:1}, label:'2 🌱 Heilkräuter → 1 🧪 Heiltrank'},
      {give:{berries:3, kraeuter:1}, get:{potion:2}, label:'3 🫐 Beeren + 1 🌱 Kraut → 2 🧪 Heiltränke'},
      {give:{silver:1}, get:{kraeuter:4}, label:'1 ⚪ Silber → 4 🌱 Heilkräuter'}
    ]}
};
// Prüft, ob ein 5x5-Haus samt Rand an dieser Stelle Platz hat
function houseFits(ctx, hx, hy){
  for(let y=hy-1; y<hy+HOUSE_SIZE+1; y++){
    for(let x=hx-1; x<hx+HOUSE_SIZE+1; x++){
      if(x<1||y<1||x>=WORLD_W-1||y>=WORLD_H-1) return false;
      if(ctx.tileGrid[y][x]!==TILE_GRASS) return false;
      if(ctx.objects.has(x+','+y)) return false;
    }
  }
  return true;
}
// Baut ein einzelnes 5x5-Haus: Wände, Tür, Boden, Möbel
function buildHouse(ctx, hx, hy, rng, resident){
  const doorSide = Math.floor(rng()*4); // 0=unten,1=oben,2=links,3=rechts
  let doorX, doorY;
  if(doorSide===0){ doorX=hx+2; doorY=hy+HOUSE_SIZE-1; }
  else if(doorSide===1){ doorX=hx+2; doorY=hy; }
  else if(doorSide===2){ doorX=hx; doorY=hy+2; }
  else { doorX=hx+HOUSE_SIZE-1; doorY=hy+2; }
  const roofTone = Math.floor(rng()*3); // Dachfarbe variiert pro Haus
  for(let y=hy; y<hy+HOUSE_SIZE; y++){
    for(let x=hx; x<hx+HOUSE_SIZE; x++){
      const edge = (x===hx||y===hy||x===hx+HOUSE_SIZE-1||y===hy+HOUSE_SIZE-1);
      const key = x+','+y;
      if(x===doorX && y===doorY){
        ctx.objects.set(key,{type:'vdoor', hp:999, maxHp:999, hx, hy,
          shop: resident.shop||null, shopOwner: resident.name});
      } else if(edge){
        ctx.objects.set(key,{type:'vwall', hp:999, maxHp:999, hx, hy, roofTone,
          corner:(x===hx||x===hx+HOUSE_SIZE-1)&&(y===hy||y===hy+HOUSE_SIZE-1)});
      } else {
        ctx.objects.set(key,{type:'vfloor', hp:999, maxHp:999, hx, hy});
      }
    }
  }
  // Möblierung im 3x3-Innenraum: Bett, Tisch + berufsspezifisches Möbel
  const inner = [];
  for(let y=hy+1; y<hy+HOUSE_SIZE-1; y++)
    for(let x=hx+1; x<hx+HOUSE_SIZE-1; x++)
      if(!(x===doorX&&y===doorY)) inner.push([x,y]);
  // Innenfelder mischen, damit die Einrichtung variiert
  for(let i=inner.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); [inner[i],inner[j]]=[inner[j],inner[i]]; }
  // Ladenbesitzer bekommen einen Tresen statt eines Regals
  const furnList = resident.shop
    ? ['bed','counter', resident.furn, 'shelf']
    : ['bed','table', resident.furn, rng()<0.5?'shelf':'hearth'];
  furnList.forEach((f,i)=>{
    if(i>=inner.length) return;
    const [fx,fy] = inner[i];
    // Tür nicht zustellen
    if(Math.abs(fx-doorX)+Math.abs(fy-doorY) <= 1) return;
    ctx.objects.set(fx+','+fy, {type:'vfurn', kind:f, hp:999, maxHp:999, hx, hy});
    if(f==='bed'){ resident.bedX=fx; resident.bedY=fy; }
  });
  return {doorX, doorY};
}
// Erzeugt eine komplette Siedlung
function generateVillage(ctx, rng, spawnCx, spawnCy){
  // Dorfmittelpunkt suchen (genug Abstand zum Startpunkt)
  let vcx=0, vcy=0, found=false;
  for(let t=0;t<300 && !found;t++){
    vcx = 12+Math.floor(rng()*(WORLD_W-24));
    vcy = 12+Math.floor(rng()*(WORLD_H-24));
    if(Math.hypot(vcx-spawnCx,vcy-spawnCy)<14) continue;
    if(ctx.tileGrid[vcy][vcx]!==TILE_GRASS) continue;
    found=true;
  }
  if(!found) return null;
  const houseCount = 5 + Math.floor(rng()*3); // 5–7 Häuser
  const houses = [];
  ctx.villagers = ctx.villagers || [];
  // Häuser locker um das Zentrum verteilen (Ringanordnung mit Zufallsversatz)
  const slots = [];
  for(let ring=0; ring<3; ring++){
    const count = ring===0 ? 4 : 6;
    for(let i=0;i<count;i++){
      const a = (i/count)*Math.PI*2 + rng()*0.5;
      const rad = 7 + ring*7;
      slots.push([vcx + Math.round(Math.cos(a)*rad), vcy + Math.round(Math.sin(a)*rad*0.8)]);
    }
  }
  for(let i=slots.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); [slots[i],slots[j]]=[slots[j],slots[i]]; }
  for(const [sx,sy] of slots){
    if(houses.length>=houseCount) break;
    const hx = sx-2, hy = sy-2;
    if(!houseFits(ctx,hx,hy)) continue;
    const nm = VILLAGER_NAMES[Math.floor(rng()*VILLAGER_NAMES.length)];
    const jb = VILLAGER_JOBS[Math.floor(rng()*VILLAGER_JOBS.length)];
    const resident = { name:nm, job:jb.job, furn:jb.furn, shop:jb.shop||null, hx, hy };
    const {doorX,doorY} = buildHouse(ctx, hx, hy, rng, resident);
    resident.doorX=doorX; resident.doorY=doorY;
    houses.push({hx,hy,doorX,doorY,resident});
    // Bewohner startet vor seiner Tür
    ctx.villagers.push({
      name:resident.name, job:resident.job, shop:resident.shop||null,
      x:doorX, y:doorY, homeX:hx+2, homeY:hy+2,
      bedX:resident.bedX, bedY:resident.bedY,
      doorX, doorY, lastMove:0, indoors:false,
      appearance: randomAppearance ? randomAppearance() : null,
      greeted:false
    });
  }
  if(!houses.length) return null;
  // Handelsposten im Zentrum + Marktstände
  let postPlaced=false;
  for(let t=0;t<40 && !postPlaced;t++){
    const px = vcx + Math.floor(rng()*5)-2, py = vcy + Math.floor(rng()*5)-2;
    if(px<1||py<1||px>=WORLD_W-1||py>=WORLD_H-1) continue;
    if(ctx.tileGrid[py][px]!==TILE_GRASS || ctx.objects.has(px+','+py)) continue;
    ctx.objects.set(px+','+py, {type:'trader', hp:1, maxHp:1});
    ctx.traderPost = {x:px, y:py};
    // Händler-NPC, der tagsüber am Posten steht und nachts heimgeht
    const home = houses[0];
    ctx.villagers.push({
      name:'Händler Corvin', job:'Händler', isTrader:true,
      x:px, y:py+1, postX:px, postY:py+1,
      homeX:home.hx+2, homeY:home.hy+2, bedX:home.resident.bedX, bedY:home.resident.bedY,
      doorX:home.doorX, doorY:home.doorY, lastMove:0, indoors:false, sleeping:false,
      appearance: randomAppearance ? randomAppearance() : null
    });
    postPlaced=true;
  }
  // Wege zwischen Türen und Zentrum
  ctx.villagePaths = ctx.villagePaths || new Set();
  houses.forEach(h=>{
    let cx2=h.doorX, cy2=h.doorY;
    let guard=0;
    while((cx2!==vcx||cy2!==vcy) && guard++<60){
      if(Math.abs(cx2-vcx)>Math.abs(cy2-vcy)) cx2 += cx2<vcx?1:-1;
      else if(cy2!==vcy) cy2 += cy2<vcy?1:-1;
      if(!ctx.objects.has(cx2+','+cy2)) ctx.villagePaths.add(cx2+','+cy2);
    }
  });
  ctx.villageCenter = {x:vcx, y:vcy, houses:houses.length};
  return ctx.villageCenter;
}

// Wird bei jedem fertiggestellten Gebäude aufgerufen
function onBuildingFinished(b){
  // Neue Feuerstelle oder neuer Tisch? Umstehende Sitzmöbel drehen sich hin.
  if(SEAT_FOCUS_TYPES.includes(b.type)){
    const n = realignSeating();
    if(n>0) toast(`🪑 ${n} Sitzmöbel richten sich nach ${BUILDING_TYPES[b.type].name} aus.`);
  }
  if(b.type==='werft' && !state.hasShip){
    state.hasShip = true;
    logEvent('⛵ Die Werft ist fertig — dein Segelboot liegt bereit. Auf der Weltkarte kannst du nun das offene Meer befahren.');
    toast('⛵ Schiff verfügbar! Öffne die Weltkarte.');
  }
}
/* Erstaufbau der Heimatregion. Wird von main.js aufgerufen, nicht
   schon beim Laden — sonst entsteht die Welt, bevor der Spielzustand
   steht. */
function initWorld(){
  buildWorld();
  // Fertigen Regionskontext zurückgeben — die inneren Variablen sind
  // von außen nicht sichtbar, ein Zugriff über globalThis läge daneben.
  return { tileGrid, objects, respawnQueue, wildMonsters, groundItems,
           highlandAnchor, meadowAnchor, huntHotspots, pathTiles };
}

/* ---------- Rückschreibe-Setter für die globale Brücke ----------
   Diese Bindings werden von anderen Modulen überschrieben. Ohne diese
   Funktionen käme die Zuweisung hier nie an und dieses Modul würde mit
   einem veralteten Wert weiterarbeiten. Siehe bridgeModule() in main.js. */
function __set_currentBiome(v){ currentBiome = v; }
function __set_dungeonCtx(v){ dungeonCtx = v; }
function __set_dungeonReturn(v){ dungeonReturn = v; }
function __set_homeCtx(v){ homeCtx = v; }
function __set_regionsRegistry(v){ regionsRegistry = v; }
function __set_respawnQueue(v){ respawnQueue = v; }
function __set_worldSeed(v){ worldSeed = v; }
function __set_worldSeedBase(v){ worldSeedBase = v; }

export {
  __set_currentBiome,
  __set_dungeonCtx,
  __set_dungeonReturn,
  __set_homeCtx,
  __set_regionsRegistry,
  __set_respawnQueue,
  __set_worldSeed,
  __set_worldSeedBase,

  initWorld,
  BIOME_CONFIG,
  BIOME_NAME_POOL,
  BIOME_ROCK_STYLE,
  BIOME_TREE_STYLE,
  DUNGEON_GRID_N,
  DUNGEON_H,
  DUNGEON_PITCH,
  DUNGEON_ROOM,
  DUNGEON_W,
  HOUSE_SIZE,
  LORE_ENTRIES,
  LORE_ORDER,
  PALETTE_GRASS,
  REGIONS,
  SHOP_TYPES,
  TILE,
  TILE_GRASS,
  TILE_SAND,
  TILE_WATER,
  VIEW_H,
  VIEW_W,
  VILLAGER_JOBS,
  VILLAGER_NAMES,
  WORLD_H,
  WORLD_W,
  atDungeon,
  atHome,
  buildHouse,
  buildRegionContext,
  buildWorld,
  checkBiomeLore,
  checkRegionTransition,
  clearEdgeCorridors,
  coastTileAt,
  computePathTiles,
  currentBiome,
  discoverLore,
  discoverNextRuinsFragment,
  dungeonCtx,
  dungeonReturn,
  edgeBands,
  edgeDirectionAt,
  ensureRegion,
  enterDungeon,
  exitDungeon,
  generateDungeonCtx,
  generateVillage,
  getOrCreateRegion,
  highlandAnchor,
  homeCtx,
  houseFits,
  huntHotspots,
  lakeCx,
  lakeCy,
  lakeRh,
  lakeRw,
  meadowAnchor,
  neighborOf,
  objAt,
  objects,
  onBuildingFinished,
  passable,
  pathTiles,
  pickAnchor,
  pickAnchorGeneric,
  regionsRegistry,
  respawnQueue,
  shoreNoise,
  spawnX,
  spawnY,
  swapAmbientTo,
  tileAt,
  tileGrid,
  travelToRegion,
  trySpawnWildInto,
  updateLocationLabel,
  worldSeed,
  worldSeedBase
};
