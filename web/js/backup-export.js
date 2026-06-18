// Notes, backup/import, CSV export, modal helpers, toasts, and mock data injection.

// ════════════════════════════════════════════
   // NOTE FIELD HELPERS
// ════════════════════════════════════════════
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}
// Save the note for a selected measurement.
function saveNote(entryId, text) {
  const e = S.history.find(h => h.id === entryId);
  if (e) { e.note = text; saveAppData(); }
}
// Save the note for the active project.
function saveProjNote(projId, text) {
  const p = S.projects.find(x => x.id === projId);
  if (p) { p.note = text; saveAppData(); }
}
// Initialize textarea autosizing for notes.
function initNoteFields() {
  document.querySelectorAll('.note-field').forEach(el => autoResize(el));
}

// ════════════════════════════════════════════
   // CURTAIN CALCULATION
// ════════════════════════════════════════════
function distanceForMode(mode) {
  if (mode === 'up' || mode === 'down') return S.sensorDistanceYmm;
  if (mode === 'central') return 0;
  return S.sensorDistanceXmm;
}

// Calculate curtain travel speed between two sensor timestamps.
function calcCurtain(entry) {
  const profile = curtainSpeedProfile(entry);
  if (!profile) return null;
  const avg = arr => arr.length ? arr.reduce((sum, point) => sum + point.v, 0) / arr.length : 0;
  return { v1: avg(profile.open), v2: avg(profile.close) };
}


// Move one measurement back to the default project.
function moveMeasurementToDefault(id) {
  ensureDefaultProject();
  const entry = S.history.find(h => h.id === id);
  if (!entry) return;
  entry.projId = DEFAULT_PROJECT_ID;
  S.selectedProjId = DEFAULT_PROJECT_ID;
  saveAppData();
  renderProjList();
  renderHistList();
  renderDetailView(id);
  toast(tx('toast.measurementMovedToDefault', 'Measurement moved to the default project'), 'success');
}

// ════════════════════════════════════════════
   // BACKUP + NAVIGATION
// ════════════════════════════════════════════
function redirectToLatestMeasurement() {
  ensureDefaultProject();
  const latest = currentProjectEntries(false)[0];
  if (!latest) {
    setContentFlush(false);
    S.selId = null;
    const content = document.getElementById('content');
    if (content) content.innerHTML = '';
    renderEmptyStateIfNeeded();
    return;
  }
  if (S.selId !== latest.id) selectEntry(latest.id, false);
  else renderDetailView(latest.id);
}

// Export projects, history, settings, and cached config as JSON.
function exportBackupJSON() {
  const payload = {
    app: 'OpenCurtainLab',
    version: 5,
    exportedAt: new Date().toISOString(),
    sensorDistanceXmm: S.sensorDistanceXmm,
    sensorDistanceYmm: S.sensorDistanceYmm,
    selectedProjId: S.selectedProjId,
    projects: S.projects,
    history: S.history,
    uiSettings: S.uiSettings,
  };
  const json = JSON.stringify(payload, null, 2);
  const dateStr = timestampForFilename();
  downloadTextFile(json, 'opencurtainlab_backup_' + dateStr + '.json', 'application/json;charset=utf-8;');
  toast(tx('toast.backupExported', 'JSON backup exported'), 'success');
}

// Import a previously exported WebUI backup JSON file.
async function importBackupJSON(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const projects = Array.isArray(data.projects) ? data.projects : null;
    const history = Array.isArray(data.history) ? data.history : null;
    if (!projects || !history) throw new Error(tx('errors.invalidBackup', 'Invalid backup'));
    if (!confirm(tx('confirm.importBackup', 'Import JSON backup? Current projects and history will be replaced.'))) return;
    S.projects = projects;
    S.history = history;
    S.selectedProjId = data.selectedProjId && projects.some(p => p.id === data.selectedProjId) ? data.selectedProjId : null;
    ensureDefaultProject();
    sanitizeMeasurementAssignments();
    S.sensorDistanceXmm = Number(data.sensorDistanceXmm || S.sensorDistanceXmm || 7.62);
    S.sensorDistanceYmm = Number(data.sensorDistanceYmm || S.sensorDistanceYmm || 5.08);
    S.uiSettings = sanitizeUiSettings(data.uiSettings || S.uiSettings || {});
    saveUiSettings();
    S.selId = null;
    S.lastMeasId = S.history.length ? S.history[0].id : null;
    saveAppData();
    renderProjList();
    renderHistList();
    redirectToLatestMeasurement();
    toast(tx('toast.backupImported', 'JSON backup imported'), 'success');
  } catch (e) {
    toast(tx('toast.importFailed', 'Import failed: no valid JSON file'), 'error');
  }
}

// Clear all local WebUI data after user confirmation.
function resetLocalWebUiData() {
  if (!confirm(tx('confirm.resetLocalData', 'Reset all local WebUI data? This removes projects, measurements and cached device settings.'))) return;
  localStorage.removeItem(LS_HISTORY_KEY);
  localStorage.removeItem(LS_PROJECTS_KEY);
  localStorage.removeItem(LS_DEVICE_KEY);
  localStorage.removeItem(LS_UI_KEY);
  S.projects = [];
  S.history = [];
  S.selId = null;
  S.lastMeasId = null;
  S.selectedProjId = null;
  S.deviceConfig = null;
  S.deviceSettings = Object.assign({}, DEFAULT_DEVICE_SETTINGS);
  S.uiSettings = Object.assign({}, DEFAULT_UI_SETTINGS);
  ensureDefaultProject();
  saveAppData();
  renderProjList();
  renderHistList();
  const content = document.getElementById('content');
  if (content) content.innerHTML = '';
  renderEmptyStateIfNeeded();
  toast(tx('toast.localDataReset', 'Local WebUI data reset'), 'success');
}

// Load custom target times from the active project into the device settings form.
async function loadProjectCustomTimes(projId) {
  const p = S.projects.find(x => x.id === projId);
  if (!p || projectTargetSeries(p) !== 'custom') return;
  const times = (Array.isArray(p.customTargetTimes) && p.customTargetTimes.length ? p.customTargetTimes : p.times)
    .map(Number).filter(v => Number.isFinite(v) && v > 0);
  if (!times.length) { toast(tx('toast.noTargetTimesSelected', 'Select at least one target time'), 'warning'); return; }
  const maxT = deviceMaxTargetTime();
  if (times.some(v => v > maxT)) {
    toast(tf('toast.customTimesInvalidWithMax', 'Invalid custom target times. Use positive numbers up to 1/{max}, separated by commas.', {max: maxT}), 'warning');
    return;
  }
  if (!S.deviceBase && !(await initDeviceConnection(true))) return;
  try {
    const body = { targetSeries: 'custom', customTargetTimes: times };
    const r = await fetch(api('/config'), {
      method: 'POST', mode: 'cors', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(2500)
    });
    if (!r.ok) throw 0;
    const d = await r.json();
    applyConfigPostResponse(d);
    saveDeviceConfigLocal();
    renderSettingsControls();
    toast(tx('toast.customTimesLoaded', 'Custom times loaded into the device'), 'success');
  } catch (e) {
    toast(tx('toast.customTimesLoadFailed', 'Custom times could not be loaded'), 'error');
  }
}

// ════════════════════════════════════════════
   // CSV EXPORT
// ════════════════════════════════════════════


function exportProjCSV(projId) {
  const p = S.projects.find(x => x.id === projId);
  if (!p) return;
  // Header: note first, then aggregated table
  const lines = [];
  if (p.note) lines.push('# ' + tx('csv.note', 'Note') + ': ' + p.note.replace(/\n/g,' | '));
  lines.push('# ' + tx('csv.project', 'Project') + ': ' + p.name);
  lines.push('# ' + tx('csv.exported', 'Exported') + ': ' + new Date().toLocaleString(uiLocale()));
  lines.push('');
  const hdr = ['Target_1x','Target_s','Avg_Fraction','Avg_ms','Deviation_EV','Spread_EV',
               'OpeningSpeed_m_s','ClosingSpeed_m_s','Flash_OK','Flash_NOK','Flash_Detected','Count'];
  lines.push(hdr.join(';'));
  p.times.forEach(tgt => {
    const agg = aggregateForTarget(projId, tgt);
    if (!agg) { lines.push([tgt,(1/tgt).toFixed(6),'','','','','','','','','','0'].join(';')); return; }
    const dev = Math.log2(agg.avgSec * tgt);
    lines.push([
      tgt, (1/tgt).toFixed(6),
      agg.avgFrac, (agg.avgSec*1000).toFixed(4),
      dev.toFixed(4), agg.avgSpread.toFixed(4),
      agg.avgV1!=null?agg.avgV1.toFixed(4):'',
      agg.avgV2!=null?agg.avgV2.toFixed(4):'',
      agg.flashOk, agg.flashBad, agg.flashDetected,
      agg.n,
    ].join(';'));
  });
  const dateStr = timestampForFilename();
  const safeName = (p.name||'export').replace(/[^a-zA-Z0-9_\-]/g,'_');
  dlCSV(lines.join('\n'), safeName + '_' + dateStr + '.csv');
  toast(tf('toast.csvExported', 'CSV exported — {count} target times', {count: p.times.length}));
}

// Download a CSV file.
function dlCSV(csv, fn) {
  const b = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
  const a = Object.assign(document.createElement('a'), {href:URL.createObjectURL(b),download:fn});
  a.click(); URL.revokeObjectURL(a.href);
}

// ════════════════════════════════════════════
   // MODAL + TOAST + UTILS
// ════════════════════════════════════════════
function openModal(id)  { document.getElementById(id).classList.add('open'); }
// Close a modal dialog.
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.overlay').forEach(el =>
  el.addEventListener('click', e => { if (e.target===el) el.classList.remove('open'); })
);

let _tt;
// Show a transient notification message.
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  const safeType = ['info', 'success', 'warning', 'error'].includes(type) ? type : 'info';
  el.textContent = msg;
  el.className = 'toast show toast-' + safeType;
  clearTimeout(_tt);
  const duration = safeType === 'error' ? 5200 : safeType === 'warning' ? 4200 : 3000;
  _tt = setTimeout(() => el.classList.remove('show'), duration);
}

// Escape text for safe HTML insertion.
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ════════════════════════════════════════════
   // MOCK DATA (dev)
// ════════════════════════════════════════════
function injectMock(targetFrac, flash = 'ok', direction = 'left') {
  const availableTimes = (S.targetTimes && S.targetTimes.length ? S.targetTimes : ALL_TIMES);
  const tf = Number(targetFrac) || availableTimes[Math.floor(Math.random() * availableTimes.length)];

  function norm(v) {
    return String(v || '').toLowerCase().replace(/[-_\s]/g, '');
  }

  function normDirection(v) {
    const m = norm(v || 'left');
    if (m === 'left') return 'left';
    if (m === 'down') return 'down';
    if (m === 'right') return 'right';
    if (m === 'up') return 'up';
    if (m === 'central') return 'central';
    return 'left';
  }

  function normFlash(v) {
    if (v === true) return 'ok';
    if (v === false) return 'none';
    const f = norm(v || 'ok');
    if (f === 'ok' || f === 'sync' || f === 'good') return 'ok';
    if (f === 'bad' || f === 'nok' || f === 'outside' || f === 'fail') return 'bad';
    if (f === 'none' || f === 'off' || f === 'no') return 'none';
    if (f === 'random') return 'random';
    return 'ok';
  }

  const mode = normDirection(direction);
  const flashMode = normFlash(flash);
  const targetSec = 1 / tf;
  const baseUs = 1000000 + Math.floor(Math.random() * 100000);
  const nominalDurationUs = Math.round(targetSec * 1e6);

  // Sensor order for the simulated curtain movement. The five sensors are diagonal; horizontal and vertical modes use different distances in analysis, but the simulated event order can stay the same.
  const order = (() => {
    if (mode === 'central') return [0, 1, 2, 3, 4];
    if (mode === 'left' || mode === 'up') return [4, 3, 2, 1, 0];
    return [0, 1, 2, 3, 4];
  })();

  // Curtain travel time between neighboring sensors. Fast target speeds use shorter travel steps so the simulated packet remains plausible.
  const stepUs = mode === 'central'
    ? 0
    : Math.max(35, Math.min(260, Math.round(nominalDurationUs * 0.08 + 50 + Math.random() * 50)));

  const sensors = Array.from({ length: 5 }, (_, id) => ({
    id,
    pin: 34 + id,
    activated: true,
    raw: 750 + Math.round(Math.random() * 180),
    baseline: 3000 + Math.round(Math.random() * 300),
    openUs: 0,
    closeUs: 0
  }));

  order.forEach((id, idx) => {
    const openJitterUs = mode === 'central'
      ? Math.round((Math.random() - 0.5) * 20)
      : Math.round((Math.random() - 0.5) * 18);
    const durationJitter = 1 + (Math.random() - 0.5) * 0.08;
    const openUs = baseUs + idx * stepUs + openJitterUs;
    const durationUs = Math.max(40, Math.round(nominalDurationUs * durationJitter));
    sensors[id].openUs = openUs;
    sensors[id].closeUs = openUs + durationUs;
  });

  const active = sensors.filter(s => s.activated && s.openUs > 0 && s.closeUs > s.openUs);
  const lastOpenUs = Math.max(...active.map(s => s.openUs));
  const firstCloseUs = Math.min(...active.map(s => s.closeUs));
  const hasTotalOpenWindow = firstCloseUs >= lastOpenUs;

  let detected = false;
  let triggerUs = 0;

  if (flashMode === 'ok') {
    detected = hasTotalOpenWindow;
    triggerUs = detected
      ? Math.round(lastOpenUs + (firstCloseUs - lastOpenUs) * (0.25 + Math.random() * 0.5))
      : 0;
  } else if (flashMode === 'bad') {
    detected = true;
    triggerUs = Math.random() < 0.5
      ? Math.round(lastOpenUs - 500 - Math.random() * 1500)
      : Math.round(firstCloseUs + 500 + Math.random() * 1500);
  } else if (flashMode === 'random') {
    const r = Math.random();
    if (r < 0.55 && hasTotalOpenWindow) {
      detected = true;
      triggerUs = Math.round(lastOpenUs + (firstCloseUs - lastOpenUs) * (0.15 + Math.random() * 0.7));
    } else if (r < 0.85) {
      detected = true;
      triggerUs = Math.random() < 0.5
        ? Math.round(lastOpenUs - 500 - Math.random() * 1500)
        : Math.round(firstCloseUs + 500 + Math.random() * 1500);
    }
  }

  ingestMeasurement({
    valid: true,
    id: 'mock_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    target: tf,
    baseUs,
    sensorDistanceXmm: S.sensorDistanceXmm,
    sensorDistanceYmm: S.sensorDistanceYmm,
    mode,
    sensors,
    flash: {
      detected,
      pin: 39,
      raw: detected ? 700 : 3100,
      baseline: 3200,
      triggerUs: detected ? triggerUs : 0
    }
  });
}
