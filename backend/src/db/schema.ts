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
} from 'drizzle-orm/pg-core';

/* ─── auth ────────────────────────────────────────────────────────────────*/
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: text('role').notNull().default('staff'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ─── singletons: config (cfg) + sequences (seq) ──────────────────────────*/
export const config = pgTable('config', {
  id: integer('id').primaryKey().default(1),
  agingDays: integer('aging_days').notNull().default(15),
  boxValue: numeric('box_value').notNull().default('450'),
  lostMode: text('lost_mode').notNull().default('manual'),
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
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/* ─── the assets: boxes ───────────────────────────────────────────────────*/
export const boxes = pgTable('boxes', {
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
  location: jsonb('location').notNull().default({}),
  history: jsonb('history').notNull().default([]),
  data: jsonb('data').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  events,
  auditLog,
};
