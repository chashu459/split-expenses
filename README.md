# Split it — a tiny Splitwise clone

A shared expense tracker for you and your friends. Create a group, add people,
log who paid for what, and see who owes whom — with simplified "you pay X"
settlements. Data lives in **your Google Sheet**, via a small
Google Apps Script API. No accounts, no sign-up: anyone with the link can use it.

## How it works

```
friend's browser ──▶ static web page (frontend/)
        │                     │  fetch() JSON (no preflight)
        │                     ▼
        │            Google Apps Script web app (backend/Code.gs)
        │                     │  SpreadsheetApp
        ▼                     ▼
   your Google Sheet ◀── Groups / Members / Expenses / Settlements tabs
```

- All money is stored as **integer cents** — no float rounding bugs.
- Splits are equal shares by default, or **custom amounts** per person
  (they must add up to the total); leftover cents go to the first person in
  an equal split.
- The add-expense form shows a **live split preview** before you save.
- **Receipt photos** can be attached to an expense — they're downscaled in
  the browser, stored in a "Split Expenses Receipts" folder in the sheet
  owner's Google Drive, and shared as viewable links (anyone-with-link).
- Balances collapse into the fewest payments with a greedy min-cash-flow pass;
  every suggestion is tappable to prefill the "record a payment" form.
- Members get colored **avatar initials**, unique within each group
  ("AJ", "AJ2"… when initials collide).
- The UI updates **optimistically** — buttons respond instantly while the
  save happens in the background (a spinner in the header shows sync state),
  so double-taps can't create duplicates.
- The Apps Script uses `LockService` so two friends saving at once can't corrupt a row.
- The frontend sends POST bodies as `text/plain` (no `Content-Type` header) so the
  browser skips the CORS preflight that Apps Script web apps can't answer.

## Project layout

```
splitwise/
├── backend/
│   └── Code.gs          # Apps Script API — paste into your sheet's script editor
├── frontend/
│   ├── index.html
│   ├── styles.css       # mobile-first, no frameworks
│   ├── config.js        # ← paste your Web App URL here
│   ├── balances.js      # shared balance math (also used by tests)
│   ├── api.js           # SheetsBackend + DemoBackend adapters
│   └── app.js           # UI
└── test/
    ├── balances.test.js      # unit tests: node test/balances.test.js
    ├── gas.test.js           # backend: runs real Code.gs against sheet/Drive stubs
    ├── sheets-adapter.test.js# adapter regression (string split_among, state returns)
    └── smoke.js              # end-to-end flow vs demo backend: node test/smoke.js
```

## Setup (about 15 minutes)

**1. Create the database — a Google Sheet**
- Make a new Google Sheet (name it whatever you like, e.g. "Split it DB").
- In the sheet: **Extensions → Apps Script**. Delete the placeholder code,
  paste in the full contents of `backend/Code.gs`, save.
- In the editor's function dropdown pick **`bootstrap`** and hit Run.
  Google will ask you to authorize the script (it needs permission to edit
  *this spreadsheet only* — plus Google Drive if you want receipt uploads).
  This creates the four tabs with headers.
  > Already have a sheet from an older version? Just run `bootstrap` again:
  > it adds any new columns (e.g. `shares`, `receipt_id`) without touching
  > your existing data.

**2. Deploy the API**
- **Deploy → New deployment → Web app**
  - *Execute as:* **Me**
  - *Who has access:* **Anyone**
- Click Deploy, copy the **Web App URL**
  (`https://script.google.com/macros/s/…/exec`).
- > If you edit `Code.gs` later, you must **Deploy → Manage deployments →
  > edit → New version**, otherwise the live URL keeps running the old code.

**3. Point the frontend at it** (without committing the URL to git)
- The Apps Script URL is a public-by-design endpoint (anyone with the link
  can use the app), but there's no reason to publish it in a public repo.
  `frontend/config.js` ships with an empty `API_URL`, and the real value is
  injected at deploy time:
  - **Netlify:** Site settings → Environment variables → add
    `APPS_SCRIPT_URL` = your Web App URL, then redeploy. The build
    (`build/inject-config.js`, wired in `netlify.toml`) stamps it into the
    published files.
  - **Docker:** pass `-e API_URL=…` — the entrypoint substitutes it at
    container start.
- With the variable unset, the app runs in **demo mode**: fully usable, but
  data stays in that browser's localStorage and isn't shared.

**4. Host the frontend folder** (any static host works — it's just files)
- Easiest: drag the `frontend/` folder onto <https://app.netlify.com/drop>
- Or: GitHub Pages / Vercel / Cloudflare Pages from this repo
- Or locally for testing: `cd frontend && python3 -m http.server 8000`
- Share the resulting link with your friends. Done.

## Auto-deploying the backend (optional, one-time setup)

A GitHub Action (`.github/workflows/deploy-backend.yml`) deploys
`backend/Code.gs` to Apps Script on every push that touches it: it pushes the
code, cuts a new version, and repoints your web app deployment at it — no
more manual "New version" clicks. To enable it:

**Google Cloud (one time, ~10 min):**
1. Find the GCP project bound to your script: Apps Script editor →
   Project Settings → Google Cloud Platform (GCP) Project → click the project
   number. In the Cloud Console: APIs & Services → enable **Apps Script API**.
2. APIs & Services → Credentials → Create Credentials → OAuth client ID →
   Application type **Desktop app**. Copy the client ID and secret.
3. APIs & Services → OAuth consent screen → add your own Google account as a
   test user (the app stays in Testing mode — fine for personal use).

**Mint a refresh token (on your own machine):**
```bash
APPS_SCRIPT_CLIENT_ID=... APPS_SCRIPT_CLIENT_SECRET=... node build/get-refresh-token.js
```
Open the printed URL in the browser logged into the script-owner account,
approve, and copy the refresh token it prints.

**GitHub repo → Settings → Secrets and variables → Actions**, add:
| Secret | Value |
|---|---|
| `APPS_SCRIPT_CLIENT_ID` / `APPS_SCRIPT_CLIENT_SECRET` | from step 2 |
| `APPS_SCRIPT_REFRESH_TOKEN` | from the helper above |
| `APPS_SCRIPT_ID` | Apps Script editor → Project Settings → Script ID |
| `APPS_SCRIPT_DEPLOYMENT_ID` | the ID in your web app URL: `/macros/s/<THIS>/exec` |

That's it — the next push touching `backend/Code.gs` deploys itself. Until
then, the manual flow still works: paste `Code.gs`, Deploy → Manage
deployments → New version.

## The sheet schema

| Tab | Columns |
|---|---|
| Groups | id, name, created_at |
| Members | id, group_id, name |
| Expenses | id, group_id, description, amount_cents, paid_by, split_among (JSON), shares (JSON, optional uneven split), receipt_id (Drive file id), date, created_at |
| Settlements | id, group_id, from_id, to_id, amount_cents, date, created_at |

You can read (and fix!) everything directly in the sheet — it's your database.
IDs are UUIDs; `split_among` is a JSON array of member ids.

## Hosting on OpenMediaVault with Docker

The app is just static files served by nginx (~25 MB image, negligible RAM —
the database/API runs on Google's servers, not your NAS).

**1. Copy the project to the NAS.** Put the whole `splitwise` folder somewhere
sensible, e.g. `/srv/dev-disk-by-label-data/docker/splitwise` (via SMB, NFS,
or `scp`).

**2. Set your backend URL.** Edit `docker-compose.yml` and paste your Google
Apps Script Web App URL into `API_URL`. (It's read at container start, so you
can change it later without rebuilding.) Leave it empty for demo mode.

**3. Start it — pick one:**
- *SSH:* `cd` into the folder and run `docker compose up -d --build`.
- *OMV Compose plugin:* Services → Compose → Files → Add, paste the contents
  of `docker-compose.yml`. The plugin creates a folder for the file — copy the
  `frontend/` and `docker/` folders in next to it (same layout as this repo),
  then hit Up.

**4. Open it:** `http://<your-nas-ip>:8090`. Anyone on your home network can use
it. For friends outside your network, install Tailscale on the OMV box and have
them join your tailnet — no port forwarding needed.

### Putting it behind Caddy (HTTPS like your Immich)

Add a site block next to your Immich one:

```
split.example.com {
    reverse_proxy splitwise:80
}
```

The container joins your existing external `proxy` network (same one Caddy and
Immich use), so Caddy reaches it by container name and fetches the certificate
automatically. Fallback if that ever doesn't resolve: point at the NAS directly
with `reverse_proxy 192.168.1.80:8090`.

To update later: copy the new files over, then `docker compose up -d --build`
(or Down + Up in the plugin).

## Good to know

- **No logins.** Anyone with the link can add expenses. That's the trade-off for
  zero-friction sharing with friends — don't use it for anything sensitive, and
  don't post the link publicly.
- **Quotas.** Apps Script's free quotas (tens of thousands of requests/day) are
  far beyond what a friend group will use.
- **"You are" picker.** Each person picks their name in a group so balances read
  as "You owe…". It's stored per-browser, per-group — not a login.
- **Deleting.** Expenses and recorded payments can be deleted from the Expenses
  tab (× button, with confirmation). Groups/members can't be deleted from the UI
  yet — delete the row in the sheet if you need to.

## Ideas for later

- Unequal / percentage / shares-based splits
- Receipt photos, categories, monthly totals
- Export a group's history to CSV
- Per-group invite links instead of one global link
