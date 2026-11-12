import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tremorScore, frameAroundHand, handBox, glareShare, evaluateLiveness } from '../shared/palm-features.js';
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

const SETTINGS = { checks: ['tremor', 'device', 'glare'], minTremor: 0.005, maxDeviceScore: 0.6, maxGlare: 0.05 };
const LIVE = { tremor: 0.009, device: { score: 0.3, sides: 0 }, glare: 0.01 };
const probe = (liveness) => ({ model: 'mp-handgeom-v1', vector: new Array(23).fill(1), hand: 'Right', quality: { frames: 18 }, liveness });
const matcher = (mode, checks = SETTINGS.checks) =>
  createHandGeometryMatcher({ threshold: 0.075, margin: 0.8, duplicateThreshold: 0.075, liveness: { mode, ...SETTINGS, checks } });

// Synthetic camera frames (grey levels) for the device-border check.
function scene({ phone = false, tableEdge = false, seed = 5 }) {
  const W = 192, H = 160, r = rng(seed);
  const px = new Uint8Array(W * H);
  // A busy room: random blotches of light and dark, like a patterned blanket.
  const blobs = Array.from({ length: 40 }, () => ({ x: r() * W, y: r() * H, s: 4 + r() * 14, v: (r() - 0.5) * 160 }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 110 + (r() - 0.5) * 30;
    for (const b of blobs) v += b.v * Math.exp(-((x - b.x) ** 2 + (y - b.y) ** 2) / (2 * b.s * b.s));
    px[y * W + x] = Math.max(0, Math.min(255, v));
  }
  if (tableEdge) for (let y = 130; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = 200;
  if (phone) {
    for (let y = 20; y < 150; y++) for (let x = 50; x < 140; x++) {
      const bezel = x < 56 || x >= 134 || y < 28 || y >= 142;
      px[y * W + x] = bezel ? 15 : 160 + (r() - 0.5) * 20;
    }
  }
  // The hand.
  for (let y = 40; y < 125; y++) for (let x = 70; x < 120; x++) {
    if (((x - 95) / 25) ** 2 + ((y - 82) / 42) ** 2 <= 1) px[y * W + x] = 120;
  }
  return { gray: px, w: W, h: H, box: { x: 70, y: 40, w: 50, h: 85 } };
}
const frameScore = (opts) => { const s = scene(opts); return frameAroundHand(s.gray, s.w, s.h, s.box); };

test('device check: a phone border around the hand scores high, a busy room does not', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const phone = frameScore({ phone: true, seed });
    assert.ok(phone.score >= 0.8 && phone.sides >= 3, `phone ${seed} ${JSON.stringify(phone)}`);
  }
  for (let seed = 1; seed <= 30; seed++) {
    const room = frameScore({ seed });
    assert.ok(room.score < 0.45, `room ${seed} ${JSON.stringify(room)}`);
  }
  // One straight edge (a table) under a real hand is not a device.
  const table = frameScore({ tableEdge: true });
  assert.ok(table.score < 0.45 && table.sides <= 1, `table ${JSON.stringify(table)}`);
  assert.deepEqual(handBox([{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.7 }]), { x: 0.4, y: 0.4, w: 0.19999999999999996, h: 0.29999999999999993 });
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
  assert.deepEqual(evaluateLiveness({ ...LIVE, device: { score: 0.95, sides: 4 } }, SETTINGS).failed, ['device']);
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
  const c = await testContainer({ livenessMode: 'enforce', livenessChecks: SETTINGS.checks, minTremor: 0.005, maxDeviceScore: 0.6, maxGlare: 0.05 });
  const hand = makeHand(11);
  const live = (p) => ({ ...p, liveness: LIVE });
  await c.palmUsers.enroll(MIB, { bankCustomerRef: 'mib_c_mariyam', name: 'Mariyam Shaheen', accountRef: 'mib_a_mariyam_cur', palm: live(probeFor(hand)), consent });

  const pi = await c.payments.createIntent(CAFE, { amount: 2500 });
  const onPhone = { ...probeFor(hand), liveness: { ...LIVE, device: { score: 0.95, sides: 4 }, glare: 0.12 } };
  await assert.rejects(c.payments.authorize(CAFE, pi.id, { palm: onPhone }),
    (e) => e.details?.reason === 'not_live' && e.details.failed.join() === 'device,glare');

  const res = await c.payments.authorize(CAFE, pi.id, { palm: live(probeFor(hand)) });
  assert.equal(res.intent.status, 'succeeded');
});
