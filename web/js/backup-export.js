// Project notes, backup/import, CSV export, modal helpers, toasts, and developer test-data injection.

// ════════════════════════════════════════════
   // NOTE FIELD HELPERS
// ════════════════════════════════════════════
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
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
function currentMeasurementGeometry() {
  const cfg = S.deviceConfig || {};
  const x = Number(cfg.sensorDistanceXmm);
  const y = Number(cfg.sensorDistanceYmm);
  return {
    sensorDistanceXmm: Number.isFinite(x) && x > 0 ? x : DEFAULT_SENSOR_DISTANCE_X_MM,
    sensorDistanceYmm: Number.isFinite(y) && y > 0 ? y : DEFAULT_SENSOR_DISTANCE_Y_MM,
  };
}

function distanceForMode(mode, entry = null) {
  const normalizedMode = normalizeMeasurementMode(mode);
  if (normalizedMode === 'central') return 0;
  const geometry = currentMeasurementGeometry();
  const source = entry || {};
  const rawDistance = normalizedMode === 'vertical'
    ? (source.sensorDistanceYmm ?? geometry.sensorDistanceYmm)
    : (source.sensorDistanceXmm ?? geometry.sensorDistanceXmm);
  const distance = Number(rawDistance);
  return Number.isFinite(distance) && distance > 0 ? distance : null;
}

// Calculate curtain travel speed between two sensor timestamps.
function calcCurtain(entry) {
  const profile = curtainSpeedProfile(entry);
  if (!profile) return null;
  const avg = arr => arr.length ? arr.reduce((sum, point) => sum + point.v, 0) / arr.length : 0;
  return { v1: avg(profile.open), v2: avg(profile.close) };
}

// Estimate focal-plane slit width from sensor exposure duration and curtain
// travel speed. Since 1 m/s equals 1 mm/ms, exposure in ms multiplied by the
// local curtain speed gives the slit width in mm.
function slitWidthStatsForEntry(entry) {
  if (!entry || normalizeMeasurementMode(entry.mode) === 'central') return null;
  const curtain = calcCurtain(entry);
  const speeds = [curtain && curtain.v1, curtain && curtain.v2].filter(v => Number.isFinite(v) && v > 0);
  const speed = average(speeds);
  if (!Number.isFinite(speed) || speed <= 0) return null;

  const widths = (entry.sensors || [])
    .filter(s => s.activated && Number.isFinite(s.seconds) && s.seconds > 0)
    .map(s => s.seconds * 1000 * speed)
    .filter(v => Number.isFinite(v) && v > 0);
  if (!widths.length) return null;

  return {
    min: Math.min(...widths),
    max: Math.max(...widths),
    avg: average(widths),
    n: widths.length,
  };
}

function slitWidthStatsForEntries(entries) {
  const stats = (entries || []).map(slitWidthStatsForEntry).filter(Boolean);
  if (!stats.length) return null;
  return {
    min: Math.min(...stats.map(x => x.min)),
    max: Math.max(...stats.map(x => x.max)),
    avg: average(stats.map(x => x.avg).filter(Number.isFinite)),
    n: stats.reduce((sum, x) => sum + (x.n || 0), 0),
  };
}


// Move one measurement back to the default project without changing the active project.
function moveMeasurementToDefault(id) {
  ensureDefaultProject();
  const entry = S.history.find(h => h.id === id);
  if (!entry) return;
  entry.projId = DEFAULT_PROJECT_ID;
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

function normalizeImportedBackup(data) {
  const sourceProjects = Array.isArray(data.projects) ? data.projects : null;
  const sourceHistory = Array.isArray(data.history) ? data.history : null;
  if (!sourceProjects || !sourceHistory) throw new Error(tx('errors.invalidBackup', 'Invalid backup'));

  const finiteNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  const positiveNumber = value => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const cleanTimeList = (value, fallback) => {
    const list = Array.isArray(value) ? value : fallback;
    const seen = new Set();
    return list.map(Number)
      .filter(v => Number.isInteger(v) && v > 0 && !seen.has(v) && seen.add(v))
      .sort((a, b) => a - b);
  };

  function normalizeImportedSensor(raw, idx, baseUs, targetSec) {
    const sensor = raw && typeof raw === 'object' ? raw : {};
    const openUs = finiteNumber(sensor.openUs, 0);
    const closeUs = finiteNumber(sensor.closeUs, 0);
    const fromUs = openUs > 0 && closeUs > openUs ? (closeUs - openUs) / 1e6 : 0;
    const fromSeconds = positiveNumber(sensor.seconds);
    const seconds = fromUs || fromSeconds;
    const activated = sensor.activated !== false && seconds > 0;
    const openMs = activated
      ? (baseUs && openUs ? (openUs - baseUs) / 1000 : finiteNumber(sensor.openMs, 0))
      : 0;
    const closeMs = activated
      ? (baseUs && closeUs ? (closeUs - baseUs) / 1000 : finiteNumber(sensor.closeMs, 0))
      : 0;

    return {
      id: Number.isInteger(Number(sensor.id)) ? Number(sensor.id) : idx,
      pin: Number.isInteger(Number(sensor.pin)) ? Number(sensor.pin) : undefined,
      activated,
      raw: Number.isFinite(Number(sensor.raw)) ? Number(sensor.raw) : 0,
      openUs: activated ? openUs : 0,
      closeUs: activated ? closeUs : 0,
      openMs,
      closeMs,
      seconds: activated ? seconds : 0,
      fraction: activated && seconds > 0 ? Math.round(1 / seconds) : 0,
      deviation: activated && seconds > 0 && targetSec > 0 ? Math.log2(seconds / targetSec) : 0,
    };
  }

  function normalizeImportedFlash(raw, baseUs) {
    if (!raw || typeof raw !== 'object') return null;
    const triggerUs = finiteNumber(raw.triggerUs, 0);
    const detected = !!raw.detected && triggerUs > 0;
    return {
      detected,
      pin: Number.isInteger(Number(raw.pin)) ? Number(raw.pin) : undefined,
      raw: Number.isFinite(Number(raw.raw)) ? Number(raw.raw) : 0,
      triggerUs: detected ? triggerUs : 0,
      triggerMs: detected && baseUs ? (triggerUs - baseUs) / 1000 : null,
    };
  }

  const projectIdMap = new Map();
  const projects = [];
  for (const raw of sourceProjects) {
    if (!raw || typeof raw !== 'object') continue;
    const oldId = String(raw.id || '');
    const isDefault = raw.isDefault === true || oldId === DEFAULT_PROJECT_ID;
    const id = isDefault ? DEFAULT_PROJECT_ID : makeSafeInternalId('p');
    projectIdMap.set(oldId, id);
    const p = Object.assign({}, raw, { id, isDefault });
    p.name = String(raw.name || (isDefault ? defaultProjectName() : 'Project')).slice(0, 80);
    p.mode = normalizeMeasurementMode(raw.mode);
    p.targetSeries = raw.targetSeries === 'custom' ? 'custom' : 'standard';
    p.times = cleanTimeList(raw.times, ALL_TIMES);
    p.customTargetTimes = cleanTimeList(raw.customTargetTimes, []);
    if (!p.times.length) p.times = ALL_TIMES.slice();
    projects.push(p);
  }

  const history = [];
  for (const raw of sourceHistory) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sensors)) continue;
    const target = positiveNumber(raw.targetFrac || raw.target);
    if (!target) continue;
    const targetSec = 1 / target;
    const baseUs = finiteNumber(raw.baseUs || (raw.raw && raw.raw.baseUs), 0);
    const sensors = raw.sensors.slice(0, 5).map((sensor, idx) => normalizeImportedSensor(sensor, idx, baseUs, targetSec));
    const rawProjId = String(raw.projId || '');
    const mappedProjId = projectIdMap.get(rawProjId) || DEFAULT_PROJECT_ID;
    const importedProject = projects.find(project => project.id === mappedProjId);
    const mode = raw.mode || raw.measurementMode || raw.shutterMode
      ? normalizeMeasurementMode(raw.mode || raw.measurementMode || raw.shutterMode)
      : normalizeMeasurementMode(importedProject && importedProject.mode);
    const active = sensors.filter(sensor => sensor.activated && sensor.seconds > 0);
    if (!active.length) continue;

    const durations = active.map(sensor => sensor.seconds);
    const avgSec = mode === 'central'
      ? medianPositive(durations)
      : durations.reduce((sum, value) => sum + value, 0) / durations.length;
    const minSec = Math.min(...durations);
    const maxSec = Math.max(...durations);
    const flash = normalizeImportedFlash(raw.flash, baseUs);
    const hint = evaluateMeasurementHintFromData({ sensors, flash, mode });
    const projectInvalid = isProjectInvalidMeasurement({ hint: hint.hint, valid: hint.hint === 'too_few_sensors' ? false : raw.valid !== false, count: active.length, mode });
    const geometry = currentMeasurementGeometry();
    const x = Number(raw.sensorDistanceXmm);
    const y = Number(raw.sensorDistanceYmm);

    const entry = Object.assign({}, raw, {
      id: makeSafeInternalId('m'),
      projId: projectInvalid ? DEFAULT_PROJECT_ID : mappedProjId,
      mode,
      targetFrac: target,
      ts: Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : Date.now(),
      valid: !projectInvalid,
      sensors,
      flash,
      avgFrac: avgSec > 0 ? Math.round(1 / avgSec) : 0,
      avgSec,
      avgDev: avgSec > 0 ? Math.log2(avgSec / targetSec) : 0,
      spread: mode === 'central' ? 0 : (durations.length > 1 && minSec > 0 ? Math.log2(maxSec / minSec) : 0),
      count: active.length,
      sensorDistanceXmm: Number.isFinite(x) && x > 0 ? x : geometry.sensorDistanceXmm,
      sensorDistanceYmm: Number.isFinite(y) && y > 0 ? y : geometry.sensorDistanceYmm,
      hint: hint.hint,
      hintText: hint.hintText,
      warning: hint.hasHint ? hint.hintText : '',
    });
    entry.flashSyncOk = isFlashSyncOk(entry);
    history.push(entry);
  }

  const selectedProjId = projectIdMap.get(String(data.selectedProjId || '')) || DEFAULT_PROJECT_ID;
  return { projects, history, selectedProjId };
}

// Import a previously exported WebUI backup JSON file.
async function importBackupJSON(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const normalized = normalizeImportedBackup(data);
    if (!normalized.projects.length && !normalized.history.length) throw new Error(tx('errors.invalidBackup', 'Invalid backup'));
    if (!confirm(tx('confirm.importBackup', 'Import JSON backup? Current projects and history will be replaced.'))) return;
    S.projects = normalized.projects;
    S.history = normalized.history;
    S.selectedProjId = normalized.selectedProjId;
    ensureDefaultProject();
    sanitizeMeasurementAssignments();
    S.uiSettings = sanitizeUiSettings(data.uiSettings || S.uiSettings || {});
    saveUiSettings();
    startPollingLoop();
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
  removeStorageKey(LS_HISTORY_KEY);
  removeStorageKey(LS_PROJECTS_KEY);
  removeStorageKey(LS_DEVICE_KEY);
  removeStorageKey(LS_UI_KEY);
  S.projects = [];
  S.history = [];
  S.selId = null;
  S.lastMeasId = null;
  S.selectedProjId = null;
  S.deviceConfig = null;
  S.deviceSettings = Object.assign({}, DEFAULT_DEVICE_SETTINGS);
  S.uiSettings = Object.assign({}, DEFAULT_UI_SETTINGS);
  startPollingLoop();
  ensureDefaultProject();
  saveAppData();
  renderProjList();
  renderHistList();
  const content = document.getElementById('content');
  if (content) content.innerHTML = '';
  renderEmptyStateIfNeeded();
  toast(tx('toast.localDataReset', 'Local WebUI data reset'), 'success');
}


// ════════════════════════════════════════════
   // CSV EXPORT
// ════════════════════════════════════════════


function csvCell(value) {
  const text = String(value ?? '');
  return '"' + text.replace(/"/g, '""') + '"';
}

function csvLine(values) {
  return values.map(csvCell).join(';');
}

function exportProjCSV(projId) {
  const p = S.projects.find(x => x.id === projId);
  if (!p) return;
  // Header: note first, then aggregated table
  const lines = [];
  if (p.note) lines.push(csvLine(['# ' + tx('csv.note', 'Note'), p.note.replace(/\n/g,' | ')]));
  lines.push(csvLine(['# ' + tx('csv.project', 'Project'), p.name]));
  lines.push(csvLine(['# ' + tx('csv.exported', 'Exported'), new Date().toLocaleString(uiLocale())]));
  lines.push('');
  const hdr = ['Target_1x','Target_s','Avg_Fraction','Avg_ms','Deviation_EV','Spread_EV',
               'OpeningSpeed_m_s','ClosingSpeed_m_s','Flash_OK','Flash_NOK','Flash_Detected','Count'];
  lines.push(csvLine(hdr));
  p.times.forEach(tgt => {
    const agg = aggregateForTarget(projId, tgt);
    if (!agg) { lines.push(csvLine([tgt,(1/tgt).toFixed(6),'','','','','','','','','','0'])); return; }
    const dev = Math.log2(agg.avgSec * tgt);
    lines.push(csvLine([
      tgt, (1/tgt).toFixed(6),
      agg.avgFrac, (agg.avgSec*1000).toFixed(4),
      dev.toFixed(4), agg.avgSpread.toFixed(4),
      agg.avgV1!=null?agg.avgV1.toFixed(4):'',
      agg.avgV2!=null?agg.avgV2.toFixed(4):'',
      agg.flashOk, agg.flashBad, agg.flashDetected,
      agg.n,
    ]));
  });
  const dateStr = timestampForFilename();
  const safeName = (p.name||'export').replace(/[^a-zA-Z0-9_\-]/g,'_');
  dlCSV(lines.join('\n'), safeName + '_' + dateStr + '.csv');
  toast(tf('toast.csvExported', 'CSV exported - {count} target times', {count: p.times.length}));
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
const createMockMeasurement = function(targetFrac, flash = 'ok', modeInput = 'horizontal') {
  const availableTimes = (S.targetTimes && S.targetTimes.length ? S.targetTimes : ALL_TIMES);
  const tf = Number(targetFrac) || availableTimes[Math.floor(Math.random() * availableTimes.length)];

  function norm(v) {
    return String(v || '').toLowerCase().replace(/[-_\s]/g, '');
  }

  function normMode(v) {
    const m = norm(v || 'horizontal');
    if (m === 'central') return 'central';
    if (m === 'vertical') return 'vertical';
    return 'horizontal';
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

  const mode = normMode(modeInput);
  const flashMode = normFlash(flash);
  const targetSec = 1 / tf;
  const baseUs = 1000000 + Math.floor(Math.random() * 100000);
  const nominalDurationUs = Math.round(targetSec * 1e6);

  // Sensor order for the simulated curtain movement. The five sensors are diagonal; horizontal and vertical modes use different distances in analysis.
  const order = mode === 'central' ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4];

  // Curtain travel time between neighboring sensors. Fast target speeds use shorter travel steps so the simulated packet remains plausible.
  const stepUs = mode === 'central'
    ? 0
    : Math.max(35, Math.min(260, Math.round(nominalDurationUs * 0.08 + 50 + Math.random() * 50)));

  const sensors = Array.from({ length: 5 }, (_, id) => ({
    id,
    pin: 34 + id,
    activated: true,
    raw: 750 + Math.round(Math.random() * 180),
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

  ingestMeasurement(Object.assign({
    valid: true,
    id: 'mock_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    target: tf,
    baseUs,
    mode,
    sensors,
    flash: {
      detected,
      pin: 39,
      raw: detected ? 700 : 3100,
      triggerUs: detected ? triggerUs : 0
    }
  }, currentMeasurementGeometry()));
};
function registerDevTools() {
  if (!isDevToolsEnabled()) return;
  window.injectMock = createMockMeasurement;
}
