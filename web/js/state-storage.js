// Application constants, state, project defaults, and local persistence.

// ════════════════════════════════════════════
   // CONSTANTS
// ════════════════════════════════════════════
const ALL_TIMES     = [1,2,4,8,15,30,60,125,250,500,1000,2000];
const DEFAULT_CUSTOM_TIMES = [1,2,5,10,25,50,100,250,500,1000,2000];
const ID_COLORS = ['#f5b030','#68a8e0','#56c47e','#e86060','#c47aff'];
const ID_BG     = ['rgba(245,176,48,0.18)','rgba(104,168,224,0.18)',
                       'rgba(86,196,126,0.18)','rgba(232,96,96,0.18)','rgba(196,122,255,0.18)'];
const POLL_MS = 1000;
const STATUS_POLL_MS = 3000;
const LS_HISTORY_KEY = 'ocl_history_v1';
const LS_PROJECTS_KEY = 'ocl_projects_v1';
const LS_DEVICE_KEY = 'ocl_device_config_v1';
const LS_UI_KEY = 'ocl_ui_settings_v1';
const DEFAULT_PROJECT_ID = 'p_default';
const APP_VERSION = '0.1.0';
const VERSION_URL = '---';
const TUTORIAL_URL_BASE = 'tutorial';
const GITHUB_URL = 'https://github.com/benikum/OpenCurtainLab';
const DEFAULT_DEVICE_HOST = 'opencurtainlab.local';
const MODES = [
  {key:'left', labelKey:'modes.left', fallback:'left'},
  {key:'down', labelKey:'modes.down', fallback:'down'},
  {key:'right', labelKey:'modes.right', fallback:'right'},
  {key:'up', labelKey:'modes.up', fallback:'up'},
  {key:'central', labelKey:'modes.central', fallback:'central shutter'},
];
const DEFAULT_DEVICE_SETTINGS = {
  defaultMeasurementMode: 'left',
  defaultTargetTime: 500,
  sensorSensitivity: 'medium',
  resultDisplay: 'until_button',
  targetSeries: 'standard',
  customTargetTimes: DEFAULT_CUSTOM_TIMES.slice(),
  oledSleepMinutes: 5
};
const SENSOR_SENSITIVITIES = ['low', 'medium', 'high'];
const DEFAULT_UI_SETTINGS = { interpolateCharts: false };


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
  lastStatusAt: 0,
  lastDeviceErrorNotice: '',
  lastNetworkHintNotice: '',
  lastMeasurementHintNotice: '',
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
  sensorDistanceXmm: 7.62,
  sensorDistanceYmm: 5.08,
  targetTimes: ALL_TIMES.filter(t => t <= 1000),
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

// Check whether a project accepts a measurement packet based on mode and target series.
function projectSupportsMeasurement(p, targetFrac, mode) {
  if (!p) return false;
  if (isDefaultProject(p)) return true;

  const target = Number(targetFrac || 0);
  const normalizedMode = mode || 'left';
  const times = Array.isArray(p.times) ? p.times.map(Number) : [];

  return String(p.mode || '') === String(normalizedMode) &&
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
  localStorage.setItem(key, JSON.stringify(value));
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
    version: 1,
    selectedProjId: S.selectedProjId,
    projects: S.projects
  });
}

// Persist the most recent device configuration snapshot.
function saveDeviceConfigLocal() {
  writeJsonStorage(LS_DEVICE_KEY, {
    version: 1,
    deviceBase: S.deviceBase || '',
    deviceConfig: S.deviceConfig || null,
    deviceSettings: S.deviceSettings || null,
    sensorDistanceXmm: S.sensorDistanceXmm,
    sensorDistanceYmm: S.sensorDistanceYmm,
    targetTimes: S.targetTimes
  });
}

// Persist UI-only preferences.
function saveUiSettings() {
  writeJsonStorage(LS_UI_KEY, {
    version: 1,
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
  S.projects.forEach(p => {
    if (!Array.isArray(p.times) || !p.times.length) p.times = ALL_TIMES.slice();
    p.times = p.times.map(Number).filter(v => Number.isFinite(v) && v > 0).sort((a,b)=>a-b);
    if (p.targetSeries !== 'custom' && p.targetSeries !== 'standard') {
      const sameAsStandard = p.times.length === ALL_TIMES.length && p.times.every((v, i) => v === ALL_TIMES[i]);
      p.targetSeries = sameAsStandard ? 'standard' : 'custom';
    }
    if (p.targetSeries === 'custom' && (!Array.isArray(p.customTargetTimes) || !p.customTargetTimes.length)) p.customTargetTimes = p.times.slice();
  });
  S.history = Array.isArray(historyStore.history) ? historyStore.history : [];
  S.selectedProjId = projectsStore.selectedProjId || null;
  if (S.selectedProjId && !S.projects.some(p => p.id === S.selectedProjId)) S.selectedProjId = null;
  S.lastMeasId = historyStore.lastMeasId || (S.history.length ? S.history[0].id : null);

  S.deviceHost = DEFAULT_DEVICE_HOST;
  S.deviceBase = deviceStore.deviceBase || '';
  S.deviceConfig = deviceStore.deviceConfig || null;
  S.deviceSettings = sanitizeDeviceSettings(deviceStore.deviceSettings || {});
  S.uiSettings = sanitizeUiSettings(uiStore);
  if (deviceStore.sensorDistanceXmm) S.sensorDistanceXmm = Number(deviceStore.sensorDistanceXmm);
  if (deviceStore.sensorDistanceYmm) S.sensorDistanceYmm = Number(deviceStore.sensorDistanceYmm);
  if (Array.isArray(deviceStore.targetTimes)) S.targetTimes = deviceStore.targetTimes.map(Number);
  ensureDefaultProject();
  sanitizeMeasurementAssignments();
  saveAppData();
}
