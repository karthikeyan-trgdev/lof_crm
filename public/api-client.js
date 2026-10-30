/* Lab of Future CRM – connects the CRM screens to the API.
 *
 * The screens keep their workflow logic (it is the approved prototype). This adapter:
 *   • signs the user in and loads branch-scoped data from GET /api/v1/bootstrap
 *   • after every user action, sends the changed records to PUT /api/v1/sync (server validates,
 *     stamps, assigns receipt numbers and runs the real integrations), then merges the server's version
 *   • takes record numbers from server sequences so IDs never collide between users
 *   • replaces simulated actions with real ones: LMS enrol/cancel calls and retry, Exotel click-to-call, incoming-call pop-up,
 *     payment links (Telr/Razorpay), printable receipts, connection tests
 *   • adds Settings → Testing console
 */
(function () {
  'use strict';
  if (!window.LOF_API) return;
  var API = window.LOF_API.base;
  var LS = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
  };
  // Sessions live in an HttpOnly cookie the page cannot read; remove tokens left by older versions
  LS.set('lof_token', null);
  var SERVER = { integrations: {}, impersonation: false };
  var COLL = { branches: 1, programs: 1, fees: 1, discounts: 1, staff: 1, leads: 1, opps: 1, students: 1, enr: 1, pay: 1, ms: 1, refunds: 1, approvals: 1, tasks: 1, calls: 1, comms: 1, notifs: 1, audit: 1 };
  var SETTINGS = ['cfg', 'perms', 'scope', 'fx', 'hist'];
  var EXACT = ['lead', 'opp', 'enr', 'pay', 'student', 'ap', 'rf', 'pd'];
  var BLOCK = ['ms', 'task', 'call', 'cm', 'notif', 'audit'];
  var p2 = function (n, w) { return String(n).padStart(w, '0'); };
  var FMT = {
    lead: function (n) { return 'LD-26-' + n; }, opp: function (n) { return 'OP-26-' + p2(n, 4); }, enr: function (n) { return 'EN-26-' + p2(n, 4); },
    pay: function (n) { return 'PY-26-' + p2(n, 4); }, student: function (n) { return 'LOF-26-' + p2(n, 6); }, ap: function (n) { return 'AP-26-' + p2(n, 4); },
    rf: function (n) { return 'RF-26-' + p2(n, 4); }, pd: function (n) { return 'PD-' + p2(n, 2); },
  };
  var INTEG_LABEL = { website: 'Website', meta: 'Meta', whatsapp: 'WhatsApp', exotel: 'Exotel', lms: 'LMS', telr: 'Telr', razorpay: 'Razorpay', erpnext: 'ERPNext', gcal: 'Google Calendar', email: 'E-mail' };

  // ------------------------------------------------------------------ HTTP
  function req(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: { 'content-type': 'application/json', 'x-lof-csrf': '1' },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) {}
        if (r.status === 401 && path.indexOf('/auth/') < 0) { signOut('Your session has ended – please sign in again.'); throw new Error('Signed out'); }
        if (r.status === 403 && j && j.details && (j.details.code === 'password_change' || j.details.code === 'mfa_setup')) { stageScreen(j.details.code); throw new Error('Signed out'); }
        if (!r.ok) { var err = new Error((j && j.error) || ('HTTP ' + r.status)); err.status = r.status; err.body = j; throw err; }
        return j;
      });
    });
  }
  /** Synchronous call – only for claiming record numbers inside the screens' synchronous handlers. */
  function xhr(method, path, body) {
    var x = new XMLHttpRequest();
    x.open(method, API + path, false);
    x.setRequestHeader('content-type', 'application/json');
    x.setRequestHeader('x-lof-csrf', '1');
    x.send(body ? JSON.stringify(body) : null);
    if (x.status >= 400) throw new Error('Numbering service unavailable (' + x.status + ')');
    return JSON.parse(x.responseText);
  }

  // ------------------------------------------------------------------ sequences
  var remaps = [];
  function makeSeq(peek) {
    var st = { peek: Object.assign({}, peek), blocks: {} };
    var rc = {};
    Object.keys(peek).forEach(function (k) { if (k.indexOf('rc_') === 0) rc[k.slice(3)] = peek[k] - 1; });
    var target = { rc: rc };
    return new Proxy(target, {
      get: function (t, k) {
        if (k === 'rc') return t.rc;
        if (EXACT.indexOf(k) >= 0) return st.peek[k] || 1;
        if (BLOCK.indexOf(k) >= 0) {
          var b = st.blocks[k];
          if (!b || b.next >= b.end) { var r = xhr('POST', '/seq/block', { name: k, size: 20 }); b = st.blocks[k] = { next: r.start, end: r.start + r.size }; }
          return b.next;
        }
        return t[k];
      },
      set: function (t, k, v) {
        if (EXACT.indexOf(k) >= 0) {
          var expect = st.peek[k] || 1;
          var r = xhr('POST', '/seq/claim', { name: k, expect: expect });
          if (!r.ok && FMT[k]) remaps.push({ from: FMT[k](expect), to: FMT[k](r.value) });
          st.peek[k] = r.value + 1;
          return true;
        }
        if (BLOCK.indexOf(k) >= 0) { if (st.blocks[k]) st.blocks[k].next++; return true; }
        t[k] = v;
        return true;
      },
    });
  }
  /** Another user took the number we showed: rename the new record everywhere before it is saved. */
  function applyRemaps() {
    if (!remaps.length) return;
    var list = remaps.splice(0);
    list.forEach(function (m) {
      var re = new RegExp(m.from.replace(/[-]/g, '\\-') + '(?![0-9])', 'g');
      Object.keys(COLL).forEach(function (c) {
        (S[c] || []).forEach(function (d, i) {
          var j = JSON.stringify(d);
          if (j.indexOf(m.from) >= 0) S[c][i] = JSON.parse(j.replace(re, m.to));
        });
      });
      if (S.route && S.route.id === m.from) S.route.id = m.to;
      toast('Number ' + m.from + ' was just taken by a colleague – saved as ' + m.to, 'warn');
    });
  }

  // ------------------------------------------------------------------ snapshot & sync
  var snap = {}, snapSet = {}, busy = false, again = false, deferredRender = false;
  function takeSnap() {
    snap = {};
    Object.keys(COLL).forEach(function (c) {
      var m = new Map();
      (S[c] || []).forEach(function (d) { m.set(d.id, JSON.stringify(d)); });
      snap[c] = m;
    });
    snapSet = {};
    SETTINGS.forEach(function (k) { snapSet[k] = JSON.stringify(S[k]); });
  }
  /** Remove prototype "(simulated …)" wording from text the screens write; integrations are real now. */
  var SIM_RE = /\s?\((?:simulated|Simulated)[^)"]*\)/g;
  function clean(j) { return SIM_RE.test(j) ? (SIM_RE.lastIndex = 0, j.replace(SIM_RE, '')) : j; }
  function diff(dry) {
    var changes = [], settings = [];
    Object.keys(COLL).forEach(function (c) {
      var seen = new Set();
      (S[c] || []).forEach(function (d) {
        if (!d || !d.id) return;
        seen.add(d.id);
        var j = JSON.stringify(d);
        var before = snap[c].get(d.id);
        if (before !== j) {
          j = clean(j);
          if (before === j) return;
          var ch = { coll: c, id: d.id, op: 'upsert', doc: JSON.parse(j) };
          if (before) ch.base = JSON.parse(clean(before)); // the version this user edited – the server applies only their changes
          changes.push(ch);
          if (!dry) snap[c].set(d.id, j);
        }
      });
      snap[c].forEach(function (_, id) { if (!seen.has(id)) { changes.push({ coll: c, id: id, op: 'delete' }); if (!dry) snap[c].delete(id); } });
    });
    SETTINGS.forEach(function (k) {
      var j = JSON.stringify(S[k]);
      if (snapSet[k] !== j) { settings.push({ key: k, doc: JSON.parse(j) }); if (!dry) snapSet[k] = j; }
    });
    return { changes: changes, settings: settings };
  }
  function mergeDocs(docs) {
    (docs || []).forEach(function (x) {
      var arr = S[x.coll];
      if (!arr) return;
      var i = arr.findIndex(function (d) { return d.id === x.doc.id; });
      if (i >= 0) arr[i] = x.doc; else arr.unshift(x.doc);
      snap[x.coll].set(x.doc.id, JSON.stringify(x.doc));
    });
  }
  function userIsTyping() {
    var a = document.activeElement;
    return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.id !== 'gs' && a.id !== 'lq' && a.id !== 'sq' && a.id !== 'auq');
  }
  function safeRender() {
    if (S.modal || userIsTyping() || (S.route.page === 'wizard')) { deferredRender = true; return; }
    deferredRender = false;
    render();
  }
  function flush() {
    if (!S || !snap.leads) return Promise.resolve();
    if (busy) { again = true; return Promise.resolve(); }
    applyRemaps();
    var d = diff();
    if (!d.changes.length && !d.settings.length) return Promise.resolve();
    busy = true;
    setSaving(true);
    return req('PUT', '/sync', d)
      .then(function (r) {
        mergeDocs(r.docs);
        if (r.settings && r.settings.length) SETTINGS.forEach(function (k) { snapSet[k] = JSON.stringify(S[k]); });
        (r.notices || []).forEach(function (n) { toast(n, 'ok'); });
        safeRender();
      })
      .catch(function (e) {
        if (e.message === 'Signed out') return;
        toast('Not saved: ' + e.message, 'err');
        return reload(true);
      })
      .then(function () {
        busy = false;
        setSaving(false);
        if (again) { again = false; return flush(); }
      });
  }
  var flushTimer = null;
  function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms || 0); }
  ['click', 'submit', 'change', 'drop'].forEach(function (ev) { document.addEventListener(ev, function () { scheduleFlush(30); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === 'Escape') scheduleFlush(30); });
  window.addEventListener('beforeunload', function (e) { if (S && snap.leads && (diff(true).changes.length || busy)) { flush(); e.preventDefault(); } });

  function setSaving(on) {
    var el = document.getElementById('lofSaving');
    if (!el) { el = document.createElement('div'); el.id = 'lofSaving'; el.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:300;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:2px 10px;font-size:11.5px;color:var(--muted);box-shadow:var(--shadow);display:none'; el.textContent = 'Saving…'; document.body.appendChild(el); }
    el.style.display = on ? 'block' : 'none';
  }

  // ------------------------------------------------------------------ load
  function applyBootstrap(b, keepUi) {
    SERVER = b.server;
    if (!keepUi) {
      S = seed(); // UI state shape from the prototype; data is replaced below
      S.saved = JSON.parse(LS.get('lof_saved_filters') || 'null') || S.saved;
      S.theme = LS.get('lof_theme') || null;
    }
    Object.keys(COLL).forEach(function (c) { S[c] = b.data[c] || []; });
    SETTINGS.forEach(function (k) { S[k] = b.data[k] || {}; });
    S.user = b.me.id;
    S.lmsServerReady = !!b.server.lmsSecrets;
    S.seq = makeSeq(b.seq);
    if (!keepUi) { S.calSel = TODAY; S.calMonth = TODAY.slice(0, 7); }
    takeSnap();
  }
  function reload(force) {
    if (!force && (busy || S.modal || userIsTyping())) return Promise.resolve();
    return req('GET', '/bootstrap').then(function (b) {
      NOW = new Date();
      applyBootstrap(b, true);
      safeRender();
    });
  }
  function start() {
    var app = document.getElementById('app');
    app.innerHTML = '<div style="display:grid;place-items:center;height:100%;color:var(--muted)">Loading Lab of Future CRM…</div>';
    return req('GET', '/bootstrap').then(function (b) {
      applyBootstrap(b, false);
      render();
      startTimers();
    }).catch(function (e) { if (e.message !== 'Signed out') app.innerHTML = '<div class="empty"><b>Could not load the CRM</b>' + esc(e.message) + '</div>'; });
  }
  var timers = [];
  function startTimers() {
    timers.forEach(clearInterval);
    timers = [
      setInterval(function () { NOW = new Date(); TODAY = dayKey(NOW.toISOString()); BASE = Date.parse(TODAY + 'T00:00:00+04:00'); }, 30000),
      setInterval(function () { if (document.visibilityState === 'visible') flush().then(function () { return reload(false); }); }, 45000),
      setInterval(pollIncoming, 8000),
    ];
  }
  var callSince = new Date().toISOString();
  function pollIncoming() {
    if (!S || document.visibilityState !== 'visible' || S.callPop) return;
    req('GET', '/calls/incoming?since=' + encodeURIComponent(callSince)).then(function (r) {
      callSince = r.now;
      var ev = (r.events || []).find(function (e) { return e.lead_id && leadById(e.lead_id); });
      if (ev) { S.callPop = ev.lead_id; S.callPopReal = true; render(); }
    }).catch(function () {});
  }

  // ------------------------------------------------------------------ sign-in
  function signOut(msg) {
    timers.forEach(clearInterval); timers = [];
    // drop everything the previous user could see before showing the sign-in screen
    S = null; S_sel = {}; Object.keys(snap).forEach(function (k) { snap[k] = new Map(); }); snapSet = {};
    loginScreen(msg);
  }
  var pendingPw = null; // kept in memory only between "sign in" and the forced password change
  function authCard(sub, msg, inner, btn) {
    document.getElementById('app').innerHTML =
      '<div style="min-height:100%;display:grid;place-items:center;padding:16px;background:var(--bg)"><form id="lofAuth" class="card" style="width:min(100%,400px)" novalidate>' +
      '<div class="hd" style="gap:10px;justify-content:flex-start"><div style="width:30px;height:30px;border-radius:6px;background:#2d5b9a;color:#fff;display:grid;place-items:center;font-weight:600;font-size:12px">LOF</div><div><h3>Lab of Future CRM</h3><div class="muted xs">' + esc(sub) + '</div></div></div>' +
      '<div class="bd" style="display:flex;flex-direction:column;gap:12px">' + (msg ? '<div class="banner" style="margin:0">' + esc(msg) + '</div>' : '') + inner +
      '<div class="fe" id="lofErr" role="alert"></div><button class="btn primary" type="submit" style="justify-content:center">' + esc(btn) + '</button></div></form></div>';
    var f = document.getElementById('lofAuth');
    var first = f.querySelector('input:not([type=hidden])');
    if (first) first.focus();
    return f;
  }
  function onSubmit(f, fn) {
    f.addEventListener('submit', function (e) {
      e.preventDefault(); e.stopPropagation();
      var btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      Promise.resolve(fn(Object.fromEntries(new FormData(f).entries()), document.getElementById('lofErr')))
        .catch(function (x) { document.getElementById('lofErr').textContent = x.message; })
        .then(function () { if (document.body.contains(btn)) btn.disabled = false; });
    }, true);
  }
  function afterAuth(stage) {
    if (stage === 'password_change' || stage === 'mfa_setup') stageScreen(stage); else start();
  }
  function loginScreen(msg, needCode, remembered) {
    var f = authCard(needCode ? 'Enter the 6-digit code from your authenticator app' : 'Sign in with your work e-mail', msg,
      needCode
        ? '<input type="hidden" name="email" value="' + esc(remembered.email) + '"><input type="hidden" name="password" value="' + esc(remembered.password) + '"><div class="f"><label for="lc">Verification code</label><input id="lc" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></div>'
        : '<div class="f"><label for="le">E-mail</label><input id="le" name="email" type="email" autocomplete="username" required></div><div class="f"><label for="lp">Password</label><input id="lp" name="password" type="password" autocomplete="current-password" required></div>',
      needCode ? 'Verify' : 'Sign in');
    onSubmit(f, function (d) {
      return req('POST', '/auth/login', { email: d.email, password: d.password, code: d.code }).then(function (r) {
        if (r.mfaRequired) return loginScreen('', true, { email: d.email, password: d.password });
        pendingPw = r.stage === 'password_change' ? d.password : null;
        afterAuth(r.stage);
      });
    });
  }
  function stageScreen(stage, msg) {
    timers.forEach(clearInterval);
    if (stage === 'password_change') {
      var f = authCard('Choose a new password', msg || 'Your password must be changed before you continue.',
        (pendingPw ? '' : '<div class="f"><label for="lp0">Current password</label><input id="lp0" name="current" type="password" autocomplete="current-password" required></div>') +
        '<div class="f"><label for="lp1">New password</label><input id="lp1" name="next" type="password" autocomplete="new-password" required></div><div class="f"><label for="lp2">Repeat new password</label><input id="lp2" name="next2" type="password" autocomplete="new-password" required><div class="help">At least 10 characters using three of: lower-case, upper-case, digits, symbols.</div></div>',
        'Save and continue');
      onSubmit(f, function (d, err) {
        if (d.next !== d.next2) { err.textContent = 'The passwords do not match'; return; }
        return req('POST', '/auth/change-password', { current: pendingPw || d.current, next: d.next }).then(function (r) { pendingPw = null; afterAuth(r.stage); });
      });
      return;
    }
    // Two-step verification setup
    authCard('Set up two-step verification', 'Loading…', '', 'Turn on');
    req('POST', '/auth/mfa/setup').then(function (r) {
      var qrImg = '';
      try { if (window.qrcode) { var q = window.qrcode(0, 'M'); q.addData(r.otpauth); q.make(); qrImg = '<img alt="QR code for your authenticator app" src="' + q.createDataURL(5, 8) + '" style="width:200px;height:200px;align-self:center;image-rendering:pixelated;background:#fff;border-radius:6px">'; } } catch (e) {}
      var f = authCard('Set up two-step verification', msg || 'Your role requires a verification code at sign-in. Scan the QR code with Google Authenticator, Microsoft Authenticator or a similar app, then enter the 6-digit code.',
        qrImg + '<div class="f"><label for="ms">Or enter this setup key</label><input id="ms" readonly value="' + esc(r.secret.replace(/(.{4})/g, '$1 ').trim()) + '" class="mono"></div><div class="f"><label for="mc">6-digit code</label><input id="mc" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></div>',
        'Turn on and continue');
      onSubmit(f, function (d) { return req('POST', '/auth/mfa/enable', { code: d.code }).then(function () { start(); }); });
    }).catch(function (e) { authCard('Two-step verification', e.message, '', 'Retry'); });
  }

  // ------------------------------------------------------------------ overrides of simulated behaviour
  var modeOf = function (k) { return (SERVER.integrations || {})[k] || 'mock'; };

  window.simBanner = function () {
    var mock = Object.keys(INTEG_LABEL).filter(function (k) { return modeOf(k) !== 'live'; });
    if (!mock.length) return '';
    return '<div class="banner">' + ic('alert') + '<span>Connected to the LOF server' + (SERVER.env && SERVER.env !== 'production' ? ' (' + esc(SERVER.env) + ')' : '') + '. Running in <b>mock mode</b>: ' + mock.map(function (k) { return INTEG_LABEL[k]; }).join(', ') + '. Live status: Settings → Testing console.</span></div>';
  };

  window.addPay = function (st, e, amt, method, ref, date, by) {
    var k = e.branch;
    st.seq.rc[k] = (st.seq.rc[k] || 0) + 1;
    var n = st.seq.pay;
    st.seq.pay = n + 1;
    var p = { id: FMT.pay(n), enr: e.id, stu: e.stu, amt: amt, cur: e.cur, method: method, ref: ref, at: date.length <= 10 ? date + 'T11:00:00+04:00' : date, rc: 'RC-' + k + '-26-' + p2(st.seq.rc[k], 4), status: 'Recorded', by: by, branch: e.branch };
    st.pay.push(p);
    e.paid = r2(e.paid + amt);
    e.payStatus = e.paid >= e.total - 0.005 ? 'Paid' : e.paid > 0 ? 'Partially paid' : 'Unpaid';
    return p;
  };

  window.runSync = function (id) {
    var m = S.ms.find(function (x) { return x.id === id; });
    if (!m) return;
    if (snap.ms && snap.ms.has(id)) {
      m.status = 'Pending';
      m.hist.push({ at: nowIso(), s: 'Pending', msg: 'Retry requested by ' + me().name });
      render();
    }
    scheduleFlush(0);
    pollSync(id, 0);
  };
  function pollSync(id, n) {
    setTimeout(function () {
      req('GET', '/lms/calls/' + encodeURIComponent(id)).then(function (m) {
        mergeDocs([{ coll: 'ms', doc: m }]);
        if (m.status === 'Pending' || m.status === 'Processing') { if (n < 15) pollSync(id, n + 1); return; }
        req('GET', '/bootstrap').then(function (b) { var s = (b.data.students || []).find(function (x) { return x.id === m.stu; }); if (s) mergeDocs([{ coll: 'students', doc: s }]); safeRender(); });
        var op = m.op === 'cancel' ? 'cancel' : 'enrol';
        toast(m.status === 'Success' ? 'LMS ' + op + ' call succeeded for ' + m.enr : 'LMS ' + op + ' call ' + m.status.toLowerCase() + ': ' + m.err, m.status === 'Success' ? 'ok' : 'err');
      }).catch(function () { if (n < 15) pollSync(id, n + 1); });
    }, n === 0 ? 1500 : 2000);
  }

  ACT.setUser = function (d) {
    if (!SERVER.impersonation) { toast('Role preview is disabled on this server', 'warn'); return; }
    S.menu = null;
    req('POST', '/auth/impersonate', { staffId: d.u }).then(function (r) {
      start().then(function () { toast('Viewing as ' + r.user.name + ' · ' + r.user.role); });
    }).catch(function (e) { toast(e.message, 'err'); });
  };
  ACT.logout = function () { flush().then(function () { return req('POST', '/auth/logout').catch(function () {}); }).then(function () { signOut('You have signed out.'); }); };
  ACT.mfa = function () { S.menu = null; req('GET', '/auth/me').then(function (r) { openModal('mfa', { on: r.mfaEnabled, required: r.mfaRequired }); }); };
  MODALS.mfa = function (m) {
    if (m.on) return { title: 'Two-step verification', size: 'sm2', form: m.required ? null : 'mfaOff', ok: 'Turn off', danger: 1,
      body: '<p class="sm">Two-step verification is <b>on</b>. You enter a code from your authenticator app each time you sign in.</p>' + (m.required ? '<p class="muted sm">It is required for your role and cannot be turned off.</p>' : '<div class="fgrid">' + F('Password', 'password', { t: 'password', req: 1, full: 1 }) + F('Current 6-digit code', 'code', { req: 1, full: 1 }) + '</div>') };
    return { title: 'Two-step verification', size: 'sm2', foot: '<button class="btn" data-act="closeModal">Not now</button><button class="btn primary" data-act="mfaStart">Set up</button>', body: '<p class="sm">Protect your account with a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password …) in addition to your password.</p>' };
  };
  ACT.mfaStart = function () { closeModal(); flush().then(function () { stageScreen('mfa_setup', 'Scan the QR code with your authenticator app, then enter the 6-digit code.'); }); };
  SUB.mfaOff = function (d, f) { if (!need(f, d, ['password', 'code'])) return; req('POST', '/auth/mfa/disable', d).then(function () { closeModal(); toast('Two-step verification turned off', 'warn'); }).catch(function (e) { setErr(f, 'code', e.message); }); };
  ACT.chgPwd = function () { S.menu = null; openModal('chgPwd', {}); };
  MODALS.chgPwd = function () {
    return { title: 'Change password', size: 'sm2', form: 'chgPwd', ok: 'Change password', body: '<div class="fgrid">' + F('Current password', 'current', { t: 'password', req: 1, full: 1 }) + F('New password', 'next', { t: 'password', req: 1, full: 1, help: 'At least 10 characters using three of: lower-case, upper-case, digits, symbols.' }) + '</div>' };
  };
  SUB.chgPwd = function (d, f) {
    if (!need(f, d, ['current', 'next'])) return;
    req('POST', '/auth/change-password', d).then(function () { closeModal(); toast('Password changed – other devices have been signed out', 'ok'); }).catch(function (e) { setErr(f, 'next', e.message); });
  };
  var _topbar = window.topbar;
  window.topbar = function () {
    var h = _topbar();
    if (!SERVER.impersonation) h = h.replace(/<div class="lab">Switch demo user \(role preview\)<\/div>[\s\S]*?(?=<div class="lab">Display<\/div>)/, '');
    else h = h.replace('Switch demo user (role preview)', 'Role preview (staging)');
    h = h.replace('<div class="lab">Display</div>', '<div class="lab">Account</div><div class="mi" data-act="chgPwd">' + ic('shield') + ' Change password</div><div class="mi" data-act="mfa">' + ic('shield') + ' Two-step verification</div><div class="mi" data-act="logout">' + ic('logout') + ' Sign out</div><div class="lab">Display</div>');
    if (modeOf('exotel') === 'live' || SERVER.env === 'production') h = h.replace(/<button class="btn sm" data-act="simCall"[\s\S]*?<\/button>/, '');
    return h;
  };
  var _theme = ACT.theme;
  ACT.theme = function () { _theme(); LS.set('lof_theme', S.theme); };
  var _saveFilter = ACT.saveFilter;
  ACT.saveFilter = function () { _saveFilter(); LS.set('lof_saved_filters', JSON.stringify(S.saved)); };

  // Remove prototype-only simulators from real data screens (the Testing console replaces them)
  var _leads = PAGES.leads;
  PAGES.leads = function (rt) { return _leads(rt).replace(/<button class="btn" data-act="openSimCapture">[\s\S]*?<\/button>/, ''); };
  var _lead = PAGES.lead;
  PAGES.lead = function (rt) {
    var h = _lead(rt);
    var l = leadById(rt.id);
    if (!l) return h;
    if (SERVER.env === 'production' || modeOf('whatsapp') === 'live') h = h.replace(/<button class="btn sm" data-act="mAvail"[^>]*>Simulate parent reply<\/button>/, '');
    if (l.avail && l.avail.s === 'Replied') h = h.replace(/Parent prefers <b>[^<]*<\/b>\./, 'Parent replied on WhatsApp: <b>“' + esc(l.avail.text || '') + '”</b>. Schedule the call under Follow-ups.');
    return h;
  };

  // Telephony: real click-to-call + real screen-pop
  var _callLog = MODALS.callLog;
  MODALS.callLog = function (m) {
    var x = _callLog(m);
    var live = modeOf('exotel') === 'live';
    x.body = x.body.replace(/<div class="banner">[\s\S]*?<\/div>/, '<div class="banner" style="justify-content:space-between">' + ic('phone') + '<span style="flex:1">' + (live ? 'Click-to-call rings your mobile first, then connects the parent. The call is logged automatically – add the outcome here.' : 'Exotel is in mock mode – dialling is logged but no call is placed.') + '</span><button type="button" class="btn sm primary" data-act="dialExotel" data-id="' + esc(m.id) + '">' + ic('phone') + ' Dial via Exotel</button></div>');
    return x;
  };
  ACT.dialExotel = function (d) {
    req('POST', '/leads/' + encodeURIComponent(d.id) + '/click-to-call').then(function (r) {
      toast(r.mode === 'live' ? 'Calling your phone now – answer to connect the parent' : 'Click-to-call sent (mock mode)', 'ok');
      setTimeout(function () { reload(false); }, 4000);
    }).catch(function (e) { toast(e.message, 'err'); });
  };
  var _answer = ACT.answerCall;
  ACT.answerCall = function () {
    if (S.callPopReal) { var id = S.callPop; S.callPop = null; S.callPopReal = false; go('lead', { id: id }); return; }
    _answer();
  };
  var _callPop = window.callPopHtml;
  window.callPopHtml = function () {
    var h = _callPop();
    return S.callPopReal ? h.replace('<span class="sim">Simulated</span>', '<span class="badge ok">Exotel</span>').replace('Answer &amp; open lead', 'Open lead').replace('Answer & open lead', 'Open lead') : h;
  };

  // Payments: hosted payment links + printable receipts
  var _payCollect = PAGES.payCollect;
  PAGES.payCollect = function (rt) {
    var h = _payCollect(rt);
    h = h.replace(/<div class="banner">[\s\S]*?<\/div>/, '<div class="banner">' + ic('wallet') + '<span>Record counter payments here, or send a secure payment link – <b>Telr</b> for AED branches, <b>Razorpay</b> for INR branches' + (modeOf('telr') === 'live' || modeOf('razorpay') === 'live' ? '' : ' (mock mode)') + '. Online payments are recorded automatically with a receipt.</span></div>');
    if (S.payPick) h = h.replace('<button class="btn primary" type="submit">Record payment (simulated)</button>', '<button class="btn primary" type="submit">Record payment</button><button class="btn" type="button" data-act="payLink" data-id="' + esc(S.payPick) + '">' + ic('link') + ' Send payment link</button>');
    return h;
  };
  ACT.payLink = function (d) {
    var amt = document.querySelector('#payf [name=amt]');
    req('POST', '/payments/links', { enrollmentId: d.id, amount: amt ? +amt.value : undefined }).then(function (r) { openModal('plink', { link: r }); }).catch(function (e) { toast(e.message, 'err'); });
  };
  MODALS.plink = function (m) {
    var l = m.link;
    return {
      title: 'Payment link ' + l.id, size: 'sm2',
      body: '<p class="sm">' + money(l.amount, l.currency) + ' via <b>' + (l.provider === 'telr' ? 'Telr' : 'Razorpay') + '</b>' + (l.mode === 'mock' ? ' <span class="sim">Mock</span>' : '') + '. The payment is recorded automatically when the parent pays.</p><div class="f"><label for="plurl">Link</label><input id="plurl" readonly value="' + esc(l.url) + '"></div>',
      foot: '<button class="btn" data-act="closeModal">Close</button><button class="btn" data-act="copy" data-v="' + esc(l.url) + '">Copy link</button><button class="btn" data-act="plSend" data-id="' + esc(l.id) + '" data-ch="Email">Send by e-mail</button><button class="btn primary" data-act="plSend" data-id="' + esc(l.id) + '" data-ch="WhatsApp">Send on WhatsApp</button>',
    };
  };
  ACT.plSend = function (d) {
    req('POST', '/payments/links/' + encodeURIComponent(d.id) + '/send', { channel: d.ch }).then(function () { closeModal(); toast('Payment link sent by ' + d.ch, 'ok'); }).catch(function (e) { toast(e.message, 'err'); });
  };
  ACT.genReceipt = function (d) {
    var w = window.open('', '_blank');
    fetch(API + '/payments/' + encodeURIComponent(d.id) + '/receipt', { credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (html) {
      var url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      if (w) w.location = url; else location.href = url;
    }).catch(function (e) { if (w) w.close(); toast(e.message, 'err'); });
  };
  var _receipt = MODALS.receipt;
  MODALS.receipt = function (m) {
    var x = _receipt(m);
    x.foot = x.foot.replace('Generate receipt (simulated)', 'Open printable receipt');
    x.body = x.body.replace('<span class="sim">Simulated</span>', '').replace('Prototype receipt – not a valid tax document. Finance linkage to ERPNext Accounts is pending integration.', 'Receipt numbers are issued by the server. Payments are posted to ERPNext Accounts as Payment Entries.');
    return x;
  };

  // LMS monitor + integration settings
  ACT.testInteg = function (d) {
    var map = { web: ['website'], meta: ['meta'], wa: ['whatsapp'], tel: ['exotel'], lms: ['lms'], pay: ['telr', 'razorpay'], erp: ['erpnext'], cal: ['gcal'] };
    (map[d.k] || [d.k]).forEach(testIntegration);
  };
  function testIntegration(k) {
    req('POST', '/testing/integrations/' + k + '/test').then(function (r) {
      if (k === 'lms') { S.lmsTestOk = !!r.ok && r.mode === 'live'; safeRender(); }
      toast(INTEG_LABEL[k] + ': ' + (r.ok ? 'connection OK' : 'failed – ' + r.error) + ' (' + r.mode + ')' + (r.note ? ' · ' + r.note : ''), r.ok ? (r.mode === 'live' ? 'ok' : 'warn') : 'err');
    }).catch(function (e) { toast(e.message, 'err'); });
  }
  CHG.outage = function (el) {
    req('POST', '/testing/flags', { moodleFail: el.checked }).then(function () { S.sim.moodleOutage = el.checked; toast(el.checked ? 'Mock LMS calls will fail until switched off' : 'Mock LMS outage off', 'warn'); render(); }).catch(function (e) { toast(e.message, 'err'); });
  };
  var _integ = PAGES.integration;
  PAGES.integration = function (rt) {
    var h = _integ(rt);
    return h.replace(/<div class="banner">[\s\S]*?<\/div>/, modeOf('lms') === 'live' ? '' : '<div class="banner">' + ic('alert') + 'The LMS is in mock mode – switch it on under Settings → LMS Integration and set LMS_URL / LMS_TOKEN on the server to go live.</div>')
      .replace(/Not connected – simulated/g, modeOf('lms') === 'live' ? 'Connected' : 'Mock mode');
  };
  // Website origins + Meta defaults are configurable alongside the existing integration fields
  try {
    var web = INTEG.find(function (g) { return g[0] === 'web'; });
    web[2].push(['origins', 'Allowed website origins (comma separated)']);
    var meta = INTEG.find(function (g) { return g[0] === 'meta'; });
    meta[2].push(['defaultBranch', 'Default branch for Meta leads (e.g. KRM)'], ['defaultProg', 'Default programme (e.g. COD)']);
  } catch (e) {}
  var _cfgInteg = CFG.integrations;
  CFG.integrations = function () {
    return _cfgInteg().replace(/<div class="banner">[\s\S]*?<\/div>/, '<div class="banner">' + ic('shield') + '<span>Credentials (tokens, keys, secrets) are stored as server secrets and never shown here. An integration runs <b>live</b> when it is enabled below and its secrets are set; otherwise it runs in mock mode. Check readiness in Settings → Testing console.</span></div>');
  };

  // Staff sign-in administration (System Administrator): temporary password, sign out everywhere
  var _staffModal = MODALS.staff;
  MODALS.staff = function (m) {
    var x = _staffModal(m);
    if (m.id && me().role === 'System Administrator' && m.id !== me().id) {
      x.body += '<div class="card" style="margin-top:14px"><div class="hd"><h3>Sign-in</h3></div><div class="bd" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<button class="btn sm" type="button" data-act="lofResetPw" data-id="' + esc(m.id) + '">Issue temporary password</button>' +
        '<button class="btn sm" type="button" data-act="lofResetPw" data-id="' + esc(m.id) + '" data-mfa="1">Temporary password + reset two-step</button>' +
        '<button class="btn sm" type="button" data-act="lofRevoke" data-id="' + esc(m.id) + '">Sign out everywhere</button>' +
        '<span class="muted xs">The person must change the temporary password at the next sign-in. All their sessions end.</span></div></div>';
    }
    return x;
  };
  ACT.lofResetPw = function (d) {
    req('POST', '/auth/reset-password', { staffId: d.id, resetMfa: d.mfa === '1' }).then(function (r) {
      openModal('lofTemp', { name: staffName(d.id), pw: r.temporaryPassword });
    }).catch(function (e) { toast(e.message, 'err'); });
  };
  ACT.lofRevoke = function (d) {
    req('POST', '/auth/revoke-sessions', { staffId: d.id }).then(function () { toast(staffName(d.id) + ' was signed out on every device', 'ok'); }).catch(function (e) { toast(e.message, 'err'); });
  };
  MODALS.lofTemp = function (m) {
    return { title: 'Temporary password', size: 'sm2', body: '<p>Give this temporary password to <b>' + esc(m.name) + '</b> in person or by phone – not by e-mail. It is shown only once.</p><p style="font:600 18px ui-monospace,monospace;user-select:all;padding:10px;border:1px solid var(--bd);border-radius:6px;text-align:center">' + esc(m.pw) + '</p>', foot: '<button class="btn primary" data-act="closeModal">Done</button>' };
  };

  // Templates: map CRM templates to WhatsApp-approved templates and e-mail subjects
  var _tpl = MODALS.tpl;
  MODALS.tpl = function (m) {
    var x = _tpl(m);
    var t = m.id ? S.cfg.comms.find(function (y) { return y.id === m.id; }) : {};
    x.body = x.body.replace(/(<div class="f full" data-f="body">)/, F('WhatsApp approved template name', 'waTemplate', { v: t.waTemplate || '', help: 'Needed for business-initiated WhatsApp messages. Body placeholders are sent as template parameters, in order.' }) + F('Template language', 'waLang', { v: t.waLang || 'en' }) + F('E-mail subject', 'subject', { v: t.subject || '' }) + '$1');
    return x;
  };
  var _subTpl = SUB.tpl;
  SUB.tpl = function (d, f) {
    var before = S.cfg.comms.length;
    _subTpl(d, f);
    if (S.modal) return;
    var t = d.oid ? S.cfg.comms.find(function (y) { return y.id === d.oid; }) : S.cfg.comms.length > before ? S.cfg.comms[S.cfg.comms.length - 1] : null;
    if (t) { t.waTemplate = d.waTemplate || ''; t.waLang = d.waLang || 'en'; t.subject = d.subject || ''; }
  };

  // ------------------------------------------------------------------ Settings → Testing console
  GROUPS.find(function (g) { return g.id === 'set'; }).tabs.push(['testing', 'Testing console', 'target', 'configuration']);
  ACCESS.testing = ['configuration', 'V'];
  var TC = { status: null, loading: false, results: {}, sims: {}, scen: {}, logs: null, logF: { integration: '', ok: '' } };
  function tcLoad() {
    TC.loading = true;
    return Promise.all([req('GET', '/testing/status'), tcLogs()]).then(function (r) { TC.status = r[0]; TC.loading = false; safeRender(); }).catch(function (e) { TC.loading = false; TC.error = e.message; safeRender(); });
  }
  function tcLogs() {
    var q = '?limit=100' + (TC.logF.integration ? '&integration=' + TC.logF.integration : '') + (TC.logF.ok === '0' ? '&ok=0' : '');
    return req('GET', '/testing/logs' + q).then(function (r) { TC.logs = r.items; });
  }
  var SIMS = [
    ['website', 'Website enquiry', 'Signed form submission → lead created, routed, WhatsApp/e-mail queued'],
    ['meta', 'Meta lead form', 'Signed leadgen event → lead imported'],
    ['meta-verify', 'Meta subscription check', 'hub.challenge verification'],
    ['whatsapp-verify', 'WhatsApp subscription check', 'hub.challenge verification'],
    ['whatsapp-status', 'WhatsApp delivered', 'Delivery receipt updates the latest test message'],
    ['whatsapp-inbound', 'WhatsApp reply', 'Parent reply threads onto the test lead'],
    ['exotel-incoming', 'Incoming call', 'Caller identified, screen-pop raised'],
    ['exotel-status', 'Call completed', 'Call logged, first-call SLA stopped'],
    ['telr-paid', 'Telr payment', 'Transaction advice → verified → receipt (needs an open test link)'],
    ['razorpay-paid', 'Razorpay payment', 'payment_link.paid → receipt (needs an open test link)'],
    ['bad-signature', 'Forged webhook', 'Invalid signature must be rejected with 401'],
  ];
  var SCEN = [
    ['uae-lead-to-enrolment', 'UAE: enquiry → enrolment → Telr payment', 'Website lead, routing, messages, Exotel call, conversion, enrolment, LMS enrol call, Telr, receipt, ERPNext, idempotency, withdrawal with refund suggestion and LMS cancel call'],
    ['india-lead-to-enrolment', 'India: enquiry → enrolment → Razorpay payment', 'Same flow for Bengaluru with INR and Razorpay'],
    ['meta-lead', 'Meta Lead Ads import', 'Signed leadgen webhook and forged-signature rejection'],
    ['lms-failure-retry', 'LMS outage and retry', 'The failed enrol call is recorded; the retry succeeds (mock mode only)'],
  ];
  var resBadge = function (r) {
    if (!r) return '<span class="faint">—</span>';
    if (r.running) return bdg('Running…', 'info');
    return r.ok ? bdg('Passed' + (r.mode ? ' · ' + r.mode : ''), r.mode === 'mock' ? 'warn' : 'ok') : bdg('Failed', 'crit');
  };
  PAGES.testing = function () {
    if (!TC.status && !TC.loading && !TC.error) tcLoad();
    if (!TC.status) return ph('Testing console', 'Integration readiness, webhook simulations and end-to-end scenarios') + card('', TC.error ? emptyBox('Could not load', TC.error) : emptyBox('Loading…', ''));
    var st = TC.status;
    var head = ph('Testing console', 'Check every integration before go-live. Simulations and scenarios create <b>test records only</b> (IDs start with TST-) and never touch business numbering.',
      '<button class="btn" data-act="tcRefresh">' + ic('refresh') + ' Refresh</button><button class="btn" data-act="tcCron">' + ic('clock') + ' Run scheduler now</button><button class="btn danger" data-act="tcCleanup">Delete test data (' + st.testRecords + ')</button>');
    var info = '<div class="sum"><div class="it"><small>Environment</small><b>' + esc(st.env) + '</b></div><div class="it"><small>Integration mode</small>' + (st.forcedMock ? bdg('Forced mock', 'warn') : bdg('Auto (live when enabled + configured)', 'info')) + '</div><div class="it"><small>Background jobs</small>' + (st.queue ? bdg('Cloudflare Queue', 'ok') : bdg('In-request (no queue bound)', 'warn')) + '</div><div class="it"><small>Live integrations</small><b>' + st.integrations.filter(function (i) { return i.mode === 'live'; }).length + ' / ' + st.integrations.length + '</b></div></div>';
    var integ = card('Integration readiness', table('tci', [
      { h: 'Integration', f: function (i) { return '<b>' + esc(i.label) + '</b>'; } },
      { h: 'Configuration', f: function (i) { return i.enabled ? bdg('Enabled', 'ok') : bdg('Disabled', ''); } },
      { h: 'Mode', f: function (i) { return i.mode === 'live' ? bdg('Live', 'ok') : bdg('Mock', 'warn'); } },
      { h: 'Missing secrets / settings', f: function (i) { return i.missing.length ? '<span class="mono xs" style="color:var(--crit)">' + i.missing.map(esc).join('<br>') + '</span>' : bdg('None', 'ok'); } },
      { h: 'Webhook URL to register', f: function (i) { return i.webhooks.length ? '<span class="mono xs">' + i.webhooks.map(esc).join('<br>') + '</span>' : '<span class="faint">—</span>'; } },
      { h: 'Last activity', f: function (i) { return i.last ? (i.last.ok ? bdg('OK', 'ok') : bdg('Error', 'crit')) + '<div class="muted xs">' + fDT(i.last.at) + ' · ' + esc(i.last.operation) + ' · ' + esc(i.last.mode) + '</div>' : '<span class="faint">Never</span>'; } },
      { h: 'Connection test', f: function (i) { var r = TC.results[i.key]; return '<div class="row"><button class="btn sm" data-act="tcTest" data-k="' + i.key + '">Test</button>' + resBadge(r) + '</div>' + (r && !r.running ? '<div class="xs ' + (r.ok ? 'muted' : '') + '" style="max-width:260px;overflow-wrap:anywhere;' + (r.ok ? '' : 'color:var(--crit)') + '">' + esc(r.ok ? (r.note || JSON.stringify(r.detail || '')).slice(0, 160) : r.error) + '</div>' : ''); } },
    ], st.integrations, { all: 1 }), { np: 1, act: '<button class="btn sm" data-act="tcTestAll">Test all</button>' });
    var sims = card('Webhook simulations', '<p class="muted sm" style="margin-top:0">Each simulation builds a correctly signed provider event and sends it through the real webhook endpoint.</p><div class="grid g3">' + SIMS.map(function (s) {
      var r = TC.sims[s[0]];
      return '<div class="card"><div class="bd"><div class="row" style="justify-content:space-between"><b>' + esc(s[1]) + '</b>' + resBadge(r) + '</div><div class="muted xs" style="margin:4px 0 8px">' + esc(s[2]) + '</div><button class="btn sm" data-act="tcSim" data-k="' + s[0] + '">Send</button>' + (r && !r.running ? '<div class="mono xs" style="margin-top:6px;max-height:80px;overflow:auto;overflow-wrap:anywhere;' + (r.ok ? '' : 'color:var(--crit)') + '">' + esc(r.text) + '</div>' : '') + '</div></div>';
    }).join('') + '</div>');
    var scen = card('End-to-end scenarios', '<div class="grid g2">' + SCEN.map(function (s) {
      var r = TC.scen[s[0]];
      return '<div class="card"><div class="hd"><h3>' + esc(s[1]) + '</h3><div class="row">' + resBadge(r) + '<button class="btn sm primary" data-act="tcScen" data-k="' + s[0] + '">Run</button></div></div><div class="bd"><div class="muted xs" style="margin-bottom:8px">' + esc(s[2]) + '</div>' +
        (r && r.steps ? '<div class="tl">' + r.steps.map(function (x) { return '<div class="ev ' + (x.ok ? 'msg' : 'crit') + '"><div>' + (x.ok ? '✓ ' : '✗ ') + esc(x.step) + '</div><div class="t" style="overflow-wrap:anywhere">' + x.ms + ' ms · ' + esc(typeof x.detail === 'string' ? x.detail : JSON.stringify(x.detail)).slice(0, 220) + '</div></div>'; }).join('') + '</div>' + (r.error ? '<div class="fe">' + esc(r.error) + '</div>' : '') : '<span class="faint xs">Not run yet</span>') +
        '</div></div>';
    }).join('') + '</div>');
    var flags = card('Failure injection (mock mode)', '<label class="chk"><input type="checkbox" data-change="tcFlag" data-k="moodleFail"' + (st.flags && st.flags.moodleFail ? ' checked' : '') + '> Simulate LMS outage – new LMS calls fail until switched off</label>');
    var logs = card('Integration log', '<div class="tb"><select data-change="tcLogF" name="integration" aria-label="Integration"><option value="">All integrations</option>' + Object.keys(INTEG_LABEL).map(function (k) { return '<option value="' + k + '"' + (TC.logF.integration === k ? ' selected' : '') + '>' + INTEG_LABEL[k] + '</option>'; }).join('') + '</select><select data-change="tcLogF" name="ok" aria-label="Result"><option value="">All results</option><option value="0"' + (TC.logF.ok === '0' ? ' selected' : '') + '>Failures only</option></select><span class="muted xs" style="margin-left:auto">Secrets are redacted before logging.</span></div>' +
      table('tcl', [
        { h: 'Time', f: function (l) { return fDT(l.at); } },
        { h: 'Integration', f: function (l) { return esc(INTEG_LABEL[l.integration] || l.integration); } },
        { h: 'Direction', f: function (l) { return l.direction === 'in' ? 'Inbound' : 'Outbound'; } },
        { h: 'Operation', f: function (l) { return '<span class="mono xs">' + esc(l.operation) + '</span>'; } },
        { h: 'Mode', f: function (l) { return l.mode === 'live' ? bdg('Live', 'ok') : bdg('Mock', 'warn'); } },
        { h: 'Result', f: function (l) { return l.ok ? bdg(String(l.status || 'OK'), 'ok') : bdg(String(l.status || 'Error'), 'crit'); } },
        { h: 'ms', f: function (l) { return l.duration_ms == null ? '—' : l.duration_ms; }, r: 1 },
        { h: 'Reference', f: function (l) { return '<span class="mono xs">' + esc(l.ref || '') + '</span>' + (l.is_test ? ' ' + bdg('test', 'info') : ''); } },
      ], TC.logs || [], { ps: 15, row: function (l) { return 'data-act="tcLog" data-id="' + l.id + '"'; }, et: 'No integration calls yet' }), { np: 1 });
    var suite = card('Automated test suite', '<p class="sm" style="margin-top:0">Run before every deployment: <span class="mono">npm test</span> (78 tests: unit, API & permission guard, webhooks, live adapters against stubbed provider APIs, testing console scenarios) and <span class="mono">npm run test:e2e</span> (browser tests of the screens against a local server).</p>');
    return head + info + integ + '<div style="height:14px"></div>' + scen + '<div style="height:14px"></div>' + sims + '<div style="height:14px"></div><div class="grid g2">' + flags + suite + '</div><div style="height:14px"></div>' + logs;
  };
  ACT.tcRefresh = function () { TC.status = null; TC.error = null; render(); };
  ACT.tcTest = function (d) {
    TC.results[d.k] = { running: true }; render();
    return req('POST', '/testing/integrations/' + d.k + '/test').then(function (r) { TC.results[d.k] = r; }).catch(function (e) { TC.results[d.k] = { ok: false, error: e.message }; })
      .then(tcLogs).then(function () { req('GET', '/testing/status').then(function (s) { TC.status = s; safeRender(); }); });
  };
  ACT.tcTestAll = function () { TC.status.integrations.reduce(function (p, i) { return p.then(function () { return ACT.tcTest({ k: i.key }); }); }, Promise.resolve()); };
  ACT.tcSim = function (d) {
    TC.sims[d.k] = { running: true }; render();
    req('POST', '/testing/webhooks/' + d.k + '/simulate', {}).then(function (r) {
      TC.sims[d.k] = { ok: r.ok !== false && (r.status ? r.status < 400 || d.k === 'bad-signature' : true), text: 'HTTP ' + r.status + ' ' + (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
    }).catch(function (e) { TC.sims[d.k] = { ok: false, text: e.message }; }).then(function () { return Promise.all([tcLogs(), req('GET', '/testing/status').then(function (s) { TC.status = s; })]); }).then(function () { reload(true); });
  };
  ACT.tcScen = function (d) {
    TC.scen[d.k] = { running: true }; render();
    req('POST', '/testing/scenarios/' + d.k + '/run').then(function (r) { TC.scen[d.k] = r; }).catch(function (e) { TC.scen[d.k] = { ok: false, error: e.message, steps: [] }; })
      .then(function () { return Promise.all([tcLogs(), req('GET', '/testing/status').then(function (s) { TC.status = s; })]); }).then(function () { reload(true); });
  };
  ACT.tcCron = function () { req('POST', '/testing/cron').then(function (r) { toast('Scheduler ran: ' + r.leadsChecked + ' open leads checked, ' + (r.overdueInstalments || 0) + ' overdue instalment(s) notified, ' + (r.lmsRetries || 0) + ' LMS retries queued', 'ok'); reload(true); }).catch(function (e) { toast(e.message, 'err'); }); };
  ACT.tcCleanup = function () { confirmBox('Delete test data', 'Delete all records created by simulations and scenarios (IDs starting with TST-) and their logs? Business records are not affected.', 'tcCleanup', null, 'Delete test data', 1); };
  CONFIRM.tcCleanup = function () { req('POST', '/testing/cleanup').then(function (r) { toast(r.deleted + ' test records deleted', 'ok'); TC.status = null; TC.scen = {}; TC.sims = {}; reload(true); }).catch(function (e) { toast(e.message, 'err'); }); };
  CHG.tcFlag = function (el) { var b = {}; b[el.dataset.k] = el.checked; req('POST', '/testing/flags', b).then(function () { TC.status.flags = Object.assign({}, TC.status.flags, b); toast('Failure injection ' + (el.checked ? 'on' : 'off'), 'warn'); }); };
  CHG.tcLogF = function (el) { TC.logF[el.name] = el.value; tcLogs().then(function () { render(); }); };
  ACT.tcLog = function (d) { req('GET', '/testing/logs/' + d.id).then(function (l) { openModal('tcLog', { l: l }); }); };
  MODALS.tcLog = function (m) {
    var l = m.l;
    var pretty = function (s) { try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { return s || ''; } };
    var pre = function (s) { return '<pre style="white-space:pre-wrap;overflow-wrap:anywhere;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:10px;font-family:var(--f-mono);font-size:11.5px;max-height:260px;overflow:auto">' + esc(pretty(s)) + '</pre>'; };
    return { title: (INTEG_LABEL[l.integration] || l.integration) + ' · ' + l.operation, size: 'lg', foot: '<button class="btn" data-act="closeModal">Close</button>',
      body: dl([['Time', fDT(l.at)], ['Direction', l.direction === 'in' ? 'Inbound webhook' : 'Outbound API call'], ['Mode', l.mode], ['Request', esc((l.method || '') + ' ' + (l.url || ''))], ['Result', (l.ok ? 'OK' : 'Failed') + (l.status ? ' · HTTP ' + l.status : '') + (l.duration_ms != null ? ' · ' + l.duration_ms + ' ms' : '')], ['Error', esc(l.error || '')], ['Reference', esc(l.ref || '')]]) +
        '<div class="sec">Request</div>' + pre(l.request) + '<div class="sec">Response</div>' + pre(l.response) };
  };

  // ------------------------------------------------------------------ fixes found in QA
  // Editing a branch / programme: the disabled Short ID field is not submitted, so carry it over
  var _subBranch = SUB.branch;
  SUB.branch = function (d, f) { if (d.oid && !d.id) d.id = d.oid; return _subBranch(d, f); };
  var _subProg = SUB.prog;
  SUB.prog = function (d, f) { if (d.oid && !d.id) d.id = d.oid; return _subProg(d, f); };
  // Lost leads can be reopened too (prototype offered it only for Not Interested)
  var _leadPage = PAGES.lead;
  PAGES.lead = function (rt) {
    var h = _leadPage(rt), l = leadById(rt.id);
    if (l && l.status === 'Lost' && can('leads', 'E') && h.indexOf('data-act="reopen"') < 0) h = h.replace(/(<button class="btn" data-act="mEditLead"[^>]*>Edit<\/button>)/, '$1<button class="btn" data-act="reopen" data-id="' + esc(l.id) + '">Reopen</button>');
    return h;
  };
  var _reopen = ACT.reopen;
  ACT.reopen = function (d) { var l = leadById(d.id); if (l && l.status === 'Lost') { l.lostReason = ''; l.status = 'Closed'; } _reopen(d); };
  // Bulk assign: only open leads are assigned, so say how many actually were
  SUB.bulkAssign = function (d, f) {
    if (!need(f, d, ['to', 'reason'])) return;
    var ids = Object.keys(S_sel), n = 0;
    ids.forEach(function (id) { var l = leadById(id); if (l && l.status === 'Open') { reassign(l, d.to, d.reason, 'Manual (bulk)'); n++; } });
    S_sel = {}; closeModal();
    toast(n ? n + ' lead(s) assigned to ' + staffName(d.to) + (n < ids.length ? ' – ' + (ids.length - n) + ' closed or converted lead(s) skipped' : '') : 'Nothing assigned – only open leads can be assigned', n ? 'ok' : 'warn');
  };

  // Integrations are real now: remove the prototype's "simulated / not connected" wording everywhere
  var liveText = function (k, live, mock) { return modeOf(k) === 'live' ? live : mock; };
  function deSim(h) {
    return h
      .replace(/<span class="sim">Simulated<\/span>/g, '')
      .replace(/\s?\((?:simulated|Simulated)[^)<]*\)/g, '')
      .replace(/Send \(simulated\)/g, 'Send')
      .replace(/Enabled – simulated/g, 'Enabled')
      .replace(/ · integration <span class="badge warn">not connected – simulated<\/span>/g, '')
      .replace(/WhatsApp Business is not connected – messages are recorded as simulated\./g, liveText('whatsapp', 'Messages are sent through WhatsApp Business.', 'WhatsApp is in mock mode – messages are logged but not delivered.'))
      .replace(/Telephony \(([^)]*)\) is not connected\. Entries marked Simulated were created in this prototype; seeded calls are sample data\./g, liveText('exotel', 'Calls are logged automatically from Exotel; add the outcome on the lead.', 'Exotel is in mock mode – log calls manually.'))
      .replace(/Payment gateway is not connected\. The payment is recorded manually and marked simulated\./g, 'Record the payment taken at the counter. For online payment, finish the enrolment and use Payments → Send payment link.')
      .replace(/WhatsApp and email providers are not connected; sending is simulated\./g, 'Messages are sent by WhatsApp Business and e-mail when those integrations are live (Settings → Testing console).')
      .replace(/Status: <span class="badge warn">[^<]*<\/span>/g, '')
      .replace(/Outcomes that record a call are logged as simulated\./g, 'The outcome is saved on the lead’s call log.')
      .replace(/Simulates the parent answering the WhatsApp availability request \(WhatsApp is not connected\)\./g, 'Record the time the parent asked for.')
      .replace(/Calendar sync \(Google\/Outlook\) is a configurable placeholder and is not connected\. /g, liveText('gcal', 'Scheduled calls are added to the team’s Google Calendar. ', ''))
      .replace(/Downloads are disabled inside the prototype viewer, so the export is shown here\./g, 'Copy the export below into a spreadsheet.');
  }
  var _shell = window.shell;
  window.shell = function () { return deSim(_shell()); };
  var _toast = window.toast;
  window.toast = function (msg, kind) { return _toast(String(msg).replace(/\s?\((?:simulated|Simulated)[^)]*\)/g, '').replace(/ \(simulated telephony\)/g, ''), kind); };
  var _addAudit = window.addAudit;
  window.addAudit = function (act, ref, det, by) { return _addAudit(String(act).replace(/\s?\(simulated\)/g, ''), ref, String(det || '').replace(/\s?\((?:simulated|Simulated)[^)]*\)/g, ''), by); };
  // LMS monitor: list the other integrations with their real mode
  var _integPage = PAGES.integration;
  PAGES.integration = function (rt) {
    var h = _integPage(rt);
    var rows = Object.keys(INTEG_LABEL).filter(function (k) { return k !== 'lms'; }).map(function (k) { return '<tr><td>' + INTEG_LABEL[k] + '</td><td>' + (modeOf(k) === 'live' ? bdg('Live', 'ok') : bdg('Mock', 'warn')) + '</td><td class="muted sm">Details: Settings → Testing console</td></tr>'; }).join('');
    return h.replace(/(<h3>Other integrations<\/h3>[\s\S]*?<tbody>)[\s\S]*?(<\/tbody>)/, '$1' + rows + '$2');
  };

  // ------------------------------------------------------------------ Settings → Database (System Administrator)
  CTABS.push(['database', 'Database']);
  var DBV = { tables: null, name: 'leads', q: '', branch: '', test: false, offset: 0, page: null, loading: false, error: null };
  var DB_LIMIT = 50;
  function dbQuery() { return '?name=' + encodeURIComponent(DBV.name) + '&q=' + encodeURIComponent(DBV.q) + '&branch=' + encodeURIComponent(DBV.branch) + (DBV.test ? '&test=1' : ''); }
  var dbSeq = 0;
  function dbLoad() {
    var my = ++dbSeq; // only the latest request may update the screen (fast table switching)
    DBV.loading = true; DBV.error = null;
    var t = DBV.tables ? Promise.resolve(null) : req('GET', '/admin/db/tables').then(function (r) { DBV.tables = r.datasets; });
    return t.then(function () { return req('GET', '/admin/db/rows' + dbQuery() + '&limit=' + DB_LIMIT + '&offset=' + DBV.offset); })
      .then(function (r) { if (my === dbSeq) DBV.page = r; }).catch(function (e) { if (my === dbSeq) DBV.error = e.message; })
      .then(function () { if (my !== dbSeq) return; DBV.loading = false; safeRender(); });
  }
  function dbDownload(path, fallbackName) {
    return fetch(API + path, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error) || 'HTTP ' + r.status); });
      var cd = r.headers.get('content-disposition') || '', m = /filename="([^"]+)"/.exec(cd);
      var truncated = r.headers.get('x-lof-truncated') === '1';
      return r.blob().then(function (b) { var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = m ? m[1] : fallbackName; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000); return { truncated: truncated }; });
    });
  }
  CFG.database = function () {
    if (me().role !== 'System Administrator') return card('Database', emptyBox('Restricted', 'Only a System Administrator can open the database.'));
    if (!DBV.page && !DBV.loading && !DBV.error) { dbLoad(); }
    var ds = (DBV.tables || []).find(function (d) { return d.name === DBV.name; }) || {};
    var groups = ['Business', 'Settings', 'System'].map(function (g) {
      var items = (DBV.tables || []).filter(function (d) { return d.group === g; });
      return '<div class="sec" style="margin-top:6px">' + g + '</div><div class="chips">' + items.map(function (d) { return '<a class="chip' + (d.name === DBV.name ? ' on' : '') + '" data-act="dbPick" data-n="' + d.name + '" tabindex="0">' + esc(d.label) + ' <span class="muted xs">' + d.rows.toLocaleString('en-US') + '</span></a>'; }).join('') + '</div>';
    }).join('');
    var p = DBV.page, body;
    if (DBV.error) body = '<div class="banner" style="background:var(--crit-bg,#fdecec)">' + esc(DBV.error) + '</div>';
    else if (!p) body = emptyBox('Loading…', '');
    else if (!p.rows.length) body = emptyBox('No records', DBV.q || DBV.branch ? 'Clear the search or branch filter.' : 'This table is empty.');
    else body = '<div class="tbl-wrap"><table class="tbl"><thead><tr>' + p.columns.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' + p.rows.map(function (r) {
      var id = r[p.columns.indexOf(p.columns[0])];
      return '<tr' + (ds.detail ? ' class="cl" style="cursor:pointer" data-act="dbRec" data-id="' + esc(id) + '"' : '') + '>' + r.map(function (v) { var t = v == null ? '' : String(v); return '<td class="' + (typeof v === 'number' ? 'r num' : '') + '" title="' + esc(t) + '">' + esc(t.length > 80 ? t.slice(0, 80) + '…' : t) + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody></table></div><div class="pager"><span>' + (p.offset + 1) + '–' + (p.offset + p.rows.length) + ' of ' + p.total.toLocaleString('en-US') + '</span><span class="row">' +
      '<button class="btn sm" data-act="dbPage" data-d="-1"' + (p.offset ? '' : ' disabled') + '>Previous</button><button class="btn sm" data-act="dbPage" data-d="1"' + (p.offset + p.rows.length < p.total ? '' : ' disabled') + '>Next</button></span></div>';
    var brs = (S.branches || []).map(function (b) { return '<option value="' + b.id + '"' + (DBV.branch === b.id ? ' selected' : '') + '>' + esc(b.name) + '</option>'; }).join('');
    var filters = '<form data-submit="dbSearch" class="tb" style="border:0;padding:0 0 12px;flex-wrap:wrap"><input type="search" name="q" value="' + esc(DBV.q) + '" placeholder="Search ' + esc(ds.label || '') + '" aria-label="Search" style="min-width:min(100%,260px)">' +
      (ds.branch ? '<select name="branch" aria-label="Branch"><option value="">All branches</option>' + brs + '</select>' : '') +
      (ds.hasTest ? '<label class="chk sm"><input type="checkbox" name="test"' + (DBV.test ? ' checked' : '') + '> Include test records</label>' : '') +
      '<button class="btn sm primary" type="submit">Search</button><span class="row" style="margin-left:auto"><button class="btn sm" type="button" data-act="dbCsv">' + ic('download') + ' Export CSV</button><button class="btn sm" type="button" data-act="dbBackup">' + ic('download') + ' Full backup (JSON)</button><button class="btn sm ghost" type="button" data-act="dbRefresh">Refresh</button></span></form>';
    return '<div class="banner">' + ic('shield') + '<span>Read-only view of the live database. Passwords, two-step secrets and session tokens are never shown. Exports and backups are recorded in the audit log.</span></div>' +
      card('Tables', groups) + '<div style="height:14px"></div>' + card(esc(ds.label || 'Records') + (ds.note ? '<div class="muted xs" style="font-weight:400">' + esc(ds.note) + '</div>' : ''), filters + body);
  };
  ACT.dbPick = function (d) { DBV.name = d.n; DBV.offset = 0; DBV.q = ''; DBV.branch = ''; DBV.page = null; dbLoad(); render(); };
  ACT.dbPage = function (d) { DBV.offset = Math.max(0, DBV.offset + (+d.d) * DB_LIMIT); dbLoad(); };
  ACT.dbRefresh = function () { DBV.tables = null; DBV.page = null; dbLoad(); render(); };
  SUB.dbSearch = function (d) { DBV.q = d.q || ''; DBV.branch = d.branch || ''; DBV.test = !!d.test; DBV.offset = 0; dbLoad(); };
  ACT.dbCsv = function () { dbDownload('/admin/db/rows.csv' + dbQuery(), 'lof-' + DBV.name + '.csv').then(function (r) { toast(r && r.truncated ? 'CSV downloaded – first 50,000 rows only; narrow the search for the rest' : 'CSV downloaded', r && r.truncated ? 'warn' : 'ok'); }).catch(function (e) { toast(e.message, 'err'); }); };
  ACT.dbBackup = function () { dbDownload('/admin/db/backup', 'lof-crm-backup.json').then(function () { toast('Backup downloaded – keep it somewhere safe', 'ok'); }).catch(function (e) { toast(e.message, 'err'); }); };
  ACT.dbRec = function (d) { if (!DBV.page || DBV.page.name !== DBV.name) return; req('GET', '/admin/db/record?name=' + encodeURIComponent(DBV.name) + '&id=' + encodeURIComponent(d.id)).then(function (r) { openModal('dbRec', { id: d.id, r: r }); }).catch(function (e) { toast(e.message, 'err'); }); };
  MODALS.dbRec = function (m) {
    return { title: (((DBV.tables || []).find(function (x) { return x.name === DBV.name; }) || {}).label || 'Record') + ' – ' + m.id, size: 'lg', foot: '<button class="btn" data-act="closeModal">Close</button>',
      body: (m.r.meta ? '<p class="muted xs">Updated ' + esc(m.r.meta.updated_at || '') + (m.r.meta.updated_by ? ' by ' + esc(m.r.meta.updated_by) : '') + ' · version ' + esc(m.r.meta.version || 1) + (m.r.meta.is_test ? ' · test record' : '') + '</p>' : '') +
        '<pre class="mono sm" style="white-space:pre-wrap;word-break:break-word;max-height:60vh;overflow:auto;background:var(--bg2,#f6f7f9);padding:12px;border-radius:6px">' + esc(JSON.stringify(m.r.record, null, 2)) + '</pre>' };
  };

  // ------------------------------------------------------------------ Configuration → Email Templates (after Communication)
  CTABS.splice(CTABS.findIndex(function (t) { return t[0] === 'comms'; }) + 1, 0, ['emailTpls', 'Email Templates']);
  var ET = { cat: '', q: '' }, etLastField = 'body';
  function etMeta() { return SERVER.emailTemplates || { categories: [], placeholders: {} }; }
  function etList() { return S.cfg.emailTpls || (S.cfg.emailTpls = []); }
  function etById(id) { return etList().find(function (t) { return t.id === id; }); }
  function etBranch(id) { if (id === 'All') return 'All branches'; var b = (S.branches || []).find(function (x) { return x.id === id; }); return b ? b.name : id; }
  function etSample(s) { var p = etMeta().placeholders; return String(s).replace(/\{(\w+)\}/g, function (all, k) { return p[k] ? p[k].sample : all; }); }
  CFG.emailTpls = function () {
    var meta = etMeta(), edit = can('configuration', 'E'), q = ET.q.toLowerCase(), all = etList();
    var rows = all.filter(function (t) { return (!ET.cat || t.cat === ET.cat) && (!q || (t.n + ' ' + t.subject + ' ' + t.body).toLowerCase().indexOf(q) >= 0); });
    var cats = '<div class="chips" style="margin-bottom:12px">' + [''].concat(meta.categories).map(function (c) {
      var n = all.filter(function (t) { return !c || t.cat === c; }).length;
      return '<a class="chip' + (ET.cat === c ? ' on' : '') + '" data-act="etCat" data-c="' + esc(c) + '" tabindex="0">' + esc(c || 'All') + ' <span class="muted xs">' + n + '</span></a>';
    }).join('') + '</div>';
    var search = '<div class="tb" style="border:0;padding:0 0 12px"><input type="search" id="etq" data-input="etq" placeholder="Search name, subject or message" value="' + esc(ET.q) + '" aria-label="Search e-mail templates" style="min-width:min(100%,300px)"></div>';
    var list = rows.length ? table('etpl', [
      { h: 'Template', f: function (t) { return '<b>' + esc(t.n) + '</b><div class="muted xs">' + esc(t.cat) + '</div>'; }, s: function (t) { return t.cat + ' ' + t.n; } },
      { h: 'Subject', f: function (t) { return '<span class="sm">' + esc(t.subject) + '</span>'; } },
      { h: 'Branch', f: function (t) { return esc(etBranch(t.branch)); }, s: function (t) { return etBranch(t.branch); } },
      { h: 'Status', f: function (t) { return bdg(t.active ? 'Active' : 'Inactive', t.active ? 'ok' : ''); } },
      { h: '', f: function (t) {
        return '<span class="row" style="justify-content:flex-end;flex-wrap:nowrap"><button class="btn sm" data-act="etPreview" data-id="' + t.id + '">Preview</button>' +
          (edit ? '<button class="btn sm" data-act="etEdit" data-id="' + t.id + '">Edit</button><button class="btn sm ghost" data-act="etCopy" data-id="' + t.id + '">Duplicate</button>' : '') + '</span>';
      } },
    ], rows, { all: 1 }) : emptyBox('No templates', ET.q || ET.cat ? 'Clear the search or pick another category.' : 'Add the first template.');
    return card('Email Templates<div class="muted xs" style="font-weight:400">E-mails to parents and clients – fee receipts, reminders, competitions, progress updates and notices.</div>',
      cats + search + list, { act: edit ? '<button class="btn sm primary" data-act="etAdd">' + ic('plus') + ' Add template</button>' : '' }) +
      '<p class="muted xs">Placeholders such as {student_name} or {receipt_no} are filled in when an e-mail is sent. A template for one branch is used instead of the “All branches” template with the same name. Automated lead and enrolment messages are under Communication.</p>';
  };
  ACT.etCat = function (d) { ET.cat = d.c || ''; render(); };
  INP.etq = function (el) { ET.q = el.value; render(); };
  ACT.etAdd = function () { openModal('etTpl', {}); };
  ACT.etEdit = function (d) { openModal('etTpl', { id: d.id }); };
  ACT.etCopy = function (d) { openModal('etTpl', { copy: d.id }); };
  ACT.etPreview = function (d) { openModal('etPreview', { id: d.id }); };
  ACT.etDelete = function (d) { var t = etById(d.id); if (t) confirmBox('Delete template', 'Delete <b>' + esc(t.n) + '</b>? E-mails already sent are not affected.', 'etDelete', d.id, 'Delete', true); };
  CONFIRM.etDelete = function (id) {
    var t = etById(id); if (!t) return;
    S.cfg.emailTpls = etList().filter(function (x) { return x.id !== id; });
    cfgSave('E-mail template ' + t.n, 'Deleted');
  };
  // Placeholder chips insert at the cursor of the subject or message field (whichever was used last)
  document.addEventListener('focusin', function (e) { if (e.target && (e.target.id === 'f_subject' || e.target.id === 'f_body')) etLastField = e.target.id.slice(2); });
  ACT.etIns = function (d) {
    var el = document.getElementById('f_' + etLastField); if (!el) return;
    var v = '{' + d.k + '}', a = el.selectionStart == null ? el.value.length : el.selectionStart, b = el.selectionEnd == null ? a : el.selectionEnd;
    el.value = el.value.slice(0, a) + v + el.value.slice(b);
    el.focus(); el.selectionStart = el.selectionEnd = a + v.length;
  };
  MODALS.etTpl = function (m) {
    var meta = etMeta(), src = etById(m.id || m.copy);
    var t = src ? Object.assign({}, src) : { cat: ET.cat || meta.categories[0], n: '', subject: '', body: '', branch: 'All', active: true };
    if (m.copy) t.n = t.n + ' (copy)';
    var chips = Object.keys(meta.placeholders).map(function (k) { return '<a class="chip" data-act="etIns" data-k="' + k + '" tabindex="0" title="' + esc(meta.placeholders[k].label) + '">{' + k + '}</a>'; }).join('');
    return { title: m.id ? 'Edit e-mail template' : 'Add e-mail template', size: 'lg', form: 'etTpl',
      foot: '<button class="btn" type="button" data-act="closeModal">Cancel</button>' + (m.id ? '<button class="btn danger" type="button" data-act="etDelete" data-id="' + esc(m.id) + '">Delete</button>' : '') + '<button class="btn primary" type="submit" form="mform">Save template</button>',
      body: '<input type="hidden" name="oid" value="' + esc(m.id || '') + '"><div class="fgrid">' +
        F('Category', 'cat', { v: t.cat, opts: meta.categories, req: 1 }) + F('Template name', 'n', { v: t.n, req: 1, ph: 'e.g. Fee receipt' }) +
        F('Branch', 'branch', { v: t.branch, opts: [['All', 'All branches']].concat((S.branches || []).map(function (b) { return [b.id, b.name]; })) }) +
        CK('Active – available for sending', 'active', t.active) +
        F('Subject', 'subject', { v: t.subject, req: 1, full: 1 }) +
        F('Message', 'body', { t: 'textarea', rows: 12, v: t.body, req: 1, full: 1, help: 'Plain text. Blank lines start a new paragraph.' }) +
        '<div class="f full"><label>Placeholders – click to insert at the cursor</label><div class="chips">' + chips + '</div></div></div>' };
  };
  SUB.etTpl = function (d, f) {
    if (!need(f, d, ['n', 'subject', 'body'])) return;
    var known = etMeta().placeholders, name = d.n.trim(), branch = d.branch || 'All';
    var unknown = function (s) { return (String(s).match(/\{[^{}]*\}/g) || []).map(function (p) { return p.slice(1, -1); }).find(function (k) { return !known[k]; }); };
    var bs = unknown(d.subject), bb = unknown(d.body);
    if (bs !== undefined) { setErr(f, 'subject', 'Unknown placeholder {' + bs + '}'); return; }
    if (bb !== undefined) { setErr(f, 'body', 'Unknown placeholder {' + bb + '}'); return; }
    if (etList().some(function (t) { return t.id !== d.oid && t.n.toLowerCase() === name.toLowerCase() && t.branch === branch; })) { setErr(f, 'n', 'A template with this name already exists for this branch'); return; }
    var o = { cat: d.cat, n: name, subject: d.subject.trim(), body: d.body, branch: branch, active: !!d.active };
    if (d.oid) Object.assign(etById(d.oid), o);
    else {
      var next = etList().reduce(function (mx, t) { return Math.max(mx, +String(t.id).replace(/\D/g, '') || 0); }, 0) + 1;
      etList().push(Object.assign({ id: 'ET' + next }, o));
    }
    closeModal();
    cfgSave('E-mail template ' + name, o.cat + ' · ' + etBranch(branch));
  };
  MODALS.etPreview = function (m) {
    var t = etById(m.id) || {}, p = etMeta().placeholders;
    return { title: 'Preview – ' + (t.n || ''), size: 'lg',
      foot: '<button class="btn" data-act="closeModal">Close</button>' + (can('configuration', 'E') ? '<button class="btn primary" data-act="etEdit" data-id="' + esc(t.id) + '">Edit</button>' : ''),
      body: '<p class="muted xs" style="margin-top:0">Shown with sample values. Real e-mails use the student’s and parent’s details.</p>' +
        '<div style="border:1px solid var(--bd);border-radius:8px;overflow:hidden"><div style="padding:10px 14px;border-bottom:1px solid var(--bd)">' +
        '<div class="muted xs">To: ' + esc(p.parent_name ? p.parent_name.sample : '') + '</div><b>' + esc(etSample(t.subject || '')) + '</b></div>' +
        '<div class="sm" style="padding:14px;white-space:pre-wrap;line-height:1.55">' + esc(etSample(t.body || '')) + '</div></div>' };
  };

  // ------------------------------------------------------------------ Configuration → Email Outgoing / Email Incoming
  CTABS.splice(CTABS.findIndex(function (t) { return t[0] === 'emailTpls'; }) + 1, 0, ['mailOut', 'Email Outgoing'], ['mailIn', 'Email Incoming']);
  var MAIL = { status: null, inbox: null, loading: false, error: null };
  var MAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
  function mailLoad() {
    if (MAIL.loading) return;
    MAIL.loading = true; MAIL.error = null;
    Promise.all([req('GET', '/mail/status'), req('GET', '/mail/inbound')])
      .then(function (r) { MAIL.status = r[0]; MAIL.inbox = r[1].items; })
      .catch(function (e) { MAIL.error = e.message; })
      .then(function () { MAIL.loading = false; safeRender(); });
  }
  function mailReady() { if (!MAIL.status && !MAIL.loading && !MAIL.error) mailLoad(); return !!MAIL.status; }
  var mailKV = function (rows) { return '<div class="fgrid">' + rows.map(function (r) { return '<div class="f"><label>' + r[0] + '</label><div>' + r[1] + '</div></div>'; }).join('') + '</div>'; };

  CFG.mailOut = function () {
    var o = S.cfg.mailOut || {}, edit = can('configuration', 'E'), st = MAIL.status && MAIL.status.outgoing;
    var status = !mailReady() ? (MAIL.error ? emptyBox('Could not load', MAIL.error) : emptyBox('Loading…', '')) : mailKV([
      ['Provider', esc(st.provider)],
      ['Mode', st.mode === 'live' ? bdg('Live – e-mails are delivered', 'ok') : bdg('Mock – nothing is delivered', 'warn')],
      ['Sending address', '<span class="mono sm">' + esc(st.from || 'not set') + '</span>'],
      ['Missing settings', st.missing.length ? '<span class="mono xs" style="color:var(--crit)">' + st.missing.map(esc).join(', ') + '</span>' : bdg('None', 'ok')],
    ]) + (o.on === false ? '<div class="banner" style="margin-top:12px">' + ic('alert') + '<span><b>Sending is paused.</b> E-mails are not sent until you turn sending back on.</span></div>' : '');
    var form = cfgForm('mailOut',
      swRow('Send e-mails', 'on', o.on !== false, 'Turn off to pause every e-mail the CRM sends (messages are marked Failed and can be sent again).') +
      '<div class="fgrid" style="margin-top:12px">' +
      F('Sender name', 'fromName', { v: o.fromName, req: 1, help: 'Shown to parents as the sender, e.g. Lab of Future' }) +
      F('Reply-to address', 'replyTo', { v: o.replyTo, ph: 'communications@laboffuture.com', help: 'Where parent replies go. Leave empty to use the sending address.' }) +
      F('Send a copy (BCC) to', 'bcc', { v: o.bcc, ph: 'optional', help: 'Keeps a copy of every e-mail in this mailbox' }) +
      F('Daily sending limit', 'dailyLimit', { t: 'number', min: 0, max: 10000, v: o.dailyLimit, help: 'Stops sending for the day above this number (0 = no limit). Gmail allows about 2,000 a day.' }) +
      F('Signature', 'signature', { t: 'textarea', rows: 4, v: o.signature, full: 1, ph: 'Lab of Future\n+971 4 000 0000 · laboffuture.com', help: 'Added to the end of every e-mail' }) + '</div>');
    var test = '<form data-submit="mailTest" class="row" novalidate style="flex-wrap:wrap;gap:8px"><input type="email" name="to" placeholder="your.name@laboffuture.com" aria-label="Send test e-mail to" style="min-width:min(100%,280px)"><button class="btn primary" type="submit">Send test e-mail</button></form>' +
      '<p class="muted xs">Uses the saved settings above. In mock mode the e-mail is only written to the Integration log.</p>';
    return card('Connection', status, { act: '<button class="btn sm ghost" data-act="mailRefresh">Refresh</button>' }) + '<div style="height:14px"></div>' +
      card('Sending rules', edit ? form : mailKV([['Sending', o.on === false ? 'Paused' : 'On'], ['Sender name', esc(o.fromName)], ['Reply-to', esc(o.replyTo || '—')], ['Copy to', esc(o.bcc || '—')], ['Daily limit', esc(o.dailyLimit)]])) +
      (edit ? '<div style="height:14px"></div>' + card('Test', test) : '') +
      '<p class="muted xs">These rules apply to every e-mail the CRM sends: lead messages, enrolment welcome, payment links and e-mail templates.</p>';
  };
  SUB.cfg_mailOut = function (d, f) {
    clearErrs(f);
    if (!need(f, d, ['fromName'])) return;
    if (/[<>"]/.test(d.fromName)) { setErr(f, 'fromName', 'Do not use < > or quotes'); return; }
    if (d.replyTo && !MAIL_RE.test(d.replyTo.trim())) { setErr(f, 'replyTo', 'Enter a valid e-mail address'); return; }
    if (d.bcc && !MAIL_RE.test(d.bcc.trim())) { setErr(f, 'bcc', 'Enter a valid e-mail address'); return; }
    var lim = Number(d.dailyLimit);
    if (!Number.isInteger(lim) || lim < 0 || lim > 10000) { setErr(f, 'dailyLimit', 'Whole number from 0 to 10,000'); return; }
    S.cfg.mailOut = { on: !!d.on, fromName: d.fromName.trim(), replyTo: (d.replyTo || '').trim().toLowerCase(), bcc: (d.bcc || '').trim().toLowerCase(), signature: d.signature || '', dailyLimit: lim };
    cfgSave('Email Outgoing', (d.on ? 'Sending on' : 'Sending paused') + ' · limit ' + lim + '/day');
  };
  SUB.mailTest = function (d) {
    var to = String(d.to || '').trim();
    if (!MAIL_RE.test(to)) { toast('Enter a valid e-mail address', 'err'); return; }
    flush().then(function () { return req('POST', '/mail/test-send', { to: to }); })
      .then(function (r) { toast(r.mode === 'live' ? 'Test e-mail sent to ' + to : 'Mock mode: test e-mail logged, not delivered', r.mode === 'live' ? 'ok' : 'warn'); })
      .catch(function (e) { toast(e.message, 'err'); });
  };
  ACT.mailRefresh = function () { MAIL.status = null; MAIL.inbox = null; MAIL.error = null; mailLoad(); render(); };

  CFG.mailIn = function () {
    var r = S.cfg.mailIn || {}, edit = can('configuration', 'E'), ready = mailReady();
    var brs = (S.branches || []).map(function (b) { return [b.id, b.name]; });
    var progs = (S.programs || []).map(function (p) { return [p.id, p.name]; });
    var conn = '<div class="banner">' + ic('mail') + '<span>' + (ready && MAIL.status.incoming.connected ? 'Mailbox connected – new e-mails are imported every 5 minutes.' : '<b>Mailbox not connected yet.</b> Automatic import starts when the Gmail connection is set up. You can set the rules now and test them with the simulation below.') + '</span></div>';
    var form = cfgForm('mailIn',
      swRow('Import incoming e-mail', 'on', !!r.on, 'Read new e-mails from the mailbox and file them in the CRM') +
      swRow('Notify staff when an e-mail arrives', 'notify', r.notify !== false, 'The counsellor (leads) or the branch team (students) gets a CRM notification') +
      '<div class="fgrid" style="margin-top:12px">' +
      F('Mailbox', 'mailbox', { v: r.mailbox, ph: 'communications@laboffuture.com' }) +
      F('E-mail from an unknown sender', 'unknown', { v: r.unknown || 'review', opts: [['review', 'Hold for review – notify the Admissions Head'], ['lead', 'Create a new lead'], ['ignore', 'Ignore']] }) +
      F('Branch for new leads', 'branch', { v: r.branch, opts: brs, blank: '— choose —', help: 'Used when unknown senders create a lead' }) +
      F('Programme for new leads', 'prog', { v: r.prog, opts: progs, blank: '— choose —' }) +
      F('Blocked senders', 'block', { t: 'textarea', rows: 4, v: (r.block || []).join('\n'), full: 1, ph: 'spam@example.com\n@marketing-company.com', help: 'One address or domain per line. E-mails from these senders are never filed.' }) + '</div>');
    var how = '<ol class="sm" style="margin:0;padding-left:18px;line-height:1.7">' +
      '<li>Sender is a <b>parent on a student record</b> → filed on that student (on each sibling) and the branch team is notified.</li>' +
      '<li>Sender is a <b>lead’s e-mail</b> → filed on the newest open lead and its counsellor is notified.</li>' +
      '<li><b>Unknown sender</b> → held for review, a new lead is created, or ignored (rule above).</li>' +
      '<li>Blocked senders, auto-replies and bounce messages are skipped. The same e-mail is never filed twice.</li></ol>';
    var sim = '<form data-submit="mailSim" novalidate><div class="fgrid">' +
      F('From (e-mail)', 'from', { req: 1, ph: 'parent@example.com', id: 'ms_from' }) + F('Sender name', 'fromName', { ph: 'optional', id: 'ms_name' }) +
      F('Subject', 'subject', { v: 'Question about the next class', full: 1, id: 'ms_subject' }) +
      F('Message', 'text', { t: 'textarea', rows: 3, v: 'Hello, can you tell me when the next class starts?', full: 1, id: 'ms_text' }) +
      '</div><div class="row" style="margin-top:12px"><button class="btn primary" type="submit">Run simulation</button><span class="muted xs">Uses the saved rules. Use a parent’s address to see it land on their record; leads created here are test records (TST-…).</span></div></form>';
    var rows = (MAIL.inbox || []);
    var tone = function (s) { return /^Matched|^New lead/.test(s) ? 'ok' : /review/.test(s) ? 'warn' : ''; };
    var link = function (i) {
      if (!i.ref) return '<span class="faint">—</span>';
      return i.ref.split(', ').map(function (id) { return '<a class="link" tabindex="0" data-act="go" data-page="' + (i.refType === 'student' ? 'student' : 'lead') + '" data-id="' + esc(id) + '">' + esc(id) + '</a>'; }).join(', ');
    };
    var inbox = !ready ? emptyBox(MAIL.error ? 'Could not load' : 'Loading…', MAIL.error || '') : rows.length ? table('mailin', [
      { h: 'Received', f: function (i) { return fDT(i.at || i.receivedAt) + (i.sim ? '<div class="muted xs">Simulation</div>' : ''); }, s: function (i) { return i.at || i.receivedAt; } },
      { h: 'From', f: function (i) { return (i.fromName ? esc(i.fromName) + '<div class="muted xs">' + esc(i.from) + '</div>' : esc(i.from)); } },
      { h: 'Subject', f: function (i) { return '<b class="sm">' + esc(i.subject) + '</b><div class="muted xs">' + esc((i.snippet || '').slice(0, 90)) + '</div>'; } },
      { h: 'Result', f: function (i) { return bdg(i.status, tone(i.status)); } },
      { h: 'Filed on', f: link },
    ], rows, { ps: 10 }) : emptyBox('No e-mails yet', 'Received e-mails and simulations appear here.');
    return conn + card('Filing rules', edit ? form : mailKV([['Import', r.on ? 'On' : 'Off'], ['Mailbox', esc(r.mailbox || '—')], ['Unknown sender', esc(r.unknown || 'review')]])) +
      '<div style="height:14px"></div><div class="grid g2" style="align-items:start">' + card('How e-mails are filed', how) + (edit ? card('Simulate an incoming e-mail', sim) : '') + '</div>' +
      '<div style="height:14px"></div>' + card('Recent incoming e-mails', inbox, { np: rows.length ? 1 : 0, act: '<button class="btn sm ghost" data-act="mailRefresh">Refresh</button>' });
  };
  SUB.cfg_mailIn = function (d, f) {
    clearErrs(f);
    if (d.mailbox && !MAIL_RE.test(d.mailbox.trim())) { setErr(f, 'mailbox', 'Enter a valid e-mail address'); return; }
    if (d.unknown === 'lead') {
      if (!d.branch) { setErr(f, 'branch', 'Choose a branch'); return; }
      var b = (S.branches || []).find(function (x) { return x.id === d.branch; });
      if (!d.prog || !b || (b.programs || []).indexOf(d.prog) < 0) { setErr(f, 'prog', 'Choose a programme offered at this branch'); return; }
    }
    var block = String(d.block || '').split(/[\n,;]+/).map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean);
    var bad = block.find(function (x) { return !MAIL_RE.test(x) && !/^@?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(x); });
    if (bad) { setErr(f, 'block', '"' + bad + '" is not an e-mail address or domain'); return; }
    S.cfg.mailIn = { on: !!d.on, mailbox: (d.mailbox || '').trim().toLowerCase(), unknown: d.unknown || 'review', branch: d.branch || '', prog: d.prog || '', block: block, notify: !!d.notify };
    cfgSave('Email Incoming', (d.on ? 'Import on' : 'Import off') + ' · unknown senders: ' + S.cfg.mailIn.unknown);
  };
  SUB.mailSim = function (d, f) {
    clearErrs(f);
    if (!MAIL_RE.test(String(d.from || '').trim())) { setErr(f, 'from', 'Enter the sender’s e-mail address'); return; }
    flush().then(function () { return req('POST', '/mail/inbound/simulate', { from: d.from.trim(), fromName: d.fromName || '', subject: d.subject || '', text: d.text || '' }); })
      .then(function (r) {
        toast('Simulation: ' + r.status + (r.ref ? ' – ' + r.ref : ''), /^Matched|^New lead/.test(r.status) ? 'ok' : 'warn');
        MAIL.inbox = null; MAIL.status = null; mailLoad(); return reload(false);
      })
      .catch(function (e) { toast(e.message, 'err'); });
  };

  // ------------------------------------------------------------------ go
  var _closeModal = window.closeModal;
  window.closeModal = function () { _closeModal(); if (deferredRender) { deferredRender = false; render(); } };
  req('GET', '/auth/me').then(function (r) { afterAuth(r.stage); }).catch(function () { loginScreen(); });
})();
