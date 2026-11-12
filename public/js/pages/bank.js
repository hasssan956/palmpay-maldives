// DEMO BANK APP with PalmPay built in.
//
// Everything outside the "PalmPay" tab stands in for a partner bank's own app
// (accounts, statement) and talks to the simulated bank backend (/sim-bank).
// The PalmPay tab is the part PalmPay supplies to banks: setup, account choice,
// limit, turn off, palm payment history. It talks to the PalmPay partner API.
import { api, simBank, bankKey, liveEvents, prefs, getConfig } from '../api.js';
import { icon, brandMark } from '../ui/icons.js';
import { contourSVG } from '../ui/contour.js';
import { openScanModal } from '../ui/scan-modal.js';
import { mvr, mvrNumber, initials, time, dayLabel, greeting, esc, countTo } from '../format.js';

const app = document.getElementById('app');
const noticeEl = document.getElementById('notice');

const THEMES = [
  { id: 'lagoon', name: 'Lagoon' },
  { id: 'hibiscus', name: 'Hibiscus' },
  { id: 'mangrove', name: 'Mangrove' },
];
const LIMITS = [100_000, 250_000, 500_000, 1_000_000];
const DECLINES = {
  insufficient_funds: 'Not enough balance in the linked account',
  over_palm_limit: 'Above your palm payment limit',
  account_blocked: 'The linked account is blocked',
};

const state = {
  session: prefs.get('bankSession'), // { bankId, customerId }
  customer: null, statement: [], palmUser: null, palmPayments: [],
  view: location.hash.slice(1) || 'home',
  hideBalance: prefs.get('hideBalance', false),
  setup: null, // { step, accountRef, limit, consent }
  editing: null, // 'account' | 'limit' | 'off'
  unseen: 0, freshRef: null, cfg: null, key: null,
};
let stopLive = () => {};

document.body.dataset.theme = prefs.get('theme', 'lagoon');

// ---------- data ----------
async function load() {
  const { bankId, customerId } = state.session;
  const [customer, statement, palmUser] = await Promise.all([
    simBank(`/${bankId}/customers/${customerId}`),
    simBank(`/${bankId}/customers/${customerId}/statement`),
    api(`/palm-users?bankCustomerRef=${encodeURIComponent(customerId)}`, { key: state.key }).catch((e) => (e.status === 404 ? null : Promise.reject(e))),
  ]);
  state.customer = customer;
  state.statement = statement.data;
  state.palmUser = palmUser;
  state.palmPayments = palmUser ? (await api(`/palm-users/${palmUser.id}/payments`, { key: state.key })).data : [];
}

const balanceOf = (accountId) => state.customer?.accounts.find((a) => a.id === accountId)?.balance ?? 0;
const primary = () => state.customer.accounts.find((a) => a.id === state.palmUser?.funding.accountRef) || state.customer.accounts[0];

function connectLive() {
  stopLive();
  stopLive = liveEvents({ key: state.key, bankCustomerRef: state.session.customerId }, {
    'payment.succeeded': async (e) => {
      const acc = primary();
      const before = acc.balance;
      await load();
      state.freshRef = e.payload.reference;
      state.unseen++;
      render();
      const amt = app.querySelector('.balance .amt');
      if (amt && !state.hideBalance && state.view === 'home') {
        countTo(amt, before, balanceOf(acc.id));
        amt.classList.add('changed');
        setTimeout(() => amt.classList.remove('changed'), 1600);
      }
      notify('palm', e.payload.merchantName, `${mvr(e.payload.amount)} paid with your palm`);
    },
    'payment_intent.failed': (e) => {
      const why = DECLINES[e.payload.reason];
      if (why) notify('x', `Palm payment declined at ${e.payload.merchantName}`, why, true);
    },
    'palm.deleted': () => refresh(),
    'palm.enrolled': () => refresh(),
    'demo.reset': () => signOut(),
  });
}

async function refresh() { await load(); render(); }

function notify(ic, title, text, bad = false) {
  noticeEl.className = `notice${bad ? ' bad' : ''}`;
  noticeEl.innerHTML = `<div class="glyph">${icon(ic)}</div><div><strong>${esc(title)}</strong><span>${esc(text)}</span></div>`;
  requestAnimationFrame(() => noticeEl.classList.add('show'));
  clearTimeout(notify.t);
  notify.t = setTimeout(() => noticeEl.classList.remove('show'), 4200);
}

// ---------- shell ----------
function render() {
  if (!state.customer) return renderSignIn();
  const views = { home: homeView, activity: activityView, palmpay: palmPayView, more: moreView };
  app.innerHTML = (views[state.view] || homeView)() + tabbar();
}

function header({ compact = false } = {}) {
  const c = state.customer;
  return `
  <header class="bank-top">
    <div class="bank-bar">
      <button class="avatar" data-act="switch" aria-label="Switch customer">${esc(initials(c.name))}</button>
      <div class="greeting"><small>${greeting()}</small><strong>${esc(c.name)}</strong></div>
      <button class="icon-btn" data-go="activity" aria-label="Activity">${icon('bell')}${state.unseen ? '<i class="dot"></i>' : ''}</button>
    </div>
    ${compact ? '' : accountCard(primary())}
  </header>`;
}

function accountCard(acc) {
  const hidden = state.hideBalance;
  const pays = state.palmUser?.funding.accountRef === acc.id;
  return `
    <section class="account-card" aria-label="${esc(acc.product)}">
      ${contourSVG(acc.number)}
      <div class="row">
        <span class="account-label">${esc(acc.product)}</span>
        <span class="account-number">${esc(state.customer.bank.short)} ${esc(acc.masked)}</span>
      </div>
      <div class="balance">
        <span class="cur">MVR</span>
        <span class="amt num ${hidden ? 'masked' : ''}">${hidden ? '••••••' : mvrNumber(acc.balance)}</span>
      </div>
      <div class="row">
        ${pays ? `<span class="chip chip-palm">${icon('palm')}Pays by palm</span>` : `<span class="chip chip-quiet">${esc(acc.number)}</span>`}
        <button class="eye-btn" data-act="eye" aria-label="${hidden ? 'Show balance' : 'Hide balance'}">${icon(hidden ? 'eyeOff' : 'eye')}</button>
      </div>
    </section>`;
}

function homeView() {
  const others = state.customer.accounts.filter((a) => a.id !== primary().id);
  return `
    ${header()}
    <main class="bank-main">
      <nav class="panel actions" aria-label="Quick actions">
        <button class="action primary" data-go="palmpay"><span class="ico">${icon('palm')}</span>PalmPay</button>
        <button class="action" data-act="soon" data-what="Transfers"><span class="ico">${icon('send')}</span>Transfer</button>
        <button class="action" data-act="soon" data-what="Bill payments"><span class="ico">${icon('receipt')}</span>Pay bills</button>
        <button class="action" data-act="soon" data-what="Cards"><span class="ico">${icon('topup')}</span>Cards</button>
      </nav>
      ${state.palmUser ? '' : `
      <button class="panel promo" data-go="palmpay">
        <span class="promo-mark">${brandMark('promo-logo')}</span>
        <span><strong>Pay in shops with your palm</strong><small>Switch on PalmPay once. No card or phone at the counter.</small></span>
        ${icon('chevron', 'chev')}
      </button>`}
      ${others.length ? `
      <section class="panel">
        <div class="section-head"><h2>Other accounts</h2></div>
        ${others.map((a) => `
          <div class="txn">
            <span class="glyph">${icon('topup')}</span>
            <span class="who"><strong>${esc(a.product)}</strong><small>${esc(a.number)}</small></span>
            <span class="amt num">${state.hideBalance ? '••••' : mvrNumber(a.balance)}</span>
          </div>`).join('')}
      </section>` : ''}
      <section class="panel">
        <div class="section-head"><h2>Recent activity</h2>${state.statement.length > 5 ? '<button data-go="activity">See all</button>' : ''}</div>
        ${statementList(state.statement.slice(0, 5))}
      </section>
    </main>`;
}

function activityView() {
  state.unseen = 0;
  return `
    ${header({ compact: true })}
    <main class="bank-main">
      <section class="panel">
        <div class="section-head"><h2>Activity</h2><span class="muted" style="font-size:var(--t-sm)">All accounts</span></div>
        ${statementList(state.statement)}
      </section>
    </main>`;
}

function statementList(rows) {
  if (!rows.length) return `<div class="empty"><strong>No activity yet</strong>Payments and transfers show up here.</div>`;
  let out = '';
  let lastDay = '';
  for (const t of rows) {
    const day = dayLabel(t.createdAt);
    if (day !== lastDay) { out += `<div class="day">${day}</div>`; lastDay = day; }
    const incoming = t.direction === 'in';
    const palm = t.type === 'palm_payment';
    const title = palm ? t.narrative.replace(/^Palm payment, /, '') : t.narrative;
    const note = palm ? `Palm payment${t.rail === 'favara' ? ' via Favara' : ''}, ${time(t.createdAt)}` : `${t.accountProduct} ${t.accountMasked}, ${time(t.createdAt)}`;
    out += `
      <div class="txn ${t.reference && t.reference === state.freshRef ? 'fresh' : ''}">
        <span class="glyph ${incoming ? 'in' : ''}">${icon(palm ? 'palm' : 'arrowIn')}</span>
        <span class="who"><strong>${esc(title)}</strong><small>${esc(note)}</small></span>
        <span class="amt num ${incoming ? 'in' : ''}">${incoming ? '+' : '-'}${mvrNumber(t.amount)}</span>
      </div>`;
  }
  state.freshRef = null;
  return out;
}

// ---------- PalmPay module (the part PalmPay supplies to banks) ----------
function palmPayView() {
  return `
    ${header({ compact: true })}
    <main class="bank-main">
      <div class="pp-head">${brandMark('pp-logo')}<span><strong>PalmPay</strong><small>Palm payments in your ${esc(state.customer.bank.short)} app</small></span></div>
      ${state.palmUser ? palmPayOn() : palmPaySetup()}
    </main>`;
}

function palmPaySetup() {
  const s = (state.setup ||= { step: 'intro', accountRef: state.customer.accounts[0].id, limit: state.cfg.defaultPalmLimit, consent: false, error: '' });
  if (s.step === 'intro') {
    return `
      <section class="panel pp-intro">
        <div class="palm-hero">
          <div class="palm-photo">${icon('palm')}</div>
          <h2>Pay with your palm</h2>
          <p>At shops with a PalmPay counter, hold up your open hand and the bill is paid from your ${esc(state.customer.bank.short)} account.</p>
        </div>
        <ol class="how">
          <li><strong>Choose an account</strong><span>Payments come straight from it. No new wallet to top up.</span></li>
          <li><strong>Scan one palm</strong><span>Use the hand you’ll pay with. Only that hand can pay.</span></li>
          <li><strong>Pay with your hand</strong><span>You get a notification here for every payment.</span></li>
        </ol>
        <div class="stack"><button class="btn btn-primary btn-block" data-act="setup-next">Set up PalmPay</button></div>
      </section>`;
  }
  return `
    <section class="panel pp-form">
      ${s.error ? `<p class="form-error" role="alert">${esc(s.error)}</p>` : ''}
      <fieldset class="choices">
        <legend>Pay from</legend>
        ${state.customer.accounts.map((a) => `
          <label class="choice">
            <input type="radio" name="acct" value="${esc(a.id)}" ${a.id === s.accountRef ? 'checked' : ''}>
            <span><strong>${esc(a.product)}</strong><small>${esc(a.number)}</small></span>
            <span class="num">${mvrNumber(a.balance)}</span>
          </label>`).join('')}
      </fieldset>
      <fieldset class="choices">
        <legend>Limit per payment</legend>
        <div class="limit-chips">${LIMITS.map((l) => `
          <label class="lchip"><input type="radio" name="limit" value="${l}" ${l === s.limit ? 'checked' : ''}><span class="num">${mvrNumber(l).replace('.00', '')}</span></label>`).join('')}
        </div>
        <span class="hint">Payments above this are declined at the counter. Change it any time.</span>
      </fieldset>
      <label class="consent">
        <input type="checkbox" name="consent" ${s.consent ? 'checked' : ''}>
        <span>I agree that PalmPay stores a template of my palm to identify me at checkout, and deletes it when I turn PalmPay off.</span>
      </label>
      <button class="btn btn-primary btn-block" data-act="setup-scan">${icon('palm')}Scan my palm</button>
    </section>`;
}

function palmPayOn() {
  const u = state.palmUser;
  const acc = state.customer.accounts.find((a) => a.id === u.funding.accountRef);
  const e = state.editing;
  return `
    <section class="panel">
      <div class="palm-hero">
        <div class="palm-photo">${u.palm.snapshot ? `<img src="${u.palm.snapshot}" alt="Your registered palm">` : icon('palm')}</div>
        <h2>PalmPay is on</h2>
        <p>Hold up the hand you registered, open and flat, at any PalmPay counter.${u.palm.mode === 'simulated' ? ' This demo profile has no palm scan yet; shops can simulate it.' : ''}</p>
      </div>
      <div class="settings">
        <button class="setting" data-act="edit" data-what="account">
          <span>Pays from</span><strong>${esc(u.funding.label)} ${esc(u.funding.masked)}</strong>${icon('chevron', 'chev')}
        </button>
        ${e === 'account' ? `<div class="setting-edit">${state.customer.accounts.map((a) => `
          <button class="opt ${a.id === u.funding.accountRef ? 'on' : ''}" data-act="set-account" data-id="${esc(a.id)}"><span>${esc(a.product)} ${esc(a.masked)}</span><span class="num">${mvrNumber(a.balance)}</span></button>`).join('')}</div>` : ''}
        <button class="setting" data-act="edit" data-what="limit">
          <span>Limit per payment</span><strong class="num">${mvr(u.limit)}</strong>${icon('chevron', 'chev')}
        </button>
        ${e === 'limit' ? `<div class="setting-edit limit-chips">${LIMITS.map((l) => `
          <button class="lchip-btn ${l === u.limit ? 'on' : ''}" data-act="set-limit" data-v="${l}"><span class="num">${mvrNumber(l).replace('.00', '')}</span></button>`).join('')}</div>` : ''}
        <div class="setting static"><span>Available to spend</span><strong class="num">${mvr(Math.min(acc?.balance ?? 0, u.limit))}</strong></div>
      </div>
    </section>
    <section class="panel">
      <div class="section-head"><h2>Palm payments</h2></div>
      ${palmPaymentList()}
    </section>
    <section class="panel stack" style="padding-top:18px">
      ${e === 'off'
        ? `<p class="muted" style="margin:0;font-size:var(--t-sm)">Your palm template is deleted and shops can no longer charge your palm. You can set it up again later.</p>
           <div class="btn-row"><button class="btn btn-ghost" data-act="edit" data-what="">Keep it on</button><button class="btn btn-danger" data-act="turn-off">Turn off and delete</button></div>`
        : `<button class="btn btn-ghost btn-block" data-act="edit" data-what="off">Turn off PalmPay</button>`}
    </section>`;
}

function palmPaymentList() {
  const rows = state.palmPayments;
  if (!rows.length) return `<div class="empty"><strong>No palm payments yet</strong>Try it at a shop counter.</div>`;
  return rows.map((p) => `
    <div class="txn">
      <span class="glyph">${icon('palm')}</span>
      <span class="who"><strong>${esc(p.merchantName)}</strong><small>${dayLabel(p.createdAt)} ${time(p.createdAt)}, ${p.rail === 'favara' ? 'via Favara' : `${esc(p.bankShort)} to ${esc(p.bankShort)}`}${p.method === 'simulated' ? ', simulated' : ''}</small></span>
      <span class="amt num">-${mvrNumber(p.amount)}</span>
    </div>`).join('');
}

async function runSetupScan() {
  const s = state.setup;
  const form = app.querySelector('.pp-form');
  s.accountRef = form.querySelector('input[name=acct]:checked')?.value;
  s.limit = Number(form.querySelector('input[name=limit]:checked')?.value);
  s.consent = form.querySelector('input[name=consent]').checked;
  if (!s.consent) { s.error = 'Tick the agreement to continue.'; return render(); }
  s.error = '';
  const c = state.customer;
  const created = await openScanModal({
    eyebrow: 'Set up PalmPay',
    title: 'Scan your palm',
    demoLabel: 'No camera? Use a simulated palm',
    demoChoices: async () => [{ id: 'sim', name: 'Simulated palm', note: 'Demo only' }],
    submit: async (input) => {
      const body = {
        bankCustomerRef: c.id, name: c.name, phone: c.phone, accountRef: s.accountRef, limit: s.limit,
        consent: { accepted: true, at: new Date().toISOString(), version: 'demo-1' },
        ...(input.demo ? { demo: true } : { palm: input.probe, snapshot: input.snapshot }),
      };
      try {
        const u = await api('/enrollments', { method: 'POST', body, key: state.key });
        return { ok: true, value: u, title: 'PalmPay is on', message: 'Pay with the same hand you just scanned.' };
      } catch (err) {
        return { ok: false, retry: err.code === 'invalid_request', title: err.details?.reason === 'not_live' ? 'Use your real hand' : 'Could not finish setup', message: err.message };
      }
    },
  });
  if (created) {
    state.setup = null;
    await refresh();
    notify('palm', 'PalmPay is on', `Payments come from ${created.funding.label} ${created.funding.masked}`);
  }
}

// ---------- more ----------
function moreView() {
  const theme = document.body.dataset.theme;
  return `
    ${header({ compact: true })}
    <main class="bank-main">
      <section class="panel menu-list">
        <button data-act="switch"><span class="ico">${icon('user')}</span><span>Switch customer<small>Sign in as someone else</small></span>${icon('chevron', 'chev')}</button>
        <a href="/terminal"><span class="ico">${icon('store')}</span><span>Shop counter<small>Take a palm payment</small></span>${icon('chevron', 'chev')}</a>
        <a href="/"><span class="ico">${icon('home')}</span><span>Prototype home<small>All demo screens</small></span>${icon('chevron', 'chev')}</a>
      </section>
      <section class="panel" style="padding:18px">
        <h2 class="mini-h">App colours</h2>
        <p class="muted" style="margin:4px 0 14px;font-size:var(--t-sm)">Preview the PalmPay screens in different bank colours.</p>
        <div class="swatches">${THEMES.map((t) => `
          <button class="swatch ${t.id === theme ? 'on' : ''}" data-act="theme" data-id="${t.id}" data-theme-preview="${t.id}" aria-pressed="${t.id === theme}"><i></i>${t.name}</button>`).join('')}
        </div>
      </section>
      <p class="muted" style="font-size:var(--t-xs);text-align:center;margin:4px 20px">Demo bank app. It stands in for a partner bank’s own app; the banks and balances are simulated.</p>
    </main>`;
}

function tabbar() {
  const tab = (view, ic, label) => `<button class="tab" data-go="${view}" ${state.view === view ? 'aria-current="page"' : ''}>${icon(ic)}${label}</button>`;
  return `
    <nav class="tabbar" aria-label="Main">
      ${tab('home', 'home', 'Home')}
      ${tab('activity', 'list', 'Activity')}
      <button class="tab tab-palm" data-go="palmpay" ${state.view === 'palmpay' ? 'aria-current="page"' : ''}><span class="disc">${icon('palm')}</span>PalmPay</button>
      <button class="tab" data-act="soon" data-what="Cards">${icon('topup')}Cards</button>
      ${tab('more', 'more', 'More')}
    </nav>`;
}

// ---------- sign in (stands in for the bank's own login) ----------
async function renderSignIn() {
  const { data } = await simBank('/customers');
  app.innerHTML = `
    <section class="signin">
      <span class="brand"><span class="bank-badge">${icon('shield')}</span><span class="brand-name">Demo bank app</span></span>
      <h1>Your bank’s app, with PalmPay inside.</h1>
      <p>This screen stands in for the bank’s own login. Choose a customer of a simulated bank.</p>
      <div class="who-list">
        ${data.map((c) => `
          <button class="who-item" data-signin="${esc(c.bankId)}:${esc(c.id)}">
            <span class="avatar">${esc(initials(c.name))}</span>
            <span><strong>${esc(c.name)}</strong><small>${esc(c.bank.short)} (simulated), ${esc(c.phoneMasked)}</small></span>
            ${icon('chevron', 'chev')}
          </button>`).join('')}
      </div>
    </section>`;
}

function signOut() {
  stopLive();
  prefs.remove('bankSession');
  Object.assign(state, { session: null, customer: null, palmUser: null, setup: null, editing: null });
  renderSignIn();
}

async function signIn(bankId, customerId) {
  state.session = { bankId, customerId };
  prefs.set('bankSession', state.session);
  try {
    state.key = await bankKey(bankId);
    await load();
  } catch {
    return signOut();
  }
  connectLive();
  render();
}

// ---------- events ----------
app.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]')?.dataset.go;
  if (go) {
    state.view = go;
    state.editing = null;
    history.replaceState(null, '', `#${go}`);
    render();
    window.scrollTo(0, 0);
    return;
  }
  const signin = e.target.closest('[data-signin]')?.dataset.signin;
  if (signin) return signIn(...signin.split(':'));

  const el = e.target.closest('[data-act]');
  const act = el?.dataset.act;
  if (!act) return;
  if (act === 'eye') { state.hideBalance = !state.hideBalance; prefs.set('hideBalance', state.hideBalance); render(); }
  if (act === 'switch') signOut();
  if (act === 'soon') notify('send', `${el.dataset.what} are outside this prototype`, 'It covers PalmPay inside a bank app.');
  if (act === 'setup-next') { state.setup.step = 'form'; render(); }
  if (act === 'setup-scan') runSetupScan();
  if (act === 'edit') { state.editing = state.editing === el.dataset.what ? null : el.dataset.what || null; render(); }
  if (act === 'set-account' || act === 'set-limit') {
    const body = act === 'set-account' ? { accountRef: el.dataset.id } : { limit: Number(el.dataset.v) };
    try {
      state.palmUser = await api(`/palm-users/${state.palmUser.id}`, { method: 'PATCH', body, key: state.key });
      state.editing = null;
      render();
      notify('check', 'PalmPay updated', act === 'set-account' ? `Paying from ${state.palmUser.funding.label} ${state.palmUser.funding.masked}` : `Limit is now ${mvr(state.palmUser.limit)}`);
    } catch (err) { notify('x', 'Could not update PalmPay', err.message, true); }
  }
  if (act === 'turn-off') {
    await api(`/palm-users/${state.palmUser.id}`, { method: 'DELETE', key: state.key });
    state.editing = null;
    await refresh();
    notify('shield', 'PalmPay is off', 'Your palm template was deleted.');
  }
  if (act === 'theme') {
    document.body.dataset.theme = el.dataset.id;
    prefs.set('theme', el.dataset.id);
    render();
  }
});

// ---------- boot ----------
(async () => {
  state.cfg = await getConfig();
  if (state.session) signIn(state.session.bankId, state.session.customerId);
  else renderSignIn();
})();
