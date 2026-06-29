// WebUI startup, event binding, polling, and developer console hints.

// ════════════════════════════════════════════
   // INIT
// ════════════════════════════════════════════
function showSourceI18nWarningIfNeeded() {
  if (!OCL_I18N_LOAD_ERROR || document.getElementById('source-i18n-warning')) return;
  const warning = document.createElement('div');
  warning.id = 'source-i18n-warning';
  warning.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;padding:12px 14px;border:1px solid rgba(245,176,48,.55);border-radius:12px;background:#1b1509;color:#f5e6c8;font:14px/1.4 system-ui, sans-serif;box-shadow:0 12px 36px rgba(0,0,0,.35)';
  warning.innerHTML = '<b>OpenCurtainLab source mode:</b> i18n JSON could not be loaded. Start a local web server in <code>web/</code>, for example <code>python3 -m http.server 8000</code>, or open <code>web/compiled/compiled-v0.1.1.html</code>.';
  document.body.appendChild(warning);
}

// Initialize persistent state, UI bindings, device connection, and polling.
function init() {
  applyStaticTranslations();
  showSourceI18nWarningIfNeeded();
  bindBackupFileInput();
  load();
  renderProjList();
  renderEmptyStateIfNeeded();
  renderHistList();
  if (S.history.length) redirectToLatestMeasurement();
  renderSettingsControls();
  renderDeviceConfigSummary();
  renderWebUiVersionSummary();
  initDeviceConnection(false).then(() => poll());
  renderEmptyStateIfNeeded();
  updateLanguageButton();
  startPollingLoop();
  window.addEventListener('resize', () => {
    const e = S.history.find(h => h.id === S.selId);
    if (e) requestAnimationFrame(() => { drawTimeline(e); drawCurtainTimeChart(e); });
    const cc = document.getElementById('curtain-chart');
    if (cc) {
      const pid = cc.dataset.projId;
      if (pid) { const pp=S.projects.find(x=>x.id===pid); if(pp) drawCurtainChart(pp); }
    }
  });
  window.addEventListener('hashchange', () => {
    if (!isTutorialPageVisible()) return;
    const anchor = currentHashAnchor();
    if (anchor) scrollContentToAnchor(anchor, false);
  });
  if (isDevToolsEnabled()) {
    registerDevTools();
    window.oclSensors = fetchSensorDiagnostics;
    console.log('%cOpenCurtainLab', 'font-size:18px;color:#f5b030;font-weight:bold');
    console.log('Dev commands: injectMock()  injectMock(500)  injectMock(500, "ok", "horizontal")  injectMock(125, "bad", "vertical")  injectMock(30, "none", "central")  injectMock(undefined, "random", "horizontal")');
    console.log('Sensor diagnostics: oclSensors()');
  }
}

// Start the WebUI after translation bundles are available.
async function bootstrap() {
  const loaded = await loadSourceI18n();
  if (loaded) {
    activateInitialTextLanguage();
  } else {
    const requested = requestedLanguageFromUrl();
    if (requested) document.documentElement.lang = requested;
  }
  init();
}

bootstrap();
