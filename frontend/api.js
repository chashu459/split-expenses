/**
 * Storage adapters. Both expose the same async interface. Mutations resolve to
 * { item, state } (or { state } for deletes), where state is the fresh full
 * state — one server round trip per action, no separate refresh needed.
 *
 *   getState()      -> { groups, members, expenses, settlements }
 *   createGroup({id?, name})                       -> { group, state }
 *   addMember({id?, groupId, name})                 -> { member, state }
 *   addExpense({id?, groupId, description, amountCents, paidBy, splitAmong, shares?, date})
 *                                                   -> { expense, state }
 *     shares is an optional uneven split: {memberId: cents}, must total amountCents.
 *     Without it, the amount splits equally among splitAmong.
 *   addSettlement({id?, groupId, fromId, toId, amountCents, date})
 *                                                   -> { settlement, state }
 *   uploadReceipt({expenseId, name?, mimeType?, data}) -> { receiptId, state }
 *     data is base64 (no data: prefix); stored in the owner's Google Drive.
 *   deleteExpense(id)                              -> { state }
 *   deleteSettlement(id)                            -> { state }
 *
 * Shapes (both backends normalize to these):
 *   group:      { id, name }
 *   member:     { id, groupId, name }
 *   expense:    { id, groupId, description, amountCents, paidBy, splitAmong:[ids], date }
 *   settlement:{ id, groupId, fromId, toId, amountCents, date }
 */

function SheetsBackend(url) {
  var base = String(url).replace(/\/+$/, '');

  function post(payload) {
    // NOTE: no Content-Type header on purpose. A string body with no
    // explicit content type is a CORS "simple request" (text/plain), so
    // the browser skips the preflight that Apps Script web apps fail.
    return fetch(base, { method: 'POST', body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'request failed');
        return res;
      });
  }

  function normState(s) {
    return {
      groups: (s.groups || []).map(function (g) { return { id: String(g.id), name: g.name }; }),
      members: (s.members || []).map(function (m) {
        return { id: String(m.id), groupId: String(m.group_id), name: m.name };
      }),
      expenses: (s.expenses || []).map(normExpense),
      settlements: (s.settlements || []).map(normSettlement),
    };
  }

  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      try { var p = JSON.parse(v); return Array.isArray(p) ? p : []; }
      catch (_) { return []; }
    }
    return [];
  }

  function normExpense(e) {
    return {
      id: String(e.id || e.expense && e.expense.id),
      groupId: String(e.group_id !== undefined ? e.group_id : e.groupId),
      description: e.description,
      amountCents: Number(e.amount_cents !== undefined ? e.amount_cents : e.amountCents),
      paidBy: String(e.paid_by !== undefined ? e.paid_by : e.paidBy),
      splitAmong: asArray(e.split_among !== undefined ? e.split_among : e.splitAmong).map(String),
      shares: parseSharesField(e.shares),
      receiptId: String(e.receipt_id !== undefined ? e.receipt_id : (e.receiptId || '')),
      date: e.date,
    };
  }

  function parseSharesField(v) {
    if (!v) return null;
    if (typeof v === 'object' && !Array.isArray(v)) {
      var out = {};
      Object.keys(v).forEach(function (k) { out[String(k)] = Number(v[k]); });
      return out;
    }
    try {
      var p = JSON.parse(v);
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        var q = {};
        Object.keys(p).forEach(function (k) { q[String(k)] = Number(p[k]); });
        return q;
      }
    } catch (_) {}
    return null;
  }

  function normSettlement(s) {
    return {
      id: String(s.id || s.settlement && s.settlement.id),
      groupId: String(s.group_id !== undefined ? s.group_id : s.groupId),
      fromId: String(s.from_id !== undefined ? s.from_id : s.fromId),
      toId: String(s.to_id !== undefined ? s.to_id : s.toId),
      amountCents: Number(s.amount_cents !== undefined ? s.amount_cents : s.amountCents),
      date: s.date,
    };
  }

  // Every mutation resolves to { state } plus the normalized item (when any).
  function withState(res, key, norm) {
    var out = { state: normState(res.state) };
    if (key) out[key] = norm(res[key]);
    return out;
  }
  function normGroup(g) { return { id: String(g.id), name: g.name }; }
  function normMember(m) {
    return { id: String(m.id), groupId: String(m.group_id), name: m.name };
  }

  return {
    kind: 'sheets',
    getState: function () {
      return fetch(base + '?action=state')
        .then(function (r) { return r.json(); })
        .then(function (res) {
          if (!res.ok) throw new Error(res.error || 'failed to load');
          return normState(res.state);
        });
    },
    createGroup: function (g) {
      return post({ action: 'createGroup', id: g.id, name: g.name }).then(function (r) {
        return withState(r, 'group', normGroup);
      });
    },
    addMember: function (m) {
      return post({ action: 'addMember', id: m.id, groupId: m.groupId, name: m.name }).then(function (r) {
        return withState(r, 'member', normMember);
      });
    },
    addExpense: function (ex) {
      return post({
        action: 'addExpense', id: ex.id, groupId: ex.groupId, description: ex.description,
        amountCents: ex.amountCents, paidBy: ex.paidBy, splitAmong: ex.splitAmong,
        shares: ex.shares || null, date: ex.date,
      }).then(function (r) { return withState(r, 'expense', normExpense); });
    },
    addSettlement: function (s) {
      return post({
        action: 'addSettlement', id: s.id, groupId: s.groupId, fromId: s.fromId,
        toId: s.toId, amountCents: s.amountCents, date: s.date,
      }).then(function (r) { return withState(r, 'settlement', normSettlement); });
    },
    deleteExpense: function (id) {
      return post({ action: 'deleteExpense', id: id }).then(function (r) { return withState(r); });
    },
    deleteSettlement: function (id) {
      return post({ action: 'deleteSettlement', id: id }).then(function (r) { return withState(r); });
    },
    uploadReceipt: function (r) {
      return post({
        action: 'uploadReceipt', expenseId: r.expenseId, name: r.name,
        mimeType: r.mimeType, data: r.data,
      }).then(function (res) {
        return { receiptId: res.receiptId, state: normState(res.state) };
      });
    },
  };
}

/* Demo backend: in-memory seed data, persisted to localStorage when available. */
function DemoBackend() {
  var KEY = 'splitwise-demo-v1';
  var store = null;

  function uid(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 10);
  }
  function today() { return new Date().toISOString().slice(0, 10); }

  function seed() {
    var g = uid('g');
    var a = uid('m'), b = uid('m'), c = uid('m');
    return {
      groups: [{ id: g, name: 'Tokyo Trip (demo)' }],
      members: [
        { id: a, groupId: g, name: 'Chashu' },
        { id: b, groupId: g, name: 'Alex' },
        { id: c, groupId: g, name: 'Priya' },
      ],
      expenses: [
        { id: uid('e'), groupId: g, description: 'Hotel (2 nights)', amountCents: 36000, paidBy: a, splitAmong: [a, b, c], date: today() },
        { id: uid('e'), groupId: g, description: 'Ramen dinner', amountCents: 8400, paidBy: b, splitAmong: [a, b, c], date: today() },
        { id: uid('e'), groupId: g, description: 'Train passes', amountCents: 15000, paidBy: c, splitAmong: [a, c], date: today() },
      ],
      settlements: [],
    };
  }

  function load() {
    if (store) return store;
    try {
      if (typeof localStorage !== 'undefined') {
        var raw = localStorage.getItem(KEY);
        if (raw) { store = JSON.parse(raw); return store; }
      }
    } catch (_) { /* fall through to seed */ }
    store = seed();
    save();
    return store;
  }
  function save() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(store));
    } catch (_) { /* private mode etc. */ }
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function snap(s) { return { state: clone(s) }; }

  return {
    kind: 'demo',
    getState: function () { return Promise.resolve(clone(load())); },
    createGroup: function (g) {
      var s = load();
      var grp = { id: g.id || uid('g'), name: String(g.name).slice(0, 80) };
      s.groups.push(grp); save();
      return Promise.resolve({ group: clone(grp), state: clone(s) });
    },
    addMember: function (m) {
      var s = load();
      var name = String(m.name).trim().slice(0, 40);
      if (!name) return Promise.reject(new Error('name cannot be blank'));
      var dupe = s.members.some(function (x) {
        return x.groupId === m.groupId && x.name.toLowerCase() === name.toLowerCase();
      });
      if (dupe) return Promise.reject(new Error('that name is already in this group'));
      var member = { id: m.id || uid('m'), groupId: m.groupId, name: name };
      s.members.push(member); save();
      return Promise.resolve({ member: clone(member), state: clone(s) });
    },
    addExpense: function (ex) {
      var s = load();
      if (!ex.splitAmong || !ex.splitAmong.length) return Promise.reject(new Error('pick who to split with'));
      if (!Number.isInteger(ex.amountCents) || ex.amountCents <= 0) {
        return Promise.reject(new Error('amount must be positive'));
      }
      var shares = null;
      if (ex.shares) {
        shares = {};
        var sum = 0;
        var ids = Object.keys(ex.shares);
        for (var i = 0; i < ids.length; i++) {
          var n = Number(ex.shares[ids[i]]);
          if (!Number.isInteger(n) || n < 0) return Promise.reject(new Error('shares must be non-negative integer cents'));
          shares[String(ids[i])] = n;
          sum += n;
        }
        if (sum !== ex.amountCents) return Promise.reject(new Error('shares must add up to the total amount'));
      }
      var e = {
        id: ex.id || uid('e'), groupId: ex.groupId, description: String(ex.description).slice(0, 120) || 'Expense',
        amountCents: ex.amountCents, paidBy: ex.paidBy, splitAmong: ex.splitAmong.map(String),
        shares: shares, receiptId: '', date: ex.date,
      };
      s.expenses.push(e); save();
      return Promise.resolve({ expense: clone(e), state: clone(s) });
    },
    addSettlement: function (st) {
      var s = load();
      if (st.fromId === st.toId) return Promise.reject(new Error('pick two different people'));
      var x = {
        id: st.id || uid('s'), groupId: st.groupId, fromId: st.fromId, toId: st.toId,
        amountCents: st.amountCents, date: st.date,
      };
      s.settlements.push(x); save();
      return Promise.resolve({ settlement: clone(x), state: clone(s) });
    },
    deleteExpense: function (id) {
      var s = load();
      s.expenses = s.expenses.filter(function (e) { return e.id !== id; });
      save();
      return Promise.resolve(snap(s));
    },
    deleteSettlement: function (id) {
      var s = load();
      s.settlements = s.settlements.filter(function (x) { return x.id !== id; });
      save();
      return Promise.resolve(snap(s));
    },
    uploadReceipt: function (r) {
      var s = load();
      var ex = s.expenses.filter(function (e) { return e.id === r.expenseId; })[0];
      if (!ex) return Promise.reject(new Error('unknown expense'));
      ex.receiptId = 'demo-receipt';
      save();
      return Promise.resolve({ receiptId: 'demo-receipt', state: clone(s) });
    },
    reset: function () { store = seed(); save(); return Promise.resolve(); },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SheetsBackend: SheetsBackend, DemoBackend: DemoBackend };
}
