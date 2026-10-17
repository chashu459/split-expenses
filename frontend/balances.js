/**
 * Shared balance math. Amounts are integer cents everywhere.
 *
 * Sign convention: a positive balance means the person is OWED money
 * (they paid more than their share); negative means they OWE money.
 *
 * Loaded via <script> in the browser and via require() in node tests.
 */

/**
 * Per-person owed amounts for one expense, in cents: {memberId: cents}.
 * Uses explicit uneven `shares` when present, otherwise splits equally
 * (leftover cents go to the first person).
 */
function owedSplit(e) {
  var shares = e.shares;
  if (shares && typeof shares === 'object' && Object.keys(shares).length) {
    var out = {};
    Object.keys(shares).forEach(function (k) { out[String(k)] = Number(shares[k]) || 0; });
    return out;
  }
  var ids = (e.splitAmong || e.split_among || []).map(String);
  var eq = {};
  if (!ids.length) return eq;
  var share = Math.floor(e.amountCents / ids.length);
  var remainder = e.amountCents - share * ids.length; // 0..n-1 leftover cents
  ids.forEach(function (mid, i) { eq[mid] = share + (i === 0 ? remainder : 0); });
  return eq;
}

function computeBalances(members, expenses, settlements) {
  var bal = {};
  members.forEach(function (m) { bal[String(m.id)] = 0; });

  expenses.forEach(function (e) {
    var owed = owedSplit(e);
    var ids = Object.keys(owed);
    if (!ids.length) return;
    var paidBy = String(e.paidBy || e.paid_by);
    bal[paidBy] = (bal[paidBy] || 0) + e.amountCents;
    ids.forEach(function (mid) {
      bal[mid] = (bal[mid] || 0) - owed[mid];
    });
  });

  (settlements || []).forEach(function (s) {
    var from = String(s.fromId || s.from_id);
    var to = String(s.toId || s.to_id);
    var amt = s.amountCents;
    // `from` pays `to`: from owed money (negative), paying moves them up.
    bal[from] = (bal[from] || 0) + amt;
    bal[to] = (bal[to] || 0) - amt;
  });

  return bal;
}

/**
 * Greedy min-cash-flow: collapse N-way balances into the fewest
 * payments. Returns [{from, to, amountCents}].
 */
function simplifyDebts(balances) {
  var debtors = [];   // owe money: {id, amt>0}
  var creditors = []; // owed money: {id, amt>0}
  Object.keys(balances).forEach(function (id) {
    var amt = balances[id];
    if (amt < 0) debtors.push({ id: id, amt: -amt });
    else if (amt > 0) creditors.push({ id: id, amt: amt });
  });
  debtors.sort(function (a, b) { return b.amt - a.amt; });
  creditors.sort(function (a, b) { return b.amt - a.amt; });

  var out = [];
  var i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    var d = debtors[i], c = creditors[j];
    var x = Math.min(d.amt, c.amt);
    out.push({ from: d.id, to: c.id, amountCents: x });
    d.amt -= x;
    c.amt -= x;
    if (d.amt === 0) i++;
    if (c.amt === 0) j++;
  }
  return out;
}

function formatMoney(cents) {
  var sign = cents < 0 ? '-' : '';
  return sign + '$' + (Math.abs(cents) / 100).toFixed(2);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeBalances: computeBalances, simplifyDebts: simplifyDebts, formatMoney: formatMoney, owedSplit: owedSplit };
}
