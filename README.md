# Gridwright

A crossword construction app modeled on **Ingrid 0.7.5** ("Your crossword pal™"), built from a static analysis of the installed app with [REA: Reverse Engineer Anything](https://github.com/morluto/rea).

**Open the app: https://ot-mo.github.io/KorsordSve/**

## Run it

The link above runs the latest version straight from GitHub Pages. Every push to `main` republishes the `app/` folder through `.github/workflows/pages.yml`. Projects, your added words and a loaded word list are saved in the browser you use.

To run it from your own computer instead:

```bash
git clone https://github.com/ot-mo/KorsordSve.git
```

Then open `app/index.html` in Chrome or Edge.

If autofill feels slow when the page is opened straight from disk, serve it from the `KorsordSve` folder instead:

```bash
npx -y http-server@14.1.1 app -p 5178 -c-1
```

Then open http://localhost:5178.

**Word list:** every project uses **bara_ord** by default: your list from `Downloads\saldo_2.3\saldo_2.3\bara_ord.txt` (SALDO 2.3 from Språkbanken, CC BY 3.0), built into `app/words-bara-ord.js` as 123,393 words. Entries with digits were left out, multi-word and hyphenated entries are joined, and accents are folded (André → ANDRE). Scores come from SALDO's part-of-speech tags: ordinary words 60, names (`pm`, `pmm`) 55, abbreviations (`nna`, `pma`, `aba`, `ava`, `ppa`, `kna`, `vba`) 50. A word that is also an ordinary word, like rosa/Rosa, keeps 60. With the default minimum score of 50 every word can be used, but autofill prefers ordinary words. Raise the minimum to 51 to leave out abbreviations, or to 56 to leave out names too. In the Word list tab you can tick any combination of bara_ord, the Swedish frequency list, the English list and files you load yourself. Ticked lists work together as one; a word found in several lists keeps its highest score.

**Ingrid's list:** for scored English fill, use **Load another file…** in the Word list tab and pick the Spread the Wordlist file that ships with Ingrid:
`%LOCALAPPDATA%\Ingrid\app-0.7.5\resources\app.asar.unpacked\.vite\build\spreadthewordlist.dict`

## Swedish crosswords (korsord)

Choose **Swedish crossword** under Projects → New project, or open the Swedish sample ("Min bästa vän").

- **Clue squares** (`.` or the toolbar): the clue text is drawn inside the square and shrinks to fit. A square can hold two clues, split by a line. Press Enter in a clue for a new line, and type `-` to split a long word.
- **Arrows:** six directions per clue: right, down, down then right, right then down, up then right, left then down. The answer runs from the arrow until the next clue square, picture, edge or word-end bar.
- **Grey squares** (`#`) for empty filler squares, and **word-end bars** (`-`) to end an answer between two letter squares.
- **Thick arrows:** the **Thick arrow** button turns a square into a big arrow that starts an answer, for example pointing from a picture caption into the yellow answer. Its clue is kept with the answer but not printed in the grid.
- **Long arrows:** click **Long arrow**, then the squares the arrow passes through, ending on the square it points into. Right-angle bends are added for you, so an arrow can wind from a picture to its answer in any direction. Backspace removes the last point, Enter or a double-click finishes, Esc cancels. Click an arrow to make it thin or thick, point it the other way, or remove it. When it ends pointing right or down into letter squares it can also start an answer, with its clue kept on the arrow.
- **Clear a square** with Space: it removes everything on the square (or a selected area): letter, clue, grey or thick arrow square, yellow, bars, triangles, and any picture or long arrow on it. Delete only erases the letter, and Ctrl+Z undoes either.
- **Sentence triangles** (`>` or **Triangle ▸**): a small triangle on the edge after a square marks the end of one word in a multi-word answer. The answer goes on, but fill suggestions and autofill treat each word separately, and each word (2+ letters) must be in the word lists.
- **Pictures:** drag across squares (or Shift+click), then **Picture…** to place an image over that area.
- **Yellow zones:** select squares and press **Yellow**, for example for the solution word.
- Fill suggestions and autofill work on the arrow-defined answers with Å, Ä and Ö.
- **Print** prints the grid as drawn, with clues, arrows, pictures and yellow zones, plus an optional solution page. Choose "Save as PDF" in the print dialog to get a file. .puz and .ipuz can't hold this layout, so they stay American-only.

## What REA found in Ingrid

REA's `analyze-javascript-application` was run on a copy of `app.asar`. It parsed 1,452 JavaScript files, and a few supporting files were read directly from the archive.

| Area | Evidence | Gridwright equivalent |
|---|---|---|
| Electron app, Vite build, 7 windows: home, main editor, word browser, preferences, fonts, print, about | REA graph: 7 `browser-window` nodes, 8 renderers, 1 shared preload | One page: editor, Projects dialog, Word list tab, print layout |
| Fill engine runs off the UI thread (`fillEngineWorker.js`, native Rust addon `gridlock_ext`) | IPC channels `get-fill-engine-port`, `get-word-list-engine-worker-port` | `engine.js` running in a Web Worker |
| Project storage in SQLite (`better-sqlite3`, `repositoryWorker.js`, `default.sqlite3`) | REA: 2 `storage` nodes, native addons | Browser localStorage / IndexedDB |
| Word list format `word;score` (Spread the Wordlist, 315,905 entries) | `spreadthewordlist.dict` contents | Same parser, so Ingrid's file loads directly |
| Symmetry: Rotational (default), Left-Right, Top-Bottom, Diagonal NW-SE, Diagonal NE-SW, None; diagonals only for square grids | Renderer enum `{rotational, leftRight, topBottom, NWSE, SWNE, None}` | Same six options and rules |
| Keyboard: arrows, Tab / Shift+Tab between entries, Space / Delete erase forward, Escape, period toggles black squares, circles | Editor `keydown` handler, "toggle black squares" tip, `circle` action | Same bindings, plus `*` for circles |
| Fill panel: suggestions sorted by word score, letter score, recommended; "Fillable / Unfillable"; minimum word score; fill time limit; pencil letters | UI strings "Sort by Recommended", "Required word score:", "Fill time limit (seconds):", "Unfillable", "Pencil" | Suggestions with crossing-room meter, autofill into pencil, ink or erase pencil |
| Clues, duplicates, word lengths, letter counts | UI strings "Write a clue", "Duplicates", "Word Lengths", "Letter Counts" | Clues tab (with memory of earlier clues per answer), Stats tab |
| Quick add word | IPC `quick-add-word`, `can-quick-add-word` | Word list tab: Quick add |
| Export: PUZ, ipuz, JPZ, CrossFire, PDF, NYT submission PDF, clues/grid as TSV; import clues TSV | File menu labels | .puz (checksums verified with puzpy), .ipuz, clues TSV, grid TSV, JSON backup; import clues TSV and .ipuz; print with or without solution |

Not reproduced: JPZ and CrossFire export, the NYT submission PDF, cloud sync, the word browser window and font management.

No Ingrid code or assets were copied. Gridwright is an independent implementation of the behavior above.

## Files

- `app/index.html`: layout and styles (light and dark themes, print layout)
- `app/app.js`: editor, panels, projects, import/export
- `app/engine.js`: word-list bitset index, slot numbering, fill suggestions, autofill search
- `app/words.js`: English starter list from [sindresorhus/word-list](https://github.com/sindresorhus/word-list) (MIT)
- `app/words-bara-ord.js`: your bara_ord list, from SALDO 2.3 (Språkbanken, CC BY 3.0)
- `app/words-sv.js`: Swedish frequency list from [hermitdave/FrequencyWords](https://github.com/hermitdave/FrequencyWords) sv_50k (CC BY-SA 4.0)

Licenses and attribution for the bundled word lists are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
