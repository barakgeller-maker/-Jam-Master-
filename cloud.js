// Jam Master cloud: optional sign-in and sync through Supabase.
// Signed out, nothing here runs and the app stays fully local. Signed in, jams, lists and
// song/sheet files are copied to the user's private space, so they open on any phone.
(function () {
  'use strict';
  const URL = 'https://twzcygfdfieyvaeisgdv.supabase.co';
  const KEY = 'sb_publishable_210hEIzum3odH-xlbu7s9Q_iJKPKp7Y';
  const TOKEN = 'sb-twzcygfdfieyvaeisgdv-auth-token';
  const BUCKET = 'files';
  const LIB = 'vendor/supabase-2.118.0.js';
  // settings that follow the user between phones (latency, the open list and diagnostics stay per phone)
  const isStateKey = k => k === 'lists' || k === 'myInstrument' || k === 'hiddenDemos' || /^(name|sync)\.demo-/.test(k);

  const L = {
    get(k, d) { try { const v = localStorage.getItem('jm.cloud.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { if (v == null) localStorage.removeItem('jm.cloud.' + k); else localStorage.setItem('jm.cloud.' + k, JSON.stringify(v)); } catch (e) { } }
  };
  const hasToken = () => { try { return !!localStorage.getItem(TOKEN); } catch (e) { return false; } };

  let app = null, sb = null, user = null, ready = null;
  let syncing = false, again = false, timer = null, lastErr = null;
  const subs = [];
  const emit = () => subs.forEach(f => { try { f(); } catch (e) { } });

  function loadLib() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = LIB; s.onload = res; s.onerror = () => rej(new Error('offline')); document.head.appendChild(s); });
  }
  function client() {
    if (!ready) ready = (async () => {
      await loadLib();
      sb = window.supabase.createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } });
      const { data } = await sb.auth.getSession();
      user = data && data.session ? data.session.user : null;
      sb.auth.onAuthStateChange((ev, s) => {
        const was = user && user.id; user = s ? s.user : null;
        // never call Supabase inside this callback (it can deadlock); do it right after
        if (user && user.id !== was) setTimeout(() => sync(), 0);
        emit();
      });
      return sb;
    })().catch(e => { ready = null; throw e; });
    return ready;
  }

  // ---------- what changed on this phone since the last sync ----------
  const dirty = () => L.get('dirty', { jams: {}, blobs: {}, state: false });
  function markDirty(fn) { const d = dirty(); fn(d); L.set('dirty', d); }
  // called by the app's storage on every local write (not for writes made by the sync itself)
  function touch(kind, key, val) {
    if (!hasToken() && !user) return;
    if (kind === 'jams') markDirty(d => d.jams[key] = val === undefined ? 'del' : 1);
    else if (kind === 'blobs') markDirty(d => d.blobs[key] = val === undefined ? 'del' : 1);
    else if (kind === 'state') { if (!isStateKey(key)) return; markDirty(d => d.state = true); L.set('stateT', Date.now()); }
    else return;
    soon(3000);
  }
  function soon(ms) { clearTimeout(timer); timer = setTimeout(() => sync(), ms); }

  const pathOf = key => user.id + '/' + key.replace(/[^A-Za-z0-9._-]/g, '_');
  const jamOfBlob = key => key.split(':')[1];

  function stateNow() {
    const v = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('jm.') && isStateKey(k.slice(3))) v[k.slice(3)] = app.Settings.get(k.slice(3), null); }
    return v;
  }
  function mergeLists(a, b) { // union by list id; a jam stays in every list it was in on either phone
    const out = (a || []).map(x => ({ ...x, jams: [...x.jams] }));
    for (const x of b || []) {
      const y = out.find(o => o.id === x.id);
      if (y) x.jams.forEach(j => { if (!y.jams.includes(j)) y.jams.push(j); });
      else out.push({ ...x, jams: [...x.jams] });
    }
    return out;
  }

  // ---------- the sync itself: pull, apply what is newer, push what is ours ----------
  async function sync() {
    if (!user || !navigator.onLine) return;
    if (syncing) { again = true; return; }
    syncing = true; lastErr = null; emit();
    let changed = false;
    try {
      const uid = user.id, firstKey = 'synced.' + uid, first = !L.get(firstKey, false);
      const { data: rows, error } = await sb.from('items').select('kind,id,data,deleted,updated_at').limit(5000);
      if (error) throw error;
      const remote = { jam: {}, state: null };
      rows.forEach(r => { if (r.kind === 'jam') remote.jam[r.id] = r; else if (r.kind === 'state' && r.id === 'main') remote.state = r; });
      const d = dirty();
      const local = await app.DB.all('jams').catch(() => []);
      const localById = Object.fromEntries(local.map(j => [j.id, j]));

      // jams: newer side wins; deletions travel as tombstones
      for (const id in remote.jam) {
        const r = remote.jam[id], mine = localById[id];
        if (d.jams[id]) continue; // our own change is pushed below
        if (r.deleted) {
          if (mine && (mine.updatedAt || 0) <= (r.data.t || 0)) { await app.removeJamLocal(id); changed = true; }
        } else if (!mine || (r.data.updatedAt || 0) > (mine.updatedAt || 0)) { await app.DB.put('jams', r.data, undefined, true); changed = true; }
      }
      const push = [];
      for (const j of local) {
        const r = remote.jam[j.id], t = j.updatedAt || 0;
        if (d.jams[j.id] === 1 || !r || t > ((r.deleted ? r.data.t : r.data.updatedAt) || 0)) push.push(j);
      }
      for (const id in d.jams) if (d.jams[id] === 'del') push.push({ id, _del: true });

      // settings and lists
      let pushState = false; const stateT0 = L.get('stateT', 0);
      const rs = remote.state && remote.state.data;
      if (rs && first) {
        const mineV = stateNow(), v = { ...rs.v, ...mineV };
        v.lists = mergeLists(rs.v.lists, mineV.lists);
        v.hiddenDemos = (mineV.hiddenDemos || []).filter(x => (rs.v.hiddenDemos || []).includes(x));
        if (rs.v.myInstrument) v.myInstrument = mineV.myInstrument || rs.v.myInstrument;
        for (const k in v) app.Settings.set(k, v[k], true);
        changed = true; pushState = true;
      } else if (rs && !d.state && (rs.t || 0) > L.get('stateT', 0)) {
        for (const k in rs.v) app.Settings.set(k, rs.v[k], true);
        L.set('stateT', rs.t); changed = true;
      } else if (!rs || d.state) pushState = true;

      // upload
      const now = new Date().toISOString();
      const up = push.map(j => j._del ? { user_id: uid, kind: 'jam', id: j.id, data: { t: Date.now() }, deleted: true, updated_at: now }
        : { user_id: uid, kind: 'jam', id: j.id, data: { ...j, updatedAt: j.updatedAt || Date.now() }, deleted: false, updated_at: now });
      if (pushState) { const t = L.get('stateT', 0) || Date.now(); L.set('stateT', t); up.push({ user_id: uid, kind: 'state', id: 'main', data: { t, v: stateNow() }, deleted: false, updated_at: now }); }
      for (let i = 0; i < up.length; i += 20) { const { error: e2 } = await sb.from('items').upsert(up.slice(i, i + 20)); if (e2) throw e2; }

      // files: upload what the cloud doesn't have yet, remove files of deleted jams
      const { data: list, error: e3 } = await sb.storage.from(BUCKET).list(uid, { limit: 1000 });
      if (e3) throw e3;
      const have = new Set((list || []).map(f => uid + '/' + f.name));
      const gone = new Set(Object.keys(remote.jam).filter(id => remote.jam[id].deleted && !d.jams[id]).concat(Object.keys(d.jams).filter(id => d.jams[id] === 'del')));
      const keys = await app.DB.blobKeys().catch(() => []);
      for (const k of keys) {
        if (gone.has(jamOfBlob(k)) || have.has(pathOf(k))) continue;
        const b = await app.DB.get('blobs', k); if (!b) continue;
        const { error: e4 } = await sb.storage.from(BUCKET).upload(pathOf(k), b, { upsert: true, contentType: b.type || 'application/octet-stream' });
        if (e4) throw e4;
      }
      const delPaths = new Set(Object.keys(d.blobs).filter(k => d.blobs[k] === 'del').map(pathOf));
      const rm = [...have].filter(p => gone.has(p.split('/')[1].split('_')[1]) || delPaths.has(p));
      if (rm.length) await sb.storage.from(BUCKET).remove(rm);

      // everything that was dirty when we started is now in the cloud
      markDirty(cur => {
        for (const id in d.jams) if (cur.jams[id] === d.jams[id]) delete cur.jams[id];
        for (const k in d.blobs) if (cur.blobs[k] === d.blobs[k]) delete cur.blobs[k];
        if (d.state && L.get('stateT', 0) === stateT0) cur.state = false;
      });
      L.set(firstKey, true); L.set('last', Date.now());
    } catch (e) { console.warn('cloud sync', e); lastErr = String(e && e.message || e); }
    syncing = false; emit();
    if (changed && app.refresh) app.refresh();
    if (again) { again = false; soon(500); }
  }

  // a song recorded on another phone: fetch it the first time it is needed
  async function fetchBlob(key) {
    if (!hasToken()) return null;
    try {
      await client(); if (!user) return null;
      const { data, error } = await sb.storage.from(BUCKET).download(pathOf(key));
      if (error || !data) return null;
      await app.DB.put('blobs', data, key, true);
      return data;
    } catch (e) { return null; }
  }

  window.Cloud = {
    init(a) {
      app = a;
      const fromLink = /[?&]code=/.test(location.search);
      if (hasToken() || fromLink) client().then(() => { if (fromLink) history.replaceState(null, '', location.pathname + location.hash); if (user) sync(); emit(); }).catch(() => { });
      window.addEventListener('online', () => soon(500));
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && user) soon(800); });
    },
    touch, sync, fetchBlob,
    onChange(f) { subs.push(f); return () => { const i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1); }; },
    info() { return { user: user ? { email: user.email } : null, maybe: hasToken(), syncing, last: L.get('last', 0), error: lastErr, pending: (() => { const d = dirty(); return Object.keys(d.jams).length + Object.keys(d.blobs).length + (d.state ? 1 : 0); })() }; },
    async sendCode(email) {
      await client();
      const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
      if (error) throw error;
    },
    async verifyCode(email, token) {
      await client();
      const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
      if (error) throw error;
    },
    async google() {
      await client();
      const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
      if (error) throw error;
    },
    async signOut() {
      await client().catch(() => { });
      const uid = user && user.id;
      try { await sb.auth.signOut({ scope: 'local' }); } catch (e) { }
      try { localStorage.removeItem(TOKEN); } catch (e) { }
      if (uid) L.set('synced.' + uid, null);
      L.set('dirty', null); user = null; emit();
    }
  };
})();
