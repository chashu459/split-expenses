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
    getLastColumn() { return rows[0].length; },
    getRange(r, c, nr, nc) {
      return {
        getValues: () => {
          const out = [];
          for (let i = 0; i < (nr || 1); i++) {
            const row = [];
            for (let j = 0; j < (nc || 1); j++) row.push(rows[r - 1 + i][c - 1 + j]);
            out.push(row);
          }
          return out;
        },
        setValue: (v) => { rows[r - 1][c - 1] = v; },
      };
    },
    setFrozenRows() {},
    _rows: rows,
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
global.Utilities = {
  getUuid: () => 'uuid-' + (++uuidN),
  base64Decode: (s) => Buffer.from(s, 'base64'),
  newBlob: (bytes, mime, name) => ({ bytes, mimeType: mime, name }),
  formatDate: (d) => d.toISOString().slice(0, 10),
};
global.Session = { getScriptTimeZone: () => 'America/Los_Angeles' };
const driveFiles = {};
global.DriveApp = {
  Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
  Permission: { VIEW: 'VIEW' },
  _folders: {},
  getFoldersByName(name) {
    const f = this._folders[name] || null;
    let used = false;
    return { hasNext: () => !used && !!f, next: () => { used = true; return f; } };
  },
  createFolder(name) {
    const folder = {
      createFile: (blob) => {
        const id = 'file-' + Math.random().toString(36).slice(2, 10);
        const file = { getId: () => id, setSharing: () => {}, _blob: blob, _shared: [] };
        file.setSharing = (a, p) => { file._shared.push([a, p]); };
        driveFiles[id] = file;
        return file;
      },
    };
    this._folders[name] = folder;
    return folder;
  },
};
global.ContentService = {
  createTextOutput: (s) => ({ setMimeType: () => ({ getContent: () => s }) }),
  MimeType: { JSON: 'json' },
};

/* ---------- load the real Code.gs ---------- */
const code = fs.readFileSync(__dirname + '/../backend/Code.gs', 'utf8');
eval(code + '\n;global.__doPost = doPost; global.__doGet = doGet; global.__bootstrap = bootstrap;');
// simulate a sheet created by an older bootstrap(): columns added by migration
global.__bootstrap();

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

t('member names are normalized to title case', () => {
  const { res } = post({ action: 'addMember', id: 'm-norm', groupId: 'g1', name: '  jiashu   wang ' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.member.name, 'Jiashu Wang');
  assert.strictEqual(res.state.members.find((m) => m.id === 'm-norm').name, 'Jiashu Wang');
});

t('duplicate member check is normalization-aware', () => {
  const { res } = post({ action: 'addMember', id: 'm-norm2', groupId: 'g1', name: 'JIASHU WANG' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /already in this group/);
});

t('uneven shares: balances follow shares, not equal split', () => {
  const B = require('../frontend/balances.js');
  const { res } = post({
    action: 'addExpense', id: 'e-share', groupId: 'g1', description: 'Uneven',
    amountCents: 9000, paidBy: 'm1', splitAmong: ['m1', 'm2'],
    shares: { m1: 7000, m2: 2000 }, date: '2026-10-17',
  });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.expense.shares, { m1: 7000, m2: 2000 });
  const members = [{ id: 'm1' }, { id: 'm2' }];
  const expenses = [{ amountCents: 9000, paidBy: 'm1', splitAmong: ['m1', 'm2'], shares: { m1: 7000, m2: 2000 } }];
  assert.deepStrictEqual(B.computeBalances(members, expenses, []), { m1: 2000, m2: -2000 });
});

t('shares must add up to the total', () => {
  const { res } = post({
    action: 'addExpense', id: 'e-badshare', groupId: 'g1', description: 'Bad',
    amountCents: 9000, paidBy: 'm1', splitAmong: ['m1', 'm2'],
    shares: { m1: 7000, m2: 1000 }, date: '2026-10-17',
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /add up to the total/);
});

t('shares with unknown member rejected', () => {
  const { res } = post({
    action: 'addExpense', id: 'e-badshare2', groupId: 'g1', description: 'Bad',
    amountCents: 9000, paidBy: 'm1', splitAmong: ['m1', 'm2'],
    shares: { m1: 4500, zzz: 4500 }, date: '2026-10-17',
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /member not in group/);
});

t('uploadReceipt stores file id on the expense', () => {
  const data = Buffer.from('fake-image-bytes').toString('base64');
  const { res } = post({
    action: 'uploadReceipt', expenseId: 'e-share', name: 'r.jpg',
    mimeType: 'image/jpeg', data,
  });
  assert.strictEqual(res.ok, true);
  assert.ok(res.receiptId.startsWith('file-'));
  const file = driveFiles[res.receiptId];
  assert.ok(file, 'file created in Drive stub');
  assert.deepStrictEqual(file._shared, [['ANYONE_WITH_LINK', 'VIEW']]);
  assert.strictEqual(res.state.expenses.find((e) => e.id === 'e-share').receipt_id, res.receiptId);
  // sheet row updated too
  const rows = sheets.expenses.getDataRange().getValues();
  const head = rows[0].map(String);
  const ridx = head.indexOf('receipt_id');
  const row = rows.find((r) => String(r[0]) === 'e-share');
  assert.strictEqual(String(row[ridx]), res.receiptId);
});

t('uploadReceipt rejects unknown expense and oversized files', () => {
  const bad = post({ action: 'uploadReceipt', expenseId: 'nope', data: 'eA==' });
  assert.strictEqual(bad.res.ok, false);
  const big = post({ action: 'uploadReceipt', expenseId: 'e-share', data: Buffer.alloc(16 * 1024 * 1024).toString('base64') });
  assert.strictEqual(big.res.ok, false);
  assert.match(big.res.error, /too large/);
});

t('date normalization: Date objects from Sheets become YYYY-MM-DD', () => {
  sheets.settlements.appendRow(['s-date', 'g1', 'm1', 'm2', 100,
    new Date(Date.UTC(2026, 9, 17, 8, 0, 0)), '2026-10-17T00:00:00.000Z']);
  const { res } = get('state');
  const s = res.state.settlements.find((x) => x.id === 's-date');
  assert.strictEqual(s.date, '2026-10-17');
});

t('bootstrap adds missing columns to an existing sheet', () => {
  // simulate a pre-feature expenses tab: old 8-column header + one data row
  sheets.expenses._rows.length = 0;
  sheets.expenses._rows.push(['id', 'group_id', 'description', 'amount_cents', 'paid_by', 'split_among', 'date', 'created_at']);
  sheets.expenses._rows.push(['e-old', 'g1', 'Old', 500, 'm1', JSON.stringify(['m1']), '2026-10-16', 't']);
  global.__bootstrap();
  const head = sheets.expenses.getDataRange().getValues()[0].map(String);
  assert.ok(head.includes('shares'), 'shares column added');
  assert.ok(head.includes('receipt_id'), 'receipt_id column added');
  const { res } = get('state');
  const old = res.state.expenses.find((e) => e.id === 'e-old');
  assert.strictEqual(old.description, 'Old');
  assert.strictEqual(old.shares, null);
  assert.strictEqual(old.receipt_id, '');
});

console.log(passed + ' gas tests passed');
