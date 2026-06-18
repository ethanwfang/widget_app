# Living Character Widget — Full Build Plan

A Home Screen widget showing a **shared scene** of two people, where each person's
state is driven by **iOS Focus** and **Google Calendar**, resolved in the cloud.

- **Display:** Widgy (one image layer)
- **Brain:** Cloudflare Worker (cron + HTTP endpoints)
- **State store:** GitHub repo (config + image assets)
- **Focus bridge:** iOS Shortcuts (one tiny automation per Focus mode, per phone)

---

## 1. Architecture

```
  iPhone Focus (her)            iPhone Focus (you)
        │ POST                        │ POST
        ▼                             ▼
  ┌─────────────────────────────────────────────┐
  │            Cloudflare Worker (brain)         │
  │  • POST /update    ← Focus state from phones │
  │  • CRON  */15 min  → poll Google Calendar    │
  │  • resolve each user's state (calendar wins) │
  │  • look up pairs[her|you] → image            │
  │  • GET /scene.png  → serves chosen image     │
  │  • GET /missing    → checklist of unmade art │
  │  • GET /state      → debug JSON              │
  └─────────────────────────────────────────────┘
        │ reads config + assets        │ persists last-known state
        ▼                              ▼
   GitHub repo (config.json,      Cloudflare KV
   assets/, scenes/)              (her_focus, you_focus, resolved)
        ▲
        │ one image layer, fixed URL, ~15 min refresh
  ┌─────────────┐
  │   Widgy     │  GET https://<worker>/scene.png
  └─────────────┘
```

**Why each piece exists**
- **Cloudflare** can reach Google Calendar over its API by itself, but **cannot see iOS Focus** (no Apple cloud API for it).
- **Shortcuts** is the only thing that can detect a Focus change on the phone; its sole job is to POST that change to the Worker.
- **Widgy** is a dumb window: it shows one fixed URL whose *bytes* change. No logic on the phone.
- **GitHub** holds editable config + art. **Cloudflare KV** holds tiny mutable runtime state (last Focus per user, last resolved image).

**Resolution rule (global "calendar wins"):**
For each user, in order:
1. If a current calendar event title matches a state's keyword → use that state.
2. Else if the user has an active Focus state (last POSTed, not `idle`) → use it.
3. Else → `default_state` (`idle`).

Then `image = pairs["her:<herState>|you:<youState>"]`, falling back to `fallback_image` if that pair isn't drawn yet.

---

## 2. Repo layout

```
widget_app/
├─ config.json                 # states, keywords, pairs, settings (source of truth)
├─ worker/
│  ├─ src/worker.js            # the Cloudflare Worker
│  └─ wrangler.toml            # Worker config + cron + KV binding
├─ assets/                     # per-user single-state art (optional/reference)
│  ├─ her/ gym.png study.png sleep.png relax.png idle.png
│  └─ you/ ...
├─ scenes/                     # the pre-rendered PAIR images (what actually displays)
│  ├─ her-gym__you-study.png
│  ├─ her-sleep__you-sleep.png
│  └─ _fallback.png
└─ shortcuts/                  # notes/screenshots for the phone automations
```

> Note: with **pre-rendered pairs**, `scenes/` is what's displayed. `assets/` is just
> your working folder for generating the pair art (or future composite mode).

---

## 3. `config.json` (the abstraction)

Everything about states is data. Add/remove a state by editing this file + dropping in art.

```json
{
  "winner": "calendar",
  "fallback_image": "scenes/_fallback.png",
  "calendar_lookahead_minutes": 0,
  "users": {
    "her": {
      "calendar_id": "her-google-calendar-id@group.calendar.google.com",
      "default_state": "idle",
      "states": [
        { "id": "gym",   "keywords": ["gym", "workout", "lift", "run"] },
        { "id": "study", "keywords": ["class", "study", "lecture", "hw", "exam"] },
        { "id": "sleep", "keywords": ["sleep", "bed", "nap"] },
        { "id": "relax", "keywords": ["relax", "break", "chill", "movie"] },
        { "id": "idle",  "keywords": [] }
      ]
    },
    "you": {
      "calendar_id": "your-google-calendar-id@group.calendar.google.com",
      "default_state": "idle",
      "states": [
        { "id": "gym",   "keywords": ["gym", "workout", "lift"] },
        { "id": "study", "keywords": ["work", "meeting", "focus", "deep work"] },
        { "id": "sleep", "keywords": ["sleep", "bed"] },
        { "id": "relax", "keywords": ["relax", "game", "chill"] },
        { "id": "idle",  "keywords": [] }
      ]
    }
  },
  "pairs": {
    "her:gym|you:study":   "scenes/her-gym__you-study.png",
    "her:study|you:study": "scenes/her-study__you-study.png",
    "her:sleep|you:sleep": "scenes/her-sleep__you-sleep.png",
    "her:idle|you:idle":   "scenes/her-idle__you-idle.png"
  }
}
```

**Rules the Worker enforces:**
- Keyword match is **case-insensitive substring** on the event title; first state (in array order) with any matching keyword wins. Put more specific states first.
- A pair key is always `her:<id>|you:<id>`. Missing key → `fallback_image`.
- A Focus POST with a `state` id not in that user's `states` is ignored (safe add/remove).

---

## 4. Cloudflare Worker

### 4.1 `wrangler.toml`

```toml
name = "living-widget"
main = "src/worker.js"
compatibility_date = "2024-11-01"

# 15-minute calendar poll
[triggers]
crons = ["*/15 * * * *"]

# Tiny mutable runtime state
[[kv_namespaces]]
binding = "STATE"
id = "<created via: wrangler kv namespace create STATE>"

[vars]
CONFIG_URL = "https://raw.githubusercontent.com/<you>/<repo>/main/config.json"
SCENES_BASE_URL = "https://raw.githubusercontent.com/<you>/<repo>/main/"

# Secrets (set with `wrangler secret put <NAME>`):
#   SHARED_TOKEN              - simple bearer the phones send, so randos can't POST
#   GOOGLE_CLIENT_ID
#   GOOGLE_CLIENT_SECRET
#   GOOGLE_REFRESH_TOKEN_HER  - one-time OAuth consent per person
#   GOOGLE_REFRESH_TOKEN_YOU
```

### 4.2 Endpoints

| Method | Path        | Purpose |
|--------|-------------|---------|
| POST   | `/update`   | Phone reports a Focus change: `{ "user":"her", "state":"gym" }` (Bearer `SHARED_TOKEN`). Recomputes immediately. |
| GET    | `/scene.png`| Widgy points here. Serves the resolved pair image with **anti-cache headers**. |
| GET    | `/state`    | Debug JSON: raw focus per user, resolved states, chosen image. |
| GET    | `/missing`  | Checklist of pair keys that have no image yet (your art to-do list). |
| CRON   | —           | Every 15 min: poll both calendars, recompute, store resolved image. |

### 4.3 `src/worker.js` (skeleton — fill in TODOs)

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/update") return handleUpdate(request, env);
    if (url.pathname === "/scene.png") return serveScene(env);
    if (url.pathname === "/state")    return json(await computeState(env));
    if (url.pathname === "/missing")  return json(await missingPairs(env));
    return new Response("ok");
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(recomputeAndStore(env));   // cron tick
  },
};

// ---- config + tiny helpers --------------------------------------------------
async function loadConfig(env) {
  const r = await fetch(env.CONFIG_URL, { cf: { cacheTtl: 60 } });
  return r.json();
}
const json = (o) => new Response(JSON.stringify(o, null, 2), { headers: { "content-type": "application/json" } });

// ---- POST /update : Focus from phone ---------------------------------------
async function handleUpdate(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${env.SHARED_TOKEN}`) return new Response("unauthorized", { status: 401 });
  const { user, state } = await request.json();
  const cfg = await loadConfig(env);
  if (!cfg.users[user]) return new Response("unknown user", { status: 400 });
  const valid = cfg.users[user].states.some(s => s.id === state);
  await env.STATE.put(`focus:${user}`, valid ? state : cfg.users[user].default_state);
  await recomputeAndStore(env);             // make Focus feel instant server-side
  return json({ ok: true, user, state });
}

// ---- calendar : current event title -> matched state ------------------------
async function googleAccessToken(env, refreshToken) {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  return (await r.json()).access_token;
}

async function currentEventTitle(env, calendarId, refreshToken) {
  const token = await googleAccessToken(env, refreshToken);
  // NOTE: Worker has no Date.now? It does at runtime; only the Claude *workflow* sandbox blocks it.
  const now = new Date();
  const params = new URLSearchParams({
    timeMin: new Date(now.getTime() - 60000).toISOString(),
    timeMax: new Date(now.getTime() + 60000).toISOString(),
    singleEvents: "true", orderBy: "startTime", maxResults: "1",
  });
  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  const data = await r.json();
  return data.items?.[0]?.summary || null;   // event title, or null if free
}

function matchKeyword(title, userCfg) {
  if (!title) return null;
  const t = title.toLowerCase();
  for (const s of userCfg.states) {
    if (s.keywords.some(k => t.includes(k.toLowerCase()))) return s.id;
  }
  return null;
}

// ---- resolution : calendar wins, then focus, then default ------------------
async function resolveUser(env, cfg, user) {
  const userCfg = cfg.users[user];
  const calState = matchKeyword(await currentEventTitle(env, userCfg.calendar_id, refreshTokenFor(env, user)), userCfg);
  if (cfg.winner === "calendar" && calState) return calState;
  const focusState = await env.STATE.get(`focus:${user}`);
  if (focusState && focusState !== userCfg.default_state) return focusState;
  if (cfg.winner === "focus" && calState) return calState;   // focus-wins fallback
  return calState || userCfg.default_state;
}
const refreshTokenFor = (env, user) => user === "her" ? env.GOOGLE_REFRESH_TOKEN_HER : env.GOOGLE_REFRESH_TOKEN_YOU;

async function computeState(env) {
  const cfg = await loadConfig(env);
  const her = await resolveUser(env, cfg, "her");
  const you = await resolveUser(env, cfg, "you");
  const key = `her:${her}|you:${you}`;
  const image = cfg.pairs[key] || cfg.fallback_image;
  return { her, you, key, image };
}

async function recomputeAndStore(env) {
  const s = await computeState(env);
  await env.STATE.put("resolved_image", s.image);
  return s;
}

// ---- GET /scene.png : serve image with anti-cache headers ------------------
async function serveScene(env) {
  let path = await env.STATE.get("resolved_image");
  if (!path) path = (await recomputeAndStore(env)).image;
  const img = await fetch(env.SCENES_BASE_URL + path, { cf: { cacheTtl: 30 } });
  return new Response(img.body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "no-store, must-revalidate",  // beat iOS/CDN image cache
      "etag": `"${path}"`,
    },
  });
}

// ---- GET /missing : pair art to-do list ------------------------------------
async function missingPairs(env) {
  const cfg = await loadConfig(env);
  const her = cfg.users.her.states.map(s => s.id);
  const you = cfg.users.you.states.map(s => s.id);
  const missing = [];
  for (const h of her) for (const y of you) {
    const k = `her:${h}|you:${y}`;
    if (!cfg.pairs[k]) missing.push(k);
  }
  return { total: her.length * you.length, drawn: her.length*you.length - missing.length, missing };
}
```

> The skeleton is intentionally complete enough to run. The TODOs are mostly: create
> the KV namespace, set secrets, and confirm calendar event-window logic suits you
> (e.g. `calendar_lookahead_minutes` if you want "starting soon" to count).

---

## 5. Google Calendar OAuth (one-time per person, then never again)

Personal `@gmail.com` accounts are fine. Each of you consents **exactly once** — but
only if you get two settings right, or the token will silently die in ~7 days.

> ⚠️ **The two non-negotiable settings for "consent once, forever":**
> 1. **Publish the consent screen to "In production"** (NOT "Testing"). In Testing,
>    refresh tokens for the sensitive `calendar.readonly` scope expire after ~7 days.
>    In production they persist indefinitely.
> 2. **Request the token with `access_type=offline` AND `prompt=consent`** on the first
>    authorization. This is what makes Google return a long-lived *refresh* token (not
>    just a short access token). Without it you only get a token that expires in an hour.
>
> Once published + offline, the refresh token only ever breaks if you **revoke** access,
> **change the scopes**, or have a major account security event (password reset). Your
> Worker uses it every 15 min, so it never goes idle. Otherwise: set it and forget it.

1. Google Cloud Console → new project → **Enable Google Calendar API**.
2. **OAuth consent screen** → User type **External**.
   - Add app name + your support email.
   - Add both of your Google accounts as **Test users** (needed to authorize during setup).
   - **Publish status → "In production"** (the key step — see warning above). You'll each
     see a one-time "Google hasn't verified this app" warning at consent → **Advanced →
     Go to {app} (unsafe)**. That's expected for an unverified personal app; click through once.
3. **Credentials → OAuth client ID → Desktop app.** Note `client_id` / `client_secret`.
4. Get a **refresh token** per person (Google OAuth Playground, or a 10-line local script):
   - Scope: `https://www.googleapis.com/auth/calendar.readonly`
   - **Must include `access_type=offline` and `prompt=consent`** so you receive a `refresh_token`.
   - Consent once as *her*, once as *you*. Save each `refresh_token`.
5. Store as Worker secrets:
   ```
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   wrangler secret put GOOGLE_REFRESH_TOKEN_HER
   wrangler secret put GOOGLE_REFRESH_TOKEN_YOU
   ```
6. Find each `calendar_id` (Google Calendar → settings of the calendar → "Calendar ID";
   primary calendars are just the gmail address). Put them in `config.json`.

---

## 6. iOS Shortcuts (the Focus bridge) — per phone

Create one **Personal Automation** per Focus mode you use, on **each** phone.

**Example — "Gym Focus ON" (her phone):**
1. Shortcuts app → **Automation** → **+** → **Focus** → choose **Gym** → **When Turning On**.
2. **Run Immediately** ✅ (critical — otherwise she taps a prompt every time).
3. Action: **Get Contents of URL**
   - URL: `https://<your-worker>.workers.dev/update`
   - Method: **POST**
   - Headers: `Authorization: Bearer <SHARED_TOKEN>`
   - Request Body: **JSON** → `{ "user": "her", "state": "gym" }`

**Also create "Gym Focus OFF":** same, **When Turning Off**, body `{ "user": "her", "state": "idle" }`.

Repeat for each Focus (study/sleep/relax). On your phone, same but `"user": "you"`.

> Tip: build one, then duplicate and change the Focus + the `state` string. ~3 actions each.

---

## 7. Widgy setup (once, then never again)

1. Widgy → **New Widget** → pick Home Screen size.
2. Add an **Image layer**.
3. Source: **URL** → `https://<your-worker>.workers.dev/scene.png`
4. Refresh interval: set to the **shortest** Widgy allows (it's a request; iOS throttles it).
5. Size the image to fill; save; add the Widgy widget to the Home Screen.
6. Repeat on the second phone — same URL, both see the same scene.

---

## 8. Art workflow (pre-rendered pairs)

1. Hit `GET /missing` → get the exact list of undrawn pair keys.
2. For each key `her:<h>|you:<y>`, generate a scene (Gemini etc.) and save as
   `scenes/her-<h>__you-<y>.png`.
3. Add the entry to `config.json` `pairs`.
4. Commit & push. Worker picks it up within ~60s (config cache TTL).
5. Until a pair is drawn, that combo shows `_fallback.png` — nothing breaks.

**Adding a new state later:** add it to a user's `states` (id + keywords), then `GET /missing`
tells you the handful of new pair images to draw. **Removing:** delete the state; stale
pair keys are harmless.

---

## 9. Build milestones

- [ ] **M0 — Repo + fallback image.** Create repo, `config.json` with 2 idle states + `_fallback.png`. Commit.
- [ ] **M1 — Worker skeleton live.** Deploy Worker, create KV, set `SHARED_TOKEN`. `GET /scene.png` serves fallback. `GET /state` returns JSON.
- [ ] **M2 — Focus path.** Build Shortcuts on both phones → POST `/update`. Verify `/state` flips. Widgy shows the right scene.
- [ ] **M3 — A few real scenes.** Draw 4–6 common pairs, wire into `config.json`. Confirm they appear.
- [ ] **M4 — Calendar path.** OAuth both accounts, set secrets, add `calendar_id`s. Confirm cron resolves calendar states and "calendar wins" overrides Focus.
- [ ] **M5 — Fill the grid.** Use `/missing` to complete pair art over time.
- [ ] **M6 — Polish.** Tune keyword lists, refresh intervals, fallback art.

---

## 10. Known constraints (set expectations)

- **Not real-time.** End-to-end change can take **15–45 min** to *display* (Worker 15-min cron + iOS widget refresh budget + cache). Focus is server-fresh on POST, but pixels wait on the widget refresh. This is an ambient widget by design.
- **iOS refresh budget:** ~40–70 widget refreshes/day; sub-15-min isn't guaranteed; Low Power Mode stretches it.
- **Cache:** images are served via the Worker with `no-store` + ETag specifically to beat iOS/GitHub image caching — do **not** point Widgy at raw GitHub.
- **OAuth test-user mode:** tokens from an unverified consent screen can expire after ~7 days. For a 2-person app either re-consent occasionally or publish the consent screen.
- **Going real-time** later = a custom WidgetKit app with push-driven reloads (out of scope; ship ambient first).
```
