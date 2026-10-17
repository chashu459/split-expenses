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
- Splits are equal shares; leftover cents go to the first person in the split.
- Balances collapse into the fewest payments with a greedy min-cash-flow pass.
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
    ├── balances.test.js # unit tests: node test/balances.test.js
    └── smoke.js         # end-to-end flow vs demo backend: node test/smoke.js
```

## Setup (about 15 minutes)

**1. Create the database — a Google Sheet**
- Make a new Google Sheet (name it whatever you like, e.g. "Split it DB").
- In the sheet: **Extensions → Apps Script**. Delete the placeholder code,
  paste in the full contents of `backend/Code.gs`, save.
- In the editor's function dropdown pick **`bootstrap`** and hit Run.
  Google will ask you to authorize the script (it needs permission to edit
  *this spreadsheet only*). This creates the four tabs with headers.

**2. Deploy the API**
- **Deploy → New deployment → Web app**
  - *Execute as:* **Me**
  - *Who has access:* **Anyone**
- Click Deploy, copy the **Web App URL**
  (`https://script.google.com/macros/s/…/exec`).
- > If you edit `Code.gs` later, you must **Deploy → Manage deployments →
  > edit → New version**, otherwise the live URL keeps running the old code.

**3. Point the frontend at it**
- Open `frontend/config.js` and paste the URL:
  ```js
  const API_URL = "https://script.google.com/macros/s/…/exec";
  ```
- With the URL empty, the app runs in **demo mode**: fully usable, but data
  stays in that browser's localStorage and isn't shared.

**4. Host the frontend folder** (any static host works — it's just files)
- Easiest: drag the `frontend/` folder onto <https://app.netlify.com/drop>
- Or: GitHub Pages / Vercel / Cloudflare Pages from this repo
- Or locally for testing: `cd frontend && python3 -m http.server 8000`
- Share the resulting link with your friends. Done.

## The sheet schema

| Tab | Columns |
|---|---|
| Groups | id, name, created_at |
| Members | id, group_id, name |
| Expenses | id, group_id, description, amount_cents, paid_by, split_among (JSON), date, created_at |
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
