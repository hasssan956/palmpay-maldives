// Payment intents at the shop counter.
//
//   requires_palm --palm matched--> processing --bank approves--> succeeded
//        |                               \--bank declines--> failed (insufficient_funds, ...)
//        |--palm not matched x N--> failed (palm_not_recognised)
//        |--over customer's palm limit--> failed (over_palm_limit)
//        |--cancel--> canceled          \--ttl passes--> expired
//
// PalmPay never moves money itself. It identifies the payer, then asks the
// payer's bank to authorise the debit through the BankConnector port.
import { DomainError, conflict, invalid, notFound } from '../domain/errors.js';
import { newId, newReference } from '../domain/ids.js';
import { assertLaari } from '../domain/money.js';
import { shortName } from './palm-users.js';

const OPEN = 'requires_palm';

export function createPaymentService({ uow, matcher, banks, config }) {
  function sanitizeItems(items) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 50).map((it) => ({
      name: String(it.name || 'Item').slice(0, 60),
      qty: Math.max(1, Math.min(99, Number.parseInt(it.qty, 10) || 1)),
      unitPrice: assertLaari(Number(it.unitPrice), { min: 0, max: 10_000_000, field: 'unitPrice' }),
    }));
  }

  function terminalMerchant(partner, merchantId) {
    if (partner?.type !== 'terminal') throw new DomainError('forbidden', 'Only a shop terminal can take payments.', { status: 403 });
    if (merchantId && merchantId !== partner.merchantId) throw new DomainError('forbidden', 'This terminal belongs to another shop.', { status: 403 });
    return partner.merchantId;
  }

  function ownIntent(r, partner, id) {
    const pi = r.intents.get(id);
    if (!pi || pi.merchantId !== partner?.merchantId) throw notFound('payment_intent');
    return pi;
  }

  return {
    async createIntent(partner, { merchantId, terminalId = 'T-01', amount, items, description, idempotencyKey }) {
      merchantId = terminalMerchant(partner, merchantId);
      const cleanItems = sanitizeItems(items);
      if (amount === undefined && cleanItems.length) amount = cleanItems.reduce((a, it) => a + it.qty * it.unitPrice, 0);
      assertLaari(amount, { min: 100, max: 10_000_000, field: 'amount' });
      if (cleanItems.length && cleanItems.reduce((a, it) => a + it.qty * it.unitPrice, 0) !== amount) {
        throw invalid('Amount does not equal the sum of the items.');
      }
      return uow.run((r) => {
        const merchant = r.merchants.get(merchantId);
        if (!merchant) throw notFound('merchant');
        if (idempotencyKey) {
          const existing = r.intents.findByIdempotencyKey(merchantId, idempotencyKey);
          if (existing) {
            if (existing.amount !== amount) throw conflict('idempotency_mismatch', 'This idempotency key was used for a different amount.');
            return existing;
          }
        }
        const pi = r.intents.create({
          id: newId('pi'), merchantId, merchantName: merchant.name, terminalId: String(terminalId).slice(0, 20),
          amount, currency: config.currency, items: cleanItems, description: description ? String(description).slice(0, 120) : null,
          status: OPEN, attempts: 0, idempotencyKey: idempotencyKey || null, reference: newReference(),
          expiresAt: new Date(Date.now() + config.intentTtlSeconds * 1000).toISOString(),
        });
        r.outbox.add('payment_intent.created', { intentId: pi.id, merchantId, terminalId: pi.terminalId, amount });
        return pi;
      });
    },

    async getIntent(partner, id) {
      return uow.read((r) => {
        const pi = ownIntent(r, partner, id);
        if (pi.status === OPEN && Date.parse(pi.expiresAt) < Date.now()) return { ...pi, status: 'expired' };
        return pi;
      });
    },

    async cancelIntent(partner, id) {
      return uow.run((r) => {
        const pi = ownIntent(r, partner, id);
        if (pi.status !== OPEN) throw conflict('intent_not_open', `Payment is already ${pi.status}.`);
        r.outbox.add('payment_intent.canceled', { intentId: id, merchantId: pi.merchantId, terminalId: pi.terminalId });
        return r.intents.update(id, { status: 'canceled' });
      });
    },

    async getPayment(partner, id) {
      return uow.read((r) => {
        const p = r.payments.get(id);
        const allowed = p && ((partner?.type === 'terminal' && p.merchantId === partner.merchantId) ||
          (partner?.type === 'bank' && p.bankId === partner.bankId));
        if (!allowed) throw notFound('payment');
        return p;
      });
    },

    /**
     * 1. identify the palm  2. check PalmPay rules  3. ask the payer's bank
     * 4. record the outcome. Steps 1-2 and 4 are local units of work; step 3 is
     * a call to another system and happens between them, never inside a lock.
     */
    async authorize(partner, id, { palm, demo }) {
      if (demo && !config.demoMode) throw new DomainError('demo_disabled', 'Simulated scans are turned off.', { status: 403 });
      if (!demo) {
        const check = matcher.validateProbe(palm);
        if (!check.ok) throw invalid('The palm scan was not usable. Hold your whole hand inside the outline and scan again.', { reason: check.reason });
      }

      // --- Steps 1 + 2 ---
      const step = await uow.run(async (r) => {
        let pi = ownIntent(r, partner, id);
        if (pi.status === 'succeeded') return { done: { intent: pi, payment: r.payments.get(pi.paymentId), replay: true } };
        if (pi.status === OPEN && Date.parse(pi.expiresAt) < Date.now()) {
          r.intents.update(id, { status: 'expired' });
          return { done: { intent: r.intents.get(id) } };
        }
        if (pi.status === 'processing') throw conflict('intent_processing', 'This payment is already being approved.');
        if (pi.status !== OPEN) throw conflict('intent_not_open', `Payment is ${pi.status}.`);

        let match;
        if (demo) {
          const u = r.palmUsers.get(demo.palmUserId);
          if (!u || u.status !== 'active') throw notFound('palm_user');
          match = { status: 'match', palmUserId: u.id, method: 'simulated' };
        } else {
          const m = await matcher.identify(palm, r.palmTemplates.listActive());
          match = { ...m, palmUserId: m.customerId, method: 'palm' };
        }
        const debug = config.exposeMatchDebug
          ? { status: match.status, distance: match.distance, threshold: match.threshold, candidates: match.candidates?.map((c) => ({ distance: c.distance })) }
          : undefined;

        if (match.status !== 'match') {
          const attempts = pi.attempts + 1;
          const failed = attempts >= config.maxScanAttempts;
          const updated = r.intents.update(id, {
            attempts, status: failed ? 'failed' : OPEN,
            lastError: { code: { ambiguous: 'palm_ambiguous', wrong_hand: 'palm_wrong_hand' }[match.status] || 'palm_not_recognised', at: new Date().toISOString() },
            failureReason: failed ? 'palm_not_recognised' : null,
          });
          r.outbox.add(failed ? 'payment_intent.failed' : 'payment_intent.scan_failed', {
            intentId: id, merchantId: pi.merchantId, terminalId: pi.terminalId, attempts, reason: updated.lastError.code,
          });
          return { done: { intent: updated, match: debug } };
        }

        const user = r.palmUsers.get(match.palmUserId);
        const merchant = r.merchants.get(pi.merchantId);
        const who = { palmUserId: user.id, bankId: user.funding.bankId, bankCustomerRef: user.bankCustomerRef };
        if (pi.amount > user.limit) {
          const updated = r.intents.update(id, { status: 'failed', failureReason: 'over_palm_limit', palmUserId: user.id, attempts: pi.attempts + 1 });
          r.outbox.add('payment_intent.failed', { intentId: id, merchantId: pi.merchantId, terminalId: pi.terminalId, ...who, amount: pi.amount, merchantName: merchant.name, reason: 'over_palm_limit' });
          return { done: { intent: updated, match: debug } };
        }
        pi = r.intents.update(id, { status: 'processing', palmUserId: user.id, attempts: pi.attempts + 1 });
        return { pi, user, merchant, method: match.method, distance: match.distance ?? null, debug, who };
      });
      if (step.done) return step.done;

      // --- Step 3: the payer's bank decides ---
      const { pi, user, merchant, who } = step;
      let bankResult;
      try {
        bankResult = await banks.authorizeDebit({
          issuerBankId: user.funding.bankId, accountRef: user.funding.accountRef, amount: pi.amount,
          acquirerBankId: merchant.acquirerBankId, creditAccountRef: merchant.settlementAccountRef,
          reference: pi.reference, narrative: `Palm payment, ${merchant.name}`, idempotencyKey: pi.id,
        });
      } catch (err) {
        console.error('[payments] bank call failed:', err.message);
        bankResult = { error: true };
      }

      // --- Step 4: record the outcome ---
      return uow.run((r) => {
        if (bankResult.error) {
          const updated = r.intents.update(pi.id, { status: OPEN, lastError: { code: 'bank_unavailable', at: new Date().toISOString() } });
          return { intent: updated, match: step.debug };
        }
        if (!bankResult.approved) {
          const updated = r.intents.update(pi.id, { status: 'failed', failureReason: bankResult.reason });
          r.outbox.add('payment_intent.failed', { intentId: pi.id, merchantId: pi.merchantId, terminalId: pi.terminalId, ...who, amount: pi.amount, merchantName: merchant.name, reason: bankResult.reason });
          return { intent: updated, match: step.debug };
        }
        const payment = r.payments.create({
          id: newId('pay'), reference: pi.reference, intentId: pi.id, amount: pi.amount, currency: pi.currency,
          palmUserId: user.id, customerName: user.name, customerShort: shortName(user.name),
          bankId: user.funding.bankId, bankShort: user.funding.bankShort, accountMasked: user.funding.masked, accountLabel: user.funding.label,
          merchantId: merchant.id, merchantName: merchant.name, acquirerBankId: merchant.acquirerBankId, terminalId: pi.terminalId,
          items: pi.items, rail: bankResult.rail, authCode: bankResult.authCode, method: step.method, matchDistance: step.distance,
        });
        const updated = r.intents.update(pi.id, { status: 'succeeded', paymentId: payment.id, lastError: null });
        r.outbox.add('payment.succeeded', {
          ...who, intentId: pi.id, paymentId: payment.id, merchantId: merchant.id, terminalId: pi.terminalId,
          amount: pi.amount, merchantName: merchant.name, reference: payment.reference, rail: payment.rail,
        });
        return { intent: updated, payment, match: step.debug };
      });
    },
  };
}
