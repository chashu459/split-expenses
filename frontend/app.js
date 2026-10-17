/* Splitwise clone frontend. Backend chosen in config.js (API_URL). */
(function () {
  'use strict';

  var backend = (typeof API_URL === 'string' && API_URL)
    ? SheetsBackend(API_URL)
    : DemoBackend();

  var state = { groups: [], members: [], expenses: [], settlements: [] };
  var view = { name: 'groups' }; // or { name:'group', id, tab:'balances'|'expenses' }
  // Global identity: one normalized name ("Jiashu Wang"). A member with the
  // same name in any group is recognized as the same person.
  var myName = null;

  /* ---------- helpers ---------- */

  function $(sel, el) { return (el || document).querySelector(sel); }
  function $all(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }

  // "jiashu wang" -> "Jiashu Wang". Mirrors the server's normalizeMemberName_.
  function normalizeName(v) {
    var parts = String(v == null ? '' : v).trim().split(/\s+/).filter(Boolean);
    return parts.map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).join(' ');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function dollarsToCents(str) {
    var n = Math.round(parseFloat(String(str).trim()) * 100);
    return (isFinite(n) && n > 0) ? n : null;
  }

  // Parse one custom-split amount box.
  // -> {state:'empty'} for blank or zero (counts as 0, excluded from the split),
  //    {state:'ok', cents} for a positive amount,
  //    {state:'bad'} for garbage/negative input.
  function parseShareInput(raw) {
    var t = String(raw == null ? '' : raw).trim();
    if (t === '') return { state: 'empty' };
    var n = Math.round(parseFloat(t) * 100);
    if (!isFinite(n) || n < 0) return { state: 'bad' };
    if (n === 0) return { state: 'empty' };
    return { state: 'ok', cents: n };
  }

  function fmtDate(d) { return String(d || '').slice(0, 10); } // date only, never datetime
  function todayISO() { return new Date().toISOString().slice(0, 10); }

  function uuid() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    } catch (_) {}
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* Optimistic mutations: apply locally and render instantly, then sync with
   * the server through a serial queue. pendingOps drives the sync spinner in
   * the header so it's always clear something is still saving. On failure we
   * toast and reload server truth to roll back. */
  var opChain = Promise.resolve();
  var pendingOps = 0;
  function mutate(label, optimisticFn, requestFn) {
    pendingOps++;
    try { optimisticFn(); } catch (_) {}
    render();
    opChain = opChain.then(function () {
      return Promise.resolve()
        .then(requestFn)
        .then(function (out) {
          pendingOps--;
          setState(out.state);
          renderPage();
        })
        .catch(function (err) {
          pendingOps--;
          toast(label + ' failed (' + (err && err.message || err) + ') — reloading.', true);
          return backend.getState().then(function (s) {
            setState(s);
            renderPage();
          }).catch(function () { renderPage(); });
        });
    });
  }
  function syncDot() {
    return '<span class="syncdot' + (pendingOps > 0 ? '' : ' hidden') +
      '" title="Syncing…">⟳</span>';
  }

  /* ---------- member avatars ---------- */

  // 12 hues spread around the wheel so neighbors never look alike.
  var AVATAR_COLORS = ['#dc2626', '#ea580c', '#d97706', '#a3a307', '#65a30d',
                       '#16a34a', '#0d9488', '#0891b2', '#2563eb', '#7c3aed',
                       '#c026d3', '#db2777'];

  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function baseInitials(name) {
    var parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }

  // Unique per group: "AJ", and "AJ2", "AJ3"… when initials collide.
  function avatarLabel(member, members) {
    var base = baseInitials(member.name);
    var same = (members || []).filter(function (m) { return baseInitials(m.name) === base; });
    if (same.length < 2) return base;
    var idx = same.map(function (m) { return m.id; }).indexOf(member.id);
    return idx <= 0 ? base : base + (idx + 1);
  }

  function avatarHTML(member, members) {
    if (!member) return '';
    return '<span class="avatar" style="background:' + avatarColor(member, members) + '" title="' +
      esc(normalizeName(member.name)) + '">' + esc(avatarLabel(member, members)) + '</span>';
  }

  // Color by position in the member list (deduped by name), so the people
  // you see together always get distinct colors. Falls back to the name
  // hash when the member isn't in the list.
  function avatarColor(member, members) {
    var order = [], seen = {};
    (members || []).forEach(function (m) {
      var n = normalizeName(m.name);
      if (!seen[n]) { seen[n] = true; order.push(n); }
    });
    var idx = order.indexOf(normalizeName(member.name));
    if (idx === -1) idx = hashStr(normalizeName(member.name));
    return AVATAR_COLORS[idx % AVATAR_COLORS.length];
  }

  function receiptURL(e) {
    if (!e.receiptId || e.receiptId === 'demo-receipt') return null;
    return 'https://drive.google.com/file/d/' + encodeURIComponent(e.receiptId) + '/view';
  }

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
  function memberById(id) {
    return state.members.filter(function (x) { return x.id === id; })[0] || null;
  }
  function memberName(id) {
    var m = memberById(id);
    return m ? normalizeName(m.name) : '?';
  }
  // My member id within a group: the member whose normalized name matches
  // the global identity (null when not found).
  function myId(groupId) {
    if (!myName) return null;
    var ms = membersOf(groupId);
    for (var i = 0; i < ms.length; i++) {
      if (normalizeName(ms[i].name) === myName) return ms[i].id;
    }
    return null;
  }
  function displayName(groupId, id) {
    return id === myId(groupId) ? 'You' : memberName(id);
  }

  // Normalize member names on every state load so legacy rows and other
  // clients' data match the same-person identity.
  function setState(s) {
    (s.members || []).forEach(function (m) { m.name = normalizeName(m.name); });
    state = s;
  }

  function loadMe() {
    try {
      myName = localStorage.getItem('splitwise-me-name') || null;
    } catch (_) { myName = null; }
  }
  function saveMe() {
    try {
      if (myName) localStorage.setItem('splitwise-me-name', myName);
      else localStorage.removeItem('splitwise-me-name');
    } catch (_) {}
  }
  // One-time migration from the old per-group map {groupId: memberId}.
  function migrateLegacyMe() {
    if (myName) return;
    try {
      var old = JSON.parse(localStorage.getItem('splitwise-me') || '{}');
      var ids = Object.keys(old);
      for (var i = 0; i < ids.length; i++) {
        var m = memberById(old[ids[i]]);
        if (m) { myName = normalizeName(m.name); saveMe(); break; }
      }
      localStorage.removeItem('splitwise-me');
    } catch (_) {}
  }

  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.className = 'toast'; }, 2600);
  }

  function meChipHTML() {
    var label = myName ? 'You are: <b>' + esc(myName) + '</b>' : 'Who are you?';
    return '<button class="me-chip" id="me-btn" title="Your identity — tap to change">' +
      label + '</button>';
  }
  function wireMeChip() {
    var b = $('#me-btn');
    if (b) b.addEventListener('click', function () { identityModal(!myName); });
  }

  // This identity's Venmo handle, from the first matching member row.
  function myVenmo() {
    if (!myName) return '';
    for (var i = 0; i < state.members.length; i++) {
      var m = state.members[i];
      if (normalizeName(m.name) === myName && m.venmo) return m.venmo;
    }
    return '';
  }
  // Every distinct member name across groups, for the "who are you" picker.
  function knownNames() {
    var seen = {}, out = [];
    state.members.forEach(function (m) {
      var n = normalizeName(m.name);
      if (n && !seen[n]) { seen[n] = true; out.push(n); }
    });
    out.sort();
    return out;
  }

  /* ---------- modal ---------- */

  function openModal(html, opts) {
    var ov = $('#overlay');
    ov.innerHTML = '<div class="modal">' + html + '</div>';
    ov.classList.add('open');
    // opts.lock: the modal can't be dismissed by clicking the overlay
    // (used for gates the user must answer, like joining a group).
    ov._locked = !!(opts && opts.lock);
    var first = $('#overlay input, #overlay select');
    if (first) first.focus();
  }
  function closeModal() {
    var ov = $('#overlay');
    ov._locked = false;
    ov.classList.remove('open');
    ov.innerHTML = '';
  }

  /* ---------- screens ---------- */

  function render() {
    closeModal();
    renderPage();
    window.scrollTo(0, 0);
  }

  // Re-render the page behind any open modal (used when a background sync
  // finishes — never steals a half-filled form).
  function renderPage() {
    if (view.name === 'group') renderGroup();
    else renderGroups();
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
      var faces = ms.slice(0, 5).map(function (m) { return avatarHTML(m, ms); }).join('');
      return '<div class="group-card-wrap">' +
        '<button class="group-card" data-group="' + esc(g.id) + '">' +
        '<span class="group-faces">' + faces + '</span>' +
        '<span class="group-name">' + esc(g.name) + '</span>' +
        '<span class="group-meta">' + ms.length + ' people · ' + nExp + ' expenses</span>' +
        '</button>' +
        '<button class="card-del" data-del-group="' + esc(g.id) + '" title="Delete group">×</button>' +
        '</div>';
    }).join('');

    $('#app').innerHTML =
      demoBanner() +
      '<header class="top"><h1>Split it</h1>' + syncDot() + meChipHTML() + '</header>' +
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
    $all('[data-del-group]').forEach(function (el) {
      el.addEventListener('click', function (ev) {
        ev.stopPropagation();
        deleteGroupFlow(el.getAttribute('data-del-group'));
      });
    });
    $('#new-group').addEventListener('click', newGroupModal);
    wireMeChip();
  }

  // Shared delete-group flow (list page only): warns about unsettled
  // balances, then soft-deletes. Stays on the current view.
  function deleteGroupFlow(groupId) {
    var g = state.groups.filter(function (x) { return x.id === groupId; })[0];
    if (!g) return;
    var ms = membersOf(groupId);
    var open = simplifyDebts(computeBalances(ms, expensesOf(groupId), settlementsOf(groupId))).length;
    var msg = open > 0
      ? 'This group still has ' + open + ' unsettled payment' + (open === 1 ? '' : 's') +
        '. Delete the group anyway? It will be hidden from the app but kept in the sheet.'
      : 'Delete this group? It will be hidden from the app but kept in the sheet.';
    if (!confirm(msg)) return;
    mutate('Delete group',
      function () { state.groups = state.groups.filter(function (x) { return x.id !== groupId; }); },
      function () { return backend.deleteGroup(groupId); });
  }

  function groupHeaderHTML(g) {
    return '<header class="top sub">' +
      '<button class="back" id="back">‹</button>' +
      '<h1>' + esc(g.name) + '</h1>' + syncDot() + meChipHTML();
  }

  function renderGroup() {
    var g = state.groups.filter(function (x) { return x.id === view.id; })[0];
    if (!g) { view = { name: 'groups' }; render(); return; }
    var ms = membersOf(g.id);

    var headerHtml = groupHeaderHTML(g);

    // Join gate: an identified non-member sees no group content — just the
    // prompt to join (or decline, which clears the identity).
    if (myName && !myId(g.id)) {
      $('#app').innerHTML = demoBanner() + headerHtml + '</header>' +
        '<main class="wrap"><p class="empty">You\'re not a member of this group yet.</p></main>';
      $('#back').addEventListener('click', function () { view = { name: 'groups' }; render(); });
      wireMeChip();
      joinPromptModal(g);
      return;
    }

    var tab = view.tab || 'balances';
    var body = tab === 'balances' ? balancesTab(g, ms) : expensesTab(g, ms);

    $('#app').innerHTML =
      demoBanner() + headerHtml +
        '<button class="icon-btn" data-add-expense title="Add expense">＋</button>' +
        '<div class="menu-wrap">' +
          '<button class="icon-btn" id="settings-btn" title="Group settings">⚙</button>' +
          '<div class="menu hidden" id="settings-menu">' +
            '<button data-menu="members">Manage members</button>' +
          '</div>' +
        '</div>' +
      '</header>' +
      '<main class="wrap">' +
        '<div class="tabs">' +
          '<button class="tab' + (tab === 'balances' ? ' active' : '') + '" data-tab="balances">Balances</button>' +
          '<button class="tab' + (tab === 'expenses' ? ' active' : '') + '" data-tab="expenses">Expenses</button>' +
        '</div>' + body +
      '</main>';

    $('#back').addEventListener('click', function () { view = { name: 'groups' }; render(); });
    $all('[data-add-expense]').forEach(function (el) {
      el.addEventListener('click', function () { expenseModal(g, ms, null); });
    });
    $('#settings-btn').addEventListener('click', function (ev) {
      ev.stopPropagation();
      $('#settings-menu').classList.toggle('hidden');
    });
    $('#settings-menu [data-menu="members"]').addEventListener('click', function () {
      $('#settings-menu').classList.add('hidden');
      membersModal(g);
    });
    wireMeChip();
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
      return '<div class="bal-row"><div class="bal-left">' + avatarHTML(m, ms) +
        '<span>' + label + '</span></div>' +
        '<span class="' + cls + '">' + text + '</span></div>';
    }).join('');

    var pays = simplified.map(function (p) {
      var from = memberById(p.from), to = memberById(p.to);
      return '<div class="pay-row"><div class="pay-left">' + avatarHTML(from, ms) +
        '<b>' + esc(displayName(g.id, p.from)) + '</b><span class="pays-word">pays</span><b>' +
        esc(displayName(g.id, p.to)) + '</b>' + avatarHTML(to, ms) + '</div>' +
        '<span class="amt">' + formatMoney(p.amountCents) + '</span></div>';
    }).join('');

    return '<section>' + (rows || '<p class="empty">Add people and expenses to see balances.</p>') + '</section>' +
      '<section><h2>Suggested payments</h2>' +
      (pays || '<p class="empty">Everyone is settled up 🎉</p>') +
      (ms.length >= 2 ? '<button class="btn primary block" id="settle">Record a payment</button>' : '') +
      '</section>';
  }

  // How the selected ("you are") user fares in one expense:
  // "You lent $X" / "You borrowed $X" / "Even" / "You're not involved".
  // Returns { net, involved } or null when no user is selected.
  function myExpenseNet(g, e) {
    var me = myId(g.id);
    if (!me) return null;
    var owed = owedSplit(e);
    var myOwed = owed[String(me)] || 0;
    var paidByMe = String(e.paidBy) === String(me);
    var inSplit = e.splitAmong.map(String).indexOf(String(me)) !== -1;
    if (!paidByMe && !inSplit && myOwed <= 0) return { net: 0, involved: false };
    return { net: (paidByMe ? e.amountCents : 0) - myOwed, involved: true };
  }

  function myExpenseLine(g, e) {
    var r = myExpenseNet(g, e);
    if (!r) return '';
    if (!r.involved) return '<span class="myshare muted">You\'re not involved</span>';
    if (r.net > 0) return '<span class="myshare pos">You lent ' + formatMoney(r.net) + '</span>';
    if (r.net < 0) return '<span class="myshare neg">You borrowed ' + formatMoney(-r.net) + '</span>';
    return '<span class="myshare zero">Even</span>';
  }

  // Signed personal amount for the right-hand column: +$X lent, −$X borrowed.
  // Falls back to the total (muted) when the user isn't involved or selected.
  function myExpenseAmt(g, e) {
    var r = myExpenseNet(g, e);
    if (r && r.involved) {
      if (r.net > 0) return '<span class="amt pos">+' + formatMoney(r.net) + '</span>';
      if (r.net < 0) return '<span class="amt neg">−' + formatMoney(-r.net) + '</span>';
      return '<span class="amt zero">' + formatMoney(0) + '</span>';
    }
    var cls = r ? ' zero' : '';
    return '<span class="amt' + cls + '">' + formatMoney(e.amountCents) + '</span>';
  }

  // 'paid' | 'received' | 'uninvolved' | null (no user selected)
  function mySettlementDir(g, s) {
    var me = myId(g.id);
    if (!me) return null;
    if (String(s.fromId) === String(me)) return 'paid';
    if (String(s.toId) === String(me)) return 'received';
    return 'uninvolved';
  }

  function mySettlementLine(g, s) {
    var d = mySettlementDir(g, s);
    if (!d) return '';
    if (d === 'paid') {
      return '<span class="myshare neg">You paid ' + formatMoney(s.amountCents) + '</span>';
    }
    if (d === 'received') {
      return '<span class="myshare pos">You received ' + formatMoney(s.amountCents) + '</span>';
    }
    return '<span class="myshare muted">You\'re not involved</span>';
  }

  function mySettlementAmt(g, s) {
    var d = mySettlementDir(g, s);
    if (d === 'paid') return '<span class="amt neg">−' + formatMoney(s.amountCents) + '</span>';
    if (d === 'received') return '<span class="amt pos">+' + formatMoney(s.amountCents) + '</span>';
    var cls = d ? ' zero' : '';
    return '<span class="amt' + cls + '">' + formatMoney(s.amountCents) + '</span>';
  }

  // "Today" / "Yesterday" / "Oct 16, 2026"
  function dateHeaderLabel(d) {
    var today = todayISO();
    if (d === today) return 'Today';
    var y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (d === y) return 'Yesterday';
    var p = String(d).split('-');
    if (p.length !== 3) return d;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var mi = Number(p[1]) - 1;
    return (months[mi] || p[1]) + ' ' + Number(p[2]) + ', ' + p[0];
  }

  function expensesTab(g, ms) {
    // One interleaved feed: expenses + payments, grouped under date
    // headers, newest first — ordered by date, then time created.
    var feed = [];
    expensesOf(g.id).forEach(function (e) {
      var who = e.splitAmong.map(function (id) { return esc(displayName(g.id, id)); }).join(', ');
      var splitNote = e.shares ? ' · custom split' : '';
      var payer = memberById(e.paidBy);
      var rurl = receiptURL(e);
      var receipt = rurl
        ? ' <a class="receipt" href="' + rurl + '" target="_blank" rel="noopener" title="View receipt">🧾</a>'
        : (e.receiptId ? ' <span class="receipt" title="Receipt attached">🧾</span>' : '');
      feed.push({
        date: fmtDate(e.date), createdAt: e.createdAt || '', id: e.id,
        html: '<div class="exp-row"><div class="exp-left">' + avatarHTML(payer, ms) +
          '<div class="exp-main"><span class="exp-desc">' + esc(e.description) + receipt + '</span>' +
          myExpenseLine(g, e) +
          '<span class="exp-sub">' + formatMoney(e.amountCents) + ' total · ' +
          esc(displayName(g.id, e.paidBy)) + ' paid · split: ' + who + splitNote + '</span></div></div>' +
          '<div class="exp-right">' + myExpenseAmt(g, e) +
          '<button class="edit-btn" data-edit-exp="' + esc(e.id) + '" title="Details">ⓘ</button></div>' +
          '</div>',
      });
    });
    settlementsOf(g.id).forEach(function (s) {
      feed.push({
        date: fmtDate(s.date), createdAt: s.createdAt || '', id: s.id,
        html: '<div class="exp-row settle"><div class="exp-left">' +
          '<div class="exp-main"><span class="exp-desc">💸 ' + esc(displayName(g.id, s.fromId)) +
          ' → ' + esc(displayName(g.id, s.toId)) + '</span>' +
          mySettlementLine(g, s) +
          '<span class="exp-sub">' + formatMoney(s.amountCents) + ' · payment recorded</span></div></div>' +
          '<div class="exp-right">' + mySettlementAmt(g, s) +
          '<button class="del" data-del-settle="' + esc(s.id) + '" title="Delete">×</button></div>' +
          '</div>',
      });
    });
    feed.sort(function (a, b) {
      return (b.date || '').localeCompare(a.date || '') ||
             (b.createdAt || '').localeCompare(a.createdAt || '') ||
             String(b.id).localeCompare(String(a.id));
    });
    var html = '', lastDate = null;
    feed.forEach(function (item) {
      if (item.date !== lastDate) {
        html += '<div class="date-head">' + esc(dateHeaderLabel(item.date || 'Undated')) + '</div>';
        lastDate = item.date;
      }
      html += item.html;
    });

    return '<button class="btn primary block" data-add-expense>+ Add expense</button>' +
      '<section>' + (html || '<p class="empty">No expenses yet.</p>') + '</section>';
  }

  function wireGroupButtons(g, ms) {
    var b;
    if ((b = $('#settle'))) b.addEventListener('click', function () { settleModal(g, ms); });
    $all('[data-edit-exp]').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-edit-exp');
        var ex = state.expenses.filter(function (e) { return e.id === id; })[0];
        if (ex) expenseModal(g, ms, ex);
      });
    });
    $all('[data-del-settle]').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-del-settle');
        if (!confirm('Delete this payment?')) return;
        mutate('Delete payment',
          function () { state.settlements = state.settlements.filter(function (s) { return s.id !== id; }); },
          function () { return backend.deleteSettlement(id); });
      });
    });
  }

  /* ---------- modals ---------- */

  // "Who are you?" picker (setup=true, first visit) or identity editor.
  // The editor has three jobs: switch to a known person, add a brand-new
  // person (identity only — no member rows touched), and edit the current
  // identity's name/Venmo (renames this person's member rows in every
  // group, skipping groups where the name is taken).
  function identityModal(setup) {
    var names = knownNames().filter(function (n) { return n !== myName; });
    var listHtml = names.map(function (n) {
      return '<button class="id-pick" data-pick="' + esc(n) + '">' + esc(n) + '</button>';
    }).join('');
    if (setup) {
      openModal('<h2>Who are you?</h2>' +
        '<p class="muted">Pick your name so the app can show your personal share.</p>' +
        (listHtml ? '<div class="id-list">' + listHtml + '</div><div class="or">or</div>' : '') +
        '<label>Your name<input id="f-myname" maxlength="40" placeholder="e.g. Alex"></label>' +
        '<div class="modal-actions"><button class="btn" id="m-cancel">Cancel</button>' +
        '<button class="btn primary" id="m-ok">Save</button></div>');
      wireIdentityModal(null);
      return;
    }
    openModal('<h2>Your identity</h2>' +
      (listHtml
        ? '<div class="sect-label">Switch to</div><div class="id-list">' + listHtml + '</div>'
        : '') +
      '<div class="sect-label">Add a new person</div>' +
      '<div class="inline-row"><input id="f-newname" maxlength="40" placeholder="New name">' +
      '<button class="btn" id="m-add-new">Add</button></div>' +
      '<div class="sect-label">Edit ' + esc(myName || '') + '</div>' +
      '<label>Display name<input id="f-myname" maxlength="40" value="' + esc(myName || '') + '"></label>' +
      '<label>Venmo handle (optional)<input id="f-myvenmo" maxlength="32" value="' +
      esc(myVenmo()) + '" placeholder="@handle"></label>' +
      '<div class="modal-actions"><button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn primary" id="m-ok">Save</button></div>');
    wireIdentityModal(true);
  }

  function wireIdentityModal(isEditor) {
    $all('[data-pick]').forEach(function (el) {
      el.addEventListener('click', function () {
        myName = normalizeName(el.getAttribute('data-pick'));
        saveMe();
        closeModal();
        render();
      });
    });
    var addBtn = $('#m-add-new');
    if (addBtn) addBtn.addEventListener('click', function () {
      var n = normalizeName($('#f-newname').value);
      if (!n) { toast('Enter a name', true); return; }
      myName = n; // fresh identity: no member rows are touched
      saveMe();
      closeModal();
      render();
    });
    $('#m-cancel').addEventListener('click', closeModal);
    $('#m-ok').addEventListener('click', function () {
      var newName = normalizeName($('#f-myname').value);
      if (!newName) { toast('Enter your name', true); return; }
      var vEl = $('#f-myvenmo');
      var newVenmo = vEl ? vEl.value.trim().replace(/^@+/, '') : null;
      if (newVenmo && !/^[A-Za-z0-9._-]{1,30}$/.test(newVenmo)) {
        toast('Bad Venmo handle', true); return;
      }
      saveIdentity(newName, newVenmo);
    });
  }

  function saveIdentity(newName, newVenmo) {
    var oldName = myName;
    var rows = oldName ? state.members.filter(function (m) {
      return normalizeName(m.name) === oldName;
    }) : [];
    var skippedGroups = [];
    var targets = [];
    rows.forEach(function (m) {
      var collision = newName !== oldName && state.members.some(function (x) {
        return x.id !== m.id && x.groupId === m.groupId &&
               normalizeName(x.name) === newName;
      });
      if (collision) { skippedGroups.push(m.groupId); return; }
      targets.push(m);
    });
    mutate('Save identity',
      function () {
        targets.forEach(function (m) {
          m.name = newName;
          if (newVenmo !== null) m.venmo = newVenmo;
        });
        myName = newName;
        saveMe();
      },
      function () {
        var chain = Promise.resolve(null);
        targets.forEach(function (m) {
          chain = chain.then(function () {
            var patch = { name: newName };
            if (newVenmo !== null) patch.venmo = newVenmo;
            return backend.updateMember(m.groupId, m.id, patch);
          });
        });
        return chain.then(function (last) {
          return last ? { state: last.state } : { state: state };
        });
      });
    if (skippedGroups.length) {
      toast('Name taken in ' + skippedGroups.length + ' group(s) — left unchanged there.', true);
    }
  }

  function newGroupModal() {
    openModal('<h2>New group</h2>' +
      '<label>Group name<input id="f-name" placeholder="e.g. Japan trip" maxlength="80"></label>' +
      '<div class="modal-actions"><button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn primary" id="m-ok">Create</button></div>');
    $('#m-cancel').addEventListener('click', closeModal);
    $('#m-ok').addEventListener('click', function () {
      var name = $('#f-name').value.trim();
      if (!name) { toast('Give the group a name', true); return; }
      var g = { id: uuid(), name: name };
      view = { name: 'group', id: g.id, tab: 'balances' };
      // The creator joins the group automatically (when an identity is set).
      var selfMember = myName
        ? { id: uuid(), groupId: g.id, name: myName, venmo: '' }
        : null;
      mutate('Create group',
        function () {
          state.groups.push(g);
          if (selfMember) state.members.push(selfMember);
        },
        function () {
          return backend.createGroup(g).then(function (out) {
            if (!selfMember) return out;
            return backend.addMember(selfMember);
          });
        });
      addMemberModal({ id: g.id, name: g.name });
    });
  }

  // Parse batch member input: one per line, optional trailing @venmo handle.
  // "Alex" -> {name:'Alex', venmo:''}; "Priya @priya-pays" -> {name:'Priya', venmo:'priya-pays'}.
  // Returns { members, bad } where bad lists lines with an invalid handle.
  function parseMemberLines(text) {
    var members = [], bad = [];
    String(text == null ? '' : text).split('\n').forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var at = t.lastIndexOf('@');
      if (at === -1) {
        members.push({ name: normalizeName(t), venmo: '' });
        return;
      }
      var namePart = t.slice(0, at).trim();
      var handle = t.slice(at + 1).trim();
      if (!namePart || !/^[A-Za-z0-9._-]{1,30}$/.test(handle)) {
        bad.push(t);
        return;
      }
      members.push({ name: normalizeName(namePart), venmo: handle });
    });
    return { members: members, bad: bad };
  }

  function addMemberModal(g) {
    openModal('<h2>Add people</h2>' +
      '<label>One per line — add <b>@venmo</b> after a name to set their Venmo handle' +
      '<textarea id="f-names" rows="4" placeholder="Alex\nPriya @priya-pays"></textarea></label>' +
      '<div class="modal-actions"><button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn primary" id="m-ok">Add</button></div>');
    $('#m-cancel').addEventListener('click', closeModal);
    $('#m-ok').addEventListener('click', function () {
      var parsed = parseMemberLines($('#f-names').value);
      if (parsed.bad.length) { toast('Bad Venmo handle: ' + parsed.bad.join(', '), true); return; }
      if (!parsed.members.length) { toast('Enter at least one name', true); return; }
      var members = parsed.members.map(function (p) {
        return { id: uuid(), groupId: g.id, name: p.name, venmo: p.venmo };
      });
      mutate('Add people',
        function () {
          members.forEach(function (m) { state.members.push(m); });
        },
        function () { return backend.addMembers(g.id, members); });
    });
  }

  // Gate: an identified user who isn't a member must join before viewing.
  // Joining shows a loading screen while the server confirms — the group
  // content is never revealed optimistically. Declining keeps the identity
  // and goes back to the list.
  function joinPromptModal(g) {
    openModal('<h2>Join this group?</h2>' +
      '<p>You must be a member of <b>' + esc(g.name) + '</b> to view it.</p>' +
      '<p class="muted">Join as <b>' + esc(myName) + '</b>?</p>' +
      '<div class="modal-actions"><button class="btn" id="m-no">No</button>' +
      '<button class="btn primary" id="m-join">Join group</button></div>',
      { lock: true });
    $('#m-no').addEventListener('click', function () {
      view = { name: 'groups' };
      render();
    });
    $('#m-join').addEventListener('click', function () {
      var m = { id: uuid(), groupId: g.id, name: myName, venmo: myVenmo() };
      closeModal();
      $('#app').innerHTML = demoBanner() + groupHeaderHTML(g) + '</header>' +
        '<main class="wrap"><div class="loading"><span class="syncdot"></span>' +
        '<p>Joining ' + esc(g.name) + '…</p></div></main>';
      $('#back').addEventListener('click', function () { view = { name: 'groups' }; render(); });
      wireMeChip();
      pendingOps++;
      opChain = opChain.then(function () {
        return backend.addMember(m).then(function (out) {
          pendingOps--;
          setState(out.state);
          render();
        }).catch(function (err) {
          pendingOps--;
          toast('Join failed (' + (err && err.message || err) + ') — please try again.', true);
          render(); // back to the join gate
        });
      });
    });
  }

  // Group settings → member list: edit Venmo handles, add people, remove
  // members that have no expenses or payments (locked otherwise).
  function membersModal(g) {
    var ms = membersOf(g.id);
    function isActive(id) {
      return state.expenses.some(function (e) {
        return e.groupId === g.id && (String(e.paidBy) === String(id) ||
          e.splitAmong.map(String).indexOf(String(id)) !== -1);
      }) || state.settlements.some(function (s) {
        return s.groupId === g.id &&
          (String(s.fromId) === String(id) || String(s.toId) === String(id));
      });
    }
    var rows = ms.map(function (m) {
      var locked = isActive(m.id);
      return '<div class="mem-row">' + avatarHTML(m, ms) +
        '<span class="mem-name">' + esc(m.name) + '</span>' +
        '<input class="mem-venmo" data-venmo="' + esc(m.id) + '" value="' + esc(m.venmo || '') +
        '" placeholder="@venmo" maxlength="32">' +
        (locked
          ? '<span class="mem-lock" title="Has expenses or payments — cannot be removed">🔒</span>'
          : '<button class="del" data-del-member="' + esc(m.id) +
            '" title="Remove from group">×</button>') +
        '</div>';
    }).join('');
    openModal('<h2>Members</h2>' +
      (rows || '<p class="empty">No members yet.</p>') +
      '<div class="modal-actions"><button class="btn" id="m-add">+ Add people</button>' +
      '<button class="btn" id="m-cancel">Close</button>' +
      '<button class="btn primary" id="m-save">Save</button></div>');
    $('#m-cancel').addEventListener('click', closeModal);
    $('#m-add').addEventListener('click', function () { addMemberModal(g); });
    $all('[data-del-member]').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-del-member');
        var m = memberById(id);
        if (!m || !confirm('Remove ' + m.name + ' from this group?')) return;
        mutate('Remove member',
          function () {
            state.members = state.members.filter(function (x) { return x.id !== id; });
          },
          function () { return backend.deleteMember(g.id, id); });
      });
    });
    $('#m-save').addEventListener('click', function () {
      var changes = [], bad = false;
      $all('[data-venmo]').forEach(function (inp) {
        var m = memberById(inp.getAttribute('data-venmo'));
        if (!m) return;
        var v = inp.value.trim().replace(/^@+/, '');
        if (v !== '' && !/^[A-Za-z0-9._-]{1,30}$/.test(v)) { bad = true; return; }
        if (v !== (m.venmo || '')) changes.push({ m: m, venmo: v });
      });
      if (bad) { toast('Bad Venmo handle', true); return; }
      if (!changes.length) { closeModal(); return; }
      mutate('Save members',
        function () { changes.forEach(function (c) { c.m.venmo = c.venmo; }); },
        function () {
          var chain = Promise.resolve(null);
          changes.forEach(function (c) {
            chain = chain.then(function () {
              return backend.updateMember(g.id, c.m.id, { venmo: c.venmo });
            });
          });
          return chain.then(function (last) { return { state: last.state }; });
        });
    });
  }

  /* Downscale a receipt photo client-side so uploads stay small. */
  function processReceipt(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var max = 1600;
          var scale = Math.min(1, max / Math.max(img.width, img.height));
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            if (blob) resolve(blob);
            else reject(new Error('could not process image'));
          }, 'image/jpeg', 0.8);
        } catch (e) { reject(e); }
        if (img.src && img.src.indexOf('blob:') === 0) URL.revokeObjectURL(img.src);
      };
      img.onerror = function () { reject(new Error('could not read image')); };
      img.src = URL.createObjectURL(file);
    }).then(function (blob) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(String(r.result).split(',')[1]); };
        r.onerror = function () { reject(new Error('could not read image')); };
        r.readAsDataURL(blob);
      });
    });
  }

  // Shared add/edit expense form. `existing` is null for a new expense;
  // when set, the form is prefilled, saving updates in place, a Delete
  // button appears, and the receipt can be viewed/replaced.
  function expenseModal(g, ms, existing) {
    if (ms.length < 1) { toast('Add people to the group first', true); return; }
    var me = myId(g.id);
    var isEdit = !!existing;
    var splitMode = (existing && existing.shares) ? 'custom' : 'equal';
    var receiptFile = null;
    // In edit mode start dirty so saved custom amounts are never auto-overwritten.
    var customDirty = isEdit;

    var paidOpts = ms.map(function (m) {
      var sel = existing ? String(existing.paidBy) === String(m.id) : m.id === me;
      return '<option value="' + esc(m.id) + '"' + (sel ? ' selected' : '') + '>' +
        esc(m.name) + '</option>';
    }).join('');
    // Receipt block: in edit mode show the current receipt (if any) with a
    // preview link, plus a picker to replace it.
    var receiptBlock;
    if (!isEdit) {
      receiptBlock = '<label>Receipt (optional)<input id="f-receipt" type="file" accept="image/*"></label>';
    } else if (existing.receiptId) {
      var rurl = receiptURL(existing);
      receiptBlock = '<div class="receipt-now">🧾 ' +
        (rurl ? '<a href="' + rurl + '" target="_blank" rel="noopener">View current receipt</a>'
              : '<span class="muted">Receipt attached</span>') + '</div>' +
        '<label>Replace receipt<input id="f-receipt" type="file" accept="image/*"></label>';
    } else {
      receiptBlock = '<label>Add receipt<input id="f-receipt" type="file" accept="image/*"></label>';
    }
    function inEqual(id) {
      return existing
        ? existing.splitAmong.map(String).indexOf(String(id)) !== -1
        : true;
    }
    var equalChecks = ms.map(function (m) {
      return '<label class="check">' + avatarHTML(m, ms) +
        '<input type="checkbox" data-split="' + esc(m.id) + '"' +
        (inEqual(m.id) ? ' checked' : '') + '> ' + esc(m.name) + '</label>';
    }).join('');
    function inCustom(id) {
      return existing
        ? !!(existing.shares && existing.shares[String(id)] !== undefined)
        : true;
    }
    function customAmt(id) {
      if (existing && existing.shares && existing.shares[String(id)] !== undefined) {
        return ' value="' + (Number(existing.shares[String(id)]) / 100).toFixed(2) + '"';
      }
      return '';
    }
    var customRows = ms.map(function (m) {
      return '<div class="crow"><label class="check">' + avatarHTML(m, ms) +
        '<input type="checkbox" data-csplit="' + esc(m.id) + '"' +
        (inCustom(m.id) ? ' checked' : '') + '></label>' +
        '<span class="crow-name">' + esc(m.name) + '</span>' +
        '<input class="crow-amt" data-camt="' + esc(m.id) + '" inputmode="decimal" placeholder="0.00"' +
        customAmt(m.id) + '></div>';
    }).join('');

    openModal('<h2>' + (isEdit ? 'Edit expense' : 'Add expense') + '</h2>' +
      '<label>Description<input id="f-desc" placeholder="e.g. Dinner" maxlength="120"' +
      (existing ? ' value="' + esc(existing.description) + '"' : '') + '></label>' +
      '<div class="row2">' +
      '<label>Amount ($)<input id="f-amount" inputmode="decimal" placeholder="0.00"' +
      (existing ? ' value="' + (Number(existing.amountCents) / 100).toFixed(2) + '"' : '') + '></label>' +
      '<label>Date<input id="f-date" type="date" value="' +
      (existing ? esc(fmtDate(existing.date)) : todayISO()) + '"></label>' +
      '</div>' +
      '<label>Paid by<select id="f-paid">' + paidOpts + '</select></label>' +
      receiptBlock +
      '<div class="seg" id="split-mode">' +
        '<button data-mode="equal"' + (splitMode === 'equal' ? ' class="active"' : '') + '>Equal split</button>' +
        '<button data-mode="custom"' + (splitMode === 'custom' ? ' class="active"' : '') + '>Custom amounts</button>' +
      '</div>' +
      '<div id="split-equal"' + (splitMode === 'equal' ? '' : ' class="hidden"') +
      '><div class="checks">' + equalChecks + '</div></div>' +
      '<div id="split-custom"' + (splitMode === 'custom' ? '' : ' class="hidden"') +
      '>' + customRows + '</div>' +
      '<div id="split-preview" class="preview"></div>' +
      '<div class="modal-actions">' +
      (isEdit ? '<button class="btn danger" id="m-del">Delete</button>' : '') +
      '<button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn primary" id="m-ok">' + (isEdit ? 'Save' : 'Add') + '</button></div>');

    function checkedEqualIds() {
      return $all('#split-equal [data-split]').filter(function (c) { return c.checked; })
        .map(function (c) { return c.getAttribute('data-split'); });
    }
    function customState() {
      // { bad, shares: {id: cents}, checked: [ids] }.
      // Rows with blank/zero amounts count as 0 and are left out of shares;
      // only garbage input sets bad.
      var shares = {}, checked = [], bad = false;
      $all('#split-custom .crow').forEach(function (row) {
        var cb = row.querySelector('[data-csplit]');
        if (!cb.checked) return;
        var id = cb.getAttribute('data-csplit');
        checked.push(id);
        var p = parseShareInput(row.querySelector('[data-camt]').value);
        if (p.state === 'bad') { bad = true; return; }
        if (p.state === 'ok') shares[id] = p.cents;
      });
      return { bad: bad, shares: shares, checked: checked };
    }
    function previewRows(parts, ids) {
      return ids.map(function (id) {
        var m = memberById(id);
        return '<div class="pv-row">' + avatarHTML(m, ms) +
          '<span>' + esc(m ? m.name : '?') + '</span>' +
          '<span class="amt">' + formatMoney(parts[id] || 0) + '</span></div>';
      }).join('');
    }
    function renderPreview() {
      var box = $('#split-preview');
      var amtEl = $('#f-amount');
      if (!box || !amtEl) return; // modal closed: stale event, ignore
      var cents = dollarsToCents(amtEl.value);
      if (!cents) {
        box.innerHTML = '<span class="muted">Enter an amount to preview the split.</span>';
        return;
      }
      if (splitMode === 'equal') {
        var ids = checkedEqualIds();
        if (!ids.length) {
          box.innerHTML = '<span class="muted">Pick who to split with.</span>';
          return;
        }
        var parts = owedSplit({ amountCents: cents, splitAmong: ids, shares: null });
        box.innerHTML = '<div class="pv-title">Split preview</div>' + previewRows(parts, ids);
      } else {
        var cs = customState();
        if (cs.bad) {
          box.innerHTML = '<span class="muted">One of the amounts isn\'t a valid number.</span>';
          return;
        }
        if (!cs.checked.length) {
          box.innerHTML = '<span class="muted">Pick who to split with.</span>';
          return;
        }
        // Always show the running split: blank amounts count as $0.00.
        var sids = Object.keys(cs.shares);
        var sum = sids.reduce(function (n, id) { return n + cs.shares[id]; }, 0);
        var diff = cents - sum;
        var rowsHtml = cs.checked.map(function (id) {
          var m = memberById(id);
          return '<div class="pv-row">' + avatarHTML(m, ms) +
            '<span>' + esc(m ? m.name : '?') + '</span>' +
            '<span class="amt">' + formatMoney(cs.shares[id] || 0) + '</span></div>';
        }).join('');
        var note;
        if (diff === 0 && sids.length) {
          note = '<div class="pv-total ok">✓ Adds up to ' + formatMoney(cents) + '</div>';
        } else if (diff > 0) {
          note = '<div class="pv-total bad">' + formatMoney(diff) + ' left to allocate</div>';
        } else {
          note = '<div class="pv-total bad">Over by ' + formatMoney(-diff) + '</div>';
        }
        box.innerHTML = '<div class="pv-title">Split preview</div>' + rowsHtml + note;
      }
    }

    // prefill custom amounts with an equal split whenever inputs change
    function prefillCustom() {
      var cents = dollarsToCents($('#f-amount').value);
      var ids = checkedEqualIds();
      if (!cents || !ids.length) return;
      var parts = owedSplit({ amountCents: cents, splitAmong: ids, shares: null });
      $all('#split-custom [data-camt]').forEach(function (inp) {
        var id = inp.getAttribute('data-camt');
        inp.value = parts[id] !== undefined ? (parts[id] / 100).toFixed(2) : '';
      });
    }

    $('#split-mode').addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-mode]');
      if (!btn) return;
      splitMode = btn.getAttribute('data-mode');
      $all('#split-mode button').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      $('#split-equal').classList.toggle('hidden', splitMode !== 'equal');
      $('#split-custom').classList.toggle('hidden', splitMode !== 'custom');
      if (splitMode === 'custom') { prefillCustom(); customDirty = false; }
      renderPreview();
    });
    $('#f-amount').addEventListener('input', function () {
      if (splitMode === 'custom' && !customDirty) prefillCustom();
      renderPreview();
    });
    // Live preview listeners go on the fresh .modal element (removed on
    // close), never on the persistent #overlay, so they can't accumulate
    // across opens and fire after the modal is gone.
    var modalEl = $('#overlay .modal');
    modalEl.addEventListener('change', renderPreview);
    modalEl.addEventListener('input', function (ev) {
      if (ev.target.hasAttribute('data-camt')) customDirty = true;
      if (ev.target.id === 'f-amount' || ev.target.hasAttribute('data-camt')) renderPreview();
    });
    var fr = $('#f-receipt');
    if (fr) fr.addEventListener('change', function (ev) {
      receiptFile = (ev.target.files && ev.target.files[0]) || null;
    });
    renderPreview();

    $('#m-cancel').addEventListener('click', closeModal);
    if (isEdit) {
      $('#m-del').addEventListener('click', function () {
        if (!confirm('Delete this expense?')) return;
        mutate('Delete expense',
          function () {
            state.expenses = state.expenses.filter(function (e) { return e.id !== existing.id; });
          },
          function () { return backend.deleteExpense(existing.id); });
      });
    }
    $('#m-ok').addEventListener('click', function () {
      var cents = dollarsToCents($('#f-amount').value);
      if (cents === null) { toast('Enter a valid amount', true); return; }
      var split, shares = null;
      if (splitMode === 'equal') {
        split = checkedEqualIds();
        if (!split.length) { toast('Pick at least one person to split with', true); return; }
      } else {
        var cs2 = customState();
        if (cs2.bad) { toast('One of the amounts isn\'t a valid number', true); return; }
        var sids2 = Object.keys(cs2.shares);
        if (!sids2.length) { toast('Enter an amount for at least one person', true); return; }
        var sum2 = sids2.reduce(function (n, id) { return n + cs2.shares[id]; }, 0);
        if (sum2 !== cents) {
          var left2 = cents - sum2;
          toast(left2 > 0 ? formatMoney(left2) + ' still needs to be allocated'
                          : 'Over by ' + formatMoney(-left2), true);
          return;
        }
        shares = cs2.shares;
        split = sids2; // members without an amount are left out of the split
      }
      view.tab = 'expenses';
      var file = receiptFile;
      if (isEdit) {
        var updated = {
          id: existing.id, groupId: g.id,
          description: $('#f-desc').value.trim() || 'Expense',
          amountCents: cents,
          paidBy: $('#f-paid').value,
          splitAmong: split,
          shares: shares,
          receiptId: existing.receiptId,
          date: $('#f-date').value || todayISO(),
        };
        mutate('Save expense',
          function () {
            for (var i = 0; i < state.expenses.length; i++) {
              if (state.expenses[i].id === existing.id) { state.expenses[i] = updated; break; }
            }
          },
          function () {
            return backend.updateExpense(updated).then(function (out) {
              if (!file) return out;
              return processReceipt(file).then(function (b64) {
                return backend.uploadReceipt({
                  expenseId: existing.id, name: file.name || 'receipt.jpg',
                  mimeType: 'image/jpeg', data: b64,
                });
              });
            });
          });
        return;
      }
      var ex = {
        id: uuid(), groupId: g.id,
        description: $('#f-desc').value.trim() || 'Expense',
        amountCents: cents,
        paidBy: $('#f-paid').value,
        splitAmong: split,
        shares: shares,
        receiptId: '',
        date: $('#f-date').value || todayISO(),
      };
      mutate('Add expense',
        function () { state.expenses.push(ex); },
        function () {
          return backend.addExpense(ex).then(function (out) {
            if (!file) return out;
            return processReceipt(file).then(function (b64) {
              return backend.uploadReceipt({
                expenseId: ex.id, name: file.name || 'receipt.jpg',
                mimeType: 'image/jpeg', data: b64,
              });
            });
          });
        });
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

    var sugList = simplified.map(function (p, i) {
      return '<button class="sug-row" data-sug="' + i + '">' +
        '<span class="sug-left">' + avatarHTML(memberById(p.from), ms) +
        '<b>' + esc(displayName(g.id, p.from)) + '</b><span class="pays-word">→</span>' +
        avatarHTML(memberById(p.to), ms) + '<b>' + esc(displayName(g.id, p.to)) + '</b></span>' +
        '<span class="amt">' + formatMoney(p.amountCents) + '</span></button>';
    }).join('');

    openModal('<h2>Record a payment</h2>' +
      (sugList
        ? '<div class="sug-title">Tap a suggestion to fill it in:</div><div class="sug-list">' + sugList + '</div>'
        : '<p class="empty">Everyone is settled up 🎉</p>') +
      '<div class="row2"><label>From<select id="f-from">' + personOpts(me) + '</select></label>' +
      '<label>To<select id="f-to">' + personOpts() + '</select></label></div>' +
      '<div class="row2"><label>Amount ($)<input id="f-amount" inputmode="decimal" placeholder="0.00"></label>' +
      '<label>Date<input id="f-date" type="date" value="' + todayISO() + '"></label></div>' +
      '<div id="venmo-wrap"></div>' +
      '<div class="modal-actions"><button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn primary" id="m-ok">Record</button></div>');

    // Prefilled Venmo payment link, shown only when the recipient ("To")
    // has a Venmo handle configured. Built at click time from the form.
    function refreshVenmo() {
      var wrap = $('#venmo-wrap');
      if (!wrap) return;
      var to = memberById($('#f-to').value);
      if (!to || !to.venmo) { wrap.innerHTML = ''; return; }
      var cents = dollarsToCents($('#f-amount').value);
      var q = '?txn=pay&recipients=' + encodeURIComponent(to.venmo);
      if (cents !== null) q += '&amount=' + (cents / 100).toFixed(2);
      q += '&note=' + encodeURIComponent('Split It: ' + g.name);
      wrap.innerHTML = '<a class="btn venmo block" href="https://venmo.com/' + q +
        '" target="_blank" rel="noopener">Pay @' + esc(to.venmo) + ' with Venmo ↗</a>';
    }
    $('#f-to').addEventListener('change', refreshVenmo);
    $('#f-amount').addEventListener('input', refreshVenmo);
    refreshVenmo();

    $('#m-cancel').addEventListener('click', closeModal);
    $all('[data-sug]').forEach(function (el) {
      el.addEventListener('click', function () {
        var p = simplified[Number(el.getAttribute('data-sug'))];
        $('#f-from').value = p.from;
        $('#f-to').value = p.to;
        $('#f-amount').value = (p.amountCents / 100).toFixed(2);
        refreshVenmo();
      });
    });
    $('#m-ok').addEventListener('click', function () {
      var cents = dollarsToCents($('#f-amount').value);
      if (cents === null) { toast('Enter a valid amount', true); return; }
      var from = $('#f-from').value, to = $('#f-to').value;
      if (from === to) { toast('Pick two different people', true); return; }
      var st = {
        id: uuid(), groupId: g.id, fromId: from, toId: to,
        amountCents: cents, date: $('#f-date').value || todayISO(),
      };
      view.tab = 'balances';
      mutate('Record payment',
        function () { state.settlements.push(st); },
        function () { return backend.addSettlement(st); });
    });
  }

  /* ---------- boot ---------- */

  function refresh() {
    return backend.getState().then(function (s) {
      setState(s);
      migrateLegacyMe();
      render();
      // First visit: ask who they are so personal amounts work right away.
      if (!myName) identityModal(true);
    }).catch(function (err) {
      $('#app').innerHTML = '<main class="wrap"><p class="empty">Couldn\'t load data: ' +
        esc(err.message) + '</p><button class="btn primary block" id="retry">Retry</button></main>';
      $('#retry').addEventListener('click', refresh);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('#overlay').addEventListener('click', function (ev) {
      if (ev.target.id === 'overlay' && !ev.currentTarget._locked) closeModal();
    });
    // Dismiss the group settings menu on any outside tap (wired once —
    // renderGroup rebuilds the menu every render, so it can't own this).
    document.addEventListener('click', function (ev) {
      var menu = document.getElementById('settings-menu');
      if (menu && !menu.classList.contains('hidden') &&
          !ev.target.closest('.menu-wrap')) {
        menu.classList.add('hidden');
      }
    });
    loadMe();
    refresh();
  });
})();
