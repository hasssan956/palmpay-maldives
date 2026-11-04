import { buildContainer } from './container.js';
import { createApp } from './http/app.js';
import { seed } from './seed.js';

const c = await buildContainer();

// First boot (or a wiped deployment disk): load demo data.
const hasData = await c.store.read((r) => r.merchants.list().length > 0);
const hasBanks = c.simBanks ? (await c.simBanks.listBanks()).length > 0 : true;
if (!hasData || !hasBanks) {
  await seed(c);
  console.log('[palmpay] Seeded demo data');
}

const app = createApp(c);
app.listen(c.config.port, '0.0.0.0', () => {
  console.log(`[palmpay] Listening on :${c.config.port} (store: ${c.store.describe()}, banks: ${c.banks.kind}, matcher: ${c.matcher.model}, demo: ${c.config.demoMode})`);
});
