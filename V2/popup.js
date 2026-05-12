// popup.js — runs in the extension popup context
// Reading progress is stored in chrome.storage.sync so it follows your Chrome login.
// AI provider settings/API key stay in chrome.storage.local and are not synced.

const LEGACY_KEY = 'tripitaka_progress_v1';
const LOCAL_MIGRATION_FLAG = 'tt_local_to_sync_migrated_v1';
const SUTTA_PREFIX = 'tt_sutta_';

const NIKAYA_TOTALS = {
  digha:     { name: 'Dīgha Nikāya',     total: 34 },
  majjhima:  { name: 'Majjhima Nikāya',  total: 152 },
  samyutta:  { name: 'Saṃyutta Nikāya',  total: 7656 },
  anguttara: { name: 'Aṅguttara Nikāya', total: 9557 },
  khuddaka:  { name: 'Khuddaka Nikāya',  total: 2000 }
};

function keyForSutta(id) {
  return `${SUTTA_PREFIX}${id}`;
}

function idFromSuttaKey(key) {
  return key.startsWith(SUTTA_PREFIX) ? key.slice(SUTTA_PREFIX.length) : null;
}

function storageGet(area, keys) {
  return new Promise((resolve, reject) => {
    area.get(keys, result => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result || {});
    });
  });
}

function storageSet(area, items) {
  return new Promise((resolve, reject) => {
    area.set(items, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function storageRemove(area, keys) {
  return new Promise((resolve, reject) => {
    area.remove(keys, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

async function getAllSyncedSuttas() {
  const all = await storageGet(chrome.storage.sync, null);
  const suttas = {};
  for (const [key, value] of Object.entries(all)) {
    const id = idFromSuttaKey(key);
    if (id && value && typeof value === 'object') {
      suttas[id] = { id, ...value };
    }
  }
  return suttas;
}

async function clearSyncedSuttas() {
  const all = await storageGet(chrome.storage.sync, null);
  const keys = Object.keys(all).filter(k => k.startsWith(SUTTA_PREFIX));
  if (keys.length > 0) await storageRemove(chrome.storage.sync, keys);
}

async function saveSuttasToSync(suttas) {
  const items = {};
  for (const [id, sutta] of Object.entries(suttas || {})) {
    items[keyForSutta(id)] = { ...sutta, id };
  }
  if (Object.keys(items).length > 0) {
    await storageSet(chrome.storage.sync, items);
  }
}

async function migrateLocalToSyncOnce() {
  const flag = await storageGet(chrome.storage.local, [LOCAL_MIGRATION_FLAG]);
  if (flag[LOCAL_MIGRATION_FLAG]) return;

  const legacy = await storageGet(chrome.storage.local, [LEGACY_KEY]);
  const legacyData = legacy[LEGACY_KEY];
  if (legacyData?.suttas && Object.keys(legacyData.suttas).length > 0) {
    const currentSync = await getAllSyncedSuttas();
    const merged = { ...legacyData.suttas, ...currentSync }; // existing sync wins
    await saveSuttasToSync(merged);
  }

  await storageSet(chrome.storage.local, { [LOCAL_MIGRATION_FLAG]: true });
}

async function loadAll() {
  await migrateLocalToSyncOnce();
  return { suttas: await getAllSyncedSuttas(), sessions: [] };
}

async function saveAll(data) {
  await migrateLocalToSyncOnce();
  // Merge/write records into Chrome sync. Do not clear first, so a quota error
  // cannot wipe existing synced progress during import.
  await saveSuttasToSync(data?.suttas || {});
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtRelative(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function showError(err) {
  console.error(err);
  alert('Storage error: ' + err.message + '\n\nIf this happens after many saved suttas or long summaries, Chrome sync storage may be full. Export your data, then consider using a backend database later.');
}

// ---- Tabs ----
function setActiveTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.view').forEach(v => {
    v.classList.toggle('active', v.id === `view-${name}`);
  });
  if (name === 'progress') renderProgress().catch(showError);
  if (name === 'review')   renderReview().catch(showError);
  if (name === 'list')     renderList().catch(showError);
  if (name === 'settings') renderSettings().catch(showError);
}
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => setActiveTab(btn.dataset.tab);
});

// ---- Progress view ----
async function renderProgress() {
  const data = await loadAll();
  const suttas = Object.values(data.suttas);
  const totalRead = suttas.filter(s => s.status === 'read' || s.status === 'studied').length;
  const totalStudied = suttas.filter(s => s.status === 'studied').length;
  const totalAll = Object.values(NIKAYA_TOTALS).reduce((a, b) => a + b.total, 0);
  const pct = totalAll ? ((totalRead / totalAll) * 100).toFixed(1) : 0;

  document.getElementById('overall-read').textContent = totalRead.toLocaleString();
  document.getElementById('overall-studied').textContent = totalStudied.toLocaleString();
  document.getElementById('overall-pct').textContent = pct + '%';

  const byNikaya = {};
  for (const [code, info] of Object.entries(NIKAYA_TOTALS)) {
    byNikaya[code] = { ...info, code, read: 0, studied: 0 };
  }
  for (const s of suttas) {
    const n = byNikaya[s.nikaya];
    if (!n) continue;
    if (s.status === 'read') n.read += 1;
    if (s.status === 'studied') n.studied += 1;
  }

  const list = document.getElementById('nikaya-list');
  list.innerHTML = Object.values(byNikaya).map(n => {
    const totalDone = n.read + n.studied;
    const readPct = n.total ? (n.read / n.total) * 100 : 0;
    const studiedPct = n.total ? (n.studied / n.total) * 100 : 0;
    return `
      <div class="nikaya-row">
        <div class="nikaya-row-header">
          <span class="nikaya-name">${n.name}</span>
          <span class="nikaya-counts">${totalDone} / ${n.total.toLocaleString()} · ${((totalDone / n.total) * 100).toFixed(1)}%</span>
        </div>
        <div class="bar">
          <div class="bar-studied" style="width: ${studiedPct}%"></div>
          <div class="bar-read"    style="width: ${readPct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ---- Review view ----
async function renderReview() {
  const data = await loadAll();
  const now = Date.now();
  const due = Object.values(data.suttas)
    .filter(s => s.status === 'studied' && s.nextReviewAt && s.nextReviewAt <= now)
    .sort((a, b) => a.nextReviewAt - b.nextReviewAt);

  const upcoming = Object.values(data.suttas)
    .filter(s => s.status === 'studied' && s.nextReviewAt && s.nextReviewAt > now)
    .sort((a, b) => a.nextReviewAt - b.nextReviewAt)
    .slice(0, 5);

  const list = document.getElementById('review-list');
  if (due.length === 0 && upcoming.length === 0) {
    list.innerHTML = '<div class="empty">Mark suttas as "studied" on the site to schedule reviews.</div>';
    return;
  }

  let html = '';
  if (due.length > 0) {
    html += `<div style="font-size:11px; text-transform:uppercase; color:#b22; font-weight:500; margin-bottom:6px;">Due now (${due.length})</div>`;
    html += due.map(s => entryHtml(s, 'due')).join('');
  }
  if (upcoming.length > 0) {
    html += `<div style="font-size:11px; text-transform:uppercase; color:#888; font-weight:500; margin: 14px 0 6px;">Upcoming</div>`;
    html += upcoming.map(s => entryHtml(s, 'upcoming')).join('');
  }
  list.innerHTML = html;
  attachEntryClicks();
}

function entryHtml(s, mode) {
  const meta = mode === 'due'
    ? `Due ${fmtRelative(s.nextReviewAt)} · ${s.reviewCount}× reviewed`
    : mode === 'upcoming'
    ? `In ${Math.ceil((s.nextReviewAt - Date.now()) / 86400000)}d · ${s.reviewCount}× reviewed`
    : `Read ${fmtRelative(s.lastReadAt)}`;
  return `
    <a class="entry entry-status-${s.status}" data-id="${s.id}" href="#">
      <div class="entry-title">${escapeHtml(s.title || 'Sutta ' + s.id)}</div>
      <div class="entry-meta">${meta}</div>
      ${s.summary ? `<div class="entry-summary">${escapeHtml(s.summary)}</div>` : ''}
    </a>
  `;
}

function attachEntryClicks() {
  document.querySelectorAll('.entry[data-id]').forEach(a => {
    a.onclick = (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: `https://tripitaka.online/sutta/${a.dataset.id}` });
    };
  });
}

// ---- List view ----
async function renderList(filter = '') {
  const data = await loadAll();
  const all = Object.values(data.suttas)
    .filter(s => s.lastReadAt)
    .sort((a, b) => b.lastReadAt - a.lastReadAt);

  const f = filter.toLowerCase().trim();
  const filtered = f
    ? all.filter(s =>
        (s.title || '').toLowerCase().includes(f) ||
        (s.summary || '').toLowerCase().includes(f))
    : all;

  const list = document.getElementById('all-list');
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">No suttas yet. Open one on tripitaka.online to start tracking.</div>';
    return;
  }
  list.innerHTML = filtered.map(s => entryHtml(s, 'recent')).join('');
  attachEntryClicks();
}

document.getElementById('search-input').addEventListener('input', e => {
  renderList(e.target.value).catch(showError);
});

// ---- Settings view ----
async function renderSettings() {
  const s = await storageGet(chrome.storage.local, ['tt_llm_endpoint', 'tt_llm_key', 'tt_llm_model']);
  document.getElementById('llm-endpoint').value = s.tt_llm_endpoint || 'https://api.openai.com/v1/chat/completions';
  document.getElementById('llm-key').value      = s.tt_llm_key || '';
  document.getElementById('llm-model').value    = s.tt_llm_model || 'gpt-4o-mini';

  const data = await loadAll();
  const syncStatus = document.getElementById('sync-status');
  if (syncStatus) {
    syncStatus.textContent = `Progress sync is enabled. ${Object.keys(data.suttas).length} suttas are stored in Chrome sync.`;
  }
}

document.getElementById('save-settings').onclick = async () => {
  try {
    await storageSet(chrome.storage.local, {
      tt_llm_endpoint: document.getElementById('llm-endpoint').value.trim(),
      tt_llm_key:      document.getElementById('llm-key').value.trim(),
      tt_llm_model:    document.getElementById('llm-model').value.trim()
    });
    const status = document.getElementById('save-status');
    status.textContent = '✓ Saved locally';
    setTimeout(() => status.textContent = '', 2000);
  } catch (err) {
    showError(err);
  }
};

document.getElementById('export-data').onclick = async () => {
  try {
    const data = await loadAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tripitaka-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showError(err);
  }
};

document.getElementById('import-data').onclick = () => {
  document.getElementById('import-file').click();
};
document.getElementById('import-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  try {
    const parsed = JSON.parse(text);
    if (!parsed.suttas) throw new Error('Invalid file format');
    if (!confirm(`Import ${Object.keys(parsed.suttas).length} suttas? This will merge with existing synced data.`)) return;
    const current = await loadAll();
    const merged = { ...current, suttas: { ...current.suttas, ...parsed.suttas } };
    await saveAll(merged);
    alert('Imported successfully into Chrome sync.');
    setActiveTab('progress');
  } catch (err) {
    alert('Import failed: ' + err.message);
  }
};

document.getElementById('clear-data').onclick = async () => {
  try {
    if (!confirm('Delete ALL synced tracked progress? This cannot be undone.')) return;
    if (!confirm('Really delete everything from Chrome sync?')) return;
    await clearSyncedSuttas();
    alert('Cleared from Chrome sync.');
    setActiveTab('progress');
  } catch (err) {
    showError(err);
  }
};

// Init
setActiveTab('progress');
