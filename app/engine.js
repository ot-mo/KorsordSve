// Gridwright engine: word-list index, slot geometry and the autofill search.
// The factory is self-contained so it can be stringified into a Web Worker
// (works from file:// too), mirroring Ingrid's separate fill-engine worker.
function GridEngineFactory() {
  // A-Z plus the Swedish Å, Ä, Ö. English lists simply never use the last three.
  const ALPHA = "abcdefghijklmnopqrstuvwxyzåäö";
  const NL = ALPHA.length;
  const CODE = new Map([...ALPHA].map((ch, i) => [ch, i]));
  const code = (ch) => CODE.get(ch);

  function pop(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }

  // Lowercase, keep å/ä/ö, fold other accents (é -> e), drop everything else.
  function normalize(word) {
    return word.toLowerCase()
      .replace(/å/g, "\u0001").replace(/ä/g, "\u0002").replace(/ö/g, "\u0003")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/\u0001/g, "å").replace(/\u0002/g, "ä").replace(/\u0003/g, "ö")
      .replace(/[^a-zåäö]/g, "");
  }

  // Accepts Ingrid / Spread the Wordlist style "word;score" lines, or plain words.
  function parseWordList(text, defaultScore = 50) {
    const map = new Map();
    for (const raw of text.split(/\r?\n/)) {
      if (!raw) continue;
      const semi = raw.lastIndexOf(";");
      let word = normalize(semi >= 0 ? raw.slice(0, semi) : raw);
      let score = semi >= 0 ? parseInt(raw.slice(semi + 1), 10) : defaultScore;
      if (word.length < 2 || word.length > 25) continue;
      if (!Number.isFinite(score)) score = defaultScore;
      const prev = map.get(word);
      if (prev === undefined || score > prev) map.set(word, score);
    }
    return map;
  }

  class WordIndex {
    constructor(map) {
      this.scores = map;
      this.size = map.size;
      this.byLen = new Map();
      const groups = new Map();
      for (const [w, s] of map) {
        let g = groups.get(w.length);
        if (!g) groups.set(w.length, (g = []));
        g.push([w, s]);
      }
      for (const [L, list] of groups) {
        // Bit order follows score order, so walking a bitset yields best words first.
        list.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
        const n = list.length, W = (n + 31) >>> 5;
        const words = new Array(n), scores = new Int16Array(n);
        const bits = new Uint32Array(L * NL * W);
        for (let i = 0; i < n; i++) {
          const w = list[i][0];
          words[i] = w;
          scores[i] = list[i][1];
          const word = i >>> 5, bit = 1 << (i & 31);
          for (let p = 0; p < L; p++) bits[(p * NL + code(w[p])) * W + word] |= bit;
        }
        this.byLen.set(L, { L, n, W, words, scores, bits, allowed: new Uint32Array(W) });
      }
      this.setMinScore(0);
    }

    setMinScore(min) {
      this.minScore = min;
      for (const li of this.byLen.values()) {
        li.allowed.fill(0);
        for (let i = 0; i < li.n; i++) if (li.scores[i] >= min) li.allowed[i >>> 5] |= 1 << (i & 31);
      }
    }

    allows(word) {
      const s = this.scores.get(word);
      return s !== undefined && s >= this.minScore;
    }

    // codes: array of letter codes or -1 for unknown. Returns a fresh bitset, or null if no words of that length.
    match(codes) {
      const li = this.byLen.get(codes.length);
      if (!li) return null;
      const out = li.allowed.slice(), W = li.W;
      for (let p = 0; p < codes.length; p++) {
        const x = codes[p];
        if (x < 0) continue;
        const off = (p * NL + x) * W;
        for (let k = 0; k < W; k++) out[k] &= li.bits[off + k];
      }
      return out;
    }

    count(bits) {
      if (!bits) return 0;
      let c = 0;
      for (let k = 0; k < bits.length; k++) if (bits[k]) c += pop(bits[k]);
      return c;
    }

    // For each letter, how many words in `bits` have that letter at position p.
    letterCounts(L, bits, p) {
      const out = new Int32Array(NL);
      const li = this.byLen.get(L);
      if (!li || !bits) return out;
      const W = li.W;
      for (let x = 0; x < NL; x++) {
        const off = (p * NL + x) * W;
        let c = 0;
        for (let k = 0; k < W; k++) {
          const v = bits[k] & li.bits[off + k];
          if (v) c += pop(v);
        }
        out[x] = c;
      }
      return out;
    }

    *iterate(L, bits) {
      const li = this.byLen.get(L);
      if (!li || !bits) return;
      for (let k = 0; k < bits.length; k++) {
        let v = bits[k];
        while (v) {
          const t = v & -v;
          const i = (k << 5) + (31 - Math.clz32(t));
          v ^= t;
          yield i;
        }
      }
    }

    wordAt(L, i) { return this.byLen.get(L).words[i]; }
    scoreAt(L, i) { return this.byLen.get(L).scores[i]; }
  }

  // Shared shape for both grid styles: slots with cells, plus which entry crosses each square.
  function finishGeo(w, h, slots, numbers) {
    const cellSlots = Array.from({ length: w * h }, () => ({ A: null, D: null }));
    for (const s of slots) s.cells.forEach((idx, p) => { if (!cellSlots[idx][s.dir]) cellSlots[idx][s.dir] = { s: s.id, p }; });
    for (const s of slots) {
      const other = s.dir === "A" ? "D" : "A";
      s.cross = s.cells.map((idx) => cellSlots[idx][other]);
    }
    return { slots, numbers, cellSlots };
  }

  // American style: entries are runs of 2+ open squares, numbered in reading order.
  function computeSlots(w, h, blocks) {
    const slots = [], numbers = new Int16Array(w * h);
    const open = (r, c) => r >= 0 && c >= 0 && r < h && c < w && !blocks[r * w + c];
    let num = 0;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        if (!open(r, c)) continue;
        const startsA = !open(r, c - 1) && open(r, c + 1);
        const startsD = !open(r - 1, c) && open(r + 1, c);
        if (!startsA && !startsD) continue;
        num++;
        numbers[r * w + c] = num;
        for (const dir of ["A", "D"]) {
          if ((dir === "A" && !startsA) || (dir === "D" && !startsD)) continue;
          const cells = [];
          let rr = r, cc = c;
          while (open(rr, cc)) {
            cells.push(rr * w + cc);
            if (dir === "A") cc++; else rr++;
          }
          slots.push({ id: slots.length, num, dir, r, c, len: cells.length, cells });
        }
      }
    }
    return finishGeo(w, h, slots, numbers);
  }

  // Swedish style: entries come from the clue squares' arrows. defs: [{dir, cells, ...extra}]
  function geoFromSlots(w, h, defs) {
    const slots = defs.map((d, id) => ({
      ...d, id, num: d.num ?? id + 1, len: d.cells.length,
      r: Math.floor(d.cells[0] / w), c: d.cells[0] % w,
    }));
    return finishGeo(w, h, slots, new Int16Array(w * h));
  }

  // Swedish arrows: where the answer starts relative to its clue square, and which way it runs.
  const ARROWS = {
    right: { dr: 0, dc: 1, dir: "A" },          // →  starts to the right, runs right
    down: { dr: 1, dc: 0, dir: "D" },           // ↓  starts below, runs down
    "down-right": { dr: 1, dc: 0, dir: "A" },   // ↳  starts below, runs right
    "right-down": { dr: 0, dc: 1, dir: "D" },   // ↴  starts to the right, runs down
    "up-right": { dr: -1, dc: 0, dir: "A" },    // ↱  starts above, runs right
    "left-down": { dr: 0, dc: -1, dir: "D" },   // ↙  starts to the left, runs down
  };

  // open[i] true for letter squares; clues: {cellIndex: [{text, arrow}]}; breaks[i]: 1 = bar after (right), 2 = bar below.
  // An answer runs from its start square until a non-letter square, the edge, or a bar.
  function swedishSlots(w, h, open, clues, breaks) {
    const defs = [], problems = [];
    const ok = (r, c) => r >= 0 && c >= 0 && r < h && c < w && open[r * w + c];
    const cellsWithClues = Object.keys(clues || {}).map(Number).sort((a, b) => a - b);
    for (const ci of cellsWithClues) {
      const r0 = Math.floor(ci / w), c0 = ci % w;
      (clues[ci] || []).forEach((q, k) => {
        const a = ARROWS[q.arrow];
        if (!a) return;
        let r = r0 + a.dr, c = c0 + a.dc;
        const cells = [];
        while (ok(r, c)) {
          const i = r * w + c;
          cells.push(i);
          if (breaks && (breaks[i] & (a.dir === "A" ? 1 : 2))) break;
          if (a.dir === "A") c++; else r++;
        }
        if (cells.length < 2) { problems.push({ clueCell: ci, clueIdx: k, len: cells.length }); return; }
        defs.push({ dir: a.dir, cells, clueCell: ci, clueIdx: k, arrow: q.arrow });
      });
    }
    defs.sort((x, y) => x.cells[0] - y.cells[0] || (x.dir === "A" ? -1 : 1));
    return { defs, problems };
  }

  const codesOf = (slot, letters) => slot.cells.map((i) => letters[i]);
  const isComplete = (slot, letters) => slot.cells.every((i) => letters[i] >= 0);
  const wordOf = (slot, letters) => slot.cells.map((i) => ALPHA[letters[i]]).join("");

  // Per open position of `slot`, the number of words each letter leaves for the crossing entry.
  function crossCounts(index, slot, slots, letters) {
    return slot.cells.map((cell, p) => {
      const x = slot.cross[p];
      if (letters[cell] >= 0 || !x) return null;
      const cs = slots[x.s];
      return index.letterCounts(cs.len, index.match(codesOf(cs, letters)), x.p);
    });
  }

  // Suggestions for one entry, like Ingrid's fill panel: score plus how much room it leaves the crossings.
  function candidatesFor(index, geo, letters, slotId, limit = 400) {
    const slot = geo.slots[slotId];
    const bits = index.match(codesOf(slot, letters));
    const total = index.count(bits);
    const cc = crossCounts(index, slot, geo.slots, letters);
    const inGrid = new Set();
    for (const s of geo.slots) if (s.id !== slotId && isComplete(s, letters)) inGrid.add(wordOf(s, letters));
    const out = [];
    for (const i of index.iterate(slot.len, bits)) {
      const word = index.wordAt(slot.len, i);
      let minCross = Infinity;
      for (let p = 0; p < slot.len; p++) {
        if (!cc[p]) continue;
        minCross = Math.min(minCross, cc[p][code(word[p])]);
      }
      out.push({ word, score: index.scoreAt(slot.len, i), minCross: minCross === Infinity ? -1 : minCross, dupe: inGrid.has(word) });
      if (out.length >= limit) break;
    }
    return { total, list: out };
  }

  class Stop extends Error {}

  // Backtracking with most-constrained-entry ordering, crossing look-ahead and randomized restarts.
  // grid: {w, h, blocks, letters, slotDefs?}. With slotDefs (Swedish style) the entries are given, not derived.
  function fillGrid(index, grid, opts = {}) {
    const { w, h } = grid;
    const start = Int8Array.from(grid.letters);
    const geo = grid.slotDefs ? geoFromSlots(w, h, grid.slotDefs) : computeSlots(w, h, Uint8Array.from(grid.blocks));
    const slots = geo.slots;
    const label = (s) => s.label || `${s.num} ${s.dir === "A" ? "Across" : "Down"}`;
    const timeLimit = opts.timeLimitMs ?? 10000;
    const deadline = Date.now() + timeLimit;
    let seed = opts.seed ?? (Date.now() & 0x7fffffff);
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    for (const s of slots) {
      if (isComplete(s, start)) continue;
      if (index.count(index.match(codesOf(s, start))) === 0) {
        const pattern = s.cells.map((i) => (start[i] >= 0 ? ALPHA[start[i]].toUpperCase() : "?")).join("");
        return { ok: false, reason: `No word in the list fits ${label(s)} (${pattern}).`, slot: s.id };
      }
    }

    let totalNodes = 0, attempts = 0;
    let budget = 4000;
    while (Date.now() < deadline) {
      attempts++;
      const letters = Int8Array.from(start);
      const used = new Map();
      for (const s of slots) if (isComplete(s, letters)) { const wd = wordOf(s, letters); used.set(wd, (used.get(wd) || 0) + 1); }
      let nodes = 0;
      const jitter = attempts === 1 ? 2 : 8;

      const search = () => {
        nodes++;
        if (nodes > budget) throw new Stop("restart");
        if ((nodes & 63) === 0 && Date.now() > deadline) throw new Stop("time");

        let best = null, bestBits = null, bestCount = Infinity;
        for (const s of slots) {
          if (isComplete(s, letters)) continue;
          const bits = index.match(codesOf(s, letters));
          const c = index.count(bits);
          if (c === 0) return false;
          // Prefer fewer options, then longer entries.
          if (c < bestCount || (c === bestCount && s.len > best.len)) { best = s; bestBits = bits; bestCount = c; }
        }
        if (!best) return true;

        const cc = crossCounts(index, best, slots, letters);
        const ranked = [];
        let scanned = 0;
        for (const i of index.iterate(best.len, bestBits)) {
          if (++scanned > 2000) break;
          const word = index.wordAt(best.len, i);
          if (used.get(word)) continue;
          let minCross = Infinity, ok = true;
          for (let p = 0; p < best.len; p++) {
            if (!cc[p]) continue;
            const n = cc[p][code(word[p])];
            if (n === 0) { ok = false; break; }
            if (n < minCross) minCross = n;
          }
          if (!ok) continue;
          const room = minCross === Infinity ? 12 : Math.log2(1 + minCross);
          ranked.push([word, 0.6 * index.scoreAt(best.len, i) + 5 * room + rand() * jitter]);
        }
        ranked.sort((a, b) => b[1] - a[1]);
        const branch = Math.min(ranked.length, 12);
        for (let k = 0; k < branch; k++) {
          const word = ranked[k][0];
          const changed = [];
          best.cells.forEach((cell, p) => { if (letters[cell] < 0) { letters[cell] = code(word[p]); changed.push(p); } });
          const claimed = [word];
          let ok = true;
          // Every entry this word completes must be a real, unused word (covers extra overlaps in Swedish grids).
          const touched = new Set();
          for (const p of changed) for (const x of [best.cross[p]]) if (x) touched.add(x.s);
          for (const sid of touched) {
            const cs = slots[sid];
            if (!isComplete(cs, letters)) continue;
            const cw = wordOf(cs, letters);
            if (used.get(cw) || claimed.includes(cw) || !index.allows(cw)) { ok = false; break; }
            claimed.push(cw);
          }
          if (ok) {
            for (const c of claimed) used.set(c, (used.get(c) || 0) + 1);
            if (search()) return true;
            for (const c of claimed) used.set(c, used.get(c) - 1);
          }
          for (const p of changed) letters[best.cells[p]] = -1;
        }
        return false;
      };

      try {
        const done = search();
        totalNodes += nodes;
        if (done) return { ok: true, letters: Array.from(letters), attempts, nodes: totalNodes, ms: timeLimit - (deadline - Date.now()) };
      } catch (e) {
        totalNodes += nodes;
        if (!(e instanceof Stop)) throw e;
        if (e.message === "time") break;
      }
      budget = Math.floor(budget * 1.5);
    }
    return { ok: false, reason: `No fill found within ${Math.round(timeLimit / 1000)} seconds. Try more time, a lower minimum score, or fewer locked letters.`, attempts, nodes: totalNodes };
  }

  return { ALPHA, NL, code, normalize, parseWordList, WordIndex, computeSlots, geoFromSlots, swedishSlots, ARROWS, candidatesFor, fillGrid, isComplete, wordOf };
}

function GridEngineWorkerMain(E) {
  let index = null;
  self.onmessage = (e) => {
    const m = e.data;
    try {
      if (m.type === "load") {
        const map = E.parseWordList(m.text);
        for (const [w, s] of m.custom || []) map.set(w, s);
        index = new E.WordIndex(map);
        index.setMinScore(m.minScore);
        self.postMessage({ type: "loaded" });
      } else if (m.type === "minScore") {
        index.setMinScore(m.minScore);
      } else if (m.type === "fill") {
        const r = E.fillGrid(index, m.grid, m.opts);
        self.postMessage({ type: "filled", id: m.id, ...r });
      }
    } catch (err) {
      self.postMessage({ type: "error", id: m.id, message: String(err && err.message || err) });
    }
  };
}
