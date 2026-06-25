// Application constants, state, project defaults, and local persistence.

// ════════════════════════════════════════════
   // CONSTANTS
// ════════════════════════════════════════════
const ALL_TIMES     = [1,2,4,8,15,30,60,125,250,500,1000,2000];
const DEFAULT_CUSTOM_TIMES = [1,2,5,10,25,50,100,250,500,1000,2000];
const DEFAULT_SENSOR_DISTANCE_X_MM = 13.17;
const DEFAULT_SENSOR_DISTANCE_Y_MM = 7.67;
const ID_COLORS = ['#f5b030','#68a8e0','#56c47e','#e86060','#c47aff'];
const ID_BG     = ['rgba(245,176,48,0.18)','rgba(104,168,224,0.18)',
                       'rgba(86,196,126,0.18)','rgba(232,96,96,0.18)','rgba(196,122,255,0.18)'];
const POLL_MS = 1000;
const STATUS_POLL_MS = 20000;
const LS_HISTORY_KEY = 'ocl_history_v1';
const LS_PROJECTS_KEY = 'ocl_projects_v1';
const LS_DEVICE_KEY = 'ocl_device_config_v1';
const LS_UI_KEY = 'ocl_ui_settings_v1';
const DEFAULT_PROJECT_ID = 'p_default';
const APP_VERSION = '0.1.0';
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
const DEFAULT_UI_SETTINGS = { interpolateCharts: false };


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
  cdnVersion: '',
  lastVersionNotice: '',
  settingsSnapshot: '',
  settingsDirty: false,
  settingsSaving: false,
  deviceSettings: Object.assign({}, DEFAULT_DEVICE_SETTINGS),
  targetTimes: ALL_TIMES.slice(),
  uiSettings: Object.assign({}, DEFAULT_UI_SETTINGS),
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
  const key = String(mode || '').toLowerCase();
  return key === 'vertical' ? 'vertical' : key === 'central' ? 'central' : 'horizontal';
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

// Move measurements away from projects that no longer support them.
function sanitizeMeasurementAssignments() {
  ensureDefaultProject();
  S.history.forEach(entry => {
    const p = projectById(entry.projId);
    if (!projectSupportsMeasurement(p, entry.targetFrac, entry.mode)) {
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
  return S.history.filter(h => h.projId === projId && (includeErrors || !h.isError));
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

function isSafeInternalId(value) {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(String(value || ''));
}

function makeSafeInternalId(prefix) {
  const cleanPrefix = /^[A-Za-z][A-Za-z0-9_-]{0,12}$/.test(prefix) ? prefix : 'id';
  const cryptoObj = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cleanPrefix + '_' + cryptoObj.randomUUID().replace(/-/g, '');
  return cleanPrefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

// Persist the measurement history.
function saveHistory() {
  writeJsonStorage(LS_HISTORY_KEY, {
    version: 1,
    lastMeasId: S.lastMeasId,
    selectedEntryId: S.selId,
    history: S.history
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
  writeJsonStorage(LS_UI_KEY, {
    interpolateCharts: !!(S.uiSettings && S.uiSettings.interpolateCharts)
  });
}

// Normalize UI preferences loaded from storage.
function sanitizeUiSettings(input) {
  const raw = Object.assign({}, input || {});
  return {
    interpolateCharts: raw.interpolateCharts === true
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
  S.history = Array.isArray(historyStore.history) ? historyStore.history : [];
  S.history.forEach(h => {
    if (!isSafeInternalId(h.id)) h.id = makeSafeInternalId('m');
    const oldProjId = String(h.projId || '');
    if (loadedProjectIdMap.has(oldProjId)) h.projId = loadedProjectIdMap.get(oldProjId);
    else if (!isSafeInternalId(h.projId)) h.projId = DEFAULT_PROJECT_ID;
    const x = Number(h.sensorDistanceXmm);
    const y = Number(h.sensorDistanceYmm);
    h.sensorDistanceXmm = Number.isFinite(x) && x > 0 ? x : DEFAULT_SENSOR_DISTANCE_X_MM;
    h.sensorDistanceYmm = Number.isFinite(y) && y > 0 ? y : DEFAULT_SENSOR_DISTANCE_Y_MM;
    if (h.flash && typeof h.flash === 'object') delete h.flash['enabled'];
  });
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
