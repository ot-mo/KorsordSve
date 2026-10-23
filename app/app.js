// Gridwright: a crossword construction app modelled on Ingrid's workflow
// (grid editor with symmetry, scored word list, fill suggestions, autofill worker,
// clue editor, stats, .puz/.ipuz/TSV export and print), plus a Swedish style
// (korsord) with clues inside squares, arrows, pictures and yellow zones.
"use strict";

const E = GridEngineFactory();
const $ = (id) => document.getElementById(id);

// ---------- storage (every access guarded; the app works without it) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};
const idb = {
  open() {
    return new Promise((res, rej) => {
      try {
        const r = indexedDB.open("gridwright", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("kv");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      } catch (e) { rej(e); }
    });
  },
  async get(key) {
    try {
      const db = await this.open();
      return await new Promise((res) => {
        const q = db.transaction("kv").objectStore("kv").get(key);
        q.onsuccess = () => res(q.result);
        q.onerror = () => res(undefined);
      });
    } catch { return undefined; }
  },
  async set(key, value) {
    try {
      const db = await this.open();
      await new Promise((res) => {
        const t = db.transaction("kv", "readwrite");
        t.objectStore("kv").put(value, key);
        t.oncomplete = res; t.onerror = res;
      });
    } catch { /* not fatal */ }
  },
  async del(key) {
    try {
      const db = await this.open();
      db.transaction("kv", "readwrite").objectStore("kv").delete(key);
    } catch { /* not fatal */ }
  },
};

// ---------- state ----------
let projects = store.get("gw.projects", {});
let project = null;
let geo = null;
let fillGeo = null;                 // words for fill: answers, with sentences split at triangles
let covered = new Uint8Array(0);   // squares under a picture
let sel = { r: 0, c: 0 };
let anchor = null;                  // other corner of a rectangular selection
let selPic = null;                  // id of the selected picture
let dir = "A";
let undoStack = [], redoStack = [];
let index = null;
let custom = store.get("gw.custom", []);
let clueBank = store.get("gw.cluebank", {});
let worker = null, workerReady = false, filling = false, fillSeq = 0;
let activeTab = "fill";
const imgCache = new Map();

// ---------- Swedish arrows ----------
const ARROW_ORDER = ["right", "down", "down-right", "right-down", "up-right", "left-down"];
const ARROW_NAMES = {
  right: "Right", down: "Down", "down-right": "Down, then right",
  "right-down": "Right, then down", "up-right": "Up, then right", "left-down": "Left, then down",
};
const ARROW_GLYPH = { right: "→", down: "↓", "down-right": "↳", "right-down": "↴", "up-right": "↱", "left-down": "↙" };
const headR = (x, y) => `<polygon class="head" points="${x - 13},${y - 9} ${x + 1},${y} ${x - 13},${y + 9}"/>`;
const headD = (x, y) => `<polygon class="head" points="${x - 9},${y - 13} ${x},${y + 1} ${x + 9},${y - 13}"/>`;
// Drawn in the answer's first square, on the edge it shares with the clue square.
const CELL_ARROW = {
  right: `<polygon class="head" points="0,36 15,50 0,64"/>`,
  down: `<polygon class="head" points="36,0 64,0 50,15"/>`,
  "down-right": `<path d="M15 0 V20 H30"/>` + headR(42, 20),
  "right-down": `<path d="M0 15 H20 V30"/>` + headD(20, 42),
  "up-right": `<path d="M15 100 V80 H30"/>` + headR(42, 80),
  "left-down": `<path d="M100 15 H80 V30"/>` + headD(80, 42),
  // Small triangles on a square's right or bottom edge: the sentence goes on with its next word.
  "tri-r": `<polygon class="head" points="80,35 100,50 80,65"/>`,
  "tri-b": `<polygon class="head" points="35,80 50,100 65,80"/>`,
};
const cellArrowSvg = (a) => `<svg viewBox="0 0 100 100" aria-hidden="true">${CELL_ARROW[a]}</svg>`;
// Thick arrows fill a whole square and start an answer, for example from a picture caption.
const THICK_ARROW = {
  right: `<path d="M8 50 H60"/><polygon class="head" points="56,24 94,50 56,76"/>`,
  down: `<path d="M50 8 V60"/><polygon class="head" points="24,56 50,94 76,56"/>`,
  "down-right": `<path d="M28 6 V56 H60"/><polygon class="head" points="56,30 94,56 56,82"/>`,
  "right-down": `<path d="M6 28 H56 V60"/><polygon class="head" points="30,56 56,94 82,56"/>`,
  "up-right": `<path d="M28 94 V44 H60"/><polygon class="head" points="56,18 94,44 56,70"/>`,
  "left-down": `<path d="M94 28 H44 V60"/><polygon class="head" points="18,56 44,94 70,56"/>`,
};
const thickArrowSvg = (a) => `<svg class="thick" viewBox="0 0 100 100" aria-hidden="true">${THICK_ARROW[a] || ""}</svg>`;
// Picker icons show the clue square (grey) and the path of the answer.
const PICK_ARROW = {
  right: `<rect class="src" x="2" y="30" width="38" height="40"/><path d="M44 50 H80"/>` + headR(94, 50),
  down: `<rect class="src" x="30" y="2" width="40" height="38"/><path d="M50 44 V80"/>` + headD(50, 94),
  "down-right": `<rect class="src" x="2" y="2" width="38" height="38"/><path d="M21 44 V68 H80"/>` + headR(94, 68),
  "right-down": `<rect class="src" x="2" y="2" width="38" height="38"/><path d="M44 21 H68 V80"/>` + headD(68, 94),
  "up-right": `<rect class="src" x="2" y="60" width="38" height="38"/><path d="M21 56 V32 H80"/>` + headR(94, 32),
  "left-down": `<rect class="src" x="60" y="2" width="38" height="38"/><path d="M56 21 H32 V80"/>` + headD(32, 94),
};

// ---------- samples ----------
const SAMPLE_PATTERN = [
  "...#...#.......", ".......#.......", ".......#.......", ".....#...#.....", "###...#....#...",
  "###...#....#...", "....#......#...", "....#.....#....", "...#......#....", "...#....#...###",
  "...#....#...###", ".....#...#.....", ".......#.......", ".......#.......", ".......#...#...",
];

const SAMPLE_DOG = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fcdf3"/><stop offset="1" stop-color="#e6f5ff"/></linearGradient></defs>
<rect width="400" height="400" fill="url(#s)"/><circle cx="335" cy="68" r="34" fill="#ffd84d"/>
<rect y="292" width="400" height="108" fill="#78c158"/>
<ellipse cx="200" cy="335" rx="98" ry="72" fill="#f1e2c8"/>
<ellipse cx="120" cy="196" rx="34" ry="72" fill="#c4935a" transform="rotate(18 120 196)"/>
<ellipse cx="280" cy="196" rx="34" ry="72" fill="#c4935a" transform="rotate(-18 280 196)"/>
<ellipse cx="200" cy="190" rx="88" ry="82" fill="#f6ead6"/>
<ellipse cx="200" cy="234" rx="46" ry="34" fill="#fffaf0"/>
<ellipse cx="200" cy="256" rx="11" ry="14" fill="#ef7f8f"/>
<ellipse cx="200" cy="214" rx="17" ry="12" fill="#2a2522"/>
<circle cx="166" cy="176" r="11" fill="#2a2522"/><circle cx="234" cy="176" r="11" fill="#2a2522"/>
<circle cx="169" cy="172" r="3.5" fill="#fff"/><circle cx="237" cy="172" r="3.5" fill="#fff"/>
<path d="M200 226 v12 M184 244 q16 12 32 0" stroke="#2a2522" stroke-width="4" fill="none" stroke-linecap="round"/>
</svg>`);

// Rows: '#' clue square (clues listed below) or grey square, 'P' under the picture, letters are the answers.
const SWEDISH_SAMPLE = {
  rows: ["#####PPPP", "#AR##PPPP", "#RÖTTPPPP", "#GRAYPPPP", "#########", "#SÅ#TIMME", "#I#VARA#X", "#TRAGISKT", "#T#RISKER", "##VET#ENA", "#MA#SENT#"],
  clues: {
    1: [["down", "ILSKEN"]], 2: [["down", "TUB"]], 9: [["right", "YTMÅTT"]], 12: [["down", "GRIPA"]], 13: [["down", "FÖR, I ÄLDRE SPRÅK"]],
    18: [["right", "SOM BLOD"]], 27: [["right", "ENHET FÖR STRÅLDOS"]], 37: [["down", "BEFALLNING TILL HUNDEN PÅ BILDEN"]],
    40: [["down", "BLIVIT TAGNA"]], 41: [["down", "REGNBÅGS-HINNA"]], 42: [["down", "DÖLJER ANSIKTET"]], 44: [["down", "UTÖVER DET VANLIGA"]],
    45: [["right", "PLANTERA FRÖN"]], 48: [["right", "60 MINUTER"], ["down", "___ SIG"]], 56: [["right", "EXISTERA"]],
    61: [["down", "ROCKBAND FRÅN ESKILSTUNA"]], 63: [["right", "SORGLIGT"]], 74: [["right", "FAROR"], ["down", "VAD SA DU?"]],
    82: [["right", "HAR KUNSKAP"]], 86: [["right", "FÖRENA"]], 90: [["right", "MOR, I VARDAGSTAL"]], 93: [["right", "INTE TIDIGT"]],
  },
  zone: [46, 55, 64, 73],
  picture: { id: "sample-dog", r: 0, c: 5, w: 4, h: 4, src: SAMPLE_DOG },
};

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function newProject(title, w, h, symmetry = "rotational", style = "american") {
  const n = w * h;
  const p = {
    id: uid(), title: title || "Untitled puzzle", author: "", copyright: "", notes: "",
    w, h, symmetry: style === "swedish" ? "None" : symmetry, style,
    blocks: new Array(n).fill(0), letters: new Array(n).fill(""), pencil: new Array(n).fill(""),
    circles: new Array(n).fill(0), clues: {}, sclues: {}, zones: new Array(n).fill(0), breaks: new Array(n).fill(0), images: [], longArrows: [],
    created: Date.now(), modified: Date.now(),
  };
  if (style === "swedish") {
    // Usual starting frame: clue squares along the top row and the left column.
    p.blocks[0] = 2;
    for (let c = 1; c < w; c++) { p.blocks[c] = 1; p.sclues[c] = [{ text: "", arrow: "down" }]; }
    for (let r = 1; r < h; r++) { p.blocks[r * w] = 1; p.sclues[r * w] = [{ text: "", arrow: "right" }]; }
  }
  return p;
}

function sampleProject() {
  const p = newProject("Blue Pencil (sample)", 15, 15);
  SAMPLE_PATTERN.forEach((row, r) => [...row].forEach((ch, c) => { p.blocks[r * 15 + c] = ch === "#" ? 1 : 0; }));
  const put = (r, c, word) => [...word].forEach((ch, k) => { p.letters[r * 15 + c + k] = ch; });
  put(1, 0, "PENCILS");
  put(13, 8, "ERASERS");
  p.clues["1,0,A"] = "Tools sharpened before a solve";
  p.clues["13,8,A"] = "They undo graphite mistakes";
  p.author = "You";
  return p;
}

function swedishSampleProject() {
  const S = SWEDISH_SAMPLE, w = S.rows[0].length, h = S.rows.length;
  const p = newProject("Min bästa vän (exempel)", w, h, "None", "swedish");
  p.blocks.fill(0); p.sclues = {};
  S.rows.forEach((row, r) => [...row].forEach((ch, c) => {
    const i = r * w + c;
    if (ch === "#") p.blocks[i] = S.clues[i] ? 1 : 2;
    else if (ch !== "P") p.letters[i] = ch;
  }));
  for (const [i, list] of Object.entries(S.clues)) p.sclues[i] = list.map(([arrow, text]) => ({ arrow, text }));
  for (const i of S.zone) p.zones[i] = 1;
  p.images = [{ ...S.picture }];
  p.author = "Du";
  return p;
}

// ---------- helpers ----------
const isSv = () => project.style === "swedish";
const idx = (r, c) => r * project.w + c;
const eff = (i) => project.letters[i] || project.pencil[i];
const inBounds = (r, c) => r >= 0 && c >= 0 && r < project.h && c < project.w;
const dirName = (d) => (d === "A" ? "Across" : "Down");
const clueKey = (s) => `${s.r},${s.c},${s.dir}`;
const slotText = (s, fill = "?") => s.cells.map((i) => eff(i) || fill).join("");
const slotComplete = (s) => s.cells.every((i) => eff(i));
const isLetterCell = (i) => !project.blocks[i] && !covered[i];
const hasClues = (i) => project.blocks[i] === 1 || project.blocks[i] === 3; // clue square or thick arrow square
const letterCode = (l) => (l ? E.code(l.toLowerCase()) ?? -1 : -1);
const inkCodes = () => project.letters.map(letterCode);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function clueOf(s) {
  if (isSv() && s.arrowId) { const a = (project.longArrows || []).find((x) => x.id === s.arrowId); return a ? a.text || "" : ""; }
  if (isSv()) { const q = (project.sclues[s.clueCell] || [])[s.clueIdx]; return q ? q.text : ""; }
  return project.clues[clueKey(s)] || "";
}
function slotLabel(s) {
  if (isSv()) { const t = clueOf(s).replace(/\s+/g, " ").trim(); return `${ARROW_GLYPH[s.arrow]} ${t || "(no clue yet)"}`; }
  return `${s.num} ${dirName(s.dir)}`;
}
const slotTag = (s) => (isSv() ? ARROW_GLYPH[s.arrow] : `${s.num}${s.dir}`);

function regionRect() {
  const a = anchor || sel;
  return { r0: Math.min(a.r, sel.r), c0: Math.min(a.c, sel.c), r1: Math.max(a.r, sel.r), c1: Math.max(a.c, sel.c) };
}
function regionCells() {
  const { r0, c0, r1, c1 } = regionRect();
  const out = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(idx(r, c));
  return out;
}
const pictureAt = (i) => {
  const r = Math.floor(i / project.w), c = i % project.w;
  return project.images.find((im) => r >= im.r && r < im.r + im.h && c >= im.c && c < im.c + im.w);
};

function recomputeGeo() {
  const { w, h } = project;
  covered = new Uint8Array(w * h);
  for (const im of project.images || []) {
    for (let r = im.r; r < im.r + im.h; r++) for (let c = im.c; c < im.c + im.w; c++) if (inBounds(r, c)) covered[idx(r, c)] = 1;
  }
  if (isSv()) {
    const open = Array.from({ length: w * h }, (_, i) => isLetterCell(i));
    const { defs, problems } = E.swedishSlots(w, h, open, project.sclues, project.breaks);
    for (const a of project.longArrows || []) {
      const ans = a.answer ? arrowAnswerCells(a) : null;
      if (ans) defs.push({ ...ans, arrowId: a.id, arrow: ans.dir === "A" ? "right" : "down" });
    }
    defs.sort((x, y) => x.cells[0] - y.cells[0] || (x.dir === "A" ? -1 : 1));
    geo = E.geoFromSlots(w, h, defs);
    geo.problems = problems;
    geo.arrowsAt = new Map();
    for (const s of geo.slots) {
      if (s.arrowId || project.blocks[s.clueCell] === 3) continue; // long and thick arrows draw their own
      const list = geo.arrowsAt.get(s.cells[0]) || [];
      list.push(s.arrow);
      geo.arrowsAt.set(s.cells[0], list);
    }
    // Small triangles split a sentence into words. The clue covers the whole answer,
    // but for fill suggestions and autofill each word (2+ letters) must be in the word list.
    const words = [];
    for (const s of geo.slots) {
      const bit = s.dir === "A" ? 4 : 8;
      const parts = [[]];
      s.cells.forEach((i, p) => {
        parts[parts.length - 1].push(i);
        if (project.breaks[i] & bit && p < s.cells.length - 1) parts.push([]);
      });
      parts.forEach((cells, k) => { if (cells.length >= 2) words.push({ dir: s.dir, cells, parent: s.id, part: k + 1, parts: parts.length }); });
    }
    fillGeo = E.geoFromSlots(w, h, words);
  } else {
    geo = E.computeSlots(w, h, project.blocks);
    fillGeo = geo;
  }
}

function currentSlot() {
  if (!geo) return null;
  const i = idx(sel.r, sel.c);
  if (!isLetterCell(i)) return null;
  const ref = geo.cellSlots[i][dir] || geo.cellSlots[i][dir === "A" ? "D" : "A"];
  return ref ? geo.slots[ref.s] : null;
}

// The word being filled: the whole answer, or one word of a sentence split by triangles.
function currentFillSlot() {
  const ans = currentSlot();
  if (!ans || fillGeo === geo) return ans;
  const ref = fillGeo.cellSlots[idx(sel.r, sel.c)][ans.dir];
  const fs = ref ? fillGeo.slots[ref.s] : null;
  return fs && fs.parent === ans.id ? fs : null;
}
const answerOf = (fs) => (fillGeo === geo ? fs : geo.slots[fs.parent]);
function fillLabel(fs) {
  const base = slotLabel(answerOf(fs));
  return fs.parts > 1 ? `${base} · word ${fs.part} of ${fs.parts}` : base;
}

function toast(msg, ms = 2800) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

// ---------- persistence & undo ----------
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    project.modified = Date.now();
    projects[project.id] = project;
    if (!store.set("gw.projects", projects)) toast("Couldn't save to this browser's storage. Export a backup to keep your work.");
    store.set("gw.current", project.id);
  }, 250);
}

const snapshot = () => JSON.stringify({
  b: project.blocks, l: project.letters, p: project.pencil, c: project.circles, k: project.clues,
  q: project.sclues, z: project.zones, br: project.breaks, im: project.images, la: project.longArrows,
});
function restore(s) {
  const o = JSON.parse(s);
  Object.assign(project, { blocks: o.b, letters: o.l, pencil: o.p, circles: o.c, clues: o.k, sclues: o.q, zones: o.z, breaks: o.br, images: o.im, longArrows: o.la || [] });
  recomputeGeo();
}

function mutate(fn, { structural = false } = {}) {
  undoStack.push(snapshot());
  if (undoStack.length > 300) undoStack.shift();
  redoStack = [];
  fn();
  if (structural) recomputeGeo();
  saveSoon();
  render();
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  saveSoon(); render();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  saveSoon(); render();
}

// ---------- word lists ----------
// Any number of lists can be on at once. They are merged into one index:
// a word found in several lists keeps its highest score, and your added words override all.
const BUILTIN_LISTS = [
  { id: "bara", name: "bara_ord (SALDO 2.3)", note: "123,393 Swedish words. Ordinary words 60, names 55, abbreviations 50.", text: () => window.BARA_ORD },
  { id: "svfreq", name: "Swedish frequency list", note: "48,798 words, scored 30 to 60 by how common they are.", text: () => window.SWEDISH_WORDS },
  { id: "en", name: "English list", note: "269,746 words, all scored 50.", text: () => window.STARTER_WORDS },
];
let loadedFiles = [];                         // [{id, name, text}] kept in IndexedDB
let enabledLists = store.get("gw.lists", null); // {listId: true}
const lineCount = (text) => (text.match(/\n/g) || []).length + 1;

async function loadWordList() {
  loadedFiles = (await idb.get("wordlists")) || [];
  // Move a file loaded with an earlier version (one file only) into the new list of files.
  const old = await idb.get("wordlist");
  if (old && old.text) {
    loadedFiles.push({ id: uid(), name: old.name, text: old.text });
    await idb.set("wordlists", loadedFiles);
    await idb.del("wordlist");
  }
  if (!enabledLists) {
    const prev = store.get("gw.list", "bara");
    const id = prev === "custom" && loadedFiles[0] ? loadedFiles[0].id : BUILTIN_LISTS.some((b) => b.id === prev) ? prev : "bara";
    enabledLists = { [id]: true };
    store.set("gw.lists", enabledLists);
  }
  renderListChoices();
  rebuildIndex();
}

function activeSources() {
  const out = [];
  for (const b of BUILTIN_LISTS) if (enabledLists[b.id]) out.push({ name: b.name, text: b.text() || "" });
  for (const f of loadedFiles) if (enabledLists[f.id]) out.push({ name: f.name, text: f.text });
  return out;
}

function setListEnabled(id, on) {
  enabledLists[id] = on;
  if (!on) delete enabledLists[id];
  if (!Object.keys(enabledLists).length) {
    enabledLists.bara = true;
    toast("At least one list has to be on, so bara_ord was turned back on.");
  }
  store.set("gw.lists", enabledLists);
  renderListChoices();
  rebuildIndex();
}

function renderListChoices() {
  const host = $("wl-lists");
  host.innerHTML = "";
  const all = [
    ...BUILTIN_LISTS,
    ...loadedFiles.map((f) => ({ id: f.id, name: f.name, note: `Your file, ${lineCount(f.text).toLocaleString()} lines.`, file: true })),
  ];
  for (const l of all) {
    const row = document.createElement("div");
    row.className = "wl-row";
    row.innerHTML = `<input type="checkbox" id="wl-${l.id}"><label for="wl-${l.id}"><b></b><small></small></label>`;
    row.querySelector("b").textContent = l.name;
    row.querySelector("small").textContent = l.note;
    const box = row.querySelector("input");
    box.checked = !!enabledLists[l.id];
    box.addEventListener("change", () => setListEnabled(l.id, box.checked));
    if (l.file) {
      const rm = document.createElement("button");
      rm.type = "button"; rm.className = "btn small danger"; rm.textContent = "Remove";
      rm.addEventListener("click", async () => {
        if (rm.dataset.armed !== "1") { rm.dataset.armed = "1"; rm.textContent = "Confirm remove"; return; }
        loadedFiles = loadedFiles.filter((f) => f.id !== l.id);
        await idb.set("wordlists", loadedFiles);
        setListEnabled(l.id, false);
        toast(`Removed ${l.name}`);
      });
      row.appendChild(rm);
    }
    host.appendChild(row);
  }
}

async function addWordListFile(text, name) {
  const f = { id: uid(), name, text };
  loadedFiles.push(f);
  await idb.set("wordlists", loadedFiles);
  toast(`Loaded ${name}. It is on together with your other lists.`);
  setListEnabled(f.id, true);
}

function rebuildIndex() {
  const sources = activeSources();
  $("wl-status").className = "status";
  $("wl-status").textContent = "Indexing word lists…";
  index = null;
  setTimeout(() => {
    const t0 = performance.now();
    index = new E.WordIndex(E.mergeWordLists(sources.map((s) => s.text), custom));
    index.setMinScore(minScore());
    const ms = Math.round(performance.now() - t0);
    $("wl-status").className = "status ok";
    $("wl-status").textContent = sources.length === 1
      ? `Using ${sources[0].name}: ${index.size.toLocaleString()} words. Indexed in ${ms} ms.`
      : `Using ${sources.length} lists together: ${index.size.toLocaleString()} different words in total. Indexed in ${ms} ms.`;
    startWorker();
    render();
  }, 20);
}

function minScore() {
  const v = parseInt($("min-score").value, 10);
  return Number.isFinite(v) ? v : 0;
}

function startWorker() {
  if (worker) worker.terminate();
  worker = null; workerReady = false;
  try {
    const src = `const E=(${GridEngineFactory.toString()})();(${GridEngineWorkerMain.toString()})(E);`;
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    worker.onmessage = onWorkerMessage;
    worker.onerror = () => { worker = null; };
    worker.postMessage({ type: "load", texts: activeSources().map((src) => src.text), custom, minScore: minScore() });
  } catch {
    worker = null; // fall back to filling on the page
  }
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === "loaded") workerReady = true;
  else if (m.type === "filled" || m.type === "error") {
    if (m.id !== fillSeq) return;
    finishFill(m.type === "error" ? { ok: false, reason: m.message } : m);
  }
}

// ---------- autofill ----------
function setFillStatus(text, kind = "") {
  const el = $("fill-status");
  el.hidden = !text;
  el.className = "status " + kind;
  el.textContent = text || "";
}

function startFill() {
  if (filling) { stopFill(); return; }
  if (!index) return;
  if (!geo.slots.length) { setFillStatus(isSv() ? "There are no answers yet. Add clue squares with arrows first." : "The grid has no entries.", "err"); return; }
  const seconds = Math.max(2, Math.min(300, parseInt($("time-limit").value, 10) || 30));
  const grid = {
    w: project.w, h: project.h,
    blocks: project.blocks.map((b, i) => (b || covered[i] ? 1 : 0)),
    letters: inkCodes(),
    slotDefs: isSv() ? fillGeo.slots.map((s) => ({ dir: s.dir, cells: s.cells, label: fillLabel(s) })) : undefined,
  };
  const opts = { timeLimitMs: seconds * 1000, seed: Math.floor(Math.random() * 1e9) };
  filling = true;
  fillSeq++;
  $("btn-autofill").textContent = "Stop";
  setFillStatus(`Filling… up to ${seconds} s. Your inked letters stay locked.`);
  if (worker && workerReady) {
    worker.postMessage({ type: "fill", id: fillSeq, grid, opts });
  } else {
    setTimeout(() => finishFill(E.fillGrid(index, grid, { ...opts, timeLimitMs: Math.min(opts.timeLimitMs, 8000) })), 30);
  }
}

function stopFill() {
  filling = false;
  fillSeq++;
  $("btn-autofill").textContent = "Fill grid";
  setFillStatus("Fill stopped.");
  startWorker();
}

function finishFill(res) {
  filling = false;
  $("btn-autofill").textContent = "Fill grid";
  if (!res.ok) {
    setFillStatus(res.reason || "No fill found.", "err");
    if (res.slot != null && fillGeo.slots[res.slot]) selectSlot(fillGeo.slots[res.slot]);
    return;
  }
  mutate(() => {
    res.letters.forEach((code, i) => {
      if (!isLetterCell(i) || project.letters[i]) return;
      project.pencil[i] = code >= 0 ? E.ALPHA[code].toUpperCase() : "";
    });
  });
  setFillStatus(`Filled in ${(res.ms / 1000).toFixed(1)} s (${res.attempts} ${res.attempts === 1 ? "pass" : "passes"}). Pencil letters are suggestions: ink them to keep, or overwrite any entry.`, "ok");
}

// ---------- grid editing ----------
function partners(r, c) {
  const { w, h, symmetry } = project;
  const out = [[r, c]];
  if (isSv()) return out;
  if (symmetry === "rotational") out.push([h - 1 - r, w - 1 - c]);
  else if (symmetry === "leftRight") out.push([r, w - 1 - c]);
  else if (symmetry === "topBottom") out.push([h - 1 - r, c]);
  else if (symmetry === "NWSE" && w === h) out.push([c, r]);
  else if (symmetry === "SWNE" && w === h) out.push([w - 1 - c, h - 1 - r]);
  return out;
}

function toggleBlock(r, c) {
  const makeBlock = !project.blocks[idx(r, c)];
  mutate(() => {
    for (const [rr, cc] of partners(r, c)) {
      const i = idx(rr, cc);
      project.blocks[i] = makeBlock ? 1 : 0;
      if (makeBlock) { project.letters[i] = ""; project.pencil[i] = ""; project.circles[i] = 0; }
    }
  }, { structural: true });
}

function toggleCircle(r, c) {
  const i = idx(r, c);
  if (project.blocks[i]) return;
  mutate(() => { project.circles[i] = project.circles[i] ? 0 : 1; });
}

// Swedish: kind 0 = letter square, 1 = clue square, 2 = grey square, 3 = thick arrow square
// (starts an answer whose clue is elsewhere, such as a picture caption). Applies to the whole selection.
function defaultClue(i) {
  const r = Math.floor(i / project.w), c = i % project.w;
  const letter = (rr, cc) => inBounds(rr, cc) && isLetterCell(idx(rr, cc));
  if (letter(r, c + 1)) return { text: "", arrow: "right" };
  if (letter(r + 1, c)) return { text: "", arrow: "down" };
  return { text: "", arrow: "right" };
}

function setKind(kind, cells = regionCells()) {
  cells = cells.filter((i) => !covered[i]);
  if (!cells.length) return;
  mutate(() => {
    for (const i of cells) {
      project.blocks[i] = kind;
      if (kind) { project.letters[i] = ""; project.pencil[i] = ""; }
      if (kind !== 1 && kind !== 3) delete project.sclues[i];
    }
    if (kind === 1 || kind === 3) {
      recomputeGeo();
      for (const i of cells) {
        const list = project.sclues[i] || [defaultClue(i)];
        if (!list.length) list.push(defaultClue(i));
        // A thick arrow square holds one answer; a clue square holds up to two.
        project.sclues[i] = kind === 3
          ? [{ ...list[0], thick: true }]
          : list.map(({ thick, ...q }) => q);
      }
    }
  }, { structural: true });
}

// Every square a long arrow passes over, bends included.
function arrowPathCells(a) {
  const out = [];
  (a.cells || []).forEach((i, k) => {
    if (k === 0) { out.push(i); return; }
    const prev = a.cells[k - 1];
    const [dr, dc] = stepDir(prev, i);
    let r = rowOf(prev), c = colOf(prev);
    while (r !== rowOf(i) || c !== colOf(i)) { r += dr; c += dc; out.push(idx(r, c)); }
  });
  return out;
}

// Space: wipe the square (or the selected area) back to an empty letter square. Removes the letter,
// pencil, clue/grey/thick arrow square, yellow, bars, triangles and circle, plus any picture
// covering it and any long arrow passing over it. Undo brings it all back.
function clearSquares(cells) {
  const set = new Set(cells);
  const pics = (project.images || []).filter((im) => cells.some((i) => covered[i] && pictureAt(i) === im));
  const arrows = (project.longArrows || []).filter((a) => arrowPathCells(a).some((i) => set.has(i)));
  mutate(() => {
    for (const i of cells) {
      project.letters[i] = ""; project.pencil[i] = ""; project.circles[i] = 0;
      if (isSv()) {
        project.blocks[i] = 0;
        delete project.sclues[i];
        project.zones[i] = 0;
        project.breaks[i] = 0;
      } else if (project.blocks[i]) {
        for (const [rr, cc] of partners(rowOf(i), colOf(i))) project.blocks[idx(rr, cc)] = 0;
      }
    }
    project.images = (project.images || []).filter((im) => !pics.includes(im));
    project.longArrows = (project.longArrows || []).filter((a) => !arrows.includes(a));
  }, { structural: true });
  if (selPic && !project.images.some((im) => im.id === selPic)) selPic = null;
  if (selArrow && !project.longArrows.some((a) => a.id === selArrow)) selArrow = null;
}

// The same edge can carry a word-end bar or a sentence triangle, not both.
function toggleEdgeMark(kind) {
  const i = idx(sel.r, sel.c);
  if (!isLetterCell(i)) { toast(kind === "bar" ? "Word-end bars go on letter squares." : "Triangles go on letter squares."); return; }
  const bar = dir === "A" ? 1 : 2, tri = dir === "A" ? 4 : 8;
  const [on, off] = kind === "bar" ? [bar, tri] : [tri, bar];
  mutate(() => { project.breaks[i] = (project.breaks[i] ^ on) & ~off; }, { structural: true });
}

function toggleZone() {
  const cells = regionCells().filter((i) => !covered[i]);
  if (!cells.length) return;
  const allOn = cells.every((i) => project.zones[i]);
  mutate(() => { for (const i of cells) project.zones[i] = allOn ? 0 : 1; });
}

const toggleBreak = () => toggleEdgeMark("bar");
const toggleTriangle = () => toggleEdgeMark("triangle");

function step(r, c, d, k = 1) {
  return d === "A" ? [r, c + k] : [r + k, c];
}

function advance(k = 1) {
  const [r, c] = step(sel.r, sel.c, dir, k);
  if (inBounds(r, c) && isLetterCell(idx(r, c))) sel = { r, c };
}

function typeLetter(ch) {
  const i = idx(sel.r, sel.c);
  if (isSv() && hasClues(i)) { focusSquareClue(0, ch); return; }
  if (!isLetterCell(i)) return;
  mutate(() => { project.letters[i] = ch; project.pencil[i] = ""; });
  advance(1);
  render();
}

function erase(forward) {
  const i = idx(sel.r, sel.c);
  if (forward) {
    if (isLetterCell(i)) mutate(() => { project.letters[i] = ""; project.pencil[i] = ""; });
    advance(1);
    render();
    return;
  }
  if (isLetterCell(i) && eff(i)) {
    mutate(() => { project.letters[i] = ""; project.pencil[i] = ""; });
    return;
  }
  const [r, c] = step(sel.r, sel.c, dir, -1);
  if (!inBounds(r, c)) return;
  sel = { r, c };
  const j = idx(r, c);
  if (isLetterCell(j) && eff(j)) mutate(() => { project.letters[j] = ""; project.pencil[j] = ""; });
  else render();
}

function selectSlot(s, toFirstBlank = false) {
  dir = s.dir;
  anchor = null; selPic = null;
  let target = s.cells[0];
  if (toFirstBlank) target = s.cells.find((i) => !eff(i)) ?? s.cells[0];
  sel = { r: Math.floor(target / project.w), c: target % project.w };
  render();
}

function nextSlot(delta) {
  const order = isSv() ? geo.slots.slice() : [...geo.slots.filter((s) => s.dir === dir), ...geo.slots.filter((s) => s.dir !== dir)];
  if (!order.length) return;
  const cur = currentSlot();
  let k = cur ? order.indexOf(cur) : -1;
  k = (k + delta + order.length) % order.length;
  selectSlot(order[k], true);
}

function onGridKey(e) {
  if (drawing) {
    if (e.key === "Enter") { e.preventDefault(); finishArrow(); return; }
    if (e.key === "Escape") { e.preventDefault(); cancelArrow(); return; }
    if (e.key === "Backspace") { e.preventDefault(); drawing.cells.pop(); render(); return; }
    if (e.key === " ") { e.preventDefault(); return; }
  }
  if (selArrow && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); removeArrow(); return; }
  if (selArrow && e.key === "Escape") { e.preventDefault(); selArrow = null; render(); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (mod) {
    if (e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    return;
  }
  if (e.altKey) return;
  const k = e.key;
  const arrows = { ArrowUp: [-1, 0, "D"], ArrowDown: [1, 0, "D"], ArrowLeft: [0, -1, "A"], ArrowRight: [0, 1, "A"] };
  if (arrows[k]) {
    e.preventDefault();
    const [dr, dc, d] = arrows[k];
    if (e.shiftKey) {
      // Extend a rectangular selection.
      if (!anchor) anchor = { ...sel };
      const r = sel.r + dr, c = sel.c + dc;
      if (inBounds(r, c)) sel = { r, c };
      render();
      return;
    }
    anchor = null; selPic = null;
    if (d !== dir && isLetterCell(idx(sel.r, sel.c))) { dir = d; render(); return; }
    const r = sel.r + dr, c = sel.c + dc;
    if (inBounds(r, c)) sel = { r, c };
    render();
  } else if (k === "Tab") {
    e.preventDefault(); nextSlot(e.shiftKey ? -1 : 1);
  } else if (k === "Enter") {
    e.preventDefault();
    if (isSv() && hasClues(idx(sel.r, sel.c))) { focusSquareClue(0); return; }
    dir = dir === "A" ? "D" : "A"; render();
  } else if (k === "Backspace") {
    e.preventDefault(); erase(false);
  } else if (k === " ") {
    e.preventDefault();
    const area = !!anchor;
    clearSquares(area ? regionCells() : [idx(sel.r, sel.c)]);
    if (!area) { advance(1); render(); }
  } else if (k === "Delete") {
    e.preventDefault(); erase(true);
  } else if (k === ".") {
    e.preventDefault();
    if (isSv()) setKind(project.blocks[idx(sel.r, sel.c)] === 1 ? 0 : 1);
    else { toggleBlock(sel.r, sel.c); advance(1); render(); }
  } else if (k === "#" && isSv()) {
    e.preventDefault(); setKind(project.blocks[idx(sel.r, sel.c)] === 2 ? 0 : 2);
  } else if (k === "-" && isSv()) {
    e.preventDefault(); toggleBreak();
  } else if (k === ">" && isSv()) {
    e.preventDefault(); toggleTriangle();
  } else if (k === "*" && !isSv()) {
    e.preventDefault(); toggleCircle(sel.r, sel.c);
  } else if (k === "Escape") {
    if (anchor) { anchor = null; render(); } else $("grid").blur();
  } else if (/^[a-zåäö]$/i.test(k)) {
    e.preventDefault(); typeLetter(k.toUpperCase());
  }
}

// ---------- pictures ----------
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
    const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement("canvas");
    cv.width = Math.round(img.naturalWidth * scale); cv.height = Math.round(img.naturalHeight * scale);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.86);
  } finally { URL.revokeObjectURL(url); }
}

function addPicture() {
  const { r0, c0, r1, c1 } = regionRect();
  if (r0 === r1 && c0 === c1) { toast("Select the area first: drag across squares or Shift+click the opposite corner."); return; }
  const cells = regionCells();
  if (cells.some((i) => covered[i])) { toast("That area overlaps another picture. Remove it first."); return; }
  const input = $("file-input");
  input.value = ""; input.accept = "image/*";
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    let src;
    try { src = await shrinkImage(f); } catch { toast("That file couldn't be read as a picture."); return; }
    const id = uid();
    imgCache.set(id, src);
    await idb.set("img:" + id, src);
    mutate(() => {
      for (const i of cells) { project.blocks[i] = 0; project.letters[i] = ""; project.pencil[i] = ""; project.zones[i] = 0; delete project.sclues[i]; }
      project.images.push({ id, r: r0, c: c0, w: c1 - c0 + 1, h: r1 - r0 + 1 });
    }, { structural: true });
    anchor = null; selPic = id;
    render();
  };
  input.click();
}

function removePicture() {
  const im = project.images.find((x) => x.id === selPic) || pictureAt(idx(sel.r, sel.c));
  if (!im) { toast("Click a picture to select it first."); return; }
  mutate(() => { project.images = project.images.filter((x) => x !== im); }, { structural: true });
  selPic = null;
  render();
}

async function loadProjectImages() {
  const missing = (project.images || []).filter((im) => !im.src && !imgCache.has(im.id));
  for (const im of missing) {
    const src = await idb.get("img:" + im.id);
    if (src) imgCache.set(im.id, src);
  }
  if (missing.length) { picSig = ""; render(); }
}

// ---------- rendering ----------
// ---------- long arrows ----------
// Free arrows drawn over the grid and pictures. They pass through the squares you click,
// bend at right angles, and end with the tip on the edge of the last square. An arrow can
// also start an answer (like a thick arrow square) running on from its last square.
let drawing = null;   // {cells, thick} while an arrow is being drawn
let hoverCell = null;
let selArrow = null;  // id of the selected long arrow
const SVGNS = "http://www.w3.org/2000/svg";
const ARROW_STYLE = { thin: { stroke: 5, len: 26, half: 15 }, thick: { stroke: 13, len: 38, half: 26 } };
const rowOf = (i) => Math.floor(i / project.w), colOf = (i) => i % project.w;
const stepDir = (a, b) => [Math.sign(rowOf(b) - rowOf(a)), Math.sign(colOf(b) - colOf(a))];

// Adds a corner wherever two clicked squares share neither row nor column (across first, then down),
// and drops points in the middle of a straight run.
function routeCells(cells) {
  const pts = [];
  for (const i of cells) {
    const prev = pts[pts.length - 1];
    if (prev === i) continue;
    if (prev != null && rowOf(prev) !== rowOf(i) && colOf(prev) !== colOf(i)) pts.push(idx(rowOf(prev), colOf(i)));
    pts.push(i);
  }
  return pts.filter((i, k) => {
    if (k === 0 || k === pts.length - 1) return true;
    const [a, b] = stepDir(pts[k - 1], i), [c, d] = stepDir(i, pts[k + 1]);
    return a !== c || b !== d;
  });
}

function longArrowShape(route, thick) {
  const st = thick ? ARROW_STYLE.thick : ARROW_STYLE.thin;
  const pts = route.map((i) => [colOf(i) * 100 + 50, rowOf(i) * 100 + 50]);
  const [dr, dc] = stepDir(route[route.length - 2], route[route.length - 1]);
  const [ex, ey] = pts[pts.length - 1];
  const tip = [ex - dc * 50, ey - dr * 50];                 // where it enters the last square
  const base = [tip[0] - dc * st.len, tip[1] - dr * st.len];
  const line = [...pts.slice(0, -1), [base[0] + dc * 2, base[1] + dr * 2]];
  return {
    d: "M" + line.map((p) => p.join(" ")).join(" L"),
    head: [tip, [base[0] - dr * st.half, base[1] + dc * st.half], [base[0] + dr * st.half, base[1] - dc * st.half]],
    stroke: st.stroke,
  };
}

// The answer a long arrow starts: from its last square in the arrow's final direction (right or down).
function arrowAnswerCells(a) {
  if (!a.cells || a.cells.length < 2) return null;
  const [dr, dc] = stepDir(a.cells[a.cells.length - 2], a.cells[a.cells.length - 1]);
  if (!((dr === 0 && dc === 1) || (dr === 1 && dc === 0))) return null;
  const d = dc === 1 ? "A" : "D";
  const cells = [];
  let r = rowOf(a.cells[a.cells.length - 1]), c = colOf(a.cells[a.cells.length - 1]);
  while (inBounds(r, c) && isLetterCell(idx(r, c))) {
    const j = idx(r, c);
    cells.push(j);
    if (project.breaks[j] & (d === "A" ? 1 : 2)) break;
    if (d === "A") c++; else r++;
  }
  return cells.length >= 2 ? { dir: d, cells } : null;
}

let arrowSig = "";
function renderLongArrows() {
  const g = $("grid");
  let svg = g.querySelector(".arrow-layer");
  if (!svg) {
    svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "arrow-layer");
    svg.setAttribute("aria-hidden", "true");
    g.appendChild(svg);
    arrowSig = "";
  }
  const draft = drawing ? routeCells(hoverCell != null ? [...drawing.cells, hoverCell] : drawing.cells) : null;
  const sig = JSON.stringify([project.w, project.h, project.longArrows, selArrow, draft, drawing && drawing.thick]);
  if (sig === arrowSig) return;
  arrowSig = sig;
  svg.setAttribute("viewBox", `0 0 ${project.w * 100} ${project.h * 100}`);
  svg.style.gridArea = "1 / 1 / -1 / -1";
  const one = (route, thick, cls, id) => {
    if (route.length === 1 && cls === "draft") return `<circle class="la-dot" cx="${colOf(route[0]) * 100 + 50}" cy="${rowOf(route[0]) * 100 + 50}" r="12"/>`;
    if (route.length < 2) return "";
    const { d, head, stroke } = longArrowShape(route, thick);
    return `<g class="la ${cls}"${id ? ` data-arrow="${id}"` : ""}><path class="hit" d="${d}"/><path class="line" d="${d}" stroke-width="${stroke}"/><polygon class="head" points="${head.map((p) => p.join(",")).join(" ")}"/></g>`;
  };
  svg.innerHTML = (project.longArrows || []).map((a) => one(a.cells, a.thick, a.id === selArrow ? "sel" : "", a.id)).join("")
    + (draft ? one(draft, drawing.thick, "draft") : "");
}

function startArrow() {
  drawing = { cells: [], thick: !!store.get("gw.arrowThick", false) };
  hoverCell = null; selArrow = null; selPic = null; anchor = null;
  $("grid").focus();
  render();
}
function cancelArrow() { drawing = null; hoverCell = null; render(); }
function finishArrow() {
  const route = drawing ? routeCells(drawing.cells) : [];
  const thick = !!(drawing && drawing.thick);
  drawing = null; hoverCell = null;
  if (route.length < 2) { toast("An arrow needs at least two squares: click where it starts, then the square it points into."); render(); return; }
  const a = { id: uid(), cells: route, thick, text: "", answer: false };
  a.answer = !!arrowAnswerCells(a);
  mutate(() => { project.longArrows.push(a); }, { structural: true });
  selArrow = a.id;
  render();
}
const selectedArrow = () => (project.longArrows || []).find((a) => a.id === selArrow);
function updateArrow(fn) {
  const a = selectedArrow();
  if (a) mutate(() => fn(a), { structural: true });
}
function removeArrow() {
  if (!selectedArrow()) return;
  mutate(() => { project.longArrows = project.longArrows.filter((a) => a.id !== selArrow); }, { structural: true });
  selArrow = null;
  render();
}
function setArrowClue(text, commit) {
  const a = selectedArrow();
  if (!a) return;
  armClueUndo("la:" + a.id);
  a.text = text;
  if (commit) { clueUndoArmed = null; rememberClue(geo.slots.find((s) => s.arrowId === a.id), text.trim()); }
  saveSoon();
  render();
}

let laKey = "";
function renderArrowEditor() {
  const host = $("la-editor");
  const a = selectedArrow();
  host.hidden = !drawing && !a;
  if (host.hidden) { laKey = ""; return; }
  const canAnswer = a && !!arrowAnswerCells(a);
  const key = drawing ? `draw|${drawing.thick}` : `${a.id}|${a.thick}|${a.answer}|${canAnswer}`;
  const thickPick = (thick, onPick) => {
    const box = document.createElement("div");
    box.className = "row";
    for (const [label, v] of [["Thin line", false], ["Thick line", true]]) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "btn small" + (thick === v ? " on" : ""); b.textContent = label;
      b.setAttribute("aria-pressed", String(thick === v));
      b.addEventListener("click", () => onPick(v));
      box.appendChild(b);
    }
    return box;
  };
  const button = (label, cls, fn) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn small " + cls; b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  };
  if (key !== laKey) {
    laKey = key;
    host.innerHTML = "";
    if (drawing) {
      const p = document.createElement("p");
      p.className = "muted"; p.style.margin = "0"; p.style.fontSize = "13px";
      p.innerHTML = "<b>Drawing a long arrow.</b> Click the squares it passes through, ending on the square it points into; bends are added for you. <kbd>Backspace</kbd> removes the last point, <kbd>Enter</kbd> or a double-click finishes, <kbd>Esc</kbd> cancels.";
      host.appendChild(p);
      const row = thickPick(drawing.thick, (v) => { drawing.thick = v; store.set("gw.arrowThick", v); render(); $("grid").focus(); });
      row.appendChild(button("Finish arrow", "primary", () => { finishArrow(); $("grid").focus(); }));
      row.appendChild(button("Cancel", "", () => { cancelArrow(); $("grid").focus(); }));
      host.appendChild(row);
    } else {
      const row = thickPick(a.thick, (v) => updateArrow((x) => { x.thick = v; }));
      row.appendChild(button("Point the other way", "", () => updateArrow((x) => { x.cells.reverse(); })));
      row.appendChild(button("Remove arrow", "danger", () => { removeArrow(); $("grid").focus(); }));
      host.appendChild(row);
      const chk = document.createElement("label");
      chk.className = "row"; chk.style.fontSize = "13px";
      chk.innerHTML = `<input type="checkbox" ${a.answer && canAnswer ? "checked" : ""} ${canAnswer ? "" : "disabled"}> Starts an answer from the square it points into`;
      chk.querySelector("input").addEventListener("change", (e) => updateArrow((x) => { x.answer = e.target.checked; }));
      host.appendChild(chk);
      if (!canAnswer) {
        const n = document.createElement("span");
        n.className = "muted"; n.style.fontSize = "12.5px";
        n.textContent = "To start an answer, the arrow has to end pointing right or down into at least two letter squares.";
        host.appendChild(n);
      } else if (a.answer) {
        const f = document.createElement("label");
        f.className = "field";
        f.textContent = "Clue for this answer (not printed in the grid, e.g. the picture caption)";
        const ta = document.createElement("textarea");
        ta.rows = 2; ta.dataset.la = "1"; ta.placeholder = "Bildtext eller ledtråd"; ta.value = a.text || "";
        ta.addEventListener("input", () => setArrowClue(ta.value, false));
        ta.addEventListener("change", () => setArrowClue(ta.value, true));
        f.appendChild(ta);
        host.appendChild(f);
      }
    }
  } else if (a) {
    const ta = host.querySelector("textarea[data-la]");
    if (ta && document.activeElement !== ta && ta.value !== (a.text || "")) ta.value = a.text || "";
  }
}

// Which square is under the pointer, even over a picture or an arrow.
function cellFromPoint(e) {
  const g = $("grid"), rect = g.getBoundingClientRect();
  const border = (rect.width - g.clientWidth) / 2;
  const c = Math.floor((e.clientX - rect.left - border) / (g.clientWidth / project.w));
  const r = Math.floor((e.clientY - rect.top - border) / (g.clientHeight / project.h));
  return inBounds(r, c) ? idx(r, c) : null;
}

let cellEls = [];
let picSig = "";
function buildGrid() {
  const g = $("grid");
  g.style.setProperty("--w", project.w);
  g.style.setProperty("--h", project.h);
  g.classList.toggle("sv", isSv());
  g.lang = isSv() ? "sv" : "en";
  g.innerHTML = "";
  cellEls = [];
  picSig = "";
  arrowSig = "";
  for (let i = 0; i < project.w * project.h; i++) {
    const d = document.createElement("div");
    d.className = "cell";
    d.dataset.i = i;
    d.style.gridRow = String(Math.floor(i / project.w) + 1);
    d.style.gridColumn = String((i % project.w) + 1);
    d.innerHTML = '<span class="n"></span><span class="l"></span><span class="qbox"></span><span class="arw"></span><span class="k"></span>';
    g.appendChild(d);
    const [n, l, q, a] = d.children;
    cellEls.push({ el: d, n, l, q, a, qKey: "", aKey: "" });
  }
}

function renderImages() {
  const sig = JSON.stringify(project.images) + "|" + selPic + "|" + [...imgCache.keys()].join();
  if (sig === picSig) return;
  picSig = sig;
  const g = $("grid");
  g.querySelectorAll(".pic").forEach((p) => p.remove());
  for (const im of project.images || []) {
    const d = document.createElement("div");
    d.className = "pic" + (im.id === selPic ? " on" : "");
    d.dataset.pic = im.id;
    d.style.gridArea = `${im.r + 1} / ${im.c + 1} / span ${im.h} / span ${im.w}`;
    const src = imgCache.get(im.id) || im.src;
    d.innerHTML = src ? `<img alt="">` : `<span class="ph">Picture missing</span>`;
    if (src) d.firstChild.src = src;
    g.appendChild(d);
  }
}

function deadCells() {
  const bad = new Set();
  if (!index) return bad;
  const codes = inkCodes();
  for (const s of fillGeo.slots) {
    const pat = s.cells.map((i) => codes[i]);
    if (pat.every((x) => x < 0) || pat.every((x) => x >= 0)) continue;
    if (index.count(index.match(pat)) === 0) s.cells.forEach((i) => bad.add(i));
  }
  return bad;
}

const toFit = new Set();
function render() {
  if (!project) return;
  document.body.dataset.style = isSv() ? "swedish" : "american";
  const sv = isSv();
  const slot = currentSlot();
  const inSlot = new Set(slot ? slot.cells : []);
  const i0 = idx(sel.r, sel.c);
  const crossRef = isLetterCell(i0) && slot ? geo.cellSlots[i0][slot.dir === "A" ? "D" : "A"] : null;
  const inCross = new Set(crossRef ? geo.slots[crossRef.s].cells : []);
  const bad = deadCells();
  const region = anchor ? new Set(regionCells()) : null;
  for (let i = 0; i < cellEls.length; i++) {
    const ce = cellEls[i];
    const { el, n, l } = ce;
    const b = project.blocks[i];
    let cls = "cell";
    if (sv) {
      if (b === 1) cls += " q";
      else if (b === 2) cls += " dead";
      else if (b === 3) cls += " ta";
      if (project.zones[i]) cls += " z";
      if (!b && project.breaks[i] & 1) cls += " kr";
      if (!b && project.breaks[i] & 2) cls += " kb";
      if (slot && slot.clueCell === i) cls += " qh";
    } else if (b) cls += " b";
    if (!b) {
      if (project.circles[i] && !sv) cls += " c";
      if (inCross.has(i)) cls += " x";
      if (inSlot.has(i)) cls += " h";
      if (bad.has(i)) cls += " bad";
    }
    if (region && region.has(i)) cls += " rg";
    if (i === i0) cls += " s";
    if (el.className !== cls) el.className = cls;

    const num = b || sv ? "" : geo.numbers[i] || "";
    if (n.textContent != num) n.textContent = num;
    const ink = project.letters[i], pen = project.pencil[i];
    const txt = b ? "" : ink || pen;
    if (l.textContent !== txt) l.textContent = txt;
    l.classList.toggle("p", !ink && !!pen);

    // Swedish clue text inside the square, and arrows in answer squares.
    const clues = sv && b === 1 ? project.sclues[i] || [] : null;
    const thick = sv && b === 3 ? ((project.sclues[i] || [])[0] || {}).arrow || "right" : null;
    const qKey = clues ? JSON.stringify(clues.map((q) => q.text)) : thick ? "thick:" + thick : "";
    if (qKey !== ce.qKey) {
      ce.qKey = qKey;
      ce.q.innerHTML = thick ? thickArrowSvg(thick) : clues
        ? (clues.length ? clues : [{ text: "" }]).map((q) => q.text.trim()
          ? `<span class="qt">${esc(q.text.trim())}</span>`
          : `<span class="qt empty">clue</span>`).join("")
        : "";
      if (clues) toFit.add(i);
    }
    let arrows = sv ? geo.arrowsAt.get(i) || [] : [];
    if (sv && !b) {
      if (project.breaks[i] & 4) arrows = [...arrows, "tri-r"];
      if (project.breaks[i] & 8) arrows = [...arrows, "tri-b"];
    }
    if (!arrows.length) arrows = null;
    const aKey = arrows ? arrows.join() : "";
    if (aKey !== ce.aKey) { ce.aKey = aKey; ce.a.innerHTML = arrows ? arrows.map(cellArrowSvg).join("") : ""; }
  }
  renderImages();
  renderLongArrows();
  fitClues();
  $("grid").classList.toggle("drawing", !!drawing);

  // under the grid: clue square editor (Swedish) or the current entry's clue
  const onClueSquare = sv && hasClues(i0) && !covered[i0];
  renderArrowEditor();
  const arrowPanel = !$("la-editor").hidden;   // the arrow panel replaces the clue editors
  $("sq-editor").hidden = !onClueSquare || arrowPanel;
  $("clue-bar").hidden = onClueSquare || arrowPanel;
  if (onClueSquare && !arrowPanel) renderSquareEditor(i0);
  else if (slot) {
    $("cur-tag").textContent = slotTag(slot);
    const v = clueOf(slot);
    if (document.activeElement !== $("cur-clue")) $("cur-clue").value = v;
    $("cur-clue").disabled = false;
  } else {
    $("cur-tag").textContent = covered[i0] ? "Picture" : sv && project.blocks[i0] === 2 ? "Grey square" : sv && !anchor ? "No answer here" : anchor ? "Area selected" : "Black square";
    $("cur-clue").value = "";
    $("cur-clue").disabled = true;
  }

  if ($("title").value !== project.title && document.activeElement !== $("title")) $("title").value = project.title;
  $("symmetry").value = project.symmetry;
  for (const o of $("symmetry").options) if (o.value === "NWSE" || o.value === "SWNE") o.disabled = project.w !== project.h;
  $("btn-undo").disabled = !undoStack.length;
  $("btn-redo").disabled = !redoStack.length;
  const hasPencil = project.pencil.some(Boolean);
  $("btn-accept").disabled = !hasPencil;
  $("btn-clear-pencil").disabled = !hasPencil;
  $("btn-circle").classList.toggle("on", !!project.circles[i0] && !project.blocks[i0]);
  $("btn-block").classList.toggle("on", !!project.blocks[i0]);
  $("btn-clue-sq").classList.toggle("on", project.blocks[i0] === 1);
  $("btn-thick").classList.toggle("on", project.blocks[i0] === 3);
  const triBit = dir === "A" ? 4 : 8, barBit = dir === "A" ? 1 : 2;
  $("btn-tri").classList.toggle("on", !!(project.breaks[i0] & triBit) && isLetterCell(i0));
  $("btn-break").classList.toggle("on", !!(project.breaks[i0] & barBit) && isLetterCell(i0));
  $("btn-dead-sq").classList.toggle("on", project.blocks[i0] === 2);
  $("btn-pic-del").disabled = !(selPic || covered[i0]);
  $("btn-arrow").textContent = drawing ? "Finish arrow" : "Long arrow";
  $("btn-arrow").classList.toggle("on", !!drawing);

  if (activeTab === "fill") renderFillSoon();
  if (activeTab === "clues") renderClues();
  if (activeTab === "stats") renderStats();
}

// Shrink each clue's text until it fits its half of the square. Sizes are stored relative
// to the square width (--k), so they hold at any zoom and in print.
function fitClues() {
  for (const i of toFit) {
    const ce = cellEls[i];
    if (!ce) continue;
    for (const el of ce.q.querySelectorAll(".qt")) {
      let lo = 0.06, hi = 0.2;
      for (let step = 0; step < 8; step++) {
        const mid = (lo + hi) / 2;
        el.style.setProperty("--k", mid.toFixed(4));
        const fits = el.scrollHeight <= el.clientHeight + 0.5 && el.scrollWidth <= el.clientWidth + 0.5;
        if (fits) lo = mid; else hi = mid;
      }
      el.style.setProperty("--k", lo.toFixed(4));
    }
  }
  toFit.clear();
}

// ---------- Swedish clue square editor ----------
let sqKey = "";
function renderSquareEditor(i) {
  const host = $("sq-editor");
  const clues = project.sclues[i] || [];
  const thick = project.blocks[i] === 3;
  const key = i + "|" + thick + "|" + clues.map((q) => q.arrow).join();
  if (key !== sqKey) {
    sqKey = key;
    host.innerHTML = "";
    clues.forEach((q, k) => {
      const row = document.createElement("div");
      row.className = "sq-row";
      const label = thick ? "Thick arrow: clue for this answer (not printed in the grid, e.g. the picture caption)"
        : clues.length > 1 ? (k === 0 ? "Upper clue" : "Lower clue") : "Clue";
      row.innerHTML = `<label class="field">${label}<textarea rows="2" placeholder="${thick ? "Bildtext eller ledtråd" : "Skriv ledtråden"}" data-k="${k}"></textarea></label>
        <div class="sq-tools"><div class="arrow-pick" role="group" aria-label="Arrow"></div></div>`;
      const ta = row.querySelector("textarea");
      ta.value = q.text;
      ta.addEventListener("input", () => setSquareClue(i, k, ta.value, false));
      ta.addEventListener("change", () => setSquareClue(i, k, ta.value, true));
      ta.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); setSquareClue(i, k, ta.value, true); $("grid").focus(); } });
      const pick = row.querySelector(".arrow-pick");
      for (const a of ARROW_ORDER) {
        const b = document.createElement("button");
        b.type = "button";
        b.title = ARROW_NAMES[a];
        b.setAttribute("aria-label", ARROW_NAMES[a]);
        b.setAttribute("aria-pressed", String(q.arrow === a));
        b.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true">${PICK_ARROW[a]}</svg>`;
        b.addEventListener("click", () => mutate(() => { project.sclues[i][k].arrow = a; }, { structural: true }));
        pick.appendChild(b);
      }
      if (!thick) {
        const rm = document.createElement("button");
        rm.type = "button"; rm.className = "btn small danger"; rm.textContent = "Remove clue";
        rm.addEventListener("click", () => mutate(() => { project.sclues[i].splice(k, 1); }, { structural: true }));
        row.querySelector(".sq-tools").appendChild(rm);
      }
      host.appendChild(row);
    });
    const actions = document.createElement("div");
    actions.className = "row";
    if (!thick && clues.length < 2) {
      const add = document.createElement("button");
      add.type = "button"; add.className = "btn small";
      add.textContent = clues.length ? "Add a second clue" : "Add a clue";
      add.addEventListener("click", () => mutate(() => {
        const used = new Set(clues.map((q) => q.arrow));
        const first = defaultClue(i);
        const arrow = !used.has(first.arrow) ? first.arrow : ARROW_ORDER.find((a) => !used.has(a));
        (project.sclues[i] = project.sclues[i] || []).push({ text: "", arrow });
      }, { structural: true }));
      actions.appendChild(add);
    }
    const note = document.createElement("span");
    note.className = "muted";
    note.style.fontSize = "12.5px";
    const answers = geo.slots.filter((s) => s.clueCell === i);
    const lost = (geo.problems || []).filter((p) => p.clueCell === i);
    note.textContent = answers.map((s) => `${ARROW_GLYPH[s.arrow]} ${s.len} letters: ${slotText(s, "·")}`).join("   ")
      + (lost.length ? `   ${lost.length > 1 ? "Two arrows point" : "An arrow points"} at fewer than 2 letter squares.` : "");
    actions.appendChild(note);
    host.appendChild(actions);
  } else {
    host.querySelectorAll("textarea").forEach((ta) => {
      const q = clues[+ta.dataset.k];
      if (q && document.activeElement !== ta && ta.value !== q.text) ta.value = q.text;
    });
  }
}

function focusSquareClue(k, append = "") {
  render();
  const ta = $("sq-editor").querySelector(`textarea[data-k="${k}"]`);
  if (!ta) return;
  ta.focus();
  if (append) { ta.value += append; setSquareClue(idx(sel.r, sel.c), k, ta.value, false); }
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

let clueUndoArmed = null;
function armClueUndo(key) {
  if (clueUndoArmed !== key) { undoStack.push(snapshot()); redoStack = []; clueUndoArmed = key; }
}
function rememberClue(s, text) {
  if (!text || !s || !slotComplete(s)) return;
  const ans = slotText(s);
  clueBank[ans] = [text, ...(clueBank[ans] || []).filter((x) => x !== text)].slice(0, 12);
  store.set("gw.cluebank", clueBank);
}

function setSquareClue(i, k, text, commit) {
  const q = (project.sclues[i] || [])[k];
  if (!q) return;
  armClueUndo(`${i}:${k}`);
  q.text = text;
  if (commit) { clueUndoArmed = null; rememberClue(geo.slots.find((s) => s.clueCell === i && s.clueIdx === k), text.trim()); }
  saveSoon();
  render();
}

// ---------- fill suggestions ----------
let fillTimer = null;
function renderFillSoon() { clearTimeout(fillTimer); fillTimer = setTimeout(renderFill, 30); }

function renderFill() {
  const slot = currentFillSlot();
  const list = $("cands");
  if (!slot) {
    $("slot-label").textContent = currentSlot() ? "One-letter word" : "No answer selected";
    $("slot-pattern").textContent = "";
    $("cand-summary").textContent = currentSlot()
      ? "This square is a one-letter word in a sentence, so any letter is allowed here."
      : isSv() ? "Select a letter square that belongs to an answer to see words that fit." : "Select a white square to see words that fit.";
    list.innerHTML = "";
    return;
  }
  const label = fillLabel(slot);
  $("slot-label").textContent = `${label.length > 52 ? label.slice(0, 51) + "…" : label} · ${slot.len} letters`;
  $("slot-pattern").textContent = slot.cells.map((i) => project.letters[i] || "·").join("");
  if (!index) { $("cand-summary").textContent = "Word list is loading…"; return; }

  const { total, list: cands } = E.candidatesFor(index, fillGeo, inkCodes(), slot.id, 600);
  let rows = cands;
  const f = $("cand-filter").value.trim().toLowerCase();
  if (f) {
    let re = null;
    if (/[\^$.*+?()[\]|]/.test(f)) { try { re = new RegExp(f); } catch { re = null; } }
    rows = rows.filter((c) => (re ? re.test(c.word) : c.word.includes(E.normalize(f))));
  }
  const room = (c) => (c.minCross < 0 ? 12 : Math.log2(1 + c.minCross));
  const sort = $("cand-sort").value;
  if (sort === "recommended") rows = rows.slice().sort((a, b) => (b.minCross !== 0) - (a.minCross !== 0) || (0.6 * b.score + 5 * room(b)) - (0.6 * a.score + 5 * room(a)));
  else if (sort === "room") rows = rows.slice().sort((a, b) => room(b) - room(a) || b.score - a.score);
  else if (sort === "alpha") rows = rows.slice().sort((a, b) => a.word.localeCompare(b.word, "sv"));

  const fillable = cands.filter((c) => c.minCross !== 0).length;
  $("cand-summary").textContent = total === 0
    ? "No word in the list fits this pattern. Change a crossing letter or add a word in the Word list tab."
    : `${total.toLocaleString()} ${total === 1 ? "word fits" : "words fit"}${cands.length < total ? ` (top ${cands.length} by score checked)` : ""}. ${fillable.toLocaleString()} leave every crossing fillable.`;

  const shown = rows.slice(0, 200);
  list.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const c of shown) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cand" + (c.minCross === 0 ? " dead" : "") + (c.dupe ? " dupe" : "");
    const pct = c.minCross < 0 ? 100 : Math.min(100, Math.round((Math.log2(1 + c.minCross) / 10) * 100));
    b.title = c.minCross === 0 ? "Leaves a crossing with no possible words" : c.minCross < 0 ? "No open crossings" : `Tightest crossing keeps ${c.minCross.toLocaleString()} options`;
    b.innerHTML = `<span class="w">${esc(c.word.toUpperCase())}</span><span class="sc">${c.score}</span><span class="meter"><i style="width:${pct}%"></i></span>`;
    b.addEventListener("click", () => placeWord(slot, c.word.toUpperCase()));
    frag.appendChild(b);
  }
  list.appendChild(frag);
}

function placeWord(slot, word) {
  const letters = [...word];
  mutate(() => slot.cells.forEach((i, p) => { project.letters[i] = letters[p]; project.pencil[i] = ""; }));
  $("grid").focus();
}

// ---------- clues ----------
let clueSig = "";
function renderClues() {
  const sv = isSv();
  const sig = (sv ? "sv:" : "am:") + geo.slots.map((s) => s.num + s.dir + s.len + "@" + s.cells[0] + (s.clueCell ?? "")).join("|");
  const cur = currentSlot();
  $("clues-A-h").textContent = sv ? "Answers" : "Across";
  $("clues-D-h").hidden = sv;
  $("clues-D").hidden = sv;
  if (sig !== clueSig) {
    clueSig = sig;
    for (const d of ["A", "D"]) {
      const host = $("clues-" + d);
      host.innerHTML = "";
      const list = sv ? (d === "A" ? geo.slots : []) : geo.slots.filter((x) => x.dir === d);
      for (const s of list) {
        const row = document.createElement("div");
        row.className = "clue-row";
        row.dataset.slot = s.id;
        row.innerHTML = `<span class="num">${sv ? ARROW_GLYPH[s.arrow] : s.num}</span><div><div class="ans"></div><textarea rows="1" placeholder="Write a clue" aria-label="Clue"></textarea></div><div class="chips"></div>`;
        const ta = row.querySelector("textarea");
        ta.addEventListener("focus", () => { if (currentSlot() !== s) selectSlot(s); });
        ta.addEventListener("input", () => setClue(s, ta.value, false));
        ta.addEventListener("change", () => setClue(s, ta.value, true));
        row.addEventListener("click", (e) => { if (e.target === row || e.target.classList.contains("num") || e.target.classList.contains("ans")) selectSlot(s); });
        host.appendChild(row);
      }
    }
  }
  for (const row of document.querySelectorAll(".clue-row")) {
    const s = geo.slots[+row.dataset.slot];
    if (!s) continue;
    row.classList.toggle("on", s === cur);
    row.querySelector(".ans").textContent = slotText(s, "·");
    const ta = row.querySelector("textarea");
    const v = clueOf(s);
    if (document.activeElement !== ta && ta.value !== v) ta.value = v;
    const chips = row.querySelector(".chips");
    const prev = slotComplete(s) ? (clueBank[slotText(s)] || []).filter((x) => x !== v).slice(0, 3) : [];
    const key = prev.join("\u0001");
    if (chips.dataset.key !== key) {
      chips.dataset.key = key;
      chips.innerHTML = "";
      for (const p of prev) {
        const b = document.createElement("button");
        b.className = "chip"; b.type = "button"; b.textContent = p; b.title = "Use a clue you wrote before for this answer";
        b.addEventListener("click", () => setClue(s, p, true));
        chips.appendChild(b);
      }
    }
  }
  if (cur) document.querySelector(`.clue-row[data-slot="${cur.id}"]`)?.scrollIntoView({ block: "nearest" });
}

function setClue(s, text, commit) {
  if (isSv() && s.arrowId) {
    const a = (project.longArrows || []).find((x) => x.id === s.arrowId);
    if (!a) return;
    armClueUndo("la:" + a.id);
    a.text = text;
  } else if (isSv()) {
    const q = (project.sclues[s.clueCell] || [])[s.clueIdx];
    if (!q) return;
    armClueUndo(`${s.clueCell}:${s.clueIdx}`);
    q.text = text;
  } else {
    armClueUndo(clueKey(s));
    if (text) project.clues[clueKey(s)] = text; else delete project.clues[clueKey(s)];
  }
  if (commit) { clueUndoArmed = null; rememberClue(s, text.trim()); }
  saveSoon();
  if (document.activeElement !== $("cur-clue") && currentSlot() === s) $("cur-clue").value = text;
  if (isSv()) render();
  else if (activeTab === "clues" && commit) renderClues();
}

// ---------- stats ----------
function renderStats() {
  const sv = isSv();
  const slots = geo.slots;
  const letterCells = project.blocks.map((_, i) => i).filter(isLetterCell);
  const open = letterCells.length;
  const filled = letterCells.filter((i) => eff(i)).length;
  const words = slots.length;
  const avg = words ? (slots.reduce((n, s) => n + s.len, 0) / words).toFixed(2) : "0";
  const clued = slots.filter((s) => clueOf(s).trim()).length;
  const unchecked = [], orphan = [];
  for (const i of letterCells) {
    const cs = geo.cellSlots[i];
    if (!cs.A && !cs.D) orphan.push(i);
    else if (!cs.A || !cs.D) unchecked.push(i);
  }
  const tiles = sv
    ? [[words, "answers"], [project.blocks.filter((b) => b === 1).length, "clue squares"], [avg, "average length"],
      [`${open ? Math.round((filled / open) * 100) : 0}%`, "squares filled"], [`${clued}/${words}`, "answers clued"], [orphan.length, "squares in no answer"]]
    : [[words, "words"], [project.blocks.length - open, "black squares"], [avg, "average length"],
      [`${open ? Math.round((filled / open) * 100) : 0}%`, "squares filled"], [`${clued}/${words}`, "entries clued"], [unchecked.length, "unchecked squares"]];
  $("stat-tiles").innerHTML = tiles.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");

  const name = (s) => (sv ? `“${(clueOf(s) || "no clue").slice(0, 24)}”` : `${s.num}${s.dir}`);
  const issues = [];
  const seen = new Map();
  for (const s of slots) if (slotComplete(s)) { const w = slotText(s); seen.set(w, [...(seen.get(w) || []), name(s)]); }
  for (const [w, at] of seen) if (at.length > 1) issues.push(["bad", `Duplicate answer ${w} at ${at.join(", ")}`]);
  if (sv) {
    for (const p of geo.problems || []) {
      const q = project.sclues[p.clueCell][p.clueIdx];
      issues.push(["bad", `The arrow of “${(q.text || "empty clue").slice(0, 24)}” points at ${p.len ? "a single letter square" : "no letter squares"}`]);
    }
    const starts = new Map();
    for (const s of slots) { const k = s.cells[0] + s.dir; starts.set(k, (starts.get(k) || 0) + 1); }
    for (const [k, n] of starts) if (n > 1) issues.push(["bad", `${n} clues point at the same answer (row ${Math.floor(parseInt(k, 10) / project.w) + 1})`]);
    for (const [i, list] of Object.entries(project.sclues)) if (project.blocks[i] === 1 && !list.length) issues.push(["warn", `A clue square has no clue (row ${Math.floor(i / project.w) + 1}, column ${(i % project.w) + 1})`]);
    if (orphan.length) issues.push(["warn", `${orphan.length} letter square${orphan.length > 1 ? "s belong" : " belongs"} to no answer`]);
    for (const a of project.longArrows || []) if (a.answer && !arrowAnswerCells(a)) issues.push(["warn", "A long arrow should start an answer, but it doesn't end pointing right or down into 2 or more letter squares"]);
    const unclued = words - clued;
    if (unclued) issues.push(["warn", `${unclued} answer${unclued > 1 ? "s have" : " has"} no clue text yet`]);
  } else {
    for (const s of slots) if (s.len < 3) issues.push(["warn", `${s.num} ${dirName(s.dir)} is only ${s.len} letters`]);
    if (unchecked.length) issues.push(["warn", `${unchecked.length} square${unchecked.length > 1 ? "s are" : " is"} in only one entry`]);
    const asym = project.symmetry !== "None" && project.blocks.some((b, i) => {
      const r = Math.floor(i / project.w), c = i % project.w;
      return partners(r, c).some(([rr, cc]) => project.blocks[idx(rr, cc)] !== b);
    });
    if (asym) issues.push(["warn", "The black squares don't match the chosen symmetry"]);
  }
  if (index) {
    for (const s of fillGeo.slots) {
      if (!slotComplete(s) || index.scores.has(slotText(s).toLowerCase())) continue;
      const where = s.parts > 1 ? `word ${s.part} of ${name(answerOf(s))}` : name(answerOf(s));
      issues.push(["warn", `${slotText(s)} (${where}) isn't in the word lists`]);
    }
  }
  $("stat-issues").innerHTML = issues.length
    ? issues.map(([k, t]) => `<div class="issue" style="color:var(--${k === "bad" ? "bad" : "warn"})">${esc(t)}</div>`).join("")
    : `<div class="issue" style="color:var(--good)">No problems found.</div>`;

  const lens = new Map();
  for (const s of slots) lens.set(s.len, (lens.get(s.len) || 0) + 1);
  const maxL = Math.max(1, ...lens.values());
  $("stat-lengths").innerHTML = [...lens.keys()].sort((a, b) => a - b)
    .map((L) => `<div class="bar"><span>${L}</span><span class="track"><i style="width:${(lens.get(L) / maxL) * 100}%"></i></span><span>${lens.get(L)}</span></div>`).join("");

  const counts = new Array(E.NL).fill(0);
  for (const i of letterCells) { const c = letterCode(eff(i)); if (c >= 0) counts[c]++; }
  const shown = sv ? E.NL : 26;
  $("stat-letters").innerHTML = counts.slice(0, shown).map((n, k) => `<div class="${n ? "" : "zero"}"><b>${E.ALPHA[k].toUpperCase()}</b>${n}</div>`).join("");

  for (const f of ["author", "copyright", "notes"]) {
    const el = $("meta-" + f);
    if (document.activeElement !== el) el.value = project[f] || "";
  }
}

// ---------- projects dialog ----------
function openProject(p) {
  project = p;
  const n = p.w * p.h;
  p.style = p.style || "american";
  for (const k of ["letters", "pencil"]) if (!p[k]) p[k] = new Array(n).fill("");
  for (const k of ["circles", "zones", "breaks"]) if (!p[k]) p[k] = new Array(n).fill(0);
  if (!p.clues) p.clues = {};
  if (!p.sclues) p.sclues = {};
  if (!p.images) p.images = [];
  if (!p.longArrows) p.longArrows = [];
  drawing = null; hoverCell = null; selArrow = null;
  for (const im of p.images) if (im.src && !imgCache.has(im.id)) imgCache.set(im.id, im.src);
  undoStack = []; redoStack = []; clueSig = ""; sqKey = ""; anchor = null; selPic = null;
  recomputeGeo();
  const first = geo.slots[0];
  sel = first ? { r: first.r, c: first.c } : { r: 0, c: 0 };
  dir = first ? first.dir : "A";
  buildGrid();
  setFillStatus("");
  store.set("gw.current", p.id);
  render();
  loadProjectImages();
}

function thumb(p) {
  const cv = document.createElement("canvas");
  cv.width = p.w; cv.height = p.h;
  const ctx = cv.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  const col = (name) => css.getPropertyValue(name);
  for (let i = 0; i < p.w * p.h; i++) {
    const b = p.blocks[i];
    ctx.fillStyle = p.style === "swedish"
      ? (b === 1 || b === 3 ? col("--qbg") : b === 2 ? col("--dead") : p.zones && p.zones[i] ? col("--zone") : col("--cell"))
      : b ? col("--ink") : (p.letters[i] || p.pencil[i]) ? col("--hl") : col("--cell");
    ctx.fillRect(i % p.w, Math.floor(i / p.w), 1, 1);
  }
  ctx.fillStyle = col("--accent");
  for (const im of p.images || []) ctx.fillRect(im.c, im.r, im.w, im.h);
  return cv;
}

function renderProjects() {
  const host = $("proj-list");
  host.innerHTML = "";
  const list = Object.values(projects).sort((a, b) => b.modified - a.modified);
  if (!list.length) host.innerHTML = '<p class="muted">No saved projects yet. Create one above.</p>';
  for (const p of list) {
    const row = document.createElement("div");
    row.className = "proj" + (project && p.id === project.id ? " current" : "");
    const open = p.blocks.filter((b) => !b).length;
    const filled = p.blocks.reduce((n, b, i) => n + (!b && (p.letters[i] || p.pencil[i]) ? 1 : 0), 0);
    row.appendChild(thumb(p));
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `<b></b><span>${p.style === "swedish" ? "Swedish" : "American"} · ${p.w}×${p.h} · ${open ? Math.round((filled / open) * 100) : 0}% filled · edited ${new Date(p.modified).toLocaleDateString()}</span>`;
    meta.querySelector("b").textContent = p.title;
    row.appendChild(meta);
    const acts = document.createElement("div");
    acts.className = "row";
    const mk = (label, cls, fn) => { const b = document.createElement("button"); b.className = "btn small " + cls; b.type = "button"; b.textContent = label; b.addEventListener("click", fn); acts.appendChild(b); return b; };
    mk("Open", "", () => { openProject(p); $("dlg-projects").close(); });
    mk("Duplicate", "", () => {
      const copy = JSON.parse(JSON.stringify(p));
      copy.id = uid(); copy.title = p.title + " copy"; copy.modified = Date.now();
      projects[copy.id] = copy; store.set("gw.projects", projects); renderProjects();
    });
    const del = mk("Delete", "danger", () => {
      if (del.dataset.armed !== "1") { del.dataset.armed = "1"; del.textContent = "Confirm delete"; return; }
      delete projects[p.id];
      store.set("gw.projects", projects);
      if (project && project.id === p.id) {
        const next = Object.values(projects)[0] || sampleProject();
        projects[next.id] = next; store.set("gw.projects", projects);
        openProject(next);
      }
      renderProjects();
      toast(`Deleted “${p.title}”`);
    });
    row.appendChild(acts);
    host.appendChild(row);
  }
  const samples = document.createElement("div");
  samples.className = "row";
  samples.innerHTML = '<span class="muted" style="font-size:12.5px">Examples:</span>';
  for (const [label, make] of [["American sample", sampleProject], ["Swedish sample", swedishSampleProject]]) {
    const b = document.createElement("button");
    b.className = "btn small"; b.type = "button"; b.textContent = "Open " + label.toLowerCase();
    b.addEventListener("click", () => {
      const p = make();
      projects[p.id] = p; store.set("gw.projects", projects);
      openProject(p); $("dlg-projects").close();
    });
    samples.appendChild(b);
  }
  host.appendChild(samples);
}

// ---------- import / export ----------
const slug = () => (project.title || "puzzle").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "puzzle";
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Saved ${name}`);
}

function orderedClues() {
  // Across Lite order: by number, Across before Down.
  return geo.slots.slice().sort((a, b) => a.num - b.num || (a.dir === "A" ? -1 : 1));
}

function requireFull() {
  const missing = project.blocks.findIndex((b, i) => isLetterCell(i) && !eff(i));
  if (missing >= 0) {
    sel = { r: Math.floor(missing / project.w), c: missing % project.w };
    anchor = null;
    render();
    toast("Fill every letter square first. The first empty one is now selected.");
    return false;
  }
  return true;
}

function americanOnly() {
  if (!isSv()) return true;
  toast("The .puz and .ipuz formats can't hold Swedish-style grids. Use Print (choose Save as PDF) or Project backup.", 4200);
  return false;
}

function puzChecksum(bytes, start, len, cksum) {
  for (let i = start; i < start + len; i++) {
    cksum = cksum & 1 ? (cksum >>> 1) | 0x8000 : cksum >>> 1;
    cksum = (cksum + bytes[i]) & 0xffff;
  }
  return cksum;
}

function exportPuz() {
  if (!americanOnly() || !requireFull()) return;
  const { w, h } = project;
  const latin1 = (s) => Array.from(s || "", (ch) => (ch.charCodeAt(0) < 256 ? ch.charCodeAt(0) : 63));
  const sol = [], blank = [];
  for (let i = 0; i < w * h; i++) {
    sol.push(project.blocks[i] ? 46 : latin1(eff(i))[0]);
    blank.push(project.blocks[i] ? 46 : 45);
  }
  const clues = orderedClues().map((s) => latin1(clueOf(s)));
  const title = latin1(project.title), author = latin1(project.author), copyright = latin1(project.copyright), notes = latin1(project.notes);
  const strs = [...title, 0, ...author, 0, ...copyright, 0, ...clues.flatMap((c) => [...c, 0]), ...notes, 0];
  let gext = [];
  if (project.circles.some(Boolean)) {
    const data = project.circles.map((c, i) => (c && !project.blocks[i] ? 0x80 : 0));
    const ck = puzChecksum(data, 0, data.length, 0);
    gext = [..."GEXT"].map((c) => c.charCodeAt(0)).concat([data.length & 255, data.length >> 8, ck & 255, ck >> 8], data, [0]);
  }
  const bytes = new Uint8Array(52 + sol.length * 2 + strs.length + gext.length);
  const put = (off, arr) => bytes.set(arr, off);
  put(2, [..."ACROSS&DOWN"].map((c) => c.charCodeAt(0)).concat([0]));
  put(0x18, [..."1.3"].map((c) => c.charCodeAt(0)).concat([0]));
  bytes[0x2c] = w; bytes[0x2d] = h;
  bytes[0x2e] = clues.length & 255; bytes[0x2f] = clues.length >> 8;
  bytes[0x30] = 1; bytes[0x31] = 0;
  put(52, sol); put(52 + sol.length, blank); put(52 + sol.length * 2, strs);
  if (gext.length) put(52 + sol.length * 2 + strs.length, gext);

  const cib = puzChecksum(bytes, 0x2c, 8, 0);
  const n = w * h;
  const cSol = puzChecksum(bytes, 52, n, 0);
  const cGrid = puzChecksum(bytes, 52 + n, n, 0);
  const stringsSum = (c) => {
    for (const p of [title, author, copyright]) if (p.length) c = puzChecksum([...p, 0], 0, p.length + 1, c);
    for (const cl of clues) c = puzChecksum(cl, 0, cl.length, c);
    if (notes.length) c = puzChecksum([...notes, 0], 0, notes.length + 1, c);
    return c;
  };
  let overall = cib;
  overall = puzChecksum(bytes, 52, n, overall);
  overall = puzChecksum(bytes, 52 + n, n, overall);
  overall = stringsSum(overall);
  const cPart = stringsSum(0);
  bytes[0] = overall & 255; bytes[1] = overall >> 8;
  bytes[0x0e] = cib & 255; bytes[0x0f] = cib >> 8;
  const mask = [..."ICHEATED"].map((c) => c.charCodeAt(0));
  const sums = [cib, cSol, cGrid, cPart];
  for (let k = 0; k < 4; k++) {
    bytes[0x10 + k] = mask[k] ^ (sums[k] & 255);
    bytes[0x14 + k] = mask[k + 4] ^ (sums[k] >> 8);
  }
  download(slug() + ".puz", bytes, "application/x-crossword");
}

function exportIpuz() {
  if (!americanOnly()) return;
  const { w, h } = project;
  const puzzle = [], solution = [];
  for (let r = 0; r < h; r++) {
    const pr = [], sr = [];
    for (let c = 0; c < w; c++) {
      const i = idx(r, c);
      if (project.blocks[i]) { pr.push("#"); sr.push("#"); continue; }
      const num = geo.numbers[i] || 0;
      pr.push(project.circles[i] ? { cell: num, style: { shapebg: "circle" } } : num);
      sr.push(eff(i) || null);
    }
    puzzle.push(pr); solution.push(sr);
  }
  const clues = { Across: [], Down: [] };
  for (const s of geo.slots) clues[dirName(s.dir)].push([s.num, clueOf(s)]);
  const doc = {
    version: "http://ipuz.org/v2", kind: ["http://ipuz.org/crossword#1"],
    title: project.title, author: project.author, copyright: project.copyright, notes: project.notes,
    dimensions: { width: w, height: h }, puzzle, solution, clues, block: "#", empty: 0,
  };
  download(slug() + ".ipuz", JSON.stringify(doc, null, 1), "application/json");
}

function exportCluesTsv() {
  const clean = (t) => t.replace(/[\t\n]/g, " ");
  const lines = isSv() ? ["Clue\tArrow\tRow\tColumn\tAnswer"] : ["Number\tDirection\tAnswer\tClue"];
  if (isSv()) {
    for (const s of geo.slots) {
      const at = s.clueCell ?? s.cells[0];
      lines.push(`${clean(clueOf(s))}\t${s.arrowId ? "long-arrow" : s.arrow}\t${Math.floor(at / project.w) + 1}\t${(at % project.w) + 1}\t${slotText(s, "?")}`);
    }
  } else {
    for (const s of orderedClues()) lines.push(`${s.num}\t${dirName(s.dir)}\t${slotText(s, "?")}\t${clean(clueOf(s))}`);
  }
  download(slug() + "-clues.tsv", lines.join("\n") + "\n", "text/tab-separated-values");
}

function exportGridTsv() {
  const lines = [];
  for (let r = 0; r < project.h; r++) {
    const row = [];
    for (let c = 0; c < project.w; c++) {
      const i = idx(r, c);
      row.push(covered[i] ? "@" : project.blocks[i] === 2 ? "-" : project.blocks[i] ? "#" : eff(i) || "");
    }
    lines.push(row.join("\t"));
  }
  download(slug() + "-grid.tsv", lines.join("\n") + "\n", "text/tab-separated-values");
}

function importCluesTsv(text) {
  let n = 0;
  const rows = text.split(/\r?\n/).map((l) => l.split("\t")).filter((r) => r.length >= 2);
  const byAnswer = (ans) => geo.slots.find((s) => slotText(s) === E.normalize(ans).toUpperCase());
  mutate(() => {
    for (const r of rows) {
      let slot = null, clue = "";
      const num = parseInt(r[0], 10);
      if (isSv() && r.length >= 5) { slot = byAnswer(r[4]); clue = r[0]; }
      else if (!isSv() && Number.isFinite(num) && r.length >= 3) {
        const d = /^d/i.test(r[1]) ? "D" : /^a/i.test(r[1]) ? "A" : null;
        slot = d && geo.slots.find((s) => s.num === num && s.dir === d);
        clue = r.length >= 4 ? r[3] : r[2];
      } else { slot = byAnswer(r[0]); clue = r[1]; }
      if (!slot || !clue || !clue.trim()) continue;
      if (isSv() && slot.arrowId) { const a = project.longArrows.find((x) => x.id === slot.arrowId); if (a) a.text = clue.trim(); }
      else if (isSv()) project.sclues[slot.clueCell][slot.clueIdx].text = clue.trim();
      else project.clues[clueKey(slot)] = clue.trim();
      n++;
    }
  });
  toast(n ? `Imported ${n} clue${n > 1 ? "s" : ""}` : "No clues matched. Use the columns from Clues as spreadsheet, or Answer and Clue.");
}

function exportProjectJson() {
  const imageData = {};
  for (const im of project.images || []) { const src = imgCache.get(im.id) || im.src; if (src) imageData[im.id] = src; }
  download(slug() + ".gridwright.json", JSON.stringify({ ...project, imageData }), "application/json");
}

async function importProjectJson(text) {
  let o;
  try { o = JSON.parse(text); } catch { toast("That file isn't valid JSON."); return; }
  let p;
  if (o.dimensions && o.puzzle) {
    const w = o.dimensions.width, h = o.dimensions.height;
    p = newProject(o.title || "Imported puzzle", w, h, "None");
    Object.assign(p, { author: o.author || "", copyright: o.copyright || "", notes: o.notes || "" });
    const blockCh = o.block || "#";
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c;
      const cell = o.puzzle[r][c];
      const v = cell && typeof cell === "object" ? cell.cell : cell;
      if (v === blockCh || cell === null) p.blocks[i] = 1;
      if (cell && typeof cell === "object" && cell.style && cell.style.shapebg === "circle") p.circles[i] = 1;
      const s = o.solution && o.solution[r] && o.solution[r][c];
      const sv = s && typeof s === "object" ? s.value : s;
      if (!p.blocks[i] && typeof sv === "string" && /^[a-zåäö]$/i.test(sv)) p.letters[i] = sv.toUpperCase();
    }
    const g = E.computeSlots(w, h, p.blocks);
    for (const [dname, d] of [["Across", "A"], ["Down", "D"]]) {
      for (const cl of (o.clues && o.clues[dname]) || []) {
        const num = Array.isArray(cl) ? cl[0] : cl.number;
        const txt = Array.isArray(cl) ? cl[1] : cl.clue;
        const s = g.slots.find((x) => x.num == num && x.dir === d);
        if (s && txt) p.clues[`${s.r},${s.c},${d}`] = txt;
      }
    }
  } else if (o.blocks && o.w && o.h) {
    p = o;
    for (const [id, src] of Object.entries(o.imageData || {})) { imgCache.set(id, src); await idb.set("img:" + id, src); }
    delete p.imageData;
    p.id = uid();
  } else {
    toast("That file isn't a Gridwright project or an ipuz crossword.");
    return;
  }
  p.modified = Date.now();
  projects[p.id] = p;
  store.set("gw.projects", projects);
  openProject(p);
  toast(`Opened “${p.title}”`);
}

function pickFile(accept, cb) {
  const input = $("file-input");
  input.value = "";
  input.accept = accept;
  input.onchange = () => {
    const f = input.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => cb(String(r.result), f.name);
    r.readAsText(f);
  };
  input.click();
}

// ---------- print ----------
function printPuzzle(withSolution) {
  const head = `<h1>${esc(project.title)}</h1><p class="by">${esc(project.author ? "By " + project.author : "")}${project.copyright ? " · " + esc(project.copyright) : ""}</p>`;
  let html;
  if (isSv()) {
    // Swedish puzzles print the grid itself: clues, arrows, pictures and yellow zones included.
    const copy = (blank) => {
      const g = $("grid").cloneNode(true);
      g.removeAttribute("id");
      g.removeAttribute("tabindex");
      g.classList.toggle("blank", blank);
      g.querySelectorAll(".cell").forEach((c) => c.classList.remove("s", "h", "x", "qh", "rg", "bad"));
      g.querySelectorAll(".pic").forEach((c) => c.classList.remove("on"));
      g.querySelectorAll(".la.sel").forEach((c) => c.classList.remove("sel"));
      g.querySelectorAll(".la.draft, .la-dot").forEach((c) => c.remove());
      g.classList.remove("drawing");
      return g.outerHTML;
    };
    // One padded section per printed page (the page itself has no margin, see @page korsord).
    html = `<section class="ppage-sv">${head}${copy(true)}</section>`;
    if (withSolution) html += `<section class="ppage-sv"><h1>${esc(project.title)}: lösning</h1>${copy(false)}</section>`;
  } else {
    const gridHtml = (letters) => {
      let out = `<div class="pgrid" style="grid-template-columns:repeat(${project.w},1fr)">`;
      for (let i = 0; i < project.w * project.h; i++) {
        if (project.blocks[i]) { out += '<div class="b"></div>'; continue; }
        out += `<div class="${project.circles[i] ? "c" : ""}">${geo.numbers[i] ? `<small>${geo.numbers[i]}</small>` : ""}${letters ? `<span>${esc(eff(i))}</span>` : ""}</div>`;
      }
      return out + "</div>";
    };
    const clueCol = (d) => `<section><h3>${dirName(d)}</h3>${geo.slots.filter((s) => s.dir === d).map((s) => `<p><b>${s.num}</b> ${esc(clueOf(s))}</p>`).join("")}</section>`;
    html = head + gridHtml(false) + `<div class="pclues">${clueCol("A")}${clueCol("D")}</div>`;
    if (withSolution) html += `<div class="pbreak"><h1>${esc(project.title)}: solution</h1>${gridHtml(true)}</div>`;
  }
  $("print-area").innerHTML = html;
  window.print();
}

// ---------- image export (PNG) ----------
// Draws the puzzle straight onto a canvas, so the image never depends on print settings.
// Everything is drawn in a 100-units-per-square space, the same one the on-screen arrows use.
const EXPORT_PX = 120;    // pixels per square: a 13-wide grid becomes about 1600 px wide
const EXPORT_MARGIN = 30;

// Turns the arrow markup used on screen (<path>/<polygon>) into canvas paths.
function svgShapes(markup) {
  const out = [];
  markup.replace(/<(path|polygon)([^>]*)\/>/g, (m, tag, attrs) => {
    if (tag === "path") { out.push({ path: new Path2D(attrs.match(/d="([^"]+)"/)[1]), fill: false }); return m; }
    const pts = attrs.match(/points="([^"]+)"/)[1].trim().split(/\s+/).map((p) => p.split(",").map(Number));
    const p2 = new Path2D();
    pts.forEach(([x, y], k) => (k ? p2.lineTo(x, y) : p2.moveTo(x, y)));
    p2.closePath();
    out.push({ path: p2, fill: true });
    return m;
  });
  return out;
}

function drawShapes(ctx, markup, x, y, S, strokeWidth, join = "miter", cap = "square") {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(S / 100, S / 100);
  ctx.fillStyle = "#000"; ctx.strokeStyle = "#000";
  ctx.lineWidth = strokeWidth; ctx.lineJoin = join; ctx.lineCap = cap;
  for (const s of svgShapes(markup)) { if (s.fill) ctx.fill(s.path); else ctx.stroke(s.path); }
  ctx.restore();
}

// Fits clue text into its box the way the screen does: uppercase, line breaks only at spaces,
// after hyphens and where you pressed Enter, shrinking until every line fits.
function drawClueText(ctx, text, x, y, w, h, S) {
  const paras = text.toUpperCase().trim().split(/\n/);
  const maxW = w * 0.9, maxH = h * 0.94;
  const font = (size) => `600 ${size}px "Archivo Narrow", "Arial Narrow", Arial, sans-serif`;
  const wrap = (size) => {
    ctx.font = font(size);
    const lines = [];
    for (const para of paras) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        word.split(/(?<=-)/).forEach((piece, k) => {
          const next = line + (k === 0 && line ? " " : "") + piece;
          if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = piece; }
          else line = next;
        });
      }
      lines.push(line);
    }
    return lines;
  };
  let lo = 0.06 * S, hi = 0.2 * S, best = wrap(lo);
  for (let k = 0; k < 10; k++) {
    const mid = (lo + hi) / 2, lines = wrap(mid);
    const fits = lines.length * mid * 1.04 <= maxH && lines.every((l) => ctx.measureText(l).width <= maxW);
    if (fits) { lo = mid; best = lines; } else hi = mid;
  }
  ctx.font = font(lo);
  ctx.fillStyle = "#000"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const lh = lo * 1.04, top = y + h / 2 - (best.length * lh) / 2 + lh / 2;
  best.forEach((l, k) => ctx.fillText(l, x + w / 2, top + k * lh));
}

// Like the screen's object-fit: cover. Pictures without a built-in size (some SVG drawings)
// are first drawn at the picture's own aspect ratio, then cropped like any photo.
function drawCover(ctx, img, x, y, w, h) {
  let src = img, iw = img.naturalWidth, ih = img.naturalHeight;
  if (!iw || !ih || /^data:image\/svg/.test(img.src)) {
    const vb = /viewBox="[\d.\s-]*?([\d.]+)\s+([\d.]+)"/.exec(decodeURIComponent(img.src));
    iw = vb ? +vb[1] : w; ih = vb ? +vb[2] : h;
    const k = Math.max(w / iw, h / ih) * 2;
    const off = document.createElement("canvas");
    off.width = Math.round(iw * k); off.height = Math.round(ih * k);
    off.getContext("2d").drawImage(img, 0, 0, off.width, off.height);
    src = off; iw = off.width; ih = off.height;
  }
  const r = Math.max(w / iw, h / ih), sw = w / r, sh = h / r;
  ctx.drawImage(src, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}

async function exportImage(withLetters) {
  const S = EXPORT_PX, M = EXPORT_MARGIN, sv = isSv();
  const W = project.w * S, H = project.h * S;
  const cv = document.createElement("canvas");
  cv.width = W + 2 * M; cv.height = H + 2 * M;
  const ctx = cv.getContext("2d");
  toast("Making the image…");
  try {
    await Promise.all(['600 20px "Archivo Narrow"', '600 20px "Libre Franklin"', '500 20px "Libre Franklin"'].map((f) => document.fonts.load(f)));
  } catch { /* falls back to system fonts */ }
  const pics = await Promise.all((project.images || []).map((im) => new Promise((res) => {
    const src = imgCache.get(im.id) || im.src;
    if (!src) return res(null);
    const img = new Image();
    img.onload = () => res({ im, img });
    img.onerror = () => res(null);
    img.src = src;
  })));

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.translate(M, M);
  const X = (i) => colOf(i) * S, Y = (i) => rowOf(i) * S;
  const n = project.w * project.h;

  // squares
  for (let i = 0; i < n; i++) {
    if (covered[i]) continue;
    const b = project.blocks[i];
    ctx.fillStyle = sv ? (b === 2 ? "#c8c8c8" : project.zones[i] ? "#ffe14d" : "#fff") : b ? "#000" : "#fff";
    ctx.fillRect(X(i), Y(i), S, S);
  }
  for (const p of pics) if (p) drawCover(ctx, p.img, p.im.c * S, p.im.r * S, p.im.w * S, p.im.h * S);

  // grid lines (pictures get one frame instead of lines across them)
  ctx.strokeStyle = "#000"; ctx.lineWidth = 2;
  for (let i = 0; i < n; i++) if (!covered[i]) ctx.strokeRect(X(i), Y(i), S, S);
  for (const im of project.images || []) ctx.strokeRect(im.c * S, im.r * S, im.w * S, im.h * S);

  // contents
  for (let i = 0; i < n; i++) {
    if (covered[i]) continue;
    const b = project.blocks[i], x = X(i), y = Y(i);
    if (sv && b === 1) {
      const clues = (project.sclues[i] || []).filter((q) => q.text.trim());
      clues.forEach((q, k) => drawClueText(ctx, q.text, x, y + (k * S) / clues.length, S, S / clues.length, S));
      if (clues.length === 2) { ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y + S / 2); ctx.lineTo(x + S, y + S / 2); ctx.stroke(); }
      continue;
    }
    if (sv && b === 3) {
      const a = ((project.sclues[i] || [])[0] || {}).arrow || "right";
      drawShapes(ctx, THICK_ARROW[a] || "", x + 0.06 * S, y + 0.06 * S, 0.88 * S, 15, "miter", "butt");
      continue;
    }
    if (b) continue;
    if (sv) {
      const marks = [...(geo.arrowsAt.get(i) || [])];
      if (project.breaks[i] & 4) marks.push("tri-r");
      if (project.breaks[i] & 8) marks.push("tri-b");
      for (const m of marks) drawShapes(ctx, CELL_ARROW[m], x, y, S, 5);
      ctx.fillStyle = "#000";
      if (project.breaks[i] & 1) ctx.fillRect(x + S - 0.045 * S, y, 0.09 * S, S);
      if (project.breaks[i] & 2) ctx.fillRect(x, y + S - 0.045 * S, S, 0.09 * S);
    } else {
      if (geo.numbers[i]) {
        ctx.fillStyle = "#000"; ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.font = `500 ${Math.round(0.27 * S)}px "Libre Franklin", Arial, sans-serif`;
        ctx.fillText(String(geo.numbers[i]), x + 0.04 * S, y + 0.03 * S);
      }
      if (project.circles[i]) { ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x + S / 2, y + S / 2, S * 0.46, 0, Math.PI * 2); ctx.stroke(); }
    }
    if (withLetters && eff(i)) {
      ctx.fillStyle = "#000"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = `600 ${Math.round(0.6 * S)}px "Libre Franklin", Arial, sans-serif`;
      ctx.fillText(eff(i), x + S / 2, y + 0.58 * S);
    }
  }

  // long arrows on top
  for (const a of project.longArrows || []) {
    if (!a.cells || a.cells.length < 2) continue;
    const { d, head, stroke } = longArrowShape(a.cells, a.thick);
    const pts = head.map((p) => p.join(",")).join(" ");
    drawShapes(ctx, `<path d="${d}"/><polygon class="head" points="${pts}"/>`, 0, 0, 100, stroke, "miter", "butt");
  }

  // outer frame
  ctx.lineWidth = 6;
  ctx.strokeRect(0, 0, W, H);

  const name = `${slug()}${withLetters ? (sv ? "-losning" : "-solution") : ""}.png`;
  cv.toBlob((blob) => {
    if (!blob) { toast("The image couldn't be made. Try again, or use Print instead."); return; }
    download(name, blob, "image/png");
  }, "image/png");
}

// ---------- wiring ----------
function setTab(name) {
  activeTab = name;
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const t of ["fill", "clues", "stats", "words"]) $("tab-" + t).hidden = t !== name;
  store.set("gw.tab", name);
  if (name === "words") renderCustom();
  render();
}

function renderCustom() {
  const host = $("qa-list");
  host.innerHTML = "";
  if (!custom.length) { host.innerHTML = '<span class="muted">No added words yet.</span>'; return; }
  for (const [w, s] of custom.slice().reverse()) {
    const row = document.createElement("div");
    row.className = "row";
    row.style.justifyContent = "space-between";
    row.innerHTML = `<span>${esc(w.toUpperCase())} <span class="muted">${s}</span></span>`;
    const b = document.createElement("button");
    b.className = "btn small"; b.type = "button"; b.textContent = "Remove";
    b.addEventListener("click", () => { custom = custom.filter((x) => x[0] !== w); store.set("gw.custom", custom); renderCustom(); rebuildIndex(); });
    row.appendChild(b);
    host.appendChild(row);
  }
}

function addCustomWord() {
  const w = E.normalize($("qa-word").value);
  const s = parseInt($("qa-score").value, 10);
  if (w.length < 2) { toast("Enter a word of at least two letters."); return; }
  custom = custom.filter((x) => x[0] !== w).concat([[w, Number.isFinite(s) ? s : 50]]);
  store.set("gw.custom", custom);
  $("qa-word").value = "";
  renderCustom();
  rebuildIndex();
  toast(`Added ${w.toUpperCase()}`);
}

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}

function wire() {
  const grid = $("grid");
  grid.addEventListener("keydown", onGridKey);
  let dragFrom = null;
  const cellAt = (e) => {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const cell = t && t.closest && t.closest(".cell");
    return cell && grid.contains(cell) ? +cell.dataset.i : null;
  };
  grid.addEventListener("mousedown", (e) => {
    if (drawing) {
      e.preventDefault();
      const i = cellFromPoint(e);
      if (i != null && drawing.cells[drawing.cells.length - 1] !== i) drawing.cells.push(i);
      if (e.detail >= 2) finishArrow();
      grid.focus();
      render();
      return;
    }
    const la = e.target.closest(".la");
    if (la && la.dataset.arrow) {
      e.preventDefault();
      selArrow = la.dataset.arrow; selPic = null; anchor = null;
      grid.focus();
      render();
      return;
    }
    selArrow = null;
    const pic = e.target.closest(".pic");
    if (pic) {
      e.preventDefault();
      const im = project.images.find((x) => x.id === pic.dataset.pic);
      selPic = im ? im.id : null;
      anchor = null;
      if (im) sel = { r: im.r, c: im.c };
      grid.focus();
      render();
      return;
    }
    const cell = e.target.closest(".cell");
    if (!cell) return;
    e.preventDefault();
    selPic = null;
    const i = +cell.dataset.i;
    const r = Math.floor(i / project.w), c = i % project.w;
    if (e.shiftKey) {
      if (!anchor) anchor = { ...sel };
      sel = { r, c };
    } else if (r === sel.r && c === sel.c && !anchor) {
      dir = dir === "A" ? "D" : "A";
    } else {
      anchor = null;
      sel = { r, c };
      const cs = geo.cellSlots[i];
      if (cs && !cs[dir] && cs[dir === "A" ? "D" : "A"]) dir = dir === "A" ? "D" : "A";
      dragFrom = { r, c };
    }
    grid.focus();
    render();
  });
  window.addEventListener("mousemove", (e) => {
    if (drawing) {
      const i = grid.contains(e.target) ? cellFromPoint(e) : null;
      if (i !== hoverCell) { hoverCell = i; renderLongArrows(); }
      return;
    }
    if (!dragFrom || !(e.buttons & 1)) { dragFrom = null; return; }
    const i = cellAt(e);
    if (i == null) return;
    const r = Math.floor(i / project.w), c = i % project.w;
    if (r === sel.r && c === sel.c) return;
    anchor = { ...dragFrom };
    sel = { r, c };
    render();
  });
  window.addEventListener("mouseup", () => { dragFrom = null; });
  if (window.ResizeObserver) {
    let lastW = 0;
    new ResizeObserver(() => {
      const wpx = grid.clientWidth;
      if (Math.abs(wpx - lastW) < 40) return;
      lastW = wpx;
      cellEls.forEach((ce, i) => { if (ce.qKey) toFit.add(i); });
      fitClues();
    }).observe(grid);
  }

  $("btn-block").addEventListener("click", () => { toggleBlock(sel.r, sel.c); grid.focus(); });
  $("btn-circle").addEventListener("click", () => { toggleCircle(sel.r, sel.c); grid.focus(); });
  $("btn-clue-sq").addEventListener("click", () => { setKind(1); focusSquareClue(0); });
  $("btn-dead-sq").addEventListener("click", () => { setKind(2); grid.focus(); });
  $("btn-letter-sq").addEventListener("click", () => { setKind(0); grid.focus(); });
  $("btn-zone").addEventListener("click", () => { toggleZone(); grid.focus(); });
  $("btn-break").addEventListener("click", () => { toggleBreak(); grid.focus(); });
  $("btn-tri").addEventListener("click", () => { toggleTriangle(); grid.focus(); });
  $("btn-arrow").addEventListener("click", () => { if (drawing) finishArrow(); else startArrow(); grid.focus(); });
  $("btn-thick").addEventListener("click", () => {
    if (project.blocks[idx(sel.r, sel.c)] === 3) { setKind(0); grid.focus(); return; }
    setKind(3);
    focusSquareClue(0);
  });
  $("btn-pic").addEventListener("click", addPicture);
  $("btn-pic-del").addEventListener("click", () => { removePicture(); grid.focus(); });
  $("btn-undo").addEventListener("click", undo);
  $("btn-redo").addEventListener("click", redo);
  $("symmetry").addEventListener("change", (e) => { project.symmetry = e.target.value; saveSoon(); render(); });
  $("title").addEventListener("input", (e) => { project.title = e.target.value || "Untitled puzzle"; saveSoon(); });

  $("cur-clue").addEventListener("input", (e) => { const s = currentSlot(); if (s) setClue(s, e.target.value, false); });
  $("cur-clue").addEventListener("change", (e) => { const s = currentSlot(); if (s) setClue(s, e.target.value, true); });
  $("cur-clue").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const s = currentSlot(); if (s) setClue(s, e.target.value, true); nextSlot(1); $("cur-clue").focus(); } });

  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => setTab(b.dataset.tab));

  $("btn-autofill").addEventListener("click", startFill);
  $("btn-accept").addEventListener("click", () => mutate(() => project.pencil.forEach((p, i) => { if (p) { project.letters[i] = p; project.pencil[i] = ""; } })));
  $("btn-clear-pencil").addEventListener("click", () => mutate(() => project.pencil.fill("")));
  $("min-score").addEventListener("change", () => {
    store.set("gw.minScore", minScore());
    if (index) index.setMinScore(minScore());
    if (worker) worker.postMessage({ type: "minScore", minScore: minScore() });
    render();
  });
  $("time-limit").addEventListener("change", () => store.set("gw.timeLimit", $("time-limit").value));
  $("cand-filter").addEventListener("input", renderFillSoon);
  $("cand-sort").addEventListener("change", renderFill);

  for (const f of ["author", "copyright", "notes"]) $("meta-" + f).addEventListener("input", (e) => { project[f] = e.target.value; saveSoon(); });

  $("btn-load-wl").addEventListener("click", () => pickFile(".dict,.txt,.tsv,.csv,text/plain", addWordListFile));
  $("btn-qa").addEventListener("click", addCustomWord);
  $("qa-word").addEventListener("keydown", (e) => { if (e.key === "Enter") addCustomWord(); });

  $("btn-projects").addEventListener("click", () => { renderProjects(); $("dlg-projects").showModal(); });
  $("dlg-close").addEventListener("click", () => $("dlg-projects").close());
  $("new-style").addEventListener("change", (e) => {
    const sv = e.target.value === "swedish";
    $("new-w").value = sv ? 13 : 15;
    $("new-h").value = sv ? 17 : 15;
  });
  $("new-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const w = Math.max(3, Math.min(25, parseInt($("new-w").value, 10) || 15));
    const h = Math.max(3, Math.min(25, parseInt($("new-h").value, 10) || 15));
    const p = newProject($("new-title").value.trim(), w, h, "rotational", $("new-style").value);
    projects[p.id] = p;
    store.set("gw.projects", projects);
    $("new-title").value = "";
    openProject(p);
    $("dlg-projects").close();
    $("grid").focus();
  });

  const actions = {
    "export-png": () => exportImage(false), "export-png-solution": () => exportImage(true),
    "export-puz": exportPuz, "export-ipuz": exportIpuz, "export-clues-tsv": exportCluesTsv, "export-grid-tsv": exportGridTsv,
    "export-json": exportProjectJson,
    "import-clues-tsv": () => pickFile(".tsv,.txt,text/tab-separated-values", importCluesTsv),
    "import-json": () => pickFile(".json,.ipuz,application/json", importProjectJson),
    "print-blank": () => printPuzzle(false), "print-solution": () => printPuzzle(true),
  };
  for (const b of document.querySelectorAll("[data-act]")) {
    b.addEventListener("click", () => { b.closest("details").open = false; actions[b.dataset.act](); });
  }
  document.addEventListener("click", (e) => {
    for (const d of document.querySelectorAll("details.menu[open]")) if (!d.contains(e.target)) d.open = false;
  });

  $("btn-theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    applyTheme(next);
    store.set("gw.theme", next);
    picSig = "";
  });

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === "o") { e.preventDefault(); renderProjects(); $("dlg-projects").showModal(); }
    else if (k === "p") { e.preventDefault(); printPuzzle(false); }
    else if (k === "s") { e.preventDefault(); saveSoon(); toast("Saved in this browser"); }
  });
}

// ---------- boot ----------
(function boot() {
  applyTheme(store.get("gw.theme", null));
  $("min-score").value = store.get("gw.minScore", 50);
  $("time-limit").value = store.get("gw.timeLimit", 30);
  wire();
  let cur = projects[store.get("gw.current", "")];
  if (!cur) {
    cur = Object.values(projects).sort((a, b) => b.modified - a.modified)[0];
    if (!cur) {
      const am = sampleProject(), sv = swedishSampleProject();
      sv.modified = am.modified + 1;
      projects[am.id] = am; projects[sv.id] = sv;
      store.set("gw.projects", projects);
      cur = sv;
    }
  }
  openProject(cur);
  setTab(store.get("gw.tab", "fill"));
  loadWordList();
})();
