// CSV camera-attribute export and standalone HTML camera report generation.

// ════════════════════════════════════════════
// EXPORT SCORING HELPERS
// ════════════════════════════════════════════
const REPORT_EXPORT_CONFIG = Object.freeze({
  // Spread is weighted higher than simple offset because uneven exposure across the frame is harder to compensate.
  accuracyOffsetWeight: 35,
  accuracySpreadWeight: 65,
  reliabilityWeight: 100,
  curtainUniformityWeight: 55,
  curtainParallelismWeight: 45,
  // A configured target time with no valid measurement means this speed did not work in the camera project.
  missingTargetScore: 0,
});

function exportConfig() {
  return REPORT_EXPORT_CONFIG;
}

function scoreBlend(parts) {
  const valid = parts.filter(p => p && Number.isFinite(p.score) && Number.isFinite(p.weight) && p.weight > 0);
  const total = valid.reduce((sum, p) => sum + p.weight, 0);
  return total ? valid.reduce((sum, p) => sum + p.score * p.weight, 0) / total : null;
}

function scoreFromTolerance(value, good, acceptable, floor = 20) {
  const v = Math.abs(Number(value));
  if (!Number.isFinite(v)) return null;
  if (v <= good) return clampNumber(100 - (v / Math.max(good, 0.0001)) * 8, 0, 100);
  if (v <= acceptable) return clampNumber(92 - ((v - good) / Math.max(acceptable - good, 0.0001)) * 32, 0, 100);
  return clampNumber(60 - ((v - acceptable) / Math.max(acceptable * 1.5, 0.0001)) * 40, floor, 60);
}

function scoreLabel(score) {
  if (!Number.isFinite(score)) return tx('report.notRated', 'Not rated');
  if (score >= 90) return tx('report.excellent', 'Excellent');
  if (score >= 78) return tx('report.good', 'Good');
  if (score >= 62) return tx('report.usable', 'Usable');
  if (score >= 45) return tx('report.needsServiceSoon', 'Service useful');
  return tx('report.serviceRecommended', 'Service recommended');
}

function reportGrade(score) {
  return gradeFromScore(score).grade;
}

function pctScore(score) {
  return Number.isFinite(score) ? Math.round(score) : null;
}

function formatScore(score) {
  return Number.isFinite(score) ? Math.round(score) + ' / 100' : '-';
}

function formatReportTime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '-';
  if (s >= 1) return s.toLocaleString(uiLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' s';
  return (s * 1000).toLocaleString(uiLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ms';
}

function formatFractionFromSeconds(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '-';
  const frac = Math.round(1 / s);
  return frac <= 1 ? s.toLocaleString(uiLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' s' : '1/' + frac + ' s';
}

function signedEv(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '-';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + ' EV';
}

function safeFilenameName(name, fallback = 'camera') {
  return String(name || fallback).trim().replace(/[^a-zA-Z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

function activeSensorDurations(entry) {
  return (entry.sensors || []).filter(s => s.activated && Number.isFinite(s.seconds) && s.seconds > 0);
}

function targetLabel(targetFrac) {
  const t = Number(targetFrac);
  return Number.isFinite(t) && t > 0 ? '1/' + t + ' s' : '-';
}

function targetRowsForProject(project) {
  const cfg = exportConfig();
  return (project.times || []).map(target => {
    const agg = aggregateForTarget(project.id, target);
    if (!agg) {
      return {
        targetFrac: target,
        targetSec: target > 0 ? 1 / target : null,
        measured: false,
        missing: true,
        measurementCount: 0,
        targetWeight: 1,
        accuracyScore: cfg.missingTargetScore,
      };
    }

    const offsetScore = scoreFromTolerance(Math.abs(agg.avgDev), 0.15, 0.75, 25);
    const spreadScore = scoreFromTolerance(agg.avgSpread, 0.10, 0.55, 20);
    const reliabilityScore = agg.n >= 2 ? scoreFromTolerance(agg.sigmaEv, 0.05, 0.35, 30) : null;
    const accuracyScore = scoreBlend([
      { score: offsetScore, weight: cfg.accuracyOffsetWeight },
      { score: spreadScore, weight: cfg.accuracySpreadWeight },
    ]);

    return {
      targetFrac: target,
      targetSec: 1 / target,
      measured: true,
      missing: false,
      measurementCount: agg.n,
      targetWeight: 1,
      avgFrac: agg.avgFrac,
      avgSec: agg.avgSec,
      avgMs: agg.avgSec * 1000,
      avgDev: agg.avgDev,
      avgAbsDev: agg.avgAbsDev,
      avgSpread: agg.avgSpread,
      sigmaEv: agg.sigmaEv,
      accuracyScore,
      reliabilityScore,
      targetScore: agg.score,
      openingSpeed: agg.avgV1,
      closingSpeed: agg.avgV2,
      flashDetected: agg.flashDetected,
      flashOk: agg.flashOk,
      flashLate: agg.flashLate,
      flashBad: agg.flashBad,
    };
  });
}

function velocityCv(values) {
  const clean = values.filter(v => Number.isFinite(v) && v > 0);
  const avg = average(clean);
  return clean.length > 1 && avg ? stddev(clean) / avg : null;
}

function missingTargetStats(targetRows) {
  const rows = Array.isArray(targetRows) ? targetRows : [];
  const total = rows.length;
  const missing = rows.filter(row => row && row.missing).length;
  return { total, missing, missingFraction: total ? missing / total : 0 };
}

function curtainConditionForEntry(entry) {
  const profile = curtainSpeedProfile(entry);
  if (!profile || (!profile.open.length && !profile.close.length)) return null;

  const openCv = velocityCv(profile.open.map(p => p.v));
  const closeCv = velocityCv(profile.close.map(p => p.v));
  const uniformityCv = average([openCv, closeCv].filter(Number.isFinite));
  const pairs = [];
  const closeByX = new Map(profile.close.map(p => [p.x.toFixed(3), p.v]));

  profile.open.forEach(p => {
    const cv = closeByX.get(p.x.toFixed(3));
    if (Number.isFinite(cv) && cv > 0 && p.v > 0) pairs.push(Math.abs(Math.log2(p.v / cv)));
  });

  const parallelEv = average(pairs);
  return {
    openCv,
    closeCv,
    uniformityCv,
    parallelEv,
    openAvg: average(profile.open.map(p => p.v)),
    closeAvg: average(profile.close.map(p => p.v)),
  };
}

function curtainConditionForProject(entries, targetRows, project) {
  const missingStats = missingTargetStats(targetRows);
  const mode = project && typeof normalizeMeasurementMode === 'function' ? normalizeMeasurementMode(project.mode) : '';
  const applyMissingPenalty = mode !== 'central';
  const coverageFactor = applyMissingPenalty && missingStats.total ? Math.max(0, 1 - missingStats.missingFraction) : 1;
  const items = entries.map(curtainConditionForEntry).filter(Boolean);
  if (!items.length) return {
    uniformityCv: null,
    parallelEv: null,
    uniformityScore: null,
    parallelScore: null,
    curtainScore: applyMissingPenalty && missingStats.missing ? 0 : null,
    openAvg: null,
    closeAvg: null,
    missingTargets: missingStats.missing,
  };

  const cfg = exportConfig();
  const uniformityCv = average(items.map(x => x.uniformityCv).filter(Number.isFinite));
  const parallelEv = average(items.map(x => x.parallelEv).filter(Number.isFinite));
  const uniformityScore = scoreFromTolerance(uniformityCv, 0.08, 0.35, 25);
  const parallelScore = scoreFromTolerance(parallelEv, 0.08, 0.45, 25);
  const baseCurtainScore = scoreBlend([
    { score: uniformityScore, weight: cfg.curtainUniformityWeight },
    { score: parallelScore, weight: cfg.curtainParallelismWeight },
  ]);

  return {
    uniformityCv,
    parallelEv,
    uniformityScore,
    parallelScore,
    curtainScore: Number.isFinite(baseCurtainScore) ? clampNumber(baseCurtainScore * coverageFactor, 0, 100) : null,
    baseCurtainScore,
    openAvg: average(items.map(x => x.openAvg).filter(Number.isFinite)),
    closeAvg: average(items.map(x => x.closeAvg).filter(Number.isFinite)),
    missingTargets: missingStats.missing,
  };
}

function recommendedFlashSync(targetRows) {
  const candidates = targetRows
    .filter(row => row.measured && row.flashDetected > 0 && row.flashOk > 0 && row.flashBad === 0)
    .sort((a, b) => b.targetFrac - a.targetFrac);

  if (candidates.length) {
    const best = candidates[0];
    return {
      targetFrac: best.targetFrac,
      label: targetLabel(best.targetFrac),
      status: tx('report.flashRecommendedMeasured', 'Fastest safely measured flash time'),
    };
  }

  const anyFlash = targetRows.some(row => row.measured && row.flashDetected > 0);
  return {
    targetFrac: null,
    label: anyFlash ? tx('report.noSafeFlashSync', 'No safe flash sync measured') : tx('report.flashNotMeasured', 'Flash sync not measured'),
    status: anyFlash ? tx('report.allMeasuredFlashFailed', 'All measured flash times had failures') : tx('report.noFlashData', 'No flash data in this project'),
  };
}

function projectScoreModel(project) {
  const entries = getProjectEntries(project.id);
  const targetRows = targetRowsForProject(project);
  const measuredRows = targetRows.filter(row => row.measured);
  const scoredRows = targetRows.filter(row => Number.isFinite(row.accuracyScore));
  const cfg = exportConfig();
  const accuracyScore = weightedAverage(scoredRows, 'accuracyScore', 'targetWeight');
  const repeatedRows = measuredRows.filter(row => row.measurementCount >= 2 && Number.isFinite(row.reliabilityScore));
  const reliabilityScore = repeatedRows.length ? weightedAverage(repeatedRows, 'reliabilityScore', 'measurementCount') : null;
  const curtain = curtainConditionForProject(entries, targetRows, project);
  const overall = scoreBlend([
    { score: accuracyScore, weight: 44 },
    { score: reliabilityScore, weight: cfg.reliabilityWeight ? 24 : 0 },
    { score: curtain.curtainScore, weight: 32 },
  ]);
  const flash = recommendedFlashSync(targetRows);
  return { entries, targetRows, measuredRows, cfg, accuracyScore, reliabilityScore, curtain, overall, flash };
}

// ════════════════════════════════════════════
// ENHANCED CSV EXPORT
// ════════════════════════════════════════════
function csvCell(value) {
  const text = String(value ?? '');
  return '"' + text.replace(/"/g, '""') + '"';
}

function csvLine(values) {
  return values.map(csvCell).join(';');
}

function csvNumber(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '';
}

function csvBool(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return '';
}

function exportProjCSV(projId) {
  const p = S.projects.find(x => x.id === projId);
  if (!p || isDefaultProject(p)) return;

  const model = projectScoreModel(p);
  const lines = [];
  const now = new Date();

  lines.push(csvLine(['OpenCurtainLab project export', APP_VERSION]));
  lines.push(csvLine(['Project', p.name]));
  lines.push(csvLine(['Exported', formatReportDateTime(now)]));
  lines.push(csvLine(['Mode', modeLabel(p.mode)]));
  lines.push(csvLine(['Sensor distance X mm', csvNumber(model.entries[0]?.sensorDistanceXmm, 3)]));
  lines.push(csvLine(['Sensor distance Y mm', csvNumber(model.entries[0]?.sensorDistanceYmm, 3)]));
  lines.push(csvLine([tx('report.maximumFlashTime', 'Maximum flash time'), model.flash.label]));
  lines.push(csvLine(['Accuracy score', formatScore(model.accuracyScore)]));
  lines.push(csvLine(['Reliability score', formatScore(model.reliabilityScore)]));
  lines.push(csvLine(['Curtain condition score', formatScore(model.curtain.curtainScore)]));
  lines.push(csvLine(['Overall score', formatScore(model.overall)]));
  if (p.note) lines.push(csvLine(['Project note', p.note.replace(/\n/g, ' | ')]));
  lines.push('');

  lines.push(csvLine([
    'RecordType','Target','Target_s','Measured_fraction','Measured_s','Measured_ms','Offset_EV','Abs_offset_EV','Spread_EV','Repeatability_sigma_EV',
    'Accuracy_score','Reliability_score','Opening_speed_m_s','Closing_speed_m_s','Flash_ok','Flash_late','Flash_bad','Flash_detected','Measurements','Grade'
  ]));

  model.targetRows.forEach(row => {
    lines.push(csvLine([
      'TARGET', targetLabel(row.targetFrac), csvNumber(row.targetSec, 6), row.measured ? ('1/' + row.avgFrac) : '', csvNumber(row.avgSec, 6), csvNumber(row.avgMs, 3),
      csvNumber(row.avgDev, 4), csvNumber(row.avgAbsDev, 4), csvNumber(row.avgSpread, 4), csvNumber(row.sigmaEv, 4),
      csvNumber(row.accuracyScore, 1), csvNumber(row.reliabilityScore, 1), csvNumber(row.openingSpeed, 4), csvNumber(row.closingSpeed, 4),
      row.flashOk ?? '', row.flashLate ?? '', row.flashBad ?? '', row.flashDetected ?? '', row.measurementCount || 0, Number.isFinite(row.accuracyScore) ? reportGrade(row.accuracyScore) : ''
    ]));
  });

  lines.push('');
  lines.push(csvLine([
    'RecordType','Measurement_ID','Timestamp','Project','Mode','Target','Measured_fraction','Measured_s','Measured_ms','Offset_EV','Spread_EV','Sensor_count',
    'Opening_speed_m_s','Closing_speed_m_s','Flash_detected','Flash_sync_ok','Flash_sync_state','Hint'
  ]));

  model.entries.forEach(entry => {
    const curtain = calcCurtain(entry) || {};
    lines.push(csvLine([
      'MEASUREMENT', entry.id, formatReportDateTime(new Date(entry.ts || Date.now())), p.name, modeLabel(entry.mode), targetLabel(entry.targetFrac),
      entry.avgFrac ? '1/' + entry.avgFrac : '', csvNumber(entry.avgSec, 6), csvNumber(entry.avgSec * 1000, 3), csvNumber(entry.avgDev, 4), csvNumber(entry.spread, 4), entry.count || activeSensorDurations(entry).length,
      csvNumber(curtain.v1, 4), csvNumber(curtain.v2, 4), csvBool(entry.flash && entry.flash.detected), csvBool(isFlashSyncOk(entry)), typeof flashSyncState === 'function' ? flashSyncState(entry) : '', entry.hint || ''
    ]));
  });

  lines.push('');
  lines.push(csvLine([
    'RecordType','Measurement_ID','Sensor','Activated','Open_ms','Close_ms','Exposure_ms','Measured_fraction','Offset_EV','Raw'
  ]));

  model.entries.forEach(entry => {
    (entry.sensors || []).forEach(sensor => {
      lines.push(csvLine([
        'SENSOR', entry.id, 'S' + sensor.id, csvBool(sensor.activated), csvNumber(sensor.openMs, 3), csvNumber(sensor.closeMs, 3), csvNumber(sensor.seconds * 1000, 3),
        sensor.fraction ? '1/' + sensor.fraction : '', csvNumber(sensor.deviation, 4), sensor.raw ?? ''
      ]));
    });
  });

  const dateStr = timestampForFilename(now);
  downloadTextFile('\uFEFF' + lines.join('\n'), safeFilenameName(p.name) + '_' + dateStr + '_camera_attributes.csv', 'text/csv;charset=utf-8;');
  toast(tf('toast.csvExported', 'CSV exported - {count} target times', {count: model.targetRows.length}), 'success');
}

// ════════════════════════════════════════════
// STANDALONE HTML CAMERA REPORT
// ════════════════════════════════════════════
function formatReportDateTime(date = new Date()) {
  return date.toLocaleString(uiLocale(), {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

function reportDensityClass(rows) {
  const count = (rows || []).filter(Boolean).length;
  if (count >= 12) return 'dense-report';
  if (count >= 8) return 'compact-report';
  return '';
}

function reportScoreCard(title, score, body) {
  const pct = pctScore(score);
  const bar = Number.isFinite(pct) ? pct : 0;
  return `<section class="score-card">
    <div class="score-card-top"><h3>${esc(title)}</h3><strong>${esc(formatScore(score))}</strong></div>
    <div class="score-bar"><i style="width:${bar}%"></i></div>
    <p>${esc(body)}</p>
  </section>`;
}

function reportRowsHtml(rows) {
  return rows.map(row => {
    if (!row.measured) {
      const label = row.missing ? tx('report.missingTargetRow', 'Missing target time - counted as a problem') : tx('report.notMeasured', 'Not measured');
      return `<tr><td>${esc(targetLabel(row.targetFrac))}</td><td colspan="8" class="muted">${esc(label)}</td></tr>`;
    }
    return `<tr>
      <td>${esc(targetLabel(row.targetFrac))}</td>
      <td>${esc(formatFractionFromSeconds(row.avgSec))}</td>
      <td>${esc(formatReportTime(row.avgSec))}</td>
      <td>${esc(signedEv(row.avgDev))}</td>
      <td>${esc(formatFixed(row.avgSpread, 2) + ' EV')}</td>
      <td>${esc(formatFixed(row.sigmaEv, 2) + ' EV')}</td>
      <td>${esc(formatScore(row.accuracyScore))}</td>
      <td>${row.openingSpeed != null && row.closingSpeed != null ? esc(row.openingSpeed.toFixed(2) + ' / ' + row.closingSpeed.toFixed(2)) : '-'}</td>
      <td>${row.flashDetected ? (row.flashBad ? '×' : (row.flashLate ? '●' : '●')) : '-'}</td>
    </tr>`;
  }).join('');
}

function evChartTickStep(limit) {
  if (limit <= 1) return 0.25;
  if (limit <= 2) return 0.5;
  return 1;
}

function targetBarsSvg(rows) {
  const chartRows = rows.filter(r => r && (r.measured || r.missing));
  const measured = chartRows.filter(r => r.measured);
  if (!chartRows.length) return '';

  const bounds = measured.flatMap(row => {
    const spread = Math.max(0, Number(row.avgSpread) || 0);
    const halfSpread = spread / 2;
    return [row.avgDev - halfSpread, row.avgDev + halfSpread, row.avgDev];
  }).filter(Number.isFinite);

  const rawLimit = Math.max(0.5, ...(bounds.length ? bounds.map(v => Math.abs(v)) : [1]));
  const tickStep = evChartTickStep(rawLimit);
  const limit = Math.ceil(rawLimit / tickStep) * tickStep;
  const width = 820;
  const dense = chartRows.length >= 12;
  const compact = chartRows.length >= 8;
  const left = 90;
  const right = 68;
  const top = compact ? 24 : 32;
  const bottom = 24;
  const rowH = dense ? 12 : compact ? 16 : 22;
  const plotW = width - left - right;
  const height = top + bottom + chartRows.length * rowH;
  const zeroX = left + plotW / 2;
  const xFor = ev => left + ((ev + limit) / (2 * limit)) * plotW;

  const ticks = [];
  for (let v = -limit; v <= limit + tickStep / 10; v += tickStep) ticks.push(Number(v.toFixed(3)));

  const axis = ticks.map(tick => {
    const x = xFor(tick);
    const label = (tick > 0 ? '+' : '') + tick.toFixed(tickStep < 1 ? 2 : 0).replace(/\.00$/, '').replace(/\.0$/, '') + ' EV';
    const cls = Math.abs(tick) < 0.0001 ? 'zero' : 'grid';
    return `<line class="${cls}" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top - 14}" y2="${height - bottom + 5}"></line><text class="tick" x="${x.toFixed(1)}" y="${height - 10}" text-anchor="middle">${esc(label)}</text>`;
  }).join('');

  const items = chartRows.map((row, i) => {
    const y = top + i * rowH;
    const barY = y - Math.max(5, rowH * 0.28);
    const barH = Math.max(8, rowH * 0.52);

    if (row.missing) {
      const label = tx('report.missingTargetChartLabel', 'No valid measurement');
      return `<text class="target missing-target" x="16" y="${y + 4}">${esc(targetLabel(row.targetFrac))}</text>` +
        `<rect class="missing-band" x="${left}" y="${barY.toFixed(1)}" width="${plotW}" height="${barH.toFixed(1)}" rx="4"></rect>` +
        `<text class="missing-label" x="${zeroX.toFixed(1)}" y="${y + 4}" text-anchor="middle">${esc(label)}</text>`;
    }

    const dx = Number(row.avgDev) || 0;
    const spread = Math.max(0, Number(row.avgSpread) || 0);
    const halfSpread = spread / 2;
    const x0 = zeroX;
    const x1 = xFor(dx);
    const barX = Math.min(x0, x1);
    const barW = Math.max(2, Math.abs(x1 - x0));
    const errMinX = xFor(dx - halfSpread);
    const errMaxX = xFor(dx + halfSpread);
    const valueX = dx >= 0 ? Math.min(width - 8, Math.max(errMaxX + 8, x1 + 8)) : Math.max(8, Math.min(errMinX - 8, x1 - 8));
    return `<text class="target" x="16" y="${y + 4}">${esc(targetLabel(row.targetFrac))}</text>` +
      `<rect x="${barX.toFixed(1)}" y="${barY.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="4"></rect>` +
      `<line class="error" x1="${errMinX.toFixed(1)}" x2="${errMaxX.toFixed(1)}" y1="${y - 1}" y2="${y - 1}"></line>` +
      `<line class="error-cap" x1="${errMinX.toFixed(1)}" x2="${errMinX.toFixed(1)}" y1="${barY.toFixed(1)}" y2="${(y + Math.max(4, rowH * 0.28)).toFixed(1)}"></line>` +
      `<line class="error-cap" x1="${errMaxX.toFixed(1)}" x2="${errMaxX.toFixed(1)}" y1="${barY.toFixed(1)}" y2="${(y + Math.max(4, rowH * 0.28)).toFixed(1)}"></line>` +
      `<text class="value" x="${valueX.toFixed(1)}" y="${y + 4}" text-anchor="${dx >= 0 ? 'start' : 'end'}">${esc(signedEv(row.avgDev))}</text>`;
  }).join('');

  return `<svg class="offset-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(tx('report.exposureOffsets', 'Exposure offsets'))}">${axis}${items}</svg>`;
}

function niceSpeedMax(maxValue) {
  const raw = Math.max(1, Number(maxValue) || 1);
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const scaled = raw / exp;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
  return nice * exp;
}

function curtainSpeedSvg(project, rows) {
  if (project && typeof normalizeMeasurementMode === 'function' && normalizeMeasurementMode(project.mode) === 'central') return '';

  const chartRows = rows
    .filter(r => r && (r.measured || r.missing))
    .sort((a, b) => a.targetFrac - b.targetFrac);
  const measured = chartRows.filter(r => Number.isFinite(r.openingSpeed) || Number.isFinite(r.closingSpeed));

  if (!measured.length) return '';

  const width = 820;
  const compact = chartRows.length >= 8;
  const manyTargets = chartRows.length >= 10;
  const left = 64;
  const right = 28;
  const top = 24;
  const bottom = manyTargets ? 70 : compact ? 58 : 46;
  const plotW = width - left - right;
  const plotH = compact ? 134 : 160;
  const height = top + plotH + bottom;
  const allSpeeds = measured.flatMap(row => [row.openingSpeed, row.closingSpeed]).filter(v => Number.isFinite(v) && v > 0);
  const maxV = niceSpeedMax(Math.max(...allSpeeds) * 1.18);
  const xFor = index => left + (chartRows.length === 1 ? plotW / 2 : (index / (chartRows.length - 1)) * plotW);
  const yFor = value => top + plotH * (1 - Math.max(0, value) / maxV);

  const grid = [];
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const value = maxV * (1 - i / gridSteps);
    const y = top + plotH * (i / gridSteps);
    grid.push(`<line class="grid" x1="${left}" x2="${width - right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>`);
    grid.push(`<text class="tick speed" x="${left - 9}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(formatFixed(value, 2))}</text>`);
  }

  const tickY = top + plotH + (manyTargets ? 24 : 18);
  const xAxis = chartRows.map((row, i) => {
    const x = xFor(i);
    const label = targetLabel(row.targetFrac).replace(' s', '');
    const targetClass = row.missing ? 'tick target missing-target' : 'tick target';
    const textAttrs = manyTargets
      ? `x="${(x - 3).toFixed(1)}" y="${tickY.toFixed(1)}" text-anchor="end" transform="rotate(-35 ${x.toFixed(1)} ${tickY.toFixed(1)})"`
      : `x="${x.toFixed(1)}" y="${tickY.toFixed(1)}" text-anchor="middle"`;
    return `<line class="grid soft" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${top + plotH}"></line>` +
      `<text class="${targetClass}" ${textAttrs}>${esc(label)}</text>`;
  }).join('');

  function lineFor(key, cls) {
    const points = chartRows.map((row, i) => {
      const v = row[key];
      return Number.isFinite(v) && v > 0 ? { x: xFor(i), y: yFor(v), v, row } : null;
    }).filter(Boolean);
    if (!points.length) return '';
    const pointString = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const circles = points.map(p => `<circle class="${cls}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${compact ? 3.4 : 4}"><title>${esc(targetLabel(p.row.targetFrac) + ': ' + p.v.toFixed(2) + ' m/s')}</title></circle>`).join('');
    return `<polyline class="curtain-line ${cls}" points="${pointString}"></polyline>${circles}`;
  }

  const axis = `<line class="axis" x1="${left}" x2="${left}" y1="${top}" y2="${top + plotH}"></line>` +
    `<line class="axis" x1="${left}" x2="${width - right}" y1="${top + plotH}" y2="${top + plotH}"></line>` +
    `<text class="axis-label y" x="16" y="${top + plotH / 2}" transform="rotate(-90 16 ${top + plotH / 2})" text-anchor="middle">m/s</text>` +
    `<text class="axis-label x" x="${left + plotW / 2}" y="${height - 9}" text-anchor="middle">${esc(tx('charts.targetSpeedAxis', 'Target speed (1/x s)'))}</text>`;

  return `<svg class="curtain-speed-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(tx('cards.curtainCurve', 'Curtain speed by target'))}">` +
    grid.join('') + xAxis + axis + lineFor('openingSpeed', 'opening') + lineFor('closingSpeed', 'closing') +
    `</svg>`;
}

function curtainSpeedReportSection(project, rows) {
  const chart = curtainSpeedSvg(project, rows);
  if (!chart) return '';
  return `<section class="chart-section curtain-speed-section"><h2>${esc(tx('cards.curtainCurve', 'Curtain speed by target'))}</h2>` +
    `<div class="chart-explainer"><p>${esc(tx('report.curtainSpeedExplanation', 'The lines show whether the opening and closing curtains move at similar, steady speeds across the measured settings. Smooth, close lines suggest clean shutter travel; jumps or large separation can indicate adjustment or service needs.'))}</p>` +
    `<div class="chart-legend"><div><span class="legend-line opening"></span><span>${esc(tx('charts.openingSpeed', 'Opening speed'))}</span></div>` +
    `<div><span class="legend-line closing"></span><span>${esc(tx('charts.closingSpeed', 'Closing speed'))}</span></div></div></div>` +
    chart + `</section>`;
}

function reportDataFieldsHtml(project, model, measuredCount, measuredTargets) {
  const missingTargets = (model.targetRows || []).filter(row => row && row.missing).length;
  const targetSub = missingTargets
    ? tf('report.missingTargetsProblem', '{count} missing target time(s) lower accuracy and curtain condition.', { count: missingTargets })
    : tx('report.measuredTargets', 'measured target speeds in this camera project');
  const fields = [
    { label: tx('report.maximumFlashTime', 'Maximum flash time'), value: model.flash.label, sub: model.flash.status },
    { label: tx('report.measurements', 'Measurements'), value: String(measuredCount), sub: tx('report.validProjectMeasurements', 'evaluated releases; more repeats make the rating more reliable') },
    { label: tx('report.targetTimes', 'Target times'), value: measuredTargets + '/' + project.times.length, sub: targetSub }
  ];
  return `<section class="data-fields">${fields.map(field => `<div class="data-field"><span>${esc(field.label)}</span><strong>${esc(field.value)}</strong><small>${esc(field.sub || '')}</small></div>`).join('')}</section>`;
}

function renderReportTemplate(template, values) {
  return String(template || '').replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? '') : match);
}

async function reportTemplateHtml() {
  const embedded = document.getElementById('ocl-report-template');
  if (embedded) return embedded.textContent || embedded.innerHTML || '';
  const response = await fetch('report-template.html', { cache: 'no-store' });
  if (!response.ok) throw new Error('report-template.html not available');
  return response.text();
}

async function standaloneReportHtml(project, model) {
  const exportedAt = formatReportDateTime(new Date());
  const measuredCount = model.entries.length;
  const measuredTargets = model.measuredRows.length;
  const title = tx('report.title', 'Camera measurement report');
  const accBody = tx('report.accuracyBody', 'Compares the camera with every selected shutter speed. High values mean the measured exposure is close to the target and even across the frame. A missing target speed counts as a fault because this speed apparently produced no valid timing result.');
  const relBody = tx('report.reliabilityBody', 'Rates whether the same setting stays consistent over repeated releases. This matters when the camera should work reproducibly, not only once. Without repeat measurements, the result is limited.');
  const curtainBody = tx('report.curtainBody', 'Rates focal-plane shutter travel. Good values mean the opening and closing curtains move smoothly and match each other. Missing target speeds lower this value because an unusable speed can indicate a shutter timing problem.');
  const overallLabel = scoreLabel(model.overall);
  const note = project.note ? `<section class="note"><h2>${esc(tx('report.projectNote', 'Project note'))}</h2><p>${esc(project.note)}</p></section>` : '';
  const template = await reportTemplateHtml();

  return renderReportTemplate(template, {
    LANG: esc(document.documentElement.lang || 'en'),
    PAGE_TITLE: esc(project.name + ' - ' + title),
    APP_VERSION: esc(APP_VERSION),
    PROJECT_NAME: esc(project.name),
    REPORT_TITLE: esc(title),
    REPORT_DENSITY_CLASS: esc(reportDensityClass(model.targetRows)),
    EXPORTED_AT: esc(exportedAt),
    OVERALL_GRADE: esc(reportGrade(model.overall)),
    OVERALL_LABEL: esc(overallLabel),
    MEASUREMENTS_LABEL: esc(tx('report.measurements', 'Measurements')),
    MEASUREMENT_COUNT: esc(measuredCount),
    TARGET_TIMES_LABEL: esc(tx('report.targetTimes', 'Target times')),
    MEASURED_TARGETS: esc(measuredTargets + '/' + project.times.length),
    OVERALL_TITLE: esc(tx('report.overall', 'Overall')),
    OVERALL_SCORE: esc(formatScore(model.overall)),
    SCORES_TITLE: esc(tx('report.scoresTitle', 'Assessment')),
    SCORE_CARDS: [
      reportScoreCard(tx('report.accuracy', 'Accuracy'), model.accuracyScore, accBody),
      reportScoreCard(tx('report.reliability', 'Reliability'), model.reliabilityScore, relBody),
      reportScoreCard(tx('report.curtainCondition', 'Curtain condition'), model.curtain.curtainScore, curtainBody),
    ].join(''),
    DATA_TITLE: esc(tx('report.dataTitle', 'Results')), 
    EXPOSURE_OFFSETS_TITLE: esc(tx('report.exposureOffsets', 'Exposure offsets')),
    EXPOSURE_OFFSETS_EXPLANATION: esc(tx('report.exposureOffsetsExplanation', 'For each selected shutter speed, the bar shows the average timing error against the target. 0 EV is ideal. Left means the camera is faster, right means slower. The whisker shows frame evenness. A missing target speed is shown as a failed row and lowers the accuracy and curtain-condition scores.')),
    EXPOSURE_BAR_LEGEND: esc(tx('report.exposureBarLegend', 'Bar: average timing error')),
    EXPOSURE_ERROR_LEGEND: esc(tx('report.exposureErrorLegend', 'Whisker: frame evenness')),
    OFFSET_CHART: targetBarsSvg(model.targetRows),
    CURTAIN_SPEED_SECTION: curtainSpeedReportSection(project, model.targetRows),
    DATA_FIELDS: reportDataFieldsHtml(project, model, measuredCount, measuredTargets),
    PROJECT_NOTE: note,
    GITHUB_URL: esc(typeof GITHUB_URL !== 'undefined' ? GITHUB_URL : 'https://github.com/benikum/OpenCurtainLab'),
    GITHUB_LABEL: esc(tx('report.githubLink', 'GitHub: benikum/OpenCurtainLab')),
  });
}

async function exportProjectReportHtml(projId) {
  const project = S.projects.find(x => x.id === projId);
  if (!project || isDefaultProject(project)) return;

  try {
    const model = projectScoreModel(project);
    const html = await standaloneReportHtml(project, model);
    const filename = safeFilenameName(project.name) + '_' + timestampForFilename() + '_camera_report.html';
    downloadTextFile(html, filename, 'text/html;charset=utf-8;');
    toast(tx('toast.reportExported', 'HTML camera report exported'), 'success');
  } catch (err) {
    console.error(err);
    toast(tx('toast.reportExportFailed', 'HTML camera report could not be exported'), 'error');
  }
}
