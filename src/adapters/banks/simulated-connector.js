// BankConnector adapter for the simulated banks.
//
// A real connector (e.g. adapters/banks/http-connector.js) keeps these three
// methods and calls each bank's API over mutual TLS instead:
//   describe       -> static config per partner bank
//   verifyAccount  -> bank confirms the account belongs to the customer (token)
//   authorizeDebit -> bank authorises + posts the debit, routes via Favara if
//                     the merchant banks elsewhere, returns an auth code
export function createSimulatedBankConnector({ simBanks, latencyMs = 350 }) {
  let banks;
  const load = async () => (banks ||= Object.fromEntries((await simBanks.listBanks()).map((b) => [b.id, b])));

  return {
    kind: 'simulated',
    async describe(bankId) {
      const b = (await load())[bankId];
      return b ? { id: b.id, name: b.name, short: b.short, simulated: true } : null;
    },
    async verifyAccount({ bankId, bankCustomerRef, accountRef }) {
      return simBanks.verifyAccount(bankId, bankCustomerRef, accountRef);
    },
    async authorizeDebit(req) {
      // A real bank call can be slow; keep a little latency so the UI is honest.
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      return simBanks.authorizeDebit(req);
    },
    reset() { banks = undefined; },
  };
}
