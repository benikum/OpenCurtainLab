// Shared formatting, timing scale, and download helpers.

// OpenCurtainLab Web UI
// ---------------------
// This file intentionally stays dependency-free so it can be served directly
// from the device, GitHub Pages, or a local web server.
//
// Responsibilities:
// - keep the browser-side application state in `S`
// - poll the OpenCurtainLab device API
// - convert raw timing packets into user-facing measurements
// - manage projects, project notes, backup/import and CSV export
// - draw timelines and curtain diagnostics on canvas

// Shared formatting and download helpers used throughout the UI.
function devStatus(ev) {
  const abs = Math.abs(Number(ev) || 0);
  if (abs <= 0.10) return { level: 'ok',   color: 'var(--green)'  };
  if (abs <= 0.30) return { level: 'warn', color: 'var(--orange)' };
  return { level: ev > 0 ? 'pos' : 'neg', color: 'var(--red)' };
}

// Choose the small status indicator color for a device state.
function devColor(ev) { return devStatus(ev).color; }
// Choose the CSS class used for a device state.
function devClass(ev) { return devStatus(ev).level; }

// Format a time interval in compact human-readable form.
function niceInterval(range, maxTicks) {
  const raw = Math.max(Math.abs(range) / Math.max(maxTicks, 1), Number.EPSILON);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const n of [1, 2, 2.5, 5, 10]) if (n * mag >= raw) return n * mag;
  return 10 * mag;
}

// Pick the best time unit for displaying a measurement timeline.
function getMeasurementTimeScale(entry, padRatio = 0.10) {
  const active = (entry && entry.sensors ? entry.sensors : [])
    .filter(s => s.activated && Number.isFinite(s.openMs) && Number.isFinite(s.closeMs));
  if (!active.length) return null;
  const tMin = Math.min(...active.map(s => s.openMs));
  const tMax = Math.max(...active.map(s => s.closeMs));
  const span = tMax - tMin || 0.1;
  const pad = Math.max(span * padRatio, 0.05);
  const T0 = tMin - pad;
  const T1 = tMax + pad;
  return { tMin, tMax, T0, T1, range: T1 - T0 || 1 };
}

// Create a filesystem-safe timestamp for exported files.
function timestampForFilename(date = new Date()) {
  return date.getFullYear() + '-' +
    String(date.getMonth() + 1).padStart(2, '0') + '-' +
    String(date.getDate()).padStart(2, '0') + '_' +
    String(date.getHours()).padStart(2, '0') +
    String(date.getMinutes()).padStart(2, '0');
}

// Download generated text data as a local file.
function downloadTextFile(text, filename, mime = 'text/plain;charset=utf-8;') {
  const blob = new Blob([text], { type: mime });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: filename,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}
