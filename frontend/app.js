/* Splitwise clone frontend. Backend chosen in config.js (API_URL). */
(function () {
  'use strict';

  var backend = (typeof API_URL === 'string' && API_URL)
    ? SheetsBackend(API_URL)
    : DemoBackend();

  var state = { groups: [], members: [], expenses: [], settlements: [] };
  var view = { name: 'groups' }; // or { name:'group', id, tab:'balances'|'expenses' }
  var meByGroup = {}; // groupId -> memberId ("you are")

  /* ---------- helpers ---------- */

  function $(sel, el) { return (el || document).querySelector(sel); }
  function $all(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function dollarsToCents(str) {
    var n = Math.round(parseFloat(String(str).trim()) * 100);
    return (isFinite(n) && n > 0) ? n : null;
  }

  function todayISO() { return new Date().toISOString().slice(0, 10); }

  function membersOf(groupId) {
    return state.members.filter(function (m) { return m.groupId === groupId; });
  }
  function expensesOf(groupId) {
    return state.expenses
      .filter(function (e) { return e.groupId === groupId; })
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || '') || (b.id || '').localeCompare(a.id || ''); });
  }
  function settlementsOf(groupId) {
    return state.settlements
      .filter(function (s) { return s.groupId === groupId; })
      .sort(function (a, b) { return (b.date || '').localeCompare(a.date || '') || (b.id || '').localeCompare(a.id || ''); });
  }
  function memberName(id) {
    var m = state.members.filter(function (x) { return x.id === id; })[0];
    return m ? m.name : '?';
  }
  function myId(groupId) { return meByGroup[groupId] || null; }
  function displayName(groupId, id) {
    return id === myId(groupId) ? 'You' : memberName(id);
  }

  function loadMe() {
    try {
      meByGroup = JSON.parse(localStorage.getItem('splitwise-me') || '{}');
    } catch (_) { meByGroup = {}; }
  }
  function saveMe() {
    try { localStorage.setItem('splitwise-me', JSON.stringify(meByGroup)); } catch (_) {}
  }

  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  /* ---------- modal ---------- */

  function openModal(html) {
    var ov = $('#overlay');
    ov.innerHTML = '<div class="modal">' + html + '</div>';
    ov.classList.add('open');
    var first = $('#overlay input, #overlay select');
    if (first) first.focus();
  }
  function closeModal() {
    var ov = $('#overlay');
    ov.classList.remove('open');
    ov.innerHTML = '';
  }

  /* ---------- screens ---------- */

  function render() {
    closeModal();
    if (view.name === 'group') renderGroup();
    else renderGroups();
    window.scrollTo(0, 0);
  }

  function demoBanner() {
    if (backend.kind !== 'demo') return '';
    return '<div class="demo-banner">Demo mode — data stays in this browser. ' +
      'Connect your Google Sheet in <code>config.js</code> to share with friends.</div>';
  }

  function renderGroups() {
    var cards = state.groups.map(function (g) {
      var ms = membersOf(g.id);
      var nExp = expensesOf(g.id).length;
      return '<button class="group-card" data-group="' + esc(g.id) + '">' +
        '<span class="group-name">' + esc(g.name) + '</span>' +
        '<span class="group-meta">' + ms.length + ' people · ' + nExp + ' expenses</span>' +
        '</button>';
    }).join('');

    $('#app').innerHTML =
      demoBanner() +
      '<header class="top"><h1>Split it</h1></header>' +
      '<main class="wrap">' +
        (cards || '<p class="empty">No groups yet. Start one below.</p>') +
        '<button class="btn primary block" id="new-group">+ New group</button>' +
      '</main>';

    $all('[data-group]').forEach(function (el) {
      el.addEventListener('click', function () {
        view = { name: 'group', id: el.getAttribute('data-group'), tab: 'balances' };
        render();
      });
    });
    $('#new-group').addEventListener('click', newGroupModal);
  }

  function renderGroup() {
    var g = state.groups.filter(function (x) { return x.id === view.id; })[0];
    if (!g) { view = { name: 'groups' }; render(); return; }
    var ms = membersOf(g.id);
    var tab = view.tab || 'balances';

    var mePicker = '<label class="me-picker">You are ' +
      '<select id="me-select"><option value="">—</option>' +
      ms.map(function (m) {
        return '<option value="' + esc(m.id) + '"' +
          (myId(g.id) === m.id ? ' selected' : '') + '>' + esc(m.name) + '</option>';
      }).join('') + '</select></label>';

    var body = tab === 'balances' ? balancesTab(g, ms) : expensesTab(g, ms);

    $('#app').innerHTML =
      demoBanner() +
      '<header class="top sub">' +
        '<button class="back" id="back">‹</button>' +
        '<h1>' + esc(g.name) + '</h1>' +
        '<button class="icon-btn" id="add-member" title="Add person">＋</button>' +
      '</header>' +
      '<main class="wrap">' + mePicker +
        '<div class="tabs">' +
          '<button class="tab' + (tab === 'balances' ? ' active' : '') + '" data-tab="balances">Balances</button>' +
          '<button class="tab' + (tab === 'expenses' ? ' active' : '') + '" data-tab="expenses">Expenses</button>' +
        '</div>' + body +
      '</main>';

    $('#back').addEventListener('click', function () { view = { name: 'groups' }; render(); });
    $('#add-member').addEventListener('click', function () { addMemberModal(g); });
    $('#me-select').addEventListener('change', function (ev) {
      meByGroup[g.id] = ev.target.value || null;
      saveMe();
      render();
    });
    $all('[data-tab]').forEach(function (el) {
      el.addEventListener('click', function () {
        view.tab = el.getAttribute('data-tab');
        render();
      });
    });
    wireGroupButtons(g, ms);
  }

  function balancesTab(g, ms) {
    var ex = expensesOf(g.id), st = settlementsOf(g.id);
    var bal = computeBalances(ms, ex, st);
    var simplified = simplifyDebts(bal);
    var me = myId(g.id);

    var rows = ms.map(function (m) {
      var b = bal[m.id] || 0;
      var cls = b > 0 ? 'pos' : (b < 0 ? 'neg' : 'zero');
      var label = m.id === me ? 'You' : esc(m.name);
      var text = b > 0 ? 'is owed ' + formatMoney(b)
               : b < 0 ? 'owes ' + formatMoney(-b)
               : 'settled up';
      return '<div class="bal-row"><span>' + label + '</span>' +
        '<span class="' + cls + '">' + text + '</span></div>';
    }).join('');

    var pays = simplified.map(function (p) {
      return '<div class="pay-row"><span><b>' + esc(displayName(g.id, p.from)) +
        '</b> pays <b>' + esc(displayName(g.id, p.to)) + '</b></span>' +
        '<span class="amt">' + formatMoney(p.amountCents) + '</span></div>';
    }).join('');

    return '<section>' + (rows || '<p class="empty">Add people and expenses to see balances.</p>') + '</section>' +
      '<section><h2>Suggested payments</h2>' +
      (pays || '<p class="empty">Everyone is settled up 🎉</p>') +
      (ms.length >= 2 ? '<button class="btn primary block" id="settle">Record a payment</button>' : '') +
      '</section>';
  }

  function expensesTab(g, ms) {
    var ex = expensesOf(g.id), st = settlementsOf(g.id);
    var items = ex.map(function (e) {
      var who = e.splitAmong.map(function (id) { return esc(displayName(g.id, id)); }).join(', ');
      return '<div class="exp-row">' +
        '<div class="exp-main"><span class="exp-desc">' + esc(e.description) + '</span>' +
        '<span class="exp-sub">' + esc(e.date || '') + ' · ' + esc(displayName(g.id, e.paidBy)) +
        ' paid · split: ' + who + '</span></div>' +
        '<div class="exp-right"><span class="amt">' + formatMoney(e.amountCents) + '</span>' +
        '<button class="del" data-del-exp="' + esc(e.id) + '" title="Delete">×</button></div>' +
        '</div>';
    }).join('');

    var stItems = st.map(function (s) {
      return '<div class="exp-row settle">' +
        '<div class="exp-main"><span class="exp-desc">💸 ' + esc(displayName(g.id, s.fromId)) +
        ' → ' + esc(displayName(g.id, s.toId)) + '</span>' +
        '<span class="exp-sub">' + esc(s.date || '') + ' · payment recorded</span></div>' +
        '<div class="exp-right"><span class="amt">' + formatMoney(s.amountCents) + '</span>' +
        '<button class="del" data-del-settle="' + esc(s.id) + '" title="Delete">×</button></div>' +
        '</div>';
    }).join('');

    return '<button class="btn primary block" id="add-expense">+ Add expense</button>' +
      '<section>' + ((items + stItems) || '<p class="empty">No expenses yet.</p>') + '</section>';
  }

  function wireGroupButtons(g, ms) {
    var b;
    if ((b = $('#add-expense'))) b.addEventListener('click', function () { addExpenseModal(g, ms); });
    if ((b = $('#settle'))) b.addEventListener('click', function () { settleModal(g, ms); });
    $all('[data-del-exp]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (!confirm('Delete this expense?')) return;
        backend.deleteExpense(el.getAttribute('data-del-exp'))
          .then(refresh).catch(function (err) { toast(err.message, true); });
      });
    });
    $all('[data-del-settle]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (!confirm('Delete this payment?')) return;
        backend.deleteSettlement(el.getAttribute('data-del-settle'))
          .then(refresh).catch(function (err) { toast(err.message, true); });
      });
    });
  }

  /* ---------- modals ---------- */

  function newGroupModal() {
    openModal('<h2>New group</h2>' +
      '<label>Group name<input id="f-name" placeholder="e.g. Japan trip" maxlength="80"></label>' +
      '<div class="modal-actions"><button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn primary" id="m-ok">Create</button></div>');
    $('#m-cancel').addEventListener('click', closeModal);
    $('#m-ok').addEventListener('click', function () {
      var name = $('#f-name').value.trim();
      if (!name) { toast('Give the group a name', true); return; }
      backend.createGroup(name).then(function (g) {
        view = { name: 'group', id: g.id, tab: 'balances' };
        return refresh();
      }).then(function () { addMemberModal(state.groups.filter(function (x) { return x.id === view.id; })[0]); })
        .catch(function (err) { toast(err.message, true); });
    });
  }

  function addMemberModal(g) {
    openModal('<h2>Add person</h2>' +
      '<label>Name<input id="f-name" placeholder="e.g. Alex" maxlength="40"></label>' +
      '<div class="modal-actions"><button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn primary" id="m-ok">Add</button></div>');
    $('#m-cancel').addEventListener('click', closeModal);
    $('#m-ok').addEventListener('click', function () {
      var name = $('#f-name').value.trim();
      if (!name) { toast('Enter a name', true); return; }
      backend.addMember(g.id, name).then(refresh)
        .catch(function (err) { toast(err.message, true); });
    });
  }

  function addExpenseModal(g, ms) {
    if (ms.length < 1) { toast('Add people to the group first', true); return; }
    var me = myId(g.id);
    var paidOpts = ms.map(function (m) {
      return '<option value="' + esc(m.id) + '"' + (m.id === me ? ' selected' : '') + '>' +
        esc(m.name) + '</option>';
    }).join('');
    var checks = ms.map(function (m) {
      return '<label class="check"><input type="checkbox" data-split="' + esc(m.id) + '" checked> ' +
        esc(m.name) + '</label>';
    }).join('');

    openModal('<h2>Add expense</h2>' +
      '<label>Description<input id="f-desc" placeholder="e.g. Dinner" maxlength="120"></label>' +
      '<div class="row2">' +
      '<label>Amount ($)<input id="f-amount" inputmode="decimal" placeholder="0.00"></label>' +
      '<label>Date<input id="f-date" type="date" value="' + todayISO() + '"></label>' +
      '</div>' +
      '<label>Paid by<select id="f-paid">' + paidOpts + '</select></label>' +
      '<label>Split equally between</label><div class="checks">' + checks + '</div>' +
      '<div class="modal-actions"><button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn primary" id="m-ok">Add</button></div>');

    $('#m-cancel').addEventListener('click', closeModal);
    $('#m-ok').addEventListener('click', function () {
      var cents = dollarsToCents($('#f-amount').value);
      if (cents === null) { toast('Enter a valid amount', true); return; }
      var split = $all('[data-split]').filter(function (c) { return c.checked; })
        .map(function (c) { return c.getAttribute('data-split'); });
      if (!split.length) { toast('Pick at least one person to split with', true); return; }
      backend.addExpense({
        groupId: g.id,
        description: $('#f-desc').value.trim() || 'Expense',
        amountCents: cents,
        paidBy: $('#f-paid').value,
        splitAmong: split,
        date: $('#f-date').value || todayISO(),
      }).then(function () { view.tab = 'expenses'; return refresh(); })
        .catch(function (err) { toast(err.message, true); });
    });
  }

  function settleModal(g, ms) {
    var bal = computeBalances(ms, expensesOf(g.id), settlementsOf(g.id));
    var simplified = simplifyDebts(bal);
    var me = myId(g.id);

    function personOpts(selected) {
      return ms.map(function (m) {
        return '<option value="' + esc(m.id) + '"' + (m.id === selected ? ' selected' : '') + '>' +
          esc(m.name) + '</option>';
      }).join('');
    }

    var sug = '';
    if (simplified.length) {
      var p0 = simplified[0];
      sug = '<button class="btn block" id="use-suggested">Use suggested: ' +
        esc(displayName(g.id, p0.from)) + ' → ' + esc(displayName(g.id, p0.to)) +
        ' ' + formatMoney(p0.amountCents) + '</button>';
    }

    openModal('<h2>Record a payment</h2>' + sug +
      '<div class="row2"><label>From<select id="f-from">' + personOpts(me) + '</select></label>' +
      '<label>To<select id="f-to">' + personOpts() + '</select></label></div>' +
      '<div class="row2"><label>Amount ($)<input id="f-amount" inputmode="decimal" placeholder="0.00"></label>' +
      '<label>Date<input id="f-date" type="date" value="' + todayISO() + '"></label></div>' +
      '<div class="modal-actions"><button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn primary" id="m-ok">Record</button></div>');

    $('#m-cancel').addEventListener('click', closeModal);
    var useSug = $('#use-suggested');
    if (useSug) useSug.addEventListener('click', function () {
      $('#f-from').value = p0.from;
      $('#f-to').value = p0.to;
      $('#f-amount').value = (p0.amountCents / 100).toFixed(2);
    });
    $('#m-ok').addEventListener('click', function () {
      var cents = dollarsToCents($('#f-amount').value);
      if (cents === null) { toast('Enter a valid amount', true); return; }
      var from = $('#f-from').value, to = $('#f-to').value;
      if (from === to) { toast('Pick two different people', true); return; }
      backend.addSettlement({
        groupId: g.id, fromId: from, toId: to,
        amountCents: cents, date: $('#f-date').value || todayISO(),
      }).then(function () { view.tab = 'balances'; return refresh(); })
        .catch(function (err) { toast(err.message, true); });
    });
  }

  /* ---------- boot ---------- */

  function refresh() {
    return backend.getState().then(function (s) {
      state = s;
      render();
    }).catch(function (err) {
      $('#app').innerHTML = '<main class="wrap"><p class="empty">Couldn\'t load data: ' +
        esc(err.message) + '</p><button class="btn primary block" id="retry">Retry</button></main>';
      $('#retry').addEventListener('click', refresh);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('#overlay').addEventListener('click', function (ev) {
      if (ev.target.id === 'overlay') closeModal();
    });
    loadMe();
    refresh();
  });
})();
