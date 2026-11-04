// BiometricMatcher adapter: compares MediaPipe hand-geometry vectors in-process.
// A vendor adapter (Tencent PalmAI, Keyo, Fujitsu PalmSecure, ...) would keep
// the same three methods and call the vendor's API instead.
import { FEATURE_MODEL, FEATURE_PAIRS, relativeDistance } from '../../../shared/palm-features.js';

export function createHandGeometryMatcher({ threshold, margin, duplicateThreshold }) {
  const expectedLength = FEATURE_PAIRS.length;

  function validateProbe(probe) {
    if (!probe || typeof probe !== 'object') return { ok: false, reason: 'missing_probe' };
    if (probe.model !== FEATURE_MODEL) return { ok: false, reason: 'unsupported_model' };
    const v = probe.vector;
    if (!Array.isArray(v) || v.length !== expectedLength) return { ok: false, reason: 'bad_vector' };
    if (!v.every((x) => Number.isFinite(x) && x > 0 && x < 5)) return { ok: false, reason: 'bad_vector' };
    if (probe.quality && probe.quality.frames < 8) return { ok: false, reason: 'too_few_frames' };
    return { ok: true };
  }

  function rank(probe, templates) {
    return templates
      .filter((t) => t.model === FEATURE_MODEL)
      .map((t) => ({ customerId: t.palmUserId ?? t.customerId, distance: round(relativeDistance(probe.vector, t.templateRef.vector)) }))
      .sort((a, b) => a.distance - b.distance);
  }

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
      const candidates = rank(probe, templates);
      const [best, second] = candidates;
      const top = candidates.slice(0, 3);
      if (!best || best.distance > threshold) return { status: 'no_match', distance: best?.distance, candidates: top, threshold };
      if (second && best.distance > second.distance * margin) {
        return { status: 'ambiguous', distance: best.distance, candidates: top, threshold };
      }
      return { status: 'match', customerId: best.customerId, distance: best.distance, candidates: top, threshold };
    },
  };
}

const round = (x) => Math.round(x * 10000) / 10000;
