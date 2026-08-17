import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'fs';
import path from 'path';

const ROOT = '/home/claude/game';

// --- 2D-Kontext-Attrappe: alles no-op, Zahlen zurueck wo noetig ---
function makeCtx(){
  const grad = { addColorStop(){}, };
  const target = {
    canvas: null, fillStyle:'#000', strokeStyle:'#000', lineWidth:1, globalAlpha:1,
    font:'10px sans-serif', textAlign:'left', textBaseline:'alphabetic',
    globalCompositeOperation:'source-over', lineCap:'butt', lineJoin:'miter',
    shadowBlur:0, shadowColor:'#000', filter:'none', imageSmoothingEnabled:true,
    __calls: {}, __texts: [], __rects: [], __log: [], __stack: [], __clip: false,
    measureText(){ return { width: 10 }; },
    createLinearGradient(){ return grad; },
    createRadialGradient(){ return grad; },
    createPattern(){ return null; },
    getImageData(){ return { data:new Uint8ClampedArray(4), width:1, height:1 }; },
    createImageData(){ return { data:new Uint8ClampedArray(4), width:1, height:1 }; },
  };
  return new Proxy(target, {
    get(t, k){
      if(k === 'fillText') return (txt)=>{ t.__texts.push(String(txt)); t.__log.push(['fillText',String(txt),t.fillStyle,t.globalAlpha]); t.__calls.fillText=(t.__calls.fillText||0)+1; };
      if(k === 'fill') return ()=>{ t.__log.push(['fill','',t.fillStyle,t.globalAlpha]); t.__calls.fill=(t.__calls.fill||0)+1; };
      if(k === 'save') return ()=>{ t.__stack.push([t.fillStyle,t.globalAlpha,t.__clip]); t.__calls.save=(t.__calls.save||0)+1; };
      if(k === 'restore') return ()=>{ const v=t.__stack.pop(); if(v){ t.fillStyle=v[0]; t.globalAlpha=v[1]; t.__clip=v[2]; } t.__calls.restore=(t.__calls.restore||0)+1; };
      if(k === 'clip') return ()=>{ t.__clip = true; t.__calls.clip=(t.__calls.clip||0)+1; };
      if(k === 'fillRect' || k === 'strokeRect') return (x,y,ww,hh)=>{ t.__rects.push([k,x,y,ww,hh,!!t.__clip]); t.__calls[k]=(t.__calls[k]||0)+1; };
      if(k in t) return t[k];
      return (...a)=>{ t.__calls[k]=(t.__calls[k]||0)+1; };
    },
    set(t, k, v){ t[k] = v; return true; }
  });
}

const virtualConsole = new VirtualConsole();
const errors = [];
virtualConsole.on('jsdomError', e => errors.push('[jsdomError] ' + (e.detail || e.message)));
virtualConsole.on('error', (...a) => errors.push('[console.error] ' + a.map(String).join(' ')));
virtualConsole.on('warn', () => {});
virtualConsole.on('log', (...a) => console.log('   game>', ...a));

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'dangerously',
  resources: undefined,
  pretendToBeVisual: true,
  virtualConsole,
});

const w = dom.window;

// Canvas-Kontext bereitstellen (jsdom liefert ohne node-canvas null)
w.HTMLCanvasElement.prototype.getContext = function(){
  if(!this.__ctx){ this.__ctx = makeCtx(); this.__ctx.canvas = this; }
  return this.__ctx;
};
// Web Audio Attrappe
class FakeParam { constructor(){ this.value = 0; } setValueAtTime(){return this;} linearRampToValueAtTime(){return this;} exponentialRampToValueAtTime(){return this;} setTargetAtTime(){return this;} cancelScheduledValues(){return this;} }
function fakeNode(){
  return new Proxy({ gain:new FakeParam(), frequency:new FakeParam(), detune:new FakeParam(),
                     Q:new FakeParam(), type:'sine', buffer:null, playbackRate:new FakeParam() }, {
    get(t,k){ if(k in t) return t[k]; return ()=>fakeNode(); },
    set(t,k,v){ t[k]=v; return true; }
  });
}
w.AudioContext = class {
  constructor(){ this.currentTime = 0; this.sampleRate = 44100; this.destination = fakeNode(); this.state='running'; }
  createGain(){ return fakeNode(); } createOscillator(){ return fakeNode(); }
  createBiquadFilter(){ return fakeNode(); } createConvolver(){ return fakeNode(); }
  createBufferSource(){ return fakeNode(); } createDynamicsCompressor(){ return fakeNode(); }
  createStereoPanner(){ return fakeNode(); } createDelay(){ return fakeNode(); }
  createBuffer(ch,len){ return { getChannelData(){ return new Float32Array(len); }, length:len }; }
  resume(){ return Promise.resolve(); }
};
w.webkitAudioContext = w.AudioContext;

// storage-API der Artefakt-Umgebung
const mem = new Map();
w.storage = {
  async get(k){ return mem.has(k) ? { key:k, value:mem.get(k) } : null; },
  async set(k,v){ mem.set(k,v); return { key:k, value:v }; },
  async delete(k){ mem.delete(k); return { key:k, deleted:true }; },
  async list(){ return { keys:[...mem.keys()] }; },
};

// rAF zaehlen statt endlos laufen lassen
let frames = 0;
let MAX = 100000;
w.requestAnimationFrame = (cb) => {
  if(frames++ > MAX) return 0;
  return setTimeout(()=>{ try{ cb(Date.now()); }catch(e){ errors.push('[rAF] '+e.stack); } }, 0);
};
w.cancelAnimationFrame = (id) => clearTimeout(id);

// Module von Hand laden (jsdom kann keine ES-Module-Imports aufloesen)
const { pathToFileURL } = await import('url');
const mainURL = pathToFileURL(path.join(ROOT, 'main.js')).href;

// globalThis des Node-Prozesses auf das jsdom-window umbiegen,
// damit die Module dieselbe Umgebung sehen wie im Browser.
for(const key of ['document','window','navigator','performance','requestAnimationFrame',
                  'cancelAnimationFrame','AudioContext','webkitAudioContext','storage',
                  'HTMLCanvasElement','Image','Event','CustomEvent','KeyboardEvent',
                  'MouseEvent','TouchEvent','getComputedStyle','location','history',/*timers weglassen*/
                  'Path2D']){
  if(!(key in w)) continue;
  try{ Object.defineProperty(globalThis, key, { value: w[key], configurable:true, writable:true }); }catch(e){}
}
globalThis.window = w;
Object.defineProperty(globalThis,'performance',{value:{now:()=>Date.now()},configurable:true});
try{ Object.defineProperty(w,'performance',{value:globalThis.performance,configurable:true}); }catch(e){}

console.log('--- Start: main.js wird geladen ---');
try {
  await import(mainURL);
} catch(e) {
  errors.push('[import main.js] ' + e.stack);
}

// Frames abwarten (Boot-Phase)
await new Promise(r => setTimeout(r, 600)); const bootFrames = frames;
console.log('Boot-Frames:', bootFrames, '| Fehler bisher:', errors.length, '| gameMode:', globalThis.gameMode);

// --- Jetzt wirklich ein Spiel starten, damit der volle Renderpfad laeuft ---
function click(id){
  const el = w.document.getElementById(id);
  if(!el){ errors.push('[UI] Element fehlt: #'+id); return false; }
  if(el.classList.contains('hidden')) console.log('   (Hinweis: #'+id+' war hidden)');
  try{ el.click(); }catch(e){ errors.push('[click #'+id+'] '+e.stack); return false; }
  return true;
}
const flow = ['tbStart','btnSolo','startStyleClick','btnConfirmCrew'];
for(const id of flow){
  click(id);
  await new Promise(r => setTimeout(r, 120));
  console.log('   nach #'+id+' -> gameMode =', globalThis.gameMode, '| Fehler:', errors.length);
}
// Intro ueberspringen und pruefen, dass danach alles zu ist
const openNow = () => [...w.document.querySelectorAll('.overlay')]
   .filter(e=>!e.classList.contains('hidden')).map(e=>e.id);
console.log('   offen nach Crew-Bestaetigung:', openNow());
if(w.document.getElementById('introSkip')){ w.document.getElementById('introSkip').click(); }
await new Promise(r=>setTimeout(r,400));
console.log('   nach Intro-Skip             :', openNow(), '| gameMode:', globalThis.gameMode, '| paused:', globalThis.paused);
// Falls ein Story-Dialog erscheint: Weiter druecken
let guard=0;
while(w.document.getElementById('storyOverlay') && !w.document.getElementById('storyOverlay').classList.contains('hidden') && guard++<30){
  const b = w.document.querySelector('#storyChoices button');
  console.log('   Dialog "'+w.document.getElementById('storyTitle').textContent+'" -> klicke ' + (b?'"'+b.textContent+'"':'(KEIN BUTTON)'));
  if(!b) break;
  b.click();
  await new Promise(r=>setTimeout(r,300));
}
console.log('   nach Story-Dialogen         :', openNow(), '| gameMode:', globalThis.gameMode, '| paused:', globalThis.paused);

frames = 0;
await new Promise(r => setTimeout(r, 2000));

// --- Render-Test: Mauern und Lagerfeuer ---
console.log('\n--- Render-Test: Mauer-Autotiling & Lagerfeuer ---');
{
  const px = globalThis.state.player.x, py = globalThis.state.player.y;
  // Waagerechte Mauer aus 4 Feldern + ein Lagerfeuer daneben
  const mk = (type,x,y)=>({ type, x, y, built:true, work:1, workReq:1, regionId:'C', rotation:0 });
  // bewusst weit weg, damit die Testmauer dem Spieler nicht den Weg verstellt
  globalThis.state.buildings.push(mk('wall',px+10,py+10), mk('wall',px+11,py+10), mk('wall',px+12,py+10),
                                  mk('wall',px+11,py+11), mk('campfire',px+10,py+12));
  const conns = globalThis.state.buildings.filter(b=>b.type==='wall')
      .map(b=>{ const c = globalThis.fenceConnections(b); return b.x+'/'+b.y+' n:'+ +c.n +' s:'+ +c.s +' w:'+ +c.w +' e:'+ +c.e; });
  console.log('  Nachbarschaft der Mauern:');
  conns.forEach(c=>console.log('    ', c));
  const anyConn = globalThis.state.buildings.filter(b=>b.type==='wall')
      .some(b=>{ const c=globalThis.fenceConnections(b); return c.n||c.s||c.w||c.e; });
  console.log('  Autotiling erkennt Nachbarn:', anyConn ? 'JA' : 'NEIN');

  const c2d = globalThis.ctx;
  c2d.__texts.length = 0; c2d.__rects.length = 0;
  for(const k of Object.keys(c2d.__calls)) delete c2d.__calls[k];
  globalThis.drawBuilding(globalThis.state.buildings.find(b=>b.type==='wall'), 100, 100);
  const wallEmoji = c2d.__texts.filter(t=>t==='🧱'||t==='❔');
  console.log('  Mauer -> Emoji-Notbehelf :', wallEmoji.length ? 'JA ('+wallEmoji.join()+')' : 'nein');
  console.log('  Mauer -> fillRect-Aufrufe:', c2d.__calls.fillRect || 0);
  // Geometrie pruefen: nichts darf spuerbar ueber die 32x32-Kachel hinausragen
  const TILE = 32, ox = 100, oy = 100, TOL = 2;
  const aus = c2d.__rects.filter(([k,x,y,ww,hh]) =>
      x < ox-TOL || y < oy-TOL || x+ww > ox+TILE+TOL || y+hh > oy+TILE+TOL || ww > TILE+TOL || hh > TILE+TOL);
  console.log('  Mauer -> Rechtecke gesamt:', c2d.__rects.length);
  console.log('  Mauer -> ausserhalb Kachel:', aus.length);
  aus.slice(0,6).forEach(([k,x,y,ww,hh]) =>
      console.log('      ' + k + ' x=' + (x-ox) + ' y=' + (y-oy) + ' w=' + ww + ' h=' + hh));
// --- Feinschliff: Bewegung, Texturen, HUD ---
console.log('\n--- Bewegungsinterpolation ---');
{
  const st = globalThis.state;
  globalThis.moveAnim.moving = true;
  globalThis.moveAnim.fromX = 10; globalThis.moveAnim.toX = 11;
  globalThis.moveAnim.fromY = 10; globalThis.moveAnim.toY = 10;
  globalThis.moveAnim.dur = 1000;
  const punkte = [];
  [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].forEach(t=>{
    globalThis.moveAnim.start = performance.now() - t*1000;
    punkte.push(+(globalThis.currentPlayerRender().x - 10).toFixed(3));
  });
  globalThis.moveAnim.moving = false;
  console.log('  Positionskurve           :', punkte.join(' '));
  // Smoothstep: Anfang und Ende flacher als die Mitte
  const startTempo = punkte[1] - punkte[0];
  const mitteTempo = punkte[3] - punkte[2];
  console.log('  Tempo Start / Mitte      :', startTempo.toFixed(3) + ' / ' + mitteTempo.toFixed(3),
              mitteTempo > startTempo * 1.5 ? ' weiches Anlaufen' : ' LINEAR');
}

console.log('\n--- Ackerfurchen: Variation ---');
{
  const c2d = globalThis.ctx;
  const signaturen = new Set();
  for(let i=0;i<6;i++){
    c2d.__rects.length = 0;
    globalThis.drawBuilding({type:'feld_getreide',x:20+i,y:30+i*2,built:true,work:1,workReq:1,regionId:'C',rotation:0,growth:0.1}, 100, 100);
    signaturen.add(JSON.stringify(c2d.__rects.map(r=>r.slice(1).map(v=>Math.round(v*4)/4))));
  }
  console.log('  6 Kacheln -> Muster      :', signaturen.size, signaturen.size > 1 ? 'unterschiedlich' : 'ALLE GLEICH');
  // Stabilitaet: dieselbe Kachel zweimal muss identisch sein
  const zweimal = [];
  for(let i=0;i<2;i++){
    c2d.__rects.length = 0;
    globalThis.drawBuilding({type:'feld_getreide',x:20,y:30,built:true,work:1,workReq:1,regionId:'C',rotation:0,growth:0.1}, 100, 100);
    zweimal.push(JSON.stringify(c2d.__rects.map(r=>r.slice(1).map(v=>Math.round(v*4)/4))));
  }
  console.log('  dieselbe Kachel 2x       :', zweimal[0] === zweimal[1] ? 'identisch (kein Flackern)' : 'FLACKERT');
}

console.log('\n--- HUD-Optimierung ---');
{
  const st = globalThis.state;
  // DOM-Schreibzugriffe zaehlen
  let schreib = 0;
  const proto = Object.getPrototypeOf(w.document.getElementById('lblHp'));
  const desc = Object.getOwnPropertyDescriptor(proto, 'textContent')
            || Object.getOwnPropertyDescriptor(w.Node.prototype, 'textContent');
  Object.defineProperty(proto, 'textContent', {
    configurable: true,
    get(){ return desc.get.call(this); },
    set(v){ schreib++; desc.set.call(this, v); }
  });
  for(const k of Object.keys(globalThis.hudLetzte)) delete globalThis.hudLetzte[k];
  globalThis.updateHUD();                 // erster Aufruf fuellt alles
  const ersterLauf = schreib;
  schreib = 0;
  for(let i=0;i<5;i++) globalThis.updateHUD();   // nichts geaendert
  const ohneAenderung = schreib;
  schreib = 0;
  st.inventory.wood = (st.inventory.wood||0) + 1;
  globalThis.updateHUD();
  const eineAenderung = schreib;
  Object.defineProperty(proto, 'textContent', desc);

  console.log('  erster Aufruf            :', ersterLauf + ' DOM-Schreibzugriffe');
  console.log('  5x ohne Aenderung        :', ohneAenderung, ohneAenderung === 0 ? ' nichts angefasst' : ' SCHREIBT UNNOETIG');
  console.log('  nach 1 geaendertem Wert  :', eineAenderung, eineAenderung <= 2 ? ' nur das Noetige' : ' ZU VIEL');
}

// --- Vollstaendigkeit: jeder Bautyp in allen noetigen Tabellen ---
console.log('\n--- Tabellen-Vollstaendigkeit ---');
{
  const typen = Object.keys(globalThis.BUILDING_TYPES);
  const cat = globalThis.BUILDING_MENU_CATEGORY || {};
  const ord = globalThis.BUILD_ORDER || {};
  const emo = globalThis.BUILD_EMOJI || {};
  const c2d = globalThis.ctx;

  const ohneKategorie = typen.filter(t => !cat[t]);
  const ohneOrdnung   = typen.filter(t => !ord[t]);
  const ohneEmoji     = typen.filter(t => !emo[t]);
  const ohneZeichnung = typen.filter(t=>{
    c2d.__texts.length = 0;
    try { globalThis.drawBuilding({type:t,x:5,y:5,built:true,work:1,workReq:1,regionId:'C',rotation:0}, 100, 100); }
    catch(e){ return true; }
    return c2d.__texts.includes('❔');
  });

  console.log('  Bautypen gesamt          :', typen.length);
  console.log('  ohne Menue-Kategorie     :', ohneKategorie.length ? ohneKategorie.join(', ') + '  <-- nicht baubar!' : 'keiner');
  console.log('  ohne Bau-Reihenfolge     :', ohneOrdnung.length ? ohneOrdnung.join(', ') : 'keiner');
  console.log('  ohne Emoji-Rueckfall     :', ohneEmoji.length ? ohneEmoji.join(', ') : 'keiner');
  console.log('  ohne Zeichenzweig        :', ohneZeichnung.length ? ohneZeichnung.join(', ') : 'keiner');

  // Felder zusaetzlich: Ertrag und Begehbarkeit
  const felder = Object.keys(globalThis.FIELD_YIELD);
  const feldLuecken = felder.filter(t => !globalThis.BUILDING_TYPES[t] || !cat[t] || !globalThis.istBegehbarerBau(t));
  console.log('  Felder vollstaendig      :', feldLuecken.length ? feldLuecken.join(', ') + '  <-- LUECKE' : 'alle ' + felder.length);
}

// --- Tiefenoptik und Feldkollision ---
console.log('\n--- Tiefenoptik ---');
{
  const st = globalThis.state;
  const c2d = globalThis.ctx;
  // Objekte in verschiedenen Entfernungen, Deckkraft beim Zeichnen mitschneiden
  const px = st.player.x, py = st.player.y;
  st.buildings = st.buildings.filter(b => Math.abs(b.x-px) > 12 || Math.abs(b.y-py) > 12);
  globalThis.camera.x = px - 12; globalThis.camera.y = py - 7;
  [0, 4, 8, 13].forEach((dy,i)=>{
    st.buildings.push({ type:'tower', x:px-6+i, y:globalThis.camera.y+dy, built:true, work:1, workReq:1, regionId:'C', rotation:0 });
  });
  const alphas = [];
  const echt = globalThis.drawBuilding;
  globalThis.drawBuilding = function(b){ if(b.type==='tower') alphas.push([b.y - globalThis.camera.y, +c2d.globalAlpha.toFixed(3)]); return echt.apply(this, arguments); };
  try { globalThis.render(Date.now()); } catch(e){ console.log('  render-Fehler: ' + e.message); }
  globalThis.drawBuilding = echt;
  console.log('  Deckkraft nach Bildtiefe :');
  alphas.forEach(([zeile, a])=> console.log('    Zeile ' + String(zeile).padStart(2) + ' von oben  ->  alpha ' + a));
  const sinkend = alphas.length > 1 && alphas.every((v,i)=> i===0 || v[1] >= alphas[i-1][1]);
  console.log('  ferner = durchsichtiger   :', sinkend ? 'ja' : 'PRUEFEN');
  console.log('  staerkste Abschwaechung   :', alphas.length ? Math.round((1-Math.min(...alphas.map(a=>a[1])))*100) + ' %' : '-');
  console.log('  globalAlpha danach zurueck:', c2d.globalAlpha === 1 ? 'ja' : 'NEIN (' + c2d.globalAlpha + ')');
  st.buildings = st.buildings.filter(b=>b.type!=='tower');
}

// --- Lagerlimit, Truhe, Sortierung ---
console.log('\n--- Lagerlimit ---');
{
  const st = globalThis.state;
  st.buildings = st.buildings.filter(b=>b.type!=='lagerkiste');
  console.log('  Grundkapazitaet          :', globalThis.STORAGE_BASE, '| je Kiste +' + globalThis.STORAGE_PER_CHEST);
  console.log('  aktuelles Limit          :', globalThis.storageCap());

  // greift das Limit wirklich?
  st.inventory.wood = 0;
  const gespeichert = globalThis.addResource('wood', 500);
  console.log('  500 Holz eingelagert     :', gespeichert + ' angenommen, Bestand ' + st.inventory.wood,
              st.inventory.wood <= globalThis.storageCap() ? ' Limit greift' : ' LIMIT UMGANGEN');

  // Kiste erhoeht das Limit
  st.buildings.push({type:'lagerkiste', x:st.player.x+11, y:st.player.y+11, built:true, work:1, workReq:1, regionId:'C', rotation:0});
  console.log('  mit 1 Kiste              :', globalThis.storageCap());
  const nach = globalThis.addResource('wood', 500);
  console.log('  nochmal 500 Holz         :', nach + ' angenommen, Bestand ' + st.inventory.wood);

  // Umgehen alle Quellen jetzt das Limit nicht mehr?
  const fs = await import('fs');
  const dateien = ['main.js','entities/colonist.js','ui/battle.js','ui/input.js','ui/panels.js','ui/screens.js','ui/worldmap.js'];
  let direkt = 0;
  for(const f of dateien){
    const txt = fs.readFileSync(path.join(ROOT, f), 'utf8');
    direkt += (txt.match(/state\.inventory\[\w+\]\s*(\+=|=\s*\(state\.inventory)/g) || []).length;
  }
  console.log('  Quellen, die es umgehen  :', direkt ? direkt + '  <-- FEHLER' : 'keine');
}

console.log('\n--- Truhe: Fenster, Sortierung, Animation ---');
{
  const st = globalThis.state;
  const kiste = st.buildings.find(b=>b.type==='lagerkiste');
  Object.assign(st.inventory, { wood:300, stone:120, fiber:45, metal:8, berries:200 });
  const body = w.document.getElementById('interiorBody');

  kiste.openedAt = null;
  globalThis.renderInteriorBody(kiste);
  console.log('  Deckelanimation ausgeloest:', kiste.openedAt ? 'ja' : 'NEIN');
  console.log('  Sortierknoepfe            :', [...body.querySelectorAll('.chestSortBar button')].map(b=>b.textContent.trim()).join(' | '));
  const zeilen = () => [...body.querySelectorAll('.resItem span:first-child')].map(e=>e.textContent.trim().split(' ').pop());
  console.log('  Sortierung Menge          :', zeilen().slice(0,4).join(' > '));
  [...body.querySelectorAll('.chestSortBar button')].find(b=>b.textContent.includes('Name')).click();
  console.log('  Sortierung Name           :', zeilen().slice(0,4).join(' > '));
  [...body.querySelectorAll('.chestSortBar button')].find(b=>b.textContent.includes('Füllstand')).click();
  console.log('  Sortierung Fuellstand     :', zeilen().slice(0,4).join(' > '));
  console.log('  Fuellbalken               :', body.querySelectorAll('.resBar').length + ' Zeilen');
  console.log('  Warnung bei vollem Lager  :', body.textContent.includes('am Limit') ? 'sichtbar' : 'keine (nichts voll)');

  // Zeichnen mit offenem Deckel darf nicht abstuerzen
  const vorher = errors.length;
  kiste.openedAt = performance.now();
  try { globalThis.drawBuilding(kiste, 100, 100); } catch(e){ errors.push('[truhe] '+e.message); }
  console.log('  Zeichnen offen            :', errors.length === vorher ? 'fehlerfrei' : 'FEHLER');
}

// --- Pausenmenue ---
console.log('\n--- Pausenmenue ---');
{
  const $ = id => w.document.getElementById(id);
  const offen = id => { const e=$(id); return e && !e.classList.contains('hidden'); };
  globalThis.initPauseMenu();
  globalThis.closeAllOverlays(); globalThis.setMode('micro');
  $('mainTitleScreen').classList.add('hidden');

  console.log('  Knoepfe vorhanden        :', ['pauseResume','pauseOptions','pauseSaveQuit'].filter(id=>$(id)).length + ' von 3');

  // Escape haelt das Spiel an
  console.log('  vor Escape               : gameMode=' + globalThis.gameMode + ' paused=' + globalThis.paused);
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key:'Escape', code:'Escape', bubbles:true }));
  console.log('  nach Escape              : gameMode=' + globalThis.gameMode + ' paused=' + globalThis.paused +
              ' | Menue ' + (offen('mainMenuOverlay') ? 'offen' : 'ZU'));
  console.log('  Hinweis sichtbar         :', $('pauseState') ? '"' + $('pauseState').textContent.trim() + '"' : 'FEHLT');

  // Fortsetzen
  $('pauseResume').click();
  console.log('  Fortsetzen               : gameMode=' + globalThis.gameMode + ' paused=' + globalThis.paused +
              ' | Menue ' + (offen('mainMenuOverlay') ? 'NOCH OFFEN' : 'zu'));

  // Einstellungen
  globalThis.openMainMenu();
  $('pauseOptions').click();
  console.log('  Einstellungen            :', offen('optionsOverlay') ? 'geoeffnet' : 'FEHLT',
              '| Menue ' + (offen('mainMenuOverlay') ? 'noch offen' : 'zu'));
  globalThis.closeAllOverlays(); globalThis.setMode('micro');

  // Speichern und zum Titel
  globalThis.openMainMenu();
  $('pauseSaveQuit').click();
  await new Promise(r=>setTimeout(r,150));
  const frage = $('storyDesc').textContent.slice(0,44);
  console.log('  Speichern & Titel        : Rueckfrage "' + frage + '…"');
  const ja = [...w.document.querySelectorAll('#storyChoices button')].find(b=>b.textContent.includes('Ja'));
  ja.click();
  await new Promise(r=>setTimeout(r,150));
  console.log('  nach Bestaetigung        : gameMode=' + globalThis.gameMode + ' paused=' + globalThis.paused);
  console.log('  Titelbild sichtbar       :', offen('mainTitleScreen') ? 'ja' : 'NEIN');
  const reste = [...w.document.querySelectorAll('.overlay')].filter(e=>!e.classList.contains('hidden') && e.id!=='mainTitleScreen').map(e=>e.id);
  console.log('  offene Fenster daneben   :', reste.length ? reste.join(', ') + '  <-- FEHLER' : 'keine');
  console.log('  Tasten geloest           :', globalThis.movementKeysHeld.size === 0 ? 'ja' : 'NEIN');

  $('mainTitleScreen').classList.add('hidden');
  globalThis.setMode('micro');
}

// --- Wachstumsstadien und mehrseitige Dialoge ---
console.log('\n--- Wachstumsstadien ---');
{
  const st = globalThis.state;
  console.log('  Stufen                   :', globalThis.FIELD_STAGES.map(s=>s.icon+' '+s.label).join('  ->  '));
  const feld = { type:'feld_getreide', x:5, y:5, built:true, work:1, workReq:1, regionId:'C', rotation:0, growth:0 };
  [0, 0.3, 0.7, 1].forEach(g=>{
    feld.growth = g;
    const s = globalThis.fieldStage(feld);
    console.log('    Fortschritt ' + String(Math.round(g*100)).padStart(3) + ' %  ->  ' + s.label);
  });

  // Tag/Nacht-Kopplung
  st.buildings = st.buildings.filter(b=>!globalThis.FIELD_YIELD[b.type]);
  st.buildings.push({ type:'feld_getreide', x:st.player.x+9, y:st.player.y+9, built:true, work:1, workReq:1, regionId:'C', rotation:0, growth:0 });
  const f = st.buildings[st.buildings.length-1];
  const { DAY_CYCLE_MS } = await import(pathToFileURL(path.join(ROOT,'engine/rng.js')).href);
  const messen = (phase)=>{
    st.dayCycleOffset = Date.now() - phase * DAY_CYCLE_MS;
    f.growth = 0;
    globalThis.tickFields(60000);      // eine Minute
    return f.growth;
  };
  const tag = messen(0.5), nacht = messen(0.0);
  console.log('  1 Min Wachstum bei Tag   :', (tag*100).toFixed(1) + ' %');
  console.log('  1 Min Wachstum bei Nacht :', (nacht*100).toFixed(1) + ' %',
              nacht < tag * 0.5 ? ' nachts deutlich langsamer' : ' KEINE KOPPLUNG');
  console.log('  Nachtfaktor              :', globalThis.NACHT_WACHSTUM);
  st.buildings = st.buildings.filter(b=>b !== f);
}

console.log('\n--- Mehrseitige Dialoge ---');
{
  const kurz = 'Ein kurzer Satz.';
  const lang = 'Die Boote sind verbrannt, der Weg zurück versperrt. Vor dir liegt Farholt, ein Landstrich, den die alten Karten nur als weißen Fleck kennen. Was auch immer hier einst war, es ist lange fort.\n\nDrei Winter lang haben wir uns auf diese Fahrt vorbereitet. Vorräte gehortet, Werkzeug geschmiedet, Karten studiert, die niemand je bestätigt hat. Und nun stehen wir hier, am Rand von allem, was wir kennen, und der Wind riecht nach nassem Holz und kaltem Stein.\n\nWas wir hier errichten, wird niemand für uns tun. Was wir hier verlieren, bekommen wir nicht zurück.';
  console.log('  kurzer Text  -> Seiten   :', globalThis.dialogSeiten(kurz).length);
  const seiten = globalThis.dialogSeiten(lang);
  console.log('  langer Text  -> Seiten   :', seiten.length, '(je ' + seiten.map(s=>s.length).join(', ') + ' Zeichen)');
  console.log('  Grenze pro Seite         :', globalThis.DIALOG_ZEICHEN_PRO_SEITE);

  // Durchblaettern
  const dlg = w.document.getElementById('storyOverlay');
  dlg.classList.add('hidden');
  let geklickt = false;
  globalThis.showStoryDialog('Der Aufbruch', lang, [{ label:'Verstanden', action:()=>{ geklickt = true; } }]);
  const folge = [];
  for(let i=0;i<8;i++){
    const b = w.document.querySelector('#storyChoices button');
    if(!b) break;
    folge.push(b.textContent.trim());
    b.click();
    if(dlg.classList.contains('hidden')) break;
  }
  console.log('  Knopffolge               :', folge.join('  |  '));
  console.log('  Aktion am Ende ausgefuehrt:', geklickt ? 'ja' : 'NEIN');
  console.log('  kurzer Text einseitig    :', (()=>{
    dlg.classList.add('hidden');
    globalThis.showStoryDialog('Test', kurz, [{label:'OK', action:()=>{}}]);
    const b = w.document.querySelector('#storyChoices button');
    const einseitig = b && b.textContent.trim() === 'OK';
    if(b) b.click();
    return einseitig ? 'ja (kein Weiter-Knopf)' : 'NEIN';
  })());
}

// --- Audit: Begehbarkeit aller Felder und Boeden ---
console.log('\n--- Audit: Begehbarkeit ---');
{
  const st = globalThis.state;
  // freies Grasfeld suchen
  let x=null,y=null;
  for(let r=3;r<25 && x===null;r++) for(let dx=-r;dx<=r && x===null;dx++) for(let dy=-r;dy<=r;dy++){
    const px=st.player.x+dx, py=st.player.y+dy;
    if(globalThis.objAt(px,py)) continue;
    if(st.buildings.some(b=>b.x===px&&b.y===py)) continue;
    if(globalThis.tileAt(px,py)!==globalThis.TILE_GRASS) continue;
    if(!globalThis.passable(px,py)) continue;
    x=px;y=py;break;
  }
  const felder = Object.keys(globalThis.FIELD_YIELD);
  const boeden = ['holzboden','steinboden','marmorboden','teppich','gartenweg','stockpile','schutzzone','tiergehege','door'];
  let fehler = [];
  [...felder, ...boeden].forEach(t=>{
    st.buildings = st.buildings.filter(b=>!(b.x===x&&b.y===y));
    st.buildings.push({type:t,x,y,built:true,work:1,workReq:1,regionId:'C',rotation:0});
    if(!globalThis.passable(x,y)) fehler.push(t);
  });
  st.buildings = st.buildings.filter(b=>!(b.x===x&&b.y===y));
  console.log('  Felder geprueft          :', felder.join(', '));
  console.log('  Boeden geprueft          :', boeden.length + ' Typen');
  console.log('  blockieren faelschlich   :', fehler.length ? fehler.join(', ') + '   <-- FEHLER' : 'keiner');
  console.log('  Ableitung aus Tabelle    :', globalThis.istBegehbarerBau('feld_fasern') && globalThis.istBegehbarerBau('feld_getreide') ? 'greift' : 'GREIFT NICHT');
  console.log('  Wand bleibt blockierend  :', globalThis.istBegehbarerBau('wall') ? 'NEIN — FEHLER' : 'ja');
}

console.log('\n--- Audit: Event-Listener ---');
{
  // Mehrfachaufruf darf keine doppelten Listener erzeugen
  const vorher = errors.length;
  for(let i=0;i<3;i++) globalThis.initDesignationTools();
  console.log('  initDesignationTools 3x  :', errors.length === vorher ? 'fehlerfrei, Schutz greift' : 'FEHLER');
  const menu = w.document.getElementById('desMenu');
  const knopf = w.document.getElementById('btnDesignations');
  menu.classList.add('hidden');
  knopf.click();
  console.log('  Menue nach 1 Klick       :', menu.classList.contains('hidden') ? 'ZU (doppelt geschaltet!)' : 'offen (richtig)');
  knopf.click();
}

// --- Y-Sortierung, Partikel, Tag/Nacht ---
console.log('\n--- HD-2D-Effekte ---');
{
  const st = globalThis.state;
  const c2d = globalThis.ctx;

  // Y-Sortierung: steht der Spieler hinter einem suedlicheren Gebaeude?
  const px = st.player.x, py = st.player.y;
  st.buildings = st.buildings.filter(b => Math.abs(b.x-px) > 6 || Math.abs(b.y-py) > 6);
  st.buildings.push({ type:'tower', x:px, y:py+2, built:true, work:1, workReq:1, regionId:'C', rotation:0 });
  st.colonists.forEach(c=>{ c.x = px+1; c.y = py-2; c.regionId='C'; });

  // Reihenfolge der Zeichenaufrufe mitschneiden
  const folge = [];
  const echtBuilding = globalThis.drawBuilding, echtPlayer = globalThis.drawPlayer;
  globalThis.drawBuilding = function(b, sx, sy){ folge.push('bau:' + b.type + '@y' + b.y); return echtBuilding.apply(this, arguments); };
  globalThis.drawPlayer = function(){ folge.push('SPIELER@y' + st.player.y); return echtPlayer.apply(this, arguments); };
  try { globalThis.render(Date.now()); } catch(e){ console.log('  render-Fehler: ' + e.message); }
  globalThis.drawBuilding = echtBuilding; globalThis.drawPlayer = echtPlayer;

  const iSpieler = folge.findIndex(z=>z.startsWith('SPIELER'));
  const iTurm = folge.findIndex(z=>z.includes('tower'));
  console.log('  Spieler y=' + py + ', Turm y=' + (py+2));
  console.log('  Zeichenreihenfolge       :', iSpieler >= 0 && iTurm >= 0
      ? (iSpieler < iTurm ? 'Spieler vor Turm — richtig (Turm steht suedlicher)' : 'Turm zuerst — FALSCH')
      : 'nicht ermittelbar (Spieler:' + iSpieler + ' Turm:' + iTurm + ')');

  // Partikel
  console.log('  Partikeldichte           :', globalThis.PARTIKEL_DICHTE);
  const vorher = c2d.__calls.arc || 0;
  for(const k of Object.keys(c2d.__calls)) delete c2d.__calls[k];
  globalThis.zeichnePartikel(Date.now(), st.player.x-10, st.player.y-6);
  console.log('  Partikel gezeichnet      :', (c2d.__calls.arc||0) + ' Kreise, fehlerfrei');

  // Tag/Nacht-Faerbung
  const zeig = p => globalThis.skyTintAt(p).join(',');
  console.log('  Faerbung Mittag/Abend/Nacht:', zeig(0.5) + ' / ' + zeig(0.79) + ' / ' + zeig(0.0));
  console.log('  Lichtquellen             :', Object.keys(globalThis.LIGHT_SOURCES).length);
  console.log('  Schattenwurf vorhanden   :', typeof globalThis.zeichneFeuerschatten === 'function' ? 'ja' : 'NEIN');

  st.buildings = st.buildings.filter(b => !(b.x===px && b.y===py+2));
}

// --- Dorf-NPCs: Menue, Handel, Routinen ---
console.log('\n--- Dorfbewohner ---');
{
  const v = { name:'Testa', job:'Bäckerin', x:5, y:5, homeX:5, homeY:5, bedX:5, bedY:5,
              isTrader:false, talkIdx:0, appearance:globalThis.randomAppearance() };
  const dlg = w.document.getElementById('storyOverlay');
  const knoepfe = () => [...w.document.querySelectorAll('#storyChoices button')].map(b=>b.textContent.trim());

  globalThis.talkToVillager(v);
  console.log('  Menue bei Handwerkerin   :', knoepfe().join(' | '));
  const t = { ...v, name:'Kaufo', job:'Händler', isTrader:true, talkIdx:0 };
  globalThis.talkToVillager(t);
  console.log('  Menue bei Haendler       :', knoepfe().join(' | '));
  const hatHandel = knoepfe().some(k=>k.includes('Handeln'));
  console.log('  Handeln nur bei Haendler :', hatHandel ? 'ja' : 'FEHLT');

  // Plaudern liefert wechselnde Texte
  const texte = new Set();
  const p2 = { ...v, talkIdx:0, greeted:true };
  for(let i=0;i<4;i++){ globalThis.talkToVillager(p2); texte.add(w.document.getElementById('storyDesc').textContent.slice(0,40)); }
  console.log('  4x plaudern -> Texte     :', texte.size, texte.size > 1 ? 'wechselnd' : 'IMMER GLEICH');

  // Berufe und Namen
  console.log('  Berufe mit eigenen Texten:', Object.keys(globalThis.VILLAGER_TALK).join(', '));
  console.log('  Dorfaufgaben             :', globalThis.VILLAGE_TASKS ? globalThis.VILLAGE_TASKS.length : '?');
  console.log('  Handelsangebote          :', globalThis.VILLAGE_TRADES ? globalThis.VILLAGE_TRADES.length : '?');
  const b = w.document.querySelector('#storyChoices button'); if(b) b.click();
  dlg.classList.add('hidden');
}

// --- Questgeber, Naehe-Erkennung, Hauptquest ---
console.log('\n--- Questgeber ---');
{
  const st = globalThis.state;
  const def = globalThis.NPC_TYPES.bote;
  console.log('  Bote in der Tabelle      :', def ? def.label + ' ' + def.icon + ', fest: ' + !!def.fest + ', dauer: ' + def.dauer : 'FEHLT');

  // einmalig setzen
  st.quests.boteGesetzt = false;
  [...globalThis.objects.entries()].filter(([k,o])=>o.npcTyp==='bote').forEach(([k])=>globalThis.objects.delete(k));
  const pos = globalThis.spawnStartBote();
  console.log('  spawnStartBote()         :', pos ? 'gesetzt bei ' + pos.x + '/' + pos.y + ' ("' + pos.name + '")' : 'KEIN PLATZ');
  const nochmal = globalThis.spawnStartBote();
  console.log('  zweiter Aufruf           :', nochmal === null ? 'kein Doppelgaenger (richtig)' : 'ZWEITER BOTE!');

  // Naehe-Erkennung
  st.player.x = 5; st.player.y = 5;
  console.log('  weit weg -> Reichweite   :', globalThis.npcInReichweite() ? 'FALSCH ERKANNT' : 'niemand (richtig)');
  st.player.x = pos.x + 1; st.player.y = pos.y;
  const nah = globalThis.npcInReichweite();
  console.log('  daneben -> Reichweite    :', nah ? 'erkannt (' + nah.o.npcTyp + ')' : 'NICHT ERKANNT');

  // E-Taste oeffnet das Gespraech
  const dlg = w.document.getElementById('storyOverlay');
  dlg.classList.add('hidden');
  globalThis.interactKey();
  const titel = w.document.getElementById('storyTitle').textContent;
  console.log('  E-Taste                  :', !dlg.classList.contains('hidden') ? 'Dialog offen "' + titel + '"' : 'NICHTS PASSIERT');

  // Gespraech bis zur Hauptquest durchklicken
  const schritte = [];
  let n = 0;
  while(n < 8){
    const b = w.document.querySelector('#storyChoices button');
    if(!b) break;
    schritte.push(w.document.getElementById('storyDesc').textContent.slice(0, 52).replace(/\n/g,' ') + '…');
    b.click(); n++;
    if(dlg.classList.contains('hidden')) break;
  }
  schritte.forEach((z,i)=>console.log('    ' + (i+1) + '. ' + z));
  console.log('  Bote bleibt stehen       :', globalThis.objects.has(pos.x + ',' + pos.y) ? 'ja (fest)' : 'VERSCHWUNDEN');
  console.log('  Hauptquest-Stufe         :', st.quests.mainStage, '"' + globalThis.MAIN_QUEST_STAGES[st.quests.mainStage].title + '"');

  // Erneut ansprechen muss wieder funktionieren
  dlg.classList.add('hidden');
  globalThis.interactKey();
  console.log('  erneut ansprechbar       :', !dlg.classList.contains('hidden') ? 'ja' : 'NEIN');
  const b2 = w.document.querySelector('#storyChoices button'); if(b2) b2.click();
}

// --- Wandhaltbarkeit und Feldarten ---
console.log('\n--- Wandhaltbarkeit ---');
{
  const st = globalThis.state;
  const arten = ['zaun','holzwand1','holzwand3','wall','fensterwand2','metallwand1','metallwand3','titanwall'];
  console.log('  Haltbarkeit je Material:');
  arten.forEach(t=>{
    const hp = globalThis.wallMaxHp(t);
    const def = globalThis.WALL_DEFENSE_FACTOR[t] ?? '-';
    const kosten = Object.entries(globalThis.BUILDING_TYPES[t].cost).map(([k,v])=>k+':'+v).join(' ');
    console.log('    ' + t.padEnd(14) + 'HP ' + String(hp).padStart(3) + '  Verteidigung ' + String(def).padEnd(5) + '  ' + kosten);
  });

  // Ueberfall: nehmen Waende Schaden, brechen schwache zuerst?
  const bx = st.player.x + 25, by = st.player.y + 25;
  st.buildings = st.buildings.filter(b => Math.abs(b.x-bx) > 8 || Math.abs(b.y-by) > 8);
  const mk = (t,i)=>({ type:t, x:bx+i, y:by, built:true, work:1, workReq:1, regionId:'C', rotation:0 });
  ['holzwand1','holzwand1','wall','metallwand3'].forEach((t,i)=> st.buildings.push(mk(t,i)));
  const vorher = st.buildings.filter(b=>b.x>=bx && b.x<bx+4 && b.y===by).length;
  let runden = 0, zerstoert = 0;
  for(let i=0;i<12;i++){ const r = globalThis.angreiferBeschaedigenWaende(3); zerstoert += r.zerstoert; runden++; }
  const rest = st.buildings.filter(b=>b.x>=bx && b.x<bx+4 && b.y===by);
  console.log('  nach ' + runden + ' Ueberfaellen  : ' + vorher + ' -> ' + rest.length + ' Waende (' + zerstoert + ' zerschlagen)');
  console.log('  was uebrig blieb        : ' + (rest.map(b=>b.type + '(' + Math.max(0,Math.round(b.hp)) + ')').join(', ') || 'nichts'));
  const nurStark = rest.every(b => globalThis.wallMaxHp(b.type) >= 40);
  console.log('  schwaches brach zuerst  : ' + (nurStark ? 'ja' : 'PRUEFEN'));
  st.buildings = st.buildings.filter(b => !(b.x>=bx && b.x<bx+4 && b.y===by));
}

console.log('\n--- Feldarten ---');
{
  const F = globalThis.FIELD_YIELD;
  console.log('  Art             Rohstoff   Reifezeit   Ertrag   pro Minute');
  Object.entries(F).forEach(([t,c])=>{
    const proMin = (c.amt / (c.growTime/60000)).toFixed(2);
    console.log('    ' + t.padEnd(14) + c.res.padEnd(10) + (c.growTime/1000 + ' s').padStart(7) +
                String(c.amt).padStart(8) + proMin.padStart(12));
  });
  const fehlt = Object.keys(F).filter(t => !globalThis.BUILDING_TYPES[t]);
  console.log('  ohne Gebaeudeeintrag    :', fehlt.length ? fehlt.join(', ') : 'keine');
  const c2d = globalThis.ctx;
  const kaputt = Object.keys(F).filter(t=>{
    c2d.__texts.length = 0;
    try { globalThis.drawBuilding({type:t,x:5,y:5,built:true,work:1,workReq:1,regionId:'C',rotation:0,plantedAt:Date.now()-999999}, 100, 100); }
    catch(e){ return true; }
    return c2d.__texts.includes('❔');
  });
  console.log('  Zeichnen fehlerhaft     :', kaputt.length ? kaputt.join(', ') : 'keine');
}

// --- Titelbildschirm: funktionieren alle vier Knoepfe? ---
console.log('\n--- Titelbildschirm ---');
{
  const $ = id => w.document.getElementById(id);
  const sicht = el => el && !el.classList.contains('hidden');
  const z = el => parseInt(w.getComputedStyle(el).zIndex, 10) || 0;
  const titel = $('mainTitleScreen');

  globalThis.showTitleScreen();
  console.log('  Titelbild sichtbar       :', sicht(titel) ? 'ja' : 'NEIN', '| z-index ' + z(titel));

  for(const [id, ziel] of [['tbOptions','optionsOverlay'], ['tbCredits','creditsOverlay']]){
    globalThis.showTitleScreen();
    const el = $(ziel);
    if(el) el.classList.add('hidden');
    $(id).click();
    const offen = sicht(el);
    const zz = z(el);
    const verdeckt = offen && sicht(titel) && zz < z(titel);
    console.log('  ' + id.padEnd(12) + '-> ' + ziel.padEnd(16) +
      (offen ? 'geoeffnet (z ' + zz + ')' : 'BLEIBT ZU') +
      (verdeckt ? '   <-- LIEGT HINTER DEM TITELBILD' : (offen ? '   sichtbar' : '')));
    if(el) el.classList.add('hidden');
  }
  // Zustand sauber zuruecklassen, sonst verfaelscht das Titelbild spaetere Tests
  globalThis.hideTitleScreen();
  titel.classList.add('hidden');
  ['optionsOverlay','creditsOverlay'].forEach(id=>{ const e=$(id); if(e) e.classList.add('hidden'); });
  if(globalThis.closeAllOverlays) globalThis.closeAllOverlays();
  globalThis.setMode('micro');
}

// --- Jedes Ereignis einmal ausloesen ---
console.log('\n--- Ereignisse einzeln ---');
{
  const alle = [...globalThis.STORY_EVENTS, ...globalThis.SIEDLER_EVENTS];
  const gesehen = new Set();
  for(const e of alle){
    if(gesehen.has(e.id)) continue;
    gesehen.add(e.id);
    const vorher = errors.length;
    let status = 'ok';
    try { e.run(); }
    catch(err){ status = 'AUSNAHME -> ' + err.message; }
    // Dialog wegklicken, falls einer aufging
    const b = w.document.querySelector('#storyChoices button');
    if(b) b.click();
    console.log('  ' + e.id.padEnd(12) + status + (errors.length > vorher ? '  (+Fehler)' : ''));
  }
}

// --- Kampfwerte und Ereignistakt ---
console.log('\n--- Kampfwerte ---');
{
  const SP = globalThis.SPECIES;
  const nachRar = {};
  SP.forEach(s=>{ (nachRar[s.rarity] ||= []).push(s.stats); });
  for(const [r, liste] of Object.entries(nachRar)){
    const hp = liste.map(s=>s.hp), df = liste.map(s=>s.def), at = liste.map(s=>s.atk);
    const sp = (a)=> Math.min(...a) + '-' + Math.max(...a);
    console.log('  ' + r.padEnd(9) + 'HP ' + sp(hp).padEnd(7) + ' DEF ' + sp(df).padEnd(6) + ' ATK ' + sp(at));
  }
  // Wie viele Schlaege braucht ein Spieler mit atk 10?
  const treffer = (atk, ziel) => Math.ceil(ziel.hp / Math.max(1, Math.round(atk - ziel.def/2)));
  ['common','uncommon','rare'].forEach(r=>{
    const l = nachRar[r]; if(!l) return;
    const schnitt = l.reduce((a,s)=>({hp:a.hp+s.hp/l.length, def:a.def+s.def/l.length}), {hp:0,def:0});
    console.log('  ' + r.padEnd(9) + 'Schlaege bei atk 10: ' + treffer(10, schnitt) +
                ' | bei atk 16: ' + treffer(16, schnitt));
  });
}

console.log('\n--- Ereignistakt ---');
{
  console.log('  Story-Ereignisse         : erstes nach 45 s, danach alle 100 s');
  console.log('  Zuzugs-Ereignisse        : erstes nach 70 s, danach alle 130 s');
  console.log('  Zuzugs-Tabelle           :', globalThis.SIEDLER_EVENTS.map(e=>e.id + '(' + e.weight + ')').join(', '));
  const vorher = globalThis.state.colonists.length;
  let ok = 0;
  for(let i=0;i<5;i++){ try { globalThis.rollSiedlerEvent(); ok++; } catch(e){ console.log('  FEHLER: ' + e.message); break; } }
  console.log('  5 Wuerfe fehlerfrei      :', ok === 5 ? 'ja' : 'NEIN');
}

// --- Balancing: Startumgebung ---
console.log('\n--- Startumgebung ---');
{
  const st = globalThis.state;
  const px = st.player.x, py = st.player.y;
  // Was liegt tatsaechlich herum?
  const summe = {};
  globalThis.groundItems.forEach(g=>{ summe[g.resource] = (summe[g.resource]||0) + g.amount; });
  console.log('  Bodenfundstuecke         :', globalThis.groundItems.length, 'Stapel');
  console.log('  darin enthalten          :', Object.entries(summe).map(([k,v])=>k+':'+v).join(', ') || 'nichts');
  const soll = { wood:40, stone:28, fiber:15, berries:12 };
  console.log('  Soll laut scatterStarter :', Object.entries(soll).map(([k,v])=>k+':'+v).join(', '));
  const fehl = Object.keys(soll).filter(k => (summe[k]||0) < soll[k]);
  console.log('  darunter geblieben       :', fehl.length ? fehl.map(k=>k+' '+(summe[k]||0)+'/'+soll[k]).join(', ') : 'keine');

  // Objekte in Laufweite
  const zaehl = {};
  for(let dy=-12; dy<=12; dy++) for(let dx=-12; dx<=12; dx++){
    const o = globalThis.objAt(px+dx, py+dy);
    if(o) zaehl[o.type] = (zaehl[o.type]||0)+1;
  }
  console.log('  Objekte im Umkreis 12    :', Object.entries(zaehl).map(([k,v])=>k+':'+v).join(', ') || 'keine');

  // Reicht es fuer die primitive Werkbank?
  const kosten = globalThis.BUILDING_TYPES.primitivbank.cost;
  console.log('  Primitive Werkbank kostet:', Object.entries(kosten).map(([k,v])=>k+':'+v).join(', '));
  const reicht = Object.keys(kosten).every(k => (summe[k]||0) >= kosten[k]);
  console.log('  allein durch Aufsammeln  :', reicht ? 'machbar' : 'NICHT machbar');
}

// --- Designations-System ---
console.log('\n--- Flaechenmarkierungen ---');
{
  const st = globalThis.state;
  globalThis.clearAllDesignations();
  // Testflaeche mit Baeumen und Fels bestuecken
  const bx = st.player.x + 20, by = st.player.y + 20;
  for(let y=0;y<4;y++) for(let x=0;x<4;x++){
    globalThis.objects.set((bx+x)+','+(by+y), { type: (x<2?'tree':'rock'), hp:3, maxHp:3 });
  }
  console.log('  Arten                    :', Object.keys(globalThis.DESIGNATION_ARTEN).join(', '));

  const gefaellt = globalThis.designateArea(bx, by, bx+3, by+3, 'chop', 'C');
  console.log('  chop ueber 4x4 (8 Baeume):', gefaellt, gefaellt === 8 ? ' nur Baeume markiert' : ' FALSCHE ANZAHL');
  const gemint = globalThis.designateArea(bx, by, bx+3, by+3, 'mine', 'C');
  console.log('  mine ueber dieselbe Flaeche:', gemint, gemint === 8 ? ' nur Fels markiert' : ' FALSCHE ANZAHL');
  console.log('  Markierungen gesamt      :', globalThis.designationCount());

  console.log('  Abfrage Baum-Kachel      :', JSON.stringify(globalThis.designationAt(bx, by, 'C')));
  console.log('  Abfrage leere Kachel     :', globalThis.designationAt(bx-5, by-5, 'C') === null ? 'null (richtig)' : 'FALSCH');
  console.log('  falsche Region           :', globalThis.designationAt(bx, by, 'X') === null ? 'null (richtig)' : 'FALSCH');

  // Abbruch-Modus: Rechteck wieder loeschen
  const weg = globalThis.clearArea(bx, by, bx+1, by+3);
  console.log('  clearArea 2x4            :', weg + ' entfernt, verbleibend ' + globalThis.designationCount());

  // Aufraeumen verwaister Markierungen
  globalThis.objects.delete((bx+2)+','+(by));
  const verwaist = globalThis.pruneDesignations();
  console.log('  pruneDesignations()      :', verwaist + ' verwaiste entfernt');

  // Speichern und Laden
  const gesichert = globalThis.serializeDesignations();
  globalThis.clearAllDesignations();
  globalThis.loadDesignations(gesichert);
  console.log('  speichern/laden          :', globalThis.designationCount() === gesichert.length ? 'verlustfrei' : 'VERLUST');

  // Sortierung nach Entfernung fuer die Arbeitssuche
  const liste = globalThis.designationsOfKind('mine', 'C', st.player.x, st.player.y);
  const dists = liste.map(m => Math.round(Math.hypot(m.x-st.player.x, m.y-st.player.y)));
  const sortiert = dists.every((d,i)=> i===0 || d >= dists[i-1]);
  console.log('  nach Entfernung sortiert :', sortiert ? 'ja' : 'NEIN', '(' + dists.slice(0,5).join(',') + ')');

  // Rendern mit Markierungen darf nicht abstuerzen
  const vorher = errors.length;
  try { globalThis.render(Date.now()); } catch(e){ errors.push('[des] ' + e.message); }
  console.log('  Rendern mit Markierungen :', errors.length === vorher ? 'fehlerfrei' : 'FEHLER');

  globalThis.clearAllDesignations();
  for(let y=0;y<4;y++) for(let x=0;x<4;x++) globalThis.objects.delete((bx+x)+','+(by+y));
}

console.log('\n--- Architekt-Leiste und HUD ---');
{
  const $ = id => w.document.getElementById(id);
  const menu = $('desMenu'), knopf = $('btnDesignations'), liste = $('resourceOverlay');

  globalThis.initDesignationTools();
  knopf.click();
  const holz = [...menu.querySelectorAll('button')].find(b=>b.dataset.designation === 'chop');
  holz.click();
  console.log('  Auftraege-Menue          :', menu.querySelectorAll('button').length + ' Punkte, Auswahl -> ' + globalThis.designationMode);
  console.log('  Werkzeugzeiger           :', $('cmdCursor') && !$('cmdCursor').classList.contains('hidden') ? 'sichtbar' : 'FEHLT');
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key:'Escape', bubbles:true }));

  // --- Ressourcenliste oben links, Statusbalken unten links ---
  const bars = w.document.querySelector('.bars');
  const cs = w.getComputedStyle(liste), bs = w.getComputedStyle(bars);
  console.log('  Liste liegt in            :', liste.parentElement ? '#' + liste.parentElement.id : 'nirgends');
  console.log('  Liste Position            :', cs.position + ' top:' + cs.top + ' left:' + cs.left);
  console.log('  Statusbalken Position     :', bs.position + ' bottom:' + bs.bottom + ' left:' + bs.left);
  console.log('  beide links, getrennt     :',
    cs.left === '10px' && bs.left === '10px' && cs.top === '10px' && bs.bottom === '10px' ? 'ja' : 'PRUEFEN');
  console.log('  Eintraege                 :', liste.querySelectorAll('.invItem').length);

  // --- Knopfreihenfolge in der Architekt-Leiste ---
  const arch = w.document.getElementById('architekt');
  const folge = [...arch.children].map(e =>
    e.classList.contains('barSpacer') ? '│ ABSTAND │' :
    (e.querySelector('button') || e).textContent.trim().split(' ').slice(0,2).join(' '));
  console.log('  Leisten-Reihenfolge       :', folge.join('  '));
  const bar = w.document.getElementById('bottomBar');
  const bcs = w.getComputedStyle(bar);
  console.log('  Leiste ausgerichtet       :', bcs.justifyContent,
              bcs.justifyContent === 'flex-start' ? ' linksbuendig' : ' NICHT links');
  console.log('  Abstand zum linken Rand   :', bcs.paddingLeft,
              '| erste Gruppe: ' + w.getComputedStyle(arch).paddingLeft);

  // --- Ueberlappungen ---
  const abs = [...w.document.querySelectorAll('#stage > *')].filter(e=>{
    const c = w.getComputedStyle(e);
    return c.position === 'absolute' && !e.classList.contains('overlay') && e.id !== 'game';
  });
  const pos = {};
  abs.forEach(e=>{
    const c = w.getComputedStyle(e);
    (pos[[c.top,c.left,c.right,c.bottom].join('|')] ||= []).push(e.id || e.className);
  });
  const koll = Object.values(pos).filter(v=>v.length>1);
  console.log('  Overlays in der Buehne    :', abs.map(e=>e.id||e.className).join(', '));
  console.log('  gleiche Verankerung       :', koll.length ? koll.map(v=>v.join('+')).join(', ') + '  <-- UEBERLAPPT' : 'keine');
}

// --- Tastensteuerung und Bauebenen ---
console.log('\n--- Tastensteuerung ---');
{
  const runter = (code, key) => w.dispatchEvent(new w.KeyboardEvent('keydown', { code, key, bubbles:true }));
  const hoch   = (code, key) => w.dispatchEvent(new w.KeyboardEvent('keyup',   { code, key, bubbles:true }));
  const gehalten = () => [...globalThis.movementKeysHeld].sort().join(',') || '(nichts)';
  globalThis.keyboardCameraEnabled = false;
  globalThis.alleTastenLoslassen();

  runter('KeyD', 'd');
  console.log('  D gedrueckt              :', gehalten());
  hoch('KeyD', 'd');
  console.log('  D losgelassen            :', gehalten());

  // Der alte Fehler: Zeichen aendert sich zwischen Druecken und Loslassen
  runter('KeyD', 'd');
  hoch('KeyD', 'D');            // Umschalt kam dazwischen -> anderes Zeichen
  console.log('  losgelassen als "D"      :', gehalten(), gehalten()==='(nichts)' ? ' erkannt' : ' HAENGT');

  // Fokusverlust
  runter('KeyW', 'w'); runter('KeyA', 'a');
  const vorBlur = gehalten();
  w.dispatchEvent(new w.Event('blur'));
  console.log('  Fokusverlust             :', vorBlur + '  ->  ' + gehalten(), gehalten()==='(nichts)' ? ' geloest' : ' HAENGT');

  // Tabwechsel
  runter('KeyS', 's');
  Object.defineProperty(w.document, 'hidden', { value:true, configurable:true });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  console.log('  Tab gewechselt           :', gehalten(), gehalten()==='(nichts)' ? ' geloest' : ' HAENGT');
  Object.defineProperty(w.document, 'hidden', { value:false, configurable:true });
  globalThis.alleTastenLoslassen();
}

console.log('\n--- Bauebenen: Boden unter Wand ---');
{
  const st = globalThis.state;
  // Ein wirklich freies Grasfeld suchen statt eines geraten
  let x = null, y = null;
  for(let r=3; r<25 && x===null; r++){
    for(let dx=-r; dx<=r && x===null; dx++){
      for(let dy=-r; dy<=r; dy++){
        const px = st.player.x+dx, py = st.player.y+dy;
        if(globalThis.objAt(px,py)) continue;
        if(st.buildings.some(b=>b.x===px&&b.y===py)) continue;
        if(globalThis.tileAt(px,py) !== globalThis.TILE_GRASS) continue;
        if(!globalThis.passable(px,py)) continue;
        x = px; y = py; break;
      }
    }
  }
  console.log('  Testfeld                  :', x===null ? 'KEINS GEFUNDEN' : x + '/' + y +
    ' (Untergrund ' + globalThis.tileAt(x,y) + ')');
  if(x === null) throw new Error('kein freies Grasfeld');
  st.buildings = st.buildings.filter(b => !(b.x===x && b.y===y));
  const setzen = (typ) => st.buildings.push({ type:typ, x, y, built:true, work:1, workReq:1, regionId:'C', rotation:0 });

  console.log('  leeres Feld: Boden        :', globalThis.canBuildAt(x,y,'holzboden') ? 'erlaubt' : 'VERBOTEN');
  console.log('  leeres Feld: Wand         :', globalThis.canBuildAt(x,y,'wall') ? 'erlaubt' : 'VERBOTEN');

  setzen('wall');
  console.log('  Wand steht -> Boden       :', globalThis.canBuildAt(x,y,'holzboden') ? 'erlaubt  (Ziel)' : 'VERBOTEN');
  console.log('  Wand steht -> zweite Wand :', globalThis.canBuildAt(x,y,'metallwand1') ? 'ERLAUBT (falsch)' : 'verboten  (richtig)');

  setzen('holzboden');
  console.log('  beides auf dem Feld       :', st.buildings.filter(b=>b.x===x&&b.y===y).length + ' Bauten');
  console.log('  -> zweiter Boden          :', globalThis.canBuildAt(x,y,'steinboden') ? 'ERLAUBT (falsch)' : 'verboten  (richtig)');

  // Fensterwand statt Wand
  st.buildings = st.buildings.filter(b => !(b.x===x && b.y===y));
  setzen('fensterwand2');
  console.log('  Fensterwand -> Boden      :', globalThis.canBuildAt(x,y,'teppich') ? 'erlaubt  (Ziel)' : 'VERBOTEN');

  // Abriss nimmt den Aufbau zuerst
  setzen('holzboden');
  const t = { x, y };
  globalThis.demolishBuildingAt(t);
  const rest = st.buildings.filter(b=>b.x===x&&b.y===y).map(b=>b.type);
  console.log('  Abriss entfernt zuerst    :', rest.length ? 'Aufbau weg, es bleibt: ' + rest.join(',') : 'ALLES weg');
  st.buildings = st.buildings.filter(b => !(b.x===x && b.y===y));
}

// --- NPCs: Platzieren, Sprechen, Auftrag ---
console.log('\n--- NPC-System ---');
{
  const st = globalThis.state;
  const typen = Object.keys(globalThis.NPC_TYPES);
  console.log('  NPC-Sorten in der Tabelle :', typen.join(', '));

  // Ereignis darf nicht mehr abstuerzen
  [...globalThis.objects.entries()].filter(([k,o])=>o.type==='quest_npc').forEach(([k])=>globalThis.objects.delete(k));
  let absturz = false;
  try { globalThis.questNpcEvent(); } catch(e){ absturz = true; console.log('  questNpcEvent()          : AUSNAHME -> ' + e.message); }
  const nachEreignis = [...globalThis.objects.values()].filter(o=>o.type==='quest_npc');
  if(!absturz) console.log('  questNpcEvent()          : erzeugt ' + nachEreignis.length + ' NPC' +
    (nachEreignis.length ? ' (' + nachEreignis[0].npcTyp + ', "' + nachEreignis[0].name + '")' : ''));

  // Jede Sorte gezielt platzieren
  const platziert = [];
  for(const t of typen){
    const pos = globalThis.spawnNpc(t, st.player.x + 6, st.player.y + 6, 8);
    if(pos) platziert.push({ typ:t, ...pos });
    else console.log('  ' + t.padEnd(14) + ' KEIN PLATZ GEFUNDEN');
  }
  console.log('  gezielt platziert        :', platziert.length + ' von ' + typen.length);

  // Gespraech komplett durchklicken
  const p0 = platziert[0];
  const o = globalThis.objects.get(p0.x + ',' + p0.y);
  const body = w.document.getElementById('storyOverlay');
  const titel = () => w.document.getElementById('storyTitle').textContent;
  const text  = () => w.document.getElementById('storyDesc').textContent;
  const knopf = () => w.document.querySelector('#storyChoices button');

  globalThis.talkToQuestNpc(p0.x, p0.y, o);
  const verlauf = [];
  let n = 0;
  while(knopf() && n < 10){
    verlauf.push('"' + text().slice(0, 46) + '…"  [' + knopf().textContent + ']');
    const wars = knopf().textContent;
    knopf().click();
    n++;
    if(wars.includes('Wird gemacht') || wars.includes('Danke')) break;
  }
  console.log('  Gespraech mit ' + p0.name + ' (' + p0.typ + '), Titel: "' + titel() + '"');
  verlauf.forEach((z,i)=>console.log('    ' + (i+1) + '. ' + z));
  console.log('  Dialogschritte           :', verlauf.length, verlauf.length >= 3 ? ' mehrstufig' : ' ZU KURZ');
  console.log('  NPC nach Gespraech weg   :', globalThis.objects.has(p0.x + ',' + p0.y) ? 'NEIN, steht noch' : 'ja');
  console.log('  Nebenquests offen        :', (st.quests.side||[]).length);

  // aufraeumen
  platziert.forEach(p=>globalThis.objects.delete(p.x + ',' + p.y));
}

// --- Tag- und Nachtwechsel ---
console.log('\n--- Tag/Nacht ---');
{
  const rund = v => Math.round(v*1000)/1000;
  const { DAY_CYCLE_MS } = await import(pathToFileURL(path.join(ROOT,'engine/rng.js')).href);
  // Verlauf auf Knicke pruefen: zweite Ableitung darf nicht springen
  let maxSprung = 0, wo = 0, vorSteig = null, vor = null;
  for(let i=0;i<=400;i++){
    const p = i/400;
    const v = globalThis.darknessAt(p);
    if(vor !== null){
      const steig = v - vor;
      if(vorSteig !== null){
        const sprung = Math.abs(steig - vorSteig);
        if(sprung > maxSprung){ maxSprung = sprung; wo = p; }
      }
      vorSteig = steig;
    }
    vor = v;
  }
  console.log('  groesster Knick im Verlauf:', rund(maxSprung*1000)/1000, 'bei Phase', rund(wo),
              maxSprung < 0.0005 ? '  fliessend' : '  RUCKELT');
  console.log('  Mittag  ', rund(globalThis.darknessAt(0.50)),
              '| Abend ', rund(globalThis.darknessAt(0.72)),
              '| Mitternacht', rund(globalThis.darknessAt(0.00)),
              '| Morgen', rund(globalThis.darknessAt(0.28)));
  // Farbstimmung
  const zeig = p => globalThis.skyTintAt(p).join(',');
  console.log('  Himmelsfarbe Mittag      :', zeig(0.50));
  let spitzeAb = 0.5, maxWarm = -1;
  for(let i=500;i<=1000;i++){ const p=i/1000; const t=globalThis.skyTintAt(p); if(t[0]-t[2] > maxWarm){ maxWarm = t[0]-t[2]; spitzeAb = p; } }
  console.log('  waermste Abendphase      : ' + rund(spitzeAb) + ' -> ' + zeig(spitzeAb));
  console.log('  Himmelsfarbe Mitternacht :', zeig(0.00), '(kuehl/blau erwartet)');
  let spitzeMo = 0.5, maxWarmM = -1;
  for(let i=0;i<=500;i++){ const p=i/1000; const t=globalThis.skyTintAt(p); if(t[0]-t[2] > maxWarmM){ maxWarmM = t[0]-t[2]; spitzeMo = p; } }
  console.log('  waermste Morgenphase     : ' + rund(spitzeMo) + ' -> ' + zeig(spitzeMo));
  const abend = globalThis.skyTintAt(spitzeAb), nacht = globalThis.skyTintAt(0.00);
  console.log('  Abend waermer als Nacht  :', abend[0] > nacht[0] && abend[0] > abend[2] ? 'ja' : 'NEIN');
  console.log('  Nacht kuehler als Abend  :', nacht[2] > nacht[0] ? 'ja' : 'NEIN');
  console.log('  Lichtwaerme Mittag/Nacht :', rund(globalThis.lightWarmthAt(0.5)) + ' / ' + rund(globalThis.lightWarmthAt(0)));

  // Rendern zu vier Tageszeiten, mit Lagerfeuer
  const st = globalThis.state;
  const fx = st.player.x + 3, fy = st.player.y + 1;
  st.buildings.push({ type:'campfire', x:fx, y:fy, built:true, work:1, workReq:1, regionId:'C', rotation:0 });
  const c2d = globalThis.ctx;
  for(const [name, phase] of [['Mittag',0.5],['Abend',0.72],['Mitternacht',0.0],['Morgen',0.28]]){
    st.dayCycleOffset = Date.now() - phase * DAY_CYCLE_MS;
    for(const k of Object.keys(c2d.__calls)) delete c2d.__calls[k];
    const vorher = errors.length;
    try { globalThis.render(Date.now()); } catch(e){ errors.push('[tag] ' + e.message); }
    console.log('  ' + name.padEnd(12) + 'Dunkelheit ' + rund(globalThis.darknessAt(globalThis.dayPhaseNow())).toFixed(2) +
      '  Lichtkreise ' + String(c2d.__calls.arc || 0).padStart(3) +
      '  Fuellungen ' + String(c2d.__calls.fill || 0).padStart(4) +
      (errors.length > vorher ? '   FEHLER' : ''));
  }
  st.buildings.splice(st.buildings.length - 1, 1);
}

// --- Inventar und Ausruestung ---
console.log('\n--- Inventar / Ausruestung ---');
{
  const $ = id => w.document.getElementById(id);
  const taste = k => w.dispatchEvent(new w.KeyboardEvent('keydown', { key:k, code:'Key'+k.toUpperCase(), bubbles:true }));
  const offen = () => !$('characterOverlay').classList.contains('hidden');
  const reiter = () => { const t = w.document.querySelector('#charTabs .wizTab.active'); return t ? t.dataset.chartab : '-'; };
  const sichtbar = name => { const p = w.document.querySelector('.charPane[data-charpane="'+name+'"]'); return p && !p.classList.contains('hidden'); };

  // Material fuer den Test
  Object.assign(globalThis.state.inventory, { wood:20, stone:15, berries:6, metal:8, fiber:9, copper:6, silver:4 });

  if(offen()) globalThis.closeCharacter();
  taste('u');
  console.log('  Taste U oeffnet          :', offen() ? 'ja, Reiter "' + reiter() + '"' : 'NEIN');
  console.log('  Inventar-Bereich sichtbar:', sichtbar('inventar') ? 'ja' : 'NEIN');
  const plaetze = w.document.querySelectorAll('#invSlotGrid .slotItem').length;
  const gefuellt = w.document.querySelectorAll('#invSlotGrid .slotItem:not(.empty)').length;
  console.log('  Inventarplaetze          :', plaetze, 'davon belegt:', gefuellt);
  const ziehbar = [...w.document.querySelectorAll('#invSlotGrid .slotItem')].filter(e => e.draggable).length;
  console.log('  davon ziehbar            :', ziehbar);

  taste('p');
  console.log('  Taste P schaltet um      :', offen() ? 'offen, Reiter "' + reiter() + '"' : 'GESCHLOSSEN (falsch)');
  console.log('  Ausruestungsplaetze      :', w.document.querySelectorAll('#charEquipSlots .equipSlot').length);
  taste('p');
  console.log('  Taste P schliesst        :', offen() ? 'NEIN, noch offen' : 'ja');

  // Ausruesten per Ziehen nachstellen
  globalThis.openInventory();
  const vorher = JSON.stringify(globalThis.state.player.gear || {});
  const kupfer = globalThis.state.inventory.copper;
  globalThis.craftForSlotFromDrag('weapon');
  const nachher = JSON.stringify(globalThis.state.player.gear || {});
  console.log('  Schmieden per Ziehen     :', vorher + '  ->  ' + nachher + (vorher !== nachher ? '  wirkt' : '  KEINE WIRKUNG'));
  console.log('  Material verbraucht      :', kupfer !== globalThis.state.inventory.copper ? 'ja' : 'nein (anderes Material)');

  // Essen
  globalThis.state.stats.hunger = 40;
  const hungerVor = globalThis.state.stats.hunger;
  const essen = w.document.querySelector('#invFoodList button');
  if(essen){ essen.click(); console.log('  Essen aus dem Inventar   :', hungerVor + ' -> ' + globalThis.state.stats.hunger); }
  else console.log('  Essen aus dem Inventar   : kein Nahrungsmittel vorhanden');
  globalThis.closeCharacter();
}

// --- Kachelraster: liegen alle Kacheln auf ganzen Pixeln? ---
console.log('\n--- Kachelraster ---');
{
  const c2d = globalThis.ctx;
  const nachkomma = v => Math.abs(v - Math.round(v)) > 0.001;
  let krumm = 0, geprueft = 0, luecken = 0, beispiel = null;
  for(const versatz of [0, 0.45, 0.9, 1.35, 0.5, 0.333, 0.777]){
    globalThis.cameraFreeMode = true;
    globalThis.camera.x = 40 + versatz;
    globalThis.camera.y = 30 + versatz;
    c2d.__rects.length = 0;
    try { globalThis.render(Date.now()); } catch(e){ console.log('  render-Fehler: ' + e.message); break; }
    const kacheln = c2d.__rects.filter(r => r[3] >= 32 && r[4] >= 32);
    kacheln.forEach(r => {
      geprueft++;
      if(nachkomma(r[1]) || nachkomma(r[2])){ krumm++; if(!beispiel) beispiel = 'x=' + r[1] + ' y=' + r[2]; }
    });
    if(kacheln.length){
      const y0 = kacheln[0][2];
      const zeile = kacheln.filter(r => Math.abs(r[2] - y0) < 0.01).map(r => [r[1], r[3]]).sort((a,b) => a[0]-b[0]);
      for(let i=1;i<zeile.length;i++){
        if(zeile[i][0] - (zeile[i-1][0] + zeile[i-1][1]) > 0.001) luecken++;
      }
    }
  }
  globalThis.cameraFreeMode = false;
  console.log('  gepruefte Kacheln        :', geprueft, 'bei 7 Kamerapositionen');
  console.log('  auf Bruchteil-Pixeln     :', krumm ? krumm + '  Beispiel ' + beispiel : 'keine');
  console.log('  Luecken zwischen Nachbarn:', luecken ? luecken : 'keine');
  console.log('  Kantenglaettung aus      :', c2d.imageSmoothingEnabled === false ? 'ja' : 'NEIN');
}

// --- Navigation im Charakter-Erstellungsmenue ---
console.log('\n--- Startablauf: Vor und Zurueck ---');
{
  const $ = id => w.document.getElementById(id);
  const schritt = () => globalThis.aktiverStartSchritt();
  const reiter  = () => globalThis.aktiverWizSchritt();
  const zurueck = $('btnStartBack');
  const wo = () => (schritt() || 'startOverlay zu') + (schritt()==='crewStep' ? ' / Reiter '+reiter() : '');
  const klick = id => { const e = $(id); if(!e) { console.log('  Element fehlt: '+id); return; } e.click(); };

  console.log('  Zurueck-Knopf im HTML    :', zurueck ? 'vorhanden' : 'FEHLT');

  // Vorwaerts: Titel -> Startart -> Figurenerstellung -> Reiter 3
  $('startOverlay').classList.add('hidden');
  klick('tbStart');
  console.log('  nach "Spiel starten"     :', wo());
  klick('btnSolo');
  console.log('  nach "Solo-Survival"     :', wo());
  globalThis.switchWizStep(3);
  console.log('  nach Reiterwechsel       :', wo(), '| Knopf: "' + zurueck.textContent + '"');

  // Rueckwaerts, Schritt fuer Schritt
  const weg = [];
  for(let i=0;i<6;i++){
    const vorher = wo();
    zurueck.click();
    weg.push(vorher + '  ->  ' + wo());
    if(schritt() === null) break;
  }
  console.log('  Rueckweg:');
  weg.forEach(z=>console.log('    ' + z));
  console.log('  Endet auf Titelbildschirm:',
    $('startOverlay').classList.contains('hidden') && !$('mainTitleScreen').classList.contains('hidden') ? 'ja' : 'NEIN');

  // Escape muss denselben Weg nehmen
  klick('tbStart'); klick('btnMulti');
  const vorEsc = wo();
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
  console.log('  Escape                   :', vorEsc + '  ->  ' + wo());

  // Kein Feststecken: aus jedem Schritt kommt man heraus
  let haenger = [];
  for(const start of ['titleStep','modeStep','crewStep']){
    $('startOverlay').classList.remove('hidden');
    globalThis.zeigeStartSchritt(start, {zuruecksetzen:true, merken:false});
    let n = 0;
    while(!$('startOverlay').classList.contains('hidden') && n < 10){ zurueck.click(); n++; }
    if(n >= 10) haenger.push(start);
  }
  console.log('  Schritte ohne Ausweg     :', haenger.length ? haenger.join(', ') : 'keine');
}

  const gr = c2d.__rects.filter(([k,x,y,ww,hh]) => ww > TILE || hh > TILE);
// --- Schwarzer Balken beim Lagerfeuer? ---
console.log('\n--- Lagerfeuer: dunkle Flaechen je Drehung ---');
{
  const c2d = globalThis.ctx;
  for(const rot of [0,90,180,270]){
    c2d.__rects.length = 0; c2d.__stack.length = 0;
    for(const k of Object.keys(c2d.__calls)) delete c2d.__calls[k];
    const b = { type:'campfire', x:5, y:5, built:true, work:1, workReq:1, regionId:'C', rotation:rot };
    globalThis.drawBuilding(b, 100, 100);
    // dunkle, hohe Rechtecke aufspueren (Balken)
    const balken = c2d.__rects.filter(([k,x,y,w,h]) => h > 12 && w <= 10);
    console.log('  ' + String(rot).padStart(3) + '°  Rechtecke: ' + String(c2d.__rects.length).padStart(2) +
      '  schmale hohe Balken: ' + (balken.length
        ? balken.map(([k,x,y,w,h]) => 'x=' + (x-100) + ' b=' + w + ' h=' + h).join(', ') + '   <-- BALKEN'
        : 'keine'));
  }
}


// --- Alle Bauten: vier Ansichten, aufrecht, in der Kachel ---
console.log('\n--- Ausrichtung aller Bauten ---');
{
  const c2d = globalThis.ctx;
  const alle = Object.keys(globalThis.BUILDING_TYPES);
  const waende = alle.filter(t => /wand|wall/.test(t)).concat(['zaun','door','tower']);
  const boeden = globalThis.FLAT_BUILDINGS || [];
  const aus = new Set([...waende, ...boeden]);
  const pruefen = alle.filter(t => !aus.has(t));
  let ohneAnsichten = [], kaputt = [], ausserhalb = [];
  for(const t of pruefen){
    const sigs = [];
    for(const rot of [0,90,180,270]){
      c2d.__rects.length = 0; c2d.__stack.length = 0;
      for(const k of Object.keys(c2d.__calls)) delete c2d.__calls[k];
      const b = { type:t, x:5, y:5, built:true, work:1, workReq:1, regionId:'C', rotation:rot };
      try { globalThis.drawBuilding(b, 100, 100); }
      catch(e){ kaputt.push(t + '@' + rot + ' ' + e.message); continue; }
      if(c2d.__stack.length !== 0) kaputt.push(t + '@' + rot + ' save/restore offen');
      const raus = c2d.__rects.filter(([k,x,y,w,h,beschnitten]) =>
        !beschnitten && (x < 96 || y < 96 || x+w > 140 || y+h > 140));
      if(raus.length) ausserhalb.push(t + '@' + rot + ' ' + JSON.stringify(raus[0]));
      sigs.push(JSON.stringify(c2d.__rects.map(r=>r.slice(1).map(v=>Math.round(v)))));
    }
    if(new Set(sigs).size < 3) ohneAnsichten.push(t + '(' + new Set(sigs).size + ')');
  }
  console.log('  geprueft (ohne Waende/Tueren/Boeden):', pruefen.length);
  console.log('  weniger als 3 Ansichten            :', ohneAnsichten.length ? ohneAnsichten.join(', ') : 'keine');
  console.log('  Ausnahme / save-restore offen      :', kaputt.length ? kaputt.slice(0,5).join(' | ') : 'keine');
  console.log('  ragt aus der Kachel                :', ausserhalb.length ? ausserhalb.slice(0,5).join(', ') + (ausserhalb.length>5?' …':'') : 'keine');
}

  c2d.__texts.length = 0;
// --- Lichtquellen und Avatar im Barbier ---
console.log('\n--- Fackeln / Avatar ---');
{
  const LS = globalThis.LIGHT_SOURCES || {};
  console.log('  Lichtquellen eingetragen:', Object.keys(LS).join(', ') || 'KEINE');
  console.log('  fackel leuchtet          :', LS.fackel ? 'ja, Radius ' + LS.fackel.radius + ', Flackern ' + LS.fackel.flacker : 'NEIN');
  console.log('  campfire unveraendert    :', LS.campfire ? 'Radius ' + LS.campfire.radius : 'FEHLT');
  // Nachtebene mit Fackel zeichnen und Lichtloecher zaehlen
  const st = globalThis.state;
  const c2d = globalThis.ctx;
  const fx = st.player.x + 2, fy = st.player.y;
  st.buildings.push({ type:'fackel', x:fx, y:fy, built:true, work:1, workReq:1, regionId:'C', rotation:0 });
  const zaehle = ()=>{
    const vorher = c2d.__calls.arc || 0;
    globalThis.drawNightOverlay(Date.now(), { x: st.player.x, y: st.player.y });
    return (c2d.__calls.arc || 0) - vorher;
  };
  // Nutzt die Nachtebene die Tabelle wirklich, oder steht dort noch campfire fest?
  const quelle = globalThis.drawNightOverlay.toString();
  console.log('  Nachtebene nutzt Tabelle :', quelle.includes('LIGHT_SOURCES') ? 'ja' : 'NEIN');
  console.log('  campfire fest verdrahtet :', /campfire'\s*&&/.test(quelle) ? 'JA — noch alt' : 'nein');
  // Mit Fackel rendern: darf keinen Fehler werfen
  const vorher = errors.length;
  try { globalThis.drawNightOverlay(Date.now(), { x: st.player.x, y: st.player.y }); }
  catch(e){ errors.push('[nacht] ' + e.message); }
  console.log('  Rendern mit Fackel       :', errors.length === vorher ? 'fehlerfrei' : 'FEHLER');
  st.buildings.splice(st.buildings.length - 1, 1);

  // Avatar im Barbier
  const body = w.document.getElementById('interiorBody');
  const b = { type:'barber', x:5, y:5, built:true, work:1, workReq:1, regionId:'C', rotation:0 };
  globalThis.renderInteriorBody(b);
  const vorschau = body.querySelector('canvas.apPreview');
  const stage = w.document.getElementById('avatarStage');
  console.log('  Avatar-Canvas im Barbier :', vorschau ? vorschau.width + 'x' + vorschau.height + ' vorhanden' : 'FEHLT');
  console.log('  liegt im Barbier-Fenster :', vorschau ? (body.contains(vorschau) ? 'ja' : 'NEIN, woanders') : '-');
  console.log('  Wuerfel-Knopf sichtbar   :', body.querySelector('.apDice') ? 'ja' : 'nein');
}

  for(const k of Object.keys(c2d.__calls)) delete c2d.__calls[k];
// --- Moebel in allen vier Ausrichtungen ---
console.log('\n--- Moebel: Sprites und Ausrichtung ---');
{
  const c2d = globalThis.ctx;
  const cat = globalThis.BUILDING_MENU_CATEGORY || {};
  const moebel = Object.keys(cat).filter(t => cat[t] === 'moebel' || cat[t] === 'freizeit');
  const selbst = ['stuhl','bank','kommode','schreibtisch','bibliothek','vorratskammer',
                  'krankenstube','barber','kamin','lagerkiste','tent'];
  let probleme = 0;
  for(const t of moebel){
    const zeilen = [];
    for(const rot of [0,90,180,270]){
      c2d.__texts.length = 0; c2d.__rects.length = 0; c2d.__stack.length = 0;
      for(const k of Object.keys(c2d.__calls)) delete c2d.__calls[k];
      const b = { type:t, x:5, y:5, built:true, work:1, workReq:1, regionId:'C', rotation:rot };
      let fehler = '';
      try { globalThis.drawBuilding(b, 100, 100); } catch(e){ fehler = 'AUSNAHME'; }
      const zeichen = Object.values(c2d.__calls).reduce((a,b)=>a+b, 0);
      const signatur = JSON.stringify(c2d.__rects.map(r=>r.slice(1).map(v=>Math.round(v*2)/2)));
      const notbehelf = c2d.__texts.includes('❔');
      const offen = c2d.__stack.length;
      zeilen.push({ rot, zeichen, notbehelf, offen, fehler, signatur });
    }
    const kaputt = zeilen.filter(z => z.fehler || z.notbehelf || z.offen !== 0 || z.zeichen < 3);
    const varianz = new Set(zeilen.map(z=>z.signatur)).size;
    const eigen = selbst.includes(t);
    const status = kaputt.length ? 'PROBLEM' :
      (eigen && varianz === 1 ? 'IGNORIERT DREHUNG' : (eigen ? varianz+' eigene Ansichten' : 'ok'));
    if(kaputt.length) probleme++;
    console.log('  ' + t.padEnd(15) + 'Zeichenaufrufe je Drehung: ' +
      zeilen.map(z=>String(z.zeichen).padStart(3)).join(' ') +
      '  ' + status +
      (kaputt.length ? '  -> ' + kaputt.map(z=>z.rot+'°:'+(z.fehler||(z.notbehelf?'❔':'save-offen '+z.offen))).join(', ') : ''));
  }
  console.log('  Moebel mit Problemen: ' + (probleme || 'keine'));
}

// --- Begehbarkeit: Tuer ja, Waende und Fenster nein ---
console.log('\n--- Begehbarkeit ---');
{
  const st = globalThis.state;
  const bx = st.player.x + 34, by = st.player.y + 34;
  const typen = ['wall','door','zaun',
                 'holzwand1','holzwand2','holzwand3',
                 'fensterwand1','fensterwand2','fensterwand3',
                 'metallwand1','metallwand2','metallwand3'];
  const erwartet = { door:true };   // alles andere blockiert
  let fehler = 0;
  typen.forEach((t,i)=>{
    const x = bx + i, y = by;
    st.buildings.push({ type:t, x, y, built:true, work:1, workReq:1, regionId:'C', rotation:0 });
    const frei = globalThis.passable(x, y);
    const soll = !!erwartet[t];
    if(frei !== soll) fehler++;
    console.log('  ' + t.padEnd(14) + (frei ? 'begehbar    ' : 'blockiert   ') +
                (frei === soll ? 'wie gewollt' : 'FALSCH (erwartet ' + (soll ? 'begehbar' : 'blockiert') + ')'));
  });
  console.log('  Abweichungen: ' + (fehler || 'keine'));
  st.buildings.splice(st.buildings.length - typen.length, typen.length);
}

  const fireEmoji = c2d.__texts.filter(t=>t==='🔥'||t==='❔');
// --- Halbe Fenster, mittige Tueren, Wandrichtung ---
console.log('\n--- Fenster / Tuer / Ausrichtung ---');
{
  const c2d = globalThis.ctx;
  const st = globalThis.state;
  const bx = st.player.x + 30, by = st.player.y + 30;
  const mk = (t,x,y)=>({ type:t, x, y, built:true, work:1, workReq:1, regionId:'C', rotation:0 });
  // waagerechte Mauer mit Fenster und Tuer, plus senkrechte Mauer
  const bau = [mk('wall',bx,by), mk('fensterwand2',bx+1,by), mk('door',bx+2,by), mk('wall',bx+3,by),
               mk('wall',bx+6,by), mk('fensterwand2',bx+6,by+1), mk('door',bx+6,by+2), mk('wall',bx+6,by+3)];
  st.buildings.push(...bau);
  const richtung = (b)=>globalThis.wandRichtung(b);
  console.log('  Fenster in waagerechter Mauer:', richtung(bau[1]));
  console.log('  Tuer    in waagerechter Mauer:', richtung(bau[2]));
  console.log('  Fenster in senkrechter Mauer :', richtung(bau[5]));
  console.log('  Tuer    in senkrechter Mauer :', richtung(bau[6]));

  function flaeche(b){
    c2d.__rects.length = 0;
    for(const k of Object.keys(c2d.__calls)) delete c2d.__calls[k];
    globalThis.drawBuilding(b, 100, 100);
    // groesste zusammenhaengende Rechtecksbreite/-hoehe als Mass
    let maxW = 0, maxH = 0, summe = 0;
    c2d.__rects.forEach(([k,x,y,w,h])=>{ if(w>maxW) maxW=w; if(h>maxH) maxH=h; summe += Math.abs(w*h); });
    return { maxW, maxH, summe, n: c2d.__rects.length };
  }
  const w1 = flaeche(bau[0]);                        // volle Mauer
  const f1 = flaeche(bau[1]);                        // Fenster waagerecht
  const f2 = flaeche(bau[5]);                        // Fenster senkrecht
  console.log('  volle Mauer   bedeckte Flaeche: ' + Math.round(w1.summe));
  console.log('  Fenster waagr bedeckte Flaeche: ' + Math.round(f1.summe) +
              '  Anteil: ' + (f1.summe/w1.summe).toFixed(2) +
              (f1.summe < w1.summe*0.75 ? '  schmaler als die Mauer' : '  ZU BREIT'));
  console.log('  Fenster senkr bedeckte Flaeche: ' + Math.round(f2.summe) +
              '  Anteil: ' + (f2.summe/w1.summe).toFixed(2));

  // Tuer: liegt das Blatt mittig?
  c2d.__rects.length = 0;
  globalThis.drawBuilding(bau[2], 100, 100);
  const TILE = 32, ox = 100, oy = 100;
  const gross = c2d.__rects.filter(([k,x,y,w,h]) => w > 12 && h > 12);
  const mitten = gross.map(([k,x,y,w,h]) => [ (x + w/2 - ox).toFixed(1), (y + h/2 - oy).toFixed(1) ]);
  const zentriert = mitten.every(([mx,my]) => Math.abs(mx - TILE/2) < 1.5 && Math.abs(my - TILE/2) < 1.5);
  console.log('  Tuerblatt-Mittelpunkte      : ' + JSON.stringify(mitten) +
              (zentriert ? '  mittig' : '  NICHT MITTIG (Soll 16.0/16.0)'));
  const zuGross = c2d.__rects.filter(([k,x,y,w,h]) => w > 36 || h > 36).length;
  console.log('  Tuer ragt ueber die Kachel  : ' + (zuGross ? 'JA' : 'nein'));
  st.buildings.splice(st.buildings.length - bau.length, bau.length);
}

  console.log('  Feuer -> Emoji-Notbehelf :', fireEmoji.length ? 'JA ('+fireEmoji.join()+')' : 'nein');
// --- Neue Wandvarianten ---
console.log('\n--- Neue Wandstufen ---');
{
  const neue = ['holzwand1','holzwand2','holzwand3','fensterwand1','fensterwand2','fensterwand3',
                'metallwand1','metallwand2','metallwand3'];
  const c2d = globalThis.ctx;
  const BT = globalThis.BUILDING_TYPES;
  for(const t of neue){
    const def = BT[t];
    c2d.__texts.length = 0; c2d.__rects.length = 0;
    for(const k of Object.keys(c2d.__calls)) delete c2d.__calls[k];
    const b = { type:t, x:5, y:5, built:true, work:1, workReq:1, regionId:'C', rotation:0 };
    let fehler = '';
    try { globalThis.drawBuilding(b, 100, 100); } catch(e){ fehler = ' AUSNAHME: '+e.message; }
    const zu_gross = c2d.__rects.filter(([k,x,y,ww,hh]) => ww > 36 || hh > 36).length;
    const emoji = c2d.__texts.includes('❔');
    console.log('  ' + t.padEnd(14) +
      (def ? 'definiert' : 'FEHLT   ') +
      ' | Linie:' + (globalThis.BUILD_CATEGORY[t] === 'line' ? 'ja ' : 'NEIN') +
      ' | Autotiling:' + (globalThis.AUTOTILED.includes(t) ? 'ja ' : 'NEIN') +
      ' | Verteidigung:' + String(globalThis.WALL_DEFENSE_FACTOR[t] ?? 'KEINE').padEnd(4) +
      ' | Zeichnen:' + (emoji ? '❔ NOTBEHELF' : (zu_gross ? 'ZU GROSS' : 'ok')) + fehler);
  }
  // Verbinden sich die neuen Waende untereinander?
  const px = globalThis.state.player.x + 20, py = globalThis.state.player.y + 20;
  const mk = (t,x,y)=>({ type:t, x, y, built:true, work:1, workReq:1, regionId:'C', rotation:0 });
  globalThis.state.buildings.push(mk('holzwand2',px,py), mk('fensterwand2',px+1,py), mk('metallwand3',px+2,py));
  const mitte = globalThis.state.buildings.find(b=>b.type==='fensterwand2' && b.x===px+1);
  const c = globalThis.fenceConnections(mitte);
  console.log('  Fensterwand zwischen Holz- und Metallwand: west=' + c.w + ' ost=' + c.e +
              (c.w && c.e ? '  verbindet sich' : '  VERBINDET NICHT'));
}

  console.log('  Feuer -> Zeichenaufrufe  : fill=' + (c2d.__calls.fill||0) + ' ellipse=' + (c2d.__calls.ellipse||0) + ' arc=' + (c2d.__calls.arc||0));
// --- Respawn: waechst noch etwas in der Basis oder auf Wasser? ---
console.log('\n--- Respawn-Regeln ---');
{
  const st = globalThis.state;
  const px = st.player.x, py = st.player.y;
  // Umgebung freiraeumen: andere Tests haben hier Bauten hinterlassen,
  // die den Abstandsring verfaelschen wuerden
  st.buildings = st.buildings.filter(b => Math.abs(b.x-px) > 6 || Math.abs(b.y-py) > 6);
  st.buildings.push({ type:'tent', x:px, y:py, built:true, work:1, workReq:1, regionId:'C', rotation:0 });
  const faelle = [
    ['auf dem Gebaeude',        px,     py,     false],
    ['direkt daneben',          px+1,   py,     false],
    ['zwei Felder entfernt',    px+2,   py,     false],
    ['drei Felder entfernt',    px+3,   py+3,   true ],
    ['ausserhalb der Karte',    -5,     10,     false],
    ['jenseits des Randes',     99999,  10,     false],
  ];
  for(const [name, x, y, erwartet] of faelle){
    const ist = globalThis.respawnErlaubt(x, y);
    console.log('  ' + name.padEnd(22) + 'erlaubt: ' + String(ist).padEnd(6) +
                (ist === erwartet ? ' wie erwartet' : ' ABWEICHUNG (erwartet ' + erwartet + ')'));
  }
  // Wasser suchen und pruefen
  let wasser = null;
  for(let y=0; y<globalThis.WORLD_H && !wasser; y++)
    for(let x=0; x<globalThis.WORLD_W; x++)
      if(globalThis.tileAt(x,y) === globalThis.TILE_WATER){ wasser = [x,y]; break; }
  console.log('  auf Wasser            erlaubt: ' +
    (wasser ? String(globalThis.respawnErlaubt(wasser[0], wasser[1])) + (globalThis.respawnErlaubt(wasser[0],wasser[1]) ? ' FEHLER' : ' korrekt abgelehnt') : '(kein Wasser gefunden)'));
  // Warteschlange: ungeeigneter Eintrag darf nicht ewig haengen
  globalThis.respawnQueue = [{ x:-5, y:10, type:'tree', at: Date.now()-1000 },
                             { x:px, y:py, type:'tree', at: Date.now()-1000 }];
  const vorher = globalThis.respawnQueue.length;
  globalThis.processRespawns();
  console.log('  Warteschlange ' + vorher + ' -> ' + globalThis.respawnQueue.length +
    ' (ungueltiges Feld verworfen, belegtes bleibt: ' + (globalThis.respawnQueue.length === 1 ? 'ja' : 'nein') + ')');
  console.log('  Baum in der Basis gesetzt: ' + (globalThis.objects.has(px+','+py) ? 'JA — FEHLER' : 'nein'));
}

// --- Gebaeude-Innenraeume: kommt Bedienoberflaeche statt Zeichencode? ---
console.log('\n--- Innenraeume (Barbier, Bibliothek, Krankenstube) ---');
{
  const body = w.document.getElementById('interiorBody');
  for(const typ of ['barber','bibliothek','krankenstube','brunnen','zwinger','research']){
    const b = { type:typ, x:5, y:5, built:true, work:1, workReq:1, regionId:'C', rotation:0 };
    const vorher = errors.length;
    try { globalThis.renderInteriorBody(b); }
    catch(e){ console.log('  ' + typ.padEnd(14) + ' AUSNAHME: ' + e.message); continue; }
    const knoepfe = body.querySelectorAll('button').length;
    const felder  = body.querySelectorAll('select, input').length;
    const text    = body.textContent.trim().length;
    console.log('  ' + typ.padEnd(14) + ' Knoepfe:' + String(knoepfe).padStart(2) +
                '  Auswahl:' + felder + '  Text:' + String(text).padStart(4) +
                (knoepfe + felder === 0 ? '   <-- UNBENUTZBAR' : '') +
                (errors.length > vorher ? '  FEHLER' : ''));
  }
  // Barbier wirklich bedienen
  const b = { type:'barber', x:5, y:5, built:true, work:1, workReq:1, regionId:'C', rotation:0 };
  globalThis.renderInteriorBody(b);
  const vorher = JSON.stringify(globalThis.state.player.appearance || null);
  const wuerfel = [...body.querySelectorAll('button')].find(x=>x.textContent.includes('würfeln'));
  if(!wuerfel){ console.log('  Wuerfel-Knopf fehlt'); }
  else {
    wuerfel.click();
    await new Promise(r=>setTimeout(r,120));
    const nachher = JSON.stringify(globalThis.state.player.appearance || null);
    console.log('  Aussehen per Klick geaendert:', nachher !== vorher ? 'JA' : 'NEIN');
  }
  const auswahl = body.querySelector('select');
  console.log('  Auswahl Personen            :', auswahl ? auswahl.options.length + ' Eintraege' : 'fehlt');
}

// --- Feld im Zustand "bereit" ---
console.log('\n--- Feld: Zeichenbefehle im Zustand bereit ---');
{
  const c2d = globalThis.ctx;
  const feld = { type:'feld_getreide', x:5, y:5, built:true, work:1, workReq:1, regionId:'C',
                 rotation:0, plantedAt: Date.now() - 99999999, ready:true };
  console.log('  Wachstum:', globalThis.fieldGrowthProgress(feld));
  c2d.__log.length = 0; c2d.__stack.length = 0; c2d.globalAlpha = 1; c2d.fillStyle = '#000';
  globalThis.drawBuilding(feld, 100, 100);
  console.log('  save/restore ausgeglichen:', c2d.__stack.length === 0 ? 'ja' : 'NEIN, offen: '+c2d.__stack.length);
  console.log('  globalAlpha am Ende      :', c2d.globalAlpha);
  console.log('  Zeichenbefehle:');
  c2d.__log.forEach(([art,txt,fs,ga])=>{
    const schwach = (art==='fillText' && (ga < 0.9 || (typeof fs==='string' && /rgba\([^)]*0?\.[0-2]\d*\)/.test(fs))));
    console.log('    ' + art.padEnd(9) + String(txt||'').padEnd(4) + ' fillStyle=' + String(fs).padEnd(26) + ' alpha=' + ga + (schwach ? '   <-- fast unsichtbar' : ''));
  });
}

// --- Umstellung auf echte Importe: sind rng/audio noch global? ---
console.log('\n--- Modulgrenzen (rng.js / audio.js) ---');
{
  const nsA = await import(pathToFileURL(path.join(ROOT,'engine/audio.js')).href);
  const weg = ['clamp','genId','hash2','mulberry32','lerp','DAY_CYCLE_MS','soundEnabled','musicEnabled','sfxEvent','startMusicTrack'];
  const nochGlobal = weg.filter(n => n in globalThis);
  console.log('  nicht mehr global        :', weg.length - nochGlobal.length, 'von', weg.length);
  console.log('  noch global (unerwuenscht):', nochGlobal.length ? nochGlobal.join(', ') : 'keiner');
  // Schalter ueber die neue Setter-Schnittstelle
  const vorher = nsA.soundEnabled;
  nsA.setSoundEnabled(!vorher);
  console.log('  setSoundEnabled()        :', vorher, '->', nsA.soundEnabled, nsA.soundEnabled !== vorher ? ' wirkt' : ' WIRKT NICHT');
  nsA.setSoundEnabled(vorher);
  const vm = nsA.musicEnabled;
  nsA.setMusicEnabled(!vm);
  console.log('  setMusicEnabled()        :', vm, '->', nsA.musicEnabled, nsA.musicEnabled !== vm ? ' wirkt' : ' WIRKT NICHT');
  nsA.setMusicEnabled(vm);
  // Der Knopf in der Oberflaeche muss weiterhin funktionieren
  const btn = w.document.getElementById('btnSoundToggle');
  const v0 = nsA.soundEnabled; btn.click();
  console.log('  Knopf in der Oberflaeche :', v0, '->', nsA.soundEnabled, nsA.soundEnabled !== v0 ? ' wirkt' : ' WIRKT NICHT');
  btn.click();
}

// --- Laden im laufenden Spiel: bleiben Fenster offen? ---
console.log('\n--- Laden im laufenden Spiel ---');
{
  const offen = () => [...w.document.querySelectorAll('.overlay')]
     .filter(e=>!e.classList.contains('hidden') && e.id !== 'mainTitleScreen').map(e=>e.id);
  await globalThis.saveGame(globalThis.slotKey ? globalThis.slotKey(1) : 'wildwood-slot-1');
  // Menue und Speicherplatzliste oeffnen, wie es der Spieler tut
  globalThis.openOverlay('mainMenuOverlay');
  globalThis.openOverlay('slotsOverlay');
  console.log('  vor dem Laden :', offen(), '| gameMode:', globalThis.gameMode);
  const ok = await globalThis.reloadGameMidSession(globalThis.slotKey ? globalThis.slotKey(1) : 'wildwood-slot-1');
  await new Promise(r=>setTimeout(r,200));
  const rest = offen();
  console.log('  geladen       :', ok);
  console.log('  nach dem Laden:', rest.length ? rest : '(alles zu)', '| gameMode:', globalThis.gameMode, '| paused:', globalThis.paused);
  const stimmig = (rest.length === 0 && globalThis.gameMode === 'micro');
  console.log('  Zustand stimmig:', stimmig ? 'JA' : 'NEIN — Welt laeuft hinter offenem Fenster');
  console.log('  overlayStack  :', JSON.stringify(globalThis.overlayStack));
}

}
// --- Statuseffekte: wirkt Frost jetzt? ---
console.log('\n--- Statuseffekt Frost ---');
{
  const nsB = await import(pathToFileURL(path.join(ROOT,'ui/battle.js')).href);
  const eff = globalThis.effectiveSpd;
  if(typeof eff !== 'function'){ console.log('  effectiveSpd nicht vorhanden -> Frost wirkt NICHT'); }
  else {
    const flink = { spd: 20, statuses: [] };
    const kalt  = { spd: 20, statuses: [{ key:'freeze', turns:2 }] };
    const gift  = { spd: 20, statuses: [{ key:'poison', turns:3 }] };
    console.log('  ohne Effekt        spd 20 ->', eff(flink,'ally'));
    console.log('  mit Frost          spd 20 ->', eff(kalt,'ally'), eff(kalt,'ally') < 20 ? ' verlangsamt' : ' KEINE Wirkung');
    console.log('  mit Gift (kein slow) spd 20 ->', eff(gift,'ally'), eff(gift,'ally') === 20 ? ' unveraendert (richtig)' : ' FALSCH');
    // Zugreihenfolge: langsamer Gegner ohne Frost schlaegt schnellen mit Frost
    const a = { kind:'ally', ref:{ spd: 20, statuses:[{key:'freeze',turns:2}] } };
    const b = { kind:'ally', ref:{ spd: 14, statuses:[] } };
    const reihe = [a,b].sort((x,y)=> eff(y.ref,y.kind) - eff(x.ref,x.kind));
    console.log('  Reihenfolge: eingefroren(20)=' + eff(a.ref,'ally') + ' vs normal(14)=' + eff(b.ref,'ally') +
                ' -> zuerst: ' + (reihe[0] === b ? 'der normale (richtig)' : 'der eingefrorene (FALSCH)'));
    // Robustheit: fehlende Felder duerfen kein NaN erzeugen
    const kaputt = eff({ statuses: null }, 'ally');
    console.log('  ohne spd-Feld      ->', kaputt, Number.isFinite(kaputt) ? ' kein NaN' : ' NaN!');
  }
}


// --- Canvas-Seitenverhaeltnis pruefen ---
console.log('\n--- Canvas-Seitenverhaeltnis ---');
{
  const cv = w.document.getElementById('game');
  const stage = cv.parentElement;
  const faelle = [
    ['dein Fall (Konsole)', 1600, 420],
    ['Laptop 16:9',         1280, 720],
    ['schmales Fenster',     640, 900],
    ['exakt 5:3',            800, 480],
    ['Vollbild 1080p',      1920, 1080],
    ['Handy quer',           844, 390],
  ];
  const soll = cv.width / cv.height;
  for(const [name, bw, bh] of faelle){
    Object.defineProperty(stage, 'clientWidth',  { value: bw, configurable: true });
    Object.defineProperty(stage, 'clientHeight', { value: bh, configurable: true });
    const r = globalThis.fitCanvasToStage();
    const ist = r.w / r.h;
    const abw = Math.abs(ist - soll) / soll;
    const passt = r.w <= bw && r.h <= bh;
    console.log('  ' + name.padEnd(21) + 'Buehne ' + (bw+'x'+bh).padEnd(10) +
      '-> Canvas ' + (r.w+'x'+r.h).padEnd(11) + 'Verh. ' + ist.toFixed(4) +
      (abw < 0.005 ? '  korrekt' : '  VERZERRT ' + (abw*100).toFixed(1) + '%') +
      (passt ? '' : '  RAGT HERAUS'));
  }
  console.log('  Sollverhaeltnis 800/480 =', soll.toFixed(4));
}

// --- Jeder Gebaeudetyp einzeln zeichnen ---
console.log('\n--- Alle Gebaeudetypen zeichnen ---');
{
  const c2d = globalThis.ctx;
  const typen = Object.keys(globalThis.BUILDING_TYPES);
  const frag = [], leer = [], kaputt = [];
  for(const t of typen){
    c2d.__texts.length = 0; c2d.__rects.length = 0;
    for(const k of Object.keys(c2d.__calls)) delete c2d.__calls[k];
    const b = { type:t, x:5, y:5, built:true, work:1, workReq:1, regionId:'C', rotation:0 };
    try { globalThis.drawBuilding(b, 100, 100); }
    catch(e){ kaputt.push(t + ' (' + e.message + ')'); continue; }
    if(c2d.__texts.includes('❔')) frag.push(t);
    const zeichen = Object.entries(c2d.__calls).reduce((n,[k,v]) => n + v, 0);
    if(zeichen < 2) leer.push(t + '(' + zeichen + ')');
    const TILE = 32, ox = 100, oy = 100, TOL = 4;
    const aus = c2d.__rects.filter(([k,x,y,ww,hh]) => ww > TILE+TOL || hh > TILE+TOL);
    if(aus.length) kaputt.push(t + ' zu gross: ' + JSON.stringify(aus[0]));
  }
  console.log('  geprueft                 :', typen.length, 'Typen');
  console.log('  Fragezeichen ❔           :', frag.length ? frag.join(', ') : 'keiner');
  console.log('  fast nichts gezeichnet   :', leer.length ? leer.join(', ') : 'keiner');
  console.log('  Ausnahme / zu gross      :', kaputt.length ? kaputt.join(' | ') : 'keiner');
}

// --- Haertetest: Register absichtlich zerstoeren (simuliert alte panels.js) ---
console.log('\n--- Haertetest: leeres Overlay-Register ---');
const sicherung = Object.assign({}, globalThis.OVERLAYS);
for(const k of Object.keys(globalThis.OVERLAYS)) delete globalThis.OVERLAYS[k];
console.log('  Register geleert, Eintraege:', Object.keys(globalThis.OVERLAYS).length);
globalThis.showStoryDialog('Notfalltest','Text',[{label:'Weiter', action:()=>{ console.log('  >>> Aktion lief'); }}]);
await new Promise(r=>setTimeout(r,120));
const offen1 = !w.document.getElementById('storyOverlay').classList.contains('hidden');
w.document.querySelector('#storyChoices button').click();
await new Promise(r=>setTimeout(r,200));
const offen2 = !w.document.getElementById('storyOverlay').classList.contains('hidden');
console.log('  Dialog offen nach Anzeige :', offen1);
console.log('  Dialog offen nach Klick   :', offen2, offen2 ? '  <-- HAENGT' : '  <-- schliesst korrekt');
console.log('  Register danach           :', Object.keys(globalThis.OVERLAYS).length, 'Eintrag(e) nachgetragen');
console.log('  Hinweis: Nachtraege haben keinen onOpen-Haken — Notnagel, kein Ersatz.');
Object.assign(globalThis.OVERLAYS, sicherung);   // echtes Register wiederherstellen

// --- Alle Fenster einzeln oeffnen und schliessen ---
console.log('\n--- Overlay-Test ---');
const ids = ['craftOverlay','colonyOverlay','dexOverlay','researchOverlay','journalOverlay',
  'characterOverlay','chronikOverlay','goalsOverlay','workOverlay','worldMapOverlay',
  'villageShopOverlay','overworldOverlay','optionsOverlay','storyOverlay','mainMenuOverlay'];
const isOpen = id => { const e=w.document.getElementById(id); return e && !e.classList.contains('hidden'); };
for(const id of ids){
  const before = errors.length;
  let opened=false, closed=false, inhalt=0;
  try{
    globalThis.openOverlay(id);
    opened = isOpen(id);
    const el = w.document.getElementById(id);
    inhalt = el ? el.textContent.trim().length : 0;
    globalThis.closeOverlay(id);
    closed = !isOpen(id);
  }catch(e){ errors.push('['+id+'] '+e.stack); }
  const neu = errors.length - before;
  console.log('  ' + id.padEnd(20) +
    ' oeffnet:' + (opened?'JA ':'NEIN') +
    ' schliesst:' + (closed?'JA ':'NEIN') +
    ' Inhalt:' + String(inhalt).padStart(5) +
    (neu? '  FEHLER('+neu+')':''));
}
console.log('  registriert insgesamt:', globalThis.overlayStack !== undefined ? Object.keys(globalThis.OVERLAYS||{}).length : '?');

// --- Story-Dialog reproduzieren ---
console.log('\n--- Story-Dialog Test ---');
const openOverlays = () => [...w.document.querySelectorAll('.overlay')]
   .filter(e=>!e.classList.contains('hidden')).map(e=>e.id);
console.log('  offene Overlays vor Dialog :', openOverlays());
globalThis.showStoryDialog('Testtitel','Testtext',[{label:'Weiter', action:()=>{ console.log('  >>> ACTION AUSGEFUEHRT'); }}]);
await new Promise(r=>setTimeout(r,150));
console.log('  offene Overlays nach Dialog:', openOverlays());
console.log('  overlayStack               :', JSON.stringify(globalThis.overlayStack));
console.log('  gameMode                   :', globalThis.gameMode, '| paused:', globalThis.paused);
const btns = w.document.querySelectorAll('#storyChoices button');
console.log('  Buttons im Dialog          :', btns.length, btns.length? '("'+btns[0].textContent+'")':'');
if(btns.length){
  console.log('  onclick vorhanden          :', typeof btns[0].onclick);
  btns[0].click();
  await new Promise(r=>setTimeout(r,150));
  console.log('  nach Klick, offene Overlays:', openOverlays());
  console.log('  gameMode nach Klick        :', globalThis.gameMode, '| paused:', globalThis.paused);
}

// --- Interaktionstest: Pfade, die ueber die Setter laufen ---
console.log('\n--- Interaktionstest ---');
function key(type, code){
  const ev = new w.KeyboardEvent(type, { key: code, code: 'Key'+code.toUpperCase(), bubbles:true });
  w.dispatchEvent(ev); w.document.dispatchEvent(ev);
}
async function tick(ms=150){ await new Promise(r=>setTimeout(r, ms)); }
function step(label, fn){
  const before = errors.length;
  try{ fn(); }catch(e){ errors.push('['+label+'] '+e.stack); }
  return before;
}

const nsAudio = await import(pathToFileURL(path.join(ROOT,'engine/audio.js')).href);
const nsPanels = await import(pathToFileURL(path.join(ROOT,'ui/panels.js')).href);
const nsWm = await import(pathToFileURL(path.join(ROOT,'ui/worldmap.js')).href);
globalThis.keyboardCameraEnabled = false;   // via Setter ins Besitzermodul panels.js
console.log('  [diag] Setter wirkt in panels.js:', nsPanels.keyboardCameraEnabled === false);
const p0 = { x: globalThis.state.player.x, y: globalThis.state.player.y };
step('bewegung', ()=>{ key('keydown','d'); });
await tick(400);
step('bewegung-stop', ()=>{ key('keyup','d'); });
await tick(200);
const p1 = { x: globalThis.state.player.x, y: globalThis.state.player.y };
console.log('  [diag] keyboardCameraEnabled=', globalThis.keyboardCameraEnabled,
            '| movementKeysHeld=', globalThis.movementKeysHeld && globalThis.movementKeysHeld.size,
            '| actionForKey("d")=', globalThis.actionForKey && globalThis.actionForKey('d'),
            '| paused=', globalThis.paused, '| gameMode=', globalThis.gameMode);
console.log('  Bewegung (WASD)      : ' + p0.x+'/'+p0.y + ' -> ' + p1.x+'/'+p1.y + (p1.x!==p0.x||p1.y!==p0.y ? '  bewegt' : '  KEINE Bewegung'));

step('sound-toggle', ()=>{ w.document.getElementById('btnSoundToggle').click(); });
console.log('  soundEnabled toggeln : ' + nsAudio.soundEnabled);
step('sound-toggle2', ()=>{ w.document.getElementById('btnSoundToggle').click(); });
console.log('  zurueck              : ' + nsAudio.soundEnabled);

step('buildmode', ()=>{ globalThis.buildMode = { active:true, type:'tent', dragStart:null, dragCurrent:null, rotation:0, keepRotation:false }; });
await tick();
console.log('  buildMode.active (Panels sieht es): ' + (nsPanels.buildMode && nsPanels.buildMode.active) + ' | global: ' + (globalThis.buildMode && globalThis.buildMode.active));
step('buildmode-exit', ()=>{ globalThis.buildMode = { active:false, type:null, dragStart:null, dragCurrent:null, rotation:0, keepRotation:false }; });
await tick();
console.log('  nach Abbruch (Panels): ' + (nsPanels.buildMode && nsPanels.buildMode.active) + ' | global: ' + (globalThis.buildMode && globalThis.buildMode.active));

step('worldmap', ()=>{ globalThis.enterMacroMap(); });
await tick(300);
console.log('  macroMode (Worldmap sieht es): ' + nsWm.macroMode + ' | global: ' + globalThis.macroMode + ' | gameMode: ' + globalThis.gameMode);
step('worldmap-zu', ()=>{ globalThis.exitMacroMap(); });
await tick(300);
console.log('  nach Schliessen (Worldmap): ' + nsWm.macroMode + ' | global: ' + globalThis.macroMode + ' | gameMode: ' + globalThis.gameMode);

step('speichern', ()=>{ globalThis.saveGame('test-slot'); });
await tick(200);
console.log('  saveGame()           : ' + (mem.has('test-slot') ? 'Spielstand geschrieben ('+mem.get('test-slot').length+' Zeichen)' : 'NICHTS GESCHRIEBEN'));

const uids = [globalThis.newUid(), globalThis.newUid(), globalThis.newUid()];
console.log('  newUid() fortlaufend : ' + uids.join(', ') + (new Set(uids).size===3 ? '  eindeutig' : '  DOPPELT'));

await tick(400);
console.log('  Fehler im Interaktionstest: ' + errors.length);

// --- Rueckschreibe-Setter pruefen: schreibt eine Zuweisung im Besitzermodul an? ---
console.log('\n--- Setter-Test (schreiben von aussen, lesen aus dem Modul) ---');
const modOf = {
  buildMode:'ui/panels.js', hoverTile:'ui/panels.js', cameraFreeMode:'ui/panels.js',
  wildMonsters:'ui/panels.js', groundItems:'ui/panels.js', demolishMode:'ui/panels.js',
  worldSeed:'engine/world.js', currentBiome:'engine/world.js', homeCtx:'engine/world.js',
  macroMode:'ui/worldmap.js', listeningFor:'ui/input.js',
  playerActionType:'engine/renderer.js',
};
const nsCache = {};
for(const [name, file] of Object.entries(modOf)){
  const url = pathToFileURL(path.join(ROOT, file)).href;
  nsCache[file] = nsCache[file] || await import(url);
  const ns = nsCache[file];
  const before = ns[name];
  const probe = { __probe: name + '_' + Math.random().toString(36).slice(2,7) };
  globalThis[name] = probe;
  const arrived = ns[name] === probe;
  const readBack = globalThis[name] === probe;
  console.log(`  ${name.padEnd(18)} Modul sieht Wert: ${arrived ? 'JA ' : 'NEIN'}  | global liest zurueck: ${readBack ? 'JA' : 'NEIN'}  (${file})`);
  if(!arrived || !readBack) errors.push('[setter] ' + name + ' kommt nicht im Besitzermodul an');
  globalThis[name] = before;   // wiederherstellen
}

console.log('--- Ergebnis ---');
console.log('Frames nach Spielstart   :', frames);
console.log('gameMode                 :', globalThis.gameMode);
console.log('Spielerposition          :', globalThis.state && globalThis.state.player.x + '/' + globalThis.state.player.y);
console.log('Gebaeude                 :', globalThis.state && globalThis.state.buildings.length);
console.log('globalThis.ctx gesetzt   :', globalThis.ctx ? 'ja' : 'NEIN (null/undefined)');
console.log('globalThis.canvas gesetzt:', globalThis.canvas ? globalThis.canvas.id : 'NEIN');
console.log('saveGame global          :', typeof globalThis.saveGame);
console.log('loadGame global          :', typeof globalThis.loadGame);
console.log('newUid global            :', typeof globalThis.newUid);
console.log('loopErrorCount           :', globalThis.loopErrorCount);
console.log('Fehler gesammelt         :', errors.length);
errors.slice(0, 12).forEach(e => console.log('  !', e.split('\n').slice(0,4).join('\n    ')));
process.exit(0);
