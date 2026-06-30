// Timeline drawing, curtain speed charts, flash sync visualization, and canvas helpers.

// Return whether speed-chart interpolation is enabled.
function chartInterpolationEnabled() {
  return !!(S.uiSettings && S.uiSettings.interpolateCharts);
}

function ensureChartTooltip(canvas) {
  if (!canvas || !canvas.parentElement) return null;
  const parent = canvas.parentElement;
  if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  let tip = parent.querySelector('.chart-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tooltip';
    parent.appendChild(tip);
  }
  return tip;
}

function bindCanvasPointTooltip(canvas, points) {
  if (!canvas) return;
  canvas._oclTooltipPoints = Array.isArray(points) ? points : [];
  const tip = ensureChartTooltip(canvas);
  if (!tip) return;
  if (canvas._oclTooltipBound) {
    tip.style.display = 'none';
    return;
  }
  canvas._oclTooltipBound = true;

  canvas.addEventListener('mousemove', event => {
    const pts = canvas._oclTooltipPoints || [];
    if (!pts.length) { tip.style.display = 'none'; return; }
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width ? canvas.clientWidth / rect.width : 1;
    const sy = rect.height ? canvas.clientHeight / rect.height : 1;
    const mx = (event.clientX - rect.left) * sx;
    const my = (event.clientY - rect.top) * sy;
    let best = null;
    let bestDist = Infinity;
    pts.forEach(point => {
      const dx = mx - point.x;
      const dy = my - point.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) { bestDist = dist; best = point; }
    });
    if (!best || bestDist > 14) { tip.style.display = 'none'; return; }
    tip.innerHTML = best.html || '';
    tip.style.display = 'block';
    const left = Math.min(canvas.clientWidth - tip.offsetWidth - 6, Math.max(6, best.x + 10));
    const top = Math.min(canvas.clientHeight - tip.offsetHeight - 6, Math.max(6, best.y - tip.offsetHeight - 10));
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  });

  canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
}

// Return speed points in display order without extending them beyond the measured segment centers.
function speedSeriesForChart(points) {
  if (!Array.isArray(points) || !points.length) return points || [];
  return points.slice().sort((a, b) => a.x - b.x);
}


// Extend a measured speed path visually to the full sensor span. These segments
// are deliberately dashed because they are display continuity only, not measured
// speed samples.
function drawSpeedEdgeExtensions(ctx, points, minX, maxX, toX, toY) {
  if (!points.length) return;
  const line = points.slice().sort((a, b) => a.x - b.x);
  const first = line[0];
  const last = line[line.length - 1];
  const eps = 0.0001;

  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.globalAlpha = 0.72;
  ctx.lineWidth = Math.max(1, ctx.lineWidth * 0.85);

  if (first.x > minX + eps) {
    ctx.beginPath();
    ctx.moveTo(toX(minX), toY(first.v));
    ctx.lineTo(toX(first.x), toY(first.v));
    ctx.stroke();
  }

  if (last.x < maxX - eps) {
    ctx.beginPath();
    ctx.moveTo(toX(last.x), toY(last.v));
    ctx.lineTo(toX(maxX), toY(last.v));
    ctx.stroke();
  }

  ctx.restore();
}

// Draw one curtain-speed path on the chart canvas.
function drawSpeedPath(ctx, points, toX, toY, smooth) {
  if (!points.length) return;
  const px = points.map(point => ({ x: toX(point.x), y: toY(point.v) }));
  ctx.beginPath();
  ctx.moveTo(px[0].x, px[0].y);

  if (!smooth || px.length < 3) {
    for (let i = 1; i < px.length; i++) ctx.lineTo(px[i].x, px[i].y);
    return;
  }

  // Smooth interpolation keeps the calculated speed points fixed and rounds the
  // line between them.
  for (let i = 0; i < px.length - 1; i++) {
    const p0 = px[i - 1] || px[i];
    const p1 = px[i];
    const p2 = px[i + 1];
    const p3 = px[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
  }
}

// Collect ordered sensor samples for curtain-speed calculation.
function getCurtainSamples(entry) {
  if (!entry || normalizeMeasurementMode(entry.mode) === 'central') return null;
  const sensors = (entry.sensors || [])
    .map((sensor, index) => ({ ...sensor, index: Number.isFinite(Number(sensor.id)) ? Number(sensor.id) : index }))
    .filter(sensor => sensor.activated && Number.isFinite(sensor.openMs) && Number.isFinite(sensor.closeMs));
  if (sensors.length < 2) return null;

  const distanceMm = distanceForMode(entry.mode, entry);
  if (distanceMm == null) return null;

  // The chart always uses the full five-sensor physical span. The first sensor
  // in the detected travel direction (S0 or S4) is position 0 mm. Speed points
  // are placed halfway between the available sensor positions, so missing
  // intermediate sensors keep the physical scale intact.
  const ordered = sensors.sort((a, b) => a.openMs - b.openMs);
  const firstIndex = ordered[0].index;
  const lastIndex = ordered[ordered.length - 1].index;
  const originIndex = firstIndex > lastIndex ? 4 : 0;
  const positioned = ordered.map(sensor => ({
    ...sensor,
    positionMm: Math.abs(sensor.index - originIndex) * distanceMm,
  }));

  return { sensors: positioned, distanceMm, originIndex };
}

// Convert sensor timing samples into curtain-speed segments.
function curtainSpeedProfile(entry) {
  const sample = getCurtainSamples(entry);
  if (!sample) return null;
  const { sensors: act, distanceMm, reverseAxis } = sample;
  const open = [];
  const close = [];

  for (let i = 1; i < act.length; i++) {
    const prev = act[i - 1];
    const cur = act[i];
    const physicalDistanceMm = Math.abs(cur.index - prev.index) * distanceMm;
    if (physicalDistanceMm <= 0) continue;

    const x = (prev.positionMm + cur.positionMm) / 2;
    const dtOpen = cur.openMs - prev.openMs;
    const dtClose = cur.closeMs - prev.closeMs;
    if (dtOpen > 0) open.push({ x, v: physicalDistanceMm / dtOpen, sensorGap: Math.abs(cur.index - prev.index) });
    if (dtClose > 0) close.push({ x, v: physicalDistanceMm / dtClose, sensorGap: Math.abs(cur.index - prev.index) });
  }

  return {
    open,
    close,
    distanceMm,
    maxPositionMm: distanceMm * 4,
    sensorCount: act.length,
    originIndex: sample.originIndex,
  };
}

// Draw the combined sensor timing and curtain-speed chart.
function drawCurtainTimeChart(entry) {
  const canvas = document.getElementById('curtain-time-chart');
  if (!canvas) return;

  const profile = curtainSpeedProfile(entry);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = canvas.parentElement.clientWidth || 600;
  const H = window.innerWidth <= 600 ? 252 : 282;

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const C = {
    bg: '#131613',
    grid: '#222622',
    axis: '#3d443d',
    text: '#7a8a7a',
    text2: '#b8c4b8',
  };

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  const PAD_L = 64;
  const PAD_R = 24;
  const PAD_T = 24;
  const PAD_B = 72;
  const PW = W - PAD_L - PAD_R;
  const PH = H - PAD_T - PAD_B;

  if (!profile || (!profile.open.length && !profile.close.length)) {
    ctx.fillStyle = C.text;
    ctx.font = `11px 'Share Tech Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.fillText(tx('charts.notEnoughCurtain', 'Not enough sensor points for curtain chart'), W / 2, H / 2);
    bindCanvasPointTooltip(canvas, []);
    return;
  }

  const all = [...profile.open, ...profile.close];
  const maxX = Math.max(profile.maxPositionMm || 0, profile.distanceMm || 0, 1);
  const vMax = Math.max(...all.map(point => Math.abs(point.v)), 1) * 1.20;
  const toX = x => PAD_L + (x / maxX) * PW;
  const toY = v => PAD_T + PH * (1 - v / vMax);

  // Horizontal speed grid.
  ctx.save();
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.font = `9px 'Share Tech Mono', monospace`;
  ctx.textAlign = 'right';
  ctx.fillStyle = C.text;
  const yGrid = 4;
  for (let i = 0; i <= yGrid; i++) {
    const y = PAD_T + (i / yGrid) * PH;
    ctx.beginPath();
    ctx.moveTo(PAD_L, y);
    ctx.lineTo(W - PAD_R, y);
    ctx.stroke();
    const v = vMax * (1 - i / yGrid);
    ctx.fillText(formatFixed(v, 2), PAD_L - 6, y + 3);
  }
  ctx.restore();

  // Vertical position grid over the full five-sensor span.
  ctx.save();
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.font = `10px 'Share Tech Mono', monospace`;
  ctx.fillStyle = C.text;
  ctx.textAlign = 'center';
  const xGridSteps = Math.max(1, Math.round(maxX / Math.max(profile.distanceMm, 0.001)));
  for (let i = 0; i <= xGridSteps; i++) {
    const pos = Math.min(i * profile.distanceMm, maxX);
    const x = toX(pos);
    ctx.beginPath();
    ctx.moveTo(x, PAD_T);
    ctx.lineTo(x, PAD_T + PH);
    ctx.stroke();
    ctx.fillText(formatFixed(pos, 2), x, PAD_T + PH + 17);
  }
  ctx.restore();

  // Axes and labels.
  ctx.save();
  ctx.strokeStyle = C.axis;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PAD_L, PAD_T);
  ctx.lineTo(PAD_L, PAD_T + PH);
  ctx.lineTo(W - PAD_R, PAD_T + PH);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.font = `9px 'Share Tech Mono', monospace`;
  ctx.fillStyle = C.text;
  ctx.textAlign = 'center';
  ctx.translate(16, PAD_T + PH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(tx('charts.speedAxis', 'SPEED (m/s)'), 0, 0);
  ctx.restore();

  ctx.save();
  ctx.font = `10px 'Share Tech Mono', monospace`;
  ctx.fillStyle = C.text;
  ctx.textAlign = 'center';
  ctx.fillText(tx('charts.positionAxis', 'POSITION (mm)'), PAD_L + PW / 2, PAD_T + PH + 37);
  ctx.restore();

  const hoverPoints = [];

  function drawLine(arr, color, label) {
    if (!arr.length) return;
    const line = speedSeriesForChart(arr);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    drawSpeedEdgeExtensions(ctx, line, 0, maxX, toX, toY);
    drawSpeedPath(ctx, line, toX, toY, chartInterpolationEnabled());
    ctx.stroke();
    arr.forEach(point => {
      const px = toX(point.x);
      const py = toY(point.v);
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = C.bg;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      hoverPoints.push({
        x: px,
        y: py,
        html: `<strong>${esc(label || '')}</strong><br>${esc(formatMm(point.x))}<br>${esc(formatMetersPerSecond(point.v))}`
      });
    });
    ctx.restore();
  }

  drawLine(profile.open, '#52c4b0', tx('charts.openingSpeed', 'Opening speed'));
  drawLine(profile.close, '#68a8e0', tx('charts.closingSpeed', 'Closing speed'));

  ctx.font = `9px 'Share Tech Mono', monospace`;
  function legendItemLeft(x, y, color, label) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 3);
    ctx.lineTo(x + 18, y - 3);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 22, y);
  }

  function legendItemRight(xRight, y, color, label) {
    const textWidth = ctx.measureText(label).width;
    const textLeft = xRight - textWidth;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(textLeft - 24, y - 3);
    ctx.lineTo(textLeft - 6, y - 3);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'right';
    ctx.fillText(label, xRight, y);
  }

  const ly = PAD_T + PH + 37;
  legendItemLeft(PAD_L + 8, ly, '#52c4b0', tx('charts.openingSpeed', 'Opening speed'));
  legendItemRight(W - PAD_R, ly, '#68a8e0', tx('charts.closingSpeed', 'Closing speed'));
  bindCanvasPointTooltip(canvas, hoverPoints);
}

// ════════════════════════════════════════════
   // TIMELINE CANVAS
// ════════════════════════════════════════════
function drawTimeline(entry) {
  const canvas = document.getElementById('tl');
  if (!canvas) return;

  const isMobile = window.innerWidth <= 600;
  if (isMobile) { drawTimelineVertical(entry, canvas); return; }

  const dpr    = Math.min(window.devicePixelRatio || 1, 2);
  const W      = canvas.parentElement.clientWidth || 600;
  const active = entry.sensors.filter(s => s.activated);
  if (!active.length) return;

  // Layout constants
  const PAD_L   = 64;
  const PAD_R   = 68;
  // Space for the axis at the top.
  const PAD_T   = 36;
  // Space for the axis at the bottom.
  const PAD_B   = 38;
  const ROW_H   = 34;
  const BAR_H   = 16;
  const H       = PAD_T + active.length * ROW_H + PAD_B;

  canvas.width        = W * dpr;
  canvas.height       = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Colors from CSS vars → parse once
  const C = {
    bg:    '#131613',
    grid:  '#222622',
    axis:  '#3d443d',
    text:  '#7a8a7a',
    text2: '#b8c4b8',
    text3: '#f0f4f0',
  };

  // Background
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);

  // Time range in ms (relative to first open)
  const scale = getMeasurementTimeScale(entry);
  if (!scale) return;
  const { tMin, T0, T1, range } = scale;

  const toX = t => PAD_L + (t - T0) / range * (W - PAD_L - PAD_R);

  // ── GRID + X-AXIS TICKS ────────────────────
  // Choose a readable tick interval.
  const drawW    = W - PAD_L - PAD_R;
  const maxTicks = Math.max(3, Math.floor(drawW / 70));
  const tickInt  = niceInterval(range, maxTicks);
  const tickStart = Math.ceil(T0 / tickInt) * tickInt;

  ctx.save();
  ctx.strokeStyle = C.grid;
  ctx.lineWidth   = 1;
  ctx.setLineDash([3, 4]);
  ctx.font        = `10px 'Share Tech Mono', monospace`;
  ctx.fillStyle   = C.text;
  ctx.textAlign   = 'center';

  for (let t = tickStart; t <= T1 + tickInt * 0.01; t += tickInt) {
    const x = toX(t);
    if (x < PAD_L - 1 || x > W - PAD_R + 1) continue;

    // Vertical grid line
    ctx.beginPath();
    ctx.moveTo(x, PAD_T - 6);
    ctx.lineTo(x, H - PAD_B + 6);
    ctx.stroke();

    // Tick mark on bottom axis
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = C.axis;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, H - PAD_B);
    ctx.lineTo(x, H - PAD_B + 5);
    ctx.stroke();
    ctx.restore();

    // Label: relative ms from first open
    const relMs = t - tMin;
    let label;
    if (tickInt < 0.1)       label = formatMs(relMs);
    else if (tickInt < 1)    label = formatMs(relMs);
    else if (tickInt < 10)   label = formatMs(relMs);
    else                     label = formatMs(relMs);
    ctx.fillText(label, x, H - PAD_B + 17);
  }
  ctx.restore();

  // Top axis line
  ctx.strokeStyle = C.axis;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD_L, PAD_T - 6); ctx.lineTo(W - PAD_R, PAD_T - 6); ctx.stroke();
  // Bottom axis line
  ctx.beginPath(); ctx.moveTo(PAD_L, H - PAD_B); ctx.lineTo(W - PAD_R, H - PAD_B); ctx.stroke();

  // Axis title
  ctx.fillStyle   = C.text;
  ctx.font        = `9px 'Share Tech Mono', monospace`;
  ctx.textAlign   = 'center';
  ctx.fillText(tx('charts.timeRelative', 'TIME (ms, relative to first opening)'), W / 2, H - 6);

  // "ID" label area
  ctx.fillStyle = C.grid;
  ctx.fillRect(0, 0, PAD_L - 2, H);
  ctx.fillStyle = C.text;
  ctx.font = `9px 'Share Tech Mono', monospace`;
  ctx.textAlign = 'right';
  ctx.fillText('ID', PAD_L - 6, PAD_T - 14);


  // Flashzeitpunkt als vertikale Linie
  if (entry.flash && entry.flash.detected && entry.flash.triggerMs != null) {
    const fx = toX(entry.flash.triggerMs);
    if (fx >= PAD_L && fx <= W - PAD_R) {
      ctx.save();
      ctx.strokeStyle = flashSyncColor(entry);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(fx, PAD_T - 10);
      ctx.lineTo(fx, H - PAD_B + 8);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = `10px 'Share Tech Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('FLASH', fx, PAD_T - 16);
      ctx.restore();
    }
  }

  // ── ID BARS ─────────────────────────────
  let row = 0;
  entry.sensors.forEach((s, si) => {
    if (!s.activated) return;

    const cy  = PAD_T + row * ROW_H + ROW_H / 2;
    const barY = cy - BAR_H / 2;

    // Sensor label
    ctx.save();
    ctx.fillStyle   = ID_COLORS[si];
    ctx.font        = `bold 11px 'Share Tech Mono', monospace`;
    ctx.textAlign   = 'right';
    ctx.fillText('id ' + si, PAD_L - 8, cy + 4);
    ctx.restore();

    // Track zero reference (thin)
    ctx.save();
    ctx.strokeStyle = '#2a2e2a';
    ctx.lineWidth   = 1;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD_L, cy); ctx.lineTo(W - PAD_R, cy);
    ctx.stroke();
    ctx.restore();

    const xO = toX(s.openMs);
    const xC = toX(s.closeMs);
    const bw = Math.max(xC - xO, 2);

    // Glow background
    ctx.save();
    const grd = ctx.createLinearGradient(xO, 0, xC, 0);
    grd.addColorStop(0,   ID_BG[si]);
    grd.addColorStop(0.2, ID_COLORS[si] + 'aa');
    grd.addColorStop(0.8, ID_COLORS[si] + 'aa');
    grd.addColorStop(1,   ID_BG[si]);
    ctx.fillStyle = grd;
    ctx.fillRect(xO, barY, bw, BAR_H);

    // Bar border
    ctx.strokeStyle = ID_COLORS[si];
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(xO + 0.75, barY + 0.75, bw - 1.5, BAR_H - 1.5);
    ctx.restore();

    // Open / Close tick lines
    ctx.save();
    ctx.strokeStyle = ID_COLORS[si];
    ctx.lineWidth   = 1.5;
    [[xO, '▶'], [xC, '◀']].forEach(([x]) => {
      ctx.beginPath();
      ctx.moveTo(x, barY - 5);
      ctx.lineTo(x, barY + BAR_H + 5);
      ctx.stroke();
    });
    ctx.restore();

    // Duration label inside bar (if wide enough)
    const durMs = formatFixed(s.closeMs - s.openMs, 2);
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.font      = `9px 'Share Tech Mono', monospace`;
    ctx.textAlign = 'center';
    const midX = (xO + xC) / 2;
    if (bw > 36) ctx.fillText(durMs + ' ms', midX, cy + 3);
    // Open timestamp label above left edge
    ctx.fillStyle   = ID_COLORS[si];
    ctx.textAlign   = 'left';
    ctx.font        = `8px 'Share Tech Mono', monospace`;
    ctx.fillText('+' + s.openMs.toFixed(2) + 'ms', xO + 2, barY - 7);
    ctx.restore();

    row++;
  });

  // Stripe between rows
  for (let r = 1; r < active.length; r++) {
    const y = PAD_T + r * ROW_H - 1;
    ctx.strokeStyle = '#1e221e';
    ctx.lineWidth   = 1;
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
  }
}


// ════════════════════════════════════════════
   // TOTAL OPEN TIME
   // Time between last sensor opening and first sensor closing (ms)
   // Can be negative (flash sync territory)
// ════════════════════════════════════════════
function calcTotalOpenTime(entry) {
  const act = entry.sensors.filter(s => s.activated);
  if (!act.length) return 0;
  const lastOpen  = Math.max(...act.map(s => s.openMs));
  const firstClose= Math.min(...act.map(s => s.closeMs));
  // A negative value means the curtains overlap.
  return firstClose - lastOpen;
}

// Return the time window when all activated sensors were open.
function getTotalOpenWindow(entry) {
  const act = entry.sensors.filter(s => s.activated);
  if (!act.length) return null;
  const lastOpen = Math.max(...act.map(s => s.openMs));
  const firstClose = Math.min(...act.map(s => s.closeMs));
  return { startMs: lastOpen, endMs: firstClose };
}

const FLASH_SYNC_LATE_MARGIN_MS = 2;

// Return the detailed flash-sync state for the useful open window.
function flashSyncState(entry) {
  if (!entry || !entry.flash || !entry.flash.detected || entry.flash.triggerMs == null) return 'none';
  const w = getTotalOpenWindow(entry);
  if (!w) return 'bad';
  const trigger = Number(entry.flash.triggerMs);
  if (!Number.isFinite(trigger) || trigger < w.startMs || trigger > w.endMs) return 'bad';
  return trigger >= (w.endMs - FLASH_SYNC_LATE_MARGIN_MS) ? 'late' : 'ok';
}

// Check whether the flash trigger occurred during the useful open window.
function isFlashSyncOk(entry) {
  const state = flashSyncState(entry);
  if (state === 'none') return null;
  return state === 'ok' || state === 'late';
}

// Return a drawing color for the detailed flash-sync state.
function flashSyncColor(entry) {
  const state = flashSyncState(entry);
  if (state === 'ok') return '#56c47e';
  if (state === 'late') return '#f5b030';
  if (state === 'bad') return '#e86060';
  return '#4a564a';
}

// Return HTML for the flash-sync status icon.
function flashSyncIcon(entry) {
  const state = flashSyncState(entry);
  if (state === 'ok') return `<span title="${esc(tx('flash.within', 'Flash within total opening'))}" style="color:var(--green);font-size:16px;">●</span>`;
  if (state === 'late') return `<span title="${esc(tx('flash.late', 'Flash near the end of total opening'))}" style="color:var(--amber);font-size:16px;">●</span>`;
  if (state === 'bad') return `<span title="${esc(tx('flash.outside', 'Flash outside total opening'))}" style="color:var(--red);font-size:16px;">×</span>`;
  return `<span title="${esc(tx('flash.none', 'No flash detected'))}" style="color:var(--tx4);font-size:16px;">-</span>`;
}

// ════════════════════════════════════════════
   // VERTICAL TIMELINE (mobile)
   // X = sensors, Y = time axis
// ════════════════════════════════════════════
function drawTimelineVertical(entry, canvas) {
  const dpr    = Math.min(window.devicePixelRatio || 1, 2);
  const active = entry.sensors.filter(s => s.activated);
  if (!active.length) return;

  const COL_W  = 56;
  const PAD_T  = 20;
  const PAD_B  = 82;
  const PAD_L  = 50;
  const PAD_R  = 12;
  const W      = Math.max(canvas.parentElement.clientWidth, active.length * COL_W + PAD_L + PAD_R);
  // Mobile layout needs a longer vertical timeline
  const H      = Math.max(520, Math.min(760, Math.round(window.innerHeight * 0.68)));

  canvas.width  = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const C = { bg:'#131613', grid:'#222622', axis:'#3d443d', text:'#7a8a7a' };
  ctx.fillStyle = C.bg; ctx.fillRect(0,0,W,H);

  let tMin=Infinity, tMax=-Infinity;
  active.forEach(s => { tMin=Math.min(tMin,s.openMs); tMax=Math.max(tMax,s.closeMs); });
  const span=tMax-tMin||0.1, pad=span*0.1;
  const T0=tMin-pad, T1=tMax+pad, range=T1-T0;
  const PH = H-PAD_T-PAD_B;
  const toY = t => PAD_T + (t-T0)/range*PH;

  // horizontal grid
  const tickInt = niceInterval(range, Math.max(3,Math.floor(PH/40)));
  const tickStart = Math.ceil(T0/tickInt)*tickInt;

  ctx.strokeStyle=C.grid; ctx.lineWidth=1; ctx.setLineDash([2,4]);
  for(let t=tickStart; t<=T1; t+=tickInt){
    const y=toY(t); if(y<PAD_T||y>H-PAD_B) continue;
    ctx.beginPath(); ctx.moveTo(PAD_L,y); ctx.lineTo(W-PAD_R,y); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle=C.axis; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(PAD_L,PAD_T); ctx.lineTo(PAD_L,H-PAD_B); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(PAD_L,H-PAD_B); ctx.lineTo(W-PAD_R,H-PAD_B); ctx.stroke();

  // Y tick labels
  ctx.fillStyle=C.text; ctx.font=`8px 'Share Tech Mono',monospace`; ctx.textAlign='right';
  for(let t=tickStart; t<=T1; t+=tickInt){
    const y=toY(t); if(y<PAD_T||y>H-PAD_B) continue;
    const rel=t-tMin;
    ctx.fillText((rel < 0 ? '' : '+') + formatFixed(rel, 2), PAD_L - 3, y + 3);
  }

  // Draw the flash trigger as a dashed line if the packet contains one.
  if (entry.flash && entry.flash.detected && entry.flash.triggerMs != null) {
    const fy = toY(entry.flash.triggerMs);
    if (fy >= PAD_T && fy <= H - PAD_B) {
      ctx.save();
      ctx.strokeStyle = flashSyncColor(entry);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD_L, fy);
      ctx.lineTo(W - PAD_R, fy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.font = `9px 'Share Tech Mono',monospace`;
      ctx.textAlign = 'left';
      ctx.fillText('FLASH', PAD_L + 4, fy - 4);
      ctx.restore();
    }
  }

  // Bars per sensor
  let col=0;
  entry.sensors.forEach((s,si)=>{
    if(!s.activated) return;
    const cx = PAD_L + col*COL_W + COL_W/2;
    const bw = COL_W*0.45;
    const yO = toY(s.openMs), yC = toY(s.closeMs);
    const bh = Math.max(yC-yO, 2);
    const grd = ctx.createLinearGradient(0,yO,0,yC);
    grd.addColorStop(0, ID_BG[si]);
    grd.addColorStop(0.3, ID_COLORS[si]+'aa');
    grd.addColorStop(0.7, ID_COLORS[si]+'aa');
    grd.addColorStop(1, ID_BG[si]);
    ctx.fillStyle=grd; ctx.fillRect(cx-bw/2, yO, bw, bh);
    ctx.strokeStyle=ID_COLORS[si]; ctx.lineWidth=1.5;
    ctx.strokeRect(cx-bw/2+0.75, yO+0.75, bw-1.5, bh-1.5);
    // label
    ctx.fillStyle=ID_COLORS[si]; ctx.font=`bold 10px 'Share Tech Mono',monospace`;
    ctx.textAlign='center'; ctx.fillText('id '+si, cx, H-PAD_B+14);
    col++;
  });

  ctx.fillStyle=C.text; ctx.font=`8px 'Share Tech Mono',monospace`;
  ctx.textAlign='center';
  ctx.fillText('ms', PAD_L/2, PAD_T+PH/2);
}
