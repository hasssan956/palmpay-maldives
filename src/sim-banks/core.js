// SIMULATED BANK CORES (stand-ins for BML's and MIB's own systems).
//
// Everything in this folder plays the part of the banks. In production none of
// it exists inside PalmPay: the banks run their own core banking, and PalmPay
// reaches them through adapters/banks/*-connector.js over their APIs.
// It has its own store file so PalmPay code cannot reach into it by accident.
import { randomInt } from 'node:crypto';
import { newId } from '../domain/ids.js';

export function emptyBankState() {
  return { schemaVersion: 1, banks: {}, customers: {}, accounts: {}, ledger: [], postings: {}, idempotency: {} };
}

export function makeBankRepos(s, _pending, { writable }) {
  const guard = () => { if (!writable) throw new Error('read-only'); };
  const now = () => new Date().toISOString();
  return {
    state: s,
    now,
    put(collection, obj) { guard(); s[collection][obj.id] = { ...obj, createdAt: obj.createdAt || now() }; return s[collection][obj.id]; },
    balanceOf: (accountId) => s.ledger.reduce((a, e) => (e.accountId === accountId ? a + e.amount : a), 0),
    post(posting, entries) {
      guard();
      if (entries.reduce((a, e) => a + e.amount, 0) !== 0) throw new Error('unbalanced posting');
      const p = { ...posting, id: posting.id || newId('pst'), createdAt: now() };
      s.postings[p.id] = p;
      for (const e of entries) s.ledger.push({ txnId: p.id, accountId: e.accountId, amount: e.amount, createdAt: p.createdAt });
      return p;
    },
    remember(key, value) { guard(); s.idempotency[key] = value; },
  };
}

const masked = (number) => `••${number.replace(/\D/g, '').slice(-4)}`;

export function createSimBanks({ store }) {
  function publicAccount(r, a) {
    return { id: a.id, product: a.product, number: a.number, masked: masked(a.number), currency: a.currency, balance: r.balanceOf(a.id) };
  }

  return {
    async listBanks() {
      return store.read((r) => Object.values(r.state.banks));
    },

    async listCustomers() {
      return store.read((r) =>
        Object.values(r.state.customers).map((c) => ({
          id: c.id, bankId: c.bankId, bank: r.state.banks[c.bankId], name: c.name,
          phoneMasked: `+960 ${c.phone.slice(0, 3)}-••${c.phone.slice(5)}`,
        })),
      );
    },

    async getCustomer(bankId, customerId) {
      return store.read((r) => {
        const c = r.state.customers[customerId];
        if (!c || c.bankId !== bankId) return null;
        const accounts = Object.values(r.state.accounts).filter((a) => a.ownerType === 'customer' && a.ownerId === c.id);
        return { id: c.id, bankId, bank: r.state.banks[bankId], name: c.name, phone: c.phone, accounts: accounts.map((a) => publicAccount(r, a)) };
      });
    },

    async statement(bankId, customerId, { limit = 50 } = {}) {
      return store.read((r) => {
        const mine = new Map(Object.values(r.state.accounts)
          .filter((a) => a.bankId === bankId && a.ownerType === 'customer' && a.ownerId === customerId)
          .map((a) => [a.id, a]));
        return Object.values(r.state.postings)
          .filter((p) => mine.has(p.debitAccountId) || mine.has(p.creditAccountId))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit)
          .map((p) => {
            const out = mine.has(p.debitAccountId);
            const acc = mine.get(out ? p.debitAccountId : p.creditAccountId);
            return { ...p, direction: out ? 'out' : 'in', accountMasked: masked(acc.number), accountProduct: acc.product };
          });
      });
    },

    /** Bank-side check that an account belongs to the customer and can pay. */
    async verifyAccount(bankId, customerId, accountId) {
      return store.read((r) => {
        const a = r.state.accounts[accountId];
        if (!a || a.bankId !== bankId || a.ownerType !== 'customer' || a.ownerId !== customerId) return { ok: false };
        return { ok: true, label: a.product, masked: masked(a.number), currency: a.currency };
      });
    },

    /**
     * Debit the payer and credit the merchant. Same bank: one internal
     * transfer ("on-us"). Different banks: issuer debits the customer and
     * sends over Favara; acquirer receives over Favara and credits the merchant.
     */
    async authorizeDebit({ issuerBankId, accountRef, amount, acquirerBankId, creditAccountRef, reference, narrative, idempotencyKey }) {
      return store.run((r) => {
        const s = r.state;
        if (idempotencyKey && s.idempotency[idempotencyKey]) return s.idempotency[idempotencyKey];
        const finish = (result) => { if (idempotencyKey) r.remember(idempotencyKey, result); return result; };

        const acc = s.accounts[accountRef];
        const merchantAcc = s.accounts[creditAccountRef];
        if (!acc || acc.bankId !== issuerBankId) return finish({ approved: false, reason: 'account_not_found' });
        if (!merchantAcc || merchantAcc.bankId !== acquirerBankId) return finish({ approved: false, reason: 'merchant_account_invalid' });
        if (acc.status && acc.status !== 'active') return finish({ approved: false, reason: 'account_blocked' });
        if (r.balanceOf(acc.id) < amount) return finish({ approved: false, reason: 'insufficient_funds' });

        const authCode = String(randomInt(100000, 999999));
        if (issuerBankId === acquirerBankId) {
          r.post({ bankId: issuerBankId, type: 'palm_payment', rail: 'on-us', narrative, reference, amount, authCode,
            debitAccountId: acc.id, creditAccountId: merchantAcc.id }, [
            { accountId: acc.id, amount: -amount },
            { accountId: merchantAcc.id, amount },
          ]);
          return finish({ approved: true, authCode, rail: 'on-us' });
        }
        const issuerFavara = `${issuerBankId}_sys_favara`;
        const acquirerFavara = `${acquirerBankId}_sys_favara`;
        r.post({ bankId: issuerBankId, type: 'palm_payment', rail: 'favara', narrative, reference, amount, authCode,
          debitAccountId: acc.id, creditAccountId: issuerFavara }, [
          { accountId: acc.id, amount: -amount },
          { accountId: issuerFavara, amount },
        ]);
        r.post({ bankId: acquirerBankId, type: 'favara_in', rail: 'favara', narrative: `Favara in, ${reference}`, reference, amount,
          debitAccountId: acquirerFavara, creditAccountId: merchantAcc.id }, [
          { accountId: acquirerFavara, amount: -amount },
          { accountId: merchantAcc.id, amount },
        ]);
        return finish({ approved: true, authCode, rail: 'favara' });
      });
    },

    async merchantBalance(accountId) {
      return store.read((r) => r.balanceOf(accountId));
    },
  };
}
