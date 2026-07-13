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

Codes are **numeric only** (minimum 4 digits). They are stored in `data/db.json` and survive server restarts.

| Role | Default code | Notes |
|------|-------------|-------|
| Pilot | `1234` | Also has admin access (code management) |
| ATC | `5678` | Read-only access to last-login info |

**Change defaults** by setting env vars before the first server start (see below). After the DB is seeded, use the in-app Code Management panel to add/revoke codes.

---

## Roles

- **Pilot** — logs into `index.html`, can plan flights, see the flight calendar, and manage access codes via the ⚙ Codes button.
- **ATC / AFIS** — logs into `atc.html` (or is redirected there when selecting ATC on the login screen). Can see all submitted flights and check last-login times.

Both roles can visit either page. ATC visiting `index.html` sees the grid but the "Schedule flight" button is hidden. Pilot visiting `atc.html` sees the ATC dashboard but the 📋 Logins button is hidden.

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
| `DATA_DIR` | Path to store `db.json` | `./data` |
| `PORT` | HTTP port (set automatically by Railway — do not override) | `3000` |

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

---

## Security

### Authentication

Tokens are **HMAC-SHA256 signed**, stored in `localStorage`, valid for 7 days. Revoking a code immediately invalidates all tokens issued with that code (checked on every request by reloading `db.json`).

On page load, the token is **verified with the server** before the app is shown. If the server is unreachable or the token is invalid/expired, the token is cleared and the login screen stays visible. Network failures never grant access.

### Preventing flash of app content

Both `index.html` and `atc.html` set `body { visibility: hidden }` in CSS by default. The login overlay explicitly overrides this with `#loginScreen { visibility: visible }`. When the server confirms a valid token, JavaScript sets `document.body.style.visibility = 'visible'` to reveal the app. This means the app content is **never visible** — even for a single frame — until authentication is confirmed, regardless of z-index or rendering order.

### XSS protection

All user-supplied data (pilot name, notes, AFIS note, drone type/reg, cell IDs) is HTML-escaped before being inserted into `innerHTML` template literals. Both files use a DOM-based `esc()`/`escHtml()` helper (`element.textContent = s; return element.innerHTML`) which is immune to regex bypass.

### Code scanning

A GitHub Actions workflow (`.github/workflows/codeql.yml`) runs **CodeQL security analysis** on every push to `main`/`master` and weekly on a schedule. It uses the `security-extended` and `security-and-quality` query suites, which cover OWASP Top 10 and additional quality checks.

### Infrastructure

Server runs on [Railway](https://railway.com/) — EU West Amsterdam (Google Cloud). SOC 2 Type 2 · SOC 3 · GDPR · HIPAA. See [trust.railway.com](https://trust.railway.com) for details.

### Analytics

[GoatCounter](https://www.goatcounter.com/) — anonymous page views only. No cookies, no personal data, no consent banner required.

---

## ⚠️ Grid cell ID convention — do not change

**This is critical.** Cell IDs (e.g. `C24`) must mean the same thing in every part of the system. A mismatch means a pilot flies in a different sector than ATC approved — a safety issue.

### The rule

> **Row 1 = northernmost row. Row 29 = southernmost row.**
> Columns A–I run west to east.

### How the grid loop works

Both `index.html` and `atc.html` build the Leaflet grid with the same loop:

```js
for (let r = 0; r < ROWS; r++) {        // r=0 starts at B.south (southernmost)
  const id = colLetter(c-2) + (ROWS - r); // ROWS-r = tool row number (1=north)
}
```

Because the loop starts at `B.south` (the geographic bottom), `r=0` is the southernmost cell. To get the correct tool row number (1 at the top/north), the formula is `ROWS - r`, **not** `r + 1`.

Using `r + 1` would label the southernmost cell as row 1, inverting the entire grid — so `C24` in the pilot tool would highlight a completely different cell in the ATC view.

### Where this formula is used

| File | Location | Purpose |
|------|----------|---------|
| `index.html` | Leaflet grid loop | Pilot map cell IDs |
| `index.html` | `exportReferenceMap()` — steps 2, 3, 5 | Reference map PNG labels |
| `atc.html` | Leaflet grid loop | ATC map cell IDs |

The mini SVG preview in `atc.html` (flight card thumbnail) uses `r+1` — that is intentional because the SVG renders top-to-bottom (r=0 = visual top = north = row 1), so `r+1` is correct there.

### If you ever touch the grid bounds or cell size

Verify that `C24` highlights the same physical area on both `index.html` and `atc.html` before deploying.

---

## Service Worker

`sw.js` caches tiles from `/tiles/` (the server proxy) for offline use. After any change to `sw.js`, users need to refresh once to activate the new worker.

---

## Weather widget

Uses the [Open-Meteo](https://open-meteo.com/) free API (no key required). Shows current temperature, sunrise/sunset, and a 3-day forecast for Karpathos (35.507°N, 27.213°E). Click the widget in the header to expand. Links to Windy and Meteoblue for detailed forecasts.
