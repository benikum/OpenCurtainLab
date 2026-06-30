// Device API access, firmware settings, diagnostics, and settings UI.

// ════════════════════════════════════════════
   // POLLING
// ════════════════════════════════════════════

function classifyFetchError(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  if (err && Number.isFinite(Number(err.status))) return 'http_' + Number(err.status);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'browser_offline';
  if (location.protocol === 'https:' && S.deviceBase && S.deviceBase.startsWith('http://')) return 'mixed_content';
  return 'network_or_cors';
}

function httpStatusError(response) {
  const err = new Error('HTTP ' + (response ? response.status : 'error'));
  err.status = response ? response.status : 0;
  return err;
}

// Return the current WebUI polling interval in milliseconds.
function currentPollIntervalMs() {
  return normalizePollIntervalMs(S.uiSettings && S.uiSettings.pollIntervalMs);
}

// Restart the measurement polling loop after interval changes.
function startPollingLoop() {
  if (S.pollTimer) clearInterval(S.pollTimer);
  S.pollTimer = setInterval(poll, currentPollIntervalMs());
}

// Run one background polling cycle for measurement data. /status is rate-limited by STATUS_POLL_MS.
// Device discovery is intentionally not retried here; otherwise the empty start screen
// is rebuilt every polling tick while the device is offline. Manual Connect still retries.
async function poll() {
  if (!S.deviceBase) { setConnState('connecting'); return; }

  try {
    const r = await fetch(api('/data'), { signal: AbortSignal.timeout(1500), mode: 'cors' });
    if (!r.ok) throw httpStatusError(r);
    const d = await r.json();

    S.connectionProblem = null;
    setConnState('connected');

    if (d.id && d.id !== S.lastMeasId) {
      S.lastMeasId = d.id;
      ingestMeasurement(d);
    }
    await fetchDeviceStatus(false);
  } catch(e) {
    S.connectionProblem = { type: classifyFetchError(e), message: tx('connectionHelp.title', 'Could not connect to OpenCurtainLab') };
    setConnState(classifyFetchError(e));
  }
}

// Call a device API endpoint with timeout and error classification.
function api(path) {
  return (S.deviceBase || '') + path;
}

// Initialize the preferred device host and start connection discovery.
async function initDeviceConnection(showMessages = true, hostOnly = false) {
  const candidates = [];
  const raw = DEFAULT_DEVICE_HOST;
  if (raw) candidates.push(normalizeDeviceBase(raw));
  if (!hostOnly) {
    if (!candidates.includes('http://' + DEFAULT_DEVICE_HOST)) candidates.push('http://' + DEFAULT_DEVICE_HOST);
    if (location.protocol === 'http:' && location.hostname) candidates.push(location.origin);
  }

  for (const base of candidates) {
    try {
      const r = await fetch(base + '/config', { signal: AbortSignal.timeout(1600), mode:'cors' });
      if (!r.ok) continue;
      const cfg = await r.json();
      S.deviceBase = base;
      S.deviceHost = base.replace(/^https?:\/\//,'');
      saveDeviceConfigLocal();
      applyDeviceConfig(cfg);
      await fetchDeviceStatus(true);
      S.connectionProblem = null;
      setConnState('connected');
      if (showMessages) toast(tf('toast.deviceConnected', 'Device connected: {host}', {host: S.deviceHost}), 'success');
      return true;
    } catch(e) {}
  }
  S.connectionProblem = { type: 'not_found', message: hostOnly ? tx('toast.deviceNotFoundHost', 'No OpenCurtainLab found at this address.') : tx('toast.deviceNotFoundDefault', 'No OpenCurtainLab found at opencurtainlab.local.') };
  if (showMessages) toast(S.connectionProblem.message, 'error');
  renderEmptyStateIfNeeded();
  return false;
}

// Normalize a device host or URL into a base URL.
function normalizeDeviceBase(v) {
  v = String(v || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  return v;
}


// Normalize device settings returned from the firmware.
function sanitizeDeviceSettings(input) {
  const raw = Object.assign({}, input || {});
  const settings = Object.assign({}, DEFAULT_DEVICE_SETTINGS);
  if (typeof raw.defaultMeasurementMode === 'string') settings.defaultMeasurementMode = normalizeMeasurementMode(raw.defaultMeasurementMode);
  if (Number.isFinite(Number(raw.defaultTargetTime))) settings.defaultTargetTime = Number(raw.defaultTargetTime);
  if (typeof raw.sensorSensitivity === 'string' && SENSOR_SENSITIVITIES.includes(raw.sensorSensitivity)) {
    settings.sensorSensitivity = raw.sensorSensitivity;
  }
  if (typeof raw.resultDisplay === 'string') settings.resultDisplay = raw.resultDisplay;
  if (typeof raw.targetSeries === 'string') settings.targetSeries = raw.targetSeries;
  if (Array.isArray(raw.customTargetTimes)) settings.customTargetTimes = raw.customTargetTimes.map(Number).filter(v => Number.isFinite(v) && v > 0);
  if (Number.isFinite(Number(raw.oledSleepMinutes))) settings.oledSleepMinutes = Number(raw.oledSleepMinutes);
  return settings;
}

// Return the firmware-supported maximum shutter target time.
function deviceMaxTargetTime() {
  const cfgMax = S.deviceConfig && Number(S.deviceConfig.maxTargetTime);
  if (Number.isFinite(cfgMax) && cfgMax > 0) return cfgMax;
  const times = Array.isArray(S.targetTimes) && S.targetTimes.length ? S.targetTimes : ALL_TIMES;
  return Math.max(...times.map(Number).filter(v => Number.isFinite(v) && v > 0), ...ALL_TIMES);
}


// Return whether the connected firmware has the optional battery voltage monitor enabled.
function isBatteryVoltageEnabled() {
  const cfg = S.deviceConfig || {};
  if (typeof cfg.batteryVoltageEnabled === 'boolean') return cfg.batteryVoltageEnabled;
  const voltage = Number(S.deviceRuntime && S.deviceRuntime.batteryVoltage);
  return Number.isFinite(voltage) && voltage > 0;
}

// Return the voltage range used for battery percentage display.
function batteryVoltageRange() {
  const cfg = S.deviceConfig || {};
  const empty = Number(cfg.batteryEmptyVoltage);
  const full = Number(cfg.batteryFullVoltage);
  return {
    empty: Number.isFinite(empty) ? empty : 6.0,
    full: Number.isFinite(full) ? full : 9.5
  };
}


// Convert battery voltage to the configured 0-100 percentage range.
function batteryPercentage(voltage) {
  const n = Number(voltage);
  const range = batteryVoltageRange();
  if (!Number.isFinite(n) || range.full <= range.empty) return null;
  return Math.max(0, Math.min(100, Math.round(((n - range.empty) * 100) / (range.full - range.empty))));
}

// Return the firmware-supported standard target time list.
function standardTargetTimes() {
  const cfg = S.deviceConfig || {};
  const arr = Array.isArray(cfg.targetTimesStandard) && cfg.targetTimesStandard.length ? cfg.targetTimesStandard : ALL_TIMES;
  const maxT = deviceMaxTargetTime();
  return arr.map(Number).filter(v => Number.isFinite(v) && v > 0 && v <= maxT).sort((a, b) => a - b);
}

// Display or clear the custom target-time validation message.
function setCustomTargetTimesError(message = '') {
  const el = document.getElementById('custom-target-times-error');
  const input = document.getElementById('set-custom-target-times');
  if (el) el.textContent = message || '';
  if (input) input.classList.toggle('invalid', !!message);
}

// Display or clear the device-address validation message.
function setDeviceAddressError(message = '') {
  const el = document.getElementById('device-address-error');
  const input = document.getElementById('device-address-input');
  if (el) el.textContent = message || '';
  if (input) input.classList.toggle('invalid', !!message);
}

// Build a normalized WebUI-side measurement hint object.
function makeMeasurementHint(hint = 'none', fallbackTitle = '') {
  const key = String(hint || 'none');
  const title = key === 'none' ? '' : tx('measurementHints.' + key + '.title', fallbackTitle || key);
  return { hint: key, hintText: title, hasHint: key !== 'none' };
}

// Return true when the raw timing pattern looks like a firmware capture timeout.
function isTimeoutMeasurementPattern(activeSensors) {
  if (!Array.isArray(activeSensors) || !activeSensors.length) return false;
  const closeMs = activeSensors.map(s => Number(s.closeMs)).filter(v => Number.isFinite(v) && v > 0);
  if (!closeMs.length) return false;
  const maxCloseMs = Math.max(...closeMs);
  if (maxCloseMs < (WEB_MEASUREMENT_TIMEOUT_MS - WEB_MEASUREMENT_TIMEOUT_MARGIN_MS)) return false;

  // Timeout closing is produced by one forced timestamp, so repeated closeUs values are a strong signal.
  const closeUsValues = activeSensors.map(s => Number(s.closeUs)).filter(v => Number.isFinite(v) && v > 0);
  const roundedCounts = new Map();
  closeUsValues.forEach(v => {
    const k = Math.round(v / 1000); // millisecond bucket is enough for browser-side diagnostics.
    roundedCounts.set(k, (roundedCounts.get(k) || 0) + 1);
  });
  const repeatedForcedClose = Array.from(roundedCounts.values()).some(count => count >= 2);
  return repeatedForcedClose || activeSensors.length === 1;
}

// Derive measurement hints in the WebUI from raw sensor and flash data.
function evaluateMeasurementHintFromData(data = {}) {
  const sensors = Array.isArray(data.sensors) ? data.sensors : [];
  const activeSensors = sensors.filter(s => s && s.activated && Number(s.openUs) > 0 && Number(s.closeUs) > Number(s.openUs));
  const flash = data.flash || null;
  const flashDetected = !!(flash && flash.detected && Number(flash.triggerUs) > 0);
  const mode = normalizeMeasurementMode(data.mode || data.measurementMode || data.shutterMode);
  const isCentral = mode === 'central';

  if (activeSensors.length && isTimeoutMeasurementPattern(activeSensors)) {
    return makeMeasurementHint('timeout_with_data', 'Timeout measurement');
  }
  if (!activeSensors.length && flashDetected) {
    return makeMeasurementHint('flash_without_sensor', 'Flash without shutter sensor');
  }
  if (!isCentral && activeSensors.length > 0 && activeSensors.length < MIN_VALID_SENSOR_COUNT) {
    return makeMeasurementHint('too_few_sensors', 'Too few sensors were covered');
  }
  if (!isCentral && activeSensors.length > 0 && activeSensors.length < 5) {
    return makeMeasurementHint('incomplete_sensor_coverage', 'Incomplete sensor coverage');
  }
  return makeMeasurementHint('none');
}

// Compatibility wrapper: measurement hints are intentionally derived in the WebUI, not trusted from firmware packets.
function normalizeHint(packet) {
  return evaluateMeasurementHintFromData(packet || {});
}

// Compare two dotted semantic-ish version strings.
function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

// Split release.api.bugfix versions into numeric parts.
function versionParts(value) {
  return String(value || '').split('.').map(v => parseInt(v, 10) || 0);
}

// Firmware and WebUI are API-compatible when release and API version match.
function sameApiVersion(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  return (pa[0] || 0) === (pb[0] || 0) && (pa[1] || 0) === (pb[1] || 0);
}

// Keep only the content inside a <pre> block when a raw text response is browser-wrapped as HTML.
function unwrapPreContent(value) {
  const raw = String(value || '');
  const lower = raw.toLowerCase();
  const preStart = lower.indexOf('<pre');
  if (preStart < 0) return raw;

  const contentStart = lower.indexOf('>', preStart);
  if (contentStart < 0) return raw;

  const contentEnd = lower.indexOf('</pre>', contentStart + 1);
  if (contentEnd < 0) return raw.slice(contentStart + 1);
  return raw.slice(contentStart + 1, contentEnd);
}

// Read the first non-empty version line from plain text or <pre>-wrapped text.
function cleanVersion(value) {
  const text = unwrapPreContent(value);
  const lines = text.replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

// Format an unavailable or available version for display.
function versionLabel(value) {
  const v = cleanVersion(value);
  return v ? 'v' + v : tx('versions.unknown', 'unknown');
}

function parseVersionInfoResponse(value) {
  const fallback = {
    manifestAvailable: false,
    currentFirmware: '',
    projectVersion: '',
    bugfixversion: ''
  };

  const raw = unwrapPreContent(value).trim();
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return {
        manifestAvailable: parsed.manifestAvailable === true,
        currentFirmware: cleanVersion(parsed.currentFirmware),
        projectVersion: cleanVersion(parsed.projectVersion),
        bugfixversion: cleanVersion(parsed.bugfixversion)
      };
    }
  } catch (e) {
    return fallback;
  }

  return fallback;
}

// Update visible warnings about WebUI and firmware version mismatches.
function updateVersionWarnings(showToast = false) {
  const info = S.versionInfo || {};
  const firmware = cleanVersion(info.currentFirmware || (S.deviceConfig && S.deviceConfig.version));
  const webui = cleanVersion(APP_VERSION);
  const compatibleWebui = cleanVersion(info.bugfixversion || S.cdnVersion);
  const projectVersion = cleanVersion(info.projectVersion);
  const manifestAvailable = info.manifestAvailable === true;

  // Release/API mismatches are compatibility warnings. Bugfix-only differences are allowed.
  S.versionMismatch = (firmware && webui && !sameApiVersion(firmware, webui))
    ? tf('versions.firmwareWebUiMismatch', 'Firmware {firmware} and Web UI {webui} use different API versions.', {
        firmware: versionLabel(firmware),
        webui: versionLabel(webui)
      })
    : '';

  S.webUiUpdateAvailable = (manifestAvailable && compatibleWebui && compareVersions(compatibleWebui, webui) > 0)
    ? tf('versions.newWebUiAvailable', 'New Web UI version available {version}', { version: versionLabel(compatibleWebui) })
    : '';

  S.firmwareUpdateAvailable = (manifestAvailable && projectVersion && firmware && compareVersions(projectVersion, firmware) > 0)
    ? tf('versions.newFirmwareAvailable', 'New firmware version available {version}', { version: versionLabel(projectVersion) })
    : '';

  S.updateAvailable = [S.webUiUpdateAvailable, S.firmwareUpdateAvailable].filter(Boolean).join(' ');
  S.versionWarning = [S.versionMismatch, S.updateAvailable].filter(Boolean).join(' ');
  renderWebUiVersionSummary();

  if (!showToast) return;
  const notice = S.versionMismatch || S.webUiUpdateAvailable || S.firmwareUpdateAvailable;
  if (notice && notice !== S.lastVersionNotice) {
    S.lastVersionNotice = notice;
    if (S.versionMismatch) toast(tx('versions.mismatchTitle', 'Version mismatch') + ': ' + S.versionMismatch, 'warning');
    else toast(notice, 'success');
  }
}

// Check whether the connected firmware version fits this WebUI.
function checkFirmwareCompatibility(cfg) {
  updateVersionWarnings(true);
}

// Look up localized help text for a code.
function helpLookup(group, key) {
  if (!key || key === 'none') return null;
  const base = tx(group + '.' + key, null);
  if (base && typeof base === 'object') return base;
  return null;
}

// Return help text for a measurement hint.
function measurementHintHelp(key, fallbackText = '') {
  const h = helpLookup('measurementHints', key);
  if (h) return h;
  if (!key || key === 'none') return null;
  return {
    title: fallbackText || key,
    body: fallbackText || key,
    action: tx('measurementHints.generic.action', 'Check the camera setup and repeat the measurement.')
  };
}

// Return help text for a device error.
function deviceErrorHelp(key, fallbackText = '') {
  const h = helpLookup('deviceErrors', key);
  if (h) return h;
  if (!key || key === 'none') return null;
  return {
    title: fallbackText || key,
    body: fallbackText || key,
    action: tx('deviceErrors.generic.action', 'Check the device and reconnect when the problem is fixed.')
  };
}

// Build localized HTML help for a connection or network hint.
function connectionHelpHtml() {
  const steps = tx('connectionHelp.steps', [
    'Make sure the device is powered on.',
    'Use opencurtainlab.local or the IP shown on the OLED.',
    'Make sure this computer is on the same Wi-Fi network.',
    'If setup mode is active, connect to the OpenCurtainLab Wi-Fi and open 192.168.4.1.'
  ]);
  const arr = Array.isArray(steps) ? steps : [];
  return `<div class="notice-card notice-info"><div class="notice-title">${esc(tx('connectionHelp.title', 'Could not connect to OpenCurtainLab'))}</div><ol>${arr.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>`;
}

// Build a reusable notice card for warnings and errors.
function buildNoticeCard(kind, title, body, action) {
  const cls = kind === 'error' ? 'notice-error'
    : kind === 'warning' ? 'notice-warning'
    : kind === 'success' ? 'notice-success'
    : 'notice-info';
  return `<div class="notice-card ${cls}">
    <div class="notice-title">${esc(title || '')}</div>
    ${body ? `<div class="notice-body">${esc(body)}</div>` : ''}
    ${action ? `<div class="notice-action">${esc(action)}</div>` : ''}
  </div>`;
}

// Build the active device-error notice card.
function deviceNoticeHtml() {
  const dev = S.deviceStatus || {};
  if (!dev.error || dev.error === 'none') return '';
  const h = deviceErrorHelp(dev.error, dev.errorText || dev.error);
  return buildNoticeCard('error', h.title, h.body, h.action);
}

// Build the firmware compatibility notice card.
function firmwareNoticeHtml() {
  const notices = [];
  if (S.versionMismatch) {
    notices.push(buildNoticeCard('error', tx('versions.mismatchTitle', 'Version mismatch'), S.versionMismatch, tx('versions.mismatchAction', 'Use firmware and Web UI files from the same release.')));
  }
  if (S.webUiUpdateAvailable) {
    notices.push(buildNoticeCard('success', tx('versions.newWebUiAvailableTitle', 'New Web UI version available'), S.webUiUpdateAvailable, tx('versions.webUiUpdateAction', 'Download the current Web UI files from the project release.')));
  }
  if (S.firmwareUpdateAvailable) {
    notices.push(buildNoticeCard('success', tx('versions.newFirmwareAvailableTitle', 'New firmware version available'), S.firmwareUpdateAvailable, tx('versions.firmwareUpdateAction', 'Install the current firmware from the project release.')));
  }
  return notices.join('');
}

// Build the latest measurement-hint notice card.
function measurementHintNoticeHtml(entry) {
  if (!entry || !entry.hint || entry.hint === 'none') return '';
  if (normalizeMeasurementMode(entry.mode) === 'central' && isLowSensorCoverageHint(entry.hint)) return '';
  const h = measurementHintHelp(entry.hint, entry.hintText || entry.hint);
  return buildNoticeCard('warning', h.title, h.body, h.action);
}

// Apply a configuration object received from the firmware.
function applyDeviceConfig(d) {
  if (!d) return;

  // /config is the authority for target lists and runtime settings. Measurement geometry is stored per measurement packet.
  if (d.settings && d.settings.targetSeries) {
    const arr = d.settings.targetSeries === 'custom'
      ? (d.targetTimesCustom || d.settings.customTargetTimes)
      : d.targetTimesStandard;
    if (Array.isArray(arr)) S.targetTimes = arr.map(Number).filter(t => t > 0);
  } else if (Array.isArray(d.targetTimesStandard)) {
    S.targetTimes = d.targetTimesStandard.map(Number).filter(t => t > 0);
  }

  if (d.settings) S.deviceSettings = sanitizeDeviceSettings(d.settings);

  if (d.device || d.version || d.settings || d.maxTargetTime) {
    S.deviceConfig = Object.assign({}, S.deviceConfig || {}, d);
    checkFirmwareCompatibility(S.deviceConfig);
    renderDeviceConfigSummary();
    renderSettingsControls();
    renderEmptyStateIfNeeded();
  }

  saveDeviceConfigLocal();
}

function renderVersionSummary() {
  const el = document.getElementById('settings-version-summary');
  if (!el) return;
  const info = S.versionInfo || {};
  const c = S.deviceConfig || {};
  const rt = S.deviceRuntime || {};
  const deviceVersion = cleanVersion(info.currentFirmware || rt.version || c.version);
  const manifestKnown = info.manifestAvailable === true || !!S.cdnVersion;

  let statusClass = 'version-ok';
  let statusText = tx('versions.upToDate', 'Software up to date');
  if (S.versionMismatch) {
    statusClass = 'version-mismatch';
    statusText = tx('versions.mismatchTitle', 'Version mismatch');
  } else if (S.webUiUpdateAvailable && S.firmwareUpdateAvailable) {
    statusClass = 'version-update';
    statusText = tx('versions.multipleUpdatesAvailable', 'Updates available');
  } else if (S.webUiUpdateAvailable) {
    statusClass = 'version-update';
    statusText = S.webUiUpdateAvailable;
  } else if (S.firmwareUpdateAvailable) {
    statusClass = 'version-update';
    statusText = S.firmwareUpdateAvailable;
  } else if (!manifestKnown) {
    statusClass = 'version-unknown';
    statusText = tx('versions.updateUnknown', 'Update unknown');
  }

  el.innerHTML = [
    `<span>${esc(tf('versions.webUiLabel', 'WebUI {version}', { version: versionLabel(APP_VERSION) }))}</span>`,
    `<span>${esc(tf('versions.deviceLabel', 'Device {version}', { version: versionLabel(deviceVersion) }))}</span>`,
    `<span class="${statusClass}">${esc(statusText)}</span>`
  ].join('');
  el.classList.toggle('has-version-mismatch', !!S.versionMismatch);
  el.classList.toggle('has-update-available', !!S.updateAvailable);
  el.title = [S.versionMismatch, S.webUiUpdateAvailable, S.firmwareUpdateAvailable].filter(Boolean).join(' ');
}

// Format the battery voltage from /status as voltage and percentage.
function formatBatteryVoltageStatus(voltage) {
  const n = Number(voltage);
  if (!Number.isFinite(n) || n <= 0) return tx('settingsInfo.unavailable', '-');
  const pct = batteryPercentage(n);
  const label = n.toLocaleString(uiLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${label}V - ${pct ?? 0}%`;
}

// Render important /status details in the device settings card.
function renderSettingsDeviceInfo() {
  const el = document.getElementById('settings-device-info');
  if (!el) return;
  const cfg = S.deviceConfig || {};
  const net = S.networkStatus || {};
  const dev = S.deviceStatus || {};
  const rt = S.deviceRuntime || {};
  const dash = tx('settingsInfo.unavailable', '-');
  const statusOk = !(dev.error && dev.error !== 'none');
  const connected = !!S.connected;
  const statusValue = !connected
    ? tx('settingsInfo.notConnected', 'disconnected')
    : statusOk ? tx('settingsInfo.ok', 'OK') : (dev.errorText || dev.error || tx('settingsInfo.problem', 'problem'));
  const rows = [
    { label: tx('settingsInfo.status', 'Status'), value: statusValue, cls: !connected ? 'warn' : (statusOk ? 'ok' : 'err') },
    { label: tx('settingsInfo.ip', 'IP'), value: connected ? (net.ip || cfg.ip || dash) : dash }
  ];
  if (isBatteryVoltageEnabled()) {
    rows.push({ label: tx('settingsInfo.battery', 'Battery'), value: formatBatteryVoltageStatus(rt.batteryVoltage) });
  }
  rows.push({ label: tx('settingsInfo.measurementId', 'Measurement ID'), value: Number.isFinite(Number(rt.measCount)) ? String(rt.measCount) : dash });

  el.innerHTML = rows.map(row => `<div class="settings-info-row"><span class="settings-info-label">${esc(row.label)}</span><span class="settings-info-value ${row.cls || ''}">${esc(row.value)}</span></div>`).join('');
}

// Render the WebUI version row in settings.
function renderWebUiVersionSummary() {
  renderVersionSummary();
}

// Render the compact version and device-status summary in settings.
function renderDeviceConfigSummary() {
  renderVersionSummary();
  renderSettingsDeviceInfo();
}

// Render all settings controls from local state and device capabilities.
function renderSettingsControls() {
  const st = Object.assign({}, DEFAULT_DEVICE_SETTINGS, S.deviceSettings || {});
  const seriesSel = document.getElementById('set-target-series');
  const sensSel = document.getElementById('set-sensitivity');
  const resultSel = document.getElementById('set-result-display');
  const sleepSel = document.getElementById('set-oled-sleep');
  const customEl = document.getElementById('set-custom-target-times');
  const addrEl = document.getElementById('device-address-input');
  const interpEl = document.getElementById('ui-interpolate-charts');
  const pollEl = document.getElementById('ui-poll-interval-ms');
  if (seriesSel) seriesSel.value = st.targetSeries || 'standard';
  if (sensSel) sensSel.value = SENSOR_SENSITIVITIES.includes(st.sensorSensitivity) ? st.sensorSensitivity : DEFAULT_DEVICE_SETTINGS.sensorSensitivity;
  if (resultSel) resultSel.value = st.resultDisplay || 'until_button';
  if (sleepSel) sleepSel.value = String(st.oledSleepMinutes ?? 5);
  if (customEl) customEl.value = Array.isArray(st.customTargetTimes) ? st.customTargetTimes.join(',') : standardTargetTimes().join(',');
  if (addrEl) addrEl.value = S.deviceHost || DEFAULT_DEVICE_HOST;
  if (interpEl) interpEl.checked = !!(S.uiSettings && S.uiSettings.interpolateCharts);
  if (pollEl) pollEl.value = String(currentPollIntervalMs());
  setCustomTargetTimesError('');
  setDeviceAddressError('');
  onTargetSeriesChanged(false);
  bindSettingsChangeHandlers();
  bindBackupFileInput();
  S.settingsSnapshot = snapshotSettingsForm();
  S.settingsDirty = false;
  S.settingsSaving = false;
  updateSettingsSaveState();
}

// Read the settings form into a normalized object.
function snapshotSettingsForm() {
  const seriesSel = document.getElementById('set-target-series');
  const customEl = document.getElementById('set-custom-target-times');
  const sensSel = document.getElementById('set-sensitivity');
  const resultSel = document.getElementById('set-result-display');
  const sleepSel = document.getElementById('set-oled-sleep');
  return JSON.stringify({
    targetSeries: seriesSel ? seriesSel.value : 'standard',
    customTargetTimes: customEl ? String(customEl.value || '').trim() : '',
    sensorSensitivity: sensSel && SENSOR_SENSITIVITIES.includes(sensSel.value) ? sensSel.value : DEFAULT_DEVICE_SETTINGS.sensorSensitivity,
    resultDisplay: resultSel ? resultSel.value : 'until_button',
    oledSleepMinutes: sleepSel ? String(sleepSel.value) : '5'
  });
}

// Enable or disable the settings save button based on changes and validity.
function updateSettingsSaveState() {
  const btn = document.getElementById('save-device-settings-btn');
  const status = document.getElementById('settings-save-status');
  const now = snapshotSettingsForm();
  S.settingsDirty = now !== S.settingsSnapshot;
  if (btn) {
    btn.disabled = S.settingsSaving || !S.settingsDirty;
    btn.textContent = S.settingsSaving
      ? tx('settings.saving', 'SAVING...')
      : S.settingsDirty ? tx('settings.save', 'SAVE SETTINGS') : tx('settings.saved', 'SAVED');
  }
  if (status) {
    status.textContent = S.settingsSaving
      ? tx('settings.savingLabel', 'Saving...')
      : S.settingsDirty ? tx('settings.unsaved', 'Unsaved changes') : '';
  }
}

// Mark the settings form as changed and refresh validation state.
function markSettingsDirty() {
  updateSettingsSaveState();
}

// Enable or disable speed-chart interpolation and redraw the current detail view.
function setChartInterpolation(enabled) {
  S.uiSettings = Object.assign({}, DEFAULT_UI_SETTINGS, S.uiSettings || {}, { interpolateCharts: !!enabled });
  saveUiSettings();
  const entry = S.selId ? S.history.find(e => e.id === S.selId) : null;
  if (entry) requestAnimationFrame(() => drawCurtainTimeChart(entry));
  const project = activeProject();
  if (project && !isDefaultProject(project)) requestAnimationFrame(() => drawCurtainChart(project));
}

// Save and apply the WebUI polling interval.
function setPollingIntervalMs(value) {
  const interval = normalizePollIntervalMs(value);
  S.uiSettings = Object.assign({}, DEFAULT_UI_SETTINGS, S.uiSettings || {}, { pollIntervalMs: interval });
  saveUiSettings();
  const input = document.getElementById('ui-poll-interval-ms');
  if (input) input.value = String(interval);
  startPollingLoop();
}


// Attach event handlers for settings controls once.
function bindSettingsChangeHandlers() {
  const ids = ['set-target-series', 'set-custom-target-times', 'set-sensitivity', 'set-result-display', 'set-oled-sleep'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.dataset.oclDirtyBound) return;
    el.addEventListener('input', markSettingsDirty);
    el.addEventListener('change', markSettingsDirty);
    el.dataset.oclDirtyBound = '1';
  });
}

// Attach the backup import file input handler without inline JavaScript.
function bindBackupFileInput() {
  const el = document.getElementById('backup-file');
  if (!el || el.dataset.oclImportBound) return;
  el.addEventListener('change', () => {
    importBackupJSON(el.files && el.files[0]);
    el.value = '';
  });
  el.dataset.oclImportBound = '1';
}
// React to switching between standard and custom target time series.
function onTargetSeriesChanged(markDirty = true) {
  const customEl = document.getElementById('set-custom-target-times');
  const errorEl = document.getElementById('custom-target-times-error');
  if (customEl) customEl.style.display = '';
  if (errorEl) errorEl.style.display = '';
  if (markDirty) updateSettingsSaveState();
}
// Parse and validate a comma-separated list of target times.
function validateTargetTimesInput(raw, { allowEmptyStandard = true } = {}) {
  const text = String(raw || '').trim();
  if (!text && allowEmptyStandard) {
    const times = standardTargetTimes();
    return {
      ok: true,
      times,
      usedStandard: true,
      message: tx('toast.customTimesDefaulted', 'Standard target times loaded')
    };
  }
  if (!text) return { ok: false, reason: 'empty', message: tx('toast.customTimesEmpty', 'Custom target times are empty') };
  if (/[^0-9,;\s]/.test(text)) {
    return { ok: false, reason: 'invalid', message: tx('toast.customTimesInvalid', 'Invalid custom target times. Use positive numbers separated by commas.') };
  }
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  const values = parts.map(v => Number(v));
  const maxT = deviceMaxTargetTime();
  if (!values.length || values.some(v => !Number.isInteger(v) || v <= 0 || v > maxT)) {
    return { ok: false, reason: 'invalid', message: tf('toast.customTimesInvalidWithMax', 'Invalid custom target times. Use positive numbers up to 1/{max}, separated by commas.', {max: maxT}) };
  }
  if (values.length > 16) return { ok: false, reason: 'too_many', message: tx('toast.customTimesTooMany', 'Maximum 16 custom target times allowed') };
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) return { ok: false, reason: 'duplicate', message: tx('toast.customTimesDuplicate', 'Custom target times contain duplicates') };
    seen.add(v);
  }
  return { ok: true, times: values.slice().sort((a, b) => a - b), usedStandard: false };
}

// Validate the custom target-time editor and update its help text.
function validateCustomTargetTimesField() {
  const input = document.getElementById('set-custom-target-times');
  if (!input) return true;
  const result = validateTargetTimesInput(input.value);
  setCustomTargetTimesError(result.ok ? '' : result.message);
  updateSettingsSaveState();
  return result.ok;
}

// Return the current custom target-time list from settings or device defaults.
function customTargetTimesFromSettings() {
  const arr = S.deviceSettings && Array.isArray(S.deviceSettings.customTargetTimes)
    ? S.deviceSettings.customTargetTimes
    : DEFAULT_CUSTOM_TIMES;
  return arr.map(Number).filter(v => Number.isFinite(v) && v > 0);
}

// Apply the result of saving configuration to the device.
function applyConfigPostResponse(response) {
  if (!response) return;

  // POST /config returns the stored settings. Treat that response as the new local config
  // without doing an immediate second /config request.
  const merged = Object.assign({}, S.deviceConfig || {});
  if (response.settings) {
    merged.settings = response.settings;
    if (Array.isArray(response.settings.customTargetTimes)) {
      merged.targetTimesCustom = response.settings.customTargetTimes;
    }
  }
  if (response.maxTargetTime) merged.maxTargetTime = response.maxTargetTime;
  if (response.targetTimesStandard) merged.targetTimesStandard = response.targetTimesStandard;
  if (response.targetTimesCustom) merged.targetTimesCustom = response.targetTimesCustom;
  applyDeviceConfig(merged);
}

// Validate, normalize, save, and connect to a manually entered device address.
async function connectToDeviceAddress() {
  const input = document.getElementById('device-address-input');
  const raw = input && input.value ? input.value : DEFAULT_DEVICE_HOST;
  const base = normalizeDeviceBase(raw);
  setDeviceAddressError('');
  setConnState('connecting');

  try {
    const r = await fetch(base + '/config', { signal: AbortSignal.timeout(2200), mode: 'cors' });
    if (!r.ok) throw httpStatusError(r);
    const cfg = await r.json();
    S.deviceBase = base;
    S.deviceHost = base.replace(/^https?:\/\//, '');
    applyDeviceConfig(cfg);
    await fetchDeviceStatus(true);
    saveDeviceConfigLocal();
    S.connectionProblem = null;
    setConnState('connected');
    toast(tf('toast.deviceConnected', 'Device connected: {host}', {host: S.deviceHost}), 'success');
  } catch (e) {
    S.deviceBase = '';
    setConnState('connecting');
    const msg = tx('toast.deviceNotFoundHost', 'No OpenCurtainLab found at this address.');
    S.connectionProblem = { type: 'not_found', message: msg };
    setDeviceAddressError(msg);
    toast(msg, 'error');
  }
}


// Send changed settings to the firmware and update local state.
async function saveDeviceSettings() {
  if (!S.deviceBase && !(await initDeviceConnection(true))) return;
  if (S.settingsSaving) return;
  const targetSeries = document.getElementById('set-target-series').value;
  const customInput = document.getElementById('set-custom-target-times');
  const customResult = validateTargetTimesInput(customInput && customInput.value);
  if (!customResult.ok) {
    setCustomTargetTimesError(customResult.message);
    toast(customResult.message, 'warning');
    return;
  }

  setCustomTargetTimesError('');
  const customTargetTimes = customResult.times;
  if (customInput) customInput.value = customTargetTimes.join(',');


  const storedSettings = Object.assign({}, DEFAULT_DEVICE_SETTINGS, S.deviceSettings || {});
  const body = {
    defaultMeasurementMode: normalizeMeasurementMode(storedSettings.defaultMeasurementMode),
    defaultTargetTime: Number.isFinite(Number(storedSettings.defaultTargetTime))
      ? Number(storedSettings.defaultTargetTime)
      : DEFAULT_DEVICE_SETTINGS.defaultTargetTime,
    targetSeries,
    customTargetTimes,
    sensorSensitivity: SENSOR_SENSITIVITIES.includes(document.getElementById('set-sensitivity').value)
      ? document.getElementById('set-sensitivity').value
      : DEFAULT_DEVICE_SETTINGS.sensorSensitivity,
    resultDisplay: document.getElementById('set-result-display').value,
    oledSleepMinutes: Number(document.getElementById('set-oled-sleep').value)
  };
  try {
    S.settingsSaving = true;
    updateSettingsSaveState();
    const r = await fetch(api('/config'), {
      method: 'POST', mode: 'cors', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(2200)
    });
    if (!r.ok) throw httpStatusError(r);
    const d = await r.json();
    applyConfigPostResponse(d);
    saveDeviceConfigLocal();
    renderSettingsControls();
    toast(customResult.usedStandard ? tx('toast.customTimesDefaulted', 'Standard target times loaded') : tx('toast.settingsSaved', 'Settings saved'), customResult.usedStandard ? 'info' : 'success');
  } catch(e) {
    toast(tx('toast.settingsSaveFailed', 'Settings could not be saved'), 'error');
  } finally {
    S.settingsSaving = false;
    updateSettingsSaveState();
  }
}

// Ensure a device connection exists before calling a device-only action.
async function ensureDeviceConnection(showMessages = true) {
  if (S.deviceBase) return true;
  return initDeviceConnection(showMessages);
}

function arraysEqualNumberList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Number(a[i]) !== Number(b[i])) return false;
  return true;
}

function projectTargetTimes(p) {
  const values = Array.isArray(p && p.times) ? p.times : [];
  return values.map(Number).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
}

function deviceSettingsForProject(p) {
  const times = projectTargetTimes(p);
  if (!p || isDefaultProject(p) || !times.length) return null;

  const standard = standardTargetTimes();
  const useStandard = projectTargetSeries(p) === 'standard' && arraysEqualNumberList(times, standard);
  const currentDefault = Number(S.deviceSettings && S.deviceSettings.defaultTargetTime);
  const defaultTargetTime = times.includes(currentDefault) ? currentDefault : times[0];
  const body = {
    defaultMeasurementMode: normalizeMeasurementMode(p.mode),
    defaultTargetTime,
    targetSeries: useStandard ? 'standard' : 'custom'
  };
  if (!useStandard) body.customTargetTimes = times;
  return body;
}

async function syncProjectSettingsToDevice(p) {
  if (!S.deviceBase) return false;
  const body = deviceSettingsForProject(p);
  if (!body) return false;
  try {
    const r = await fetch(api('/config'), {
      method: 'POST', mode: 'cors', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body), signal: AbortSignal.timeout(2200)
    });
    if (!r.ok) return false;
    const d = await r.json();
    applyConfigPostResponse(d);
    saveDeviceConfigLocal();
    return true;
  } catch (e) {
    return false;
  }
}

// Fetch live sensor diagnostics for developer console use.
async function fetchSensorDiagnostics() {
  if (!(await ensureDeviceConnection(true))) {
    throw new Error(tx('toast.deviceNotConnected', 'Device not connected'));
  }

  const r = await fetch(api('/sensors'), { signal: AbortSignal.timeout(1800), mode: 'cors' });
  if (!r.ok) throw new Error('GET /sensors failed');
  const d = await r.json();
  if (Array.isArray(d.sensors) && console && console.table) {
    console.table(d.sensors.map(sensor => ({
      id: sensor.id,
      pin: sensor.pin,
      raw: sensor.raw,
      onThresholdRaw: sensor.onThresholdRaw,
      offThresholdRaw: sensor.offThresholdRaw,
      active: sensor.active,
      trackedActive: sensor.trackedActive,
      wasActivated: sensor.wasActivated
    })));
  }
  if (d.flash) console.log('OpenCurtainLab flash', d.flash);
  return d;
}

