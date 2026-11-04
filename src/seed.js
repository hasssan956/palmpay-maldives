// Demo seed: two shops (one banks with BML, one with MIB, so both on-us and
// Favara payments can be shown) and one customer with palm payments already
// on (simulated, so "Simulate a scan" works before anyone enrols a real palm).
import { emptyPalmPayState } from './adapters/store/palmpay-repos.js';
import { seedSimBanks } from './sim-banks/seed.js';

export const DEMO_MERCHANTS = [
  { id: 'mer_raalhu_cafe', name: 'Raalhu Café', location: 'Majeedhee Magu, Malé', acquirerBankId: 'bml', settlementAccountRef: 'bml_m_raalhu', terminals: ['T-01'] },
  { id: 'mer_hulhumale_mart', name: 'Hulhumalé Mart', location: 'Nirolhu Magu, Hulhumalé', acquirerBankId: 'mib', settlementAccountRef: 'mib_m_mart', terminals: ['T-01'] },
];

export async function seed(c) {
  if (c.simBankStore) {
    await seedSimBanks(c.simBankStore);
    c.banks.reset?.();
  }
  await c.store.replaceAll(emptyPalmPayState());
  await c.store.run((r) => {
    for (const m of DEMO_MERCHANTS) r.merchants.create(m);
  });
  if (!c.config.demoMode) return;
  await c.palmUsers.enroll({ type: 'bank', bankId: 'bml' }, {
    bankCustomerRef: 'bml_c_aishath', name: 'Aishath Shiuna', phone: '7771234',
    accountRef: 'bml_a_aishath_cur', demo: true, consent: { accepted: true, version: 'demo-1' },
  });
}

// `npm run reset` from the shell.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { buildContainer } = await import('./container.js');
  const c = await buildContainer();
  await seed(c);
  await Promise.all([c.store.flush(), c.simBankStore?.flush()]);
  console.log(`Demo data reset in ${c.store.describe()}`);
}
