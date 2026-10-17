/**
 * Splitwise-clone backend: a tiny JSON API on top of a Google Sheet.
 *
 * SETUP
 *  1. Create a new Google Sheet (this script must be bound to it:
 *     Extensions > Apps Script from that sheet, then paste this file).
 *  2. Run `bootstrap` once from the Apps Script editor (it creates the
 *     Groups / Members / Expenses / Settlements tabs with headers).
 *  3. Deploy > New deployment > Web app:
 *       Execute as: Me
 *       Who has access: Anyone
 *     Copy the Web App URL into the frontend's config.js as API_URL.
 *     After editing this file, redeploy as a NEW VERSION or the live URL
 *     keeps running the old code.
 *
 * API
 *  GET  ?action=state
 *       -> { ok:true, state:{ groups, members, expenses, settlements } }
 *  POST { action:'createGroup', id?, name }                 -> { ok, group, state }
 *  POST { action:'addMember', id?, groupId, name }          -> { ok, member, state }
 *  POST { action:'addExpense', id?, groupId, description,
 *                          amountCents, paidBy, splitAmong:[ids], date }
 *       -> { ok, expense, state }
 *  POST { action:'addSettlement', id?, groupId, fromId, toId, amountCents, date }
 *       -> { ok, settlement, state }
 *  POST { action:'deleteExpense', id }                      -> { ok, state }
 *  POST { action:'deleteSettlement', id }                   -> { ok, state }
 *
 * Every POST returns the fresh full state, so clients need only one request
 * per action. Clients may supply `id` (a UUID they generated); writes are
 * idempotent on it, so a retried request never creates a duplicate row.
 *
 * All money is integer cents. All responses are JSON.
 * POST bodies must be sent as text/plain (no Content-Type header) so the
 * browser does not send a CORS preflight, which Apps Script web apps
 * cannot answer.
 */

var TABS = {
  groups:      ['id', 'name', 'created_at'],
  members:     ['id', 'group_id', 'name'],
  expenses:    ['id', 'group_id', 'description', 'amount_cents', 'paid_by',
                'split_among', 'date', 'created_at'],
  settlements: ['id', 'group_id', 'from_id', 'to_id', 'amount_cents',
                'date', 'created_at'],
};

/** Run once from the editor to create tabs + headers. */
function bootstrap() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function (tab) {
    var sheet = ss.getSheetByName(tab) || ss.insertSheet(tab);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(TABS[tab]);
      sheet.setFrozenRows(1);
    }
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
    var db = readDb(ss); // each tab read exactly once per request
    var out;
    switch (body.action) {
      case 'createGroup':      out = createGroup_(ss, db, body);      break;
      case 'addMember':        out = addMember_(ss, db, body);        break;
      case 'addExpense':       out = addExpense_(ss, db, body);      break;
      case 'addSettlement':    out = addSettlement_(ss, db, body);   break;
      case 'deleteExpense':    out = deleteExpense_(ss, db, body);    break;
      case 'deleteSettlement': out = deleteSettlement_(ss, db, body); break;
      default: return json_({ ok: false, error: 'unknown action: ' + body.action });
    }
    out.ok = true;
    out.state = db; // db was updated in-memory by the action; lock was held throughout
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

function parseExpense_(e) {
  e.amount_cents = Number(e.amount_cents);
  try { e.split_among = JSON.parse(e.split_among); }
  catch (_) { e.split_among = []; }
  if (!Array.isArray(e.split_among)) e.split_among = [];
  return e;
}

function parseSettlement_(s) {
  s.amount_cents = Number(s.amount_cents);
  return s;
}

/** Read every tab once; returns parsed rows in sheet (snake_case) shape. */
function readDb(ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  return {
    groups: rowsIn_(sheet_(ss, 'groups')),
    members: rowsIn_(sheet_(ss, 'members')),
    expenses: rowsIn_(sheet_(ss, 'expenses')).map(parseExpense_),
    settlements: rowsIn_(sheet_(ss, 'settlements')).map(parseSettlement_),
  };
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

/* ---------------- actions ---------------- */

function createGroup_(ss, db, body) {
  var id = id_(body.id);
  var existing = findById_(db.groups, id);
  if (existing) return { group: existing, duplicate: true };
  var g = { id: id, name: cleanName_(body.name, 80), created_at: now_() };
  sheet_(ss, 'groups').appendRow([g.id, g.name, g.created_at]);
  db.groups.push(g);
  return { group: g };
}

function addMember_(ss, db, body) {
  need_(body, ['groupId']);
  getGroup_(db, body.groupId);
  var id = id_(body.id);
  var existing = findById_(db.members, id);
  if (existing) return { member: existing, duplicate: true };
  var name = cleanName_(body.name, 40);
  var dupe = db.members.some(function (m) {
    return String(m.group_id) === String(body.groupId) &&
           String(m.name).toLowerCase() === name.toLowerCase();
  });
  if (dupe) throw new Error('that name is already in this group');
  var m = { id: id, group_id: String(body.groupId), name: name };
  sheet_(ss, 'members').appendRow([m.id, m.group_id, m.name]);
  db.members.push(m);
  return { member: m };
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
  var ex = {
    id: id,
    group_id: String(body.groupId),
    description: String(body.description).trim().slice(0, 120) || 'Expense',
    amount_cents: cents,
    paid_by: String(body.paidBy),
    split_among: splitAmong,
    date: String(body.date).slice(0, 10),
    created_at: now_(),
  };
  sheet_(ss, 'expenses').appendRow([
    ex.id, ex.group_id, ex.description, ex.amount_cents, ex.paid_by,
    JSON.stringify(ex.split_among), ex.date, ex.created_at,
  ]);
  db.expenses.push(ex);
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
    date: String(body.date).slice(0, 10),
    created_at: now_(),
  };
  sheet_(ss, 'settlements').appendRow([
    s.id, s.group_id, s.from_id, s.to_id, s.amount_cents, s.date, s.created_at,
  ]);
  db.settlements.push(s);
  return { settlement: s };
}

function deleteExpense_(ss, db, body) {
  if (!body.id) throw new Error('missing field: id');
  var sheet = sheet_(ss, 'expenses');
  var values = sheet.getDataRange().getValues();
  var found = false;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(body.id)) {
      sheet.deleteRow(r + 1);
      found = true;
      break;
    }
  }
  if (!found) throw new Error('not found');
  db.expenses = db.expenses.filter(function (x) { return String(x.id) !== String(body.id); });
  return {};
}

function deleteSettlement_(ss, db, body) {
  if (!body.id) throw new Error('missing field: id');
  var sheet = sheet_(ss, 'settlements');
  var values = sheet.getDataRange().getValues();
  var found = false;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(body.id)) {
      sheet.deleteRow(r + 1);
      found = true;
      break;
    }
  }
  if (!found) throw new Error('not found');
  db.settlements = db.settlements.filter(function (x) { return String(x.id) !== String(body.id); });
  return {};
}
