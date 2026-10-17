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
 *
 * API
 *  GET  ?action=state
 *       -> { ok:true, groups:[], members:[], expenses:[], settlements:[] }
 *  POST { action:'createGroup', name }
 *  POST { action:'addMember', groupId, name }
 *  POST { action:'addExpense', groupId, description, amountCents, paidBy,
 *                          splitAmong:[memberId...], date }
 *  POST { action:'addSettlement', groupId, fromId, toId, amountCents, date }
 *  POST { action:'deleteExpense', id }
 *  POST { action:'deleteSettlement', id }
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
    if (action === 'state') return json_({ ok: true, state: readState_() });
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
    var out;
    switch (body.action) {
      case 'createGroup':    out = createGroup_(body);    break;
      case 'addMember':      out = addMember_(body);      break;
      case 'addExpense':     out = addExpense_(body);     break;
      case 'addSettlement':  out = addSettlement_(body);  break;
      case 'deleteExpense':  out = deleteRow_(TABS.expenses, 'expenses', body.id);    break;
      case 'deleteSettlement': out = deleteRow_(TABS.settlements, 'settlements', body.id); break;
      default: return json_({ ok: false, error: 'unknown action: ' + body.action });
    }
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

function sheet_(tab) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(tab);
  if (!sheet) throw new Error('missing tab "' + tab + '" — run bootstrap() first');
  return sheet;
}

function rows_(tab) {
  var sheet = sheet_(tab);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(String);
  return values.slice(1).map(function (r) {
    var obj = {};
    headers.forEach(function (h, i) { obj[h] = r[i]; });
    return obj;
  });
}

function readState_() {
  return {
    groups: rows_('groups'),
    members: rows_('members'),
    expenses: rows_('expenses').map(function (e) {
      e.amount_cents = Number(e.amount_cents);
      try { e.split_among = JSON.parse(e.split_among); }
      catch (_) { e.split_among = []; }
      return e;
    }),
    settlements: rows_('settlements').map(function (s) {
      s.amount_cents = Number(s.amount_cents);
      return s;
    }),
  };
}

function now_() { return new Date().toISOString(); }
function uuid_() { return Utilities.getUuid(); }

/* ---------------- validation ---------------- */

function need_(body, fields) {
  fields.forEach(function (f) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      throw new Error('missing field: ' + f);
    }
  });
}

function groupExists_(groupId) {
  return rows_('groups').some(function (g) { return String(g.id) === String(groupId); });
}

function memberIds_(groupId) {
  var ids = {};
  rows_('members').forEach(function (m) {
    if (String(m.group_id) === String(groupId)) ids[String(m.id)] = true;
  });
  return ids;
}

function assertGroupAndMembers_(groupId, ids) {
  if (!groupExists_(groupId)) throw new Error('unknown group');
  var valid = memberIds_(groupId);
  (ids || []).forEach(function (id) {
    if (!valid[String(id)]) throw new Error('member not in group: ' + id);
  });
}

function assertCents_(v) {
  var n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error('amount must be a positive integer number of cents');
  return n;
}

/* ---------------- actions ---------------- */

function createGroup_(body) {
  need_(body, ['name']);
  var g = { id: uuid_(), name: String(body.name).slice(0, 80), created_at: now_() };
  sheet_('groups').appendRow([g.id, g.name, g.created_at]);
  return { ok: true, group: g };
}

function addMember_(body) {
  need_(body, ['groupId', 'name']);
  if (!groupExists_(body.groupId)) throw new Error('unknown group');
  var name = String(body.name).trim().slice(0, 40);
  if (!name) throw new Error('name cannot be blank');
  var dupe = rows_('members').some(function (m) {
    return String(m.group_id) === String(body.groupId) &&
           String(m.name).toLowerCase() === name.toLowerCase();
  });
  if (dupe) throw new Error('that name is already in this group');
  var m = { id: uuid_(), group_id: String(body.groupId), name: name };
  sheet_('members').appendRow([m.id, m.group_id, m.name]);
  return { ok: true, member: m };
}

function addExpense_(body) {
  need_(body, ['groupId', 'description', 'amountCents', 'paidBy', 'splitAmong', 'date']);
  var cents = assertCents_(body.amountCents);
  var splitAmong = body.splitAmong.map(String);
  if (!splitAmong.length) throw new Error('splitAmong cannot be empty');
  assertGroupAndMembers_(body.groupId, splitAmong.concat([body.paidBy]));
  var ex = {
    id: uuid_(),
    group_id: String(body.groupId),
    description: String(body.description).trim().slice(0, 120) || 'Expense',
    amount_cents: cents,
    paid_by: String(body.paidBy),
    split_among: JSON.stringify(splitAmong),
    date: String(body.date).slice(0, 10),
    created_at: now_(),
  };
  sheet_('expenses').appendRow([
    ex.id, ex.group_id, ex.description, ex.amount_cents, ex.paid_by,
    ex.split_among, ex.date, ex.created_at,
  ]);
  return { ok: true, expense: ex };
}

function addSettlement_(body) {
  need_(body, ['groupId', 'fromId', 'toId', 'amountCents', 'date']);
  if (String(body.fromId) === String(body.toId)) {
    throw new Error('a settlement needs two different people');
  }
  var cents = assertCents_(body.amountCents);
  assertGroupAndMembers_(body.groupId, [body.fromId, body.toId]);
  var s = {
    id: uuid_(),
    group_id: String(body.groupId),
    from_id: String(body.fromId),
    to_id: String(body.toId),
    amount_cents: cents,
    date: String(body.date).slice(0, 10),
    created_at: now_(),
  };
  sheet_('settlements').appendRow([
    s.id, s.group_id, s.from_id, s.to_id, s.amount_cents, s.date, s.created_at,
  ]);
  return { ok: true, settlement: s };
}

function deleteRow_(headers, tab, id) {
  if (!id) throw new Error('missing field: id');
  var sheet = sheet_(tab);
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0]) === String(id)) {
      sheet.deleteRow(r + 1);
      return { ok: true };
    }
  }
  throw new Error('not found');
}
