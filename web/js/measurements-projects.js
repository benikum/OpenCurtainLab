// Device status handling, measurement ingestion, project lists, and detail rendering.

// Apply device status data and update related UI indicators.
function applyDeviceStatus(status) {
  if (!status) return;

  // Firmware v10 exposes structured status data while keeping older top-level fields for compatibility.
  if (status.deviceStatus) {
    S.deviceStatus = Object.assign({ error: 'none', errorText: '', subsystem: 'none' }, status.deviceStatus);
  } else {
    S.deviceStatus = {
      error: status.deviceError || 'none',
      errorText: status.deviceErrorText || '',
      subsystem: 'none'
    };
  }

  const network = status.network || {};
  S.networkStatus = Object.assign({
    connected: !!status.wifi,
    apMode: !!status.apMode,
    ip: status.ip || '',
    apIp: status.apIp || '',
    hostname: status.hostname || '',
    mdns: status.mdns || '',
    mdnsStarted: false,
    hint: 'none',
    hintText: ''
  }, network);

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

  // Device and network diagnostics are shown as popups, not in the connection pill.
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
}

// Return a localized label for a connection state.
function connectionLabelForState(state) {
  if (state === 'connected') return tx('connection.connected', 'CONNECTED');
  return tx('connection.connecting', 'CONNECTING...');
}

// Check the local WebUI version file in development mode.
async function checkAppVersion() {
  try {
    const r = await fetch(VERSION_URL + '?t=' + Date.now(), { cache:'no-store' });
    if (!r.ok) return;
    S.cdnVersion = cleanVersion(await r.text());
    updateVersionWarnings(true);
    renderDeviceConfigSummary();
  } catch(e) {
    // Offline use is supported; absence of version.txt only disables CDN version checks.
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
  const previouslyActive = activeProject();
  const entry = buildEntryFromPacket(d);
  if (entry && entry.hint && entry.hint !== 'none' && entry.hintText) notifyMeasurementHint(entry);
  if (!entry) return;

  const movedToDefault = previouslyActive &&
    !isDefaultProject(previouslyActive) &&
    entry.projId === DEFAULT_PROJECT_ID &&
    !projectSupportsMeasurement(previouslyActive, entry.targetFrac, entry.mode);

  if (movedToDefault) {
    S.selectedProjId = DEFAULT_PROJECT_ID;
    toast(tx('toast.measurementAssignedToDefaultIncompatible', 'Measurement assigned to the default project because it does not match the selected project.'), 'warning');
  }

  S.history.unshift(entry);
  if (S.history.length > 300) S.history.pop();
  saveAppData();
  renderProjList();
  renderHistList();
  selectEntry(entry.id, false);
  redirectToLatestMeasurement();
  requestAnimationFrame(() => {
    const el = document.getElementById('he-' + entry.id);
    if (el) el.classList.add('new-flash');
  });
}

// Convert raw firmware measurement data into a WebUI history entry.
function buildEntryFromPacket(d) {
  if (!d || !d.id) return null;
  if (!d.valid) {
    const h = normalizeHint(d);
    return {
      id: d.id,
      ts: Date.now(),
      valid: false,
      isError: true,
      error: h.hintText || d.error || d.reason || tx('errors.unknown', 'Unknown error'),
      hint: h.hint,
      hintText: h.hintText,
      warning: h.hintText || d.warning || '',
      targetFrac: d.target || null,
      avgFrac: 0,
      avgSec: 0,
      avgDev: 0,
      spread: 0,
      count: 0,
      sensors: [],
      flash: d.flash || null,
      projId: activeProjectIdForMeasurement(d.target || null, d.mode || 'left'),
      raw: d,
    };
  }

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
        baseline: s.baseline,
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
        enabled: !!d.flash.enabled,
        detected,
        pin: d.flash.pin,
        raw: d.flash.raw,
        baseline: d.flash.baseline,
        triggerUs,
        triggerMs: detected && baseUs ? (triggerUs - baseUs) / 1000 : null,
      };
    }

    const h = normalizeHint(d);
    const entry = {
      id: d.id,
      valid: true,
      ts: Date.now(),
      targetFrac: target,
      mode: d.mode || 'left',
      avgFrac: avgSec > 0 ? Math.round(1 / avgSec) : 0,
      avgSec,
      avgDev: avgSec > 0 && targetSec > 0 ? Math.log2(avgSec / targetSec) : 0,
      spread: durs.length > 1 && minSec > 0 ? Math.log2(maxSec / minSec) : 0,
      count: act.length,
      sensors,
      flash,
      hint: h.hint,
      hintText: h.hintText,
      warning: h.hasHint ? h.hintText : '',
      projId: activeProjectIdForMeasurement(target, d.mode || 'left'),
      raw: d,
    };
    entry.flashSyncOk = isFlashSyncOk(entry);
    return entry;
  }

  // Legacy packet fallback for old exports or pre-raw-data firmware builds.
  const entry = {
    id:          d.id,
    valid:       true,
    ts:          Date.now(),
    targetFrac:  d.target,
    avgFrac:     d.avgFraction,
    avgSec:      d.avgSeconds,
    avgDev:      d.avgDeviationStops,
    spread:      d.spreadStops,
    count:       d.activatedCount,
    sensors:     d.sensors,
    flash:       d.flash || null,
    hint:        d.hint || 'none',
    hintText:    d.hintText || '',
    warning:     d.hintText || d.warning || d.error || '',
    mode:        d.mode || 'left',
    projId:      activeProjectIdForMeasurement(d.target, d.mode || 'left'),
    raw:         d,
  };
  entry.flashSyncOk = isFlashSyncOk(entry);
  return entry;
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

// Create a stable project id for an automatic target-speed project.
function autoProjectIdForTarget(targetFrac, mode) {
  return activeProjectIdForMeasurement(targetFrac, mode);
}

// Return a localized label for a measurement mode.
function modeLabel(mode) {
  const m = MODES.find(x => x.key === mode);
  return m ? tx(m.labelKey, m.fallback) : tx('modes.left', 'left');
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
  if (p && (p.targetSeries === 'custom' || p.targetSeries === 'standard')) return p.targetSeries;
  return 'standard';
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
  const mode = document.getElementById('proj-mode').value || 'left';
  const seriesEl = document.getElementById('proj-series');
  const targetSeries = seriesEl && seriesEl.value === 'custom' ? 'custom' : 'standard';
  const p = {
    id:'p_'+Date.now(),
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
  if (!S.projects.length) {
    el.innerHTML = '<div class="empty" style="padding:16px 0;"><div class="empty-sub">' + esc(tx('empty.noProjectYet', 'No project yet')) + '</div></div>';
    return;
  }
  el.innerHTML = S.projects.map(p => {
    const cnt = projectEntries(p.id, false).length;
    const active = p.id === S.selectedProjId ? ' active' : '';
    const meta = (p.id === DEFAULT_PROJECT_ID || p.isDefault)
      ? `${cnt} ${tx('labels.measurements', 'measurements')}`
      : `${modeLabel(p.mode)} · ${targetSeriesLabel(projectTargetSeries(p))} · ${p.times.length} ${tx('labels.speeds', 'speeds')} · ${cnt} ${tx('labels.measurements', 'measurements')}`;
    return `<div class="proj-card${active}" onclick="showProject('${p.id}')">
      <div class="proj-card-name">${esc(p.name)}</div>
      <div class="proj-card-meta">${meta}</div>
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
        <div class="h-meta">${ts} · ${esc(e.error || 'Unknown error')}</div>
      </div>`;
    }

    const dev = e.avgDev;
    const dc  = devClass(dev);
    const ds  = (dev>=0?'+':'') + dev.toFixed(2);
    const sel = e.id === S.selId ? 'sel' : '';

    return `<div class="h-entry ${sel}" id="he-${e.id}" onclick="selectEntry('${e.id}')">
      <div class="h-time">1/${e.avgFrac}</div>
      <div class="h-dev ${dc}">${ds}<br><span style="font-size:9px;opacity:0.6">EV</span></div>
      <div class="h-meta">${ts} · ${modeLabel(e.mode)} · ${tx('labels.target', 'Target')} 1/${e.targetFrac} · ${e.count} Sens.${e.warning ? ' · ' + tx('labels.warning', 'Warning') : ''}</div>
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
  const isCentral = (e.mode === 'central');

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

  setContentEmptyView(false);
  setContentFlush(false);
  const moveToDefaultAction = e.projId === DEFAULT_PROJECT_ID ? '' : `<button class="btn btn-ghost btn-sm" onclick="moveMeasurementToDefault('${id}')">${esc(tx('measurement.moveToDefault', 'Move to default project'))}</button>`;
  document.getElementById('content').innerHTML = `

    <!-- Summary -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">${tx('cards.measurement', 'Measurement')} — ${ts} — ${modeLabel(e.mode)}</span>
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
