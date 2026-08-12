-- ============================================================================
-- BoxTrace — initial schema (PostgreSQL 16)
-- Mirrors src/db/schema.ts exactly. Idempotent: safe to run repeatedly.
-- Real Postgres deployments should prefer drizzle-kit migrations, but this DDL
-- is the single source used to bootstrap both Postgres and the PGlite test DB.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id                        SERIAL PRIMARY KEY,
  username                  TEXT NOT NULL UNIQUE,
  password_hash             TEXT NOT NULL,
  name                      TEXT NOT NULL,
  role                      TEXT NOT NULL DEFAULT 'staff',
  email                     TEXT,
  password_reset_otp_hash   TEXT,
  password_reset_expires_at TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive migrations for databases created before these columns existed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_otp_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS config (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  aging_days  INTEGER NOT NULL DEFAULT 15,
  box_value   NUMERIC NOT NULL DEFAULT 450,
  lost_mode   TEXT NOT NULL DEFAULT 'manual',
  prefs       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive: databases created before per-account UI prefs (S.dfPrefs/S.uiPrefs/
-- S.gatePrefs) round-tripped through /api/state.
ALTER TABLE config ADD COLUMN IF NOT EXISTS prefs JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  addr        TEXT,
  contact     TEXT,
  return_days INTEGER,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS box_types (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  unit       TEXT,
  value      NUMERIC,
  dim        TEXT,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS warehouses (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  gate_type  TEXT,
  gates      JSONB NOT NULL DEFAULT '[]'::jsonb,
  gate_types JSONB NOT NULL DEFAULT '{}'::jsonb,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gates (
  gate_no      INTEGER PRIMARY KEY,
  warehouse_id TEXT
);

CREATE TABLE IF NOT EXISTS locations (
  code       TEXT PRIMARY KEY,
  wh         TEXT,
  zone       TEXT,
  rack       TEXT,
  shelf      TEXT,
  slot       TEXT,
  type       TEXT,
  note       TEXT,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employees (
  id                    TEXT PRIMARY KEY,
  name                  TEXT,
  role                  TEXT,
  user_id               INTEGER REFERENCES users(id),
  data                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  pin_hash              TEXT,
  pin_reset_otp_hash    TEXT,
  pin_reset_expires_at  TIMESTAMPTZ,
  username              TEXT UNIQUE,
  password_hash         TEXT,
  password_reset_otp_hash    TEXT,
  password_reset_expires_at  TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive migrations for databases created before these columns existed.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_hash TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_reset_otp_hash TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS pin_reset_expires_at TIMESTAMPTZ;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS username TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_username_unique') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_username_unique UNIQUE (username);
  END IF;
END $$;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_reset_otp_hash TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS boxes (
  tag          TEXT PRIMARY KEY,
  type         TEXT,
  value        NUMERIC,
  status       TEXT NOT NULL DEFAULT 'pending',
  cycles       INTEGER NOT NULL DEFAULT 0,
  customer     TEXT,
  do_no        TEXT,
  po           TEXT,
  out_gate     INTEGER,
  out_wh       TEXT,
  out_at       TIMESTAMPTZ,
  due_at       TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  labeled      BOOLEAN NOT NULL DEFAULT false,
  rfid_tid     TEXT UNIQUE,
  rfid_epc     TEXT,
  location     JSONB NOT NULL DEFAULT '{}'::jsonb,
  history      JSONB NOT NULL DEFAULT '[]'::jsonb,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS boxes_status_idx   ON boxes (status);
CREATE INDEX IF NOT EXISTS boxes_customer_idx ON boxes (customer);
CREATE INDEX IF NOT EXISTS boxes_due_idx      ON boxes (due_at);

-- Additive migrations for databases created before RFID columns existed.
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS rfid_tid TEXT;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS rfid_epc TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boxes_rfid_tid_unique') THEN
    ALTER TABLE boxes ADD CONSTRAINT boxes_rfid_tid_unique UNIQUE (rfid_tid);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS boxes_rfid_epc_idx ON boxes (rfid_epc);

-- One RFID identity per box (see boxes.rfid in db/schema.ts). Backfilled
-- preferring the EPC, since that is the value a reader reports during a plain
-- inventory sweep and therefore the one a gate scan will actually arrive as.
-- The old columns are intentionally left in place: they still carry the record
-- of what was read, lookups keep matching them so nothing registered under the
-- old scheme stops resolving, and dropping them would make this irreversible.
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS rfid TEXT;
UPDATE boxes SET rfid = COALESCE(rfid_epc, rfid_tid) WHERE rfid IS NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boxes_rfid_unique') THEN
    ALTER TABLE boxes ADD CONSTRAINT boxes_rfid_unique UNIQUE (rfid);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS vehicles (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS do_records (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS putaway (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ตรวจนับ (cycle count) sessions. `expected` is frozen at open time so a box
-- gated out mid-count can't quietly erase its own discrepancy; see
-- src/db/schema.ts for the full reasoning.
CREATE TABLE IF NOT EXISTS cycle_counts (
  id          TEXT PRIMARY KEY,
  wh          TEXT NOT NULL,
  zone        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'open',
  started_by  TEXT,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ,
  expected    JSONB NOT NULL DEFAULT '[]'::jsonb,
  counted     JSONB NOT NULL DEFAULT '[]'::jsonb,
  unexpected  JSONB NOT NULL DEFAULT '[]'::jsonb,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Finding "the open session for this post" is the single hottest lookup here
-- (every scan the PDA submits resolves through it).
CREATE INDEX IF NOT EXISTS cycle_counts_open_idx ON cycle_counts (wh, zone, status);

CREATE TABLE IF NOT EXISTS events (
  id   SERIAL PRIMARY KEY,
  ts   TIMESTAMPTZ NOT NULL DEFAULT now(),
  data JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          SERIAL PRIMARY KEY,
  action      TEXT,
  actor       TEXT,
  entity_id   TEXT,
  entity_name TEXT,
  before      JSONB,
  after       JSONB,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now()
);
