// ─── State ────────────────────────────────────────────────────────────────────
let currentTabId  = null;
let selectedModel = null;
let githubConfig  = { token: null, repo: null, defaultBranch: 'main' };
let githubUser    = null;   // { login, name, avatar_url }
const BACKEND     = 'http://localhost:8000';

// ─── Screen Router ────────────────────────────────────────────────────────────
function showScreen(id) {
  ['login-screen', 'repo-screen', 'main-screen'].forEach(s => {
    document.getElementById(s).style.display = s === id ? 'flex' : 'none';
  });
}

// ─── Backend Health Check ─────────────────────────────────────────────────────
async function checkBackend() {
  const dot   = document.getElementById('backend-dot');
  const label = document.getElementById('backend-label');
  try {
    const res = await fetch(`${BACKEND}/models`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      dot.className     = 'backend-dot online';
      label.textContent = 'Backend online';
      return true;
    }
  } catch {}
  dot.className     = 'backend-dot offline';
  label.textContent = 'Backend offline — run: python main.py';
  return false;
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
document.getElementById('login-btn').addEventListener('click', handleLogin);
document.getElementById('login-token').addEventListener('keydown', e => {
  if (e.key === 'Enter') handleLogin();
});

async function handleLogin() {
  const token = document.getElementById('login-token').value.trim();
  const errEl = document.getElementById('login-error');
  const btn   = document.getElementById('login-btn');

  if (!token) { showLoginError('Please paste your GitHub Personal Access Token.'); return; }

  btn.textContent = 'Signing in…';
  btn.disabled    = true;
  errEl.style.display = 'none';

  try {
    const res  = await fetch(`${BACKEND}/github/user`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ github_token: token, repo: '' })
    });
    const data = await res.json();
    if (!data.ok) { showLoginError(data.error); btn.textContent = 'Continue with GitHub'; btn.disabled = false; return; }

    githubUser = data;
    chrome.storage.local.set({ githubToken: token, githubUser: data });
    showRepoPicker(token, data);
  } catch {
    showLoginError('Cannot reach backend. Run: python main.py in the backend folder.');
    btn.textContent = 'Continue with GitHub';
    btn.disabled    = false;
  }
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent     = msg;
  el.style.display   = 'block';
}

// ─── Repo Picker Screen ───────────────────────────────────────────────────────
async function showRepoPicker(token, user) {
  showScreen('repo-screen');

  // Fill user strip
  document.getElementById('user-avatar').src   = user.avatar_url || '';
  document.getElementById('user-name').textContent  = user.name  || user.login;
  document.getElementById('user-login').textContent = '@' + user.login;

  // Load repos
  await loadRepoList(token);
}

async function loadRepoList(token) {
  const list = document.getElementById('repo-list');
  list.innerHTML = '<div class="repo-loading"><div class="spinner"></div>Loading repositories…</div>';

  try {
    const res  = await fetch(`${BACKEND}/github/repos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ github_token: token, repo: '' })
    });
    const data = await res.json();
    if (!data.ok || !data.repos.length) {
      list.innerHTML = '<div class="repo-empty">No repositories found.</div>';
      return;
    }
    renderRepoList(data.repos, token);
  } catch {
    list.innerHTML = '<div class="repo-empty">⚠️ Backend offline.</div>';
  }
}

let allRepos = [];
function renderRepoList(repos, token) {
  allRepos = repos;
  const list = document.getElementById('repo-list');
  list.innerHTML = '';
  repos.forEach(r => list.appendChild(makeRepoItem(r, token)));
}

function makeRepoItem(r, token) {
  const item = document.createElement('div');
  item.className = 'repo-item';
  item.dataset.fullName = r.full_name;
  item.innerHTML = `
    <div class="repo-item-left">
      <div class="repo-item-name">${escapeHTML(r.full_name)}</div>
      ${r.description ? `<div class="repo-item-desc">${escapeHTML(r.description)}</div>` : ''}
      <div class="repo-item-meta">
        ${r.language ? `<span class="repo-lang">${escapeHTML(r.language)}</span>` : ''}
        <span class="repo-branch">⎇ ${escapeHTML(r.default_branch)}</span>
        ${r.private ? '<span class="repo-private">Private</span>' : '<span class="repo-public">Public</span>'}
      </div>
    </div>
    <button class="repo-select-btn" data-repo="${escapeHTML(r.full_name)}" data-branch="${escapeHTML(r.default_branch)}">Select</button>
  `;
  item.querySelector('.repo-select-btn').addEventListener('click', () => connectRepo(r, token));
  return item;
}

async function connectRepo(repo, token) {
  const errEl = document.getElementById('repo-pick-error');
  errEl.style.display = 'none';

  // Highlight selected
  document.querySelectorAll('.repo-item').forEach(i => i.classList.remove('selected'));
  const item = document.querySelector(`.repo-item[data-full-name="${repo.full_name}"]`);
  if (item) { item.classList.add('selected'); item.querySelector('.repo-select-btn').textContent = 'Connecting…'; }

  githubConfig = { token, repo: repo.full_name, defaultBranch: repo.default_branch };
  chrome.storage.local.set({ githubConfig });
  showMainPanel();
}

// ─── Logout ───────────────────────────────────────────────────────────────────
function handleLogout() {
  githubConfig = { token: null, repo: null, defaultBranch: 'main' };
  githubUser   = null;
  chrome.storage.local.remove(['githubConfig', 'githubToken', 'githubUser']);
  document.getElementById('login-token').value = '';
  document.getElementById('login-error').style.display = 'none';
  document.getElementById('login-btn').textContent = 'Continue with GitHub';
  document.getElementById('login-btn').disabled = false;
  showScreen('login-screen');
}

document.getElementById('logout-btn').addEventListener('click', handleLogout);
document.getElementById('logout-main-btn').addEventListener('click', handleLogout);
document.getElementById('change-repo-btn').addEventListener('click', () => {
  const token = githubConfig.token || (githubUser && document.getElementById('login-token').value);
  chrome.storage.local.get('githubToken', d => {
    if (d.githubToken && githubUser) showRepoPicker(d.githubToken, githubUser);
    else showScreen('login-screen');
  });
});

// Repo search filter
document.getElementById('repo-search').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  const list = document.getElementById('repo-list');
  list.innerHTML = '';
  const filtered = allRepos.filter(r =>
    r.full_name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q)
  );
  if (!filtered.length) { list.innerHTML = '<div class="repo-empty">No matches found.</div>'; return; }
  chrome.storage.local.get('githubToken', d => {
    filtered.forEach(r => list.appendChild(makeRepoItem(r, d.githubToken)));
  });
});

// ─── Main Panel Init ──────────────────────────────────────────────────────────
function showMainPanel() {
  showScreen('main-screen');

  // Fill user chip
  if (githubUser) {
    document.getElementById('chip-avatar').src   = githubUser.avatar_url || '';
    document.getElementById('chip-login').textContent = '@' + githubUser.login;
  }

  // Fill active repo bar
  document.getElementById('active-repo-name').textContent   = githubConfig.repo || 'No repo';
  document.getElementById('active-repo-branch').textContent = githubConfig.defaultBranch ? '⎇ ' + githubConfig.defaultBranch : '';

  checkBackend();
  setInterval(checkBackend, 10000);
  loadModels();

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length > 0) { currentTabId = tabs[0].id; refreshState(); requestPerfMetrics(); }
  });
}

// ─── App Boot ─────────────────────────────────────────────────────────────────
chrome.storage.local.get(['githubConfig', 'githubToken', 'githubUser', 'selectedModel'], (data) => {
  if (data.selectedModel) selectedModel = data.selectedModel;

  if (data.githubConfig && data.githubConfig.token && data.githubConfig.repo && data.githubUser) {
    // Already logged in and repo selected — go straight to main
    githubConfig = data.githubConfig;
    githubUser   = data.githubUser;
    showMainPanel();
  } else if (data.githubToken && data.githubUser) {
    // Logged in but no repo yet — show picker
    githubUser = data.githubUser;
    showRepoPicker(data.githubToken, data.githubUser);
  } else {
    // Not logged in
    showScreen('login-screen');
  }
});

// Tab events (used after main panel is shown)
chrome.tabs.onActivated.addListener((activeInfo) => {
  currentTabId = activeInfo.tabId;
  refreshState();
  requestPerfMetrics();
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'state_updated' && request.tabId === currentTabId) renderState(request.state);
  if (request.action === 'perf_data'    && request.tabId === currentTabId) renderPerf(request.data);
});

function refreshState() {
  chrome.runtime.sendMessage({ action: 'get_state' }, (state) => {
    if (state) renderState(state);
  });
}
setInterval(checkBackend, 10000);   // re-check every 10s
loadModels();
restoreGithubConfig();

// ─── Tab Events ───────────────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener((activeInfo) => {
  currentTabId = activeInfo.tabId;
  refreshState();
  requestPerfMetrics();
});

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'state_updated' && request.tabId === currentTabId) renderState(request.state);
  if (request.action === 'perf_data'    && request.tabId === currentTabId) renderPerf(request.data);
});

function refreshState() {
  chrome.runtime.sendMessage({ action: 'get_state' }, (state) => {
    if (state) renderState(state);
  });
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
document.getElementById('settings-btn').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('gh-connect-btn').addEventListener('click', async () => {
  const token  = document.getElementById('gh-token').value.trim();
  const repo   = document.getElementById('gh-repo').value.trim();
  const status = document.getElementById('gh-status');

  if (!token || !repo) {
    setGhStatus('error', '⚠️ Both token and repo are required.');
    return;
  }

  const btn = document.getElementById('gh-connect-btn');
  btn.textContent = 'Connecting…';
  btn.disabled    = true;

  try {
    const res  = await fetch(`${BACKEND}/github/connect`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ github_token: token, repo })
    });
    const data = await res.json();

    if (data.ok) {
      githubConfig = { token, repo, defaultBranch: data.default_branch };
      chrome.storage.local.set({ githubConfig });
      setGhStatus('success', `✅ Connected to <strong>${data.full_name}</strong>`);
    } else {
      setGhStatus('error', `⚠️ ${data.error}`);
    }
  } catch {
    setGhStatus('error', '⚠️ Backend offline. Start FastAPI on port 8000.');
  }

  btn.textContent = 'Connect Repository';
  btn.disabled    = false;
});

function setGhStatus(type, html) {
  const el = document.getElementById('gh-status');
  el.className = `gh-status ${type}`;
  el.innerHTML = html;
}

function restoreGithubConfig() {
  chrome.storage.local.get(['githubConfig', 'selectedModel'], (data) => {
    if (data.githubConfig) {
      githubConfig = data.githubConfig;
      document.getElementById('gh-token').value = githubConfig.token || '';
      document.getElementById('gh-repo').value  = githubConfig.repo  || '';
      if (githubConfig.repo) {
        setGhStatus('success', `✅ Connected to <strong>${githubConfig.repo}</strong>`);
      }
    }
    if (data.selectedModel) selectedModel = data.selectedModel;
  });
}

// ─── Model Selector ───────────────────────────────────────────────────────────
async function loadModels() {
  const select = document.getElementById('model-select');
  try {
    const res  = await fetch(`${BACKEND}/models`);
    const data = await res.json();

    chrome.storage.local.get('selectedModel', ({ selectedModel: saved }) => {
      const defaultId = saved || data.default;
      selectedModel   = defaultId;
      select.innerHTML = '';
      data.models.forEach(m => {
        const opt       = document.createElement('option');
        opt.value       = m.id;
        opt.textContent = m.name;
        if (m.id === defaultId) opt.selected = true;
        select.appendChild(opt);
      });
    });
  } catch {
    select.innerHTML = '<option value="">Backend offline</option>';
  }
}

document.getElementById('model-select').addEventListener('change', (e) => {
  selectedModel = e.target.value;
  chrome.storage.local.set({ selectedModel });
});

// ─── Tab Buttons ──────────────────────────────────────────────────────────────
function setActiveTab(active) {
  ['errors', 'perf', 'history'].forEach(id => {
    document.getElementById(`tab-${id}`).classList.toggle('active', id === active);
  });
  document.getElementById('error-feed').style.display    = active === 'errors'  ? 'block' : 'none';
  document.getElementById('perf-panel').style.display    = active === 'perf'    ? 'block' : 'none';
  document.getElementById('history-panel').style.display = active === 'history' ? 'block' : 'none';
}

document.getElementById('tab-errors').addEventListener('click', () => setActiveTab('errors'));
document.getElementById('tab-perf').addEventListener('click', () => { setActiveTab('perf'); requestPerfMetrics(); });
document.getElementById('tab-history').addEventListener('click', () => { setActiveTab('history'); loadHistory(); });

document.getElementById('clear-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'clear_state' });
  renderState({ errors: [], warnings: [] });
});

document.getElementById('history-clear-btn').addEventListener('click', async () => {
  await fetch(`${BACKEND}/history`, { method: 'DELETE' });
  loadHistory();
});

// ─── Performance ──────────────────────────────────────────────────────────────
function requestPerfMetrics() {
  if (!currentTabId) return;
  chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    func: () => {
      const nav       = performance.getEntriesByType('navigation')[0];
      const resources = performance.getEntriesByType('resource');
      const mem       = performance.memory;
      return {
        domLoad:       nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : null,
        fullLoad:      nav ? Math.round(nav.loadEventEnd - nav.startTime) : null,
        resourceCount: resources.length,
        jsHeap:        mem ? Math.round(mem.usedJSHeapSize / 1024 / 1024) : null
      };
    }
  }).then(results => {
    if (results?.[0]?.result) renderPerf(results[0].result);
  }).catch(() => {});
}

function renderPerf(data) {
  const fmt = (ms) => ms != null && ms > 0 ? (ms > 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms') : '--';
  document.getElementById('metric-dom').textContent       = fmt(data.domLoad);
  document.getElementById('metric-load').textContent      = fmt(data.fullLoad);
  document.getElementById('metric-resources').textContent = data.resourceCount ?? '--';
  document.getElementById('metric-heap').textContent      = data.jsHeap != null ? data.jsHeap + 'MB' : '--';
  document.getElementById('perf-value').textContent       = fmt(data.fullLoad);
}

// ─── History ──────────────────────────────────────────────────────────────────
async function loadHistory() {
  const feed = document.getElementById('history-feed');
  feed.innerHTML = '<div class="loading-text">Loading history…</div>';
  try {
    const res  = await fetch(`${BACKEND}/history`);
    const data = await res.json();

    if (!data.history.length) {
      feed.innerHTML = `<div class="empty-state"><div class="empty-icon">🕓</div><div class="empty-text">No history yet</div><div class="empty-sub">Debug an error to see it here</div></div>`;
      return;
    }

    feed.innerHTML = '';
    data.history.forEach(row => {
      const card  = document.createElement('div');
      card.className = 'history-card';
      const parts = (row.solution || '').split('##FIX##');
      const expl  = (parts[0] || '').replace('##EXPLANATION##', '').trim();
      const fixAndRest = (parts[1] || '');
      const fix   = fixAndRest.split('##FILE##')[0].trim();

      card.innerHTML = `
        <div class="history-meta">
          <span class="history-type">${escapeHTML(row.error_type || 'error')}</span>
          <span class="history-model">${escapeHTML(row.model || '')}</span>
          <span class="history-time">${new Date(row.timestamp).toLocaleString()}</span>
        </div>
        <div class="history-message">${escapeHTML(row.error_message)}</div>
        ${expl ? `<div class="solution-section"><div class="solution-label explanation-label">💡 Explanation</div><p>${escapeHTML(expl)}</p></div>` : ''}
        ${fix  ? `<div class="solution-section"><div class="solution-label fix-label">🔧 Fix</div><pre><code>${escapeHTML(fix)}</code></pre></div>` : ''}
      `;
      feed.appendChild(card);
    });
  } catch {
    feed.innerHTML = '<p style="color:#f87171;padding:12px;">⚠️ Backend offline. Start FastAPI on port 8000.</p>';
  }
}

// ─── Error Feed ───────────────────────────────────────────────────────────────
function renderState(state) {
  const errorCount = state.errors.length;
  const warnCount  = state.warnings.length;

  document.getElementById('error-count').innerText = errorCount;
  document.getElementById('warn-count').innerText  = warnCount;

  const glow = document.getElementById('ambient-glow');
  if (glow) {
    glow.className = 'ambient-glow';
    if (errorCount > 0)     glow.classList.add('has-errors');
    else if (warnCount > 0) glow.classList.add('has-warnings');
  }

  const badge = document.getElementById('health-badge');
  if (badge) {
    if (errorCount > 0) {
      badge.className = 'badge badge-red';
      badge.innerHTML = `<span class="badge-dot"></span>${errorCount} Error${errorCount > 1 ? 's' : ''}`;
    } else if (warnCount > 0) {
      badge.className = 'badge badge-yellow';
      badge.innerHTML = `<span class="badge-dot"></span>${warnCount} Warning${warnCount > 1 ? 's' : ''}`;
    } else {
      badge.className = 'badge badge-green';
      badge.innerHTML = '<span class="badge-dot"></span>Healthy';
    }
  }

  const feed      = document.getElementById('error-feed');
  feed.innerHTML  = '';
  const allEvents = [...state.errors, ...state.warnings].sort((a, b) => b.timestamp - a.timestamp);

  if (allEvents.length === 0) {
    feed.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">No issues detected</div><div class="empty-sub">Page is running healthy</div></div>`;
    return;
  }

  allEvents.forEach(evt => {
    const isWarn = evt.type.includes('warn');
    const card   = document.createElement('div');
    card.className = `error-card ${isWarn ? 'warning' : ''}`;

    let displayMsg = evt.message || evt.statusText || 'Unknown issue';
    if (evt.type === 'network_error') displayMsg = `${evt.method} ${evt.status} — ${evt.url}`;

    const time     = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '';
    const typeIcon = evt.type === 'network_error' ? '🌐' : evt.type === 'console_warn' ? '⚠️' : evt.type === 'unhandled_rejection' ? '💥' : '🔴';

    let snippetHtml = '';
    if (evt.dom_snippet) {
      snippetHtml = `<div class="snippet-label">📌 DOM Element</div><div class="error-snippet">${escapeHTML(evt.dom_snippet)}</div>`;
    } else if (evt.stack) {
      snippetHtml = `<div class="snippet-label">📎 Stack Trace</div><div class="error-snippet">${escapeHTML(evt.stack.split('\n').slice(0, 3).join('\n'))}</div>`;
    }

    card.innerHTML = `
      <div class="card-header">
        <div class="error-type"><span class="type-dot"></span><span class="type-text">${typeIcon} ${evt.type.replace(/_/g, ' ')}</span></div>
        <div class="error-timestamp">${time}</div>
      </div>
      <div class="error-message">${escapeHTML(displayMsg)}</div>
      ${snippetHtml}
      <button class="debug-btn" data-payload='${JSON.stringify(evt).replace(/'/g, "&#39;")}'>🤖 Debug with AI</button>
      <div class="ai-solution" style="display: none;"></div>
    `;
    feed.appendChild(card);
  });

  document.querySelectorAll('.debug-btn').forEach(btn => {
    btn.addEventListener('click', handleDebugClick);
  });
}

// ─── Streaming Debug ──────────────────────────────────────────────────────────
async function handleDebugClick(e) {
  const btn         = e.currentTarget;
  const payload     = JSON.parse(btn.getAttribute('data-payload'));
  payload.model     = selectedModel || null;
  // Attach GitHub credentials so backend can fetch the real source file
  if (githubConfig.token && githubConfig.repo) {
    payload.github_token = githubConfig.token;
    payload.repo         = githubConfig.repo;
  }

  btn.innerHTML     = `Analyzing <span class="thinking-dots"><span></span><span></span><span></span></span>`;
  btn.disabled      = true;

  const solutionDiv = btn.nextElementSibling;
  solutionDiv.style.display = 'block';
  solutionDiv.innerHTML     = '<div class="stream-cursor-wrap"><span class="stream-cursor"></span></div>';

  let fullText = '';

  try {
    const response = await fetch(`${BACKEND}/debug`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let parsed;
        try { parsed = JSON.parse(line.slice(6)); } catch { continue; }

        if (parsed.token) {
          fullText += parsed.token;
          renderStreamingText(solutionDiv, fullText);
        }
        if (parsed.done) {
          renderFinalSolution(solutionDiv, fullText, payload);
          btn.innerHTML = '✅ Debugged';
          btn.classList.add('success');
        }
        if (parsed.error) {
          solutionDiv.innerHTML = `<p style="color:#f87171;font-size:12px;">⚠️ ${escapeHTML(parsed.error)}</p>`;
          btn.innerHTML = '🤖 Debug with AI';
          btn.disabled  = false;
        }
        if (parsed.info) {
          // Non-blocking notice — model was auto-switched, stream continues
          const note = document.createElement('div');
          note.style.cssText = 'font-size:10px;color:#d29922;margin-bottom:4px;';
          note.textContent = `ℹ️ ${parsed.info}`;
          solutionDiv.prepend(note);
        }
      }
    }
  } catch (err) {
    solutionDiv.innerHTML = `<p style="color:#f87171;font-size:12px;">⚠️ Backend offline. Start FastAPI on port 8000.</p>`;
    btn.innerHTML = '🤖 Debug with AI';
    btn.disabled  = false;
  }
}

function renderStreamingText(container, text) {
  container.innerHTML = `<div class="stream-text">${escapeHTML(text)}<span class="stream-cursor"></span></div>`;
}

function renderFinalSolution(container, fullText, originalPayload) {
  // Parse the four sections
  const expParts  = fullText.split('##FIX##');
  const rawExpl   = (expParts[0] || '').replace('##EXPLANATION##', '').trim();

  const fixAndRest = (expParts[1] || '');
  const fixParts   = fixAndRest.split('##FILE##');
  const rawFix     = fixParts[0].trim();

  const fileAndRest   = (fixParts[1] || '');
  const fileParts     = fileAndRest.split('##BRANCH_HINT##');
  // Sanitize: take the first non-empty line, strip quotes/backticks/parens Claude might add
  const rawFile = (fileParts[0] || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0 && !l.startsWith('(') && !l.startsWith('#')) || '';
  const cleanFile = rawFile
    .replace(/^['"\`(]+|['"\`);]+$/g, '')  // strip wrapping punctuation
    .trim();
  const rawBranchHint = (fileParts[1] || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0 && !l.startsWith('(') && !l.startsWith('#')) || '';
  const cleanBranch = rawBranchHint.replace(/^['"\`(]+|['"\`);]+$/g, '').trim();

  let html = '';
  if (rawExpl) {
    html += `<div class="solution-section"><div class="solution-label explanation-label">💡 Explanation</div><p>${escapeHTML(rawExpl)}</p></div>`;
  }
  if (rawFix) {
    html += `<div class="solution-section"><div class="solution-label fix-label">🔧 Suggested Fix</div><pre><code>${escapeHTML(rawFix)}</code></pre></div>`;
  }
  if (cleanFile && cleanFile !== 'unknown') {
    html += `<div class="solution-section"><div class="solution-label file-label">📁 File</div><code class="file-chip">${escapeHTML(cleanFile)}</code></div>`;
  }
  if (!html) html = `<p>${escapeHTML(fullText)}</p>`;

  // GitHub Apply Fix — show whenever repo is connected, even if file is unknown
  if (githubConfig.token && githubConfig.repo && rawFix) {
    const fileKnown = cleanFile && cleanFile !== 'unknown';
    const fileInputHtml = fileKnown
      ? `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
           <span class="settings-label" style="white-space:nowrap;">File:</span>
           <code class="file-chip" id="apply-file-display">${escapeHTML(cleanFile)}</code>
           <input type="hidden" id="apply-file-input" value="${escapeHTML(cleanFile)}">
         </div>`
      : `<div style="margin-bottom:8px;">
           <label class="settings-label" style="display:block;margin-bottom:4px;">📁 Which file needs this fix?</label>
           <input type="text" id="apply-file-input" class="settings-input" 
                  placeholder="e.g. index.html or src/app.js" 
                  style="font-size:11px;padding:7px 10px;">
         </div>`;

    html += `
      <div class="apply-fix-wrap" style="margin-top:12px;">
        ${fileInputHtml}
        <button class="apply-fix-btn"
          data-file="${escapeHTML(cleanFile)}"
          data-fix="${escapeHTML(rawFix)}"
          data-error="${escapeHTML(originalPayload.message || '')}"
          data-branch="${escapeHTML(cleanBranch)}"
          data-file-known="${fileKnown}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
          Apply Fix on GitHub
        </button>
        <div class="apply-fix-result"></div>
      </div>`;
  }

  container.innerHTML = html;

  // Attach apply-fix listener
  const applyBtn = container.querySelector('.apply-fix-btn');
  if (applyBtn) applyBtn.addEventListener('click', handleApplyFix);
}

// ─── GitHub Apply Fix ─────────────────────────────────────────────────────────
async function handleApplyFix(e) {
  const btn       = e.currentTarget;
  const wrap      = btn.closest('.apply-fix-wrap') || btn.parentElement;
  const fileInput = wrap ? wrap.querySelector('#apply-file-input') : null;

  // Get file path — from hidden input (auto-detected) or visible text input (user typed)
  let filePath = fileInput ? fileInput.value.trim() : btn.getAttribute('data-file');

  if (!filePath) {
    const resultDiv = wrap ? wrap.querySelector('.apply-fix-result') : btn.nextElementSibling;
    if (resultDiv) resultDiv.innerHTML = `<div class="apply-result error">⚠️ Please enter the file path before applying.</div>`;
    return;
  }

  const fixText   = btn.getAttribute('data-fix');
  const errorMsg  = btn.getAttribute('data-error');
  const resultDiv = wrap ? wrap.querySelector('.apply-fix-result') : btn.nextElementSibling;

  btn.textContent = '⏳ Applying…';
  btn.disabled    = true;
  resultDiv.innerHTML = '';

  try {
    const res  = await fetch(`${BACKEND}/apply-fix`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        github_token:  githubConfig.token,
        repo:          githubConfig.repo,
        file_path:     filePath,
        fix_text:      fixText,
        error_message: errorMsg,
        base_branch:   githubConfig.defaultBranch || 'main',
        model:         selectedModel
      })
    });
    const data = await res.json();

    if (data.ok) {
      resultDiv.innerHTML = `
        <div class="apply-result success">
          ✅ Pushed to <strong>${escapeHTML(data.branch)}</strong><br>
          <a class="result-link" href="${data.compare_url}" target="_blank">View diff / Open PR →</a>
        </div>`;
      btn.textContent = '✅ Applied';
      btn.classList.add('applied');
    } else {
      resultDiv.innerHTML = `<div class="apply-result error">⚠️ ${escapeHTML(data.error)}</div>`;
      btn.textContent = 'Apply Fix on GitHub';
      btn.disabled    = false;
    }
  } catch {
    resultDiv.innerHTML = `<div class="apply-result error">⚠️ Backend offline.</div>`;
    btn.textContent = 'Apply Fix on GitHub';
    btn.disabled    = false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g,
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}
