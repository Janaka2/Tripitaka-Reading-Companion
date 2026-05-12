#!/usr/bin/env python3
"""
Sync tripitaka_summaries/sutta-sangraha.html with the sutta_*.txt files
currently in tripitaka_summaries/.

Reads every sutta_*.txt in the folder, builds a fresh SUTTAS JS array, and
replaces the existing one inside the HTML. Run this any time after dropping
new summary files into the folder.

Usage:  python3 update_sangraha.py
"""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SUMMARY_DIR = ROOT / "tripitaka_summaries"
HTML = SUMMARY_DIR / "sutta-sangraha.html"
VAR_DECL = "const SUTTAS = ["
VAR_NAME = "const SUTTAS"

FIELDS = {
    "Sutta ID": "id",
    "URL": "url",
    "Title": "title",
    "Key insight": "keyInsight",
    "Summary": "summary",
    "Key terms": "keyTerms",
    "Reflect": "reflect",
    "Read time": "readTime",
}


def parse_txt(path):
    data = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip() or ":" not in raw:
            continue
        label, _, value = raw.partition(":")
        key = FIELDS.get(label.strip())
        if not key:
            continue
        data[key] = value.strip()
    if "id" not in data:
        return None
    try:
        data["id"] = int(data["id"])
    except ValueError:
        return None
    # Fill any missing fields so the JS shape is stable.
    for js_key in FIELDS.values():
        data.setdefault(js_key, "" if js_key != "id" else 0)
    return data


def section_sort_key(s):
    """Sort by section prefix (numeric tuple), then by id."""
    m = re.match(r"^([\d.]+)\.\s", s["title"])
    if m:
        parts = tuple(int(p) for p in m.group(1).split(".") if p.isdigit())
    else:
        parts = (9999,)
    return (parts, s["id"])


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
        raise SystemExit("could not find end of SUTTAS array")
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
    suttas.sort(key=section_sort_key)

    html = HTML.read_text(encoding="utf-8")
    updated = replace_block(html, VAR_DECL, build_js_array(suttas))
    HTML.write_text(updated, encoding="utf-8")
    print(f"Wrote {len(suttas)} suttas into {HTML.relative_to(ROOT)}"
          + (f" (skipped {skipped} unparseable)" if skipped else ""))


if __name__ == "__main__":
    main()
