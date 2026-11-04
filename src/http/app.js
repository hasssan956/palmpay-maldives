// HTTP layer.
//   /api/v1/*     PalmPay partner API: what BML, MIB and shop terminals call.
//   /sim-bank/*   Stand-in for each bank's OWN backend, used by the demo bank
//                 app. Not part of PalmPay; removed when real banks connect.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DomainError, notFound } from '../domain/errors.js';
import { seed } from '../seed.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function createApp(c) {
  const { config, palmUsers, payments, bus, store, simBanks, banks } = c;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '400kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self)');
    next();
  });

  // --- Who is calling? "Authorization: Bearer <key>" (or ?key= for SSE) ---
  const partnerFor = (key) => (key && config.partnerKeys[key]) || null;
  const auth = (type) => (req, res, next) => {
    const key = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '') || req.query.key;
    const partner = partnerFor(key);
    if (!partner || (type && partner.type !== type)) {
      return res.status(401).json({ error: { code: 'unauthorized', message: 'A valid partner key is required.' } });
    }
    req.partner = partner;
    next();
  };

  const api = express.Router();

  api.get('/health', (req, res) => res.json({ ok: true, store: store.describe(), banks: banks.kind, listeners: bus.size() }));

  api.get('/config', async (req, res) => {
    const demoKeys = config.demoMode
      ? Object.fromEntries(Object.entries(config.partnerKeys).map(([k, v]) => [v.type === 'bank' ? `bank:${v.bankId}` : `terminal:${v.merchantId}`, k]))
      : undefined;
    res.json({
      currency: config.currency, demoMode: config.demoMode, allowReset: config.allowReset, exposeMatchDebug: config.exposeMatchDebug,
      defaultPalmLimit: config.defaultPalmLimit, maxPalmLimit: config.maxPalmLimit, maxScanAttempts: config.maxScanAttempts,
      biometric: { provider: config.biometricProvider, model: c.matcher.model, handModelUrl: config.handModelUrl, threshold: config.matchThreshold },
      demoKeys,
    });
  });

  // --- Bank-facing: enrolment and palm settings ---
  api.post('/enrollments', auth('bank'), async (req, res) => res.status(201).json(await palmUsers.enroll(req.partner, req.body || {})));
  api.get('/palm-users', auth('bank'), async (req, res) => {
    const u = await palmUsers.findForBankCustomer(req.partner, String(req.query.bankCustomerRef || ''));
    if (!u) throw notFound('palm_user');
    res.json(u);
  });
  api.get('/palm-users/:id', auth('bank'), async (req, res) => res.json(await palmUsers.get(req.partner, req.params.id)));
  api.patch('/palm-users/:id', auth('bank'), async (req, res) => res.json(await palmUsers.update(req.partner, req.params.id, req.body || {})));
  api.delete('/palm-users/:id', auth('bank'), async (req, res) => res.json(await palmUsers.remove(req.partner, req.params.id)));
  api.get('/palm-users/:id/payments', auth('bank'), async (req, res) =>
    res.json({ data: await palmUsers.payments(req.partner, req.params.id, { limit: Math.min(200, Number(req.query.limit) || 50) }) }),
  );

  // --- Terminal-facing: taking a payment ---
  api.get('/merchants', async (req, res) => res.json({ data: await store.read((r) => r.merchants.list()) }));
  api.post('/payment-intents', auth('terminal'), async (req, res) => {
    const { merchantId, terminalId, amount, items, description } = req.body || {};
    const idempotencyKey = req.get('Idempotency-Key') || undefined;
    res.status(201).json(await payments.createIntent(req.partner, { merchantId, terminalId, amount, items, description, idempotencyKey }));
  });
  api.get('/payment-intents/:id', auth('terminal'), async (req, res) => res.json(await payments.getIntent(req.partner, req.params.id)));
  api.post('/payment-intents/:id/authorize', auth('terminal'), async (req, res) => {
    const { palm, demo } = req.body || {};
    res.json(await payments.authorize(req.partner, req.params.id, { palm, demo }));
  });
  api.post('/payment-intents/:id/cancel', auth('terminal'), async (req, res) => res.json(await payments.cancelIntent(req.partner, req.params.id)));
  api.get('/payments/:id', auth(), async (req, res) => res.json(await payments.getPayment(req.partner, req.params.id)));

  // --- Live events (Server-Sent Events). A bank sees only its customers' events;
  //     a terminal only its shop's. In production banks get the same events as webhooks.
  api.get('/events', auth(), (req, res) => {
    const p = req.partner;
    const { palmUserId, bankCustomerRef } = req.query;
    const filter = (e) => {
      const d = e.payload || {};
      if (e.type === 'demo.reset') return true;
      if (p.type === 'terminal') return d.merchantId === p.merchantId;
      if (d.bankId !== p.bankId) return false;
      return (!palmUserId || d.palmUserId === palmUserId) && (!bankCustomerRef || d.bankCustomerRef === bankCustomerRef);
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const unsubscribe = bus.subscribe(filter, (e) => res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); unsubscribe(); });
  });

  // --- Demo-only helpers ---
  const demoOnly = (req, res, next) => (config.demoMode ? next() : res.status(404).end());
  api.get('/demo/palm-users', demoOnly, async (req, res) => res.json({ data: await palmUsers.listForDemo() }));
  api.post('/admin/reset', async (req, res) => {
    if (!config.allowReset) throw new DomainError('reset_disabled', 'Reset is turned off.', { status: 403 });
    await seed(c);
    bus.publish({ id: 'reset', type: 'demo.reset', payload: {}, createdAt: new Date().toISOString() });
    res.json({ ok: true });
  });

  api.use((req, res) => res.status(404).json({ error: { code: 'route_not_found', message: 'No such endpoint.' } }));
  app.use('/api/v1', api);

  // --- Simulated bank backends (stand-ins for BML / MIB's own systems) ---
  if (simBanks) {
    const sim = express.Router();
    sim.get('/customers', async (req, res) => res.json({ data: await simBanks.listCustomers() }));
    sim.get('/:bankId/customers/:id', async (req, res) => {
      const cust = await simBanks.getCustomer(req.params.bankId, req.params.id);
      if (!cust) throw notFound('bank_customer');
      res.json(cust);
    });
    sim.get('/:bankId/customers/:id/statement', async (req, res) =>
      res.json({ data: await simBanks.statement(req.params.bankId, req.params.id, { limit: Math.min(200, Number(req.query.limit) || 50) }) }),
    );
    app.use('/sim-bank', sim);
  }

  // --- Static frontend, shared feature code and the vendored MediaPipe runtime ---
  app.get(['/pos', '/enroll'], (req, res) => res.redirect(302, req.path === '/pos' ? '/terminal' : '/bank#palmpay'));
  app.use('/shared', express.static(join(root, 'shared'), { maxAge: '1h' }));
  app.use('/vendor/mediapipe', express.static(join(root, 'node_modules/@mediapipe/tasks-vision'), { maxAge: '7d', immutable: true }));
  app.use(express.static(join(root, 'public'), { extensions: ['html'], maxAge: config.nodeEnv === 'production' ? '1h' : 0 }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof DomainError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof TypeError || err instanceof RangeError) return res.status(422).json({ error: { code: 'invalid_request', message: err.message } });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Request body is not valid JSON.' } });
    console.error(err);
    res.status(500).json({ error: { code: 'internal_error', message: 'Something failed on the server. Try again.' } });
  });

  return app;
}
