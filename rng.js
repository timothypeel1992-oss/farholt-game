/* ============================================================
   engine/rng.js
   Deterministische Zufallshelfer — Grundlage für die gesamte
   prozedurale Erzeugung. Hat selbst keine Abhängigkeiten.
============================================================ */

/* ============================================================
   RNG helpers
============================================================ */
function mulberry32(seed){
  return function(){
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hash2(x,y,seed){
  let n = Math.sin(x*127.1 + y*311.7 + seed*0.0173) * 43758.5453;
  return n - Math.floor(n);
}
function lerp(a,b,t){ return a + (b-a)*t; }
function clamp(v,lo,hi){ return Math.max(lo, Math.min(hi,v)); }
function genId(){ return Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,7); }
const DAY_CYCLE_MS = 600000; // ein voller Tag/Nacht-Zyklus = 10 reale Minuten
const HAIR_SHAPES = ['kurz','lang','pferdeschwanz','dutt','glatze','irokese','zöpfe','afro','pony','lockig','wuschel','seitenscheitel','undercut','wellen','zopfkranz','strubbel'];
const HAIR_STYLE_COUNT = HAIR_SHAPES.length * 3; // 3 Größenvarianten je Schnitt
const OUTFIT_STYLES = ['Robe','Rüstung','Mantel','Kurzjacke'];
const FACE_STYLES = ['Rund','Schmal','Wach','Verschmitzt'];
const HAIR_COLORS = ['#2a2015','#5b4327','#8b5e2f','#d4a94a','#c94f3d','#e8e8e8','#4a3f6b','#3f6b5a'];
const SKIN_COLORS = ['#ffe0bd','#f1c27d','#e0ac69','#c68642','#8d5524','#5a3a22','#f5c9b8','#d9a066'];
const OUTFIT_COLORS = ['#c9822c','#3d6b4f','#5a3d6b','#6b3d3d','#3d5a6b','#8b7355','#4a4a4a','#c94f8f'];

export { DAY_CYCLE_MS, FACE_STYLES, HAIR_COLORS, HAIR_SHAPES, HAIR_STYLE_COUNT, OUTFIT_COLORS, OUTFIT_STYLES, SKIN_COLORS, clamp, genId, hash2, lerp, mulberry32 };
