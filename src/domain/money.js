// Money is always an integer number of laari (1 MVR = 100 laari).
// Floats never touch balances; this is the rule that survives into production.

export const LAARI_PER_MVR = 100;

export function toLaari(mvr) {
  const n = typeof mvr === 'string' ? Number(mvr.replace(/,/g, '')) : Number(mvr);
  if (!Number.isFinite(n)) throw new TypeError('Amount is not a number');
  return Math.round(n * LAARI_PER_MVR);
}

export function assertLaari(value, { min = 0, max = Number.MAX_SAFE_INTEGER, field = 'amount' } = {}) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be an integer number of laari`);
  if (value < min || value > max) throw new RangeError(`${field} is out of range`);
  return value;
}

export function formatMVR(laari) {
  const sign = laari < 0 ? '-' : '';
  const abs = Math.abs(laari);
  const whole = Math.floor(abs / LAARI_PER_MVR).toLocaleString('en-US');
  const frac = String(abs % LAARI_PER_MVR).padStart(2, '0');
  return `${sign}MVR ${whole}.${frac}`;
}
