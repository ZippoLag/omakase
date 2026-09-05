# License & attribution

**omakase** is built by [Sebastián R. Vansteenkiste](https://github.com/zippolag)
via [DeepSeek V4 Flash](https://www.deepseek.com/) @
[FREEBUFF](https://freebuff.com/get-started?ref=ref-48e765cb-2146-4cf9-8fba-2a2af1676e77&referrer=Sebasti%C3%A1n+Vansteenkiste) (affiliate link).

It is an independent, from-scratch reimplementation inspired by
[tangorin.com](https://tangorin.com/) — the free online Japanese–English
dictionary initially developed by Gregory Bober and now developed and owned by
Archie Preston. Tangorin itself is built almost entirely on the same open EDRDG
projects listed below and has no public API; its data sources and licenses are
published on its [About page](https://tangorin.com/about). **No Tangorin code,
data, or trademarks are included in omakase** — all dictionary content is
sourced directly from the upstream open projects. The research behind that
decision (sources, licenses, offline alternatives) is documented in
[`tangorin_sources.md`](tangorin_sources.md), and the per-component copyright
and license texts of every third-party source and library are collected in
[`NOTICE.md`](NOTICE.md).

## Project code — MIT

Copyright © 2026 Sebastián R. Vansteenkiste

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Dictionary data — share-alike terms apply

The offline database (`dist/kanji.db`) is derived from the open data sources
below. The MIT licence above covers the **code** only; the **data** keeps the
licences of its sources, so any redistribution of the database itself must
comply with the share-alike terms of those sources (CC BY-SA 4.0 for
EDRDG-derived content, CC BY-SA 3.0 for KanjiVG diagrams) and carry the same
attributions.

### EDRDG files — JMdict, KANJIDIC2, kradfile-u, radkfile

- Copyright © James William Breen and The Electronic Dictionary Research and
  Development Group (EDRDG). The kradfile-u revisions are further © Jim Rose
  (KanjiCafe.com).
- Licensed under CC BY-SA 4.0 — <https://creativecommons.org/licenses/by-sa/4.0/>
- Full licence statement: <https://www.edrdg.org/edrdg/licence.html>

**Attribution (required by the EDRDG licence):** omakase acknowledges that it
uses the JMdict, KANJIDIC2, kradfile-u and radkfile files and incorporates data
from them. This file (distributed with the software), the README, the
`omakase --help` credits, the `omakase --license` text (a byte-for-byte copy
embedded in the CLI, see `src/licenses.ts`), and the web app footer each state
the usage and source of the files and link to the licence locations above. See
also
<https://www.edrdg.org/wiki/index.php/JMdict-EDICT_Dictionary_Project> and
<https://www.edrdg.org/wiki/index.php/KANJIDIC_Project>.

**Disclaimer (from the EDRDG licence):** *While every effort has been made to
ensure the accuracy of the information in the files, it is possible that errors
may still be included. The files are made available without any warranty
whatsoever as to their accuracy or suitability for a particular application.
Any individual or organization making use of the files must agree to assume all
liability for the use or misuse of the files, and must agree not to hold the
Group liable for any actions or events resulting from use of the files.*

### KanjiVG — stroke-order diagrams

- © Ulrich Apel, released under CC BY-SA 3.0 —
  <https://creativecommons.org/licenses/by-sa/3.0/>
- Source: <https://kanjivg.tagaini.net/>

### JmdictFurigana — ruby segmentation

- © Doublevil, MIT licence (<https://github.com/Doublevil/JmdictFurigana>);
  the underlying data derives from JMdict, CC BY-SA 4.0.

### jmdict-simplified — JSON conversion of the EDRDG files

- © scriptin (<https://github.com/scriptin/jmdict-simplified>); the NPM
  packages are MIT-licensed, the converted data keeps the EDRDG CC BY-SA 4.0
  terms.

### Tatoeba — example sentences

- © Tatoeba contributors, CC BY 2.0 FR (some sentences CC0) —
  <https://tatoeba.org/>, <https://creativecommons.org/licenses/by/2.0/fr/>

## Software libraries

| Library | Use | License |
|---|---|---|
| [better-sqlite3](https://www.npmjs.com/package/better-sqlite3) | Native SQLite engine for the CLI | MIT |
| [@sqlite.org/sqlite-wasm](https://sqlite.org/wasm) | In-browser SQLite engine for the web app | Apache-2.0 (SQLite itself: public domain) |
| [TypeScript](https://www.typescriptlang.org/) | Dev: typechecking / compilation | Apache-2.0 |
| [tsx](https://tsx.is/) | Dev: running TypeScript | MIT |
| [puppeteer-core](https://pptr.dev/) | Dev: headless-Chrome web verification | Apache-2.0 |
| [@types/node](https://www.npmjs.com/package/@types/node), [@types/better-sqlite3](https://www.npmjs.com/package/@types/better-sqlite3) | Dev: type declarations | MIT |

## Disclaimers

- Dictionary content may contain errors; it is provided without any warranty of
  accuracy or fitness for a particular purpose (see the EDRDG disclaimer above).
- omakase is **not affiliated with, endorsed by, or connected to** Tangorin,
  EDRDG, Tatoeba, Ulrich Apel, or any other source or contributor.
- Stroke-order diagrams come from the bundled KanjiVG set (CC BY-SA 3.0,
  © Ulrich Apel); only the diagrams you actually view are fetched by the web
  app and cached locally.
- The app runs 100% offline — no queries, lookups, or personal data ever leave
  the device.
