/**
 * Auto-deploy backend/Code.gs to Apps Script:
 *   1. pushes the code (other project files, e.g. the manifest, are preserved)
 *   2. creates a new version
 *   3. points the web app deployment at the new version
 *
 * Runs in CI (see .github/workflows/deploy-backend.yml). All env vars required:
 *
 *   APPS_SCRIPT_CLIENT_ID / APPS_SCRIPT_CLIENT_SECRET / APPS_SCRIPT_REFRESH_TOKEN
 *     OAuth client for the Apps Script API. The refresh token needs two scopes:
 *       https://www.googleapis.com/auth/script.projects    (push code, cut versions)
 *       https://www.googleapis.com/auth/script.deployments  (repoint the web app deployment)
 *     Mint one with: node build/get-refresh-token.js
 *   APPS_SCRIPT_ID
 *     Apps Script editor -> Project Settings -> Script ID
 *   APPS_SCRIPT_DEPLOYMENT_ID
 *     The ID inside your web app URL: https://script.google.com/macros/s/<THIS>/exec
 *
 * The Apps Script API must be enabled for the script's Google Cloud project
 * (Cloud Console -> APIs & Services -> enable "Apps Script API").
 */
const fs = require('fs');
const path = require('path');

const {
  APPS_SCRIPT_CLIENT_ID: clientId,
  APPS_SCRIPT_CLIENT_SECRET: clientSecret,
  APPS_SCRIPT_REFRESH_TOKEN: refreshToken,
  APPS_SCRIPT_ID: scriptId,
  APPS_SCRIPT_DEPLOYMENT_ID: deploymentId,
} = process.env;

async function refreshAccessToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('token refresh failed: ' + JSON.stringify(j));
  return j.access_token;
}

async function api(at, method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + at, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${url} -> HTTP ${r.status}: ${JSON.stringify(j).slice(0, 500)}`);
  return j;
}

(async () => {
  for (const [k, v] of Object.entries({ clientId, clientSecret, refreshToken, scriptId, deploymentId })) {
    if (!v) throw new Error('missing env var for ' + k);
  }
  const at = await refreshAccessToken();
  const base = `https://script.googleapis.com/v1/projects/${scriptId}`;

  // 1. push code, preserving the project's other files (manifest etc.)
  const code = fs.readFileSync(path.join(__dirname, '..', 'backend', 'Code.gs'), 'utf8');
  const content = await api(at, 'GET', `${base}/content`);
  let files = (content.files || []).map((f) =>
    f.name === 'Code' && f.type === 'SERVER_JS' ? { ...f, source: code } : f
  );
  if (!files.some((f) => f.name === 'Code' && f.type === 'SERVER_JS') && !files.some((f) => f.name === 'Code')) {
    files.push({ name: 'Code', type: 'SERVER_JS', source: code });
  }
  await api(at, 'PUT', `${base}/content`, { files });
  console.log('code pushed');

  // 2. cut a new version
  const ver = await api(at, 'POST', `${base}/versions`, {
    description: 'auto-deploy ' + new Date().toISOString(),
  });
  console.log('version created:', ver.versionNumber);

  // 3. point the live web app deployment at it
  await api(at, 'PUT', `${base}/deployments/${deploymentId}`, {
    versionNumber: ver.versionNumber,
    manifestFileName: 'appsscript',
    description: 'Split it web app',
  });
  console.log('deployment now serving version', ver.versionNumber);
})().catch((e) => { console.error('deploy failed:', e.message); process.exit(1); });
