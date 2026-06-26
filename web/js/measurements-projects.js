// Device status handling, measurement ingestion, project lists, and detail rendering.

// Apply device status data and update related UI indicators.
function applyDeviceStatus(status) {
  if (!status) return;

  S.deviceStatus = Object.assign({ error: 'none', errorText: '', subsystem: 'none' }, status.deviceStatus || {});

  S.networkStatus = Object.assign({
    connected: false,
    apMode: false,
    ip: '',
    apIp: '',
    hostname: '',
    mdns: '',
    mdnsStarted: false,
    hint: 'none',
    hintText: ''
  }, status.network || {});

  S.deviceRuntime = Object.assign({}, S.deviceRuntime || {}, {
    uptime: Number.isFinite(Number(status.uptime)) ? Number(status.uptime) : null,
    measCount: Number.isFinite(Number(status.measCount)) ? Number(status.measCount) : null,
    batteryVoltage: Number.isFinite(Number(status.batteryVoltage)) ? Number(status.batteryVoltage) : null,
    device: status.device || (S.deviceConfig && S.deviceConfig.device) || '',
    version: status.version || (S.deviceConfig && S.deviceConfig.version) || ''
  });

  notifyDeviceStatusChanges();
  renderDeviceConfigSummary();
}

// Return whether a network hint should be surfaced to the user.
function isNoticeableNetworkHint(hint) {
  return !!hint && hint !== 'none' && hint !== 'access_point_active' && hint !== 'no_credentials';
}

// Show notifications for meaningful device status changes.
function notifyDeviceStatusChanges() {
  const dev = S.deviceStatus || {};
  const net = S.networkStatus || {};
  const rt = S.deviceRuntime || {};

  const devKey = dev.error && dev.error !== 'none' ? dev.error : '';
  if (devKey !== S.lastDeviceErrorNotice) {
    S.lastDeviceErrorNotice = devKey;
    if (devKey) {
      const h = deviceErrorHelp(devKey, dev.errorText || dev.error);
      toast(h.title + (h.action ? ': ' + h.action : ''), 'error');
    }
  }

  const netKey = isNoticeableNetworkHint(net.hint) ? net.hint : '';
  if (netKey !== S.lastNetworkHintNotice) {
    S.lastNetworkHintNotice = netKey;
    if (netKey) toast(net.hintText || net.hint || tx('connection.networkHint', 'Network issue'), 'warning');
  }

  if (!isBatteryVoltageEnabled()) {
    S.lastBatteryLowNotice = '';
    return;
  }

  const voltage = Number(rt.batteryVoltage);
  const pct = batteryPercentage(voltage);
  const lowBattery = Number.isFinite(voltage) && voltage > 0 && pct !== null && pct <= BATTERY_LOW_NOTICE_PERCENT;
  const batteryKey = lowBattery ? 'low' : '';
  if (batteryKey !== S.lastBatteryLowNotice) {
    S.lastBatteryLowNotice = batteryKey;
    if (lowBattery) {
      toast(tf('toast.batteryLow', 'Battery low: {voltage} V ({percent}%).', {
        voltage: voltage.toLocaleString(uiLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
        percent: pct
      }), 'warning');
    }
  }
}

// Return a localized label for a connection state.
function connectionLabelForState(state) {
  if (state === 'connected') return tx('connection.connected', 'CONNECTED');
  return tx('connection.connecting', 'CONNECTING...');
}

// Check the manifest-selected compatible WebUI version through the device proxy.
async function checkAppVersion() {
  try {
    const base = S.deviceBase || '';
    const url = base ? api('/version') : '/version';
    const r = await fetch(url + '?t=' + Date.now(), { cache:'no-store', mode:'cors', signal: AbortSignal.timeout(2200) });
    if (!r.ok) return;
    S.cdnVersion = cleanVersion(await r.text());
    updateVersionWarnings(true);
    renderDeviceConfigSummary();
  } catch(e) {
    // Offline use is supported; absence of /version only disables update checks.
  }
}


// Update connection state indicators and warnings.
function setConnState(state) {
  const normalized = state === 'connected' ? 'connected' : 'connecting';
  const dot  = document.getElementById('cdot');
  const lbl  = document.getElementById('clabel');
  const pill = dot ? dot.closest('.conn-pill') : null;
  if (!dot || !lbl) return;

  // The pill only reports API reachability. Diagnostics are displayed as popup notifications.
  if (pill) pill.className = 'conn-pill ' + normalized;

  if (normalized === 'connected') {
    S.connected = true;
    dot.className = 'conn-dot on';
  } else {
    S.connected = false;
    dot.className = 'conn-dot';
  }

  lbl.textContent = connectionLabelForState(normalized);
  renderEmptyStateIfNeeded();
}

// Show a toast for a new measurement hint.
function notifyMeasurementHint(entry) {
  const key = entry && entry.id && entry.hint ? entry.id + ':' + entry.hint : '';
  if (!key || key === S.lastMeasurementHintNotice) return;
  S.lastMeasurementHintNotice = key;
  const h = measurementHintHelp(entry.hint, entry.hintText || entry.hint);
  toast(h.title + (h.action ? ': ' + h.action : ''), 'warning');
}

// ════════════════════════════════════════════
   // INGEST MEASUREMENT
// ════════════════════════════════════════════
function ingestMeasurement(d) {
  if (!d || !d.id) return false;

  const h = normalizeHint(d);
  if (h.hasHint) notifyMeasurementHint({ id: d.id, hint: h.hint, hintText: h.hintText });

  // Store measurements with raw timing data even when they are invalid for camera projects.
  // They are kept in the default project for diagnostics and excluded from project scores.
  const previouslyActive = activeProject();
  const entry = buildEntryFromPacket(d);
  if (!entry) return false;

  const assignedToDefault = previouslyActive &&
    !isDefaultProject(previouslyActive) &&
    entry.projId === DEFAULT_PROJECT_ID;

  if (assignedToDefault) {
    toast(tx('toast.measurementAssignedToDefaultIncompatible', 'Measurement assigned to the default project because it does not match the selected project.'), 'warning');
  }

  S.history.unshift(entry);
  if (S.history.length > 300) S.history.pop();
  saveAppData();
  renderProjList();
  renderHistList();

  if (entry.projId === S.selectedProjId) {
    selectEntry(entry.id, false);
    redirectToLatestMeasurement();
  } else {
    renderEmptyStateIfNeeded();
  }

  requestAnimationFrame(() => {
    const el = document.getElementById('he-' + entry.id);
    if (el) el.classList.add('new-flash');
  });
  return true;
}

// Convert raw firmware measurement data into a WebUI history entry.
function buildEntryFromPacket(d) {
  if (!d || !d.id) return null;
  // Current firmware interface: baseUs plus per-sensor openUs/closeUs timestamps.
  if (d.baseUs != null && Array.isArray(d.sensors)) {
    const target = Number(d.target || 0);
    const targetSec = target > 0 ? 1 / target : 0;
    const baseUs = Number(d.baseUs || 0);

    const sensors = d.sensors.map((s, idx) => {
      const openUs = Number(s.openUs || 0);
      const closeUs = Number(s.closeUs || 0);
      const activated = !!s.activated && openUs > 0 && closeUs > openUs;
      const seconds = activated ? (closeUs - openUs) / 1e6 : 0;
      return {
        id: s.id ?? idx,
        pin: s.pin,
        activated,
        raw: s.raw,
        openUs,
        closeUs,
        openMs: activated && baseUs ? (openUs - baseUs) / 1000 : 0,
        closeMs: activated && baseUs ? (closeUs - baseUs) / 1000 : 0,
        seconds,
        fraction: seconds > 0 ? Math.round(1 / seconds) : 0,
        deviation: seconds > 0 && targetSec > 0 ? Math.log2(seconds / targetSec) : 0,
      };
    });

    const act = sensors.filter(s => s.activated);
    const avgSec = act.length ? act.reduce((a,s)=>a+s.seconds,0) / act.length : 0;
    const durs = act.map(s => s.seconds).filter(v => v > 0);
    const minSec = durs.length ? Math.min(...durs) : 0;
    const maxSec = durs.length ? Math.max(...durs) : 0;

    let flash = null;
    if (d.flash) {
      const triggerUs = Number(d.flash.triggerUs || 0);
      const detected = !!d.flash.detected && triggerUs > 0;
      flash = {
        detected,
        pin: d.flash.pin,
        raw: d.flash.raw,
        triggerUs,
        triggerMs: detected && baseUs ? (triggerUs - baseUs) / 1000 : null,
      };
    }

    const h = normalizeHint(d);
    const projectInvalid = isProjectInvalidMeasurement({ hint: h.hint, valid: d.valid !== false, count: act.length });
    if (projectInvalid && h.hint === 'none' && act.length > 0 && act.length < MIN_VALID_SENSOR_COUNT) {
      h.hint = 'too_few_sensors';
      h.hintText = tx('measurementHints.too_few_sensors.title', 'Too few sensors were covered');
      h.hasHint = true;
    }
    if (!act.length) return null;
    const geometry = currentMeasurementGeometry();
    const x = Number(d.sensorDistanceXmm);
    const y = Number(d.sensorDistanceYmm);
    const entry = {
      id: d.id,
      valid: !projectInvalid,
      ts: Date.now(),
      targetFrac: target,
      mode: normalizeMeasurementMode(d.mode),
      avgFrac: avgSec > 0 ? Math.round(1 / avgSec) : 0,
      avgSec,
      avgDev: avgSec > 0 && targetSec > 0 ? Math.log2(avgSec / targetSec) : 0,
      spread: durs.length > 1 && minSec > 0 ? Math.log2(maxSec / minSec) : 0,
      count: act.length,
      sensors,
      flash,
      sensorDistanceXmm: Number.isFinite(x) && x > 0 ? x : geometry.sensorDistanceXmm,
      sensorDistanceYmm: Number.isFinite(y) && y > 0 ? y : geometry.sensorDistanceYmm,
      hint: h.hint,
      hintText: h.hintText,
      warning: h.hasHint ? h.hintText : '',
      projId: projectInvalid ? DEFAULT_PROJECT_ID : activeProjectIdForMeasurement(target, normalizeMeasurementMode(d.mode)),
      raw: d,
    };
    entry.flashSyncOk = isFlashSyncOk(entry);
    return entry;
  }

  return null;
}

// ════════════════════════════════════════════
   // SIDEBAR MOBILE
// ════════════════════════════════════════════
function toggleSidebar() {
  const sb   = document.getElementById('sidebar');
  const back = document.getElementById('sb-back');
  sb.classList.toggle('mob-open');
  back.classList.toggle('mob-open');
}

// Return a localized label for a measurement mode.
function modeLabel(mode) {
  const normalizedMode = normalizeMeasurementMode(mode);
  const m = MODES.find(x => x.key === normalizedMode);
  return m ? tx(m.labelKey, m.fallback) : tx('modes.horizontal', 'horizontal');
}

// Return the automatically detected travel direction for a measurement entry.
function detectedTravelDirectionInfo(entry) {
  const mode = normalizeMeasurementMode(entry && entry.mode);
  if (!entry || mode === 'central') return null;
  const sensors = (entry.sensors || [])
    .map((sensor, index) => ({ ...sensor, index: Number.isFinite(Number(sensor.id)) ? Number(sensor.id) : index }))
    .filter(sensor => sensor.activated && Number.isFinite(sensor.openMs))
    .sort((a, b) => a.openMs - b.openMs);
  if (sensors.length < 2) return null;
  const first = sensors[0].index;
  const last = sensors[sensors.length - 1].index;
  if (first === last) return null;

  if (mode === 'vertical') {
    return first < last
      ? { key: 'topDown', label: tx('directions.topDown', 'top → bottom'), rotation: 90 }
      : { key: 'bottomTop', label: tx('directions.bottomTop', 'bottom → top'), rotation: -90 };
  }

  return first < last
    ? { key: 'leftRight', label: tx('directions.leftRight', 'left → right'), rotation: 0 }
    : { key: 'rightLeft', label: tx('directions.rightLeft', 'right → left'), rotation: 180 };
}

function detectedTravelDirectionLabel(entry) {
  const direction = detectedTravelDirectionInfo(entry);
  return direction ? direction.label : '';
}

// Return a measurement-mode label with detected direction when available.
function measurementModeSummary(entry) {
  const base = modeLabel(entry && entry.mode);
  const direction = detectedTravelDirectionLabel(entry);
  return direction ? `${base} · ${direction}` : base;
}

function historyDirectionArrowHtml(entry) {
  const direction = detectedTravelDirectionInfo(entry);
  return direction ? `<span class="h-dir-icon" title="${esc(direction.label)}" style="--dir-rot:${direction.rotation}deg"><svg aria-hidden="true" focusable="false" viewBox="0 -960 960 960" xmlns="http://www.w3.org/2000/svg"><path d="M402.23-480 218.85-664 261-706.15 487.15-480 261-253.85 218.85-296l183.38-184Zm254 0L472.85-664 515-706.15 741.15-480 515-253.85 472.85-296l183.38-184Z"></path></svg></span>` : '';
}

function historyCentralIconHtml() {
  return `<span class="h-dir-icon h-dir-icon-central" aria-hidden="true"><svg class="empty-icon-svg" focusable="false" viewBox="0 -960 960 960" xmlns="http://www.w3.org/2000/svg"><path d="M480-360q-50 0-85-35t-35-85q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35ZM324-111.5Q251-143 197-197t-85.5-127Q80-397 80-480t31.5-156Q143-709 197-763t127-85.5Q397-880 480-880t156 31.5Q709-817 763-763t85.5 127Q880-563 880-480t-31.5 156Q817-251 763-197t-127 85.5Q563-80 480-80t-156-31.5ZM480-160q133 0 226.5-93.5T800-480q0-133-93.5-226.5T480-800q-133 0-226.5 93.5T160-480q0 133 93.5 226.5T480-160Zm0-320Zm141.5 141.5Q680-397 680-480t-58.5-141.5Q563-680 480-680t-141.5 58.5Q280-563 280-480t58.5 141.5Q397-280 480-280t141.5-58.5Z"></path></svg></span>`;
}

function historyModeHtml(entry) {
  const mode = normalizeMeasurementMode(entry && entry.mode);
  const icon = mode === 'central' ? historyCentralIconHtml() : historyDirectionArrowHtml(entry);
  const label = measurementModeSummary(entry);
  return `<div class="h-mode" title="${esc(label)}">${icon}</div>`;
}

// Return a localized label for a target-time series.
function targetSeriesLabel(series) {
  return series === 'custom'
    ? tx('targetSeries.custom', 'Custom')
    : tx('targetSeries.standard', 'Standard');
}

// ════════════════════════════════════════════
   // PROJECT MANAGEMENT
// ════════════════════════════════════════════
function normalizeProjectName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Return the target-time series configured for a project.
function projectTargetSeries(p) {
  return p && (p.targetSeries === 'custom' || p.targetSeries === 'standard') ? p.targetSeries : 'standard';
}

// Return the target times associated with a project series.
function projectTimesForSeries(series) {
  return series === 'custom' ? customTargetTimesFromSettings() : ALL_TIMES.slice();
}

// Update the new-project target-time picker for the selected series.
function updateProjectTimePicker() {
  const seriesEl = document.getElementById('proj-series');
  const series = seriesEl && seriesEl.value === 'custom' ? 'custom' : 'standard';
  const times = projectTimesForSeries(series);
  const grid = document.getElementById('time-picker');
  if (!grid) return;
  grid.innerHTML = times.map(t =>
    `<div class="t-tog on" data-t="${t}" onclick="this.classList.toggle('on')">1/${t}</div>`
  ).join('');
}

// Open the new-project modal with defaults.
function openNewProj() {
  document.getElementById('proj-name').value = '';
  const modeSel = document.getElementById('proj-mode');
  modeSel.innerHTML = MODES.map(m => `<option value="${m.key}">${esc(modeLabel(m.key))}</option>`).join('');
  const seriesSel = document.getElementById('proj-series');
  if (seriesSel) seriesSel.value = (S.deviceSettings && S.deviceSettings.targetSeries) === 'custom' ? 'custom' : 'standard';
  updateProjectTimePicker();
  openModal('modal-proj');
}

// Create and select a new project from modal input.
function createProj() {
  const name = document.getElementById('proj-name').value.trim().replace(/\s+/g, ' ');
  if (!name) { toast(tx('toast.enterProjectName', 'Please enter a project name')); return; }
  const nameKey = normalizeProjectName(name);
  if (S.projects.some(p => normalizeProjectName(p.name) === nameKey)) {
    toast(tx('toast.projectNameExists', 'A project with this name already exists'));
    return;
  }
  const times = [...document.querySelectorAll('.t-tog.on')].map(e => +e.dataset.t).filter(v => Number.isFinite(v) && v > 0).sort((a,b)=>a-b);
  if (!times.length) { toast(tx('toast.noTargetTimesSelected', 'Select at least one target time'), 'warning'); return; }
  const mode = normalizeMeasurementMode(document.getElementById('proj-mode').value);
  const seriesEl = document.getElementById('proj-series');
  const targetSeries = seriesEl && seriesEl.value === 'custom' ? 'custom' : 'standard';
  const p = {
    id: makeSafeInternalId('p'),
    name,
    mode,
    targetSeries,
    times,
    customTargetTimes: targetSeries === 'custom' ? times.slice() : [],
    createdAt: Date.now()
  };
  S.projects.push(p);
  S.selectedProjId = p.id;
  saveAppData();
  closeModal('modal-proj');
  renderProjList();
  showProject(p.id);
  toast(tf('toast.projectCreated', 'Project \"{name}\" created', {name}));
}

// Delete the active non-default project and reassign its measurements.
function deleteProj(id) {
  ensureDefaultProject();
  if (id === DEFAULT_PROJECT_ID) {
    toast(tx('toast.defaultProjectKept', 'The default project cannot be deleted'), 'warning');
    return;
  }
  if (!confirm(tx('confirm.deleteProject', 'Delete project?'))) return;
  S.projects = S.projects.filter(p => p.id !== id);
  S.history.forEach(h => { if (h.projId === id) h.projId = DEFAULT_PROJECT_ID; });
  if (S.selectedProjId === id) S.selectedProjId = DEFAULT_PROJECT_ID;
  saveAppData();
  renderProjList();
  renderEmptyStateIfNeeded();
  renderHistList();
  redirectToLatestMeasurement();
}


// Render the project list in the sidebar.
function renderProjList() {
  const el = document.getElementById('proj-list');
  if (!el) return;
  if (!S.projects.length) {
    el.innerHTML = '<div class="empty" style="padding:16px 0;"><div class="empty-sub">' + esc(tx('empty.noProjectYet', 'No project yet')) + '</div></div>';
    return;
  }
  el.innerHTML = S.projects.map(p => {
    const cnt = projectEntries(p.id, false).length;
    const active = p.id === S.selectedProjId ? ' active' : '';
    const meta = (p.id === DEFAULT_PROJECT_ID || p.isDefault)
      ? `${cnt} ${tx('labels.measurements', 'measurements')}`
      : `${modeLabel(p.mode)} · ${p.times.length} ${tx('labels.speeds', 'speeds')} · ${cnt} ${tx('labels.measurements', 'measurements')}`;
    return `<div class="proj-card${active}" onclick="showProject('${p.id}')">
      <div class="proj-card-name">${esc(p.name)}</div>
      <div class="proj-card-meta">${esc(meta)}</div>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════════
   // HISTORY LIST
// ════════════════════════════════════════════
function renderHistList() {
  ensureDefaultProject();
  const el  = document.getElementById('hist-list');
  const cnt = document.getElementById('hist-count');
  const p = activeProject();
  const entries = p ? projectEntries(p.id, true) : [];
  if (cnt) cnt.textContent = entries.length;
  if (!el) return;

  if (!entries.length) {
    const name = p ? p.name : tx('project.defaultName', 'Default project');
    const icon = typeof emptyIconHtml === 'function' ? emptyIconHtml('aperture') : '';
    el.innerHTML = `<div class="empty"><div class="empty-ico">${icon}</div>
      <div class="empty-txt">${esc(tx('empty.noMeasurements', 'No measurements'))}</div>
      <div class="empty-sub">${esc(tf('empty.waitingForProjectMeasurement', 'Waiting for measurements in {project}', {project:name}))}</div></div>`;
    return;
  }

  el.innerHTML = entries.map(e => {
    const ts  = new Date(e.ts).toLocaleTimeString(uiLocale());

    if (e.isError) {
      return `<div class="h-entry err" id="he-${e.id}">
        <div class="h-time" style="color:var(--red);">ERROR</div>
        <div class="h-dev pos">!</div>
        <div class="h-meta"><span class="h-meta-line">${ts}</span><span class="h-meta-line">${esc(e.error || 'Unknown error')}</span></div>
        <div class="h-mode h-mode-empty">—</div>
      </div>`;
    }

    const dev = e.avgDev;
    const dc  = devClass(dev);
    const ds  = (dev>=0?'+':'') + dev.toFixed(2);
    const sel = e.id === S.selId ? 'sel' : '';

    return `<div class="h-entry ${sel}" id="he-${e.id}" onclick="selectEntry('${e.id}')">
      <div class="h-time">1/${e.avgFrac}</div>
      <div class="h-dev ${dc}"><span>${ds}</span><span class="h-dev-unit">EV</span></div>
      <div class="h-meta"><span class="h-meta-line">${ts}</span><span class="h-meta-line">${tx('labels.target', 'Target')} 1/${e.targetFrac} · ${e.count} Sens.${e.warning ? ' · ' + tx('labels.warning', 'Warning') : ''}</span></div>
      ${historyModeHtml(e)}
    </div>`;
  }).join('');
}

// ════════════════════════════════════════════
   // ENTRY SELECTION → DETAIL VIEW
// ════════════════════════════════════════════
function selectEntry(id, scroll = true) {
  const e = S.history.find(h => h.id === id);
  if (!e || e.isError) return;
  S.selId = id;
  renderHistList();
  renderDetailView(id);
  if (scroll && window.innerWidth <= 767) toggleSidebar();
}

// ════════════════════════════════════════════
   // DETAIL VIEW
// ════════════════════════════════════════════
function renderDetailView(id) {
  const e = S.history.find(h => h.id === id);
  if (!e) return;

  const ts  = new Date(e.ts).toLocaleString(uiLocale());
  const ds  = (e.avgDev>=0?'+':'') + e.avgDev.toFixed(3);
  const devC = devColor(e.avgDev);
  const isCentral = (normalizeMeasurementMode(e.mode) === 'central');

  // Sensor boxes
  const sboxes = e.sensors.map((s,i) => {
    if (!s.activated) return `<div class="s-box off" data-s="${i}">
      <div class="s-name">ID ${i}</div>
      <div style="font-size:11px;color:var(--tx4);">${tx('labels.inactive', 'inactive')}</div></div>`;
    const sdc = devColor(s.deviation);
    const sds = (s.deviation>=0?'+':'') + s.deviation.toFixed(3);
    return `<div class="s-box" data-s="${i}">
      <div class="s-name">ID ${i}</div>
      <div class="s-frac">1/${s.fraction}</div>
      <div class="s-dev" style="color:${sdc}">${sds} EV</div>
      <div class="s-ms">${(s.seconds*1000).toFixed(3)} ms</div>
    </div>`;
  }).join('');

  // Single measurements remain a raw diagnostic view.
  // Curtain condition summaries are intentionally only shown in the project view,
  // where repeated measurements make the rating meaningful.

  // Persist note
  const noteKey = 'note_' + id;

  setSettingsNavActive(false);
  setContentEmptyView(false);
  setContentFlush(false);
  const moveToDefaultAction = e.projId === DEFAULT_PROJECT_ID ? '' : `<button class="btn btn-ghost btn-sm" onclick="moveMeasurementToDefault('${id}')">${esc(tx('measurement.moveToDefault', 'Move to default project'))}</button>`;
  document.getElementById('content').innerHTML = `

    <!-- Summary -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">${tx('cards.measurement', 'Measurement')} — ${ts} — ${measurementModeSummary(e)}</span>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
          ${moveToDefaultAction}
          <span style="font-size:10px;color:var(--tx4)">${e.id}</span>
        </div>
      </div>
      <div class="card-body">
        ${measurementHintNoticeHtml(e)}
        <div class="metrics-row">
          <div class="metric">
            <div class="m-label">${tx('metrics.avgExposure', 'Avg exposure time')}</div>
            <div class="m-val">1/${e.avgFrac}</div>
            <div class="m-sub">${(e.avgSec*1000).toFixed(3)} ms</div>
          </div>
          <div class="metric">
            <div class="m-label">${tx('metrics.avgDeviation', 'Avg deviation')}</div>
            <div class="m-val" style="color:${devC};font-size:20px;">${ds} EV</div>
            <div class="m-sub">${tx('labels.target', 'Target')}: 1/${e.targetFrac} s</div>
          </div>
          ${isCentral ? '' : `<div class="metric">
            <div class="m-label">Spread min↔max</div>
            <div class="m-val" style="font-size:18px;">${e.spread.toFixed(3)} EV</div>
            <div class="m-sub">${e.count} ${tx('labels.sensorsActive', 'sensors active')}</div>
          </div>`}
          <div class="metric">
            <div class="m-label">${tx('metrics.totalOpenTime', 'Total open time')}</div>
            <div class="m-val" style="font-size:18px;">${calcTotalOpenTime(e).toFixed(3)} ms</div>
            <div class="m-sub">&nbsp;</div>
          </div>
          <div class="metric">
            <div class="m-label">${tx('metrics.flashSync', 'Flash sync')}</div>
            <div class="m-val" style="font-size:18px;">${flashSyncIcon(e)}</div>
            <div class="m-sub">${e.flash && e.flash.detected ? e.flash.triggerMs.toFixed(3) + ' ms' : tx('labels.noFlashDetected', 'no flash detected')}</div>
          </div>
        </div>
        <div class="sensor-row">${sboxes}</div>
      </div>
    </div>

    <!-- Timeline -->
    <div class="card timeline-card">
      <div class="card-hdr"><span class="card-title">${tx('cards.timelineOpening', 'Timeline — shutter opening')}</span></div>
      <div class="card-body" style="padding:10px 6px;">
        <div class="tl-wrap"><canvas id="tl"></canvas></div>
      </div>
    </div>

    ${isCentral ? '' : `<div class="card timeline-card">
      <div class="card-hdr"><span class="card-title">${tx('cards.timelineSpeed', 'Curtain speed by sensor position')}</span><span style="font-size:10px;color:var(--tx3)">m/s · mm</span></div>
      <div class="card-body" style="padding:10px 6px;">
        <div class="tl-wrap"><canvas id="curtain-time-chart"></canvas></div>
      </div>
    </div>`}

    <!-- Grade field -->
    <div class="card">
      <div class="card-hdr"><span class="card-title">${tx('cards.note', 'Note')}</span></div>
      <div class="card-body" style="padding:8px 10px;">
        <textarea class="note-field" id="note-field"
          placeholder="${esc(tx('placeholders.measurementNotes', 'Notes for this measurement…'))}"
          oninput="autoResize(this);saveNote('${id}',this.value)"
        >${esc(e.note||'')}</textarea>
      </div>
    </div>

  `;

  requestAnimationFrame(() => { drawTimeline(e); drawCurtainTimeChart(e); initNoteFields(); });
}
