// storage.js — shared data layer for content script and popup
// Uses chrome.storage.sync for reading progress so it follows the same Chrome login.
// Keeps API keys/settings in chrome.storage.local from popup/content code.
// Loaded as a regular <script> by popup.html and/or kept as reference for content.js.

const TripitakaStore = (() => {
  const LEGACY_KEY = 'tripitaka_progress_v1';
  const LOCAL_MIGRATION_FLAG = 'tt_local_to_sync_migrated_v1';
  const SUTTA_PREFIX = 'tt_sutta_';

  // Default per-Nikaya totals (Sinhalese / Buddha Jayanthi tradition).
  // Used for percentage calculations. Adjust if you confirm exact site counts.
  const NIKAYA_TOTALS = {
    digha:     { name: 'Dīgha Nikāya',    total: 34 },
    majjhima:  { name: 'Majjhima Nikāya', total: 152 },
    samyutta:  { name: 'Saṃyutta Nikāya', total: 7656 },
    anguttara: { name: 'Aṅguttara Nikāya', total: 9557 },
    khuddaka:  { name: 'Khuddaka Nikāya',  total: 2000 } // rough estimate; books vary
  };

  // Spaced repetition intervals (days) — applied when a sutta is marked "studied".
  const SR_INTERVALS = [3, 10, 30, 90, 180, 365];

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

  async function saveSuttasToSync(suttas) {
    const items = {};
    for (const [id, sutta] of Object.entries(suttas || {})) {
      items[keyForSutta(id)] = { ...sutta, id };
    }
    if (Object.keys(items).length > 0) {
      await storageSet(chrome.storage.sync, items);
    }
  }

  async function clearSyncedSuttas() {
    const all = await storageGet(chrome.storage.sync, null);
    const keys = Object.keys(all).filter(k => k.startsWith(SUTTA_PREFIX));
    if (keys.length > 0) await storageRemove(chrome.storage.sync, keys);
  }

  // One-time migration: copy old chrome.storage.local progress into sync storage.
  // We do not delete the old local data, so it remains as a safe backup.
  async function migrateLocalToSyncOnce() {
    const flag = await storageGet(chrome.storage.local, [LOCAL_MIGRATION_FLAG]);
    if (flag[LOCAL_MIGRATION_FLAG]) return;

    const legacy = await storageGet(chrome.storage.local, [LEGACY_KEY]);
    const legacyData = legacy[LEGACY_KEY];
    if (legacyData?.suttas && Object.keys(legacyData.suttas).length > 0) {
      const currentSync = await getAllSyncedSuttas();
      // Local fills missing records; existing synced records win.
      const merged = { ...legacyData.suttas, ...currentSync };
      await saveSuttasToSync(merged);
    }

    await storageSet(chrome.storage.local, { [LOCAL_MIGRATION_FLAG]: true });
  }

  async function load() {
    await migrateLocalToSyncOnce();
    return { suttas: await getAllSyncedSuttas(), sessions: [] };
  }

  async function save(data) {
    await migrateLocalToSyncOnce();
    await clearSyncedSuttas();
    await saveSuttasToSync(data?.suttas || {});
  }

  // Get a single sutta record by id (the numeric URL id)
  async function getSutta(id) {
    await migrateLocalToSyncOnce();
    const result = await storageGet(chrome.storage.sync, [keyForSutta(id)]);
    return result[keyForSutta(id)] || null;
  }

  // Update or create a sutta record
  async function upsertSutta(id, patch) {
    await migrateLocalToSyncOnce();
    const existing = await getSutta(id) || {
      id,
      title: '',
      sectionCode: '',
      nikaya: '',
      status: 'unread',
      summary: '',
      firstReadAt: null,
      lastReadAt: null,
      studiedAt: null,
      reviewCount: 0,
      nextReviewAt: null
    };
    const merged = { ...existing, ...patch, id };
    await storageSet(chrome.storage.sync, { [keyForSutta(id)]: merged });
    return merged;
  }

  async function markRead(id, meta = {}) {
    const now = Date.now();
    const existing = await getSutta(id);
    const patch = {
      ...meta,
      lastReadAt: now,
      status: existing?.status === 'studied' ? 'studied' : 'read'
    };
    if (!existing?.firstReadAt) patch.firstReadAt = now;
    return upsertSutta(id, patch);
  }

  async function markStudied(id) {
    const now = Date.now();
    const existing = await getSutta(id);
    const reviewCount = (existing?.reviewCount || 0) + 1;
    const intervalDays = SR_INTERVALS[Math.min(reviewCount - 1, SR_INTERVALS.length - 1)];
    const nextReviewAt = now + intervalDays * 24 * 60 * 60 * 1000;
    return upsertSutta(id, {
      status: 'studied',
      studiedAt: now,
      lastReadAt: now,
      reviewCount,
      nextReviewAt
    });
  }

  async function resetSutta(id) {
    await migrateLocalToSyncOnce();
    await storageRemove(chrome.storage.sync, [keyForSutta(id)]);
  }

  async function setSummary(id, summary) {
    return upsertSutta(id, { summary });
  }

  async function getStats() {
    const data = await load();
    const byNikaya = {};
    for (const [code, info] of Object.entries(NIKAYA_TOTALS)) {
      byNikaya[code] = { ...info, read: 0, studied: 0 };
    }
    let totalRead = 0, totalStudied = 0;
    for (const s of Object.values(data.suttas)) {
      const n = byNikaya[s.nikaya];
      if (s.status === 'read' || s.status === 'studied') {
        if (n) n.read += 1;
        totalRead += 1;
      }
      if (s.status === 'studied') {
        if (n) n.studied += 1;
        totalStudied += 1;
      }
    }
    const totalAll = Object.values(NIKAYA_TOTALS).reduce((a, b) => a + b.total, 0);
    return { byNikaya, totalRead, totalStudied, totalAll };
  }

  async function getDueForReview(limit = 5) {
    const data = await load();
    const now = Date.now();
    return Object.values(data.suttas)
      .filter(s => s.status === 'studied' && s.nextReviewAt && s.nextReviewAt <= now)
      .sort((a, b) => a.nextReviewAt - b.nextReviewAt)
      .slice(0, limit);
  }

  async function getRecent(limit = 10) {
    const data = await load();
    return Object.values(data.suttas)
      .filter(s => s.lastReadAt)
      .sort((a, b) => b.lastReadAt - a.lastReadAt)
      .slice(0, limit);
  }

  function detectNikaya(sectionCode) {
    if (!sectionCode) return '';
    const top = sectionCode.split('.')[0];
    const map = {
      '1': 'samyutta',
      '2': 'samyutta',
      '3': 'majjhima',
      '4': 'digha',
      '5': 'anguttara',
      '6': 'khuddaka',
      '7': 'khuddaka'
    };
    return map[top] || 'unknown';
  }

  return {
    NIKAYA_TOTALS,
    load, save,
    getSutta, upsertSutta,
    markRead, markStudied, resetSutta,
    setSummary,
    getStats, getDueForReview, getRecent,
    detectNikaya,
    migrateLocalToSyncOnce,
    clearSyncedSuttas
  };
})();

if (typeof window !== 'undefined') window.TripitakaStore = TripitakaStore;
