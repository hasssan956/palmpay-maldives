import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tremorScore } from '../shared/palm-features.js';
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

const probe = (tremor) => ({ model: 'mp-handgeom-v1', vector: new Array(23).fill(1), hand: 'Right', quality: { frames: 18 }, liveness: { tremor } });

test('enforce mode rejects a scan without enough tremor; observe mode lets it through', () => {
  const enforce = createHandGeometryMatcher({ threshold: 0.075, margin: 0.8, duplicateThreshold: 0.075, liveness: { mode: 'enforce', minTremor: 0.005 } });
  assert.deepEqual(enforce.validateProbe(probe(0.002)), { ok: false, reason: 'not_live' });
  assert.deepEqual(enforce.validateProbe({ ...probe(0), liveness: undefined }), { ok: false, reason: 'not_live' });
  assert.equal(enforce.validateProbe(probe(0.009)).ok, true);

  const observe = createHandGeometryMatcher({ threshold: 0.075, margin: 0.8, duplicateThreshold: 0.075, liveness: { mode: 'observe', minTremor: 0.005 } });
  assert.equal(observe.validateProbe(probe(0.002)).ok, true);
});

test('with LIVENESS_MODE=enforce, a flat scan cannot pay and a live one can', async () => {
  const { testContainer, probeFor, MIB, CAFE, consent } = await import('./helpers.js');
  const c = await testContainer({ livenessMode: 'enforce', minTremor: 0.005 });
  const hand = makeHand(11);
  const live = (p) => ({ ...p, liveness: { check: 'tremor', tremor: 0.012, passed: true } });
  await c.palmUsers.enroll(MIB, { bankCustomerRef: 'mib_c_mariyam', name: 'Mariyam Shaheen', accountRef: 'mib_a_mariyam_cur', palm: live(probeFor(hand)), consent });

  const pi = await c.payments.createIntent(CAFE, { amount: 2500 });
  const flat = { ...probeFor(hand), liveness: { check: 'tremor', tremor: 0.001, passed: false } };
  await assert.rejects(c.payments.authorize(CAFE, pi.id, { palm: flat }), (e) => e.details?.reason === 'not_live');

  const res = await c.payments.authorize(CAFE, pi.id, { palm: live(probeFor(hand)) });
  assert.equal(res.intent.status, 'succeeded');
});
