/* ============================================================
   ACC LMS — Core Engine  v7.0.0
   API Client | Auth | I18n | Theme | PWA | Photos | Charts
   Arabian Cement Company — Lubrication Management System
   Phase 7 — Security Hardening + Performance + Photo Viewer
   ============================================================

   Phase 7 Changes from v5.0.0:
     P-007  Consolidated single delta sync poll (was 5 separate polls)
     P-008  LocalCache invalidation on all write operations
     P-009  Pagination event delegation (removes inline onclick — CSP safe)
     P-010  NotifBell document.hidden guard (battery/data saving)
     F-05   AbortController 15s timeout + 2-retry exponential backoff
     SEC-006 CSRF token header on all POST requests
     SEC-004 token transport (body-based — see API._req for details)
     PHOTO   PhotoViewer lightbox module (view, navigate, admin delete)
     OFFLINE OfflineQueue — Background Sync for offline write queue
     P-012   GlobalSearch client-side prefix cache
============================================================ */

'use strict';

// ── Configuration ────────────────────────────────────────────
const CONFIG = {
  APP_VERSION:        '7.0.0',
  API_URL_KEY:        'lms_api_url',
  API_URL:             'https://script.google.com/macros/s/AKfycbx5-6aMcjadrqtn-4wND3j9HUtFSFzdepDv_Q59CrJqGkbrAJzVgo7qWXRCBDuUcqE/exec',
  SESSION_KEY:        'lms_session',
  LANG_KEY:           'lms_lang',
  THEME_KEY:          'lms_theme',
  SIDEBAR_KEY:        'lms_sidebar_collapsed',
  CSRF_KEY:           'lms_csrf_token',
  SYNC_INTERVAL:      30000,
  TOAST_DURATION:     4000,
  CACHE_TTL:          300,
  DEBOUNCE_SEARCH:    350,
  MAX_PHOTOS:         3,
  MAX_PHOTO_SIZE_MB:  5,
  ALLOWED_PHOTO_TYPES:['image/jpeg','image/png','image/webp'],
  API_TIMEOUT_MS:     15000,   // F-05: 15-second AbortController timeout
  API_MAX_RETRIES:    2,       // F-05: 2 retries with exponential backoff
  API_RETRY_BASE_MS:  1000,    // F-05: Base backoff (doubles each retry)
};

// ── Event Bus ────────────────────────────────────────────────
const EventBus = {
  _l: {},
  on(ev, fn) {
    if (!this._l[ev]) this._l[ev] = [];
    this._l[ev].push(fn);
    return () => this.off(ev, fn);
  },
  off(ev, fn) { this._l[ev] = (this._l[ev]||[]).filter(l => l !== fn); },
  emit(ev, d) { (this._l[ev]||[]).forEach(fn => fn(d)); },
};

// ── Store (localStorage wrapper) ─────────────────────────────
const Store = {
  get(k, fb = null) {
    try { const v = localStorage.getItem(k); return v === null ? fb : JSON.parse(v); }
    catch { return fb; }
  },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  remove(k) { try { localStorage.removeItem(k); } catch {} },
  clear() {
    Object.keys(localStorage).filter(k => k.startsWith('lms_'))
      .forEach(k => { try { localStorage.removeItem(k); } catch {} });
  },
};

// ── Local Cache (TTL) ─────────────────────────────────────────
const LocalCache = {
  set(key, data, ttl = CONFIG.CACHE_TTL) {
    Store.set(`lms_cache_${key}`, { data, expiresAt: Date.now() + ttl * 1000 });
  },
  get(key) {
    const c = Store.get(`lms_cache_${key}`);
    if (!c) return null;
    if (Date.now() > c.expiresAt) { Store.remove(`lms_cache_${key}`); return null; }
    return c.data;
  },
  clear(key) {
    if (key) { Store.remove(`lms_cache_${key}`); return; }
    Object.keys(localStorage).filter(k => k.startsWith('lms_cache_'))
      .forEach(k => { try { localStorage.removeItem(k); } catch {} });
  },
  // P-008: Invalidate keys matching a pattern prefix
  invalidate(prefix) {
    Object.keys(localStorage)
      .filter(k => k.startsWith(`lms_cache_${prefix}`))
      .forEach(k => { try { localStorage.removeItem(k); } catch {} });
  },
};

// ── API Client ───────────────────────────────────────────────
const API = {
  _baseUrl: '',
  setUrl(url) { this._baseUrl = url; },
  _token() { return Store.get(CONFIG.SESSION_KEY)?.token || null; },

  /* F-05: AbortController timeout + retry with exponential backoff
     SEC-004 / SEC-006 — PRODUCTION FIX: Google Apps Script Web Apps cannot
     read custom request headers in doPost(e) — there is no e.headers,
     only e.postData and e.parameter. Token and CSRF token are therefore
     sent inside the JSON body instead, matching the deployed backend's
     routeRequest() (reads params.token || data.token) and routePhase7()
     (reads params.csrfToken || data.csrfToken).

     CORS FIX: Apps Script Web Apps cannot respond to OPTIONS preflight
     requests (no doOptions handler is possible, and Access-Control-Allow-
     Origin cannot be set). Content-Type 'application/json' is NOT a CORS
     "simple request" header and triggers a preflight that always fails.
     Using 'text/plain' avoids the preflight entirely — doPost() still
     parses the raw body as JSON via JSON.parse(e.postData.contents)
     regardless of the declared Content-Type, so this is safe. */
  async _req(method, action, payload = {}, retryCount = 0) {
    if (!this._baseUrl) return { success:false, error:'API URL not configured' };

    const token = this._token();
    const csrf  = Store.get(CONFIG.CSRF_KEY, null);
    const headers = { 'Content-Type':'text/plain;charset=utf-8' };

    const body = { action, method, ...payload };
    body.data = { ...(body.data || {}) };
    if (token) body.data.token = token;
    if (method === 'POST' && csrf) body.data.csrfToken = csrf;

    // F-05: AbortController timeout
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), CONFIG.API_TIMEOUT_MS);

    try {
      const res = await fetch(this._baseUrl, {
        method:  'POST',
        headers,
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // F-05: Retry on 5xx server errors
        if (res.status >= 500 && retryCount < CONFIG.API_MAX_RETRIES) {
          const backoff = CONFIG.API_RETRY_BASE_MS * Math.pow(2, retryCount);
          await new Promise(r => setTimeout(r, backoff));
          return this._req(method, action, payload, retryCount + 1);
        }
        return { success:false, error:`HTTP ${res.status}`, raw: text };
      }
      return res.json();

    } catch(err) {
      clearTimeout(timeoutId);

      // Offline detection
      if (!navigator.onLine) {
        EventBus.emit('app:offline');
        // Attempt to queue the request for Background Sync
        if (method === 'POST') OfflineQueue.enqueue({ action, payload });
        return { success:false, error:'offline', offline:true };
      }

      // F-05: Retry on network errors (AbortError = timeout)
      if (retryCount < CONFIG.API_MAX_RETRIES) {
        const backoff = CONFIG.API_RETRY_BASE_MS * Math.pow(2, retryCount);
        await new Promise(r => setTimeout(r, backoff));
        return this._req(method, action, payload, retryCount + 1);
      }

      return { success:false, error: err.name === 'AbortError' ? 'Request timed out (15s)' : err.message };
    }
  },

  get(action, params = {}) { return this._req('GET', action, { params }); },

  // P-008: post() clears relevant cache keys after successful mutation
  async post(action, data = {}) {
    const res = await this._req('POST', action, { data });
    if (res.success) {
      // Invalidate caches related to the entity being mutated
      const prefix = action.split('.')[0]; // e.g. 'history', 'points', 'notifications'
      LocalCache.invalidate(prefix);
    }
    return res;
  },

  // ── Auth ──────────────────────────────────────────────────
  login(no, pw)            { return this._req('POST','auth.login',{ data:{employeeNo:no,password:pw} }); },
  logout()                 { return this.post('auth.logout',{}); },
  changePassword(old, nw)  { return this.post('users.change_password',{oldPassword:old,newPassword:nw}); },

  // ── P-007: Consolidated delta sync (single call, multiple tabs) ──
  /** Single multi-tab sync call replacing 5 separate polls */
  deltaSync(tabs, lastSyncAt) {
    return this.get('sync.delta', { tabs: Array.isArray(tabs) ? tabs.join(',') : tabs, lastSyncAt });
  },

  // ── Points ────────────────────────────────────────────────
  getPoints(p={})          { return this.get('points.list',p); },
  getPoint(id)             { return this.get('points.get',{pointId:id}); },
  createPoint(d)           { return this.post('points.create',d); },
  updatePoint(id,d)        { return this.post('points.update',{pointId:id,...d}); },
  recalculatePoint(id)     { return this.post('points.recalculate',{pointId:id}); },

  // ── History ───────────────────────────────────────────────
  getHistory(p={})         { return this.get('history.list',p); },
  getHistoryRecord(id)     { return this.get('history.get',{historyId:id}); },
  submitOilChange(d)       { return this.post('workflow.submit_oil_change',d); },
  approveRecord(id,notes)  { return this.post('workflow.approve',{historyId:id,notes}); },
  rejectRecord(id,reason)  { return this.post('workflow.reject',{historyId:id,reason}); },
  recallRecord(id)         { return this.post('workflow.recall',{historyId:id}); },
  restoreRecord(id,reason) { return this.post('workflow.restore',{historyId:id,reason}); },
  submitCorrection(id,d)   { return this.post('workflow.correct',{historyId:id,...d}); },
  approveCorrection(id)    { return this.post('corrections.approve',{correctionId:id}); },
  rejectCorrection(id,r)   { return this.post('corrections.reject',{correctionId:id,reason:r}); },

  // ── Oil Analysis ──────────────────────────────────────────
  getAnalysis(p={})               { return this.get('analysis.list',p); },
  submitAnalysis(d)               { return this.post('workflow.submit_oil_analysis',d); },
  approveAnalysis(id,d)           { return this.post('workflow.approve_analysis',{analysisId:id,...d}); },
  rejectAnalysis(id,r)            { return this.post('workflow.reject_analysis',{analysisId:id,reason:r}); },
  setNextSampleDate(id,dt)        { return this.post('analysis.set_next_date',{analysisId:id,nextDate:dt}); },

  // ── Notifications ─────────────────────────────────────────
  getNotifications(unreadOnly=false){ return this.get('notifications.list',{unreadOnly}); },
  markNotificationRead(id)         { return this.post('notifications.mark_read',{notifId:id}); },
  markAllRead()                    { return this.post('notifications.mark_all_read',{}); },

  // ── Reports ───────────────────────────────────────────────
  getKPI()               { return this.get('reports.kpi',{}); },
  getOverdueReport(p={}) { return this.get('reports.overdue',p); },
  getComplianceReport(p={}){ return this.get('reports.compliance',p); },
  getTrendsReport(p={})  { return this.get('reports.trends',p); },
  getAuditLog(p={})      { return this.get('audit.list',p); },

  // ── Workflow ──────────────────────────────────────────────
  getPendingQueue() { return this.get('workflow.pending',{}); },

  // ── Users ─────────────────────────────────────────────────
  getUsers()           { return this.get('users.list',{}); },
  createUser(d)        { return this.post('users.create',d); },
  updateUser(id,d)     { return this.post('users.update',{userId:id,...d}); },
  resetPassword(id)    { return this.post('users.reset_password',{userId:id}); },
  deactivateUser(id)   { return this.post('users.deactivate',{userId:id}); },

  // ── System ────────────────────────────────────────────────
  getConfig()            { return this.get('system.config',{}); },
  updateConfig(k,v)      { return this.post('system.config.update',{key:k,value:v}); },
  systemPing()           { return this.get('system.ping',{}); },
  systemVersion()        { return this.get('system.version',{}); },

  // ── Master data ───────────────────────────────────────────
  getAreas()            { return this.get('areas.list',{}); },
  getLocations(areaId)  { return this.get('locations.list',{areaId}); },
  getLubricants()       { return this.get('lubricants.list',{}); },
  getFrequencyCodes()   { return this.get('frequency.list',{}); },
  getAssets(p={})       { return this.get('assets.list',p); },

  // ── Search ────────────────────────────────────────────────
  search(q) { return this.get('search.global',{q}); },

  // ── Phase 7 — Photos (Google Drive) ──────────────────────
  uploadPhoto(historyId, base64Data, mimeType, fileName) {
    return this.post('files.upload_photo',{historyId,base64Data,mimeType,fileName});
  },
  getPhotos(historyId)  { return this.get('files.get_photos',{historyId}); },
  deletePhoto(fileId, historyId) { return this.post('files.delete_photo',{fileId,historyId}); },
};

// ── Auth ──────────────────────────────────────────────────────
const Auth = {
  _s: null,
  init()       { this._s = Store.get(CONFIG.SESSION_KEY); },
  isLoggedIn() {
    return this._s?.expiresAt && new Date(this._s.expiresAt) > new Date();
  },
  getUser()  { return this._s?.user || null; },
  getToken() { return this._s?.token || null; },
  getRole()  { return this._s?.user?.Role || null; },
  hasRole(...roles) { return roles.includes(this.getRole()); },
  can(action, isOwn=false) { return PermissionClient.can(this.getRole(), action, isOwn); },

  async login(employeeNo, password) {
    const res = await API.login(employeeNo, password);
    if (res.success && res.data?.token) {
      this._s = res.data;
      Store.set(CONFIG.SESSION_KEY, this._s);
      // SEC-006: Backend does not issue a separate CSRF token — the
      // deployed routePhase7()._validateCSRFToken() checks csrfToken
      // === sessionToken, so the session token itself is reused here.
      Store.set(CONFIG.CSRF_KEY, res.data.token);
      EventBus.emit('auth:login', this._s.user);
      return { success:true, firstLogin: res.data.user?.ForcePasswordChange };
    }
    return { success:false, error: res.error || 'Login failed' };
  },

  async logout() {
    try { await API.logout(); } catch {}
    this._s = null;
    Store.remove(CONFIG.SESSION_KEY);
    Store.remove(CONFIG.CSRF_KEY);
    LocalCache.clear();
    EventBus.emit('auth:logout');
    const d = window.location.pathname.split('/').filter(Boolean).length;
    window.location.href = d > 1 ? '../'.repeat(d - 1) + 'index.html' : 'index.html';
  },

  requireAuth() {
    if (!this.isLoggedIn()) {
      const d = window.location.pathname.split('/').filter(Boolean).length;
      window.location.href = d > 1 ? '../'.repeat(d - 1) + 'index.html' : 'index.html';
      return false;
    }
    return true;
  },
};

// ── Permission Client ─────────────────────────────────────────
const PermissionClient = {
  _m: {
    ADMIN:      { 'points.create':true,'points.update':true,'points.deactivate':true,
                  'history.create':true,'history.approve':true,'history.reject':true,
                  'history.recall':true,'history.restore':true,'history.correct':true,
                  'analysis.create':true,'analysis.approve':true,'analysis.reject':true,
                  'analysis.set_next_date':true,'corrections.approve':true,'corrections.reject':true,
                  'users.create':true,'users.update':true,'users.deactivate':true,
                  'users.reset_password':true,'system.config':true,'reports.view':true,
                  'files.upload':true,'files.delete':true },
    SUPERVISOR: { 'points.create':true,'points.update':true,
                  'history.create':true,'history.approve':true,'history.reject':true,
                  'history.recall':'own','history.correct':true,
                  'analysis.create':true,'analysis.approve':true,'analysis.reject':true,
                  'analysis.set_next_date':true,'users.update':'own',
                  'reports.view':true,'files.upload':true },
    TECHNICIAN: { 'history.create':true,'history.recall':'own',
                  'analysis.create':true,'users.update':'own','files.upload':true },
    VIEWER:     { 'reports.view':true },
  },
  can(role, action, isOwn=false) {
    if (!role) return false;
    const p = this._m[role]?.[action];
    if (!p) return false;
    if (p === true) return true;
    if (p === 'own') return isOwn;
    return false;
  },
};

// ── I18n ──────────────────────────────────────────────────────
const I18n = {
  _s: {},
  _lang: 'en',

  async init() {
    this._lang = Store.get(CONFIG.LANG_KEY, 'en');
    await this._load(this._lang);
    this._applyDir();
  },

  async _load(lang) {
    try {
      // FIX: URL-path depth counting breaks under subpath hosting (e.g.
      // GitHub Pages project sites at /repo-name/...) because the repo
      // name itself gets miscounted as a folder depth level. Instead,
      // derive the i18n folder location directly from where core.js
      // itself was loaded from — reliable regardless of hosting depth.
      // (document.currentScript is null here since this runs async,
      // long after core.js's own synchronous execution finished, so
      // we look it up from the live document.scripts list instead.)
      const coreScript = Array.from(document.scripts).find(s => s.src.includes('core.js'));
      const jsDir = coreScript ? coreScript.src.replace(/core\.js(\?.*)?$/, '') : 'js/';
      const r = await fetch(`${jsDir}i18n/${lang}.json`);
      this._s = await r.json();
    } catch(e) { console.warn('i18n load failed:', lang); this._s = {}; }
  },

  async setLang(lang) {
    this._lang = lang;
    Store.set(CONFIG.LANG_KEY, lang);
    await this._load(lang);
    this._applyDir();
    this._rerender();
    EventBus.emit('lang:changed', { lang });
  },

  getLang() { return this._lang; },

  t(key, vars={}) {
    const has = Object.prototype.hasOwnProperty.call(this._s, key);

    // FIX: several pages call I18n.t(key, 'Some fallback text') expecting
    // the second argument to be used when the key is missing — e.g.
    // I18n.t('common.records', 'records'), I18n.t('photo.viewer_title')
    // || 'Photos'. The original implementation only ever treated the
    // second argument as a {vars} object for {placeholder} interpolation,
    // so Object.entries() on a plain string silently did nothing and the
    // function fell back to returning the raw, untranslated key itself
    // (e.g. literally the text "history.pageTitle") whenever a key was
    // missing from en.json/ar.json. That is the direct cause of raw
    // translation keys appearing in the UI. Now: a string second
    // argument is used as the fallback display text; an object second
    // argument is still used for {name}-style interpolation as before.
    // If a key is missing and no fallback was given, we humanize the key
    // (last segment, separators -> spaces, capitalized) instead of ever
    // showing the raw dotted key — and log it so missing keys are easy
    // to spot in the console instead of silently leaking into the UI.
    let varsObj = {};
    let fallback = null;
    if (typeof vars === 'string') {
      fallback = vars;
    } else if (vars && typeof vars === 'object') {
      varsObj = vars;
    }

    let str;
    if (has) {
      str = this._s[key];
    } else {
      if (!this._warnedKeys) this._warnedKeys = new Set();
      if (!this._warnedKeys.has(key)) {
        this._warnedKeys.add(key);
        console.warn('[i18n] missing translation key:', key);
      }
      str = fallback !== null ? fallback : this._humanizeKey(key);
    }

    Object.entries(varsObj).forEach(([k,v]) => { str = str.replace(`{${k}}`, v); });
    return str;
  },

  // Turns 'history.pageTitle' into 'Page Title' as a last-resort display
  // fallback — never shows the raw dotted/camelCase key to the user.
  _humanizeKey(key) {
    const last = key.split('.').pop() || key;
    const spaced = last.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return spaced.replace(/\b\w/g, c => c.toUpperCase());
  },

  _applyDir() {
    const dir = this._lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.setAttribute('dir', dir);
    document.documentElement.setAttribute('lang', this._lang);
    if (document.body) {
      document.body.setAttribute('dir', dir);
      document.body.style.fontFamily = this._lang === 'ar'
        ? 'var(--font-arabic)' : 'var(--font-sans)';
    }
  },

  _rerender() {
    this._applyDir();
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = this.t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = this.t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = this.t(el.dataset.i18nTitle);
    });
  },

  formatDate(d, opts) {
    if (!d) return '—';
    try {
      const loc = this._lang === 'ar' ? 'ar-EG' : 'en-GB';
      return new Date(d).toLocaleDateString(loc, opts || {year:'numeric',month:'short',day:'numeric'});
    } catch { return d; }
  },

  formatDatetime(d) {
    if (!d) return '—';
    try {
      const loc = this._lang === 'ar' ? 'ar-EG' : 'en-GB';
      return new Date(d).toLocaleString(loc, {year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    } catch { return d; }
  },

  timeAgo(d) {
    if (!d) return '—';
    try {
      const diff = Date.now() - new Date(d).getTime();
      const mins = Math.floor(diff/60000), hrs = Math.floor(mins/60), days = Math.floor(hrs/24);
      const ar = this._lang === 'ar';
      if (mins < 1)   return ar ? 'الآن' : 'Just now';
      if (mins < 60)  return ar ? `منذ ${mins} دقيقة` : `${mins}m ago`;
      if (hrs < 24)   return ar ? `منذ ${hrs} ساعة` : `${hrs}h ago`;
      if (days < 7)   return ar ? `منذ ${days} يوم` : `${days}d ago`;
      return this.formatDate(d);
    } catch { return d; }
  },
};

// ── Theme ─────────────────────────────────────────────────────
const Theme = {
  _cur: 'auto',
  _mq: null,
  init() {
    this._cur = Store.get(CONFIG.THEME_KEY, 'auto');
    this._mq  = window.matchMedia('(prefers-color-scheme: dark)');
    this._apply();
    this._mq.addEventListener('change', () => { if (this._cur === 'auto') this._apply(); });
  },
  set(t) { this._cur = t; Store.set(CONFIG.THEME_KEY, t); this._apply(); EventBus.emit('theme:changed',{theme:t}); },
  get()  { return this._cur; },
  _apply() {
    const dark = this._cur === 'dark' || (this._cur === 'auto' && this._mq?.matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#141D42' : '#1E2B5E');
  },
};

// ── Toast ─────────────────────────────────────────────────────
const Toast = {
  _c: null,
  init() {
    let c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container'; c.className = 'toast-container';
      c.setAttribute('role','status'); c.setAttribute('aria-live','polite');
      document.body.appendChild(c);
    }
    this._c = c;
  },
  _show(msg, type, dur=CONFIG.TOAST_DURATION) {
    if (!this._c) this.init();
    const icons = {success:'✅',error:'❌',warning:'⚠️',info:'ℹ️'};
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.setAttribute('role','alert');
    t.innerHTML = `<span class="toast-icon" aria-hidden="true">${icons[type]||'ℹ️'}</span>
      <span class="toast-message">${msg}</span>
      <button class="toast-close" aria-label="Dismiss">✕</button>`;
    t.querySelector('.toast-close').onclick = () => t.remove();
    this._c.appendChild(t);
    requestAnimationFrame(() => t.classList.add('toast-visible'));
    setTimeout(() => { t.style.animation='toast-out 0.3s ease forwards'; setTimeout(()=>t.remove(),300); }, dur);
  },
  success(m,d){ this._show(m,'success',d); },
  error(m,d)  { this._show(m,'error',d||6000); },
  warning(m,d){ this._show(m,'warning',d); },
  info(m,d)   { this._show(m,'info',d); },
};

// ── Modal ─────────────────────────────────────────────────────
const Modal = {
  _m: {}, _n: 0,
  create({ title='', body='', footer, size='md', onClose }={}) {
    const id = `modal-${++this._n}`;
    const el = document.createElement('div');
    el.className = 'modal-overlay'; el.id = id;
    el.setAttribute('role','dialog'); el.setAttribute('aria-modal','true');
    el.setAttribute('aria-labelledby',`${id}-title`);
    el.innerHTML = `
      <div class="modal modal-${size}">
        <div class="modal-header">
          <h3 class="modal-title" id="${id}-title">${title}</h3>
          <button class="modal-close-btn" data-modal-close="${id}" aria-label="Close dialog">✕</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
      </div>`;
    // P-009: Use event delegation instead of inline onclick
    el.addEventListener('click', e => {
      if (e.target === el) this.close(id);
      const closeBtn = e.target.closest('[data-modal-close]');
      if (closeBtn) this.close(closeBtn.dataset.modalClose);
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key==='Escape') { Modal.close(id); document.removeEventListener('keydown',esc); }
    });
    document.body.appendChild(el);
    this._m[id] = { el, onClose };
    requestAnimationFrame(() => el.classList.add('modal-visible'));
    document.body.style.overflow = 'hidden';
    setTimeout(() => el.querySelector('input,button,select,textarea')?.focus(), 80);
    return id;
  },
  close(id) {
    const m = this._m[id]; if (!m) return;
    m.el.classList.remove('modal-visible');
    setTimeout(() => { m.el.remove(); delete this._m[id];
      if (!Object.keys(this._m).length) document.body.style.overflow = ''; }, 200);
    m.onClose?.();
  },
  closeAll() { Object.keys(this._m).forEach(id => this.close(id)); },
  // Helper: update body of existing modal
  updateBody(id, html) {
    const m = this._m[id]; if (!m) return;
    const body = m.el.querySelector('.modal-body');
    if (body) body.innerHTML = html;
  },
};

// ── DOM Helpers ───────────────────────────────────────────────
const DOM = {
  emptyState(msg, icon='📭', sub='') {
    return `<div class="empty-state">
      <div class="empty-icon" aria-hidden="true">${icon}</div>
      <div class="empty-message">${msg}</div>
      ${sub ? `<div class="empty-sub">${sub}</div>` : ''}
    </div>`;
  },
  loadingRows(n=5) {
    return Array.from({length:n}, () =>
      `<tr><td colspan="99"><div class="skeleton" style="height:18px;width:100%;border-radius:4px;"></div></td></tr>`
    ).join('');
  },
  skeletonCards(n=3) {
    return Array.from({length:n}, () =>
      `<div class="stat-card"><div class="skeleton" style="height:80px;width:100%;"></div></div>`
    ).join('');
  },
};

// ── Format Helpers ────────────────────────────────────────────
const Format = {
  number(v) {
    if (v===null||v===undefined||v==='—') return '—';
    const n = Number(v); return isNaN(n) ? String(v) : n.toLocaleString();
  },
  statusBadge(s) {
    const m = {PENDING:{c:'pending'},APPROVED:{c:'approved'},REJECTED:{c:'rejected'},
                RECALLED:{c:'recalled'},CORRECTED:{c:'corrected'}};
    const cfg = m[s] || {c:'info'};
    return `<span class="badge badge-${cfg.c}">${I18n.t(`status.${(s||'').toLowerCase()}`) || s}</span>`;
  },
  criticalityBadge(cr) {
    const m = {CRITICAL:'critical',HIGH:'high',MEDIUM:'medium',LOW:'low'};
    return `<span class="badge badge-${m[cr]||'info'}">${I18n.t(`criticality.${(cr||'').toLowerCase()}`) || cr}</span>`;
  },
  roleBadge(role) {
    const m = {ADMIN:'navy',SUPERVISOR:'purple',TECHNICIAN:'blue',VIEWER:'gray'};
    return `<span class="badge badge-${m[role]||'info'}">${I18n.t(`role.${(role||'').toLowerCase()}`) || role}</span>`;
  },
  initials(name='') {
    return (name||'').split(' ').map(w=>w[0]).join('').toUpperCase().substring(0,2) || '?';
  },
  overdueClass(days) {
    if (!days || days<=0) return 'low';
    if (days<=7)  return 'medium';
    if (days<=30) return 'high';
    return 'critical';
  },
  frequency(code) {
    const m = {'2 Y':'2 Years','3 Y':'3 Years','5 Y':'5 Years','1 Y':'1 Year',
               '0.5 Y':'6 Months','1.5 Y':'18 Months','4 Y':'4 Years',
               'Oil Analysis':'Oil Analysis','As needed':'As Needed'};
    return m[code] || code || '—';
  },
};

// ── Sync Manager — P-007: Consolidated single multi-tab poll ──
const SyncManager = {
  _timer: null,
  _last:  null,
  _tabs:  [],
  _online: navigator.onLine,

  // P-007: Single consolidated call for all tabs
  startBackground(tabs=[]) {
    this._tabs = tabs;
    const ms = Store.get('lms_sync_interval', CONFIG.SYNC_INTERVAL/1000) * 1000;
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      // P-010: Don't poll when tab is hidden (handled in NotifBell too)
      if (!this._online || document.hidden) return;
      this._syncAll();
    }, ms);
  },

  // P-007: One API call for all dirty tabs
  async _syncAll() {
    if (!this._tabs.length) return;
    const res = await API.deltaSync(this._tabs, this._last);
    if (res.success && res.data) {
      this._last = new Date().toISOString();
      // Emit per-tab events from consolidated response
      const tabData = res.data;
      Object.keys(tabData).forEach(tab => {
        if (tabData[tab]) {
          // P-008: Invalidate relevant caches on delta update
          LocalCache.invalidate(tab.toLowerCase());
          EventBus.emit(`sync:${tab.toLowerCase()}`, tabData[tab]);
        }
      });
    }
  },

  stop() { clearInterval(this._timer); this._timer = null; },

  setOnline(online) {
    this._online = online;
    EventBus.emit(online ? 'app:online' : 'app:offline');
    if (online) this._syncAll();
  },
};

// ── Photo Manager ─────────────────────────────────────────────
const PhotoManager = {
  async preparePhoto(file) {
    if (!CONFIG.ALLOWED_PHOTO_TYPES.includes(file.type))
      return { valid:false, error:'Invalid file type. Use JPEG, PNG, or WebP.' };
    if (file.size > CONFIG.MAX_PHOTO_SIZE_MB * 1024 * 1024)
      return { valid:false, error:`File too large. Max ${CONFIG.MAX_PHOTO_SIZE_MB}MB.` };
    const base64 = await new Promise((res,rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result); r.onerror = rej;
      r.readAsDataURL(file);
    });
    return { valid:true, base64: base64.split(',')[1], mimeType:file.type, fileName:file.name, previewUrl:base64 };
  },

  async upload(historyId, file) {
    const p = await this.preparePhoto(file);
    if (!p.valid) return { success:false, error:p.error };
    return API.uploadPhoto(historyId, p.base64, p.mimeType, p.fileName);
  },

  buildPickerUI(containerId, maxPhotos=CONFIG.MAX_PHOTOS) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    let files = [];

    container.innerHTML = `
      <div class="photo-picker">
        <div class="photo-picker-slots" id="${containerId}-slots"></div>
        <label class="photo-add-btn" id="${containerId}-add">
          <input type="file" id="${containerId}-input" accept="image/jpeg,image/png,image/webp"
            style="display:none;" aria-label="Add photo">
          <span aria-hidden="true">📷</span>
          <span>Add Photo</span>
          <span class="photo-count" id="${containerId}-count">0 / ${maxPhotos}</span>
        </label>
        <div class="form-error" id="${containerId}-err" style="display:none;"></div>
      </div>`;

    const input   = document.getElementById(`${containerId}-input`);
    const slots   = document.getElementById(`${containerId}-slots`);
    const errEl   = document.getElementById(`${containerId}-err`);
    const countEl = document.getElementById(`${containerId}-count`);
    const addBtn  = document.getElementById(`${containerId}-add`);

    input.addEventListener('change', async e => {
      for (const f of Array.from(e.target.files)) {
        if (files.length >= maxPhotos) {
          errEl.textContent = `Max ${maxPhotos} photos allowed.`;
          errEl.style.display = 'block'; break;
        }
        const p = await this.preparePhoto(f);
        if (!p.valid) { errEl.textContent = p.error; errEl.style.display='block'; continue; }
        errEl.style.display = 'none';
        files.push({ file:f, prepared:p });
        const slot = document.createElement('div');
        slot.className='photo-slot';
        slot.style.cssText='position:relative;width:80px;height:80px;border-radius:8px;overflow:hidden;border:1px solid var(--color-border);flex-shrink:0;';
        slot.innerHTML=`<img src="${p.previewUrl}" style="width:100%;height:100%;object-fit:cover;" alt="Photo ${files.length}">
          <button type="button" data-slot-remove="true" style="position:absolute;top:3px;right:3px;width:20px;height:20px;background:rgba(0,0,0,0.6);color:#fff;border:none;border-radius:50%;font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center;" aria-label="Remove photo">✕</button>`;
        // P-009: Event delegation instead of direct onclick
        slot._fileRef = f;
        slots.appendChild(slot);
        countEl.textContent = `${files.length} / ${maxPhotos}`;
        addBtn.style.display = files.length >= maxPhotos ? 'none' : 'flex';
      }
      input.value = '';
    });

    // P-009: Delegate remove button clicks
    slots.addEventListener('click', e => {
      if (!e.target.dataset.slotRemove) return;
      const slot = e.target.closest('.photo-slot');
      if (!slot) return;
      files = files.filter(f => f.file !== slot._fileRef);
      slot.remove();
      countEl.textContent = `${files.length} / ${maxPhotos}`;
      addBtn.style.display = files.length >= maxPhotos ? 'none' : 'flex';
    });

    container._getFiles = () => files;
    return container;
  },
};

// ── Photo Viewer (Phase 7 — Lightbox) ────────────────────────
const PhotoViewer = {
  _photos:  [],
  _current: 0,
  _modalId: null,
  _historyId: null,

  /**
   * Open the photo lightbox for a history record.
   * @param {string} historyId
   * @param {boolean} isAdmin — show delete button if true
   */
  async open(historyId, isAdmin = false) {
    this._historyId = historyId;
    this._current   = 0;

    // Show loading modal
    this._modalId = Modal.create({
      title: I18n.t('photo.viewer_title') || 'Photos',
      body: `<div style="text-align:center;padding:40px;"><div class="skeleton" style="width:100%;height:300px;border-radius:12px;"></div></div>`,
      size: 'lg',
    });

    const res = await API.getPhotos(historyId);
    if (!res.success || !res.data?.length) {
      Modal.updateBody(this._modalId,
        DOM.emptyState(I18n.t('photo.no_photos') || 'No photos attached to this record', '📷'));
      return;
    }

    this._photos = res.data;
    this._render(isAdmin);
  },

  _render(isAdmin) {
    if (!this._modalId) return;
    const photo   = this._photos[this._current];
    const total   = this._photos.length;
    const canPrev = this._current > 0;
    const canNext = this._current < total - 1;

    const body = `
      <div class="photo-lightbox" role="img" aria-label="Photo ${this._current+1} of ${total}">
        <div class="photo-lb-main">
          <button class="photo-lb-nav photo-lb-prev" data-lb-nav="prev"
            ${canPrev ? '' : 'disabled'} aria-label="Previous photo">‹</button>
          <div class="photo-lb-img-wrap">
            <img src="${photo.thumbnailUrl}" alt="${photo.fileName}"
              class="photo-lb-img" loading="lazy"
              onerror="this.src='${photo.url}'">
            <a href="${photo.url}" target="_blank" rel="noopener"
              class="photo-lb-fullscreen-btn" title="Open full size">⤢</a>
          </div>
          <button class="photo-lb-nav photo-lb-next" data-lb-nav="next"
            ${canNext ? '' : 'disabled'} aria-label="Next photo">›</button>
        </div>
        <div class="photo-lb-meta">
          <span>${this._current+1} / ${total}</span>
          <span class="photo-lb-filename">${photo.fileName}</span>
          <span>${I18n.formatDatetime ? I18n.formatDatetime(photo.createdAt) : photo.createdAt}</span>
        </div>
        ${total > 1 ? `<div class="photo-lb-strip" role="group" aria-label="Photo thumbnails">
          ${this._photos.map((p, i) => `
            <button data-lb-thumb="${i}" class="photo-lb-thumb ${i===this._current?'active':''}"
              aria-label="Photo ${i+1}" aria-pressed="${i===this._current}">
              <img src="${p.thumbnailUrl}" alt="Thumbnail ${i+1}" loading="lazy">
            </button>`).join('')}
        </div>` : ''}
        ${isAdmin ? `<div class="photo-lb-admin">
          <button class="btn btn-sm btn-danger" data-lb-delete="${photo.fileId}"
            aria-label="Delete this photo">🗑 ${I18n.t('btn.delete') || 'Delete Photo'}</button>
        </div>` : ''}
      </div>`;

    Modal.updateBody(this._modalId, body);

    // P-009: Event delegation on the modal
    const modalEl = document.getElementById(this._modalId);
    if (!modalEl) return;
    modalEl.addEventListener('click', async e => {
      const navBtn    = e.target.closest('[data-lb-nav]');
      const thumbBtn  = e.target.closest('[data-lb-thumb]');
      const deleteBtn = e.target.closest('[data-lb-delete]');

      if (navBtn) {
        const dir = navBtn.dataset.lbNav;
        if (dir === 'prev' && this._current > 0) { this._current--; this._render(isAdmin); }
        if (dir === 'next' && this._current < this._photos.length - 1) { this._current++; this._render(isAdmin); }
      }

      if (thumbBtn) {
        this._current = Number(thumbBtn.dataset.lbThumb);
        this._render(isAdmin);
      }

      if (deleteBtn) {
        const fileId = deleteBtn.dataset.lbDelete;
        if (!confirm(I18n.t('photo.confirm_delete') || 'Delete this photo? This cannot be undone.')) return;
        deleteBtn.disabled = true;
        deleteBtn.textContent = '…';
        const delRes = await API.deletePhoto(fileId, this._historyId);
        if (delRes.success) {
          Toast.success(I18n.t('photo.deleted') || 'Photo deleted');
          this._photos = this._photos.filter(p => p.fileId !== fileId);
          if (!this._photos.length) {
            Modal.updateBody(this._modalId, DOM.emptyState('All photos deleted', '📷'));
          } else {
            this._current = Math.min(this._current, this._photos.length - 1);
            this._render(isAdmin);
          }
        } else {
          Toast.error(delRes.error || 'Delete failed');
          deleteBtn.disabled = false;
          deleteBtn.textContent = `🗑 ${I18n.t('btn.delete') || 'Delete Photo'}`;
        }
      }
    }, { once: false });

    // Keyboard navigation
    const keyHandler = (e) => {
      if (!document.getElementById(this._modalId)) {
        document.removeEventListener('keydown', keyHandler);
        return;
      }
      if (e.key === 'ArrowLeft'  && this._current > 0) { this._current--; this._render(isAdmin); }
      if (e.key === 'ArrowRight' && this._current < this._photos.length - 1) { this._current++; this._render(isAdmin); }
    };
    document.addEventListener('keydown', keyHandler);
  },

  _formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
    return `${(bytes/1024/1024).toFixed(2)} MB`;
  },
};

// ── Offline Queue (Background Sync) ──────────────────────────
const OfflineQueue = {
  _KEY: 'lms_offline_queue',

  enqueue(request) {
    const queue = Store.get(this._KEY, []);
    queue.push({ ...request, queuedAt: new Date().toISOString(), id: Math.random().toString(36) });
    Store.set(this._KEY, queue);
    // Attempt Background Sync registration
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready.then(sw => {
        sw.sync.register('acc-lms-offline-sync').catch(e =>
          console.warn('[OfflineQueue] Background Sync registration failed:', e)
        );
      });
    }
    EventBus.emit('offline:queued', { count: queue.length });
  },

  getQueue() { return Store.get(this._KEY, []); },

  async flushQueue() {
    const queue = this.getQueue();
    if (!queue.length) return { flushed: 0, failed: 0 };
    const remaining = [];
    let flushed = 0, failed = 0;
    for (const item of queue) {
      try {
        const res = await API.post(item.action, item.payload?.data || {});
        if (res.success) { flushed++; } else { remaining.push(item); failed++; }
      } catch { remaining.push(item); failed++; }
    }
    Store.set(this._KEY, remaining);
    if (flushed > 0) {
      Toast.success(`${flushed} offline submission(s) synced`, 5000);
      EventBus.emit('offline:flushed', { flushed, failed });
    }
    return { flushed, failed };
  },

  count() { return this.getQueue().length; },

  clear() { Store.remove(this._KEY); },
};

// ── Charts (inline SVG, no external lib) ─────────────────────
const Charts = {
  // P-011: Use viewBox (responsive) instead of offsetWidth (forced reflow)
  bar(containerId, data, opts={}) {
    const el = document.getElementById(containerId);
    if (!el || !data?.length) return;
    const w = 420, h = opts.height || 220;
    const pad = { t:24, r:20, b:60, l:52 };
    const iW = w-pad.l-pad.r, iH = h-pad.t-pad.b;
    const max = Math.max(...data.map(d=>d.value), 1);
    const bW = iW/data.length*0.65, gap = iW/data.length*0.35;
    const COLORS = ['var(--color-brand-navy-mid)','var(--color-brand-green)','var(--color-pending)','var(--color-rejected)','var(--color-recalled)'];

    const bars = data.map((d,i) => {
      const bh = (d.value/max)*iH;
      const x  = pad.l + i*(bW+gap) + gap/2;
      const y  = pad.t + iH - bh;
      const c  = d.color || COLORS[i%COLORS.length];
      return `
        <rect x="${x}" y="${y}" width="${bW}" height="${bh}" fill="${c}" rx="4" tabindex="0">
          <title>${d.label}: ${Format.number(d.value)}</title>
        </rect>
        <text x="${x+bW/2}" y="${pad.t+iH+16}" text-anchor="middle" font-size="11" fill="var(--color-text-muted)">${d.label.length>7?d.label.slice(0,6)+'…':d.label}</text>
        ${d.value>0?`<text x="${x+bW/2}" y="${y-5}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--color-text-primary)">${Format.number(d.value)}</text>`:''}
      `;
    }).join('');

    const ticks = [0,.25,.5,.75,1].map(t => {
      const y=pad.t+iH-t*iH, v=Math.round(max*t);
      return `<line x1="${pad.l}" y1="${y}" x2="${pad.l+iW}" y2="${y}" stroke="var(--color-border)" stroke-dasharray="3,3"/>
        <text x="${pad.l-6}" y="${y+4}" text-anchor="end" font-size="10" fill="var(--color-text-muted)">${Format.number(v)}</text>`;
    }).join('');

    // P-011: viewBox makes chart responsive without forced reflow
    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block;" role="img" aria-label="${opts.title||'Bar chart'}">
      <title>${opts.title||''}</title>${ticks}${bars}
      ${opts.title?`<text x="${w/2}" y="${h-4}" text-anchor="middle" font-size="12" fill="var(--color-text-muted)">${opts.title}</text>`:''}
    </svg>`;
  },

  donut(containerId, data, opts={}) {
    const el = document.getElementById(containerId);
    if (!el || !data?.length) return;
    const sz=opts.size||180, cx=sz/2, cy=sz/2, or=sz*.42, ir=sz*.27;
    const total = data.reduce((s,d)=>s+d.value,0)||1;
    const COLS=['var(--color-brand-navy)','var(--color-brand-green)','var(--color-pending)','var(--color-rejected)','var(--color-recalled)','var(--color-corrected)'];
    let ang = -Math.PI/2;

    const slices = data.map((d,i) => {
      const a = (d.value/total)*2*Math.PI;
      const ea = ang+a;
      const path = `M${cx+or*Math.cos(ang)},${cy+or*Math.sin(ang)} A${or},${or} 0 ${a>Math.PI?1:0},1 ${cx+or*Math.cos(ea)},${cy+or*Math.sin(ea)} L${cx+ir*Math.cos(ea)},${cy+ir*Math.sin(ea)} A${ir},${ir} 0 ${a>Math.PI?1:0},0 ${cx+ir*Math.cos(ang)},${cy+ir*Math.sin(ang)} Z`;
      ang = ea;
      return `<path d="${path}" fill="${d.color||COLS[i%COLS.length]}"><title>${d.label}: ${Format.number(d.value)} (${Math.round(d.value/total*100)}%)</title></path>`;
    }).join('');

    const legend = data.map((d,i) => `
      <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:5px;">
        <span style="width:11px;height:11px;border-radius:2px;background:${d.color||COLS[i%COLS.length]};flex-shrink:0;"></span>
        <span style="color:var(--color-text-secondary);flex:1;">${d.label}</span>
        <span style="font-weight:600;color:var(--color-text-primary);">${Format.number(d.value)}</span>
      </div>`).join('');

    el.innerHTML = `<div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap;">
      <svg width="${sz}" height="${sz}" viewBox="0 0 ${sz} ${sz}" style="flex-shrink:0;" role="img" aria-label="${opts.title||'Donut chart'}">
        ${slices}
        ${opts.centerLabel?`<text x="${cx}" y="${cy-5}" text-anchor="middle" font-size="22" font-weight="700" fill="var(--color-text-primary)">${opts.centerLabel}</text><text x="${cx}" y="${cy+14}" text-anchor="middle" font-size="11" fill="var(--color-text-muted)">${opts.centerSub||''}</text>`:''}
      </svg>
      <div style="flex:1;min-width:110px;">${legend}</div>
    </div>`;
  },

  trend(containerId, data, opts={}) {
    const el = document.getElementById(containerId);
    if (!el || !data?.length) return;
    const w = 420, h=opts.height||160;
    const pad = {t:16,r:16,b:40,l:44};
    const iW=w-pad.l-pad.r, iH=h-pad.t-pad.b;
    const max = Math.max(...data.map(d=>d.value),1);
    const step = iW/(data.length-1||1);
    const pts = data.map((d,i)=>({x:pad.l+i*step,y:pad.t+iH-(d.value/max)*iH,...d}));
    const poly = pts.map(p=>`${p.x},${p.y}`).join(' ');
    const area = [`${pts[0].x},${pad.t+iH}`, ...pts.map(p=>`${p.x},${p.y}`), `${pts[pts.length-1].x},${pad.t+iH}`].join(' ');
    const c = opts.color||'var(--color-brand-navy-mid)';
    const fid = `f${containerId.replace(/\W/g,'')}`;

    el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:auto;display:block;" role="img" aria-label="${opts.title||'Trend'}">
      <defs><linearGradient id="${fid}" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="${c}" stop-opacity="0.2"/>
        <stop offset="100%" stop-color="${c}" stop-opacity="0.02"/>
      </linearGradient></defs>
      ${[0,.5,1].map(t=>{const y=pad.t+iH-t*iH; return `<line x1="${pad.l}" y1="${y}" x2="${pad.l+iW}" y2="${y}" stroke="var(--color-border)" stroke-width="1"/>
        <text x="${pad.l-6}" y="${y+4}" text-anchor="end" font-size="10" fill="var(--color-text-muted)">${Format.number(Math.round(max*t))}</text>`;}).join('')}
      <polygon points="${area}" fill="url(#${fid})"/>
      <polyline points="${poly}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.map(p=>`<circle cx="${p.x}" cy="${p.y}" r="4" fill="${c}" stroke="#fff" stroke-width="2"><title>${p.label}: ${Format.number(p.value)}</title></circle>`).join('')}
      ${pts.filter((_,i)=>i%Math.ceil(pts.length/7)===0||i===pts.length-1).map(p=>`
        <text x="${p.x}" y="${pad.t+iH+18}" text-anchor="middle" font-size="10" fill="var(--color-text-muted)">${p.label.length>8?p.label.slice(0,7)+'…':p.label}</text>`).join('')}
    </svg>`;
  },
};

// ── Pagination — P-009: Event Delegation ─────────────────────
const Pagination = {
  _handlers: {},

  /**
   * P-009: Render pagination using data attributes + event delegation.
   * No inline onclick — CSP-safe and GC-efficient.
   */
  render(containerId, { total, page, perPage, onChange }) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const tp = Math.ceil(total/perPage);
    if (tp<=1) { el.innerHTML=''; return; }
    const pages=[]; let prev;
    for (let i=1;i<=tp;i++) {
      if (i===1||i===tp||(i>=page-2&&i<=page+2)) pages.push(i);
      else if (prev!=='…') pages.push('…');
      prev = pages[pages.length-1];
    }
    // Store handler reference by containerId
    this._handlers[containerId] = onChange;

    el.innerHTML = `<div class="pagination" role="navigation" aria-label="Pagination" data-pagination="${containerId}">
      <button class="page-btn" ${page<=1?'disabled':''} data-page="${page-1}" aria-label="Previous">‹</button>
      ${pages.map(p=>p==='…'?`<span style="color:var(--color-text-muted);padding:0 4px;">…</span>`:
        `<button class="page-btn ${p===page?'active':''}" data-page="${p}" aria-label="Page ${p}" aria-current="${p===page?'page':'false'}">${p}</button>`).join('')}
      <button class="page-btn" ${page>=tp?'disabled':''} data-page="${page+1}" aria-label="Next">›</button>
    </div>
    <div style="font-size:var(--text-xs);color:var(--color-text-muted);text-align:center;margin-top:8px;">
      ${(page-1)*perPage+1}–${Math.min(page*perPage,total)} of ${Format.number(total)} records
    </div>`;
  },

  /** Call once per page to enable event delegation for all pagination containers */
  initDelegation() {
    document.addEventListener('click', e => {
      const btn = e.target.closest('[data-pagination] [data-page]');
      if (!btn || btn.disabled) return;
      const containerId = btn.closest('[data-pagination]')?.dataset.pagination;
      const pageNum = Number(btn.dataset.page);
      if (containerId && this._handlers[containerId] && !isNaN(pageNum) && pageNum > 0) {
        this._handlers[containerId](pageNum);
      }
    });
  },
};

// ── Global Search — P-012: Client-side prefix cache ──────────
const GlobalSearch = {
  _open:false, _q:'', _t:null,
  // P-012: Cache search results by query prefix
  _cache: {},
  _cacheMaxAge: 60000, // 1 minute

  init() {
    const btn=document.getElementById('global-search-btn');
    const ov=document.getElementById('search-overlay');
    const inp=document.getElementById('search-input');
    if (!btn||!ov) return;
    btn.addEventListener('click', ()=>this.open());
    ov.addEventListener('click', e=>{ if(e.target===ov) this.close(); });
    inp?.addEventListener('input', e=>{ this._q=e.target.value; clearTimeout(this._t); this._t=setTimeout(()=>this._search(),CONFIG.DEBOUNCE_SEARCH); });
    document.addEventListener('keydown', e=>{
      if ((e.ctrlKey||e.metaKey)&&e.key==='k') { e.preventDefault(); this._open?this.close():this.open(); }
      if (e.key==='Escape'&&this._open) this.close();
    });
  },
  open()  { this._open=true; const o=document.getElementById('search-overlay'); if(o){o.style.display='flex'; o.querySelector('input')?.focus();} },
  close() { this._open=false; const o=document.getElementById('search-overlay'); if(o)o.style.display='none'; const i=document.getElementById('search-input'); if(i)i.value=''; this._q=''; this._renderResults([]); },

  async _search() {
    if (this._q.length<2) { this._renderResults([]); return; }

    // P-012: Check prefix cache — if query starts with cached query, filter locally
    const cached = this._findCacheHit(this._q);
    if (cached) {
      const filtered = cached.data.filter(r =>
        (r.title||'').toLowerCase().includes(this._q.toLowerCase()) ||
        (r.subtitle||'').toLowerCase().includes(this._q.toLowerCase())
      );
      this._renderResults(filtered);
      return;
    }

    const res = await API.search(this._q);
    if (res.success) {
      const results = res.data || [];
      // Cache result
      this._cache[this._q] = { data: results, cachedAt: Date.now() };
      this._renderResults(results);
    }
  },

  _findCacheHit(query) {
    const now = Date.now();
    // Find a cached result where the query is a prefix extension
    for (const [key, val] of Object.entries(this._cache)) {
      if (query.startsWith(key) && now - val.cachedAt < this._cacheMaxAge) {
        return val;
      }
    }
    return null;
  },

  _renderResults(results) {
    const c=document.getElementById('search-results'); if(!c) return;
    if (!results.length) { c.innerHTML=this._q.length>=2?DOM.emptyState(I18n.t('search.no_results'),'🔍'):''; return; }
    c.innerHTML = results.map(r=>`
      <a class="search-result-item" href="${r.url||'#'}" data-search-close="true">
        <div class="search-result-icon" aria-hidden="true">${r.icon||'📋'}</div>
        <div class="search-result-info">
          <div class="search-result-title">${r.title}</div>
          <div class="search-result-sub">${r.subtitle||''}</div>
        </div>
        ${r.badge?`<span class="badge badge-${r.badge.toLowerCase()}">${r.badge}</span>`:''}
      </a>`).join('');
    // Event delegation
    c.querySelectorAll('[data-search-close]').forEach(a =>
      a.addEventListener('click', () => this.close())
    );
  },
};

// ── Notification Bell — P-010: document.hidden guard ─────────
const NotifBell = {
  _count:0, _timer:null,
  async init() { await this.refresh(); this._timer=setInterval(()=>this.refresh(),60000); },
  async refresh() {
    // P-010: Skip poll if tab is hidden (saves battery + network)
    if (document.hidden) return;
    const res = await API.getNotifications(true);
    if (res.success) {
      this._count=(res.data||[]).length;
      this._updateBadge();
      EventBus.emit('notif:updated',{count:this._count,items:res.data});
    }
  },
  _updateBadge() {
    const b=document.getElementById('notif-count'); if(!b) return;
    b.textContent=this._count>99?'99+':this._count;
    b.style.display=this._count>0?'flex':'none';
  },
  stop() { clearInterval(this._timer); },
};

// ── Sidebar ───────────────────────────────────────────────────
const Sidebar = {
  _col:false, _mob:false,
  init() {
    this._col=Store.get(CONFIG.SIDEBAR_KEY,false);
    this._apply();
    document.getElementById('sidebar-toggle')?.addEventListener('click',()=>this.toggleCollapse());
    document.getElementById('mobile-menu-btn')?.addEventListener('click',()=>this.toggleMobile());
    document.getElementById('mobile-overlay')?.addEventListener('click',()=>this.closeMobile());
    this._setActive();
  },
  toggleCollapse() { this._col=!this._col; Store.set(CONFIG.SIDEBAR_KEY,this._col); this._apply(); },
  toggleMobile()   { this._mob=!this._mob; this._applyMob(); },
  closeMobile()    { this._mob=false; this._applyMob(); },
  _apply() {
    document.getElementById('sidebar')?.classList.toggle('collapsed',this._col);
    document.getElementById('main-content')?.classList.toggle('sidebar-collapsed',this._col);
  },
  _applyMob() {
    document.getElementById('sidebar')?.classList.toggle('mobile-open',this._mob);
    const o=document.getElementById('mobile-overlay');
    if(o) o.style.display=this._mob?'block':'none';
    document.body.style.overflow=this._mob?'hidden':'';
  },
  _setActive() {
    const cur=window.location.pathname.split('/').pop()||'index.html';
    document.querySelectorAll('.nav-item[data-page]').forEach(el=>{
      const active=el.dataset.page===cur;
      el.classList.toggle('active',active);
      el.setAttribute('aria-current',active?'page':'false');
    });
  },
};

// ── Quick Filters ─────────────────────────────────────────────
const QuickFilters = {
  _a:{},
  init(containerId, filters, onChange) {
    const c=document.getElementById(containerId); if(!c) return;
    c.setAttribute('role','group');
    c.innerHTML=filters.map(f=>`
      <button class="filter-chip ${this._a[f.key]===f.value?'active':''}"
        data-key="${f.key}" data-value="${f.value||''}"
        aria-pressed="${this._a[f.key]===f.value}" type="button">
        ${f.icon?`<span aria-hidden="true">${f.icon}</span>`:''}${f.label}
      </button>`).join('');
    c.addEventListener('click', e=>{
      const chip=e.target.closest('.filter-chip'); if(!chip) return;
      const key=chip.dataset.key, val=chip.dataset.value;
      if (this._a[key]===val) {
        delete this._a[key]; chip.classList.remove('active'); chip.setAttribute('aria-pressed','false');
      } else {
        c.querySelectorAll(`[data-key="${key}"]`).forEach(ch=>{ ch.classList.remove('active'); ch.setAttribute('aria-pressed','false'); });
        this._a[key]=val; chip.classList.add('active'); chip.setAttribute('aria-pressed','true');
      }
      onChange({...this._a});
    });
  },
  getActive() { return {...this._a}; },
  reset()     { this._a={}; },
};

// ── Print Helper ──────────────────────────────────────────────
const Print = {
  section(contentId, title='') {
    const el = document.getElementById(contentId);
    if (!el) { window.print(); return; }
    const origTitle = document.title;
    document.title = `${title} — ACC LMS`;
    const iframe = document.createElement('iframe');
    iframe.style.display='none'; document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    doc.write(`<!DOCTYPE html><html><head><title>${title}</title>
      <style>* {box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;font-size:12px;color:#000;padding:20px}
      h1{font-size:18px;font-weight:700;margin-bottom:4px}
      .ph{border-bottom:2px solid #1E2B5E;padding-bottom:12px;margin-bottom:20px}
      .ph-sub{font-size:11px;color:#666;margin-top:4px}
      table{width:100%;border-collapse:collapse;margin-top:12px}
      th{background:#1E2B5E;color:#fff;padding:8px;text-align:left;font-size:11px}
      td{padding:7px 8px;border-bottom:1px solid #e2e8f0;font-size:11px}
      .badge{padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600}
      @page{margin:1.5cm}</style>
    </head><body>
      <div class="ph"><h1>${title}</h1><div class="ph-sub">Arabian Cement Company — LMS — ${new Date().toLocaleDateString()}</div></div>
      ${el.innerHTML}
    </body></html>`);
    doc.close();
    iframe.contentWindow.onafterprint = () => { iframe.remove(); document.title=origTitle; };
    setTimeout(() => { iframe.contentWindow.focus(); iframe.contentWindow.print(); }, 300);
  },
};

// ── PWA ───────────────────────────────────────────────────────
const PWA = {
  _prompt: null,
  async init() {
    if (!('serviceWorker' in navigator)) return;
    try {
      // FIX: a plain relative 'sw.js' resolves against the CURRENT
      // PAGE's location, not the site root — correct on index.html
      // (site root) but wrong on pages/*.html (one level deeper),
      // which is exactly why this 404'd specifically on inner pages.
      // sw.js only exists at the site root, so anchor to it using the
      // same core.js-location technique used for the i18n path fix.
      const coreScript = Array.from(document.scripts).find(s => s.src.includes('core.js'));
      const siteRoot = coreScript ? coreScript.src.replace(/js\/core\.js(\?.*)?$/, '') : './';
      const reg = await navigator.serviceWorker.register(`${siteRoot}sw.js`, { scope: siteRoot });
      console.log('[PWA] SW registered');
      reg.addEventListener('updatefound', () => {
        reg.installing?.addEventListener('statechange', function() {
          if (this.state==='installed'&&navigator.serviceWorker.controller)
            Toast.info('A new version is available — refresh to update.', 8000);
        });
      });

      // Listen for Background Sync flush
      navigator.serviceWorker.addEventListener('message', e => {
        if (e.data?.type === 'SYNC_FLUSH') OfflineQueue.flushQueue();
      });
    } catch(e) { console.warn('[PWA] SW failed:', e); }

    window.addEventListener('online',  () => {
      SyncManager.setOnline(true);
      Toast.success('Connection restored', 2500);
      // Flush offline queue on reconnect
      if (OfflineQueue.count() > 0) OfflineQueue.flushQueue();
    });
    window.addEventListener('offline', () => {
      SyncManager.setOnline(false);
      Toast.warning('You are offline. Cached data available.', 4000);
    });

    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault(); this._prompt=e; EventBus.emit('pwa:installable');
    });
  },
  async promptInstall() {
    if (!this._prompt) return false;
    this._prompt.prompt();
    const { outcome } = await this._prompt.userChoice;
    this._prompt = null;
    return outcome === 'accepted';
  },
  isInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone===true;
  },
};

// ── App Init ──────────────────────────────────────────────────
const App = {
  async init() {
    const savedUrl = Store.get(CONFIG.API_URL_KEY, '') || CONFIG.API_URL;
    if (savedUrl) API.setUrl(savedUrl);
    Auth.init();
    await I18n.init();
    Theme.init();
    Toast.init();
    // P-009: Init pagination delegation once globally
    Pagination.initDelegation();
    await PWA.init();
    console.log(`ACC LMS v${CONFIG.APP_VERSION} ready`);
  },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => App.init());
} else {
  App.init();
}

// ── Injected Styles ───────────────────────────────────────────
const _coreCSS = document.createElement('style');
_coreCSS.textContent = `
@keyframes toast-in  { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
@keyframes toast-out { to{opacity:0;transform:translateY(8px) scale(.95)} }
.toast-container{position:fixed;bottom:24px;right:24px;display:flex;flex-direction:column;gap:10px;z-index:var(--z-toast,400);max-width:360px}
[dir=rtl] .toast-container{right:auto;left:24px}
.toast{display:flex;align-items:center;gap:10px;padding:14px 16px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.15);font-size:var(--text-sm,13px);font-weight:500;background:var(--color-surface,#fff);border:1px solid var(--color-border,#e2e8f0);opacity:0;animation:toast-in .25s ease forwards;min-width:260px}
.toast-visible{opacity:1}
.toast-success{border-left:4px solid var(--color-approved,#059669)}
.toast-error  {border-left:4px solid var(--color-rejected,#DC2626)}
.toast-warning{border-left:4px solid var(--color-pending,#D97706)}
.toast-info   {border-left:4px solid var(--color-info,#0284C7)}
.toast-close  {margin-left:auto;background:none;border:none;cursor:pointer;color:var(--color-text-muted);font-size:14px;padding:2px}
.toast-message{flex:1}

.modal-overlay{position:fixed;inset:0;background:rgba(15,23,41,.65);z-index:var(--z-modal,300);display:flex;align-items:center;justify-content:center;padding:24px;opacity:0;transition:opacity .2s;backdrop-filter:blur(3px)}
.modal-visible{opacity:1!important}
.modal{background:var(--color-surface,#fff);border-radius:var(--radius-xl,20px);box-shadow:var(--shadow-xl);width:100%;max-width:560px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden}
.modal-md{max-width:560px}.modal-lg{max-width:760px}.modal-xl{max-width:960px}.modal-sm{max-width:400px}
.modal-header{display:flex;align-items:center;justify-content:space-between;padding:20px 24px;border-bottom:1px solid var(--color-border);flex-shrink:0}
.modal-title{font-size:var(--text-lg,18px);font-weight:600;color:var(--color-text-primary)}
.modal-close-btn{background:none;border:none;cursor:pointer;font-size:18px;color:var(--color-text-muted);width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;transition:background .15s}
.modal-close-btn:hover{background:var(--color-surface-overlay)}
.modal-body{padding:24px;overflow-y:auto;flex:1}
.modal-footer{padding:16px 24px;border-top:1px solid var(--color-border);display:flex;justify-content:flex-end;gap:10px;flex-shrink:0;background:var(--color-surface-overlay)}

.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;text-align:center}
.empty-icon{font-size:48px;margin-bottom:16px;opacity:.6}
.empty-message{font-size:var(--text-md,16px);font-weight:500;color:var(--color-text-secondary)}
.empty-sub{font-size:var(--text-sm,13px);color:var(--color-text-muted);margin-top:6px}

@keyframes skeleton-wave{0%{background-position:200% 0}100%{background-position:-200% 0}}
.skeleton{background:linear-gradient(90deg,var(--color-border,#E2E8F0) 25%,rgba(226,232,240,.5) 50%,var(--color-border,#E2E8F0) 75%);background-size:200% 100%;animation:skeleton-wave 1.4s ease infinite;border-radius:6px}

.search-result-item{display:flex;align-items:center;gap:12px;padding:10px 16px;cursor:pointer;text-decoration:none;color:var(--color-text-primary);transition:background .15s;border-bottom:1px solid var(--color-border)}
.search-result-item:hover{background:var(--color-surface-overlay)}
.search-result-icon{font-size:20px;flex-shrink:0}
.search-result-title{font-size:var(--text-sm);font-weight:500}
.search-result-sub{font-size:var(--text-xs);color:var(--color-text-muted)}

.photo-picker{display:flex;flex-direction:column;gap:10px}
.photo-picker-slots{display:flex;gap:10px;flex-wrap:wrap}
.photo-add-btn{display:flex;align-items:center;gap:8px;padding:0 14px;height:80px;border-radius:10px;border:2px dashed var(--color-border);cursor:pointer;font-size:var(--text-sm);color:var(--color-text-muted);transition:all .15s;background:var(--color-surface)}
.photo-add-btn:hover{border-color:var(--color-brand-navy);color:var(--color-brand-navy)}
.photo-count{font-size:var(--text-xs);background:var(--color-surface-overlay);padding:2px 8px;border-radius:99px}

/* Photo Lightbox — Phase 7 */
.photo-lightbox{display:flex;flex-direction:column;gap:12px}
.photo-lb-main{display:flex;align-items:center;gap:8px;min-height:280px}
.photo-lb-nav{background:var(--color-surface-overlay);border:1px solid var(--color-border);border-radius:50%;width:40px;height:40px;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s;color:var(--color-text-primary)}
.photo-lb-nav:hover:not(:disabled){background:var(--color-brand-navy);color:#fff}
.photo-lb-nav:disabled{opacity:.3;cursor:default}
.photo-lb-img-wrap{flex:1;position:relative;border-radius:12px;overflow:hidden;background:var(--color-surface-overlay);aspect-ratio:4/3;display:flex;align-items:center;justify-content:center}
.photo-lb-img{max-width:100%;max-height:380px;object-fit:contain;border-radius:8px;display:block}
.photo-lb-fullscreen-btn{position:absolute;top:8px;right:8px;background:rgba(0,0,0,.55);color:#fff;border-radius:6px;padding:4px 8px;text-decoration:none;font-size:16px;line-height:1;transition:background .15s}
.photo-lb-fullscreen-btn:hover{background:rgba(0,0,0,.8)}
.photo-lb-meta{display:flex;gap:12px;font-size:var(--text-xs);color:var(--color-text-muted);flex-wrap:wrap;align-items:center;padding:0 4px}
.photo-lb-filename{font-weight:500;color:var(--color-text-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.photo-lb-strip{display:flex;gap:8px;overflow-x:auto;padding:4px 0}
.photo-lb-thumb{width:64px;height:64px;border-radius:8px;overflow:hidden;border:2px solid var(--color-border);cursor:pointer;background:none;padding:0;flex-shrink:0;transition:border-color .15s}
.photo-lb-thumb.active{border-color:var(--color-brand-navy);box-shadow:0 0 0 2px var(--color-brand-navy)}
.photo-lb-thumb img{width:100%;height:100%;object-fit:cover}
.photo-lb-admin{display:flex;justify-content:flex-end;padding-top:8px;border-top:1px solid var(--color-border);margin-top:4px}

[data-theme=dark]{
  --color-bg:#0F1729;
  --color-surface:#1A2340;
  --color-surface-raised:#1F2B4E;
  --color-surface-overlay:rgba(255,255,255,.05);
  --color-header:#1A2340;
  --color-border:#2D3A5C;
  --color-text-primary:#F1F5F9;
  --color-text-secondary:#94A3B8;
  --color-text-muted:#64748B;
}

@media (max-width:640px){
  .hidden-mobile{display:none!important}
  .modal{max-width:100%;margin:0;border-radius:var(--radius-xl) var(--radius-xl) 0 0;max-height:95vh;position:fixed;bottom:0;left:0;right:0}
  .modal-overlay{align-items:flex-end;padding:0}
  .toast-container{bottom:16px;right:16px;left:16px;max-width:100%}
  .photo-lb-main{min-height:200px}
  .photo-lb-img{max-height:240px}
}

@media print{
  .sidebar,.app-header,.btn,.toast-container,.modal-overlay,.filter-bar,.pagination,.tab-nav{display:none!important}
  .main-content{margin:0!important}.page-content{padding:0!important}
  .card{box-shadow:none;border:1px solid #ddd;break-inside:avoid}
  body{background:#fff}
}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;transition-duration:.01ms!important}
}
`;
document.head.appendChild(_coreCSS);
