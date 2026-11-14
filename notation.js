// Scrolling staff: draws the player's part (written pitch for their instrument) as one long line
// of music and keeps the current beat under a fixed playhead.
(function (g) {
  'use strict';
  const SHARP = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  const STEP_SEMI = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const DUR = [[4, 'w', 0], [3, 'h', 1], [2, 'h', 0], [1.5, 'q', 1], [1, 'q', 0], [0.75, '8', 1], [0.5, '8', 0], [0.25, '16', 0], [0.125, '32', 0]];
  const EPS = 1e-3;
  let vfPromise = null;
  function loadVexFlow() {
    if (g.Vex && g.Vex.Flow) return Promise.resolve(g.Vex.Flow);
    if (!vfPromise) vfPromise = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'vendor/vexflow-bravura.js';
      s.onload = () => res(g.Vex.Flow); s.onerror = () => { vfPromise = null; rej(new Error('vexflow')); };
      document.head.appendChild(s);
    });
    return vfPromise;
  }

  // "F#5" / "Eb5" / "E#5" -> {letter, acc, oct}; or from midi with sharps
  function spell(name, midi) {
    const m = name && /^([A-G])(#{1,2}|b{1,2})?(-?\d)$/.exec(name);
    if (m) return { letter: m[1].toLowerCase(), acc: m[2] || '', oct: +m[3] };
    const n = SHARP[((midi % 12) + 12) % 12]; return { letter: n[0], acc: n.slice(1), oct: Math.floor(midi / 12) - 1 };
  }
  // split a duration (in beats) starting at `pos` into printable values
  function pieces(len) {
    const out = []; let left = len;
    while (left > EPS) {
      if (Math.abs(left - 1 / 3) < 0.02 || Math.abs(left - 2 / 3) < 0.02) { out.push({ beats: left, trip: true }); break; }
      const d = DUR.find(x => x[0] <= left + EPS); if (!d) break;
      out.push({ beats: d[0], code: d[1], dots: d[2] }); left -= d[0];
    }
    return out;
  }

  // build per-measure event lists (notes split at bar lines, gaps filled with rests)
  function layout(score, transpose, namesFor, instrumentId) {
    const ms = score.measureStart, total = score.totalBeats, nM = ms.length;
    const mEnd = i => (i + 1 < nM ? ms[i + 1] : total);
    const measures = ms.map((s, i) => ({ i, start: s, end: mEnd(i), ev: [] }));
    const at = b => { let lo = 0, hi = nM - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ms[mid] <= b + EPS) lo = mid; else hi = mid - 1; } return lo; };
    score.notes.forEach((n, idx) => {
      const sp = spell(namesFor === instrumentId ? n.n : null, n.c + transpose);
      let b = n.b, left = n.d, first = true;
      while (left > EPS) {
        const mi = at(b), room = measures[mi].end - b; if (room <= EPS) break; // never loop on notes past the last bar
        const take = Math.min(left, room);
        measures[mi].ev.push({ kind: 'n', b, d: take, sp, idx, tieIn: !first });
        b += take; left -= take; first = false;
      }
    });
    for (const m of measures) {
      m.ev.sort((a, b) => a.b - b.b);
      const filled = []; let pos = m.start;
      for (const e of m.ev) { if (e.b - pos > EPS) filled.push({ kind: 'r', b: pos, d: e.b - pos }); filled.push(e); pos = e.b + e.d; }
      if (m.end - pos > EPS && m.ev.length) filled.push({ kind: 'r', b: pos, d: m.end - pos });
      m.ev = filled; m.empty = !m.ev.some(e => e.kind === 'n');
    }
    // group runs of empty measures into blocks
    const blocks = []; let i = 0;
    while (i < nM) {
      if (measures[i].empty) { let j = i; while (j + 1 < nM && measures[j + 1].empty) j++; blocks.push({ rest: true, from: i, to: j, start: measures[i].start, end: measures[j].end }); i = j + 1; }
      else { blocks.push({ rest: false, from: i, to: i, start: measures[i].start, end: measures[i].end, m: measures[i] }); i++; }
    }
    return blocks;
  }

  async function render(host, jam, theme) {
    const VF = await loadVexFlow();
    const score = jam.score; const M = g.Music; const inst = M.instrument(jam.instrument);
    const blocks = layout(score, inst.transpose, score.namesFor, jam.instrument);
    host.innerHTML = '';
    const view = document.createElement('div'); view.className = 'score-view';
    const strip = document.createElement('div'); strip.className = 'score-strip';
    const head = document.createElement('div'); head.className = 'score-head';
    view.appendChild(strip); view.appendChild(head); host.appendChild(view);
    const H = 114, staveY = 30, meter = score.meter || 4, SC = 1.3;
    view.style.height = Math.round(H * SC) + 'px';
    head.style.top = Math.round((staveY - 8) * SC) + 'px'; head.style.height = Math.round(56 * SC) + 'px';
    // widths
    let x = 10; const geo = [];
    blocks.forEach((bk, k) => {
      let w;
      if (bk.rest) w = bk.to > bk.from ? 120 : 80;
      else w = 46 + bk.m.ev.reduce((a, e) => a + (e.kind === 'n' ? (e.d <= 0.5 ? 26 : 34) : 22), 0);
      if (k === 0) w += 70; // clef + time
      geo.push({ x, w }); x += w;
    });
    const width = x + 20;
    const renderer = new VF.Renderer(strip, VF.Renderer.Backends.SVG);
    renderer.resize(Math.ceil(width * SC), Math.ceil(H * SC));
    const ctx = renderer.getContext(); ctx.scale(SC, SC);
    ctx.setFillStyle(theme.ink); ctx.setStrokeStyle(theme.ink);
    const anchors = []; // [beat, x]
    const noteEls = {}; // score note idx -> [svg elements]
    let prevPiece = null; const ties = [];
    blocks.forEach((bk, k) => {
      const { x: bx, w } = geo[k];
      const stave = new VF.Stave(bx, staveY, w, { space_above_staff_ln: 0 });
      if (k === 0) { stave.addClef('treble'); if (Number.isInteger(meter)) stave.addTimeSignature(meter + '/4'); }
      stave.setContext(ctx).draw();
      const sx = stave.getNoteStartX(), ex = stave.getNoteEndX();
      if (bk.rest) {
        const n = bk.to - bk.from + 1;
        if (n > 1) new VF.MultiMeasureRest(n, { number_of_measures: n }).setStave(stave).setContext(ctx).draw();
        else { const r = new VF.StaveNote({ keys: ['d/5'], duration: 'wr', align_center: true }); const v = new VF.Voice({ num_beats: meter, beat_value: 4 }).setStrict(false); v.addTickables([r]); new VF.Formatter().joinVoices([v]).format([v], ex - sx - 10); v.draw(ctx, stave); }
        // label measure numbers of the block
        ctx.save(); ctx.setFont('Heebo, Arial', 10, 'normal'); ctx.setFillStyle(theme.dim);
        ctx.fillText(String(bk.from + 1) + (n > 1 ? '–' + (bk.to + 1) : ''), k === 0 ? sx : bx + 3, staveY - 6); ctx.restore();
        anchors.push([bk.start, sx], [bk.end, ex + 4]);
        prevPiece = null; return;
      }
      ctx.save(); ctx.setFont('Heebo, Arial', 10, 'normal'); ctx.setFillStyle(theme.dim); ctx.fillText(String(bk.from + 1), k === 0 ? sx : bx + 3, staveY - 6); ctx.restore();
      const notes = [], meta = []; const accState = {};
      for (const e of bk.m.ev) {
        for (const p of pieces(e.d)) {
          let vfn;
          if (e.kind === 'r') {
            if (p.trip) { vfn = new VF.StaveNote({ keys: ['b/4'], duration: Math.abs(p.beats - 1 / 3) < 0.02 ? '8r' : 'qr' }); }
            else vfn = new VF.StaveNote({ keys: [p.code === 'w' ? 'd/5' : 'b/4'], duration: p.code + 'r', dots: p.dots });
            meta.push({ e, p, rest: true });
          } else {
            const sp = e.sp; const key = sp.letter + sp.acc + '/' + sp.oct;
            const code = p.trip ? (Math.abs(p.beats - 1 / 3) < 0.02 ? '8' : 'q') : p.code;
            vfn = new VF.StaveNote({ keys: [key], duration: code, dots: p.trip ? 0 : p.dots, auto_stem: true });
            const st = sp.letter + sp.oct; const accNow = sp.acc || 'n';
            const shown = accState[st] !== undefined ? accState[st] : 'n';
            const isTieCont = (e.tieIn || (prevPiece && prevPiece.e === e));
            if (!isTieCont && accNow !== shown) vfn.addModifier(new VF.Accidental(sp.acc || 'n'), 0);
            accState[st] = accNow;
            meta.push({ e, p });
          }
          if (!p.trip && p.dots) VF.Dot.buildAndAttach([vfn], { all: true });
          // tie between consecutive pieces of the same score note
          const cur = { vfn, e };
          if (e.kind === 'n' && prevPiece && prevPiece.e.kind === 'n' && prevPiece.e.idx === e.idx) ties.push([prevPiece.vfn, vfn]);
          prevPiece = e.kind === 'n' ? cur : null;
          notes.push(vfn);
        }
      }
      const voice = new VF.Voice({ num_beats: meter, beat_value: 4 }).setStrict(false);
      voice.addTickables(notes);
      // triplets
      const tuplets = []; let run = [];
      meta.forEach((m, i) => { if (m.p.trip) { run.push(notes[i]); if (run.length === 3) { tuplets.push(new VF.Tuplet(run, { num_notes: 3, notes_occupied: 2, ratioed: false, bracketed: false })); run = []; } } else run = []; });
      const beams = VF.Beam.generateBeams(notes.filter((n, i) => !meta[i].rest), { groups: [new VF.Fraction(2, 8)] });
      new VF.Formatter().joinVoices([voice]).format([voice], Math.max(30, ex - sx - 12));
      voice.draw(ctx, stave);
      beams.forEach(b => b.setContext(ctx).draw());
      tuplets.forEach(t => t.setContext(ctx).draw());
      anchors.push([bk.start, sx]);
      notes.forEach((n, i) => {
        const m = meta[i];
        // anchor each printed note at its beat
        const pb = m.e.b + meta.slice(0, i).filter(q => q.e === m.e).reduce((a, q) => a + q.p.beats, 0);
        anchors.push([pb, n.getAbsoluteX()]);
        if (!m.rest) { const el = n.getSVGElement && n.getSVGElement(); if (el) (noteEls[m.e.idx] = noteEls[m.e.idx] || []).push(el); }
      });
      anchors.push([bk.end, ex + 4]);
    });
    ties.forEach(([a, b]) => new VF.StaveTie({ first_note: a, last_note: b, first_indices: [0], last_indices: [0] }).setContext(ctx).draw());
    anchors.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const svg = strip.querySelector('svg'); svg.setAttribute('aria-label', 'תווים');
    function xAt(beat) {
      if (beat <= anchors[0][0]) return anchors[0][1];
      let lo = 0, hi = anchors.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (anchors[mid][0] <= beat) lo = mid; else hi = mid; }
      const a = anchors[lo], b = anchors[hi]; if (b[0] - a[0] < EPS) return b[1];
      return a[1] + (b[1] - a[1]) * Math.min(1, Math.max(0, (beat - a[0]) / (b[0] - a[0])));
    }
    let lastX = null, curIdx = -1, curCls = '';
    return {
      seek(beat) {
        const vw = view.clientWidth || 360; const hx = Math.round(vw * 0.32);
        const xx = xAt(beat) * SC;
        if (lastX !== null && Math.abs(xx - lastX) < 0.3) return;
        lastX = xx; strip.style.transform = `translate3d(${(hx - xx).toFixed(1)}px,0,0)`; head.style.left = hx + 'px';
      },
      mark(idx, cls) {
        if (idx === curIdx && cls === curCls) return;
        (noteEls[curIdx] || []).forEach(el => el.classList.remove('vf-now', 'vf-ok', 'vf-bad'));
        curIdx = idx; curCls = cls;
        (noteEls[idx] || []).forEach(el => el.classList.add('vf-now', ...(cls ? [cls] : [])));
      }
    };
  }
  g.Notation = { render, loadVexFlow, layout };
})(window);
