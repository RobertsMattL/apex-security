// APEX SECURITY web console. Talks to the same REST API + WebSocket gateway as the Android app.
// No build step: plain ES modules. DOM is built with h() (textContent only, never innerHTML).

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className += ' ' + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('--')) el.style.setProperty(k, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $app = document.getElementById('app');
const $toasts = document.getElementById('toasts');

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const fmt = {
  clock: (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; },
  stamp: (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmt.clock(ms)}`; },
  ago: (ms) => {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
  },
  day: (ms) => {
    const d = new Date(ms), t = new Date(), y = new Date(Date.now() - 864e5);
    const same = (a, b) => a.toDateString() === b.toDateString();
    return same(d, t) ? 'TODAY' : same(d, y) ? 'YESTERDAY' : d.toDateString().toUpperCase();
  },
  pct: (c) => `${Math.round(c * 100)}%`,
  kind: (k) => (k === 'person' ? 'HUMAN' : k === 'animal' ? 'ANIMAL' : String(k).toUpperCase()),
  cooldown: (s) => (s === 0 ? 'OFF' : s < 60 ? `${s}s` : s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`),
};
const color = {
  kind: (k) => (k === 'person' ? 'var(--red)' : k === 'animal' ? 'var(--amber)' : 'var(--cyan)'),
  stream: (s) => (s === 'online' ? 'var(--green)' : s === 'connecting' ? 'var(--amber)' : s === 'disabled' ? 'var(--text-faint)' : 'var(--red)'),
  detector: (s) => (s === 'running' ? 'var(--cyan)' : s === 'error' ? 'var(--red)' : s === 'starting' ? 'var(--amber)' : 'var(--text-faint)'),
};

// ---------------------------------------------------------------------------
// session + API
// ---------------------------------------------------------------------------
const store = {
  get: (k) => { try { return localStorage.getItem(`tacsec.${k}`); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(`tacsec.${k}`) : localStorage.setItem(`tacsec.${k}`, v); } catch {} },
};

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const api = {
  token: store.get('access'),
  async raw(method, path, body, token) {
    const r = await fetch(path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!r.ok) throw new ApiError(r.status, data?.error ?? `HTTP ${r.status}`);
    return data;
  },
  expSoon(t) {
    try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp * 1000 - Date.now() < 60000; } catch { return true; }
  },
  refreshing: null,
  async accessToken(force = false) {
    if (!force && this.token && !this.expSoon(this.token)) return this.token;
    this.refreshing ??= (async () => {
      const rt = store.get('refresh');
      if (!rt) throw new ApiError(401, 'signed out');
      try {
        this.save(await this.raw('POST', '/api/auth/refresh', { refreshToken: rt }));
      } finally {
        this.refreshing = null;
      }
    })();
    await this.refreshing;
    return this.token;
  },
  save(r) {
    this.token = r.accessToken;
    store.set('access', r.accessToken);
    store.set('refresh', r.refreshToken);
    store.set('device', r.deviceId);
  },
  async call(method, path, body) {
    try {
      return await this.raw(method, path, body, await this.accessToken());
    } catch (e) {
      if (e.status !== 401) throw e;
      return this.raw(method, path, body, await this.accessToken(true));
    }
  },
  get: (p) => api.call('GET', p),
  post: (p, b = {}) => api.call('POST', p, b),
  put: (p, b) => api.call('PUT', p, b),
  patch: (p, b) => api.call('PATCH', p, b),
  del: (p) => api.call('DELETE', p),
};

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------
const state = {
  signedIn: !!store.get('refresh'),
  cameras: [],
  alerts: new Map(), // notification id -> item (dedup key)
  activity: [],
  link: 'offline',
  error: null,
  eventsVersion: 0,
};
const listeners = new Set();
let notifyQueued = false;
function changed() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => { notifyQueued = false; listeners.forEach((fn) => fn()); });
}
const alertsSorted = () => [...state.alerts.values()].sort((a, b) => b.createdAt - a.createdAt);
const unreadCount = () => [...state.alerts.values()].filter((a) => !a.read).length;
const isRead = (n) => n.read === true || n.state === 'read';

function upsertAlert(n) {
  const prev = state.alerts.get(n.id);
  state.alerts.set(n.id, { ...n, read: isRead(n) || !!prev?.read });
  return !prev;
}

async function refreshAll() {
  try {
    const b = await api.get('/api/bootstrap');
    state.cameras = b.cameras;
    b.notifications.forEach(upsertAlert);
    state.activity = await api.get('/api/events?limit=30');
    state.error = null;
  } catch (e) {
    if (e.status === 401) return signOut();
    state.error = e.message;
  }
  changed();
}

function markRead(ids) {
  const unread = ids.filter((id) => state.alerts.get(id) && !state.alerts.get(id).read);
  if (!unread.length) return;
  unread.forEach((id) => (state.alerts.get(id).read = true));
  if (!rt.send({ t: 'read', ids: unread })) api.post('/api/notifications/read', { ids: unread }).catch(() => {});
  changed();
}

function signOut() {
  rt.stop();
  ['access', 'refresh'].forEach((k) => store.set(k, null));
  api.token = null;
  Object.assign(state, { signedIn: false, cameras: [], activity: [], alerts: new Map() });
  location.hash = '#/';
  changed();
}

// ---------------------------------------------------------------------------
// realtime: same protocol as the Android RealtimeClient
// ---------------------------------------------------------------------------
const rt = {
  ws: null, wanted: false, attempt: 0, lastMsg: 0, timer: null, hb: null,
  start() {
    if (this.wanted) return;
    this.wanted = true;
    this.connect();
    this.hb = setInterval(() => {
      if (!this.ws) return;
      this.send({ t: 'ping' });
      if (state.link === 'online' && Date.now() - this.lastMsg > 50000) this.ws.close();
    }, 20000);
  },
  stop() {
    this.wanted = false;
    clearInterval(this.hb); clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    state.link = 'offline';
  },
  send(m) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  },
  async connect(force = false) {
    if (!this.wanted) return;
    state.link = 'connecting'; changed();
    let token;
    try { token = await api.accessToken(force); } catch (e) { if (e.status === 401) return signOut(); return this.retry(); }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0; this.lastMsg = Date.now();
      state.link = 'online'; changed();
      refreshAll();
    };
    ws.onmessage = (ev) => { this.lastMsg = Date.now(); onMessage(JSON.parse(ev.data)); };
    ws.onclose = (ev) => { if (ws === this.ws) { this.ws = null; this.retry(ev.code === 1006 && this.attempt > 0); } };
  },
  retry(force = false) {
    if (!this.wanted) return;
    state.link = 'offline'; changed();
    const ms = Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5));
    this.timer = setTimeout(() => this.connect(force), ms);
  },
};
window.addEventListener('online', () => { if (rt.wanted && state.link !== 'online') { clearTimeout(rt.timer); rt.attempt = 0; rt.connect(); } });

function onMessage(m) {
  switch (m.t) {
    case 'notification': {
      const isNew = upsertAlert(m.n);
      rt.send({ t: 'ack', ids: [m.n.id] }); // receipt: we have it
      if (isNew && !isRead(m.n)) toast(state.alerts.get(m.n.id));
      changed();
      break;
    }
    case 'notification.read': {
      const a = state.alerts.get(m.id);
      if (a) a.read = true;
      changed();
      break;
    }
    case 'camera.status':
      state.cameras = state.cameras.map((c) => (c.id === m.cameraId ? { ...c, status: m.status } : c));
      changed();
      break;
    case 'camera.upserted':
      state.cameras = state.cameras.some((c) => c.id === m.camera.id) ? state.cameras.map((c) => (c.id === m.camera.id ? m.camera : c)) : [...state.cameras, m.camera];
      changed();
      break;
    case 'camera.removed':
      state.cameras = state.cameras.filter((c) => c.id !== m.cameraId);
      changed();
      break;
    case 'settings.updated':
      state.cameras = state.cameras.map((c) => (c.id === m.cameraId ? { ...c, ...m.settings } : c));
      changed();
      break;
    case 'events.deleted': {
      const gone = new Set(m.eventIds);
      m.notificationIds.forEach((id) => state.alerts.delete(id));
      for (const [id, a] of state.alerts) if (gone.has(a.eventId)) state.alerts.delete(id);
      state.activity = state.activity.filter((e) => !gone.has(e.id));
      eventSeq = eventSeq.filter((x) => !gone.has(x.eventId));
      state.deleted = gone;
      state.eventsVersion++;
      changed();
      break;
    }
    case 'event':
      api.get(`/api/events/${m.event.id}`).then((ev) => {
        state.activity = [ev, ...state.activity.filter((x) => x.id !== ev.id)].slice(0, 50);
        state.eventsVersion++;
        changed();
      }).catch(() => {});
      break;
  }
}

// ---------------------------------------------------------------------------
// shared components
// ---------------------------------------------------------------------------
const pip = (c, pulse = false) => h('span.pip' + (pulse ? '.pulse' : ''), { style: { color: c } });
const chip = (text, c = 'var(--text-dim)', filled = false, onclick) =>
  h(onclick ? 'button.chip' : 'span.chip', { '--c': c, class: filled ? 'filled' : '', onclick }, text);
const btn = (text, onclick, { variant = '', primary = false, disabled = false, block = false, small = false } = {}) =>
  h('button.btn', { class: [variant, primary && 'primary brackets', block && 'block', small && 'small'].filter(Boolean).join(' '), onclick, disabled }, text);
const sectionHeader = (text, trailing) => h('div.section-header', {}, h('span.label', { text: `// ${text.toUpperCase()}` }), h('span.rule'), trailing ?? null);
const kv = (rows) => h('div.kv', {}, rows.filter(Boolean).flatMap(([k, v, c]) => [h('span.label', { text: k }), h('span.v', { text: v, style: c ? { color: c } : null })]));
const linkIndicator = () => {
  const [c, t] = state.link === 'online' ? ['var(--green)', 'LINK'] : state.link === 'connecting' ? ['var(--amber)', 'SYNC'] : ['var(--red)', 'NO LINK'];
  return h('span.link', { style: { color: c } }, pip(c, state.link !== 'online'), t);
};
function toggle(checked, onchange, { disabled = false, c = 'var(--cyan)' } = {}) {
  return h('button.toggle', { role: 'switch', 'aria-checked': String(!!checked), '--c': c, disabled, onclick: () => onchange(!checked) }, h('i'), h('i'));
}
const toggleRow = (title, sub, checked, onchange, opts = {}) =>
  h('div.toggle-row', {}, h('div.grow', {}, h('div.t', { text: title, style: { color: opts.disabled ? 'var(--text-faint)' : null } }), sub ? h('div.data-sm.faint', { text: sub }) : null), toggle(checked, onchange, opts));
function topbar(title, sub, { back, actions = [] } = {}) {
  return h('header.topbar', {},
    back ? h('a.back', { href: back, title: 'Back', text: '‹' }) : null,
    h('div.grow', {}, h('span.title', { text: title }), sub ? h('span.data-sm.sub', { text: sub }) : null),
    ...actions);
}
const empty = (title, detail, action) => h('div.empty', {}, h('div.mark.brackets', {}, h('i')), h('div.title.dim', { text: title }), h('p.faint', { text: detail }), action ?? null);
const frameOverlay = (c) => h('div.overlay-brackets.brackets', { '--br': c, '--bl': '12px', '--bi': '8px' });

/** Event frames use signed, expiring URLs from the server; cache by event id like the app does. */
const eventImg = (url, cls = '') => (url ? h('img', { src: url, alt: '', loading: 'lazy', class: cls }) : h('div.center.label.faint', { text: 'NO FRAME', class: cls }));

/** Latest frames for dashboard tiles: fetched with the bearer token, kept as blob URLs. */
const snapshots = {
  urls: new Map(),
  at: new Map(),
  async refresh(id) {
    try {
      const r = await fetch(`/api/cameras/${id}/snapshot`, { headers: { authorization: `Bearer ${await api.accessToken()}` } });
      if (!r.ok) return;
      const url = URL.createObjectURL(await r.blob());
      const old = this.urls.get(id);
      this.urls.set(id, url);
      this.at.set(id, Date.now());
      document.querySelectorAll(`img[data-snap="${id}"]`).forEach((img) => (img.src = url));
      if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
    } catch {}
  },
  img(id) {
    if (!this.at.has(id) || Date.now() - this.at.get(id) > 15000) { this.at.set(id, Date.now()); this.refresh(id); }
    return h('img', { 'data-snap': id, src: this.urls.get(id) ?? undefined, alt: '' });
  },
};
setInterval(() => { if (state.signedIn && route().name === 'dash') state.cameras.filter((c) => c.status?.stream === 'online').forEach((c) => snapshots.refresh(c.id)); }, 15000);

function toast(a) {
  const el = h('div.toast', { onclick: () => { openEvent(a.eventId, a.id, alertsSorted().map((x) => ({ eventId: x.eventId, alertId: x.id }))); el.remove(); } },
    a.imageUrl ? h('img', { src: a.imageUrl, alt: '' }) : null,
    h('div', { style: { flex: 1, minWidth: 0 } },
      chip(fmt.kind(a.kind), color.kind(a.kind), true),
      h('div.data', { text: a.cameraName.toUpperCase(), style: { marginTop: '4px' } }),
      h('div.data-sm', { text: `${a.label} ${fmt.pct(a.confidence)} · ${fmt.clock(a.createdAt)}` })));
  $toasts.prepend(el);
  while ($toasts.children.length > 4) $toasts.lastChild.remove();
  setTimeout(() => el.remove(), 9000);
  document.title = `(${unreadCount()}) Apex Security Console`;
}

/** The list an event was opened from; event detail pages through it (swipe, arrows, buttons). */
let eventSeq = [];
function openEvent(eventId, alertId, list, replace = false) {
  if (list) eventSeq = list;
  const url = `#/event/${eventId}${alertId ? `?alert=${alertId}` : ''}`;
  replace ? location.replace(url) : (location.hash = url);
}

/** Delete events (and their frames + notifications). Applies locally at once; the server broadcasts to other clients. */
async function deleteEvents(body) {
  const r = await api.post('/api/events/delete', body);
  onMessage({ t: 'events.deleted', eventIds: r.eventIds, notificationIds: r.notificationIds });
  return r.deleted;
}

const checkbox = (checked, onclick) => h('button.check', { role: 'checkbox', 'aria-checked': String(!!checked), onclick: (e) => { e.stopPropagation(); onclick(); } });

/**
 * Selection bar for lists. `allMatching` means "everything matching the current filter",
 * including items not loaded yet; it's executed server-side.
 */
function selectionBar({ count, allMatching, loaded, onSelectAll, onClear, onDelete, confirming, busy }) {
  return h('div.selbar', {},
    h('span.data.c-cyan', { text: allMatching ? 'ALL MATCHING SELECTED' : `${count} SELECTED` }),
    h('span.grow'),
    allMatching || count === loaded ? null : btn(`Select all`, onSelectAll, { small: true }),
    btn('Clear', onClear, { small: true, variant: 'dim' }),
    btn(busy ? 'Deleting…' : confirming ? `Confirm delete${allMatching ? ' all' : ` ${count}`}` : 'Delete', onDelete, { small: true, variant: 'red', primary: confirming, disabled: busy || (!allMatching && count === 0) }));
}

// ---------------------------------------------------------------------------
// live player: tacticalRtsp's MSE player (web-app/public/index.html), per camera
// ---------------------------------------------------------------------------
class LivePlayer {
  constructor(cameraId) {
    this.cameraId = cameraId;
    this.video = h('video', { muted: true, playsinline: true, autoplay: true });
    this.video.muted = true;
    this.status = h('span.data-sm', { text: 'ACQUIRING', style: { color: 'var(--cyan)' } });
    this.pip = pip('var(--cyan)', true);
    this.lag = h('span.data-sm', { text: '' });
    this.clock = h('span.data-sm', { style: { color: 'rgba(228,236,241,0.8)' } });
    this.el = h('div.frame', {}, this.video, h('div.scan'), frameOverlay('rgba(56,225,255,0.7)'),
      h('div.tl', {}, this.pip, this.status), h('div.tr', {}, this.clock), h('div.bl', { style: { textAlign: 'right' } }, this.lag));
    this.closed = false;
    this.TARGET = 0.5; this.MAX = 3;
    this.connect();
    this.tick = setInterval(() => this.regulate(), 250);
    this.clockTimer = setInterval(() => (this.clock.textContent = fmt.stamp(Date.now())), 1000);
  }
  setStatus(text, c) { this.status.textContent = text; this.status.style.color = c; this.pip.style.color = c; }
  async connect() {
    if (this.closed) return;
    const token = await api.accessToken().catch(() => null);
    if (!token || this.closed) return;
    const ms = new MediaSource();
    this.video.src = URL.createObjectURL(ms);
    this.started = false;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live?camera=${this.cameraId}&token=${encodeURIComponent(token)}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let sb = null;
    const queue = [];
    const pump = () => {
      if (!sb || sb.updating || !queue.length) return;
      try { sb.appendBuffer(queue.shift()); } catch (e) { if (e.name === 'QuotaExceededError') trim(0); }
    };
    const trim = (keep) => {
      if (!sb || sb.updating || !sb.buffered.length) return;
      const start = sb.buffered.start(0);
      if (this.video.currentTime - start > keep + 1) sb.remove(start, this.video.currentTime - keep);
    };
    let retryMs = 2000;
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const { codec } = JSON.parse(ev.data);
        const mime = `video/mp4; codecs="${codec}"`;
        if (!MediaSource.isTypeSupported(mime)) { this.setStatus(`UNSUPPORTED ${codec}`, 'var(--amber)'); return ws.close(); }
        const init = () => {
          sb = ms.addSourceBuffer(mime);
          sb.mode = 'segments';
          sb.addEventListener('updateend', () => { pump(); trim(5); });
          this.setStatus('● LIVE', 'var(--red)');
          pump();
        };
        ms.readyState === 'open' ? init() : ms.addEventListener('sourceopen', init, { once: true });
      } else {
        queue.push(ev.data);
        pump();
      }
    };
    // A decode error kills the media element; start over (the new stream begins on a keyframe).
    this.video.onerror = () => { this.video.onerror = null; retryMs = 0; ws.close(); };
    ws.onclose = () => {
      if (this.closed) return;
      this.setStatus('SIGNAL LOST', 'var(--amber)');
      setTimeout(() => this.connect(), retryMs);
    };
  }
  // Hold the buffer near TARGET with tiny playback-rate nudges instead of seeking (as tacticalRtsp does).
  regulate() {
    const v = this.video, b = v.buffered;
    if (!b.length) return;
    const end = b.end(b.length - 1), lag = end - v.currentTime;
    this.lag.textContent = `BUF ${Math.round(lag * 1000)}MS`;
    if (!this.started) { if (lag < this.TARGET) return; this.started = true; v.play().catch(() => {}); }
    if (lag > this.MAX) { v.currentTime = end - this.TARGET; v.playbackRate = 1; }
    else if (lag > this.TARGET * 1.5) v.playbackRate = 1.02;
    else if (lag < this.TARGET * 0.5) v.playbackRate = 0.97;
    else if (Math.abs(lag - this.TARGET) < this.TARGET * 0.15) v.playbackRate = 1;
    if (v.paused) v.play().catch(() => {});
  }
  destroy() {
    this.closed = true;
    clearInterval(this.tick); clearInterval(this.clockTimer);
    this.ws?.close();
    this.video.removeAttribute('src'); this.video.load();
  }
}

// ---------------------------------------------------------------------------
// views. Each returns { el, update?, destroy? }; update() patches without remounting.
// ---------------------------------------------------------------------------
function loginView() {
  const f = { server: location.origin, user: 'admin', pass: '' };
  let setupRequired = null;
  const err = h('div.err');
  const mode = h('span.label', { text: '// OPERATOR', style: { color: 'var(--cyan)' } });
  const status = h('span.data-sm', { style: { color: 'var(--green)' } });
  const go = btn('Connect', submit, { primary: true, block: true });
  const user = h('input.input', { value: f.user, oninput: (e) => (f.user = e.target.value), autocomplete: 'username' });
  const pass = h('input.input', { type: 'password', oninput: (e) => (f.pass = e.target.value), autocomplete: 'current-password', onkeydown: (e) => e.key === 'Enter' && submit() });
  api.raw('GET', '/api/health').then((r) => {
    setupRequired = r.setupRequired;
    status.textContent = setupRequired ? 'SERVER FOUND · FIRST RUN' : 'SERVER FOUND';
    mode.textContent = setupRequired ? '// CREATE ADMIN ACCOUNT' : '// OPERATOR';
    mode.style.color = setupRequired ? 'var(--amber)' : 'var(--cyan)';
    go.textContent = setupRequired ? 'Create & connect' : 'Connect';
    pass.placeholder = setupRequired ? 'min. 8 characters' : '';
  }).catch((e) => (err.textContent = `Server unreachable: ${e.message}`));
  async function submit() {
    err.textContent = '';
    go.disabled = true;
    try {
      if (setupRequired) await api.raw('POST', '/api/setup', { username: f.user.trim(), password: f.pass });
      const device = store.get('device');
      api.save(await api.raw('POST', '/api/auth/login', {
        username: f.user.trim(), password: f.pass, platform: 'web',
        deviceName: `Web · ${navigator.platform || 'browser'}`.slice(0, 64), ...(device ? { deviceId: device } : {}),
      }));
      state.signedIn = true;
      rt.start();
      render();
    } catch (e) {
      err.textContent = e.message;
    }
    go.disabled = false;
  }
  const el = h('div.login.fade-in', {},
    h('div.logo.brackets', {}, pip('var(--amber)', true)),
    h('div.headline', { text: 'APEX SECURITY' }),
    h('div.label', { text: 'Surveillance console · link setup', style: { marginBottom: '32px' } }),
    h('div.glass.brackets', { '--br': 'rgba(56,225,255,0.6)', '--bl': '8px' },
      h('span.label.c-cyan', { text: '// UPLINK' }),
      h('div.kv', { style: { margin: '8px 0 4px' } }, h('span.label', { text: 'Server' }), h('span.v', { text: f.server })),
      status,
      h('div', { style: { height: '12px' } }), mode,
      h('label.field', {}, h('span.label', { text: 'Username' }), user),
      h('label.field', {}, h('span.label', { text: 'Password' }), pass),
      err, h('div', { style: { height: '8px' } }), go),
    h('p.faint', { text: 'Camera credentials stay on the server. This console only receives live video over an authenticated session.', style: { marginTop: '16px' } }));
  setTimeout(() => pass.focus(), 50);
  return { el };
}

function dashboardView() {
  const el = h('div.fade-in');
  const update = () => {
    const unread = unreadCount();
    const online = state.cameras.filter((c) => c.status?.stream === 'online').length;
    const detecting = state.cameras.filter((c) => c.status?.detector === 'running').length;
    const lastBy = new Map();
    state.activity.forEach((e) => lastBy.has(e.cameraId) || lastBy.set(e.cameraId, e));
    const stat = (label, value, c) => h('div.glass.stat', { '--c': c }, h('div.label', { text: label }), h('div.metric', { text: value, style: { color: c } }), h('div.bar', { style: { '--c': c } }));
    el.replaceChildren(
      topbar('APEX SECURITY', location.host, {
        actions: [
          linkIndicator(),
          btn('Live', () => (location.hash = '#/live'), { small: true }),
          btn('Events', () => (location.hash = '#/events'), { small: true, variant: 'dim' }),
          h('span.badge-wrap', {}, btn('Alerts', () => (location.hash = '#/alerts'), { small: true, variant: unread ? 'amber' : '' }), unread ? h('span.badge', { text: unread > 99 ? '99+' : unread }) : null),
          btn('Sys', () => (location.hash = '#/sys'), { small: true, variant: 'dim' }),
        ],
      }),
      h('main', {},
        state.error ? h('div.data-sm.c-amber', { text: `⚠ ${state.error}`, style: { marginTop: '10px' } }) : null,
        h('div.stats', {},
          stat('Online', `${online}/${state.cameras.length}`, !state.cameras.length ? 'var(--text-faint)' : online === state.cameras.length ? 'var(--green)' : online ? 'var(--amber)' : 'var(--red)'),
          stat('Detect', `${detecting}`, detecting ? 'var(--cyan)' : 'var(--text-faint)'),
          stat('Unread', `${unread}`, unread ? 'var(--amber)' : 'var(--text-faint)')),
        sectionHeader('Cameras', h('span.data-sm', { text: `${state.cameras.length} UNITS` })),
        state.cameras.length
          ? h('div.grid', {}, state.cameras.map((c) => cameraCard(c, lastBy.get(c.id))), h('div.add-card.brackets', { '--br': 'rgba(56,225,255,0.5)', '--bl': '12px', '--bi': '8px', onclick: () => (location.hash = '#/add') }, h('div', {}, h('div.headline.c-cyan', { text: '+' }), h('div.label.c-cyan', { text: 'Add camera' }))))
          : empty('No cameras', 'Add an RTSP camera to begin monitoring.', btn('+ Add camera', () => (location.hash = '#/add'), { primary: true })),
        sectionHeader('Recent activity', h('span.data-sm', { text: `LAST ${state.activity.length}` })),
        state.activity.length ? h('div.list', {}, state.activity.slice(0, 12).map(activityRow)) : h('p.faint', { text: 'No detections yet.' })));
  };
  update();
  return { el, update };
}

function cameraCard(c, last) {
  const st = c.status ?? {};
  const sc = color.stream(st.stream);
  return h('div.glass.clickable.cam-card', { onclick: () => (location.hash = `#/cam/${c.id}`) },
    h('div.frame', {},
      st.stream === 'online' ? snapshots.img(c.id) : h('div.center.label.faint', { text: 'NO SIGNAL' }),
      h('div.shade'), h('div.scan'), frameOverlay(sc),
      h('div.tl.data-sm', { style: { color: sc } }, pip(sc, st.stream !== 'online'), (st.stream ?? '').toUpperCase()),
      st.tracks?.[0] ? h('div.tr.data-sm', { text: st.tracks[0], style: { color: 'rgba(228,236,241,0.7)' } }) : null,
      h('div.bl', {},
        h('div.title', { text: c.name }),
        h('div.data-sm', { text: last ? `LAST ${fmt.kind(last.kind)} · ${fmt.ago(last.createdAt)}` : 'NO RECENT DETECTIONS', style: { color: last ? color.kind(last.kind) : null } }))),
    h('div.foot', {},
      c.listeners.map((l) => chip(fmt.kind(l.kind), l.enabled ? color.kind(l.kind) : 'var(--text-faint)', l.enabled)),
      h('span.grow'),
      h('span.data-sm', { text: `DET ${(st.detector ?? 'off').toUpperCase()}`, style: { color: color.detector(st.detector) } }),
      c.notificationsEnabled ? null : chip('Muted', 'var(--text-faint)')));
}

function activityRow(ev) {
  return h('div.row-item', { '--c': color.kind(ev.kind), onclick: () => openEvent(ev.id, null, state.activity.map((e) => ({ eventId: e.id }))) },
    h('span.stripe'), eventImg(ev.imageUrl, 'thumb'),
    h('div.grow', {},
      h('div.data', { text: `${fmt.kind(ev.kind)} · ${ev.cameraName.toUpperCase()}` }),
      h('div.data-sm', { text: `${ev.label} ${fmt.pct(ev.confidence)}${ev.trackId != null ? ` · TRK #${ev.trackId}` : ''}` })),
    h('div.right', {}, h('div.data.dim', { text: fmt.clock(ev.createdAt) }), h('div.data-sm.faint', { text: fmt.ago(ev.createdAt) })));
}

function cameraView(id) {
  const player = new LivePlayer(id);
  const side = h('div');
  const head = h('div');
  const events = h('div');
  let lastEventsVersion = -1;
  let probe = null, busy = false, confirmDelete = false, err = '';
  const drafts = new Map();

  const saveListeners = (list) => api.put(`/api/cameras/${id}/settings`, { listeners: list }).catch((e) => { err = e.message; update(); });

  async function loadEvents() {
    try {
      const list = await api.get(`/api/events?cameraId=${id}&limit=30`);
      events.replaceChildren(
        sectionHeader('Recent detections', h('span.data-sm', { text: `${list.length}` })),
        list.length ? h('div.strip', {}, list.map((ev) => h('div.tile', { onclick: () => openEvent(ev.id, null, list.map((e) => ({ eventId: e.id }))) },
          h('div.frame', {}, eventImg(ev.imageUrl), h('div.tl', {}, chip(fmt.kind(ev.kind), color.kind(ev.kind), true))),
          h('div.data-sm', { text: `${fmt.clock(ev.createdAt)} · ${fmt.pct(ev.confidence)}`, style: { marginTop: '4px' } }))))
          : h('p.faint', { text: 'Nothing detected yet.' }));
    } catch {}
  }

  function listenerPanel(c, base) {
    const l = drafts.get(base.kind) ?? base;
    const kc = color.kind(l.kind);
    const slider = (label, value, text, min, max, step, onInput) => {
      const out = h('span.data', { text, style: { color: l.enabled ? 'var(--cyan)' : 'var(--text-faint)' } });
      const input = h('input', { type: 'range', min, max, step, value, disabled: !l.enabled });
      input.addEventListener('input', () => { out.textContent = onInput(Number(input.value), false); });
      input.addEventListener('change', () => onInput(Number(input.value), true));
      return h('div.slider', {}, h('div.row', {}, h('span.label', { text: label }), out), input);
    };
    return h('div.glass' + (l.enabled ? '.brackets' : ''), { '--br': kc, '--bl': '8px', style: { marginBottom: '10px' } },
      h('div.title', { text: `${fmt.kind(l.kind)} detection`, style: { color: l.enabled ? kc : 'var(--text-dim)' } }),
      toggleRow('Detect', `Record ${l.label.toLowerCase()} events from this feed`, l.enabled, (on) => saveListeners([{ ...l, enabled: on }]), { c: kc }),
      toggleRow('Notify', `Send an alert for each new ${l.label.toLowerCase()}`, l.notify, (on) => saveListeners([{ ...l, notify: on }]), { c: kc, disabled: !l.enabled || !c.notificationsEnabled }),
      slider('Confidence threshold', Math.round(l.minConfidence * 100), fmt.pct(l.minConfidence), 20, 95, 1, (v, commit) => {
        const next = { ...l, minConfidence: v / 100 };
        if (commit) { drafts.delete(l.kind); saveListeners([next]); } else drafts.set(l.kind, next);
        return fmt.pct(v / 100);
      }),
      slider('Cooldown', l.cooldownSec, fmt.cooldown(l.cooldownSec), 0, 600, 10, (v, commit) => {
        const next = { ...l, cooldownSec: v };
        if (commit) { drafts.delete(l.kind); saveListeners([next]); } else drafts.set(l.kind, next);
        return fmt.cooldown(v);
      }));
  }

  function update() {
    const c = state.cameras.find((x) => x.id === id);
    if (!c) {
      if (state.cameras.length) head.replaceChildren(topbar('Camera', 'Removed', { back: '#/' }));
      return;
    }
    // Don't rebuild sliders mid-drag.
    if (document.activeElement?.type === 'range' && side.contains(document.activeElement)) return;
    const st = c.status ?? {};
    head.replaceChildren(topbar(c.name, `UNIT ${c.id.slice(0, 8).toUpperCase()}`, { back: '#/', actions: [chip(st.stream ?? '', color.stream(st.stream), true)] }));
    side.replaceChildren(
      sectionHeader('Alerts'),
      h('div.glass', {}, toggleRow('Notifications', 'Push alerts for this camera to your devices', c.notificationsEnabled, (on) => api.put(`/api/cameras/${id}/settings`, { notificationsEnabled: on }).catch((e) => { err = e.message; update(); }), { c: 'var(--amber)' })),
      sectionHeader('Detection listeners'),
      c.listeners.map((l) => listenerPanel(c, l)),
      sectionHeader('Link telemetry'),
      h('div.glass', {},
        kv([
          ['Stream', (st.stream ?? '').toUpperCase(), color.stream(st.stream)],
          ['Since', st.since ? `${fmt.stamp(st.since)} (${fmt.ago(st.since)})` : '—'],
          ['Tracks', (st.tracks ?? []).join(', ') || '—'],
          ['Viewers', `${st.readers ?? 0}`],
          ['Detector', (st.detector ?? 'off').toUpperCase(), color.detector(st.detector)],
          st.message ? ['Message', st.message, 'var(--amber)'] : null,
          ['Source', c.rtspUrl],
          ['Auth', c.hasCredentials ? 'STORED ON SERVER' : 'NONE'],
          ['Transport', c.transport.toUpperCase()],
        ]),
        h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '12px', flexWrap: 'wrap' } },
          btn(busy ? 'Testing…' : 'Test link', async () => {
            busy = true; update();
            probe = await api.post(`/api/cameras/${id}/test`).catch((e) => ({ ok: false, error: e.message }));
            busy = false; update();
          }, { disabled: busy }),
          probe ? h('span.data-sm', { text: probe.ok ? `OK · ${probe.video.codec.toUpperCase()} ${probe.video.width}x${probe.video.height} · ${probe.latencyMs}ms` : `FAIL · ${probe.error}`, style: { color: probe.ok ? 'var(--green)' : 'var(--red)' } }) : null)),
      err ? h('div.err', { text: err }) : null,
      sectionHeader('Unit'),
      h('div', { style: { display: 'flex', gap: '10px' } },
        btn(c.enabled ? 'Disable feed' : 'Enable feed', () => api.patch(`/api/cameras/${id}`, { enabled: !c.enabled }).catch((e) => { err = e.message; update(); }), { variant: 'amber' }),
        btn(confirmDelete ? 'Confirm remove' : 'Remove', async () => {
          if (!confirmDelete) { confirmDelete = true; return update(); }
          try { await api.del(`/api/cameras/${id}`); location.hash = '#/'; } catch (e) { err = e.message; update(); }
        }, { variant: 'red', primary: confirmDelete })));
    if (state.eventsVersion !== lastEventsVersion) { lastEventsVersion = state.eventsVersion; loadEvents(); }
  }

  const fs = btn('Fullscreen', () => player.el.requestFullscreen?.(), { small: true, variant: 'dim' });
  const el = h('div.fade-in', {}, head,
    h('main', {}, h('div.two-col', { style: { marginTop: '14px' } },
      h('div', {}, player.el, h('div', { style: { display: 'flex', justifyContent: 'flex-end', marginTop: '8px' } }, fs), events),
      side)));
  update();
  return { el, update, destroy: () => player.destroy() };
}

function alertsView() {
  let filter = 'all';
  let selecting = false, confirming = false, busy = false, err = '';
  const selected = new Set();
  const el = h('div.fade-in');
  const update = () => {
    const all = alertsSorted();
    const unread = all.filter((a) => !a.read).length;
    const shown = filter === 'all' ? all : filter === 'unread' ? all.filter((a) => !a.read) : all.filter((a) => a.cameraId === filter);
    const groups = new Map();
    shown.forEach((a) => { const d = fmt.day(a.createdAt); groups.set(d, [...(groups.get(d) ?? []), a]); });
    const f = (key, label, c) => chip(label, filter === key ? c : 'var(--text-dim)', filter === key, () => { filter = key; selected.clear(); confirming = false; update(); });
    for (const id of selected) if (!state.alerts.has(id)) selected.delete(id);
    const toggleSel = (id) => { selected.has(id) ? selected.delete(id) : selected.add(id); confirming = false; update(); };
    async function del() {
      if (!confirming) { confirming = true; return update(); }
      busy = true; update();
      try {
        await deleteEvents({ ids: [...selected].map((id) => state.alerts.get(id)?.eventId).filter(Boolean) });
        selected.clear(); selecting = false; err = '';
      } catch (e) { err = e.message; }
      busy = false; confirming = false; update();
    }
    el.replaceChildren(
      topbar('Alerts', `${unread} UNREAD · ${all.length} TOTAL`, { back: '#/', actions: [
        unread ? btn('Mark all read', () => markRead(all.filter((a) => !a.read).map((a) => a.id)), { variant: 'amber', small: true }) : null,
        all.length ? btn(selecting ? 'Done' : 'Select', () => { selecting = !selecting; selected.clear(); confirming = false; update(); }, { small: true, variant: selecting ? '' : 'dim' }) : null,
      ].filter(Boolean) }),
      h('main', {},
        h('div.filters', {}, f('all', 'All', 'var(--cyan)'), f('unread', `Unread ${unread}`, 'var(--amber)'), state.cameras.map((c) => f(c.id, c.name, 'var(--cyan)'))),
        selecting ? selectionBar({
          count: selected.size, loaded: shown.length, confirming, busy,
          onSelectAll: () => { shown.forEach((a) => selected.add(a.id)); confirming = false; update(); },
          onClear: () => { selected.clear(); confirming = false; update(); },
          onDelete: del,
        }) : null,
        err ? h('div.err', { text: err }) : null,
        shown.length ? [...groups].map(([day, list]) => [
          sectionHeader(day, h('span.data-sm', { text: `${list.length}` })),
          h('div.list', {}, list.map((a) => h('div.row-item' + (a.read ? '' : '.unread') + (selected.has(a.id) ? '.selected' : ''), { '--c': a.read ? 'var(--hairline-dim)' : 'var(--amber)', onclick: () => (selecting ? toggleSel(a.id) : openEvent(a.eventId, a.id, shown.map((x) => ({ eventId: x.eventId, alertId: x.id })))) },
            selecting ? checkbox(selected.has(a.id), () => toggleSel(a.id)) : null,
            h('span.stripe'), eventImg(a.imageUrl, 'thumb'),
            h('div.grow', {},
              h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, chip(fmt.kind(a.kind), color.kind(a.kind), !a.read), a.read ? null : h('span.data-sm.c-amber', { text: 'NEW' })),
              h('div.data', { text: a.cameraName.toUpperCase(), style: { marginTop: '4px', color: a.read ? 'var(--text-dim)' : null } }),
              h('div.data-sm', { text: `${a.label} ${fmt.pct(a.confidence)}` })),
            h('div.right', {}, h('div.data.dim', { text: fmt.clock(a.createdAt) }), h('div.data-sm.faint', { text: fmt.ago(a.createdAt) })))))])
          : empty(filter === 'unread' ? 'All clear' : 'No alerts', 'Detections from your cameras will appear here in real time.')));
  };
  update();
  return { el, update };
}

function eventView(eventId, alertId) {
  const el = h('div.fade-in');
  let ev = null, err = null, confirmDel = false;
  const seq = () => (eventSeq.some((x) => x.eventId === eventId) ? eventSeq : [{ eventId, alertId }]);
  const pos = () => seq().findIndex((x) => x.eventId === eventId);
  const go = (delta) => {
    const s = seq(), i = pos() + delta;
    if (i < 0 || i >= s.length) return;
    openEvent(s[i].eventId, s[i].alertId, null, true); // replace: Back still returns to the list
  };
  const onKey = (e) => {
    if (e.target.closest?.('input, textarea')) return;
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  };
  document.addEventListener('keydown', onKey);
  // Touch / pen swipe on the frame.
  let sx = null, sy = null;
  const swipe = {
    onpointerdown: (e) => { sx = e.clientX; sy = e.clientY; },
    onpointerup: (e) => {
      if (sx === null) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      sx = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 1 : -1);
    },
    style: { touchAction: 'pan-y', userSelect: 'none' },
  };
  if (alertId) markRead([alertId]);
  const update = () => {
    if (state.deleted?.has(eventId)) {
      el.replaceChildren(topbar('Event deleted', '', { back: '#/' }), h('main', {}, empty('Deleted', 'This event was deleted.')));
      return;
    }
    const a = alertId ? state.alerts.get(alertId) : null;
    const kind = ev?.kind ?? a?.kind ?? '';
    const kc = color.kind(kind);
    const camId = ev?.cameraId ?? a?.cameraId;
    el.replaceChildren(
      topbar(`${fmt.kind(kind)} detected`, [(ev?.cameraName ?? a?.cameraName ?? '').toUpperCase(), seq().length > 1 ? `${pos() + 1} / ${seq().length}` : ''].filter(Boolean).join(' · '), {
        back: alertId ? '#/alerts' : '#/',
        actions: seq().length > 1 ? [
          btn('‹ Prev', () => go(-1), { small: true, disabled: pos() <= 0 }),
          h('span.data-sm', { text: `${pos() + 1}/${seq().length}` }),
          btn('Next ›', () => go(1), { small: true, disabled: pos() >= seq().length - 1 }),
        ] : [],
      }),
      h('main', {}, h('div.two-col', { style: { marginTop: '14px' } },
        h('div.hero-img', swipe, (ev?.imageUrl ?? a?.imageUrl) ? h('img', { src: ev?.imageUrl ?? a?.imageUrl, alt: '' }) : h('div.center.label.faint', { text: 'NO FRAME' }), h('div.overlay-brackets.brackets', { '--br': kc, '--bl': '18px', '--bw': '2px', '--bi': '6px' })),
        h('div', {},
          h('div.glass.brackets', { '--br': kc, '--bl': '8px' },
            h('div.label', { text: '// TARGET', style: { color: kc, marginBottom: '8px' } }),
            ev ? kv([
              ['Class', `${fmt.kind(ev.kind)} (${ev.label})`, kc],
              ['Confidence', fmt.pct(ev.confidence)],
              ['Track', ev.trackId != null ? `#${ev.trackId}` : '—'],
              ['Camera', ev.cameraName],
              ['Time', fmt.stamp(ev.createdAt)],
              ['Age', fmt.ago(ev.createdAt)],
              ['Event', ev.id.slice(0, 8).toUpperCase()],
            ]) : h('div.data-sm', { text: err ?? 'Loading…' })),
          h('div', { style: { height: '14px' } }),
          camId ? btn('Go live ›', () => (location.hash = `#/cam/${camId}`), { primary: true, block: true }) : null,
          h('div', { style: { height: '10px' } }),
          btn(confirmDel ? 'Confirm delete event' : 'Delete event', async () => {
            if (!confirmDel) { confirmDel = true; return update(); }
            const s = seq(), i = pos();
            const next = s[i + 1] ?? s[i - 1];
            try {
              await deleteEvents({ ids: [eventId] });
              if (next) openEvent(next.eventId, next.alertId, null, true);
              else history.length > 1 ? history.back() : (location.hash = '#/');
            } catch (e) { err = e.message; confirmDel = false; update(); }
          }, { variant: 'red', primary: confirmDel, block: true })))));
  };
  api.get(`/api/events/${eventId}`).then((e) => { ev = e; update(); }).catch((e) => { err = e.message; update(); });
  update();
  return { el, update, destroy: () => document.removeEventListener('keydown', onKey) };
}

function setupView() {
  const f = { url: 'rtsp://', transport: 'automatic', user: '', pass: '', name: '', person: true, animal: false };
  let probe = null, testing = false, creating = false, err = '';
  const rail = h('div.steps');
  const result = h('div');
  const testBtn = btn('Run test', runTest);
  const deploy = btn('Deploy camera', create, { primary: true, block: true });
  const errEl = h('div.err');
  const invalidate = () => { probe = null; refresh(); };
  const input = (label, key, attrs = {}, onChange = invalidate) =>
    h('label.field', {}, h('span.label', { text: label }), h('input.input', { value: f[key], oninput: (e) => { f[key] = e.target.value; onChange(); }, ...attrs }));
  const seg = h('div.segmented', {}, [['automatic', 'AUTO'], ['tcp', 'TCP'], ['udp', 'UDP']].map(([v, t]) =>
    h('button', { 'aria-pressed': String(f.transport === v), onclick: (e) => { f.transport = v; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false')); e.target.setAttribute('aria-pressed', 'true'); invalidate(); } }, t)));
  const personRow = h('div'), animalRow = h('div');

  const urlOk = () => /^rtsps?:\/\/[^/\s]+/.test(f.url);
  function refresh() {
    const step = !urlOk() ? 1 : !probe?.ok ? 3 : !f.name.trim() ? 4 : 5;
    rail.replaceChildren(...['SRC', 'AUTH', 'TEST', 'ID', 'DET'].flatMap((label, i) => {
      const n = i + 1;
      const s = h('div.s' + (n < step ? '.done' : n === step ? '.cur' : ''), {}, h('i'), h('span.data-sm', { text: label, style: { color: 'inherit' } }));
      return i < 4 ? [s, h('div.ln' + (n < step ? '.done' : ''))] : [s];
    }));
    testBtn.disabled = !urlOk() || testing;
    testBtn.textContent = testing ? 'Testing…' : 'Run test';
    testBtn.className = 'btn' + (probe?.ok ? '' : ' primary brackets');
    result.replaceChildren(probe ? (probe.ok
      ? kv([['Result', 'SIGNAL ACQUIRED', 'var(--green)'], ['Video', `${probe.video.codec.toUpperCase()} ${probe.video.width}x${probe.video.height}${probe.video.fps ? ` @${probe.video.fps}fps` : ''}`], ['Latency', `${probe.latencyMs} ms`]])
      : h('div', {}, kv([['Result', 'NO SIGNAL', 'var(--red)']]), h('div.err', { text: probe.error }))) : '');
    result.parentElement?.style.setProperty('--br', probe ? (probe.ok ? 'var(--green)' : 'var(--red)') : 'transparent');
    deploy.disabled = !probe?.ok || !f.name.trim() || creating;
    deploy.textContent = creating ? 'Deploying…' : 'Deploy camera';
    errEl.textContent = err;
    personRow.replaceChildren(toggleRow('Human detection', 'Alert when a person is detected', f.person, (v) => { f.person = v; refresh(); }, { c: 'var(--red)' }));
    animalRow.replaceChildren(toggleRow('Animal detection', 'Dogs, cats, birds, wildlife', f.animal, (v) => { f.animal = v; refresh(); }, { c: 'var(--amber)' }));
  }
  async function runTest() {
    testing = true; refresh();
    probe = await api.post('/api/cameras/test', { rtspUrl: f.url.trim(), username: f.user || null, password: f.pass || null, transport: f.transport }).catch((e) => ({ ok: false, error: e.message }));
    testing = false; refresh();
  }
  async function create() {
    creating = true; err = ''; refresh();
    try {
      const cam = await api.post('/api/cameras', { name: f.name.trim(), rtspUrl: f.url.trim(), username: f.user || null, password: f.pass || null, transport: f.transport, skipTest: true });
      await api.put(`/api/cameras/${cam.id}/settings`, { listeners: cam.listeners.map((l) => ({ ...l, enabled: l.kind === 'person' ? f.person : l.kind === 'animal' ? f.animal : l.enabled })) });
      location.hash = `#/cam/${cam.id}`;
    } catch (e) {
      err = e.message;
    }
    creating = false; refresh();
  }
  const el = h('div.fade-in', {},
    topbar('Add camera', 'DEPLOY NEW SENSOR', { back: '#/' }),
    h('main', { style: { maxWidth: '760px' } },
      rail,
      sectionHeader('01 · Source'),
      h('div.glass', {}, input('RTSP URL', 'url', { placeholder: 'rtsp://192.168.1.50:554/stream1', spellcheck: 'false' }),
        h('div.data-sm.faint', { text: 'Credentials in the URL are moved to secure server storage.' }),
        h('div.label', { text: 'Transport', style: { margin: '12px 0 6px' } }), seg),
      sectionHeader('02 · Authentication'),
      h('div.glass', {}, h('div.data-sm.faint', { text: 'Optional. Stored encrypted on the server, never sent back to clients.' }),
        input('Username', 'user', { autocomplete: 'off' }), input('Password', 'pass', { type: 'password', autocomplete: 'new-password' })),
      sectionHeader('03 · Link test'),
      h('div.glass.brackets', { '--br': 'transparent', '--bl': '8px' }, testBtn, h('div', { style: { height: '10px' } }), result),
      sectionHeader('04 · Identify'),
      h('div.glass', {}, input('Camera name', 'name', { placeholder: 'Driveway', maxlength: '64' }, refresh)),
      sectionHeader('05 · Detection listeners'),
      h('div.glass', {}, personRow, animalRow, h('div.data-sm.faint', { text: 'Thresholds and cooldowns can be tuned per camera after deployment.' })),
      errEl, h('div', { style: { height: '16px' } }), deploy));
  refresh();
  return { el };
}

function systemView() {
  const el = h('div.fade-in');
  const devices = h('div');
  api.get('/api/devices').then((list) => devices.replaceChildren(h('div.list', {}, list.map((d) => h('div.row-item', { '--c': d.id === store.get('device') ? 'var(--cyan)' : 'var(--hairline)', style: { cursor: 'default' } },
    h('span.stripe'),
    h('div.grow', {}, h('div.data', { text: `${d.name}${d.id === store.get('device') ? ' (this console)' : ''}` }), h('div.data-sm', { text: `${d.platform.toUpperCase()} · ${d.id.slice(0, 8).toUpperCase()}` })),
    h('div.right', {}, h('div.data-sm', { text: d.lastSeenAt ? `SEEN ${fmt.ago(d.lastSeenAt)}` : '' }))))))).catch(() => {});
  const update = () => el.replaceChildren(
    topbar('System', 'CONSOLE STATUS', { back: '#/' }),
    h('main', { style: { maxWidth: '760px' } },
      sectionHeader('Uplink'),
      h('div.glass', {},
        h('div.kv', {}, h('span.label', { text: 'WebSocket' }), linkIndicator()),
        kv([['Server', location.origin], ['Device', (store.get('device') ?? '—').slice(0, 8).toUpperCase()], ['Cameras', `${state.cameras.length}`], ['Alerts', `${state.alerts.size} (${unreadCount()} unread)`]]),
        h('div', { style: { marginTop: '12px' } }, btn('Reconnect', () => { clearTimeout(rt.timer); rt.ws?.close(); rt.attempt = 0; if (!rt.ws) rt.connect(); }))),
      sectionHeader('Paired devices'), devices,
      sectionHeader('Session'), btn('Sign out', signOut, { variant: 'red' }),
      h('p.faint', { text: 'Alerts arrive over a persistent WebSocket. Each is acknowledged on receipt and marked read when opened; the server retries until it hears back, so nothing is lost while this console is closed.', style: { marginTop: '24px' } })));
  update();
  return { el, update };
}

/**
 * Live wall: every enabled camera playing live at once. Players are kept across
 * status updates (only added/removed as cameras come and go) so video never restarts.
 */
function galleryView() {
  const players = new Map(); // cameraId -> { player, tile, nameEl, pipEl }
  let layout = store.get('wall.layout') ?? 'auto';
  let wallMode = false;
  const wall = h('div.wall');
  const head = h('div');
  const shell = h('div');
  const emptyEl = h('div');

  function applyLayout() {
    wall.className = 'wall' + (layout === 'auto' ? ' auto' : '');
    wall.style.setProperty('--cols', layout === 'auto' ? '' : layout);
    if (wallMode) {
      const n = players.size, cols = layout === 'auto' ? Math.ceil(Math.sqrt(n)) : Number(layout);
      wall.className = 'wall';
      wall.style.setProperty('--cols', String(cols || 1));
      wall.style.gridAutoRows = `${100 / Math.max(1, Math.ceil(n / (cols || 1)))}vh`;
    } else wall.style.gridAutoRows = '';
  }

  function tileFor(c) {
    const player = new LivePlayer(c.id);
    const nameEl = h('div.title', { text: c.name });
    const sub = h('div.data-sm');
    const tile = h('div.tile', {},
      player.el,
      h('div.name', { onclick: () => (location.hash = `#/cam/${c.id}`), title: 'Open camera' }, nameEl, sub),
      h('div.tools', {},
        btn('Open', () => (location.hash = `#/cam/${c.id}`), { small: true }),
        btn('Full', () => player.el.requestFullscreen?.(), { small: true, variant: 'dim' })));
    return { player, tile, nameEl, sub };
  }

  function update() {
    const cams = state.cameras.filter((c) => c.enabled);
    // add / remove players without touching the ones already playing
    for (const [id, p] of players) if (!cams.some((c) => c.id === id)) { p.player.destroy(); p.tile.remove(); players.delete(id); }
    cams.forEach((c) => {
      let p = players.get(c.id);
      if (!p) { p = tileFor(c); players.set(c.id, p); }
      wall.append(p.tile); // keeps camera order
      p.nameEl.textContent = c.name;
      const st = c.status ?? {};
      p.sub.textContent = `${(st.stream ?? '').toUpperCase()}${st.detector === 'running' ? ' · DET' : ''}`;
      p.sub.style.color = color.stream(st.stream);
      p.tile.classList.toggle('offline', st.stream !== 'online' && st.stream !== 'connecting');
    });
    applyLayout();
    const online = cams.filter((c) => c.status?.stream === 'online').length;
    const seg = h('div.segmented', {}, [['auto', 'AUTO'], ['1', '1×'], ['2', '2×'], ['3', '3×'], ['4', '4×']].map(([v, t]) =>
      h('button', { 'aria-pressed': String(layout === v), onclick: () => { layout = v; store.set('wall.layout', v); update(); } }, t)));
    head.replaceChildren(wallMode ? '' : topbar('Live wall', `${online}/${cams.length} ONLINE · ${players.size} FEEDS`, { back: '#/', actions: [linkIndicator(), seg, btn('Wall mode', enterWall, { small: true })] }));
    emptyEl.replaceChildren(cams.length ? '' : empty('No cameras', 'Add a camera to see it here.', btn('+ Add camera', () => (location.hash = '#/add'), { primary: true })));
  }

  // Wall mode: browser fullscreen, every feed tiled to fit the screen, no chrome.
  function enterWall() {
    wallMode = true;
    shell.className = 'wall-full';
    shell.requestFullscreen?.().catch(() => {});
    update();
  }
  const onFs = () => { if (!document.fullscreenElement && wallMode) { wallMode = false; shell.className = ''; update(); } };
  document.addEventListener('fullscreenchange', onFs);
  const onKey = (e) => { if (e.key === 'Escape' && wallMode) { wallMode = false; shell.className = ''; update(); } };
  document.addEventListener('keydown', onKey);

  shell.append(wall);
  const el = h('div.fade-in', {}, head, h('main', { style: { maxWidth: 'none', paddingTop: '12px' } }, emptyEl, shell));
  update();
  return {
    el, update,
    destroy: () => {
      players.forEach((p) => p.player.destroy());
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    },
  };
}

/** Event history across cameras: filter, select, select all (server-side), delete. */
function eventsView() {
  let cameraId = '', kind = '';
  let items = [], loading = false, done = false, lastVersion = state.eventsVersion;
  let selecting = false, allMatching = false, confirming = false, busy = false, err = '';
  const selected = new Set();
  const el = h('div.fade-in');

  async function load(reset) {
    if (loading) return;
    loading = true;
    if (reset) { items = []; done = false; }
    try {
      const q = new URLSearchParams({ limit: '100' });
      if (cameraId) q.set('cameraId', cameraId);
      if (kind) q.set('kind', kind);
      if (!reset && items.length) q.set('before', String(items[items.length - 1].createdAt));
      const page = await api.get(`/api/events?${q}`);
      items = reset ? page : items.concat(page.filter((e) => !items.some((x) => x.id === e.id)));
      done = page.length < 100;
      err = '';
    } catch (e) { err = e.message; }
    loading = false;
    update();
  }

  const clearSel = () => { selected.clear(); allMatching = false; confirming = false; };
  const toggleSel = (id) => {
    if (allMatching) { allMatching = false; items.forEach((e) => selected.add(e.id)); }
    selected.has(id) ? selected.delete(id) : selected.add(id);
    confirming = false; update();
  };
  async function del() {
    if (!confirming) { confirming = true; return update(); }
    busy = true; update();
    try {
      const n = await deleteEvents(allMatching ? { all: true, ...(cameraId ? { cameraId } : {}), ...(kind ? { kind } : {}) } : { ids: [...selected] });
      toast2(`${n} event${n === 1 ? '' : 's'} deleted`);
      clearSel(); selecting = false;
      await load(true);
    } catch (e) { err = e.message; }
    busy = false; confirming = false; update();
  }

  function update() {
    if (state.deleted) items = items.filter((e) => !state.deleted.has(e.id));
    if (state.eventsVersion !== lastVersion && !selecting) { lastVersion = state.eventsVersion; load(true); }
    const sel = (key, val, label, c = 'var(--cyan)') => chip(label, val === key ? c : 'var(--text-dim)', val === key, () => {});
    const camChip = (id, label) => { const c = sel(id, cameraId, label); c.onclick = () => { cameraId = id; clearSel(); load(true); }; return c; };
    const kindChip = (k, label) => { const c = sel(k, kind, label, k ? color.kind(k) : 'var(--cyan)'); c.onclick = () => { kind = k; clearSel(); load(true); }; return c; };
    const isSel = (id) => allMatching || selected.has(id);
    el.replaceChildren(
      topbar('Events', `${items.length}${done ? '' : '+'} LOADED`, { back: '#/', actions: [
        items.length ? btn(selecting ? 'Done' : 'Select', () => { selecting = !selecting; clearSel(); update(); }, { small: true, variant: selecting ? '' : 'dim' }) : null,
      ].filter(Boolean) }),
      h('main', {},
        h('div.toolbar', {}, h('span.label', { text: 'Camera' }), camChip('', 'All'), state.cameras.map((c) => camChip(c.id, c.name))),
        h('div.toolbar', { style: { marginTop: '-4px' } }, h('span.label', { text: 'Class' }), kindChip('', 'All'), kindChip('person', 'Human'), kindChip('animal', 'Animal')),
        selecting ? selectionBar({
          count: selected.size, loaded: items.length, allMatching, confirming, busy,
          onSelectAll: () => { allMatching = true; selected.clear(); confirming = false; update(); },
          onClear: () => { clearSel(); update(); },
          onDelete: del,
        }) : null,
        allMatching && !done ? h('div.data-sm.c-amber', { text: 'Includes events not loaded yet: everything matching these filters will be deleted.', style: { marginBottom: '8px' } }) : null,
        err ? h('div.err', { text: err }) : null,
        items.length ? h('div.list', {}, items.map((ev) => h('div.row-item' + (selecting && isSel(ev.id) ? '.selected' : ''), { '--c': color.kind(ev.kind), onclick: () => (selecting ? toggleSel(ev.id) : openEvent(ev.id, null, items.map((e) => ({ eventId: e.id })))) },
          selecting ? checkbox(isSel(ev.id), () => toggleSel(ev.id)) : null,
          h('span.stripe'), eventImg(ev.imageUrl, 'thumb'),
          h('div.grow', {},
            h('div.data', { text: `${fmt.kind(ev.kind)} · ${ev.cameraName.toUpperCase()}` }),
            h('div.data-sm', { text: `${ev.label} ${fmt.pct(ev.confidence)}${ev.trackId != null ? ` · TRK #${ev.trackId}` : ''}` })),
          h('div.right', {}, h('div.data.dim', { text: fmt.stamp(ev.createdAt) }), h('div.data-sm.faint', { text: fmt.ago(ev.createdAt) })))))
          : loading ? h('p.faint', { text: 'Loading…' }) : empty('No events', 'Nothing matches these filters.'),
        !done && items.length ? h('div', { style: { textAlign: 'center', marginTop: '14px' } }, btn(loading ? 'Loading…' : 'Load more', () => load(false), { disabled: loading })) : null));
  }
  load(true);
  update();
  return { el, update };
}

/** Small neutral confirmation toast. */
function toast2(text) {
  const el = h('div.toast', { style: { borderColor: 'rgba(56,225,255,0.45)' } }, h('span.data.c-cyan', { text }));
  $toasts.prepend(el);
  setTimeout(() => el.remove(), 3500);
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------
function route() {
  const [path, query] = location.hash.replace(/^#/, '').split('?');
  const parts = (path || '/').split('/').filter(Boolean);
  const q = new URLSearchParams(query ?? '');
  if (parts[0] === 'cam' && parts[1]) return { name: 'cam', key: `cam:${parts[1]}`, make: () => cameraView(parts[1]) };
  if (parts[0] === 'event' && parts[1]) return { name: 'event', key: `event:${parts[1]}`, make: () => eventView(parts[1], q.get('alert')) };
  if (parts[0] === 'live') return { name: 'live', key: 'live', make: galleryView };
  if (parts[0] === 'events') return { name: 'events', key: 'events', make: eventsView };
  if (parts[0] === 'alerts') return { name: 'alerts', key: 'alerts', make: alertsView };
  if (parts[0] === 'add') return { name: 'add', key: 'add', make: setupView };
  if (parts[0] === 'sys') return { name: 'sys', key: 'sys', make: systemView };
  return { name: 'dash', key: 'dash', make: dashboardView };
}

let current = null;
function render() {
  const r = state.signedIn ? route() : { name: 'login', key: 'login', make: loginView };
  if (current?.key === r.key) return current.view.update?.();
  current?.view.destroy?.();
  current = { key: r.key, view: r.make() };
  $app.replaceChildren(current.view.el);
  window.scrollTo(0, 0);
}
listeners.add(() => {
  render();
  document.title = unreadCount() ? `(${unreadCount()}) Apex Security Console` : 'Apex Security Console';
});
window.addEventListener('hashchange', render);

render();
if (state.signedIn) rt.start();
