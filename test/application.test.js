import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let processHandle;
let temporaryDirectory;
let baseUrl;

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  return { response, body };
}

async function json(route, options = {}) {
  const result = await request(route, options);
  assert.ok(result.response.ok, `${result.response.status}: ${JSON.stringify(result.body)}`);
  return result.body;
}

function post(body) {
  return { method: 'POST', body: JSON.stringify(body) };
}

async function createSpool(colorName = 'Schwarz', overrides = {}) {
  return json('/api/spools', post({
    brand: 'Prusament',
    material: 'PLA',
    colorName,
    colorHex: '2d2d2d',
    ...overrides,
  }));
}

async function move(inventoryId, location, replaceOccupied = false) {
  return json(`/api/spools/${inventoryId}/move`, post({ location, replaceOccupied }));
}

async function setStatus(inventoryId, status) {
  return json(`/api/spools/${inventoryId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

const position = (board, across, deep) => ({ board, across, stacked: 1, deep });

test.before(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'filamentregal-node-test-'));
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  processHandle = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_PATH: path.join(temporaryDirectory, 'test.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  processHandle.stdout.on('data', chunk => { output += chunk; });
  processHandle.stderr.on('data', chunk => { output += chunk; });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`Server wurde vorzeitig beendet:\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/config`);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Serverstart hat zu lange gedauert:\n${output}`);
});

test.after(async () => {
  if (processHandle?.exitCode === null) {
    processHandle.kill('SIGTERM');
    await once(processHandle, 'exit');
  }
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

test('serves the React application and reports all 32 shelf cells', async () => {
  const config = await json('/api/config');
  assert.deepEqual(config, { boards: 2, across: 8, stacked: 1, deep: 2 });
  assert.equal(config.boards * config.across * config.stacked * config.deep, 32);

  const { response, body } = await request('/');
  assert.equal(response.status, 200);
  assert.match(body, /<div id="root"><\/div>/);

  const nested = await request('/spool/S9999');
  assert.equal(nested.response.status, 200);
  assert.match(nested.body, /<div id="root"><\/div>/);
});

test('validates required metadata and hexadecimal colors', async () => {
  for (const body of [
    { brand: '', material: 'PLA', colorName: 'Rot' },
    { brand: 'Marke', material: '', colorName: 'Rot' },
    { brand: 'Marke', material: 'PLA', colorName: '' },
    { brand: 'Marke', material: 'PLA', colorName: 'Rot', colorHex: '12345' },
    { brand: 'Marke', material: 'PLA', colorName: 'Rot', colorHex: 'GG0000' },
  ]) {
    const result = await request('/api/spools', post(body));
    assert.equal(result.response.status, 400);
    assert.ok(result.body.error);
  }
});

test('creates monotonic inventory IDs and normalizes metadata', async () => {
  const first = await createSpool();
  const second = await createSpool('Weiß');
  assert.equal(first.inventoryId, 'S0001');
  assert.equal(second.inventoryId, 'S0002');
  assert.equal(first.colorHex, '2D2D2D');
  assert.equal(first.status, 'unassigned');
  assert.equal(first.location, null);

  const suggestions = await json('/api/suggestions');
  assert.deepEqual(suggestions.brands, ['Prusament']);
  assert.deepEqual(suggestions.materials, ['PLA']);
});

test('rejects malformed inventory IDs and unknown spools', async () => {
  for (const id of ['PLA-001', 'S1', '0001']) {
    const result = await request(`/api/spools/${id}`);
    assert.equal(result.response.status, 400);
  }
  const missing = await request('/api/spools/S9999');
  assert.equal(missing.response.status, 404);
});

test('moves a spool and supports the complete status lifecycle', async () => {
  const spool = await createSpool('Lebenszyklus');
  const location = position(1, 2, 2);
  const moved = await move(spool.inventoryId, location);
  assert.deepEqual(moved.spool.location, location);
  assert.equal(moved.spool.status, 'stored');
  assert.equal(moved.displaced, null);

  const inUse = await setStatus(spool.inventoryId, 'in_use');
  assert.equal(inUse.status, 'in_use');
  assert.equal(inUse.location, null);

  assert.equal((await setStatus(spool.inventoryId, 'archived')).status, 'archived');
  assert.equal((await setStatus(spool.inventoryId, 'unassigned')).status, 'unassigned');
});

test('swaps positions of two stored spools', async () => {
  const first = await createSpool('Tausch A');
  const second = await createSpool('Tausch B');
  const firstLocation = position(1, 1, 1);
  const secondLocation = position(2, 8, 2);
  await move(first.inventoryId, firstLocation);
  await move(second.inventoryId, secondLocation);

  const result = await move(first.inventoryId, secondLocation, true);
  assert.deepEqual(result.spool.location, secondLocation);
  assert.equal(result.displaced.inventoryId, second.inventoryId);
  assert.deepEqual(result.displaced.location, firstLocation);
});

test('requires confirmation for occupied cells and then displaces to in-use', async () => {
  const incoming = await createSpool('Eingehend');
  const occupant = await createSpool('Belegt');
  const location = position(1, 4, 2);
  await move(occupant.inventoryId, location);

  const conflict = await request(`/api/spools/${incoming.inventoryId}/move`, post({ location }));
  assert.equal(conflict.response.status, 409);
  assert.match(conflict.body.error, new RegExp(occupant.inventoryId));

  const unchanged = await json(`/api/spools/${incoming.inventoryId}`);
  assert.equal(unchanged.status, 'unassigned');

  const result = await move(incoming.inventoryId, location, true);
  assert.deepEqual(result.spool.location, location);
  assert.equal(result.displaced.status, 'in_use');
  assert.equal(result.displaced.location, null);
});

test('rejects invalid positions and storing archived spools', async () => {
  const spool = await createSpool('Grenzen');
  for (const location of [
    position(0, 1, 1),
    position(1, 9, 1),
    { board: 1, across: 1, stacked: 2, deep: 1 },
    position(1, 1, 3),
  ]) {
    const result = await request(`/api/spools/${spool.inventoryId}/move`, post({ location }));
    assert.equal(result.response.status, 400);
  }
  await setStatus(spool.inventoryId, 'archived');
  const archivedMove = await request(`/api/spools/${spool.inventoryId}/move`, post({ location: position(1, 1, 1) }));
  assert.equal(archivedMove.response.status, 409);
});

test('searches, filters, archives, and restores inventory', async () => {
  const pla = await createSpool('Galaxy Black');
  const petg = await createSpool('Orange', { brand: 'Polymaker', material: 'PETG', colorHex: null });
  await move(pla.inventoryId, position(2, 3, 1));
  await setStatus(petg.inventoryId, 'archived');

  const search = await json('/api/spools?query=galaxy');
  assert.ok(search.some(item => item.inventoryId === pla.inventoryId));
  assert.ok(search.every(item => item.status !== 'archived'));

  const positionFilter = await json('/api/spools?board=2&deep=1');
  assert.ok(positionFilter.some(item => item.inventoryId === pla.inventoryId));
  assert.ok(positionFilter.every(item => item.location.board === 2 && item.location.deep === 1));

  const archive = await json('/api/spools?archived=true');
  assert.ok(archive.some(item => item.inventoryId === petg.inventoryId));
  assert.ok(archive.every(item => item.status === 'archived'));

  const restored = await setStatus(petg.inventoryId, 'unassigned');
  assert.equal(restored.status, 'unassigned');
});

test('generates a standard SVG QR code containing the inventory ID', async () => {
  const result = await request('/api/spools/S0001/qr.svg');
  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(result.body, /<svg/);
  assert.match(result.body, /<path/);
});

test('ships the offline QR photo decoder', async () => {
  const result = await request('/static/html5-qrcode.min.js');
  assert.equal(result.response.status, 200);
  assert.ok(result.body.length > 100_000);
  assert.match(result.body, /Html5Qrcode/);

  const localFile = await readFile(path.join(ROOT, 'public/static/html5-qrcode.min.js'));
  assert.ok(localFile.length > 100_000);
});
