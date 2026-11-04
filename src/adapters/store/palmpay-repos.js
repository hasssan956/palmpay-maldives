// PalmPay's own data. Note what is NOT here: no balances, no bank accounts.
// PalmPay knows who a palm belongs to, which bank account (by the bank's
// reference) they chose to pay from, and the payments it routed.
// db/migrations/001_init.sql is the same model in PostgreSQL.
import { newId } from '../../domain/ids.js';

export function emptyPalmPayState() {
  return {
    schemaVersion: 2,
    palmUsers: {},
    palmTemplates: {},
    merchants: {},
    intents: {},
    payments: {},
    events: [],
  };
}

export function makePalmPayRepos(s, pendingEvents, { writable }) {
  const guard = () => {
    if (!writable) throw new Error('Write attempted inside a read-only unit of work');
  };
  const now = () => new Date().toISOString();
  const values = (obj) => Object.values(obj);

  return {
    palmUsers: {
      create(u) { guard(); s.palmUsers[u.id] = { ...u, createdAt: now() }; return s.palmUsers[u.id]; },
      get: (id) => s.palmUsers[id] || null,
      byBankCustomer: (bankId, bankCustomerRef) =>
        values(s.palmUsers).find((u) => u.bankId === bankId && u.bankCustomerRef === bankCustomerRef && u.status !== 'deleted') || null,
      list: () => values(s.palmUsers).filter((u) => u.status === 'active'),
      update(id, patch) { guard(); Object.assign(s.palmUsers[id], patch, { updatedAt: now() }); return s.palmUsers[id]; },
    },

    palmTemplates: {
      create(t) { guard(); s.palmTemplates[t.id] = { ...t, status: 'active', createdAt: now() }; return s.palmTemplates[t.id]; },
      listActive: () => values(s.palmTemplates).filter((t) => t.status === 'active'),
      activeFor: (palmUserId) =>
        values(s.palmTemplates).find((t) => t.palmUserId === palmUserId && t.status === 'active') || null,
      revokeFor(palmUserId) {
        guard();
        let n = 0;
        for (const t of values(s.palmTemplates)) {
          if (t.palmUserId === palmUserId && t.status === 'active') { t.status = 'revoked'; t.revokedAt = now(); n++; }
        }
        return n;
      },
    },

    merchants: {
      create(m) { guard(); s.merchants[m.id] = { ...m, createdAt: now() }; return s.merchants[m.id]; },
      get: (id) => s.merchants[id] || null,
      list: () => values(s.merchants),
    },

    intents: {
      create(pi) { guard(); s.intents[pi.id] = { ...pi, createdAt: now(), updatedAt: now() }; return s.intents[pi.id]; },
      get: (id) => s.intents[id] || null,
      findByIdempotencyKey: (merchantId, key) =>
        values(s.intents).find((pi) => pi.merchantId === merchantId && pi.idempotencyKey === key) || null,
      update(id, patch) { guard(); Object.assign(s.intents[id], patch, { updatedAt: now() }); return s.intents[id]; },
    },

    payments: {
      create(p) { guard(); s.payments[p.id] = { ...p, createdAt: now() }; return s.payments[p.id]; },
      get: (id) => s.payments[id] || null,
      listFor(palmUserId, { limit = 50 } = {}) {
        return values(s.payments)
          .filter((p) => p.palmUserId === palmUserId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit);
      },
    },

    outbox: {
      add(type, payload) {
        guard();
        pendingEvents.push({ id: newId('evt'), type, payload, createdAt: now() });
      },
    },
  };
}
