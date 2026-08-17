/* ============================================================
   engine/audio.js — Klang
   Vollständig synthetisiert über die Web Audio API: 25 Effekte
   und drei Musikstücke, ohne eine einzige Audiodatei.

   Signalkette: Quelle → Effekt- bzw. Musikbus → Kompressor →
   Ausgabe. Der Hall wird über eine im Code erzeugte Impulsantwort
   berechnet.

   Hat keine Abhängigkeiten zu anderen Modulen.
============================================================ */

/* ============================================================
   Sound engine (pure Web Audio synth, no audio files)
============================================================ */
let soundEnabled = true;
let audioCtx = null;
function ensureAudio(){
  if(!soundEnabled) return null;
  if(!audioCtx){
    try{ audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){ return null; }
  }
  if(audioCtx.state === 'suspended'){ audioCtx.resume().catch(()=>{}); }
  return audioCtx;
}
/* --- Gekapselt: Signalkette und Hilfsfunktionen bleiben intern.
   Nach außen gehen nur die Effekt-Auslöser (sfx*) sowie tone/beep.
   Intern: masterGain, sfxBus, musicBus, reverbNode, reverbSend,
   noiseBuf, noiseHit, rnd — letzteres beseitigt zugleich eine
   Namenskollision mit einer gleichnamigen lokalen Funktion. --- */
/* --- Signalkette: alles läuft über einen Masterbus mit Kompressor ---
   Vorher ging jeder Ton direkt an destination; bei mehreren gleichzeitigen
   Sounds führte das zu Übersteuerung und hartem Klang. --- */
let masterGain=null, sfxBus=null, musicBus=null, reverbNode=null, reverbSend=null, noiseBuf=null;
function buildAudioGraph(a){
  if(masterGain) return;
  masterGain = a.createGain(); masterGain.gain.value = 0.9;
  const comp = a.createDynamicsCompressor();
  comp.threshold.value = -16; comp.knee.value = 22; comp.ratio.value = 5;
  comp.attack.value = 0.004; comp.release.value = 0.22;
  masterGain.connect(comp); comp.connect(a.destination);
  sfxBus = a.createGain(); sfxBus.gain.value = 1.0; sfxBus.connect(masterGain);
  musicBus = a.createGain(); musicBus.gain.value = 1.0;
  // Musik bekommt einen sanften Tiefpass -> weniger schrill, wärmer
  const musLp = a.createBiquadFilter(); musLp.type='lowpass'; musLp.frequency.value=2600; musLp.Q.value=0.6;
  musicBus.connect(musLp); musLp.connect(masterGain);
  // kleiner Raum: prozedural erzeugte Impulsantwort (kein Audiofile nötig)
  try{
    const len = Math.floor(a.sampleRate*1.1);
    const imp = a.createBuffer(2, len, a.sampleRate);
    for(let ch=0; ch<2; ch++){
      const d = imp.getChannelData(ch);
      for(let i=0;i<len;i++){
        const decay = Math.pow(1 - i/len, 2.6);
        d[i] = (Math.random()*2-1) * decay * 0.5;
      }
    }
    reverbNode = a.createConvolver(); reverbNode.buffer = imp;
    reverbSend = a.createGain(); reverbSend.gain.value = 0.22;
    reverbSend.connect(reverbNode); reverbNode.connect(masterGain);
  }catch(e){ reverbSend=null; }
  // Rauschpuffer für perkussive/natürliche Geräusche (Schläge, Schritte, Wasser)
  try{
    const nlen = Math.floor(a.sampleRate*1.2);
    noiseBuf = a.createBuffer(1, nlen, a.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for(let i=0;i<nlen;i++) nd[i] = Math.random()*2-1;
  }catch(e){}
}
const rnd = (lo,hi)=> lo + Math.random()*(hi-lo);
// Ton mit Tonhöhen-Hüllkurve (statt starrer Frequenz) und optionalem Hall
function tone(o){
  const a = ensureAudio(); if(!a) return; buildAudioGraph(a);
  try{
    const t0 = a.currentTime + (o.delay||0);
    const dur = o.dur||0.1;
    const osc = a.createOscillator(); const g = a.createGain();
    osc.type = o.type||'sine';
    osc.frequency.setValueAtTime(o.f0, t0);
    if(o.f1 && o.f1!==o.f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1,o.f1), t0+dur);
    if(o.detune) osc.detune.value = o.detune;
    const vol = o.vol!==undefined ? o.vol : 0.12;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0+(o.attack||0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    let last = g;
    if(o.lp){
      const f = a.createBiquadFilter(); f.type='lowpass';
      f.frequency.setValueAtTime(o.lp, t0);
      if(o.lp1) f.frequency.exponentialRampToValueAtTime(Math.max(60,o.lp1), t0+dur);
      g.connect(f); last = f;
    }
    osc.connect(g);
    last.connect(sfxBus);
    if(reverbSend && o.verb) last.connect(reverbSend);
    osc.start(t0); osc.stop(t0+dur+0.05);
  }catch(e){}
}
// Gefiltertes Rauschen — sorgt für den perkussiven Anteil (Holz, Stein, Treffer)
const noiseHit = function(o){
  const a = ensureAudio(); if(!a || !noiseBuf) return; buildAudioGraph(a);
  try{
    const t0 = a.currentTime + (o.delay||0);
    const dur = o.dur||0.09;
    const src = a.createBufferSource(); src.buffer = noiseBuf;
    src.playbackRate.value = o.rate||1;
    const f = a.createBiquadFilter();
    f.type = o.filter||'bandpass';
    f.frequency.setValueAtTime(o.f0, t0);
    if(o.f1 && o.f1!==o.f0) f.frequency.exponentialRampToValueAtTime(Math.max(60,o.f1), t0+dur);
    f.Q.value = o.q!==undefined ? o.q : 1.2;
    const g = a.createGain();
    const vol = o.vol!==undefined ? o.vol : 0.1;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0+(o.attack||0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    src.connect(f); f.connect(g); g.connect(sfxBus);
    if(reverbSend && o.verb) g.connect(reverbSend);
    const off = Math.random()*0.5;
    src.start(t0, off, dur+0.05); src.stop(t0+dur+0.05);
  }catch(e){}
}
// Kompatibilitäts-Wrapper (alte Aufrufform)
function beep(freq, duration, type, volume, delay){
  tone({f0:freq, dur:duration, type:type||'sine', vol:volume, delay:delay});
}

/* --- Effekte: geschichtet aus Ton + Rauschen, mit leichter Zufallsvariation,
   damit sich häufig wiederholte Aktionen nicht monoton anhören. --- */
const sfxChop = () => {                       // Axt in Holz: dumpfer Impuls + Splittern
  const v = rnd(0.92,1.08);
  noiseHit({f0:1500*v, f1:400, dur:0.075, filter:'bandpass', q:0.9, vol:0.16, verb:true});
  tone({f0:190*v, f1:95, dur:0.11, type:'triangle', vol:0.13, lp:900, verb:true});
};
const sfxMine = () => {                       // Spitzhacke auf Stein: harter Klack + Nachhall
  const v = rnd(0.9,1.12);
  noiseHit({f0:3200*v, f1:900, dur:0.055, filter:'bandpass', q:1.6, vol:0.17, verb:true});
  tone({f0:150*v, f1:70, dur:0.13, type:'square', vol:0.1, lp:700, lp1:300, verb:true});
};
const sfxHarvest = () => {                    // Pflanze zupfen: kurzes Rascheln + heller Ton
  noiseHit({f0:2600*rnd(0.9,1.1), f1:1400, dur:0.07, filter:'highpass', q:0.7, vol:0.07});
  tone({f0:700*rnd(0.96,1.06), f1:900, dur:0.07, type:'sine', vol:0.07});
};
const sfxDrink = () => {                       // Schluck: aufsteigende Blubber
  tone({f0:380, f1:620, dur:0.12, type:'sine', vol:0.09, lp:1600});
  tone({f0:520, f1:820, dur:0.1, type:'sine', vol:0.07, delay:0.09, lp:1800});
  noiseHit({f0:900, f1:400, dur:0.06, filter:'lowpass', vol:0.05, delay:0.04});
};
const sfxEat = () => {                         // Kauen: zwei weiche Impulse
  noiseHit({f0:800, f1:300, dur:0.07, filter:'lowpass', q:0.8, vol:0.09});
  noiseHit({f0:700, f1:260, dur:0.07, filter:'lowpass', q:0.8, vol:0.08, delay:0.11});
  tone({f0:300, f1:220, dur:0.08, type:'triangle', vol:0.05, delay:0.02});
};
const sfxRest = () => {                        // Ausruhen: warmer, sanfter Akkord
  tone({f0:262, dur:0.5, type:'sine', vol:0.07, lp:1200, verb:true});
  tone({f0:330, dur:0.55, type:'sine', vol:0.055, delay:0.1, lp:1200, verb:true});
  tone({f0:392, dur:0.6, type:'sine', vol:0.045, delay:0.2, lp:1200, verb:true});
};
const sfxBuildTick = () => {                   // Hammerschlag
  const v = rnd(0.94,1.08);
  noiseHit({f0:2000*v, f1:600, dur:0.05, filter:'bandpass', q:1.1, vol:0.1});
  tone({f0:340*v, f1:200, dur:0.06, type:'triangle', vol:0.08});
};
const sfxBuildDone = () => {                   // Fertig: heller Dreiklang mit Hall
  [[523,0],[659,0.09],[784,0.18]].forEach(([f,d],i)=>
    tone({f0:f, dur:0.22, type:'triangle', vol:0.13, delay:d, verb:true}));
  tone({f0:1046, dur:0.3, type:'sine', vol:0.07, delay:0.27, verb:true});
};
const sfxPlace = () => {                       // Objekt absetzen
  noiseHit({f0:1200, f1:400, dur:0.045, filter:'bandpass', q:1, vol:0.08});
  tone({f0:420, f1:300, dur:0.06, type:'triangle', vol:0.07});
};
const sfxDemolish = () => {                    // Abreißen: Poltern + Geröll
  noiseHit({f0:900, f1:180, dur:0.28, filter:'lowpass', q:0.6, vol:0.16, verb:true});
  tone({f0:180, f1:70, dur:0.24, type:'sawtooth', vol:0.1, lp:600, verb:true});
  noiseHit({f0:1600, f1:500, dur:0.14, filter:'bandpass', q:0.8, vol:0.07, delay:0.1});
};
const sfxCraft = () => {                       // Werkbank: metallisches Klirren
  tone({f0:440*rnd(0.98,1.03), f1:520, dur:0.08, type:'square', vol:0.08, lp:2400});
  tone({f0:660, f1:780, dur:0.1, type:'square', vol:0.07, delay:0.06, lp:2600, verb:true});
  noiseHit({f0:4000, f1:2000, dur:0.09, filter:'highpass', vol:0.05, delay:0.05});
};
const sfxCatchSuccess = () => {                // Fang geglückt: aufsteigende Fanfare
  [[523,0],[659,0.09],[784,0.18],[1046,0.28]].forEach(([f,d])=>
    tone({f0:f, dur:0.26, type:'triangle', vol:0.14, delay:d, verb:true}));
  tone({f0:1568, dur:0.4, type:'sine', vol:0.06, delay:0.36, verb:true});
};
const sfxCatchFail = () => {                   // Fang misslungen: absackender Ton
  tone({f0:340, f1:150, dur:0.26, type:'sawtooth', vol:0.11, lp:1400, lp1:400});
  noiseHit({f0:800, f1:250, dur:0.16, filter:'lowpass', vol:0.06, delay:0.03});
};
const sfxHit = () => {                         // Eigener Treffer: satter Schlag
  const v = rnd(0.9,1.1);
  noiseHit({f0:2200*v, f1:500, dur:0.07, filter:'bandpass', q:1.1, vol:0.15});
  tone({f0:200*v, f1:80, dur:0.12, type:'square', vol:0.13, lp:1100, lp1:400, verb:true});
};
const sfxHitTaken = () => {                    // Treffer kassiert: dumpfer, tiefer
  const v = rnd(0.92,1.06);
  noiseHit({f0:1100*v, f1:280, dur:0.09, filter:'lowpass', q:0.9, vol:0.14});
  tone({f0:130*v, f1:62, dur:0.16, type:'square', vol:0.13, lp:700, lp1:250, verb:true});
};
const sfxMiss = () => {                        // Fehlschlag: Luftzug
  noiseHit({f0:1800, f1:5200, dur:0.12, filter:'bandpass', q:0.5, vol:0.07});
};
const sfxSuperEffective = () => {              // Sehr effektiv: greller Doppelschlag
  tone({f0:760, f1:1180, dur:0.09, type:'square', vol:0.11, verb:true});
  tone({f0:1000, f1:1500, dur:0.11, type:'square', vol:0.1, delay:0.07, verb:true});
  noiseHit({f0:5000, f1:2200, dur:0.1, filter:'highpass', vol:0.07, delay:0.02});
};
const sfxVictory = () => {                     // Sieg: kleine Fanfare
  [[523,0,0.16],[659,0.11,0.16],[784,0.22,0.2],[1046,0.34,0.36]].forEach(([f,d,du])=>
    tone({f0:f, dur:du, type:'triangle', vol:0.14, delay:d, verb:true}));
};
const sfxFaint = () => {                       // Besiegt: abfallendes Glissando
  tone({f0:420, f1:90, dur:0.5, type:'sawtooth', vol:0.12, lp:1600, lp1:300, verb:true});
  tone({f0:210, f1:60, dur:0.55, type:'triangle', vol:0.08, delay:0.08, verb:true});
};
const sfxFleeSuccess = () => {                 // Flucht: schnelle Schritte
  [0,0.06,0.12].forEach((d,i)=>{
    noiseHit({f0:1400-i*260, f1:500, dur:0.05, filter:'bandpass', q:1, vol:0.08, delay:d});
    tone({f0:440-i*110, dur:0.05, type:'sine', vol:0.06, delay:d});
  });
};
const sfxFleeFail = () => {                    // Flucht misslungen
  tone({f0:260, f1:120, dur:0.22, type:'sawtooth', vol:0.1, lp:900});
};
const sfxEvent = () => {                       // Ereignis: freundlicher Zweiklang
  tone({f0:620, f1:700, dur:0.14, type:'sine', vol:0.09, verb:true});
  tone({f0:880, dur:0.18, type:'sine', vol:0.08, delay:0.09, verb:true});
};
const sfxRaid = () => {                        // Überfall: bedrohliche Hornstöße
  [0,0.17,0.36].forEach((d,i)=>{
    tone({f0:150-i*8, f1:120-i*8, dur:0.28, type:'sawtooth', vol:0.14, delay:d, lp:800, verb:true});
    tone({f0:75-i*4, dur:0.3, type:'square', vol:0.09, delay:d, lp:400});
  });
  noiseHit({f0:400, f1:120, dur:0.5, filter:'lowpass', vol:0.05, delay:0.02});
};
const sfxJoin = () => {                        // Neuer Kolonist: warme Begrüßung
  [[440,0],[554,0.08],[659,0.16]].forEach(([f,d])=>
    tone({f0:f, dur:0.24, type:'triangle', vol:0.12, delay:d, verb:true}));
};
const sfxError = () => {                       // Fehler: kurzes tiefes Brummen
  tone({f0:180, f1:130, dur:0.13, type:'sawtooth', vol:0.09, lp:700});
};

// Musikzweig nach außen: playNote liegt außerhalb der Kapsel und
// braucht einen Anschlusspunkt — direkter Zugriff auf musicBus wäre
// von dort nicht sichtbar.


/* ============================================================
   Procedural background music (colony theme + battle theme)
============================================================ */
let musicEnabled = true;
let currentMusicId = 0;
let activeMusicTrackKey = null;
const NOTE_FREQ = {
  D2:73.42, E2:82.41, F2:87.31, G2:98.00, A2:110.00, C2:65.41,
  C3:130.81, D3:146.83, E3:164.81, F3:174.61, G3:196.00, A3:220.00, B3:246.94,
  C4:261.63, D4:293.66, E4:329.63, F4:349.23, G4:392.00, A4:440.00, B4:493.88,
  C5:523.25, D5:587.33, E5:659.25, F5:698.46, G5:783.99, A5:880.00
};
function playNote(freq, beats, tempo, volume, type){
  const a = ensureAudio(); if(!a || !musicEnabled) return;
  buildAudioGraph(a);
  try{
    const dur = (60/tempo)*beats*0.88;
    const osc = a.createOscillator(); const gain = a.createGain();
    osc.type = type; osc.frequency.value = freq;
    osc.detune.value = (Math.random()-0.5)*7;   // minimale Verstimmung -> lebendiger, weniger steril
    const t0 = a.currentTime;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(volume, t0+0.05);
    gain.gain.setValueAtTime(volume, t0+dur*0.45);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0+dur);
    osc.connect(gain); gain.connect(musicBus || a.destination);
    osc.start(t0); osc.stop(t0+dur+0.05);
  }catch(e){}
}
const COLONY_MELODY = [['E4',1],['G4',1],['C5',1],['G4',1],['A4',1],['C5',1],['E5',1],['C5',1],['D4',1],['F4',1],['A4',1],['F4',1],['G4',1],['B4',1],['D5',1],['B4',1]];
const COLONY_BASS = [['C3',2],['G3',2],['A3',2],['E3',2],['F3',2],['C3',2],['G3',2],['G3',2]];
const BATTLE_MELODY = [['A4',0.5],['C5',0.5],['E5',0.5],['A5',0.5],['G5',0.5],['E5',0.5],['C5',0.5],['A4',0.5],['F4',0.5],['A4',0.5],['C5',0.5],['F5',0.5],['E5',0.5],['C5',0.5],['A4',0.5],['E4',0.5]];
const BATTLE_BASS = [['A2',1],['A2',1],['F2',1],['F2',1],['C3',1],['C3',1],['G2',1],['G2',1]];
const DUNGEON_MELODY = [['A3',1.5],['C4',0.5],['E4',1],['D4',1],['A3',1.5],['G3',0.5],['A3',2],['E3',1],['G3',1],['A3',1],['C4',1],['A3',2],['F3',1],['E3',1],['D3',1],['E3',1]];
const DUNGEON_BASS = [['A2',2],['A2',2],['F2',2],['G2',2],['A2',2],['E2',2],['F2',2],['A2',2]];
const MUSIC_TRACKS = {
  colony:{ tempo:96, melody:COLONY_MELODY, bass:COLONY_BASS, melodyVol:0.045, bassVol:0.05, type:'triangle' },
  battle:{ tempo:148, melody:BATTLE_MELODY, bass:BATTLE_BASS, melodyVol:0.05, bassVol:0.06, type:'square' },
  dungeon:{ tempo:66, melody:DUNGEON_MELODY, bass:DUNGEON_BASS, melodyVol:0.036, bassVol:0.042, type:'sine' }
};
function startMusicTrack(trackKey){
  activeMusicTrackKey = trackKey;
  currentMusicId++;
  const myId = currentMusicId;
  const cfg = MUSIC_TRACKS[trackKey];
  if(!cfg) return;
  function runLine(seq, volume, type){
    let i = 0;
    function step(){
      if(currentMusicId!==myId || !musicEnabled) return;
      const entry = seq[i % seq.length];
      const note = entry[0], beats = entry[1];
      if(note) playNote(NOTE_FREQ[note], beats, cfg.tempo, volume, type);
      i++;
      setTimeout(step, (60/cfg.tempo)*beats*1000);
    }
    step();
  }
  runLine(cfg.melody, cfg.melodyVol, cfg.type);
  runLine(cfg.bass, cfg.bassVol, 'sine');
}
function stopMusic(){ currentMusicId++; }

/* ---------- Rückschreibe-Setter für die globale Brücke ----------
   Diese Bindings werden von anderen Modulen überschrieben. Ohne diese
   Funktionen käme die Zuweisung hier nie an und dieses Modul würde mit
   einem veralteten Wert weiterarbeiten. Siehe bridgeModule() in main.js. */
/* Öffentliche Schalter. Als importierte Bindung sind musicEnabled und
   soundEnabled beim Lesen live, aber schreibgeschützt — Zuweisungen von
   außen laufen deshalb über diese beiden Funktionen. */
function setMusicEnabled(v){ musicEnabled = !!v; return musicEnabled; }
function setSoundEnabled(v){ soundEnabled = !!v; return soundEnabled; }
function __set_musicEnabled(v){ musicEnabled = v; }
function __set_soundEnabled(v){ soundEnabled = v; }

export {
  __set_musicEnabled,
  __set_soundEnabled,
  setMusicEnabled,
  setSoundEnabled,

  activeMusicTrackKey,
  audioCtx,
  beep,
  buildAudioGraph,
  ensureAudio,
  musicEnabled,
  playNote,
  sfxBuildDone,
  sfxBuildTick,
  sfxCatchFail,
  sfxCatchSuccess,
  sfxChop,
  sfxCraft,
  sfxDemolish,
  sfxDrink,
  sfxEat,
  sfxError,
  sfxEvent,
  sfxFaint,
  sfxFleeFail,
  sfxFleeSuccess,
  sfxHarvest,
  sfxHit,
  sfxHitTaken,
  sfxJoin,
  sfxMine,
  sfxMiss,
  sfxPlace,
  sfxRaid,
  sfxRest,
  sfxSuperEffective,
  sfxVictory,
  soundEnabled,
  startMusicTrack,
  stopMusic,
  tone
};
