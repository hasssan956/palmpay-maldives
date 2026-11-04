-- PalmPay Maldives: PalmPay's own data in PostgreSQL (same model as the JSON store).
-- There are no balances or bank accounts here on purpose: money lives at the
-- banks. PalmPay keeps identity (palm templates), the bank's references, the
-- customer's chosen account and limit, and a record of payments it routed.
-- Money is BIGINT laari.

CREATE TABLE partner_banks (
  id            TEXT PRIMARY KEY,               -- 'bml', 'mib'
  name          TEXT NOT NULL,
  short_name    TEXT NOT NULL,
  api_base_url  TEXT,                           -- the bank's endpoint for authorize-debit
  webhook_url   TEXT,                           -- where PalmPay sends payment events
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  key_hash      TEXT PRIMARY KEY,               -- store a hash, never the key
  partner_type  TEXT NOT NULL CHECK (partner_type IN ('bank','terminal')),
  bank_id       TEXT REFERENCES partner_banks(id),
  merchant_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);

CREATE TABLE palm_users (
  id                 TEXT PRIMARY KEY,          -- pu_...
  bank_id            TEXT NOT NULL REFERENCES partner_banks(id),
  bank_customer_ref  TEXT NOT NULL,             -- the bank's id for its customer
  name               TEXT NOT NULL,
  phone              TEXT,
  funding_account_ref TEXT NOT NULL,            -- the bank's token for the chosen account
  funding_label      TEXT NOT NULL,             -- "Current account"
  funding_masked     TEXT NOT NULL,             -- "••0913"
  limit_laari        BIGINT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  consent_version    TEXT NOT NULL,
  consent_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX one_active_palm_user ON palm_users (bank_id, bank_customer_ref) WHERE status <> 'deleted';

CREATE TABLE palm_templates (
  id            TEXT PRIMARY KEY,               -- plm_...
  palm_user_id  TEXT NOT NULL REFERENCES palm_users(id),
  model         TEXT NOT NULL,                  -- mp-handgeom-v1 | vendor model id
  template_ref  JSONB,                          -- vector today; { vendorTemplateId } with a vendor; NULL once revoked
  quality       JSONB,
  snapshot      TEXT,                           -- demo only; never store palm images in production
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX one_active_template ON palm_templates (palm_user_id) WHERE status = 'active';

CREATE TABLE merchants (
  id                      TEXT PRIMARY KEY,     -- mer_...
  name                    TEXT NOT NULL,
  location                TEXT,
  acquirer_bank_id        TEXT NOT NULL REFERENCES partner_banks(id),
  settlement_account_ref  TEXT NOT NULL,        -- acquirer's reference for the shop's account
  terminals               TEXT[] NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_intents (
  id               TEXT PRIMARY KEY,            -- pi_...
  merchant_id      TEXT NOT NULL REFERENCES merchants(id),
  terminal_id      TEXT NOT NULL,
  amount           BIGINT NOT NULL CHECK (amount >= 100),
  currency         CHAR(3) NOT NULL DEFAULT 'MVR',
  items            JSONB NOT NULL DEFAULT '[]',
  description      TEXT,
  reference        TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL CHECK (status IN ('requires_palm','processing','succeeded','failed','canceled','expired')),
  attempts         INT NOT NULL DEFAULT 0,
  palm_user_id     TEXT REFERENCES palm_users(id),
  payment_id       TEXT,
  failure_reason   TEXT,
  last_error       JSONB,
  idempotency_key  TEXT,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, idempotency_key)
);

-- A record of each approved payment: what PalmPay routed, not a balance.
CREATE TABLE payments (
  id                TEXT PRIMARY KEY,           -- pay_...
  reference         TEXT NOT NULL UNIQUE,
  intent_id         TEXT NOT NULL REFERENCES payment_intents(id),
  amount            BIGINT NOT NULL,
  currency          CHAR(3) NOT NULL DEFAULT 'MVR',
  palm_user_id      TEXT NOT NULL REFERENCES palm_users(id),
  bank_id           TEXT NOT NULL REFERENCES partner_banks(id),     -- issuer
  account_masked    TEXT NOT NULL,
  merchant_id       TEXT NOT NULL REFERENCES merchants(id),
  acquirer_bank_id  TEXT NOT NULL REFERENCES partner_banks(id),
  rail              TEXT NOT NULL CHECK (rail IN ('on-us','favara')),
  auth_code         TEXT NOT NULL,
  method            TEXT NOT NULL,              -- palm | simulated
  match_distance    NUMERIC(8,4),
  items             JSONB NOT NULL DEFAULT '[]',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_by_user ON payments (palm_user_id, created_at DESC);
CREATE INDEX payments_by_merchant ON payments (merchant_id, created_at DESC);

-- Transactional outbox -> SSE today, bank webhooks later.
CREATE TABLE events (
  id            TEXT PRIMARY KEY,               -- evt_...
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX events_unpublished ON events (created_at) WHERE published_at IS NULL;
