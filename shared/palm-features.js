// Palm feature extraction, shared by the browser scanner and the server tests.
//
// Input: the 21 hand landmarks MediaPipe HandLandmarker returns per hand.
//   0 wrist | 1-4 thumb | 5-8 index | 9-12 middle | 13-16 ring | 17-20 pinky
// Output: a vector of bone and palm lengths divided by palm width, so it does not
// depend on how far the hand is from the camera. Bone lengths also stay the same
// when fingers bend, which keeps the vector stable between scans.
//
// This is HAND GEOMETRY, a demo-grade biometric. It can tell a handful of
// people apart in a demo; it is not secure enough for real money. Production
// replaces this file with a vendor SDK (palm vein / palmprint) behind the
// BiometricMatcher port. Nothing else in the app needs to change.

export const FEATURE_MODEL = 'mp-handgeom-v1';

// Pairs of landmark indices whose distance becomes one feature.
export const FEATURE_PAIRS = [
  // thumb bones
  [1, 2], [2, 3], [3, 4],
  // index, middle, ring, pinky bones (MCP-PIP, PIP-DIP, DIP-TIP)
  [5, 6], [6, 7], [7, 8],
  [9, 10], [10, 11], [11, 12],
  [13, 14], [14, 15], [15, 16],
  [17, 18], [18, 19], [19, 20],
  // palm length from wrist to each knuckle
  [0, 5], [0, 9], [0, 13], [0, 17],
  // knuckle spacing
  [5, 9], [9, 13], [13, 17],
  // thumb base to index knuckle
  [1, 5],
];

const PALM_WIDTH = [5, 17];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

/** @param {{x:number,y:number,z:number}[]} points 21 world landmarks (metres) */
export function extractFeatures(points) {
  if (!Array.isArray(points) || points.length !== 21) return null;
  const width = dist(points[PALM_WIDTH[0]], points[PALM_WIDTH[1]]);
  if (!(width > 1e-6)) return null;
  return FEATURE_PAIRS.map(([i, j]) => round4(dist(points[i], points[j]) / width));
}

/**
 * Checks one frame of normalised image landmarks (0..1) for scan quality.
 * Returns the first problem found, or null when the frame is usable.
 */
export function frameProblem(imagePoints) {
  if (!imagePoints || imagePoints.length !== 21) return 'no_hand';
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const p of imagePoints) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const size = Math.max(maxX - minX, maxY - minY);
  if (size < 0.28) return 'too_far';
  if (size > 0.95) return 'too_close';
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  if (Math.abs(cx - 0.5) > 0.22 || Math.abs(cy - 0.5) > 0.22) return 'off_center';
  // Fingers open: each fingertip is further from the wrist than its middle joint.
  const w = imagePoints[0];
  for (const [pip, tip] of [[6, 8], [10, 12], [14, 16], [18, 20]]) {
    if (dist2d(w, imagePoints[tip]) < dist2d(w, imagePoints[pip]) * 1.05) return 'fingers_closed';
  }
  return null;
}

const dist2d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Per-feature median across many frames: robust to the odd bad frame. */
export function medianVector(vectors) {
  if (!vectors.length) return null;
  const n = vectors[0].length;
  const out = new Array(n);
  for (let k = 0; k < n; k++) {
    const col = vectors.map((v) => v[k]).sort((a, b) => a - b);
    const m = col.length >> 1;
    out[k] = round4(col.length % 2 ? col[m] : (col[m - 1] + col[m]) / 2);
  }
  return out;
}

/** Mean relative distance between two vectors; 0 = identical. */
export function relativeDistance(a, b) {
  let total = 0;
  for (let k = 0; k < a.length; k++) {
    const mean = (Math.abs(a[k]) + Math.abs(b[k])) / 2 || 1;
    total += Math.abs(a[k] - b[k]) / mean;
  }
  return total / a.length;
}

/** How much the captured frames disagreed with their median (lower is steadier). */
export function spreadOf(vectors, median) {
  if (!vectors.length) return 1;
  return round4(vectors.reduce((acc, v) => acc + relativeDistance(v, median), 0) / vectors.length);
}

// --- Liveness: tremor -------------------------------------------------------
//
// A real hand is never perfectly still. Muscles keep the fingers trembling and
// drifting very slightly, and each finger moves a little on its own.
// A photo or a screen showing a hand can be moved, tilted and zoomed, but it
// moves as ONE flat sheet: every point follows the same straight-line
// (affine) motion.
//
// So for each frame we find the affine transform that best maps it onto a
// reference shape, and keep only what that transform cannot explain: the
// fingers' independent motion. The score is how much that leftover motion
// varies over the scan, in palm widths. Higher = more alive.
//
// Demo grade: the camera's own landmark noise adds to the score, and a video
// of a real hand still passes. Tune MIN_TREMOR with real hands and photos.

/**
 * @param {{x:number,y:number}[][]} frames image landmarks (0..1) per frame, 21 points each
 * @param {number} aspect video width / height, so x and y are in the same units
 * @returns {number|null} tremor score in palm widths, or null if there are too few frames
 */
export function tremorScore(frames, aspect = 1) {
  const pts = frames
    .filter((f) => f && f.length === 21)
    .map((f) => f.map((p) => [p.x * aspect, p.y]));
  if (pts.length < 6) return null;

  // Reference shape: align everything to the middle frame, average, align again.
  let ref = pts[pts.length >> 1];
  for (let pass = 0; pass < 2; pass++) {
    const aligned = pts.map((f) => alignAffine(f, ref)).filter(Boolean);
    if (aligned.length < 6) return null;
    ref = ref.map((_, i) => [mean(aligned.map((a) => a[i][0])), mean(aligned.map((a) => a[i][1]))]);
  }
  const aligned = pts.map((f) => alignAffine(f, ref)).filter(Boolean);
  const width = Math.hypot(ref[5][0] - ref[17][0], ref[5][1] - ref[17][1]);
  if (aligned.length < 6 || !(width > 1e-6)) return null;

  // For each landmark: how far does it wander (after alignment) around its own average?
  let total = 0;
  for (let i = 0; i < 21; i++) {
    const mx = mean(aligned.map((a) => a[i][0]));
    const my = mean(aligned.map((a) => a[i][1]));
    total += Math.sqrt(mean(aligned.map((a) => (a[i][0] - mx) ** 2 + (a[i][1] - my) ** 2)));
  }
  return round4(total / 21 / width);
}

/** Least-squares affine map of `src` onto `dst`; returns the mapped points, or null if degenerate. */
function alignAffine(src, dst) {
  const n = src.length;
  const sc = [mean(src.map((p) => p[0])), mean(src.map((p) => p[1]))];
  const dc = [mean(dst.map((p) => p[0])), mean(dst.map((p) => p[1]))];
  // M = (Σ d·sᵀ)(Σ s·sᵀ)⁻¹ on centred points
  let sxx = 0, sxy = 0, syy = 0, dxsx = 0, dxsy = 0, dysx = 0, dysy = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - sc[0], y = src[i][1] - sc[1];
    const u = dst[i][0] - dc[0], v = dst[i][1] - dc[1];
    sxx += x * x; sxy += x * y; syy += y * y;
    dxsx += u * x; dxsy += u * y; dysx += v * x; dysy += v * y;
  }
  const det = sxx * syy - sxy * sxy;
  if (!(Math.abs(det) > 1e-12)) return null;
  const ia = syy / det, ib = -sxy / det, id = sxx / det; // inverse of [[sxx,sxy],[sxy,syy]]
  const a = dxsx * ia + dxsy * ib, b = dxsx * ib + dxsy * id;
  const c = dysx * ia + dysy * ib, d = dysx * ib + dysy * id;
  return src.map(([px, py]) => {
    const x = px - sc[0], y = py - sc[1];
    return [a * x + b * y + dc[0], c * x + d * y + dc[1]];
  });
}

// --- Liveness: device frame -------------------------------------------------
//
// A photo or video of a hand is usually shown on a phone, tablet or laptop.
// An object detector (COCO classes) looks for those around the hand. To avoid
// blocking a real customer with a phone in their other hand, or a till screen
// behind them, a device only counts when the hand sits INSIDE it and fills a
// fair part of it.

export const DEVICE_CATEGORIES = ['cell phone', 'laptop', 'tv']; // "tv" covers monitors

/** Bounding box of image landmarks, normalised 0..1. */
export function handBox(points) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * @param {{x,y,w,h}} hand normalised hand box
 * @param {{x,y,w,h,score,label}[]} devices normalised device boxes
 * @returns {{score:number,label:string|null}} the most confident device that frames the hand
 */
export function deviceAroundHand(hand, devices) {
  let best = { score: 0, label: null };
  const handArea = hand.w * hand.h;
  if (!(handArea > 0)) return best;
  for (const d of devices || []) {
    const ix = Math.max(0, Math.min(hand.x + hand.w, d.x + d.w) - Math.max(hand.x, d.x));
    const iy = Math.max(0, Math.min(hand.y + hand.h, d.y + d.h) - Math.max(hand.y, d.y));
    const inside = (ix * iy) / handArea; // how much of the hand is within the device
    const fills = handArea / (d.w * d.h || 1); // how much of the device the hand fills
    if (inside >= 0.6 && fills >= 0.15 && d.score > best.score) best = { score: round4(d.score), label: d.label };
  }
  return best;
}

// --- Liveness: glare ---------------------------------------------------------
//
// Skin scatters light softly. Glossy photo paper and glass screens throw back
// bright, nearly white highlights. We measure the share of the palm (not the
// fingers, which have background between them) that is near-white glare.

export const PALM_OUTLINE = [0, 1, 2, 5, 9, 13, 17];

/**
 * @param {Uint8ClampedArray} rgba image pixels
 * @param {number} width
 * @param {number} height
 * @param {[number,number][]} polygon palm outline in pixel coordinates of this image
 * @returns {number|null} share of palm pixels that are glare (0..1)
 */
export function glareShare(rgba, width, height, polygon) {
  let palm = 0, glare = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!insidePolygon(x + 0.5, y + 0.5, polygon)) continue;
      const i = (y * width + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      palm++;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luma >= 235 && Math.max(r, g, b) - Math.min(r, g, b) <= 40) glare++;
    }
  }
  return palm < 50 ? null : round4(glare / palm);
}

function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// --- Liveness: the rule, shared by scanner and server -----------------------

/**
 * @param {{tremor?:number|null, device?:{score:number}|null, glare?:number|null}} m measurements
 * @param {{checks:string[], minTremor:number, maxDeviceScore:number, maxGlare:number}} s settings
 * @returns {{passed:boolean, failed:string[]}} a missing measurement counts as a fail
 */
export function evaluateLiveness(m = {}, s) {
  const failed = [];
  const on = (c) => s.checks.includes(c);
  if (on('tremor') && !(Number.isFinite(m.tremor) && m.tremor >= s.minTremor)) failed.push('tremor');
  if (on('device') && !(Number.isFinite(m.device?.score) && m.device.score < s.maxDeviceScore)) failed.push('device');
  if (on('glare') && !(Number.isFinite(m.glare) && m.glare <= s.maxGlare)) failed.push('glare');
  return { passed: failed.length === 0, failed };
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const round4 = (x) => Math.round(x * 10000) / 10000;
