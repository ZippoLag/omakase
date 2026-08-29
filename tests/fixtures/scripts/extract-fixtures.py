#!/usr/bin/env python3
"""Re-extract fixture entries from the pinned jmdict-simplified release.

Usage: python3 tests/fixtures/scripts/extract-fixtures.py
Verifies downloads against tests/fixtures/manifest.json sha256 before writing.
"""
import hashlib
import io
import json
import os
import tarfile
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRIES = os.path.join(BASE, "entries")


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def load_json_tgz(data):
    tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
    return json.load(tf.extractfile(tf.getmembers()[0]))


def save(name, obj):
    with open(os.path.join(ENTRIES, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def main():
    os.makedirs(ENTRIES, exist_ok=True)
    with open(os.path.join(BASE, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    tag = manifest["release"]
    rel = json.loads(get("https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest"))
    if rel["tag_name"] != manifest["release"]:
        raise SystemExit(
            "upstream moved to %s; update manifest.json (or pin --allow-new) "
            "before regenerating fixtures" % rel["tag_name"]
        )

    # verify all downloads against manifest sha256
    blobs = {}
    for asset, want in manifest["files"].items():
        url = next(a["browser_download_url"] for a in rel["assets"] if a["name"] == asset)
        data = get(url)
        got = hashlib.sha256(data).hexdigest()
        if got != want:
            raise SystemExit("sha256 mismatch for %s: %s" % (asset, got))
        blobs[asset] = data
    print("downloads verified against manifest:", ", ".join(manifest["files"]))

    jmdict = load_json_tgz(blobs["jmdict-eng-%s.json.tgz" % tag])
    kanjidic2 = load_json_tgz(blobs["kanjidic2-en-%s.json.tgz" % tag])
    krad = load_json_tgz(blobs["kradfile-%s.json.tgz" % tag])
    radk = load_json_tgz(blobs["radkfile-%s.json.tgz" % tag])

    # ---- JMdict entries (by kanji text, or kana text when kanji absent) ----
    def find_jmdict(k):
        return [
            w for w in jmdict["words"]
            if k in [x["text"] for x in w.get("kanji", [])]
            or (k in [x["text"] for x in w.get("kana", [])] and not w.get("kanji"))
        ]

    word_spec = {
        "jmdict-1358280-taberu.json": "食べる",
        "jmdict-1547720-kuru.json": "来る",
        "jmdict-1605820-yoi.json": "良い",
        "jmdict-1358340-tabemono.json": "食べ物",
        "jmdict-1358490-shokuji.json": "食事",
        "jmdict-1591900-kirei.json": "綺麗",
        "jmdict-1343460-atsui.json": "暑い",
        "jmdict-1169870-nomu.json": "飲む",
        "jmdict-1592100-kuu.json": "食う",
        "jmdict-1296400-aru.json": "有る",
        "jmdict-1609650-kanzuru.json": "感ずる",
    }
    for name, k in word_spec.items():
        matches = find_jmdict(k)
        assert len(matches) == 1, (name, k, [w["id"] for w in matches])
        save(name, matches[0])

    # kana-only entries
    for name, k in [("jmdict-suru.json", "する"), ("jmdict-ii.json", "いい")]:
        matches = [
            w for w in jmdict["words"]
            if k in [x["text"] for x in w.get("kana", [])]
            and any(x.get("common") for x in w.get("kana", []))
        ]
        assert matches, (name, k)
        # suru: prefer the 為る entry (id 1157170); ii: the kana-only adj-ix entry
        pick = next((w for w in matches if w["id"] == "1157170"), matches[0]) if name == "jmdict-suru.json" else matches[0]
        save(name, pick)

    # ---- KANJIDIC2 entries ----
    kanji_map = {c["literal"]: c for c in kanjidic2["characters"]}
    for lit, name in [
        ("食", "kanjidic2-shoku.json"), ("水", "kanjidic2-mizu.json"), ("飲", "kanjidic2-nomu.json"),
        ("見", "kanjidic2-miru.json"), ("行", "kanjidic2-iku.json"), ("来", "kanjidic2-kuru.json"),
        ("良", "kanjidic2-ryo.json"), ("暑", "kanjidic2-sho.json"), ("綺", "kanjidic2-ki.json"), ("喰", "kanjidic2-kuu.json"),
    ]:
        save(name, kanji_map[lit])

    # ---- kradfile / radkfile slices ----
    for lit in ["食", "水", "飲", "見", "行", "来", "良", "暑", "綺", "喰"]:
        if lit in krad["kanji"]:
            save("krad-%s.json" % lit, {"literal": lit, "components": krad["kanji"][lit]})
    for rad in ["水", "食", "口"]:
        if rad in radk["radicals"]:
            save("radk-%s.json" % rad, radk["radicals"][rad])

    print("fixtures written to", ENTRIES)


if __name__ == "__main__":
    main()
