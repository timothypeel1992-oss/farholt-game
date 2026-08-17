/* ============================================================
   data/species.js
   Kreaturen-Daten und ihre Darstellung: 36 Basis-Arten, drei
   Evolutionsstufen, Körperformen, Muster und Zeichenlogik.

   Braucht von außen nur zwei Helfer — dadurch ist dieses Modul
   nahezu eigenständig.
============================================================ */
import { mulberry32 } from '../engine/rng.js';
import { shadeColor } from '../engine/renderer.js';

/* ============================================================
   Species data (36 creatures, generative visuals)
============================================================ */
/* Dreistufige Paletten: Tiefton für den Schattenkern, Grundton für die
   Fläche, Akzent für Bauch und Lichtkanten. Ergibt harmonische Verläufe
   statt einer einzelnen Grundfarbe. */
const TYPE_PALETTE = {
  Fire:    {deep:'#7a1f14', base:'#d94f2b', accent:'#f7c96b', rim:'#ffb347'},
  Water:   {deep:'#12414f', base:'#2e7d82', accent:'#8fe3dd', rim:'#5fc9d6'},
  Grass:   {deep:'#24471f', base:'#4c7a3d', accent:'#b9d977', rim:'#8fc45a'},
  Electric:{deep:'#7a5a10', base:'#dfae2c', accent:'#fff3a3', rim:'#ffe066'},
  Ice:     {deep:'#3a6b80', base:'#7ec3d6', accent:'#e8f8ff', rim:'#b8ecff'},
  Rock:    {deep:'#3a2a15', base:'#8a6a32', accent:'#e0bd71', rim:'#c49a4e'},
  Poison:  {deep:'#3d1f5c', base:'#7b4fa6', accent:'#d4aef2', rim:'#a878d6'},
  Ghost:   {deep:'#2b2b47', base:'#5a5a8b', accent:'#b9b9e6', rim:'#8f8fd1'},
  Flying:  {deep:'#141c3d', base:'#3b4a8c', accent:'#a9baf0', rim:'#6b7fd1'},
  Bug:     {deep:'#3d4f1c', base:'#7c9a3d', accent:'#d6e88a', rim:'#a8c45e'},
  Normal:  {deep:'#5c4d38', base:'#a8946e', accent:'#e6dbc4', rim:'#c9b795'},
  Dragon:  {deep:'#2c2154', base:'#5b4a9e', accent:'#b49ae8', rim:'#8b6fcf'}
};
const TYPE_COLORS = {
  Fire:['#e8623b','#f2a65a'], Water:['#2e7d82','#7fd1d1'], Grass:['#4c7a3d','#9fcb5a'],
  Electric:['#e0b93d','#fff08a'], Ice:['#7ec3d6','#d4f1f9'], Rock:['#8b7355','#c9b18c'],
  Poison:['#7b4fa6','#c299e8'], Ghost:['#5a5a8b','#a6a6d6'], Flying:['#7fa8d6','#e8f0fa'],
  Bug:['#7c9a3d','#c4d96b'], Normal:['#a8946e','#d9cbb0'], Dragon:['#5b4a9e','#8b6fcf']
};
const BODY=['round','oval','chunky','slender','spiky','hunched','serpent','bulb'];
const EAR=['none','round','pointy','long','fin'];
const TAIL=['none','short','long','fluffy','fin'];
const PATTERN=['plain','spots','stripes','scales','fur','bands','mottled','crag'];
const EYE=['round','sleepy','sharp'];
const LEGS=['stubby','tall','paws','clawed','none'];   // Beinformen
const ARMS=['none','stubby','claws','fins'];            // Armformen

const SPECIES_RAW = [
  ['Twiggling','Grass','common'],['Mossbeak','Grass','common'],['Thornhide','Rock','common'],
  ['Emberkit','Fire','common'],['Cinderfox','Fire','common'],['Ripplet','Water','common'],
  ['Tidefin','Water','common'],['Sparkmite','Electric','common'],['Voltoad','Electric','common'],
  ['Frostkit','Ice','common'],['Pebblet','Rock','common'],['Boulderback','Rock','common'],
  ['Toxipod','Poison','common'],['Wisplet','Ghost','common'],['Featherling','Flying','common'],
  ['Skywisp','Flying','common'],['Beetlenap','Bug','common'],['Chitterbug','Bug','common'],
  ['Furball','Normal','uncommon'],['Duskhare','Normal','uncommon'],['Plainstrider','Normal','uncommon'],
  ['Blazehorn','Fire','uncommon'],['Deepgill','Water','uncommon'],['Stormwing','Electric','uncommon'],
  ['Glacierback','Ice','uncommon'],['Chillowl','Ice','uncommon'],['Cragclaw','Rock','uncommon'],
  ['Spineshroom','Poison','uncommon'],['Gloomoth','Poison','uncommon'],['Hollowmask','Ghost','uncommon'],
  ['Shadewisp','Ghost','uncommon'],['Talonpeak','Flying','uncommon'],['Silkspinner','Bug','uncommon'],
  ['Drakeling','Dragon','rare'],['Wyrmlet','Dragon','rare'],['Stormdrake','Dragon','rare']
];
/* Kampfwerte je Seltenheit.

   Vorher hielt ein gewöhnliches Wesen 9 bis 13 Treffer aus, bei einer
   Schadensformel von atk - def/2 also oft nur zwei Schläge. Kämpfe waren
   damit entschieden, bevor Fähigkeiten oder Gegenstände eine Rolle spielten.

   Lebenspunkte und Rüstung (def) sind deutlich angehoben, der Angriff nur
   maßvoll — Kämpfe dauern länger, treffen aber nicht härter. Wer den ersten
   Schlag verpasst, verliert dadurch nicht sofort. */
const RARITY_CFG = {
  common:{hp:[16,21],atk:[3,5],def:[3,5],spd:[4,10],weight:6,catch:0.45},
  uncommon:{hp:[22,28],atk:[5,7],def:[4,6],spd:[5,12],weight:3,catch:0.30},
  rare:{hp:[30,38],atk:[7,10],def:[6,8],spd:[6,14],weight:1,catch:0.15}
};
function paramsFor(id){
  const r = mulberry32(id*97+13);
  const pick = a => a[Math.floor(r()*a.length)];
  const wings = r()<0.28;
  return {
    body:pick(BODY), ear:pick(EAR), tail:pick(TAIL), wings, pattern:pick(PATTERN), eye:pick(EYE),
    // Flieger schweben (keine Beine), alle anderen bekommen echte Beine
    legs: wings ? 'none' : pick(LEGS.slice(0,4)),
    arms: pick(ARMS)
  };
}
function statsFor(id, rarity){
  const r = mulberry32(id*13+7);
  const c = RARITY_CFG[rarity];
  const rand = (range)=> Math.round(range[0] + r()*(range[1]-range[0]));
  return { hp:rand(c.hp), atk:rand(c.atk), def:rand(c.def), spd:rand(c.spd) };
}
const SPECIES = SPECIES_RAW.map((s,id)=>{
  return { id, name:s[0], type:s[1], rarity:s[2], params: paramsFor(id), stats: statsFor(id,s[2]),
    weight: RARITY_CFG[s[2]].weight, catchBase: RARITY_CFG[s[2]].catch };
});
const EVOLUTION_WINS_NEEDED = 6;
/* ============================================================
   Evolutionen: alle Arten entwickeln sich über drei Stufen.
   Jede Stufe verändert Aussehen, Größe und Merkmale — vorher
   teilten sich alle Stufen dieselben Parameter und sahen gleich aus.
============================================================ */
const EVO_SUFFIX = {
  2: ['Wächter','Streuner','Läufer','Späher','Ranker','Hüter'],
  3: ['Ältester','Urtier','Koloss','Erhabener','Schrecken','Ahn']
};
// Zusätzliche Merkmale, die erst mit der Entwicklung erscheinen
const EVO_FEATURES = {
  2: ['horns','spikes','mane','fins'],
  3: ['bighorns','plates','crest','tusks']
};
(function generateEvolutions(){
  const baseCount = SPECIES.length;
  for(let baseId=0; baseId<baseCount; baseId++){
    const base = SPECIES[baseId];
    let prevId = baseId;
    for(let stage=2; stage<=3; stage++){
      const r = mulberry32(baseId*7919 + stage*104729);
      const mult = stage===2 ? 1.55 : 2.4;
      // Aussehen weiterentwickeln statt kopieren
      const p = Object.assign({}, base.params);
      p.sizeMul = stage===2 ? 1.25 : 1.6;                 // sichtbar größer
      p.feature = EVO_FEATURES[stage][Math.floor(r()*EVO_FEATURES[stage].length)];
      p.shade = stage===2 ? -14 : -28;                     // dunklere, sattere Färbung
      if(stage===2 && p.tail==='none') p.tail='short';     // Anhängsel wachsen nach
      if(stage===3){
        if(p.ear==='none') p.ear='pointy';
        if(p.arms==='none') p.arms='claws';
        if(p.legs==='none' && !p.wings) p.legs='clawed';
      }
      const suffix = EVO_SUFFIX[stage][Math.floor(r()*EVO_SUFFIX[stage].length)];
      const evo = {
        id: SPECIES.length,
        name: base.name + '-' + suffix,
        type: base.type, rarity: base.rarity, params: p,
        stats: { hp:Math.round(base.stats.hp*mult), atk:Math.round(base.stats.atk*mult),
                 def:Math.round(base.stats.def*mult), spd:Math.round(base.stats.spd*(stage===2?1.2:1.35)) },
        weight: 0, catchBase: 0, evolvesFrom: prevId, stage
      };
      SPECIES.push(evo);
      SPECIES[prevId].evolvesTo = evo.id;
      prevId = evo.id;
    }
  }
})();

/* ---------- Battle: type effectiveness & moves ---------- */
const STRONG_AGAINST = {
  Fire:['Grass','Bug','Ice'], Water:['Fire','Rock'], Grass:['Water','Rock'], Electric:['Water','Flying'],
  Ice:['Grass','Flying','Dragon'], Rock:['Fire','Flying','Bug','Ice'], Poison:['Grass','Bug'], Ghost:['Ghost'],
  Flying:['Grass','Bug'], Bug:['Grass','Poison'], Normal:[], Dragon:['Dragon']
};
function typeMultiplier(atkType, defType){
  if((STRONG_AGAINST[atkType]||[]).includes(defType)) return 1.5;
  if((STRONG_AGAINST[defType]||[]).includes(atkType)) return 0.67;
  return 1;
}
const MOVES_BY_TYPE = {
  Fire:[{name:'Funkenstoß',power:1.0,acc:0.95},{name:'Flammenwoge',power:1.5,acc:0.8}],
  Water:[{name:'Wasserstrahl',power:1.0,acc:0.95},{name:'Flutwelle',power:1.5,acc:0.8}],
  Grass:[{name:'Blattschnitt',power:1.0,acc:0.95},{name:'Dornenranken',power:1.5,acc:0.8}],
  Electric:[{name:'Funkenschlag',power:1.0,acc:0.95},{name:'Donnerstoß',power:1.5,acc:0.8}],
  Ice:[{name:'Frostbiss',power:1.0,acc:0.95},{name:'Eislawine',power:1.5,acc:0.75}],
  Rock:[{name:'Steinwurf',power:1.0,acc:0.95},{name:'Felssturz',power:1.5,acc:0.8}],
  Poison:[{name:'Gifthieb',power:1.0,acc:0.95},{name:'Säureschwall',power:1.5,acc:0.8}],
  Ghost:[{name:'Schattenklaue',power:1.0,acc:0.95},{name:'Fluchwelle',power:1.5,acc:0.8}],
  Flying:[{name:'Windstoß',power:1.0,acc:0.95},{name:'Sturzflug',power:1.5,acc:0.8}],
  Bug:[{name:'Stachelschlag',power:1.0,acc:0.95},{name:'Schwarmangriff',power:1.5,acc:0.8}],
  Normal:[{name:'Tackle',power:1.0,acc:0.98},{name:'Vollgas',power:1.4,acc:0.85}],
  Dragon:[{name:'Drachenzahn',power:1.1,acc:0.92},{name:'Drachenzorn',power:1.6,acc:0.75}]
};

/* ---------- Monster rendering (procedural vector creature) ---------- */
/* ============================================================
   Körperformen der Monster
   Organische Silhouetten mit Bézier-Kurven statt schlichter
   Ellipsen — jede Form hat einen eigenen Umriss.
============================================================ */
function bodyPath(ctx, shape, s){
  ctx.beginPath();
  if(shape==='round'){
    // gedrungen und weich, unten etwas breiter
    ctx.moveTo(0,-s*0.44);
    ctx.bezierCurveTo(s*0.34,-s*0.46, s*0.48,-s*0.14, s*0.44,s*0.14);
    ctx.bezierCurveTo(s*0.41,s*0.42, s*0.2,s*0.5, 0,s*0.48);
    ctx.bezierCurveTo(-s*0.2,s*0.5, -s*0.41,s*0.42, -s*0.44,s*0.14);
    ctx.bezierCurveTo(-s*0.48,-s*0.14, -s*0.34,-s*0.46, 0,-s*0.44);
    ctx.closePath();
  } else if(shape==='oval'){
    // breit und flach, wie ein liegender Rumpf
    ctx.moveTo(-s*0.52,0);
    ctx.bezierCurveTo(-s*0.5,-s*0.34, -s*0.2,-s*0.42, s*0.06,-s*0.38);
    ctx.bezierCurveTo(s*0.36,-s*0.34, s*0.54,-s*0.16, s*0.52,s*0.04);
    ctx.bezierCurveTo(s*0.5,s*0.3, s*0.24,s*0.42, -s*0.04,s*0.4);
    ctx.bezierCurveTo(-s*0.32,s*0.38, -s*0.52,s*0.24, -s*0.52,0);
    ctx.closePath();
  } else if(shape==='slender'){
    // hoch und schmal, oben verjüngt
    ctx.moveTo(0,-s*0.52);
    ctx.bezierCurveTo(s*0.22,-s*0.5, s*0.34,-s*0.2, s*0.32,s*0.1);
    ctx.bezierCurveTo(s*0.3,s*0.4, s*0.16,s*0.52, 0,s*0.5);
    ctx.bezierCurveTo(-s*0.16,s*0.52, -s*0.3,s*0.4, -s*0.32,s*0.1);
    ctx.bezierCurveTo(-s*0.34,-s*0.2, -s*0.22,-s*0.5, 0,-s*0.52);
    ctx.closePath();
  } else if(shape==='chunky'){
    // massiger Block mit weichen Ecken und schwerer Unterseite
    ctx.moveTo(-s*0.44,-s*0.3);
    ctx.bezierCurveTo(-s*0.4,-s*0.44, s*0.4,-s*0.44, s*0.44,-s*0.3);
    ctx.bezierCurveTo(s*0.54,-s*0.06, s*0.54,s*0.24, s*0.42,s*0.38);
    ctx.bezierCurveTo(s*0.2,s*0.5, -s*0.2,s*0.5, -s*0.42,s*0.38);
    ctx.bezierCurveTo(-s*0.54,s*0.24, -s*0.54,-s*0.06, -s*0.44,-s*0.3);
    ctx.closePath();
  } else if(shape==='spiky'){
    // gezackter Umriss aus abwechselnd langen und kurzen Spitzen
    const n=11;
    for(let i=0;i<=n;i++){
      const a=(i/n)*Math.PI*2 - Math.PI/2;
      const r=s*(i%2===0 ? 0.5 : 0.34);
      const px=Math.cos(a)*r, py=Math.sin(a)*r*0.9;
      if(i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }
    ctx.closePath();
  } else if(shape==='hunched'){
    // gebeugter Rücken, Kopf nach vorn geneigt
    ctx.moveTo(-s*0.42,s*0.3);
    ctx.bezierCurveTo(-s*0.5,-s*0.06, -s*0.32,-s*0.44, s*0.02,-s*0.42);
    ctx.bezierCurveTo(s*0.3,-s*0.4, s*0.5,-s*0.18, s*0.46,s*0.1);
    ctx.bezierCurveTo(s*0.44,s*0.36, s*0.24,s*0.46, s*0.02,s*0.44);
    ctx.bezierCurveTo(-s*0.18,s*0.42, -s*0.34,s*0.4, -s*0.42,s*0.3);
    ctx.closePath();
  } else if(shape==='serpent'){
    // langgezogen und geschwungen wie ein Leib
    ctx.moveTo(-s*0.5,s*0.1);
    ctx.bezierCurveTo(-s*0.46,-s*0.28, -s*0.1,-s*0.42, s*0.14,-s*0.3);
    ctx.bezierCurveTo(s*0.42,-s*0.16, s*0.52,s*0.06, s*0.44,s*0.24);
    ctx.bezierCurveTo(s*0.34,s*0.44, s*0.02,s*0.46, -s*0.16,s*0.36);
    ctx.bezierCurveTo(-s*0.34,s*0.28, -s*0.5,s*0.26, -s*0.5,s*0.1);
    ctx.closePath();
  } else if(shape==='bulb'){
    // schmaler Kopf, ausladender Unterleib
    ctx.moveTo(0,-s*0.46);
    ctx.bezierCurveTo(s*0.18,-s*0.46, s*0.24,-s*0.2, s*0.28,-s*0.04);
    ctx.bezierCurveTo(s*0.52,s*0.06, s*0.56,s*0.34, s*0.28,s*0.46);
    ctx.bezierCurveTo(s*0.1,s*0.53, -s*0.1,s*0.53, -s*0.28,s*0.46);
    ctx.bezierCurveTo(-s*0.56,s*0.34, -s*0.52,s*0.06, -s*0.28,-s*0.04);
    ctx.bezierCurveTo(-s*0.24,-s*0.2, -s*0.18,-s*0.46, 0,-s*0.46);
    ctx.closePath();
  } else {
    ctx.ellipse(0,0,s*0.42,s*0.4,0,0,Math.PI*2);
  }
}
// Optische Kennzeichnung der Seltenheitsstufen (Aura + Größe)
const RARITY_AURA = {
  uncommon:{ rgb:'120,205,255', r:20 },   // kühles Blau
  rare:    { rgb:'246,196,74',  r:25 }    // goldener Schimmer
};
const RARITY_SIZE = { common:26, uncommon:29, rare:33 };
function drawMonster(ctx, cx, cy, s, species, caught, hpFrac, anim){
  const p = species.params;
  // Entwicklungsstufe wirkt auf Größe und Färbung
  s = s * (p.sizeMul || 1);
  let colors = caught ? TYPE_COLORS[species.type] : ['#8b8b83','#c2c2b8'];
  if(caught && p.shade) colors = [shadeColor(colors[0], p.shade), shadeColor(colors[1], p.shade)];
  const now = performance.now();
  // sanfte Idle-/Lauf-Animation: Beine wippen, Flieger schweben auf und ab
  const gait = Math.sin(now/(anim==='walk'?170:420) + species.id*1.7);
  const hover = p.wings ? Math.sin(now/520 + species.id)*s*0.05 : 0;
  ctx.save(); ctx.translate(cx, cy + hover);
  ctx.lineWidth = Math.max(1.6, s*0.05);
  ctx.strokeStyle = caught ? '#26261f' : '#6b6b62';
  // --- Beine (hinter dem Körper) ---
  if(p.legs && p.legs!=='none'){
    const legCol = shadeColor(colors[0], -18);
    const hipY = s*0.22;
    const conf = {
      stubby:{len:s*0.20, w:s*0.11, spread:0.26, foot:s*0.09},
      tall:  {len:s*0.34, w:s*0.075, spread:0.22, foot:s*0.10},
      paws:  {len:s*0.22, w:s*0.13, spread:0.30, foot:s*0.13},
      clawed:{len:s*0.26, w:s*0.09, spread:0.28, foot:s*0.11}
    }[p.legs];
    // Hinterbeine etwas dunkler und leicht versetzt -> räumliche Tiefe
    [{side:-1,back:true},{side:1,back:true},{side:-1,back:false},{side:1,back:false}].forEach((L,i)=>{
      const swing = gait * (L.back ? -1 : 1) * (L.side>0 ? 1 : -1) * s*0.07;
      const lx = L.side*s*conf.spread + (L.back ? L.side*s*0.06 : 0);
      const ly = hipY + (L.back ? -s*0.02 : 0);
      ctx.fillStyle = L.back ? shadeColor(legCol,-14) : legCol;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(lx-conf.w/2, ly, conf.w, conf.len+swing, conf.w*0.5)
                    : ctx.rect(lx-conf.w/2, ly, conf.w, conf.len+swing);
      ctx.fill(); ctx.stroke();
      // Pfote / Kralle am Fußende
      const fy = ly + conf.len + swing;
      ctx.beginPath();
      if(p.legs==='clawed'){
        ctx.moveTo(lx-conf.foot*0.5, fy);
        ctx.lineTo(lx+conf.foot*0.6, fy);
        ctx.lineTo(lx+conf.foot*0.2, fy+conf.foot*0.45);
        ctx.closePath();
      } else {
        ctx.ellipse(lx, fy, conf.foot*0.55, conf.foot*0.38, 0, 0, Math.PI*2);
      }
      ctx.fill(); ctx.stroke();
    });
  }
  if(p.tail!=='none'){
    ctx.fillStyle = colors[0]; ctx.beginPath();
    if(p.tail==='short'){ ctx.ellipse(s*0.4,s*0.1,s*0.12,s*0.08,0.5,0,Math.PI*2); }
    else if(p.tail==='long'){ ctx.ellipse(s*0.5,s*0.05,s*0.22,s*0.06,0.4,0,Math.PI*2); }
    else if(p.tail==='fluffy'){ ctx.ellipse(s*0.46,s*0.02,s*0.18,s*0.16,0.3,0,Math.PI*2); }
    else { ctx.moveTo(s*0.35,0); ctx.quadraticCurveTo(s*0.6,s*0.05,s*0.55,-s*0.2); ctx.quadraticCurveTo(s*0.45,-s*0.05,s*0.35,0); }
    ctx.fill(); ctx.stroke();
  }
  if(p.wings){
    ctx.fillStyle = colors[1];
    [-1,1].forEach(side=>{
      ctx.beginPath(); ctx.ellipse(side*s*0.32, -s*0.05, s*0.22, s*0.32, side*0.5, 0, Math.PI*2);
      ctx.fill(); ctx.globalAlpha=0.9; ctx.stroke(); ctx.globalAlpha=1;
    });
  }
  /* --- Verschmolzene Silhouette: Rumpf, Kopf, Ohren, Flügel, Glieder
     und Schwanz bilden EINE Kontur statt gestapelter Einzelformen. --- */
  // Klar definierte Grundform statt Metaball-Verschmelzung: Die
  // verschmolzenen Konturen wurden unlesbar und verzogen den Körper.
  const shapePath = ()=>{ bodyPath(ctx, p.body, s); };
  /* --- Volumen durch mehrstufigen Verlauf statt flacher Fläche.
     Tiefton außen, Grundton in der Fläche, Akzent im Lichtbereich —
     erzeugt den Eindruck von durchscheinendem Körper. --- */
  const pal = (caught && TYPE_PALETTE[species.type]) ? TYPE_PALETTE[species.type]
              : {deep:'#4a4a44', base:'#8b8b83', accent:'#c2c2b8', rim:'#a5a59c'};
  const bodyGrad = ctx.createRadialGradient(-s*0.16, -s*0.20, s*0.05, 0, s*0.06, s*0.62);
  bodyGrad.addColorStop(0,   shadeColor(pal.accent, 8));
  bodyGrad.addColorStop(0.32, pal.base);
  bodyGrad.addColorStop(0.78, shadeColor(pal.base, -18));
  bodyGrad.addColorStop(1,   pal.deep);
  ctx.fillStyle = bodyGrad; shapePath(); ctx.fill(); ctx.stroke();
  ctx.save();
  shapePath(); ctx.clip();
  // Streulicht am unteren Rand — wirkt wie durchscheinendes Gewebe
  const sss = ctx.createRadialGradient(0, s*0.34, s*0.02, 0, s*0.34, s*0.46);
  sss.addColorStop(0, pal.rim); sss.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalAlpha = 0.30; ctx.fillStyle = sss; ctx.fillRect(-s,-s,s*2,s*2);
  ctx.globalAlpha = 1;
  const belly = ctx.createRadialGradient(0, s*0.22, s*0.05, 0, s*0.2, s*0.5);
  belly.addColorStop(0, colors[1]); belly.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalAlpha = 0.55; ctx.fillStyle = belly;
  ctx.fillRect(-s, -s, s*2, s*2);
  // Lichtkante oben links
  ctx.globalAlpha = 0.28;
  const rim = ctx.createLinearGradient(-s*0.4, -s*0.5, s*0.1, s*0.1);
  rim.addColorStop(0, 'rgba(255,255,255,.9)'); rim.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = rim; ctx.fillRect(-s, -s, s*2, s*2);
  // Schattenseite unten rechts
  ctx.globalAlpha = 0.22;
  const shd = ctx.createLinearGradient(s*0.1, s*0.1, s*0.5, s*0.5);
  shd.addColorStop(0, 'rgba(0,0,0,0)'); shd.addColorStop(1, 'rgba(0,0,0,.85)');
  ctx.fillStyle = shd; ctx.fillRect(-s, -s, s*2, s*2);
  ctx.restore();
  // --- Merkmale der Entwicklungsstufen ---
  if(p.feature){
    const dark = shadeColor(colors[0], -35), light = shadeColor(colors[1], 20);
    ctx.lineWidth = Math.max(1.2, s*0.04);
    if(p.feature==='horns' || p.feature==='bighorns'){
      const hl = p.feature==='bighorns' ? s*0.34 : s*0.2;
      ctx.fillStyle = light; ctx.strokeStyle = dark;
      [-1,1].forEach(side=>{
        ctx.beginPath();
        ctx.moveTo(side*s*0.2, -s*0.34);
        ctx.quadraticCurveTo(side*s*0.34, -s*0.34-hl, side*s*0.16, -s*0.34-hl*1.15);
        ctx.quadraticCurveTo(side*s*0.24, -s*0.34-hl*0.5, side*s*0.1, -s*0.3);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      });
    } else if(p.feature==='spikes' || p.feature==='crest'){
      const n = p.feature==='crest' ? 5 : 3;
      ctx.fillStyle = light; ctx.strokeStyle = dark;
      for(let i=0;i<n;i++){
        const t=(i-(n-1)/2)*s*0.13;
        ctx.beginPath();
        ctx.moveTo(t-s*0.05, -s*0.32); ctx.lineTo(t, -s*0.32-s*(0.16+ (p.feature==='crest'?0.1:0)));
        ctx.lineTo(t+s*0.05, -s*0.32); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    } else if(p.feature==='mane'){
      ctx.fillStyle = shadeColor(colors[1], -10);
      for(let i=0;i<9;i++){
        const a = Math.PI + (i/8)*Math.PI;
        ctx.beginPath();
        ctx.ellipse(Math.cos(a)*s*0.36, -s*0.05+Math.sin(a)*s*0.3, s*0.1, s*0.06, a, 0, Math.PI*2);
        ctx.fill();
      }
    } else if(p.feature==='plates'){
      ctx.fillStyle = light; ctx.strokeStyle = dark;
      for(let i=0;i<3;i++){
        ctx.beginPath();
        ctx.ellipse(0, -s*0.2+i*s*0.16, s*(0.3-i*0.05), s*0.07, 0, 0, Math.PI*2);
        ctx.fill(); ctx.stroke();
      }
    } else if(p.feature==='tusks'){
      ctx.fillStyle = '#efe6cd'; ctx.strokeStyle = dark;
      [-1,1].forEach(side=>{
        ctx.beginPath();
        ctx.moveTo(side*s*0.14, s*0.06);
        ctx.quadraticCurveTo(side*s*0.26, s*0.16, side*s*0.2, s*0.28);
        ctx.quadraticCurveTo(side*s*0.16, s*0.14, side*s*0.1, s*0.08);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      });
    } else if(p.feature==='fins'){
      ctx.fillStyle = shadeColor(colors[1], 12); ctx.strokeStyle = dark;
      [-1,1].forEach(side=>{
        ctx.beginPath();
        ctx.moveTo(side*s*0.3, -s*0.05);
        ctx.quadraticCurveTo(side*s*0.5, -s*0.22, side*s*0.42, s*0.1);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      });
    }
    ctx.lineWidth = Math.max(1.6, s*0.05);
  }
  // --- Arme (vor dem Körper) ---
  if(p.arms && p.arms!=='none'){
    const armCol = colors[0];
    [-1,1].forEach(side=>{
      const swing = gait * side * s*0.06;
      const ax = side*s*0.30, ay = s*0.02;
      ctx.fillStyle = armCol;
      ctx.beginPath();
      if(p.arms==='stubby'){
        ctx.ellipse(ax, ay+swing*0.5, s*0.075, s*0.13, side*0.25, 0, Math.PI*2);
        ctx.fill(); ctx.stroke();
      } else if(p.arms==='claws'){
        ctx.ellipse(ax, ay+swing*0.5, s*0.07, s*0.15, side*0.3, 0, Math.PI*2);
        ctx.fill(); ctx.stroke();
        // drei kleine Krallen
        ctx.beginPath();
        for(let k=-1;k<=1;k++){
          const kx = ax + side*s*0.05 + k*s*0.035, ky = ay+swing*0.5 + s*0.15;
          ctx.moveTo(kx, ky); ctx.lineTo(kx + side*s*0.03, ky + s*0.06);
        }
        ctx.lineWidth = Math.max(1, s*0.028); ctx.stroke();
        ctx.lineWidth = Math.max(1.6, s*0.05);
      } else if(p.arms==='fins'){
        ctx.ellipse(ax + side*s*0.04, ay+swing*0.4, s*0.055, s*0.19, side*0.55, 0, Math.PI*2);
        ctx.fill(); ctx.stroke();
      }
    });
  }
  ctx.fillStyle='rgba(255,255,255,.18)';
  ctx.beginPath(); ctx.ellipse(-s*0.15,-s*0.24,s*0.2,s*0.15,0,0,Math.PI*2); ctx.fill();
  if(p.body==='spiky'){
    ctx.fillStyle = colors[0];
    for(let i=-1;i<=1;i++){
      ctx.beginPath(); ctx.moveTo(i*s*0.14, -s*0.32); ctx.lineTo(i*s*0.14 - s*0.06, -s*0.5); ctx.lineTo(i*s*0.14 + s*0.06, -s*0.5);
      ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  }
  // Muster folgen der verschmolzenen Form, nicht mehr einer starren Ellipse
  ctx.save();
  bodyPath(ctx, p.body, s);
  ctx.clip();
  ctx.fillStyle = colors[1];
  if(p.pattern==='spots'){
    const r2 = mulberry32(species.id*5+2);
    for(let i=0;i<5;i++){ ctx.beginPath(); ctx.arc((r2()-0.5)*s*0.7,(r2()-0.5)*s*0.6, s*0.06+r2()*s*0.04, 0, Math.PI*2); ctx.fill(); }
  } else if(p.pattern==='stripes'){
    for(let i=-2;i<=2;i++){ ctx.fillRect(-s*0.6, i*s*0.14 - s*0.03, s*1.2, s*0.06); }
  } else if(p.pattern==='scales'){
    /* Echte Schuppen: einzeln gezeichnete Plättchen mit eigener Kontur,
       Lichtkante und Schattenrand — der Körper wirkt zusammengesetzt,
       nicht bemalt. Reihen folgen der Körperwölbung. */
    const sw = s*0.15, sh2 = s*0.13;
    for(let row=-3; row<=3; row++){
      const ry = row*sh2*0.82;
      // Reihen weiter außen sind schmaler — folgt der Rundung
      const bow = 1 - Math.pow(Math.abs(ry)/(s*0.5), 2)*0.35;
      const off = (row%2===0) ? 0 : sw*0.5;
      for(let col=-4; col<=4; col++){
        const px = col*sw*bow + off, py = ry + Math.abs(col)*s*0.012;
        ctx.beginPath();
        ctx.moveTo(px - sw*0.46, py);
        ctx.quadraticCurveTo(px - sw*0.44, py + sh2*0.62, px, py + sh2*0.7);
        ctx.quadraticCurveTo(px + sw*0.44, py + sh2*0.62, px + sw*0.46, py);
        ctx.quadraticCurveTo(px, py - sh2*0.28, px - sw*0.46, py);
        ctx.closePath();
        ctx.fillStyle = pal.base; ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.28)'; ctx.lineWidth = Math.max(0.5, s*0.012); ctx.stroke();
        // Glanz auf der oberen Hälfte jeder Schuppe
        ctx.fillStyle = 'rgba(255,255,255,.18)';
        ctx.beginPath();
        ctx.ellipse(px, py + sh2*0.16, sw*0.30, sh2*0.18, 0, 0, Math.PI*2); ctx.fill();
      }
    }
    ctx.fillStyle = colors[1];
  } else if(p.pattern==='fur'){
    /* Fell aus geschwungenen Büscheln statt gerader Striche:
       jedes Büschel folgt der Wuchsrichtung nach unten außen. */
    const r3 = mulberry32(species.id*11+7);
    ctx.lineCap = 'round';
    for(let i=0;i<26;i++){
      const px=(r3()-0.5)*s*0.95, py=(r3()-0.5)*s*0.9;
      const len = s*(0.09 + r3()*0.07);
      const dir = Math.atan2(py + s*0.25, px) + (r3()-0.5)*0.5;
      const ex = px + Math.cos(dir)*len, ey = py + Math.sin(dir)*len;
      // Schattenlinie
      ctx.strokeStyle = 'rgba(0,0,0,.22)';
      ctx.lineWidth = Math.max(1, s*0.030);
      ctx.beginPath(); ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + Math.cos(dir-0.5)*len*0.6, py + Math.sin(dir-0.5)*len*0.6, ex, ey);
      ctx.stroke();
      // helle Spitze darüber
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = Math.max(0.7, s*0.018);
      ctx.beginPath(); ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + Math.cos(dir-0.5)*len*0.6, py + Math.sin(dir-0.5)*len*0.6, ex, ey);
      ctx.stroke();
    }
    ctx.fillStyle = colors[1];
  } else if(p.pattern==='crag'){
    /* Rissige Gesteinsoberfläche: verzweigte Spalten mit Tiefenschatten
       und heller Bruchkante, ausgehend vom Körperzentrum. */
    const r5 = mulberry32(species.id*23+5);
    for(let i=0;i<6;i++){
      let px = (r5()-0.5)*s*0.5, py = (r5()-0.5)*s*0.5;
      let ang = r5()*Math.PI*2;
      const seg = 3 + Math.floor(r5()*3);
      const pts=[[px,py]];
      for(let k=0;k<seg;k++){
        ang += (r5()-0.5)*1.5;
        const len = s*(0.07 + r5()*0.09);
        px += Math.cos(ang)*len; py += Math.sin(ang)*len;
        pts.push([px,py]);
      }
      // Tiefenschatten der Spalte
      ctx.strokeStyle='rgba(0,0,0,.42)'; ctx.lineWidth=Math.max(1, s*0.028); ctx.lineJoin='round';
      ctx.beginPath(); ctx.moveTo(pts[0][0],pts[0][1]);
      for(let k=1;k<pts.length;k++) ctx.lineTo(pts[k][0],pts[k][1]);
      ctx.stroke();
      // helle Bruchkante leicht versetzt
      ctx.strokeStyle=pal.accent; ctx.lineWidth=Math.max(0.6, s*0.013);
      ctx.beginPath(); ctx.moveTo(pts[0][0]+s*0.012, pts[0][1]-s*0.012);
      for(let k=1;k<pts.length;k++) ctx.lineTo(pts[k][0]+s*0.012, pts[k][1]-s*0.012);
      ctx.stroke();
    }
    // vereinzelte Gesteinsplatten heben sich ab
    for(let i=0;i<4;i++){
      const px=(r5()-0.5)*s*0.7, py=(r5()-0.5)*s*0.65, w2=s*(0.10+r5()*0.08);
      ctx.fillStyle='rgba(255,255,255,.10)';
      ctx.beginPath();
      ctx.moveTo(px-w2, py); ctx.lineTo(px-w2*0.3, py-w2*0.7);
      ctx.lineTo(px+w2*0.8, py-w2*0.2); ctx.lineTo(px+w2*0.2, py+w2*0.6);
      ctx.closePath(); ctx.fill();
    }
    ctx.fillStyle = colors[1];
  } else if(p.pattern==='bands'){
    // breite Querbänder mit weichen Rändern
    for(let i=-1;i<=1;i++){
      ctx.beginPath();
      ctx.ellipse(0, i*s*0.26, s*0.5, s*0.075, 0, 0, Math.PI*2);
      ctx.fill();
    }
  } else if(p.pattern==='mottled'){
    // unregelmäßige Flecken unterschiedlicher Größe
    const r4 = mulberry32(species.id*17+3);
    for(let i=0;i<8;i++){
      const px=(r4()-0.5)*s*0.8, py=(r4()-0.5)*s*0.75;
      ctx.beginPath();
      ctx.ellipse(px, py, s*(0.04+r4()*0.07), s*(0.03+r4()*0.05), r4()*3, 0, Math.PI*2);
      ctx.fill();
    }
  }
  ctx.restore();
  if(p.ear!=='none'){
    ctx.fillStyle = colors[0];
    [-1,1].forEach(side=>{
      ctx.beginPath();
      if(p.ear==='round'){ ctx.ellipse(side*s*0.22,-s*0.38,s*0.09,s*0.11,0,0,Math.PI*2); }
      else if(p.ear==='pointy'){ ctx.moveTo(side*s*0.14,-s*0.32); ctx.lineTo(side*s*0.28,-s*0.58); ctx.lineTo(side*s*0.32,-s*0.28); ctx.closePath(); }
      else if(p.ear==='long'){ ctx.ellipse(side*s*0.16,-s*0.5,s*0.06,s*0.22,side*0.2,0,Math.PI*2); }
      else { ctx.ellipse(side*s*0.24,-s*0.3,s*0.1,s*0.16,side*0.6,0,Math.PI*2); }
      ctx.fill(); ctx.stroke();
    });
  }
  /* --- Augen: sitzen in der Kopfpartie, nicht mitten im Rumpf.
     Saubere Kontur in Körperlinienstärke, Blickrichtung je Augentyp. --- */
  const headTop = (p.body==='slender'||p.body==='bulb') ? -0.34 : -0.26;
  const eyeY = s*(headTop + 0.06);
  const eyeGap = s*(p.body==='slender' ? 0.13 : 0.16);
  const lw = Math.max(1, s*0.028);
  /* Blick nach Element: Feuer, Drache, Gestein und Gift wirken bedrohlich,
     Pflanze, Normal und Flug freundlich. Verhindert, dass alles niedlich aussieht. */
  const FIERCE = ['Fire','Dragon','Rock','Poison','Ghost'];
  const fierce = FIERCE.includes(species.type);
  [-1,1].forEach(side=>{
    const ex = side*eyeGap;
    // Augapfel — bei müden Augen flacher, bei scharfen schmaler
    const rx = p.eye==='sharp' ? s*0.085 : s*0.095;
    const ry = p.eye==='sleepy' ? s*0.05 : (p.eye==='sharp' ? s*0.075 : s*0.095);
    ctx.beginPath();
    ctx.ellipse(ex, eyeY, rx, ry, 0, 0, Math.PI*2);
    ctx.fillStyle = caught ? '#f4f2ea' : '#cfcdc4';
    ctx.fill();
    if(caught){
      ctx.strokeStyle = '#26261f'; ctx.lineWidth = lw; ctx.stroke();
      // Pupille, leicht nach vorn versetzt für lebendigen Blick
      ctx.fillStyle = '#1c241c';
      ctx.beginPath();
      if(p.eye==='sharp'){
        ctx.ellipse(ex + side*s*0.015, eyeY, s*0.032, s*0.055, 0, 0, Math.PI*2);
      } else {
        ctx.arc(ex + side*s*0.012, eyeY + s*0.008, s*0.042, 0, Math.PI*2);
      }
      ctx.fill();
      // Glanzpunkt
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath(); ctx.arc(ex - s*0.025, eyeY - s*0.028, s*0.016, 0, Math.PI*2); ctx.fill();
      // Bei bedrohlichen Arten glüht die Pupille und die Braue senkt sich
      if(fierce){
        const glow = ctx.createRadialGradient(ex, eyeY, 0, ex, eyeY, rx*1.4);
        glow.addColorStop(0, pal.rim); glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.save(); ctx.globalAlpha = 0.55; ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(ex, eyeY, rx*1.4, 0, Math.PI*2); ctx.fill(); ctx.restore();
        // zusammengekniffenes Lid von oben
        ctx.fillStyle = '#26261f';
        ctx.beginPath();
        ctx.moveTo(ex - rx*1.1, eyeY - ry*1.1);
        ctx.lineTo(ex + rx*1.1, eyeY - ry*(side>0 ? 0.15 : 0.75));
        ctx.lineTo(ex + rx*1.1, eyeY - ry*1.2);
        ctx.lineTo(ex - rx*1.1, eyeY - ry*1.2);
        ctx.closePath(); ctx.fill();
        // gesenkte Braue
        ctx.strokeStyle = '#1c1c16'; ctx.lineWidth = lw*1.5; ctx.lineCap='round';
        ctx.beginPath();
        ctx.moveTo(ex - side*rx*1.25, eyeY - ry*1.75);
        ctx.lineTo(ex + side*rx*1.15, eyeY - ry*1.15);
        ctx.stroke();
      }
      // Lidstrich gibt dem Blick Ausdruck
      ctx.strokeStyle = '#26261f'; ctx.lineWidth = lw*0.9; ctx.lineCap='round';
      ctx.beginPath();
      if(fierce){
        ctx.moveTo(ex - rx*1.05, eyeY - ry*1.1);
        ctx.quadraticCurveTo(ex, eyeY - ry*1.25, ex + rx*1.05, eyeY - ry*0.5);
      } else if(p.eye==='sleepy'){
        ctx.moveTo(ex - rx, eyeY - ry*0.2);
        ctx.quadraticCurveTo(ex, eyeY - ry*1.3, ex + rx, eyeY - ry*0.2);
      } else if(p.eye==='sharp'){
        ctx.moveTo(ex - rx*1.05, eyeY - ry*0.9);
        ctx.quadraticCurveTo(ex, eyeY - ry*1.5, ex + rx*1.05, eyeY - ry*0.55);
      } else {
        ctx.moveTo(ex - rx*0.9, eyeY - ry*1.05);
        ctx.quadraticCurveTo(ex, eyeY - ry*1.35, ex + rx*0.9, eyeY - ry*1.05);
      }
      ctx.stroke();
    }
  });
  ctx.restore();
  if(caught && hpFrac!==undefined && hpFrac<0.3){
    ctx.save(); ctx.globalAlpha=0.25; ctx.fillStyle='#000'; ctx.beginPath();
    ctx.arc(cx,cy,s*0.55,0,Math.PI*2); ctx.fill(); ctx.restore();
  }
}

export {
  SPECIES,
  SPECIES_RAW,
  TYPE_COLORS,
  TYPE_PALETTE,
  MOVES_BY_TYPE,
  STRONG_AGAINST,
  typeMultiplier,
  RARITY_CFG,
  RARITY_AURA,
  RARITY_SIZE,
  EVOLUTION_WINS_NEEDED,
  BODY,
  EAR,
  TAIL,
  PATTERN,
  EYE,
  LEGS,
  ARMS,
  paramsFor,
  statsFor,
  bodyPath,
  drawMonster
};
