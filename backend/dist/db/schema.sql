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
  must_change_password      BOOLEAN NOT NULL DEFAULT false,
  name                      TEXT NOT NULL,
  role                      TEXT NOT NULL DEFAULT 'staff',
  email                     TEXT,
  password_reset_otp_hash   TEXT,
  password_reset_expires_at TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive migrations for databases created before these columns existed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_otp_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;

-- RBAC. Permission keys are developer-defined in src/lib/permissions.ts and
-- deliberately not a table — only the grants below are data.
CREATE TABLE IF NOT EXISTS roles (
  id          SERIAL PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active      BOOLEAN NOT NULL DEFAULT true,
  system      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id    INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_id, permission)
);

-- Additive migration for databases created before RBAC existed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id);
-- Soft delete: DELETE /api/roles/:id sets this instead of removing the row
-- (see the comment on roles.deletedAt in schema.ts).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS config (
  id          INTEGER PRIMARY KEY DEFAULT 1,
  aging_days  INTEGER NOT NULL DEFAULT 15,
  box_value   NUMERIC NOT NULL DEFAULT 450,
  lost_mode   TEXT NOT NULL DEFAULT 'manual',
  system_name TEXT NOT NULL DEFAULT 'Smart Tracking',
  subtitle    TEXT NOT NULL DEFAULT 'WMS · เฟส 1 · Returnable Asset Tracking',
  logo_data   TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE config ADD COLUMN IF NOT EXISTS putaway_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE config ADD COLUMN IF NOT EXISTS system_name TEXT NOT NULL DEFAULT 'Smart Tracking';
ALTER TABLE config ADD COLUMN IF NOT EXISTS subtitle TEXT NOT NULL DEFAULT 'WMS · เฟส 1 · Returnable Asset Tracking';
ALTER TABLE config ADD COLUMN IF NOT EXISTS logo_data TEXT;
ALTER TABLE config ADD COLUMN IF NOT EXISTS return_note_company TEXT NOT NULL DEFAULT 'ABSS';
ALTER TABLE config ADD COLUMN IF NOT EXISTS return_note_department TEXT NOT NULL DEFAULT 'ฝ่ายทรัพยากรบุคคล';
ALTER TABLE config ADD COLUMN IF NOT EXISTS return_note_phone TEXT NOT NULL DEFAULT '0xx-xxx-xxxx';

CREATE TABLE IF NOT EXISTS sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  addr        TEXT,
  contact     TEXT,
  line_user_id TEXT,
  contact_email TEXT,
  return_days INTEGER,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ
);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS line_user_id TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS line_display_name TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS line_picture_url TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS line_linked_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS contact_email TEXT;

CREATE TABLE IF NOT EXISTS line_link_invites (
  id               SERIAL PRIMARY KEY,
  token_hash       TEXT NOT NULL UNIQUE,
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  oauth_state_hash TEXT,
  nonce            TEXT,
  code_verifier    TEXT,
  expires_at       TIMESTAMPTZ NOT NULL,
  consumed_at      TIMESTAMPTZ,
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS line_link_invites_customer_idx
  ON line_link_invites (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS line_link_invites_expiry_idx
  ON line_link_invites (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS box_types (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  unit       TEXT,
  value      NUMERIC,
  dim        TEXT,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
ALTER TABLE box_types ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

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

-- Last time a gate's FX9600 webhook (POST /api/rfid/fx9600/:gate/webhook) was
-- hit, for the frontend's "reader connected?" status light. Deliberately its
-- own table, not a column on `gates` — replaceState() (PUT /api/state)
-- deletes and rebuilds every row of `gates` wholesale on every save() from
-- the legacy UI, which would wipe this on the next unrelated edit. Written
-- only by the webhook route itself, read-only from the client's point of
-- view (composeState surfaces it, PUT never touches it).
CREATE TABLE IF NOT EXISTS gate_webhook_status (
  gate_no      INTEGER PRIMARY KEY,
  last_seen_at TIMESTAMPTZ NOT NULL
);
-- Source IP of the most recent webhook hit, so the frontend can offer a
-- "manage this reader" button pointed at the FX9600's own admin UI
-- (readers serve one at their IP over HTTP(S)) without anyone hardcoding
-- it — the reader tells us where it's calling from every time it posts.
ALTER TABLE gate_webhook_status ADD COLUMN IF NOT EXISTS last_ip TEXT;
ALTER TABLE gate_webhook_status ADD COLUMN IF NOT EXISTS last_tag_seen_at TIMESTAMPTZ;
ALTER TABLE gate_webhook_status ADD COLUMN IF NOT EXISTS last_antennas JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Central configuration for fixed RFID readers. gate_no is the default/fallback
-- gate when an older payload has no antenna port mapping.
CREATE TABLE IF NOT EXISTS rfid_readers (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  host              TEXT NOT NULL,
  gate_no           INTEGER NOT NULL UNIQUE,
  webhook_url       TEXT NOT NULL,
  transmit_power    NUMERIC NOT NULL DEFAULT 3,
  antenna_count     INTEGER NOT NULL DEFAULT 4,
  heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 1,
  reading_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by        TEXT
);
ALTER TABLE rfid_readers ADD COLUMN IF NOT EXISTS heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 1;

-- A single FX9600 HTTP POST endpoint receives reads from every antenna. Keep
-- routing in normalized configuration so port assignments can change without
-- code changes. The reader's gate_no remains the backwards-compatible fallback.
CREATE TABLE IF NOT EXISTS rfid_antenna_gate_mappings (
  reader_id    TEXT NOT NULL REFERENCES rfid_readers(id) ON DELETE CASCADE,
  antenna_port INTEGER NOT NULL CHECK (antenna_port BETWEEN 1 AND 32),
  gate_no      INTEGER NOT NULL CHECK (gate_no > 0),
  antenna_role TEXT NOT NULL DEFAULT 'direct' CHECK (antenna_role IN ('outer','inner','direct')),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT,
  PRIMARY KEY (reader_id, antenna_port)
);
CREATE INDEX IF NOT EXISTS rfid_antenna_gate_mappings_gate_idx
  ON rfid_antenna_gate_mappings (gate_no);
ALTER TABLE rfid_antenna_gate_mappings ADD COLUMN IF NOT EXISTS antenna_role TEXT NOT NULL DEFAULT 'direct';

CREATE TABLE IF NOT EXISTS rfid_gate_auto_sessions (
  gate_no      INTEGER PRIMARY KEY,
  direction    TEXT NOT NULL CHECK (direction IN ('in','out')),
  customer     TEXT,
  do_no        TEXT,
  po           TEXT,
  plate        TEXT,
  driver       TEXT,
  vehicle_type TEXT,
  recorder     TEXT,
  expires_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by   TEXT
);

-- Which gate each logged-in account last picked for Gate ขาออก/ขาเข้า (see
-- pickGate()/fixedGatesRef() in legacy.html) — the legacy UI used to keep
-- this in S.gatePrefs and round-trip it through PUT /api/state like
-- everything else, but stateSchema never declared that key so it was
-- silently stripped on every save and forgotten on the next reload/device.
-- Keyed by the JWT's `username` (stable per login), not the display `name`
-- (two accounts can share a display name) or a per-browser value (the user
-- explicitly wants this to follow them across devices, not stick to one).
-- Boxes a fixed RFID reader has seen at a gate but that nobody has confirmed
-- into the warehouse yet. The reader feeds this queue; the operator reviews it
-- as chips in Gate ขาเข้า and presses "ยืนยันรับเข้าคลัง" to actually receive —
-- deliberately NOT auto-receiving, since a reader sees everything in range
-- including boxes merely passing by or sitting on a truck that hasn't been
-- unloaded. Rows are upserted (seen_at refreshed) on every read, deleted when
-- the operator confirms or removes the chip, and ignored once stale.
CREATE TABLE IF NOT EXISTS gate_pending_reads (
  gate_no  INTEGER NOT NULL,
  tag      TEXT    NOT NULL,
  seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  direction TEXT,
  PRIMARY KEY (gate_no, tag)
);
ALTER TABLE gate_pending_reads ADD COLUMN IF NOT EXISTS direction TEXT;

CREATE TABLE IF NOT EXISTS gate_prefs (
  username     TEXT PRIMARY KEY,
  out_gate     TEXT,
  in_gate      TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-account UI preferences for the legacy single-page app: which tab the
-- account was last on, which sub-view/record it had open, plus the smaller
-- per-account view settings (theme, layout, list mode, saved filter values).
--
-- Its own table for the same reason gate_prefs got one: the legacy UI kept
-- these in S.uiPrefs and round-tripped them through PUT /api/state, but
-- stateSchema never declared a `uiPrefs` key, so Zod stripped the whole thing
-- on every single save — the values never reached the database at all and
-- were lost on reload or on any other device. They are also per-account UI
-- state, not shared application data, so they must not live in the one big
-- `S` snapshot that every client receives and would overwrite for each other.
--
-- A single jsonb bag rather than a column per key on purpose: these are
-- free-form client-owned view settings that get added and renamed as the UI
-- changes, and nothing server-side ever queries an individual key.
CREATE TABLE IF NOT EXISTS ui_prefs (
  username     TEXT PRIMARY KEY,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS locations (
  code       TEXT PRIMARY KEY,
  wh         TEXT,
  zone       TEXT,
  rack       TEXT NOT NULL,
  shelf      TEXT,
  slot       TEXT,
  type       TEXT,
  note       TEXT,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Physical warehouse geometry for the 3D rack view.  All persisted values are
-- centimetres; the renderer converts them to metres at the API boundary
-- (1 Three.js unit = 1 metre).  `locations` remains the operational/location
-- master used by the legacy UI, while these two tables provide a normalized,
-- queryable geometry model without changing the existing Putaway workflow.
CREATE TABLE IF NOT EXISTS racks (
  id                 TEXT PRIMARY KEY,
  warehouse_id       TEXT NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  zone               TEXT NOT NULL DEFAULT '',
  code               TEXT NOT NULL,
  position_x_cm      DOUBLE PRECISION NOT NULL DEFAULT 0,
  position_y_cm      DOUBLE PRECISION NOT NULL DEFAULT 0,
  position_z_cm      DOUBLE PRECISION NOT NULL DEFAULT 0,
  rotation_y_deg     DOUBLE PRECISION NOT NULL DEFAULT 0,
  width_cm           DOUBLE PRECISION NOT NULL DEFAULT 140,
  height_cm          DOUBLE PRECISION NOT NULL DEFAULT 110,
  depth_cm           DOUBLE PRECISION NOT NULL DEFAULT 110,
  material_type      TEXT NOT NULL DEFAULT 'powder_coated_steel',
  data               JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT racks_identity_unique UNIQUE (warehouse_id, zone, code),
  CONSTRAINT racks_positive_dimensions CHECK (width_cm > 0 AND height_cm > 0 AND depth_cm > 0)
);
CREATE INDEX IF NOT EXISTS racks_warehouse_idx ON racks (warehouse_id, zone, code);

CREATE TABLE IF NOT EXISTS slots (
  id                 TEXT PRIMARY KEY,
  rack_id            TEXT NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
  shelf_code         TEXT NOT NULL DEFAULT '',
  slot_code          TEXT NOT NULL DEFAULT '',
  local_x_cm         DOUBLE PRECISION NOT NULL DEFAULT 0,
  local_y_cm         DOUBLE PRECISION NOT NULL DEFAULT 0,
  local_z_cm         DOUBLE PRECISION NOT NULL DEFAULT 0,
  width_cm           DOUBLE PRECISION NOT NULL DEFAULT 120,
  height_cm          DOUBLE PRECISION NOT NULL DEFAULT 80,
  depth_cm           DOUBLE PRECISION NOT NULL DEFAULT 100,
  status             TEXT NOT NULL DEFAULT 'empty',
  data               JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT slots_rack_position_unique UNIQUE (rack_id, shelf_code, slot_code),
  CONSTRAINT slots_status_check CHECK (status IN ('empty', 'full')),
  CONSTRAINT slots_positive_dimensions CHECK (width_cm > 0 AND height_cm > 0 AND depth_cm > 0)
);
CREATE INDEX IF NOT EXISTS slots_rack_idx ON slots (rack_id, shelf_code, slot_code);

-- Existing Location Master rows receive deterministic real-scale defaults on
-- first migration.  ON CONFLICT DO NOTHING is intentional: operator-adjusted
-- coordinates and dimensions are never overwritten on a later restart.
WITH rack_source AS (
  SELECT
    wh,
    COALESCE(zone, '') AS zone,
    rack,
    COUNT(DISTINCT COALESCE(NULLIF(shelf, ''), '1'))::INTEGER AS shelf_count,
    COUNT(DISTINCT COALESCE(NULLIF(slot, ''), '1'))::INTEGER AS slot_count,
    ROW_NUMBER() OVER (PARTITION BY wh ORDER BY COALESCE(zone, ''), rack) - 1 AS rack_index
  FROM locations
  WHERE COALESCE(wh, '') <> '' AND COALESCE(rack, '') <> ''
  GROUP BY wh, COALESCE(zone, ''), rack
)
INSERT INTO racks (
  id, warehouse_id, zone, code,
  position_x_cm, position_y_cm, position_z_cm, rotation_y_deg,
  width_cm, height_cm, depth_cm
)
SELECT
  CONCAT(wh, '::', zone, '::', rack), wh, zone, rack,
  MOD(rack_index, 4) * 1000.0, 0,
  FLOOR(rack_index / 4.0) * 600.0, 0,
  GREATEST(slot_count * 120.0 + 20.0, 140.0),
  GREATEST(shelf_count * 80.0 + 30.0, 110.0),
  110.0
FROM rack_source
ON CONFLICT (id) DO NOTHING;

WITH slot_source AS (
  SELECT
    l.*,
    COALESCE(l.zone, '') AS normalized_zone,
    DENSE_RANK() OVER (
      PARTITION BY l.wh, COALESCE(l.zone, ''), l.rack
      ORDER BY COALESCE(NULLIF(l.slot, ''), '1')
    ) AS slot_index,
    DENSE_RANK() OVER (
      PARTITION BY l.wh, COALESCE(l.zone, ''), l.rack
      ORDER BY COALESCE(NULLIF(l.shelf, ''), '1')
    ) AS shelf_index,
    COUNT(*) OVER (
      PARTITION BY l.wh, COALESCE(l.zone, ''), l.rack, COALESCE(NULLIF(l.shelf, ''), '1')
    ) AS slots_on_shelf
  FROM locations l
  WHERE COALESCE(l.wh, '') <> '' AND COALESCE(l.rack, '') <> ''
)
INSERT INTO slots (
  id, rack_id, shelf_code, slot_code,
  local_x_cm, local_y_cm, local_z_cm,
  width_cm, height_cm, depth_cm, status
)
SELECT
  code,
  CONCAT(wh, '::', normalized_zone, '::', rack),
  COALESCE(NULLIF(shelf, ''), '1'),
  COALESCE(NULLIF(slot, ''), '1'),
  (slot_index - (slots_on_shelf + 1) / 2.0) * 120.0,
  10.0 + (shelf_index - 0.5) * 80.0,
  0,
  110.0, 70.0, 100.0, 'empty'
FROM slot_source
ON CONFLICT (id) DO NOTHING;

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
-- Employees are a second principal (own username/password_hash below), so they
-- carry their own role rather than borrowing one through a linked users row
-- that most of them don't have.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES roles(id);
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
  slot_id      TEXT REFERENCES slots(id) ON DELETE SET NULL,
  width_cm     DOUBLE PRECISION NOT NULL DEFAULT 60,
  height_cm    DOUBLE PRECISION NOT NULL DEFAULT 40,
  depth_cm     DOUBLE PRECISION NOT NULL DEFAULT 40,
  material_type TEXT NOT NULL DEFAULT 'generic',
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
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS slot_id TEXT REFERENCES slots(id) ON DELETE SET NULL;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS width_cm DOUBLE PRECISION NOT NULL DEFAULT 60;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS height_cm DOUBLE PRECISION NOT NULL DEFAULT 40;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS depth_cm DOUBLE PRECISION NOT NULL DEFAULT 40;
ALTER TABLE boxes ADD COLUMN IF NOT EXISTS material_type TEXT NOT NULL DEFAULT 'generic';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'boxes_rfid_tid_unique') THEN
    ALTER TABLE boxes ADD CONSTRAINT boxes_rfid_tid_unique UNIQUE (rfid_tid);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS boxes_rfid_epc_idx ON boxes (rfid_epc);
CREATE INDEX IF NOT EXISTS boxes_slot_idx ON boxes (slot_id);

-- Resolve the normalized slot whenever an operational flow changes a box's
-- legacy JSON location.  Gate-out/lost flows explicitly clear slot_id; a later
-- Putaway/Gate-in with a real rack location resolves it here in one place.
CREATE OR REPLACE FUNCTION boxtrace_resolve_box_slot()
RETURNS TRIGGER AS $$
BEGIN
  IF COALESCE(NEW.location->>'wh', '') = ''
     OR COALESCE(NEW.location->>'rack', '') = ''
     OR COALESCE(NEW.location->>'shelf', '') = ''
     OR COALESCE(NEW.location->>'slot', '') = '' THEN
    NEW.slot_id := NULL;
  ELSE
    SELECT s.id INTO NEW.slot_id
    FROM slots s
    JOIN racks r ON r.id = s.rack_id
    WHERE r.warehouse_id = NEW.location->>'wh'
      AND r.zone = COALESCE(NEW.location->>'zone', '')
      AND r.code = NEW.location->>'rack'
      AND s.shelf_code = NEW.location->>'shelf'
      AND s.slot_code = NEW.location->>'slot'
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS boxes_resolve_slot_trigger ON boxes;
CREATE TRIGGER boxes_resolve_slot_trigger
BEFORE INSERT OR UPDATE OF location ON boxes
FOR EACH ROW EXECUTE FUNCTION boxtrace_resolve_box_slot();

CREATE OR REPLACE FUNCTION boxtrace_refresh_slot_status()
RETURNS TRIGGER AS $$
DECLARE
  old_slot TEXT;
  new_slot TEXT;
BEGIN
  old_slot := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.slot_id END;
  new_slot := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.slot_id END;

  IF old_slot IS NOT NULL THEN
    UPDATE slots SET status = CASE WHEN (
      SELECT COUNT(*) FROM boxes b
      WHERE b.slot_id = old_slot AND b.status IN ('warehouse', 'hold', 'damage')
    ) >= 2 THEN 'full' ELSE 'empty' END, updated_at = now()
    WHERE id = old_slot;
  END IF;
  IF new_slot IS NOT NULL AND new_slot IS DISTINCT FROM old_slot THEN
    UPDATE slots SET status = CASE WHEN (
      SELECT COUNT(*) FROM boxes b
      WHERE b.slot_id = new_slot AND b.status IN ('warehouse', 'hold', 'damage')
    ) >= 2 THEN 'full' ELSE 'empty' END, updated_at = now()
    WHERE id = new_slot;
  ELSIF new_slot IS NOT NULL THEN
    UPDATE slots SET status = CASE WHEN (
      SELECT COUNT(*) FROM boxes b
      WHERE b.slot_id = new_slot AND b.status IN ('warehouse', 'hold', 'damage')
    ) >= 2 THEN 'full' ELSE 'empty' END, updated_at = now()
    WHERE id = new_slot;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS boxes_slot_status_trigger ON boxes;
CREATE TRIGGER boxes_slot_status_trigger
AFTER INSERT OR DELETE OR UPDATE OF slot_id, status ON boxes
FOR EACH ROW EXECUTE FUNCTION boxtrace_refresh_slot_status();

-- One-time/backward-compatible enrichment of existing boxes from Box Type
-- dimensions.  Explicit per-box dimensions stored in JSON always win.
UPDATE boxes b
SET
  width_cm = SPLIT_PART(REPLACE(REPLACE(LOWER(bt.dim), '×', 'x'), '*', 'x'), 'x', 1)::DOUBLE PRECISION,
  depth_cm = SPLIT_PART(REPLACE(REPLACE(LOWER(bt.dim), '×', 'x'), '*', 'x'), 'x', 2)::DOUBLE PRECISION,
  height_cm = SPLIT_PART(REPLACE(REPLACE(LOWER(bt.dim), '×', 'x'), '*', 'x'), 'x', 3)::DOUBLE PRECISION,
  material_type = CASE
    WHEN COALESCE(bt.name, '') ILIKE '%กระดาษ%' OR COALESCE(bt.name, '') ILIKE '%carton%' THEN 'carton'
    WHEN COALESCE(bt.name, '') ILIKE '%พลาสติก%' OR COALESCE(bt.name, '') ILIKE '%plastic%' THEN 'plastic_crate'
    WHEN COALESCE(bt.name, '') ILIKE '%โลหะ%' OR COALESCE(bt.name, '') ILIKE '%metal%' THEN 'metal_box'
    ELSE b.material_type
  END
FROM box_types bt
WHERE b.type = bt.id
  AND COALESCE(bt.dim, '') ~ '^[[:space:]]*[0-9]+([.][0-9]+)?[[:space:]]*[xX×*][[:space:]]*[0-9]+([.][0-9]+)?[[:space:]]*[xX×*][[:space:]]*[0-9]+([.][0-9]+)?[[:space:]]*$'
  AND b.width_cm = 60
  AND b.height_cm = 40
  AND b.depth_cm = 40
  AND b.material_type = 'generic'
  AND NOT (b.data ? 'widthCm')
  AND NOT (b.data ? 'dimensionsCm');

UPDATE boxes b
SET slot_id = l.code
FROM locations l
WHERE b.slot_id IS NULL
  AND COALESCE(b.location->>'wh', '') = COALESCE(l.wh, '')
  AND COALESCE(b.location->>'zone', '') = COALESCE(l.zone, '')
  AND COALESCE(b.location->>'rack', '') = COALESCE(l.rack, '')
  AND COALESCE(b.location->>'shelf', '') = COALESCE(l.shelf, '')
  AND COALESCE(b.location->>'slot', '') = COALESCE(l.slot, '')
  AND COALESCE(l.rack, '') <> '';

UPDATE slots s
SET status = CASE WHEN (
  SELECT COUNT(*) FROM boxes b
  WHERE b.slot_id = s.id AND b.status IN ('warehouse', 'hold', 'damage')
) >= 2 THEN 'full' ELSE 'empty' END;

/* ─── Realtime warehouse-3D change feed ──────────────────────────────────
   The API's in-process SSE bus observes normal HTTP writes, but an ERP/admin
   tool may legitimately write Postgres directly.  Notify once per committed
   transaction (Postgres folds repeated identical channel/payload pairs) so a
   browser reloads the 3D model only after every related row is durable.

   Keep this deliberately to tables consumed by GET /api/warehouse-3d.  It is
   not a general audit mechanism and must not wake 3D clients for unrelated
   customer, employee, or UI-preference edits. */
CREATE OR REPLACE FUNCTION notify_warehouse3d_changed()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('boxtrace_warehouse3d_changed', 'warehouse3d');
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS boxtrace_warehouse3d_boxes_changed ON boxes;
CREATE TRIGGER boxtrace_warehouse3d_boxes_changed
AFTER INSERT OR UPDATE OR DELETE ON boxes
FOR EACH ROW EXECUTE FUNCTION notify_warehouse3d_changed();

DROP TRIGGER IF EXISTS boxtrace_warehouse3d_box_types_changed ON box_types;
CREATE TRIGGER boxtrace_warehouse3d_box_types_changed
AFTER INSERT OR UPDATE OR DELETE ON box_types
FOR EACH ROW EXECUTE FUNCTION notify_warehouse3d_changed();

DROP TRIGGER IF EXISTS boxtrace_warehouse3d_warehouses_changed ON warehouses;
CREATE TRIGGER boxtrace_warehouse3d_warehouses_changed
AFTER INSERT OR UPDATE OR DELETE ON warehouses
FOR EACH ROW EXECUTE FUNCTION notify_warehouse3d_changed();

DROP TRIGGER IF EXISTS boxtrace_warehouse3d_locations_changed ON locations;
CREATE TRIGGER boxtrace_warehouse3d_locations_changed
AFTER INSERT OR UPDATE OR DELETE ON locations
FOR EACH ROW EXECUTE FUNCTION notify_warehouse3d_changed();

DROP TRIGGER IF EXISTS boxtrace_warehouse3d_racks_changed ON racks;
CREATE TRIGGER boxtrace_warehouse3d_racks_changed
AFTER INSERT OR UPDATE OR DELETE ON racks
FOR EACH ROW EXECUTE FUNCTION notify_warehouse3d_changed();

DROP TRIGGER IF EXISTS boxtrace_warehouse3d_slots_changed ON slots;
CREATE TRIGGER boxtrace_warehouse3d_slots_changed
AFTER INSERT OR UPDATE OR DELETE ON slots
FOR EACH ROW EXECUTE FUNCTION notify_warehouse3d_changed();

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

-- FX9600 fixed readers. One row per physical reader, identified by the
-- `reader` id it's configured to send on its HTTP POST Notification URL
-- (?reader=<id>). `last_webhook_at` is stamped on every inbound call —
-- including empty "no read" heartbeats — so online/offline is derived purely
-- from recency, never from tag activity (see services/fx9600.ts).
CREATE TABLE IF NOT EXISTS fx9600_readers (
  id              TEXT PRIMARY KEY,
  gate_no         INTEGER,
  last_webhook_at TIMESTAMPTZ,
  last_payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
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

-- Location Master records must always identify their physical rack. Older
-- snapshots may have stored NULL; preserve those rows under an explicit
-- migration marker so the column can be made structurally non-null.
UPDATE locations
SET rack = COALESCE(NULLIF(BTRIM(rack), ''), NULLIF(BTRIM(data->>'rack'), ''), 'UNASSIGNED')
WHERE rack IS NULL OR BTRIM(rack) = '';
ALTER TABLE locations ALTER COLUMN rack SET NOT NULL;

-- Durable automatic LINE outbox. A stable business key prevents duplicate
-- pushes after a repeated RFID scan, scheduler overlap, or container restart.
CREATE TABLE IF NOT EXISTS line_notification_deliveries (
  id              TEXT PRIMARY KEY,
  channel         TEXT NOT NULL DEFAULT 'line',
  kind            TEXT NOT NULL,
  customer_id     TEXT NOT NULL,
  customer_name   TEXT NOT NULL DEFAULT '',
  business_date   TEXT NOT NULL,
  recipient       TEXT NOT NULL,
  retry_key       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'processing',
  message         TEXT NOT NULL,
  attempt_count   INTEGER NOT NULL DEFAULT 1,
  line_request_id TEXT,
  error           TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE line_notification_deliveries ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'line';
CREATE INDEX IF NOT EXISTS line_notification_deliveries_retry_idx
  ON line_notification_deliveries (status, updated_at);
CREATE INDEX IF NOT EXISTS line_notification_deliveries_customer_idx
  ON line_notification_deliveries (customer_id, created_at DESC);
