// Engraved contour lines, like a reef chart or the ridges of a palm.
// Seeded by a string (the account number) so every wallet card is unique
// and stable across visits.

function rng(seedStr) {
  let h = 2166136261;
  for (const ch of seedStr) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function loop(cx, cy, r, wobble, phase, points = 64) {
  const pts = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const k = 1 + wobble * (0.55 * Math.sin(3 * a + phase) + 0.3 * Math.sin(5 * a - phase * 1.7) + 0.15 * Math.sin(2 * a + phase * 0.6));
    pts.push([cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k * 0.82]);
  }
  // Closed Catmull-Rom spline -> cubic Béziers
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < points; i++) {
    const p0 = pts[(i - 1 + points) % points], p1 = pts[i], p2 = pts[(i + 1) % points], p3 = pts[(i + 2) % points];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d + 'Z';
}

export function contourSVG(seed, { width = 400, height = 240, rings = 14, color = '#2ec4b6', opacity = 0.22, cls = 'contour' } = {}) {
  const r = rng(seed || 'palmpay');
  const cx = width * (0.62 + r() * 0.3);
  const cy = height * (0.15 + r() * 0.5);
  const phase = r() * Math.PI * 2;
  const step = Math.max(width, height) / rings * 0.9;
  let paths = '';
  for (let i = 1; i <= rings; i++) {
    const o = (opacity * (1 - i / (rings + 4))).toFixed(3);
    paths += `<path d="${loop(cx, cy, i * step, 0.06 + i * 0.012, phase + i * 0.35)}" stroke-opacity="${o}"/>`;
  }
  return `<svg class="${cls}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid slice" fill="none" stroke="${color}" stroke-width="1.1" aria-hidden="true">${paths}</svg>`;
}
