// BiometricMatcher adapter: compares MediaPipe hand-geometry vectors in-process.
// A vendor adapter (Tencent PalmAI, Keyo, Fujitsu PalmSecure, ...) would keep
// the same three methods and call the vendor's API instead.
import { FEATURE_MODEL, FEATURE_PAIRS, relativeDistance } from '../../../shared/palm-features.js';

export function createHandGeometryMatcher({ threshold, margin, duplicateThreshold, liveness = { mode: 'off' } }) {
  const expectedLength = FEATURE_PAIRS.length;

  // Tremor liveness (see tremorScore in shared/palm-features.js). The scanner
  // measures it; the server has the final say. "observe" records the score
  // without blocking, so the threshold can be tuned with real hands first.
  // A vendor SDK does its own, certified liveness instead.
  function isLive(probe) {
    if (liveness.mode !== 'enforce') return true;
    const t = probe.liveness?.tremor;
    return Number.isFinite(t) && t >= liveness.minTremor;
  }

  function validateProbe(probe) {
    if (!probe || typeof probe !== 'object') return { ok: false, reason: 'missing_probe' };
    if (probe.model !== FEATURE_MODEL) return { ok: false, reason: 'unsupported_model' };
    const v = probe.vector;
    if (!Array.isArray(v) || v.length !== expectedLength) return { ok: false, reason: 'bad_vector' };
    if (!v.every((x) => Number.isFinite(x) && x > 0 && x < 5)) return { ok: false, reason: 'bad_vector' };
    if (probe.quality && probe.quality.frames < 8) return { ok: false, reason: 'too_few_frames' };
    if (!isLive(probe)) return { ok: false, reason: 'not_live' };
    return { ok: true };
  }

  function rank(probe, templates) {
    return templates
      .filter((t) => t.model === FEATURE_MODEL)
      .map((t) => ({
        customerId: t.palmUserId ?? t.customerId,
        hand: t.templateRef.hand || null,
        distance: round(relativeDistance(probe.vector, t.templateRef.vector)),
      }))
      .sort((a, b) => a.distance - b.distance);
  }

  // Left and right hands of one person are near mirror images, so their
  // geometry is almost identical. The detector's left/right label is what
  // tells them apart: a template only matches a probe of the same hand.
  const sameHand = (probe) => (c) => !probe.hand || !c.hand || c.hand === probe.hand;

  return {
    model: FEATURE_MODEL,
    validateProbe,

    // Hand geometry: the template is the vector itself. A vendor would return
    // { vendorTemplateId } here and keep the biometric on their side.
    async enroll(probe) {
      return { templateRef: { vector: probe.vector, hand: probe.hand || null } };
    },

    async findDuplicate(probe, templates) {
      const [best] = rank(probe, templates);
      return best && best.distance <= duplicateThreshold ? best : null;
    },

    async identify(probe, templates) {
      const all = rank(probe, templates);
      const candidates = all.filter(sameHand(probe));
      const [best, second] = candidates;
      const top = candidates.slice(0, 3);
      if (!best || best.distance > threshold) {
        // Close match on the other hand: the customer used the wrong hand.
        const other = all.find((c) => !sameHand(probe)(c));
        if (other && other.distance <= threshold) return { status: 'wrong_hand', distance: other.distance, candidates: top, threshold };
        return { status: 'no_match', distance: best?.distance, candidates: top, threshold };
      }
      if (second && best.distance > second.distance * margin) {
        return { status: 'ambiguous', distance: best.distance, candidates: top, threshold };
      }
      return { status: 'match', customerId: best.customerId, distance: best.distance, candidates: top, threshold };
    },
  };
}

const round = (x) => Math.round(x * 10000) / 10000;
