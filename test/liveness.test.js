import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tremorScore, deviceAroundHand, handBox, glareShare, evaluateLiveness } from '../shared/palm-features.js';
import { makeHand, landmarksFor } from './helpers.js';
import { createHandGeometryMatcher } from '../src/adapters/biometrics/hand-geometry-matcher.js';

// Deterministic random numbers so the test never flakes.
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// Place a hand shape (metres) into the camera image (0..1) with a given pose.
function project(shape, { angle, scale, tx, ty, shear = 0 }) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return shape.map((p) => {
    const x = p.x + shear * p.y;
    return { x: 0.5 + tx + scale * (cos * x - sin * p.y), y: 0.6 + ty - scale * (sin * x + cos * p.y) };
  });
}

const FRAMES = 18;
const pose = (r, t) => ({
  angle: 0.1 * Math.sin(t / 3) + (r() - 0.5) * 0.02,
  scale: 3 + 0.1 * Math.sin(t / 4),
  tx: 0.01 * Math.sin(t / 2),
  ty: 0.01 * Math.cos(t / 2),
  shear: 0.05 * Math.sin(t / 5), // a photo tilted towards the camera
});

// Same flat picture every frame, moved, tilted and zoomed, plus a little camera noise.
function photoFrames(seed) {
  const r = rng(seed);
  const shape = landmarksFor(makeHand(7), 0, r);
  return Array.from({ length: FRAMES }, (_, t) =>
    project(shape, pose(r, t)).map((p) => ({ x: p.x + (r() - 0.5) * 0.0006, y: p.y + (r() - 0.5) * 0.0006 })));
}

// A real hand: same overall motion, but each joint also trembles on its own.
function liveFrames(seed, tremor = 0.0012) {
  const r = rng(seed);
  const hand = makeHand(7);
  return Array.from({ length: FRAMES }, (_, t) => project(landmarksFor(hand, tremor, r), pose(r, t)));
}

test('a moving, tilting photo of a hand scores low on tremor', () => {
  const score = tremorScore(photoFrames(3));
  assert.ok(score < 0.004, `photo scored ${score}`);
});

test('a live hand with independent finger tremor scores higher than a photo', () => {
  const live = tremorScore(liveFrames(3));
  const photo = tremorScore(photoFrames(3));
  assert.ok(live > 0.006, `live hand scored ${live}`);
  assert.ok(live > photo * 3, `live ${live} vs photo ${photo}`);
});

test('tremor needs enough frames', () => {
  assert.equal(tremorScore(photoFrames(1).slice(0, 4)), null);
});

const SETTINGS = { checks: ['tremor', 'device', 'glare'], minTremor: 0.005, maxDeviceScore: 0.5, maxGlare: 0.05 };
const LIVE = { tremor: 0.009, device: { score: 0, label: null }, glare: 0.01 };
const probe = (liveness) => ({ model: 'mp-handgeom-v1', vector: new Array(23).fill(1), hand: 'Right', quality: { frames: 18 }, liveness });
const matcher = (mode, checks = SETTINGS.checks) =>
  createHandGeometryMatcher({ threshold: 0.075, margin: 0.8, duplicateThreshold: 0.075, liveness: { mode, ...SETTINGS, checks } });

test('device check: a phone framing the hand counts, a phone elsewhere does not', () => {
  const hand = { x: 0.35, y: 0.3, w: 0.3, h: 0.4 };
  const phoneAround = { x: 0.3, y: 0.2, w: 0.42, h: 0.62, score: 0.8, label: 'cell phone' };
  const phoneInOtherHand = { x: 0.75, y: 0.5, w: 0.15, h: 0.3, score: 0.9, label: 'cell phone' };
  const bigScreenBehind = { x: 0, y: 0, w: 1, h: 1, score: 0.9, label: 'tv' }; // hand fills only 12% of it
  assert.deepEqual(deviceAroundHand(hand, [phoneAround]), { score: 0.8, label: 'cell phone' });
  assert.deepEqual(deviceAroundHand(hand, [phoneInOtherHand]), { score: 0, label: null });
  assert.deepEqual(deviceAroundHand(hand, [bigScreenBehind]), { score: 0, label: null });
  assert.equal(deviceAroundHand(handBox([{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.7 }]), [phoneAround]).score, 0.8);
});

test('glare check: shiny near-white patches on the palm are measured, skin tones are not', () => {
  const W = 20, H = 20;
  const img = (fill) => {
    const px = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px.set([...fill(x, y), 255], (y * W + x) * 4);
    return px;
  };
  const palm = [[0, 0], [W, 0], [W, H], [0, H]];
  const skin = img(() => [205, 160, 130]);
  const brightSkin = img(() => [250, 225, 200]); // well-lit skin is warm, not white
  const shiny = img((x, y) => (x < 10 && y < 10 ? [250, 250, 248] : [205, 160, 130])); // a quarter is glare
  assert.equal(glareShare(skin, W, H, palm), 0);
  assert.equal(glareShare(brightSkin, W, H, palm), 0);
  assert.equal(glareShare(shiny, W, H, palm), 0.25);
  // Pixels outside the palm outline are ignored.
  assert.equal(glareShare(shiny, W, H, [[10, 10], [W, 10], [W, H], [10, H]]), 0);
  assert.equal(glareShare(skin, 4, 4, [[0, 0], [4, 0], [4, 4], [0, 4]]), null); // too small to judge
});

test('liveness rule: every enabled check must pass, and a missing reading fails', () => {
  assert.deepEqual(evaluateLiveness(LIVE, SETTINGS), { passed: true, failed: [] });
  assert.deepEqual(evaluateLiveness({ ...LIVE, tremor: 0.001 }, SETTINGS).failed, ['tremor']);
  assert.deepEqual(evaluateLiveness({ ...LIVE, device: { score: 0.7, label: 'cell phone' } }, SETTINGS).failed, ['device']);
  assert.deepEqual(evaluateLiveness({ ...LIVE, glare: 0.2 }, SETTINGS).failed, ['glare']);
  assert.deepEqual(evaluateLiveness({}, SETTINGS).failed, ['tremor', 'device', 'glare']);
  assert.deepEqual(evaluateLiveness({ tremor: 0.009 }, { ...SETTINGS, checks: ['tremor'] }).failed, []);
});

test('enforce mode rejects a scan that fails a check; observe mode lets it through', () => {
  assert.deepEqual(matcher('enforce').validateProbe(probe({ ...LIVE, glare: 0.3 })), { ok: false, reason: 'not_live', failed: ['glare'] });
  assert.deepEqual(matcher('enforce').validateProbe(probe(undefined)).failed, ['tremor', 'device', 'glare']);
  assert.equal(matcher('enforce').validateProbe(probe(LIVE)).ok, true);
  assert.equal(matcher('enforce', ['tremor']).validateProbe(probe({ tremor: 0.009 })).ok, true);
  assert.equal(matcher('observe').validateProbe(probe({ tremor: 0.001 })).ok, true);
});

test('with LIVENESS_MODE=enforce, a scan of a phone screen cannot pay and a live hand can', async () => {
  const { testContainer, probeFor, MIB, CAFE, consent } = await import('./helpers.js');
  const c = await testContainer({ livenessMode: 'enforce', livenessChecks: SETTINGS.checks, minTremor: 0.005, maxDeviceScore: 0.5, maxGlare: 0.05 });
  const hand = makeHand(11);
  const live = (p) => ({ ...p, liveness: LIVE });
  await c.palmUsers.enroll(MIB, { bankCustomerRef: 'mib_c_mariyam', name: 'Mariyam Shaheen', accountRef: 'mib_a_mariyam_cur', palm: live(probeFor(hand)), consent });

  const pi = await c.payments.createIntent(CAFE, { amount: 2500 });
  const onPhone = { ...probeFor(hand), liveness: { ...LIVE, device: { score: 0.82, label: 'cell phone' }, glare: 0.12 } };
  await assert.rejects(c.payments.authorize(CAFE, pi.id, { palm: onPhone }),
    (e) => e.details?.reason === 'not_live' && e.details.failed.join() === 'device,glare');

  const res = await c.payments.authorize(CAFE, pi.id, { palm: live(probeFor(hand)) });
  assert.equal(res.intent.status, 'succeeded');
});
