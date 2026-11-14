// Virtual band: turns the player's part into a minus-one backing track.
// Reads key and chords from the part, then renders drums / bass / piano or guitar
// with small synthesized instruments, straight into a Float32Array.
(function (g) {
  'use strict';
  const SR = 24000;
  const NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const MAJ_NAME = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const MIN_NAME = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  const HEB = { C: 'דו', D: 'רה', E: 'מי', F: 'פה', G: 'סול', A: 'לה', B: 'סי' };
  const mod12 = x => ((x % 12) + 12) % 12;

  // ---------- key ----------
  const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function corr(a, b) { const ma = a.reduce((x, y) => x + y) / 12, mb = b.reduce((x, y) => x + y) / 12; let n = 0, da = 0, db = 0; for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db || 1); }
  // concert key from the notes (concert pitch) and the written key signature
  function detectKey(score, transpose) {
    const h = new Array(12).fill(0);
    score.notes.forEach(n => { h[mod12(n.c)] += Math.min(n.d, 2); });
    const last = score.notes.length ? mod12(score.notes[score.notes.length - 1].c) : null;
    const sigMaj = score.keyFifths != null ? mod12(score.keyFifths * 7 - transpose) : null; // concert major tonic of the signature
    let best = null;
    for (let t = 0; t < 12; t++) for (const mode of ['maj', 'min']) {
      const prof = mode === 'maj' ? KS_MAJ : KS_MIN; const rot = h.map((_, i) => prof[mod12(i - t)]);
      let s = corr(h, rot);
      if (sigMaj != null) { const rel = mode === 'maj' ? t : mod12(t + 3); if (rel === sigMaj) s += 0.12; }
      if (last === t) s += 0.08;
      if (!best || s > best.s) best = { tonic: t, mode, s };
    }
    return { tonic: best.tonic, mode: best.mode };
  }
  function keyName(tonic, mode, opts) {
    const n = (mode === 'maj' ? MAJ_NAME : MIN_NAME)[mod12(tonic)];
    const heb = HEB[n[0]] + (n[1] === '#' ? '♯' : n[1] === 'b' ? '♭' : '');
    return (opts && opts.letter ? n.replace('#', '♯').replace('b', '♭') + (mode === 'maj' ? '' : 'm') : heb + ' ' + (mode === 'maj' ? 'מז׳ור' : 'מינור'));
  }
  const FLAT_MAJ = new Set([5, 10, 3, 8, 1, 6]); // F Bb Eb Ab Db Gb
  function useFlats(tonic, mode) { const maj = mode === 'maj' ? tonic : mod12(tonic + 3); return FLAT_MAJ.has(maj); }
  function spellMidi(m, flats) { return (flats ? NAMES_FLAT : NAMES_SHARP)[mod12(m)] + (Math.floor(Math.round(m) / 12) - 1); }

  // ---------- chords ----------
  // diatonic chord set for the key: [root offset, quality, prior]
  const DIA = {
    maj: [[0, 'maj', .35], [2, 'min', .1], [4, 'min', .02], [5, 'maj', .22], [7, 'dom', .25], [9, 'min', .15], [2, 'dom', -.05]],
    min: [[0, 'min', .35], [5, 'min', .18], [7, 'dom', .25], [3, 'maj', .12], [8, 'maj', .14], [10, 'maj', .1], [2, 'hdim', 0]]
  };
  const QUAL = { maj: [0, 4, 7], min: [0, 3, 7], dom: [0, 4, 7, 10], hdim: [0, 3, 6, 10] };
  const SEVENTH = { maj: 11, min: 10, dom: 10, hdim: 10 };
  function measures(score) {
    const ms = score.measureStart, out = [];
    for (let i = 0; i < ms.length; i++) out.push({ i, start: ms[i], len: (i + 1 < ms.length ? ms[i + 1] : score.totalBeats) - ms[i] });
    return out;
  }
  function inferChords(score, key) {
    const ms = measures(score); const cand = DIA[key.mode].map(([o, q, p]) => ({ root: mod12(key.tonic + o), q, p }));
    const tonicChord = cand[0], fill = key.mode === 'maj' ? [0, 5, 3, 4] : [0, 3, 5, 2]; // I vi IV V  /  i VI iv v-ish
    let prev = null, restRun = 0;
    const out = ms.map((m, k) => {
      const ns = score.notes.filter(n => n.b < m.start + m.len - 1e-3 && n.b + n.d > m.start + 1e-3);
      if (!ns.length) { const c = cand[fill[restRun++ % 4]] || tonicChord; prev = c; return { ...m, root: c.root, q: c.q }; }
      restRun = 0;
      let best = null;
      for (const c of cand) {
        const tones = QUAL[c.q].map(x => mod12(c.root + x));
        let s = c.p;
        ns.forEach((n, j) => {
          const d = Math.min(n.b + n.d, m.start + m.len) - Math.max(n.b, m.start); const pc = mod12(n.c);
          const w = tones[0] === pc ? 1 : tones[1] === pc ? .9 : tones[2] === pc ? .8 : tones[3] === pc ? .4 : -.35;
          s += w * d * (j === 0 && n.b <= m.start + 1e-3 ? 1.5 : 1);
        });
        if (prev && prev.root === c.root && prev.q === c.q) s += .15;
        if (!best || s > best.s) best = { c, s };
      }
      prev = best.c; return { ...m, root: best.c.root, q: best.c.q };
    });
    if (out.length) { const l = out[out.length - 1]; l.root = tonicChord.root; l.q = tonicChord.q; }
    return out;
  }

  // ---------- tiny instruments (one-shot buffers, cached) ----------
  const cache = new Map();
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
  let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let cacheBytes = 0; const CACHE_MAX = 12e6; // keep the sound cache small (phones)
  function shot(key, make) {
    let b = cache.get(key);
    if (!b) { b = make(); cache.set(key, b); cacheBytes += b.length * 4; while (cacheBytes > CACHE_MAX && cache.size > 1) { const k = cache.keys().next().value; cacheBytes -= cache.get(k).length * 4; cache.delete(k); } }
    return b;
  }
  function clearCache() { cache.clear(); cacheBytes = 0; }
  function piano(m, dur) {
    const dq = Math.min(2.4, Math.round(dur * 8) / 8);
    return shot('p' + m + ':' + dq, () => {
      const f = mtof(m), len = Math.floor((dq + 0.35) * SR), o = new Float32Array(len), rel = Math.floor(dq * SR);
      for (let h = 1; h <= 9; h++) {
        const fh = f * h * Math.sqrt(1 + 0.0004 * h * h); if (fh > SR / 2.2) break;
        const a = 0.5 / Math.pow(h, 1.4) * (h === 2 ? 1.3 : 1), dec = 1.2 + h * 0.9 + f / 260, w = 2 * Math.PI * fh / SR;
        for (let i = 0; i < len; i++) o[i] += a * Math.sin(w * i) * Math.exp(-dec * i / SR);
      }
      for (let i = 0; i < len; i++) { let e = Math.min(1, i / (0.004 * SR)); if (i > rel) e *= Math.exp(-(i - rel) / (0.06 * SR)); o[i] *= e; }
      return o;
    });
  }
  function bass(m, dur) {
    const dq = Math.min(2, Math.round(dur * 8) / 8);
    return shot('b' + m + ':' + dq, () => {
      const f = mtof(m), len = Math.floor((dq + 0.12) * SR), o = new Float32Array(len), rel = Math.floor(dq * 0.92 * SR);
      for (let i = 0; i < len; i++) {
        const t = i / SR, ph = 2 * Math.PI * f * t;
        let v = Math.sin(ph) + 0.45 * Math.sin(2 * ph) * Math.exp(-6 * t) + 0.18 * Math.sin(3 * ph) * Math.exp(-9 * t);
        let e = Math.min(1, i / (0.006 * SR)) * (0.65 + 0.35 * Math.exp(-3 * t)); if (i > rel) e *= Math.exp(-(i - rel) / (0.025 * SR));
        o[i] = 0.55 * v * e;
      }
      return o;
    });
  }
  function pluck(m, dur, bright) { // Karplus-Strong string
    const dq = Math.min(2.4, Math.round(dur * 8) / 8);
    return shot('g' + m + ':' + dq + ':' + bright, () => {
      const f = mtof(m), N = Math.max(2, Math.round(SR / f)), len = Math.floor((dq + 0.1) * SR), o = new Float32Array(len), buf = new Float32Array(N);
      for (let i = 0; i < N; i++) buf[i] = rnd() * 2 - 1;
      let lp = 0; for (let i = 0; i < N; i++) { lp += (buf[i] - lp) * (bright ? 0.7 : 0.45); buf[i] = lp; }
      const damp = 0.996 - f / 90000; const rel = Math.floor(dq * SR); let p = 0;
      for (let i = 0; i < len; i++) {
        const a = buf[p], b = buf[(p + 1) % N]; const v = damp * 0.5 * (a + b); buf[p] = v; p = (p + 1) % N;
        let e = 1; if (i > rel) e = Math.exp(-(i - rel) / (0.03 * SR)); o[i] = 0.45 * a * e;
      }
      return o;
    });
  }
  function lead(m, dur) { // soft melody voice (off by default)
    const dq = Math.min(4, Math.round(dur * 8) / 8);
    return shot('l' + m + ':' + dq, () => {
      const f = mtof(m), len = Math.floor((dq + 0.08) * SR), o = new Float32Array(len), rel = Math.floor(dq * 0.95 * SR);
      for (let i = 0; i < len; i++) {
        const t = i / SR, vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.2 * t) * Math.min(1, t * 3), ph = 2 * Math.PI * f * vib * t;
        let v = Math.sin(ph) + 0.3 * Math.sin(2 * ph) + 0.12 * Math.sin(3 * ph);
        let e = Math.min(1, i / (0.03 * SR)); if (i > rel) e *= Math.exp(-(i - rel) / (0.02 * SR)); o[i] = 0.3 * v * e;
      }
      return o;
    });
  }
  function noise(len, fn) { const o = new Float32Array(len); for (let i = 0; i < len; i++) o[i] = fn(i / SR, rnd() * 2 - 1); return o; }
  const DR = {
    kick: () => shot('kick', () => { let ph = 0; return noise(Math.floor(0.35 * SR), t => { ph += 2 * Math.PI * (48 + 110 * Math.exp(-t * 28)) / SR; return 0.9 * Math.sin(ph) * Math.exp(-t * 9); }); }),
    snare: () => shot('snare', () => { let lp = 0; return noise(Math.floor(0.25 * SR), (t, r) => { lp += (r - lp) * 0.55; return (0.5 * (r - lp * 0.6) * Math.exp(-t * 18) + 0.35 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30)); }); }),
    hat: () => shot('hat', () => { let pr = 0; return noise(Math.floor(0.07 * SR), (t, r) => { const h = r - pr; pr = r; return 0.22 * h * Math.exp(-t * 60); }); }),
    pedal: () => shot('pedal', () => { let pr = 0; return noise(Math.floor(0.06 * SR), (t, r) => { const h = r - pr; pr = r; return 0.15 * h * Math.exp(-t * 70); }); }),
    ride: () => shot('ride', () => { let pr = 0; const fs = [523, 811, 1249, 1693, 2399]; return noise(Math.floor(0.9 * SR), (t, r) => { const h = r - pr; pr = r; let m = 0; fs.forEach(f => m += Math.sign(Math.sin(2 * Math.PI * f * t))); return (0.05 * m * Math.exp(-t * 5) + 0.09 * h * Math.exp(-t * 7)) * 0.8; }); }),
    rim: () => shot('rim', () => noise(Math.floor(0.05 * SR), (t, r) => 0.5 * (Math.sin(2 * Math.PI * 1700 * t) + 0.4 * r) * Math.exp(-t * 90))),
    shaker: () => shot('shaker', () => { let pr = 0; return noise(Math.floor(0.08 * SR), (t, r) => { const h = r - pr; pr = r; return 0.12 * h * Math.sin(Math.PI * Math.min(1, t / 0.08)); }); }),
    clickHi: () => shot('clickHi', () => noise(Math.floor(0.04 * SR), t => 0.5 * Math.sin(2 * Math.PI * 1760 * t) * Math.exp(-t * 120))),
    clickLo: () => shot('clickLo', () => noise(Math.floor(0.04 * SR), t => 0.4 * Math.sin(2 * Math.PI * 1175 * t) * Math.exp(-t * 120))),
    stick: () => shot('stick', () => noise(Math.floor(0.04 * SR), (t, r) => 0.45 * (Math.sin(2 * Math.PI * 2500 * t) * 0.6 + r * 0.5) * Math.exp(-t * 110)))
  };

  // ---------- styles ----------
  const STYLES = [
    { id: 'jazz', name: 'ג׳אז', e: '🎹', desc: 'פסנתר, קונטרבס ותופים, בסווינג', tracks: ['drums', 'bass', 'piano'] },
    { id: 'pop', name: 'רוק / פופ', e: '🎸', desc: 'גיטרה, בס ותופים', tracks: ['drums', 'bass', 'guitar'] },
    { id: 'latin', name: 'לטיני', e: '🪇', desc: 'בוסה נובה: גיטרה, בס וכלי הקשה', tracks: ['drums', 'bass', 'guitar'] },
    { id: 'minimal', name: 'מינימלי', e: '⏱️', desc: 'מטרונום ובס, בלי הסחות', tracks: ['drums', 'bass'] }
  ];
  const TRACKS = { drums: { name: 'תופים', e: '🥁' }, bass: { name: 'בס', e: '🎻' }, piano: { name: 'פסנתר', e: '🎹' }, guitar: { name: 'גיטרה', e: '🎸' }, melody: { name: 'המנגינה שלך', e: '🎵' } };
  function tracksFor(style) { const s = STYLES.find(x => x.id === style) || STYLES[1]; return [...s.tracks, 'melody']; }
  function suggestStyle(score) {
    const trip = score.notes.filter(n => Math.abs(n.d * 3 - Math.round(n.d * 3)) < 0.02 && Math.abs(n.d * 2 - Math.round(n.d * 2)) > 0.05).length;
    if (trip > score.notes.length * 0.08) return 'jazz';
    if (/jazz|swing|ג׳אז|סווינג|blues/i.test(score.title || '')) return 'jazz';
    if (/bossa|latin|samba|בוסה|לטיני/i.test(score.title || '')) return 'latin';
    return 'pop';
  }

  // voicing near a center pitch, keeping close to the previous voicing
  function voicing(ch, center, seventh, prev) {
    const iv = QUAL[ch.q].slice(0, 3).concat(seventh ? [SEVENTH[ch.q]] : []);
    let best = null;
    for (let inv = 0; inv < iv.length; inv++) {
      const pcs = iv.slice(inv).concat(iv.slice(0, inv)); let base = ch.root + pcs[0]; while (base < center - 7) base += 12; while (base >= center + 5) base -= 12;
      const notes = [base]; for (let k = 1; k < pcs.length; k++) { let n = ch.root + pcs[k]; while (n <= notes[k - 1]) n += 12; while (n - 12 > notes[k - 1]) n -= 12; notes.push(n); }
      const avg = notes.reduce((a, b) => a + b) / notes.length; const pv = prev ? prev.reduce((a, b) => a + b) / prev.length : center;
      const sc = Math.abs(avg - pv) + Math.abs(avg - center) * 0.5;
      if (!best || sc < best.sc) best = { notes, sc };
    }
    return best.notes;
  }
  function bassNote(pc, lo) { let n = 28 + mod12(pc - 4); if (lo) return n; return n < 33 ? n + 12 : n; } // E1..D#2 range, nudged up

  // ---------- render ----------
  // jam: {score (concert), gen:{style, tempo, mutes}}; opts.maxBeats renders a preview
  // the band as a list of timed one-shots: [{t (song seconds), s: sound descriptor, g: gain}]
  function compose(score, gen, opts) {
    opts = opts || {}; seed = 12345; const ev = [];
    const bpm = gen.tempo || score.tempo || 100, spb = 60 / bpm, swing = gen.style === 'jazz';
    const meter = Math.round(score.meter || 4) || 4;
    const offset = meter * spb; // one bar of count-in
    const key = gen.key || detectKey(score, 0);
    const chords = inferChords(score, key);
    const total = Math.min(score.totalBeats, opts.maxBeats || Infinity);
    const dur = offset + total * spb + 2.5;
    const mutes = gen.mutes || { melody: true };
    const on = id => tracksFor(gen.style).includes(id) && !mutes[id];
    const GAIN = { count: 0.8, drums: 0.9, bass: 1.0, piano: 0.9, guitar: 0.85, melody: 0.7 };
    const tAt = b => offset + b * spb;
    const sw = b => { const f = b - Math.floor(b); return swing && Math.abs(f - 0.5) < 1e-3 ? Math.floor(b) + 2 / 3 : b; };
    function put(id, desc, b, gain, absT) { ev.push({ t: absT != null ? absT : tAt(sw(b)), s: desc, g: gain * (GAIN[id] || 1) }); }
    // count-in sticks
    if (!opts.noCount) for (let k = 0; k < meter; k++) put('count', P.DR.stick(), 0, k === 0 ? 0.9 : 0.6, k * spb);
    let prevV = null;
    for (let ci = 0; ci < chords.length; ci++) {
      const m = chords[ci]; if (m.start >= total) break;
      const L = m.len, nxt = chords[ci + 1] || m, beats = [];
      for (let k = 0; k < L - 1e-3; k++) beats.push(m.start + k);
      const acc = (x, a) => x * (0.92 + 0.16 * rnd()) * a;
      // drums
      if (on('drums')) {
        beats.forEach((b, k) => {
          const pos = k % 4, last = k === beats.length - 1;
          if (gen.style === 'jazz') {
            put('drums', P.DR.ride(), b, acc(0.55, pos % 2 ? 1 : 0.85));
            if (pos % 2 === 1) { put('drums', P.DR.ride(), b + 0.5, acc(0.38, 1)); put('drums', P.DR.pedal(), b, 0.6); }
            if (pos === 0) put('drums', P.DR.kick(), b, 0.18);
          } else if (gen.style === 'pop') {
            if (pos === 0 || pos === 2) put('drums', P.DR.kick(), b, acc(0.9, 1));
            if (pos === 2 && rnd() < 0.3) put('drums', P.DR.kick(), b + 0.5, 0.6);
            if (pos === 1 || pos === 3) put('drums', P.DR.snare(), b, acc(0.75, 1));
            put('drums', P.DR.hat(), b, acc(0.75, 1)); put('drums', P.DR.hat(), b + 0.5, acc(0.5, 1));
            if (last && ci % 8 === 7) { put('drums', P.DR.snare(), b + 0.5, 0.5); put('drums', P.DR.snare(), b + 0.75, 0.6); }
          } else if (gen.style === 'latin') {
            if (pos === 0 || pos === 2) put('drums', P.DR.kick(), b, 0.6);
            if (pos === 1 || pos === 3) put('drums', P.DR.kick(), b + 0.5, 0.45);
            put('drums', P.DR.shaker(), b, acc(0.7, 1)); put('drums', P.DR.shaker(), b + 0.5, acc(0.45, 1));
            const bar2 = ci % 2 === 1, rims = bar2 ? [1, 2.5] : [0, 1.5, 3];
            rims.forEach(r => { if (Math.floor(r) === k) put('drums', P.DR.rim(), m.start + r, 0.45); });
          } else {
            put('drums', pos === 0 ? P.DR.clickHi() : P.DR.clickLo(), b, pos === 0 ? 0.8 : 0.55);
            put('drums', P.DR.shaker(), b + 0.5, 0.25);
          }
        });
      }
      // bass
      if (on('bass')) {
        const R = bassNote(m.root), fifth = R + 7 > 47 ? R - 5 : R + 7, third = R + QUAL[m.q][1];
        if (gen.style === 'jazz') {
          const nr = bassNote(nxt.root);
          beats.forEach((b, k) => {
            let n;
            if (k === 0) n = R; else if (k === beats.length - 1 && beats.length > 1) n = nr + (rnd() < 0.5 ? 1 : -1);
            else n = [R, third, fifth, R + 12 > 50 ? R : R + 12, R + 2][Math.floor(rnd() * 5)];
            put('bass', P.bass(n, spb * 0.95), b, acc(0.9, 1));
          });
        } else if (gen.style === 'pop') {
          beats.forEach((b, k) => { const pos = k % 4; const n = pos === 2 ? (rnd() < 0.5 ? fifth : R) : R; put('bass', P.bass(n, spb * (pos % 2 ? 0.45 : 0.8)), b, acc(0.85, 1)); if (pos % 2 === 1) put('bass', P.bass(R, spb * 0.4), b + 0.5, acc(0.6, 1)); });
        } else if (gen.style === 'latin') {
          beats.forEach((b, k) => { const pos = k % 4; if (pos === 0) put('bass', P.bass(R, spb * 1.4), b, 0.9); if (pos === 1) put('bass', P.bass(fifth, spb * 0.45), b + 0.5, 0.75); if (pos === 2) put('bass', P.bass(fifth, spb * 1.4), b, 0.85); if (pos === 3) put('bass', P.bass(R, spb * 0.45), b + 0.5, 0.7); });
        } else {
          put('bass', P.bass(R, spb * Math.min(L, 4) * 0.9), m.start, 0.8);
        }
      }
      // comping
      if (on('piano') || on('guitar')) {
        const v = voicing(m, gen.style === 'jazz' ? 62 : 60, gen.style === 'jazz' || gen.style === 'latin', prevV); prevV = v;
        if (gen.style === 'jazz' && on('piano')) {
          const pats = [[[1.5, .5], [3, .6]], [[0, .9], [2.5, .4]], [[1, .5], [2.5, .5], [3.5, .4]], [[0.5, .5], [2, 1.2]]];
          pats[Math.floor(rnd() * pats.length)].forEach(([o, d]) => { if (o < L - 1e-3) v.forEach((n, j) => put('piano', P.piano(n, d * spb), m.start + o, acc(0.32, j === 0 ? 1.1 : 1))); });
        } else if (on('guitar')) {
          const gtr = v.map(n => n - 12 < 52 ? n : n - 12).concat([v[0]]).sort((a, b) => a - b);
          const strum = (b, d, gain, up) => { (up ? gtr.slice().reverse() : gtr).forEach((n, j) => put('guitar', P.pluck(n, d * spb, gen.style === 'pop'), 0, gain * (0.9 + 0.2 * rnd()), tAt(sw(b)) + j * (gen.style === 'pop' ? 0.011 : 0.018))); };
          if (gen.style === 'pop') beats.forEach((b, k) => { strum(b, 0.9, 0.42, false); if (k % 2 === 1) strum(b + 0.5, 0.45, 0.26, true); });
          else { const pat = ci % 2 ? [[0.5, .9], [2, .9], [3.5, .4]] : [[0, 1.4], [1.5, .9], [3, .9]]; pat.forEach(([o, d]) => { if (o < L - 1e-3) strum(m.start + o, d, 0.34, false); }); }
        } else if (on('piano')) {
          v.forEach(n => put('piano', P.piano(n, Math.min(L, 4) * spb * 0.95), m.start, 0.3));
        }
      }
    }
    if (on('melody')) score.notes.forEach(n => { if (n.b < total) put('melody', P.lead(n.c, n.d * spb * 0.95), n.b, 0.8, tAt(n.b)); });
    ev.sort((a, b) => a.t - b.t);
    return { ev, dur, offset, bpm, key, chords };
  }
  const P = { piano: (m, d) => ['piano', m, d], bass: (m, d) => ['bass', m, d], pluck: (m, d, br) => ['pluck', m, d, br], lead: (m, d) => ['lead', m, d], DR: {} };
  Object.keys(DR).forEach(k => { P.DR[k] = () => ['DR', k]; });
  const REAL = { piano, bass, pluck, lead };
  function sound(desc) { return desc[0] === 'DR' ? DR[desc[1]]() : REAL[desc[0]](desc[1], desc[2], desc[3]); }
  const MASTER = 0.45;
  // offline mix of [from, to) seconds (for exporting a take); memory = only that span
  function render(score, gen, opts) {
    opts = opts || {}; const c = compose(score, gen, opts);
    const from = opts.from || 0, to = Math.min(opts.to || c.dur, c.dur), len = Math.max(1, Math.ceil((to - from) * SR)), mix = new Float32Array(len);
    for (const e of c.ev) {
      if (e.t >= to) break; if (e.t < from - 3) continue;
      const buf = sound(e.s), start = Math.round((e.t - from) * SR), end = Math.min(len, start + buf.length), g = e.g * MASTER;
      for (let i = Math.max(0, start); i < end; i++) mix[i] += buf[i - start] * g;
    }
    clearCache(); reverb(mix);
    for (let i = 0; i < len; i++) mix[i] = Math.max(-1, Math.min(1, mix[i]));
    return { data: mix, sr: SR, offset: c.offset, bpm: c.bpm, key: c.key, chords: c.chords };
  }
  function reverb(mix) { // in place
    const len = mix.length;
    const combs = [1116, 1188, 1277, 1356].map(d => ({ d: Math.round(d * SR / 44100), buf: null, p: 0, lp: 0 }));
    combs.forEach(c => c.buf = new Float32Array(c.d));
    const aps = [556, 441].map(d => ({ d: Math.round(d * SR / 44100), buf: null, p: 0 })); aps.forEach(a => a.buf = new Float32Array(a.d));
    for (let i = 0; i < len; i++) {
      const x = mix[i] * 0.06; let s = 0;
      for (const c of combs) { const y = c.buf[c.p]; c.lp = y * 0.6 + c.lp * 0.4; c.buf[c.p] = x + c.lp * 0.78; c.p = (c.p + 1) % c.d; s += y; }
      for (const a of aps) { const b = a.buf[a.p]; const y = -s + b; a.buf[a.p] = s + b * 0.5; a.p = (a.p + 1) % a.d; s = y; }
      mix[i] += s;
    }
  }

  // ---------- live playback: one-shots scheduled ~1 s ahead, so memory stays flat for any song length ----------
  function live(score, gen) {
    const c = compose(score, gen);
    return { isLive: true, duration: c.dur, offset: c.offset, key: c.key, source: ctx => new LiveSource(ctx, c.ev, c.dur) };
  }
  const ctxCache = new WeakMap(); // ctx -> {bufs: Map, bytes, verb}
  function ctxStore(ctx) {
    let st = ctxCache.get(ctx);
    if (!st) { st = { bufs: new Map(), bytes: 0, verb: null }; ctxCache.set(ctx, st); }
    return st;
  }
  function bufFor(ctx, desc) {
    const st = ctxStore(ctx), k = desc.join(':'); let b = st.bufs.get(k);
    if (!b) {
      const d = sound(desc); b = ctx.createBuffer(1, d.length, SR);
      if (b.copyToChannel) b.copyToChannel(d, 0); else b.getChannelData(0).set(d);
      st.bufs.set(k, b); st.bytes += d.length * 4;
      while (st.bytes > 12e6 && st.bufs.size > 1) { const k0 = st.bufs.keys().next().value; st.bytes -= st.bufs.get(k0).length * 4; st.bufs.delete(k0); }
    } else { st.bufs.delete(k); st.bufs.set(k, b); } // most recently used last
    return b;
  }
  function verbFor(ctx) {
    const st = ctxStore(ctx); if (st.verb) return st.verb;
    const sr = ctx.sampleRate, n = Math.floor(1.4 * sr), ir = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = (rnd() * 2 - 1) * Math.pow(1 - i / n, 2.2) * Math.exp(-3 * i / n); }
    return (st.verb = ir);
  }
  function LiveSource(ctx, ev, dur) {
    this.ctx = ctx; this.ev = ev; this.dur = dur; this.onended = null; this.active = new Set(); this.timer = null; this.done = false;
    this.out = ctx.createGain();
    try { const cv = ctx.createConvolver(); cv.buffer = verbFor(ctx); const wet = ctx.createGain(); wet.gain.value = 0.12; this.out.connect(cv); cv.connect(wet); this.wet = wet; this.cv = cv; } catch (e) { this.wet = null; }
  }
  LiveSource.prototype.connect = function (dest) { this.out.connect(dest); if (this.wet) this.wet.connect(dest); return dest; };
  LiveSource.prototype.start = function (when, offset, length) {
    const ctx = this.ctx, ev = this.ev; offset = offset || 0;
    const t0 = when - offset, end = Math.min(this.dur, length != null ? offset + length : this.dur);
    let lo = 0, hi = ev.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (ev[mid].t < offset - 1e-3) lo = mid + 1; else hi = mid; }
    let i = lo; const self = this;
    const play = e => {
      const src = ctx.createBufferSource(); src.buffer = bufFor(ctx, e.s);
      const g = ctx.createGain(); g.gain.value = e.g * MASTER; src.connect(g); g.connect(self.out);
      const at = Math.max(ctx.currentTime, t0 + e.t); const stopAt = t0 + end;
      src.start(at); if (stopAt > at) src.stop(Math.min(stopAt, at + src.buffer.duration)); else src.stop(at);
      self.active.add(src); src.onended = () => { self.active.delete(src); try { g.disconnect(); } catch (x) { } };
    };
    const offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
    if (offline) { for (; i < ev.length && ev[i].t < end; i++) play(ev[i]); return; }
    const pump = () => {
      if (self.done) return;
      const songNow = ctx.currentTime - t0;
      while (i < ev.length && ev[i].t < end && ev[i].t < songNow + 1.2) play(ev[i++]);
      if (songNow >= end) { self.done = true; clearInterval(self.timer); if (self.onended) self.onended(); }
    };
    pump(); this.timer = setInterval(pump, 50);
  };
  LiveSource.prototype.stop = function () {
    this.done = true; clearInterval(this.timer);
    this.active.forEach(s => { try { s.onended = null; s.stop(); } catch (e) { } }); this.active.clear();
    try { this.out.disconnect(); } catch (e) { } try { this.wet && this.wet.disconnect(); } catch (e) { }
  };

  // shift the part to another key: concert pitches move, written names are respelled for the new key
  function transposeScore(score, shift, transpose, key) {
    const sc = JSON.parse(JSON.stringify(score)); if (!shift) return sc;
    const nk = { tonic: mod12(key.tonic + shift), mode: key.mode };
    const flats = useFlats(mod12(nk.tonic + transpose), nk.mode);
    sc.notes.forEach(n => { n.c += shift; n.n = spellMidi(n.c + transpose, flats); });
    return sc;
  }

  g.Band = { STYLES, TRACKS, tracksFor, suggestStyle, detectKey, keyName, inferChords, render, compose, sound, live, clearCache, MASTER, SR, transposeScore, mod12 };
  // also runs as a Web Worker, so long songs render without freezing the page
  if (typeof document === 'undefined' && typeof g.postMessage === 'function') {
    g.onmessage = e => {
      try { const r = render(e.data.score, e.data.gen, e.data.opts); g.postMessage({ ok: true, data: r.data, sr: r.sr, offset: r.offset }, [r.data.buffer]); }
      catch (err) { g.postMessage({ ok: false, error: String(err && err.message || err) }); }
    };
  }
})(typeof window !== 'undefined' ? window : self);
