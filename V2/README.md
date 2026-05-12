# Tripitaka Reading Tracker

A Chrome extension that tracks your reading on **tripitaka.online** so you never lose track of which suttas you've finished — and never accidentally re-read the same one.

## What it does

- **Floating sidebar** on every tripitaka.online page showing your current sutta and overall progress
- **Two-tier tracking**: auto-detects when you've *read* a sutta (scrolled to ~80% or 45 seconds focused), and lets you manually mark *studied* once you've understood it
- **One-line summaries** in your own words — write what struck you, optionally seeded by an AI suggestion
- **Spaced re-reading**: studied suttas get scheduled for review at 1 → 3 → 7 → 21 → 60 → 180 day intervals
- **Per-Nikāya progress bars** so you see "12 / 34 in Dīgha" instead of a lonely "12 / 17,000"
- **Search** across all suttas you've read by title or summary
- **Chrome profile sync** for reading progress across browsers where you use the same Chrome login
- **Export / import** your data as JSON — your reading log is yours

## Install

1. Download/clone this folder to your computer
2. Open Chrome → `chrome://extensions`
3. Toggle **Developer mode** (top right)
4. Click **Load unpacked** → pick the `tripitaka-tracker` folder
5. Pin the extension to the toolbar (puzzle-piece icon → pin)

The first time you open https://tripitaka.online/ you'll see the sidebar in the top right.

## Sync across your Chrome login

Reading progress is stored in `chrome.storage.sync`, not `chrome.storage.local`. That means your read/studied status and summaries can sync to other Chrome browsers where:

1. You are signed in with the same Chrome profile
2. Chrome Sync is enabled
3. The extension has the same extension ID

For a local unpacked extension, the safest long-term option is to publish it as **Unlisted** in the Chrome Web Store and install it from the same link everywhere. During development, keep the same extension folder and extension ID where possible.

When you install this updated version, old data from `chrome.storage.local` is copied into Chrome sync one time. The old local data is not deleted, so it remains as a backup.

Important: Chrome sync storage is small. It is good for progress, status, dates, and short summaries. It is not suitable for very long notes, large question histories, PDFs, or images. For that, use Firebase, Supabase, or your own Spring Boot backend later.

## Configure AI suggestions (optional)

The "✨ Suggest" button in the sidebar can call any OpenAI-compatible endpoint to draft a one-line summary you then edit.

1. Click the extension icon → **Settings**
2. Paste your endpoint URL, API key, and model name
3. Save

Your key is stored only in this browser (`chrome.storage.local`) and is not synced to other devices. Nothing leaves your machine except the request to the endpoint you configured. You can also leave this empty and write summaries entirely by hand — that's actually the better learning approach.

## The learning strategy this is built around

This is not just a checkbox app. The design encodes some specific learning principles:

### Why two tiers (read vs studied)

"Read it" and "got it" are different states. Auto-marking on scroll captures *exposure* — useful for "have I seen this before?" — but doesn't claim understanding. The manual "Studied" click is the moment you commit: yes, I followed this teaching, yes, I could explain the gist. Only studied suttas enter the spaced-review schedule.

### Why you write the summary, not the AI

The act of compressing a sutta into one sentence in your own words is the actual learning. If the AI writes it for you, you'll have a record but no memory. The plugin defaults to a blank box; the AI suggestion is a backstop for when you're stuck or want to check yourself, not a shortcut. Edit anything the AI gives you — make it your own phrase.

### Why spaced re-reading rather than "never again"

Suttas are not one-and-done. The Buddha's teachings are explicitly designed to be re-encountered as your understanding deepens — the same words mean different things at different stages of practice. The schedule (1, 3, 7, 21, 60, 180 days) is rough Ebbinghaus spacing: short intervals to consolidate, longer intervals to retain. When a sutta surfaces in "Due for review", read it again and re-mark studied. The interval extends.

### Why per-Nikāya, not just total

Total progress (5 / ~17,000) is meaningless and demoralizing. Per-section progress is concrete: "I've read 12 of 34 in Dīgha — 35%, more than a third!" Pick a Nikāya, work through it, see the bar fill. The Dīgha is small enough to finish; that's where most readers benefit from starting.

### Suggested reading orders

- **Beginner**: Dīgha Nikāya (34 long discourses, narrative, accessible) → Majjhima Nikāya (152 medium, doctrinal heart of the canon)
- **For breadth**: Dhammapada (in Khuddaka) → key Dīgha (DN 16, 22) → key Majjhima → topical sweeps in Saṃyutta
- **For depth**: pick one Saṃyutta or Aṅguttara nipāta and finish it before moving on — Saṃyutta and Aṅguttara are vast and lend themselves to thematic dives, not linear reading

## Files

```
manifest.json    Chrome MV3 manifest
content.js       Runs on tripitaka.online — sidebar, scroll detection, AI suggest
sidebar.css      Styles for the floating sidebar
popup.html/js/css  Full dashboard (click extension icon)
storage.js       Shared data model (kept for reference; content.js inlines it)
icons/           PNG icons (16, 48, 128)
```

## Notes on accuracy

- **Nikāya detection** uses a heuristic on the section code (e.g. `5.3.5.8.` → Aṅguttara). The mapping in `content.js` (function `detectNikaya`) is a best guess and may need correcting once you've used the extension on a few suttas across each Nikāya. If progress bars are landing in the wrong section, edit the `map` object in `content.js` and reload the extension.
- **Total counts per Nikāya** (in `popup.js` and `storage.js`) follow the Sinhalese / Buddha Jayanthi tradition (Saṃyutta = 7,656; Aṅguttara = 9,557). If tripitaka.online uses different totals, edit `NIKAYA_TOTALS` to match.

## Privacy

Reading progress is stored in Chrome sync storage so it can follow your Chrome login. No analytics, no telemetry, no remote server. AI settings/API keys stay local to the browser where you entered them. AI requests go directly from your browser to the endpoint you configure (if any).
