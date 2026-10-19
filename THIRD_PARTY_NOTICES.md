# Third-party notices

Gridwright bundles three word lists. Each keeps its own license.

## app/words-bara-ord.js: SALDO 2.3

Word forms from **SALDO 2.3** (Svenskt associationslexikon), Språkbanken Text, University of Gothenburg.
https://spraakbanken.gu.se/en/resources/saldo

Licensed under Creative Commons Attribution 3.0 Unported (CC BY 3.0): https://creativecommons.org/licenses/by/3.0/

Changes: entries containing digits were removed; the rest were lowercased, spaces and hyphens removed, and accents other than å, ä and ö folded (é → e). Each word was given a crossword score from its SALDO part-of-speech tag (ordinary words 60, names 55, abbreviations 50).

## app/words-sv.js: FrequencyWords (Swedish)

Derived from `sv_50k.txt` in **FrequencyWords** by Hermit Dave, built from OpenSubtitles 2018.
https://github.com/hermitdave/FrequencyWords

Content licensed under Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0): https://creativecommons.org/licenses/by-sa/4.0/

Changes: entries limited to 2–15 letters from a–z, å, ä, ö; scores from 30 to 60 assigned from frequency rank. This derived file is distributed under CC BY-SA 4.0.

## app/words.js: word-list

From **word-list** v4.1.0 by Sindre Sorhus: https://github.com/sindresorhus/word-list
Changes: limited to words of 3–15 letters.

```
MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Fonts

Libre Franklin, Archivo Narrow and IBM Plex Mono are loaded from Google Fonts when the page opens (SIL Open Font License 1.1). They are not included in this repository.
