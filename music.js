// Music helpers: instruments, note names, beat maps, MusicXML import, pitch detection.
(function (g) {
  'use strict';

  // transpose = semitones from concert pitch to written pitch for the instrument
  const INSTRUMENTS = [
    { id: 'alto', name: 'סקסופון אלט', e: '🎷', transpose: 9, key: 'Eb', low: 49, high: 81 },
    { id: 'tenor', name: 'סקסופון טנור', e: '🎷', transpose: 14, key: 'Bb', low: 44, high: 76 },
    { id: 'soprano', name: 'סקסופון סופרן', e: '🎷', transpose: 2, key: 'Bb', low: 56, high: 88 },
    { id: 'bari', name: 'סקסופון בריטון', e: '🎷', transpose: 21, key: 'Eb', low: 36, high: 69 },
    { id: 'trumpet', name: 'חצוצרה', e: '🎺', transpose: 2, key: 'Bb', low: 52, high: 84 },
    { id: 'clarinet', name: 'קלרינט', e: '🎵', transpose: 2, key: 'Bb', low: 50, high: 91 },
    { id: 'flute', name: 'חליל', e: '🪈', transpose: 0, key: 'C', low: 60, high: 96 },
    { id: 'trombone', name: 'טרומבון', e: '🎺', transpose: 0, key: 'C', low: 40, high: 72 },
    { id: 'violin', name: 'כינור', e: '🎻', transpose: 0, key: 'C', low: 55, high: 100 },
    { id: 'voice', name: 'שירה', e: '🎤', transpose: 0, key: 'C', low: 40, high: 84 },
    { id: 'other', name: 'כלי אחר (בצליל אמיתי)', e: '🎶', transpose: 0, key: 'C', low: 36, high: 96 },
  ];
  const instrument = id => INSTRUMENTS.find(i => i.id === id) || INSTRUMENTS[0];

  const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const SOLF = { C: 'דו', D: 'רה', E: 'מי', F: 'פה', G: 'סול', A: 'לה', B: 'סי' };
  function midiName(m) { const n = SHARP[((Math.round(m) % 12) + 12) % 12]; return n; }
  function solfege(letterName) { // "F#5" or "F#" -> "פה#"
    const mm = /^([A-G])(#|b)?/.exec(letterName || ''); if (!mm) return '';
    return SOLF[mm[1]] + (mm[2] === '#' ? '♯' : mm[2] === 'b' ? '♭' : '');
  }
  function pretty(letterName) { return (letterName || '').replace(/\d+$/, '').replace('#', '♯').replace(/([A-G])b/, '$1♭'); }

  // ---- beat map: score beat (float) <-> song seconds ----
  function makeBeatMap(beatTimes) {
    const bt = beatTimes, n = bt.length;
    const first = (bt[1] - bt[0]), last = (bt[n - 1] - bt[n - 2]);
    return {
      toTime(b) {
        if (b <= 0) return bt[0] + b * first;
        if (b >= n - 1) return bt[n - 1] + (b - (n - 1)) * last;
        const i = Math.floor(b), f = b - i; return bt[i] + f * (bt[i + 1] - bt[i]);
      },
      toBeat(t) {
        if (t <= bt[0]) return (t - bt[0]) / first;
        if (t >= bt[n - 1]) return (n - 1) + (t - bt[n - 1]) / last;
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (bt[mid] <= t) lo = mid; else hi = mid; }
        return lo + (t - bt[lo]) / (bt[hi] - bt[lo]);
      },
      secPerBeatAt(b) { const i = Math.max(0, Math.min(n - 2, Math.floor(b))); return bt[i + 1] - bt[i]; }
    };
  }
  function linearBeatTimes(offset, bpm, totalBeats) {
    const out = []; for (let b = 0; b <= totalBeats + 1; b++) out.push(+(offset + b * 60 / bpm).toFixed(4)); return out;
  }
  // measure index (1-based) and beat-in-measure for a score beat
  function measureAt(score, b) {
    const ms = score.measureStart; let lo = 0, hi = ms.length - 1;
    if (b < ms[0]) return { m: 1, beat: 0 };
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ms[mid] <= b) lo = mid; else hi = mid - 1; }
    return { m: lo + 1, beat: b - ms[lo] };
  }
  function sectionAt(score, b) {
    let s = null; for (const x of score.sections || []) if (x.beat <= b + 1e-6) s = x; return s;
  }

  // ---- MusicXML ----
  async function unzipFirstXml(buf) {
    const dv = new DataView(buf); const u8 = new Uint8Array(buf); const files = {};
    // find end of central directory
    let eocd = -1; for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('zip');
    const cnt = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    for (let k = 0; k < cnt; k++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
      files[name] = { method, csize, lho }; p += 46 + nl + xl + cl;
    }
    async function read(name) {
      const f = files[name]; const ln = dv.getUint16(f.lho + 26, true), lx = dv.getUint16(f.lho + 28, true);
      const data = u8.subarray(f.lho + 30 + ln + lx, f.lho + 30 + ln + lx + f.csize);
      if (f.method === 0) return dec.decode(data);
      const ds = new DecompressionStream('deflate-raw');
      const out = await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer();
      return dec.decode(out);
    }
    let target = null;
    if (files['META-INF/container.xml']) {
      const c = await read('META-INF/container.xml'); const m = /full-path="([^"]+)"/.exec(c); if (m) target = m[1];
    }
    if (!target) target = Object.keys(files).find(n => /\.(xml|musicxml)$/i.test(n) && !n.startsWith('META-INF'));
    return read(target);
  }

  const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  // returns score object with concert-pitch notes (c), written names (n) for chosen instrument
  function parseMusicXML(text, writtenTranspose) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('הקובץ לא נקרא כ-MusicXML');
    const part = doc.querySelector('part'); if (!part) throw new Error('לא נמצא חלק בקובץ');
    const title = (doc.querySelector('work-title') || doc.querySelector('movement-title') || {}).textContent || '';
    let divisions = 1, beatsPerMeasure = 4, beatType = 4, tempo = 0, chromaticT = null;
    const measureStart = [], notes = [], sections = [];
    let pos = 0; // in quarter beats
    let pendingTie = null; let meter = 4; let pickup = 0;
    const measures = [...part.children].filter(e => e.tagName === 'measure');
    measures.forEach((mEl, mi) => {
      measureStart.push(+pos.toFixed(4));
      let cur = 0, maxCur = 0;
      for (const el of mEl.children) {
        const tag = el.tagName;
        if (tag === 'attributes') {
          const d = el.querySelector('divisions'); if (d) divisions = +d.textContent;
          const b = el.querySelector('time beats'), bt = el.querySelector('time beat-type');
          if (b && bt) { beatsPerMeasure = +b.textContent; beatType = +bt.textContent; if (mi === 0) meter = beatsPerMeasure * 4 / beatType; }
          const tr = el.querySelector('transpose chromatic'); if (tr) chromaticT = +tr.textContent + 12 * (+(el.querySelector('transpose octave-change') || { textContent: 0 }).textContent || 0);
        } else if (tag === 'direction') {
          const s = el.querySelector('sound[tempo]'); if (s && !tempo) tempo = +s.getAttribute('tempo');
          const reh = el.querySelector('rehearsal'); if (reh) sections.push({ m: mi + 1, name: reh.textContent.trim(), beat: +(pos + cur).toFixed(4) });
        } else if (tag === 'sound' && el.getAttribute('tempo') && !tempo) { tempo = +el.getAttribute('tempo'); }
        else if (tag === 'backup') { cur -= (+el.querySelector('duration').textContent) / divisions; }
        else if (tag === 'forward') { cur += (+el.querySelector('duration').textContent) / divisions; maxCur = Math.max(maxCur, cur); }
        else if (tag === 'note') {
          const voice = (el.querySelector('voice') || { textContent: '1' }).textContent;
          const isChord = !!el.querySelector('chord'); const isGrace = !!el.querySelector('grace');
          if (isGrace) continue;
          const durEl = el.querySelector('duration'); const dur = durEl ? (+durEl.textContent) / divisions : 0;
          if (voice !== '1') { if (!isChord) { cur += dur; maxCur = Math.max(maxCur, cur); } continue; }
          if (isChord) continue; // keep top/first note only
          const start = pos + cur;
          if (!el.querySelector('rest')) {
            const step = el.querySelector('pitch step').textContent, oct = +el.querySelector('pitch octave').textContent;
            const alt = +((el.querySelector('pitch alter') || { textContent: 0 }).textContent || 0);
            const sounding = 12 * (oct + 1) + STEP[step] + alt;
            const ties = [...el.querySelectorAll('tie')].map(t => t.getAttribute('type'));
            const altStr = alt > 0 ? '#' : alt < 0 ? 'b' : '';
            let curNote;
            if (pendingTie && pendingTie.raw === sounding && ties.includes('stop')) {
              pendingTie.d = +(pendingTie.d + dur).toFixed(4); curNote = pendingTie;
            } else {
              curNote = { b: +start.toFixed(4), d: +dur.toFixed(4), raw: sounding, m: mi + 1, n: step + altStr + oct };
              notes.push(curNote);
            }
            pendingTie = ties.includes('start') ? curNote : null;
          } else pendingTie = null;
          cur += dur; maxCur = Math.max(maxCur, cur);
        }
      }
      const len = Math.max(maxCur, cur);
      if (mi === 0 && (mEl.getAttribute('implicit') === 'yes' || len < meter - 1e-6)) pickup = len;
      pos += len || meter;
    });
    // MusicXML pitches are written pitch for transposing parts; <transpose chromatic> gives written->concert
    // no <transpose> element means the file is already in concert pitch
    const tConcert = chromaticT != null ? chromaticT : 0; // concert = written + chromatic
    for (const n of notes) { n.c = n.raw + tConcert; delete n.raw; }
    if (!sections.length) sections.push({ m: 1, name: 'התחלה', beat: 0 });
    return { title, meter, tempo: tempo || 100, pickup, measureStart, totalBeats: +pos.toFixed(4), sections, notes, writtenFromFile: chromaticT == null };
  }

  // ---- YIN pitch detection ----
  function yin(buf, sr, minF, maxF, thresh) {
    thresh = thresh || 0.15;
    const maxTau = Math.min(Math.floor(sr / minF), (buf.length >> 1) - 1), minTau = Math.max(2, Math.floor(sr / maxF));
    const W = buf.length - maxTau; if (W < 32) return null;
    const d = new Float32Array(maxTau + 1);
    for (let tau = 1; tau <= maxTau; tau++) {
      let s = 0; for (let i = 0; i < W; i++) { const x = buf[i] - buf[i + tau]; s += x * x; } d[tau] = s;
    }
    let run = 0; d[0] = 1; let tauBest = -1;
    for (let tau = 1; tau <= maxTau; tau++) { run += d[tau]; d[tau] = run ? d[tau] * tau / run : 1; }
    for (let tau = minTau; tau <= maxTau; tau++) {
      if (d[tau] < thresh) { while (tau + 1 <= maxTau && d[tau + 1] < d[tau]) tau++; tauBest = tau; break; }
    }
    if (tauBest < 0) return null;
    const a = d[tauBest - 1] || d[tauBest], b = d[tauBest], c = d[tauBest + 1] || d[tauBest];
    const den = (a + c - 2 * b); const shift = den ? (a - c) / (2 * den) : 0;
    const f = sr / (tauBest + shift);
    return { f, midi: 69 + 12 * Math.log2(f / 440), conf: 1 - b };
  }
  function rms(buf) { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); }

  g.Music = { INSTRUMENTS, instrument, midiName, solfege, pretty, makeBeatMap, linearBeatTimes, measureAt, sectionAt, parseMusicXML, unzipFirstXml, yin, rms };
})(window);
