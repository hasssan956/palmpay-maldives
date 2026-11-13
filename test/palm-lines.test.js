import { test } from 'node:test';
import assert from 'node:assert/strict';
import { palmRegion, samplePalm, palmCode, codeDistance, linesDistance, isPalmCode, LINES_MODEL } from '../shared/palm-lines.js';
import { createHandGeometryMatcher } from '../src/adapters/biometrics/hand-geometry-matcher.js';
import { testContainer, makeHand, probeFor, MIB, BML, CAFE, consent } from './helpers.js';

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

// A drawn palm: skin with soft shading and a pattern of dark creases.
const W = 480, H = 640;
function drawPalm(seed) {
  const r = rng(seed);
  const curves = Array.from({ length: 28 }, () => {
    const p0 = [140 + r() * 200, 240 + r() * 240];
    const p1 = [p0[0] + (r() - 0.5) * 160, p0[1] + (r() - 0.5) * 160];
    const p2 = [p1[0] + (r() - 0.5) * 160, p1[1] + (r() - 0.5) * 160];
    return { p0, p1, p2, width: 1.2 + r() * 2, dark: 35 + r() * 40 };
  });
  return curves;
}
function render(curves, { gain = 1, bias = 0, noise = 0, dx = 0, dy = 0, seed = 1 } = {}) {
  const r = rng(seed);
  const img = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) img[y * W + x] = 175 + 20 * Math.sin(x / 90) * Math.cos(y / 120);
  for (const c of curves) {
    for (let t = 0; t <= 1; t += 0.004) {
      const x = (1 - t) ** 2 * c.p0[0] + 2 * (1 - t) * t * c.p1[0] + t * t * c.p2[0] + dx;
      const y = (1 - t) ** 2 * c.p0[1] + 2 * (1 - t) * t * c.p1[1] + t * t * c.p2[1] + dy;
      const R = Math.ceil(c.width + 1);
      for (let yy = Math.floor(y) - R; yy <= y + R; yy++) for (let xx = Math.floor(x) - R; xx <= x + R; xx++) {
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const d = Math.hypot(xx - x, yy - y);
        if (d <= c.width) img[yy * W + xx] = Math.min(img[yy * W + xx], 175 - c.dark * (1 - d / (c.width + 1)));
      }
    }
  }
  return img.map((v) => Math.max(0, Math.min(255, v * gain + bias + (r() - 0.5) * 2 * noise)));
}
// Knuckles and wrist placing the palm patch over the creases.
function landmarks({ dx = 0, dy = 0 } = {}) {
  const pts = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.4 }));
  pts[5] = { x: (150 + dx) / W, y: (250 + dy) / H };
  pts[17] = { x: (330 + dx) / W, y: (250 + dy) / H };
  pts[0] = { x: (240 + dx) / W, y: (560 + dy) / H };
  return pts;
}
const codeOf = (img, lm = landmarks()) => palmCode(samplePalm(img, W, H, palmRegion(lm, W, H)));

test('palm lines: the same palm in different light matches, a different palm does not', () => {
  const alice = drawPalm(11), bob = drawPalm(22);
  const a1 = codeOf(render(alice));
  const a2 = codeOf(render(alice, { gain: 0.75, bias: 30, noise: 6, seed: 3 })); // dimmer, noisier
  const a3 = codeOf(render(alice, { dx: 3, dy: -2, noise: 4, seed: 4 }), landmarks({ dx: 3, dy: -2 })); // hand moved
  const b1 = codeOf(render(bob));
  assert.ok(isPalmCode(a1));
  const same = [codeDistance(a1, a2), codeDistance(a1, a3)];
  const different = codeDistance(a1, b1);
  assert.ok(Math.max(...same) < 0.25, `same palm ${same}`);
  assert.ok(different > 0.35, `different palms ${different}`);
});

test('palm lines: a patch that is not fully in view is refused', () => {
  const lm = landmarks({ dy: 330 }); // hand low in the picture: the palm patch runs off the bottom
  assert.equal(samplePalm(render(drawPalm(1)), W, H, palmRegion(lm, W, H)), null);
});

// Codes for the matcher tests: a person's codes vary a little between scans.
function personCodes(seed) {
  const r = rng(seed);
  return Array.from({ length: 576 }, () => (r() < 0.2 ? '.' : String(Math.floor(r() * 6)))).join('');
}
function rescan(code, seed, flip = 0.12) {
  const r = rng(seed);
  return [...code].map((c) => (c !== '.' && r() < flip ? String((Number(c) + 1) % 6) : c)).join('');
}
const withLines = (probe, codes) => ({ ...probe, palmLines: { model: LINES_MODEL, codes } });

test('palm lines: the same hand shape with different palm lines is a stranger', () => {
  const m = createHandGeometryMatcher({ threshold: 0.1, margin: 0.8, duplicateThreshold: 0.1, lines: { mode: 'require', threshold: 0.35 } });
  const shape = probeFor(makeHand(5));
  const aishath = personCodes(1);
  const templates = [{ palmUserId: 'pu_aishath', model: 'mp-handgeom-v1', templateRef: { vector: shape.vector, hand: 'Right', lines: [aishath, rescan(aishath, 2)] } }];

  return Promise.all([
    m.identify(withLines(shape, [rescan(aishath, 3), rescan(aishath, 4), rescan(aishath, 5)]), templates).then((r) => {
      assert.equal(r.status, 'match');
      assert.ok(r.lines < 0.2, `owner lines ${r.lines}`);
    }),
    // Exactly the bug: identical shape, someone else's palm.
    m.identify(withLines(shape, [personCodes(9), personCodes(10)]), templates).then((r) => {
      assert.equal(r.status, 'no_match');
      assert.ok(r.lines > 0.4, `stranger lines ${r.lines}`);
    }),
  ]);
});

test('palm lines: scans without lines, and palms registered before lines existed, are refused', async () => {
  const m = createHandGeometryMatcher({ threshold: 0.1, margin: 0.8, duplicateThreshold: 0.1, lines: { mode: 'require', threshold: 0.35 } });
  const shape = probeFor(makeHand(5));
  assert.deepEqual(m.validateProbe(shape), { ok: false, reason: 'no_palm_lines' });
  assert.deepEqual(m.validateProbe(withLines(shape, ['123'])), { ok: false, reason: 'no_palm_lines' });
  assert.equal(m.validateProbe(withLines(shape, [personCodes(1)])).ok, true);
  const old = [{ palmUserId: 'pu_old', model: 'mp-handgeom-v1', templateRef: { vector: shape.vector, hand: 'Right' } }];
  assert.equal((await m.identify(withLines(shape, [personCodes(1)]), old)).status, 'no_match');
});

test('palm lines end to end: register, pay with the same palm, a stranger cannot pay', async () => {
  const c = await testContainer({ palmLines: 'require', linesThreshold: 0.35, matchThreshold: 0.1, duplicateThreshold: 0.1 });
  const hand = makeHand(11);
  const mariyam = personCodes(31);
  await c.palmUsers.enroll(MIB, { bankCustomerRef: 'mib_c_mariyam', name: 'Mariyam Shaheen', accountRef: 'mib_a_mariyam_cur',
    palm: withLines(probeFor(hand), [mariyam, rescan(mariyam, 32), rescan(mariyam, 33)]), consent });

  // A stranger whose hand shape is the same: refused.
  const pi = await c.payments.createIntent(CAFE, { amount: 2500 });
  const stranger = await c.payments.authorize(CAFE, pi.id, { palm: withLines(probeFor(hand), [personCodes(77), personCodes(78)]) });
  assert.equal(stranger.intent.status, 'requires_palm');
  assert.equal(stranger.intent.lastError.code, 'palm_not_recognised');

  // A stranger can't register as a second person with the owner's palm, but can with their own.
  await assert.rejects(c.palmUsers.enroll(BML, { bankCustomerRef: 'bml_c_ibrahim', name: 'Ibrahim Nashid', accountRef: 'bml_a_ibrahim_cur',
    palm: withLines(probeFor(hand), [rescan(mariyam, 40)]), consent }), (e) => e.code === 'palm_already_enrolled');

  // Mariyam: paid.
  const res = await c.payments.authorize(CAFE, pi.id, { palm: withLines(probeFor(hand), [rescan(mariyam, 34), rescan(mariyam, 35), rescan(mariyam, 36)]) });
  assert.equal(res.intent.status, 'succeeded');
  assert.equal(res.match.status, 'match');
  assert.ok(res.match.lines < 0.35);
});

test('linesDistance takes the median, so one lucky frame cannot let a stranger in', () => {
  const owner = personCodes(50);
  const lucky = [rescan(owner, 51), personCodes(52), personCodes(53)]; // one good frame, two strangers
  assert.ok(linesDistance(lucky, [owner]) > 0.4);
});
