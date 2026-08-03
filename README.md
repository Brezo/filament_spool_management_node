# Filamentregal – React + Node.js

React-Neuimplementierung der NiceGUI-Anwendung. Der Express-Server stellt die
REST-API bereit und speichert die Daten mit SQLite. Das vorhandene
`filament.db`-Schema ist kompatibel.

## Entwicklung

Node.js 20 oder neuer wird benötigt.

```bash
npm install
npm run dev
```

Die Anwendung läuft anschließend unter `http://localhost:8080`. Im
Entwicklungsmodus integriert der Node-Server Vite direkt.

## Produktion

```bash
npm install
npm run build
npm start
```

## Tests

```bash
npm test
```

Der Testlauf erstellt zuerst den React-Produktions-Build und startet danach
einen echten Node-/Express-Server mit einer temporären SQLite-Datenbank. Er
prüft unter anderem Validierung, fortlaufende Inventarnummern, Suche und
Filter, den Zustandslebenszyklus, Einlagern, Tauschen, Verdrängen,
Regalgrenzen, Archiv und Wiederherstellung, QR-SVGs sowie den ausgelieferten
Offline-QR-Decoder. Die temporäre Datenbank wird anschließend gelöscht.

Konfiguration:

- `PORT`: HTTP-Port, Standard `8080`
- `DATABASE_PATH`: SQLite-Pfad, Standard `./filament.db`

Für eine externe Bereitstellung sollte `DATABASE_PATH` auf ein persistentes
Volume zeigen, beispielsweise `/data/filament.db`.

## Bestehende Daten übernehmen

Die NiceGUI-Anwendung beenden und dann die Datenbank kopieren:

```bash
cp ../filament.db ./filament.db
```

Eine aktive SQLite-WAL-Datenbank darf nicht nur über die Hauptdatei kopiert
werden.
