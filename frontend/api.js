/**
 * Storage adapters. Both expose the same async interface. Mutations resolve to
 * { item, state } (or { state } for deletes), where state is the fresh full
 * state — one server round trip per action, no separate refresh needed.
 *
 *   getState()      -> { groups, members, expenses, settlements }
 *   createGroup({id?, name})                       -> { group, state }
 *   addMember({id?, groupId, name, venmo?})         -> { member, state }
 *   addMembers(groupId, [{id?, name, venmo?}])      -> { members, skipped, state }
 *     Batch add; names already in the group are skipped, not errors.
 *   addExpense({id?, groupId, description, amountCents, paidBy, splitAmong, shares?, date})
 *                                                   -> { expense, state }
 *     shares is an optional uneven split: {memberId: cents}, must total amountCents.
 *     Without it, the amount splits equally among splitAmong.
 *   updateExpense({id, groupId, description, amountCents, paidBy, splitAmong, shares?, date})
 *                                                   -> { expense, state }
 *     Edits an expense in place (receipt and created_at are kept).
 *   addSettlement({id?, groupId, fromId, toId, amountCents, date})
 *                                                   -> { settlement, state }
 *   uploadReceipt({expenseId, name?, mimeType?, data}) -> { receiptId, state }
 *     data is base64 (no data: prefix); stored in the owner's Google Drive.
 *   deleteExpense(id)                              -> { state }
 *   deleteSettlement(id)                            -> { state }
 *   deleteGroup(id)                                 -> { state }
 *     Deletes are soft: rows are flagged deleted and hidden, never removed.
 *
 * Shapes (both backends normalize to these):
 *   group:      { id, name }
 *   member:     { id, groupId, name, venmo }
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
      members: (s.members || []).map(normMember),
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
      createdAt: String(e.created_at !== undefined ? e.created_at : (e.createdAt || '')),
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
      createdAt: String(s.created_at !== undefined ? s.created_at : (s.createdAt || '')),
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
    return {
      id: String(m.id), groupId: String(m.group_id !== undefined ? m.group_id : m.groupId),
      name: m.name, venmo: cleanVenmo(m.venmo),
    };
  }
  // Venmo handle: strip a leading "@", keep handle-safe characters. Mirrors
  // the server's cleanVenmo_; lenient here so old backends don't break.
  function cleanVenmo(v) {
    if (v === undefined || v === null) return '';
    var s = String(v).trim().replace(/^@+/, '');
    return /^[A-Za-z0-9._-]{1,30}$/.test(s) ? s : '';
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
      return post({
        action: 'addMember', id: m.id, groupId: m.groupId,
        name: m.name, venmo: m.venmo || '',
      }).then(function (r) {
        return withState(r, 'member', normMember);
      });
    },
    addMembers: function (groupId, members) {
      var payload = {
        action: 'addMembers', groupId: groupId,
        members: members.map(function (m) {
          return { id: m.id, name: m.name, venmo: m.venmo || '' };
        }),
      };
      return post(payload).then(function (r) {
        var out = { state: normState(r.state), skipped: r.skipped || 0 };
        out.members = (r.members || []).map(normMember);
        return out;
      }).catch(function (err) {
        // Old backends don't know the batch action yet: fall back to
        // sequential single adds (same client ids, so idempotent).
        if (!/unknown action/i.test(err && err.message || '')) throw err;
        var chain = Promise.resolve();
        var last = null;
        members.forEach(function (m) {
          chain = chain.then(function () {
            return post({
              action: 'addMember', id: m.id, groupId: groupId,
              name: m.name, venmo: m.venmo || '',
            }).then(function (r) { last = r; });
          });
        });
        return chain.then(function () {
          return { members: members, skipped: 0, state: normState(last.state) };
        });
      });
    },
    addExpense: function (ex) {
      return post({
        action: 'addExpense', id: ex.id, groupId: ex.groupId, description: ex.description,
        amountCents: ex.amountCents, paidBy: ex.paidBy, splitAmong: ex.splitAmong,
        shares: ex.shares || null, date: ex.date,
      }).then(function (r) { return withState(r, 'expense', normExpense); });
    },
    updateExpense: function (ex) {
      return post({
        action: 'updateExpense', id: ex.id, groupId: ex.groupId, description: ex.description,
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
    deleteGroup: function (id) {
      return post({ action: 'deleteGroup', id: id }).then(function (r) { return withState(r); });
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
    var t = Date.now();
    function ts(offsetMs) { return new Date(t - offsetMs).toISOString(); }
    return {
      groups: [{ id: g, name: 'Tokyo Trip (demo)' }],
      members: [
        { id: a, groupId: g, name: 'Chashu', venmo: '' },
        { id: b, groupId: g, name: 'Alex', venmo: '' },
        { id: c, groupId: g, name: 'Priya', venmo: '' },
      ],
      expenses: [
        { id: uid('e'), groupId: g, description: 'Hotel (2 nights)', amountCents: 36000, paidBy: a, splitAmong: [a, b, c], date: today(), createdAt: ts(3000) },
        { id: uid('e'), groupId: g, description: 'Ramen dinner', amountCents: 8400, paidBy: b, splitAmong: [a, b, c], date: today(), createdAt: ts(2000) },
        { id: uid('e'), groupId: g, description: 'Train passes', amountCents: 15000, paidBy: c, splitAmong: [a, c], date: today(), createdAt: ts(1000) },
      ],
      settlements: [],
      activity: [],
    };
  }

  function load() {
    if (store) return store;
    try {
      if (typeof localStorage !== 'undefined') {
        var raw = localStorage.getItem(KEY);
        if (raw) { store = JSON.parse(raw); return migrate(store); }
      }
    } catch (_) { /* fall through to seed */ }
    store = seed();
    save();
    return store;
  }
  // Bring stores written by older versions up to the current shape.
  function migrate(s) {
    if (!s) return seed();
    if (!Array.isArray(s.activity)) s.activity = [];
    ['groups', 'expenses', 'settlements'].forEach(function (k) {
      if (!Array.isArray(s[k])) s[k] = [];
    });
    if (!Array.isArray(s.members)) s.members = [];
    return s;
  }
  function save() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(store));
    } catch (_) { /* private mode etc. */ }
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function live(items) { return items.filter(function (x) { return !x.deleted; }); }
  /** Public state: soft-deleted rows hidden, like the server's readDb. */
  function pub(s) {
    var c = clone(s);
    c.groups = live(c.groups);
    c.expenses = live(c.expenses);
    c.settlements = live(c.settlements);
    return c;
  }
  function snap(s) { return { state: pub(s) }; }
  // Append-only audit log (demo equivalent of the sheet's activity tab).
  function log(s, action, groupId, targetId, details) {
    s.activity.push({
      id: uid('a'), createdAt: new Date().toISOString(), action: action,
      groupId: groupId || '', targetId: targetId || '', details: details || {},
    });
    if (s.activity.length > 500) s.activity.splice(0, s.activity.length - 500);
  }
  // Same normalization as the server: "jiashu wang" -> "Jiashu Wang",
  // so the same person is recognized across groups.
  function titleCase(v) {
    var parts = String(v).trim().split(/\s+/).filter(Boolean);
    return parts.map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ').slice(0, 40);
  }
  function cleanVenmo(v) {
    if (v === undefined || v === null) return '';
    var s = String(v).trim().replace(/^@+/, '');
    return /^[A-Za-z0-9._-]{1,30}$/.test(s) ? s : '';
  }
  function makeMember(s, groupId, raw) {
    var name = titleCase(raw.name);
    if (!name) throw new Error('name cannot be blank');
    var dupe = s.members.some(function (x) {
      return x.groupId === groupId && titleCase(x.name) === name;
    });
    if (dupe) throw new Error('that name is already in this group');
    var member = {
      id: raw.id || uid('m'), groupId: groupId, name: name,
      venmo: cleanVenmo(raw.venmo),
    };
    s.members.push(member);
    return member;
  }

  return {
    kind: 'demo',
    getState: function () { return Promise.resolve(pub(load())); },
    createGroup: function (g) {
      var s = load();
      var grp = { id: g.id || uid('g'), name: String(g.name).slice(0, 80), deleted: false };
      s.groups.push(grp);
      log(s, 'createGroup', grp.id, grp.id, { name: grp.name });
      save();
      return Promise.resolve({ group: clone(grp), state: pub(s) });
    },
    addMember: function (m) {
      var s = load();
      var member;
      try {
        member = makeMember(s, m.groupId, m);
      } catch (e) { return Promise.reject(e); }
      log(s, 'addMember', m.groupId, member.id, { name: member.name, venmo: member.venmo });
      save();
      return Promise.resolve({ member: clone(member), state: pub(s) });
    },
    addMembers: function (groupId, members) {
      var s = load();
      var added = [], skipped = 0;
      try {
        members.forEach(function (raw) {
          try {
            added.push(makeMember(s, groupId, raw));
          } catch (e) {
            skipped++; // duplicate name (or blank): skip like the server
          }
        });
      } catch (e) { return Promise.reject(e); }
      log(s, 'addMembers', groupId, '', {
        added: added.map(function (x) { return x.name; }), skipped: skipped,
      });
      save();
      return Promise.resolve({ members: clone(added), skipped: skipped, state: pub(s) });
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
        shares: shares, receiptId: '', date: ex.date, createdAt: new Date().toISOString(),
        deleted: false,
      };
      s.expenses.push(e);
      log(s, 'addExpense', ex.groupId, e.id, { description: e.description, amountCents: e.amountCents, paidBy: e.paidBy });
      save();
      return Promise.resolve({ expense: clone(e), state: pub(s) });
    },
    updateExpense: function (ex) {
      var s = load();
      var e = s.expenses.filter(function (x) { return x.id === ex.id && !x.deleted; })[0];
      if (!e) return Promise.reject(new Error('unknown expense'));
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
      e.description = String(ex.description).slice(0, 120) || 'Expense';
      e.amountCents = ex.amountCents;
      e.paidBy = ex.paidBy;
      e.splitAmong = ex.splitAmong.map(String);
      e.shares = shares;
      e.date = ex.date;
      log(s, 'updateExpense', ex.groupId, e.id, { description: e.description, amountCents: e.amountCents, paidBy: e.paidBy });
      save();
      return Promise.resolve({ expense: clone(e), state: pub(s) });
    },
    addSettlement: function (st) {
      var s = load();
      if (st.fromId === st.toId) return Promise.reject(new Error('pick two different people'));
      var x = {
        id: st.id || uid('s'), groupId: st.groupId, fromId: st.fromId, toId: st.toId,
        amountCents: st.amountCents, date: st.date, createdAt: new Date().toISOString(),
        deleted: false,
      };
      s.settlements.push(x);
      log(s, 'addSettlement', st.groupId, x.id, { fromId: x.fromId, toId: x.toId, amountCents: x.amountCents });
      save();
      return Promise.resolve({ settlement: clone(x), state: pub(s) });
    },
    deleteExpense: function (id) {
      var s = load();
      var e = s.expenses.filter(function (x) { return x.id === id; })[0];
      if (!e) return Promise.reject(new Error('not found'));
      if (!e.deleted) {
        e.deleted = true;
        log(s, 'deleteExpense', e.groupId, id, {});
      }
      save();
      return Promise.resolve(snap(s));
    },
    deleteSettlement: function (id) {
      var s = load();
      var x = s.settlements.filter(function (x) { return x.id === id; })[0];
      if (!x) return Promise.reject(new Error('not found'));
      if (!x.deleted) {
        x.deleted = true;
        log(s, 'deleteSettlement', x.groupId, id, {});
      }
      save();
      return Promise.resolve(snap(s));
    },
    deleteGroup: function (id) {
      var s = load();
      var g = s.groups.filter(function (x) { return x.id === id; })[0];
      if (!g) return Promise.reject(new Error('unknown group'));
      if (!g.deleted) {
        g.deleted = true;
        log(s, 'deleteGroup', id, id, { name: g.name });
      }
      save();
      return Promise.resolve(snap(s));
    },
    uploadReceipt: function (r) {
      var s = load();
      var ex = s.expenses.filter(function (e) { return e.id === r.expenseId; })[0];
      if (!ex) return Promise.reject(new Error('unknown expense'));
      ex.receiptId = 'demo-receipt';
      log(s, 'uploadReceipt', ex.groupId, ex.id, {});
      save();
      return Promise.resolve({ receiptId: 'demo-receipt', state: pub(s) });
    },
    reset: function () { store = seed(); save(); return Promise.resolve(); },
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SheetsBackend: SheetsBackend, DemoBackend: DemoBackend };
}
