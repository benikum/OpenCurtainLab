// Application constants, state, project defaults, and local persistence.

// ════════════════════════════════════════════
   // CONSTANTS
// ════════════════════════════════════════════
const ALL_TIMES     = [1,2,4,8,15,30,60,125,250,500,1000,2000];
const DEFAULT_CUSTOM_TIMES = [1,2,5,10,25,50,100,250,500,1000,2000];
const DEFAULT_SENSOR_DISTANCE_X_MM = 13.17;
const DEFAULT_SENSOR_DISTANCE_Y_MM = 7.67;
const MIN_VALID_SENSOR_COUNT = 3;
const PROJECT_INVALID_HINTS = ['timeout_with_data', 'too_few_sensors'];
const ID_COLORS = ['#f5b030','#68a8e0','#56c47e','#e86060','#c47aff'];
const ID_BG     = ['rgba(245,176,48,0.18)','rgba(104,168,224,0.18)',
                       'rgba(86,196,126,0.18)','rgba(232,96,96,0.18)','rgba(196,122,255,0.18)'];
const DEFAULT_POLL_INTERVAL_MS = 1000;
const MIN_POLL_INTERVAL_MS = 200;
const MAX_POLL_INTERVAL_MS = 10000;
const STATUS_POLL_MS = 20000;
const WEB_MEASUREMENT_TIMEOUT_MS = 5000;
const WEB_MEASUREMENT_TIMEOUT_MARGIN_MS = 40;
const LS_HISTORY_KEY = 'ocl_history_v1';
const LS_PROJECTS_KEY = 'ocl_projects_v1';
const LS_DEVICE_KEY = 'ocl_device_config_v1';
const LS_UI_KEY = 'ocl_ui_settings_v1';
const DEFAULT_PROJECT_ID = 'p_default';
const APP_VERSION = '0.1.1';
const BATTERY_LOW_NOTICE_PERCENT = 20;
const GITHUB_URL = 'https://github.com/benikum/OpenCurtainLab';
const DEFAULT_DEVICE_HOST = 'opencurtainlab.local';
const MODES = [
  {key:'vertical', labelKey:'modes.vertical', fallback:'vertical'},
  {key:'horizontal', labelKey:'modes.horizontal', fallback:'horizontal'},
  {key:'central', labelKey:'modes.central', fallback:'central shutter'},
];
const DEFAULT_DEVICE_SETTINGS = {
  defaultMeasurementMode: 'horizontal',
  defaultTargetTime: 500,
  sensorSensitivity: 'medium',
  resultDisplay: 'until_button',
  targetSeries: 'standard',
  customTargetTimes: DEFAULT_CUSTOM_TIMES.slice(),
  oledSleepMinutes: 5
};
const SENSOR_SENSITIVITIES = ['low', 'medium', 'high'];
const DEFAULT_UI_SETTINGS = {
  interpolateCharts: true,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
};


// Console-only developer helpers are disabled unless explicitly enabled through ?dev=1 or localStorage.ocl_dev_tools=1.
function isDevToolsEnabled() {
  try {
    const params = new URLSearchParams(window.location.search || '');
    return params.get('dev') === '1' || safeLocalStorageGet('ocl_dev_tools') === '1';
  } catch (e) {
    return false;
  }
}


// ════════════════════════════════════════════
   // STATE
// ════════════════════════════════════════════
let S = {
  projects:   [],
  // Newest measurements first.
  history:    [],
  // Selected history entry id.
  selId:      null,
  lastMeasId: null,
  // Last clicked or assigned project.
  selectedProjId: null,
  connected:  false,
  deviceHost: DEFAULT_DEVICE_HOST,
  deviceBase: '',
  deviceConfig: null,
  deviceStatus: { error: 'none', errorText: '', subsystem: 'none' },
  networkStatus: { hint: 'none', hintText: '', connected: false, apMode: false, mdnsStarted: false },
  deviceRuntime: { uptime: null, measCount: null, device: '', version: '', batteryVoltage: null },
  lastStatusAt: 0,
  lastDeviceErrorNotice: '',
  lastNetworkHintNotice: '',
  lastMeasurementHintNotice: '',
  lastBatteryLowNotice: '',
  connectionProblem: null,
  versionWarning: '',
  versionMismatch: '',
  updateAvailable: '',
  webUiUpdateAvailable: '',
  firmwareUpdateAvailable: '',
  cdnVersion: '',
  versionInfo: null,
  lastVersionNotice: '',
  settingsSnapshot: '',
  settingsDirty: false,
  settingsSaving: false,
  deviceSettings: Object.assign({}, DEFAULT_DEVICE_SETTINGS),
  targetTimes: ALL_TIMES.slice(),
  uiSettings: Object.assign({}, DEFAULT_UI_SETTINGS),
  pollTimer: null,
};


// Default project helpers keep every measurement assigned to a project.
function defaultProjectName() {
  const isGerman = String(document.documentElement.lang || '').toLowerCase().startsWith('de');
  return tx('project.defaultName', isGerman ? 'Standardprojekt' : 'Default project');
}

// Create the default project object with localized labels and default settings.
function createDefaultProject() {
  return {
    id: DEFAULT_PROJECT_ID,
    name: defaultProjectName(),
    times: [],
    customTargetTimes: [],
    createdAt: 0,
    isDefault: true
  };
}

// Ensure the default project exists and is localized for the active language.
function ensureDefaultProject() {
  let p = S.projects.find(x => x.id === DEFAULT_PROJECT_ID || x.isDefault === true);
  if (!p) {
    p = createDefaultProject();
    S.projects.unshift(p);
  } else {
    p.id = DEFAULT_PROJECT_ID;
    p.isDefault = true;
    p.times = [];
    p.customTargetTimes = [];
    delete p.mode;
    delete p.targetSeries;
  }

  // The default project is a built-in UI bucket, not a user-created camera project.
  // Keep its visible name synchronized with the active interface language.
  p.name = defaultProjectName();

  if (!S.selectedProjId || !S.projects.some(x => x.id === S.selectedProjId)) S.selectedProjId = DEFAULT_PROJECT_ID;
  S.history.forEach(h => { if (!h.projId) h.projId = DEFAULT_PROJECT_ID; });
  return p;
}

// Return the currently selected project, falling back to the default project.
function activeProject() {
  ensureDefaultProject();
  return S.projects.find(p => p.id === S.selectedProjId) || S.projects.find(p => p.id === DEFAULT_PROJECT_ID);
}

// Check whether a project is the protected default project.
function isDefaultProject(p) {
  return !!p && (p.id === DEFAULT_PROJECT_ID || p.isDefault === true);
}

// Find a project by id.
function projectById(id) {
  ensureDefaultProject();
  return S.projects.find(p => p.id === id) || null;
}

// Normalize a measurement mode key to one of the supported current geometries.
function normalizeMeasurementMode(mode) {
  const key = String(mode || '').toLowerCase().replace(/[\s_-]+/g, '');
  if (key === 'vertical') return 'vertical';
  if (key === 'central' || key === 'centralshutter' || key === 'leaf' || key === 'leafshutter' || key === 'lensshutter' || key === 'objektivverschluss' || key === 'zentralverschluss') return 'central';
  return 'horizontal';
}

// Return whether a hint only describes low sensor coverage. This is valid for central shutters.
function isLowSensorCoverageHint(hint) {
  return hint === 'too_few_sensors' || hint === 'incomplete_sensor_coverage';
}

// Resolve a packet mode, falling back to the active camera project when old firmware omits the mode.
function resolveMeasurementModeForPacket(packet = {}) {
  const rawMode = packet.mode || packet.measurementMode || packet.shutterMode;
  if (rawMode) return normalizeMeasurementMode(rawMode);
  const p = activeProject();
  if (p && !isDefaultProject(p) && p.mode) return normalizeMeasurementMode(p.mode);
  return normalizeMeasurementMode(S.deviceSettings && S.deviceSettings.defaultMeasurementMode);
}

// Return the median of finite positive numbers, or 0 when none exist.
function medianPositive(values) {
  const arr = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter(v => Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

// Check whether a project accepts a measurement packet based on mode and target series.
function projectSupportsMeasurement(p, targetFrac, mode) {
  if (!p) return false;
  if (isDefaultProject(p)) return true;

  const target = Number(targetFrac || 0);
  const normalizedMode = normalizeMeasurementMode(mode);
  const times = Array.isArray(p.times) ? p.times.map(Number) : [];

  return normalizeMeasurementMode(p.mode) === normalizedMode &&
         target > 0 &&
         times.includes(target);
}

// Return whether a measurement must stay in the default diagnostics bucket.
function isProjectInvalidMeasurement(entry) {
  if (!entry) return false;
  const mode = normalizeMeasurementMode(entry.mode);
  const hint = String(entry.hint || 'none');

  // Central shutters reduce available sensor samples to one median timing value.
  // A low sensor count is therefore not a project-blocking measurement fault here.
  if (mode === 'central') {
    if (isLowSensorCoverageHint(hint)) return false;
    if (entry.valid === false) return true;
    return hint === 'timeout_with_data';
  }

  if (entry.valid === false) return true;
  const count = Number(entry.count);
  if (Number.isFinite(count) && count > 0 && count < MIN_VALID_SENSOR_COUNT) return true;
  return PROJECT_INVALID_HINTS.includes(hint);
}

// Move measurements away from projects that no longer support them.
function sanitizeMeasurementAssignments() {
  ensureDefaultProject();
  S.history.forEach(entry => {
    const mode = normalizeMeasurementMode(entry.mode);
    if (mode === 'central' && isLowSensorCoverageHint(entry.hint)) {
      entry.valid = true;
      entry.hint = 'none';
      entry.hintText = '';
      entry.warning = '';
    }

    const p = projectById(entry.projId);
    const invalid = isProjectInvalidMeasurement(entry);
    if (invalid) {
      entry.valid = false;
      const count = Number(entry.count);
      if (mode !== 'central' && (!entry.hint || entry.hint === 'none') && Number.isFinite(count) && count > 0 && count < MIN_VALID_SENSOR_COUNT) {
        entry.hint = 'too_few_sensors';
        entry.hintText = tx('measurementHints.too_few_sensors.title', 'Too few sensors were covered');
        entry.warning = entry.hintText;
      }
    }
    if (invalid || !projectSupportsMeasurement(p, entry.targetFrac, entry.mode)) {
      entry.projId = DEFAULT_PROJECT_ID;
    }
  });
}

// Choose the best project id for a new measurement.
function activeProjectIdForMeasurement(targetFrac, mode) {
  const p = activeProject();
  return projectSupportsMeasurement(p, targetFrac, mode) ? p.id : DEFAULT_PROJECT_ID;
}

// Return all measurements assigned to a project.
function projectEntries(projId, includeErrors = true) {
  return S.history.filter(h => h.projId === projId && (includeErrors || (!h.isError && h.valid !== false)));
}

// Sort the visible history order for one project by target time and measured exposure time.
// New measurements are still inserted at the top; this is only called when a project view is rebuilt.
function measurementHistorySortValue(value, fallback = Number.POSITIVE_INFINITY) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function compareMeasurementsByTargetAndActualTime(a, b) {
  const targetA = measurementHistorySortValue(a && a.targetFrac);
  const targetB = measurementHistorySortValue(b && b.targetFrac);
  if (targetA !== targetB) return targetA - targetB;

  const actualA = measurementHistorySortValue(a && a.avgSec);
  const actualB = measurementHistorySortValue(b && b.avgSec);
  if (actualA !== actualB) return actualA - actualB;

  const tsA = Number(a && a.ts);
  const tsB = Number(b && b.ts);
  if (Number.isFinite(tsA) && Number.isFinite(tsB) && tsA !== tsB) return tsB - tsA;
  return String(b && b.id || '').localeCompare(String(a && a.id || ''));
}

function sortHistoryForProjectView(projId) {
  if (!projId || !Array.isArray(S.history)) return;
  const sorted = S.history
    .filter(entry => entry && entry.projId === projId)
    .slice()
    .sort(compareMeasurementsByTargetAndActualTime);
  if (sorted.length < 2) return;

  let index = 0;
  S.history = S.history.map(entry => {
    if (!entry || entry.projId !== projId) return entry;
    return sorted[index++] || entry;
  });
}

// Return all measurements for the selected project.
function currentProjectEntries(includeErrors = true) {
  const p = activeProject();
  return p ? projectEntries(p.id, includeErrors) : [];
}

// ════════════════════════════════════════════
   // STORAGE
// ════════════════════════════════════════════
function readJsonStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch(e) {
    return fallback;
  }
}

// Write JSON to localStorage without breaking restricted browser modes.
function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) console.warn('OpenCurtainLab localStorage write failed', key, e);
    return false;
  }
}

// Remove a localStorage key without breaking restricted browser modes.
function removeStorageKey(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch (e) {
    if (typeof console !== 'undefined' && console.warn) console.warn('OpenCurtainLab localStorage remove failed', key, e);
    return false;
  }
}

// Clamp the WebUI polling interval to a practical range.
function normalizePollIntervalMs(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(MAX_POLL_INTERVAL_MS, n));
}

function isSafeInternalId(value) {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(String(value || ''));
}

function makeSafeInternalId(prefix) {
  const cleanPrefix = /^[A-Za-z][A-Za-z0-9_-]{0,12}$/.test(prefix) ? prefix : 'id';
  const cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cleanPrefix + '_' + cryptoObj.randomUUID().replace(/-/g, '');
  return cleanPrefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}


// Return a finite number or a fallback while preserving raw packet semantics.
function finiteOr(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Keep only raw measurement packet data plus measurement-time geometry.
function rawMeasurementPacketForStorage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const source = entry.raw && typeof entry.raw === 'object' ? entry.raw : entry;
  const id = String(source.id || entry.id || '').trim();
  const target = finiteOr(source.target ?? source.targetFrac ?? entry.targetFrac, 0);
  const baseUs = finiteOr(source.baseUs ?? entry.baseUs, 0);
  const mode = normalizeMeasurementMode(source.mode || source.measurementMode || source.shutterMode || entry.mode);
  const geometry = currentMeasurementGeometry();
  const sensorDistanceXmm = finiteOr(source.sensorDistanceXmm ?? entry.sensorDistanceXmm, geometry.sensorDistanceXmm);
  const sensorDistanceYmm = finiteOr(source.sensorDistanceYmm ?? entry.sensorDistanceYmm, geometry.sensorDistanceYmm);
  const sensorSource = Array.isArray(source.sensors) ? source.sensors : (Array.isArray(entry.sensors) ? entry.sensors : []);
  if (!id || !target || !sensorSource.length) return null;

  const sensors = sensorSource.map((sensor, idx) => {
    const s = sensor && typeof sensor === 'object' ? sensor : {};
    return {
      id: Number.isInteger(Number(s.id)) ? Number(s.id) : idx,
      pin: Number.isInteger(Number(s.pin)) ? Number(s.pin) : undefined,
      activated: s.activated !== false,
      raw: finiteOr(s.raw, 0),
      openUs: finiteOr(s.openUs, 0),
      closeUs: finiteOr(s.closeUs, 0),
    };
  });

  const flashSource = source.flash && typeof source.flash === 'object'
    ? source.flash
    : (entry.flash && typeof entry.flash === 'object' ? entry.flash : null);
  const flash = flashSource ? {
    detected: !!flashSource.detected,
    pin: Number.isInteger(Number(flashSource.pin)) ? Number(flashSource.pin) : undefined,
    raw: finiteOr(flashSource.raw, 0),
    triggerUs: finiteOr(flashSource.triggerUs, 0),
  } : null;

  return {
    id,
    valid: source.valid !== false,
    target,
    mode,
    baseUs,
    sensorDistanceXmm: sensorDistanceXmm > 0 ? sensorDistanceXmm : geometry.sensorDistanceXmm,
    sensorDistanceYmm: sensorDistanceYmm > 0 ? sensorDistanceYmm : geometry.sensorDistanceYmm,
    sensors,
    flash,
  };
}

// Store history without calculated values. UI entries are rebuilt from this raw packet on load.
function historyEntryForStorage(entry) {
  const raw = rawMeasurementPacketForStorage(entry);
  if (!raw) return null;
  return {
    id: raw.id,
    ts: Number.isFinite(Number(entry.ts)) ? Number(entry.ts) : Date.now(),
    projId: isSafeInternalId(entry.projId) ? entry.projId : DEFAULT_PROJECT_ID,
    raw,
  };
}

// Rebuild a full in-memory measurement entry from a raw-only stored history record.
function rebuildHistoryEntry(stored) {
  if (!stored || typeof stored !== 'object') return null;
  const raw = rawMeasurementPacketForStorage(stored.raw && typeof stored.raw === 'object' ? stored : { raw: stored });
  if (!raw || typeof buildEntryFromPacket !== 'function') return null;
  const entry = buildEntryFromPacket(raw);
  if (!entry) return null;
  entry.ts = Number.isFinite(Number(stored.ts)) ? Number(stored.ts) : entry.ts;
  if (isSafeInternalId(stored.projId)) entry.projId = stored.projId;
  return entry;
}

// Persist the measurement history.
function saveHistory() {
  writeJsonStorage(LS_HISTORY_KEY, {
    version: 2,
    storage: 'raw-only',
    lastMeasId: S.lastMeasId,
    selectedEntryId: S.selId,
    history: S.history.map(historyEntryForStorage).filter(Boolean)
  });
}

// Persist the project list and active project selection.
function saveProjects() {
  writeJsonStorage(LS_PROJECTS_KEY, {
    selectedProjId: S.selectedProjId,
    projects: S.projects
  });
}

// Persist the most recent device configuration snapshot.
function saveDeviceConfigLocal() {
  writeJsonStorage(LS_DEVICE_KEY, {
    deviceBase: S.deviceBase || '',
    deviceConfig: S.deviceConfig || null,
    deviceSettings: S.deviceSettings || null
  });
}

// Persist UI-only preferences.
function saveUiSettings() {
  writeJsonStorage(LS_UI_KEY, sanitizeUiSettings(S.uiSettings));
}

// Normalize UI preferences loaded from storage.
function sanitizeUiSettings(input) {
  const raw = Object.assign({}, input || {});
  return {
    interpolateCharts: raw.interpolateCharts !== false,
    pollIntervalMs: normalizePollIntervalMs(raw.pollIntervalMs),
  };
}

// Persist all main WebUI state groups.
function saveAppData() {
  saveProjects();
  saveHistory();
}


// Load projects, measurements, settings, and cached device configuration from
// localStorage.
function load() {
  const projectsStore = readJsonStorage(LS_PROJECTS_KEY, {});
  const historyStore = readJsonStorage(LS_HISTORY_KEY, {});
  const deviceStore = readJsonStorage(LS_DEVICE_KEY, {});
  const uiStore = readJsonStorage(LS_UI_KEY, {});

  S.projects = Array.isArray(projectsStore.projects) ? projectsStore.projects : [];
  const loadedProjectIdMap = new Map();
  S.projects.forEach(p => {
    const oldId = String(p.id || '');
    if (p.isDefault || oldId === DEFAULT_PROJECT_ID) p.id = DEFAULT_PROJECT_ID;
    else if (!isSafeInternalId(p.id)) p.id = makeSafeInternalId('p');
    loadedProjectIdMap.set(oldId, p.id);
    if (!Array.isArray(p.times) || !p.times.length) p.times = ALL_TIMES.slice();
    p.times = p.times.map(Number).filter(v => Number.isFinite(v) && v > 0).sort((a,b)=>a-b);
    p.targetSeries = p.targetSeries === 'custom' ? 'custom' : 'standard';
    p.customTargetTimes = Array.isArray(p.customTargetTimes)
      ? p.customTargetTimes.map(Number).filter(v => Number.isFinite(v) && v > 0).sort((a,b)=>a-b)
      : [];
  });
  const storedHistory = Array.isArray(historyStore.history) ? historyStore.history : [];
  S.history = storedHistory.map(stored => {
    const rawOldProjId = String(stored && stored.projId || '');
    const rebuilt = rebuildHistoryEntry(stored);
    if (!rebuilt) return null;
    const oldProjId = rawOldProjId || String(rebuilt.projId || '');
    if (loadedProjectIdMap.has(oldProjId)) rebuilt.projId = loadedProjectIdMap.get(oldProjId);
    else if (!isSafeInternalId(rebuilt.projId)) rebuilt.projId = DEFAULT_PROJECT_ID;
    return rebuilt;
  }).filter(Boolean);
  S.selectedProjId = loadedProjectIdMap.get(String(projectsStore.selectedProjId || '')) || projectsStore.selectedProjId || null;
  if (S.selectedProjId && !S.projects.some(p => p.id === S.selectedProjId)) S.selectedProjId = null;
  S.lastMeasId = historyStore.lastMeasId || (S.history.length ? S.history[0].id : null);

  S.deviceHost = DEFAULT_DEVICE_HOST;
  S.deviceBase = deviceStore.deviceBase || '';
  S.deviceConfig = deviceStore.deviceConfig || null;
  S.deviceSettings = sanitizeDeviceSettings(deviceStore.deviceSettings || {});
  S.uiSettings = sanitizeUiSettings(uiStore);
  if (S.deviceConfig) {
    const cfg = S.deviceConfig;
    const arr = cfg.settings && cfg.settings.targetSeries === 'custom'
      ? (cfg.targetTimesCustom || cfg.settings.customTargetTimes)
      : cfg.targetTimesStandard;
    if (Array.isArray(arr)) S.targetTimes = arr.map(Number).filter(v => Number.isFinite(v) && v > 0);
  }
  ensureDefaultProject();
  sanitizeMeasurementAssignments();
  saveAppData();
}
