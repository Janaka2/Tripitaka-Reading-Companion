#!/usr/bin/env bash
# Sync both HTML pages with the sutta_*.txt files currently in
# tripitaka_summaries/. Run this whenever new summaries are added.
#
# Usage:  ./sync_html.sh

set -e
cd "$(dirname "$0")"

python3 update_sangraha.py
python3 update_reading_page.py
