// Shop counter. Stands in for the bank-run card terminal at a till, with palm
// as one more way to pay. Type the amount, charge, the customer holds up a palm.
import { api, terminalKey, liveEvents, idempotencyKey, prefs, getConfig } from '../api.js';
import { icon, brandMark } from '../ui/icons.js';
import { openScanModal } from '../ui/scan-modal.js';
import { mvrNumber, esc, dateTime } from '../format.js';

const root = document.getElementById('terminal');
const MAX = 9_999_999; // MVR 99,999.99
const DECLINES = {
  insufficient_funds: ['Declined by the bank', 'Not enough balance in the customer’s account.'],
  over_palm_limit: ['Above the customer’s limit', 'This is more than their palm payment limit. Ask for another way to pay.'],
  account_blocked: ['Declined by the bank', 'The customer’s account cannot make payments.'],
  palm_not_recognised: ['Palm not recognised', 'Too many unsuccessful scans. Start the payment again.'],
};
const BANK_SHORT = { bml: 'BML', mib: 'MIB' };

const state = { merchants: [], merchantId: prefs.get('terminalMerchant', 'mer_raalhu_cafe'), amount: 0, live: false, busy: false, error: '' };
let stopLive = () => {};
const merchant = () => state.merchants.find((m) => m.id === state.merchantId) || state.merchants[0];

function render() {
  const m = merchant();
  root.innerHTML = `
    <header class="term-top">
      <a class="brand" href="/" aria-label="Prototype home">${brandMark()}</a>
      <label class="sr-only" for="shop">Shop</label>
      <select class="select" id="shop">${state.merchants.map((x) => `<option value="${esc(x.id)}" ${x.id === m.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
      <span class="live ${state.live ? 'on' : ''}"><i></i>${state.live ? 'Live' : 'Offline'}</span>
    </header>
    <section class="term-body">
      <div class="term-shop"><strong>${esc(m.name)}</strong><small>${esc(m.location)}. Banks with ${BANK_SHORT[m.acquirerBankId]} (simulated)</small></div>
      <output class="term-amount num" aria-live="polite"><small>MVR</small>${mvrNumber(state.amount)}</output>
      ${state.error ? `<p class="form-error" role="alert">${esc(state.error)}</p>` : '<p class="term-hint">Type the amount, then charge.</p>'}
      <div class="keypad" role="group" aria-label="Amount keypad">
        ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0'].map((k) => `<button data-key="${k}">${k}</button>`).join('')}
        <button data-key="del" aria-label="Delete">${icon('back')}</button>
      </div>
      <button class="btn btn-lagoon btn-block pay-btn" data-act="charge" ${state.amount < 100 || state.busy ? 'disabled' : ''}>${icon('palm')}Charge with palm</button>
    </section>`;
}

function press(k) {
  state.error = '';
  if (k === 'del') state.amount = Math.floor(state.amount / 10);
  else if (k === '00') state.amount = Math.min(MAX, state.amount * 100);
  else state.amount = Math.min(MAX, state.amount * 10 + Number(k));
  render();
}

async function charge() {
  const m = merchant();
  const key = await terminalKey(m.id);
  state.busy = true;
  render();
  let intent;
  try {
    intent = await api('/payment-intents', { method: 'POST', key, headers: { 'Idempotency-Key': idempotencyKey() }, body: { merchantId: m.id, terminalId: 'T-01', amount: state.amount } });
  } catch (err) {
    state.busy = false; state.error = err.message; return render();
  }
  const cfg = await getConfig();

  const outcome = await openScanModal({
    eyebrow: `Pay ${m.name}`,
    amount: intent.amount,
    demoChoices: async () => {
      const { data } = await api('/demo/palm-users');
      return data.map((u) => ({ id: u.id, name: u.name, note: `${u.funding.bankShort} ${u.funding.masked}` }));
    },
    submit: async (input) => {
      const body = input.demo ? { demo: { palmUserId: input.demo.id } } : { palm: input.probe };
      try {
        const res = await api(`/payment-intents/${intent.id}/authorize`, { method: 'POST', body, key });
        const pi = res.intent;
        if (pi.status === 'succeeded') {
          return { ok: true, value: { status: 'paid', payment: res.payment }, title: 'Approved', message: `Thank you, ${res.payment.customerShort}`, debug: res.match };
        }
        if (pi.status === 'requires_palm') {
          const left = cfg.maxScanAttempts - pi.attempts;
          const unclear = pi.lastError?.code === 'palm_ambiguous';
          const bankDown = pi.lastError?.code === 'bank_unavailable';
          return { ok: false, retry: true, debug: res.match,
            title: bankDown ? 'Bank not reachable' : unclear ? 'Scan was unclear' : 'Palm not recognised',
            message: bankDown ? 'Try again in a moment.' : `Hold the hand flat inside the outline. ${left > 0 ? `${left} ${left === 1 ? 'try' : 'tries'} left.` : ''}` };
        }
        const [title, message] = DECLINES[pi.failureReason] || ['Payment declined', 'Ask for another way to pay.'];
        return { ok: false, retry: false, title, message, debug: res.match, value: { status: 'declined', intent: pi, title, message } };
      } catch (err) {
        return { ok: false, retry: err.code === 'invalid_request', title: 'Scan not usable', message: err.message };
      }
    },
  });

  state.busy = false;
  if (!outcome) {
    api(`/payment-intents/${intent.id}/cancel`, { method: 'POST', key }).catch(() => {});
    return render();
  }
  render();
  showReceipt(outcome);
}

function showReceipt(outcome) {
  const paid = outcome.status === 'paid';
  const p = outcome.payment;
  const route = paid && (p.rail === 'favara'
    ? `Favara, ${BANK_SHORT[p.bankId]} to ${BANK_SHORT[p.acquirerBankId]}`
    : `Within ${BANK_SHORT[p.bankId]}`);
  const sheet = document.createElement('div');
  sheet.className = 'sheet-backdrop';
  sheet.innerHTML = paid ? `
    <article class="receipt" role="dialog" aria-modal="true" aria-label="Receipt">
      <svg class="ok" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30"/><path d="M19 33l9 9 17-19"/></svg>
      <h2>Payment approved</h2>
      <div class="big num"><small>MVR</small>${mvrNumber(p.amount)}</div>
      <p class="sub">${esc(p.merchantName)}, terminal ${esc(p.terminalId)}</p>
      <hr class="rule">
      <table class="meta">
        <tr><td>Paid by</td><td>${esc(p.customerShort)}</td></tr>
        <tr><td>Method</td><td>${p.method === 'simulated' ? 'Palm (simulated)' : 'Palm'}</td></tr>
        <tr><td>From</td><td>${esc(BANK_SHORT[p.bankId])} ${esc(p.accountMasked)}</td></tr>
        <tr><td>Route</td><td>${esc(route)}</td></tr>
        <tr><td>Approval code</td><td>${esc(p.authCode)}</td></tr>
        <tr><td>Reference</td><td>${esc(p.reference)}</td></tr>
        <tr><td>Date</td><td>${dateTime(p.createdAt)}</td></tr>
      </table>
      <p class="thanks">Shukuriyaa!</p>
      <div class="btns">
        <button class="btn btn-ghost" data-act="print">${icon('receipt')}Print</button>
        <button class="btn btn-primary" data-act="new">New sale</button>
      </div>
    </article>` : `
    <article class="receipt declined" role="dialog" aria-modal="true" aria-label="Payment declined">
      <svg class="ok" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30"/><path d="M23 23l18 18M41 23 23 41"/></svg>
      <h2>${esc(outcome.title)}</h2>
      <div class="big num"><small>MVR</small>${mvrNumber(outcome.intent.amount)}</div>
      <p class="sub">${esc(outcome.message)}</p>
      <div class="btns">
        <button class="btn btn-ghost" data-act="close">Back</button>
        <button class="btn btn-primary" data-act="new">New sale</button>
      </div>
    </article>`;
  document.body.appendChild(sheet);
  sheet.querySelector('.btn-primary').focus();
  sheet.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'print') window.print();
    if (act === 'new') { state.amount = 0; render(); sheet.remove(); }
    if (act === 'close') sheet.remove();
  });
}

async function connect() {
  stopLive();
  const key = await terminalKey(merchant().id);
  stopLive = liveEvents({ key }, {}, (on) => {
    if (on === state.live) return;
    state.live = on;
    const l = root.querySelector('.live');
    if (l) { l.classList.toggle('on', on); l.lastChild.textContent = on ? 'Live' : 'Offline'; }
  });
}

root.addEventListener('click', (e) => {
  const k = e.target.closest('[data-key]')?.dataset.key;
  if (k) return press(k);
  if (e.target.closest('[data-act="charge"]')) charge();
});
root.addEventListener('change', (e) => {
  if (e.target.id === 'shop') { state.merchantId = e.target.value; prefs.set('terminalMerchant', state.merchantId); render(); connect(); }
});
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.scan, .sheet-backdrop') || e.target.closest('select')) return;
  if (/^[0-9]$/.test(e.key)) press(e.key);
  else if (e.key === 'Backspace') press('del');
  else if (e.key === 'Enter' && state.amount >= 100 && !state.busy) charge();
});

(async () => {
  state.merchants = (await api('/merchants')).data;
  render();
  connect();
})();
