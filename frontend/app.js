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
          state = out.state;
          renderPage();
        })
        .catch(function (err) {
          pendingOps--;
          toast(label + ' failed (' + (err && err.message || err) + ') — reloading.', true);
          return backend.getState().then(function (s) {
            state = s;
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

  var AVATAR_COLORS = ['#e11d48', '#d97706', '#059669', '#0284c7', '#7c3aed',
                       '#db2777', '#65a30d', '#0d9488', '#4f46e5', '#be123c'];

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
    var color = AVATAR_COLORS[hashStr(String(member.id)) % AVATAR_COLORS.length];
    return '<span class="avatar" style="background:' + color + '" title="' +
      esc(member.name) + '">' + esc(avatarLabel(member, members)) + '</span>';
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
      return '<button class="group-card" data-group="' + esc(g.id) + '">' +
        '<span class="group-faces">' + faces + '</span>' +
        '<span class="group-name">' + esc(g.name) + '</span>' +
        '<span class="group-meta">' + ms.length + ' people · ' + nExp + ' expenses</span>' +
        '</button>';
    }).join('');

    $('#app').innerHTML =
      demoBanner() +
      '<header class="top"><h1>Split it</h1>' + syncDot() + '</header>' +
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
        '<h1>' + esc(g.name) + '</h1>' + syncDot() +
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
      return '<div class="bal-row">' + avatarHTML(m, ms) + '<span>' + label + '</span>' +
        '<span class="' + cls + '">' + text + '</span></div>';
    }).join('');

    var pays = simplified.map(function (p) {
      var from = memberById(p.from), to = memberById(p.to);
      return '<div class="pay-row"><span>' + avatarHTML(from, ms) +
        '<b>' + esc(displayName(g.id, p.from)) + '</b> pays <b>' +
        esc(displayName(g.id, p.to)) + '</b>' + avatarHTML(to, ms) + '</span>' +
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
      var splitNote = e.shares ? ' · custom split' : '';
      var payer = memberById(e.paidBy);
      var rurl = receiptURL(e);
      var receipt = rurl
        ? ' <a class="receipt" href="' + rurl + '" target="_blank" rel="noopener" title="View receipt">🧾</a>'
        : (e.receiptId ? ' <span class="receipt" title="Receipt attached">🧾</span>' : '');
      return '<div class="exp-row">' + avatarHTML(payer, ms) +
        '<div class="exp-main"><span class="exp-desc">' + esc(e.description) + receipt + '</span>' +
        '<span class="exp-sub">' + esc(fmtDate(e.date)) + ' · ' + esc(displayName(g.id, e.paidBy)) +
        ' paid · split: ' + who + splitNote + '</span></div>' +
        '<div class="exp-right"><span class="amt">' + formatMoney(e.amountCents) + '</span>' +
        '<button class="del" data-del-exp="' + esc(e.id) + '" title="Delete">×</button></div>' +
        '</div>';
    }).join('');

    var stItems = st.map(function (s) {
      return '<div class="exp-row settle">' +
        '<div class="exp-main"><span class="exp-desc">💸 ' + esc(displayName(g.id, s.fromId)) +
        ' → ' + esc(displayName(g.id, s.toId)) + '</span>' +
        '<span class="exp-sub">' + esc(fmtDate(s.date)) + ' · payment recorded</span></div>' +
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
        var id = el.getAttribute('data-del-exp');
        if (!confirm('Delete this expense?')) return;
        mutate('Delete expense',
          function () { state.expenses = state.expenses.filter(function (e) { return e.id !== id; }); },
          function () { return backend.deleteExpense(id); });
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
      mutate('Create group',
        function () { state.groups.push(g); },
        function () { return backend.createGroup(g); });
      addMemberModal({ id: g.id, name: g.name });
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
      var m = { id: uuid(), groupId: g.id, name: name };
      mutate('Add person',
        function () { state.members.push(m); },
        function () { return backend.addMember(m); });
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

  function addExpenseModal(g, ms) {
    if (ms.length < 1) { toast('Add people to the group first', true); return; }
    var me = myId(g.id);
    var splitMode = 'equal';
    var receiptFile = null;

    var paidOpts = ms.map(function (m) {
      return '<option value="' + esc(m.id) + '"' + (m.id === me ? ' selected' : '') + '>' +
        esc(m.name) + '</option>';
    }).join('');
    var equalChecks = ms.map(function (m) {
      return '<label class="check">' + avatarHTML(m, ms) +
        '<input type="checkbox" data-split="' + esc(m.id) + '" checked> ' +
        esc(m.name) + '</label>';
    }).join('');
    var customRows = ms.map(function (m) {
      return '<div class="crow"><label class="check">' + avatarHTML(m, ms) +
        '<input type="checkbox" data-csplit="' + esc(m.id) + '" checked></label>' +
        '<span class="crow-name">' + esc(m.name) + '</span>' +
        '<input class="crow-amt" data-camt="' + esc(m.id) + '" inputmode="decimal" placeholder="0.00"></div>';
    }).join('');

    openModal('<h2>Add expense</h2>' +
      '<label>Description<input id="f-desc" placeholder="e.g. Dinner" maxlength="120"></label>' +
      '<div class="row2">' +
      '<label>Amount ($)<input id="f-amount" inputmode="decimal" placeholder="0.00"></label>' +
      '<label>Date<input id="f-date" type="date" value="' + todayISO() + '"></label>' +
      '</div>' +
      '<label>Paid by<select id="f-paid">' + paidOpts + '</select></label>' +
      '<label>Receipt (optional)<input id="f-receipt" type="file" accept="image/*"></label>' +
      '<div class="seg" id="split-mode">' +
        '<button data-mode="equal" class="active">Equal split</button>' +
        '<button data-mode="custom">Custom amounts</button>' +
      '</div>' +
      '<div id="split-equal"><div class="checks">' + equalChecks + '</div></div>' +
      '<div id="split-custom" class="hidden">' + customRows + '</div>' +
      '<div id="split-preview" class="preview"></div>' +
      '<div class="modal-actions"><button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn primary" id="m-ok">Add</button></div>');

    function checkedEqualIds() {
      return $all('#split-equal [data-split]').filter(function (c) { return c.checked; })
        .map(function (c) { return c.getAttribute('data-split'); });
    }
    function customShares() {
      // {id: cents} for checked rows, or null when any amount is invalid
      var out = {}, ok = true;
      $all('#split-custom .crow').forEach(function (row) {
        var cb = row.querySelector('[data-csplit]');
        if (!cb.checked) return;
        var cents = dollarsToCents(row.querySelector('[data-camt]').value);
        if (cents === null) { ok = false; return; }
        out[cb.getAttribute('data-csplit')] = cents;
      });
      return ok ? out : null;
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
      var cents = dollarsToCents($('#f-amount').value);
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
        var shares = customShares();
        if (shares === null) {
          box.innerHTML = '<span class="muted">Enter each person\'s share.</span>';
          return;
        }
        var sids = Object.keys(shares);
        if (!sids.length) {
          box.innerHTML = '<span class="muted">Pick who to split with.</span>';
          return;
        }
        var sum = sids.reduce(function (n, id) { return n + shares[id]; }, 0);
        var diff = cents - sum;
        var note = diff === 0
          ? '<div class="pv-total ok">✓ Adds up to ' + formatMoney(cents) + '</div>'
          : '<div class="pv-total bad">' + (diff > 0
              ? formatMoney(diff) + ' left to allocate'
              : 'Over by ' + formatMoney(-diff)) + '</div>';
        box.innerHTML = '<div class="pv-title">Split preview</div>' +
          previewRows(shares, sids) + note;
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
      if (splitMode === 'custom') prefillCustom();
      renderPreview();
    });
    $('#f-amount').addEventListener('input', function () {
      if (splitMode === 'custom') prefillCustom();
      renderPreview();
    });
    $('#overlay').addEventListener('change', renderPreview);
    $('#overlay').addEventListener('input', function (ev) {
      if (ev.target.id === 'f-amount' || ev.target.hasAttribute('data-camt')) renderPreview();
    });
    $('#f-receipt').addEventListener('change', function (ev) {
      receiptFile = (ev.target.files && ev.target.files[0]) || null;
    });
    renderPreview();

    $('#m-cancel').addEventListener('click', closeModal);
    $('#m-ok').addEventListener('click', function () {
      var cents = dollarsToCents($('#f-amount').value);
      if (cents === null) { toast('Enter a valid amount', true); return; }
      var split, shares = null;
      if (splitMode === 'equal') {
        split = checkedEqualIds();
        if (!split.length) { toast('Pick at least one person to split with', true); return; }
      } else {
        shares = customShares();
        if (!shares || !Object.keys(shares).length) {
          toast('Enter a valid amount for each person', true);
          return;
        }
        var sum = Object.keys(shares).reduce(function (n, id) { return n + shares[id]; }, 0);
        if (sum !== cents) { toast('Shares must add up to ' + formatMoney(cents), true); return; }
        split = Object.keys(shares);
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
      var file = receiptFile;
      view.tab = 'expenses';
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
        '<span>' + avatarHTML(memberById(p.from), ms) +
        '<b>' + esc(displayName(g.id, p.from)) + '</b> → <b>' +
        esc(displayName(g.id, p.to)) + '</b>' +
        avatarHTML(memberById(p.to), ms) + '</span>' +
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
      '<div class="modal-actions"><button class="btn" id="m-cancel">Cancel</button>' +
      '<button class="btn primary" id="m-ok">Record</button></div>');

    $('#m-cancel').addEventListener('click', closeModal);
    $all('[data-sug]').forEach(function (el) {
      el.addEventListener('click', function () {
        var p = simplified[Number(el.getAttribute('data-sug'))];
        $('#f-from').value = p.from;
        $('#f-to').value = p.to;
        $('#f-amount').value = (p.amountCents / 100).toFixed(2);
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
