import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testContainer, makeHand, probeFor, BML, MIB, CAFE, MART, consent } from './helpers.js';

const balance = async (c, bankId, custId, accId) =>
  (await c.simBanks.getCustomer(bankId, custId)).accounts.find((a) => a.id === accId).balance;

async function enrolMariyam(c, hand) {
  return c.palmUsers.enroll(MIB, { bankCustomerRef: 'mib_c_mariyam', name: 'Mariyam Shaheen', accountRef: 'mib_a_mariyam_cur', palm: probeFor(hand), consent });
}

test('MIB customer pays a BML shop by palm: debit at MIB, credit at BML over Favara', async () => {
  const c = await testContainer();
  const hand = makeHand(11);
  const u = await enrolMariyam(c, hand);
  assert.equal(u.funding.bankShort, 'MIB');

  const events = [];
  c.bus.subscribe(() => true, (e) => events.push(e));
  const pi = await c.payments.createIntent(CAFE, { items: [{ name: 'Kalhu sai', qty: 2, unitPrice: 1500 }] });
  const res = await c.payments.authorize(CAFE, pi.id, { palm: probeFor(hand) });
  assert.equal(res.intent.status, 'succeeded', JSON.stringify(res.match));
  assert.equal(res.payment.rail, 'favara');
  assert.match(res.payment.authCode, /^\d{6}$/);

  assert.equal(await balance(c, 'mib', 'mib_c_mariyam', 'mib_a_mariyam_cur'), 120_000 - 3000);
  assert.equal(await c.simBanks.merchantBalance('bml_m_raalhu'), 3000);
  const ev = events.find((e) => e.type === 'payment.succeeded');
  assert.equal(ev.payload.bankId, 'mib');
  assert.equal(ev.payload.bankCustomerRef, 'mib_c_mariyam');
});

test('same-bank payment settles on-us', async () => {
  const c = await testContainer();
  const [aishath] = (await c.palmUsers.listForDemo());
  const pi = await c.payments.createIntent(CAFE, { amount: 4500 });
  const res = await c.payments.authorize(CAFE, pi.id, { demo: { palmUserId: aishath.id } });
  assert.equal(res.payment.rail, 'on-us');
  assert.equal(await balance(c, 'bml', 'bml_c_aishath', 'bml_a_aishath_cur'), 250_000 - 4500);
});

test('bank declines for insufficient funds and no money moves', async () => {
  const c = await testContainer();
  const u = await c.palmUsers.enroll(BML, { bankCustomerRef: 'bml_c_ibrahim', name: 'Ibrahim Nashid', accountRef: 'bml_a_ibrahim_cur', demo: true, consent });
  const pi = await c.payments.createIntent(MART, { amount: 50_000 });
  const res = await c.payments.authorize(MART, pi.id, { demo: { palmUserId: u.id } });
  assert.equal(res.intent.status, 'failed');
  assert.equal(res.intent.failureReason, 'insufficient_funds');
  assert.equal(await balance(c, 'bml', 'bml_c_ibrahim', 'bml_a_ibrahim_cur'), 8_000);
});

test('customer palm limit is enforced before the bank is asked', async () => {
  const c = await testContainer();
  const [aishath] = await c.palmUsers.listForDemo();
  await c.palmUsers.update(BML, aishath.id, { limit: 10_000 });
  const pi = await c.payments.createIntent(CAFE, { amount: 20_000 });
  const res = await c.payments.authorize(CAFE, pi.id, { demo: { palmUserId: aishath.id } });
  assert.equal(res.intent.failureReason, 'over_palm_limit');
});

test('a stranger’s palm is not recognised and fails after max attempts', async () => {
  const c = await testContainer({ maxScanAttempts: 2 });
  await enrolMariyam(c, makeHand(5));
  const pi = await c.payments.createIntent(CAFE, { amount: 2000 });
  const stranger = makeHand(424242);
  assert.equal((await c.payments.authorize(CAFE, pi.id, { palm: probeFor(stranger) })).intent.status, 'requires_palm');
  const r2 = await c.payments.authorize(CAFE, pi.id, { palm: probeFor(stranger) });
  assert.equal(r2.intent.status, 'failed');
  assert.equal(r2.intent.failureReason, 'palm_not_recognised');
});

test('idempotent intents and replayed authorize never double charge', async () => {
  const c = await testContainer();
  const [aishath] = await c.palmUsers.listForDemo();
  const a = await c.payments.createIntent(CAFE, { amount: 2500, idempotencyKey: 'k1' });
  const b = await c.payments.createIntent(CAFE, { amount: 2500, idempotencyKey: 'k1' });
  assert.equal(a.id, b.id);
  await c.payments.authorize(CAFE, a.id, { demo: { palmUserId: aishath.id } });
  const replay = await c.payments.authorize(CAFE, a.id, { demo: { palmUserId: aishath.id } });
  assert.equal(replay.replay, true);
  assert.equal(await balance(c, 'bml', 'bml_c_aishath', 'bml_a_aishath_cur'), 250_000 - 2500);
});

test('banks only see their own customers; terminals only their own intents', async () => {
  const c = await testContainer();
  const [aishath] = await c.palmUsers.listForDemo();
  await assert.rejects(c.palmUsers.get(MIB, aishath.id), (e) => e.code === 'palm_user_not_found');
  const pi = await c.payments.createIntent(CAFE, { amount: 2500 });
  await assert.rejects(c.payments.authorize(MART, pi.id, { demo: { palmUserId: aishath.id } }), (e) => e.code === 'payment_intent_not_found');
  await assert.rejects(c.palmUsers.enroll(CAFE, { bankCustomerRef: 'x' }), (e) => e.code === 'forbidden');
});

test('enrolment needs consent and an account the bank confirms', async () => {
  const c = await testContainer();
  await assert.rejects(c.palmUsers.enroll(MIB, { bankCustomerRef: 'mib_c_mariyam', name: 'Mariyam', accountRef: 'mib_a_mariyam_cur', demo: true }),
    (e) => e.code === 'invalid_request');
  await assert.rejects(c.palmUsers.enroll(MIB, { bankCustomerRef: 'mib_c_mariyam', name: 'Mariyam', accountRef: 'bml_a_aishath_cur', demo: true, consent }),
    (e) => e.code === 'invalid_request');
});

test('the same palm cannot be enrolled twice; turning off deletes the template', async () => {
  const c = await testContainer();
  const hand = makeHand(77);
  const u = await enrolMariyam(c, hand);
  await assert.rejects(
    c.palmUsers.enroll(BML, { bankCustomerRef: 'bml_c_ibrahim', name: 'Ibrahim', accountRef: 'bml_a_ibrahim_cur', palm: probeFor(hand), consent }),
    (e) => e.code === 'palm_already_enrolled',
  );
  await c.palmUsers.remove(MIB, u.id);
  const pi = await c.payments.createIntent(CAFE, { amount: 2000 });
  const res = await c.payments.authorize(CAFE, pi.id, { palm: probeFor(hand) });
  assert.equal(res.intent.status, 'requires_palm');
});

test('simulated scans are refused when demo mode is off', async () => {
  const c = await testContainer({ demoMode: false });
  const pi = await c.payments.createIntent(CAFE, { amount: 2500 });
  await assert.rejects(c.payments.authorize(CAFE, pi.id, { demo: { palmUserId: 'x' } }), (e) => e.code === 'demo_disabled');
});

test('only the registered hand can pay; the other hand gets a clear message', async () => {
  const c = await testContainer();
  const hand = makeHand(31);
  await c.palmUsers.enroll(MIB, { bankCustomerRef: 'mib_c_mariyam', name: 'Mariyam Shaheen', accountRef: 'mib_a_mariyam_cur', palm: probeFor(hand, 20, 'Right'), consent });
  const pi = await c.payments.createIntent(CAFE, { amount: 2000 });
  const wrong = await c.payments.authorize(CAFE, pi.id, { palm: probeFor(hand, 20, 'Left') });
  assert.equal(wrong.intent.status, 'requires_palm');
  assert.equal(wrong.intent.lastError.code, 'palm_wrong_hand');
  const right = await c.payments.authorize(CAFE, pi.id, { palm: probeFor(hand, 20, 'Right') });
  assert.equal(right.intent.status, 'succeeded');
});
