// Living Character Widget — Cloudflare Worker (the "brain").
// See BUILD_PLAN.md for the full architecture.
//
// Endpoints:
//   POST /update    Focus state from a phone: { "user":"her", "state":"gym" }  (Bearer SHARED_TOKEN)
//   GET  /scene.png Widgy points here. Serves the resolved pair image, anti-cached.
//   GET  /state     Debug JSON: raw focus per user + resolved states + chosen image.
//   GET  /missing   Pair keys with no image yet (your art to-do list).
//   CRON            Every 15 min: poll calendars, recompute, store resolved image.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/update") return await handleUpdate(request, env);
      if (url.pathname === "/scene.png") return await serveScene(env);
      if (url.pathname === "/state")     return json(await computeState(env));
      if (url.pathname === "/missing")   return json(await missingPairs(env));
      return new Response("living-widget ok — try /state, /scene.png, /missing\n");
    } catch (err) {
      return new Response(`error: ${err && err.stack ? err.stack : err}`, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(recomputeAndStore(env)); // cron tick: refresh from calendars
  },
};

// ---- helpers ----------------------------------------------------------------
const json = (o) => new Response(JSON.stringify(o, null, 2), {
  headers: { "content-type": "application/json" },
});

async function loadConfig(env) {
  // Cache-bust both GitHub's Fastly cache and Cloudflare's edge cache so config
  // edits propagate within ~30s instead of being pinned by GitHub's 5-min max-age.
  const bust = Math.floor(Date.now() / 30_000); // rotates every 30s
  const url = env.CONFIG_URL + (env.CONFIG_URL.includes("?") ? "&" : "?") + "v=" + bust;
  const r = await fetch(url, { cf: { cacheTtl: 30 } });
  if (!r.ok) throw new Error(`config fetch failed: ${r.status}`);
  return r.json();
}

// ---- POST /update : Focus reported from a phone ----------------------------
async function handleUpdate(request, env) {
  const auth = request.headers.get("authorization") || "";
  if (!env.SHARED_TOKEN || auth !== `Bearer ${env.SHARED_TOKEN}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const { user, state } = await request.json();
  const cfg = await loadConfig(env);
  const userCfg = cfg.users[user];
  if (!userCfg) return new Response("unknown user", { status: 400 });

  // Ignore unknown state ids so adding/removing states is always safe.
  const valid = userCfg.states.some((s) => s.id === state);
  await env.STATE.put(`focus:${user}`, valid ? state : userCfg.default_state);

  const resolved = await recomputeAndStore(env); // make Focus feel instant server-side
  return json({ ok: true, user, state: valid ? state : userCfg.default_state, resolved });
}

// ---- Google Calendar : current event title ---------------------------------
function refreshTokenFor(env, user) {
  if (user === "her") return env.GOOGLE_REFRESH_TOKEN_HER;
  if (user === "you") return env.GOOGLE_REFRESH_TOKEN_YOU;
  return null;
}

async function googleAccessToken(env, refreshToken) {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  if (!r.ok) throw new Error(`google token failed: ${r.status}`);
  return (await r.json()).access_token;
}

async function currentEventTitle(env, user, calendarId) {
  const refreshToken = refreshTokenFor(env, user);
  // Calendar is optional: if not wired up yet, skip it gracefully.
  if (!refreshToken || !env.GOOGLE_CLIENT_ID || !calendarId || calendarId.startsWith("REPLACE")) {
    return null;
  }
  const token = await googleAccessToken(env, refreshToken);
  const now = new Date(); // valid at Worker runtime
  const params = new URLSearchParams({
    timeMin: new Date(now.getTime() - 60_000).toISOString(),
    timeMax: new Date(now.getTime() + 60_000).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "1",
  });
  const r = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
  if (!r.ok) throw new Error(`calendar fetch failed: ${r.status}`);
  const data = await r.json();
  return data.items?.[0]?.summary || null;
}

function matchKeyword(title, userCfg) {
  if (!title) return null;
  const t = title.toLowerCase();
  for (const s of userCfg.states) {
    if (s.keywords.some((k) => t.includes(k.toLowerCase()))) return s.id;
  }
  return null;
}

// ---- resolution : focus-override > calendar > focus > default --------------
async function resolveUser(env, cfg, user) {
  const userCfg = cfg.users[user];

  const focusState = await env.STATE.get(`focus:${user}`);
  const focusActive = focusState && focusState !== userCfg.default_state;

  // Focus-override: states listed in focus_wins_states (e.g. "sleep") beat the
  // calendar entirely. Used so Sleep DnD always shows the sleeping character,
  // even if a calendar event happens to overlap.
  const overrides = cfg.focus_wins_states || [];
  if (focusActive && overrides.includes(focusState)) return focusState;

  let calState = null;
  try {
    calState = matchKeyword(await currentEventTitle(env, user, userCfg.calendar_id), userCfg);
  } catch (_) {
    calState = null; // don't let a calendar hiccup blank the widget
  }

  if (cfg.winner === "calendar" && calState) return calState;
  if (focusActive) return focusState;
  if (cfg.winner === "focus" && calState) return calState; // focus-wins fallback path
  return calState || userCfg.default_state;
}

async function computeState(env) {
  const cfg = await loadConfig(env);
  const her = await resolveUser(env, cfg, "her");
  const you = await resolveUser(env, cfg, "you");
  const key = `her:${her}|you:${you}`;
  const image = cfg.pairs[key] || cfg.fallback_image;
  return { winner: cfg.winner, her, you, key, image, fallback: !cfg.pairs[key] };
}

async function recomputeAndStore(env) {
  const s = await computeState(env);
  await env.STATE.put("resolved_image", s.image);
  return s;
}

// ---- GET /scene.png : serve image, beating iOS/CDN caches ------------------
async function serveScene(env) {
  let path = await env.STATE.get("resolved_image");
  if (!path) path = (await recomputeAndStore(env)).image;
  const img = await fetch(env.SCENES_BASE_URL + path, { cf: { cacheTtl: 30 } });
  if (!img.ok) return new Response(`scene fetch failed: ${img.status}`, { status: 502 });
  return new Response(img.body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "no-store, must-revalidate",
      "etag": `"${path}"`,
    },
  });
}

// ---- GET /missing : which pair images are not drawn yet --------------------
async function missingPairs(env) {
  const cfg = await loadConfig(env);
  const her = cfg.users.her.states.map((s) => s.id);
  const you = cfg.users.you.states.map((s) => s.id);
  const missing = [];
  for (const h of her) {
    for (const y of you) {
      const k = `her:${h}|you:${y}`;
      if (!cfg.pairs[k]) missing.push(k);
    }
  }
  const total = her.length * you.length;
  return { total, drawn: total - missing.length, missing };
}
