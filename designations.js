/* ============================================================
   engine/designations.js — Flächenmarkierungen

   Der Spieler zieht mit der Maus ein Rechteck und markiert darin Kacheln
   für eine Aktion: abbauen (mine), fällen (chop) oder ernten (harvest).
   Kolonisten suchen sich daraus ihre Arbeit.

   Speicherung als Map "x,y" -> { art, regionId }. Damit ist die Frage
   "ist diese Kachel markiert?" ein Nachschlagen in konstanter Zeit —
   wichtig, weil die Arbeitssuche sie pro Kolonist und Tick stellt. Eine
   Liste hätte bei tausenden Markierungen jedes Mal durchsucht werden
   müssen.

   Zusätzlich hält ARTEN je Aktion die passenden Objektarten, sodass eine
   Markierung nur dort greift, wo sie sinnvoll ist.
   ============================================================ */

const DESIGNATION_ARTEN = {
  mine:    { label: 'Abbauen',  icon: '⛏️', farbe: '#c9a227',
             objekte: ['rock','orevein','mountain'] },
  chop:    { label: 'Fällen',   icon: '🪓', farbe: '#d9812d',
             objekte: ['tree'] },
  harvest: { label: 'Ernten',   icon: '🌿', farbe: '#7fc45a',
             objekte: ['bush','fiberbush','wildgemuese'] },
};

/* Schlüssel -> { art, regionId }. Bewusst eine Map und kein Array. */
const designations = new Map();

function desKey(x, y){ return x + ',' + y; }

/* Passt diese Aktion zu dem, was auf der Kachel steht? Ohne passendes
   Objekt wäre die Markierung eine Arbeitsanweisung ins Leere. */
function passtZurKachel(art, x, y){
  const def = DESIGNATION_ARTEN[art];
  if(!def) return false;
  const o = objAt(x, y);
  return !!(o && def.objekte.includes(o.type));
}

function setDesignation(x, y, art, regionId){
  if(!DESIGNATION_ARTEN[art]) return false;
  if(!passtZurKachel(art, x, y)) return false;
  designations.set(desKey(x, y), { art, regionId: regionId || 'C' });
  return true;
}

function clearDesignation(x, y){
  return designations.delete(desKey(x, y));
}

/* Abfrage für die Arbeitssuche — konstante Zeit. */
function designationAt(x, y, regionId){
  const d = designations.get(desKey(x, y));
  if(!d) return null;
  if(regionId && d.regionId !== regionId) return null;
  return d;
}
function hasDesignation(x, y, regionId){
  return designationAt(x, y, regionId) !== null;
}

/* Alle Markierungen einer Art, nach Entfernung zu einem Punkt sortiert.
   Die Arbeitssuche nimmt sich davon den nächsten freien Eintrag. */
function designationsOfKind(art, regionId, vonX, vonY){
  const treffer = [];
  designations.forEach((d, key)=>{
    if(d.art !== art) return;
    if(regionId && d.regionId !== regionId) return;
    const p = key.split(',');
    treffer.push({ x: +p[0], y: +p[1], art: d.art });
  });
  if(vonX != null){
    treffer.sort((a,b)=>
      Math.hypot(a.x-vonX, a.y-vonY) - Math.hypot(b.x-vonX, b.y-vonY));
  }
  return treffer;
}

/* Rechteck markieren. Gibt zurück, wie viele Kacheln tatsächlich
   übernommen wurden — Kacheln ohne passendes Objekt werden übersprungen. */
function designateArea(x0, y0, x1, y1, art, regionId){
  const [ax, bx] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const [ay, by] = y0 <= y1 ? [y0, y1] : [y1, y0];
  let gesetzt = 0;
  for(let y = ay; y <= by; y++){
    for(let x = ax; x <= bx; x++){
      if(setDesignation(x, y, art, regionId)) gesetzt++;
    }
  }
  return gesetzt;
}

/* Abbruch-Modus: Rechteck wieder freiräumen, unabhängig von der Art. */
function clearArea(x0, y0, x1, y1){
  const [ax, bx] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const [ay, by] = y0 <= y1 ? [y0, y1] : [y1, y0];
  let entfernt = 0;
  for(let y = ay; y <= by; y++){
    for(let x = ax; x <= bx; x++){
      if(clearDesignation(x, y)) entfernt++;
    }
  }
  return entfernt;
}

/* Markierungen, deren Objekt verschwunden ist, aufräumen. Wird nach
   getaner Arbeit gerufen, damit die Karte nicht mit Leichen zuwächst. */
function pruneDesignations(){
  let weg = 0;
  [...designations.keys()].forEach(key=>{
    const p = key.split(',');
    const d = designations.get(key);
    if(!passtZurKachel(d.art, +p[0], +p[1])){ designations.delete(key); weg++; }
  });
  return weg;
}

function designationCount(){ return designations.size; }
function clearAllDesignations(){ designations.clear(); }

/* Speichern und Laden: die Map als schlichtes Array von Tripeln. */
function serializeDesignations(){
  const out = [];
  designations.forEach((d, key)=>{
    const p = key.split(',');
    out.push([+p[0], +p[1], d.art, d.regionId]);
  });
  return out;
}
function loadDesignations(daten){
  designations.clear();
  (daten || []).forEach(([x, y, art, reg])=>{
    if(DESIGNATION_ARTEN[art]) designations.set(desKey(x, y), { art, regionId: reg || 'C' });
  });
}

export {
  DESIGNATION_ARTEN,
  designations,
  designateArea,
  clearArea,
  setDesignation,
  clearDesignation,
  designationAt,
  hasDesignation,
  designationsOfKind,
  pruneDesignations,
  designationCount,
  clearAllDesignations,
  serializeDesignations,
  loadDesignations,
};
