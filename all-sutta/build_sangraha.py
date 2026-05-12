#!/usr/bin/env python3
"""
Rebuild the embedded sutta arrays inside the HTML pages from
tripitaka_summaries/index.tsv:

  * sutta-sangraha.html         → const SUTTAS         (full term/meaning format)
  * sutta_summary_reading_page.html → const baseSuttas (terms as string list)

Run this whenever you add new sutta_*.txt files (the shell script writes
index.tsv at the same time, so as long as that's up-to-date the HTML will
pick up everything).

Usage:  python3 build_sangraha.py
"""

import csv
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TSV = ROOT / "tripitaka_summaries" / "index.tsv"
HTML_SANGRAHA = ROOT / "tripitaka_summaries" / "sutta-sangraha.html"
HTML_READING = ROOT / "tripitaka_summaries" / "sutta_summary_reading_page.html"


def load_rows():
    with TSV.open(encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        rows = list(reader)
    if not rows:
        raise SystemExit("index.tsv is empty")
    return rows


def to_sutta_sangraha(row):
    """Shape for sutta-sangraha.html — keeps the full 'term — meaning' string."""
    rt = (row.get("read_time_s") or "").strip()
    read_time = f"~{rt}s" if rt else ""
    return {
        "id": int(row["id"]),
        "title": (row.get("title") or "").strip(),
        "keyInsight": (row.get("key_insight") or "").strip(),
        "summary": (row.get("summary") or "").strip(),
        "keyTerms": (row.get("key_terms") or "").strip(),
        "reflect": (row.get("reflect") or "").strip(),
        "readTime": read_time,
        "url": (row.get("url") or "").strip(),
    }


def to_sutta_reading(row):
    """Shape for sutta_summary_reading_page.html — terms is a list of term names."""
    rt = (row.get("read_time_s") or "").strip()
    time_str = f"~{rt}s" if rt else "~45s"
    raw_terms = (row.get("key_terms") or "").strip()
    if "|" in raw_terms:
        parts = [p.strip() for p in raw_terms.split("|")]
    else:
        parts = [p.strip() for p in re.split(r",\s*(?=[^—]*—)", raw_terms)] if raw_terms else []
    terms = []
    for p in parts:
        if not p:
            continue
        term = p.split("—", 1)[0].strip()
        if term:
            terms.append(term)
    return {
        "id": int(row["id"]),
        "url": (row.get("url") or "").strip(),
        "title": (row.get("title") or "").strip(),
        "insight": (row.get("key_insight") or "").strip(),
        "summary": (row.get("summary") or "").strip(),
        "terms": terms,
        "reflect": (row.get("reflect") or "").strip(),
        "time": time_str,
    }


def sort_key(s):
    """Sort by section prefix (numeric, tuple-wise), then id."""
    m = re.match(r"^([\d.]+)\.\s", s["title"])
    if m:
        parts = tuple(int(p) for p in m.group(1).split(".") if p.isdigit())
    else:
        parts = (9999,)
    return (parts, s["id"])


def build_js_array(var_name, suttas, indent=2):
    body = json.dumps(suttas, ensure_ascii=False, indent=indent)
    return f"{var_name} = " + body + ";"


def replace_block(text, var_decl, new_block):
    """Replace `<var_decl>[ ... ];` block in text with new_block.

    var_decl is the literal prefix like 'const SUTTAS = [' or 'const baseSuttas = ['.
    """
    start = text.find(var_decl)
    if start < 0:
        raise SystemExit(f"could not find {var_decl!r} in HTML")
    prefix_len = len(var_decl) - 1  # land right on the '['
    i = start + prefix_len
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
        raise SystemExit(f"could not find end of array for {var_decl!r}")
    if end < len(text) and text[end] == ";":
        end += 1
    return text[:start] + new_block + text[end:]


def update_file(path, var_decl, var_name, shape_fn, rows, sort_reverse=False):
    suttas = [shape_fn(r) for r in rows]
    if sort_reverse:
        # Reading page lists newest first by id
        suttas.sort(key=lambda s: -int(s["id"]))
    else:
        suttas.sort(key=sort_key)
    new_block = build_js_array(var_name, suttas)
    text = path.read_text(encoding="utf-8")
    updated = replace_block(text, var_decl, new_block)
    path.write_text(updated, encoding="utf-8")
    print(f"Wrote {len(suttas)} suttas into {path.relative_to(ROOT)}")


def main():
    rows = load_rows()
    update_file(
        HTML_SANGRAHA,
        var_decl="const SUTTAS = [",
        var_name="const SUTTAS",
        shape_fn=to_sutta_sangraha,
        rows=rows,
    )
    update_file(
        HTML_READING,
        var_decl="const baseSuttas = [",
        var_name="const baseSuttas",
        shape_fn=to_sutta_reading,
        rows=rows,
        sort_reverse=True,
    )


if __name__ == "__main__":
    main()
