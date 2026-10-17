// End-to-end smoke test of the app flow against DemoBackend.
// Exercises the same adapter interface the Sheets backend implements.
// Run with: node test/smoke.js
var assert = require('assert');
var api = require('../frontend/api.js');
var B = require('../frontend/balances.js');

(async function () {
  var backend = api.DemoBackend();
  assert.strictEqual(backend.kind, 'demo');

  // fresh group
  var g = await backend.createGroup('Weekend cabin');
  var alice = await backend.addMember(g.id, 'Alice');
  var bob = await backend.addMember(g.id, 'Bob');
  var cara = await backend.addMember(g.id, 'Cara');

  // duplicate name rejected
  await assert.rejects(backend.addMember(g.id, 'alice'), /already in this group/);

  // expenses
  await backend.addExpense({
    groupId: g.id, description: 'Groceries', amountCents: 12000,
    paidBy: alice.id, splitAmong: [alice.id, bob.id, cara.id], date: '2026-10-16',
  });
  await backend.addExpense({
    groupId: g.id, description: 'Firewood', amountCents: 4500,
    paidBy: bob.id, splitAmong: [alice.id, bob.id], date: '2026-10-16',
  });
  // invalid expense rejected
  await assert.rejects(
    backend.addExpense({ groupId: g.id, description: 'x', amountCents: 0, paidBy: alice.id, splitAmong: [alice.id], date: '2026-10-16' }),
    /positive/
  );

  var s = await backend.getState();
  var ms = s.members.filter(function (m) { return m.groupId === g.id; });
  var ex = s.expenses.filter(function (e) { return e.groupId === g.id; });
  assert.strictEqual(ex.length, 2);

  // Groceries: Alice +8000, Bob -4000, Cara -4000
  // Firewood: Bob +2250 net of his share... compute: Bob paid 4500, share 2250 -> +2250; Alice -2250
  // Totals: Alice 8000-2250=5750, Bob -4000+2250=-1750, Cara -4000
  var bal = B.computeBalances(ms, ex, []);
  assert.deepStrictEqual(bal, { [alice.id]: 5750, [bob.id]: -1750, [cara.id]: -4000 });

  var pays = B.simplifyDebts(bal);
  assert.strictEqual(pays.length, 2);
  // Bob -> Alice 1750, Cara -> Alice 4000
  var toAlice = pays.filter(function (p) { return p.to === alice.id; });
  assert.strictEqual(toAlice.reduce(function (n, p) { return n + p.amountCents; }, 0), 5750);

  // record suggested payment, balances zero out
  await backend.addSettlement({
    groupId: g.id, fromId: bob.id, toId: alice.id, amountCents: 1750, date: '2026-10-16',
  });
  await backend.addSettlement({
    groupId: g.id, fromId: cara.id, toId: alice.id, amountCents: 4000, date: '2026-10-16',
  });
  s = await backend.getState();
  ex = s.expenses.filter(function (e) { return e.groupId === g.id; });
  var st = s.settlements.filter(function (x) { return x.groupId === g.id; });
  bal = B.computeBalances(ms, ex, st);
  assert.deepStrictEqual(bal, { [alice.id]: 0, [bob.id]: 0, [cara.id]: 0 });
  assert.deepStrictEqual(B.simplifyDebts(bal), []);

  // delete an expense -> balances change
  var delId = ex[0].id;
  await backend.deleteExpense(delId);
  s = await backend.getState();
  ex = s.expenses.filter(function (e) { return e.groupId === g.id; });
  assert.strictEqual(ex.length, 1);

  console.log('smoke test passed: full flow works (group -> members -> expenses -> simplify -> settle -> zero)');
})().catch(function (e) { console.error('SMOKE FAIL:', e); process.exitCode = 1; });
