#!/usr/bin/env python3
"""
Sync tripitaka_summaries/sutta_summary_reading_page.html with the sutta_*.txt
files currently in tripitaka_summaries/.

Reads every sutta_*.txt in the folder, builds a fresh baseSuttas JS array
(reading-page shape: insight/time/terms-as-name-list), and replaces the
existing one inside the HTML. Run this any time after dropping new summary
files into the folder.

Usage:  python3 update_reading_page.py
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SUMMARY_DIR = ROOT / "tripitaka_summaries"
HTML = SUMMARY_DIR / "sutta_summary_reading_page.html"
VAR_DECL = "const baseSuttas = ["
VAR_NAME = "const baseSuttas"

# The reading page uses slightly different field names than the .txt file
# labels — we capture the .txt values then re-map to the JS shape below.
TXT_FIELDS = {
    "Sutta ID": "id",
    "URL": "url",
    "Title": "title",
    "Key insight": "_insight",
    "Summary": "summary",
    "Key terms": "_terms_raw",
    "Reflect": "reflect",
    "Read time": "_time",
}


def split_terms(raw):
    """Split a 'Key terms' string into a list of just the term names.

    Supports both ' | ' (TSV-style) and ', '-with-dash-lookahead (.txt style).
    """
    if not raw:
        return []
    parts = raw.split("|") if "|" in raw else re.split(r",\s*(?=[^—]*—)", raw)
    terms = []
    for p in parts:
        term = p.split("—", 1)[0].strip()
        if term:
            terms.append(term)
    return terms


def parse_txt(path):
    raw = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or ":" not in line:
            continue
        label, _, value = line.partition(":")
        key = TXT_FIELDS.get(label.strip())
        if not key:
            continue
        raw[key] = value.strip()
    if "id" not in raw:
        return None
    try:
        sutta_id = int(raw["id"])
    except ValueError:
        return None
    time_str = raw.get("_time") or "~45s"
    return {
        "id": sutta_id,
        "url": raw.get("url", "") or f"https://tripitaka.online/sutta/{sutta_id}",
        "title": raw.get("title", ""),
        "insight": raw.get("_insight", ""),
        "summary": raw.get("summary", ""),
        "terms": split_terms(raw.get("_terms_raw", "")),
        "reflect": raw.get("reflect", ""),
        "time": time_str,
    }


def build_js_array(suttas):
    body = json.dumps(suttas, ensure_ascii=False, indent=2)
    return f"{VAR_NAME} = " + body + ";"


def replace_block(text, var_decl, new_block):
    start = text.find(var_decl)
    if start < 0:
        raise SystemExit(f"could not find {var_decl!r} in {HTML.name}")
    i = start + len(var_decl) - 1  # land on the '['
    depth = 0
    end = -1
    in_str = False
    esc = False
    while i < len(text):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        i += 1
    if end < 0:
        raise SystemExit("could not find end of baseSuttas array")
    if end < len(text) and text[end] == ";":
        end += 1
    return text[:start] + new_block + text[end:]


def main():
    files = sorted(SUMMARY_DIR.glob("sutta_*.txt"))
    suttas = []
    skipped = 0
    for p in files:
        rec = parse_txt(p)
        if rec is None:
            skipped += 1
            continue
        suttas.append(rec)
    # Reading page lists newest id first.
    suttas.sort(key=lambda s: -s["id"])

    html = HTML.read_text(encoding="utf-8")
    updated = replace_block(html, VAR_DECL, build_js_array(suttas))
    HTML.write_text(updated, encoding="utf-8")
    print(f"Wrote {len(suttas)} suttas into {HTML.relative_to(ROOT)}"
          + (f" (skipped {skipped} unparseable)" if skipped else ""))


if __name__ == "__main__":
    main()
