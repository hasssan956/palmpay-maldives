// Composition root: the one file that picks adapters based on config.
// Adding Postgres, a real bank API or a palm-vein vendor means a case here.
import { config as defaultConfig } from './config.js';
import { createJsonStore } from './adapters/store/json-store.js';
import { emptyPalmPayState, makePalmPayRepos } from './adapters/store/palmpay-repos.js';
import { filePersistence, objectStoragePersistence } from './adapters/store/persistence.js';
import { createHandGeometryMatcher } from './adapters/biometrics/hand-geometry-matcher.js';
import { createSimulatedBankConnector } from './adapters/banks/simulated-connector.js';
import { createMemoryBus } from './adapters/events/memory-bus.js';
import { createSimBanks, emptyBankState, makeBankRepos } from './sim-banks/core.js';
import { createPalmUserService } from './services/palm-users.js';
import { createPaymentService } from './services/payments.js';

export async function buildContainer(overrides = {}) {
  const config = { ...defaultConfig, ...overrides.config };
  const bus = overrides.bus || createMemoryBus();

  const persistenceFor = async (file, key) =>
    config.storePersistence === 'replit-object-storage' ? objectStoragePersistence(key) : filePersistence(file);

  // --- PalmPay's own store ---
  if (config.storeDriver !== 'json') {
    throw new Error(`STORE_DRIVER=${config.storeDriver} has no adapter yet. See docs/ARCHITECTURE.md, "Moving to Postgres".`);
  }
  const store = await createJsonStore({
    persistence: overrides.persistence?.() || (await persistenceFor(config.storeFile, config.storeObjectKey)),
    emptyState: emptyPalmPayState,
    makeRepos: makePalmPayRepos,
    onCommit: (e) => bus.publish(e),
  });

  // --- Banks ---
  let banks;
  let simBankStore = null;
  let simBanks = null;
  switch (config.bankConnector) {
    case 'simulated':
      simBankStore = await createJsonStore({
        persistence: overrides.persistence?.() || (await persistenceFor(config.simBankFile, config.simBankObjectKey)),
        emptyState: emptyBankState,
        makeRepos: makeBankRepos,
      });
      simBanks = createSimBanks({ store: simBankStore });
      banks = createSimulatedBankConnector({ simBanks, latencyMs: config.simBankLatencyMs });
      break;
    default:
      throw new Error(`BANK_CONNECTOR=${config.bankConnector} has no adapter yet.`);
  }

  // --- Biometrics ---
  let matcher;
  switch (config.biometricProvider) {
    case 'hand-geometry':
      matcher = createHandGeometryMatcher({ threshold: config.matchThreshold, margin: config.matchMargin, duplicateThreshold: config.duplicateThreshold,
        liveness: { mode: config.livenessMode, checks: config.livenessChecks, minTremor: config.minTremor,
          maxDeviceScore: config.maxDeviceScore, maxGlare: config.maxGlare } });
      break;
    default:
      throw new Error(`BIOMETRIC_PROVIDER=${config.biometricProvider} has no adapter yet.`);
  }

  const deps = { uow: store, matcher, banks, config };
  return {
    config, bus, store, matcher, banks, simBankStore, simBanks,
    palmUsers: createPalmUserService(deps),
    payments: createPaymentService(deps),
  };
}
