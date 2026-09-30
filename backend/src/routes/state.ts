import { Router } from 'express';
import { getDb } from '../db/client.js';
import { employees } from '../db/schema.js';
import { composePdaState, composeState, replaceState } from '../services/state.js';
import { stateSchema } from '../validators/schemas.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { bump } from '../lib/bus.js';
import { requirePermissions } from './roles.js';
import { effectiveRole } from '../lib/role-data.js';

function scopedState(state: Record<string, unknown>, permissions: string[]) {
  const has = (...keys: string[]) => keys.some((key) => permissions.includes(key));
  const result: Record<string, unknown> = {};
  const copy = (key: string, allowed: boolean, empty: unknown) => {
    if (Object.prototype.hasOwnProperty.call(state, key)) result[key] = allowed ? (state[key] ?? empty) : empty;
  };
  const boxRead = has('box.view', 'box.detail', 'box.create', 'box.update', 'box.export', 'gate.in', 'gate.out', 'transaction.view', 'transaction.history', 'report.view', 'report.analytics', 'movement.view', 'dashboard.view', 'cycle_count.view', 'cycle_count.manage');
  const transactionRead = has('transaction.view', 'transaction.history', 'borrow.create', 'return.create', 'transaction.update', 'overdue.manage', 'gate.in', 'gate.out', 'report.view', 'report.analytics', 'dashboard.view');
  const warehouseRead = has('warehouse.view', 'warehouse.manage', 'gate.in', 'gate.out', 'box.view', 'box.detail', 'dashboard.view', 'cycle_count.view', 'cycle_count.manage');
  copy('boxes', boxRead, {});
  copy('customers', has('partner.view', 'partner.history', 'partner.create', 'partner.update', 'transaction.view', 'transaction.history', 'borrow.create', 'return.create', 'gate.in', 'gate.out', 'report.view', 'report.analytics'), {});
  copy('boxtypes', has('box.view', 'box.detail', 'box.create', 'box.update', 'master.manage', 'setting.view', 'dashboard.view'), {});
  copy('warehouses', warehouseRead || has('master.manage', 'setting.view'), {});
  copy('gates', warehouseRead || has('master.manage', 'setting.view'), {});
  copy('locations', warehouseRead || has('master.manage', 'setting.view'), {});
  copy('events', transactionRead || has('movement.view', 'audit.view', 'audit.export', 'cycle_count.view', 'cycle_count.manage'), []);
  copy('doRecords', transactionRead, {});
  copy('putaway', transactionRead || has('warehouse.manage', 'box.update'), {});
  copy('inventory', boxRead || transactionRead, {});
  copy('vehicles', has('gate.in', 'gate.out', 'transaction.view', 'transaction.history', 'gateprefs.manage'), {});
  copy('employees', has('employee.view', 'employee.update', 'employee.disable', 'employee.pin.manage', 'audit.view', 'setting.view'), {});
  copy('cfg', has('setting.view', 'master.manage', 'overdue.manage', 'notification.manage', 'dashboard.view'), {});
  copy('seq', has('master.manage', 'box.create', 'partner.create', 'employee.create', 'borrow.create'), {});
  copy('auditLog', has('audit.view', 'audit.export'), []);
  return result;
}

const STATE_WRITE_POLICY: Record<string, string[]> = {
  boxes: ['box.create','box.update','box.delete','gate.in','gate.out','borrow.create','return.create','transaction.update','overdue.manage'],
  customers: ['partner.create','partner.update','partner.delete'],
  boxtypes: ['master.manage'],
  warehouses: ['warehouse.manage','master.manage'],
  gates: ['warehouse.manage','master.manage'],
  locations: ['warehouse.manage','master.manage'],
  events: ['transaction.update','gate.in','gate.out','borrow.create','return.create','cycle_count.manage','box.update'],
  doRecords: ['transaction.update','gate.out','borrow.create'],
  putaway: ['warehouse.manage','gate.in','gate.out','box.update'],
  inventory: ['transaction.update','gate.in','gate.out','box.update'],
  employees: ['employee.create','employee.update','employee.disable','employee.delete','employee.pin.manage'],
  vehicles: ['gate.in','gate.out','gateprefs.manage'],
  cfg: ['master.manage','notification.manage','overdue.manage'],
  seq: ['master.manage','box.create','partner.create','employee.create','borrow.create'],
};

function protectStateWrites(payload: Record<string, unknown>, current: Record<string, unknown>, permissions: string[]) {
  const has = (keys: string[]) => keys.some((key) => permissions.includes(key));
  const checkRecord = (field: string, create: string[], update: string[], remove: string[]) => {
    const incoming = (payload[field] ?? {}) as Record<string, unknown>;
    const existing = (current[field] ?? {}) as Record<string, unknown>;
    if (!Object.keys(incoming).length && Object.keys(existing).length && !has([...create, ...update, ...remove])) {
      payload[field] = existing;
      return;
    }
    for (const key of new Set([...Object.keys(incoming), ...Object.keys(existing)])) {
      const before = existing[key], after = incoming[key];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const grants = before === undefined ? create : after === undefined ? remove : update;
      if (!has(grants)) throw httpError(403, `คุณไม่มีสิทธิ์แก้ไข ${field}.${key}`, 'forbidden');
    }
  };
  checkRecord('boxes', ['box.create'], ['box.update','gate.in','gate.out','borrow.create','return.create','transaction.update'], ['box.delete']);
  checkRecord('customers', ['partner.create'], ['partner.update'], ['partner.delete']);
  checkRecord('boxtypes', ['master.manage'], ['master.manage'], ['master.manage']);
  checkRecord('warehouses', ['warehouse.manage','master.manage'], ['warehouse.manage','master.manage'], ['warehouse.manage','master.manage']);
  checkRecord('gates', ['warehouse.manage','master.manage'], ['warehouse.manage','master.manage'], ['warehouse.manage','master.manage']);
  checkRecord('locations', ['warehouse.manage','master.manage'], ['warehouse.manage','master.manage'], ['warehouse.manage','master.manage']);
  checkRecord('employees', ['employee.create'], ['employee.update','employee.disable','employee.pin.manage'], ['employee.delete']);
  for (const [field, grants] of Object.entries(STATE_WRITE_POLICY)) {
    if (['boxes','customers','boxtypes','warehouses','locations','employees'].includes(field)) continue;
    if (has(grants)) continue;
    const incoming = payload[field] ?? (Array.isArray(current[field]) ? [] : {});
    const existing = current[field] ?? (Array.isArray(incoming) ? [] : {});
    const empty = Array.isArray(incoming) ? incoming.length === 0 : typeof incoming === 'object' && incoming !== null && Object.keys(incoming).length === 0;
    if (!empty && JSON.stringify(incoming) !== JSON.stringify(existing)) {
      throw httpError(403, `คุณไม่มีสิทธิ์แก้ไขข้อมูลส่วน ${field}`, 'forbidden');
    }
    payload[field] = existing;
  }
  // Audit history is append-only and must never be replaced by a client snapshot.
  payload.auditLog = current.auditLog ?? [];
}

/**
 * The persistence bridge used by the legacy single-page UI.
 *   GET /api/state → the full `S` snapshot (what localStorage used to hold)
 *   PUT /api/state → replace the stored state wholesale (what `save()` did)
 */
export const stateRouter = Router();

stateRouter.use(requireAuth);

// A separate path keeps intermediaries from stripping a view query parameter
// and makes PDA snapshot traffic distinguishable from the legacy web bridge.
stateRouter.get(
  '/pda',
  requirePermissions('gate.in', 'gate.out', 'box.view', 'transaction.view'),
  asyncHandler(async (req, res) => {
    const permissions = (await effectiveRole(req.user)).permissions;
    res.json(scopedState(await composePdaState(getDb()), permissions));
  }),
);

stateRouter.get(
  '/',
  requirePermissions('dashboard.view', 'gate.in', 'gate.out', 'box.view', 'transaction.view', 'report.view', 'warehouse.view', 'setting.view', 'employee.view', 'partner.view', 'rfid.log', 'lpr.log', 'cycle_count.view', 'movement.view', 'audit.view'),
  asyncHandler(async (req, res) => {
    const db = getDb();
    const state = req.query.view === 'pda'
      ? await composePdaState(db)
      : await composeState(db);
    res.json(scopedState(state, (await effectiveRole(req.user)).permissions));
  }),
);

stateRouter.put(
  '/',
  requirePermissions('box.create','box.update','box.delete','transaction.update','borrow.create','return.create','partner.create','partner.update','partner.delete','employee.create','employee.update','employee.disable','employee.delete','warehouse.manage','master.manage','gate.in','gate.out','gateprefs.manage','cycle_count.manage','overdue.manage','notification.manage','employee.pin.manage'),
  asyncHandler(async (req, res) => {
    const payload = stateSchema.parse(req.body);
    const db = getDb();
    const role = await effectiveRole(req.user);
    const currentState = await composeState(db);

    if (req.user?.role !== 'admin') protectStateWrites(payload, currentState, role.permissions);

    /* Guard against privilege escalation: the legacy UI's own admin-only check
       (isAdmin() in legacy.html) is client-side only, and this endpoint accepts
       the whole `S` snapshot verbatim. A non-admin caller must not be able to
       grant/change any employee's access level (including their own) by simply
       PUTting a modified state. */
    if (req.user?.role !== 'admin') {
      const current = await db.select().from(employees);
      const currentAccess = new Map(
        current.map((e) => [e.id, (e.data as Record<string, unknown> | null)?.access]),
      );
      for (const [id, raw] of Object.entries(payload.employees ?? {})) {
        const incomingAccess = (raw as Record<string, unknown>)?.access;
        if (incomingAccess !== currentAccess.get(id)) {
          throw httpError(403, 'คุณไม่มีสิทธิ์เปลี่ยนสิทธิ์การใช้งานพนักงาน', 'forbidden');
        }
      }
    }

    /* Design decision: no one — not even an admin — may delete their own employee
       record through this endpoint. The client (legacy.html) already blocks this
       in the UI, but this endpoint accepts a raw state snapshot, so the real gate
       has to live here: reject any upload that drops the caller's own employeeId. */
    if (req.user?.employeeId && !(req.user.employeeId in (payload.employees ?? {}))) {
      throw httpError(403, 'ไม่สามารถลบบัญชีของตัวเองได้', 'forbidden');
    }

    await replaceState(db, payload);
    /* Tell every open stream. The writer's own id rides along so its browser
       can skip re-fetching the snapshot it just uploaded. */
    const version = bump(req.get('X-Client-Id'));
    res.json({ ok: true, version });
  }),
);

export default stateRouter;
