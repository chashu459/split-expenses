// Regression test: the Apps Script backend returns split_among as a JSON
// *string* in POST responses. normExpense must parse it before .map.
// Run with: node test/sheets-adapter.test.js
var assert = require('assert');
var api = require('../frontend/api.js');

// Fake fetch: mimics the Apps Script server shape (snake_case, split_among string).
global.fetch = function (url, opts) {
  var body = opts && opts.body ? JSON.parse(opts.body) : {};
  var json;
  if (body.action === 'addExpense') {
    json = {
      ok: true,
      expense: {
        id: 'e1', group_id: 'g1', description: body.description,
        amount_cents: body.amountCents, paid_by: body.paidBy,
        split_among: JSON.stringify(body.splitAmong), // <-- string, like the real server
        date: body.date, created_at: '2026-10-17T00:00:00.000Z',
      },
    };
  } else {
    json = { ok: true, state: { groups: [], members: [], expenses: [], settlements: [] } };
  }
  return Promise.resolve({ json: function () { return Promise.resolve(json); } });
};

(async function () {
  var backend = api.SheetsBackend('https://example.com/exec');

  var ex = await backend.addExpense({
    groupId: 'g1', description: 'Lunch', amountCents: 3000,
    paidBy: 'm1', splitAmong: ['m1', 'm2'], date: '2026-10-17',
  });
  assert.deepStrictEqual(ex.splitAmong, ['m1', 'm2']);
  assert.strictEqual(ex.amountCents, 3000);
  console.log('ok - addExpense handles string split_among (no more .map TypeError)');

  var state = await backend.getState();
  assert.deepStrictEqual(state.groups, []);
  console.log('ok - getState normalizes empty state');

  console.log('sheets-adapter tests passed');
})().catch(function (e) { console.error('FAIL:', e); process.exitCode = 1; });
