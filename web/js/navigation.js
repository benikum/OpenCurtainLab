// Main content switching, tutorial rendering, language switching, and navigation.

// Replace the main content area and clear measurement selection state.
function setContentFlush(enabled) {
  const content = document.getElementById('content');
  if (content) content.classList.toggle('flush', !!enabled);
}

// Show the empty-state or quick-start view in the main content area.
function setContentEmptyView(enabled) {
  const content = document.getElementById('content');
  if (content) content.classList.toggle('empty-view', !!enabled);
}

const SIDEBAR_TOOL_BUTTON_IDS = ['github-btn', 'manual-toggle-btn', 'language-btn', 'settings-toggle-btn'];

// Keep sidebar tool highlighting mutually exclusive.
function setSidebarToolActive(btnId) {
  for (const id of SIDEBAR_TOOL_BUTTON_IDS) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('active', !!btnId && id === btnId);
  }
}

// Open or close a side tool panel.
function setToolPanel(panelId, btnId, open) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.style.display = open ? 'block' : 'none';
  if (open) panel.scrollTop = 0;
  if (open) setSidebarToolActive(btnId);
  else if (btnId && document.getElementById(btnId)?.classList.contains('active')) setSidebarToolActive(null);
}

// Mark the settings navigation button as active only while the settings page is shown.
function setSettingsNavActive(active) {
  setSidebarToolActive(active ? 'settings-toggle-btn' : null);
}

// Return whether the settings page is currently rendered in the content area.
function isSettingsPageVisible() {
  const content = document.getElementById('content');
  return !!(content && content.querySelector('.settings-page'));
}

// Render settings as a normal content page.
function showSettingsPage() {
  const content = document.getElementById('content');
  const tpl = document.getElementById('settings-page-template');
  if (!content || !tpl) return;
  S.selId = null;
  renderHistList();
  setToolPanel('language-panel', 'language-btn', false);
  setContentEmptyView(false);
  setContentFlush(false);
  content.innerHTML = tpl.innerHTML;
  applyStaticTranslations();
  renderSettingsControls(true);
  renderDeviceConfigSummary();
  renderWebUiVersionSummary();
  setSettingsNavActive(true);
  if (window.innerWidth <= 767) toggleSidebar();
}

// Toggle the language selection panel.
function toggleLanguagePanel() {
  const panel = document.getElementById('language-panel');
  const open = panel && panel.style.display === 'none';
  setToolPanel('language-panel', 'language-btn', open);
  updateLanguageButton();
}


// Open the project repository in a new tab.
function openGitHub() {
  setSidebarToolActive('github-btn');
  setToolPanel('language-panel', 'language-btn', false);
  window.open(GITHUB_URL, '_blank', 'noopener');
}

// Return the current URL hash without the leading marker.
function currentHashAnchor() {
  try { return decodeURIComponent(String(location.hash || '').replace(/^#/, '')).trim(); }
  catch (e) { return String(location.hash || '').replace(/^#/, '').trim(); }
}

// Append the current hash to a URL when one exists.
function urlWithCurrentHash(url) {
  const anchor = currentHashAnchor();
  if (!anchor || String(url).includes('#')) return url;
  return String(url) + '#' + encodeURIComponent(anchor);
}

// Update the browser URL hash without forcing a full page reload.
function setParentHashAnchor(anchor) {
  if (!anchor) return;
  try {
    const url = new URL(window.location.href);
    url.hash = encodeURIComponent(anchor);
    window.history.replaceState(null, '', url.toString());
  } catch (e) {}
}


// Find an anchor target inside the main content area.
function findAnchorTarget(root, anchor) {
  if (!root || !anchor) return null;
  const doc = root.nodeType === 9 ? root : root.ownerDocument;
  if (doc && root === doc) {
    const direct = doc.getElementById(anchor);
    if (direct) return direct;
    const named = doc.getElementsByName ? doc.getElementsByName(anchor) : null;
    return named && named.length ? named[0] : null;
  }

  const all = root.querySelectorAll ? root.querySelectorAll('[id], a[name]') : [];
  for (const el of all) {
    if (el.id === anchor || el.getAttribute('name') === anchor) return el;
  }
  return null;
}

// Scroll the content area to an anchor target.
function scrollContentToAnchor(anchor, smooth = false) {
  const content = document.getElementById('content');
  if (!content || !anchor) return false;
  const target = findAnchorTarget(content, anchor);
  if (!target) return false;
  try {
    target.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
  } catch (e) {
    target.scrollIntoView();
  }
  return true;
}

// Bind tutorial table-of-contents links to in-page scrolling.
function bindTutorialAnchors(content) {
  if (!content || content.__oclTutorialAnchorBinding) return;
  content.__oclTutorialAnchorBinding = true;
  content.addEventListener('click', (ev) => {
    const link = ev.target && ev.target.closest ? ev.target.closest('.tutorial a[href^="#"]') : null;
    if (!link || !content.contains(link)) return;
    const href = link.getAttribute('href') || '';
    const anchor = decodeURIComponent(href.replace(/^#/, '')).trim();
    if (!anchor || !findAnchorTarget(content, anchor)) return;
    ev.preventDefault();
    setParentHashAnchor(anchor);
    scrollContentToAnchor(anchor, true);
  });
}

// Fetch a tutorial HTML fragment in development mode.
async function fetchTutorialFragment(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error('Tutorial not found');
  return response.text();
}

// Render a tutorial fragment into the main content area.
function showTutorialHtml(html, title) {
  const content = document.getElementById('content');
  if (!content) return;
  S.selId = null;
  renderHistList();
  setSidebarToolActive('manual-toggle-btn');
  setToolPanel('language-panel', 'language-btn', false);
  setContentEmptyView(false);
  setContentFlush(false);
  content.innerHTML = html;
  bindTutorialAnchors(content);

  const anchor = currentHashAnchor();
  if (anchor) requestAnimationFrame(() => scrollContentToAnchor(anchor, false));
}

// Read a tutorial fragment embedded as a <template> in the compiled single-file build.
function getEmbeddedTutorialHtml() {
  const lang = getUiLanguage();
  const el = document.getElementById('ocl-tutorial-' + lang)
    || document.getElementById('ocl-tutorial-en')
    || document.getElementById('ocl-manual-' + lang)
    || document.getElementById('ocl-manual-en');
  return el ? (el.innerHTML || el.textContent || '') : '';
}


// Build the development-mode URL for a tutorial fragment.
function getTutorialUrl() {
  const cfg = sourceConfig();
  const dir = String(cfg.tutorialDir || 'tutorial').replace(/\/$/, '');
  return `${dir}/${getUiLanguage()}.html`;
}

// Load and show the tutorial for the active language.
function showManualPage() {
  const title = tx('frame.manualTitle', 'OpenCurtainLab Guide');
  const html = getEmbeddedTutorialHtml();
  if (html) {
    showTutorialHtml(html, title);
    return;
  }

  fetchTutorialFragment(getTutorialUrl())
    .then(fragment => showTutorialHtml(fragment, title))
    .catch(() => {
      const content = document.getElementById('content');
      if (!content) return;
      setSidebarToolActive('manual-toggle-btn');
      setToolPanel('language-panel', 'language-btn', false);
      setContentEmptyView(true);
      setContentFlush(false);
      content.innerHTML = `<div class="empty"><div class="empty-ico">?</div><div class="empty-txt">${esc(title)}</div><div class="empty-sub">${esc(tx('frame.manualLoadFailed', 'The guide could not be loaded.'))}</div></div>`;
    });
}

// Return the current UI language code.
function getUiLanguage() {
  return normLang(document.documentElement.lang || safeLocalStorageGet('ocl_ui_language') || 'en');
}

// Update the language toggle buttons and labels.
function updateLanguageButton() {
  const lang = getUiLanguage();
  const flag = lang === 'de' ? '🇩🇪' : '🇬🇧';
  const title = lang === 'de' ? 'Deutsch' : 'English';
  const btn = document.getElementById('language-btn');

  if (!btn) return;

  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = `<span class="language-btn-flag" aria-hidden="true">${flag}</span>`;
}


// Persist current UI-only state such as language and chart options.
function persistUiState() {
  try {
    saveAppData();
    saveDeviceConfigLocal();
  } catch(e) {
    console.warn('Could not persist UI state before navigation', e);
  }
}

// Keep the visible URL query string in sync with the current language.
function syncLanguageUrl(lang) {
  try {
    if (!window.history || !window.history.replaceState) return;
    const url = new URL(window.location.href);
    url.searchParams.set('lang', normLang(lang));
    window.history.replaceState(null, '', url.toString());
  } catch (e) {}
}

// Check whether the tutorial is currently displayed.
function isTutorialPageVisible() {
  const content = document.getElementById('content');
  return !!(content && content.querySelector('.manual-page.tutorial'));
}

// Refresh all visible UI sections after a language switch.
function rerenderAfterLanguageChange() {
  const tutorialVisible = isTutorialPageVisible();

  applyStaticTranslations();
  ensureDefaultProject();
  saveProjects();
  renderProjList();
  renderHistList();
  renderSettingsControls(true);
  renderDeviceConfigSummary();
  renderWebUiVersionSummary();

  if (tutorialVisible) showManualPage();
  else if (isSettingsPageVisible()) showSettingsPage();
  else if (S.selId) renderDetailView(S.selId);
  else renderEmptyStateIfNeeded();

  updateLanguageButton();
}

// Switch the UI language and rerender the page.
function setLanguage(lang) {
  const next = normLang(lang || 'en');

  if (next === getUiLanguage()) {
    setToolPanel('language-panel', 'language-btn', false);
    return;
  }

  persistUiState();
  safeLocalStorageSet('ocl_ui_language', next);
  setToolPanel('language-panel', 'language-btn', false);

  if (setActiveTextLanguage(next)) {
    syncLanguageUrl(next);
    rerenderAfterLanguageChange();
    return;
  }

  toast(tx('toast.languageUnavailable', 'Language resources are not available'), 'warning');
}

window.addEventListener('pagehide', persistUiState);


// Fetch the current device status from the firmware.
async function fetchDeviceStatus(force = false) {
  if (!S.deviceBase) return null;
  const now = Date.now();
  if (!force && now - S.lastStatusAt < STATUS_POLL_MS) return null;
  S.lastStatusAt = now;
  try {
    const r = await fetch(api('/status'), { signal: AbortSignal.timeout(1200), mode: 'cors' });
    if (!r.ok) return null;
    const status = await r.json();
    applyDeviceStatus(status);
    return status;
  } catch (e) {
    return null;
  }
}
