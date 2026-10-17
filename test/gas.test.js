// End-to-end test of backend/Code.gs against in-memory Apps Script stubs.
// Exercises doGet/doPost exactly as the deployed web app would.
// Run with: node test/gas.test.js
const assert = require('assert');
const fs = require('fs');

/* ---------- stubs ---------- */
let readCount = 0;
function makeSheet(header) {
  const rows = [header.slice()];
  return {
    getDataRange() {
      readCount++;
      return { getValues: () => rows.map((r) => r.slice()) };
    },
    appendRow(arr) { rows.push(arr.slice()); },
    deleteRow(n) { rows.splice(n - 1, 1); },
    getLastRow() { return rows.length; },
    setFrozenRows() {},
  };
}
const sheets = {
  groups: makeSheet(['id', 'name', 'created_at']),
  members: makeSheet(['id', 'group_id', 'name']),
  expenses: makeSheet(['id', 'group_id', 'description', 'amount_cents', 'paid_by', 'split_among', 'date', 'created_at']),
  settlements: makeSheet(['id', 'group_id', 'from_id', 'to_id', 'amount_cents', 'date', 'created_at']),
};
global.SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet([])),
  }),
};
global.LockService = {
  getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
};
let uuidN = 0;
global.Utilities = { getUuid: () => 'uuid-' + (++uuidN) };
global.ContentService = {
  createTextOutput: (s) => ({ setMimeType: () => ({ getContent: () => s }) }),
  MimeType: { JSON: 'json' },
};

/* ---------- load the real Code.gs ---------- */
const code = fs.readFileSync(__dirname + '/../backend/Code.gs', 'utf8');
eval(code + '\n;global.__doPost = doPost; global.__doGet = doGet;');

function post(body) {
  readCount = 0;
  const out = global.__doPost({ postData: { contents: JSON.stringify(body) } });
  return { res: JSON.parse(out.getContent()), reads: readCount };
}
function get(action) {
  readCount = 0;
  const out = global.__doGet({ parameter: { action } });
  return { res: JSON.parse(out.getContent()), reads: readCount };
}

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { console.error('FAIL - ' + name + '\n  ' + e.message); process.exitCode = 1; }
}

/* ---------- tests ---------- */
t('createGroup with client id', () => {
  const { res, reads } = post({ action: 'createGroup', id: 'g1', name: 'Trip' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.group.id, 'g1');
  assert.strictEqual(res.state.groups.length, 1);
  assert.ok(reads <= 4, 'expected single-pass reads, got ' + reads);
});

t('createGroup retry with same id is idempotent', () => {
  const { res } = post({ action: 'createGroup', id: 'g1', name: 'Trip' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.duplicate, true);
  assert.strictEqual(res.state.groups.length, 1);
});

t('addMember x2, duplicate name rejected', () => {
  let r = post({ action: 'addMember', id: 'm1', groupId: 'g1', name: 'Ann' });
  assert.strictEqual(r.res.ok, true);
  r = post({ action: 'addMember', id: 'm2', groupId: 'g1', name: 'Bo' });
  assert.strictEqual(r.res.ok, true);
  assert.strictEqual(r.res.state.members.length, 2);
  r = post({ action: 'addMember', id: 'm3', groupId: 'g1', name: 'ann' });
  assert.strictEqual(r.res.ok, false);
  assert.match(r.res.error, /already in this group/);
});

t('addExpense with splitAmong array', () => {
  const { res } = post({
    action: 'addExpense', id: 'e1', groupId: 'g1', description: 'Dinner',
    amountCents: 9000, paidBy: 'm1', splitAmong: ['m1', 'm2'], date: '2026-10-17',
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.expense.amount_cents, 9000);
  assert.deepStrictEqual(res.state.expenses[0].split_among, ['m1', 'm2']);
});

t('addExpense retry with same id is idempotent (no duplicate row)', () => {
  const { res } = post({
    action: 'addExpense', id: 'e1', groupId: 'g1', description: 'Dinner',
    amountCents: 9000, paidBy: 'm1', splitAmong: ['m1', 'm2'], date: '2026-10-17',
  });
  assert.strictEqual(res.duplicate, true);
  assert.strictEqual(res.state.expenses.length, 1);
  assert.strictEqual(sheets.expenses.getDataRange().getValues().length, 2); // header + 1 row
});

t('addExpense with unknown member rejected', () => {
  const { res } = post({
    action: 'addExpense', id: 'e2', groupId: 'g1', description: 'X',
    amountCents: 100, paidBy: 'm1', splitAmong: ['m1', 'zzz'], date: '2026-10-17',
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /member not in group/);
});

t('addExpense missing field rejected', () => {
  const { res } = post({ action: 'addExpense', id: 'e9', groupId: 'g1' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /missing field/);
});

t('addSettlement then balances zero out', () => {
  const B = require('../frontend/balances.js');
  let r = post({
    action: 'addSettlement', id: 's1', groupId: 'g1',
    fromId: 'm2', toId: 'm1', amountCents: 4500, date: '2026-10-17',
  });
  assert.strictEqual(r.res.ok, true);
  const st = r.res.state;
  const members = st.members.map((m) => ({ id: m.id }));
  const expenses = st.expenses.map((e) => ({
    amountCents: e.amount_cents, paidBy: e.paid_by, splitAmong: e.split_among,
  }));
  const settlements = st.settlements.map((s) => ({
    fromId: s.from_id, toId: s.to_id, amountCents: s.amount_cents,
  }));
  assert.deepStrictEqual(B.computeBalances(members, expenses, settlements), { m1: 0, m2: 0 });
});

t('deleteExpense removes row from sheet and state', () => {
  const { res } = post({ action: 'deleteExpense', id: 'e1' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.state.expenses.length, 0);
  const bad = post({ action: 'deleteExpense', id: 'nope' });
  assert.strictEqual(bad.res.ok, false);
});

t('doGet state shape', () => {
  const { res, reads } = get('state');
  assert.strictEqual(res.ok, true);
  assert.ok(Array.isArray(res.state.groups));
  assert.ok(reads <= 4, 'expected single-pass reads, got ' + reads);
  const bad = get('nope');
  assert.strictEqual(bad.res.ok, false);
});

console.log(passed + ' gas tests passed');
