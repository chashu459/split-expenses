/**
 * Storage adapters. Both expose the same async interface:
 *
 *   getState()      -> { groups, members, expenses, settlements }
 *   createGroup(name)
 *   addMember(groupId, name)
 *   addExpense({groupId, description, amountCents, paidBy, splitAmong, date})
 *   addSettlement({groupId, fromId, toId, amountCents, date})
 *   deleteExpense(id)
 *   deleteSettlement(id)
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
      date: e.date,
    };
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
    createGroup: function (name) {
      return post({ action: 'createGroup', name: name }).then(function (r) {
        return { id: String(r.group.id), name: r.group.name };
      });
    },
    addMember: function (groupId, name) {
      return post({ action: 'addMember', groupId: groupId, name: name }).then(function (r) {
        return { id: String(r.member.id), groupId: String(r.member.group_id), name: r.member.name };
      });
    },
    addExpense: function (ex) {
      return post({
        action: 'addExpense', groupId: ex.groupId, description: ex.description,
        amountCents: ex.amountCents, paidBy: ex.paidBy, splitAmong: ex.splitAmong, date: ex.date,
      }).then(function (r) { return normExpense(r.expense); });
    },
    addSettlement: function (s) {
      return post({
        action: 'addSettlement', groupId: s.groupId, fromId: s.fromId,
        toId: s.toId, amountCents: s.amountCents, date: s.date,
      }).then(function (r) { return normSettlement(r.settlement); });
    },
    deleteExpense: function (id) { return post({ action: 'deleteExpense', id: id }); },
    deleteSettlement: function (id) { return post({ action: 'deleteSettlement', id: id }); },
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

  return {
    kind: 'demo',
    getState: function () { return Promise.resolve(clone(load())); },
    createGroup: function (name) {
      var s = load();
      var g = { id: uid('g'), name: String(name).slice(0, 80) };
      s.groups.push(g); save();
      return Promise.resolve(clone(g));
    },
    addMember: function (groupId, name) {
      var s = load();
      name = String(name).trim().slice(0, 40);
      if (!name) return Promise.reject(new Error('name cannot be blank'));
      var dupe = s.members.some(function (m) {
        return m.groupId === groupId && m.name.toLowerCase() === name.toLowerCase();
      });
      if (dupe) return Promise.reject(new Error('that name is already in this group'));
      var m = { id: uid('m'), groupId: groupId, name: name };
      s.members.push(m); save();
      return Promise.resolve(clone(m));
    },
    addExpense: function (ex) {
      var s = load();
      if (!ex.splitAmong || !ex.splitAmong.length) return Promise.reject(new Error('pick who to split with'));
      if (!Number.isInteger(ex.amountCents) || ex.amountCents <= 0) {
        return Promise.reject(new Error('amount must be positive'));
      }
      var e = {
        id: uid('e'), groupId: ex.groupId, description: String(ex.description).slice(0, 120) || 'Expense',
        amountCents: ex.amountCents, paidBy: ex.paidBy, splitAmong: ex.splitAmong.map(String), date: ex.date,
      };
      s.expenses.push(e); save();
      return Promise.resolve(clone(e));
    },
    addSettlement: function (st) {
      var s = load();
      if (st.fromId === st.toId) return Promise.reject(new Error('pick two different people'));
      var x = {
        id: uid('s'), groupId: st.groupId, fromId: st.fromId, toId: st.toId,
        amountCents: st.amountCents, date: st.date,
      };
      s.settlements.push(x); save();
      return Promise.resolve(clone(x));
    },
    deleteExpense: function (id) {
      var s = load();
      s.expenses = s.expenses.filter(function (e) { return e.id !== id; });
      save();
      return Promise.resolve({ ok: true });
    },
    deleteSettlement: function (id) {
      var s = load();
      s.settlements = s.settlements.filter(function (x) { return x.id !== id; });
      save();
      return Promise.resolve({ ok: true });
    },
    reset: function () { store = seed(); save(); return Promise.resolve(); },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SheetsBackend: SheetsBackend, DemoBackend: DemoBackend };
}
