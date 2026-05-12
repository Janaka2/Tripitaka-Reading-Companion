// content.js — runs on every tripitaka.online page
// Handles: detecting current sutta, auto-marking as 'read' on scroll,
// rendering the floating sidebar, manual 'studied' button, summary editor.

(() => {
  // Inline copy of TripitakaStore — content scripts run in an isolated world,
  // so we can't share storage.js as a module. We inline the bits we need.
  const LEGACY_KEY = 'tripitaka_progress_v1';
  const LOCAL_MIGRATION_FLAG = 'tt_local_to_sync_migrated_v1';
  const SUTTA_PREFIX = 'tt_sutta_';

  // Contemplative pattern — suttas aren't flashcards. First re-read after 3 days
  // (lets the initial reading settle), capping at ~1 year for deeply-known suttas.
  const SR_INTERVALS = [3, 10, 30, 90, 180, 365];

  // Map exact Sinhala Nikāya names (as they appear on tripitaka.online's
  // <h1 class="sutta-title title-size-1"> element) to our internal keys.
  // Whitespace is normalized before lookup, so minor spacing variations are tolerated.
  const NIKAYA_NAMES = {
    'දීඝ නිකාය':     'digha',
    'මජ්ඣිම නිකාය':   'majjhima',
    'සංයුත්ත නිකාය':  'samyutta',
    'අංගුත්තර නිකාය': 'anguttara',
    'ඛුද්දක නිකාය':   'khuddaka'
  };

  function detectNikaya(nikayaName) {
    if (!nikayaName) return '';
    const normalized = nikayaName.replace(/\s+/g, ' ').trim();
    return NIKAYA_NAMES[normalized] || 'unknown';
  }

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

  // One-time migration: copy old chrome.storage.local progress into sync storage.
  // We keep the old local data as a safe backup.
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

  async function load() {
    await migrateLocalToSyncOnce();
    return { suttas: await getAllSyncedSuttas(), sessions: [] };
  }

  async function save(data) {
    await migrateLocalToSyncOnce();
    const all = await storageGet(chrome.storage.sync, null);
    const keys = Object.keys(all).filter(k => k.startsWith(SUTTA_PREFIX));
    if (keys.length > 0) await storageRemove(chrome.storage.sync, keys);
    await saveSuttasToSync(data?.suttas || {});
  }

  async function getSutta(id) {
    await migrateLocalToSyncOnce();
    const result = await storageGet(chrome.storage.sync, [keyForSutta(id)]);
    return result[keyForSutta(id)] || null;
  }

  async function upsertSutta(id, patch) {
    await migrateLocalToSyncOnce();
    const existing = await getSutta(id) || {
      id, title: '', sectionCode: '', nikaya: '',
      status: 'unread', summary: '',
      firstReadAt: null, lastReadAt: null, studiedAt: null,
      reviewCount: 0, nextReviewAt: null
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

  // Three quality levels for spaced repetition:
  //   'forgot' — reset to position 0 (re-review in 3 days)
  //   'hard'   — repeat current interval (don't advance)
  //   'good'   — advance to next interval (default for first study)
  // intervalIndex is 0-based: position 0 = SR_INTERVALS[0] = 3 days, etc.
  async function reviewSutta(id, quality) {
    const now = Date.now();
    const existing = await getSutta(id);
    const isFirstTime = !existing || existing.status !== 'studied';

    let intervalIndex;
    if (isFirstTime || quality === 'forgot') {
      intervalIndex = 0;
    } else if (quality === 'hard') {
      intervalIndex = Math.min((existing.intervalIndex ?? 0), SR_INTERVALS.length - 1);
    } else {
      intervalIndex = Math.min((existing.intervalIndex ?? -1) + 1, SR_INTERVALS.length - 1);
    }

    const intervalDays = SR_INTERVALS[intervalIndex];
    const reviewCount = (existing?.reviewCount || 0) + 1;

    return upsertSutta(id, {
      status: 'studied',
      studiedAt: now,
      lastReadAt: now,
      reviewCount,
      intervalIndex,
      lastQuality: isFirstTime ? 'first' : quality,
      nextReviewAt: now + intervalDays * 86400000
    });
  }

  // Backward-compat alias for the original single-button flow.
  async function markStudied(id) {
    return reviewSutta(id, 'good');
  }


  // ---- Sutta identification ----
  // Tripitaka.online uses URLs like /sutta/{id}. The page title and
  // section code (e.g. "5.3.5.8") appear in the rendered DOM and meta tags.
  function getSuttaIdFromUrl() {
    const m = location.pathname.match(/^\/sutta\/(\d+)/);
    return m ? m[1] : null;
  }

  function extractSuttaMeta() {
    // The page (Angular SPA) renders three nested h1.sutta-title headings:
    //   #1: දීඝ නිකාය                           (Nikāya — what we want)
    //   #2: සීලක්ඛන්ධ වග්ගෝ                       (vagga)
    //   #3: 1. දෘෂ්ටි ජාලය ගැන වදාළ දෙසුම        (sutta description in Sinhala)
    // The h1 with class 'title-size-1' is the Nikāya. Other titles use
    // 'title-size-2', 'title-size-3', etc.
    //
    // We also fall back to <h2 class="sutta-title"> if h1s aren't ready yet.

    const h1Nikaya = document.querySelector('h1.sutta-title.title-size-1');
    const h2Nikaya = document.querySelector('h2.sutta-title');
    const nikayaName = (h1Nikaya?.textContent || h2Nikaya?.textContent || '').trim();

    // The actual sutta title is the document.title or the deepest sutta-title heading
    let title = document.title.replace(' - Tripitaka.Online', '').replace(/\s*-\s*Tripitaka.*$/i, '').trim();
    if (!title) {
      const allTitles = document.querySelectorAll('h1.sutta-title, h2.sutta-title, h3.sutta-title');
      if (allTitles.length) title = allTitles[allTitles.length - 1].textContent.trim();
    }

    // sectionCode kept for backwards compat / display, extracted from the deepest title
    let sectionCode = '';
    const codeMatch = title.match(/^(\d+(?:\.\d+)*)\.?\s/);
    if (codeMatch) sectionCode = codeMatch[1];

    return { title, sectionCode, nikayaName, nikaya: detectNikaya(nikayaName) };
  }

  // ---- Scroll detection ----
  // 'Read' = user has scrolled past 80% of the article content
  // OR spent 45+ seconds with the tab focused. Either fires markRead.
  let hasMarkedRead = false;
  let focusTime = 0;
  let focusInterval = null;

  function startFocusTimer(suttaId) {
    if (focusInterval) clearInterval(focusInterval);
    focusInterval = setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        focusTime += 1;
        if (focusTime >= 45 && !hasMarkedRead) {
          handleMarkRead(suttaId, 'time');
        }
      }
    }, 1000);
  }

  function checkScrolled() {
    const scrolled = window.scrollY + window.innerHeight;
    const totalHeight = document.documentElement.scrollHeight;
    return totalHeight > 0 && scrolled / totalHeight >= 0.8;
  }

  async function handleMarkRead(suttaId, _trigger) {
    if (hasMarkedRead) return;
    hasMarkedRead = true;
    const meta = extractSuttaMeta();
    // Only commit a write if we actually managed to read meta. If the
    // page hasn't rendered yet (extractSuttaMeta returns empty fields),
    // skip — we'll auto-mark again later via scroll/time once content is there.
    if (!meta.nikayaName && !meta.title) {
      hasMarkedRead = false; // allow retry
      return;
    }
    await markRead(suttaId, meta);
    renderSidebar(); // refresh
  }

  // ---- Sidebar UI ----
  let sidebarRoot = null;
  let isCollapsed = false;

  function buildSidebarShell() {
    if (sidebarRoot) return sidebarRoot;
    sidebarRoot = document.createElement('div');
    sidebarRoot.id = 'tt-sidebar-root';
    document.documentElement.appendChild(sidebarRoot);
    return sidebarRoot;
  }

  async function renderSidebar() {
    const root = buildSidebarShell();
    const suttaId = getSuttaIdFromUrl();

    if (isCollapsed) {
      root.innerHTML = `
        <button class="tt-fab" id="tt-expand" aria-label="Open Tripitaka tracker">
          <span class="tt-fab-icon">☸</span>
        </button>
      `;
      root.querySelector('#tt-expand').onclick = () => { isCollapsed = false; renderSidebar(); };
      return;
    }

    if (!suttaId) {
      // On homepage / non-sutta page — just show the dashboard summary
      root.innerHTML = await renderDashboardOnly();
      attachShellHandlers();
      return;
    }

    const record = await getSutta(suttaId);
    const meta = extractSuttaMeta();
    const status = record?.status || 'unread';
    const summary = record?.summary || '';
    const reviewCount = record?.reviewCount || 0;
    const isDueForReview = record?.status === 'studied'
      && record?.nextReviewAt
      && record.nextReviewAt <= Date.now();
    const nextReviewLabel = record?.nextReviewAt
      ? formatNextReview(record.nextReviewAt)
      : '';

    // Stats for footer
    const data = await load();
    const totalRead = Object.values(data.suttas).filter(s => s.status === 'read' || s.status === 'studied').length;
    const totalStudied = Object.values(data.suttas).filter(s => s.status === 'studied').length;

    // Choose action block based on review state
    let actionsHtml;
    if (isDueForReview) {
      // Three-button quality assessment
      actionsHtml = `
        <div class="tt-review-prompt">
          <div class="tt-label">Time to review · how well did you remember?</div>
        </div>
        <div class="tt-actions tt-actions-three">
          <button class="tt-btn tt-btn-forgot" id="tt-q-forgot">Forgot</button>
          <button class="tt-btn tt-btn-hard"   id="tt-q-hard">Hard</button>
          <button class="tt-btn tt-btn-good"   id="tt-q-good">Got it</button>
        </div>
        <div class="tt-actions">
          <button class="tt-btn tt-btn-ghost" id="tt-reset">Reset</button>
        </div>
      `;
    } else if (status === 'studied') {
      // Already studied, not yet due — just info
      actionsHtml = `
        <div class="tt-actions">
          <button class="tt-btn tt-btn-primary" disabled>✓ Studied · next review ${escapeHtml(nextReviewLabel)}</button>
          <button class="tt-btn tt-btn-ghost" id="tt-reset">Reset</button>
        </div>
      `;
    } else {
      // First time — single button
      actionsHtml = `
        <div class="tt-actions">
          <button class="tt-btn tt-btn-primary" id="tt-mark-studied">Mark as studied</button>
          <button class="tt-btn tt-btn-ghost" id="tt-reset">Reset</button>
        </div>
      `;
    }

    root.innerHTML = `
      <div class="tt-sidebar">
        <div class="tt-header">
          <div class="tt-header-title">☸ Reading tracker</div>
          <button class="tt-collapse" id="tt-collapse" aria-label="Hide">−</button>
        </div>

        <div class="tt-current">
          <div class="tt-label">Current sutta</div>
          <div class="tt-title" title="${escapeHtml(meta.title)}">${escapeHtml(meta.title || 'Loading…')}</div>
          ${meta.sectionCode ? `<div class="tt-code">${escapeHtml(meta.sectionCode)}</div>` : ''}
          <div class="tt-status tt-status-${status}">
            ${status === 'studied' ? '✓ Studied' : status === 'read' ? '◐ Read' : '○ Unread'}
            ${reviewCount > 0 ? `<span class="tt-review-count">· reviewed ${reviewCount}×</span>` : ''}
          </div>
        </div>

        ${actionsHtml}

        <div class="tt-summary-block">
          <div class="tt-label-row">
            <span class="tt-label">Your summary</span>
            <button class="tt-link" id="tt-ai-suggest" title="Generate AI suggestion">✨ Suggest</button>
          </div>
          <textarea class="tt-summary-input" id="tt-summary"
            placeholder="One line you'll remember this by…">${escapeHtml(summary)}</textarea>
          <div class="tt-summary-help">${isDueForReview
            ? 'Tip: try to recall the gist before re-reading the sutta.'
            : 'Saves automatically. Tip: write what struck you most.'}</div>
        </div>

        <div class="tt-divider"></div>

        <div class="tt-progress-block">
          <div class="tt-label">Overall progress</div>
          <div class="tt-progress-row">
            <span class="tt-stat-num">${totalRead}</span>
            <span class="tt-stat-label">read</span>
            <span class="tt-stat-num">${totalStudied}</span>
            <span class="tt-stat-label">studied</span>
          </div>
          <button class="tt-link tt-full-dash" id="tt-open-popup">Open full dashboard →</button>
        </div>
      </div>
    `;

    attachShellHandlers();
  }

  // Format "next review" into a friendly relative phrase
  function formatNextReview(ts) {
    const diff = ts - Date.now();
    if (diff < 0) return 'now';
    const days = Math.round(diff / 86400000);
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days < 30) return `in ${days}d`;
    if (days < 365) return `in ${Math.round(days / 30)}mo`;
    return `in ${Math.round(days / 365)}y`;
  }

  async function renderDashboardOnly() {
    const data = await load();
    const totalRead = Object.values(data.suttas).filter(s => s.status === 'read' || s.status === 'studied').length;
    const totalStudied = Object.values(data.suttas).filter(s => s.status === 'studied').length;
    const recent = Object.values(data.suttas)
      .filter(s => s.lastReadAt)
      .sort((a, b) => b.lastReadAt - a.lastReadAt)
      .slice(0, 5);

    return `
      <div class="tt-sidebar">
        <div class="tt-header">
          <div class="tt-header-title">☸ Reading tracker</div>
          <button class="tt-collapse" id="tt-collapse" aria-label="Hide">−</button>
        </div>
        <div class="tt-progress-block" style="padding-top: 12px;">
          <div class="tt-progress-row">
            <span class="tt-stat-num">${totalRead}</span>
            <span class="tt-stat-label">read</span>
            <span class="tt-stat-num">${totalStudied}</span>
            <span class="tt-stat-label">studied</span>
          </div>
        </div>
        <div class="tt-divider"></div>
        <div class="tt-recent-block">
          <div class="tt-label">Recently read</div>
          ${recent.length === 0
            ? '<div class="tt-empty">Open any sutta to start tracking.</div>'
            : recent.map(s => `
                <a href="/sutta/${s.id}" class="tt-recent-item">
                  <div class="tt-recent-title">${escapeHtml(s.title || 'Sutta ' + s.id)}</div>
                  ${s.summary ? `<div class="tt-recent-summary">${escapeHtml(s.summary)}</div>` : ''}
                </a>
              `).join('')
          }
        </div>
      </div>
    `;
  }

function cleanAiSuggestion(raw) {
  return String(raw || '')
    .trim()
    .replace(/^[-•*\d.)\s]+/, '')
    .replace(/^["'“”‘’`]+|["'“”‘’`.,!?]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

  function extractSummaryFromContent(content) {
    if (!content) return '';

    const text = String(content).trim();

    // Preferred path: model returned JSON like {"summary":"..."}
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.summary === 'string') {
        return cleanAiSuggestion(parsed.summary);
      }
    } catch (_) {
      // Fallbacks below.
    }

    // Fallback: content contains JSON inside extra text.
    const jsonMatch = text.match(/\{[\s\S]*?"summary"\s*:\s*"([\s\S]*?)"[\s\S]*?\}/);
    if (jsonMatch?.[1]) {
      return cleanAiSuggestion(jsonMatch[1].replace(/\\"/g, '"'));
    }

    // Fallback: direct sentence content.
    return cleanAiSuggestion(text);
  }

  function getCleanSuttaText() {
    const selectors = [
      '.sutta-content',
      'article',
      'main'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;

      const clone = el.cloneNode(true);

      clone.querySelectorAll(
        '#tt-sidebar-root, nav, header, footer, button, script, style'
      ).forEach(x => x.remove());

      const text = clone.innerText
        .replace(/\s+/g, ' ')
        .trim();

      if (text.length > 100) {
        return text;
      }
    }

    return '';
  }

  function attachShellHandlers() {
    const collapseBtn = sidebarRoot.querySelector('#tt-collapse');
    if (collapseBtn) collapseBtn.onclick = () => { isCollapsed = true; renderSidebar(); };

    const studyBtn = sidebarRoot.querySelector('#tt-mark-studied');
    if (studyBtn) studyBtn.onclick = async () => {
      const id = getSuttaIdFromUrl();
      if (!id) return;
      await markStudied(id);
      renderSidebar();
    };

    // Three-button quality review (only present when sutta is due for review)
    const qForgot = sidebarRoot.querySelector('#tt-q-forgot');
    if (qForgot) qForgot.onclick = async () => {
      const id = getSuttaIdFromUrl();
      if (!id) return;
      await reviewSutta(id, 'forgot');
      renderSidebar();
    };
    const qHard = sidebarRoot.querySelector('#tt-q-hard');
    if (qHard) qHard.onclick = async () => {
      const id = getSuttaIdFromUrl();
      if (!id) return;
      await reviewSutta(id, 'hard');
      renderSidebar();
    };
    const qGood = sidebarRoot.querySelector('#tt-q-good');
    if (qGood) qGood.onclick = async () => {
      const id = getSuttaIdFromUrl();
      if (!id) return;
      await reviewSutta(id, 'good');
      renderSidebar();
    };

    const resetBtn = sidebarRoot.querySelector('#tt-reset');
    if (resetBtn) resetBtn.onclick = async () => {
      const id = getSuttaIdFromUrl();
      if (!id) return;
      if (!confirm('Reset this sutta to unread?')) return;
      const data = await load();
      delete data.suttas[id];
      await save(data);
      hasMarkedRead = false;
      focusTime = 0;
      renderSidebar();
    };

    const summaryInput = sidebarRoot.querySelector('#tt-summary');
    if (summaryInput) {
      let saveTimer = null;
      summaryInput.addEventListener('input', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
          const id = getSuttaIdFromUrl();
          if (!id) return;
          await upsertSutta(id, { summary: summaryInput.value });
        }, 600);
      });
    }

    const aiBtn = sidebarRoot.querySelector('#tt-ai-suggest');
    if (aiBtn) aiBtn.onclick = handleAiSuggest;

    const openPopupBtn = sidebarRoot.querySelector('#tt-open-popup');
    if (openPopupBtn) openPopupBtn.onclick = () => {
      alert('Click the extension icon in your browser toolbar to open the full dashboard.');
    };
  }

  // ---- AI summary suggestion ----
  // Sends the visible sutta text to a configured LLM endpoint.
  // We do NOT bundle an API key. The user sets their own in the popup options.
  async function handleAiSuggest() {
    const id = getSuttaIdFromUrl();
    if (!id) return;

    const settings = await new Promise(r =>
      chrome.storage.local.get(['tt_llm_endpoint', 'tt_llm_key', 'tt_llm_model'], r)
    );

    if (!settings.tt_llm_endpoint || !settings.tt_llm_key) {
      alert('Set up your AI provider in the extension popup first.\n\nClick the extension icon → Settings.');
      return;
    }

    const btn = sidebarRoot.querySelector('#tt-ai-suggest');
    if (btn) btn.textContent = '… thinking';

    try {
      const fullText = getCleanSuttaText();

      console.log('Full sutta text length:', fullText.length);
      console.log('Full sutta start:', fullText.slice(0, 500));
      console.log('Full sutta end:', fullText.slice(-500));

      if (!fullText || fullText.length < 100) {
        alert('Could not capture sutta text. Page may not be fully loaded.');
        return;
      }

      // Minimal working solution for local models:
      // Avoid sending very large suttas in one request. Use the beginning and ending,
      // because many suttas introduce the topic at the start and conclude/summarize at the end.
      const MAX_LLM_CHARS = 6000;

      const articleText = fullText.length > MAX_LLM_CHARS
        ? fullText.slice(0, MAX_LLM_CHARS / 2) +
          '\n\n...\n\n' +
          fullText.slice(-(MAX_LLM_CHARS / 2))
        : fullText;

      console.log('Sent to LLM length:', articleText.length);

      const model = (settings.tt_llm_model || 'google/gemma-4-e4b').trim();

      const resp = await fetch(settings.tt_llm_endpoint.trim(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.tt_llm_key}`
        },
        body: JSON.stringify({
          model,
          messages: [
		{
    		role: 'system',
    		content: 'Return only valid JSON. Use only the provided sutta text. Do not infer, imagine, explain, or add outside knowledge. Do not output reasoning.'
  		},
           	 {
              	role: 'user',
              	content: `You are helping a Buddhist student remember a sutta.

Use ONLY the given sutta text.
Do NOT use outside knowledge, Buddhist commentary, interpretation, imagination, or personal advice.
Do NOT add anything that is not directly stated or directly supported by the sutta text.

Write one compact Sinhala study note.

The note must include:
1. the core teaching directly found in the sutta text
2. only if clearly supported by the sutta text, one short reflection or practice direction

Strict rules:
- Sinhala only.
- Maximum 45 words total.
- 1 or 2 short sentences only.
- No title.
- No bullet points.
- No markdown.
- No explanation.
- No invented advice.
- No modern-life interpretation.
- No emotional or motivational additions.
- If the sutta only lists concepts, only mention those listed concepts.
- If no practice direction is directly supported, do not create one.
- Every word must be grounded in the given sutta text.

Return exactly this JSON shape and nothing else:
{"summary":"..."}

Sutta text:
${articleText}`
            }
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'sutta_summary',
              strict: true,
              schema: {
                type: 'object',
                properties: {
                  summary: { type: 'string' }
                },
                required: ['summary'],
                additionalProperties: false
              }
            }
          },
          max_tokens: 800,
          temperature: 0
        })
      });

      const raw = await resp.text();

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { raw };
      }

      console.log('LLM status:', resp.status);
      console.log('LLM response:', data);

      if (!resp.ok) {
        const errorText = data?.error?.message || raw || JSON.stringify(data);
        alert('LLM error HTTP ' + resp.status + ':\n\n' + errorText.slice(0, 800));
        return;
      }

      const choice = data.choices?.[0];
      console.log('LLM first choice:', JSON.stringify(choice, null, 2));

      let rawContent = '';

      if (typeof choice?.message?.content === 'string') {
        rawContent = choice.message.content;
      } else if (Array.isArray(choice?.message?.content)) {
        rawContent = choice.message.content
          .map(x => x.text || x.content || '')
          .join(' ');
      } else if (typeof choice?.text === 'string') {
        rawContent = choice.text;
      }

      console.log('Raw AI content:', rawContent);

      let suggestion = extractSummaryFromContent(rawContent);

      // Never use reasoning_content as the saved answer. It is only diagnostic.
      if (!suggestion && choice?.message?.reasoning_content) {
        console.warn('Model returned reasoning_content but no final content:', choice.message.reasoning_content);
      }

      // Final protection: keep max 20 words even if model ignores instruction.
	const words = suggestion.split(/\s+/).filter(Boolean);
	if (words.length > 60) {
  		suggestion = words.slice(0, 60).join(' ');
	}

      if (suggestion) {
        const ta = sidebarRoot.querySelector('#tt-summary');
        if (ta) {
          ta.value = suggestion;
          ta.dispatchEvent(new Event('input'));
        }
      } else {
        const finishReason = choice?.finish_reason;
        if (finishReason === 'length') {
          alert('The model did not return final content. Try a non-thinking/instruct model in LM Studio, or increase max_tokens.');
        } else {
          alert('AI returned no suggestion. Check console for full LLM response.');
        }
      }

    } catch (e) {
      console.error('AI suggest failed', e);
      alert('AI request failed: ' + e.message);
    } finally {
      if (btn) btn.textContent = '✨ Suggest';
    }
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  // ---- Init + SPA navigation ----
  // Wait for the Angular SPA to actually render the page content before
  // we read meta. Polls every 200ms up to ~6s, resolving as soon as the
  // <h1 class="sutta-title title-size-1"> with a Nikāya name appears.
  function waitForSuttaContent(maxWaitMs = 6000) {
    return new Promise(resolve => {
      const start = Date.now();
      const tick = () => {
        const meta = extractSuttaMeta();
        if (meta.nikayaName && meta.title) {
          resolve(meta);
        } else if (Date.now() - start >= maxWaitMs) {
          resolve(meta); // give up — return whatever we have
        } else {
          setTimeout(tick, 200);
        }
      };
      tick();
    });
  }

  let lastUrl = location.href;
  async function init() {
    const id = getSuttaIdFromUrl();
    hasMarkedRead = false;
    focusTime = 0;
    renderSidebar();
    if (id) {
      // Wait for Angular to render before we extract anything.
      // Once meta is ready, refresh the sidebar (so the title shows correctly)
      // and start the focus timer for the auto-mark-read trigger.
      const meta = await waitForSuttaContent();
      renderSidebar();

      // If we already have a record but nikaya is unknown / empty, backfill it now
      const existing = await getSutta(id);
      if (existing && (!existing.nikaya || existing.nikaya === 'unknown') && meta.nikaya && meta.nikaya !== 'unknown') {
        await upsertSutta(id, { nikaya: meta.nikaya, title: meta.title || existing.title });
        renderSidebar();
      }

      startFocusTimer(id);

      window.addEventListener('scroll', () => {
        if (!hasMarkedRead && checkScrolled()) {
          handleMarkRead(id, 'scroll');
        }
      }, { passive: true });
    }
  }

  // Re-init on SPA URL changes
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (focusInterval) clearInterval(focusInterval);
      init();
    }
  }, 600);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
