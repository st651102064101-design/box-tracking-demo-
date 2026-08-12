/**
 * ============================================================================
 * BoxTrace — Drizzle schema (PostgreSQL)
 * ----------------------------------------------------------------------------
 * Faithful, queryable model of the single-page app's runtime state object `S`
 * (originally persisted wholesale to localStorage under key `boxtrace_p1`).
 *
 * Design: HYBRID relational + JSONB.
 *   - Every entity gets first-class typed columns for the fields you actually
 *     query/report on (status, customer, due dates, gate, …).
 *   - Each row also keeps a `data jsonb` snapshot of the *complete* original
 *     object so the `/api/state` bridge round-trips the legacy UI with 100%
 *     fidelity (nested history[], gateTypes{}, etc.) — nothing is ever lost.
 * ============================================================================
 */
import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  numeric,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';

/* ─── auth ────────────────────────────────────────────────────────────────*/
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull().default('staff'),
  /** Where "ลืมรหัสผ่าน?" sends its OTP — set at registration. Nullable only
   *  for accounts created before this existed; forgot-password refuses to run
   *  for those until an admin backfills one, same pattern as the employee PDA
   *  PIN reset in routes/pin.ts. */
  email: text('email'),
  /** bcrypt hash of a pending "ลืมรหัสผ่าน?" email OTP; cleared once used. */
  passwordResetOtpHash: text('password_reset_otp_hash'),
  passwordResetExpiresAt: timestamp('password_reset_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ─── singletons: config (cfg) + sequences (seq) ──────────────────────────*/
export const config = pgTable('config', {
  id: integer('id').primaryKey().default(1),
  agingDays: integer('aging_days').notNull().default(15),
  boxValue: numeric('box_value').notNull().default('450'),
  lostMode: text('lost_mode').notNull().default('manual'),
  // Per-account UI preferences the legacy frontend used to assume round-tripped
  // through PUT/GET /api/state (S.dfPrefs/S.uiPrefs/S.gatePrefs) but which the
  // typed columns above never actually persisted — they silently reset on every
  // reload. One JSONB blob, keyed the same way the frontend already keys it
  // (by USER, then by filter/toggle id), since there's no per-user table for
  // this and the "verbatim data blob" bridge pattern is already how every
  // other legacy-shaped field round-trips here.
  prefs: jsonb('prefs').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sequences = pgTable('sequences', {
  name: text('name').primaryKey(), // 'do', 'emp', …
  value: integer('value').notNull().default(0),
});

/* ─── master data ─────────────────────────────────────────────────────────*/
export const customers = pgTable('customers', {
  id: text('id').primaryKey(),
  name: text('name'),
  addr: text('addr'),
  contact: text('contact'),
  returnDays: integer('return_days'),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const boxTypes = pgTable('box_types', {
  id: text('id').primaryKey(),
  name: text('name'),
  unit: text('unit'),
  value: numeric('value'),
  dim: text('dim'),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const warehouses = pgTable('warehouses', {
  id: text('id').primaryKey(),
  name: text('name'),
  gateType: text('gate_type'),
  gates: jsonb('gates').notNull().default([]), // number[]
  gateTypes: jsonb('gate_types').notNull().default({}), // Record<gate, 'in'|'out'|'both'>
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Derived lookup gate# -> warehouseId (mirror of S.gates). */
export const gates = pgTable('gates', {
  gateNo: integer('gate_no').primaryKey(),
  warehouseId: text('warehouse_id'),
});

export const locations = pgTable('locations', {
  code: text('code').primaryKey(),
  wh: text('wh'),
  zone: text('zone'),
  rack: text('rack'),
  shelf: text('shelf'),
  slot: text('slot'),
  type: text('type'),
  note: text('note'),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const employees = pgTable('employees', {
  id: text('id').primaryKey(),
  name: text('name'),
  role: text('role'),
  /** Links this employee record to its login account, so the JWT-authenticated
   *  `users.role` (admin/staff/viewer) is the single source of truth for access
   *  control — the legacy `data.access` field is kept in sync from it instead
   *  of being an independent, client-editable permission. Nullable: employees
   *  created before this link existed, or without a login account. */
  userId: integer('user_id').references(() => users.id),
  data: jsonb('data').notNull().default({}),
  /** bcrypt hash of the employee's PDA PIN — never the raw digits. */
  pinHash: text('pin_hash'),
  /** bcrypt hash of a pending "ลืมรหัส PIN?" email OTP; cleared once used. */
  pinResetOtpHash: text('pin_reset_otp_hash'),
  pinResetExpiresAt: timestamp('pin_reset_expires_at', { withTimezone: true }),
  /** This employee's own web-app login — set by an admin (see PUT
   *  /api/employees/:id/credentials), separate from the `users` table of
   *  system/service accounts. Null until set: an employee with no username
   *  yet can't sign in as themselves, only be picked as a display name. */
  username: text('username').unique(),
  passwordHash: text('password_hash'),
  /** bcrypt hash of a pending "ลืมรหัสผ่าน?" (web login, not the PDA PIN)
   *  email OTP; cleared once used. Separate from pinResetOtpHash above —
   *  different secret, different expiry, different form. */
  passwordResetOtpHash: text('password_reset_otp_hash'),
  passwordResetExpiresAt: timestamp('password_reset_expires_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ─── the assets: boxes ───────────────────────────────────────────────────*/
export const boxes = pgTable(
  'boxes',
  {
    tag: text('tag').primaryKey(),
    type: text('type'),
    value: numeric('value'),
    status: text('status').notNull().default('pending'),
    cycles: integer('cycles').notNull().default(0),
    customer: text('customer'),
    doNo: text('do_no'),
    po: text('po'),
    outGate: integer('out_gate'),
    outWh: text('out_wh'),
    outAt: timestamp('out_at', { withTimezone: true }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    labeled: boolean('labeled').notNull().default(false),
    /**
     * RFID commissioning, added on top of the original barcode-only model.
     * `tag` (the barcode, e.g. "BOX-015") stays the box's permanent identity
     * forever — RFID is just another way to *find* that same row, which is
     * why a tag swap (damaged sticker) only ever touches these two columns.
     *
     * Both are TEXT, not BYTEA: EPC/TID are always handled as hex strings on
     * every hop (reader SDK, wire format, this API), a fixed-width 96/128-bit
     * EPC never blows past a few dozen bytes, and TEXT keeps `LIKE`/equality
     * search and psql debugging trivial — the compactness BYTEA buys isn't
     * worth losing that at this row count.
     *
     * - rfid_tid: factory-burned, globally unique serial the chip vendor
     *   lasered in — never rewritable, so UNIQUE is a real DB-level guarantee
     *   and doubles as the anti-reuse check (see routes/rfid.ts).
     * - rfid_epc: user memory we write ourselves (see lib/rfid.ts encode) —
     *   NOT unique at the DB level because a tag mid-replacement legitimately
     *   has its old EPC still sitting on a shelf sticker for a moment; the
     *   uniqueness that matters (one *active* box per EPC) is enforced by
     *   applying it through routes/rfid.ts, not by a blanket constraint.
     */
    /**
     * The box's single RFID identity, and the only value tag association
     * writes going forward.
     *
     * This is the EPC — the value a reader reports for every tag during a
     * plain inventory sweep, at full speed and from any reader. A TID is the
     * more tamper-proof identifier, but most readers only surface one by
     * running a separate access operation, and an access operation has to stop
     * the inventory to run; storing an identifier the scanner can only obtain
     * by stopping to ask for it would make rapid trigger-held scanning
     * impossible. Uniqueness is instead guaranteed here, by the constraint
     * below plus writing EPCs derived from the barcode (see lib/rfid.ts) —
     * a duplicate is rejected at registration rather than discovered later.
     *
     * UNIQUE because one physical tag belongs to exactly one box; that
     * constraint is what stops a tag being silently re-registered onto a
     * second box.
     *
     * [rfidTid]/[rfidEpc] below are retained for rows written before this
     * column existed and for the record of what was actually read; lookups
     * still match against them (see services/rfid.ts) so nothing registered
     * under the old scheme stops resolving.
     */
    rfid: text('rfid').unique(),
    rfidTid: text('rfid_tid').unique(),
    rfidEpc: text('rfid_epc'),
    location: jsonb('location').notNull().default({}),
    history: jsonb('history').notNull().default([]),
    data: jsonb('data').notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    rfidEpcIdx: index('boxes_rfid_epc_idx').on(table.rfidEpc),
  }),
);

/* ─── operational / logistics ─────────────────────────────────────────────*/
export const vehicles = pgTable('vehicles', {
  id: text('id').primaryKey(),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const doRecords = pgTable('do_records', {
  id: text('id').primaryKey(),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const putaway = pgTable('putaway', {
  id: text('id').primaryKey(),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const inventory = pgTable('inventory', {
  id: text('id').primaryKey(),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ─── cycle counts (ตรวจนับ) ───────────────────────────────────────────────
 * A stock-take session over one warehouse (optionally narrowed to one zone).
 * `expected` is frozen at open time rather than recomputed on close: the
 * whole point of a count is comparing what was *believed* to be on the shelf
 * against what was actually found, and a box gated out mid-count would
 * otherwise quietly erase its own discrepancy.
 *
 * Deliberately its own table rather than another row in the generic
 * `inventory` id/data bag — a count is queried by warehouse, zone and status
 * (find the open session for this post), and those need real columns to be
 * indexable rather than jsonb probes. */
export const cycleCounts = pgTable('cycle_counts', {
  id: text('id').primaryKey(),
  wh: text('wh').notNull(),
  zone: text('zone').notNull().default(''),
  status: text('status').notNull().default('open'), // 'open' | 'closed'
  startedBy: text('started_by'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  /** Box tags the system believed were here when the session opened. */
  expected: jsonb('expected').notNull().default([]),
  /** Expected tags that were actually scanned. */
  counted: jsonb('counted').notNull().default([]),
  /** Scanned here but not expected here — the other half of a discrepancy. */
  unexpected: jsonb('unexpected').notNull().default([]),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ─── event streams ───────────────────────────────────────────────────────*/
export const events = pgTable('events', {
  id: serial('id').primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  data: jsonb('data').notNull().default({}),
});

export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  action: text('action'),
  actor: text('actor'),
  entityId: text('entity_id'),
  entityName: text('entity_name'),
  before: jsonb('before'),
  after: jsonb('after'),
  data: jsonb('data').notNull().default({}), // full original entry, verbatim
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
});

export type Schema = {
  users: typeof users;
  config: typeof config;
  sequences: typeof sequences;
  customers: typeof customers;
  boxTypes: typeof boxTypes;
  warehouses: typeof warehouses;
  gates: typeof gates;
  locations: typeof locations;
  employees: typeof employees;
  boxes: typeof boxes;
  vehicles: typeof vehicles;
  doRecords: typeof doRecords;
  putaway: typeof putaway;
  inventory: typeof inventory;
  cycleCounts: typeof cycleCounts;
  events: typeof events;
  auditLog: typeof auditLog;
};

// re-export bundle for drizzle(client, { schema })
export const schema = {
  users,
  config,
  sequences,
  customers,
  boxTypes,
  warehouses,
  gates,
  locations,
  employees,
  boxes,
  vehicles,
  doRecords,
  putaway,
  inventory,
  cycleCounts,
  events,
  auditLog,
};
