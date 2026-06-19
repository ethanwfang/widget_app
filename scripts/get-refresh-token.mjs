// One-time helper: get a Google refresh token for Calendar (read-only).
// Run it once per person (sign in as her, then as you).
//
//   GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/get-refresh-token.mjs
//
// It opens a Google sign-in page, you approve, and it prints a refresh_token.
// Requires Node >= 18 (built-in fetch). No npm install needed.

import http from "node:http";
import { exec } from "node:child_process";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const PORT = 5858;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars first.");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // <-- required to get a refresh token
    prompt: "consent",       // <-- forces a refresh token even on re-auth
  });

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/callback")) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, REDIRECT_URI).searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("No code in callback.");
    return;
  }
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const data = await tokenRes.json();
    res.writeHead(200, { "content-type": "text/plain" });
    if (data.refresh_token) {
      res.end("Success! Refresh token printed in your terminal. You can close this tab.");
      console.log("\n=== REFRESH TOKEN (copy this) ===\n");
      console.log(data.refresh_token);
      console.log("\n=================================\n");
    } else {
      res.end("No refresh_token returned. See terminal.");
      console.error("\nNo refresh_token in response:", JSON.stringify(data, null, 2));
      console.error("Tip: revoke prior access at https://myaccount.google.com/permissions and retry.");
    }
  } catch (e) {
    res.writeHead(500).end("Token exchange failed; see terminal.");
    console.error(e);
  } finally {
    setTimeout(() => server.close(() => process.exit(0)), 500);
  }
});

server.listen(PORT, () => {
  console.log("\nOpening Google sign-in in your browser...");
  console.log("If it doesn't open, paste this URL manually:\n\n" + authUrl + "\n");
  exec(`open "${authUrl}"`); // macOS
});
