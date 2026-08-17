# Farholt — modulare Struktur

Ein Kolonie-Aufbauspiel mit Kreaturenzucht und Erkundung. Sämtliche
Grafik und Klänge werden zur Laufzeit erzeugt — keine Bild- oder
Audiodateien.

## Start

ES-Module lassen sich **nicht** per Doppelklick öffnen; Browser
blockieren das über `file://`. Es braucht einen lokalen Server:

    python3 -m http.server 8000

Dann `http://localhost:8000/` aufrufen.

## Aufbau

| Datei | Zeilen | Inhalt |
|---|---|---|
| `index.html` | 1053 | Seitengerüst und Gestaltung |
| `main.js` | 1701 | Spielzustand, Hauptschleife, Startreihenfolge |
| `engine/rng.js` | 34 | Deterministische Zufallshelfer |
| `engine/audio.js` | 351 | 25 Klangeffekte, 3 Musikstücke |
| `engine/world.js` | 866 | Gelände, Küsten, Regionen, Dungeons, Dörfer |
| `engine/renderer.js` | 2583 | Kacheln, Sprites, Gebäude, Figuren |
| `data/species.js` | 671 | 108 Kreaturenformen über drei Stufen |
| `entities/colonist.js` | 1450 | Erzeugung, Prioritäten, Wegfindung, Freizeit |
| `ui/panels.js` | 2210 | Fenster, Kolonie, Feldbuch, Innenansichten |
| `ui/battle.js` | 1960 | Kampfmenü, Animationen, Statuseffekte |
| `ui/worldmap.js` | 968 | Makro-Karte, Kontinente, Randübergänge |
| `ui/screens.js` | 863 | Titelbild, Intro, Charaktererstellung |
| `ui/input.js` | 655 | Maus, Tastatur, Kolonistenauswahl |

## Startreihenfolge

Die Module enthalten keine Anweisungen mehr, die schon beim Laden
ausgeführt werden. Stattdessen ruft `main.js` der Reihe nach auf:

    initWorld()             Heimatregion erzeugen
    buildRecipeList()       Bauliste aus den Gebäudedaten
    applyRecipeDescriptions()
    initPlayerAppearance()  Aussehen würfeln
    initInput()             Maus, Tastatur, Werkzeugleiste
    initPanelHandlers()     Fenster-Knöpfe, Overlay-Register
    initScreens()           Titelbild, Intro
    initBattleUI()          Kampfmenü
    initPanels()            Anzeige aktualisieren
    seedWildMonsters()      Erstbesetzung mit Wildtieren
    initScreenTimers()      Ereignisse, Wetter
    initWorldMapTimers()    Weltkarte
    startColonistLoops()    Arbeits-KI, Bewegung, Bedürfnisse
    startGameLoops()        Minikarte, Uhr, Speichern, Wetter

Diese Reihenfolge ist nicht beliebig: Die Welt muss vor der Oberfläche
stehen, die Oberfläche vor den Zeitgebern.

## Geprüft

- Alle 12 Module laden fehlerfrei
- 61 von 61 Knopf-Verdrahtungen erhalten
- 19 Zeitgeber, 22 Ereignis-Listener, 510 Funktionen vollständig

Der vollständige Startvorgang wurde simuliert und läuft durch. Danach
liegen vor: 100x70-Weltraster mit rund 1500 Objekten, 61 Gebäudetypen,
62 Baurezepte, 108 Kreaturenformen, 9 Regionen und 10 Wildtiere.

Vier Dinge waren dabei zu beheben:

- `main.js` stellte nur die importierten Module global bereit, nicht die
  eigenen Daten. Gebäudetypen und Spielzustand fehlten dadurch.
- `initWorld()` lief vor dem Aufbau des Regionskontexts, obwohl dieser
  auf das erst dort gefüllte Raster zugreift.
- Die Zeitgeber starteten, bevor die Welt stand.
- Vier Funktionen waren nicht exportiert, obwohl andere Module sie
  brauchen.

Die Einzeldatei-Fassung `wildwood.html` läuft unverändert als Rückfall.
