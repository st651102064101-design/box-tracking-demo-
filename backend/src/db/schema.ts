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
  primaryKey,
} from 'drizzle-orm/pg-core';

/* ─── auth ────────────────────────────────────────────────────────────────*/
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
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
  /** RBAC role this account resolves its permissions through. Nullable for
   *  accounts created before RBAC existed — those fall back to mapping the
   *  legacy `role` string onto a seeded role (see roleKeyForLegacy). */
  roleId: integer('role_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ─── RBAC: roles + their permission grants ───────────────────────────────
 * Permission KEYS are developer-defined (src/lib/permissions.ts) and are not
 * a table — only the grants are data. `key` is the stable identifier code and
 * seeds refer to (users.role_id points at the row, but `key` is what survives
 * an admin renaming "Admin" to "ผู้ดูแลระบบ"). `system` marks Super Admin:
 * locked against edit/disable/delete so a bad custom role can't lock everyone
 * out of the system.
 */
export const roles = pgTable('roles', {
  id: serial('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  active: boolean('active').notNull().default(true),
  system: boolean('system').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Soft delete. `active` is a separate switch an admin flips deliberately
   *  (see routes/roles.ts) — this is what DELETE actually does. A deleted role
   *  can never again be assigned (queries filter it out) but the row survives
   *  for the audit trail: "who had what permissions on such-and-such date"
   *  shouldn't become unanswerable just because the role was later removed. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.roleId, t.permission] }) }),
);

/* ─── singletons: config (cfg) + sequences (seq) ──────────────────────────*/
export const config = pgTable('config', {
  id: integer('id').primaryKey().default(1),
  agingDays: integer('aging_days').notNull().default(15),
  boxValue: numeric('box_value').notNull().default('450'),
  lostMode: text('lost_mode').notNull().default('manual'),
  putawayEnabled: boolean('putaway_enabled').notNull().default(false),
  systemName: text('system_name').notNull().default('Smart Tracking'),
  subtitle: text('subtitle').notNull().default('WMS · เฟส 1 · Returnable Asset Tracking'),
  logoData: text('logo_data'),
  returnNoteCompany: text('return_note_company').notNull().default('ABSS'),
  returnNoteDepartment: text('return_note_department').notNull().default('ฝ่ายทรัพยากรบุคคล'),
  returnNotePhone: text('return_note_phone').notNull().default('0xx-xxx-xxxx'),
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
  lineUserId: text('line_user_id'),
  lineDisplayName: text('line_display_name'),
  linePictureUrl: text('line_picture_url'),
  lineLinkedAt: timestamp('line_linked_at', { withTimezone: true }),
  contactEmail: text('contact_email'),
  returnDays: integer('return_days'),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Soft delete. Customers are referenced from box/DO/inventory history, so a
   *  hard DELETE would either orphan that history or cascade-destroy it — this
   *  keeps the row (and everything that points at it) while taking the
   *  customer out of every list/lookup a normal user sees. Null = active. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const boxTypes = pgTable('box_types', {
  id: text('id').primaryKey(),
  name: text('name'),
  unit: text('unit'),
  value: numeric('value'),
  dim: text('dim'),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Soft delete — see customers.deletedAt. Every box carries `type` as a plain
   *  text reference (not an FK), so deleting the type row out from under boxes
   *  that still hold it would turn "ลังพลาสติก" into a dangling id on screen. */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
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

/** Last FX9600 webhook hit per gate, for the frontend's reader-connected
 *  status light — see the matching table comment in schema.sql for why this
 *  is its own table instead of a column on `gates`. */
export const gateWebhookStatus = pgTable('gate_webhook_status', {
  gateNo: integer('gate_no').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  /** Source IP of the most recent webhook hit — lets the frontend link straight
   *  to the reader's own admin UI without anyone hardcoding an address. */
  lastIp: text('last_ip'),
  lastTagSeenAt: timestamp('last_tag_seen_at', { withTimezone: true }),
  lastAntennas: jsonb('last_antennas').notNull().default([]),
});

/** One-time invitations used to bind a customer to a verified LINE Login
 * identity. Only SHA-256 hashes of bearer tokens/state are stored. */
export const lineLinkInvites = pgTable('line_link_invites', {
  id: serial('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  customerId: text('customer_id').notNull().references(() => customers.id),
  oauthStateHash: text('oauth_state_hash'),
  nonce: text('nonce'),
  codeVerifier: text('code_verifier'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rfidReaders = pgTable('rfid_readers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  host: text('host').notNull(),
  gateNo: integer('gate_no').notNull().unique(),
  webhookUrl: text('webhook_url').notNull(),
  transmitPower: numeric('transmit_power').notNull().default('3'),
  antennaCount: integer('antenna_count').notNull().default(4),
  heartbeatIntervalSeconds: integer('heartbeat_interval_seconds').notNull().default(1),
  readingEnabled: boolean('reading_enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

/** Per-antenna routing for a physical reader that posts all ports to one
 * webhook. `rfid_readers.gate_no` remains the safe fallback for reports that
 * omit an antenna number and for existing installations with no mappings. */
export const rfidAntennaGateMappings = pgTable(
  'rfid_antenna_gate_mappings',
  {
    readerId: text('reader_id').notNull().references(() => rfidReaders.id, { onDelete: 'cascade' }),
    antennaPort: integer('antenna_port').notNull(),
    gateNo: integer('gate_no').notNull(),
    antennaRole: text('antenna_role').notNull().default('direct'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.readerId, t.antennaPort] }) }),
);

/** Required business context staged before unattended outbound processing. */
export const rfidGateAutoSessions = pgTable('rfid_gate_auto_sessions', {
  gateNo: integer('gate_no').primaryKey(),
  direction: text('direction').notNull(),
  customer: text('customer'),
  doNo: text('do_no'),
  po: text('po'),
  plate: text('plate'),
  driver: text('driver'),
  vehicleType: text('vehicle_type'),
  recorder: text('recorder'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by'),
});

/** Boxes a fixed reader saw at a gate, awaiting the operator's confirmation
 *  before they're actually received — see the matching table comment in
 *  schema.sql for why reader reads queue instead of auto-receiving. */
export const gatePendingReads = pgTable(
  'gate_pending_reads',
  {
    gateNo: integer('gate_no').notNull(),
    tag: text('tag').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
    direction: text('direction'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.gateNo, t.tag] }) }),
);

/** Per-account chosen gate for Gate ขาออก/ขาเข้า — see the matching table
 *  comment in schema.sql for why this needed its own table (stateSchema
 *  silently dropped the old S.gatePrefs field on every save). */
export const gatePrefs = pgTable('gate_prefs', {
  username: text('username').primaryKey(),
  outGate: text('out_gate'),
  inGate: text('in_gate'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Per-account UI state for the legacy SPA — last tab, the record/sub-view it
 *  had open, and the smaller per-account view settings. See the matching table
 *  comment in schema.sql for why this needed its own table (stateSchema has no
 *  `uiPrefs` key, so the old S.uiPrefs was stripped on every save). */
export const uiPrefs = pgTable('ui_prefs', {
  username: text('username').primaryKey(),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const locations = pgTable('locations', {
  code: text('code').primaryKey(),
  wh: text('wh'),
  zone: text('zone'),
  rack: text('rack').notNull(),
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
  /** RBAC role for this employee's own login (employees.username below is a
   *  second, separate principal from the `users` table). Employees are the
   *  common case — most have a PDA/web login of their own and no `users` row
   *  at all — so the role has to live here, not only on the linked account.
   *  Never written from the PUT /api/state payload: it is a typed column the
   *  legacy `S` blob knows nothing about, and letting the client set it would
   *  make "save the app state" a way to promote yourself. */
  roleId: integer('role_id'),
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

/** Durable outbox for automatic LINE reminders. The primary key is the
 * business idempotency key (gate batch or customer/business date), while
 * retryKey is reused for every retry so LINE also deduplicates the push. */
export const lineNotificationDeliveries = pgTable(
  'line_notification_deliveries',
  {
    id: text('id').primaryKey(),
    channel: text('channel').notNull().default('line'),
    kind: text('kind').notNull(),
    customerId: text('customer_id').notNull(),
    customerName: text('customer_name').notNull().default(''),
    businessDate: text('business_date').notNull(),
    recipient: text('recipient').notNull(),
    retryKey: text('retry_key').notNull(),
    status: text('status').notNull().default('processing'),
    message: text('message').notNull(),
    attemptCount: integer('attempt_count').notNull().default(1),
    lineRequestId: text('line_request_id'),
    error: text('error'),
    metadata: jsonb('metadata').notNull().default({}),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    retryIdx: index('line_notification_deliveries_retry_idx').on(table.status, table.updatedAt),
    customerIdx: index('line_notification_deliveries_customer_idx').on(table.customerId, table.createdAt),
  }),
);

export type Schema = {
  users: typeof users;
  config: typeof config;
  sequences: typeof sequences;
  customers: typeof customers;
  lineLinkInvites: typeof lineLinkInvites;
  boxTypes: typeof boxTypes;
  warehouses: typeof warehouses;
  gates: typeof gates;
  gateWebhookStatus: typeof gateWebhookStatus;
  rfidReaders: typeof rfidReaders;
  rfidAntennaGateMappings: typeof rfidAntennaGateMappings;
  rfidGateAutoSessions: typeof rfidGateAutoSessions;
  gatePendingReads: typeof gatePendingReads;
  gatePrefs: typeof gatePrefs;
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
  lineNotificationDeliveries: typeof lineNotificationDeliveries;
};

// re-export bundle for drizzle(client, { schema })
export const schema = {
  users,
  config,
  sequences,
  customers,
  lineLinkInvites,
  boxTypes,
  warehouses,
  gates,
  gateWebhookStatus,
  rfidReaders,
  rfidAntennaGateMappings,
  rfidGateAutoSessions,
  gatePendingReads,
  gatePrefs,
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
  lineNotificationDeliveries,
};
