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
// A photo or video of a hand is shown on a phone, tablet or laptop, and the
// device's border shows up as straight edges boxing the hand in. A real hand
// in a room almost never has straight edges on three or four sides of it.
//
// For each side of the hand we cast rays outwards, collect the strong edges
// each ray crosses (with the right orientation: up-and-down edges for the
// left and right sides, across edges for top and bottom), and look for one
// straight line that most rays cross (RANSAC). A side "has a border" when
// most of its rays agree on such a line. The score, 0..1, is the third-best
// side: a phone around the hand scores high, an open room low.
// Each side's score also needs the line to be one continuous edge, like a
// device border, not a few unrelated edges in a busy pattern that happen to line up.

const FRAME_RAYS = 20;

/** Bounding box of image landmarks, normalised 0..1. */
export function handBox(points) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * @param {ArrayLike<number>} gray luminance, row by row (a small frame, ~200 px)
 * @param {number} w
 * @param {number} h
 * @param {{x,y,w,h}} box hand box in pixels of this frame
 * @param {object} [opts] tuning knobs (rays, maxHits, tolFactor, onFactor); defaults are the tuned values
 * @returns {{score:number, sides:number}} sides = how many sides have a straight border
 */
export function frameAroundHand(gray, w, h, box, opts = {}) {
  // Tuned on real phone-photo and real-hand frames plus generated cluttered rooms.
  const { rays: RAYS = FRAME_RAYS, maxHits = 8, tolFactor = 0.008, onFactor = 1 } = opts;
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = gray[i - w - 1], b = gray[i - w], c = gray[i - w + 1];
      const d = gray[i - 1], f = gray[i + 1];
      const g = gray[i + w - 1], k = gray[i + w], l = gray[i + w + 1];
      gx[i] = c + 2 * f + l - a - 2 * d - g;
      gy[i] = g + 2 * k + l - a - 2 * b - c;
      mag[i] = Math.hypot(gx[i], gy[i]);
    }
  }
  // Strong edge: in the top 15% of the frame, and clearly above flat noise.
  const sorted = Float32Array.from(mag).sort();
  const threshold = Math.max(60, sorted[Math.floor(sorted.length * 0.85)]);
  const margin = Math.max(2, Math.round(Math.max(w, h) * 0.02));

  const sides = [
    { along: 'y', from: box.y, to: box.y + box.h, start: box.x - margin, step: -1, vertical: true },
    { along: 'y', from: box.y, to: box.y + box.h, start: box.x + box.w + margin, step: 1, vertical: true },
    { along: 'x', from: box.x, to: box.x + box.w, start: box.y - margin, step: -1, vertical: false },
    { along: 'x', from: box.x, to: box.x + box.w, start: box.y + box.h + margin, step: 1, vertical: false },
  ];

  const scores = sides.map((side) => {
    // Edge positions met by each ray. u = position along the side, v = distance outwards.
    const rays = [];
    for (let r = 0; r < RAYS; r++) {
      const u = Math.round(side.from + ((r + 0.5) / RAYS) * (side.to - side.from));
      const hits = [];
      const limit = side.vertical ? w : h;
      for (let v = Math.round(side.start); v >= 1 && v < limit - 1; v += side.step) {
        const x = side.vertical ? v : u, y = side.vertical ? u : v;
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) break;
        const i = y * w + x;
        if (mag[i] < threshold) continue;
        const across = side.vertical ? Math.abs(gx[i]) : Math.abs(gy[i]);
        const along = side.vertical ? Math.abs(gy[i]) : Math.abs(gx[i]);
        if (across < along) continue; // edge runs the wrong way
        const prev = mag[side.vertical ? i - side.step : i - side.step * w];
        const next = mag[side.vertical ? i + side.step : i + side.step * w];
        if (mag[i] >= prev && mag[i] >= next) hits.push(v); // local peak only
        if (hits.length >= maxHits) break;
      }
      rays.push({ u, hits });
    }
    // RANSAC: a line v = a*u + b through edges on two rays; count rays that agree.
    const tol = Math.max(1.5, Math.max(w, h) * tolFactor);
    let best = 0, bestLine = null;
    for (let r1 = 0; r1 < rays.length; r1++) {
      for (let r2 = r1 + 2; r2 < rays.length; r2++) {
        for (const v1 of rays[r1].hits) {
          for (const v2 of rays[r2].hits) {
            const a = (v2 - v1) / (rays[r2].u - rays[r1].u);
            if (Math.abs(a) > 0.35) continue; // more than ~20 degrees off the side
            const b = v1 - a * rays[r1].u;
            let n = 0;
            for (const ray of rays) {
              const v = a * ray.u + b;
              if (ray.hits.some((hv) => Math.abs(hv - v) <= tol)) n++;
            }
            if (n > best) { best = n; bestLine = { a, b }; }
          }
        }
      }
    }
    if (!bestLine) return 0;
    // Continuity: walk the line pixel by pixel; how much of it is a real edge?
    let on = 0, total = 0;
    for (let u = Math.round(side.from); u <= Math.round(side.to); u++) {
      const v = Math.round(bestLine.a * u + bestLine.b);
      const x = side.vertical ? v : u, y = side.vertical ? u : v;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      total++;
      for (let dv = -1; dv <= 1; dv++) {
        const i = side.vertical ? y * w + x + dv : (y + dv) * w + x;
        if (mag[i] >= threshold * onFactor) { on++; break; }
      }
    }
    return (best / RAYS) * (total ? on / total : 0);
  });

  // Score = the third-strongest side, so it takes a border on at least three
  // sides to score high. Stripes (blinds, curtains, tiles) only line up one way.
  const ranked = [...scores].sort((p, q) => q - p);
  return { score: round4(ranked[2]), sides: scores.filter((x) => x >= 0.6).length };
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
