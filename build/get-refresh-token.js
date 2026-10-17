/**
 * One-time helper: mints a refresh token for the Apps Script API.
 *
 * Prerequisites (Google Cloud Console, in the project bound to your script):
 *   1. APIs & Services -> enable "Apps Script API".
 *   2. APIs & Services -> Credentials -> Create Credentials -> OAuth client ID
 *      -> Application type: "Desktop app". Copy the client ID and secret.
 *   3. APIs & Services -> OAuth consent screen: add your own Google account
 *      as a test user (the app stays in Testing mode — fine for personal use).
 *
 * Usage:
 *   APPS_SCRIPT_CLIENT_ID=... APPS_SCRIPT_CLIENT_SECRET=... node build/get-refresh-token.js
 *
 * It prints a URL: open it in the browser logged into the Google account that
 * owns the script, approve access, and the script prints the refresh token.
 * Save it as the APPS_SCRIPT_REFRESH_TOKEN GitHub secret (never commit it).
 *
 * Scopes requested (the minimum the deploy script needs):
 *   script.projects    - push code (updateContent) and cut versions
 *   script.deployments - repoint the web app deployment at the new version
 */
const http = require('http');

const clientId = process.env.APPS_SCRIPT_CLIENT_ID;
const clientSecret = process.env.APPS_SCRIPT_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set APPS_SCRIPT_CLIENT_ID and APPS_SCRIPT_CLIENT_SECRET first.');
  process.exit(1);
}

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/callback`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  const code = u.searchParams.get('code');
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing code — start over.');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Got it — you can close this tab and go back to your terminal.');
  server.close();

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  const j = await r.json();
  if (j.refresh_token) {
    console.log('\nSave this as the APPS_SCRIPT_REFRESH_TOKEN secret:\n');
    console.log(j.refresh_token);
  } else {
    console.error('\nNo refresh token returned:', JSON.stringify(j));
    process.exitCode = 1;
  }
});

server.listen(PORT, () => {
  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/script.projects https://www.googleapis.com/auth/script.deployments',
      access_type: 'offline',
      prompt: 'consent',
    });
  console.log('1. Open this URL in your browser (logged into the script owner account):\n');
  console.log(authUrl);
  console.log('\n2. Approve access, then come back here for the refresh token.');
});
