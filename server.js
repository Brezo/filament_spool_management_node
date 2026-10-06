import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = path.resolve(ROOT, process.env.DATABASE_PATH || 'filament.db');
const isProduction = process.env.NODE_ENV === 'production';
const app = express();

export const CAPACITY = { boards: 2, across: 8, stacked: 1, deep: 2 };
export const db = new Database(DB_PATH, { timeout: 10_000 });
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    next_value INTEGER NOT NULL CHECK (next_value > 0)
  );
  INSERT OR IGNORE INTO counters (name, next_value) VALUES ('spool', 1);
  CREATE TABLE IF NOT EXISTS spools (
    inventory_id TEXT PRIMARY KEY,
    brand TEXT NOT NULL CHECK (length(trim(brand)) > 0),
    material TEXT NOT NULL CHECK (length(trim(material)) > 0),
    color_name TEXT NOT NULL CHECK (length(trim(color_name)) > 0),
    color_hex TEXT CHECK (color_hex IS NULL OR (length(color_hex) = 6 AND color_hex NOT GLOB '*[^0-9A-F]*')),
    status TEXT NOT NULL CHECK (status IN ('unassigned', 'stored', 'in_use', 'archived')),
    board INTEGER,
    across INTEGER,
    stacked INTEGER,
    deep INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    CHECK (
      (status = 'stored'
        AND board BETWEEN 1 AND 2 AND across BETWEEN 1 AND 8
        AND stacked BETWEEN 1 AND 1 AND deep BETWEEN 1 AND 2)
      OR
      (status != 'stored' AND board IS NULL AND across IS NULL AND stacked IS NULL AND deep IS NULL)
    )
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_spool_per_cell
    ON spools (board, across, stacked, deep) WHERE status = 'stored';
  CREATE INDEX IF NOT EXISTS spools_status ON spools (status);
`);

function spoolFromRow(row) {
  if (!row) return null;
  return {
    inventoryId: row.inventory_id,
    brand: row.brand,
    material: row.material,
    colorName: row.color_name,
    colorHex: row.color_hex,
    status: row.status,
    location: row.status === 'stored'
      ? { board: row.board, across: row.across, stacked: row.stacked, deep: row.deep }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getSpool(id) {
  return spoolFromRow(db.prepare('SELECT * FROM spools WHERE inventory_id = ?').get(id));
}

function normalizeId(value) {
  const id = String(value || '').trim().toUpperCase();
  if (!/^S\d{4,}$/.test(id)) throw new ApiError(400, 'Die Inventarnummer muss dem Format S0001 entsprechen.');
  return id;
}

function normalizeMetadata({ brand, material, colorName, colorHex }) {
  const result = [brand, material, colorName].map(value => String(value || '').trim());
  if (result.some(value => !value)) {
    throw new ApiError(400, 'Hersteller, Material und Farbbezeichnung sind Pflichtfelder.');
  }
  const hex = String(colorHex || '').trim().replace(/^#/, '').toUpperCase() || null;
  if (hex && !/^[0-9A-F]{6}$/.test(hex)) {
    throw new ApiError(400, 'Der Farbcode muss aus genau sechs Hex-Zeichen bestehen.');
  }
  return { brand: result[0], material: result[1], colorName: result[2], colorHex: hex };
}

function normalizeLocation(value) {
  const location = {
    board: Number(value?.board),
    across: Number(value?.across),
    stacked: Number(value?.stacked),
    deep: Number(value?.deep),
  };
  if (
    !Number.isInteger(location.board) || location.board < 1 || location.board > CAPACITY.boards ||
    !Number.isInteger(location.across) || location.across < 1 || location.across > CAPACITY.across ||
    location.stacked !== 1 ||
    !Number.isInteger(location.deep) || location.deep < 1 || location.deep > CAPACITY.deep
  ) throw new ApiError(400, 'Ungültige Regalposition.');
  return location;
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

app.use(express.json());

app.get('/api/config', (_request, response) => response.json(CAPACITY));

app.get('/api/spools', (request, response) => {
  const archived = request.query.archived === 'true';
  const clauses = [archived ? "status = 'archived'" : "status != 'archived'"];
  const values = [];
  if (String(request.query.query || '').trim()) {
    clauses.push('(inventory_id LIKE ? COLLATE NOCASE OR brand LIKE ? COLLATE NOCASE OR material LIKE ? COLLATE NOCASE OR color_name LIKE ? COLLATE NOCASE)');
    const pattern = `%${String(request.query.query).trim()}%`;
    values.push(pattern, pattern, pattern, pattern);
  }
  if (request.query.status) {
    clauses.push('status = ?');
    values.push(request.query.status);
  }
  for (const field of ['board', 'deep']) {
    if (request.query[field]) {
      clauses.push(`${field} = ?`);
      values.push(Number(request.query[field]));
    }
  }
  const rows = db.prepare(`SELECT * FROM spools WHERE ${clauses.join(' AND ')} ORDER BY inventory_id`).all(...values);
  response.json(rows.map(spoolFromRow));
});

app.get('/api/spools/:id', (request, response) => {
  const spool = getSpool(normalizeId(request.params.id));
  if (!spool) throw new ApiError(404, 'Zu dieser Inventarnummer existiert keine Spule.');
  response.json(spool);
});

app.get('/api/suggestions', (_request, response) => {
  const distinct = field => db.prepare(`SELECT DISTINCT ${field} AS value FROM spools ORDER BY ${field} COLLATE NOCASE`).all().map(row => row.value);
  response.json({ brands: distinct('brand'), materials: distinct('material') });
});

const createSpool = db.transaction(data => {
  const number = db.prepare("SELECT next_value FROM counters WHERE name = 'spool'").pluck().get();
  const inventoryId = `S${String(number).padStart(4, '0')}`;
  db.prepare("UPDATE counters SET next_value = next_value + 1 WHERE name = 'spool'").run();
  db.prepare('INSERT INTO spools (inventory_id, brand, material, color_name, color_hex, status) VALUES (?, ?, ?, ?, ?, ?)').run(
    inventoryId, data.brand, data.material, data.colorName, data.colorHex, 'unassigned',
  );
  return getSpool(inventoryId);
});

app.post('/api/spools', (request, response) => {
  response.status(201).json(createSpool(normalizeMetadata(request.body)));
});

app.patch('/api/spools/:id/status', (request, response) => {
  const id = normalizeId(request.params.id);
  const status = request.body.status;
  if (!['unassigned', 'in_use', 'archived'].includes(status)) {
    throw new ApiError(400, 'Ungültiger Zustand.');
  }
  const result = db.prepare(`
    UPDATE spools SET status = ?, board = NULL, across = NULL, stacked = NULL, deep = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE inventory_id = ?
  `).run(status, id);
  if (!result.changes) throw new ApiError(404, 'Spule nicht gefunden.');
  response.json(getSpool(id));
});

const moveSpool = db.transaction((id, location, replaceOccupied) => {
  const source = getSpool(id);
  if (!source) throw new ApiError(404, 'Spule nicht gefunden.');
  if (source.status === 'archived') throw new ApiError(409, 'Archivierte Spulen müssen zuerst wiederhergestellt werden.');
  const row = db.prepare("SELECT * FROM spools WHERE status = 'stored' AND board = ? AND across = ? AND stacked = ? AND deep = ?")
    .get(location.board, location.across, location.stacked, location.deep);
  const occupant = spoolFromRow(row);
  if (occupant?.inventoryId === id) return { spool: source, displaced: null };
  if (occupant && !replaceOccupied) {
    throw new ApiError(409, `Die Position ist durch ${occupant.inventoryId} belegt.`);
  }
  if (occupant) {
    db.prepare("UPDATE spools SET status = 'unassigned', board = NULL, across = NULL, stacked = NULL, deep = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE inventory_id = ?").run(id);
    if (source.location) {
      const old = source.location;
      db.prepare("UPDATE spools SET board = ?, across = ?, stacked = ?, deep = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE inventory_id = ?")
        .run(old.board, old.across, old.stacked, old.deep, occupant.inventoryId);
    } else {
      db.prepare("UPDATE spools SET status = 'in_use', board = NULL, across = NULL, stacked = NULL, deep = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE inventory_id = ?")
        .run(occupant.inventoryId);
    }
  }
  db.prepare("UPDATE spools SET status = 'stored', board = ?, across = ?, stacked = ?, deep = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE inventory_id = ?")
    .run(location.board, location.across, location.stacked, location.deep, id);
  return { spool: getSpool(id), displaced: occupant ? getSpool(occupant.inventoryId) : null };
});

app.post('/api/spools/:id/move', (request, response) => {
  response.json(moveSpool(
    normalizeId(request.params.id),
    normalizeLocation(request.body.location),
    request.body.replaceOccupied === true,
  ));
});

app.get('/api/spools/:id/qr.svg', async (request, response) => {
  const id = normalizeId(request.params.id);
  if (!getSpool(id)) throw new ApiError(404, 'Spule nicht gefunden.');
  response.type('image/svg+xml').send(await QRCode.toString(id, { type: 'svg', errorCorrectionLevel: 'H', margin: 2 }));
});

app.use((error, _request, response, _next) => {
  console.error(error);
  const known = error instanceof ApiError;
  const conflict = error?.code?.startsWith('SQLITE_CONSTRAINT');
  response.status(known ? error.status : conflict ? 409 : 500).json({
    error: known ? error.message : conflict ? 'Die Regalbelegung wurde zwischenzeitlich geändert.' : 'Ein unerwarteter Fehler ist aufgetreten.',
  });
});

if (!isProduction) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(ROOT, 'dist')));
  app.get('*path', (_request, response) => response.sendFile(path.join(ROOT, 'dist', 'index.html')));
}

if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, '0.0.0.0', () => console.log(`Filamentregal läuft auf http://localhost:${PORT}`));

  const shutdown = () => {
    server.close(() => {
      try {
        db.close();
      } catch {}
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default app;
