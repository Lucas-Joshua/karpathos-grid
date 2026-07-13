'use strict';
const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const https   = require('https');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── JSON "database" ─────────────────────────────────────────────────────
// All state lives in one JSON file. On Railway: mount a volume at /data and
// set DATA_DIR=/data so it survives deploys. Locally: ./data/ is used.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return null; }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Initialise DB on first run
let db = loadDB();
if (!db) {
  const pilotCode = process.env.PILOT_CODE || '1234';
  const atcCode   = process.env.ATC_CODE   || '5678';
  db = {
    nextId: 3,
    codes: [
      { id: 1, code: pilotCode, role: 'pilot', label: 'Default pilot code', active: true, created: new Date().toISOString() },
      { id: 2, code: atcCode,   role: 'atc',   label: 'Default ATC code',   active: true, created: new Date().toISOString() },
    ],
    lastLogins: { pilot: null, atc: null },
    flights: [],
    nextFlightId: 1,
  };
  saveDB(db);
  console.log(`[DB] Seeded — pilot: ${pilotCode}  atc: ${atcCode}`);
}

// ─── HMAC token helpers ───────────────────────────────────────────────────
const SECRET = process.env.JWT_SECRET || 'karpathos-uas-dev-secret-CHANGE-ME';

function signToken(payload) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyToken(token) {
  try {
    if (!token || !token.includes('.')) return null;
    const dot  = token.lastIndexOf('.');
    const b64  = token.slice(0, dot);
    const sig  = token.slice(dot + 1);
    const exp  = crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'base64url'), Buffer.from(exp, 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (!p.role || !p.codeId || !p.iat) return null;
    if (Date.now() - p.iat > 7 * 24 * 3_600_000) return null;  // 7-day expiry
    // Check code still active (reload db in case it was updated)
    const fresh = loadDB();
    const row   = fresh.codes.find(c => c.id === p.codeId && c.active);
    if (!row) return null;
    return p;
  } catch { return null; }
}

// ─── Middleware ───────────────────────────────────────────────────────────
app.use(express.json());

function requireAuth(...roles) {
  return (req, res, next) => {
    const raw  = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = verifyToken(raw);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'Forbidden' });
    req.user = user;
    next();
  };
}

// ─── Auth endpoints ───────────────────────────────────────────────────────

// POST /api/auth  { code, role }
app.post('/api/auth', (req, res) => {
  const { code, role } = req.body || {};
  if (!code || !['pilot', 'atc'].includes(role)) {
    return res.status(400).json({ error: 'Missing code or role' });
  }
  if (!/^\d+$/.test(String(code))) {
    return setTimeout(() => res.status(401).json({ error: 'Invalid code' }), 600);
  }
  const fresh = loadDB();
  const row   = fresh.codes.find(c => c.code === String(code) && c.role === role && c.active);
  if (!row) {
    return setTimeout(() => res.status(401).json({ error: 'Invalid code' }), 600);
  }
  fresh.lastLogins[role] = { codeId: row.id, time: new Date().toISOString(), ip: req.ip };
  saveDB(fresh);

  const token = signToken({ role, codeId: row.id, iat: Date.now() });
  res.json({ token, role });
});

// GET /api/verify
app.get('/api/verify', (req, res) => {
  const raw  = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = verifyToken(raw);
  if (!user) return res.status(401).json({ error: 'Invalid token' });
  res.json({ role: user.role });
});

// ─── Shared: last logins (pilot + ATC) ───────────────────────────────────
app.get('/api/admin/last-logins', requireAuth('pilot', 'atc'), (_req, res) => {
  const fresh = loadDB();
  res.json({ lastLogins: fresh.lastLogins });
});

// ─── Admin endpoints (pilot only) ────────────────────────────────────────

// GET /api/admin/codes
app.get('/api/admin/codes', requireAuth('pilot'), (_req, res) => {
  const fresh = loadDB();
  res.json({ codes: fresh.codes, lastLogins: fresh.lastLogins });
});

// POST /api/admin/codes  { code, role, label }
app.post('/api/admin/codes', requireAuth('pilot'), (req, res) => {
  const { code, role, label = '' } = req.body || {};
  if (!code || !['pilot', 'atc'].includes(role)) {
    return res.status(400).json({ error: 'Missing code or role' });
  }
  if (!/^\d{4,}$/.test(String(code))) {
    return res.status(400).json({ error: 'Code must be at least 4 digits' });
  }
  const fresh = loadDB();
  if (fresh.codes.find(c => c.code === String(code))) {
    return res.status(409).json({ error: 'Code already exists' });
  }
  const newCode = { id: fresh.nextId++, code: String(code), role, label, active: true, created: new Date().toISOString() };
  fresh.codes.push(newCode);
  saveDB(fresh);
  res.json({ success: true, code: newCode });
});

// DELETE /api/admin/codes/:id
app.delete('/api/admin/codes/:id', requireAuth('pilot'), (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const fresh = loadDB();
  const row   = fresh.codes.find(c => c.id === id);
  if (!row) return res.status(404).json({ error: 'Not found' });

  // Prevent deleting if it would leave the role with no active codes
  const othersActive = fresh.codes.filter(c => c.id !== id && c.role === row.role && c.active);
  if (othersActive.length === 0) {
    return res.status(400).json({ error: `Cannot delete the only active ${row.role} code` });
  }

  row.active = false;
  saveDB(fresh);
  res.json({ success: true });
});

// ─── OSM Tile Proxy ───────────────────────────────────────────────────────
const TILE_MAX  = 2000;
const tileCache = new Map();

let osmActive = 0;
const osmQueue = [];
function osmAcquire() {
  return new Promise(resolve => {
    if (osmActive < 2) { osmActive++; resolve(); }
    else osmQueue.push(resolve);
  });
}
function osmRelease() {
  if (osmQueue.length > 0) osmQueue.shift()();
  else osmActive = Math.max(0, osmActive - 1);
}

function fetchOsmTile(z, x, y) {
  const sub = ['a', 'b', 'c'][(parseInt(x) + parseInt(y)) % 3];
  return new Promise((resolve, reject) => {
    const req = https.get(`https://${sub}.tile.openstreetmap.org/${z}/${x}/${y}.png`, {
      headers: { 'User-Agent': 'KarpathosUASGridTool/1.0 (drone-coordination)' },
      timeout: 10_000,
    }, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`OSM ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
    });
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OSM timeout')); });
  });
}

app.get('/tiles/:z/:x/:y.png', async (req, res) => {
  const { z, x, y } = req.params;
  if (!/^\d{1,2}$/.test(z) || !/^\d+$/.test(x) || !/^\d+$/.test(y)) return res.status(400).send('Bad params');
  if (parseInt(z) > 19) return res.status(400).send('Zoom out of range');

  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) {
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public,max-age=86400').set('X-Cache', 'HIT');
    return res.send(tileCache.get(key));
  }
  try {
    await osmAcquire();
    let buf;
    try   { buf = await fetchOsmTile(z, x, y); }
    finally { osmRelease(); }
    if (tileCache.size >= TILE_MAX) tileCache.delete(tileCache.keys().next().value);
    tileCache.set(key, buf);
    res.set('Content-Type', 'image/png').set('Cache-Control', 'public,max-age=86400').set('X-Cache', 'MISS');
    res.send(buf);
  } catch (err) {
    console.error('[TILE]', key, err.message);
    res.status(502).send('Tile unavailable');
  }
});

// ─── Flight endpoints ─────────────────────────────────────────────────────

// GET /api/flights — all flights (pilot + atc)
app.get('/api/flights', requireAuth('pilot', 'atc'), (_req, res) => {
  const fresh = loadDB();
  res.json({ flights: fresh.flights || [] });
});

// GET /api/flights/:id — single flight
app.get('/api/flights/:id', requireAuth('pilot', 'atc'), (req, res) => {
  const fresh = loadDB();
  const flight = (fresh.flights || []).find(f => f.id === req.params.id);
  if (!flight) return res.status(404).json({ error: 'Not found' });
  res.json({ flight });
});

// POST /api/flights — create (pilot only), returns sequential ID like "01"
app.post('/api/flights', requireAuth('pilot'), (req, res) => {
  const fresh = loadDB();
  if (!fresh.flights)      fresh.flights      = [];
  if (!fresh.nextFlightId) fresh.nextFlightId = 1;
  const id = String(fresh.nextFlightId).padStart(2, '0');
  fresh.nextFlightId++;
  const flight = { ...req.body, id, created: new Date().toISOString(), status: req.body.status || 'pending' };
  fresh.flights.push(flight);
  saveDB(fresh);
  res.json({ flight });
});

// PUT /api/flights/:id — full update (pilot + atc can edit details)
app.put('/api/flights/:id', requireAuth('pilot', 'atc'), (req, res) => {
  const fresh = loadDB();
  if (!fresh.flights) return res.status(404).json({ error: 'Not found' });
  const idx = fresh.flights.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const existing = fresh.flights[idx];
  fresh.flights[idx] = { ...existing, ...req.body, id: req.params.id, created: existing.created };
  saveDB(fresh);
  res.json({ flight: fresh.flights[idx] });
});

// PATCH /api/flights/:id/status — update status and/or afisNote (pilot + atc)
app.patch('/api/flights/:id/status', requireAuth('pilot', 'atc'), (req, res) => {
  const fresh = loadDB();
  if (!fresh.flights) return res.status(404).json({ error: 'Not found' });
  const flight = fresh.flights.find(f => f.id === req.params.id);
  if (!flight) return res.status(404).json({ error: 'Not found' });
  if (req.body.status   !== undefined) flight.status   = req.body.status;
  if (req.body.afisNote !== undefined) flight.afisNote = req.body.afisNote;
  saveDB(fresh);
  res.json({ flight });
});

// DELETE /api/flights/:id — pilot only
app.delete('/api/flights/:id', requireAuth('pilot'), (req, res) => {
  const fresh = loadDB();
  if (!fresh.flights) return res.status(404).json({ error: 'Not found' });
  const idx = fresh.flights.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  fresh.flights.splice(idx, 1);
  saveDB(fresh);
  res.json({ success: true });
});

// ─── Static files ─────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname), {
  setHeaders(res, p) {
    if (p.endsWith('sw.js') || p.endsWith('manifest.json')) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get('/atc', (_req, res) => res.sendFile(path.join(__dirname, 'atc.html')));
app.get('*',    (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => {
  const active = loadDB().codes.filter(c => c.active);
  console.log(`\n✈  Karpathos Grid Tool  →  http://localhost:${PORT}`);
  active.forEach(c => console.log(`   ${c.role.padEnd(6)}: ${c.code}  (${c.label})`));
  console.log('');
});
