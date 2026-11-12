// Jam Master: practice your part with the band recording.
(function () {
  'use strict';
  const M = window.Music, A = window.Analysis;
  const $app = document.getElementById('app');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + String(s).padStart(2, '0'); };
  function toast(msg, ms) { const el = document.getElementById('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), ms || 2600); }

  // ---------- settings ----------
  const Settings = {
    get(k, d) { try { const v = localStorage.getItem('jm.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('jm.' + k, JSON.stringify(v)); } catch (e) { } }
  };

  // ---------- IndexedDB ----------
  const DB = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((res, rej) => {
        const r = indexedDB.open('jammaster', 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          db.createObjectStore('jams', { keyPath: 'id' });
          db.createObjectStore('blobs');
          const t = db.createObjectStore('takes', { keyPath: 'id' }); t.createIndex('jamId', 'jamId');
        };
        r.onsuccess = () => { this._db = r.result; res(r.result); };
        r.onerror = () => rej(r.error);
      });
    },
    async tx(store, mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction(store, mode); const s = t.objectStore(store); let out;
        Promise.resolve(fn(s)).then(v => { out = v; });
        t.oncomplete = () => res(out && out.result !== undefined && out instanceof IDBRequest ? out.result : out);
        t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    },
    req(store, mode, fn) { return this.open().then(db => new Promise((res, rej) => { const t = db.transaction(store, mode); const r = fn(t.objectStore(store)); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); })); },
    put(store, val, key) { return this.req(store, 'readwrite', s => key !== undefined ? s.put(val, key) : s.put(val)); },
    get(store, key) { return this.req(store, 'readonly', s => s.get(key)); },
    del(store, key) { return this.req(store, 'readwrite', s => s.delete(key)); },
    all(store) { return this.req(store, 'readonly', s => s.getAll()); },
    takesFor(jamId) { return this.req('takes', 'readonly', s => s.index('jamId').getAll(jamId)); }
  };

  // ---------- jams ----------
  const demoCache = {};
  async function listJams() {
    let demos = [];
    try { const idx = await (await fetch('demos/index.json')).json(); demos = await Promise.all(idx.map(d => loadDemo(d.id, d.file))); } catch (e) { console.warn(e); }
    let mine = []; try { mine = await DB.all('jams'); } catch (e) { }
    mine.sort((a, b) => b.created - a.created);
    return [...mine, ...demos.filter(Boolean)];
  }
  async function loadDemo(id, file) {
    if (demoCache[id]) return demoCache[id];
    const j = await (await fetch(file || ('demos/' + id.replace('demo-', '') + '.json'))).json();
    j.score.namesFor = j.instrument;
    // a re-sync done on this device overrides the bundled one
    const over = Settings.get('sync.' + id, null); if (over) j.sync = over;
    demoCache[id] = j; return j;
  }
  async function getJam(id) {
    if (id.startsWith('demo-')) return loadDemo(id);
    return DB.get('jams', id);
  }
  async function saveSync(jam, sync) {
    jam.sync = sync;
    if (jam.demo) Settings.set('sync.' + jam.id, sync); else await DB.put('jams', jam);
  }

  // ---------- audio ----------
  let ctx = null;
  function ac() {
    if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; ctx = new C({ latencyHint: 'interactive' }); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const bufCache = {};
  async function songBuffer(jam) {
    if (bufCache[jam.id]) return bufCache[jam.id];
    let ab;
    if (jam.demo && jam.audio) ab = await (await fetch(jam.audio)).arrayBuffer();
    else { const blob = await DB.get('blobs', 'audio:' + jam.id); if (!blob) throw new Error('needAudio'); ab = await blob.arrayBuffer(); }
    const buf = await new Promise((res, rej) => { const p = ac().decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
    bufCache[jam.id] = buf; return buf;
  }
  function outLatency() { const c = ac(); return (c.outputLatency || 0) + (c.baseLatency || 0) || 0.03; }

  let mic = null; // {stream, src, node, analyser, inLat, chunks, firstFrame}
  const WORKLET = `class R extends AudioWorkletProcessor{constructor(){super();this.on=false;this.buf=new Float32Array(4096);this.n=0;this.f0=0;this.port.onmessage=e=>{if(e.data==='start'){this.on=true;this.n=0;this.first=true}else if(e.data==='stop'){if(this.n)this.flush();this.on=false;this.port.postMessage({type:'stopped'})}}}
flush(){this.port.postMessage({type:'data',frame:this.f0,buf:this.buf.slice(0,this.n)});this.n=0}
process(inp){const ch=inp[0]&&inp[0][0];if(this.on&&ch){if(this.n===0)this.f0=currentFrame;this.buf.set(ch,this.n);this.n+=ch.length;if(this.n+128>this.buf.length)this.flush()}return true}}
registerProcessor('jm-rec',R);`;
  async function ensureMic() {
    if (mic) return mic;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('nomic');
    const c = ac();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    const src = c.createMediaStreamSource(stream);
    const analyser = c.createAnalyser(); analyser.fftSize = 2048; src.connect(analyser);
    const sink = c.createGain(); sink.gain.value = 0; sink.connect(c.destination);
    let node, kind;
    if (c.audioWorklet) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await c.audioWorklet.addModule(url);
      node = new AudioWorkletNode(c, 'jm-rec'); kind = 'worklet';
    } else { node = c.createScriptProcessor(4096, 1, 1); kind = 'sp'; }
    src.connect(node); node.connect(sink);
    const tr = stream.getAudioTracks()[0]; const st = tr.getSettings ? tr.getSettings() : {};
    mic = { stream, src, node, analyser, kind, inLat: typeof st.latency === 'number' ? st.latency : 0.012, chunks: [], firstFrame: null, on: false };
    if (kind === 'worklet') node.port.onmessage = e => { if (e.data.type === 'data' && mic.on) { if (mic.firstFrame == null) mic.firstFrame = e.data.frame; mic.chunks.push(e.data.buf); } };
    else node.onaudioprocess = e => { if (!mic.on) return; if (mic.firstFrame == null) mic.firstFrame = Math.round((e.playbackTime - 4096 / c.sampleRate) * c.sampleRate); mic.chunks.push(e.inputBuffer.getChannelData(0).slice(0)); };
    return mic;
  }
  function micStart() { mic.chunks = []; mic.firstFrame = null; mic.on = true; if (mic.kind === 'worklet') mic.node.port.postMessage('start'); }
  function micStop() {
    return new Promise(res => {
      if (mic.kind !== 'worklet') { mic.on = false; return res(); }
      const h = e => { if (e.data.type === 'stopped') { mic.node.port.removeEventListener('message', h); mic.on = false; res(); } };
      mic.node.port.addEventListener('message', h); mic.node.port.postMessage('stop');
      setTimeout(() => { mic.on = false; res(); }, 600);
    });
  }
  function concat(chunks) { let n = 0; chunks.forEach(c => n += c.length); const o = new Float32Array(n); let p = 0; chunks.forEach(c => { o.set(c, p); p += c.length; }); return o; }

  // live pitch from analyser
  const liveBuf = new Float32Array(2048);
  function livePitch(inst) {
    if (!mic) return null;
    mic.analyser.getFloatTimeDomainData(liveBuf);
    const r = M.rms(liveBuf);
    const minF = 440 * Math.pow(2, (inst.low - 3 - 69) / 12), maxF = 440 * Math.pow(2, (inst.high + 3 - 69) / 12);
    const p = r > 0.006 ? M.yin(liveBuf, ac().sampleRate, minF, maxF, 0.18) : null;
    return { rms: r, midi: p ? p.midi : null };
  }

  // ---------- helpers on score ----------
  function writtenName(jam, note) {
    const inst = M.instrument(jam.instrument);
    if (note.n && jam.score.namesFor === jam.instrument) return note.n;
    return M.midiName(note.c + inst.transpose);
  }
  function noteLabel(jam, note) { const n = writtenName(jam, note); return { letter: M.pretty(n), solf: M.solfege(n) }; }
  function midiLabel(jam, midi) { const inst = M.instrument(jam.instrument); const n = M.midiName(Math.round(midi) + inst.transpose); return { letter: M.pretty(n), solf: M.solfege(n) }; }
  function phraseStartBeat(score, idx) {
    const ns = score.notes; let i = idx;
    while (i > 0 && ns[i].b - (ns[i - 1].b + ns[i - 1].d) < 1.5) i--;
    return ns[i].b;
  }
  function hasScore(jam) { return jam.score && jam.score.notes && jam.score.notes.length > 0; }
  function hasSync(jam) { return jam.sync && jam.sync.beatTimes && jam.sync.beatTimes.length > 1; }

  // ---------- router ----------
  let cleanup = null; let curRoute = '';
  const IN_FRAME = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  function go(h) { h = h || '#/'; if (IN_FRAME) { curRoute = h; route(); } else if (location.hash === h) route(); else location.hash = h; }
  async function route() {
    if (cleanup) { try { cleanup(); } catch (e) { } cleanup = null; }
    const h = (IN_FRAME ? curRoute : location.hash).replace(/^#\/?/, '');
    const [page, id] = h.split('/');
    window.scrollTo(0, 0);
    try {
      if (page === 'jam') await JamPage(decodeURIComponent(id));
      else if (page === 'new') await NewJam();
      else if (page === 'sync') await SyncPage(decodeURIComponent(id));
      else if (page === 'take') await TakePage(decodeURIComponent(id));
      else if (page === 'settings') SettingsPage();
      else await Home();
    } catch (e) { console.error(e); $app.innerHTML = `<div class="wrap"><div class="errbox">משהו השתבש: ${esc(e.message || e)}</div><button class="btn" id="eb">חזרה</button></div>`; }
  }
  if (!IN_FRAME) window.addEventListener('hashchange', route);

  // ---------- Home ----------
  async function Home() {
    $app.innerHTML = `<div class="wrap"><div class="top"><div class="brand"><div class="logo">J</div><b>Jam Master</b></div><button class="iconbtn" id="set" aria-label="הגדרות">⚙️</button></div><div class="spinner"></div></div>`;
    document.getElementById('set').onclick = () => go('#/settings');
    const jams = await listJams();
    const takes = await DB.all('takes').catch(() => []);
    const best = {}; takes.forEach(t => { best[t.jamId] = Math.max(best[t.jamId] || 0, t.report ? t.report.stats.score : 0); });
    const items = jams.map(j => {
      const inst = M.instrument(j.instrument);
      const tags = [j.demo ? '<span class="pill">דוגמה</span>' : '', !hasScore(j) ? '<span class="pill warn">בלי תווים</span>' : (!hasSync(j) || j.sync.verified === false) ? '<span class="pill warn">צריך סנכרון</span>' : ''].join('');
      return `<div class="card jam" data-id="${esc(j.id)}"><div class="art">${inst.e}</div><div style="flex:1;min-width:0"><div class="t">${esc(j.name)}${tags}</div><div class="meta">${esc(j.artist ? j.artist + ' · ' : '')}${esc(inst.name)}${best[j.id] ? ' · שיא: ' + best[j.id] + '%' : ''}</div></div><div style="color:var(--dim);font-size:22px">‹</div></div>`;
    }).join('');
    $app.querySelector('.spinner').outerHTML = `<div class="sub" style="margin:-6px 0 14px">בחר שיר והתאמן על החלק שלך עם ההרכב</div>${items || '<div class="empty">אין עדיין ג׳אמים</div>'}<button class="newjam" id="nj">＋ ג׳אם חדש</button>`;
    $app.querySelectorAll('.jam').forEach(el => el.onclick = () => go('#/jam/' + encodeURIComponent(el.dataset.id)));
    document.getElementById('nj').onclick = () => go('#/new');
  }

  // ---------- Settings ----------
  function SettingsPage() {
    const lat = Settings.get('latencyMs', 0);
    $app.innerHTML = `<div class="wrap"><div class="top"><button class="iconbtn" id="back">→</button><h1>הגדרות</h1></div>
    <div class="card"><div style="font-weight:700">תיקון השהיה (אוזניות)</div>
    <div class="hint">אם בדוחות כל הכניסות יוצאות מאוחרות באותה כמות, זו השהיה של האוזניות. עם אוזניות חוטיות בדרך כלל אין צורך. עם בלוטות׳ זה בערך 150 עד 250.</div>
    <div class="slider"><label class="ltr" id="lv">${lat} ms</label><input type="range" min="0" max="400" step="10" value="${lat}" id="lat"></div></div>
    <div class="card"><div style="font-weight:700">על האפליקציה</div><div class="hint">Jam Master, אב-טיפוס. ההקלטות והג׳אמים נשמרים רק בטלפון הזה.</div></div></div>`;
    document.getElementById('back').onclick = () => go('');
    const r = document.getElementById('lat'); r.oninput = () => { document.getElementById('lv').textContent = r.value + ' ms'; Settings.set('latencyMs', +r.value); };
  }

  // ---------- Jam page (listen / record / practice) ----------
  async function JamPage(id) {
    const jam = await getJam(id); if (!jam) { go(''); return; }
    const inst = M.instrument(jam.instrument);
    const score = hasScore(jam) ? jam.score : null;
    const synced = score && hasSync(jam);
    const bm = synced ? M.makeBeatMap(jam.sync.beatTimes) : null;
    let stopOnMistake = Settings.get('stopOnMistake', false);
    let section = null; // {from,to} in score beats

    $app.innerHTML = `<div class="wrap">
      <div class="top"><button class="iconbtn" id="back">→</button><h1>${esc(jam.name)}</h1><button class="iconbtn" id="menu">⋯</button></div>
      ${!score ? `<div class="warnbox">לג׳אם הזה אין עדיין תווים שהאפליקציה יודעת לקרוא, אז אפשר לנגן, להקליט ולשמוע את המיקס, אבל בלי בדיקת טעויות. כדי לקבל בדיקה, הוסף את ה-PDF של התווים דרך ⋯.</div>` :
        !synced || jam.sync.verified === false ? `<div class="warnbox">${!synced ? 'השיר עוד לא מסונכרן לתווים.' : 'הסנכרון של השיר הזה עוד לא אומת, ולכן הבדיקה עלולה לטעות.'} <a href="#/sync/${encodeURIComponent(jam.id)}" style="color:var(--accent);font-weight:700">סנכרן עכשיו (דקה)</a></div>` : ''}
      <div class="card stage">
        <div class="sec" id="sec">&nbsp;</div>
        <div class="bar" id="bar">–</div><div class="barlbl" id="barlbl">${score ? 'תיבה' : ''}</div>
        <div class="beats" id="beats"></div>
        <div class="cue" id="cue"><div class="big">מוכן?</div><div class="small">${score ? 'שים אוזניות, בחר קטע ולחץ הקלטה' : 'שים אוזניות ולחץ הקלטה'}</div></div>
        <div class="tuner" id="tuner" style="visibility:hidden"><div class="n" id="tExp"><small>צריך</small>–</div><div class="n" id="tYou"><small>אתה</small>–</div></div>
      </div>
      <div class="timeline" id="tl"></div><div class="times"><span id="tCur">0:00</span><span id="tDur">0:00</span></div>
      ${score ? `<div class="chips" id="chips"></div>` : ''}
      <div class="bigctl" id="ctl"></div>
      <div class="card" style="padding:4px 16px">
        ${score && synced ? `<div class="toggle"><div><div class="tl">עצירה כשיש טעות</div><div class="td">האפליקציה עוצרת, אומרת מה קרה ומחזירה אותך לתחילת המשפט</div></div><div class="sw ${stopOnMistake ? 'on' : ''}" id="swStop" role="switch"></div></div>` : ''}
      </div>
      <div class="h2">הביצועים שלך</div><div class="card takes" id="takes"><div class="sub">עוד לא הקלטת. ההקלטות נשמרות בטלפון.</div></div>
    </div>`;
    document.getElementById('back').onclick = () => go('');
    document.getElementById('menu').onclick = () => jamMenu(jam);
    const swStop = document.getElementById('swStop');
    if (swStop) swStop.onclick = () => { stopOnMistake = !stopOnMistake; swStop.classList.toggle('on', stopOnMistake); Settings.set('stopOnMistake', stopOnMistake); };

    const cueEl = document.getElementById('cue'), barEl = document.getElementById('bar'), secEl = document.getElementById('sec');
    const beatsEl = document.getElementById('beats'), tExp = document.getElementById('tExp'), tYou = document.getElementById('tYou');
    const meter = score ? Math.round(score.meter) : 4;
    beatsEl.innerHTML = score ? Array.from({ length: meter }, (_, i) => `<i class="${i === 0 ? 'one' : ''}"></i>`).join('') : '';

    // load audio
    const ctl = document.getElementById('ctl');
    ctl.innerHTML = `<div class="spinner"></div>`;
    let buf;
    try { buf = await songBuffer(jam); } catch (e) {
      if (e.message === 'needAudio') {
        ctl.innerHTML = `<div style="width:100%"><div class="warnbox">ההקלטה של השיר לא נשמרת באתר עצמו, כדי שתישאר פרטית. בחר אותה פעם אחת מהטלפון${jam.audioHint ? ` (הקובץ <span class="ltr">${esc(jam.audioHint)}</span> מהוואטסאפ)` : ''} והיא תישמר באפליקציה.</div><button class="btn primary" id="pickAud">🎵 בחר את קובץ השיר</button></div>`;
        document.getElementById('pickAud').onclick = () => pickFile('audio/*,video/mp4,.m4a,.mp3,.wav,.aac,.ogg,.opus', async f => {
          try {
            const ab = await f.arrayBuffer();
            const b = await new Promise((res, rej) => { const p = ac().decodeAudioData(ab.slice(0), res, rej); if (p && p.then) p.then(res, rej); });
            if (jam.audioDuration && Math.abs(b.duration - jam.audioDuration) > 3) { toast(`הקובץ הזה באורך ${fmt(b.duration)}, אבל השיר צריך להיות ${fmt(jam.audioDuration)}. ודא שבחרת את הקובץ הנכון.`, 5000); return; }
            await DB.put('blobs', f, 'audio:' + jam.id); bufCache[jam.id] = b; route();
          } catch (err) { toast('לא הצלחתי לפתוח את קובץ השמע הזה'); }
        });
        return;
      }
      ctl.innerHTML = `<div class="errbox">לא הצלחתי לפתוח את קובץ השיר (${esc(e.message || e)}).</div>`; return;
    }
    const dur = buf.duration;
    document.getElementById('tDur').textContent = fmt(dur);

    // timeline
    const tl = document.getElementById('tl');
    const pct = t => (100 * t / dur).toFixed(3) + '%';
    let tlHtml = '';
    if (score && synced) {
      score.sections.forEach(s => { tlHtml += `<div class="seg" style="left:${pct(bm.toTime(s.beat))}"><span>${esc(s.name)}</span></div>`; });
      score.notes.forEach(n => { const a = bm.toTime(n.b), b = bm.toTime(n.b + n.d); tlHtml += `<div class="nt" style="left:${pct(a)};width:max(1px,${pct(b - a)})"></div>`; });
    }
    tl.innerHTML = tlHtml + `<div class="rng" id="rng" style="display:none"></div><div class="head" id="head" style="left:0"></div>`;
    const head = document.getElementById('head'), rngEl = document.getElementById('rng');

    // section chips
    function sectionRange(i) {
      const s = score.sections[i], next = score.sections[i + 1];
      return { from: s.beat, to: next ? next.beat : score.totalBeats, name: s.name };
    }
    if (score) {
      const chips = document.getElementById('chips');
      const hasNotes = i => { const r = sectionRange(i); return score.notes.some(n => n.b >= r.from && n.b < r.to); };
      chips.innerHTML = `<button class="chip on" data-i="-1">כל השיר</button>` + score.sections.map((s, i) => `<button class="chip" data-i="${i}">${hasNotes(i) ? '<span class="dot" style="background:var(--accent)"></span>' : ''}${esc(s.name)}</button>`).join('');
      chips.querySelectorAll('.chip').forEach(c => c.onclick = () => {
        if (run) return;
        chips.querySelectorAll('.chip').forEach(x => x.classList.remove('on')); c.classList.add('on');
        const i = +c.dataset.i; section = i < 0 ? null : sectionRange(i);
        if (section && synced) {
          const a = Math.max(0, bm.toTime(section.from - meter)), b = Math.min(dur, bm.toTime(section.to) + 0.4);
          rngEl.style.display = ''; rngEl.style.left = pct(a); rngEl.style.width = pct(b - a); setHead(a);
        } else { rngEl.style.display = 'none'; setHead(0); }
        idle();
      });
    }
    let cursor = 0; // song seconds when idle
    function setHead(t) { cursor = t; head.style.left = pct(t); document.getElementById('tCur').textContent = fmt(t); if (synced) showPos(t, null); }
    tl.onclick = e => { if (run || section) return; const r = tl.getBoundingClientRect(); setHead(Math.max(0, Math.min(dur, (e.clientX - r.left) / r.width * dur))); };

    // display for song position
    function showPos(t, live) {
      if (!score || !synced) return;
      const b = bm.toBeat(t); const mb = M.measureAt(score, b); const s = M.sectionAt(score, b);
      secEl.textContent = s ? s.name : ' ';
      barEl.textContent = b < 0 ? '–' : mb.m;
      const bi = Math.floor(mb.beat + 1e-6);
      [...beatsEl.children].forEach((el, i) => el.classList.toggle('on', b >= 0 && i === bi && run));
      // cue
      const ns = score.notes; let cur = null, next = null;
      for (const n of ns) { if (n.b <= b + 1e-6 && b < n.b + n.d) { cur = n; } if (n.b > b) { next = n; break; } }
      let html, cls;
      if (cur) { const L = noteLabel(jam, cur); html = `<div class="big">נגן! ${L.solf}</div><div class="small ltr">${L.letter}</div>`; cls = 'play'; }
      else if (next) {
        const until = next.b - b; const L = noteLabel(jam, next);
        if (until <= meter * 2) { html = `<div class="big">${until <= meter ? Math.ceil(until) : 'מתכוננים'}</div><div class="small">הכניסה שלך: ${L.solf} <span class="ltr">${L.letter}</span></div>`; cls = 'wait'; }
        else { const bars = M.measureAt(score, next.b).m - mb.m; html = `<div class="big">הפסקה</div><div class="small">עוד ${bars} תיבות עד הכניסה (תיבה ${M.measureAt(score, next.b).m})</div>`; cls = ''; }
      } else { html = `<div class="big">סיימת את החלק שלך 🎉</div>`; cls = ''; }
      if (cueEl._h !== html) { cueEl.innerHTML = html; cueEl._h = html; cueEl.className = 'cue ' + cls; }
      if (live !== null) {
        const tn = document.getElementById('tuner'); tn.style.visibility = 'visible';
        const expTxt = cur ? noteLabel(jam, cur) : null;
        tExp.innerHTML = `<small>צריך</small>${expTxt ? expTxt.solf : '—'}`;
        if (live && live.midi != null) {
          const L = midiLabel(jam, live.midi); tYou.innerHTML = `<small>אתה</small>${L.solf}`;
          const ok = cur && Math.abs(A.wrap12(live.midi - cur.c)) < 0.6;
          tYou.className = 'n ' + (cur ? (ok ? 'ok' : 'bad') : (live.rms > 0.02 ? 'bad' : ''));
        } else { tYou.innerHTML = `<small>אתה</small>—`; tYou.className = 'n' + (cur ? ' bad' : ''); }
      }
    }

    // ---- run state ----
    let run = null; // {mode, src, T0, S, endT, startT, raf, live}
    function idle() {
      ctl.innerHTML = `<button class="round small" id="bListen" aria-label="האזנה">▶<span class="lbl"></span></button>
        <button class="round rec" id="bRec" aria-label="הקלטה">●</button>`;
      ctl.insertAdjacentHTML('afterend', '');
      document.getElementById('bListen').onclick = () => start('listen');
      document.getElementById('bRec').onclick = () => start('record');
    }
    function runningUI() {
      ctl.innerHTML = `<div style="text-align:center"><button class="round play" id="bStop" aria-label="עצור">■</button><div class="hint">${run.mode === 'listen' ? 'האזנה' : '<span class="recdot"></span>מקליט'}</div></div>`;
      document.getElementById('bStop').onclick = () => stop(true);
    }
    idle();

    async function start(mode, fromT, opts) {
      opts = opts || {};
      const c = ac();
      if (mode === 'record') {
        try { await ensureMic(); } catch (e) {
          sheet(`<h3>אין גישה למיקרופון</h3><div class="sub">${e && e.message === 'nomic' ? 'הדפדפן הזה לא מאפשר הקלטה. פתח את האפליקציה ב-Chrome או ב-Safari.' : 'צריך לאשר גישה למיקרופון כדי להקליט. אם סירבת, אפשר לאשר מחדש בהגדרות האתר בדפדפן.'}</div><button class="btn" data-close>סגור</button>`);
          return;
        }
      }
      let S = fromT != null ? fromT : cursor, endT = dur;
      if (section && synced && fromT == null) { S = Math.max(0, bm.toTime(section.from - meter)); endT = Math.min(dur, bm.toTime(section.to) + 0.4); }
      if (opts.endT) endT = opts.endT;
      if (S >= dur - 0.5) S = 0;
      const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
      const T0 = c.currentTime + 0.12;
      if (mode === 'record') micStart();
      src.start(T0, S);
      run = { mode, src, T0, S, endT, startT: S, liveState: { badSince: null, silentSince: null, extraSince: null } };
      src.onended = () => { if (run && run.src === src) stop(true); };
      runningUI();
      const lat = outLatency();
      const loop = () => {
        if (!run) return;
        const heard = run.S + (c.currentTime - run.T0) - lat;
        head.style.left = pct(Math.max(0, heard)); document.getElementById('tCur').textContent = fmt(heard);
        let live = null;
        if (run.mode === 'record') live = livePitch(inst);
        showPos(heard, run.mode === 'record' ? live : null);
        if (run.mode === 'record' && stopOnMistake && score && synced) liveCheck(heard - 0.07, live);
        if (heard >= run.endT) { stop(true); return; }
        run.raf = requestAnimationFrame(loop);
      };
      run.raf = requestAnimationFrame(loop);
    }

    // real-time mistake detection
    function liveCheck(t, live) {
      const st = run.liveState; if (!live) return;
      const b = bm.toBeat(t); const ns = score.notes;
      let cur = null, idx = -1, prevEnd = -1e9, next = null;
      for (let i = 0; i < ns.length; i++) { const n = ns[i]; if (n.b <= b && b < n.b + n.d) { cur = n; idx = i; break; } if (n.b > b) { next = n; break; } prevEnd = n.b + n.d; }
      const now = ac().currentTime;
      const voiced = live.midi != null && live.rms > 0.01;
      if (cur) {
        st.extraSince = null;
        const ts = bm.toTime(cur.b), te = bm.toTime(cur.b + cur.d);
        if (t < ts + 0.15 || t > te - 0.05) { st.badSince = null; st.silentSince = null; return; }
        if (!voiced) { st.badSince = null; if (st.silentSince == null) st.silentSince = now; if (now - st.silentSince > 0.4 && te - ts > 0.35) mistake('missed', cur, idx, null); }
        else {
          st.silentSince = null;
          const ok = Math.abs(A.wrap12(live.midi - cur.c)) < 0.7;
          if (ok) st.badSince = null; else { if (st.badSince == null) st.badSince = now; if (now - st.badSince > 0.28) mistake('wrong', cur, idx, live.midi); }
        }
      } else {
        st.badSince = null; st.silentSince = null;
        const gapStart = bm.toTime(prevEnd) + 0.45, gapEnd = next ? bm.toTime(next.b) - 0.35 : 1e9;
        if (t > gapStart && t < gapEnd && voiced && live.rms > 0.02) { if (st.extraSince == null) st.extraSince = now; if (now - st.extraSince > 0.6) mistake('extra', next, next ? ns.indexOf(next) : ns.length - 1, live.midi); }
        else st.extraSince = null;
      }
    }
    async function mistake(kind, note, idx, playedMidi) {
      if (!run || run.paused) return;
      const pos = run.S + (ac().currentTime - run.T0) - outLatency();
      run.paused = true;
      try { run.src.onended = null; run.src.stop(); } catch (e) { }
      cancelAnimationFrame(run.raf);
      await micStop();
      const m = note ? note.m : M.measureAt(score, bm.toBeat(pos)).m;
      const exp = note ? noteLabel(jam, note) : null;
      let msg;
      if (kind === 'wrong') { const P = midiLabel(jam, playedMidi); msg = `ציפיתי ל-<b>${exp.solf}</b> <span class="ltr">(${exp.letter})</span> ושמעתי <b>${P.solf}</b> <span class="ltr">(${P.letter})</span>.`; }
      else if (kind === 'missed') msg = `כאן צריך לנגן <b>${exp.solf}</b> <span class="ltr">(${exp.letter})</span> ולא שמעתי אותך.`;
      else msg = `ניגנת בזמן הפסקה.${note ? ` הכניסה הבאה שלך היא בתיבה ${note.m}.` : ''}`;
      const pIdx = idx >= 0 ? idx : 0; const pb = kind === 'extra' && note ? phraseStartBeat(score, pIdx) : phraseStartBeat(score, pIdx);
      const retryT = Math.max(0, bm.toTime(pb - meter) - 0.6);
      const savedEnd = run.endT; run = null;
      sheet(`<h3>עצרתי בתיבה ${m}</h3><div style="font-size:16px;margin:6px 0 4px">${msg}</div>
        <div class="hint">"נסה שוב" מחזיר תיבה אחת לפני תחילת המשפט, כדי שתיכנס בזמן.</div>
        <button class="btn primary" data-act="retry">↻ נסה שוב מתחילת המשפט</button>
        <div class="row"><button class="btn" data-act="cont">המשך מכאן</button><button class="btn ghost" data-act="end">סיום</button></div>`,
        act => {
          if (act === 'retry') start('record', retryT, { endT: savedEnd });
          else if (act === 'cont') start('record', Math.max(0, pos - 1.5), { endT: savedEnd });
          else { setHead(pos); idle(); }
        });
    }

    async function stop(finished) {
      if (!run) return;
      const r = run; run = null;
      cancelAnimationFrame(r.raf);
      try { r.src.onended = null; r.src.stop(); } catch (e) { }
      const c = ac();
      const stopT = Math.min(dur, r.S + (c.currentTime - r.T0));
      [...beatsEl.children].forEach(el => el.classList.remove('on'));
      document.getElementById('tuner').style.visibility = 'hidden';
      if (r.mode !== 'record') { setHead(section ? cursor : stopT); idle(); return; }
      await micStop();
      const pcm = concat(mic.chunks); mic.chunks = [];
      if (pcm.length < c.sampleRate * 1 || mic.firstFrame == null) { toast('ההקלטה קצרה מדי'); idle(); return; }
      const lat = (mic.inLat || 0) + outLatency() + Settings.get('latencyMs', 0) / 1000;
      const songTime0 = r.S + (mic.firstFrame / c.sampleRate - r.T0) - lat;
      ctl.innerHTML = `<div style="text-align:center;width:100%"><div class="spinner"></div><div class="sub" id="prog">${score && synced ? 'בודק את הביצוע…' : 'שומר…'}</div></div>`;
      let report = null;
      if (score && synced) {
        report = await A.analyze({ samples: pcm, sr: c.sampleRate, songTime0, startT: r.startT, endT: stopT, score, beatTimes: jam.sync.beatTimes, instrumentId: jam.instrument },
          p => { const el = document.getElementById('prog'); if (el) el.textContent = 'בודק את הביצוע… ' + Math.round(p * 100) + '%'; });
      }
      const take = { id: 't' + Date.now(), jamId: jam.id, created: Date.now(), sr: c.sampleRate, songTime0, startT: r.startT, endT: stopT, section: section ? section.name : null, report, pcm: new Blob([pcm.buffer]) };
      await DB.put('takes', take);
      // keep the latest 10 takes per jam
      const all = (await DB.takesFor(jam.id)).sort((a, b) => b.created - a.created);
      for (const old of all.slice(10)) await DB.del('takes', old.id);
      go('#/take/' + take.id);
    }

    cleanup = () => { if (run) { try { run.src.onended = null; run.src.stop(); } catch (e) { } cancelAnimationFrame(run.raf); if (run.mode === 'record' && mic) mic.on = false; run = null; } };

    // takes list
    const takes = (await DB.takesFor(jam.id).catch(() => [])).sort((a, b) => b.created - a.created);
    if (takes.length) document.getElementById('takes').innerHTML = takes.map(t => {
      const s = t.report && t.report.stats.total ? t.report.stats.score : null; const d = new Date(t.created);
      const col = s == null ? 'var(--muted)' : s >= 85 ? 'var(--good)' : s >= 60 ? 'var(--warn)' : 'var(--bad)';
      return `<div class="tk" data-id="${t.id}"><div class="sc" style="color:${col}">${s == null ? '🎧' : s + '%'}</div><div style="flex:1"><div style="font-weight:600">${esc(t.section || 'כל השיר')} · ${fmt(t.endT - t.startT)}</div><div class="sub">${d.toLocaleDateString('he-IL')} ${d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}</div></div><div style="color:var(--dim)">‹</div></div>`;
    }).join('');
    document.querySelectorAll('.tk').forEach(el => el.onclick = () => go('#/take/' + el.dataset.id));
    if (synced) showPos(0, null);
  }

  function jamMenu(jam) {
    sheet(`<h3>${esc(jam.name)}</h3>
      ${hasScore(jam) ? `<button class="btn" data-act="sync">🎚️ סנכרון השיר לתווים</button>` : ''}
      ${!jam.demo ? `<button class="btn" data-act="xml">📄 ${hasScore(jam) ? 'החלף' : 'הוסף'} תווים (PDF)</button>` : ''}
      ${!jam.demo ? `<button class="btn ghost" data-act="del" style="color:var(--bad)">מחק את הג׳אם</button>` : ''}
      <button class="btn ghost" data-close>סגור</button>`, async act => {
      if (act === 'sync') go('#/sync/' + encodeURIComponent(jam.id));
      if (act === 'del') sheet(`<h3>למחוק את "${esc(jam.name)}"?</h3><div class="sub">כל ההקלטות של הג׳אם יימחקו מהטלפון.</div><button class="btn rec" data-act="yes">מחק</button><button class="btn ghost" data-close>ביטול</button>`, async a => { if (a !== 'yes') return; await DB.del('jams', jam.id); await DB.del('blobs', 'audio:' + jam.id); for (const t of await DB.takesFor(jam.id)) await DB.del('takes', t.id); go(''); });
      if (act === 'xml') pickFile('application/pdf,.pdf,.musicxml,.xml,.mxl', async f => {
        toast('קורא את התווים…', 1500);
        try { const sc = await readScoreFile(f, jam.instrument); jam.score = sc; jam.sync = null; await DB.put('jams', jam); toast('התווים נטענו: ' + sc.notes.length + ' תווים'); go('#/sync/' + encodeURIComponent(jam.id)); }
        catch (e) { toast(e.message === 'noNotes' ? 'לא מצאתי תווים בקובץ. אם זו סריקה או צילום, עדיין אין לי איך לקרוא אותו.' : 'לא הצלחתי לקרוא את הקובץ', 4000); }
      });
    });
  }

  // ---------- generic bottom sheet ----------
  function sheet(html, onAct) {
    const el = document.createElement('div'); el.className = 'sheet'; el.innerHTML = `<div>${html}</div>`;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.addEventListener('click', e => {
      if (e.target === el) { close(); return; }
      const b = e.target.closest('[data-act],[data-close]'); if (!b) return;
      close(); if (b.dataset.act && onAct) onAct(b.dataset.act);
    });
    return close;
  }
  function pickFile(accept, cb, opts) {
    const i = document.createElement('input'); i.type = 'file'; i.accept = accept; if (opts && opts.capture) i.capture = 'environment'; if (opts && opts.multiple) i.multiple = true;
    i.onchange = () => { if (i.files && i.files.length) cb(opts && opts.multiple ? [...i.files] : i.files[0]); };
    i.click();
  }
  let pdfLibP = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!pdfLibP) pdfLibP = new Promise((res, rej) => {
      const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      sc.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(window.pdfjsLib); };
      sc.onerror = () => { pdfLibP = null; rej(new Error('pdflib')); }; document.head.appendChild(sc);
    });
    return pdfLibP;
  }
  const isPdf = f => /pdf$/i.test(f.type) || /\.pdf$/i.test(f.name);
  async function readScoreFile(f, instrumentId) {
    const inst = M.instrument(instrumentId);
    if (isPdf(f)) {
      const lib = await loadPdfJs();
      const r = await window.OMR.readPdf(lib, new Uint8Array(await f.arrayBuffer()));
      if (!r.notes.length) throw new Error('noNotes');
      // the part is written for the player's instrument: store concert pitch, keep the written names
      r.notes.forEach(n => { n.c = n.c - inst.transpose; });
      r.namesFor = instrumentId;
      return r;
    }
    let text;
    if (/\.mxl$/i.test(f.name)) text = await M.unzipFirstXml(await f.arrayBuffer()); else text = await f.text();
    const sc = M.parseMusicXML(text, inst.transpose);
    if (!sc.notes.length) throw new Error('empty');
    sc.namesFor = sc.writtenFromFile ? null : instrumentId;
    return sc;
  }

  // ---------- Take / report page ----------
  async function TakePage(id) {
    const take = await DB.get('takes', id); if (!take) { go(''); return; }
    const jam = await getJam(take.jamId); if (!jam) { go(''); return; }
    const rep = take.report;
    const score = jam.score; const bm = hasSync(jam) ? M.makeBeatMap(jam.sync.beatTimes) : null;
    const sec = s => score && bm ? (M.sectionAt(score, bm.toBeat(s)) || {}).name : '';
    let issuesHtml = '';
    if (rep) {
      const items = [];
      rep.results.forEach(r => {
        if (r.status === 'ok') return;
        const E = noteLabel(jam, r);
        let txt, col;
        if (r.status === 'wrong') { const P = midiLabel(jam, r.played); txt = `<b>תו לא נכון</b><br>ניגנת ${P.solf} <span class="ltr">(${P.letter})</span> במקום ${E.solf} <span class="ltr">(${E.letter})</span>`; col = 'var(--bad)'; }
        else if (r.status === 'missed') { txt = `<b>לא נשמע</b><br>היה צריך לנגן ${E.solf} <span class="ltr">(${E.letter})</span>`; col = 'var(--bad)'; }
        else if (r.status === 'late') { txt = `<b>כניסה מאוחרת</b>${r.delta != null ? ` ב-${Math.round(r.delta * 1000)} מ״ש` : ''}<br>${E.solf} <span class="ltr">(${E.letter})</span>`; col = 'var(--warn)'; }
        else if (r.status === 'early') { txt = `<b>כניסה מוקדמת</b> ב-${Math.round(-r.delta * 1000)} מ״ש<br>${E.solf} <span class="ltr">(${E.letter})</span>`; col = 'var(--info)'; }
        items.push({ t: r.ts, m: r.m, txt, col });
      });
      rep.extras.forEach(x => items.push({ t: x.t, m: x.m, txt: `<b>ניגנת בזמן הפסקה</b><br>כ-${x.len} שניות`, col: 'var(--info)' }));
      items.sort((a, b) => a.t - b.t);
      // merge per measure
      const byM = []; items.forEach(it => { const last = byM[byM.length - 1]; if (last && last.m === it.m) last.list.push(it); else byM.push({ m: it.m, t: it.t, list: [it] }); });
      issuesHtml = byM.length ? byM.map(g => `<div class="issue" data-t="${g.t}"><div class="m">${g.m}<small>תיבה</small></div><div class="tx">${g.list.slice(0, 3).map(it => `<div><span class="dot" style="background:${it.col}"></span>${it.txt}</div>`).join('')}${g.list.length > 3 ? `<div class="sub">ועוד ${g.list.length - 3}</div>` : ''}<div class="sub">${esc(sec(g.t) || '')}</div></div><div class="go">▶</div></div>`).join('')
        : `<div class="sub">לא נמצאו טעויות. כל הכבוד!</div>`;
    }
    const s = rep ? rep.stats : null;
    const ring = v => { const R = 64, C = 2 * Math.PI * R, col = v >= 85 ? 'var(--good)' : v >= 60 ? 'var(--warn)' : 'var(--bad)'; return `<div class="scorering"><svg width="150" height="150"><circle cx="75" cy="75" r="${R}" stroke="var(--card2)" stroke-width="12" fill="none"/><circle cx="75" cy="75" r="${R}" stroke="${col}" stroke-width="12" fill="none" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - v / 100)}"/></svg><div class="v"><div>${v}%<small>מדויק</small></div></div></div>`; };
    $app.innerHTML = `<div class="wrap">
      <div class="top"><button class="iconbtn" id="back">→</button><h1>${esc(jam.name)}</h1></div>
      ${rep && !s.total ? `<div class="warnbox">${esc(rep.tips[0].t)}</div>` : ''}
      ${rep && s.total ? `<div class="card" style="text-align:center">${ring(s.score)}
        <div class="stats"><div class="stat"><b style="color:var(--good)">${s.ok}</b><span>נכון</span></div><div class="stat"><b style="color:var(--bad)">${s.wrong + s.missed}</b><span>תו שגוי/חסר</span></div><div class="stat"><b style="color:var(--warn)">${s.late + s.early}</b><span>לא בזמן</span></div></div>
        <div class="hint">${esc(take.section || 'כל השיר')} · ${s.total} תווים נבדקו</div></div>
        <div class="h2">מה לשפר</div><div class="card">${rep.tips.map(t => `<div class="tip"><div class="e">${t.e}</div><div>${esc(t.t)}</div></div>`).join('')}</div>` :
        `<div class="warnbox">ההקלטה נשמרה. בדיקת טעויות תהיה זמינה אחרי שיהיו לג׳אם תווים מסונכרנים.</div>`}
      <div class="h2">הביצוע המשולב</div>
      <div class="card">
        <div class="timeline" id="tl"><div class="head" id="head" style="left:0"></div></div><div class="times"><span id="tCur">0:00</span><span id="tDur">0:00</span></div>
        <div class="bigctl" style="margin:10px 0"><button class="round play" id="bPlay">▶</button></div>
        <div class="slider"><label>השיר</label><input type="range" id="vSong" min="0" max="1.5" step="0.05" value="${Settings.get('mixSong', 0.8)}"></div>
        <div class="slider"><label>אתה</label><input type="range" id="vMe" min="0" max="3" step="0.05" value="${Settings.get('mixMe', 1.4)}"></div>
        <button class="btn" id="bShare">⬇️ שמור / שתף את המיקס</button>
      </div>
      ${rep && s.total ? `<div class="h2">איפה היו הטעויות</div><div class="card" id="issues">${issuesHtml}</div>` : ''}
      <button class="btn primary" id="again">↻ עוד פעם</button>
      <button class="btn ghost" id="delTake">מחק את ההקלטה</button>
    </div>`;
    document.getElementById('back').onclick = () => go('#/jam/' + encodeURIComponent(jam.id));
    document.getElementById('again').onclick = () => go('#/jam/' + encodeURIComponent(jam.id));
    document.getElementById('delTake').onclick = async () => { await DB.del('takes', take.id); go('#/jam/' + encodeURIComponent(jam.id)); };

    const c = ac();
    const songBuf = await songBuffer(jam);
    const pcm = new Float32Array(await take.pcm.arrayBuffer());
    const recBuf = c.createBuffer(1, pcm.length, take.sr); recBuf.copyToChannel ? recBuf.copyToChannel(pcm, 0) : recBuf.getChannelData(0).set(pcm);
    const A0 = Math.max(0, take.startT), B0 = Math.min(songBuf.duration, take.endT);
    const len = B0 - A0;
    document.getElementById('tDur').textContent = fmt(len);
    const tl = document.getElementById('tl'), head = document.getElementById('head');
    if (rep && bm) rep.results.filter(r => r.status !== 'ok').forEach(r => { tl.insertAdjacentHTML('beforeend', `<div class="iss" style="left:${(100 * (r.ts - A0) / len).toFixed(2)}%"></div>`); });
    if (rep && bm) jam.score.notes.forEach(n => { const a = bm.toTime(n.b), b = bm.toTime(n.b + n.d); if (b < A0 || a > B0) return; tl.insertAdjacentHTML('afterbegin', `<div class="nt" style="left:${(100 * (a - A0) / len).toFixed(2)}%;width:max(1px,${(100 * (b - a) / len).toFixed(2)}%)"></div>`); });
    let pb = null, pos = A0;
    const gSong = c.createGain(), gMe = c.createGain(); gSong.connect(c.destination); gMe.connect(c.destination);
    const vS = document.getElementById('vSong'), vM = document.getElementById('vMe');
    const setG = () => { gSong.gain.value = +vS.value; gMe.gain.value = +vM.value; Settings.set('mixSong', +vS.value); Settings.set('mixMe', +vM.value); };
    vS.oninput = vM.oninput = setG; setG();
    const bPlay = document.getElementById('bPlay');
    function playFrom(t) {
      stopPb(); const T = c.currentTime + 0.08;
      const s1 = c.createBufferSource(); s1.buffer = songBuf; s1.connect(gSong); s1.start(T, t, Math.max(0.01, B0 - t));
      const s2 = c.createBufferSource(); s2.buffer = recBuf; s2.connect(gMe);
      const off = t - take.songTime0; if (off >= 0) { if (off < recBuf.duration) s2.start(T, off); } else s2.start(T - off, 0);
      pb = { s1, s2, T, t }; bPlay.textContent = '❚❚';
      s1.onended = () => { if (pb && pb.s1 === s1) { stopPb(); pos = A0; draw(); } };
      const loop = () => { if (!pb) return; pos = pb.t + c.currentTime - pb.T; draw(); pb.raf = requestAnimationFrame(loop); }; loop();
    }
    function stopPb() { if (!pb) return; try { pb.s1.onended = null; pb.s1.stop(); pb.s2.stop(); } catch (e) { } cancelAnimationFrame(pb.raf); pb = null; bPlay.textContent = '▶'; }
    function draw() { head.style.left = (100 * Math.max(0, Math.min(1, (pos - A0) / len))) + '%'; document.getElementById('tCur').textContent = fmt(pos - A0); }
    bPlay.onclick = () => { if (pb) { stopPb(); } else playFrom(pos >= B0 - 0.2 ? A0 : pos); };
    tl.onclick = e => { const r = tl.getBoundingClientRect(); pos = A0 + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * len; draw(); if (pb) playFrom(pos); };
    document.querySelectorAll('.issue').forEach(el => el.onclick = () => {
      const t = +el.dataset.t; const from = bm ? Math.max(A0, bm.toTime(bm.toBeat(t) - (jam.score.meter || 4)) - 0.3) : Math.max(A0, t - 2.5);
      pos = from; playFrom(from); window.scrollTo({ top: document.getElementById('tl').getBoundingClientRect().top + window.scrollY - 120, behavior: 'smooth' });
    });
    document.getElementById('bShare').onclick = async () => {
      const btn = document.getElementById('bShare'); btn.disabled = true; btn.textContent = 'מכין קובץ…';
      try {
        const sr = 44100; const oc = new OfflineAudioContext(1, Math.ceil(len * sr), sr);
        const g1 = oc.createGain(); g1.gain.value = +vS.value; g1.connect(oc.destination);
        const g2 = oc.createGain(); g2.gain.value = +vM.value; g2.connect(oc.destination);
        const a = oc.createBufferSource(); a.buffer = songBuf; a.connect(g1); a.start(0, A0, len);
        const b = oc.createBufferSource(); b.buffer = recBuf; b.connect(g2); const off = A0 - take.songTime0; if (off >= 0) b.start(0, off); else b.start(-off, 0);
        const out = await oc.startRendering();
        const blob = wav(out.getChannelData(0), sr);
        const name = (jam.name + ' - ' + new Date(take.created).toLocaleDateString('he-IL').replace(/\//g, '.')).replace(/[\\/:*?"<>|]/g, '') + '.wav';
        const file = new File([blob], name, { type: 'audio/wav' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: jam.name }).catch(() => { }); }
        else { const u = URL.createObjectURL(blob); const a2 = document.createElement('a'); a2.href = u; a2.download = name; document.body.appendChild(a2); a2.click(); a2.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000); }
      } catch (e) { toast('לא הצלחתי ליצור את הקובץ'); }
      btn.disabled = false; btn.textContent = '⬇️ שמור / שתף את המיקס';
    };
    cleanup = stopPb;
  }
  function wav(data, sr) {
    let peak = 0; for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    const g = peak > 0.99 ? 0.99 / peak : 1;
    const b = new ArrayBuffer(44 + data.length * 2), v = new DataView(b);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, data.length * 2, true);
    for (let i = 0; i < data.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i] * g)) * 32767, true);
    return new Blob([b], { type: 'audio/wav' });
  }

  // ---------- New Jam wizard ----------
  async function NewJam() {
    const st = { step: 0, name: '', instrument: Settings.get('lastInstrument', 'alto'), score: null, scoreFile: null, sheetImages: [], audio: null, audioName: '', audioDur: 0 };
    const STEPS = 4;
    function autoName() {
      if (st.name.trim()) return st.name.trim();
      if (st.score && st.score.title) return st.score.title;
      if (st.audioName) { const n = st.audioName.replace(/\.[^.]+$/, '').replace(/^(AUD|PTT|VID)-\d+-WA\d+$/i, '').replace(/[_-]+/g, ' ').trim(); if (n) return n; }
      const d = new Date(); return `ג׳אם ${d.getDate()}.${d.getMonth() + 1} · ${d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;
    }
    function render() {
      const bar = `<div class="steps">${Array.from({ length: STEPS }, (_, i) => `<i class="${i <= st.step ? 'on' : ''}"></i>`).join('')}</div>`;
      let body = '';
      if (st.step === 0) body = `<h2>איך נקרא לג׳אם?</h2><div class="sub">לא חובה. אם תשאיר ריק, אתן שם לבד לפי השיר.</div>
        <input class="field" id="nm" style="margin-top:16px" placeholder="למשל: יוצא לאור" value="${esc(st.name)}" maxlength="60">
        <button class="btn primary" id="next">המשך</button>`;
      if (st.step === 1) body = `<h2>על מה אתה מנגן?</h2><div class="sub">ככה אראה לך את התווים בטונליות של הכלי שלך.</div>
        <div class="choices">${M.INSTRUMENTS.map(i => `<button class="choice ${st.instrument === i.id ? 'on' : ''}" data-i="${i.id}"><span class="e">${i.e}</span>${esc(i.name)}<small class="ltr">${i.key !== 'C' ? i.key : ''}</small></button>`).join('')}</div>
        <button class="btn primary" id="next">המשך</button>`;
      if (st.step === 2) body = `<h2>התווים שלך</h2><div class="sub">בחר את קובץ ה-PDF של התווים, כמו שקיבלת אותו מהמעבד. אני קורא ממנו את התווים ובודק אותך לפיהם.</div>
        <div class="row"><div class="drop ${st.score ? 'done' : ''}" id="file"><span class="e">📄</span><b>בחר קובץ</b><span class="sub">ה-PDF של התווים</span></div>
        <div class="drop ${st.sheetImages.length ? 'done' : ''}" id="cam"><span class="e">📷</span><b>צלם תווים</b><span class="sub">בלי בדיקת טעויות בינתיים</span></div></div>
        <div id="sheetInfo"></div>
        <button class="btn primary" id="next">${st.score || st.sheetImages.length ? 'המשך' : 'דלג בינתיים'}</button>`;
      if (st.step === 3) body = `<h2>השיר</h2><div class="sub">ההקלטה של ההרכב (או הפלייבק) שעליה תתאמן.</div>
        <div class="drop ${st.audio ? 'done' : ''}" id="aud"><span class="e">🎵</span><b>${st.audio ? esc(st.audioName) : 'בחר קובץ שמע'}</b><span class="sub">${st.audio ? fmt(st.audioDur) : 'mp3, m4a, wav ועוד'}</span></div>
        <div class="card" style="margin-top:14px"><div class="sub">שם הג׳אם</div><div style="font-weight:700;font-size:18px">${esc(autoName())}</div></div>
        <button class="btn primary" id="next" ${st.audio ? '' : 'disabled'}>${st.score ? 'צור ועבור לסנכרון' : 'צור ג׳אם'}</button>`;
      $app.innerHTML = `<div class="wrap wz"><div class="top"><button class="iconbtn" id="back">→</button><h1>ג׳אם חדש</h1></div>${bar}${body}</div>`;
      document.getElementById('back').onclick = () => { if (st.step) { st.step--; render(); } else go(''); };
      const next = document.getElementById('next');
      if (st.step === 0) { const nm = document.getElementById('nm'); nm.oninput = () => st.name = nm.value; nm.onkeydown = e => { if (e.key === 'Enter') next.click(); }; }
      if (st.step === 1) document.querySelectorAll('.choice').forEach(b => b.onclick = () => { st.instrument = b.dataset.i; Settings.set('lastInstrument', st.instrument); render(); });
      if (st.step === 2) {
        const info = document.getElementById('sheetInfo');
        const showInfo = () => {
          let h = '';
          if (st.reading) h += `<div class="card" style="margin-top:12px;text-align:center"><div class="spinner" style="margin:6px auto"></div>קורא את התווים…</div>`;
          if (st.score) {
            const secs = (st.score.sections || []).filter(x => x.name !== 'התחלה').map(x => x.name);
            h += `<div class="card" style="margin-top:12px"><div style="font-weight:700">✅ קראתי את התווים${st.score.title ? ': ' + esc(st.score.title) : ''}</div><div class="sub">${st.score.notes.length} תווים ב-${st.score.measureStart.length} תיבות${st.score.tempo ? ` · טמפו ${st.score.tempo}` : ''}</div>${secs.length ? `<div class="sub">${esc(secs.join(' · '))}</div>` : ''}</div>`;
            if (st.score.warnings && st.score.warnings.length) h += `<div class="warnbox">ב-${st.score.warnings.length} תיבות (${st.score.warnings.slice(0, 6).map(w => w.m).join(', ')}) לא הצלחתי לקרוא את הקצב בוודאות. הבדיקה שם עלולה לטעות.</div>`;
          }
          if (st.sheetImages.length) h += `<div class="thumbs">${st.sheetImages.map(f => `<img src="${URL.createObjectURL(f)}" alt="">`).join('')}</div>
            ${!st.score ? `<div class="warnbox" style="margin-top:10px">שמרתי את התמונות. קריאת תווים מצילום עוד לא קיימת, אז מתמונה אפשר לנגן ולהקליט בלי בדיקת טעויות. אם יש לך את קובץ ה-PDF של התווים, בחר אותו ותקבל בדיקה מלאה.</div>` : ''}`;
          if (st.pdf && !st.score && !st.reading) h += `<div class="warnbox" style="margin-top:10px">ה-PDF הזה נראה כמו סריקה או צילום של דף, ולכן לא הצלחתי לקרוא ממנו את התווים. אני קורא PDF שיצא מתוכנת תווים (MuseScore, Sibelius, Finale, Dorico). שמרתי אותו, ואפשר לנגן ולהקליט בלי בדיקה.</div>`;
          info.innerHTML = h;
        };
        showInfo();
        document.getElementById('cam').onclick = () => pickFile('image/*', files => { st.sheetImages.push(...files); render(); }, { capture: true, multiple: true });
        document.getElementById('file').onclick = () => pickFile('application/pdf,.pdf,.musicxml,.xml,.mxl,image/*', async f => {
          if (/\.(musicxml|xml|mxl)$/i.test(f.name)) {
            try { st.score = await readScoreFile(f, st.instrument); st.scoreFile = f; render(); }
            catch (e) { toast('לא הצלחתי לקרוא את הקובץ כ-MusicXML'); }
          } else if (isPdf(f)) {
            st.pdf = f; st.score = null; st.reading = true; render();
            try { st.score = await readScoreFile(f, st.instrument); }
            catch (e) { if (e.message === 'pdflib') toast('צריך חיבור לאינטרנט כדי לקרוא PDF בפעם הראשונה'); }
            st.reading = false; render();
          }
          else { st.sheetImages.push(f); render(); }
        });
      }
      if (st.step === 3) {
        document.getElementById('aud').onclick = () => pickFile('audio/*,video/mp4,.m4a,.mp3,.wav,.aac,.ogg', async f => {
          try {
            const ab = await f.arrayBuffer();
            const b = await new Promise((res, rej) => { const p = ac().decodeAudioData(ab.slice(0), res, rej); if (p && p.then) p.then(res, rej); });
            st.audio = f; st.audioName = f.name; st.audioDur = b.duration; st.decoded = b; render();
          } catch (e) { toast('לא הצלחתי לפתוח את קובץ השמע הזה'); }
        });
      }
      next.onclick = async () => {
        if (st.step < 3) { st.step++; render(); return; }
        next.disabled = true; next.textContent = 'שומר…';
        const id = 'j' + Date.now();
        const jam = { id, name: autoName(), instrument: st.instrument, created: Date.now(), score: st.score, sync: null };
        await DB.put('blobs', st.audio, 'audio:' + id);
        for (let i = 0; i < st.sheetImages.length; i++) await DB.put('blobs', st.sheetImages[i], `sheet:${id}:${i}`);
        if (st.pdf) await DB.put('blobs', st.pdf, `sheet:${id}:pdf`);
        await DB.put('jams', jam);
        if (st.decoded) bufCache[id] = st.decoded;
        go(st.score ? '#/sync/' + encodeURIComponent(id) : '#/jam/' + encodeURIComponent(id));
      };
    }
    render();
  }

  // ---------- Sync page: tap along, then auto-refine with beat tracking ----------
  async function SyncPage(id) {
    const jam = await getJam(id); if (!jam || !hasScore(jam)) { go(''); return; }
    const score = jam.score; const meter = Math.round(score.meter) || 4;
    const firstFull = score.pickup ? score.pickup : 0; // beat index of measure 2 if pickup, else measure 1
    $app.innerHTML = `<div class="wrap"><div class="top"><button class="iconbtn" id="back">→</button><h1>סנכרון</h1></div>
      <div class="sub">כדי שאדע איפה כל תיבה נמצאת בהקלטה: לחץ "נגן", ומהפעמה הראשונה של ${score.pickup ? 'התיבה המלאה הראשונה (אחרי האקדמה)' : 'תיבה 1'} הקש על המשטח בכל פעמה, לפחות 8 פעמים. אני משלים את השאר לבד ועוקב אחרי שינויי הקצב בשיר.</div>
      <div class="tapzone" id="tap">לחץ "נגן" כדי להתחיל</div>
      <div class="times" style="margin-top:6px"><span id="tCur">0:00</span><span id="taps">0 הקשות</span></div>
      <div class="row"><button class="btn primary" id="play">▶ נגן</button><button class="btn" id="reset">התחל מחדש</button></div>
      <div id="after"></div></div>`;
    document.getElementById('back').onclick = () => go('#/jam/' + encodeURIComponent(jam.id));
    const buf = await songBuffer(jam); const c = ac();
    let src = null, T0 = 0, taps = [], raf = 0, result = null, clickNodes = [];
    const tapEl = document.getElementById('tap'), playBtn = document.getElementById('play');
    function stopAll() { if (src) { try { src.stop(); } catch (e) { } src = null; } clickNodes.forEach(n => { try { n.stop(); } catch (e) { } }); clickNodes = []; cancelAnimationFrame(raf); playBtn.textContent = '▶ נגן'; }
    cleanup = stopAll;
    const now = () => c.currentTime - T0 - outLatency();
    function play(from, withClicks) {
      stopAll(); src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
      T0 = c.currentTime + 0.1 - (from || 0); src.start(c.currentTime + 0.1, from || 0);
      playBtn.textContent = '■ עצור';
      if (withClicks && result) scheduleClicks(from || 0);
      const loop = () => { document.getElementById('tCur').textContent = fmt(now()); raf = requestAnimationFrame(loop); }; loop();
    }
    function scheduleClicks(from) {
      const bt = result.beatTimes; const lat = outLatency();
      for (let b = 0; b < bt.length; b++) {
        const t = bt[b]; if (t < from || t > from + 40) continue;
        const o = c.createOscillator(), g = c.createGain(); const mb = M.measureAt(score, b);
        o.frequency.value = Math.abs(mb.beat) < 1e-3 ? 1600 : 1000; o.connect(g); g.connect(c.destination);
        const at = T0 + t - lat + outLatency() * 0; g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.5, at + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
        o.start(at); o.stop(at + 0.08); clickNodes.push(o);
      }
    }
    playBtn.onclick = () => { if (src) { stopAll(); return; } taps = []; result = null; document.getElementById('after').innerHTML = ''; document.getElementById('taps').textContent = '0 הקשות'; tapEl.textContent = 'הקש בכל פעמה'; play(0); };
    document.getElementById('reset').onclick = () => { stopAll(); taps = []; result = null; document.getElementById('after').innerHTML = ''; tapEl.textContent = 'לחץ "נגן" כדי להתחיל'; document.getElementById('taps').textContent = '0 הקשות'; };
    const onTap = e => {
      e.preventDefault(); if (!src) return;
      taps.push(now()); tapEl.classList.add('hit'); setTimeout(() => tapEl.classList.remove('hit'), 90);
      document.getElementById('taps').textContent = taps.length + ' הקשות';
      if (taps.length >= 8) { tapEl.textContent = 'מצוין. אפשר להמשיך להקיש או לסיים'; showDone(); }
    };
    tapEl.addEventListener('pointerdown', onTap);

    function showDone() {
      if (document.getElementById('finish')) return;
      document.getElementById('after').innerHTML = `<button class="btn primary" id="finish">✓ סיימתי להקיש</button>`;
      document.getElementById('finish').onclick = async () => {
        stopAll();
        document.getElementById('after').innerHTML = `<div class="spinner"></div><div class="sub" style="text-align:center">עוקב אחרי הקצב לאורך השיר…</div>`;
        await new Promise(r => setTimeout(r, 30));
        result = computeSync(buf, taps, firstFull, score.totalBeats);
        const bpm = Math.round(result.bpm);
        document.getElementById('after').innerHTML = `<div class="card" style="margin-top:14px"><div style="font-weight:700">הקצב: ${bpm} פעמות לדקה</div><div class="hint">האזן לבדיקה: תשמע קליק בכל פעמה (צליל גבוה בתחילת תיבה). אם הקליקים יושבים על הקצב, שמור.</div>
          <div class="row"><button class="btn" id="chk">▶ בדיקה עם קליקים</button></div>
          <div class="row"><button class="btn" id="m">−20ms</button><button class="btn" id="p">+20ms</button></div>
          <button class="btn primary" id="save">שמור סנכרון</button></div>`;
        document.getElementById('chk').onclick = () => { if (src) { stopAll(); return; } play(Math.max(0, result.beatTimes[firstFull] - 1.5), true); };
        const nudge = d => { result.beatTimes = result.beatTimes.map(t => +(t + d).toFixed(4)); toast((d > 0 ? 'הוזז מאוחר יותר' : 'הוזז מוקדם יותר') + ' ב-20ms', 1200); if (src) play(Math.max(0, now() - 0.5), true); };
        document.getElementById('m').onclick = () => nudge(-0.02); document.getElementById('p').onclick = () => nudge(0.02);
        document.getElementById('save').onclick = async () => { stopAll(); await saveSync(jam, { beatTimes: result.beatTimes, verified: true, method: 'tap+track' }); toast('הסנכרון נשמר'); go('#/jam/' + encodeURIComponent(jam.id)); };
      };
    }
  }

  // tap regression + dynamic-programming beat tracking (Ellis 2007), anchored to the taps
  function computeSync(buf, taps, firstBeatIdx, totalBeats) {
    // 1) clean taps -> period + phase
    const d = []; for (let i = 1; i < taps.length; i++) d.push(taps[i] - taps[i - 1]);
    const med = [...d].sort((a, b) => a - b)[d.length >> 1];
    const idx = taps.map(t => Math.round((t - taps[0]) / med));
    const n = taps.length; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sx += idx[i]; sy += taps[i]; sxx += idx[i] * idx[i]; sxy += idx[i] * taps[i]; }
    const per = (n * sxy - sx * sy) / (n * sxx - sx * sx) || med; const t0 = (sy - per * sx) / n;
    // 2) onset envelope at 100 Hz
    const sr = buf.sampleRate, ch = buf.getChannelData(0), ch2 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const hop = Math.round(sr / 100), fps = sr / hop, N = Math.floor(ch.length / hop);
    const env = new Float32Array(N); let prevE = 0, prevX = 0;
    for (let f = 0; f < N; f++) {
      let e = 0; const o = f * hop;
      for (let k = 0; k < hop; k++) { const x = ch2 ? (ch[o + k] + ch2[o + k]) * 0.5 : ch[o + k]; const hp = x - prevX; prevX = x; e += hp * hp; }
      const le = Math.log(1e-6 + e / hop); env[f] = Math.max(0, le - prevE); prevE = le;
    }
    // normalise + light smoothing
    let mean = 0; for (const v of env) mean += v; mean /= N; let sd = 0; for (const v of env) sd += (v - mean) ** 2; sd = Math.sqrt(sd / N) || 1;
    const on = new Float32Array(N); for (let f = 1; f < N - 1; f++) on[f] = ((env[f - 1] + 2 * env[f] + env[f + 1]) / 4) / sd;
    // 3) DP
    const P = per * fps, alpha = 120;
    const score = new Float32Array(N), back = new Int32Array(N).fill(-1);
    for (let f = 0; f < N; f++) {
      let best = 0, bi = -1; const a = Math.max(0, Math.round(f - 2 * P)), b = Math.round(f - P / 2);
      for (let p = a; p <= b; p++) { const r = Math.log((f - p) / P); const v = score[p] - alpha * r * r; if (v > best || bi < 0) { best = v; bi = p; } }
      score[f] = on[f] + (bi >= 0 ? Math.max(0, best) : 0); back[f] = bi >= 0 && best > 0 ? bi : -1;
    }
    let f = 0, bestS = -1; for (let i = Math.max(0, N - Math.round(2 * P)); i < N; i++) if (score[i] > bestS) { bestS = score[i]; f = i; }
    const beats = []; while (f >= 0) { beats.push(f / fps); f = back[f]; } beats.reverse();
    // 4) anchor: tracked beat closest to the first tap is score beat firstBeatIdx; verify tracker agrees with taps
    let out;
    const agree = taps.filter(t => beats.some(b => Math.abs(b - t) < 0.07)).length / taps.length;
    if (beats.length > 8 && agree >= 0.6) {
      let k0 = 0; for (let i = 0; i < beats.length; i++) if (Math.abs(beats[i] - t0) < Math.abs(beats[k0] - t0)) k0 = i;
      out = [];
      for (let b = 0; b <= totalBeats + 1; b++) {
        const k = k0 + (b - firstBeatIdx);
        if (k >= 0 && k < beats.length) out.push(+beats[k].toFixed(4));
        else if (k < 0) out.push(+(beats[0] + k * per).toFixed(4));
        else out.push(+(beats[beats.length - 1] + (k - beats.length + 1) * per).toFixed(4));
      }
    } else {
      out = M.linearBeatTimes(t0 - firstBeatIdx * per, 60 / per, totalBeats);
    }
    return { beatTimes: out, bpm: 60 / per, tracked: agree >= 0.6 };
  }

  // PWA service worker (offline shell)
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => { });
  route();
})();
