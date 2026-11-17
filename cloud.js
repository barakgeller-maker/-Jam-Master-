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

  let app = null, sb = null, user = null, ready = null, loadFailed = false;
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
  const dirty = () => { const d = L.get('dirty', null) || {}; return { jams: d.jams || {}, blobs: d.blobs || {}, takes: d.takes || {}, state: !!d.state }; };
  function markDirty(fn) { const d = dirty(); fn(d); L.set('dirty', d); }
  // called by the app's storage on every local write (not for writes made by the sync itself)
  function touch(kind, key, val) {
    if (!hasToken() && !user) return;
    if (kind === 'jams') markDirty(d => d.jams[key] = val === undefined ? 'del' : 1);
    else if (kind === 'blobs') markDirty(d => d.blobs[key] = val === undefined ? 'del' : 1);
    else if (kind === 'takes') markDirty(d => d.takes[key] = val === undefined ? 'del' : 1);
    else if (kind === 'state') { if (!isStateKey(key)) return; markDirty(d => d.state = true); L.set('stateT', Date.now()); }
    else return;
    soon(3000);
  }
  function soon(ms) { clearTimeout(timer); timer = setTimeout(() => sync(), ms); }

  const pathOf = key => user.id + '/' + key.replace(/[^A-Za-z0-9._-]/g, '_');
  const takePath = id => user.id + '/take_' + id;
  // recordings travel as 16-bit mono at 22 kHz: about 2.6 MB a minute instead of 11
  const TAKE_SR = 22050;
  async function packTake(t) {
    const f = new Float32Array(await t.pcm.arrayBuffer()), ratio = t.sr / TAKE_SR, n = Math.floor(f.length / ratio);
    const o = new Int16Array(n), h = Math.max(1, Math.round(ratio / 2));
    for (let i = 0; i < n; i++) {
      const c = Math.round(i * ratio), a = Math.max(0, c - h + 1), b = Math.min(f.length, c + h); let sum = 0;
      for (let k = a; k < b; k++) sum += f[k];
      const v = sum / Math.max(1, b - a); o[i] = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
    }
    return new Blob([o.buffer], { type: 'application/octet-stream' });
  }
  async function listAll(uid) { // the storage listing comes in pages
    const out = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await sb.storage.from(BUCKET).list(uid, { limit: 1000, offset: off });
      if (error) throw error;
      out.push(...(data || [])); if (!data || data.length < 1000) return out;
    }
  }
  const jamOfBlob = key => key.split(':')[1];
  // Postgres refuses the \u0000 character inside JSON (it can come from text read out of a PDF)
  const clean = v => JSON.parse(JSON.stringify(v).replace(/\\u0000/g, ''));
  // the newest change in the cloud, a tiny request used to notice changes made on another device
  async function latest() {
    const { data, error } = await sb.from('items').select('updated_at').order('updated_at', { ascending: false }).limit(1);
    if (error) throw error;
    return data && data[0] ? data[0].updated_at : null;
  }
  // while the app is open, look every 15 seconds whether another device changed something
  async function poll() {
    if (!user || syncing || !navigator.onLine || document.visibilityState !== 'visible') return;
    try { const t = await latest(); if (t !== L.get('seen', null)) sync(); } catch (e) { }
  }

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
    let changed = false, fileErr = null; const failed = new Set();
    try {
      const uid = user.id, firstKey = 'synced.' + uid, first = !L.get(firstKey, false);
      const rows = []; // the server hands rows out 1000 at a time
      for (let off = 0; ; off += 1000) {
        const { data, error } = await sb.from('items').select('kind,id,data,deleted,updated_at').order('kind').order('id').range(off, off + 999);
        if (error) throw error;
        rows.push(...data); if (data.length < 1000) break;
      }
      const remote = { jam: {}, take: {}, state: null };
      rows.forEach(r => { if (r.kind === 'jam') remote.jam[r.id] = r; else if (r.kind === 'take') remote.take[r.id] = r; else if (r.kind === 'state' && r.id === 'main') remote.state = r; });
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

      // recordings: the report travels as a row, the sound as a compact file fetched when opened
      const localTakes = await app.DB.all('takes').catch(() => []);
      const ltById = Object.fromEntries(localTakes.map(t => [t.id, t]));
      for (const id in remote.take) {
        const r = remote.take[id], mine = ltById[id];
        if (d.takes[id]) continue;
        if (r.deleted) { if (mine) { await app.DB.del('takes', id, true); changed = true; } }
        else if (!mine) { await app.DB.put('takes', { ...r.data, pcm: null }, undefined, true); changed = true; }
        else if (r.data.audioGone && !mine.audioGone) { mine.pcm = null; mine.audioGone = true; await app.DB.put('takes', mine, undefined, true); }
      }
      const pushTakes = localTakes.filter(t => d.takes[t.id] === 1 || !remote.take[t.id]);
      for (const id in d.takes) if (d.takes[id] === 'del') pushTakes.push({ id, _del: true });

      // upload
      const now = new Date().toISOString();
      const up = push.map(j => j._del ? { user_id: uid, kind: 'jam', id: j.id, data: { t: Date.now() }, deleted: true, updated_at: now }
        : { user_id: uid, kind: 'jam', id: j.id, data: { ...j, updatedAt: j.updatedAt || Date.now() }, deleted: false, updated_at: now });
      for (const t of pushTakes) {
        if (t._del) { up.push({ user_id: uid, kind: 'take', id: t.id, data: {}, deleted: true, updated_at: now }); continue; }
        const { pcm, ...meta } = t; up.push({ user_id: uid, kind: 'take', id: t.id, data: meta, deleted: false, updated_at: now });
      }
      if (pushState) { const t = L.get('stateT', 0) || Date.now(); L.set('stateT', t); up.push({ user_id: uid, kind: 'state', id: 'main', data: { t, v: stateNow() }, deleted: false, updated_at: now }); }
      up.forEach(r => { r.data = clean(r.data); });
      for (let i = 0; i < up.length; i += 20) { const { error: e2 } = await sb.from('items').upsert(up.slice(i, i + 20)); if (e2) throw e2; }

      // files: upload what the cloud doesn't have yet, remove files of deleted jams
      const list = await listAll(uid);
      const have = new Set((list || []).map(f => uid + '/' + f.name));
      const gone = new Set(Object.keys(remote.jam).filter(id => remote.jam[id].deleted && !d.jams[id]).concat(Object.keys(d.jams).filter(id => d.jams[id] === 'del')));
      const keys = await app.DB.blobKeys().catch(() => []);
      for (const k of keys) {
        if (gone.has(jamOfBlob(k)) || have.has(pathOf(k))) continue;
        const b = await app.DB.get('blobs', k); if (!b) continue;
        const { error: e4 } = await sb.storage.from(BUCKET).upload(pathOf(k), b, { upsert: true, contentType: b.type || 'application/octet-stream' });
        if (e4) { fileErr = fileErr || e4; failed.add('b:' + k); }
      }
      for (const t of pushTakes) {
        if (t._del || !t.pcm || t.audioGone || have.has(takePath(t.id))) continue;
        const { error: e5 } = await sb.storage.from(BUCKET).upload(takePath(t.id), await packTake(t), { upsert: true, contentType: 'application/octet-stream' });
        if (e5) { fileErr = fileErr || e5; failed.add('t:' + t.id); }
      }
      const delPaths = new Set(Object.keys(d.blobs).filter(k => d.blobs[k] === 'del').map(pathOf));
      pushTakes.forEach(t => { if (t._del || t.audioGone) delPaths.add(takePath(t.id)); });
      Object.keys(remote.take).forEach(id => { const r = remote.take[id]; if (r.deleted || r.data.audioGone) delPaths.add(takePath(id)); });
      const rm = [...have].filter(p => gone.has(p.split('/')[1].split('_')[1]) || delPaths.has(p));
      if (rm.length) await sb.storage.from(BUCKET).remove(rm);

      // everything that was dirty when we started is now in the cloud
      markDirty(cur => {
        for (const id in d.jams) if (cur.jams[id] === d.jams[id]) delete cur.jams[id];
        for (const k in d.blobs) if (cur.blobs[k] === d.blobs[k]) delete cur.blobs[k];
        for (const k in d.takes) if (cur.takes[k] === d.takes[k] && !failed.has('t:' + k)) delete cur.takes[k];
        if (d.state && L.get('stateT', 0) === stateT0) cur.state = false;
      });
      L.set(firstKey, true); L.set('last', Date.now());
      L.set('seen', await latest().catch(() => null));
      if (fileErr) throw fileErr;
    } catch (e) { console.warn('cloud sync', e); lastErr = String(e && (e.message || e.error) || e); }
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

  // ---------- sharing a jam with the band: a link anyone can open, no account needed to receive ----------
  const YEAR = 365 * 24 * 3600;
  async function share(jam) {
    await client(); if (!user) throw new Error('signin');
    // make sure this jam's files are in the cloud before handing out links to them
    const keys = (await app.DB.blobKeys().catch(() => [])).filter(k => k.split(':')[1] === jam.id && !/:pdf$/.test(k) && /^audio:/.test(k));
    const { data: list } = await sb.storage.from(BUCKET).list(user.id, { limit: 1000 });
    const have = new Set((list || []).map(f => user.id + '/' + f.name));
    const code = Array.from(crypto.getRandomValues(new Uint8Array(9)), b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
    const files = [];
    for (const k of keys) {
      if (!have.has(pathOf(k))) {
        const b = await app.DB.get('blobs', k); if (!b) continue;
        const { error } = await sb.storage.from(BUCKET).upload(pathOf(k), b, { upsert: true, contentType: b.type || 'application/octet-stream' });
        if (error) throw error;
      }
      // the band gets its own copy, so the link keeps working even if this jam is later deleted
      const kind = k.split(':')[0], dst = user.id + '/share_' + code + '_' + kind;
      const { error: ce } = await sb.storage.from(BUCKET).copy(pathOf(k), dst);
      if (ce) throw ce;
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(dst, YEAR);
      if (error) throw error;
      files.push({ kind, url: data.signedUrl });
    }
    if (!jam.gen && !files.some(f => f.kind === 'audio')) throw new Error('noAudio');
    const md = user.user_metadata || {};
    const from = md.full_name || md.name || (user.email || '').split('@')[0];
    const { id, updatedAt, created, ...rest } = jam;
    const { error } = await sb.from('shares').insert({ code, data: { v: 1, from, jam: rest, files } });
    if (error) throw error;
    return location.origin + location.pathname + '#/join/' + code;
  }
  async function getShare(code) {
    await client();
    const { data, error } = await sb.rpc('get_share', { c: code });
    if (error) throw error;
    return data;
  }

  // a recording made on another device: fetch its sound the first time it is opened
  async function fetchTakeAudio(take) {
    if (!hasToken()) return null;
    try {
      await client(); if (!user) return null;
      const { data, error } = await sb.storage.from(BUCKET).download(takePath(take.id));
      if (error || !data) return null;
      const i16 = new Int16Array(await data.arrayBuffer()), f = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
      take.pcm = new Blob([f.buffer]); take.sr = TAKE_SR;
      await app.DB.put('takes', take, undefined, true);
      return take;
    } catch (e) { return null; }
  }

  window.Cloud = {
    init(a) {
      app = a;
      // back from the sign-in link in the email (?code=…), or from a link that failed (?error=…)
      const q = location.search + location.hash, fromLink = /[?&]code=/.test(q), linkErr = /error_description=|error_code=/.test(q);
      if (linkErr) {
        const expired = /expired|otp_expired/i.test(q);
        history.replaceState(null, '', location.pathname + '#/settings');
        setTimeout(() => app.toast && app.toast(expired ? 'הקישור כבר לא בתוקף. בקש קישור חדש בהגדרות.' : 'ההתחברות לא הצליחה. נסה שוב מההגדרות.', 6000), 300);
      }
      if (hasToken() || fromLink) client().then(() => {
        if (fromLink) {
          history.replaceState(null, '', location.pathname + '#/');
          app.toast && app.toast(user ? 'מחובר! הג׳אמים נשמרים עכשיו גם בענן ☁️' : 'ההתחברות לא הושלמה. פתח את הקישור מהמייל באותו דפדפן שבו ביקשת אותו.', 6000);
        }
        if (user) sync(); emit();
      }).catch(() => { loadFailed = true; emit(); });
      window.addEventListener('online', () => soon(500));
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && user) soon(800); });
      window.addEventListener('focus', () => { if (user) soon(800); });
      setInterval(poll, 15000);
    },
    touch, sync, fetchBlob, fetchTakeAudio, share, getShare,
    onChange(f) { subs.push(f); return () => { const i = subs.indexOf(f); if (i >= 0) subs.splice(i, 1); }; },
    info() { return { user: user ? { email: user.email } : null, maybe: hasToken() && !loadFailed, syncing, last: L.get('last', 0), error: lastErr, pending: (() => { const d = dirty(); return Object.keys(d.jams).length + Object.keys(d.blobs).length + Object.keys(d.takes).length + (d.state ? 1 : 0); })() }; },
    async sendLink(email) {
      await client();
      const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
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
