// Regression test: the Apps Script backend returns split_among as a JSON
// *string* in POST responses. normExpense must parse it before .map.
// Run with: node test/sheets-adapter.test.js
var assert = require('assert');
var api = require('../frontend/api.js');

// Fake fetch: mimics the Apps Script server shape (snake_case, split_among string).
// addMembers answers "unknown action" to simulate a backend that hasn't been
// redeployed yet, exercising the client's sequential-add fallback.
global.fetch = function (url, opts) {
  var body = opts && opts.body ? JSON.parse(opts.body) : {};
  var emptyState = { groups: [], members: [], expenses: [], settlements: [] };
  var json;
  if (body.action === 'addExpense' || body.action === 'updateExpense') {
    json = {
      ok: true,
      expense: {
        id: body.id, group_id: 'g1', description: body.description,
        amount_cents: body.amountCents, paid_by: body.paidBy,
        split_among: JSON.stringify(body.splitAmong), // <-- string, like the real server
        date: body.date, created_at: '2026-10-17T00:00:00.000Z',
      },
      state: emptyState,
    };
  } else if (body.action === 'addMember') {
    json = {
      ok: true,
      member: { id: body.id, group_id: body.groupId, name: body.name, venmo: body.venmo || '' },
      state: emptyState,
    };
  } else if (body.action === 'addMembers') {
    json = { ok: false, error: 'unknown action: addMembers' };
  } else {
    json = { ok: true, state: emptyState };
  }
  return Promise.resolve({ json: function () { return Promise.resolve(json); } });
};

(async function () {
  var backend = api.SheetsBackend('https://example.com/exec');

  var out = await backend.addExpense({
    id: 'client-uuid-1', groupId: 'g1', description: 'Lunch', amountCents: 3000,
    paidBy: 'm1', splitAmong: ['m1', 'm2'], date: '2026-10-17',
  });
  assert.deepStrictEqual(out.expense.splitAmong, ['m1', 'm2']);
  assert.strictEqual(out.expense.amountCents, 3000);
  assert.strictEqual(out.expense.id, 'client-uuid-1');
  assert.ok(out.state, 'mutation returns fresh state');
  console.log('ok - addExpense handles string split_among (no more .map TypeError)');

  var state = await backend.getState();
  assert.deepStrictEqual(state.groups, []);
  console.log('ok - getState normalizes empty state');

  var upd = await backend.updateExpense({
    id: 'e1', groupId: 'g1', description: 'Dinner!', amountCents: 3500,
    paidBy: 'm1', splitAmong: ['m1', 'm2'], date: '2026-10-17',
  });
  assert.strictEqual(upd.expense.description, 'Dinner!');
  assert.strictEqual(upd.expense.amountCents, 3500);
  assert.strictEqual(upd.expense.createdAt, '2026-10-17T00:00:00.000Z');
  console.log('ok - updateExpense posts and normalizes the edited expense');

  var batch = await backend.addMembers('g1', [
    { id: 'm1', name: 'Ann', venmo: 'ann-pays' },
    { id: 'm2', name: 'Bo', venmo: '' },
  ]);
  assert.strictEqual(batch.members.length, 2);
  assert.strictEqual(batch.skipped, 0);
  assert.ok(batch.state, 'fallback returns fresh state');
  console.log('ok - addMembers falls back to sequential adds on old backends');

  console.log('sheets-adapter tests passed');
})().catch(function (e) { console.error('FAIL:', e); process.exitCode = 1; });
