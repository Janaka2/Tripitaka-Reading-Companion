const KEY = "trc_pages";

function getPageRecord() {
  const scrollHeight = document.documentElement.scrollHeight - window.innerHeight;
  const scrollPercent = scrollHeight > 0
    ? Math.round((window.scrollY / scrollHeight) * 100)
    : 0;

  return {
    pageUrl: window.location.href,
    title: document.title || "Untitled",
    status: "STARTED",
    scrollPercent: Math.max(0, Math.min(100, scrollPercent)),
    lastReadAt: new Date().toISOString()
  };
}

async function saveProgress() {
  const record = getPageRecord();
  const storage = await chrome.storage.local.get([KEY, "trc_last_page"]);
  const pages = storage[KEY] || {};
  const existing = pages[record.pageUrl] || {};

  pages[record.pageUrl] = {
    ...existing,
    ...record,
    readCount: (existing.readCount || 0) + 1,
    notes: existing.notes || [],
    completedAt: existing.completedAt || null
  };

  await chrome.storage.local.set({
    [KEY]: pages,
    trc_last_page: record.pageUrl
  });
}

let timeoutId = null;
window.addEventListener("scroll", () => {
  clearTimeout(timeoutId);
  timeoutId = setTimeout(saveProgress, 400);
});

window.addEventListener("beforeunload", saveProgress);
saveProgress();
