// Reads sheet music from PDFs exported by notation software (MuseScore, Sibelius, Finale, Dorico...).
// These PDFs keep the music as positioned glyphs of a SMuFL music font plus vector lines, so the
// notes can be read exactly, without image recognition.
(function (g) {
  'use strict';

  const NOTEHEAD = { 0xE0A0: 8, 0xE0A2: 4, 0xE0A3: 2, 0xE0A4: 1 };
  const REST = { 0xE4E2: 8, 0xE4E3: 4, 0xE4E4: 2, 0xE4E5: 1, 0xE4E6: 0.5, 0xE4E7: 0.25, 0xE4E8: 0.125 };
  const ACC = { 0xE260: -1, 0xE261: 0, 0xE262: 1, 0xE263: 2, 0xE264: -2 };
  const FLAG = { 0xE240: 1, 0xE241: 1, 0xE242: 2, 0xE243: 2, 0xE244: 3, 0xE245: 3 };
  const DOT = 0xE1E7;
  const CLEF = { 0xE050: 'G', 0xE062: 'F', 0xE05C: 'C' };
  const isTimeDigit = c => c >= 0xE080 && c <= 0xE089;
  const isTupletDigit = c => c >= 0xE880 && c <= 0xE889;
  const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const SEMI = [0, 2, 4, 5, 7, 9, 11];

  function mul(m, n) { return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]]; }

  async function pagePrimitives(pdfjs, page) {
    const O = pdfjs.OPS; const ol = await page.getOperatorList();
    let ctm = [1, 0, 0, 1, 0, 0], lw = 1, cur = null; const stack = [], prims = [];
    const ap = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
    for (let i = 0; i < ol.fnArray.length; i++) {
      const f = ol.fnArray[i], a = ol.argsArray[i];
      if (f === O.save) stack.push([ctm, lw]);
      else if (f === O.restore) { const s = stack.pop(); if (s) [ctm, lw] = s; }
      else if (f === O.transform) ctm = mul(ctm, a);
      else if (f === O.setLineWidth) lw = a[0];
      else if (f === O.constructPath) {
        const ops = a[0], args = a[1]; let k = 0; const pts = []; let curves = 0;
        for (const op of ops) {
          if (op === O.moveTo || op === O.lineTo) { pts.push(ap(args[k], args[k + 1])); k += 2; }
          else if (op === O.curveTo) { pts.push(ap(args[k + 4], args[k + 5])); k += 6; curves++; }
          else if (op === O.curveTo2 || op === O.curveTo3) { pts.push(ap(args[k + 2], args[k + 3])); k += 4; curves++; }
          else if (op === O.rectangle) { const x = args[k], y = args[k + 1], w = args[k + 2], h = args[k + 3]; pts.push(ap(x, y), ap(x + w, y), ap(x + w, y + h), ap(x, y + h)); k += 4; }
        }
        cur = { pts, curves, lw: lw * Math.hypot(ctm[0], ctm[1]) };
      } else if (cur && (f === O.stroke || f === O.closeStroke || f === O.fill || f === O.eoFill || f === O.fillStroke || f === O.eoFillStroke || f === O.closeFillStroke || f === O.closeEOFillStroke)) {
        if (cur.pts.length) {
          const xs = cur.pts.map(p => p[0]), ys = cur.pts.map(p => p[1]);
          prims.push({ stroke: f === O.stroke || f === O.closeStroke, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), pts: cur.pts, curves: cur.curves, lw: cur.lw });
        }
        cur = null;
      } else if (f === O.endPath) cur = null;
    }
    const tc = await page.getTextContent();
    const glyphs = [], texts = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const cps = [...it.str].map(c => c.codePointAt(0));
      const x = it.transform[4], y = it.transform[5], size = Math.hypot(it.transform[0], it.transform[1]);
      if (cps.some(c => c >= 0xE000 && c <= 0xF8FF)) {
        // music font: usually one glyph per item; spread multi-glyph items over the item width
        const w = it.width / cps.length;
        cps.forEach((c, i) => { if (c >= 0xE000 && c <= 0xF8FF) glyphs.push({ c, x: x + i * w, y, w, size }); });
      } else texts.push({ s: it.str, x, y, w: it.width, size, font: it.fontName });
    }
    return { prims, glyphs, texts };
  }

  function findStaves(prims) {
    const hs = prims.filter(p => p.stroke && p.y1 - p.y0 < 0.3 && p.x1 - p.x0 > 15 && p.lw < 1.5).map(p => ({ y: (p.y0 + p.y1) / 2, x0: p.x0, x1: p.x1 }));
    // merge segments on the same y into rows
    hs.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const rows = [];
    for (const h of hs) {
      const r = rows.find(r => Math.abs(r.y - h.y) < 0.25); // same height = same line, even if a segment is missing
      if (r) { r.x0 = Math.min(r.x0, h.x0); r.x1 = Math.max(r.x1, h.x1); } else rows.push({ ...h });
    }
    rows.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const staves = []; const used = new Set();
    for (let i = 0; i < rows.length; i++) {
      if (used.has(i)) continue;
      const base = rows[i]; const grp = [i];
      for (let j = i + 1; j < rows.length && grp.length < 5; j++) {
        if (used.has(j)) continue;
        const r = rows[j];
        if (Math.abs(r.x0 - base.x0) > 3 || Math.abs(r.x1 - base.x1) > 3) continue;
        const prev = rows[grp[grp.length - 1]], d = r.y - prev.y;
        if (grp.length === 1) { if (d > 2 && d < 14) grp.push(j); }
        else { const sp = rows[grp[1]].y - rows[grp[0]].y; if (Math.abs(d - sp) < 0.35) grp.push(j); else if (d > sp + 0.35) break; }
      }
      if (grp.length === 5) {
        grp.forEach(k => used.add(k));
        const ys = grp.map(k => rows[k].y);
        staves.push({ bottom: ys[0], top: ys[4], sp: (ys[4] - ys[0]) / 4, x0: base.x0, x1: base.x1 });
      }
    }
    staves.sort((a, b) => b.top - a.top); // reading order: top of the page first (PDF y grows upward)
    return staves;
  }

  function nearestStaff(staves, y) {
    let best = null, bd = 1e9;
    for (const s of staves) { const mid = (s.top + s.bottom) / 2; const d = Math.abs(y - mid); if (d < bd) { bd = d; best = s; } }
    return best && bd < best.sp * 9 ? best : null;
  }

  // y position on the beam polygon at x (top edge interpolation)
  function beamYAt(p, x) {
    const pts = p.pts; let best = null;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (Math.abs(b[0] - a[0]) < 1) continue;
      if (x < Math.min(a[0], b[0]) - 0.6 || x > Math.max(a[0], b[0]) + 0.6) continue;
      const y = a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]);
      if (best == null || y > best) best = y;
    }
    return best;
  }

  function pitchFromY(y, staff, clef) {
    // diatonic index: C4 = 28 (7*4)
    const ref = clef.type === 'F' ? { y: clef.y, idx: 7 * 3 + 3 } : clef.type === 'C' ? { y: clef.y, idx: 28 } : { y: clef.y, idx: 7 * 4 + 4 };
    const steps = Math.round((y - ref.y) / (staff.sp / 2));
    const idx = ref.idx + steps;
    return { idx, step: STEPS[((idx % 7) + 7) % 7], oct: Math.floor(idx / 7) };
  }

  async function readPdf(pdfjs, data, onProgress) {
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    const systems = []; let title = '', titleSize = 0, tempo = 0, part = null;
    for (let pn = 1; pn <= doc.numPages; pn++) {
      const page = await doc.getPage(pn);
      const { prims, glyphs, texts } = await pagePrimitives(pdfjs, page);
      onProgress && onProgress(pn / doc.numPages);
      if (pn === 1 && texts.length) {
        const mx = Math.max(...texts.map(t => t.size));
        const big = texts.filter(t => t.size > mx - 0.5);
        const y0 = big[0].y; const line = big.filter(t => Math.abs(t.y - y0) < 2);
        const rtl = line.some(t => /[\u0590-\u05FF\u0600-\u06FF]/.test(t.s));
        line.sort((a, b) => rtl ? b.x - a.x : a.x - b.x);
        title = line.map(t => t.s).join(rtl ? '' : ' ');
        part = detectPart(texts.map(t => t.s).join(' '));
        if (rtl) { // pdf text for RTL is often one glyph per item: rebuild spaces from gaps
          let out = ''; for (let i = 0; i < line.length; i++) { out += line[i].s; const nx = line[i + 1]; if (nx && line[i].x - (nx.x + nx.w) > mx * 0.2) out += ' '; } title = out;
        }
      }
      const staves = findStaves(prims);
      const sys = staves.map(s => ({ staff: s, glyphs: [], prims: [], texts: [], page: pn }));
      for (const gl of glyphs) { const s = nearestStaff(staves, gl.y); if (s) sys[staves.indexOf(s)].glyphs.push(gl); }
      for (const p of prims) { if (p.x1 - p.x0 > 400 && p.y1 - p.y0 > 400) continue; const s = nearestStaff(staves, (p.y0 + p.y1) / 2); if (s) sys[staves.indexOf(s)].prims.push(p); }
      for (const t of texts) { const s = nearestStaff(staves, t.y); if (s) sys[staves.indexOf(s)].texts.push(t); }
      // rehearsal marks (boxed text) belong to the staff right below them
      for (const fr of prims) {
        if (!fr.stroke || fr.pts.length < 4 || fr.x1 - fr.x0 < 8 || fr.y1 - fr.y0 < 6 || fr.y1 - fr.y0 > 40) continue;
        const inside = texts.filter(t => t.x >= fr.x0 - 1 && t.x <= fr.x1 && t.y >= fr.y0 - 1 && t.y <= fr.y1).sort((a, b) => a.x - b.x);
        const name = inside.map(t => t.s).join('').replace(/\s+/g, ' ').trim();
        if (!name) continue;
        let best = null; for (const st of staves) if (st.top < fr.y0 && (!best || st.top > best.top)) best = st;
        if (best && fr.y0 - best.top < best.sp * 12) sys[staves.indexOf(best)].marks = (sys[staves.indexOf(best)].marks || []).concat([{ x: fr.x0, name }]);
      }
      // tempo mark: "= 140" text right after a note glyph above the staff
      for (const t of texts) { const m = /=\s*(\d{2,3})/.exec(t.s); if (m && !tempo) tempo = +m[1]; }
      systems.push(...sys);
    }
    // clean up title (e.g. collapse whitespace)
    title = title.replace(/\s+/g, ' ');
    const out = assemble(systems, title, tempo); out.part = part; return out;
  }
  // instrument named on the part (e.g. "Alto Saxophone", "Tpt. in Bb", "סקסופון אלט")
  function detectPart(txt) {
    const t = ' ' + txt.toLowerCase() + ' ';
    const rules = [
      ['bari', /bari(tone)?\s*sax|\bbar\.?\s*sax|סקסופון\s*בריטון/], ['tenor', /tenor\s*sax|\bt\.?\s*sax|ten\.?\s*sax|סקסופון\s*טנור/],
      ['soprano', /soprano\s*sax|sop\.?\s*sax|סקסופון\s*סופרן/], ['alto', /alto\s*sax|\ba\.?\s*sax|alt\.?\s*sax|סקסופון\s*אלט|\bsax(ophone)?\b/],
      ['trumpet', /trumpet|\btpt\b|\btp\.|חצוצרה/], ['trombone', /trombone|\btbn\b|טרומבון/], ['clarinet', /clarinet|\bcl\.|קלרינט/],
      ['flute', /flute|\bfl\.|חליל/], ['violin', /violin|\bvln\b|כינור/], ['voice', /vocals?\b|voice|שירה/]
    ];
    for (const [id, re] of rules) if (re.test(t)) return id;
    return null;
  }

  function assemble(systems, title, tempo) {
    let keyFifths = null;
    const warnings = [];
    let clef = null, keyAcc = {}, meterTop = 4, meterBot = 4;
    const measures = []; // {events:[{kind:'note'|'rest', dur, midi, name, x, tieStart, tieEnd}], multi, startText}
    let prevEv = null;
    const sectionMarks = [];
    systems.forEach((S, si) => {
      const st = S.staff, sp = st.sp, mid = (st.top + st.bottom) / 2;
      const G = S.glyphs.slice().sort((a, b) => a.x - b.x);
      // clef
      const cg = G.find(g => CLEF[g.c]);
      if (cg) clef = { type: CLEF[cg.c], y: cg.y };
      if (!clef) clef = { type: 'G', y: st.bottom + sp };
      // time signature digits inside the staff
      const tsd = G.filter(g => isTimeDigit(g.c) && g.y > st.bottom - sp && g.y < st.top + sp);
      if (tsd.length >= 2) {
        const topD = tsd.filter(g => g.y > mid).sort((a, b) => a.x - b.x), botD = tsd.filter(g => g.y <= mid).sort((a, b) => a.x - b.x);
        if (topD.length && botD.length) { meterTop = +topD.map(g => g.c - 0xE080).join(''); meterBot = +botD.map(g => g.c - 0xE080).join(''); }
      }
      const firstEventX = Math.min(...G.filter(g => NOTEHEAD[g.c] || REST[g.c]).map(g => g.x), st.x1);
      const tsX = tsd.length ? Math.min(...tsd.map(g => g.x)) : firstEventX;
      // key signature: accidentals after the clef, before the time signature / first event
      const firstBar = Math.min(st.x1, ...S.prims.filter(p => p.x1 - p.x0 < Math.max(0.8, sp * 0.6) && p.y0 <= st.bottom + sp * 0.15 && p.y1 >= st.top - sp * 0.15 && (p.stroke ? p.lw : p.x1 - p.x0) >= sp * 0.14).map(p => p.x0));
      const keyGl = G.filter(g => ACC[g.c] !== undefined && cg && g.x > cg.x && g.x < cg.x + sp * 14 && g.x < firstBar - sp && g.x < Math.min(tsX, firstEventX) - sp * 0.8);
      if (cg && (keyGl.length || si === 0)) {
        keyAcc = {};
        keyGl.forEach(k => { const p = pitchFromY(k.y, st, clef); keyAcc[p.step] = ACC[k.c]; });
        if (keyFifths === null) keyFifths = keyGl.reduce((t, k) => t + (ACC[k.c] > 0 ? 1 : ACC[k.c] < 0 ? -1 : 0), 0);
      }
      // barlines
      const bars = [];
      for (const p of S.prims) {
        const vertical = p.x1 - p.x0 < Math.max(0.8, sp * 0.6) && p.y0 <= st.bottom + sp * 0.15 && p.y1 >= st.top - sp * 0.15;
        if (!vertical) continue;
        const thick = p.stroke ? p.lw : (p.x1 - p.x0);
        if (thick >= sp * 0.14) bars.push((p.x0 + p.x1) / 2);
      }
      bars.sort((a, b) => a - b);
      const bx = []; bars.forEach(x => { if (!bx.length || x - bx[bx.length - 1] > sp * 1.2) bx.push(x); else bx[bx.length - 1] = Math.max(bx[bx.length - 1], x); });
      if (!bx.length || bx[bx.length - 1] < st.x1 - sp) bx.push(st.x1);
      const startX = Math.max(st.x0, (tsd.length ? Math.max(...tsd.map(g => g.x + g.w)) : (keyGl.length ? Math.max(...keyGl.map(g => g.x + g.w)) : (cg ? cg.x + cg.w : st.x0))));
      // stems and beams
      const stems = S.prims.filter(p => p.stroke && p.x1 - p.x0 < 0.6 && p.y1 - p.y0 > sp * 1.5 && p.lw < sp * 0.14);
      const beams = S.prims.filter(p => !p.stroke && !p.curves && p.pts.length >= 4 && p.x1 - p.x0 > sp * 0.6 && p.x1 - p.x0 < 200);
      const curves = S.prims.filter(p => p.curves > 0 && p.x1 - p.x0 > sp * 0.8 && p.y1 - p.y0 < sp * 3);
      const multiBars = S.prims.filter(p => !p.curves && p.x1 - p.x0 > sp * 3 && Math.abs((p.y0 + p.y1) / 2 - mid) < sp * 0.6 &&
        (p.stroke ? (p.lw > sp * 0.4 && p.y1 - p.y0 < sp * 0.3) : (p.y1 - p.y0 > sp * 0.3 && p.y1 - p.y0 < sp * 1.2)));
      // rehearsal marks: texts above the staff inside a frame
      (S.marks || []).forEach(mk => sectionMarks.push({ sys: si, x: mk.x, name: mk.name }));
      if (globalThis.__omrDebug) console.log('sys', si, 'page', S.page, 'x0', st.x0.toFixed(1), 'startX', startX.toFixed(1), 'clef', cg && cg.x.toFixed(1), 'tsd', tsd.length, 'key', keyGl.length, 'bars', bx.map(x => x.toFixed(0)).join(','));
      // each measure
      let left = startX;
      for (let bi = 0; bi < bx.length; bi++) {
        const right = bx[bi];
        if (right - left < sp * 1.5) { left = right; continue; }
        const inM = G.filter(g => g.x >= left - sp * 0.2 && g.x < right - sp * 0.1);
        const meas = { events: [], multi: 0, sys: si, x0: left, x1: right, meter: meterTop * 4 / meterBot };
        // multi-measure rest
        const mb = inM.some(g => NOTEHEAD[g.c]) ? null : multiBars.find(p => p.x0 >= left - 1 && p.x1 <= right + 1);
        if (mb) {
          const digits = G.filter(g => isTimeDigit(g.c) && g.x >= mb.x0 - sp && g.x <= mb.x1 + sp && g.y > st.top).sort((a, b) => a.x - b.x);
          let num = digits.length ? +digits.map(g => g.c - 0xE080).join('') : 0;
          if (!num) {
            // many programs write the count as ordinary text above the bar
            const cx = (mb.x0 + mb.x1) / 2;
            const cand = S.texts.filter(t => /^\s*\d+\s*$/.test(t.s) && t.y > st.top && t.y < st.top + sp * 4 && t.x >= mb.x0 - sp && t.x <= mb.x1 + sp)
              .sort((a, b) => Math.abs(a.x + a.w / 2 - cx) - Math.abs(b.x + b.w / 2 - cx));
            num = cand.length ? +cand[0].s.trim() : 1;
          }
          meas.multi = num; if (globalThis.__omrDebug) meas.dbg = [mb.stroke, +mb.x0.toFixed(1), +mb.x1.toFixed(1), +mb.y0.toFixed(1), +mb.y1.toFixed(1), +mb.lw.toFixed(2), 'sp', +sp.toFixed(2), 'mid', +mid.toFixed(1), 'page', S.page];
          measures.push(meas); left = right; continue;
        }
        const accMeasure = {};
        const heads = inM.filter(g => NOTEHEAD[g.c]);
        const rests = inM.filter(g => REST[g.c] && g.y < st.top + sp * 2 && g.y > st.bottom - sp * 2);
        const dots = inM.filter(g => g.c === DOT);
        const accs = inM.filter(g => ACC[g.c] !== undefined);
        const flags = inM.filter(g => FLAG[g.c]);
        const tuplets = inM.filter(g => isTupletDigit(g.c));
        // group heads into chords by x
        heads.sort((a, b) => a.x - b.x);
        const chords = [];
        heads.forEach(h => { const c = chords.find(c => Math.abs(c.x - h.x) < sp * 0.6 && NOTEHEAD[c.head.c] === NOTEHEAD[h.c]); if (c) { c.all.push(h); if (h.y > c.head.y) c.head = h; } else chords.push({ x: h.x, head: h, all: [h] }); });
        const evs = [];
        for (const ch of chords) {
          const h = ch.head; const base = NOTEHEAD[h.c];
          let dur = base;
          if (base === 1 || base === 2) {
            // find stem
            const ys = ch.all.map(a => a.y);
            const stem = stems.find(s => (Math.abs(s.x0 - h.x) < 0.8 || Math.abs(s.x0 - (h.x + h.w)) < 0.8) && s.y0 <= Math.max(...ys) + sp * 0.6 && s.y1 >= Math.min(...ys) - sp * 0.6);
            if (base === 1) {
              let n = 0;
              if (stem) {
                const up = stem.y1 > h.y + sp; const tipY = up ? stem.y1 : stem.y0; const sx = stem.x0;
                for (const b of beams) {
                  if (sx < b.x0 - 0.8 || sx > b.x1 + 0.8) continue;
                  const by = beamYAt(b, sx); if (by == null) continue;
                  if (Math.abs(by - tipY) < sp * 2.2 && (up ? by <= stem.y1 + sp * 0.6 && by >= h.y : by >= stem.y0 - sp * 0.6 && by <= h.y)) n++;
                }
                const fl = flags.find(f => Math.abs(f.x - sx) < sp * 1.2 && Math.abs(f.y - tipY) < sp * 1.2);
                if (fl) n = Math.max(n, FLAG[fl.c]);
              }
              if (!n) { // stem not drawn as a clean line: fall back to a flag attached to this head
                const fl = flags.find(f => (Math.abs(f.x - h.x) < 1 || Math.abs(f.x - (h.x + h.w)) < 1.2) && Math.abs(f.y - h.y) < sp * 4.5 && Math.abs(f.y - h.y) > sp * 1.5);
                if (fl) n = FLAG[fl.c];
              }
              dur = 1 / Math.pow(2, n); 
            }
          }
          const d = dots.filter(dt => dt.x > h.x + h.w * 0.5 && dt.x < h.x + h.w + sp * 2.5 && Math.abs(dt.y - h.y) < sp * 0.75);
          const nd = Math.min(2, new Set(d.map(x => Math.round(x.x))).size);
          if (nd === 1) dur *= 1.5; else if (nd === 2) dur *= 1.75;
          const p = pitchFromY(h.y, st, clef);
          const acc = accs.find(a => a.x < h.x && a.x > h.x - sp * 3.2 && Math.abs(a.y - h.y) < sp * 0.3);
          const key = p.step + p.oct;
          let alter;
          const tiedFrom = prevEv && prevEv.tieCurve && prevEv.step === p.step && prevEv.oct === p.oct;
          if (acc) { alter = ACC[acc.c]; accMeasure[key] = alter; }
          else if (tiedFrom) alter = prevEv.alter;
          else if (accMeasure[key] !== undefined) alter = accMeasure[key];
          else alter = keyAcc[p.step] || 0;
          const midi = 12 * (p.oct + 1) + SEMI[STEPS.indexOf(p.step)] + alter;
          const ev = { kind: 'note', x: h.x, xr: h.x + h.w, y: h.y, dur, midi, step: p.step, oct: p.oct, alter, name: p.step + (alter > 0 ? '#'.repeat(alter) : alter < 0 ? 'b'.repeat(-alter) : '') + p.oct };
          // a tie needs its curve to be known before the next note is read
          ev.tieCurve = curves.find(cv => Math.abs(ev.xr - cv.x0) < sp * 1.6 && Math.abs(ev.y - (cv.y0 + cv.y1) / 2) < sp * 1.6) || null;
          evs.push(ev); prevEv = ev;
        }
        for (const r of rests) {
          let dur = REST[r.c];
          const d = dots.filter(dt => dt.x > r.x + r.w * 0.5 && dt.x < r.x + r.w + sp * 2 && Math.abs(dt.y - r.y) < sp * 1.2);
          if (d.length) dur *= 1.5;
          // a lone whole rest = whole measure
          evs.push({ kind: 'rest', x: r.x, dur, whole: r.c === 0xE4E3 });
        }
        evs.sort((a, b) => a.x - b.x);
        if (evs.length === 1 && evs[0].whole) evs[0].dur = meas.meter;
        // tuplets: scale the notes closest to each tuplet number
        for (const tg of tuplets) {
          const num = tg.c - 0xE880; if (num !== 3) continue;
          const near = evs.filter(e => e.kind === 'note').sort((a, b) => Math.abs(a.x - tg.x) - Math.abs(b.x - tg.x)).slice(0, 3);
          near.forEach(e => e.dur = e.dur * 2 / 3);
        }
        // tuplet numbers are often drawn as outlines, not text: if the measure is too long, look for
        // runs of three equal notes that, read as a triplet, make it add up exactly
        const total = evs.reduce((a, e) => a + e.dur, 0), excess = total - meas.meter;
        if (!tuplets.length && excess > 1e-3 && measures.length > 0) {
          const runs = [];
          for (let i = 0; i + 2 < evs.length; i++) {
            const a = evs[i], b = evs[i + 1], c = evs[i + 2];
            if (a.kind === 'note' && b.kind === 'note' && c.kind === 'note' && a.dur === b.dur && b.dur === c.dur && a.dur <= 1) runs.push({ i, save: a.dur, span: c.x - a.x });
          }
          runs.sort((p, q) => p.span - q.span);
          let pick = runs.find(r => Math.abs(r.save - excess) < 1e-3) ? [runs.find(r => Math.abs(r.save - excess) < 1e-3)] : null;
          if (!pick) for (let x = 0; x < runs.length && !pick; x++) for (let y = x + 1; y < runs.length; y++) if (Math.abs(runs[x].i - runs[y].i) >= 3 && Math.abs(runs[x].save + runs[y].save - excess) < 1e-3) { pick = [runs[x], runs[y]]; break; }
          if (pick) pick.forEach(r => { for (let k = 0; k < 3; k++) evs[r.i + k].dur = evs[r.i + k].dur * 2 / 3; });
        }
        meas.events = evs;
        measures.push(meas);
        left = right;
      }
      // a tie that runs off the end of the system continues on the next one
      if (prevEv && !prevEv.tieCurve && curves.some(c => c.x1 > st.x1 - sp * 2.5 && c.x0 > prevEv.x - sp && Math.abs((c.y0 + c.y1) / 2 - prevEv.y) < sp * 1.6)) prevEv.tieCurve = true;
    });

    if (globalThis.__omrDebug) globalThis.__omrDebug(measures);
    // expand into flat score
    const notes = []; const measureStart = []; let pos = 0; const meterQ = measures.length ? measures[0].meter : 4;
    const sections = []; let mNum = 0;
    let lastNote = null;
    measures.forEach((m, mi) => {
      if (m.multi) {
        for (let k = 0; k < m.multi; k++) { measureStart.push(+pos.toFixed(4)); pos += m.meter; mNum++; }
        lastNote = null; return;
      }
      mNum++; measureStart.push(+pos.toFixed(4));
      let cur = 0;
      for (const e of m.events) {
        if (e.kind === 'note') {
          const tiedHere = lastNote && lastNote.tieOpen && lastNote.c === e.midi;
          if (tiedHere) { lastNote.d = +(lastNote.d + e.dur).toFixed(4); lastNote.tieOpen = !!e.tieCurve; }
          else { const n = { b: +(pos + cur).toFixed(4), d: +e.dur.toFixed(4), c: e.midi, m: mNum, n: e.name, tieOpen: !!e.tieCurve }; notes.push(n); lastNote = n; }
        } else { lastNote = null; }
        cur += e.dur;
      }
      let len = cur;
      if (mi === 0 && cur > 0 && cur < m.meter - 1e-3) { /* pickup */ }
      else if (Math.abs(cur - m.meter) > 1e-3) {
        if (cur > 0) warnings.push({ m: mNum, got: +cur.toFixed(3), want: m.meter });
        len = m.meter;
      }
      pos += len;
    });
    // section marks -> measure numbers
    for (const s of sectionMarks) {
      let idx = 0, acc = 0;
      // map (sys, x) to the measure whose x-range contains it
      for (let i = 0, num = 1; i < measures.length; i++) {
        const m = measures[i];
        if (m.sys === s.sys && s.x < m.x1 + 2) { idx = num; break; }
        num += m.multi || 1;
      }
      if (idx) sections.push({ m: idx, name: s.name, beat: measureStart[idx - 1] });
    }
    sections.sort((a, b) => a.m - b.m);
    const uniq = sections.filter((s, i) => !i || s.m !== sections[i - 1].m);
    if (!uniq.length || uniq[0].m !== 1) uniq.unshift({ m: 1, name: 'התחלה', beat: 0 });
    notes.forEach(n => delete n.tieOpen);
    const pickup = measures.length && !measures[0].multi && measureStart.length > 1 && measureStart[1] < meterQ - 1e-3 ? measureStart[1] : 0;
    return { title, tempo: tempo || 100, keyFifths: keyFifths || 0, meter: meterQ, pickup, measureStart, totalBeats: +pos.toFixed(4), sections: uniq, notes, warnings, measures: measureStart.length };
  }

  g.OMR = { readPdf };
  if (typeof module !== 'undefined') module.exports = g.OMR;
})(typeof window !== 'undefined' ? window : globalThis);
