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
  var out = await backend.createGroup({ id: 'g1', name: 'Weekend cabin' });
  var g = out.group;
  assert.ok(out.state.groups.some(function (x) { return x.id === 'g1'; }),
    'createGroup returns fresh state including the new group');

  var m1 = (await backend.addMember({ id: 'm1', groupId: g.id, name: 'Alice' })).member;
  var m2 = (await backend.addMember({ id: 'm2', groupId: g.id, name: 'Bob' })).member;
  var m3 = (await backend.addMember({ id: 'm3', groupId: g.id, name: 'Cara' })).member;

  // duplicate name rejected
  await assert.rejects(backend.addMember({ id: 'm4', groupId: g.id, name: 'alice' }), /already in this group/);

  // expenses
  var r1 = await backend.addExpense({
    id: 'e1', groupId: g.id, description: 'Groceries', amountCents: 12000,
    paidBy: m1.id, splitAmong: [m1.id, m2.id, m3.id], date: '2026-10-16',
  });
  assert.strictEqual(r1.expense.id, 'e1', 'client-supplied id is kept');
  assert.ok(r1.state.expenses.some(function (e) { return e.id === 'e1'; }),
    'addExpense returns fresh state including the new expense');
  await backend.addExpense({
    id: 'e2', groupId: g.id, description: 'Firewood', amountCents: 4500,
    paidBy: m2.id, splitAmong: [m1.id, m2.id], date: '2026-10-16',
  });
  // invalid expense rejected
  await assert.rejects(
    backend.addExpense({ id: 'e3', groupId: g.id, description: 'x', amountCents: 0, paidBy: m1.id, splitAmong: [m1.id], date: '2026-10-16' }),
    /positive/
  );

  var s = await backend.getState();
  var ms = s.members.filter(function (m) { return m.groupId === g.id; });
  var ex = s.expenses.filter(function (e) { return e.groupId === g.id; });
  assert.strictEqual(ex.length, 2);

  // Groceries: Alice +8000, Bob -4000, Cara -4000
  // Firewood: Bob paid 4500, share 2250 -> +2250; Alice -2250
  // Totals: Alice 8000-2250=5750, Bob -4000+2250=-1750, Cara -4000
  var bal = B.computeBalances(ms, ex, []);
  assert.deepStrictEqual(bal, { m1: 5750, m2: -1750, m3: -4000 });

  var pays = B.simplifyDebts(bal);
  assert.strictEqual(pays.length, 2);
  var toAlice = pays.filter(function (p) { return p.to === m1.id; });
  assert.strictEqual(toAlice.reduce(function (n, p) { return n + p.amountCents; }, 0), 5750);

  // record suggested payments, balances zero out
  var st1 = await backend.addSettlement({
    id: 's1', groupId: g.id, fromId: m2.id, toId: m1.id, amountCents: 1750, date: '2026-10-16',
  });
  assert.strictEqual(st1.state.settlements.length, 1, 'addSettlement returns fresh state');
  await backend.addSettlement({
    id: 's2', groupId: g.id, fromId: m3.id, toId: m1.id, amountCents: 4000, date: '2026-10-16',
  });
  s = await backend.getState();
  ex = s.expenses.filter(function (e) { return e.groupId === g.id; });
  var st = s.settlements.filter(function (x) { return x.groupId === g.id; });
  bal = B.computeBalances(ms, ex, st);
  assert.deepStrictEqual(bal, { m1: 0, m2: 0, m3: 0 });
  assert.deepStrictEqual(B.simplifyDebts(bal), []);

  // delete an expense -> balances change; delete returns fresh state
  var del = await backend.deleteExpense('e1');
  assert.strictEqual(del.state.expenses.filter(function (e) { return e.groupId === g.id; }).length, 1);

  // uneven split: shares drive balances, not equal division
  var g2 = (await backend.createGroup({ id: 'g2', name: 'Uneven' })).group;
  var a1 = (await backend.addMember({ id: 'a1', groupId: g2.id, name: 'Ann' })).member;
  var b1 = (await backend.addMember({ id: 'b1', groupId: g2.id, name: 'Bo' })).member;
  var ue = await backend.addExpense({
    id: 'e9', groupId: g2.id, description: 'Uneven dinner', amountCents: 1000,
    paidBy: a1.id, splitAmong: [a1.id, b1.id], shares: { a1: 700, b1: 300 }, date: '2026-10-17',
  });
  assert.deepStrictEqual(ue.expense.shares, { a1: 700, b1: 300 });
  s = await backend.getState();
  var bal2 = B.computeBalances([a1, b1],
    s.expenses.filter(function (e) { return e.groupId === g2.id; }), []);
  assert.deepStrictEqual(bal2, { a1: 300, b1: -300 });
  await assert.rejects(backend.addExpense({
    id: 'e10', groupId: g2.id, description: 'Bad', amountCents: 1000,
    paidBy: a1.id, splitAmong: [a1.id, b1.id], shares: { a1: 700, b1: 200 }, date: '2026-10-17',
  }), /add up/);

  // names are normalized to title case (demo backend mirrors the server)
  var c1 = (await backend.addMember({ id: 'c1', groupId: g2.id, name: '  cara  jones ' })).member;
  assert.strictEqual(c1.name, 'Cara Jones');
  await assert.rejects(
    backend.addMember({ id: 'c2', groupId: g2.id, name: 'CARA JONES' }),
    /already in this group/
  );

  console.log('smoke test passed: full flow works (group -> members -> expenses -> simplify -> settle -> zero)');
})().catch(function (e) { console.error('SMOKE FAIL:', e); process.exitCode = 1; });
