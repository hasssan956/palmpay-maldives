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

const round4 = (x) => Math.round(x * 10000) / 10000;
