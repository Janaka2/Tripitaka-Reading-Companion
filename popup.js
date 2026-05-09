const KEY = "trc_pages";

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function countToday(pages) {
  const today = todayIsoDate();
  return Object.values(pages).filter((p) => p.lastReadAt?.startsWith(today)).length;
}

function renderText(id, text) {
  document.getElementById(id).textContent = text;
}

async function render() {
  const { trc_pages = {}, trc_last_page } = await chrome.storage.local.get([KEY, "trc_last_page"]);
  const pages = Object.values(trc_pages).sort((a, b) => (a.lastReadAt < b.lastReadAt ? 1 : -1));

  const completed = pages.filter((p) => p.status === "COMPLETED").length;
  const started = pages.filter((p) => p.status === "STARTED").length;

  renderText("today", `Today: opened ${countToday(trc_pages)} page(s) · Completed ${completed} · Started ${started}`);

  const current = trc_last_page ? trc_pages[trc_last_page] : null;
  renderText(
    "current",
    current
      ? `Current page: ${current.title} (${current.scrollPercent || 0}%)`
      : "No reading page tracked yet."
  );

  const list = document.getElementById("recentList");
  list.innerHTML = "";
  pages.slice(0, 5).forEach((p) => {
    const li = document.createElement("li");
    li.textContent = `${p.title} — ${p.scrollPercent || 0}%`;
    list.appendChild(li);
  });

  document.getElementById("continueBtn").onclick = () => {
    if (trc_last_page) {
      chrome.tabs.create({ url: trc_last_page });
    }
  };
}

render();
