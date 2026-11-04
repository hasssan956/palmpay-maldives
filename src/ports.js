// PORTS: the contracts the services depend on. Adapters implement them.
// No runtime code; this is the checklist a new adapter must satisfy.
//
// Going to production = new adapters for these ports + config changes.
// Services, routes and screens stay the same.

/**
 * @typedef {Object} UnitOfWork
 * Runs `fn` atomically: all writes commit together or not at all.
 * Postgres: BEGIN ... COMMIT. JSON store: draft copy swapped in on success.
 * Events added to `repos.outbox` are published only after commit.
 * @property {<T>(fn: (repos: Repos) => Promise<T>|T) => Promise<T>} run
 * @property {<T>(fn: (repos: Repos) => Promise<T>|T) => Promise<T>} read
 */

/**
 * @typedef {Object} Repos  (see adapters/store/palmpay-repos.js)
 * palmUsers, palmTemplates, merchants, intents, payments, outbox
 */

/**
 * @typedef {Object} BankConnector
 * PalmPay's only way to touch money. One adapter per bank (or one that
 * routes by bankId). Today: simulated. Later: each bank's API over mTLS.
 * @property {(bankId: string) => Promise<{id, name, short}|null>} describe
 * @property {(req: {bankId, bankCustomerRef, accountRef}) => Promise<{ok: boolean, label?: string, masked?: string}>} verifyAccount
 * @property {(req: {issuerBankId, accountRef, amount, acquirerBankId, creditAccountRef,
 *                   reference, narrative, idempotencyKey}) =>
 *            Promise<{approved: true, authCode: string, rail: 'on-us'|'favara'} | {approved: false, reason: string}>} authorizeDebit
 *   Must be idempotent on idempotencyKey: the same key returns the same result.
 */

/**
 * @typedef {Object} BiometricMatcher
 * hand-geometry (today): we hold feature vectors, compare in-process.
 * vendor (later): vendor holds templates; we keep only their template id.
 * @property {string} model
 * @property {(probe: PalmProbe) => {ok: boolean, reason?: string}} validateProbe
 * @property {(probe: PalmProbe) => Promise<{templateRef: object}>} enroll
 * @property {(probe: PalmProbe, templates: object[]) => Promise<object|null>} findDuplicate
 * @property {(probe: PalmProbe, templates: object[]) => Promise<{status: 'match'|'no_match'|'ambiguous', customerId?: string, distance?: number}>} identify
 */

/**
 * @typedef {Object} PalmProbe
 * @property {string} model
 * @property {number[]} vector
 * @property {string} [hand]
 * @property {{frames: number, spread: number}} [quality]
 */

/**
 * @typedef {Object} EventBus
 * In-process today. Redis pub/sub or Postgres LISTEN/NOTIFY with more than
 * one instance; bank webhooks are a subscriber.
 * @property {(event: object) => void} publish
 * @property {(filter: (e: object) => boolean, listener: (e: object) => void) => () => void} subscribe
 */

export {};
