// Project statistics, condition scoring, and project summary tables.

// ════════════════════════════════════════════
   // PROJECT ANALYSIS HELPERS
   // Project-level scores are intentionally based on repeated measurements.
   // A single measurement remains a diagnostic detail view, not a camera rating.
// ════════════════════════════════════════════
function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
// Return the arithmetic mean of a numeric list.
function average(values) {
  const arr = values.filter(v => Number.isFinite(v));
  return arr.length ? arr.reduce((sum, v) => sum + v, 0) / arr.length : null;
}
// Return the standard deviation of a numeric list.
function stddev(values) {
  const arr = values.filter(v => Number.isFinite(v));
  if (arr.length < 2) return 0;
  const m = average(arr);
  const variance = arr.reduce((sum, v) => sum + Math.pow(v - m, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}
// Return a weighted average for values with weights.
function weightedAverage(items, valueKey, weightKey = 'n') {
  const valid = items.filter(x => Number.isFinite(x[valueKey]) && Number.isFinite(x[weightKey]) && x[weightKey] > 0);
  const w = valid.reduce((sum, x) => sum + x[weightKey], 0);
  return w ? valid.reduce((sum, x) => sum + x[valueKey] * x[weightKey], 0) / w : null;
}
// Convert a numeric score into a coarse condition grade.
function gradeFromScore(score) {
  if (!Number.isFinite(score)) return { grade:'—', cls:'' };
  if (score >= 90) return { grade:'A', cls:'grade-a' };
  if (score >= 78) return { grade:'B', cls:'grade-b' };
  if (score >= 62) return { grade:'C', cls:'grade-c' };
  return { grade:'D', cls:'grade-d' };
}
// Return a localized label for a condition grade.
function conditionLabel(score) {
  if (!Number.isFinite(score)) return tx('condition.notRated', 'Not rated');
  if (score >= 90) return tx('condition.veryGood', 'Very good');
  if (score >= 78) return tx('condition.good', 'Good');
  if (score >= 62) return tx('condition.checkService', 'Check service');
  return tx('condition.serviceRecommended', 'Service recommended');
}
// Score a measurement against a target time.
function scoreForTarget(avgAbsDev, sigmaEv, n) {
  // Accuracy and ${tx('project.repeatability', 'repeatability')} are both measured in stops (EV).
  // The n penalty keeps ratings conservative for very small measurement series.
  const nPenalty = n >= 5 ? 0 : (5 - n) * 3;
  return clampNumber(100 - avgAbsDev * 130 - sigmaEv * 220 - nPenalty, 0, 100);
}
// Build a small inline normal-distribution SVG for project analysis.
function normalDistributionMini(values) {
  const arr = values.filter(v => Number.isFinite(v));
  if (arr.length < 2) return '<span style="color:var(--tx4);font-size:10px;">—</span>';
  const m = average(arr);
  const sd = stddev(arr) || 0.0001;
  const bins = [0,0,0,0,0,0,0];
  arr.forEach(v => {
    const z = clampNumber(Math.floor(((v - m) / (sd * 2) + 0.5) * bins.length), 0, bins.length - 1);
    bins[z]++;
  });
  const max = Math.max(...bins, 1);
  return `<div class="dist-mini" title="${esc(tx('project.distributionTitle', 'Distribution of repeated measurements'))}">${bins.map(c => `<i style="height:${Math.max(3, Math.round(c / max * 22))}px"></i>`).join('')}</div>`;
}
// Return measurements for a project by id.
function getProjectEntries(projId) {
  return projectEntries(projId, false);
}
// Extract slit-shutter statistics from a measurement entry.
function slitStatsForEntry(entry) {
  const slits = (entry.sensors || [])
    .filter(s => s.activated && Number.isFinite(s.openMs) && Number.isFinite(s.closeMs) && s.closeMs > s.openMs)
    .map(s => s.closeMs - s.openMs);
  if (slits.length < 2) return null;
  const m = average(slits);
  return { meanMs:m, sigmaMs:stddev(slits), cv:m ? stddev(slits) / m : 0 };
}
// Calculate aggregate analysis values for one project.
function projectAnalysis(p) {
  const entries = getProjectEntries(p.id);
  const aggs = p.times.map(t => aggregateForTarget(p.id, t)).filter(Boolean);
  const total = entries.length;
  const measuredTimes = aggs.length;
  const avgAbsDev = weightedAverage(aggs, 'avgAbsDev', 'n');
  const avgSigma = weightedAverage(aggs, 'sigmaEv', 'n');
  const avgSpread = weightedAverage(aggs, 'avgSpread', 'n');

  const accuracyScore = avgAbsDev == null ? null : clampNumber(100 - avgAbsDev * 140, 0, 100);
  const repeatScore = avgSigma == null ? null : clampNumber(100 - avgSigma * 260, 0, 100);

  const profiles = entries.map(e => curtainSpeedProfile(e)).filter(Boolean);
  const openV = profiles.flatMap(c => c.open.map(p => p.v));
  const closeV = profiles.flatMap(c => c.close.map(p => p.v));
  const openAvg = average(openV);
  const closeAvg = average(closeV);
  const openCv = openV.length > 1 && openAvg ? stddev(openV) / openAvg : 0;
  const closeCv = closeV.length > 1 && closeAvg ? stddev(closeV) / closeAvg : 0;
  const linearityScore = profiles.length ? clampNumber(100 - ((openCv + closeCv) / 2) * 220, 0, 100) : null;

  const slitStats = entries.map(slitStatsForEntry).filter(Boolean);
  const slitCv = average(slitStats.map(x => x.cv));
  const parallelScore = slitCv == null ? null : clampNumber(100 - slitCv * 300, 0, 100);

  const scoreParts = [accuracyScore, repeatScore, linearityScore, parallelScore].filter(Number.isFinite);
  const conditionScore = scoreParts.length ? average(scoreParts) : null;
  const syncOk = entries.filter(e => isFlashSyncOk(e) === true).length;
  const syncBad = entries.filter(e => isFlashSyncOk(e) === false).length;
  const syncDetected = entries.filter(e => e.flash && e.flash.detected).length;

  return {
    total, measuredTimes, avgAbsDev, avgSigma, avgSpread,
    accuracyScore, repeatScore, linearityScore, parallelScore, conditionScore,
    openV: openAvg, closeV: closeAvg,
    openSpeedVariation: openCv ? openCv * 100 : null,
    closeSpeedVariation: closeCv ? closeCv * 100 : null,
    syncOk, syncBad, syncDetected,
  };
}
// Build an HTML badge for a project grade.
function gradeBadge(score) {
  const g = gradeFromScore(score);
  return `<span class="grade-badge ${g.cls}">${g.grade}</span>`;
}
// Build the project overview summary cards.
function buildProjectSummary(p) {
  const a = projectAnalysis(p);
  const cond = gradeFromScore(a.conditionScore);
  const fmtEv = v => v == null ? '—' : v.toFixed(3) + ' EV';
  const fmtPct = v => v == null ? '—' : Math.round(v) + ' %';
  return `<div class="card">
    <div class="card-hdr">
      <span class="card-title">${tx('project.overallRating', 'Camera — overall rating')}</span>
      <span class="grade-badge ${cond.cls}">${cond.grade}</span>
    </div>
    <div class="card-body">
      <div class="quality-grid">
        <div class="q-card q-amber"><div class="q-label">${tx('project.condition', 'Condition')}</div><div class="q-value">${conditionLabel(a.conditionScore)}</div><div class="q-sub">Score ${fmtPct(a.conditionScore)}</div></div>
        <div class="q-card q-blue"><div class="q-label">${tx('project.measurements', 'Measurements')}</div><div class="q-value">${a.total}</div><div class="q-sub">${a.measuredTimes}/${p.times.length} ${tx('project.targetSpeedsMeasured', 'target speeds measured')}</div></div>
        <div class="q-card q-orange"><div class="q-label">${tx('project.avgDeviation', 'Avg deviation')}</div><div class="q-value">${fmtEv(a.avgAbsDev)}</div><div class="q-sub">${tx('project.absoluteAcrossRuns', 'absolute, across all runs')}</div></div>
        <div class="q-card q-teal"><div class="q-label">${tx('project.avgScatter', 'Avg scatter σ')}</div><div class="q-value">${fmtEv(a.avgSigma)}</div><div class="q-sub">${tx('project.repeatability', 'repeatability')}</div></div>
        <div class="q-card q-green"><div class="q-label">${tx('project.linearity', 'Linearity')}</div><div class="q-value">${fmtPct(a.linearityScore)}</div><div class="q-sub">${tx('project.fromLocalCurtainSpeeds', 'from local speed variation')}</div></div>
        <div class="q-card q-green"><div class="q-label">${tx('project.parallelism', 'Parallelism')}</div><div class="q-value">${fmtPct(a.parallelScore)}</div><div class="q-sub">${tx('project.fromSlitWidth', 'from slit width at each sensor')}</div></div>
      </div>
    </div>
  </div>`;
}
// Build the curtain-speed summary cards.
function buildCurtainSummary(p) {
  if (normalizeMeasurementMode(p.mode) === 'central') return '';
  const a = projectAnalysis(p);
  const fmt = (v, d=2) => v == null ? '—' : v.toFixed(d);
  const pct = v => v == null ? '—' : v.toFixed(1) + ' %';
  return `<div class="card">
    <div class="card-hdr"><span class="card-title">${tx('project.curtainsSummary', 'Curtains — speed summary')}</span></div>
    <div class="card-body">
      <div class="dual-summary">
        <div class="q-card q-blue">
          <div class="q-label">${tx('project.openingCurtain', 'Opening curtain')}</div>
          <div class="q-value">${fmt(a.openV)} m/s</div>
          <div class="q-sub">${tx('project.localSpeedVariation', 'local speed variation')} ${pct(a.openSpeedVariation)}</div>
        </div>
        <div class="q-card q-teal">
          <div class="q-label">${tx('project.closingCurtain', 'Closing curtain')}</div>
          <div class="q-value">${fmt(a.closeV)} m/s</div>
          <div class="q-sub">${tx('project.localSpeedVariation', 'local speed variation')} ${pct(a.closeSpeedVariation)}</div>
        </div>
      </div>
    </div>
  </div>`;
}

// ════════════════════════════════════════════
   // PROJECT TABLE — rows=targetTimes, cols=metrics, cells=averages
// ════════════════════════════════════════════

// Aggregate all measurements for a given project + target fraction
function aggregateForTarget(projId, targetFrac) {
  const entries = projectEntries(projId, false).filter(h => h.targetFrac === targetFrac);
  if (!entries.length) return null;

  const n = entries.length;
  const avgSec   = entries.reduce((sum, entry) => sum + entry.avgSec, 0) / n;
  const avgSpread= entries.reduce((sum, entry) => sum + entry.spread, 0) / n;
  const avgFrac  = Math.round(1 / avgSec);
  const avgDev   = Math.log2(avgSec * targetFrac);
  const devValues = entries.map(entry => Number.isFinite(entry.avgDev) ? entry.avgDev : Math.log2(entry.avgSec * targetFrac));
  const avgAbsDev = average(devValues.map(Math.abs)) || 0;
  const sigmaEv = stddev(devValues);
  const score = scoreForTarget(Math.abs(avgDev), sigmaEv, n);

  const curtains = entries.map(entry => calcCurtain(entry)).filter(Boolean);
  const avgV1 = curtains.length ? curtains.reduce((sum, c) => sum + c.v1, 0) / curtains.length : null;
  const avgV2 = curtains.length ? curtains.reduce((sum, c) => sum + c.v2, 0) / curtains.length : null;

  const flashDetected = entries.filter(entry => entry.flash && entry.flash.detected).length;
  const flashOk = entries.filter(entry => isFlashSyncOk(entry) === true).length;
  const flashBad = entries.filter(entry => isFlashSyncOk(entry) === false).length;

  return { n, entries, avgFrac, avgSec, avgDev, avgAbsDev, sigmaEv, score, avgSpread, avgV1, avgV2, flashDetected, flashOk, flashBad };
}

// Build the per-target project analysis table.
function buildProjectTable(p) {
  const fmt = (v, dec) => v != null ? v.toFixed(dec) : '—';

  const rows = p.times.map(tgt => {
    const agg = aggregateForTarget(p.id, tgt);
    if (!agg) {
      return `<tr>
        <td class="t-target">1/${tgt}</td>
        <td class="t-dim">—</td>
        <td class="t-dim">—</td>
        <td class="t-dim">—</td>
        <td class="t-dim">—</td>
        <td class="t-dim">—</td>
        <td class="t-dim">—</td>
        <td class="t-dim" style="font-size:10px;">${tx('project.zeroMeas', '0 meas.')}</td>
      </tr>`;
    }
    const devStr = (agg.avgDev>=0?'+':'') + agg.avgDev.toFixed(3) + ' EV';
    const devC = devColor(agg.avgDev);

    return `<tr>
      <td class="t-target">1/${tgt}</td>
      <td class="t-amber">1/${agg.avgFrac} <span style="font-size:10px;color:${devC}">(${devStr})</span></td>
      <td><span style="color:var(--tx1)">${agg.sigmaEv.toFixed(3)} EV</span><br><span style="font-size:10px;color:var(--tx3)">σ ${tx('project.repeatability', 'repeatability')}</span></td>
      <td>${normalDistributionMini(agg.entries.map(e => e.avgDev))}</td>
      <td>${gradeBadge(agg.score)}</td>
      <td class="t-teal">${agg.avgV1!=null ? fmt(agg.avgV1,2) : '—'} / ${agg.avgV2!=null ? fmt(agg.avgV2,2) : '—'}</td>
      <td>${agg.flashDetected ? (agg.flashBad ? '<span style="color:var(--red);font-size:16px;">×</span>' : '<span style="color:var(--green);font-size:16px;">●</span>') : '<span style="color:var(--tx4);font-size:16px;">—</span>'}</td>
      <td style="font-size:10px;color:var(--tx3)">${agg.n} ${tx('project.measShort', 'meas.')}</td>
    </tr>`;
  }).join('');

  return `<div class="tbl-wrap">
    <table>
      <thead>
        <tr>
          <th>${tx('table.target', 'Target')}</th>
          <th>${tx('table.avgMeasurement', 'Avg measurement')}</th>
          <th>σ</th>
          <th>${tx('table.distribution', 'Distribution')}</th>
          <th>${tx('table.grade', 'Grade')}</th>
          <th>${tx('table.curtainSpeed', 'Curtain speed')} V₁/V₂ (m/s)</th>
          <th>${tx('table.flash', 'Flash')}</th>
          <th>n</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// Project full-page view
function showProject(projId) {
  const p = S.projects.find(x => x.id === projId);
  if (!p) return;
  S.selectedProjId = projId;
  saveAppData();
  renderProjList();
  renderHistList();

  if (p.id === DEFAULT_PROJECT_ID || p.isDefault) {
    if (S.selId && !currentProjectEntries(true).some(e => e.id === S.selId)) S.selId = null;
    renderHistList();
    renderEmptyStateIfNeeded();
    return;
  }

  setContentEmptyView(false);
  setContentFlush(false);
  document.getElementById('content').innerHTML = `
    ${buildProjectSummary(p)}
    ${buildCurtainSummary(p)}

    <!-- Project table -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">${esc(p.name)} — ${modeLabel(p.mode)}</span>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          ${projectTargetSeries(p) === 'custom' ? `<button class="btn btn-amber btn-sm" onclick="loadProjectCustomTimes('${projId}')">${esc(tx('project.loadCustomTimes', 'Load custom times'))}</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="exportProjCSV('${projId}')">CSV EXPORT</button>
        </div>
      </div>
      <div class="card-body" style="padding:0;">
        ${buildProjectTable(p)}
      </div>
    </div>

    ${normalizeMeasurementMode(p.mode) === 'central' ? '' : `<!-- Curtain chart -->
    <div class="card">
      <div class="card-hdr">
        <span class="card-title">${tx('cards.curtainCurve', 'Curtain speed by target')}</span>
        <span style="font-size:10px;color:var(--tx3)">m/s</span>
      </div>
      <div class="card-body" style="padding:10px 6px;">
        <canvas id="curtain-chart" data-proj-id="${projId}"></canvas>
      </div>
    </div>`}

    <!-- Project note -->
    <div class="card">
      <div class="card-hdr"><span class="card-title">${tx('cards.note', 'Note')}</span></div>
      <div class="card-body" style="padding:8px 10px;">
        <textarea class="note-field" id="proj-note"
          placeholder="${esc(tx('placeholders.projectNotes', 'Notes for this project…'))}"
          oninput="autoResize(this);saveProjNote('${projId}',this.value)"
        >${esc(p.note||'')}</textarea>
      </div>
    </div>

    ${p.id === DEFAULT_PROJECT_ID ? '' : `<!-- Delete project -->
    <div class="card" style="border-color:#3a1a1a;">
      <div class="card-hdr" style="background:#1a1010;">
        <span class="card-title" style="color:var(--red)">${tx('project.deleteProject', 'Delete project')}</span>
      </div>
      <div class="card-body" style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
        <span style="font-size:12px;color:var(--tx3);">${tx('project.deleteProjectHelp', 'Deletes the project. Its measurements move to the default project.')}</span>
        <button class="btn btn-sm" style="background:#1a1010;border-color:var(--red);color:var(--red);flex-shrink:0;"
          onclick="deleteProj('${projId}')">${tx('project.delete', 'DELETE')}</button>
      </div>
    </div>`}
  `;
  requestAnimationFrame(() => { drawCurtainChart(p); initNoteFields(); });
}

// ════════════════════════════════════════════
   // CURTAIN CHART — project-level average speed by target time
   // X = supported target times (1/x), Y = local curtain speed in m/s
// ════════════════════════════════════════════
function drawCurtainChart(p) {
  const canvas = document.getElementById('curtain-chart');
  if (!canvas) return;

  const points = p.times.map(tgt => {
    const agg = aggregateForTarget(p.id, tgt);
    if (!agg || agg.avgV1 == null) return null;
    return { tgt, v1: agg.avgV1, v2: agg.avgV2 };
  }).filter(Boolean);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.parentElement.clientWidth || 600;
  const isMob = window.innerWidth <= 600;
  const H = isMob ? 226 : 252;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const C = { bg:'#131613', grid:'#222622', axis:'#3d443d', tx3:'#7a8a7a', tx1:'#f0f4f0' };
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  const PAD_L = 64;
  const PAD_R = 24;
  const PAD_T = 18;
  const PAD_B = 72;
  const PW = W - PAD_L - PAD_R;
  const PH = H - PAD_T - PAD_B;

  if (!points.length) {
    ctx.fillStyle = C.tx3;
    ctx.font = `11px 'Share Tech Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(tx('charts.noCurtainMeasurements', 'No measurements with curtain speed data yet'), W / 2, H / 2);
    return;
  }

  const allTimes = [...p.times].sort((a, b) => a - b);
  const xOf = tgt => {
    const idx = allTimes.indexOf(tgt);
    return PAD_L + (idx / Math.max(allTimes.length - 1, 1)) * PW;
  };

  const vVals = points.flatMap(pt => [pt.v1, pt.v2]).filter(v => v > 0);
  const vMax = vVals.length ? Math.max(...vVals) * 1.2 : 1;
  const yV = v => PAD_T + PH * (1 - v / vMax);

  const nGrid = 4;
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  for (let i = 0; i <= nGrid; i++) {
    const y = PAD_T + (i / nGrid) * PH;
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
  }
  allTimes.forEach(t => {
    const x = xOf(t);
    ctx.beginPath(); ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T + PH); ctx.stroke();
  });

  ctx.strokeStyle = C.axis;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(PAD_L, PAD_T); ctx.lineTo(PAD_L, PAD_T + PH); ctx.lineTo(W - PAD_R, PAD_T + PH); ctx.stroke();

  ctx.fillStyle = C.tx3;
  ctx.font = `9px 'Share Tech Mono', monospace`;
  ctx.textAlign = 'right';
  for (let i = 0; i <= nGrid; i++) {
    const v = vMax * (1 - i / nGrid);
    const y = PAD_T + (i / nGrid) * PH;
    ctx.fillText(v.toFixed(vMax < 10 ? 1 : 0), PAD_L - 4, y + 3);
  }
  ctx.save();
  ctx.translate(14, PAD_T + PH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#52c4b0';
  ctx.fillText('m/s', 0, 0);
  ctx.restore();

  ctx.fillStyle = C.tx3;
  ctx.textAlign = 'center';
  allTimes.forEach(t => {
    const x = xOf(t);
    const hasData = points.find(pt => pt.tgt === t);
    ctx.fillStyle = hasData ? C.tx3 : C.grid;
    ctx.fillText('1/' + t, x, PAD_T + PH + 14);
  });
  ctx.fillStyle = C.tx3;
  ctx.fillText(tx('charts.targetSpeedAxis', 'Target speed (1/x s)'), PAD_L + PW / 2, PAD_T + PH + 29);

  function drawLine(pts, color, label) {
    if (!pts.length) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    pts.forEach((pt, i) => {
      const x = xOf(pt.tgt);
      const y = yV(pt.val);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    pts.forEach(pt => {
      ctx.beginPath();
      ctx.arc(xOf(pt.tgt), yV(pt.val), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = C.bg;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
    ctx.restore();
  }

  drawLine(points.map(pt => ({ tgt: pt.tgt, val: pt.v1 })), '#52c4b0');
  drawLine(points.map(pt => ({ tgt: pt.tgt, val: pt.v2 })), '#68a8e0');

  ctx.font = `9px 'Share Tech Mono', monospace`;
  function legendItem(x, y, color, label) {
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y - 3); ctx.lineTo(x + 18, y - 3); ctx.stroke();
    ctx.fillStyle = color; ctx.textAlign = 'left';
    ctx.fillText(label, x + 22, y);
  }
  const ly = PAD_T + PH + 52;
  legendItem(PAD_L + 8, ly, '#52c4b0', tx('charts.openingSpeed', 'Opening speed'));
  legendItem(Math.max(PAD_L + PW * 0.50, W - PAD_R - 190), ly, '#68a8e0', tx('charts.closingSpeed', 'Closing speed'));
}


// Render the initial quick-start content.
function renderQuickStartHtml() {
  const steps = tx('quickStart.steps', [
    'Connect to the device.',
    'Create or select a project.',
    'Set the target time on the device or in the Web UI.',
    'Fire the camera shutter.',
    'Review the measurement.'
  ]);
  const arr = Array.isArray(steps) ? steps : [];
  return `<div class="quick-start">
    <div class="quick-title">${esc(tx('quickStart.title', 'Quick start'))}</div>
    <ol>${arr.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
    <div class="quick-help">${esc(tx('quickStart.help', 'Measurements are received automatically after each shutter test.'))}</div>
  </div>`;
}

// Render a stable inline SVG for empty-state icons. Unicode circle glyphs render
// inconsistently across browsers/fonts and can appear as a plain "O".
function emptyIconHtml(kind) {
  return `<svg class="empty-icon-svg" aria-hidden="true" focusable="false" viewBox="0 -960 960 960" xmlns="http://www.w3.org/2000/svg"><path d="M480-360q-50 0-85-35t-35-85q0-50 35-85t85-35q50 0 85 35t35 85q0 50-35 85t-85 35ZM324-111.5Q251-143 197-197t-85.5-127Q80-397 80-480t31.5-156Q143-709 197-763t127-85.5Q397-880 480-880t156 31.5Q709-817 763-763t85.5 127Q880-563 880-480t-31.5 156Q817-251 763-197t-127 85.5Q563-80 480-80t-156-31.5ZM480-160q133 0 226.5-93.5T800-480q0-133-93.5-226.5T480-800q-133 0-226.5 93.5T160-480q0 133 93.5 226.5T480-160Zm0-320Zm141.5 141.5Q680-397 680-480t-58.5-141.5Q563-680 480-680t-141.5 58.5Q280-563 280-480t58.5 141.5Q397-280 480-280t141.5-58.5Z"></path></svg>`;
}

// Render an appropriate empty state for the current project.
function renderEmptyStateIfNeeded() {
  const content = document.getElementById('content');
  if (!content) return;

  const hasRealContent = content.querySelector('.card, canvas, table, .manual-page, .help-page, .settings-page');
  if (S.selId || hasRealContent) return;

  let title, sub, iconKind = 'aperture', action = '', stateKey = 'idle';
  const dev = S.deviceStatus || {};
  const notices = [deviceNoticeHtml(), firmwareNoticeHtml()].filter(Boolean).join('');
  let extra = notices;

  if (dev.error && dev.error !== 'none') {
    iconKind = 'error';
    stateKey = 'device-error:' + String(dev.error || '');
    const h = deviceErrorHelp(dev.error, dev.errorText || dev.error);
    title = esc(h.title || tx('empty.deviceError', 'Device error'));
    sub = esc(h.body || dev.errorText || dev.error);
  } else if (!S.connected) {
    stateKey = 'connect';
    title = esc(tx('empty.connectDevice', 'Connect the device'));
    sub = esc(tx('empty.connectDeviceSub', 'Enter the device address in Settings or use opencurtainlab.local.'));
    extra += connectionHelpHtml();
  } else if (!currentProjectEntries(true).length) {
    stateKey = 'no-measurements';
    title = esc(tx('empty.noMeasurementsYet', 'No measurements yet'));
    sub = esc(tx('empty.noMeasurementsYetSub', 'Trigger the camera shutter. New measurements will appear automatically.'));
  } else {
    stateKey = 'select-measurement';
    title = esc(tx('empty.selectMeasurement', 'Select a measurement'));
    sub = esc(tx('empty.selectMeasurementSub', 'Choose an entry from the history to inspect timing details.'));
  }

  const emptyKey = JSON.stringify([stateKey, title, sub, extra, document.documentElement.lang || '']);
  const existing = document.getElementById('main-empty');
  if (existing && existing.dataset.emptyKey === emptyKey) {
    setContentEmptyView(true);
    return;
  }

  setSettingsNavActive(false);
  setContentEmptyView(true);
  content.innerHTML = `<div class="empty empty-main" id="main-empty" data-empty-key="${esc(emptyKey)}">
    <div class="empty-ico">${emptyIconHtml(iconKind)}</div>
    <div class="empty-txt" style="font-size:16px;">${title}</div>
    <div class="empty-sub">${sub}</div>
    ${action ? `<div class="empty-actions">${action}</div>` : ''}
    ${extra}
    ${renderQuickStartHtml()}
  </div>`;
}
