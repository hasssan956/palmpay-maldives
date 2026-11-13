# PalmPay Maldives: architecture

## What PalmPay is

PalmPay is a palm payment layer that **plugs into the bank apps people already use**, such as BML's and MIB's. It is not a wallet. Money stays in the customer's bank account. PalmPay does three things:

1. **Inside the bank's app:** the customer switches PalmPay on, picks the account to pay from, sets a per-payment limit and scans their palm once. They can change the account or limit, or turn it off (which deletes the palm template).
2. **At the shop counter:** the cashier enters the amount, the customer holds up their palm, and PalmPay works out who it is.
3. **Between the banks:** PalmPay asks the customer's bank to approve the debit. If the shop banks elsewhere, the bank sends the money over Favara. PalmPay records the payment and notifies the bank, which shows it in its app.

```
 Customer's bank app (BML / MIB)           PalmPay platform                         Banks
┌──────────────────────────────┐   ┌─────────────────────────────────────┐   ┌──────────────────────┐
│ bank's own screens           │   │ Partner API  /api/v1                 │   │ Issuer (customer's    │
│  accounts, statement  ───────┼───┼──────────────────────────────────────┼──▶│ bank) core banking:   │
│                              │   │  enrolments, palm settings  ◀── bank │   │ approve + debit       │
│ PalmPay module (from PalmPay)│──▶│  payment intents, authorize ◀── shop │   │        │ Favara       │
│  set up, account, limit, off │   │                                      │   │        ▼              │
└──────────────────────────────┘   │ Services: palm-users, payments       │   │ Acquirer (shop's      │
                                   │ Ports:  Store │ BiometricMatcher │   │   │ bank): credit shop    │
 Shop counter / bank card terminal │         BankConnector │ EventBus     │   └──────────────────────┘
┌──────────────────────────────┐   │                                      │
│ amount → palm scan → receipt │──▶│ Events → bank (webhook / SSE)        │
└──────────────────────────────┘   └─────────────────────────────────────┘
```

## How the prototype maps to the real thing

| In the prototype | Plays the part of | In production |
|---|---|---|
| `/bank`: the demo bank app | BML's or MIB's mobile app | The bank adds PalmPay's module to its own app (native SDK, or PalmPay screens opened inside the app) |
| `/sim-bank/*` and `src/sim-banks/` | Each bank's own backend and core banking | Removed. PalmPay calls the bank's real API |
| `adapters/banks/simulated-connector.js` | PalmPay's connection to the banks | A connector per bank, calling its API over mutual TLS |
| `/terminal`: the shop counter | A bank-issued card terminal with a palm scanner | Palm becomes one more way to pay on the terminal, next to card and QR |
| Demo partner keys in `/config` | Credentials per bank and per terminal | Keys held by bank backends and terminals, never by the customer's phone |
| SSE `/api/v1/events` | Notifications to the bank | Signed webhooks to each bank's backend, which pushes to its app |

## Decisions that keep scaling cheap

| Decision | Why it matters |
|---|---|
| **PalmPay holds no balances.** It stores the bank's reference for the customer and the chosen account, nothing else about money. | Banks keep control of funds and approvals, which is what they and the regulator expect. PalmPay never needs to be a deposit-taker. |
| **BankConnector port.** Three methods: `describe`, `verifyAccount`, `authorizeDebit`. | Adding a bank, or moving from simulated to real, is one new adapter file. |
| **Account verified by the bank at enrolment.** The bank confirms the account belongs to that customer. | Nobody can link someone else's account to their palm. |
| **Payment intents with a lifecycle and idempotency keys.** `requires_palm → processing → succeeded / failed / canceled / expired`. The bank call uses the intent id as its idempotency key. | A retry on bad Wi-Fi or a double tap can never charge twice, at PalmPay or at the bank. |
| **Bank call outside any lock.** Identify and check (unit of work 1), call the bank, record the outcome (unit of work 2). | A slow bank can't freeze other payments. The `processing` status blocks a second authorise for the same intent. |
| **Scoped access.** A bank key only sees its own customers. A terminal key only sees its own shop's payments. | This is the boundary that has to hold once real banks connect, and it is already tested. |
| **Biometric matcher is a port.** | Demo: hand geometry from the camera. Production: a palm-vein vendor SDK, with templates held by the vendor. |
| **Transactional outbox.** `payment.succeeded`, `payment_intent.failed`, `palm.enrolled`, `palm.deleted`. | The same events become bank webhooks, fraud scoring and reporting. |
| **Integer laari, versioned API (`/api/v1`), all settings in `src/config.js`.** | No rounding bugs, room for v2, and hardening is mostly switching demo options off. |

## The payment flow

1. The cashier types the amount. The terminal calls `POST /api/v1/payment-intents` with its key and an `Idempotency-Key`.
2. The scan screen opens the camera. MediaPipe HandLandmarker finds 21 hand points per frame. `shared/palm-features.js` turns them into 23 bone and palm length ratios, and 18 good frames are combined. `shared/palm-lines.js` reads the palm lines from the 3 sharpest frames.
3. `POST /payment-intents/:id/authorize { palm }`. PalmPay identifies the palm user (hand shape close enough, then the best palm-line match under the threshold, clearly ahead of the runner-up) and checks the customer's limit. It marks the intent `processing`.
4. PalmPay calls `authorizeDebit` on the customer's bank. If the shop banks with the same bank, the transfer stays inside it. If not, the issuer sends the money over Favara and the acquirer credits the shop.
5. PalmPay records the payment (approval code, route) and emits `payment.succeeded`. The bank app shows a notification and its balance drops. The terminal prints the receipt.

Declines are explicit: `palm_not_recognised` (after 3 tries), `palm_ambiguous`, `over_palm_limit` (PalmPay), and `insufficient_funds` or `account_blocked` (the bank).

## Partner API (v1)

| Caller | Method and path | Purpose |
|---|---|---|
| Bank | `POST /enrollments` | Turn on PalmPay: `{ bankCustomerRef, name, accountRef, limit, consent, palm }` |
| Bank | `GET /palm-users?bankCustomerRef=` | Is this customer on PalmPay? |
| Bank | `GET / PATCH / DELETE /palm-users/:id` | Read, change account or limit, turn off (deletes the template) |
| Bank | `GET /palm-users/:id/payments` | Palm payment history for the app |
| Terminal | `POST /payment-intents`, `POST /payment-intents/:id/authorize`, `POST /payment-intents/:id/cancel` | Take a payment |
| Bank or terminal | `GET /payments/:id`, `GET /events` | Receipt data, live events |

All calls send `Authorization: Bearer <key>`.

## What the biometric layer really is

Hand geometry from a phone camera is **demo grade**. It is good for showing the experience to banks and investors with a few enrolled people. It is **not** secure enough for real money, and its liveness check is basic.

**Palm lines.** Hand shape alone barely differs between people: on 152 palm photos of 58 hands (from the public 11k Hands set), two *different* people scored a median shape distance of 0.071, under the old 0.075 cut-off, so a stranger's hand often paid as someone else. A payment now needs the palm's lines and creases to match as well (`shared/palm-lines.js`):

1. A square patch of the palm is cut out, lined up with the index and little-finger knuckles, so it is the same patch of skin whatever the hand's angle or distance.
2. It becomes a competitive code (CompCode, Kong & Zhang 2004): on a 24 x 24 grid, which of 6 directions the darkest line runs in. Cells with no clear line are masked out.
3. Two codes are compared by how far apart those directions are, allowing a small shift: 0 = identical, about 0.43 = a stranger.

Each scan keeps the 3 sharpest palm patches; registration stores them with the shape. A match needs the shape under `MATCH_THRESHOLD` (0.10, a loose first filter) **and** the palm lines under `LINES_THRESHOLD` (0.35). On the photo set, 0.35 accepted a stranger 0.2% of the time and refused the owner 4.6% of the time per single photo pair; a live scan compares 3 frames against 3, which helps the owner. Phone lighting and focus are worse than that set, so tune with the `lines` value on the scan screen. Palms registered before palm lines existed have none and must be registered again. `PALM_LINES=off` goes back to shape only (not safe).

**Liveness checks.** Three cheap checks run on the same camera frames, all in `shared/palm-features.js`:

| Check | What it looks for | Setting |
|---|---|---|
| Tremor | A real hand never holds perfectly still: the fingers tremble and drift slightly, each on its own. A photo or a screen moves as one flat sheet. `tremorScore` removes any flat (affine) motion and measures the finger motion left over, in palm widths. | `MIN_TREMOR` |
| Device frame | A photo or video is shown on a phone or screen, and its border shows up as straight edges boxing the hand in; a real hand in a room almost never has straight edges on three sides of it. `frameAroundHand` casts rays outwards from each side of the hand, finds a straight, continuous edge that most rays cross (RANSAC), and scores the third-strongest side (0..1). Tuned on a real photo-on-a-phone scan (0.81) against real-hand scenes (0.19 to 0.23) and 30 generated cluttered rooms (at most 0.37). A device seen in the last 5 seconds counts, so showing it from afar and then moving close doesn't help. (An off-the-shelf object detector was tried first: it rated a phone held face-on as only 9% likely to be a phone.) | `MAX_DEVICE_SCORE` |
| Glare | Skin scatters light softly; glossy photo paper and glass screens throw back bright, nearly white highlights. `glareShare` measures how much of the palm is that kind of glare. | `MAX_GLARE` |

The scanner sends the scores with the probe; the matcher applies the same rule (`evaluateLiveness`) with the server's own thresholds and has the final say. A missing score counts as a fail, so a scan can't skip a check.

| `LIVENESS_MODE` | What happens |
|---|---|
| `off` | No liveness checks |
| `observe` (default) | Scores are measured and shown on the scan screen, nothing is blocked |
| `enforce` | A scan failing any check in `LIVENESS_CHECKS` is refused, in the scanner and again on the server (`not_live`) |

Tune before enforcing: scan real hands, then a photo of a hand on another phone and on paper, read the scores, and set each threshold between them. Strong lighting on a sweaty palm can raise glare; a tiled wall or a window frame directly around the hand can raise the device score. What still gets through: a tablet held so close its edges are out of view, a matt printed hand cut out along its outline, and a good video on a matt screen. Bank-grade liveness (tested to ISO 30107-3) comes with the palm-vein vendor SDK. Keep `DEMO_MODE` on so a demo never stalls on lighting.

Production needs dedicated scanners at counters and a vendor SDK, ideally palm vein (it reads under the skin and is hard to fake). Vendors selling SDKs or APIs include Tencent PalmAI, Fujitsu PalmSecure, Keyo and Redrock Biometrics. Enrolment would also move to a vendor-approved flow. Some vendors allow enrolling with a phone camera; others need a scanner at a branch or shop.

## Running it on Replit for little money

Replit cut its usage prices on 1 August 2026. These are its published usage rates; your plan's monthly fee and included credits come on top.

| Stage | How to run | Data | Approximate usage cost |
|---|---|---|---|
| Build and rehearse | Press **Run** in the workspace. The dev URL is HTTPS, so phone cameras work. | `data/palmpay.json`, `data/sim-banks.json` | Nothing beyond your plan |
| Shareable demo link | **Autoscale**, max instances **1**, `STORE_PERSISTENCE=replit-object-storage` plus an App Storage bucket (Autoscale disks are wiped when an instance stops) | Two JSON snapshots in App Storage | $1/month base + $0.60 per million compute units + $0.40 per million requests; storage $0.015 per GiB-month |
| Always-on demo | Reserved VM, 0.5 vCPU | Same | $0.0208/hour, about $15/month |
| Pilot | Autoscale or Reserved VM + Replit PostgreSQL | Postgres adapter | Database $0.16 per active compute hour, storage $0.35 per GiB-month |

Keep max instances at 1 while the event bus is in-memory. The MediaPipe runtime is served from the app; the hand model (about 8 MB) loads from Google's public model bucket unless `HAND_MODEL_URL` points to a copy in `public/`.

## Path to production

**Phase 1: pilot with one bank, mock money**
- `postgres-store.js` against `db/migrations/001_init.sql`.
- Embedding: a small SDK or hosted PalmPay screens the bank opens in its app, signed with a short-lived token from the bank's backend. The phone never holds an API key.
- Webhooks to the bank instead of SSE, signed with a shared secret.
- Turn off `DEMO_MODE`, `ALLOW_RESET` and `EXPOSE_MATCH_DEBUG`. Stop storing palm snapshots. Hash API keys.

**Phase 2: real money**
- A real connector for each bank's authorise-and-debit API. Favara routing is done by the banks.
- Scanner hardware and a palm-vein vendor SDK at counters, starting with terminals the acquiring bank already runs.
- Redis or Postgres LISTEN/NOTIFY event bus, several instances, monitoring, daily reconciliation of `payments` against bank reports.
- Regulation: talk to the Maldives Monetary Authority early about the licence or sandbox this needs. Biometric data needs explicit consent (captured at enrolment), deletion on request (built in), and a data-protection review with counsel.

## Folder map

```
src/
  config.js                every setting
  ports.js                 the contracts (documentation)
  container.js             picks adapters from config
  domain/                  money, ids, errors
  services/palm-users.js   enrolment, account/limit changes, turning off
  services/payments.js     intents, identify, bank authorisation, outcome
  adapters/store/          generic JSON store, PalmPay repos, persistence
  adapters/banks/          simulated-connector.js (real connectors go here)
  adapters/biometrics/     hand-geometry-matcher.js
  adapters/events/         memory-bus.js
  sim-banks/               STAND-IN for BML/MIB core banking (demo only)
  http/app.js              /api/v1 partner API, /sim-bank demo backend, static files
shared/palm-features.js    palm feature extraction (browser + tests)
public/                    /bank demo bank app, /terminal shop counter
db/migrations/             PostgreSQL schema for PalmPay's data
test/                      node:test suite
```

## Design notes

The demo bank app follows the patterns customers know from Maldivian banking apps: a dark header with the account card, a hide-balance toggle, quick actions, grouped activity, a bottom tab bar with a raised centre action, and pop-down payment notifications. It is deliberately a neutral "demo bank app" with no BML or MIB names in its branding, colours or logos; the banks appear only as "(simulated)" labels. The **App colours** setting (Lagoon, Hibiscus, Mangrove) shows how the PalmPay module takes on a host bank's palette, while the PalmPay mark stays the same.
