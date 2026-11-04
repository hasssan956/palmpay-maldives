import { randomBytes, randomInt } from 'node:crypto';

// Prefixed, sortable-enough ids (time + randomness). Prefixes make logs and
// support tickets readable: cus_, acc_, txn_, pi_, plm_, evt_.
export function newId(prefix) {
  const t = Date.now().toString(36);
  const r = randomBytes(6).toString('hex');
  return `${prefix}_${t}${r}`;
}

// 13-digit wallet number grouped as 4-3-3-3, e.g. 7710 482 019 334.
export function newAccountNumber() {
  let digits = '7710';
  for (let i = 0; i < 9; i++) digits += randomInt(0, 10);
  return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 10)} ${digits.slice(10)}`;
}

// Short human reference printed on receipts.
export function newReference() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[randomInt(0, alphabet.length)];
  return `PP-${s.slice(0, 4)}-${s.slice(4)}`;
}
