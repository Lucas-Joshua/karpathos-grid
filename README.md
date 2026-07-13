# Karpathos UAS Grid Coordination Tool

A web-based UAS (drone) flight coordination system for Karpathos AFIS (LGKP). Consists of two pages: a pilot planning tool and an ATC/AFIS dashboard, sharing a common flight database.

---

## Pages

| Page | URL | Who uses it |
|------|-----|-------------|
| `index.html` | `/` | Drone pilots — plan & submit flights |
| `atc.html` | `/atc` | ATC / AFIS — review & approve flights |

---

## Access codes

Codes are **numeric only** (minimum 4 digits). They are stored in the SQLite database and survive server restarts.

| Role | Default code | Notes |
|------|-------------|-------|
| Pilot | `1234` | Also has admin access (code management) |
| ATC | `5678` | Read-only access to last-login info |

**Change defaults** by setting env vars before the first server start (see below). After the DB is seeded, use the in-app Code Management panel to add/revoke codes.

---

## Roles

- **Pilot** — logs into `index.html`, can plan flights, see the flight calendar, and manage access codes via the ⚙ Codes button.
- **ATC / AFIS** — logs into `atc.html` (or is redirected there when selecting ATC on the login screen). Can see all submitted flights and check last-login times.

If a pilot navigates to `atc.html`, they are automatically redirected to `index.html`.

---

## Code management (pilot only)

Click **⚙ Codes** in the top-right of the pilot tool to:

- See currently active pilot and ATC codes
- Add a new code (select role, enter 4+ digit code, optional label)
- Revoke a code (immediately logs out anyone using it)

---

## Deployment on Railway

### Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PILOT_CODE` | Initial pilot code (seeded once on first start) | `1234` |
| `ATC_CODE` | Initial ATC code (seeded once on first start) | `5678` |
| `JWT_SECRET` | Secret used to sign auth tokens — **change this!** | dev fallback |
| `DATA_DIR` | Path to store the SQLite database | `./data` |
| `PORT` | HTTP port | `3000` |

> Set these in Railway → Service → Variables before the first deploy.

### Persistent storage (Railway volume)

Codes are stored in `DATA_DIR/db.json` (default `./data/db.json`). On Railway, without a volume this file resets on every deploy.

**To persist codes across deploys:**
1. In Railway, go to your service → **Volumes**
2. Add a volume mounted at `/data`
3. Set env var `DATA_DIR=/data`

### Build & start

```bash
npm install   # installs express only (no native modules)
npm start     # node server.js
```

Railway runs `npm install` and then `npm start` automatically.

---

## Local development

```bash
cd karpathos-grid
npm install
node server.js
# → http://localhost:3000
```

The `./data/` folder is created automatically next to `server.js`.

---

## Architecture

```
Browser (index.html / atc.html)
  │
  ├── /api/auth                POST  → login, get token
  ├── /api/verify              GET   → validate token
  ├── /api/admin/last-logins   GET   → pilot + ATC
  ├── /api/admin/codes         GET   → pilot only
  ├── /api/admin/codes         POST  → pilot only (add)
  ├── /api/admin/codes/:id     DELETE → pilot only (revoke)
  └── /tiles/:z/:x/:y.png           → OSM tile proxy (in-memory cache)

Server (server.js / Express — pure Node.js, no native dependencies)
  └── data/db.json  → JSON file (codes + last_logins)
```

Tokens are **HMAC-SHA256 signed**, stored in `localStorage`, valid for 7 days. Revoking a code immediately invalidates all tokens issued with that code (checked on every request).

---

## Service Worker

`sw.js` caches tiles from `/tiles/` (the server proxy) for offline use. After any change to `sw.js`, users need to refresh once to activate the new worker.

---

## Weather widget

Uses the [Open-Meteo](https://open-meteo.com/) free API (no key required). Shows current temperature, sunrise/sunset, and a 3-day forecast for Karpathos (35.507°N, 27.213°E). Click the widget in the header to expand. Links to Windy and Meteoblue for detailed forecasts.
