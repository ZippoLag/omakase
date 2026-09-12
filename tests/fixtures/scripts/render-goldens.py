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

def is_common(word):
    """JMdict common flag: any common kanji or kana writing (mirrors
    data/build/transform.ts isCommon)."""
    return any(k.get("common") for k in word.get("kanji", [])) or any(
        k.get("common") for k in word.get("kana", []))

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

def render_kanji_words(lits, entries, max_n=30, offset=0):
    """Words containing any of `lits`, ranked: most distinct matched kanji
    first, then common, then entry id — mirrors src/lookup.ts
    wordsContainingKanji + src/format.ts renderKanjiWords (two-line rows:
    `  writing  [ruby]` then `     gloss`)."""
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
    shown = ranked[offset:offset + max_n]
    if not shown:
        return ""
    lines = ["Words (%d):" % len(cand)]
    for _wid, writing, _matched, fg, gloss in shown:
        lines.append("  %s  [%s]" % (writing, fg))
        lines.append("     %s" % gloss)
    if len(cand) > offset + len(shown):
        lines.append("  … and %d more" % (len(cand) - (offset + len(shown))))
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
        return min(cands, key=lambda i: (not is_common(entries[i]), int(i)))

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

    forward = []  # real xref declarations, in word/sense/xref order
    for wid in sorted(entries):
        w = entries[wid]
        for si, s in enumerate(w["sense"]):
            for kind, xrefs in (("related", s.get("related", [])), ("antonym", s.get("antonym", []))):
                for x in xrefs:
                    if not x or not isinstance(x[0], str):
                        continue
                    text = x[0]
                    reading = None
                    to_sense = None
                    if len(x) > 1 and isinstance(x[1], int):
                        to_sense = x[1]
                    elif len(x) > 1 and isinstance(x[1], str):
                        m = re.search(r"・(\d+)$", x[1])
                        reading = x[1][:m.start()] if m else x[1]
                        if m:
                            to_sense = int(m.group(1))
                        if len(x) > 2 and isinstance(x[2], int):
                            to_sense = x[2]
                    target = resolve(text, reading)
                    if target is None:
                        continue
                    forward.append((kind, wid, target, si + 1, to_sense))

    # A reciprocal pair is one the two entries really cite each other for; the
    # synthetic backlink must not fabricate symmetry.
    related_pairs = {(f, t) for (k, f, t, _fs, _ts) in forward if k == "related"}

    def is_mutual(a, b):
        return (a, b) in related_pairs and (b, a) in related_pairs

    links = []
    seen = set()

    def push(row):
        if row["from_word"] == row["to_word"]:
            return
        key = (row["kind"], row["from_word"], row["to_word"])
        if key in seen:
            return
        seen.add(key)
        links.append(row)

    for kind, frm, to, from_sense, to_sense in forward:
        push({
            "kind": "synonym" if (kind == "related" and is_mutual(frm, to)) else kind,
            "source": "xref",
            "from_word": frm,
            "to_word": to,
            "from_sense": from_sense,
            "to_sense": to_sense,
            "score": 1.0,
        })
    for kind, frm, to, _from_sense, _to_sense in forward:
        if kind == "related" and is_mutual(frm, to):
            continue
        push({
            "kind": kind,
            "source": "xref",
            "from_word": to,
            "to_word": frm,
            "from_sense": None,
            "to_sense": None,
            "score": 1.0,
        })
    return links


# ---- gloss-similarity synonyms (mirrors transform.ts buildGlossSynonymLinks) --

GLOSS_TOKEN_CAP = 30
GLOSS_DF_CEIL = 4000     # glue ceiling; must sit above the content vocabulary
GLOSS_MIN_SHARED = 2     # one shared token is too weak a signal
GLOSS_MIN_SCORE = 0.6
GLOSS_TOP_K = 5

# Function words / generic tokens (kept in sync with src/gloss.ts).
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


def gloss_tokens(text):
    return [t for t in re.findall(r"[a-z]+", text.lower())
            if len(t) > 1 and t not in GLOSS_STOPWORDS]


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


def coarse_pos_classes(tags):
    out = set()
    for tag in tags:
        c = coarse_class(tag)
        if c:
            out.add(c)
    return out


def sense_score(a_tokens, b_tokens, weight):
    """Weighted-Dice similarity of two senses: 2*Σ_shared w / (Σ_A w + Σ_B w)."""
    b_set = set(b_tokens)
    num = 0.0
    den = 0.0
    for t in a_tokens:
        w = weight(t)
        den += w
        if t in b_set:
            num += w
    for t in b_tokens:
        den += weight(t)
    return 0.0 if den == 0 else (2.0 * num) / den


def build_gloss_synonyms(entries, xref_links):
    """Materialize kind='synonym' gloss edges for words with no explicit
    synonym/related signal of their own. Sense-pair weighted Dice, df ceiling,
    shared-token gate, minimum score, top-K per word."""
    raw_tokens = []
    sense_meta = []
    word_tokens = {}
    word_token_set = {}
    for wid in sorted(entries):
        w = entries[wid]
        seen_tokens = set()
        ordered = []
        for si, s in enumerate(w["sense"]):
            toks = []
            local = set()
            for g in s["gloss"]:
                for t in gloss_tokens(g["text"]):
                    if t in local:
                        continue
                    local.add(t)
                    toks.append(t)
                    if t not in seen_tokens:
                        seen_tokens.add(t)
                        if len(ordered) < GLOSS_TOKEN_CAP:
                            ordered.append(t)
            raw_tokens.append(toks)
            sense_meta.append((wid, si + 1, coarse_pos_classes(s["partOfSpeech"])))
        word_tokens[wid] = ordered
        word_token_set[wid] = set(ordered)

    df = {}
    for i, toks in enumerate(raw_tokens):
        keep = word_token_set[sense_meta[i][0]]
        for t in set(t for t in toks if t in keep):
            df[t] = df.get(t, 0) + 1
    total = len(raw_tokens)

    def weight(t):
        return math.log(1 + total / df.get(t, 1))

    def kept(t):
        return df.get(t, 0) <= GLOSS_DF_CEIL

    senses = []
    for i, toks in enumerate(raw_tokens):
        wid, sense_no, classes = sense_meta[i]
        keep = word_token_set[wid]
        senses.append({
            "word_id": wid,
            "sense_no": sense_no,
            "classes": classes,
            "tokens": [t for t in toks if t in keep and kept(t)],
        })

    postings = {}
    for i, s in enumerate(senses):
        for t in s["tokens"]:
            postings.setdefault(t, []).append(i)

    # A synthetic backlink (from_sense None) is not a signal of the target's
    # own — it must not suppress that word's gloss pass. `linked` keeps backlink
    # targets so a related pair is still never promoted to a synonym.
    has_signal = set()
    linked = {}
    for r in xref_links:
        linked.setdefault(r["from_word"], set()).add(r["to_word"])
        if r["from_sense"] is not None and r["kind"] in ("synonym", "related"):
            has_signal.add(r["from_word"])

    senses_by_word = {}
    for i, s in enumerate(senses):
        senses_by_word.setdefault(s["word_id"], []).append(i)

    rows = []
    for wid in sorted(entries):
        if wid in has_signal:
            continue
        my_idx = senses_by_word.get(wid)
        if not my_idx:
            continue
        source_tokens = word_tokens[wid]
        if not source_tokens:
            continue
        skip = linked.get(wid)

        shared = {}
        for t in source_tokens:
            for j in postings.get(t, ()):
                other = senses[j]["word_id"]
                if other == wid:
                    continue
                if skip and other in skip:
                    continue
                shared.setdefault(other, set()).add(t)
        if not shared:
            continue

        cands = []
        for other, shared_toks in shared.items():
            if len(shared_toks) < GLOSS_MIN_SHARED:
                continue
            best = 0.0
            from_sense = 0
            to_sense = 0
            for i in my_idx:
                a = senses[i]
                for j in senses_by_word[other]:
                    b = senses[j]
                    if a["classes"] and b["classes"] and not (a["classes"] & b["classes"]):
                        continue
                    sc = sense_score(a["tokens"], b["tokens"], weight)
                    if sc > best:
                        best = sc
                        from_sense = a["sense_no"]
                        to_sense = b["sense_no"]
            if best < GLOSS_MIN_SCORE:
                continue
            cands.append((other, best, len(shared_toks), from_sense, to_sense))

        cands.sort(key=lambda c: (-c[1], -c[2], not is_common(entries[c[0]]), int(c[0])))
        for other, score, _count, from_sense, to_sense in cands[:GLOSS_TOP_K]:
            rows.append({
                "kind": "synonym",
                "source": "gloss",
                "from_word": wid,
                "to_word": other,
                "from_sense": from_sense,
                "to_sense": to_sense,
                "score": score,
            })
    return rows


THESAURUS_LINKS = build_thesaurus_links(word_entries())
THESAURUS_LINKS += build_gloss_synonyms(word_entries(), THESAURUS_LINKS)

def render_thesaurus(word, entries, offset=0):
    """Synonyms / Antonyms / Related from the materialized scored relation rows
    (mirrors src/lookup.ts wordThesaurus + src/format.ts renderThesaurus): hits
    ranked by confidence then common-then-id, windowed at [offset, offset+5)
    with a ``… and N more`` note per block (two-line rows: `  text  [reading]`
    then `     gloss`). A section is omitted when empty."""
    def gloss_at(target, sense):
        if sense is not None and 1 <= sense <= len(target["sense"]):
            glosses = [g["text"] for g in target["sense"][sense - 1]["gloss"]]
            if glosses:
                return "; ".join(glosses)
        return first_gloss(target)

    def collect(kind):
        hits = []
        seen = set()
        for r in THESAURUS_LINKS:
            if r["kind"] != kind or r["from_word"] != word["id"] or r["to_word"] in seen:
                continue
            seen.add(r["to_word"])
            target = entries.get(r["to_word"])
            if target is None:
                continue
            hits.append((target, gloss_at(target, r["to_sense"]), r["score"]))
        hits.sort(key=lambda h: (-h[2], not is_common(h[0]), int(h[0]["id"])))
        return hits

    sections = []
    for kind, header in (("synonym", "Synonyms:"), ("antonym", "Antonyms:"), ("related", "Related:")):
        hits = collect(kind)
        shown = hits[offset:offset + 5]
        if not shown:
            continue
        if sections:
            sections.append("")
        sections.append(header)
        for target, gloss, _score in shown:
            text, reading, _ = display_header(target)
            sections.append("  %s  [%s]" % (text, reading or ""))
            sections.append("     %s" % gloss)
        if len(hits) > offset + len(shown):
            sections.append("  … and %d more" % (len(hits) - (offset + len(shown))))
    return "\n".join(sections) + "\n" if sections else ""

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
    lines.append("Meanings:")
    lines.append("     " + "; ".join(meanings))
    lines.append("")
    comps = COMPOUNDS.get(lit, [])
    if comps:
        lines.append("Compounds:")
        for wid, writing, fg, gloss in comps[:max_compounds]:
            lines.append("  %s  [%s]" % (writing, fg))
            lines.append("     %s" % gloss)
        if len(comps) > max_compounds:
            lines.append("  … and %d more" % (len(comps) - max_compounds))
    return "\n".join(lines) + "\n"

# Default per-section row cap for `search` (mirrors format.ts SEARCH_MAX_DEFAULT).
SEARCH_MAX = 30

def render_search(query, sections, offset=0, max_n=SEARCH_MAX):
    """Sectioned `search` output: query echo, then each non-empty ranked
    section (`Readings (N):` / `Meanings (N):` / `Kanji (N):`) with rows
    windowed at [offset, offset+max_n) and a remainder note counting what is
    left past the whole window. Mirrors src/format.ts renderSearch (plain
    text — bolding is a terminal-only concern in the TS formatter)."""
    lines = [query, ""]
    emitted = False
    for header, rows in sections:
        if not rows:
            continue
        if emitted:
            lines.append("")
        lines.append("%s (%d):" % (header, len(rows)))
        shown = rows[offset:offset + max_n]
        for row in shown:
            lines.append(row)
        if len(rows) > offset + len(shown):
            lines.append("  … and %d more" % (len(rows) - (offset + len(shown))))
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

    def word_out(eid, limit=None, offset=0):
        """Word body + thesaurus section (when the word has synonyms/antonyms),
        with each thesaurus window starting `offset` rows in."""
        body = render_word(w(eid), limit=limit)
        thes = render_thesaurus(w(eid), entries, offset)
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
    # --offset thesaurus paging: synthetic 9000201 ("ぺーじんぐ") carries 7
    # related + 8 antonym links, so offset 1 shows a mid-list window (5 rows
    # + a per-block ``… and N more`` note), offset 5 the tail (2/3 rows, no
    # note), and offset 8 an empty window past the end (the whole thesaurus
    # section is dropped).
    write("word-paging-offset1.txt", word_out("9000201", offset=1))
    write("word-paging-offset5.txt", word_out("9000201", offset=5))
    write("word-paging-offset8.txt", word_out("9000201", offset=8))

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
        return ["  %s  [%s]\n     %s" % (r[0], r[1], r[2]) for r in rows]

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
        return ["  %s  [%s (%s)]\n     %s" % (r[6], r[0], r[1], r[2]) for r in cands]

    def search_sections(read_rows, mean_rows, kanji):
        sections = []
        if read_rows:
            sections.append(("Readings", read_rows))
        if mean_rows:
            sections.append(("Meanings", mean_rows))
        if kanji:
            sections.append(("Kanji", ["  %s  [%s]\n     %s" % (lit, "  ".join(rs), "; ".join(ms)) for lit, rs, ms in kanji]))
        return sections

    write("search-eat.txt", render_search("eat", search_sections([], meaning_rows("eat"), kanji_reading_hits("eat", False))))
    write("search-taberu.txt", render_search("たべ", search_sections(reading_rows("たべ", True), [], kanji_reading_hits("たべ", True))))
    write("search-taberu-romaji.txt", render_search("taberu", search_sections(reading_rows("taberu", False), meaning_rows("taberu"), kanji_reading_hits("taberu", False))))
    # --offset paging goldens: an empty window past the end of a small
    # section (no negative note, header intact) and a mid-list window with
    # the remainder note (search to → 12 meaning hits in the fixtures).
    write("search-eat-offset5.txt", render_search("eat", search_sections([], meaning_rows("eat"), kanji_reading_hits("eat", False)), offset=5))
    write("search-to-offset1-max5.txt", render_search("to", search_sections([], meaning_rows("to"), kanji_reading_hits("to", False)), offset=1, max_n=5))

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
