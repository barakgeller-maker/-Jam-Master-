// Offline analysis of a take: compares the player's recording to the score reference.
(function (g) {
  'use strict';
  const M = g.Music;
  const HOP = 0.012; // seconds per analysis frame

  function downsample(x, sr) {
    const f = Math.max(1, Math.round(sr / 12000)); if (f === 1) return { y: x, sr };
    const n = Math.floor(x.length / f), y = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; const o = i * f; for (let k = 0; k < f; k++) s += x[o + k]; y[i] = s / f; }
    return { y, sr: sr / f };
  }
  const tick = () => new Promise(r => setTimeout(r, 0));

  // pitch + energy track. returns {midi: Float32Array (NaN = unvoiced), rms: Float32Array, hop}
  async function track(samples, sr, inst, onProgress) {
    const { y, sr: dsr } = downsample(samples, sr);
    const hop = Math.round(HOP * dsr), win = Math.round(0.05 * dsr);
    const nF = Math.max(0, Math.floor((y.length - win) / hop));
    const r = new Float32Array(nF), midi = new Float32Array(nF).fill(NaN);
    for (let i = 0; i < nF; i++) { let s = 0; const o = i * hop; for (let k = 0; k < win; k++) s += y[o + k] * y[o + k]; r[i] = Math.sqrt(s / win); }
    const sorted = Float32Array.from(r).sort();
    const noise = sorted[Math.floor(nF * 0.15)] || 0;
    const thr = Math.max(0.004, noise * 3.5);
    const minF = 440 * Math.pow(2, (inst.low - 3 - 69) / 12), maxF = 440 * Math.pow(2, (inst.high + 3 - 69) / 12);
    for (let i = 0; i < nF; i++) {
      if (r[i] < thr) continue;
      const fr = y.subarray(i * hop, i * hop + win);
      const p = M.yin(fr, dsr, minF, maxF, 0.2);
      if (p && p.f >= minF && p.f <= maxF) midi[i] = p.midi;
      if ((i & 511) === 0) { onProgress && onProgress(i / nF); await tick(); }
    }
    // median-of-3 cleanup of isolated octave jumps
    const out = Float32Array.from(midi);
    for (let i = 1; i < nF - 1; i++) {
      const a = midi[i - 1], b = midi[i], c = midi[i + 1];
      if (!isNaN(a) && !isNaN(b) && !isNaN(c)) { const s = [a, b, c].sort((p, q) => p - q); out[i] = s[1]; }
    }
    return { midi: out, rms: r, thr, hop: hop / dsr, off: 0.45 * win / dsr };
  }

  function onsets(tr) {
    const { midi, rms, thr } = tr, n = rms.length, res = [];
    const voiced = i => i >= 0 && i < n && rms[i] >= thr && !isNaN(midi[i]);
    const lr = Array.from(rms, v => Math.log(v + 1e-5));
    for (let i = 3; i < n - 2; i++) {
      if (!voiced(i) || !voiced(i + 1)) continue;
      let cause = null;
      const prevV = (voiced(i - 1) ? 1 : 0) + (voiced(i - 2) ? 1 : 0) + (voiced(i - 3) ? 1 : 0);
      if (prevV <= 1 && !voiced(i - 1)) cause = 'start';
      else {
        const mn = Math.min(lr[i - 1], lr[i - 2], lr[i - 3], lr[i - 4] ?? lr[i - 3]);
        if (lr[i + 1] - mn > 0.55 && lr[i] > mn + 0.3) cause = 'attack';
        else if (voiced(i - 2) && Math.abs(midi[i] - midi[i - 2]) > 0.7 && voiced(i + 2) && Math.abs(midi[i + 2] - midi[i]) < 0.5) cause = 'pitch';
      }
      if (cause) {
        if (res.length && i - res[res.length - 1].i < 5) continue;
        res.push({ i, t: i * tr.hop, cause });
      }
    }
    return res;
  }

  function wrap12(x) { return ((x % 12) + 18) % 12 - 6; }
  function median(a) { if (!a.length) return NaN; const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; }

  // job: {samples, sr, songTime0, startT, endT, score, beatTimes, instrumentId}
  async function analyze(job, onProgress) {
    const inst = M.instrument(job.instrumentId);
    const bm = M.makeBeatMap(job.beatTimes);
    const tr = await track(job.samples, job.sr, inst, onProgress);
    const ons = onsets(tr);
    const t2f = t => Math.round((t - job.songTime0 - tr.off) / tr.hop); // song time -> frame
    const f2t = f => job.songTime0 + tr.off + f * tr.hop;
    const voicedAt = f => f >= 0 && f < tr.rms.length && tr.rms[f] >= tr.thr && !isNaN(tr.midi[f]);
    const recEnd = f2t(tr.rms.length - 1);
    const lo = Math.max(job.startT, job.songTime0) + 0.15, hi = Math.min(job.endT, recEnd) - 0.1;

    const notes = job.score.notes.map((n, idx) => ({ ...n, idx, ts: bm.toTime(n.b), te: bm.toTime(n.b + n.d) }))
      .filter(n => n.ts >= lo && n.ts <= hi);
    const results = [];
    let prev = null;
    for (const n of notes) {
      const spb = bm.secPerBeatAt(n.b);
      const tol = Math.max(0.09, Math.min(0.16, 0.22 * spb));
      const dur = n.te - n.ts;
      const wA = n.ts - Math.min(0.3, spb * 0.6), wB = n.ts + Math.min(0.3, dur * 0.6);
      let best = null;
      for (const o of ons) { const t = f2t(o.i); if (t < wA || t > wB) continue; if (!best || Math.abs(t - n.ts) < Math.abs(best.t - n.ts)) best = { t, o }; }
      // voiced fraction over note body
      const fa = t2f(n.ts + 0.03), fb = t2f(n.te - 0.03); let v = 0, tot = 0; const pitches = [];
      const pa = t2f(Math.max(best ? best.t : n.ts, n.ts) + 0.05), pb = Math.max(pa + 2, t2f(n.te - 0.03));
      for (let f = fa; f <= fb; f++) { tot++; if (voicedAt(f)) v++; }
      for (let f = pa; f <= pb; f++) if (voicedAt(f)) pitches.push(tr.midi[f]);
      const vf = tot ? v / tot : 0;
      const res = { idx: n.idx, m: n.m, b: n.b, ts: n.ts, c: n.c, n: n.n, d: n.d, status: 'ok' };
      const sameAsPrev = prev && prev.c === n.c && Math.abs(prev.b + prev.d - n.b) < 0.01;
      if (vf < 0.25 && !best) { res.status = 'missed'; }
      else {
        const med = median(pitches);
        if (isNaN(med)) { res.status = best ? 'ok' : 'missed'; }
        else {
          const diff = wrap12(med - n.c); res.played = med; res.cents = Math.round(diff * 100);
          if (Math.abs(diff) > 0.6) { res.status = 'wrong'; res.playedMidi = Math.round(n.c + Math.round(diff)); }
        }
        if (best && res.status !== 'missed') {
          res.delta = +(best.t - n.ts).toFixed(3);
          if (res.status === 'ok') {
            if (res.delta > tol) res.status = 'late'; else if (res.delta < -tol) res.status = 'early';
          }
        } else if (!best && res.status === 'ok' && !sameAsPrev) {
          // sound present but no clear attack: was the player already holding the previous note into this one?
          const pre = t2f(n.ts - 0.08); if (!voicedAt(pre)) { res.status = 'late'; res.delta = null; }
        }
      }
      results.push(res); prev = n;
    }

    // playing during rests
    const extras = [];
    const sNotes = job.score.notes.map(n => ({ s: bm.toTime(n.b), e: bm.toTime(n.b + n.d), b: n.b, d: n.d }));
    const gaps = [];
    for (let i = 0; i <= sNotes.length; i++) {
      const gs = i === 0 ? -1e9 : sNotes[i - 1].e, ge = i === sNotes.length ? 1e9 : sNotes[i].s;
      const a = Math.max(gs + 0.4, lo), b = Math.min(ge - 0.35, hi);
      if (b - a > 0.9) gaps.push([a, b]);
    }
    for (const [a, b] of gaps) {
      let run = 0, runStart = null, bestRun = 0, bestStart = null;
      for (let f = t2f(a); f <= t2f(b); f++) {
        if (voicedAt(f)) { if (!run) runStart = f; run++; if (run > bestRun) { bestRun = run; bestStart = runStart; } } else run = 0;
      }
      if (bestRun * tr.hop > 0.6) {
        const t = f2t(bestStart); const mb = M.measureAt(job.score, bm.toBeat(t + 0.08));
        extras.push({ t, m: mb.m, len: +(bestRun * tr.hop).toFixed(1) });
      }
    }

    // stats
    const count = s => results.filter(r => r.status === s).length;
    const deltas = results.filter(r => typeof r.delta === 'number' && (r.status === 'ok' || r.status === 'late' || r.status === 'early')).map(r => r.delta);
    const cents = results.filter(r => (r.status === 'ok' || r.status === 'late' || r.status === 'early') && typeof r.cents === 'number').map(r => r.cents);
    const meanDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
    const sdDelta = deltas.length > 1 ? Math.sqrt(deltas.reduce((a, b) => a + (b - meanDelta) ** 2, 0) / deltas.length) : 0;
    const stats = {
      total: results.length, ok: count('ok'), wrong: count('wrong'), missed: count('missed'), late: count('late'), early: count('early'), extra: extras.length,
      meanDeltaMs: Math.round(meanDelta * 1000), sdDeltaMs: Math.round(sdDelta * 1000), medianCents: cents.length ? Math.round(median(cents)) : 0,
    };
    const penal = stats.wrong + stats.missed + 0.5 * (stats.late + stats.early) + 0.5 * stats.extra;
    stats.score = stats.total ? Math.max(0, Math.round(100 * (1 - penal / Math.max(stats.total, 1)))) : 0;
    return { results, extras, stats, tips: tips(stats, results, extras, inst) };
  }

  function tips(st, results, extras, inst) {
    const out = [];
    if (!st.total) { out.push({ e: '🤔', t: 'בקטע שהוקלט אין תווים שלך לפי התווים, אז לא היה מה לבדוק. נסה להקליט קטע שבו אתה מנגן.' }); return out; }
    const isSax = /sax|סקסופון/.test(inst.id + inst.name) || ['alto', 'tenor', 'soprano', 'bari'].includes(inst.id);
    if (st.meanDeltaMs > 140 && st.sdDeltaMs < 60 && st.late > st.total * 0.5)
      out.push({ e: '🎧', t: `כמעט כל הכניסות מאחרות באותה כמות (כ-${st.meanDeltaMs} מ״ש). זה נראה כמו השהיה של האוזניות (בלוטות׳) ולא כמו טעות שלך. עדיף אוזניות חוטיות, או לכייל את ההשהיה בהגדרות.` });
    else if (st.meanDeltaMs > 45)
      out.push({ e: '⏱️', t: `אתה נוטה לאחר בממוצע ב-${st.meanDeltaMs} מ״ש. קח אוויר כבר בפעמה שלפני הכניסה, והיעזר בספירה לאחור שעל המסך.` });
    else if (st.meanDeltaMs < -45)
      out.push({ e: '🏃', t: `אתה נוטה למהר בממוצע ב-${-st.meanDeltaMs} מ״ש. הקשב לתופים ולבס, ותן לפעמה "לנחות" לפני שאתה נכנס.` });
    if (st.wrong) {
      const ms = {}; results.filter(r => r.status === 'wrong').forEach(r => ms[r.m] = (ms[r.m] || 0) + 1);
      const worst = Object.entries(ms).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]).sort((a, b) => a - b);
      out.push({ e: '🎯', t: (st.wrong === 1 ? `היה תו אחד לא נכון, בתיבה ${worst[0]}.` : `היו ${st.wrong} תווים לא נכונים, ${worst.length > 1 ? 'בעיקר בתיבות ' + worst.join(', ') : 'בתיבה ' + worst[0]}.`) + ` נגן את הקטעים האלה לאט בלי השיר, ואז חזור עליהם במצב "עצירה בטעות".` });
    }
    if (st.missed > Math.max(1, st.total * 0.1))
      out.push({ e: '👂', t: `פספסת ${st.missed} תווים. אם אלה כניסות אחרי הפסקה ארוכה, ספור את התיבות לפי המספר הגדול על המסך.` });
    if (st.extra) out.push({ e: '🤫', t: `ניגנת ${st.extra === 1 ? 'במקום אחד' : 'ב-' + st.extra + ' מקומות'} שבו צריך לשתוק. שווה לבדוק בתווים את אורך ההפסקות שם.` });
    if (Math.abs(st.medianCents) >= 18) {
      const sharp = st.medianCents > 0;
      out.push({ e: '🎚️', t: `הכיוון שלך ${sharp ? 'גבוה' : 'נמוך'} בכ-${Math.abs(st.medianCents)} סנט. ` + (isSax ? (sharp ? 'משוך את הפומית מעט החוצה ורפה את הלסת.' : 'דחוף את הפומית מעט פנימה ותמוך יותר באוויר.') : 'כוון את הכלי לפני הנגינה.') });
    }
    if (!out.length || st.score >= 90) out.unshift({ e: '🌟', t: st.score >= 90 ? 'ביצוע מצוין! אתה מסונכרן עם ההרכב ומנגן נכון. נסה עכשיו את כל השיר ברצף.' : 'נשמע טוב. המשך לתרגל את הקטעים המסומנים.' });
    return out;
  }

  g.Analysis = { analyze, track, onsets, wrap12 };
})(window);
