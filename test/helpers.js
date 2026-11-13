import { buildContainer } from '../src/container.js';
import { seed } from '../src/seed.js';
import { extractFeatures, medianVector, FEATURE_MODEL } from '../shared/palm-features.js';

export function memoryPersistence() {
  let saved = null;
  return { name: 'memory', load: async () => saved && structuredClone(saved), save: async (st) => { saved = structuredClone(st); } };
}

export async function testContainer(config = {}) {
  const c = await buildContainer({ persistence: memoryPersistence, config: { demoMode: true, simBankLatencyMs: 0, livenessMode: 'off', palmLines: 'off', matchThreshold: 0.075, duplicateThreshold: 0.075, ...config } });
  await seed(c);
  return c;
}

export const BML = { type: 'bank', bankId: 'bml' };
export const MIB = { type: 'bank', bankId: 'mib' };
export const CAFE = { type: 'terminal', merchantId: 'mer_raalhu_cafe' }; // banks with BML
export const MART = { type: 'terminal', merchantId: 'mer_hulhumale_mart' }; // banks with MIB
export const consent = { accepted: true };

// A crude parametric hand: each person has their own bone lengths (metres).
// Good enough to exercise the feature pipeline and matcher end to end.
export function makeHand(seedValue) {
  let s = seedValue;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const vary = (base) => base * (0.82 + rand() * 0.36);
  return {
    palmWidth: vary(0.08),
    palmLen: vary(0.095),
    fingers: [0.9, 1, 0.95, 0.75].map((k) => [vary(0.045 * k), vary(0.027 * k), vary(0.022 * k)]),
    thumb: [vary(0.04), vary(0.032), vary(0.028)],
  };
}

export function landmarksFor(hand, noise = 0.004, rng = Math.random) {
  const n = () => (rng() - 0.5) * 2 * noise;
  const pts = new Array(21);
  pts[0] = { x: 0, y: 0, z: 0 };
  const xs = [-0.5, -0.17, 0.17, 0.5].map((f) => f * hand.palmWidth / 1.0);
  const lens = [1.0, 1.04, 0.98, 0.88].map((f) => f * hand.palmLen);
  hand.fingers.forEach((bones, f) => {
    const base = 5 + f * 4;
    let p = { x: xs[f], y: lens[f], z: 0 };
    pts[base] = p;
    bones.forEach((len, b) => {
      p = { x: p.x + xs[f] * 0.05, y: p.y + len, z: 0 };
      pts[base + b + 1] = p;
    });
  });
  let p = { x: -hand.palmWidth * 0.35, y: hand.palmLen * 0.2, z: 0 };
  pts[1] = p;
  hand.thumb.forEach((len, b) => {
    p = { x: p.x - len * 0.7, y: p.y + len * 0.7, z: 0 };
    pts[2 + b] = p;
  });
  // Rescale so palm width matches, then jitter every point.
  const w = Math.hypot(pts[5].x - pts[17].x, pts[5].y - pts[17].y);
  const k = hand.palmWidth / w;
  return pts.map((q) => ({ x: q.x * k + n(), y: q.y * k + n(), z: n() }));
}

export function probeFor(hand, frames = 20, side = 'Right') {
  const vectors = Array.from({ length: frames }, () => extractFeatures(landmarksFor(hand)));
  return { model: FEATURE_MODEL, vector: medianVector(vectors), hand: side, quality: { frames, spread: 0.02 } };
}
