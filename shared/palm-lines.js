// Palm-line matching, shared by the browser scanner, the server and the tests.
//
// Hand shape alone barely differs between people. The lines and creases on the
// palm do: they are what palmprint systems compare. This file:
//   1. cuts a square out of the middle of the palm, lined up with the knuckles
//      (so it is the same patch of skin whatever the hand's angle or distance),
//   2. turns it into a "competitive code" (CompCode, Kong & Zhang 2004): on a
//      grid over the patch, which of 6 directions the darkest line runs in,
//   3. compares two codes by how far apart those directions are, allowing for
//      a small shift. 0 = identical, ~0.5 = unrelated palms.
//
// Cells with no clear line are masked out instead of compared, because on a
// phone camera much of the palm is smooth skin, and its "direction" is noise.
//
// Demo grade: a contactless phone photo of palm lines is far more distinctive
// than hand shape, but lighting and focus change it. Bank grade needs a
// palm-vein scanner with certified matching.

export const LINES_MODEL = 'compcode-v1';

export const ROI_SIZE = 128; // pixels, the palm patch
const ORIENTATIONS = 6;
const GRID = 24; // cells per side
const STRIDE = 4; // pixels between cells
const OFFSET = (ROI_SIZE - (GRID - 1) * STRIDE) / 2; // centre the grid
const KEEP = 0.8; // share of cells (the clearest lines) that are compared
const MAX_SHIFT = 3; // cells, in each direction
const MIN_OVERLAP = 0.25; // of the grid, for a shift to count

// --- 1. The palm patch ------------------------------------------------------

/**
 * Where the patch sits, from MediaPipe image landmarks.
 * @param {{x:number,y:number}[]} points 21 landmarks, normalised 0..1
 * @param {number} w image width in pixels
 * @param {number} h image height in pixels
 * @returns {{center:[number,number], u:[number,number], v:[number,number], side:number}}
 */
export function palmRegion(points, w, h) {
  const P = (i) => [points[i].x * w, points[i].y * h];
  const a = P(5), b = P(17), wrist = P(0);
  const width = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const u = [(b[0] - a[0]) / width, (b[1] - a[1]) / width]; // index knuckle -> little-finger knuckle
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let v = [-u[1], u[0]]; // across, pointing to the wrist
  if (v[0] * (wrist[0] - mid[0]) + v[1] * (wrist[1] - mid[1]) < 0) v = [-v[0], -v[1]];
  return {
    center: [mid[0] + v[0] * 0.6 * width, mid[1] + v[1] * 0.6 * width],
    u, v,
    side: 0.85 * width,
  };
}

/**
 * Samples the palm patch from a grey image.
 * @param {ArrayLike<number>} gray luminance, row by row
 * @param {number} w
 * @param {number} h
 * @param {ReturnType<typeof palmRegion>} region
 * @param {number} [x0] where `gray` starts in the full image (when it is a crop)
 * @param {number} [y0]
 * @returns {Float32Array|null} ROI_SIZE x ROI_SIZE, or null if the patch is not fully in view
 */
export function samplePalm(gray, w, h, region, x0 = 0, y0 = 0) {
  const out = new Float32Array(ROI_SIZE * ROI_SIZE);
  const { center, u, v, side } = region;
  const step = side / ROI_SIZE;
  for (let j = 0; j < ROI_SIZE; j++) {
    for (let i = 0; i < ROI_SIZE; i++) {
      const s = (i + 0.5) * step - side / 2, t = (j + 0.5) * step - side / 2;
      const x = center[0] + u[0] * s + v[0] * t - x0;
      const y = center[1] + u[1] * s + v[1] * t - y0;
      if (x < 0 || y < 0 || x > w - 1.001 || y > h - 1.001) return null;
      const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
      const k = yi * w + xi;
      out[j * ROI_SIZE + i] =
        (gray[k] * (1 - fx) + gray[k + 1] * fx) * (1 - fy) + (gray[k + w] * (1 - fx) + gray[k + w + 1] * fx) * fy;
    }
  }
  return out;
}

/** Sharpness of a patch (variance of the Laplacian); used to pick the best frames. */
export function sharpness(roi) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < ROI_SIZE - 1; y++) {
    for (let x = 1; x < ROI_SIZE - 1; x++) {
      const i = y * ROI_SIZE + x;
      const l = 4 * roi[i] - roi[i - 1] - roi[i + 1] - roi[i - ROI_SIZE] - roi[i + ROI_SIZE];
      sum += l; sum2 += l * l; n++;
    }
  }
  return sum2 / n - (sum / n) ** 2;
}

// --- 2. The competitive code ------------------------------------------------

// Even Gabor filters, zero mean, one per direction. A dark line running in a
// filter's direction gives that filter its most negative response.
const KR = 9; // kernel radius
const KERNELS = Array.from({ length: ORIENTATIONS }, (_, o) => {
  const theta = (o * Math.PI) / ORIENTATIONS;
  const c = Math.cos(theta), s = Math.sin(theta);
  const sigma = 3.6, lambda = 10, gamma = 0.45; // tuned on 152 palm photos of 58 hands
  const k = [];
  for (let dy = -KR; dy <= KR; dy++) {
    for (let dx = -KR; dx <= KR; dx++) {
      const xr = dx * c + dy * s; // across the line
      const yr = -dx * s + dy * c; // along the line
      k.push(Math.exp(-(xr * xr + gamma * gamma * yr * yr) / (2 * sigma * sigma)) * Math.cos((2 * Math.PI * xr) / lambda));
    }
  }
  const m = k.reduce((p, q) => p + q, 0) / k.length;
  return Float32Array.from(k, (x) => x - m);
});

/**
 * @param {Float32Array} roi palm patch from samplePalm
 * @returns {string} GRID*GRID characters: '0'..'5' = line direction, '.' = no clear line
 */
export function palmCode(roi) {
  const codes = new Uint8Array(GRID * GRID);
  const conf = new Float32Array(GRID * GRID);
  const side = 2 * KR + 1;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const cx = Math.round(OFFSET + gx * STRIDE), cy = Math.round(OFFSET + gy * STRIDE);
      let best = Infinity, worst = -Infinity, arg = 0;
      for (let o = 0; o < ORIENTATIONS; o++) {
        const k = KERNELS[o];
        let r = 0;
        for (let dy = -KR; dy <= KR; dy++) {
          const y = Math.min(ROI_SIZE - 1, Math.max(0, cy + dy));
          const row = y * ROI_SIZE, krow = (dy + KR) * side;
          for (let dx = -KR; dx <= KR; dx++) {
            const x = Math.min(ROI_SIZE - 1, Math.max(0, cx + dx));
            r += roi[row + x] * k[krow + dx + KR];
          }
        }
        if (r < best) { best = r; arg = o; }
        if (r > worst) worst = r;
      }
      codes[gy * GRID + gx] = arg;
      conf[gy * GRID + gx] = worst - best;
    }
  }
  const cut = Float32Array.from(conf).sort()[Math.floor(conf.length * (1 - KEEP))];
  let out = '';
  for (let i = 0; i < codes.length; i++) out += conf[i] >= cut ? String(codes[i]) : '.';
  return out;
}

export function isPalmCode(s) {
  return typeof s === 'string' && s.length === GRID * GRID && /^[0-5.]+$/.test(s);
}

// --- 3. Comparing codes ----------------------------------------------------

/** Distance between two codes, 0..1, best over small shifts. ~0.5 for unrelated palms. */
export function codeDistance(a, b) {
  let best = 1;
  const minN = MIN_OVERLAP * GRID * GRID;
  for (let sy = -MAX_SHIFT; sy <= MAX_SHIFT; sy++) {
    for (let sx = -MAX_SHIFT; sx <= MAX_SHIFT; sx++) {
      let total = 0, n = 0;
      for (let y = Math.max(0, -sy); y < Math.min(GRID, GRID - sy); y++) {
        for (let x = Math.max(0, -sx); x < Math.min(GRID, GRID - sx); x++) {
          const ca = a.charCodeAt(y * GRID + x), cb = b.charCodeAt((y + sy) * GRID + x + sx);
          if (ca === 46 || cb === 46) continue; // '.'
          const d = Math.abs(ca - cb);
          total += Math.min(d, ORIENTATIONS - d);
          n++;
        }
      }
      if (n >= minN) best = Math.min(best, total / n / (ORIENTATIONS / 2));
    }
  }
  return Math.round(best * 10000) / 10000;
}

/**
 * Distance between a scan and a registered palm, each a few codes from
 * different frames: the median of the best match for each scan code, so one
 * lucky pair can't make a stranger match.
 */
export function linesDistance(probeCodes, templateCodes) {
  if (!probeCodes?.length || !templateCodes?.length) return null;
  const bests = probeCodes.map((p) => Math.min(...templateCodes.map((t) => codeDistance(p, t)))).sort((x, y) => x - y);
  const m = bests.length >> 1;
  return bests.length % 2 ? bests[m] : Math.round(((bests[m - 1] + bests[m]) / 2) * 10000) / 10000;
}
