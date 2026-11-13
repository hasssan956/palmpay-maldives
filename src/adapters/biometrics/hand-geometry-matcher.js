// BiometricMatcher adapter: compares MediaPipe hand-geometry vectors in-process.
// A vendor adapter (Tencent PalmAI, Keyo, Fujitsu PalmSecure, ...) would keep
// the same three methods and call the vendor's API instead.
import { FEATURE_MODEL, FEATURE_PAIRS, relativeDistance, evaluateLiveness } from '../../../shared/palm-features.js';
import { LINES_MODEL, isPalmCode, linesDistance } from '../../../shared/palm-lines.js';

// Two signals:
//   shape - finger and palm proportions. Barely differs between people, so with
//           palm lines on it is only a loose first filter (`threshold`).
//   lines - the palm's lines and creases (shared/palm-lines.js). This is what
//           tells people apart: a match needs the lines to match too.
// `lines.mode`: "require" (default) or "off" (shape only, the old behaviour).
const LINES_GAP = 0.03; // best palm must beat the runner-up by this much

export function createHandGeometryMatcher({ threshold, margin, duplicateThreshold, liveness = { mode: 'off' }, lines = { mode: 'off' } }) {
  const expectedLength = FEATURE_PAIRS.length;
  const useLines = lines.mode === 'require';
  const hasLines = (t) => Array.isArray(t.templateRef?.lines) && t.templateRef.lines.length > 0;

  // Liveness checks: tremor, device frame, glare (see shared/palm-features.js).
  // The scanner measures them; the server applies its own thresholds and has
  // the final say. "observe" records the scores without blocking, so the
  // thresholds can be tuned with real hands first. A vendor SDK does its own,
  // certified liveness instead.
  function liveFailures(probe) {
    if (liveness.mode !== 'enforce') return [];
    return evaluateLiveness(probe.liveness || {}, liveness).failed;
  }

  function validateProbe(probe) {
    if (!probe || typeof probe !== 'object') return { ok: false, reason: 'missing_probe' };
    if (probe.model !== FEATURE_MODEL) return { ok: false, reason: 'unsupported_model' };
    const v = probe.vector;
    if (!Array.isArray(v) || v.length !== expectedLength) return { ok: false, reason: 'bad_vector' };
    if (!v.every((x) => Number.isFinite(x) && x > 0 && x < 5)) return { ok: false, reason: 'bad_vector' };
    if (probe.quality && probe.quality.frames < 8) return { ok: false, reason: 'too_few_frames' };
    if (useLines) {
      const pl = probe.palmLines;
      if (!pl || pl.model !== LINES_MODEL || !Array.isArray(pl.codes) || pl.codes.length < 1 || pl.codes.length > 5 || !pl.codes.every(isPalmCode)) {
        return { ok: false, reason: 'no_palm_lines' };
      }
    }
    const failed = liveFailures(probe);
    if (failed.length) return { ok: false, reason: 'not_live', failed };
    return { ok: true };
  }

  function rank(probe, templates) {
    return templates
      .filter((t) => t.model === FEATURE_MODEL)
      .map((t) => ({
        customerId: t.palmUserId ?? t.customerId,
        hand: t.templateRef.hand || null,
        distance: round(relativeDistance(probe.vector, t.templateRef.vector)),
        template: t,
      }))
      .sort((a, b) => a.distance - b.distance);
  }

  // Shape filter first, then palm lines on what is left, best lines first.
  // Palms registered before palm lines existed have no lines and can't match:
  // the customer registers again.
  function rankByLines(probe, ranked, shapeLimit) {
    return ranked
      .filter((c) => c.distance <= shapeLimit && hasLines(c.template))
      .map((c) => ({ ...c, lines: linesDistance(probe.palmLines.codes, c.template.templateRef.lines) }))
      .sort((a, b) => a.lines - b.lines);
  }

  const publicCandidate = ({ template, ...c }) => c;

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
      const templateRef = { vector: probe.vector, hand: probe.hand || null };
      if (probe.palmLines?.codes) { templateRef.linesModel = LINES_MODEL; templateRef.lines = probe.palmLines.codes; }
      return { templateRef };
    },

    async findDuplicate(probe, templates) {
      if (useLines) {
        const [best] = rankByLines(probe, rank(probe, templates), duplicateThreshold);
        return best && best.lines <= lines.threshold ? publicCandidate(best) : null;
      }
      const [best] = rank(probe, templates);
      return best && best.distance <= duplicateThreshold ? publicCandidate(best) : null;
    },

    async identify(probe, templates) {
      if (useLines) return identifyWithLines(probe, templates);
      const all = rank(probe, templates).map(publicCandidate);
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

  function identifyWithLines(probe, templates) {
    const all = rank(probe, templates);
    const same = rankByLines(probe, all.filter(sameHand(probe)), threshold);
    const [best, second] = same;
    const out = (status, c, extra = {}) => ({
      status, distance: c?.distance, lines: c?.lines, threshold, linesThreshold: lines.threshold,
      candidates: same.slice(0, 3).map(publicCandidate), ...extra,
    });
    if (!best || best.lines > lines.threshold) {
      const [other] = rankByLines(probe, all.filter((c) => !sameHand(probe)(c)), threshold);
      if (other && other.lines <= lines.threshold) return out('wrong_hand', other);
      return out('no_match', best);
    }
    if (second && second.lines <= lines.threshold && second.lines - best.lines < LINES_GAP) return out('ambiguous', best);
    return out('match', best, { customerId: best.customerId });
  }
}

const round = (x) => Math.round(x * 10000) / 10000;
