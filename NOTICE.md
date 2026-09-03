# NOTICE

**omakase** is built **by [Sebastián R. Vansteenkiste](https://github.com/zippolag)
via [DeepSeek V4 Flash](https://www.deepseek.com/) @
[FREEBUFF](https://freebuff.com)**.

This NOTICE lists every third-party data source and software library the
project incorporates, together with its copyright and license. It is an
independent, from-scratch project: no code or data is copied from
[tangorin.com](https://tangorin.com/) (the site that inspired it) — all
dictionary content comes from the upstream open projects below.

License texts: the **MIT** and **Apache-2.0** texts are reproduced in full in
section 3. The **Creative Commons** licenses are quoted as their official
human-readable deeds; the full legal codes are authoritative at the linked
canonical URLs and are not reproduced here because they are long legal
documents. See also [`LICENSE.md`](LICENSE.md) for the project's own license,
the EDRDG attribution conditions and disclaimer, and general disclaimers.

---

## 1. Bundled data sources

The offline database (`dist/kanji.db`) and the stroke diagrams under
`dist/strokes/` are built from the following sources (release pins live in
`data/build/config.ts`). The data keeps the licenses of its sources, so any
redistribution of the database itself must comply with the share-alike terms
below.

### 1.1 JMdict, KANJIDIC2, kradfile-u, radkfile — EDRDG

- **Copyright:** James William Breen and The Electronic Dictionary Research and
  Development Group (EDRDG). The kradfile-u/radkfile2 revisions are © Jim Rose
  (KanjiCafe.com).
- **License:** Creative Commons Attribution-ShareAlike 4.0 International
  (CC BY-SA 4.0).
- **Source:** <https://www.edrdg.org/jmdict/edict_doc.html>,
  <https://www.edrdg.org/kanjidic/kanjd2index.html>,
  <https://www.edrdg.org/krad/kradinf.html> — full licence statement:
  <https://www.edrdg.org/edrdg/licence.html>.
- **Deed summary (CC BY-SA 4.0):** *You are free to Share — copy and
  redistribute the material in any medium or format for any purpose, even
  commercially; and Adapt — remix, transform, and build upon the material for
  any purpose, even commercially. Under the following terms: Attribution — you
  must give appropriate credit, provide a link to the license, and indicate if
  changes were made; ShareAlike — if you remix, transform, or build upon the
  material, you must distribute your contributions under the same license as
  the original; No additional restrictions — you may not apply legal terms or
  technological measures that legally restrict others from doing anything the
  license permits.* Full legal code:
  <https://creativecommons.org/licenses/by-sa/4.0/legalcode>.
- **Attribution (required by the EDRDG licence):** omakase acknowledges that it
  uses these files and incorporates data from them; this NOTICE, `LICENSE.md`,
  the README, the `omakase --help` credits, and the web app footer all state
  the usage and source of the files and link to the licence locations.
- **Disclaimer (from the EDRDG licence):** the files are made available without
  any warranty whatsoever as to their accuracy or suitability for a particular
  application; users assume all liability for the use or misuse of the files.

### 1.2 jmdict-simplified — JSON conversion of the EDRDG files

- **Copyright:** scriptin (<https://github.com/scriptin/jmdict-simplified>).
- **License:** the JSON data assets this project consumes are derived from the
  EDRDG files and are distributed under the same license (CC BY-SA 4.0, EDRDG
  terms); the conversion scripts are CC BY-SA 4.0; the NPM packages
  `@scriptin/*` are MIT (this project does not use the packages).
- **Pinned release:** `3.6.2+20260824122934`.

### 1.3 KanjiVG — stroke-order diagrams

- **Copyright:** © Ulrich Apel.
- **License:** Creative Commons Attribution-ShareAlike 3.0 (CC BY-SA 3.0).
- **Source:** <https://kanjivg.tagaini.net/> — pinned release `r20260714`.
- **Deed summary (CC BY-SA 3.0):** *You are free to Share — to copy, distribute
  and transmit the work; and to Remix — to adapt the work. Under the following
  terms: Attribution — you must attribute the work in the manner specified by
  the author or licensor; ShareAlike — if you alter, transform, or build upon
  this work, you may distribute the resulting work only under the same or a
  similar license; and you may not apply legal terms or technological measures
  that legally restrict others from doing anything the license permits.* Full
  legal code: <https://creativecommons.org/licenses/by-sa/3.0/legalcode>.

### 1.4 JmdictFurigana — ruby segmentation

- **Copyright:** © 2025 Doublevil (<https://github.com/Doublevil/JmdictFurigana>).
- **License:** source code is MIT (full text in section 3.1); the furigana data
  archive is derived from JMdict and is distributed under the same EDRDG terms
  (CC BY-SA 4.0).
- **Pinned release:** `2.3.1+2026-08-25`.

### 1.5 Tatoeba — example sentences

- **Copyright:** © Tatoeba contributors.
- **License:** Creative Commons Attribution 2.0 France (CC BY 2.0 FR); some
  sentences are dedicated to the public domain (CC0).
- **Source:** <https://tatoeba.org/>,
  <https://creativecommons.org/licenses/by/2.0/fr/legalcode>.
- **Deed summary (CC BY 2.0 FR):** *You are free to Share and Adapt, even
  commercially. Under the following terms: Attribution — you must give credit
  to the licensor in the manner specified by the author or licensor; and you
  may not apply legal terms or technological measures that legally restrict
  others from doing anything the license permits.*

---

## 2. Bundled software libraries

Versions are the ones pinned in `package.json` (verified from the installed
packages).

| Library | Version | Copyright | License | Used for |
|---|---|---|---|---|
| [better-sqlite3](https://www.npmjs.com/package/better-sqlite3) | 11.10.0 | © 2017 Joshua Wise | MIT | CLI SQLite engine |
| [@sqlite.org/sqlite-wasm](https://sqlite.org/wasm) | 3.53.0-build1 | SQLite itself is public domain; JS/WASM wrapper © The SQLite Authors (based on <https://sqlite.org/wasm>) | Apache-2.0 wrapper (SQLite: public domain; Emscripten runtime: MIT / NCSA) | Web app in-browser SQLite engine |
| [TypeScript](https://www.typescriptlang.org/) | 5.9.3 | © Microsoft Corporation | Apache-2.0 | Dev: typechecking / compilation |
| [tsx](https://tsx.is/) | 4.23.12 | © Hiroki Osame | MIT | Dev: running TypeScript |
| [puppeteer-core](https://pptr.dev/) | 25.9.0 | © Google | Apache-2.0 | Dev: headless-Chrome web verification |
| [@types/node](https://www.npmjs.com/package/@types/node) | 22.20.1 | © Microsoft Corporation | MIT | Dev: type declarations |
| [@types/better-sqlite3](https://www.npmjs.com/package/@types/better-sqlite3) | 7.6.13 | © Microsoft Corporation | MIT | Dev: type declarations |

SQLite is in the public domain; its dedication is published at
<https://sqlite.org/copyright.html>.

---

## 3. License texts

### 3.1 The MIT License

The MIT License text below applies to the MIT-licensed components in this
NOTICE: **better-sqlite3** (© 2017 Joshua Wise), **tsx** (© Hiroki Osame),
**JmdictFurigana** (© 2025 Doublevil), **@types/node** and
**@types/better-sqlite3** (© Microsoft Corporation), and the
`@scriptin/*` NPM packages of jmdict-simplified (MIT; not used by this
project).

```
MIT License

Copyright (c) <year> <copyright holders — see section 1.4 and section 2>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 3.2 Apache License, Version 2.0

Applies to **TypeScript** (© Microsoft Corporation), **puppeteer-core**
(© Google), and the JS/WASM wrapper of **@sqlite.org/sqlite-wasm** (© The
SQLite Authors; SQLite itself is public domain).

```
Apache License

Version 2.0, January 2004

http://www.apache.org/licenses/

TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

1. Definitions.

"License" shall mean the terms and conditions for use, reproduction, and
distribution as defined by Sections 1 through 9 of this document.

"Licensor" shall mean the copyright owner or entity authorized by the
copyright owner that is granting the License.

"Legal Entity" shall mean the union of the acting entity and all other
entities that control, are controlled by, or are under common control with
that entity. For the purposes of this definition, "control" means (i) the
power, direct or indirect, to cause the direction or management of such
entity, whether by contract or otherwise, or (ii) ownership of fifty percent
(50%) or more of the outstanding shares, or (iii) beneficial ownership of
such entity.

"You" (or "Your") shall mean an individual or Legal Entity exercising
permissions granted by this License.

"Source" form shall mean the preferred form for making modifications,
including but not limited to software source code, documentation source, and
configuration files.

"Object" form shall mean any form resulting from mechanical transformation or
translation of a Source form, including but not limited to compiled object
code, generated documentation, and conversions to other media types.

"Work" shall mean the work of authorship, whether in Source or Object form,
made available under the License, as indicated by a copyright notice that is
included in or attached to the work (an example is provided in the Appendix
below).

"Derivative Works" shall mean any work, whether in Source or Object form, that
is based on (or derived from) the Work and for which the editorial revisions,
annotations, elaborations, or other modifications represent, as a whole, an
original work of authorship. For the purposes of this License, Derivative
Works shall not include works that remain separable from, or merely link (or
bind by name) to the interfaces of, the Work and Derivative Works thereof.

"Contribution" shall mean any work of authorship, including the original
version of the Work and any modifications or additions to that Work or
Derivative Works thereof, that is intentionally submitted to Licensor for
inclusion in the Work by the copyright owner or by an individual or Legal
Entity authorized to submit on behalf of the copyright owner. For the purposes
of this definition, "submitted" means any form of electronic, verbal, or
written communication sent to the Licensor or its representatives, including
but not limited to communication on electronic mailing lists, source code
control systems, and issue tracking systems that are managed by, or on behalf
of, the Licensor for the purpose of discussing and improving the Work, but
excluding communication that is conspicuously marked or otherwise designated
in writing by the copyright owner as "Not a Contribution."

"Contributor" shall mean Licensor and any individual or Legal Entity on behalf
of whom a Contribution has been received by Licensor and subsequently
incorporated within the Work.

2. Grant of Copyright License. Subject to the terms and conditions of this
License, each Contributor hereby grants to You a perpetual, worldwide,
non-exclusive, no-charge, royalty-free, irrevocable copyright license to
reproduce, prepare Derivative Works of, publicly display, publicly perform,
sublicense, and distribute the Work and such Derivative Works in Source or
Object form.

3. Grant of Patent License. Subject to the terms and conditions of this
License, each Contributor hereby grants to You a perpetual, worldwide,
non-exclusive, no-charge, royalty-free, irrevocable (except as stated in this
section) patent license to make, have made, use, offer to sell, sell, import,
and otherwise transfer the Work, where such license applies only to those
patent claims licensable by such Contributor that are necessarily infringed by
their Contribution(s) alone or by combination of their Contribution(s) with
the Work to which such Contribution(s) was submitted. If You institute patent
litigation against any entity (including a cross-claim or counterclaim in a
lawsuit) alleging that the Work or a Contribution incorporated within the Work
constitutes direct or contributory patent infringement, then any patent
licenses granted to You under this License for that Work shall terminate as of
the date such litigation is filed.

4. Redistribution. You may reproduce and distribute copies of the Work or
Derivative Works thereof in any medium, with or without modifications, and in
Source or Object form, provided that You meet the following conditions:

(a) You must give any other recipients of the Work or Derivative Works a copy
of this License; and

(b) You must cause any modified files to carry prominent notices stating that
You changed the files; and

(c) You must retain, in the Source form of any Derivative Works that You
distribute, all copyright, patent, trademark, and attribution notices from the
Source form of the Work, excluding those notices that do not pertain to any
part of the Derivative Works; and

(d) If the Work includes a "NOTICE" text file as part of its distribution,
then any Derivative Works that You distribute must include a readable copy of
the attribution notices contained within such NOTICE file, excluding those
notices that do not pertain to any part of the Derivative Works, in at least
one of the following places: within a NOTICE text file distributed as part of
the Derivative Works; within the Source form or documentation, if provided
along with the Derivative Works; or, within a display generated by the
Derivative Works, if and wherever such third-party notices normally appear.
The contents of the NOTICE file are for informational purposes only and do not
modify the License. You may add Your own attribution notices within Derivative
Works that You distribute, alongside or as an addendum to the NOTICE text from
the Work, provided that such additional attribution notices cannot be
construed as modifying the License.

You may add Your own copyright statement to Your modifications and may provide
additional or different license terms and conditions for use, reproduction, or
distribution of Your modifications, or for any such Derivative Works as a
whole, provided Your use, reproduction, and distribution of the Work otherwise
complies with the conditions stated in this License.

5. Submission of Contributions. Unless You explicitly state otherwise, any
Contribution intentionally submitted for inclusion in the Work by You to the
Licensor shall be under the terms and conditions of this License, without any
additional terms or conditions. Notwithstanding the above, nothing herein
shall supersede or modify the terms of any separate license agreement you may
have executed with Licensor regarding such Contributions.

6. Trademarks. This License does not grant permission to use the trade names,
trademarks, service marks, or product names of the Licensor, except as
required for reasonable and customary use in describing the origin of the Work
and reproducing the content of the NOTICE file.

7. Disclaimer of Warranty. Unless required by applicable law or agreed to in
writing, Licensor provides the Work (and each Contributor provides its
Contributions) on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
KIND, either express or implied, including, without limitation, any warranties
or conditions of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
PARTICULAR PURPOSE. You are solely responsible for determining the
appropriateness of using or redistributing the Work and assume any risks
associated with Your exercise of permissions under this License.

8. Limitation of Liability. In no event and under no legal theory, whether in
tort (including negligence), contract, or otherwise, unless required by
applicable law (such as deliberate and grossly negligent acts) or agreed to in
writing, shall any Contributor be liable to You for damages, including any
direct, indirect, special, incidental, or consequential damages of any
character arising as a result of this License or out of the use or inability
to use the Work (including but not limited to damages for loss of goodwill,
work stoppage, computer failure or malfunction, or any and all other
commercial damages or losses), even if such Contributor has been advised of
the possibility of such damages.

9. Accepting Warranty or Additional Liability. While redistributing the Work
or Derivative Works thereof, You may choose to offer, and charge a fee for,
acceptance of support, warranty, indemnity, or other liability obligations
and/or rights consistent with this License. However, in accepting such
obligations, You may act only on Your own behalf and on Your sole
responsibility, not on behalf of any other Contributor, and only if You agree
to indemnify, defend, and hold each Contributor harmless for any liability
incurred by, or claims asserted against, such Contributor by reason of your
accepting any such warranty or additional liability.

END OF TERMS AND CONDITIONS
```

---

Keep this NOTICE and [`LICENSE.md`](LICENSE.md) with any redistribution of the
project or of the dictionary database it builds.