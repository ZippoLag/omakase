#!/usr/bin/env python3
"""Reference renderer: produces golden expected outputs from fixture data.

This is the *contract* for the CLI output format. The TypeScript formatter in
the app must reproduce these files byte-for-byte; the golden test compares
`omakase <cmd>` output against them.

Regeneration is deliberate: edit this file, run it, and review the diff.
`git diff tests/fixtures/golden` is the review surface.

Sources of fixture data (see README.md):
  - entries/*.json   exact snapshots from jmdict-simplified 3.6.2+20260824122934
  - meta/tags.json   tag descriptions from the same release
  - conjugations/*.json  real tables from jkindrix/japanese-language-data
  - sentences/*.json real curated Tatoeba pairs (CC BY 2.0 FR)
  - furigana-jmdict.json exact snapshots from Doublevil/JmdictFurigana
    2.3.1+2026-08-25 (MIT; data derived from JMdict, CC BY-SA 4.0)
  - radical numbers: Kangxi numbering (public domain); full map in real impl
"""
import json
import math
import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
E = os.path.join(BASE, "entries")
G = os.path.join(BASE, "golden")
S = os.path.join(BASE, "sentences")
C = os.path.join(BASE, "conjugations")

# ---- helpers ----------------------------------------------------------------

def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)

def word_entries():
    out = {}
    for name in sorted(os.listdir(E)):
        if name.startswith("jmdict-"):
            w = load(os.path.join(E, name))
            out[w["id"]] = w
    return out

TAGS = load(os.path.join(BASE, "meta", "tags.json"))

def pos_label(tag):
    desc = TAGS.get(tag, tag)
    return desc[0].upper() + desc[1:] if desc else tag

# pinned kana reading -> romaji, matching src/kana.ts toRomaji for the fixture
# readings (kept in sync with the TS enrichment; the regenerator is standalone
# and doesn't reimplement Hepburn).
ROMAJI = {
    "のむ": "nomu", "ある": "aru", "あつい": "atsui", "あづい": "azui",
    "あぢぃ": "ajii", "あぢー": "ajii", "あぢい": "ajii", "あっつい": "attsui",
    "アツイ": "atsui", "アツい": "atsui", "たべる": "taberu", "たべもの": "tabemono",
    "しょくじ": "shokuji", "くる": "kuru", "クる": "kuru", "きれい": "kirei",
    "キレイ": "kirei", "きれーい": "kireei", "くう": "kuu", "よい": "yoi",
    "えい": "ei", "かんずる": "kanzuru", "いい": "ii", "する": "suru",
    # kanji on/kun readings used by the reading-search goldens (src/kana.ts toRomaji)
    "しょく": "shoku", "じき": "jiki", "くらう": "kurau", "はむ": "hamu",
    "みず": "mizu", "みる": "miru", "いく": "iku", "ゆく": "yuku",
    "おこなう": "okonau", "すい": "sui", "いん": "in", "けん": "ken",
    "こう": "kou", "ぎょう": "gyou", "あん": "an", "らい": "rai",
    "りょう": "ryou", "しょう": "shou", "き": "ki", "ぐい": "gui",
}

def romaji(text):
    return ROMAJI.get(text, text)

# ---- JmdictFurigana (entries/furigana-jmdict.json, mirrored in
# ---- data/build/transform.ts furiganaLookup / furiganaForWriting):
# ---- (writing, reading) -> ruby-marked string.
FURIGANA_MAP = {}
for _e in load(os.path.join(E, "furigana-jmdict.json")):
    FURIGANA_MAP[(_e["text"], _e["reading"])] = "".join(
        s["ruby"] + ("[" + s["rt"] + "]" if s.get("rt") else "") for s in _e["furigana"]
    )


def furigana_for(entry, writing):
    """Ruby-marked string for `writing` of `entry`, or None when the dataset
    has no (writing, reading) pair for it. Pairs with the first kana reading
    that has an entry (mirrors transform.ts furiganaForWriting) — the CLI
    omits the Furigana line entirely when this returns None."""
    for k in entry.get("kana", []):
        ruby = FURIGANA_MAP.get((writing, k["text"]))
        if ruby is not None:
            return ruby
    return None

# Kangxi radical number -> character (subset used by fixtures; full list in real impl)
KANGXI = {184: "食", 85: "水", 144: "行", 75: "木", 120: "糸", 72: "日", 138: "艮", 30: "口", 147: "見"}

def is_kanji(ch):
    return "\u4e00" <= ch <= "\u9fff"

def first_gloss(word):
    glosses = [g["text"] for s in word["sense"] for g in s["gloss"]]
    return glosses[0] if glosses else ""

def find_word(word, entries):
    return next((w for w in entries.values()
                 if word in [k["text"] for k in w.get("kanji", [])]
                 or (word in [k["text"] for k in w.get("kana", [])] and not w.get("kanji"))), None)

def display_header(word):
    """First common writing + first common kana reading."""
    kanji = word.get("kanji", [])
    kana = word.get("kana", [])
    w = next((k for k in kanji if k.get("common")), kanji[0] if kanji else None)
    r = next((k for k in kana if k.get("common")), kana[0] if kana else None)
    text = w["text"] if w else (r["text"] if r else "?")
    reading = r["text"] if r else None
    common = any(k.get("common") for k in kanji) or any(k.get("common") for k in kana)
    return text, reading, common

def compound_rows(entries):
    """kanji literal -> sorted [(word_id, writing, furigana, first_gloss)]"""
    rows = {}
    for wid in sorted(entries):
        w = entries[wid]
        for k in w.get("kanji", []):
            seen = set()
            for ch in k["text"]:
                if is_kanji(ch) and ch not in seen:
                    seen.add(ch)
                    fg = furigana_for(w, k["text"]) or k["text"]
                    rows.setdefault(ch, []).append((wid, k["text"], fg, first_gloss(w)))
    return rows

COMPOUNDS = compound_rows(word_entries())

# kradfile decomposition slices (entries/krad-<kanji>.json -> components),
# mirroring src/lookup.ts loadKanji (kanji_radicals in kradfile order).
KRAD = {}
for _name in sorted(os.listdir(E)):
    if _name.startswith("krad-"):
        _k = load(os.path.join(E, _name))
        KRAD[_k["literal"]] = _k["components"]

def render_kanji_words(lits, entries, max_n=30):
    """Words containing any of `lits`, ranked: most distinct matched kanji
    first, then common, then entry id — mirrors src/lookup.ts
    wordsContainingKanji + src/format.ts renderKanjiWords."""
    cand = {}
    for wid in sorted(entries, key=lambda i: int(i)):
        w = entries[wid]
        best = None
        for k in w.get("kanji", []):
            matched = len({ch for ch in k["text"] if ch in lits})
            if matched and (best is None or matched > best[2]):
                best = (wid, k["text"], matched, furigana_for(w, k["text"]) or k["text"], first_gloss(w))
        if best:
            cand[wid] = best
    ranked = sorted(
        cand.values(),
        key=lambda r: (-r[2], not entries[r[0]].get("common", False), int(r[0])),
    )
    shown = ranked[:max_n]
    if not shown:
        return ""
    lines = ["Words (%d):" % len(cand)]
    for _wid, writing, _matched, fg, gloss in shown:
        lines.append("  %s  [%s]  %s" % (writing, fg, gloss))
    if len(cand) > len(shown):
        lines.append("  … and %d more" % (len(cand) - len(shown)))
    return "\n".join(lines) + "\n"

# ---- renderers --------------------------------------------------------------

def render_word(word, limit=None):
    text, reading, common = display_header(word)
    kanji = word.get("kanji", [])
    kana = word.get("kana", [])
    lines = []
    tag = " (common)" if common else ""
    lines.append("%s [%s]%s" % (text, reading, tag))
    lines.append("")
    if kanji:
        lines.append("Writings: " + "・".join(k["text"] for k in kanji))
    lines.append("Readings: " + "・".join(k["text"] for k in kana))
    if kanji:
        fg = furigana_for(word, kanji[0]["text"])
        if fg is not None:
            lines.append("Furigana: " + fg)
    else:
        lines.append("Furigana: " + reading)
    lines.append("")
    pos = []
    for s in word["sense"]:
        for p in s["partOfSpeech"]:
            if p not in pos:
                pos.append(p)
    labels = sorted((pos_label(p) for p in pos), key=str.lower)
    lines.append(labels[0] + (("; " + "; ".join(l.lower() for l in labels[1:])) if len(labels) > 1 else ""))
    lines.append("")
    senses = word["sense"]
    shown = senses if limit is None else senses[:limit]
    for i, s in enumerate(shown, 1):
        gloss = "; ".join(g["text"] for g in s["gloss"])
        lines.append("  %d. %s" % (i, gloss))
    if limit is not None and len(senses) > limit:
        lines.append("  … and %d more senses" % (len(senses) - limit))
    return "\n".join(lines) + "\n"

def render_examples(word):
    """Examples section: sentences whose Japanese text contains a writing of the word."""
    writings = [k["text"] for k in word.get("kanji", [])] + [k["text"] for k in word.get("kana", [])]
    sents = []
    for name in sorted(os.listdir(S)):
        s = load(os.path.join(S, name))
        if any(wr in s["japanese"] for wr in writings):
            sents.append(s)
    if not sents:
        return ""
    out = ["Examples:", ""]
    for i, s in enumerate(sents, 1):
        out.append("  %d. %s" % (i, s["japanese"]))
        out.append("     %s" % s["english"])
    return "\n".join(out) + "\n"

def build_thesaurus_links(entries):
    """Resolve every related/antonym xref tuple into links: forward, reverse,
    and 2-hop closure rows. Mirrors data/build/transform.ts buildThesaurusLinks
    (common-first, numeric-min id resolution; forward rows first so the first
    link to a target keeps its sense-specific gloss)."""
    by_text = {}
    kanji_by_text = {}
    kana_by_text = {}
    for wid, w in entries.items():
        for k in w.get("kanji", []):
            by_text.setdefault(k["text"], []).append(wid)
            kanji_by_text.setdefault(k["text"], []).append(wid)
        for k in w.get("kana", []):
            by_text.setdefault(k["text"], []).append(wid)
            kana_by_text.setdefault(k["text"], []).append(wid)

    def resolve(text, reading):
        if reading:
            kanji_ids = kanji_by_text.get(text, [])
            kana_ids = set(kana_by_text.get(reading, []))
            cands = [i for i in kanji_ids if i in kana_ids]
        else:
            cands = by_text.get(text, [])
        if not cands:
            return None
        return min(cands, key=lambda i: (not entries[i].get("common", False), int(i)))

    links = []  # (kind, from_id, to_id, to_sense, hops)
    seen = set()

    def push(kind, frm, to, sense, hops):
        if frm == to:
            return
        key = (kind, frm, to)
        if key in seen:
            return
        seen.add(key)
        links.append((kind, frm, to, sense, hops))

    forward = []
    for wid in sorted(entries):
        w = entries[wid]
        for s in w["sense"]:
            for kind, xrefs in (("related", s.get("related", [])), ("antonym", s.get("antonym", []))):
                for x in xrefs:
                    if not x or not isinstance(x[0], str):
                        continue
                    text = x[0]
                    reading = None
                    sense = None
                    if len(x) > 1 and isinstance(x[1], int):
                        sense = x[1]
                    elif len(x) > 1 and isinstance(x[1], str):
                        m = re.search(r"・(\d+)$", x[1])
                        reading = x[1][:m.start()] if m else x[1]
                        if m:
                            sense = int(m.group(1))
                        if len(x) > 2 and isinstance(x[2], int):
                            sense = x[2]
                    target = resolve(text, reading)
                    if target is None:
                        continue
                    forward.append((kind, wid, target, sense))

    for kind, frm, to, sense in forward:
        push(kind, frm, to, sense, 1)
    for kind, frm, to, _ in forward:
        push(kind, to, frm, None, 1)

    rel_edges = {}
    ant_edges = {}
    for kind, frm, to, _, hops in links:
        if hops != 1:
            continue
        m = rel_edges if kind == "related" else ant_edges
        m.setdefault(frm, set()).add(to)

    # exactly one extra hop over a snapshot of the 1-hop related rows
    base = [(k, f, t) for k, f, t, _, h in links if h == 1 and k == "related"]
    for _k, frm, to in base:
        for u in rel_edges.get(to, ()):
            if u != frm:
                push("related", frm, u, None, 2)
        for u in ant_edges.get(to, ()):
            if u != frm:
                push("antonym", frm, u, None, 2)
    return links

THESAURUS_LINKS = build_thesaurus_links(word_entries())

# ---- gloss-token thesaurus fallback (mirrors src/lookup.ts) ----------------

# Function words / generic tokens ignored by the fallback (kept in sync with
# src/lookup.ts GLOSS_STOPWORDS).
GLOSS_STOPWORDS = set([
    "a", "an", "the", "and", "or", "but", "nor", "so", "if", "then", "else",
    "not", "no", "of", "to", "in", "on", "at", "for", "with", "by", "from",
    "as", "is", "are", "was", "were", "be", "been", "being", "am", "do",
    "does", "did", "done", "have", "has", "had", "it", "its", "this", "that",
    "these", "those", "i", "you", "he", "she", "we", "they", "me", "him",
    "her", "us", "them", "my", "your", "our", "their", "e", "g", "etc",
    "eg", "ie", "sth", "sb", "some", "something", "someone", "somebody",
    "anything", "anyone", "thing", "things", "way", "ways", "one", "two",
    "used", "usu", "often", "also", "such", "very", "more", "most", "when",
    "what", "which", "who", "whom", "whose", "how", "why", "up", "down",
    "out", "off", "over", "under", "into", "onto", "about", "after", "before",
    "between", "during", "through", "until", "against", "among", "along",
    "lit", "arch", "obs", "dated", "rare", "uk", "sl", "coll", "fam",
    "derog", "hon", "pol", "vulg", "esp", "first", "last", "kind", "sort",
])

GLOSS_TOKEN_CAP = 30


def gloss_tokens(text):
    toks = re.findall(r"[a-z]+", text.lower())
    out = []
    for t in toks:
        if len(t) > 1 and t not in GLOSS_STOPWORDS and t not in out:
            out.append(t)
    return out


def word_tokens(word):
    out = []
    for s in word["sense"]:
        for g in s["gloss"]:
            for t in gloss_tokens(g["text"]):
                if t not in out:
                    out.append(t)
    return out


ENTRY_TOKENS = {wid: set(word_tokens(w)) for wid, w in word_entries().items()}


def coarse_class(tag):
    if tag.startswith("v") or tag == "aux-v":
        return "verb"
    if tag.startswith("adj"):
        return "adj"
    if re.match(r"^n(?:-|$)", tag) or tag in ("pn", "pr", "num"):
        return "noun"
    if tag == "adv":
        return "adv"
    return None


def coarse_classes(word):
    out = set()
    for s in word["sense"]:
        for tag in s["partOfSpeech"]:
            c = coarse_class(tag)
            if c:
                out.add(c)
    return out


def render_gloss_thesaurus(word, entries):
    """Fallback thesaurus: shared distinctive gloss tokens over `glosses_fts`
    (mirrored in-memory here), scored by ln(1 + N/df), same-POS preferred,
    capped at 5. Mirrors src/lookup.ts glossThesaurus."""
    tokens = word_tokens(word)
    if not tokens:
        return ""
    capped = tokens[:GLOSS_TOKEN_CAP]
    wid = word["id"]
    skip = {wid} | {to for k, frm, to, _, _ in THESAURUS_LINKS if frm == wid}
    total = len(entries)

    df = {}
    shared = {}
    for t in capped:
        ids = [owid for owid, toks in ENTRY_TOKENS.items() if t in toks]
        df[t] = len(ids)
        for owid in ids:
            if owid in skip:
                continue
            shared.setdefault(owid, set()).add(t)

    cands = []
    source_classes = coarse_classes(word)
    for owid, toks in shared.items():
        target_classes = coarse_classes(entries[owid])
        if source_classes and target_classes and not (source_classes & target_classes):
            continue
        score = sum(math.log(1 + total / df[t]) for t in toks)
        cands.append((owid, score, len(toks)))
    cands.sort(key=lambda c: (-c[1], -c[2], not entries[c[0]].get("common", False), int(c[0])))

    rows = []
    for owid, _score, _n in cands[:5]:
        text, reading, _ = display_header(entries[owid])
        rows.append("  %s  [%s]  %s" % (text, reading, first_gloss(entries[owid])))
    if not rows:
        return ""
    return "Synonyms:\n" + "\n".join(rows) + "\n"


def render_thesaurus(word, entries):
    """Thesaurus: up to 5 synonyms (related links) and 5 antonyms (antonym links)
    from the materialized link table (forward + reverse + 2-hop closure),
    mirroring src/lookup.ts wordThesaurus: first link to a target wins, common
    words first, capped at 5."""
    def gloss_at(target, sense):
        if sense is not None and 1 <= sense <= len(target["sense"]):
            glosses = [g["text"] for g in target["sense"][sense - 1]["gloss"]]
            if glosses:
                return "; ".join(glosses)
        return first_gloss(target)

    def collect(kind):
        hits = []
        seen = set()
        for k, frm, to, sense, _hops in THESAURUS_LINKS:
            if k != kind or frm != word["id"] or to in seen:
                continue
            seen.add(to)
            target = entries[to]
            hits.append((target, gloss_at(target, sense)))
        hits.sort(key=lambda h: (not h[0].get("common", False), int(h[0]["id"])))
        return hits[:5]

    sections = []
    for kind, header in [("related", "Synonyms:"), ("antonym", "Antonyms:")]:
        hits = collect(kind)
        if hits:
            if sections:
                sections.append("")
            sections.append(header)
            for target, gloss in hits:
                text, reading, _ = display_header(target)
                sections.append("  %s  [%s]  %s" % (text, reading, gloss))
    if sections:
        return "\n".join(sections) + "\n"
    # No cross-reference links at all: infer related words from gloss overlap.
    return render_gloss_thesaurus(word, entries)

def render_kanji(lit, kanji_data, word_entries, max_compounds=30):
    m = kanji_data["misc"]
    rm = kanji_data["readingMeaning"]
    on = [r["value"] for g in rm["groups"] for r in g["readings"] if r["type"] == "ja_on"]
    kun = [r["value"] for g in rm["groups"] for r in g["readings"] if r["type"] == "ja_kun"]
    meanings = [x["value"] for g in rm["groups"] for x in g["meanings"] if x["lang"] == "en"]
    classical = next((r["value"] for r in kanji_data["radicals"] if r["type"] == "classical"), None)
    rad_ch = KANGXI.get(classical) if classical else None
    lines = []
    lines.append("%s  [%s strokes]" % (lit, m["strokeCounts"][0]))
    lines.append("")
    bits = []
    if m["grade"]:
        bits.append("grade %s" % m["grade"])
    if m["jlptLevel"]:
        bits.append("JLPT %s" % m["jlptLevel"])
    if m["frequency"]:
        bits.append("frequency %s" % m["frequency"])
    if classical:
        bits.append("radical %s (%s)" % (rad_ch, classical))
    lines.append(" · ".join(bits))
    comps = KRAD.get(lit)
    if comps:
        lines.append("Radicals: " + " + ".join(comps))
    lines.append("")
    if on:
        lines.append("On:   " + "  ".join(on))
    if kun:
        lines.append("Kun:  " + "  ".join(kun))
    if rm["nanori"]:
        lines.append("Nanori: " + " ".join(rm["nanori"]))
    lines.append("")
    lines.append("Meanings: " + "; ".join(meanings))
    lines.append("")
    comps = COMPOUNDS.get(lit, [])
    if comps:
        lines.append("Compounds:")
        for wid, writing, fg, gloss in comps[:max_compounds]:
            lines.append("  %s  [%s]  %s" % (writing, fg, gloss))
        if len(comps) > max_compounds:
            lines.append("  … and %d more" % (len(comps) - max_compounds))
    return "\n".join(lines) + "\n"

# Default per-section row cap for `search` (mirrors format.ts SEARCH_MAX_DEFAULT).
SEARCH_MAX = 30

def render_search(query, sections):
    """Sectioned `search` output: query echo, then each non-empty ranked
    section (`Readings (N):` / `Meanings (N):` / `Kanji (N):`) with up to
    SEARCH_MAX rows and a remainder note. Mirrors src/format.ts renderSearch
    (plain text — bolding is a terminal-only concern in the TS formatter)."""
    lines = [query, ""]
    emitted = False
    for header, rows in sections:
        if not rows:
            continue
        if emitted:
            lines.append("")
        lines.append("%s (%d):" % (header, len(rows)))
        for row in rows[:SEARCH_MAX]:
            lines.append(row)
        if len(rows) > SEARCH_MAX:
            lines.append("  … and %d more" % (len(rows) - SEARCH_MAX))
        emitted = True
    if not emitted:
        lines.append("  (no results)")
    return "\n".join(lines) + "\n"

def render_radical(rad_ch, rad_data, limit=20):
    lines = []
    lines.append("%s  (%s strokes; %d kanji)" % (rad_ch, rad_data["strokeCount"], len(rad_data["kanji"])))
    lines.append("")
    shown = rad_data["kanji"][:limit]
    lines.append("  " + " ".join(shown))
    if len(rad_data["kanji"]) > limit:
        lines.append("  … and %d more" % (len(rad_data["kanji"]) - limit))
    return "\n".join(lines) + "\n"

FORM_LABELS = {
    "dictionary": "dictionary", "polite_nonpast": "polite nonpast",
    "polite_past": "polite past", "polite_negative": "polite negative",
    "polite_past_negative": "polite past negative", "te_form": "te-form",
    "ta_form": "ta-form (past)", "nai_form": "nai-form (negative)",
    "nakatta_form": "nakatta (neg. past)", "potential": "potential",
    "passive": "passive", "causative": "causative", "imperative": "imperative",
    "volitional": "volitional", "conditional_ba": "conditional -ba",
    "conditional_tara": "conditional -tara", "negative": "negative",
    "past": "past", "past_negative": "past negative", "adverbial": "adverbial",
}

def render_conjugate(word, conj, entries):
    text, reading, _ = display_header(word)
    lines = []
    lines.append("Conjugations of %s [%s]" % (text, reading))
    lines.append("")
    for key, value in conj["display_forms"].items():
        lines.append("  %-22s %s" % (FORM_LABELS.get(key, key), value))
    return "\n".join(lines) + "\n"

def render_deconjugate(form, matches):
    lines = [form, ""]
    for word, conj, form_name in matches:
        text, reading, _ = display_header(word)
        labels = sorted({pos_label(p) for p in
                         {p for s in word["sense"] for p in s["partOfSpeech"]}}, key=str.lower)
        pos = labels[0] + (("; " + "; ".join(l.lower() for l in labels[1:])) if len(labels) > 1 else "")
        lines.append("  %s  [%s]  %s  (← %s)" % (text, reading, pos, form_name))
    if not matches:
        lines.append("  (no matches)")
    return "\n".join(lines) + "\n"

# ---- build goldens ----------------------------------------------------------

def main():
    os.makedirs(G, exist_ok=True)
    entries = word_entries()

    def w(id_):
        return entries[id_]

    def write(name, text):
        with open(os.path.join(G, name), "w", encoding="utf-8") as f:
            f.write(text)
        print("wrote golden/%s" % name)

    def word_out(eid, limit=None):
        """Word body + thesaurus section (when the word has synonyms/antonyms)."""
        body = render_word(w(eid), limit=limit)
        thes = render_thesaurus(w(eid), entries)
        return body + "\n" + thes if thes else body

    # --- word ---
    write("word-taberu.txt", word_out("1358280") + "\n" + render_examples(w("1358280")))
    write("word-shokuji.txt", word_out("1358490") + "\n" + render_examples(w("1358490")))
    write("word-kirei.txt", word_out("1591900"))
    write("word-yoi.txt", word_out("1605820"))
    write("word-ii.txt", word_out("2820690"))
    write("word-suru-limit3.txt", word_out("1157170", limit=3))
    write("word-atsui.txt", word_out("1343460"))
    write("word-aru.txt", word_out("1296400"))
    write("word-aikyogen.txt", word_out("1215390"))

    # --- kanji ---
    for lit, name in [("食", "kanji-shoku"), ("水", "kanji-mizu"), ("喰", "kanji-kuu")]:
        data = load(os.path.join(E, "kanjidic2-%s.json" % {"食": "shoku", "水": "mizu", "喰": "kuu"}[lit]))
        write(name + ".txt", render_kanji(lit, data, entries))
    # Multi-kanji: a ranked Words section, then one page per character
    # back-to-back (each page ends with a newline). Mirrors cmdKanji /
    # runKanji for `kanji 飲食`.
    inshoku = render_kanji_words(["飲", "食"], entries) + "".join(
        render_kanji(lit, load(os.path.join(E, "kanjidic2-%s.json" % name)), entries)
        for lit, name in [("飲", "nomu"), ("食", "shoku")]
    )
    write("kanji-inshoku.txt", inshoku)

    # --- kanji-by-reading search (mirrors src/lookup.ts searchKanjiByReading) ---
    KANJI = {}
    for name in sorted(os.listdir(E)):
        if name.startswith("kanjidic2-"):
            k = load(os.path.join(E, name))
            KANJI[k["literal"]] = k

    def kanji_readings(lit):
        k = KANJI[lit]
        rm = k["readingMeaning"]
        on = [r["value"] for g in rm["groups"] for r in g["readings"] if r["type"] == "ja_on"]
        kun = [r["value"] for g in rm["groups"] for r in g["readings"] if r["type"] == "ja_kun"]
        nanori = rm["nanori"]
        meanings = [x["value"] for g in rm["groups"] for x in g["meanings"] if x["lang"] == "en"]
        return on, kun, nanori, meanings

    def normalize_reading(v):
        # strip kun dot separators, katakana -> hiragana (same as src/kana.ts)
        s = v.replace(".", "")
        return "".join(chr(ord(c) - 0x60) if "\u30a1" <= c <= "\u30f6" else c for c in s)

    def kanji_reading_hits(query, is_kana):
        needle = normalize_reading(query) if is_kana else query.lower()
        hits = []
        for lit in sorted(KANJI):
            on, kun, nanori, meanings = kanji_readings(lit)
            matched = []
            for r in on + kun + nanori:
                norm = normalize_reading(r)
                ok = norm.startswith(needle) if is_kana else romaji(norm).startswith(needle)
                if ok and r not in matched:
                    matched.append(r)
            if matched:
                hits.append((lit, matched, meanings))
        return hits

    # --- search: ranked Readings / Meanings / Kanji sections ---
    # (mirrors src/lookup.ts searchReadingPrefix + searchMeanings and the
    # sectioned layout of src/format.ts renderSearch: exact matches first,
    # then common words, then entry id; meanings require every query token
    # inside ONE sense, exact gloss tokens ranking above prefix matches.)

    def gloss_ws(text):
        return re.findall(r"[a-z0-9]+", text.lower())

    def meaning_rank(w_, toks):
        """(exact_count, prefix_count, sense_index, display_gloss) when one
        sense covers all tokens, else None. Mirrors searchMeanings' per-sense
        covering rule (sense_index = first covering sense, 0-based)."""
        exact = [False] * len(toks)
        covered = [False] * len(toks)
        display = None
        first_sense = None
        for si, s in enumerate(w_["sense"]):
            m = [False] * len(toks)
            e = [False] * len(toks)
            for g in s["gloss"]:
                ws = gloss_ws(g["text"])
                for k, t in enumerate(toks):
                    if t in ws:
                        e[k] = True
                        m[k] = True
                    elif any(x.startswith(t) for x in ws):
                        m[k] = True
            if not all(m):
                continue
            if first_sense is None:
                first_sense = si
            for k in range(len(toks)):
                if e[k]:
                    exact[k] = True
                if m[k]:
                    covered[k] = True
            if display is None:
                for g in s["gloss"]:
                    ws = gloss_ws(g["text"])
                    if any(any(x == t or x.startswith(t) for t in toks) for x in ws):
                        display = g["text"]
                        break
        if first_sense is None:
            return None
        return (sum(exact), sum(covered) - sum(exact), first_sense, display)

    def meaning_rows(query):
        toks = [t for t in re.findall(r"[a-z0-9]+", query.lower()) if len(t) > 1]
        rows = []
        for i in sorted(entries, key=int):
            res = meaning_rank(entries[i], toks)
            if res is None:
                continue
            exact_c, prefix_c, sense_i, display = res
            text, reading, common = display_header(entries[i])
            rows.append((text, reading or "", display, exact_c, prefix_c, sense_i, common, int(i)))
        # exact beats prefix; then the earliest covering sense, then common, then id
        rows.sort(key=lambda r: (-r[3], -r[4], r[5], -r[6], r[7]))
        return ["  %s  [%s]  %s" % (r[0], r[1], r[2]) for r in rows]

    def reading_rows(query, is_kana):
        """Ranked reading-prefix rows: `text  [kana (romaji)]  gloss`."""
        needle = re.sub(r"\s+", "", query if is_kana else query.lower())
        cands = []
        for i in sorted(entries, key=int):
            w_ = entries[i]
            for k in w_.get("kana", []):
                value = k["text"] if is_kana else romaji(k["text"])
                if not value.startswith(needle):
                    continue
                text, _reading, common = display_header(w_)
                cands.append((k["text"], romaji(k["text"]), first_gloss(w_), value == needle, common, int(i), text))
                break
        cands.sort(key=lambda r: (-r[3], -r[4], len(r[0]), r[5]))
        return ["  %s  [%s (%s)]  %s" % (r[6], r[0], r[1], r[2]) for r in cands]

    def search_sections(read_rows, mean_rows, kanji):
        sections = []
        if read_rows:
            sections.append(("Readings", read_rows))
        if mean_rows:
            sections.append(("Meanings", mean_rows))
        if kanji:
            sections.append(("Kanji", ["  %s  [%s]  %s" % (lit, "  ".join(rs), "; ".join(ms)) for lit, rs, ms in kanji]))
        return sections

    write("search-eat.txt", render_search("eat", search_sections([], meaning_rows("eat"), kanji_reading_hits("eat", False))))
    write("search-taberu.txt", render_search("たべ", search_sections(reading_rows("たべ", True), [], kanji_reading_hits("たべ", True))))
    write("search-taberu-romaji.txt", render_search("taberu", search_sections(reading_rows("taberu", False), meaning_rows("taberu"), kanji_reading_hits("taberu", False))))

    # --- radical ---
    write("radical-mizu.txt", render_radical("水", load(os.path.join(E, "radk-水.json"))))

    # --- conjugate ---
    for eid, name in [("1358280", "conjugate-taberu"), ("1547720", "conjugate-kuru"), ("1157170", "conjugate-suru"),
                      ("1605820", "conjugate-yoi"), ("2820690", "conjugate-ii"), ("1296400", "conjugate-aru"),
                      ("1358490", "conjugate-shokuji"), ("1609650", "conjugate-kanzuru"),
                      # per-class [G] gap classes (see tests/fixtures/conjugations provenance)
                      ("2410560", "conjugate-shisu"), ("1150450", "conjugate-aisuru"),
                      ("9000101", "conjugate-ou"), ("9000102", "conjugate-kentou")]:
        stem = name.replace("conjugate-", "")
        conj = load(os.path.join(C, stem + ".json"))
        write(name + ".txt", render_conjugate(w(eid), conj, entries))

    # --- deconjugate (scans every table in fixtures/conjugations) ---
    def deconjugate(form):
        matches = []
        for cname in sorted(os.listdir(C)):
            if not cname.endswith(".json") or cname.startswith("_"):
                continue
            conj = load(os.path.join(C, cname))
            word = entries.get(conj["id"])
            if word is None:
                continue
            for key, value in conj["display_forms"].items():
                if value == form:
                    matches.append((word, conj, FORM_LABELS.get(key, key)))
        return matches

    write("deconjugate-tabete.txt", render_deconjugate("食べて", deconjugate("食べて")))
    write("deconjugate-nai.txt", render_deconjugate("ない", deconjugate("ない")))
    write("deconjugate-shokujishite.txt", render_deconjugate("食事して", deconjugate("食事して")))
    write("deconjugate-nomatch.txt", render_deconjugate("わからないもの", deconjugate("わからないもの")))

    print("\nall goldens written to", G)

if __name__ == "__main__":
    main()
