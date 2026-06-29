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
  return Number.isFinite(score) ? Math.round(score) + ' / 100' : '—';
}

function formatReportTime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '—';
  if (s >= 1) return s.toLocaleString(uiLocale(), { maximumFractionDigits: 3 }) + ' s';
  return (s * 1000).toLocaleString(uiLocale(), { maximumFractionDigits: 3 }) + ' ms';
}

function formatFractionFromSeconds(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '—';
  const frac = Math.round(1 / s);
  return frac <= 1 ? s.toLocaleString(uiLocale(), { maximumFractionDigits: 3 }) + ' s' : '1/' + frac + ' s';
}

function signedEv(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(3) + ' EV';
}

function safeFilenameName(name, fallback = 'camera') {
  return String(name || fallback).trim().replace(/[^a-zA-Z0-9_\-]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

function activeSensorDurations(entry) {
  return (entry.sensors || []).filter(s => s.activated && Number.isFinite(s.seconds) && s.seconds > 0);
}

function targetLabel(targetFrac) {
  const t = Number(targetFrac);
  return Number.isFinite(t) && t > 0 ? '1/' + t + ' s' : '—';
}

function targetRowsForProject(project) {
  return (project.times || []).map(target => {
    const agg = aggregateForTarget(project.id, target);
    if (!agg) {
      return {
        targetFrac: target,
        targetSec: target > 0 ? 1 / target : null,
        measured: false,
        measurementCount: 0,
      };
    }

    const offsetScore = scoreFromTolerance(Math.abs(agg.avgDev), 0.15, 0.75, 25);
    const spreadScore = scoreFromTolerance(agg.avgSpread, 0.10, 0.55, 20);
    const reliabilityScore = agg.n >= 2 ? scoreFromTolerance(agg.sigmaEv, 0.05, 0.35, 30) : null;
    const cfg = exportConfig();
    const accuracyScore = scoreBlend([
      { score: offsetScore, weight: cfg.accuracyOffsetWeight },
      { score: spreadScore, weight: cfg.accuracySpreadWeight },
    ]);

    return {
      targetFrac: target,
      targetSec: 1 / target,
      measured: true,
      measurementCount: agg.n,
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

function curtainConditionForProject(entries) {
  const items = entries.map(curtainConditionForEntry).filter(Boolean);
  if (!items.length) return {
    uniformityCv: null,
    parallelEv: null,
    uniformityScore: null,
    parallelScore: null,
    curtainScore: null,
    openAvg: null,
    closeAvg: null,
  };

  const cfg = exportConfig();
  const uniformityCv = average(items.map(x => x.uniformityCv).filter(Number.isFinite));
  const parallelEv = average(items.map(x => x.parallelEv).filter(Number.isFinite));
  const uniformityScore = scoreFromTolerance(uniformityCv, 0.08, 0.35, 25);
  const parallelScore = scoreFromTolerance(parallelEv, 0.08, 0.45, 25);

  return {
    uniformityCv,
    parallelEv,
    uniformityScore,
    parallelScore,
    curtainScore: scoreBlend([
      { score: uniformityScore, weight: cfg.curtainUniformityWeight },
      { score: parallelScore, weight: cfg.curtainParallelismWeight },
    ]),
    openAvg: average(items.map(x => x.openAvg).filter(Number.isFinite)),
    closeAvg: average(items.map(x => x.closeAvg).filter(Number.isFinite)),
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
      status: tx('report.flashRecommendedMeasured', 'Maximum measured flash sync time'),
    };
  }

  const anyFlash = targetRows.some(row => row.measured && row.flashDetected > 0);
  return {
    targetFrac: null,
    label: anyFlash ? tx('report.noSafeFlashSync', 'No safe flash sync measured') : tx('report.flashNotMeasured', 'Flash sync not measured'),
    status: anyFlash ? tx('report.allMeasuredFlashFailed', 'Every measured flash time had failures') : tx('report.noFlashData', 'No flash data in this project'),
  };
}

function projectScoreModel(project) {
  const entries = getProjectEntries(project.id);
  const targetRows = targetRowsForProject(project);
  const measuredRows = targetRows.filter(row => row.measured);
  const cfg = exportConfig();
  const accuracyScore = weightedAverage(measuredRows, 'accuracyScore', 'measurementCount');
  const repeatedRows = measuredRows.filter(row => row.measurementCount >= 2 && Number.isFinite(row.reliabilityScore));
  const reliabilityScore = repeatedRows.length ? weightedAverage(repeatedRows, 'reliabilityScore', 'measurementCount') : null;
  const curtain = curtainConditionForProject(entries);
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
  lines.push(csvLine(['Exported', now.toLocaleString(uiLocale())]));
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
      row.flashOk ?? '', row.flashLate ?? '', row.flashBad ?? '', row.flashDetected ?? '', row.measurementCount || 0, row.measured ? reportGrade(row.accuracyScore) : ''
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
      'MEASUREMENT', entry.id, new Date(entry.ts || Date.now()).toLocaleString(uiLocale()), p.name, modeLabel(entry.mode), targetLabel(entry.targetFrac),
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
  toast(tf('toast.csvExported', 'CSV exported — {count} target times', {count: model.targetRows.length}), 'success');
}

// ════════════════════════════════════════════
// STANDALONE HTML CAMERA REPORT
// ════════════════════════════════════════════
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
      return `<tr><td>${esc(targetLabel(row.targetFrac))}</td><td colspan="8" class="muted">${esc(tx('report.notMeasured', 'Not measured'))}</td></tr>`;
    }
    return `<tr>
      <td>${esc(targetLabel(row.targetFrac))}</td>
      <td>${esc(formatFractionFromSeconds(row.avgSec))}</td>
      <td>${esc(formatReportTime(row.avgSec))}</td>
      <td>${esc(signedEv(row.avgDev))}</td>
      <td>${esc(row.avgSpread.toFixed(3) + ' EV')}</td>
      <td>${esc(row.sigmaEv.toFixed(3) + ' EV')}</td>
      <td>${esc(formatScore(row.accuracyScore))}</td>
      <td>${row.openingSpeed != null && row.closingSpeed != null ? esc(row.openingSpeed.toFixed(2) + ' / ' + row.closingSpeed.toFixed(2)) : '—'}</td>
      <td>${row.flashDetected ? (row.flashBad ? '×' : (row.flashLate ? '●' : '●')) : '—'}</td>
    </tr>`;
  }).join('');
}

function evChartTickStep(limit) {
  if (limit <= 1) return 0.25;
  if (limit <= 2) return 0.5;
  return 1;
}

function targetBarsSvg(rows) {
  const measured = rows.filter(r => r.measured);
  if (!measured.length) return '';

  const bounds = measured.flatMap(row => {
    const spread = Math.max(0, Number(row.avgSpread) || 0);
    const halfSpread = spread / 2;
    return [row.avgDev - halfSpread, row.avgDev + halfSpread, row.avgDev];
  }).filter(Number.isFinite);

  const rawLimit = Math.max(0.5, ...bounds.map(v => Math.abs(v)));
  const tickStep = evChartTickStep(rawLimit);
  const limit = Math.ceil(rawLimit / tickStep) * tickStep;
  const width = 820;
  const left = 94;
  const right = 74;
  const top = 42;
  const bottom = 34;
  const rowH = 30;
  const plotW = width - left - right;
  const height = top + bottom + measured.length * rowH;
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

  const items = measured.map((row, i) => {
    const y = top + i * rowH;
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
      `<rect x="${barX.toFixed(1)}" y="${y - 9}" width="${barW.toFixed(1)}" height="16" rx="4"></rect>` +
      `<line class="error" x1="${errMinX.toFixed(1)}" x2="${errMaxX.toFixed(1)}" y1="${y - 1}" y2="${y - 1}"></line>` +
      `<line class="error-cap" x1="${errMinX.toFixed(1)}" x2="${errMinX.toFixed(1)}" y1="${y - 8}" y2="${y + 6}"></line>` +
      `<line class="error-cap" x1="${errMaxX.toFixed(1)}" x2="${errMaxX.toFixed(1)}" y1="${y - 8}" y2="${y + 6}"></line>` +
      `<text class="value" x="${valueX.toFixed(1)}" y="${y + 4}" text-anchor="${dx >= 0 ? 'start' : 'end'}">${esc(signedEv(row.avgDev))}</text>`;
  }).join('');

  return `<svg class="offset-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Exposure offset by target time">${axis}${items}</svg>`;
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

  const measured = rows
    .filter(r => r.measured && (Number.isFinite(r.openingSpeed) || Number.isFinite(r.closingSpeed)))
    .sort((a, b) => a.targetFrac - b.targetFrac);

  if (!measured.length) return '';

  const width = 820;
  const height = 318;
  const left = 70;
  const right = 34;
  const top = 34;
  const bottom = 76;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const allSpeeds = measured.flatMap(row => [row.openingSpeed, row.closingSpeed]).filter(v => Number.isFinite(v) && v > 0);
  const maxV = niceSpeedMax(Math.max(...allSpeeds) * 1.18);
  const xFor = index => left + (measured.length === 1 ? plotW / 2 : (index / (measured.length - 1)) * plotW);
  const yFor = value => top + plotH * (1 - Math.max(0, value) / maxV);

  const grid = [];
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const value = maxV * (1 - i / gridSteps);
    const y = top + plotH * (i / gridSteps);
    grid.push(`<line class="grid" x1="${left}" x2="${width - right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"></line>`);
    grid.push(`<text class="tick speed" x="${left - 9}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(value.toFixed(maxV < 10 ? 1 : 0))}</text>`);
  }

  const xAxis = measured.map((row, i) => {
    const x = xFor(i);
    return `<line class="grid soft" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top}" y2="${top + plotH}"></line>` +
      `<text class="tick target" x="${x.toFixed(1)}" y="${height - 36}" text-anchor="middle">${esc(targetLabel(row.targetFrac).replace(' s', ''))}</text>`;
  }).join('');

  function lineFor(key, cls) {
    const points = measured.map((row, i) => {
      const v = row[key];
      return Number.isFinite(v) && v > 0 ? { x: xFor(i), y: yFor(v), v, row } : null;
    }).filter(Boolean);
    if (!points.length) return '';
    const pointString = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const circles = points.map(p => `<circle class="${cls}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4"><title>${esc(targetLabel(p.row.targetFrac) + ': ' + p.v.toFixed(2) + ' m/s')}</title></circle>`).join('');
    return `<polyline class="curtain-line ${cls}" points="${pointString}"></polyline>${circles}`;
  }

  const axis = `<line class="axis" x1="${left}" x2="${left}" y1="${top}" y2="${top + plotH}"></line>` +
    `<line class="axis" x1="${left}" x2="${width - right}" y1="${top + plotH}" y2="${top + plotH}"></line>` +
    `<text class="axis-label y" x="16" y="${top + plotH / 2}" transform="rotate(-90 16 ${top + plotH / 2})" text-anchor="middle">m/s</text>` +
    `<text class="axis-label x" x="${left + plotW / 2}" y="${height - 13}" text-anchor="middle">${esc(tx('charts.targetSpeedAxis', 'Target speed (1/x s)'))}</text>`;

  return `<svg class="curtain-speed-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(tx('cards.curtainCurve', 'Curtain speed by target'))}">` +
    grid.join('') + xAxis + axis + lineFor('openingSpeed', 'opening') + lineFor('closingSpeed', 'closing') +
    `</svg>`;
}

function curtainSpeedReportSection(project, rows) {
  const chart = curtainSpeedSvg(project, rows);
  if (!chart) return '';
  return `<section class="chart-section curtain-speed-section"><h2>${esc(tx('cards.curtainCurve', 'Curtain speed by target'))}</h2>` +
    `<div class="chart-explainer"><p>${esc(tx('report.curtainSpeedExplanation', 'Average opening and closing curtain speed for each measured target time.'))}</p>` +
    `<div class="chart-legend"><div><span class="legend-line opening"></span><span>${esc(tx('charts.openingSpeed', 'Opening speed'))}</span></div>` +
    `<div><span class="legend-line closing"></span><span>${esc(tx('charts.closingSpeed', 'Closing speed'))}</span></div></div></div>` +
    chart + `</section>`;
}

function reportDataFieldsHtml(project, model, measuredCount, measuredTargets) {
  const fields = [
    { label: tx('report.maximumFlashTime', 'Maximum flash time'), value: model.flash.label, sub: model.flash.status },
    { label: tx('report.measurements', 'Measurements'), value: String(measuredCount), sub: tx('report.validProjectMeasurements', 'valid project measurements') },
    { label: tx('report.targetTimes', 'Target times'), value: measuredTargets + '/' + project.times.length, sub: tx('report.measuredTargets', 'measured target times') }
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
  const exportedAt = new Date().toLocaleString(uiLocale());
  const measuredCount = model.entries.length;
  const measuredTargets = model.measuredRows.length;
  const title = tx('report.title', 'Camera measurement report');
  const accBody = tx('report.accuracyBody', 'Based on measured exposure times and image-position spread. Spread is weighted higher than offset because uneven exposure is harder to compensate.');
  const relBody = tx('report.reliabilityBody', 'Based on differences between repeated measurements of the same target times. Single measurements are listed but not enough for reliability.');
  const curtainBody = tx('report.curtainBody', 'Based on local curtain-speed uniformity and the parallelism between opening and closing curtain speeds.');
  const overallLabel = scoreLabel(model.overall);
  const note = project.note ? `<section class="note"><h2>${esc(tx('report.projectNote', 'Project note'))}</h2><p>${esc(project.note)}</p></section>` : '';
  const template = await reportTemplateHtml();

  return renderReportTemplate(template, {
    LANG: esc(document.documentElement.lang || 'en'),
    PAGE_TITLE: esc(project.name + ' — ' + title),
    APP_VERSION: esc(APP_VERSION),
    PROJECT_NAME: esc(project.name),
    REPORT_TITLE: esc(title),
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
    SCORES_INTRO: esc(tx('report.scoresIntro', 'The rating separates exposure accuracy, repeatability and curtain travel. Old mechanical cameras are rated with tolerant thresholds.')),
    SCORE_CARDS: [
      reportScoreCard(tx('report.accuracy', 'Accuracy'), model.accuracyScore, accBody),
      reportScoreCard(tx('report.reliability', 'Reliability'), model.reliabilityScore, relBody),
      reportScoreCard(tx('report.curtainCondition', 'Curtain condition'), model.curtain.curtainScore, curtainBody),
    ].join(''),
    DATA_TITLE: esc(tx('report.dataTitle', 'Camera data')),
    EXPOSURE_OFFSETS_TITLE: esc(tx('report.exposureOffsets', 'Exposure offsets')),
    EXPOSURE_OFFSETS_EXPLANATION: esc(tx('report.exposureOffsetsExplanation', 'The horizontal scale is measured in EV. Bars to the left of 0 EV are faster than the selected time, bars to the right are slower.')),
    EXPOSURE_BAR_LEGEND: esc(tx('report.exposureBarLegend', 'Bar: average exposure offset')),
    EXPOSURE_ERROR_LEGEND: esc(tx('report.exposureErrorLegend', 'Whisker: spread across the image')),
    OFFSET_CHART: targetBarsSvg(model.targetRows),
    CURTAIN_SPEED_SECTION: curtainSpeedReportSection(project, model.targetRows),
    DATA_FIELDS: reportDataFieldsHtml(project, model, measuredCount, measuredTargets),
    PROJECT_NOTE: note,
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
