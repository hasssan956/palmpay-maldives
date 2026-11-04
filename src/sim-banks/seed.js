// Demo data for the simulated banks. Names are fictional customers; the two
// banks are labelled "simulated" everywhere they appear in the UI.

const BANKS = [
  { id: 'bml', name: 'Bank of Maldives', short: 'BML', prefix: '7701' },
  { id: 'mib', name: 'Maldives Islamic Bank', short: 'MIB', prefix: '9010' },
];

const CUSTOMERS = [
  { id: 'bml_c_aishath', bankId: 'bml', name: 'Aishath Shiuna', phone: '7771234',
    accounts: [{ id: 'bml_a_aishath_cur', product: 'Current account', n: '204 118 352', opening: 250_000 },
               { id: 'bml_a_aishath_sav', product: 'Savings account', n: '204 118 771', opening: 1_200_000 }] },
  { id: 'bml_c_ibrahim', bankId: 'bml', name: 'Ibrahim Nashid', phone: '9605512',
    accounts: [{ id: 'bml_a_ibrahim_cur', product: 'Current account', n: '311 902 045', opening: 8_000 }] },
  { id: 'mib_c_mariyam', bankId: 'mib', name: 'Mariyam Shaheen', phone: '7654321',
    accounts: [{ id: 'mib_a_mariyam_cur', product: 'Current account', n: '552 640 913', opening: 120_000 }] },
];

const MERCHANT_ACCOUNTS = [
  { id: 'bml_m_raalhu', bankId: 'bml', ownerId: 'mer_raalhu_cafe', product: 'Merchant settlement', n: '880 100 221' },
  { id: 'mib_m_mart', bankId: 'mib', ownerId: 'mer_hulhumale_mart', product: 'Merchant settlement', n: '660 300 118' },
];

export async function seedSimBanks(store) {
  await store.replaceAll(store.empty());
  await store.run((r) => {
    for (const b of BANKS) {
      r.put('banks', { id: b.id, name: b.name, short: b.short, simulated: true });
      r.put('accounts', { id: `${b.id}_sys_funding`, bankId: b.id, ownerType: 'system', ownerId: b.id, product: 'Funding', number: `${b.prefix} 000 000 001`, currency: 'MVR' });
      r.put('accounts', { id: `${b.id}_sys_favara`, bankId: b.id, ownerType: 'system', ownerId: b.id, product: 'Favara settlement', number: `${b.prefix} 000 000 002`, currency: 'MVR' });
    }
    const prefix = Object.fromEntries(BANKS.map((b) => [b.id, b.prefix]));
    for (const c of CUSTOMERS) {
      r.put('customers', { id: c.id, bankId: c.bankId, name: c.name, phone: c.phone });
      for (const a of c.accounts) {
        r.put('accounts', { id: a.id, bankId: c.bankId, ownerType: 'customer', ownerId: c.id, product: a.product, number: `${prefix[c.bankId]} ${a.n}`, currency: 'MVR', status: 'active' });
        r.post({ bankId: c.bankId, type: 'opening', rail: 'internal', narrative: 'Opening balance', amount: a.opening,
          debitAccountId: `${c.bankId}_sys_funding`, creditAccountId: a.id }, [
          { accountId: `${c.bankId}_sys_funding`, amount: -a.opening },
          { accountId: a.id, amount: a.opening },
        ]);
      }
    }
    for (const m of MERCHANT_ACCOUNTS) {
      r.put('accounts', { id: m.id, bankId: m.bankId, ownerType: 'merchant', ownerId: m.ownerId, product: m.product, number: `${prefix[m.bankId]} ${m.n}`, currency: 'MVR', status: 'active' });
    }
  });
}
