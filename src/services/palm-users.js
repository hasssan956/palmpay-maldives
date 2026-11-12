// Palm users: a bank customer who has switched on palm payments in their
// bank's app. PalmPay stores the palm template, the bank's reference for the
// customer, and the bank account (by the bank's reference) they pay from.
import { DomainError, conflict, invalid, notFound } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import { assertLaari } from '../domain/money.js';

const MAX_SNAPSHOT_BYTES = 200_000;

export function shortName(name = '') {
  const [first, ...rest] = name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest[rest.length - 1][0]}.` : first;
}

export function createPalmUserService({ uow, matcher, banks, config }) {
  function present(r, u) {
    const t = r.palmTemplates.activeFor(u.id);
    return {
      id: u.id, bankId: u.bankId, bankCustomerRef: u.bankCustomerRef, name: u.name, nameShort: shortName(u.name),
      status: u.status, funding: u.funding, limit: u.limit, enrolledAt: u.createdAt,
      palm: t ? { mode: 'palm', model: t.model, snapshot: t.snapshot || null } : { mode: 'simulated' },
    };
  }

  function ownedBy(u, partner) {
    if (!u || u.status !== 'active') throw notFound('palm_user');
    if (partner && partner.type === 'bank' && partner.bankId !== u.bankId) throw notFound('palm_user');
    return u;
  }

  async function checkAccount(bankId, bankCustomerRef, accountRef) {
    const v = await banks.verifyAccount({ bankId, bankCustomerRef, accountRef });
    if (!v.ok) throw invalid('The bank could not confirm that account for this customer.');
    const bank = await banks.describe(bankId);
    return { bankId, bankShort: bank.short, accountRef, label: v.label, masked: v.masked };
  }

  function checkLimit(limit) {
    assertLaari(limit, { min: 10_000, max: config.maxPalmLimit, field: 'limit' });
    return limit;
  }

  return {
    /**
     * Called by the partner bank (from its app via its backend) after the
     * customer agrees to the terms and scans their palm.
     */
    async enroll(partner, { bankCustomerRef, name, phone, accountRef, limit = config.defaultPalmLimit, palm, snapshot, consent, demo = false }) {
      if (partner?.type !== 'bank') throw new DomainError('forbidden', 'Only a partner bank can enrol customers.', { status: 403 });
      const bankId = partner.bankId;
      if (!consent?.accepted) throw invalid('The customer must accept the palm payment terms first.');
      name = String(name || '').trim();
      if (name.length < 2) throw invalid('Customer name is missing.');
      if (!bankCustomerRef) throw invalid('bankCustomerRef is required.');
      checkLimit(limit);
      if (snapshot && (typeof snapshot !== 'string' || !snapshot.startsWith('data:image/') || snapshot.length > MAX_SNAPSHOT_BYTES)) {
        throw invalid('Palm snapshot must be a small JPEG or PNG data URL.');
      }
      if (demo && !config.demoMode) throw new DomainError('demo_disabled', 'Simulated enrolment is turned off.', { status: 403 });

      let templateRef = null;
      if (!demo) {
        const check = matcher.validateProbe(palm);
        if (!check.ok) {
          throw invalid(check.reason === 'not_live'
            ? 'This did not look like a live hand. Scan your own hand, not a photo or a screen.'
            : 'The palm scan was not usable. Scan again with the whole hand inside the outline.', { reason: check.reason, failed: check.failed });
        }
        templateRef = (await matcher.enroll(palm)).templateRef;
      }
      const funding = await checkAccount(bankId, bankCustomerRef, accountRef);

      return uow.run(async (r) => {
        if (r.palmUsers.byBankCustomer(bankId, bankCustomerRef)) {
          throw conflict('already_enrolled', 'Palm payments are already on for this customer.');
        }
        if (!demo) {
          const dup = await matcher.findDuplicate(palm, r.palmTemplates.listActive());
          if (dup) throw conflict('palm_already_enrolled', 'This palm is already registered to another PalmPay user.');
        }
        const u = r.palmUsers.create({
          id: newId('pu'), bankId, bankCustomerRef, name, phone: phone || null, funding, limit, status: 'active',
          consent: { accepted: true, at: consent.at || new Date().toISOString(), version: consent.version || 'demo-1' },
        });
        if (templateRef) {
          r.palmTemplates.create({ id: newId('plm'), palmUserId: u.id, model: matcher.model, templateRef, quality: palm.quality || null, snapshot: snapshot || null });
        }
        r.outbox.add('palm.enrolled', { palmUserId: u.id, bankId, bankCustomerRef });
        return present(r, u);
      });
    },

    async findForBankCustomer(partner, bankCustomerRef) {
      return uow.read((r) => {
        const u = r.palmUsers.byBankCustomer(partner.bankId, bankCustomerRef);
        return u && u.status === 'active' ? present(r, u) : null;
      });
    },

    async get(partner, id) {
      return uow.read((r) => present(r, ownedBy(r.palmUsers.get(id), partner)));
    },

    async update(partner, id, { limit, accountRef }) {
      const current = await uow.read((r) => ownedBy(r.palmUsers.get(id), partner));
      const patch = {};
      if (limit !== undefined) patch.limit = checkLimit(limit);
      if (accountRef !== undefined) patch.funding = await checkAccount(current.bankId, current.bankCustomerRef, accountRef);
      return uow.run((r) => {
        const u = ownedBy(r.palmUsers.get(id), partner);
        r.palmUsers.update(u.id, patch);
        r.outbox.add('palm.updated', { palmUserId: u.id, bankId: u.bankId, bankCustomerRef: u.bankCustomerRef });
        return present(r, r.palmUsers.get(u.id));
      });
    },

    /** Turn off palm payments: the template is deleted, not just disabled. */
    async remove(partner, id) {
      return uow.run((r) => {
        const u = ownedBy(r.palmUsers.get(id), partner);
        r.palmTemplates.revokeFor(u.id);
        r.palmUsers.update(u.id, { status: 'deleted', deletedAt: new Date().toISOString() });
        r.outbox.add('palm.deleted', { palmUserId: u.id, bankId: u.bankId, bankCustomerRef: u.bankCustomerRef });
        return { deleted: true };
      });
    },

    async payments(partner, id, { limit = 50 } = {}) {
      return uow.read((r) => {
        ownedBy(r.palmUsers.get(id), partner);
        return r.payments.listFor(id, { limit });
      });
    },

    /** Demo only: who can be picked in "Simulate a scan". */
    async listForDemo() {
      return uow.read((r) => r.palmUsers.list().map((u) => present(r, u)));
    },
  };
}
