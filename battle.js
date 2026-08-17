/* ============================================================
   ui/battle.js — Kampf
   Rundenmenü, Zielauswahl, Gefährten-Steuerung, Autokampf,
   Kampfanimationen und Statuseffekte.
============================================================ */

import { clamp } from '../engine/rng.js';
import { sfxBuildDone, sfxCatchFail, sfxCatchSuccess, sfxEat, sfxFaint, sfxFleeFail, sfxFleeSuccess, sfxHit, sfxHitTaken, sfxMiss, sfxSuperEffective, sfxVictory, startMusicTrack } from '../engine/audio.js';
/* ============================================================
   Battle / catching — JRPG-style menu system
============================================================ */
let encounter = null;
function ensurePlayerMonHp(){ if(state.activeId==null) return null; return state.collection[state.activeId] || null; }
function calcDmg(atk, def){ return Math.max(1, Math.round(atk - def/2 + (Math.random()*3-1))); }
function rollCrit(){ return Math.random() < 0.08; }
function livingEnemies(){ return encounter ? encounter.enemies.filter(e=>e.hp>0) : []; }
function allEnemiesDead(){ return encounter ? encounter.enemies.every(e=>e.hp<=0) : true; }
function engageWildMonster(wild){
  if(wild.raid){
    const group = homeCtx.wildMonsters.filter(w=>w.raid).slice(0,3);
    const specs = group.map(w=>({speciesId:w.speciesId, uid:w.uid}));
    startEncounter(specs, true);
  } else {
    const specs = [{speciesId:wild.speciesId, uid:wild.uid, dungeonMult:wild.dungeonMult||1, boss:!!wild.boss}];
    if(Math.random()<0.18 && !wild.boss){ specs.push({speciesId:wild.speciesId, uid:null}); }
    startEncounter(specs, false);
  }
}
function challengeLevelMult(){
  const levels = [state.player.level||1];
  state.party.forEach(id=>{ const c=state.colonists.find(cc=>cc.id===id); if(c) levels.push(c.level||1); });
  const avg = levels.reduce((a,b)=>a+b,0)/levels.length;
  return 1 + Math.min(1.0, (avg-1)*0.02);
}
function regionDangerLevel(regionId){
  const r = REGIONS[regionId];
  if(!r) return 0;
  return Math.abs(r.gx) + Math.abs(r.gy);
}
function regionDangerMult(regionId){
  return 1 + Math.min(1.6, regionDangerLevel(regionId)*0.09);
}
function startEncounter(enemySpecs, isRaid){
  setMode('battle', {remember:true}); state.player.path=[]; state.player.target=null;
  startMusicTrack('battle');
  const mult = isRaid ? 1.3 : 1;
  const lvlMult = challengeLevelMult();
  const dangerMult = atDungeon() && dungeonCtx ? (1+dungeonCtx.dangerLevel*0.09) : regionDangerMult(state.player.regionId);
  const scaleMult = lvlMult * dangerMult;
  encounter = {
    enemies: enemySpecs.map(es=>{
      const sp=SPECIES[es.speciesId];
      const dm = es.dungeonMult||1;
      const maxHp=Math.round(sp.stats.hp*mult*scaleMult*dm);
      const atk=Math.round(sp.stats.atk*scaleMult*dm);
      return { speciesId:es.speciesId, hp:maxHp, maxHp, atk, uid:(es.uid!=null?es.uid:null), boss:!!es.boss };
    }),
    raid: !!isRaid
  };
  const usingParty = partyCount()>0 || !!state.player.advClass;
  encounter.party = usingParty ? buildPartySnapshot() : null;
  const playerHasClassInParty = usingParty && !!state.player.advClass;
  const first = SPECIES[encounter.enemies[0].speciesId];
  const names = encounter.enemies.map(e=>SPECIES[e.speciesId].name).join(', ');
  const isBossFight = encounter.enemies.some(e=>e.boss);
  document.getElementById('encTitle').textContent = isRaid ? '⚠️ Überfall! Verteidige die Kolonie!' : (isBossFight ? '👑 Der Wächter des Dungeons!' : (encounter.enemies.length>1 ? 'Mehrere wilde Wesen entdeckt!' : 'Wildes Wesen entdeckt!'));
  document.getElementById('encLog').textContent = isRaid ? `Eine Gruppe feindseliger Kreaturen greift die Kolonie an: ${names}!` : (encounter.enemies.length>1 ? `Wilde Wesen tauchen auf: ${names}!` : `Ein wildes ${first.name} (${first.type}) taucht auf!`);
  document.getElementById('btnMenuFight').classList.toggle('hidden', usingParty && !playerHasClassInParty);
  document.getElementById('btnMenuDefend').classList.toggle('hidden', usingParty);
  document.getElementById('btnMenuPartyRound').classList.toggle('hidden', !usingParty || playerHasClassInParty);
  if(typeof stopAutoBattle==='function') stopAutoBattle();   // startet jeder Kampf mit Autokampf aus
  if(typeof updateAutoBattleButton==='function') updateAutoBattleButton();
  if(!usingParty){
    const pm = ensurePlayerMonHp(); const hasMon = !!pm;
    document.getElementById('btnMenuFight').disabled = !hasMon || pm.currentHp<=0;
    document.getElementById('btnMenuDefend').disabled = !hasMon || pm.currentHp<=0;
  } else {
    document.getElementById('btnMenuFight').disabled = false;
  }
  const flash = document.getElementById('battleFlash');
  flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
  const encPanel = document.querySelector('#encounter .battlePanel');
  if(encPanel){ encPanel.classList.remove('punchIn'); void encPanel.offsetWidth; encPanel.classList.add('punchIn'); }
  document.getElementById('encounter').classList.remove('hidden');
  if(encounter.party){ startPartyTurnRound(); } else { showMainMenu(); }
  drawBattleScene();
}
function buildPartySnapshot(){
  const eliteMult = hasTech('elitetruppe') ? 1.1 : 1;
  const list = [];
  const pst = playerCombatStats();
  if(pst){
    const pMaxMp = (CLASS_MAX_MP[state.player.advClass]||20) + Math.floor((state.player.level||1)/5)*2;
    list.push({ id:'__player__', name:'Du', cls:state.player.advClass, level:state.player.level||1, maxHp:pst.hp, hp:pst.hp, atk:pst.atk, def:pst.def, spd:pst.spd, heal:pst.heal||0, maxMp:pMaxMp, mp:pMaxMp });
  }
  state.party.forEach(id=>{
    const c = state.colonists.find(cc=>cc.id===id);
    if(!c || !c.advClass) return;
    const st = combatStatsFor(c);
    let atk = st.atk, def = st.def, hp = st.hp, spd = st.spd, heal = st.heal||0;
    if(c.advClass==='Waldläufer' && hasTech('jagdmeister')) atk += 3;
    atk = Math.round(atk*eliteMult); def = Math.round(def*eliteMult); hp = Math.round(hp*eliteMult); spd = Math.round(spd*eliteMult); heal = Math.round(heal*eliteMult);
    const cMaxMp = (CLASS_MAX_MP[c.advClass]||20) + Math.floor((c.level||1)/5)*2;
    list.push({ id:c.id, name:c.name, cls:c.advClass, level:c.level||1, maxHp:hp, hp:hp, atk, def, spd, heal, maxMp:cMaxMp, mp:cMaxMp });
  });
  return list;
}
function partyClassColor(cls){ return {Krieger:'#b03a2e',Magier:'#5a3d6b',Heiler:'#3d6b4f',Waldläufer:'#6b8f4e'}[cls]||'#c9822c'; }
function drawBattleLabel(bctx, x, y, name, sub, hp, maxHp, barColor, dim){
  const S = Math.min(bctx.canvas.height/230, 1.5);   // begrenzt, sonst wird die Schrift im Vollbild zu groß
  bctx.save();
  if(dim) bctx.globalAlpha = 0.45;
  bctx.textAlign='center';
  bctx.font='800 '+Math.round(12*S)+'px Nunito, sans-serif';
  bctx.strokeStyle='rgba(0,0,0,.65)'; bctx.lineWidth=3*S;
  bctx.strokeText(name, x, y);
  bctx.fillStyle='#efe6cd'; bctx.fillText(name, x, y);
  bctx.font=Math.round(10*S)+'px Nunito, sans-serif'; bctx.fillStyle='#b9c9b3';
  bctx.fillText(sub, x, y+13*S);
  const barW=68*S, barH=6*S, barY=y+19*S;
  bctx.fillStyle='rgba(0,0,0,.5)'; bctx.fillRect(x-barW/2, barY, barW, barH);
  const bg = bctx.createLinearGradient(0,barY,0,barY+barH);
  bg.addColorStop(0, shadeColor(barColor,26)); bg.addColorStop(1, barColor);
  bctx.fillStyle = bg;
  bctx.fillRect(x-barW/2, barY, barW*clamp(hp/maxHp,0,1), barH);
  bctx.fillStyle='rgba(255,255,255,.22)';
  bctx.fillRect(x-barW/2, barY, barW*clamp(hp/maxHp,0,1), barH*0.4);
  bctx.strokeStyle='rgba(0,0,0,.6)'; bctx.lineWidth=1*S; bctx.strokeRect(x-barW/2,barY,barW,barH);
  bctx.font='800 '+Math.round(9*S)+'px Nunito, sans-serif';
  bctx.strokeStyle='rgba(0,0,0,.6)'; bctx.lineWidth=2.4*S;
  bctx.strokeText(Math.max(0,Math.round(hp))+'/'+maxHp, x, y+33*S);
  bctx.fillStyle='#efe6cd';
  bctx.fillText(Math.max(0,Math.round(hp))+'/'+maxHp, x, y+33*S);
  bctx.restore();
}
function enemySpritePos(idx){
  const c = document.getElementById('battleSceneCanvas');
  const W=c.width, H=c.height;
  const en = encounter.enemies.length;
  const eStartX = W*0.10, eGap = Math.min(W*0.16, (W*0.42-eStartX)/Math.max(1,en-1||1));
  // Y so wählen, dass die Füße unabhängig von der Sprite-Größe auf derselben Bodenlinie stehen
  const S = H/230;
  const spriteSize = (en===1 ? 62 : 44) * S;
  const groundY = H*0.735;                    // gemeinsame Standlinie knapp unter dem Horizont
  return { x: en===1 ? W*0.32 : eStartX + idx*eGap, y: groundY - spriteSize*0.42 };
}
function partySpritePos(idx){
  const c = document.getElementById('battleSceneCanvas');
  const W=c.width, H=c.height;
  const n = encounter.party.length;
  const startX = W*0.58, gap = Math.min(W*0.12, (W*0.96-startX)/Math.max(1,n-1||1));
  return { x: n===1 ? W*0.70 : startX + idx*gap, y: H*0.66 };
}
function companionSpritePos(){
  const c = document.getElementById('battleSceneCanvas');
  return { x: c.width*0.76, y: c.height*0.62 };
}
let floatingTexts = [];
function spawnFloatingText(x,y,text,color){
  floatingTexts.push({x,y,text,color,start:performance.now()});
  // nutzt dieselbe Schleife wie die Kampfanimationen
  if(typeof ensureBattleAnimLoop==='function') ensureBattleAnimLoop();
}
function drawFloatingTexts(bctx){
  const now = performance.now();
  floatingTexts = floatingTexts.filter(f=>now-f.start<900);
  floatingTexts.forEach(f=>{
    const t = (now-f.start)/900;
    bctx.save();
    bctx.globalAlpha = 1-t;
    const SS = Math.min(bctx.canvas.height/230, 1.6);
    bctx.font = '800 '+Math.round((f.big?20:15)*SS)+'px Nunito, sans-serif';
    bctx.fillStyle = f.color; bctx.textAlign='center';
    bctx.strokeStyle='rgba(0,0,0,.6)'; bctx.lineWidth=3;
    bctx.lineWidth = 3*SS;
    bctx.strokeText(f.text, f.x, f.y-30*t*SS);
    bctx.fillText(f.text, f.x, f.y-30*t*SS);
    bctx.restore();
  });
}
function drawInitiativeBar(bctx, W, H){
  if(!encounter) return;
  const combatants = [];
  encounter.enemies.forEach((e,i)=>{ if(e.hp>0) combatants.push({
    spd: SPECIES[e.speciesId].stats.spd, icon:'👹', color:'#c94f3d', foe:true,
    name: SPECIES[e.speciesId].name }); });
  if(encounter.party){
    encounter.party.forEach(p=>{ if(p.hp>0) combatants.push({
      spd:p.spd, icon:ADV_CLASS_ICON[p.cls]||'⚔️', color:partyClassColor(p.cls), name:p.name }); });
  } else {
    const pm = ensurePlayerMonHp();
    if(pm && pm.currentHp>0){ const psp=SPECIES[state.activeId];
      combatants.push({spd:psp.stats.spd, icon:'🐾', color:'#3e8e8e', name:psp.name}); }
  }
  if(combatants.length===0) return;
  combatants.sort((a,b)=>b.spd-a.spd);
  // Zeitleiste quer über den oberen Rand: schnellster links, langsamster rechts
  // UI-Skalierung bewusst begrenzen — sonst werden Plättchen und Schrift im Vollbild riesig
  const S = Math.min(H/230, 1.45);
  const rBase = 11*S;                       // Radius des größten Plättchens
  const padR = 20*S + rBase;   // rechts Platz lassen, damit nichts abgeschnitten wird
  const y = 20*S;
  bctx.save();
  // Hintergrundband
  const bandG = bctx.createLinearGradient(0,y-13*S,0,y+13*S);
  bandG.addColorStop(0,'rgba(8,18,14,.82)'); bandG.addColorStop(1,'rgba(8,18,14,.55)');
  bctx.fillStyle = bandG; bctx.fillRect(0,0,W,y+rBase+16*S);
  // Klare Statusanzeige links: wer ist gerade dran?
  const lead = combatants[0];
  const youTurn = !lead.foe;
  const label = youTurn ? 'DU BIST AM ZUG' : (lead.name.toUpperCase()+' AGIERT');
  bctx.textAlign='left'; bctx.textBaseline='middle';
  // farbige Plakette als eindeutiger Indikator
  bctx.font='800 '+Math.round(10*S)+'px Nunito, sans-serif';
  const tw = bctx.measureText(label).width;
  const bx = 10*S, bh = 19*S, bw = tw + 26*S;
  const tg = bctx.createLinearGradient(bx, y-bh/2, bx+bw, y+bh/2);
  if(youTurn){ tg.addColorStop(0,'#2f7a4a'); tg.addColorStop(1,'#1d5231'); }
  else { tg.addColorStop(0,'#a83a2b'); tg.addColorStop(1,'#6e2419'); }
  bctx.fillStyle=tg;
  if(bctx.roundRect){ bctx.beginPath(); bctx.roundRect(bx, y-bh/2, bw, bh, bh/2); bctx.fill(); }
  else bctx.fillRect(bx, y-bh/2, bw, bh);
  bctx.strokeStyle = youTurn ? 'rgba(143,201,58,.75)' : 'rgba(255,150,120,.7)';
  bctx.lineWidth=1.5;
  if(bctx.roundRect){ bctx.stroke(); }
  // blinkender Punkt, solange der Spieler dran ist
  const blink = youTurn ? (0.45+Math.abs(Math.sin(performance.now()/430))*0.55) : 1;
  bctx.globalAlpha = blink;
  bctx.fillStyle = youTurn ? '#8fc93a' : '#ffb0a0';
  bctx.beginPath(); bctx.arc(bx+11*S, y, 3.6*S, 0, Math.PI*2); bctx.fill();
  bctx.globalAlpha = 1;
  bctx.fillStyle='#efe6cd';
  bctx.fillText(label, bx+20*S, y+0.5);
  // Leiste erst nach der Plakette beginnen lassen
  const padL = bx + bw + 14*S;
  const trackW = Math.max(40, W - padL - padR);
  bctx.strokeStyle='rgba(255,255,255,.16)'; bctx.lineWidth=2*S; bctx.lineCap='round';
  bctx.beginPath(); bctx.moveTo(padL, y); bctx.lineTo(W-padR, y); bctx.stroke();
  // Marker gleichmäßig verteilt, aktiver Kämpfer vorne größer
  const n = combatants.length;
  combatants.forEach((cb,i)=>{
    const t = n===1 ? 0 : i/(n-1);
    const x = padL + t*trackW;
    const active = i===0;
    const r = active ? rBase : rBase*0.76;
    // Verbindungstick zur Leiste
    bctx.strokeStyle='rgba(255,255,255,.12)'; bctx.lineWidth=1;
    bctx.beginPath(); bctx.moveTo(x,y); bctx.lineTo(x,y+ (active?0:0)); bctx.stroke();
    // Schatten
    bctx.fillStyle='rgba(0,0,0,.45)';
    bctx.beginPath(); bctx.arc(x, y+1.5*S, r, 0, Math.PI*2); bctx.fill();
    // Plättchen
    const pg = bctx.createLinearGradient(x-r, y-r, x+r, y+r);
    pg.addColorStop(0, cb.color);
    pg.addColorStop(1, shadeColor(cb.color,-30));
    bctx.globalAlpha = active ? 1 : 0.72;
    bctx.fillStyle = pg;
    bctx.beginPath(); bctx.arc(x, y, r, 0, Math.PI*2); bctx.fill();
    bctx.strokeStyle = active ? '#ffd23f' : 'rgba(0,0,0,.5)';
    bctx.lineWidth = (active ? 2.2 : 1.2)*S;
    bctx.stroke();
    // Symbol
    bctx.globalAlpha = 1;
    bctx.font = Math.round((active?12:9.5)*S)+'px sans-serif';
    bctx.textAlign='center'; bctx.textBaseline='middle';
    bctx.fillText(cb.icon, x, y+1);
    // Name des aktiven Kämpfers darunter
    if(active){
      bctx.font='800 '+Math.round(9.5*S)+'px Nunito, sans-serif';
      bctx.fillStyle='#ffd23f';
      bctx.strokeStyle='rgba(0,0,0,.7)'; bctx.lineWidth=2.5*S;
      bctx.strokeText(cb.name.slice(0,12), x, y+r+9*S);
      bctx.fillText(cb.name.slice(0,12), x, y+r+9*S);
    }
  });
  bctx.textBaseline='alphabetic';
  bctx.restore();
}
function generateSceneDecor(){
  const decor = [];
  const R = () => Math.random();
  // Ferne Baumsilhouetten am Horizont (hinter dem Bodenrand)
  const treeCount = 9 + Math.floor(R()*5);
  for(let i=0;i<treeCount;i++){
    decor.push({ layer:'far', x: (i+R()*0.7)/treeCount, type:'fartree',
      scale: 0.7+R()*0.6, kind: R()<0.4?'pine':'round' });
  }
  // Mittelgrund: sanfte Hügelkuppen direkt an der Horizontlinie
  for(let i=0;i<4;i++){
    decor.push({ layer:'mid', x: R(), type:'ridge', scale: 0.8+R()*1.1, h: 0.05+R()*0.06 });
  }
  // Vordergrund auf dem Boden: Grasbüschel, Steine, Blumen
  for(let i=0;i<22;i++){
    const r = R();
    decor.push({ layer:'ground', x: R(), y: 0.74+R()*0.24,
      type: r<0.5?'tuft':(r<0.82?'rock':'flower'), scale: 0.6+R()*0.8 });
  }
  return decor;
}
// Malt den geschichteten Kampfhintergrund: Himmel, Horizont, Fernbäume, Boden
// Weicher, auslaufender Bodenschatten statt harter Ellipse
function battleShadow(bctx, x, y, rx, ry){
  bctx.save();
  bctx.translate(x,y); bctx.scale(1, ry/rx);
  const g = bctx.createRadialGradient(0,0,0,0,0,rx);
  g.addColorStop(0,'rgba(0,0,0,.38)');
  g.addColorStop(0.6,'rgba(0,0,0,.18)');
  g.addColorStop(1,'rgba(0,0,0,0)');
  bctx.fillStyle=g; bctx.beginPath(); bctx.arc(0,0,rx,0,Math.PI*2); bctx.fill();
  bctx.restore();
}
function drawBattleBackdrop(bctx, W, H){
  const horizon = H*0.72;
  const night = (typeof isNightNow==='function') ? isNightNow() : false;
  // Himmel mit Tageszeit-Stimmung
  const sky = bctx.createLinearGradient(0,0,0,horizon);
  if(night){ sky.addColorStop(0,'#101c2c'); sky.addColorStop(0.6,'#16283a'); sky.addColorStop(1,'#20344a'); }
  else { sky.addColorStop(0,'#2b4a3a'); sky.addColorStop(0.55,'#3a5f45'); sky.addColorStop(1,'#587a52'); }
  bctx.fillStyle = sky; bctx.fillRect(0,0,W,horizon);
  // Dunstband am Horizont
  const haze = bctx.createLinearGradient(0,horizon-46,0,horizon);
  haze.addColorStop(0,'rgba(200,220,190,0)');
  haze.addColorStop(1, night?'rgba(150,180,215,.16)':'rgba(220,235,190,.22)');
  bctx.fillStyle = haze; bctx.fillRect(0,horizon-46,W,46);
  // Sonne bzw. Mond
  bctx.save();
  const orbX = W*0.78, orbY = H*0.2;
  const orbG = bctx.createRadialGradient(orbX,orbY,2,orbX,orbY,44);
  orbG.addColorStop(0, night?'rgba(220,232,255,.55)':'rgba(255,238,180,.6)');
  orbG.addColorStop(1, 'rgba(255,238,180,0)');
  bctx.fillStyle=orbG; bctx.beginPath(); bctx.arc(orbX,orbY,44,0,Math.PI*2); bctx.fill();
  bctx.fillStyle = night?'#dfe8ff':'#f5e6a8';
  bctx.beginPath(); bctx.arc(orbX,orbY,11,0,Math.PI*2); bctx.fill();
  bctx.restore();
}
function drawSceneDecor(bctx, W, H, decor){
  const horizon = H*0.72;
  const night = (typeof isNightNow==='function') ? isNightNow() : false;
  // 1) Hügelkuppen am Horizont
  decor.filter(d=>d.layer==='mid').forEach(d=>{
    const px = d.x*W, hh = d.h*H, rw = 90*d.scale;
    bctx.fillStyle = night?'rgba(22,40,50,.75)':'rgba(30,58,40,.65)';
    bctx.beginPath();
    bctx.moveTo(px-rw, horizon);
    bctx.quadraticCurveTo(px, horizon-hh*2.1, px+rw, horizon);
    bctx.closePath(); bctx.fill();
  });
  // 2) Ferne Baumsilhouetten
  decor.filter(d=>d.layer==='far').forEach(d=>{
    const px = d.x*W, base = horizon+1, s = d.scale;
    bctx.fillStyle = night?'rgba(14,26,34,.9)':'rgba(24,46,32,.85)';
    bctx.fillRect(px-1.4*s, base-16*s, 2.8*s, 16*s);
    bctx.beginPath();
    if(d.kind==='pine'){
      bctx.moveTo(px, base-40*s);
      bctx.lineTo(px-11*s, base-12*s);
      bctx.lineTo(px+11*s, base-12*s);
      bctx.closePath();
    } else {
      bctx.arc(px, base-26*s, 13*s, 0, Math.PI*2);
    }
    bctx.fill();
  });
  // 3) Bodenfläche mit Perspektive
  const groundG = bctx.createLinearGradient(0,horizon,0,H);
  if(night){ groundG.addColorStop(0,'#1c3326'); groundG.addColorStop(1,'#0d1c14'); }
  else { groundG.addColorStop(0,'#3f6b3f'); groundG.addColorStop(1,'#254529'); }
  bctx.fillStyle = groundG; bctx.fillRect(0,horizon,W,H-horizon);
  // Kante zwischen Boden und Horizont
  bctx.fillStyle = night?'rgba(120,150,175,.14)':'rgba(200,225,150,.16)';
  bctx.fillRect(0,horizon,W,2);
  // Perspektivische Bodenlinien (weiter unten breiter auseinander)
  bctx.strokeStyle = night?'rgba(255,255,255,.03)':'rgba(255,255,255,.045)';
  bctx.lineWidth = 1;
  for(let i=1;i<=4;i++){
    const t = i/5, y = horizon + Math.pow(t,1.7)*(H-horizon);
    bctx.beginPath(); bctx.moveTo(0,y); bctx.lineTo(W,y); bctx.stroke();
  }
  // 4) Vordergrund-Deko auf dem Boden
  decor.filter(d=>d.layer==='ground').forEach(d=>{
    const px = d.x*W, py = d.y*H, s = d.scale;
    if(d.type==='tuft'){
      bctx.strokeStyle = night?'rgba(110,150,90,.4)':'rgba(143,201,58,.45)';
      bctx.lineWidth=1.3*s; bctx.lineCap='round';
      for(let k=0;k<3;k++){
        bctx.beginPath(); bctx.moveTo(px+(k-1)*3, py+4*s);
        bctx.lineTo(px+(k-1)*5, py-5*s); bctx.stroke();
      }
    } else if(d.type==='flower'){
      bctx.fillStyle = night?'rgba(190,190,210,.5)':['#e8a94d','#efe6cd','#c94f8f'][Math.floor(px)%3];
      [[0,-1.5],[1.3,0.6],[-1.3,0.6]].forEach(([ox,oy])=>{
        bctx.beginPath(); bctx.arc(px+ox*s,py+oy*s,1.1*s,0,Math.PI*2); bctx.fill();
      });
    } else {
      // Stein mit Licht/Schatten statt flacher Ellipse
      bctx.fillStyle='rgba(0,0,0,.3)';
      bctx.beginPath(); bctx.ellipse(px,py+2*s,5.5*s,2*s,0,0,Math.PI*2); bctx.fill();
      bctx.fillStyle = night?'#4a5057':'#6b6157';
      bctx.beginPath(); bctx.ellipse(px,py,5*s,3.4*s,0,0,Math.PI*2); bctx.fill();
      bctx.fillStyle='rgba(255,255,255,.16)';
      bctx.beginPath(); bctx.ellipse(px-1.6*s,py-1.2*s,2*s,1.2*s,0,0,Math.PI*2); bctx.fill();
    }
  });
}
/* ============================================================
   Kampf-Animationen: Ausfallschritt beim Angriff, Wackeln und
   Rotblitz beim Treffer, Aufprall-Partikel. Rein prozedural.
============================================================ */
let battleAnims = [];      // {side:'enemy'|'party'|'comp', idx, type, start, dur, dir}
let battleParticles = [];  // {x,y,vx,vy,start,life,color,size}
let battleAnimRunning = false;
function battleAnimTick(){
  if(!encounter){ battleAnimRunning=false; battleAnims=[]; battleParticles=[]; return; }
  const now = performance.now();
  battleAnims = battleAnims.filter(a=>now-a.start < a.dur);
  battleParticles = battleParticles.filter(p=>now-p.start < p.life);
  drawBattleScene();
  if(battleAnims.length || battleParticles.length || floatingTexts.length){
    requestAnimationFrame(battleAnimTick);
  } else {
    battleAnimRunning=false;
    drawBattleScene();
  }
}
function ensureBattleAnimLoop(){
  if(!battleAnimRunning){ battleAnimRunning=true; requestAnimationFrame(battleAnimTick); }
}
// Angreifer macht einen Ausfallschritt Richtung Ziel
function animAttack(side, idx){
  battleAnims.push({side, idx, type:'lunge', start:performance.now(), dur:340,
    dir: side==='enemy' ? 1 : -1});
  ensureBattleAnimLoop();
}
// Getroffener wackelt und blitzt rot auf
function animHit(side, idx, crit){
  battleAnims.push({side, idx, type:'hit', start:performance.now(), dur: crit?420:280, crit:!!crit});
  ensureBattleAnimLoop();
}
// Aufprall-Funken am Trefferpunkt
function spawnImpact(x, y, color, count){
  const n = count||10;
  for(let i=0;i<n;i++){
    const a = Math.random()*Math.PI*2, sp = 40+Math.random()*130;
    battleParticles.push({
      x, y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp-40,
      start:performance.now(), life:340+Math.random()*260,
      color: color||'#ffd23f', size: 1.4+Math.random()*2.2
    });
  }
  ensureBattleAnimLoop();
}
// Liefert Versatz/Blitz für eine Figur, basierend auf laufenden Animationen
function battleFxFor(side, idx){
  const now = performance.now();
  let dx=0, dy=0, flash=0, scale=1;
  battleAnims.forEach(a=>{
    if(a.side!==side || a.idx!==idx) return;
    // abgelaufene Animationen ignorieren — sonst laufen die Kurven
    // über ihren Gültigkeitsbereich hinaus und erzeugen riesige Versätze
    const raw = (now-a.start)/a.dur;
    if(raw<0 || raw>1) return;
    const t = raw;
    if(a.type==='lunge'){
      // schnell vor, langsam zurück
      const p = t<0.35 ? (t/0.35) : (1-(t-0.35)/0.65);
      dx += a.dir * 26 * p;
      dy += -6*p;
      scale *= 1 + 0.06*p;
    } else if(a.type==='hit'){
      const damp = 1-t;
      dx += Math.sin(t*Math.PI*(a.crit?9:6)) * (a.crit?9:6) * damp;
      flash = Math.max(flash, damp*(a.crit?0.85:0.6));
    }
  });
  return {dx, dy, flash, scale};
}
function drawBattleParticles(bctx){
  const now = performance.now();
  battleParticles.forEach(p=>{
    const t = (now-p.start)/p.life;
    const px = p.x + p.vx*(t*p.life/1000);
    const py = p.y + p.vy*(t*p.life/1000) + 260*Math.pow(t*p.life/1000,2);
    bctx.save();
    bctx.globalAlpha = Math.max(0, 1-t);
    bctx.fillStyle = p.color;
    bctx.beginPath(); bctx.arc(px, py, p.size*(1-t*0.5), 0, Math.PI*2); bctx.fill();
    bctx.restore();
  });
}

function drawBattleScene(){
  if(!encounter) return;
  const c = document.getElementById('battleSceneCanvas');
  const bctx = c.getContext('2d');
  const W=c.width, H=c.height;
  const S = H/230;   // Skalierung relativ zum ursprünglichen Layout (230px hoch)
  bctx.clearRect(0,0,W,H);
  drawBattleBackdrop(bctx, W, H);
  if(!encounter.sceneDecor) encounter.sceneDecor = generateSceneDecor();
  drawSceneDecor(bctx, W, H, encounter.sceneDecor);

  const enemies = encounter.enemies;
  const en = enemies.length;
  enemies.forEach((e,i)=>{
    const sp = SPECIES[e.speciesId];
    const pos0 = enemySpritePos(i);
    const fx = battleFxFor('enemy', i);
    const enemyX = pos0.x + fx.dx, enemyY = pos0.y + fx.dy;
    const size = (en===1?62:44) * fx.scale * S;
    battleShadow(bctx, pos0.x, pos0.y+size*0.42, size*0.52, size*0.14);
    drawMonster(bctx, enemyX, enemyY, size, sp, true, e.hp/e.maxHp);
    if(fx.flash>0){
      // Rotblitz beim Treffer: Silhouette kurz einfärben
      bctx.save(); bctx.globalCompositeOperation='source-atop';
      bctx.globalAlpha = fx.flash;
      bctx.fillStyle='#ff5a45';
      bctx.beginPath(); bctx.arc(enemyX, enemyY, size*0.62, 0, Math.PI*2); bctx.fill();
      bctx.restore();
    }
    drawBattleLabel(bctx, pos0.x, pos0.y+size*0.42+13*S, sp.name, sp.type, e.hp, e.maxHp, '#8fc93a', e.hp<=0);
    drawStatusIcons(bctx, e, pos0.x, pos0.y - size*0.52, S);
  });

  if(encounter.party){
    const n = encounter.party.length;
    encounter.party.forEach((p,i)=>{
      const pp0 = partySpritePos(i);
      const pfx = battleFxFor('party', i);
      const px = pp0.x + pfx.dx, py = pp0.y + pfx.dy;
      battleShadow(bctx, pp0.x, pp0.y+30*S, 17*S, 5*S);
      if(pfx.flash>0){
        bctx.save(); bctx.globalAlpha=pfx.flash*0.7; bctx.fillStyle='#ff5a45';
        bctx.beginPath(); bctx.ellipse(px,py-4*S,20*S,26*S,0,0,Math.PI*2); bctx.fill(); bctx.restore();
      }
      bctx.save(); bctx.globalAlpha = p.hp<=0 ? 0.4 : 1; bctx.translate(px,py); bctx.scale(pfx.scale,pfx.scale);
      // Echtes Aussehen verwenden: Spieler seinen eigenen Charakter,
      // Kolonisten ihr gespeichertes Aussehen. Nur als Rückfall ein Standardlook.
      let look;
      if(p.id==='__player__'){
        look = playerAppearance;
      } else {
        const cRef = state.colonists.find(cc=>cc.id===p.id);
        look = cRef && cRef.appearance ? cRef.appearance : null;
      }
      if(!look) look = {outfitColor: partyClassColor(p.cls), hairstyle:2, hairColor:'#5b4327', skinColor:'#e8c9a0'};
      drawHumanoidBody(bctx, look, 2.0*S, null, null, false, p.cls);
      bctx.restore();
      // Klassensymbol als kleine Plakette klar über dem Kopf (nicht mehr im Gesicht)
      const badgeY = py - 46*S;
      const bR = 9*Math.min(S,1.6);
      bctx.save();
      bctx.fillStyle='rgba(0,0,0,.45)';
      bctx.beginPath(); bctx.arc(px, badgeY+1.5, bR, 0, Math.PI*2); bctx.fill();
      const bgr = bctx.createLinearGradient(px-bR, badgeY-bR, px+bR, badgeY+bR);
      bgr.addColorStop(0, partyClassColor(p.cls));
      bgr.addColorStop(1, shadeColor(partyClassColor(p.cls),-32));
      bctx.fillStyle=bgr;
      bctx.beginPath(); bctx.arc(px, badgeY, bR, 0, Math.PI*2); bctx.fill();
      bctx.strokeStyle='rgba(233,230,205,.55)'; bctx.lineWidth=1.4;
      bctx.stroke();
      bctx.font=Math.round(11*Math.min(S,1.6))+'px sans-serif';
      bctx.textAlign='center'; bctx.textBaseline='middle';
      bctx.fillText(ADV_CLASS_ICON[p.cls], px, badgeY+0.5);
      bctx.textBaseline='alphabetic';
      bctx.restore();
      bctx.save(); if(p.hp<=0) bctx.globalAlpha=0.45;
      bctx.font='800 '+Math.round(11*S)+'px Nunito, sans-serif'; bctx.fillStyle='#efe6cd'; bctx.textAlign='center';
      bctx.fillText(p.name, px, py+42*S);
      drawStatusIcons(bctx, p, px, py-62*S, S);
      bctx.restore();
    });
  } else {
    const pm = ensurePlayerMonHp();
    const {x:compX, y:compY} = companionSpritePos();
    battleShadow(bctx, compX, compY+24*S, 26*S, 7*S);
    if(pm){
      const psp = SPECIES[state.activeId];
      const cfx = battleFxFor('comp', 0);
      if(cfx.flash>0){
        bctx.save(); bctx.globalAlpha=cfx.flash*0.7; bctx.fillStyle='#ff5a45';
        bctx.beginPath(); bctx.arc(compX+cfx.dx, compY+cfx.dy, 32*S, 0, Math.PI*2); bctx.fill(); bctx.restore();
      }
      drawMonster(bctx, compX+cfx.dx, compY+cfx.dy, 52*cfx.scale*S, psp, true, pm.currentHp/psp.stats.hp);
      drawBattleLabel(bctx, compX, compY+58*S, psp.name, psp.type, pm.currentHp, psp.stats.hp, '#7fd1d1', pm.currentHp<=0);
      drawStatusIcons(bctx, pm, compX, compY-34*S, S);
    } else {
      // Statt nacktem Text: der Spieler selbst steht im Kampf
      bctx.save(); bctx.translate(compX, compY+14*S);
      try{ drawHumanoidBody(bctx, playerAppearance, 2.1*S, null, null, false, state.player.advClass||null); }catch(e){}
      bctx.restore();
      bctx.font='800 '+Math.round(12*S)+'px Nunito, sans-serif'; bctx.fillStyle='#efe6cd'; bctx.textAlign='center';
      bctx.fillText('Du', compX, compY+40*S);
      bctx.font='700 '+Math.round(10*S)+'px Nunito, sans-serif'; bctx.fillStyle='rgba(207,224,201,.75)';
      bctx.fillText('ohne Begleiter', compX, compY+53*S);
    }
  }
  drawInitiativeBar(bctx, W, H);
  drawBattleParticles(bctx);
  drawFloatingTexts(bctx);
  renderPartyStatusBar();
}
function renderPartyStatusBar(){
  const wrap = document.getElementById('partyStatusBar');
  if(!encounter || !encounter.party){ wrap.innerHTML=''; return; }
  wrap.innerHTML = '';
  encounter.party.forEach(p=>{
    // Wer als Nächstes am Zug ist, wird hervorgehoben
    const fastest = encounter.party.filter(q=>q.hp>0).sort((a,b)=>b.spd-a.spd)[0];
    const isActive = fastest && fastest.id===p.id;
    const box = document.createElement('div');
    box.className='charBox'+(p.hp<=0?' dead':'')+(isActive?' active':'');
    box.style.borderTopColor = partyClassColor(p.cls);
    const hpPct = clamp(p.hp/p.maxHp*100,0,100);
    const mpPct = p.maxMp ? clamp(p.mp/p.maxMp*100,0,100) : 0;
    const resLabel = CLASS_RESOURCE_NAME[p.cls] || 'MP';
    box.innerHTML = `<div class="cbName">${ADV_CLASS_ICON[p.cls]||''} ${p.name}</div>
      <div class="cbBarRow"><span class="cbLabel">LP</span><div class="cbBarTrack"><div class="cbBarFill hp" style="width:${hpPct}%"></div></div><span class="cbBarNum">${Math.max(0,p.hp)}/${p.maxHp}</span></div>
      ${p.maxMp?`<div class="cbBarRow"><span class="cbLabel" title="${resLabel}">${resLabel.slice(0,2)}</span><div class="cbBarTrack"><div class="cbBarFill mp" style="width:${mpPct}%"></div></div><span class="cbBarNum">${p.mp}/${p.maxMp}</span></div>`:''}`;
    wrap.appendChild(box);
  });
}
function redrawEncounterSprites(){ drawBattleScene(); }
function refreshEncounterBars(){ drawBattleScene(); }
function endEncounter(){ if(typeof stopAutoBattle==='function') stopAutoBattle(); activeAllyRef = null; encounter = null; setMode('micro'); document.getElementById('encounter').classList.add('hidden'); startMusicTrack(atDungeon() ? 'dungeon' : 'colony'); }
function resolveRaidSuccess(){
  if(!state.raid) return;
  state.raid = null;
  homeCtx.wildMonsters = homeCtx.wildMonsters.filter(w=>!w.raid);
  if(atHome()) wildMonsters = homeCtx.wildMonsters;
  logEvent('🛡️ Überfall abgewehrt! Die Kolonie ist sicher.'); toast('🛡️ Überfall abgewehrt!');
  updateColonyIfOpen();
}

/* ---------- menu navigation ---------- */
function renderItemQuickBar(){
  if(!encounter) return;
  const wrap = document.getElementById('itemQuickBar');
  if(!wrap) return;   // Schnellleiste wurde aus der Kampfansicht entfernt
  wrap.innerHTML='';
  const usingParty = !!encounter.party;
  const noCompanion = !usingParty && !ensurePlayerMonHp();
  const items = [
    { icon:'🫐', count:state.inventory.berries||0, cls:'itemBtnBerry', disabled: (state.inventory.berries||0)<=0 || (usingParty?encounter.party.every(p=>p.hp<=0):noCompanion), fn: usingParty?doPartyItemBerry:doItemBerry },
    { icon:'🧪', count:state.inventory.potion||0, cls:'itemBtnPotion', disabled: (state.inventory.potion||0)<=0 || (usingParty?encounter.party.every(p=>p.hp<=0):noCompanion), fn: usingParty?doPartyItemPotion:doItemPotion },
    { icon:'🪤', count:state.inventory.trap||0, cls:'itemBtnTrap', disabled: (state.inventory.trap||0)<=0, fn: doItemTrap }
  ];
  items.forEach(it=>{
    const btn = document.createElement('button'); btn.className='itemQuickBtn '+it.cls;
    btn.textContent = `${it.icon} ${it.count}`;
    btn.disabled = it.disabled;
    btn.onclick = it.fn;
    wrap.appendChild(btn);
  });
}
let playerMenuHTML = null;
function showMainMenu(){
  const m = document.getElementById('encMainMenu');
  if(playerMenuHTML === null) playerMenuHTML = m.innerHTML;
  if(m.dataset.mode === 'ally'){
    m.innerHTML = playerMenuHTML;   // feste Spielerknöpfe zurückholen
    m.dataset.mode = '';
    bindBattleMenuButtons();
  }
  m.classList.remove('hidden');
  document.getElementById('encSubMenu').classList.add('hidden');
  renderItemQuickBar();
}
/* ============================================================
   Manuelle Steuerung der Gefährten: eigenes Menü je Kolonist
============================================================ */
function allyTurnDone(line){
  activeAllyRef = null;
  if(line) turnRoundLines.push(line);
  turnQueueIdx++;
  document.getElementById('encLog').textContent = turnRoundLines.slice(-3).join(' ');
  redrawEncounterSprites(); refreshEncounterBars();
  if(allEnemiesDead()){ afterVictoryParty(turnRoundLines); return; }
  if(encounter && encounter.party.every(p=>p.hp<=0)){ afterPartyWipe(turnRoundLines); return; }
  setTimeout(advanceTurnQueue, 420);
}
let activeAllyRef = null;
function showAllyMenu(p){
  activeAllyRef = p;
  const wrap = document.getElementById('encMainMenu');
  if(playerMenuHTML === null) playerMenuHTML = wrap.innerHTML;
  document.getElementById('encSubMenu').classList.add('hidden');
  wrap.classList.remove('hidden');
  wrap.innerHTML = '';
  wrap.dataset.mode = 'ally';
  const head = document.createElement('div');
  head.className = 'allyTurnHead';
  head.innerHTML = '<b>'+p.name+'</b> <span>'+(p.cls||'ohne Klasse')+' · Stufe '+(p.level||1)+
                   (p.mp!=null ? ' · '+p.mp+'/'+(p.maxMp||0)+' MP' : '')+'</span>';
  wrap.appendChild(head);
  const mk = (label, fn, cls)=>{
    const b = document.createElement('button');
    b.type = 'button';
    if(cls) b.className = cls;
    b.textContent = label;
    b.onclick = fn;
    wrap.appendChild(b);
  };
  mk('⚔ Angreifen', function(){ showAllyAbilityMenu(p); });
  mk('🎒 Gegenstand', function(){ showItemMenu(); }, 'secondary');
  mk('🏃 Fliehen', function(){
    wrap.classList.add('hidden');
    doPartyFlee();
  }, 'secondary');
  mk('⏭ Aussetzen', function(){
    wrap.classList.add('hidden');
    allyTurnDone(p.name+' hält sich zurück.');
  }, 'secondary');
}
function showAllyAbilityMenu(p){
  const main = document.getElementById('encMainMenu');
  const wrap = document.getElementById('encSubMenu');
  main.classList.add('hidden');
  wrap.classList.remove('hidden');
  wrap.innerHTML = '';
  const companionOk = hasUsableCompanion();
  const list = unlockedAbilities(p.cls, p.level||1).filter(function(a){
    return a.kind !== 'creature' || companionOk;
  });
  if(list.length === 0){
    const d = document.createElement('div');
    d.className = 'desc';
    d.textContent = p.name+' hat noch keine Klasse und kann nur zusehen.';
    wrap.appendChild(d);
  }
  list.forEach(function(a){
    const mp = (p.mp != null) ? p.mp : Infinity;
    const affordable = (a.cost||0) <= mp;
    const btn = document.createElement('button');
    btn.type = 'button';
    if(!affordable){ btn.disabled = true; btn.className = 'secondary'; }
    btn.textContent = a.name + (a.cost ? ' ('+a.cost+' MP)' : '');
    btn.onmouseenter = function(){
      const ib = document.getElementById('skillInfoBox');
      if(ib) ib.textContent = a.desc || '';
    };
    btn.onclick = function(){
      wrap.classList.add('hidden');
      const living = livingEnemies();
      const needsTarget = (a.kind==='single' || a.kind==='execute' || a.kind==='multi');
      if(living.length > 1 && needsTarget){
        showAllyTargetMenu(p, a);
      } else {
        allyTurnDone(executeAbility(p, a, null));
      }
    };
    wrap.appendChild(btn);
  });
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'secondary';
  back.textContent = '↩ Zurück';
  back.onclick = function(){ wrap.classList.add('hidden'); showAllyMenu(p); };
  wrap.appendChild(back);
}
function showAllyTargetMenu(p, ability){
  const wrap = document.getElementById('encSubMenu');
  wrap.classList.remove('hidden');
  wrap.innerHTML = '';
  encounter.enemies.forEach(function(e, i){
    if(e.hp <= 0) return;
    const sp = SPECIES[e.speciesId];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = sp.name+' ('+e.hp+'/'+e.maxHp+')';
    btn.onclick = function(){
      wrap.classList.add('hidden');
      allyTurnDone(executeAbility(p, ability, i));
    };
    wrap.appendChild(btn);
  });
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'secondary';
  back.textContent = '↩ Zurück';
  back.onclick = function(){ wrap.classList.add('hidden'); showAllyAbilityMenu(p); };
  wrap.appendChild(back);
}
function showMoveMenu(){
  if(!encounter) return;
  const pm = ensurePlayerMonHp(); if(!pm || pm.currentHp<=0) return;
  const psp = SPECIES[state.activeId];
  const wrap = document.getElementById('encSubMenu'); wrap.innerHTML='';
  MOVES_BY_TYPE[psp.type].forEach((m,i)=>{
    const btn = document.createElement('button');
    btn.textContent = m.name+' ('+Math.round(m.power*100)+'%, '+Math.round(m.acc*100)+'% Treffer)';
    btn.onclick = ()=>{
      const living = livingEnemies();
      if(living.length>1){ showTargetMenu(i); }
      else { const idx = encounter.enemies.findIndex(e=>e.hp>0); doMoveRound(i, idx); }
    };
    wrap.appendChild(btn);
  });
  const back = document.createElement('button'); back.className='secondary'; back.textContent='↩ Zurück'; back.onclick=showMainMenu;
  wrap.appendChild(back);
  document.getElementById('encMainMenu').classList.add('hidden');
  wrap.classList.remove('hidden');
}
function showPartySkillMenu(){
  if(!encounter || !encounter.party) return;
  const playerP = encounter.party.find(p=>p.id==='__player__');
  if(!playerP || playerP.hp<=0) return;
  const wrap = document.getElementById('encSubMenu'); wrap.innerHTML='';
  const mpLine = document.createElement('div'); mpLine.className='desc'; mpLine.style.textAlign='center';
  const resLabel = CLASS_RESOURCE_NAME[playerP.cls] || 'Mana';
  const resIcon = CLASS_RESOURCE_ICON[playerP.cls] || '🔷';
  mpLine.textContent = `${resIcon} ${resLabel}: ${playerP.mp}/${playerP.maxMp}`;
  wrap.appendChild(mpLine);
  const dock = document.createElement('div'); dock.className='skillDock'; dock.style.width='100%';
  // Statischer Infobereich mit fester Höhe — reserviert seinen Platz dauerhaft
  const INFO_PLACEHOLDER = 'Fahre über eine Fähigkeit, um die Beschreibung zu sehen.';
  const infoBox = document.createElement('div');
  infoBox.className = 'skillInfoBox';
  infoBox.textContent = INFO_PLACEHOLDER;
  const abilities = unlockedAbilities(playerP.cls, playerP.level);
  abilities.forEach(a=>{
    const companionMissing = a.kind==='creature' && !hasUsableCompanion();
    const affordable = (a.cost||0) <= playerP.mp && !companionMissing;
    const btn = document.createElement('button');
    btn.className = 'skillRow2';
    const kindColor = { single:'#c94f3d', execute:'#c94f3d', multi:'#c9822c', aoe:'#d9542d', heal:'#3e8e6e', heal2:'#3e8e6e', healAll:'#3e8e6e', revive:'#ffd23f', healAllDmgAll:'#3e8e6e', creature:'#9a6fc9' }[a.kind] || '#8a6fb0';
    btn.style.borderLeftColor = kindColor;
    btn.disabled = !affordable;
    btn.innerHTML = `<span class="srName">${a.name}${companionMissing?' 🚫':''}</span><span class="srMp">${resIcon}${a.cost||0}</span>`;
    btn.onclick = ()=>{
      if(!affordable) return;
      const living = livingEnemies();
      if(living.length>1 && a.kind!=='aoe' && a.kind!=='multi' && !['heal','heal2','healAll','revive','healAllDmgAll'].includes(a.kind)){
        showPartyTargetMenu(a);
      } else {
        doPlayerAbility(a, null);
      }
    };
    dock.appendChild(btn);
    // Beschreibung landet in einem festen Infofeld unterhalb — nichts wird verschoben
    const showInfo = ()=>{
      infoBox.textContent = a.desc || '—';
      infoBox.style.borderLeftColor = kindColor;
    };
    btn.addEventListener('mouseenter', showInfo);
    btn.addEventListener('focus', showInfo);
    btn.addEventListener('touchstart', showInfo, {passive:true});
  });
  wrap.appendChild(dock);
  wrap.appendChild(infoBox);
  dock.addEventListener('mouseleave', ()=>{
    infoBox.textContent = INFO_PLACEHOLDER;
    infoBox.style.borderLeftColor = 'rgba(255,255,255,.2)';
  });
  const back = document.createElement('button'); back.className='secondary'; back.textContent='↩ Zurück'; back.onclick=showMainMenu;
  wrap.appendChild(back);
  document.getElementById('encMainMenu').classList.add('hidden');
  wrap.classList.remove('hidden');
}
function showPartyTargetMenu(ability){
  const wrap = document.getElementById('encSubMenu'); wrap.innerHTML='';
  const title = document.createElement('div'); title.className='desc'; title.style.textAlign='center'; title.textContent='Wen angreifen?';
  wrap.appendChild(title);
  encounter.enemies.forEach((e,idx)=>{
    if(e.hp<=0) return;
    const sp = SPECIES[e.speciesId];
    const btn = document.createElement('button');
    btn.textContent = `${sp.name} (${e.hp}/${e.maxHp} LP)`;
    btn.onclick = ()=>doPlayerAbility(ability, idx);
    wrap.appendChild(btn);
  });
  const back = document.createElement('button'); back.className='secondary'; back.textContent='↩ Zurück'; back.onclick=showPartySkillMenu;
  wrap.appendChild(back);
}
function showTargetMenu(moveIndex){
  const wrap = document.getElementById('encSubMenu'); wrap.innerHTML='';
  const title = document.createElement('div'); title.className='desc'; title.style.textAlign='center'; title.textContent='Wen angreifen?';
  wrap.appendChild(title);
  encounter.enemies.forEach((e,idx)=>{
    if(e.hp<=0) return;
    const sp = SPECIES[e.speciesId];
    const btn = document.createElement('button');
    btn.textContent = `${sp.name} (${e.hp}/${e.maxHp} LP)`;
    btn.onclick = ()=>doMoveRound(moveIndex, idx);
    wrap.appendChild(btn);
  });
  const back = document.createElement('button'); back.className='secondary'; back.textContent='↩ Zurück'; back.onclick=showMoveMenu;
  wrap.appendChild(back);
}
/* Bricht eine Item-Aktion ab, ohne den Zug zu verbrauchen — und holt
   dabei das Menü zurück. Vorher blieben beide Menüs versteckt und der
   Kampf hing fest. */
function abortItemAction(msg){
  if(msg) toast(msg);
  document.getElementById('encSubMenu').classList.add('hidden');
  if(typeof activeAllyRef !== 'undefined' && activeAllyRef) showAllyMenu(activeAllyRef);
  else showMainMenu();
}
function showItemMenu(){
  if(!encounter) return;
  const wrap = document.getElementById('encSubMenu'); wrap.innerHTML='';
  const usingParty = !!encounter.party;
  const b1 = document.createElement('button'); b1.className='itemBtnBerry'; b1.textContent = '🫐 Beere verfüttern ('+state.inventory.berries+')';
  const noCompanion = !usingParty && !ensurePlayerMonHp();
  b1.disabled = state.inventory.berries<=0 || (usingParty ? encounter.party.every(p=>p.hp<=0) : noCompanion);
  if(noCompanion) b1.title = 'Du hast keinen gezähmten Begleiter aktiv — wähle im Feldbuch (📖) eine gefangene Kreatur als Begleiter.';
  b1.onclick = usingParty ? doPartyItemBerry : doItemBerry;
  const b3 = document.createElement('button'); b3.className='itemBtnPotion'; b3.textContent = '🧪 Heiltrank ('+(state.inventory.potion||0)+')';
  b3.disabled = (state.inventory.potion||0)<=0 || (usingParty ? encounter.party.every(p=>p.hp<=0) : noCompanion);
  b3.onclick = usingParty ? doPartyItemPotion : doItemPotion;
  const b2 = document.createElement('button'); b2.className='itemBtnTrap';
  b2.textContent = '🪤 Falle werfen ('+state.inventory.trap+')';
  b2.disabled = state.inventory.trap<=0;
  b2.onclick = doItemTrap;
  const back = document.createElement('button'); back.className='secondary'; back.textContent='↩ Zurück';
  // Zurück zum Menü der Figur, die wirklich am Zug ist
  back.onclick = function(){ if(activeAllyRef) showAllyMenu(activeAllyRef); else showMainMenu(); };
  wrap.appendChild(b1); wrap.appendChild(b3); wrap.appendChild(b2); wrap.appendChild(back);
  document.getElementById('encMainMenu').classList.add('hidden');
  wrap.classList.remove('hidden');
}
function onBattleFightClick(){
  if(encounter && encounter.party && state.player.advClass) showPartySkillMenu();
  else showMoveMenu();
}
/* Verdrahtung als Funktion: Das Gefährten-Menü ersetzt den Inhalt von
   encMainMenu, wodurch die Ereignisbindungen verloren gehen. Nach dem
   Wiederherstellen müssen sie erneut gesetzt werden. */
function bindBattleMenuButtons(){
  const fight = document.getElementById('btnMenuFight');
  if(fight) fight.onclick = onBattleFightClick;
  const pr = document.getElementById('btnMenuPartyRound');
  if(pr) pr.onclick = function(){ doPartyRound(); };
  const it = document.getElementById('btnMenuItem');
  if(it) it.onclick = showItemMenu;
  const df = document.getElementById('btnMenuDefend');
  if(df) df.onclick = function(){ doDefendRound(); };
  const fl = document.getElementById('btnMenuFlee');
  if(fl) fl.onclick = function(){
    if(encounter && encounter.party){ doPartyFlee(); } else { doFlee(); }
  };
  const ab = document.getElementById('btnAutoBattle');
  if(ab) ab.onclick = onAutoBattleClick;
}

/* ============================================================
   Autokampf: Kolonisten-Gruppe kämpft selbstständig weiter.
   Wählt automatisch eine sinnvolle Fähigkeit (heilen wenn nötig,
   sonst angreifen) und spielt Runde für Runde ab.
============================================================ */
let autoBattleOn = false;
let autoBattleTimer = null;
function updateAutoBattleButton(){
  const b = document.getElementById('btnAutoBattle');
  if(!b) return;
  const usable = !!(encounter && encounter.party);
  b.classList.toggle('hidden', !usable);
  b.textContent = autoBattleOn ? '🤖 Autokampf: An' : '🤖 Autokampf: Aus';
  b.style.background = autoBattleOn
    ? 'linear-gradient(180deg,#3e8e6e,#2f6b53)' : '';
  b.style.color = autoBattleOn ? '#eafff5' : '';
}
function stopAutoBattle(){
  autoBattleOn = false;
  if(autoBattleTimer){ clearTimeout(autoBattleTimer); autoBattleTimer = null; }
  updateAutoBattleButton();
}
function autoPickAction(){
  if(!encounter || !encounter.party) return null;
  const me = encounter.party.find(p=>p.id==='__player__');
  if(!me || me.hp<=0) return null;
  const abilities = unlockedAbilities(me.cls, me.level) || [];
  const affordable = abilities.filter(a=>(a.cost||0) <= me.mp &&
    !(a.kind==='creature' && !hasUsableCompanion()));
  if(!affordable.length) return {basic:true};
  // Verwundeter Verbündeter unter 45%? -> heilen
  const hurt = encounter.party.filter(p=>p.hp>0 && p.hp/p.maxHp < 0.45);
  if(hurt.length){
    const healSkill = affordable.find(a=>['heal','heal2','healAll','healAllDmgAll'].includes(a.kind));
    if(healSkill) return {ability:healSkill};
  }
  // Gefallener Verbündeter? -> wiederbeleben
  const downed = encounter.party.filter(p=>p.hp<=0);
  if(downed.length){
    const rev = affordable.find(a=>a.kind==='revive');
    if(rev) return {ability:rev};
  }
  // Mehrere Gegner? -> Flächenangriff bevorzugen
  const foes = livingEnemies();
  if(foes.length>1){
    const aoe = affordable.find(a=>a.kind==='aoe'||a.kind==='multi');
    if(aoe) return {ability:aoe};
  }
  // sonst stärkster Einzelangriff, den wir uns leisten können
  const dmgSkills = affordable.filter(a=>['single','execute','multi','aoe'].includes(a.kind));
  if(dmgSkills.length){
    dmgSkills.sort((a,b)=>(b.mult||1)-(a.mult||1));
    return {ability:dmgSkills[0]};
  }
  return {basic:true};
}
function autoBattleStep(){
  if(!autoBattleOn || !encounter || !encounter.party){ stopAutoBattle(); return; }
  if(allEnemiesDead() || encounter.party.every(p=>p.hp<=0)){ stopAutoBattle(); return; }
  // nur handeln, wenn der Spieler tatsächlich am Zug ist
  const entry = turnQueue && turnQueue[turnQueueIdx];
  if(!entry || entry.kind!=='ally' || entry.ref.id!=='__player__'){
    autoBattleTimer = setTimeout(autoBattleStep, 350);
    return;
  }
  const choice = autoPickAction();
  if(!choice){ stopAutoBattle(); return; }
  try{
    if(choice.ability){
      // schwächsten lebenden Gegner als Ziel wählen
      const foes = encounter.enemies.map((e,i)=>({e,i})).filter(o=>o.e.hp>0);
      foes.sort((a,b)=>a.e.hp-b.e.hp);
      doPlayerAbility(choice.ability, foes.length?foes[0].i:null);
    } else {
      doPartyRound();
    }
  }catch(e){ stopAutoBattle(); return; }
  autoBattleTimer = setTimeout(autoBattleStep, 850);
}
function onAutoBattleClick(){
  if(!encounter || !encounter.party){ toast('🤖 Autokampf braucht eine Gruppe.'); return; }
  autoBattleOn = !autoBattleOn;
  updateAutoBattleButton();
  if(autoBattleOn){
    toast('🤖 Autokampf aktiv — die Gruppe kämpft selbstständig.');
    autoBattleTimer = setTimeout(autoBattleStep, 400);
  } else {
    if(autoBattleTimer){ clearTimeout(autoBattleTimer); autoBattleTimer=null; }
    toast('🤖 Autokampf aus — du steuerst jeden Gefährten selbst.');
  }
}
const autoBtn = document.getElementById('btnAutoBattle');

/* ---------- combat math ---------- */
/* ============================================================
   Statuseffekte im Kampf
   Werden von typgebundenen Angriffen ausgelöst, wirken zu
   Rundenbeginn und werden über der Figur angezeigt.
============================================================ */
/* --- Gekapselt: 3 Bezeichner nach außen, 4 bleiben intern.
   Schnittstelle: rollStatusFromType, tickStatuses, drawStatusIcons
   Intern: STATUS_DEFS, TYPE_STATUS, applyStatus, hasStatus --- */
const STATUS_DEFS = {
  poison:{ name:'Gift',   icon:'☠️', color:'#8f5ac9', dmgPct:0.08, turns:3,
           text:'wird vergiftet!', tick:'leidet unter Gift' },
  burn:  { name:'Brand',  icon:'🔥', color:'#e07030', dmgPct:0.10, turns:2,
           text:'fängt Feuer!',    tick:'brennt' },
  freeze:{ name:'Frost',  icon:'❄️', color:'#6fb8d8', dmgPct:0.04, turns:2, slow:true,
           text:'friert ein!',     tick:'ist unterkühlt' },
  bleed: { name:'Blutung',icon:'🩸', color:'#c94f3d', dmgPct:0.09, turns:2,
           text:'blutet!',         tick:'verliert Blut' }
};
// Welcher Angriffstyp löst welchen Effekt aus (Chance in Prozent)
const TYPE_STATUS = {
  Fire:{key:'burn', chance:0.28}, Poison:{key:'poison', chance:0.35},
  Ice:{key:'freeze', chance:0.26}, Rock:{key:'bleed', chance:0.18},
  Bug:{key:'poison', chance:0.20}, Ghost:{key:'freeze', chance:0.15},
  Dragon:{key:'burn', chance:0.20}, Electric:{key:'freeze', chance:0.12}
};
// Effekt auf ein Ziel legen (Objekt braucht nur ein statuses-Feld)
function applyStatus(target, key, sourceName){
  if(!target || !STATUS_DEFS[key]) return null;
  target.statuses = target.statuses || [];
  const existing = target.statuses.find(s=>s.key===key);
  if(existing){ existing.turns = STATUS_DEFS[key].turns; return null; } // nur auffrischen
  target.statuses.push({ key, turns: STATUS_DEFS[key].turns });
  return `${sourceName||'Das Ziel'} ${STATUS_DEFS[key].text}`;
}
// Nach einem Treffer prüfen, ob der Angriffstyp einen Effekt auslöst
function rollStatusFromType(atkType, target, targetName){
  const cfg = TYPE_STATUS[atkType];
  if(!cfg || Math.random() > cfg.chance) return null;
  return applyStatus(target, cfg.key, targetName);
}
// Zu Rundenbeginn: Schaden anwenden, Dauer herunterzählen
function tickStatuses(target, maxHp, label){
  if(!target || !target.statuses || !target.statuses.length) return [];
  const lines = [];
  target.statuses = target.statuses.filter(s=>{
    const def = STATUS_DEFS[s.key];
    if(!def) return false;
    const dmg = Math.max(1, Math.round(maxHp * def.dmgPct));
    if(def.dmgPct>0){
      if(target.hp!==undefined) target.hp = clamp(target.hp-dmg, 0, maxHp);
      else if(target.currentHp!==undefined) target.currentHp = clamp(target.currentHp-dmg, 0, maxHp);
      lines.push(`${def.icon} ${label} ${def.tick} (-${dmg}).`);
    }
    s.turns--;
    if(s.turns<=0){ lines.push(`${label}: ${def.name} klingt ab.`); return false; }
    return true;
  });
  return lines;
}
function hasStatus(target, key){
  return !!(target && target.statuses && target.statuses.some(s=>s.key===key));
}
// Symbole über der Figur zeichnen
function drawStatusIcons(bctx, target, x, y, S){
  if(!target || !target.statuses || !target.statuses.length) return;
  const size = 15*Math.min(S,1.5);
  const total = target.statuses.length;
  target.statuses.forEach((s,i)=>{
    const def = STATUS_DEFS[s.key]; if(!def) return;
    const ix = x + (i-(total-1)/2)*(size+4);
    bctx.save();
    bctx.fillStyle='rgba(0,0,0,.5)';
    bctx.beginPath(); bctx.arc(ix, y+1, size*0.55, 0, Math.PI*2); bctx.fill();
    bctx.fillStyle = def.color;
    bctx.globalAlpha = 0.85;
    bctx.beginPath(); bctx.arc(ix, y, size*0.55, 0, Math.PI*2); bctx.fill();
    bctx.globalAlpha = 1;
    bctx.strokeStyle='rgba(255,255,255,.4)'; bctx.lineWidth=1.2; bctx.stroke();
    bctx.font = Math.round(size*0.62)+'px sans-serif';
    bctx.textAlign='center'; bctx.textBaseline='middle';
    bctx.fillText(def.icon, ix, y+0.5);
    // Restdauer als kleine Zahl
    bctx.font='800 '+Math.round(size*0.42)+'px Nunito, sans-serif';
    bctx.fillStyle='#fff';
    bctx.fillText(s.turns, ix+size*0.42, y+size*0.42);
    bctx.textBaseline='alphabetic';
    bctx.restore();
  });
}


function computeMoveResult(atkSpecies, atkStats, defSpecies, defStats, move, defending){
  if(Math.random() > move.acc){ return { dmg:0, text:`setzt ${move.name} ein... Daneben!`, mult:1, crit:false }; }
  const mult = typeMultiplier(atkSpecies.type, defSpecies.type);
  let dmg = Math.max(1, Math.round(calcDmg(Math.round(atkStats.atk*move.power), defStats.def) * mult));
  const crit = Math.random() < 0.08;
  if(crit) dmg = Math.round(dmg*1.6);
  if(defending) dmg = Math.max(1, Math.round(dmg*0.5));
  let suffix = mult>1.01 ? ' Sehr effektiv!' : (mult<0.99 ? ' Nicht sehr effektiv...' : '');
  if(crit) suffix = ' 💥 Kritischer Treffer!'+suffix;
  return { dmg, text:`setzt ${move.name} ein! ${dmg} Schaden.`+suffix, mult, crit };
}
function playerGearBonus(){
  const g = state.player.gear || {weapon:0,armor:0,trinket:0};
  return { atk: (g.weapon||0)+(g.trinket||0), def: (g.armor||0)+(g.trinket||0) };
}
function wildAttacks(defendingFlag){
  const psp = SPECIES[state.activeId]; const pm = ensurePlayerMonHp();
  if(!pm) return '';
  const living = livingEnemies();
  if(living.length===0) return '';
  const gb = playerGearBonus();
  const defStats = { atk: psp.stats.atk, def: psp.stats.def+gb.def, hp: psp.stats.hp };
  const attackers = [living[Math.floor(Math.random()*living.length)]];
  if(living.length>1 && Math.random()<0.4){
    const second = living.filter(e=>e!==attackers[0]);
    if(second.length>0) attackers.push(second[Math.floor(Math.random()*second.length)]);
  }
  const texts = attackers.map(e=>{
    const sp = SPECIES[e.speciesId];
    const wmove = MOVES_BY_TYPE[sp.type][Math.floor(Math.random()*MOVES_BY_TYPE[sp.type].length)];
    const res = computeMoveResult(sp, {atk:e.atk||sp.stats.atk, def:sp.stats.def, hp:sp.stats.hp}, psp, defStats, wmove, defendingFlag);
    pm.currentHp = clamp(pm.currentHp-res.dmg, 0, psp.stats.hp);
    const pos = companionSpritePos();
    animAttack('enemy', 0);
    if(res.dmg===0){ sfxMiss(); spawnFloatingText(pos.x, pos.y, 'Verfehlt!', '#cfcfcf'); }
    else {
      if(res.crit) sfxSuperEffective(); else sfxHitTaken();
      spawnFloatingText(pos.x, pos.y, '-'+res.dmg, res.crit?'#ffd23f':'#ff6b5b');
      setTimeout(()=>{ if(!encounter) return; animHit('comp', 0, res.crit); spawnImpact(pos.x, pos.y, '#ff6b5b', res.crit?16:9); }, 150);
      const stL = rollStatusFromType(sp.type, pm, psp.name);
      if(stL) res.text += ' '+stL;
    }
    return `Das wilde ${sp.name} `+res.text;
  });
  return texts.join(' ');
}
function playerAttacks(moveIndex, targetIdx){
  const psp = SPECIES[state.activeId];
  const idx = (targetIdx!=null && encounter.enemies[targetIdx] && encounter.enemies[targetIdx].hp>0) ? targetIdx : encounter.enemies.findIndex(e=>e.hp>0);
  if(idx<0) return '';
  const target = encounter.enemies[idx];
  const sp = SPECIES[target.speciesId];
  const move = MOVES_BY_TYPE[psp.type][moveIndex];
  const gb = playerGearBonus();
  const atkStats = { atk: psp.stats.atk+gb.atk, def: psp.stats.def+gb.def, hp: psp.stats.hp };
  const res = computeMoveResult(psp, atkStats, sp, sp.stats, move, false);
  if(hasTech('tierbund') && res.dmg>0) res.dmg = Math.max(1, Math.round(res.dmg*1.15));
  target.hp = clamp(target.hp-res.dmg, 0, target.maxHp);
  const pos = enemySpritePos(idx);
  animAttack('comp', 0);
  if(res.dmg===0){ sfxMiss(); spawnFloatingText(pos.x, pos.y, 'Verfehlt!', '#cfcfcf'); }
  else {
    if(res.crit) sfxSuperEffective(); else if(res.mult>1.01) sfxSuperEffective(); else sfxHit();
    spawnFloatingText(pos.x, pos.y, '-'+res.dmg, res.crit?'#ffd23f':'#efe6cd');
    setTimeout(()=>{ if(!encounter) return; animHit('enemy', idx, res.crit); spawnImpact(pos.x, pos.y, res.crit?'#ffd23f':'#ffb36b', res.crit?18:10); }, 150);
    const stLine = rollStatusFromType(psp.type, target, sp.name);
    if(stLine) res.text += ' '+stLine;
  }
  return `${psp.name} greift ${sp.name} an — `+res.text;
}
function rollCombatLoot(){
  const r = Math.random();
  if(r<0.40) return null;
  if(r<0.65){
    const keys=['wood','stone','fiber']; const k=keys[Math.floor(Math.random()*keys.length)]; const amt=1+Math.floor(Math.random()*3);
    addResource(k, amt); bumpResource(k);
    return `+${amt} ${RESOURCE_ICONS[k]} ${RESOURCE_NAMES[k]}`;
  }
  if(r<0.80){
    const k = Math.random()<0.8?'copper':'silver';
    addResource(k, 1); bumpResource(k);
    return `+1 ${RESOURCE_ICONS[k]} ${RESOURCE_NAMES[k]}`;
  }
  if(r<0.92){
    state.inventory.potion=(state.inventory.potion||0)+1;
    return '+1 🧪 Heiltrank';
  }
  if(r<0.97){
    state.inventory.metal=(state.inventory.metal||0)+2; bumpResource('metal');
    return '+2 ⚙️ Metall';
  }
  state.classScrolls=(state.classScrolls||0)+1;
  return '+1 📜 Klassen-Schriftrolle (im Kolonie-Panel bei Kolonisten nutzbar)';
}
function rollMeatDrop(speciesId){
  if(Math.random()>=0.65) return null;
  const sp = SPECIES[speciesId];
  const key = MEAT_BY_TYPE[sp.type] || 'meat_normal';
  const amt = 1+Math.floor(Math.random()*2);
  addResource(key, amt);
  bumpResource(key);
  // Jagdbeute liefert zusätzlich Fell — Rohstoff für die Gerberei
  let extra = '';
  if(Math.random()<0.65){
    const pelts = 1+Math.floor(Math.random()*2);
    state.inventory.fell = (state.inventory.fell||0)+pelts;
    bumpResource('fell');
    extra = `, +${pelts} ${RESOURCE_ICONS.fell} ${RESOURCE_NAMES.fell}`;
  }
  return `+${amt} ${RESOURCE_ICONS[key]} ${RESOURCE_NAMES[key]}${extra}`;
}
function afterVictory(lines){
  let bossPos = null;
  if(dungeonCtx && !dungeonCtx.cleared){
    encounter.enemies.forEach(e=>{
      if(e.uid===dungeonCtx.bossUid){ const wm = wildMonsters.find(w=>w.uid===e.uid); if(wm) bossPos = {x:wm.x, y:wm.y}; }
    });
  }
  encounter.enemies.forEach(e=>{ if(e.uid!=null){ wildMonsters = wildMonsters.filter(w=>w.uid!==e.uid); } });
  if(atHome()) homeCtx.wildMonsters = wildMonsters;
  state.quests.killCount = (state.quests.killCount||0) + encounter.enemies.length;
  lines.push(encounter.enemies.length>1 ? 'Die wilden Wesen fliehen erschöpft.' : `Das wilde ${SPECIES[encounter.enemies[0].speciesId].name} flieht erschöpft.`);
  const loot = encounter.enemies.flatMap(e=>[rollCombatLoot(), rollMeatDrop(e.speciesId)]).filter(Boolean);
  if(loot.length>0){ lines.push('Beute: '+loot.join(', ')+'.'); toast('🎁 Beute gefunden: '+loot.join(', ')); }
  if(bossPos){
    dungeonCtx.cleared = true;
    state.quests.bossDefeated = true;
    objects.set(bossPos.x+','+bossPos.y, {type:'dungeon_chest', hp:1, maxHp:1});
    lines.push('👑 Der Wächter ist besiegt! Eine Beutetruhe erscheint.');
    logEvent('👑 Dungeon-Boss besiegt, Beutetruhe erschienen.');
  }
  document.getElementById('encLog').textContent = lines.join(' ');
  redrawEncounterSprites(); refreshEncounterBars(); sfxVictory();
  if(state.activeId!=null && state.collection[state.activeId]){
    const c = state.collection[state.activeId];
    c.wins = (c.wins||0)+1;
    checkEvolution(state.activeId);
  }
  if(encounter.raid && !homeCtx.wildMonsters.some(w=>w.raid)) resolveRaidSuccess();
  setTimeout(endEncounter, 1100); saveGame();
}
function checkEvolution(id){
  const sp = SPECIES[id];
  const c = state.collection[id];
  if(!sp || !c || sp.evolvesTo==null) return;
  if((c.wins||0) < EVOLUTION_WINS_NEEDED) return;
  const evoSp = SPECIES[sp.evolvesTo];
  state.collection[evoSp.id] = { caught:true, currentHp: evoSp.stats.hp, wins:0, penned:false };
  if(state.activeId===id) state.activeId = evoSp.id;
  state.quests.evolutionSeen = true;
  sfxVictory();
  showStoryDialog('✨ Entwicklung!', `${sp.name} hat genug Erfahrung gesammelt und entwickelt sich zu ${evoSp.name}! Die neuen Werte: ❤️${evoSp.stats.hp} ⚔️${evoSp.stats.atk} 🛡️${evoSp.stats.def} 🏃${evoSp.stats.spd}`, [{label:'Fantastisch!', action:()=>{}}]);
  logEvent('✨ '+sp.name+' hat sich zu '+evoSp.name+' entwickelt!');
  saveGame();
}
function afterFaint(lines){
  const psp = SPECIES[state.activeId];
  lines.push(`Dein ${psp.name} ist erschöpft und zieht sich zurück.`);
  document.getElementById('encLog').textContent = lines.join(' ');
  refreshEncounterBars(); sfxFaint();
  setTimeout(endEncounter, 1300); saveGame();
}
function finishRound(lines, pm){
  // Statuseffekte am Rundenende abarbeiten
  if(encounter){
    encounter.enemies.forEach(e=>{
      if(e.hp<=0) return;
      tickStatuses(e, e.maxHp, SPECIES[e.speciesId].name).forEach(l=>lines.push(l));
    });
    if(pm && state.activeId!=null){
      const psp = SPECIES[state.activeId];
      const before = pm.currentHp;
      tickStatuses(pm, psp.stats.hp, psp.name).forEach(l=>lines.push(l));
      if(pm.currentHp<before) sfxHitTaken();
    }
  }
  document.getElementById('encLog').textContent = lines.join(' ');
  redrawEncounterSprites(); refreshEncounterBars(); showMainMenu();
  if(pm && pm.currentHp<=0){ afterFaint(lines); return; }
  saveGame();
}

/* ---------- round handlers ---------- */
function doMoveRound(moveIndex, targetIdx){
  const pm = ensurePlayerMonHp(); if(!pm || pm.currentHp<=0) return;
  const psp = SPECIES[state.activeId];
  const enemySpds = livingEnemies().map(e=>effectiveSpd(e, 'enemy'));
  const maxEnemySpd = enemySpds.length ? Math.max(...enemySpds) : 0;
  const playerSpd = Math.max(1, Math.round(psp.stats.spd * slowFactor(pm)));
  const playerFirst = (playerSpd + Math.random()*3) >= (maxEnemySpd + Math.random()*3);
  let lines = [];
  if(playerFirst){
    lines.push(playerAttacks(moveIndex, targetIdx));
    redrawEncounterSprites(); refreshEncounterBars();
    if(allEnemiesDead()){ afterVictory(lines); return; }
    lines.push(wildAttacks(false));
  } else {
    lines.push(wildAttacks(false));
    if(pm.currentHp<=0){ afterFaint(lines); return; }
    lines.push(playerAttacks(moveIndex, targetIdx));
    if(allEnemiesDead()){ afterVictory(lines); return; }
  }
  finishRound(lines, pm);
}
function doDefendRound(){
  if(!encounter) return;
  const pm = ensurePlayerMonHp(); if(!pm || pm.currentHp<=0) return;
  const psp = SPECIES[state.activeId];
  let lines = [`${psp.name} geht in Deckung und übersteht den nächsten Treffer besser.`];
  lines.push(wildAttacks(true));
  finishRound(lines, pm);
}
function doItemBerry(){
  if(!encounter || state.inventory.berries<=0) return;
  const pm = ensurePlayerMonHp(); if(!pm) return;
  const psp = SPECIES[state.activeId];
  state.inventory.berries -= 1; bumpResource('berries'); sfxEat();
  const heal = Math.round(psp.stats.hp*0.4);
  pm.currentHp = clamp(pm.currentHp+heal, 0, psp.stats.hp);
  spawnFloatingText(companionSpritePos().x, companionSpritePos().y, '+'+heal, '#8fc93a');
  let lines = [`Du gibst ${psp.name} eine Beere. +${heal} HP.`];
  lines.push(wildAttacks(false));
  finishRound(lines, pm);
}
function doItemPotion(){
  if(!encounter || (state.inventory.potion||0)<=0) return;
  const pm = ensurePlayerMonHp(); if(!pm) return;
  const psp = SPECIES[state.activeId];
  state.inventory.potion -= 1; sfxEat();
  const heal = Math.round(psp.stats.hp*0.75);
  pm.currentHp = clamp(pm.currentHp+heal, 0, psp.stats.hp);
  spawnFloatingText(companionSpritePos().x, companionSpritePos().y, '+'+heal, '#8fc93a');
  let lines = [`Du gibst ${psp.name} einen Heiltrank. +${heal} HP.`];
  lines.push(wildAttacks(false));
  finishRound(lines, pm);
}
function doItemTrap(){
  if(!encounter) return;
  if(state.inventory.trap<=0){ abortItemAction('🪤 Du hast keine Fallen.'); return; }
  const living = livingEnemies();
  if(living.length===0){ abortItemAction(); return; }
  if(living.length>1){ showCatchTargetMenu(); return; }
  executeTrapThrow(encounter.enemies.findIndex(e=>e.hp>0));
}
function showCatchTargetMenu(){
  const wrap = document.getElementById('encSubMenu'); wrap.innerHTML='';
  const title = document.createElement('div'); title.className='desc'; title.style.textAlign='center'; title.textContent='Welches Wesen fangen?';
  wrap.appendChild(title);
  encounter.enemies.forEach((e,idx)=>{
    if(e.hp<=0) return;
    const sp = SPECIES[e.speciesId];
    const btn = document.createElement('button');
    btn.textContent = `${sp.name} (${e.hp}/${e.maxHp} LP)`;
    btn.onclick = ()=>executeTrapThrow(idx);
    wrap.appendChild(btn);
  });
  const back = document.createElement('button'); back.className='secondary'; back.textContent='↩ Zurück'; back.onclick=showItemMenu;
  wrap.appendChild(back);
}
const BOSS_CATCH_HP_THRESHOLD = 0.3;
function executeTrapThrow(idx){
  const target = encounter.enemies[idx];
  const sp = SPECIES[target.speciesId];
  const hpFrac = target.hp/target.maxHp;
  const isBoss = !!target.boss;
  if(isBoss && hpFrac > BOSS_CATCH_HP_THRESHOLD){
    sfxCatchFail();
    toast(`⚠️ ${sp.name} wehrt die Falle mühelos ab — schwäche es zuerst auf unter ${Math.round(BOSS_CATCH_HP_THRESHOLD*100)}% Leben!`);
    return;
  }
  state.inventory.trap -= 1; bumpResource('trap'); updateHUD();
  const wbBonus = state.buildings.some(b=>b.type==='workbench' && b.built) ? 0.15 : 0;
  const kennelBonus = state.buildings.some(b=>b.type==='zwinger' && b.built) ? 0.1 : 0;
  const rangerBonus = (encounter.party && encounter.party.some(p=>p.cls==='Waldläufer' && p.hp>0)) ? 0.1 : 0;
  const techBonus = hasTech('faehrtenlesen') ? 0.1 : 0;
  const lowHpBonus = Math.pow(clamp(1-hpFrac,0,1), 1.8) * 0.65;
  let chance = sp.catchBase*0.35 + lowHpBonus + wbBonus + kennelBonus + rangerBonus + techBonus;
  if(isBoss) chance *= 0.5;
  const chanceMax = isBoss ? 0.5 : 0.9;
  const chanceClamped = clamp(chance, 0.03, chanceMax);
  const success = Math.random() < chanceClamped;
  if(success){
    sfxCatchSuccess();
    if(!state.collection[sp.id]){
      state.collection[sp.id] = { caught:true, currentHp: sp.stats.hp, wins:0, penned:false };
      toast(`🎉 ${sp.name} wurde gefangen und ins Feldbuch aufgenommen!`);
      if(state.activeId==null) state.activeId = sp.id;
    } else { toast(`🎉 ${sp.name} erneut gefangen!`); }
    target.hp = 0;
    if(target.uid!=null){ wildMonsters = wildMonsters.filter(w=>w.uid!==target.uid); if(atHome()) homeCtx.wildMonsters = wildMonsters; }
    let lines = [`Die Falle hält! ${sp.name} wurde gefangen!`];
    redrawEncounterSprites(); refreshEncounterBars();
    if(allEnemiesDead()){
      document.getElementById('encLog').textContent = lines.join(' ');
      if(encounter.raid && !homeCtx.wildMonsters.some(w=>w.raid)) resolveRaidSuccess();
      setTimeout(endEncounter, 1000); saveGame();
      return;
    }
    if(encounter.party){ continuePartyTurnQueue(lines); }
    else {
      const pm = ensurePlayerMonHp();
      if(pm){ finishRound(lines, pm); }
      else { document.getElementById('encLog').textContent = lines.join(' '); showMainMenu(); saveGame(); }
    }
  } else {
    sfxCatchFail();
    let lines = [`Die Falle hat nicht gehalten! ${sp.name} kämpft weiter.`];
    if(encounter.party){
      continuePartyTurnQueue(lines);
    } else {
      const pm = ensurePlayerMonHp();
      if(pm){ lines.push(wildAttacks(false)); finishRound(lines, pm); }
      else { document.getElementById('encLog').textContent = lines.join(' '); showMainMenu(); updateHUD(); saveGame(); }
    }
  }
}
function doFlee(){
  if(!encounter) return;
  const success = Math.random() < (hasTech('expedition') ? 0.9 : 0.8);
  if(success){ sfxFleeSuccess(); toast('Du bist erfolgreich geflohen!'); endEncounter(); return; }
  sfxFleeFail();
  let lines = ['Die Flucht ist fehlgeschlagen!'];
  const pm = ensurePlayerMonHp();
  if(pm){ lines.push(wildAttacks(false)); finishRound(lines, pm); }
  else { document.getElementById('encLog').textContent = lines.join(' '); showMainMenu(); }
}

/* ---------- Party combat: initiative turn queue ---------- */
let turnQueue = [];
let turnQueueIdx = 0;
let turnRoundLines = [];
/* Tempo eines Kämpfers inklusive Statuseffekten. Frost ist als slow:true
   definiert und hasStatus() gab es bereits — nur ausgewertet wurde beides
   nie, weshalb Frost bisher ausschliesslich Schaden machte. */
function slowFactor(ref){
  let f = 1;
  const list = (ref && ref.statuses) ? ref.statuses : [];
  list.forEach(s=>{ const def = STATUS_DEFS[s.key]; if(def && def.slow) f *= 0.5; });
  return f;
}
function effectiveSpd(ref, kind){
  const base = (kind==='ally') ? ref.spd : SPECIES[ref.speciesId].stats.spd;
  if(!(base > 0)) return 1;
  return Math.max(1, Math.round(base * slowFactor(ref)));
}
function startPartyTurnRound(){
  if(!encounter || !encounter.party) return;
  const combatants = [];
  encounter.party.forEach(p=>{ if(p.hp>0) combatants.push({kind:'ally', ref:p}); });
  encounter.enemies.forEach(e=>{ if(e.hp>0) combatants.push({kind:'enemy', ref:e}); });
  combatants.sort((a,b)=> effectiveSpd(b.ref, b.kind) - effectiveSpd(a.ref, a.kind));
  turnQueue = combatants;
  turnQueueIdx = 0;
  turnRoundLines = [];
  // Statuseffekte zu Rundenbeginn abarbeiten (Frost verlangsamt zusätzlich)
  encounter.enemies.forEach(e=>{
    if(e.hp<=0) return;
    tickStatuses(e, e.maxHp, SPECIES[e.speciesId].name).forEach(l=>turnRoundLines.push(l));
  });
  encounter.party.forEach(p=>{
    if(p.hp<=0) return;
    tickStatuses(p, p.maxHp, p.id==='__player__'?'Du':p.name).forEach(l=>turnRoundLines.push(l));
  });
  advanceTurnQueue();
}
function enemySingleAttack(e){
  const targets = encounter.party.filter(p=>p.hp>0);
  if(targets.length===0) return null;
  const sp = SPECIES[e.speciesId];
  const target = targets[Math.floor(Math.random()*targets.length)];
  const crit = rollCrit();
  let dmg = Math.max(1, calcDmg(e.atk||sp.stats.atk, target.def));
  if(crit) dmg = Math.round(dmg*1.6);
  target.hp = clamp(target.hp-dmg, 0, target.maxHp);
  const idx = encounter.party.indexOf(target);
  const pos = partySpritePos(idx);
  const eIdx = encounter.enemies.indexOf(e);
  animAttack('enemy', eIdx>=0?eIdx:0);
  spawnFloatingText(pos.x, pos.y, '-'+dmg, crit?'#ffd23f':'#ff6b5b');
  sfxHitTaken();
  setTimeout(()=>{ if(!encounter) return; animHit('party', idx, crit); spawnImpact(pos.x, pos.y, '#ff6b5b', crit?16:9); }, 150);
  return `Das wilde ${sp.name} greift ${target.id==='__player__'?'dich':target.name} an!${crit?' 💥 Kritischer Treffer!':''} ${dmg} Schaden.`;
}
function advanceTurnQueue(){
  if(!encounter || !encounter.party) return;
  if(allEnemiesDead()){ afterVictoryParty(turnRoundLines); return; }
  if(encounter.party.every(p=>p.hp<=0)){ afterPartyWipe(turnRoundLines); return; }
  while(turnQueueIdx < turnQueue.length){
    const entry = turnQueue[turnQueueIdx];
    if(entry.ref.hp<=0){ turnQueueIdx++; continue; }
    if(entry.kind==='ally' && entry.ref.id==='__player__'){
      activeAllyRef = null;
      document.getElementById('encLog').textContent = turnRoundLines.slice(-3).join(' ') || 'Du bist am Zug!';
      showMainMenu();
      return;
    }
    if(entry.kind==='ally'){
      // Manuelle Steuerung, sofern der Autokampf aus ist
      if(!autoBattleOn){
        document.getElementById('encLog').textContent =
          turnRoundLines.slice(-3).join(' ') || `${entry.ref.name} ist am Zug!`;
        showAllyMenu(entry.ref);
        return;
      }
      const ability = bestAbilityFor(entry.ref, livingEnemies().length);
      const line = ability ? executeAbility(entry.ref, ability, null) : `${entry.ref.name} zögert — noch keine Klasse gewählt.`;
      turnRoundLines.push(line);
      turnQueueIdx++;
      document.getElementById('encLog').textContent = turnRoundLines.slice(-3).join(' ');
      redrawEncounterSprites(); refreshEncounterBars();
      if(allEnemiesDead()){ afterVictoryParty(turnRoundLines); return; }
      setTimeout(advanceTurnQueue, 550);
      return;
    } else {
      const line = enemySingleAttack(entry.ref);
      if(line) turnRoundLines.push(line);
      turnQueueIdx++;
      document.getElementById('encLog').textContent = turnRoundLines.slice(-3).join(' ');
      redrawEncounterSprites(); refreshEncounterBars();
      if(encounter.party.every(p=>p.hp<=0)){ afterPartyWipe(turnRoundLines); return; }
      setTimeout(advanceTurnQueue, 550);
      return;
    }
  }
  startPartyTurnRound();
}
function continuePartyTurnQueue(lines){
  turnRoundLines.push(...lines);
  turnQueueIdx++;
  document.getElementById('encLog').textContent = turnRoundLines.slice(-3).join(' ');
  redrawEncounterSprites(); refreshEncounterBars();
  if(allEnemiesDead()){ afterVictoryParty(turnRoundLines); return; }
  if(encounter.party.every(p=>p.hp<=0)){ afterPartyWipe(turnRoundLines); return; }
  setTimeout(advanceTurnQueue, 400);
}
function wildAttacksParty(){
  const living = livingEnemies();
  if(living.length===0) return null;
  const texts = [];
  living.forEach(e=>{
    const targets = encounter.party.filter(p=>p.hp>0);
    if(targets.length===0) return;
    const sp = SPECIES[e.speciesId];
    const target = targets[Math.floor(Math.random()*targets.length)];
    const crit = rollCrit();
    let dmg = Math.max(1, calcDmg(e.atk||sp.stats.atk, target.def));
    if(crit) dmg = Math.round(dmg*1.6);
    target.hp = clamp(target.hp-dmg, 0, target.maxHp);
    const idx = encounter.party.indexOf(target);
    const pos = partySpritePos(idx);
    const eIdx2 = encounter.enemies.indexOf(e);
    animAttack('enemy', eIdx2>=0?eIdx2:0);
    spawnFloatingText(pos.x, pos.y, '-'+dmg, crit?'#ffd23f':'#ff6b5b');
    setTimeout(()=>{ if(!encounter) return; animHit('party', idx, crit); spawnImpact(pos.x, pos.y, '#ff6b5b', crit?16:9); }, 150);
    const stP = rollStatusFromType(sp.type, target, target.id==='__player__'?'Du':target.name);
    if(stP) texts.push(stP);
    texts.push(`Das wilde ${sp.name} greift ${target.id==='__player__'?'dich':target.name} an!${crit?' 💥 Kritischer Treffer!':''} ${dmg} Schaden.`);
  });
  if(texts.length>0) sfxHitTaken();
  return texts.join(' ') || null;
}
function afterVictoryParty(lines){
  let bossPos = null;
  if(dungeonCtx && !dungeonCtx.cleared){
    encounter.enemies.forEach(e=>{
      if(e.uid===dungeonCtx.bossUid){ const wm = wildMonsters.find(w=>w.uid===e.uid); if(wm) bossPos = {x:wm.x, y:wm.y}; }
    });
  }
  encounter.enemies.forEach(e=>{ if(e.uid!=null){ wildMonsters = wildMonsters.filter(w=>w.uid!==e.uid); } });
  if(atHome()) homeCtx.wildMonsters = wildMonsters;
  state.quests.killCount = (state.quests.killCount||0) + encounter.enemies.length;
  lines.push(encounter.enemies.length>1 ? 'Die wilden Wesen fliehen erschöpft.' : `Das wilde ${SPECIES[encounter.enemies[0].speciesId].name} flieht erschöpft.`);
  const loot = encounter.enemies.flatMap(e=>[rollCombatLoot(), rollMeatDrop(e.speciesId)]).filter(Boolean);
  if(loot.length>0){ lines.push('Beute: '+loot.join(', ')+'.'); toast('🎁 Beute gefunden: '+loot.join(', ')); }
  if(bossPos){
    dungeonCtx.cleared = true;
    state.quests.bossDefeated = true;
    objects.set(bossPos.x+','+bossPos.y, {type:'dungeon_chest', hp:1, maxHp:1});
    lines.push('👑 Der Wächter ist besiegt! Eine Beutetruhe erscheint.');
    logEvent('👑 Dungeon-Boss besiegt, Beutetruhe erschienen.');
  }
  document.getElementById('encLog').textContent = lines.join(' ');
  redrawEncounterSprites(); refreshEncounterBars(); sfxVictory();
  const xpDangerMult = atDungeon() && dungeonCtx ? (1+dungeonCtx.dangerLevel*0.09) : regionDangerMult(state.player.regionId);
  encounter.party.filter(p=>p.hp>0).forEach(p=>{
    const c = partyMemberCharacter(p);
    if(c) gainXp(c, Math.round(12*xpDangerMult));
  });
  if(encounter.raid && !homeCtx.wildMonsters.some(w=>w.raid)) resolveRaidSuccess();
  setTimeout(endEncounter, 1200); saveGame();
}
function afterPartyWipe(lines){
  lines.push('Deine Party ist erschöpft und zieht sich zurück.');
  document.getElementById('encLog').textContent = lines.join(' ');
  refreshEncounterBars(); sfxFaint();
  setTimeout(endEncounter, 1400); saveGame();
}
function finishPartyRound(lines){
  document.getElementById('encLog').textContent = lines.join(' ');
  redrawEncounterSprites(); refreshEncounterBars(); showMainMenu();
  if(encounter.party.every(p=>p.hp<=0)){ afterPartyWipe(lines); return; }
  saveGame();
}
function executeAbility(p, ability, forcedTargetIdx){
  const c = partyMemberCharacter(p);
  p.mp = Math.max(0, (p.mp||0) - (ability.cost||0));
  if(ability.kind==='heal' || ability.kind==='heal2' || ability.kind==='healAll' || ability.kind==='revive' || ability.kind==='healAllDmgAll'){
    const healBase = Math.round((p.heal||4)*(ability.healMult||1));
    if(ability.kind==='revive'){
      const fainted = encounter.party.filter(x=>x.hp<=0);
      if(fainted.length>0){
        const target = fainted[0];
        target.hp = Math.round(target.maxHp*Math.max(0.25,ability.healMult||0.3));
        const rpos = partySpritePos(encounter.party.indexOf(target));
        spawnFloatingText(rpos.x, rpos.y, '+'+target.hp, '#ffd23f');
        sfxBuildDone(); if(c) gainXp(c, 3);
        const isPlayerTarget = target.id==='__player__';
        return `${p.name} wirkt ${ability.name} auf ${isPlayerTarget?'dich':target.name}! ${isPlayerTarget?'Du kämpfst':target.name+' kämpft'} wieder mit ${target.hp} LP.`;
      }
    }
    if(ability.kind==='healAll' || ability.kind==='healAllDmgAll'){
      const alive = encounter.party.filter(x=>x.hp>0);
      alive.forEach(a=>{
        const healed = clamp(a.hp+healBase,0,a.maxHp) - a.hp;
        a.hp = clamp(a.hp+healBase,0,a.maxHp);
        if(healed>0){ const apos=partySpritePos(encounter.party.indexOf(a)); spawnFloatingText(apos.x, apos.y, '+'+healed, '#8fc93a'); }
      });
      let line = `${p.name} wirkt ${ability.name} — die ganze Party heilt um ${healBase} LP.`;
      sfxEat();
      if(ability.kind==='healAllDmgAll'){
        livingEnemies().forEach(en=>{
          const dmg = Math.max(1, Math.round(calcDmg(p.atk, SPECIES[en.speciesId].stats.def)*(ability.mult||0.4)));
          en.hp = clamp(en.hp-dmg,0,en.maxHp);
          const epos = enemySpritePos(encounter.enemies.indexOf(en));
          spawnFloatingText(epos.x, epos.y, '-'+dmg, '#ffd23f');
        });
        line += ' Heiliges Licht versengt alle Gegner!';
      }
      if(c) gainXp(c, 3);
      return line;
    }
    const targetsN = ability.kind==='heal2' ? 2 : 1;
    const lowestOnes = encounter.party.filter(x=>x.hp>0).sort((a,b)=>(a.hp/a.maxHp)-(b.hp/b.maxHp)).slice(0,targetsN);
    if(lowestOnes.length===0) return `${p.name} findet niemanden zum Heilen.`;
    lowestOnes.forEach(target=>{
      const healed = clamp(target.hp+healBase,0,target.maxHp) - target.hp;
      target.hp = clamp(target.hp+healBase,0,target.maxHp);
      const hpos = partySpritePos(encounter.party.indexOf(target));
      if(healed>0) spawnFloatingText(hpos.x, hpos.y, '+'+healed, '#8fc93a');
    });
    sfxEat();
    if(c) gainXp(c, 2);
    return `${p.name} wirkt ${ability.name} auf ${lowestOnes.map(t=>t.name).join(' & ')}. +${healBase} LP.`;
  }
  // offensive abilities
  if(ability.kind==='creature'){
    const cInfo = state.activeId!=null ? state.collection[state.activeId] : null;
    if(!cInfo || cInfo.penned || cInfo.currentHp<=0){
      return `${p.name} ruft nach der Kreatur, aber niemand antwortet.`;
    }
    const csp = SPECIES[state.activeId];
    const targetEnemy = (forcedTargetIdx!=null && encounter.enemies[forcedTargetIdx] && encounter.enemies[forcedTargetIdx].hp>0)
      ? encounter.enemies[forcedTargetIdx] : livingEnemies().sort((a,b)=>a.hp-b.hp)[0];
    if(!targetEnemy) return `${csp.name} findet kein Ziel mehr.`;
    const targetSp = SPECIES[targetEnemy.speciesId];
    const move = MOVES_BY_TYPE[csp.type][Math.floor(Math.random()*MOVES_BY_TYPE[csp.type].length)];
    const crit = rollCrit();
    let dmg = Math.max(1, Math.round(calcDmg(csp.stats.atk, targetSp.stats.def) * (ability.mult||1) * typeMultiplier(csp.type, targetSp.type)));
    if(crit) dmg = Math.round(dmg*1.6);
    targetEnemy.hp = clamp(targetEnemy.hp-dmg,0,targetEnemy.maxHp);
    const eTi = encounter.enemies.indexOf(targetEnemy);
    const epos = enemySpritePos(eTi);
    const pIdx0 = encounter.party ? encounter.party.indexOf(p) : -1;
    if(pIdx0>=0) animAttack('party', pIdx0);
    spawnFloatingText(epos.x, epos.y, '-'+dmg, crit?'#ffd23f':'#efe6cd');
    sfxHit();
    setTimeout(()=>{ if(!encounter) return; animHit('enemy', eTi, crit); spawnImpact(epos.x, epos.y, crit?'#ffd23f':'#ffb36b', crit?18:10); }, 150);
    return `${p.name} befiehlt ${csp.name} anzugreifen! ${csp.name} setzt ${move.name} ein — trifft ${targetSp.name} für ${dmg}${crit?' 💥':''} Schaden.`;
  }
  let targets = [];
  if(forcedTargetIdx!=null && ability.kind!=='aoe' && ability.kind!=='multi'){
    const t = encounter.enemies[forcedTargetIdx];
    if(t && t.hp>0) targets = [t];
  }
  if(targets.length===0){
    if(ability.kind==='aoe') targets = livingEnemies();
    else if(ability.kind==='multi') targets = livingEnemies().sort(()=>Math.random()-0.5).slice(0, ability.targets||2);
    else targets = [livingEnemies().sort((a,b)=>a.hp-b.hp)[0]].filter(Boolean);
  }
  if(targets.length===0) return `${p.name} findet kein Ziel mehr.`;
  const lineParts = [];
  const pIdxA = encounter.party ? encounter.party.indexOf(p) : -1;
  if(pIdxA>=0) animAttack('party', pIdxA);
  targets.forEach(targetEnemy=>{
    const targetSp = SPECIES[targetEnemy.speciesId];
    const crit = ability.guaranteedCrit || rollCrit();
    let dmg = Math.max(1, Math.round(calcDmg(p.atk, targetSp.stats.def) * (ability.mult||1)));
    if(crit) dmg = Math.round(dmg*1.6);
    targetEnemy.hp = clamp(targetEnemy.hp-dmg,0,targetEnemy.maxHp);
    const eTiA = encounter.enemies.indexOf(targetEnemy);
    const epos = enemySpritePos(eTiA);
    spawnFloatingText(epos.x, epos.y, '-'+dmg, crit?'#ffd23f':'#efe6cd');
    setTimeout(()=>{ if(!encounter) return; animHit('enemy', eTiA, crit); spawnImpact(epos.x, epos.y, crit?'#ffd23f':'#ffb36b', crit?18:10); }, 150);
    lineParts.push(`${targetSp.name} (${dmg}${crit?' 💥':''})`);
    if(ability.lifesteal){ p.hp = clamp(p.hp+Math.round(dmg*ability.lifesteal),0,p.maxHp); }
  });
  sfxHit();
  if(c) gainXp(c, 2);
  return `${p.name} (${p.cls}) wirkt ${ability.name}! Trifft ${lineParts.join(', ')}.`;
}
function doPartyRound(){
  if(!encounter || !encounter.party || encounter.party.length===0) return;
  let lines = [];
  const living = encounter.party.filter(p=>p.hp>0).sort((a,b)=>b.spd-a.spd);
  living.forEach(p=>{
    if(allEnemiesDead()) return;
    const ability = bestAbilityFor(p, livingEnemies().length);
    if(!ability){ lines.push(`${p.name} zögert — noch keine Klasse gewählt.`); return; }
    lines.push(executeAbility(p, ability, null));
  });
  redrawEncounterSprites(); refreshEncounterBars();
  if(allEnemiesDead()){ afterVictoryParty(lines); return; }
  const retaliation = wildAttacksParty();
  if(retaliation) lines.push(retaliation);
  finishPartyRound(lines);
}
function doPlayerAbility(ability, targetIdx){
  if(!encounter || !encounter.party) return;
  const playerP = encounter.party.find(p=>p.id==='__player__');
  if(!playerP || playerP.hp<=0) return;
  const line = executeAbility(playerP, ability, targetIdx);
  continuePartyTurnQueue([line]);
}
function doPartyItemBerry(){
  if(!encounter || !encounter.party || state.inventory.berries<=0) return;
  const living = encounter.party.filter(p=>p.hp>0);
  if(living.length===0) return;
  const target = living.sort((a,b)=>(a.hp/a.maxHp)-(b.hp/b.maxHp))[0];
  state.inventory.berries -= 1; bumpResource('berries'); sfxEat();
  const heal = Math.round(target.maxHp*0.4);
  target.hp = clamp(target.hp+heal, 0, target.maxHp);
  const bpos = partySpritePos(encounter.party.indexOf(target));
  spawnFloatingText(bpos.x, bpos.y, '+'+heal, '#8fc93a');
  continuePartyTurnQueue([target.id==='__player__' ? `Du isst eine Beere. +${heal} LP.` : `Du gibst ${target.name} eine Beere. +${heal} LP.`]);
}
function doPartyItemPotion(){
  if(!encounter || !encounter.party) return;
  if((state.inventory.potion||0)<=0){ abortItemAction('🧪 Keine Heiltränke mehr.'); return; }
  const living = encounter.party.filter(p=>p.hp>0);
  if(living.length===0){ abortItemAction(); return; }
  const target = living.sort((a,b)=>(a.hp/a.maxHp)-(b.hp/b.maxHp))[0];
  state.inventory.potion -= 1; sfxEat();
  const heal = Math.round(target.maxHp*0.75);
  target.hp = clamp(target.hp+heal, 0, target.maxHp);
  const ppos = partySpritePos(encounter.party.indexOf(target));
  spawnFloatingText(ppos.x, ppos.y, '+'+heal, '#8fc93a');
  continuePartyTurnQueue([target.id==='__player__' ? `Du trinkst einen Heiltrank. +${heal} LP.` : `Du gibst ${target.name} einen Heiltrank. +${heal} LP.`]);
}
function doPartyFlee(){
  if(!encounter) return;
  const success = Math.random() < (hasTech('expedition') ? 0.9 : 0.8);
  if(success){ sfxFleeSuccess(); toast('Deine Party ist erfolgreich geflohen!'); endEncounter(); return; }
  sfxFleeFail();
  continuePartyTurnQueue(['Die Flucht ist fehlgeschlagen!']);
}

/* ============================================================
   Verdrahtung des Kampfmenüs und Zeitgeber
   Wird von main.js aufgerufen, sobald die Seite steht.
============================================================ */
function initBattleUI(){
  setInterval(()=>{
    if(paused || !state.raid) return;
    const raiders = homeCtx.wildMonsters.filter(w=>w.raid && w.hp>0);
    if(raiders.length===0) return;
    const guards = allDefenders();
    guards.forEach(c=>{
      let nearest=null, nd=Infinity;
      raiders.forEach(w=>{ const d=Math.hypot(c.x-w.x,c.y-w.y); if(d<nd){ nd=d; nearest=w; } });
      if(!nearest) return;
      // Wer stärker auf Fernkampf gestellt ist, hält Abstand und schießt
      const mW = combatWeight(c,'melee'), rW = combatWeight(c,'ranged');
      const prefersRanged = rW > mW;
      const RANGE = 5.5, KEEP_DIST = 3;
      const inMelee = nd <= 1.6;
      const inShot  = prefersRanged && nd <= RANGE;
      const killed = (dmg, ranged)=>{
        nearest.hp = Math.max(0, nearest.hp-dmg);
        if(ranged) sfxMiss(); else sfxHit();
        c.facing = nearest.x>c.x?'right':(nearest.x<c.x?'left':(nearest.y>c.y?'down':'up'));
        c.combatFx = { ranged:!!ranged, until: Date.now()+400,
                       tx:nearest.x, ty:nearest.y, fx:c.x, fy:c.y };
        if(nearest.hp<=0){
          homeCtx.wildMonsters = homeCtx.wildMonsters.filter(w=>w!==nearest);
          if(atHome()) wildMonsters = homeCtx.wildMonsters;
          gainXp(c, ranged?5:6);
          toast((ranged?'🏹 ':'⚔️ ')+c.name+' hat einen Angreifer besiegt!');
          logEvent((ranged?'🏹 ':'⚔️ ')+c.name+' hat einen Angreifer abgewehrt.');
          if(!homeCtx.wildMonsters.some(w=>w.raid)) resolveRaidSuccess();
        }
      };
      if(inMelee && !prefersRanged){
        killed(3 + Math.round(c.skills.Nahkampf*0.5), false);
      } else if(inShot){
        // Fernkampf: etwas weniger Schaden, dafür ohne Gegenwehr auf Distanz
        killed(2 + Math.round(c.skills.Nahkampf*0.4), true);
        // zu nah? einen Schritt zurückweichen
        if(nd < KEEP_DIST){
          const bx = c.x - Math.sign(nearest.x-c.x), by = c.y - Math.sign(nearest.y-c.y);
          if(passable(bx,by,homeCtx) && !homeCtx.wildMonsters.some(w=>w.x===bx&&w.y===by)){ c.x=bx; c.y=by; }
        }
      } else if(inMelee){
        // Fernkämpfer im Nahkampf: wehrt sich schwächer
        killed(2 + Math.round(c.skills.Nahkampf*0.3), false);
      } else {
        const dx = Math.sign(nearest.x-c.x), dy = Math.sign(nearest.y-c.y);
        let nx=c.x, ny=c.y;
        if(Math.abs(nearest.x-c.x) >= Math.abs(nearest.y-c.y) && dx!==0) nx=c.x+dx;
        else if(dy!==0) ny=c.y+dy;
        if(passable(nx,ny,homeCtx) && !homeCtx.wildMonsters.some(w=>w.x===nx&&w.y===ny)){
          c.x=nx; c.y=ny; c.facing = dx>0?'right':(dx<0?'left':(dy>0?'down':'up'));
        }
      }
    });
  }, 1100);
  document.getElementById('btnMenuFight').onclick = onBattleFightClick;
  document.getElementById('btnMenuPartyRound').onclick = ()=>doPartyRound();
  document.getElementById('btnMenuItem').onclick = showItemMenu;
  document.getElementById('btnMenuDefend').onclick = ()=>doDefendRound();
  document.getElementById('btnMenuFlee').onclick = ()=>{ if(encounter && encounter.party){ doPartyFlee(); } else { doFlee(); } };
  if(autoBtn) autoBtn.onclick = onAutoBattleClick;
}

export {
  effectiveSpd,
  slowFactor,
  initBattleUI,
  BOSS_CATCH_HP_THRESHOLD,
  STATUS_DEFS,
  TYPE_STATUS,
  abortItemAction,
  activeAllyRef,
  advanceTurnQueue,
  afterFaint,
  afterPartyWipe,
  afterVictory,
  afterVictoryParty,
  allEnemiesDead,
  allyTurnDone,
  animAttack,
  animHit,
  applyStatus,
  autoBattleOn,
  autoBattleStep,
  autoBattleTimer,
  autoBtn,
  autoPickAction,
  battleAnimRunning,
  battleAnimTick,
  battleAnims,
  battleFxFor,
  battleParticles,
  battleShadow,
  bindBattleMenuButtons,
  buildPartySnapshot,
  calcDmg,
  challengeLevelMult,
  checkEvolution,
  companionSpritePos,
  computeMoveResult,
  continuePartyTurnQueue,
  doDefendRound,
  doFlee,
  doItemBerry,
  doItemPotion,
  doItemTrap,
  doMoveRound,
  doPartyFlee,
  doPartyItemBerry,
  doPartyItemPotion,
  doPartyRound,
  doPlayerAbility,
  drawBattleBackdrop,
  drawBattleLabel,
  drawBattleParticles,
  drawBattleScene,
  drawFloatingTexts,
  drawInitiativeBar,
  drawSceneDecor,
  drawStatusIcons,
  encounter,
  endEncounter,
  enemySingleAttack,
  enemySpritePos,
  engageWildMonster,
  ensureBattleAnimLoop,
  ensurePlayerMonHp,
  executeAbility,
  executeTrapThrow,
  finishPartyRound,
  finishRound,
  floatingTexts,
  generateSceneDecor,
  hasStatus,
  livingEnemies,
  onAutoBattleClick,
  onBattleFightClick,
  partyClassColor,
  partySpritePos,
  playerAttacks,
  playerGearBonus,
  playerMenuHTML,
  redrawEncounterSprites,
  refreshEncounterBars,
  regionDangerLevel,
  regionDangerMult,
  renderItemQuickBar,
  renderPartyStatusBar,
  resolveRaidSuccess,
  rollCombatLoot,
  rollCrit,
  rollMeatDrop,
  rollStatusFromType,
  showAllyAbilityMenu,
  showAllyMenu,
  showAllyTargetMenu,
  showCatchTargetMenu,
  showItemMenu,
  showMainMenu,
  showMoveMenu,
  showPartySkillMenu,
  showPartyTargetMenu,
  showTargetMenu,
  spawnFloatingText,
  spawnImpact,
  startEncounter,
  startPartyTurnRound,
  stopAutoBattle,
  tickStatuses,
  turnQueue,
  turnQueueIdx,
  turnRoundLines,
  updateAutoBattleButton,
  wildAttacks,
  wildAttacksParty
};
