#!/bin/bash

set -u

START_ID="${1:-1}"
END_ID="${2:-20000}"

OUT_DIR="tripitaka_summaries"
LOG_FILE="$OUT_DIR/run.log"
INDEX_FILE="$OUT_DIR/index.tsv"

LM_ENDPOINT="${LM_ENDPOINT:-http://127.0.0.1:1234/v1/chat/completions}"
LM_MODEL="${LM_MODEL:-google/gemma-4-e4b}"
LM_API_KEY="${LM_API_KEY:-lm-studio}"

MAX_LLM_CHARS="${MAX_LLM_CHARS:-6000}"
DELAY_SECONDS="${DELAY_SECONDS:-1}"

mkdir -p "$OUT_DIR"

echo "Starting Tripitaka summary job"
echo "Range: $START_ID to $END_ID"
echo "Output: $OUT_DIR"
echo "LM endpoint: $LM_ENDPOINT"
echo "LM model: $LM_MODEL"
echo ""

if [ ! -d ".venv_tripitaka" ]; then
  echo "Creating Python virtual environment..."
  python3 -m venv .venv_tripitaka
fi

source .venv_tripitaka/bin/activate

python - <<'PY'
import importlib.util
import subprocess
import sys

packages = {
    "playwright": "playwright",
    "requests": "requests"
}

missing = []
for import_name, package_name in packages.items():
    if importlib.util.find_spec(import_name) is None:
        missing.append(package_name)

if missing:
    subprocess.check_call([sys.executable, "-m", "pip", "install", *missing])

subprocess.call([sys.executable, "-m", "playwright", "install", "chromium"])
PY

cat > .tripitaka_worker.py <<'PY'
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path

import requests
from playwright.async_api import async_playwright


START_ID = int(os.environ.get("START_ID", "1"))
END_ID = int(os.environ.get("END_ID", "20000"))

OUT_DIR = Path(os.environ.get("OUT_DIR", "tripitaka_summaries"))
LOG_FILE = OUT_DIR / "run.log"
INDEX_FILE = OUT_DIR / "index.tsv"

LM_ENDPOINT = os.environ.get("LM_ENDPOINT", "http://127.0.0.1:1234/v1/chat/completions")
LM_MODEL = os.environ.get("LM_MODEL", "google/gemma-4-e4b")
LM_API_KEY = os.environ.get("LM_API_KEY", "lm-studio")

MAX_LLM_CHARS = int(os.environ.get("MAX_LLM_CHARS", "6000"))
DELAY_SECONDS = float(os.environ.get("DELAY_SECONDS", "1"))

OUT_DIR.mkdir(exist_ok=True)


def log(message: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    print(line, flush=True)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def clean_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def clean_summary(raw: str) -> str:
    text = clean_spaces(raw)
    text = re.sub(r'^[-•*\d.)\s]+', '', text)
    text = re.sub(r'^[\'"“”‘’`]+|[\'"“”‘’`.,!?]+$', '', text)
    return text.strip()


def limit_words(text: str, max_words: int = 45) -> str:
    words = text.split()
    if len(words) > max_words:
        return " ".join(words[:max_words])
    return text


def prepare_llm_text(full_text: str) -> str:
    if len(full_text) <= MAX_LLM_CHARS:
        return full_text

    half = MAX_LLM_CHARS // 2
    return full_text[:half] + "\n\n...\n\n" + full_text[-half:]


def extract_json_summary(content: str) -> str:
    if not content:
        return ""

    content = content.strip()

    try:
        parsed = json.loads(content)
        if isinstance(parsed, dict) and isinstance(parsed.get("summary"), str):
            return clean_summary(parsed["summary"])
    except Exception:
        pass

    match = re.search(r'\{[\s\S]*?"summary"\s*:\s*"([\s\S]*?)"[\s\S]*?\}', content)
    if match:
        return clean_summary(match.group(1).replace('\\"', '"'))

    return clean_summary(content)


def call_llm(article_text: str) -> str:
    prompt = f"""Write one Sinhala study note from the sutta text below.
Target length: about 90–100 words (never more than 100).

Shape it so a reader can digest it in one calm read:
1. One short opening sentence giving the setting or who speaks.
2. Two to three sentences explaining the central teaching in plain Sinhala.
3. One closing sentence giving the practical lesson or reflection the sutta invites.

Strict rules:
- Use only the given sutta text. No outside knowledge, no commentary, no imagination, no inference beyond the text.
- Sinhala only. No title. No bullet points. No numbering in the output.
- Flowing prose, calm and clear tone.
- Return only JSON in the exact form: {{"summary":"..."}}

Sutta text:
{article_text}
"""

    payload = {
        "model": LM_MODEL,
        "messages": [
            {
                "role": "system",
                "content": "Return only valid JSON. Use only the provided sutta text. Do not infer, imagine, explain, or add outside knowledge. Do not output reasoning."
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "sutta_summary",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {
                        "summary": {"type": "string"}
                    },
                    "required": ["summary"],
                    "additionalProperties": False
                }
            }
        },
        "max_tokens": 800,
        "temperature": 0
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {LM_API_KEY}"
    }

    try:
        resp = requests.post(LM_ENDPOINT, headers=headers, json=payload, timeout=180)
    except Exception as e:
        raise RuntimeError(f"LLM connection failed: {e}")

    # Fallback for local servers that do not support json_schema.
    if resp.status_code >= 400:
        payload.pop("response_format", None)
        resp = requests.post(LM_ENDPOINT, headers=headers, json=payload, timeout=180)

    if resp.status_code >= 400:
        raise RuntimeError(f"LLM HTTP {resp.status_code}: {resp.text[:500]}")

    data = resp.json()
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}

    content = message.get("content") or choice.get("text") or ""
    summary = extract_json_summary(content)

    # Never save reasoning_content as the final summary.
    if not summary and message.get("reasoning_content"):
        raise RuntimeError("Model returned reasoning but no final summary. Use a non-thinking instruct model or increase max_tokens.")

    return limit_words(summary, 110)


async def extract_sutta(page, sutta_id: int):
    url = f"https://tripitaka.online/sutta/{sutta_id}"

    await page.goto(url, wait_until="networkidle", timeout=45000)

    try:
        await page.wait_for_selector("app-sutta .sinhala-text, app-sutta h1.sutta-title", timeout=12000)
    except Exception:
        pass

    data = await page.evaluate("""
() => {
  function clean(s) {
    return String(s || '').replace(/\\s+/g, ' ').trim();
  }

  // Read only real sutta titles from the sutta component
  const titleEls = Array.from(document.querySelectorAll(
    'app-sutta h1.sutta-title, app-sutta h2.sutta-title, app-sutta h3.sutta-title'
  ))
    .map(el => clean(el.innerText))
    .filter(Boolean);

  const title = titleEls.length ? titleEls[titleEls.length - 1] : '';

  // IMPORTANT:
  // Read ONLY Sinhala text blocks.
  // Ignore Pali blocks: .pali-text, .pali-gatha
  const sinhalaEls = Array.from(document.querySelectorAll(
    'app-sutta .sinhala-text'
  ));

  const sinhalaText = sinhalaEls
    .map(el => clean(el.innerText))
    .filter(Boolean)
    .join(' ');

  return {
    title,
    text: sinhalaText,
    titleCount: titleEls.length,
    sinhalaBlockCount: sinhalaEls.length
  };
}
""")

    title = clean_spaces(data.get("title", ""))
    text = clean_spaces(data.get("text", ""))
    title_count = int(data.get("titleCount") or 0)
    sinhala_block_count = int(data.get("sinhalaBlockCount") or 0)

    # Skip unavailable / empty pages.
    if title_count == 0:
        log(f"SKIP empty sutta/{sutta_id}: no real sutta title")
        return None

    if sinhala_block_count == 0:
        log(f"SKIP empty sutta/{sutta_id}: no Sinhala text blocks")
        return None

    if len(text) < 50:
        log(f"SKIP empty sutta/{sutta_id}: Sinhala text too short chars={len(text)}")
        return None

    return {
        "id": sutta_id,
        "url": url,
        "title": title,
        "text": text
    }


def write_result(sutta_id: int, url: str, title: str, summary: str) -> None:
    out_file = OUT_DIR / f"sutta_{sutta_id:05d}.txt"

    with out_file.open("w", encoding="utf-8") as f:
        f.write(f"Sutta ID: {sutta_id}\n")
        f.write(f"URL: {url}\n")
        f.write(f"Title: {title}\n")
        f.write(f"Summary: {summary}\n")

    is_new_index = not INDEX_FILE.exists()
    with INDEX_FILE.open("a", encoding="utf-8") as f:
        if is_new_index:
            f.write("id\turl\ttitle\tsummary\n")
        safe_title = title.replace("\t", " ").replace("\n", " ")
        safe_summary = summary.replace("\t", " ").replace("\n", " ")
        f.write(f"{sutta_id}\t{url}\t{safe_title}\t{safe_summary}\n")


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()

        for sutta_id in range(START_ID, END_ID + 1):
            out_file = OUT_DIR / f"sutta_{sutta_id:05d}.txt"

            if out_file.exists():
                log(f"SKIP existing sutta/{sutta_id}")
                continue

            try:
                sutta = await extract_sutta(page, sutta_id)

                if not sutta:
                    log(f"SKIP unavailable or empty sutta/{sutta_id}")
                    continue

                full_text = sutta["text"]
                llm_text = prepare_llm_text(full_text)

                log(f"READ sutta/{sutta_id} title='{sutta['title']}' chars={len(full_text)} sent={len(llm_text)}")

                summary = call_llm(llm_text)

                if not summary:
                    log(f"SKIP no summary sutta/{sutta_id}")
                    continue

                write_result(
                    sutta_id=sutta_id,
                    url=sutta["url"],
                    title=sutta["title"],
                    summary=summary
                )

                log(f"SAVED sutta/{sutta_id}: {summary}")

            except Exception as e:
                log(f"ERROR sutta/{sutta_id}: {e}")
                continue

            await asyncio.sleep(DELAY_SECONDS)

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
PY

START_ID="$START_ID" \
END_ID="$END_ID" \
OUT_DIR="$OUT_DIR" \
LOG_FILE="$LOG_FILE" \
INDEX_FILE="$INDEX_FILE" \
LM_ENDPOINT="$LM_ENDPOINT" \
LM_MODEL="$LM_MODEL" \
LM_API_KEY="$LM_API_KEY" \
MAX_LLM_CHARS="$MAX_LLM_CHARS" \
DELAY_SECONDS="$DELAY_SECONDS" \
python .tripitaka_worker.py


