// Unit tests for balances.js — run with: node test/balances.test.js
var assert = require('assert');
var B = require('../frontend/balances.js');

var passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { console.error('FAIL - ' + name + '\n  ' + e.message); process.exitCode = 1; }
}

function members(names) {
  return names.map(function (n, i) { return { id: 'm' + i, name: n }; });
}

t('equal split: payer net positive, others negative', function () {
  var ms = members(['A', 'B', 'C']);
  var ex = [{ amountCents: 9000, paidBy: 'm0', splitAmong: ['m0', 'm1', 'm2'] }];
  var bal = B.computeBalances(ms, ex, []);
  assert.deepStrictEqual(bal, { m0: 6000, m1: -3000, m2: -3000 });
});

t('odd cents: remainder goes to first participant', function () {
  var ms = members(['A', 'B', 'C']);
  var ex = [{ amountCents: 100, paidBy: 'm0', splitAmong: ['m0', 'm1', 'm2'] }];
  var bal = B.computeBalances(ms, ex, []);
  // shares 33/33/34: A paid 100, owes 34 -> +66; B -33; C -33
  assert.deepStrictEqual(bal, { m0: 66, m1: -33, m2: -33 });
  assert.strictEqual(bal.m0 + bal.m1 + bal.m2, 0);
});

t('subset split: non-participants unaffected', function () {
  var ms = members(['A', 'B', 'C']);
  var ex = [{ amountCents: 10000, paidBy: 'm2', splitAmong: ['m0', 'm2'] }];
  var bal = B.computeBalances(ms, ex, []);
  assert.deepStrictEqual(bal, { m0: -5000, m1: 0, m2: 5000 });
});

t('settlement moves debtor up and creditor down', function () {
  var ms = members(['A', 'B']);
  var ex = [{ amountCents: 10000, paidBy: 'm0', splitAmong: ['m0', 'm1'] }];
  var st = [{ fromId: 'm1', toId: 'm0', amountCents: 5000 }];
  var bal = B.computeBalances(ms, ex, st);
  assert.deepStrictEqual(bal, { m0: 0, m1: 0 });
});

t('simplify: one debtor, two creditors -> two payments', function () {
  var pays = B.simplifyDebts({ a: -5000, b: 3000, c: 2000 });
  assert.strictEqual(pays.length, 2);
  var total = pays.reduce(function (s, p) { return s + p.amountCents; }, 0);
  assert.strictEqual(total, 5000);
  pays.forEach(function (p) { assert.strictEqual(p.from, 'a'); });
});

t('simplify: already settled -> no payments', function () {
  assert.deepStrictEqual(B.simplifyDebts({ a: 0, b: 0 }), []);
});

t('simplify: payments actually zero out balances', function () {
  var start = { a: -7250, b: 4000, c: 3250, d: 0 };
  var pays = B.simplifyDebts(start);
  var bal = { a: -7250, b: 4000, c: 3250, d: 0 };
  pays.forEach(function (p) { bal[p.from] += p.amountCents; bal[p.to] -= p.amountCents; });
  Object.keys(bal).forEach(function (k) { assert.strictEqual(bal[k], 0, k); });
});

t('formatMoney', function () {
  assert.strictEqual(B.formatMoney(1234), '$12.34');
  assert.strictEqual(B.formatMoney(-500), '-$5.00');
  assert.strictEqual(B.formatMoney(0), '$0.00');
});

console.log(passed + ' tests passed');
