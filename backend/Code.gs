/**
 * Splitwise-clone backend: a tiny JSON API on top of a Google Sheet.
 *
 * SETUP
 *  1. Create a new Google Sheet (this script must be bound to it:
 *     Extensions > Apps Script from that sheet, then paste this file).
 *  2. Deploy > New deployment > Web app:
 *       Execute as: Me
 *       Who has access: Anyone
 *  3. Schema migrations run themselves: every deploy POSTs
 *     {action:'bootstrap'} to the live URL, which creates the
 *     Groups / Members / Expenses / Settlements tabs with headers and
 *     adds any missing columns without touching existing data.
 *     (You can also run `bootstrap` manually from the editor.)
 *  4. Copy the Web App URL into the frontend's config.js as API_URL.
 *     After editing this file, redeploy as a NEW VERSION or the live URL
 *     keeps running the old code. The receipts feature needs Drive access,
 *     so Google will ask you to re-authorize on the first deploy that
 *     includes it.
 *
 * API
 *  GET  ?action=state
 *       -> { ok:true, state:{ groups, members, expenses, settlements } }
 *  POST { action:'createGroup', id?, name }                 -> { ok, group, state }
 *  POST { action:'addMember', id?, groupId, name, venmo? } -> { ok, member, state }
 *       venmo is an optional Venmo handle (stored without a leading "@").
 *  POST { action:'addMembers', groupId, members:[{id?, name, venmo?}] }
 *       -> { ok, members:[added], skipped, state }
 *       Batch add. Members whose normalized name is already in the group are
 *       skipped (counted in `skipped`), so the call is safe to retry.
 *  POST { action:'addExpense', id?, groupId, description, amountCents,
 *                          paidBy, splitAmong:[ids], shares?({id:cents}),
 *                          date }                           -> { ok, expense, state }
 *  POST { action:'updateExpense', id, groupId, description, amountCents,
 *                          paidBy, splitAmong:[ids], shares?({id:cents}),
 *                          date }                           -> { ok, expense, state }
 *       Edits an existing expense in place (receipt and created_at kept).
 *  POST { action:'addSettlement', id?, groupId, fromId, toId, amountCents, date }
 *       -> { ok, settlement, state }
 *  POST { action:'deleteExpense', id }                      -> { ok, state }
 *  POST { action:'deleteSettlement', id }                   -> { ok, state }
 *  POST { action:'deleteGroup', id }                        -> { ok, state }
 *       Deletes are SOFT: the row is flagged as deleted and hidden from
 *       reads, but never removed from the sheet. Deleting twice is a no-op.
 *
 *  Every mutating POST also appends one row to the `activity` tab
 *  (who-did-what audit log). Idempotent retries are not logged twice.
 *  POST { action:'uploadReceipt', expenseId, name?, mimeType?, data(base64) }
 *       -> { ok, receiptId, state }
 *
 * Every POST returns the fresh full state, so clients need only one request
 * per action. Clients may supply `id` (a UUID they generated); writes are
 * idempotent on it, so a retried request never creates a duplicate row.
 * `shares` is an optional per-person split ({memberId: cents}); it must add
 * up to amountCents. Without it, the amount splits equally among splitAmong.
 *
 * All money is integer cents. All responses are JSON.
 * POST bodies must be sent as text/plain (no Content-Type header) so the
 * browser does not send a CORS preflight, which Apps Script web apps
 * cannot answer.
 */

var TABS = {
  groups:      ['id', 'name', 'created_at', 'deleted'],
  members:     ['id', 'group_id', 'name', 'venmo', 'deleted'],
  expenses:    ['id', 'group_id', 'description', 'amount_cents', 'paid_by',
                'split_among', 'shares', 'receipt_id', 'date', 'created_at', 'deleted'],
  settlements: ['id', 'group_id', 'from_id', 'to_id', 'amount_cents',
                'date', 'created_at', 'deleted'],
  // Append-only audit log. Every mutating action writes one row here
  // (idempotent retries and no-op deletes are not logged twice).
  activity:    ['id', 'group_id', 'action', 'target_id', 'details', 'created_at'],
};

/** Columns stored as JSON text in the sheet. */
var JSON_COLS = ['split_among', 'shares'];

/** Run once from the editor. Creates tabs; on existing tabs adds any columns
 *  introduced by newer versions without touching existing data. */
function bootstrap() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function (tab) {
    var sheet = ss.getSheetByName(tab) || ss.insertSheet(tab);
    var want = TABS[tab];
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(want);
      sheet.setFrozenRows(1);
      return;
    }
    var have = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
    want.forEach(function (h) {
      if (have.indexOf(h) === -1) {
        sheet.getRange(1, have.length + 1).setValue(h);
        have.push(h);
      }
    });
  });
}

/* ---------------- request handling ---------------- */

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || '';
    if (action === 'state') return json_({ ok: true, state: readDb() });
    return json_({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (body.action === 'bootstrap') {
      // Runs before readDb: on a fresh or outdated sheet readDb would throw
      // for missing tabs/columns. Idempotent — only creates tabs and appends
      // missing columns, never touches existing data.
      bootstrap();
      return json_({ ok: true });
    }
    var db = readDb(ss); // each tab read exactly once per request
    var out;
    switch (body.action) {
      case 'createGroup':      out = createGroup_(ss, db, body);      break;
      case 'updateGroup':      out = updateGroup_(ss, db, body);      break;
      case 'addMember':        out = addMember_(ss, db, body);        break;
      case 'addMembers':       out = addMembers_(ss, db, body);       break;
      case 'updateMember':     out = updateMember_(ss, db, body);     break;
      case 'deleteMember':     out = deleteMember_(ss, db, body);     break;
      case 'addExpense':       out = addExpense_(ss, db, body);       break;
      case 'updateExpense':    out = updateExpense_(ss, db, body);    break;
      case 'addSettlement':    out = addSettlement_(ss, db, body);   break;
      case 'deleteExpense':    out = deleteExpense_(ss, db, body);    break;
      case 'deleteSettlement': out = deleteSettlement_(ss, db, body); break;
      case 'deleteGroup':      out = deleteGroup_(ss, db, body);      break;
      case 'uploadReceipt':    out = uploadReceipt_(ss, db, body);    break;
      default: return json_({ ok: false, error: 'unknown action: ' + body.action });
    }
    out.ok = true;
    out.state = db; // db was updated in-memory by the action; lock was held throughout
    if (!out.duplicate && !out.alreadyDeleted) logActivity_(ss, body, out);
    return json_(out);
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- storage helpers ---------------- */

function sheet_(ss, tab) {
  var sheet = ss.getSheetByName(tab);
  if (!sheet) throw new Error('missing tab "' + tab + '" — run bootstrap() first');
  return sheet;
}

function headersOf_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
}

function rowsIn_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(String);
  return values.slice(1).map(function (r) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = r[i]; });
    return obj;
  });
}

/** Append using the sheet's actual header order, so column order never matters. */
function appendObj_(ss, tab, obj) {
  var sheet = sheet_(ss, tab);
  var headers = headersOf_(sheet);
  sheet.appendRow(headers.map(function (h) {
    var v = obj[h];
    if (v === undefined || v === null) return '';
    if (JSON_COLS.indexOf(h) !== -1) return JSON.stringify(v);
    return v;
  }));
}

/** Update one cell identified by row id + column header. */
function setCellById_(ss, tab, id, header, value) {
  var sheet = sheet_(ss, tab);
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(String);
  var col = headers.indexOf(header);
  if (col === -1) throw new Error('missing column "' + header + '" — run bootstrap()');
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(id)) {
      sheet.getRange(r + 1, col + 1).setValue(value);
      return;
    }
  }
  throw new Error('not found');
}

/** Sheets may auto-convert "2026-10-17" text into Date objects; normalize. */
function dateStr_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    try { return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
    catch (_) { /* fall through to string handling */ }
  }
  return String(v == null ? '' : v).slice(0, 10);
}

function parseJsonCol_(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function parseExpense_(e) {
  e.amount_cents = Number(e.amount_cents);
  var sm = parseJsonCol_(e.split_among);
  e.split_among = Array.isArray(sm) ? sm.map(String) : [];
  var sh = parseJsonCol_(e.shares);
  e.shares = (sh && typeof sh === 'object' && !Array.isArray(sh)) ? sh : null;
  e.receipt_id = String(e.receipt_id || '');
  e.date = dateStr_(e.date);
  return e;
}

function parseSettlement_(s) {
  s.amount_cents = Number(s.amount_cents);
  s.date = dateStr_(s.date);
  return s;
}

/** Read every tab once; returns parsed rows in sheet (snake_case) shape.
 *  Soft-deleted rows (deleted flag set) are hidden from clients but stay
 *  in the sheet. */
function readDb(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  return {
    groups: rowsIn_(sheet_(ss, 'groups')).filter(function (r) { return !isDeleted_(r); }),
    members: rowsIn_(sheet_(ss, 'members')).filter(function (r) { return !isDeleted_(r); }),
    expenses: rowsIn_(sheet_(ss, 'expenses')).filter(function (r) { return !isDeleted_(r); }).map(parseExpense_),
    settlements: rowsIn_(sheet_(ss, 'settlements')).filter(function (r) { return !isDeleted_(r); }).map(parseSettlement_),
  };
}

/** Soft-delete flag: rows are hidden, never removed from the sheet. */
function isDeleted_(r) {
  var v = r.deleted;
  return v === 1 || v === true || v === '1' || v === 'true';
}

/** Raw (unfiltered) rows of a tab, for idempotent delete retries. */
function rawRows_(ss, tab) {
  return rowsIn_(sheet_(ss, tab));
}

function now_() { return new Date().toISOString(); }
function uuid_() { return Utilities.getUuid(); }

function findById_(rows, id) {
  id = String(id);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === id) return rows[i];
  }
  return null;
}

/* ---------------- validation ---------------- */

function need_(body, fields) {
  fields.forEach(function (f) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      throw new Error('missing field: ' + f);
    }
  });
}

/** Client-supplied id (for idempotent retries), or a fresh UUID. */
function id_(v) {
  if (v === undefined || v === null || v === '') return uuid_();
  var s = String(v);
  if (s.length > 64) throw new Error('bad id');
  return s;
}

function getGroup_(db, groupId) {
  var g = findById_(db.groups, groupId);
  if (!g) throw new Error('unknown group');
  return g;
}

function checkMembers_(db, groupId, ids) {
  var valid = {};
  db.members.forEach(function (m) {
    if (String(m.group_id) === String(groupId)) valid[String(m.id)] = true;
  });
  (ids || []).forEach(function (id) {
    if (!valid[String(id)]) throw new Error('member not in group: ' + id);
  });
}

function assertCents_(v) {
  var n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error('amount must be a positive integer number of cents');
  return n;
}

function cleanName_(v, max) {
  var s = String(v).trim().slice(0, max);
  if (!s) throw new Error('name cannot be blank');
  return s;
}

/** Venmo handle: strip a leading "@", keep it to handle-safe characters. */
function cleanVenmo_(v) {
  if (v === undefined || v === null) return '';
  var s = String(v).trim().replace(/^@+/, '');
  if (!s) return '';
  if (!/^[A-Za-z0-9._-]{1,30}$/.test(s)) throw new Error('bad venmo handle: ' + v);
  return s;
}

/** Member names are normalized to title case so "jiashu wang" and
 *  "Jiashu Wang" are recognized as the same person everywhere. */
function normalizeMemberName_(v) {
  var parts = String(v).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error('name cannot be blank');
  return parts.map(function (w) {
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ').slice(0, 40);
}

/** Validate uneven shares: {memberId: cents}, must total amountCents. */
function parseShares_(v, db, groupId, amountCents) {
  if (v === undefined || v === null || v === '') return null;
  var obj = (typeof v === 'object') ? v : JSON.parse(v);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('shares must be an object of member id to cents');
  }
  var ids = Object.keys(obj);
  if (!ids.length) return null;
  var sum = 0;
  var clean = {};
  ids.forEach(function (id) {
    var n = Number(obj[id]);
    if (!Number.isInteger(n) || n < 0) throw new Error('shares must be non-negative integer cents');
    clean[String(id)] = n;
    sum += n;
  });
  if (sum !== amountCents) throw new Error('shares must add up to the total amount');
  checkMembers_(db, groupId, ids);
  return clean;
}

/* ---------------- actions ---------------- */

function createGroup_(ss, db, body) {
  var id = id_(body.id);
  var existing = findById_(db.groups, id);
  if (existing) return { group: existing, duplicate: true };
  var g = { id: id, name: cleanName_(body.name, 80), created_at: now_() };
  appendObj_(ss, 'groups', g);
  db.groups.push(g);
  return { group: g };
}

/** Rename a group in place. */
function updateGroup_(ss, db, body) {
  if (!body.id) throw new Error('missing field: id');
  var g = getGroup_(db, body.id);
  var name = cleanName_(body.name, 80);
  setCellById_(ss, 'groups', g.id, 'name', name);
  g.name = name;
  return { group: g };
}

function addMember_(ss, db, body) {
  need_(body, ['groupId']);
  getGroup_(db, body.groupId);
  var id = id_(body.id);
  var existing = findById_(db.members, id);
  if (existing) return { member: existing, duplicate: true };
  var name = normalizeMemberName_(body.name);
  var dupe = db.members.some(function (m) {
    return String(m.group_id) === String(body.groupId) &&
           normalizeMemberName_(m.name) === name;
  });
  if (dupe) throw new Error('that name is already in this group');
  var m = { id: id, group_id: String(body.groupId), name: name, venmo: cleanVenmo_(body.venmo) };
  appendObj_(ss, 'members', m);
  db.members.push(m);
  return { member: m };
}

/** Batch add members. Skips names already in the group (counted in
 *  `skipped`) instead of failing, so the call is safe to retry. */
function addMembers_(ss, db, body) {
  need_(body, ['groupId', 'members']);
  getGroup_(db, body.groupId);
  if (!Array.isArray(body.members) || !body.members.length) {
    throw new Error('members must be a non-empty array');
  }
  if (body.members.length > 50) throw new Error('too many members at once (max 50)');
  var seen = {};
  db.members.forEach(function (m) {
    if (String(m.group_id) === String(body.groupId)) {
      seen[normalizeMemberName_(m.name)] = true;
    }
  });
  var added = [], skipped = 0;
  body.members.forEach(function (raw) {
    var name = normalizeMemberName_(raw.name);
    if (seen[name]) { skipped++; return; }
    var id = id_(raw.id);
    var existing = findById_(db.members, id);
    if (existing) { skipped++; return; }
    var m = {
      id: id, group_id: String(body.groupId), name: name,
      venmo: cleanVenmo_(raw.venmo),
    };
    appendObj_(ss, 'members', m);
    db.members.push(m);
    seen[name] = true;
    added.push(m);
  });
  return { members: added, skipped: skipped };
}

/** Edit a member in place: rename and/or set the Venmo handle ('' clears
 *  it). Renames reject when another member of the same group already has
 *  the name, so two people can never collide under one identity. */
function updateMember_(ss, db, body) {
  if (!body.id) throw new Error('missing field: id');
  var m = findById_(db.members, body.id);
  if (!m) throw new Error('unknown member');
  var updates = {};
  if (body.name !== undefined) {
    var name = normalizeMemberName_(body.name);
    var dupe = db.members.some(function (x) {
      return String(x.id) !== String(m.id) &&
             String(x.group_id) === String(m.group_id) &&
             normalizeMemberName_(x.name) === name;
    });
    if (dupe) throw new Error('that name is already in this group');
    updates.name = name;
  }
  if (body.venmo !== undefined) updates.venmo = cleanVenmo_(body.venmo);
  if (!Object.keys(updates).length) return { member: m };
  var sheet = sheet_(ss, 'members');
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(String);
  var row = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(body.id)) { row = r + 1; break; }
  }
  if (row === -1) throw new Error('unknown member');
  Object.keys(updates).forEach(function (h) {
    var c = headers.indexOf(h);
    if (c === -1) throw new Error('missing column "' + h + '" — run bootstrap()');
    sheet.getRange(row, c + 1).setValue(updates[h]);
  });
  Object.keys(updates).forEach(function (h) { m[h] = updates[h]; });
  return { member: m };
}

/** Soft-delete a member, but only when they have no expenses or payments in
 *  the group — otherwise balances would dangle. The row is flagged, never
 *  removed. Idempotent — deleting twice is a no-op. */
function deleteMember_(ss, db, body) {
  if (!body.id) throw new Error('missing field: id');
  var m = findById_(db.members, body.id);
  if (!m) {
    var existed = rawRows_(ss, 'members').some(function (r) { return String(r.id) === String(body.id); });
    if (!existed) throw new Error('unknown member');
    return { alreadyDeleted: true }; // idempotent no-op
  }
  var active =
    db.expenses.some(function (e) {
      return String(e.paid_by) === String(m.id) ||
             e.split_among.map(String).indexOf(String(m.id)) !== -1;
    }) ||
    db.settlements.some(function (s) {
      return String(s.from_id) === String(m.id) || String(s.to_id) === String(m.id);
    });
  if (active) throw new Error('member has expenses or payments and cannot be removed');
  softDelete_(ss, db, 'members', db.members, body.id);
  db.members = db.members.filter(function (x) { return String(x.id) !== String(m.id); });
  return { memberId: m.id };
}

function addExpense_(ss, db, body) {
  need_(body, ['groupId', 'description', 'amountCents', 'paidBy', 'splitAmong', 'date']);
  var id = id_(body.id);
  var existing = findById_(db.expenses, id);
  if (existing) return { expense: existing, duplicate: true };
  var cents = assertCents_(body.amountCents);
  var splitAmong = body.splitAmong.map(String);
  if (!splitAmong.length) throw new Error('splitAmong cannot be empty');
  getGroup_(db, body.groupId);
  checkMembers_(db, body.groupId, splitAmong.concat([body.paidBy]));
  var shares = parseShares_(body.shares, db, body.groupId, cents);
  if (shares) {
    var shareIds = Object.keys(shares);
    if (!shareIds.length) throw new Error('shares cannot be empty');
  }
  var ex = {
    id: id,
    group_id: String(body.groupId),
    description: String(body.description).trim().slice(0, 120) || 'Expense',
    amount_cents: cents,
    paid_by: String(body.paidBy),
    split_among: splitAmong,
    shares: shares,
    receipt_id: '',
    date: dateStr_(body.date),
    created_at: now_(),
  };
  appendObj_(ss, 'expenses', ex);
  db.expenses.push(ex);
  return { expense: ex };
}

/** Edit an expense in place. receipt_id and created_at are left untouched. */
function updateExpense_(ss, db, body) {
  need_(body, ['id', 'groupId', 'description', 'amountCents', 'paidBy', 'splitAmong', 'date']);
  var ex = findById_(db.expenses, body.id);
  if (!ex) throw new Error('unknown expense');
  var cents = assertCents_(body.amountCents);
  var splitAmong = body.splitAmong.map(String);
  if (!splitAmong.length) throw new Error('splitAmong cannot be empty');
  getGroup_(db, body.groupId);
  checkMembers_(db, body.groupId, splitAmong.concat([body.paidBy]));
  var shares = parseShares_(body.shares, db, body.groupId, cents);
  var sheet = sheet_(ss, 'expenses');
  var values = sheet.getDataRange().getValues();
  var headers = values[0].map(String);
  var row = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(body.id)) { row = r + 1; break; }
  }
  if (row === -1) throw new Error('unknown expense');
  var updates = {
    description: String(body.description).trim().slice(0, 120) || 'Expense',
    amount_cents: cents,
    paid_by: String(body.paidBy),
    split_among: JSON.stringify(splitAmong),
    shares: shares ? JSON.stringify(shares) : '',
    date: dateStr_(body.date),
  };
  Object.keys(updates).forEach(function (h) {
    var c = headers.indexOf(h);
    if (c === -1) throw new Error('missing column "' + h + '" — run bootstrap()');
    sheet.getRange(row, c + 1).setValue(updates[h]);
  });
  ex.description = updates.description;
  ex.amount_cents = cents;
  ex.paid_by = updates.paid_by;
  ex.split_among = splitAmong;
  ex.shares = shares;
  ex.date = updates.date;
  return { expense: ex };
}

function addSettlement_(ss, db, body) {
  need_(body, ['groupId', 'fromId', 'toId', 'amountCents', 'date']);
  var id = id_(body.id);
  var existing = findById_(db.settlements, id);
  if (existing) return { settlement: existing, duplicate: true };
  if (String(body.fromId) === String(body.toId)) {
    throw new Error('a settlement needs two different people');
  }
  var cents = assertCents_(body.amountCents);
  getGroup_(db, body.groupId);
  checkMembers_(db, body.groupId, [body.fromId, body.toId]);
  var s = {
    id: id,
    group_id: String(body.groupId),
    from_id: String(body.fromId),
    to_id: String(body.toId),
    amount_cents: cents,
    date: dateStr_(body.date),
    created_at: now_(),
  };
  appendObj_(ss, 'settlements', s);
  db.settlements.push(s);
  return { settlement: s };
}

/** Soft delete: flag the row as deleted; it stays in the sheet but is
 *  hidden from reads. Idempotent — deleting twice is a no-op. */
function softDelete_(ss, db, tab, rows, id) {
  if (!id) throw new Error('missing field: id');
  var live = findById_(rows, id);
  if (!live) {
    var existed = rawRows_(ss, tab).some(function (r) { return String(r.id) === String(id); });
    if (!existed) throw new Error('not found');
    return { alreadyDeleted: true }; // idempotent no-op
  }
  setCellById_(ss, tab, id, 'deleted', '1');
  return {};
}

function deleteExpense_(ss, db, body) {
  var r = softDelete_(ss, db, 'expenses', db.expenses, body.id);
  if (r && r.alreadyDeleted) return r;
  db.expenses = db.expenses.filter(function (x) { return String(x.id) !== String(body.id); });
  return {};
}

function deleteSettlement_(ss, db, body) {
  var r = softDelete_(ss, db, 'settlements', db.settlements, body.id);
  if (r && r.alreadyDeleted) return r;
  db.settlements = db.settlements.filter(function (x) { return String(x.id) !== String(body.id); });
  return {};
}

/** Soft-delete a whole group (its row is flagged, never removed). */
function deleteGroup_(ss, db, body) {
  if (!body.id) throw new Error('missing field: id');
  var g = findById_(db.groups, body.id);
  if (!g) {
    var existed = rawRows_(ss, 'groups').some(function (r) { return String(r.id) === String(body.id); });
    if (!existed) throw new Error('unknown group');
    return { alreadyDeleted: true }; // idempotent no-op
  }
  setCellById_(ss, 'groups', body.id, 'deleted', '1');
  db.groups = db.groups.filter(function (x) { return String(x.id) !== String(body.id); });
  return {};
}

/* ---------------- activity log ---------------- */

/** Make sure the activity tab exists with the right headers (self-healing,
 *  so no manual bootstrap run is needed after upgrading). */
function ensureActivityTab_(ss) {
  var sheet = ss.getSheetByName('activity');
  if (!sheet) {
    sheet = ss.insertSheet('activity');
    sheet.appendRow(TABS.activity);
    sheet.setFrozenRows(1);
    return sheet;
  }
  var have = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  TABS.activity.forEach(function (h) {
    if (have.indexOf(h) === -1) {
      sheet.getRange(1, have.length + 1).setValue(h);
      have.push(h);
    }
  });
  return sheet;
}

/** Append one audit row per mutating action. Called from doPost; idempotent
 *  retries and no-op deletes are skipped by the caller. */
function logActivity_(ss, body, out) {
  ensureActivityTab_(ss);
  var details = {};
  switch (body.action) {
    case 'createGroup':
    case 'updateGroup':
      details = { name: body.name };
      break;
    case 'addMember':
      details = { name: body.name, venmo: body.venmo || '' };
      break;
    case 'addMembers':
      details = {
        added: (out.members || []).map(function (m) { return m.name; }),
        skipped: out.skipped || 0,
      };
      break;
    case 'addExpense':
    case 'updateExpense':
      details = {
        description: body.description, amount_cents: body.amountCents,
        paid_by: body.paidBy,
      };
      break;
    case 'addSettlement':
      details = {
        from_id: body.fromId, to_id: body.toId, amount_cents: body.amountCents,
      };
      break;
    case 'uploadReceipt':
      details = { expense_id: body.expenseId, name: body.name || '' };
      break;
    case 'updateMember':
      details = { name: body.name, venmo: body.venmo };
      break;
    // deleteExpense / deleteSettlement / deleteGroup / deleteMember:
    // target id is enough
  }
  var target = body.id || body.expenseId ||
    (out.group && out.group.id) || (out.member && out.member.id) ||
    (out.expense && out.expense.id) || (out.settlement && out.settlement.id) || '';
  appendObj_(ss, 'activity', {
    id: uuid_(),
    group_id: String(body.groupId || ''),
    action: String(body.action),
    target_id: String(target),
    details: JSON.stringify(details),
    created_at: now_(),
  });
}

/* ---------------- receipts ---------------- */

function receiptFolder_() {
  var it = DriveApp.getFoldersByName('Split Expenses Receipts');
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder('Split Expenses Receipts');
}

/** Body: { expenseId, name?, mimeType?, data } where data is base64 (no prefix). */
function uploadReceipt_(ss, db, body) {
  need_(body, ['expenseId', 'data']);
  var ex = findById_(db.expenses, body.expenseId);
  if (!ex) throw new Error('unknown expense');
  var bytes = Utilities.base64Decode(String(body.data));
  if (bytes.length > 15 * 1024 * 1024) throw new Error('receipt too large (max 15MB)');
  var blob = Utilities.newBlob(bytes, body.mimeType || 'image/jpeg', body.name || 'receipt.jpg');
  var file = receiptFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var fid = file.getId();
  setCellById_(ss, 'expenses', ex.id, 'receipt_id', fid);
  ex.receipt_id = fid;
  return { receiptId: fid };
}
