# Tripitaka Reading Companion

A privacy-first Chrome extension MVP to track reading progress on [Tripitaka.Online](https://tripitaka.online/).

## MVP features
- Auto-detect current Tripitaka page (URL + title)
- Save scroll percentage and last read timestamp
- Track basic status model (`STARTED`, extendable to `COMPLETED`/`READ_LATER`)
- Continue last reading page from popup
- Show quick dashboard for today's activity and recently read pages

## Tech stack
- Chrome Extension Manifest V3
- Plain JavaScript, HTML, CSS
- `chrome.storage.local` for local-only persistence

## Local development
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this repository folder
5. Open `https://tripitaka.online/` and start reading

## Data model (current shape)
```json
{
  "pageUrl": "https://tripitaka.online/sutta/206",
  "title": "Page title",
  "status": "STARTED",
  "scrollPercent": 47,
  "lastReadAt": "2026-05-09T10:30:00.000Z",
  "completedAt": null,
  "notes": [],
  "readCount": 2
}
```

## Roadmap
- Add status controls: Completed / Read later
- Add per-page notes and daily reflection prompt
- Add streak + calendar view
- Add JSON export/import
