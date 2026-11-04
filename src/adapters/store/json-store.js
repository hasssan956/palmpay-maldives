// Generic JSON store: a UnitOfWork over an in-memory state object that is
// snapshotted to a persistence backend after each commit.
//
// Two separate stores use it: PalmPay's own data (palmpay-repos.js) and the
// simulated bank cores (sim-banks/repos.js). Keeping them in separate files
// mirrors reality: PalmPay never reads a bank's database, it calls the bank.

export async function createJsonStore({ persistence, emptyState, makeRepos, onCommit = () => {}, maxEvents = 500 }) {
  const fresh = emptyState();
  let state = (await persistence.load()) || fresh;
  if (state.schemaVersion !== fresh.schemaVersion) {
    console.warn(`[store] ${persistence.name}: schema ${state.schemaVersion} -> ${fresh.schemaVersion}, starting fresh`);
    state = fresh;
  }

  let lock = Promise.resolve();
  let saving = Promise.resolve();

  function persist() {
    const snapshot = state;
    saving = saving.then(() => persistence.save(snapshot)).catch((err) => {
      console.error(`[store] ${persistence.name} persist failed:`, err.message);
    });
    return saving;
  }

  async function withLock(fn) {
    const prev = lock;
    let release;
    lock = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function run(fn) {
    return withLock(async () => {
      const draft = structuredClone(state);
      const pending = [];
      const result = await fn(makeRepos(draft, pending, { writable: true }));
      if (draft.events) {
        draft.events.push(...pending);
        if (draft.events.length > maxEvents) draft.events.splice(0, draft.events.length - maxEvents);
      }
      state = draft;
      await persist();
      for (const e of pending) onCommit(e);
      return result;
    });
  }

  const read = async (fn) => fn(makeRepos(state, [], { writable: false }));

  const replaceAll = (next) => withLock(async () => { state = next; await persist(); });

  return { run, read, replaceAll, empty: emptyState, flush: () => saving, describe: () => persistence.name };
}
