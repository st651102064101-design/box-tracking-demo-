/**
 * ============================================================================
 * Per-entity permission enforcement for PUT /api/state
 * ----------------------------------------------------------------------------
 * The legacy SPA has no per-entity endpoints: `save()` uploads the whole `S`
 * object every time anything changes. That makes "does this request touch
 * employees?" unanswerable from the payload alone — the payload always
 * contains everything — but perfectly answerable as a DIFF against what is
 * already stored.
 *
 * So: compare incoming against stored, group by group. A group that did not
 * change needs no permission at all. A group that changed while the caller
 * lacks the permission for that kind of change is DROPPED — the stored version
 * is kept and the group is named in the response.
 *
 * Why drop rather than 403 the whole request: a warehouse hand editing one box
 * still uploads the employee table along with it, because the snapshot always
 * carries everything. Rejecting the request outright would mean they could
 * never save anything at all. Dropping the groups they may not change lets the
 * work they ARE allowed to do go through, and — the part that actually
 * matters — stops a stale or hostile client from wiping tables it has no
 * business writing to.
 * ============================================================================
 */
import type { StatePayload } from '../validators/schemas.js';

/** Which permissions authorise each kind of change to a group. Holding ANY of
 *  the listed permissions is enough for that kind of change. */
interface GroupRule {
  key: string;
  /** Shown to the user when their change is refused. */
  label: string;
  /** Keys of `S` this group owns. */
  stateKeys: string[];
  create: string[];
  update: string[];
  remove: string[];
  /** Server-derived fields the client echoes back untouched — comparing them
   *  would report a change nobody made. */
  ignoreFields?: string[];
}

const MASTER = ['master.manage'];

export const STATE_GROUPS: GroupRule[] = [
  {
    key: 'boxes',
    label: 'ข้อมูลกล่อง',
    stateKeys: ['boxes'],
    create: ['box.create'],
    update: ['box.update'],
    remove: ['box.delete'],
  },
  {
    key: 'partners',
    label: 'ลูกค้า / คู่ค้า',
    stateKeys: ['customers'],
    create: ['partner.create'],
    update: ['partner.update'],
    remove: ['partner.delete'],
  },
  {
    key: 'employees',
    label: 'ข้อมูลพนักงาน',
    stateKeys: ['employees'],
    create: ['employee.create'],
    update: ['employee.update', 'employee.disable'],
    remove: ['employee.delete'],
    /* Typed columns merged in by composeState, not part of what the client
       may set (roleId in particular is assigned through /api/roles). */
    ignoreFields: ['userId', 'roleId', 'hasPin', 'hasLogin', 'loginUsername'],
  },
  {
    key: 'master',
    label: 'ข้อมูลหลัก (ประเภทกล่อง / คลัง / ประตู / ตำแหน่ง / ตั้งค่า)',
    stateKeys: ['boxtypes', 'warehouses', 'gates', 'locations', 'cfg', 'seq'],
    create: MASTER,
    update: MASTER,
    remove: MASTER,
  },
  {
    key: 'transactions',
    label: 'รายการยืม–คืน / DO / รถ / การจัดเก็บ',
    stateKeys: ['doRecords', 'putaway', 'inventory', 'vehicles'],
    create: ['borrow.create', 'return.create', 'transaction.update'],
    update: ['transaction.update'],
    remove: ['transaction.cancel', 'transaction.update'],
  },
];

/** Groups nothing here guards, and why. */
export const UNGUARDED_STATE_KEYS = [
  /* Append-only movement log the UI writes as things happen; every entry is
     also produced server-side by the gate/box routes. */
  'events',
  /* Not wiped by replaceState at all — see the audit-log section there. */
  'auditLog',
  /* Read-only from the client: only the FX9600 webhook writes these. */
  'gateWebhookLastSeen',
  'gateWebhookLastIp',
  'gateHeartbeatIntervalSeconds',
  'fx9600AdminUrl',
];

type Dict = Record<string, unknown>;

/** Stable JSON with sorted keys, minus fields the client doesn't own, so two
 *  objects that mean the same thing compare equal regardless of key order. */
function normalize(value: unknown, ignore: Set<string>): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const src = v as Dict;
      const out: Dict = {};
      for (const k of Object.keys(src).sort()) {
        if (ignore.has(k)) continue;
        /* undefined and null both mean "not set" once this has been through
           JSON on the wire — treat them the same so a round-trip isn't a diff. */
        if (src[k] === undefined || src[k] === null) continue;
        out[k] = walk(src[k]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

interface GroupDiff {
  added: boolean;
  changed: boolean;
  removed: boolean;
}

function diffGroup(incoming: unknown, stored: unknown, ignore: Set<string>): GroupDiff {
  const isMap = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
  /* Non-map values (cfg, seq are maps; anything scalar) — a plain inequality
     counts as a change. */
  if (!isMap(incoming) || !isMap(stored)) {
    const same = normalize(incoming, ignore) === normalize(stored, ignore);
    return { added: false, changed: !same, removed: false };
  }
  const a = incoming as Dict;
  const b = stored as Dict;
  let added = false;
  let changed = false;
  let removed = false;
  for (const id of Object.keys(a)) {
    if (!(id in b)) added = true;
    else if (normalize(a[id], ignore) !== normalize(b[id], ignore)) changed = true;
  }
  for (const id of Object.keys(b)) if (!(id in a)) removed = true;
  return { added, changed, removed };
}

export interface RejectedGroup {
  key: string;
  label: string;
  /** Which permissions would have been needed. */
  required: string[];
}

export interface GuardResult {
  /** The payload to actually persist: rejected groups replaced with what is
   *  already stored, so the write is a no-op for them. */
  payload: StatePayload;
  rejected: RejectedGroup[];
}

/**
 * Drops the parts of `incoming` the caller may not change, keeping `stored`
 * for those. Returns what to persist plus a report of what was refused.
 */
export function guardStatePayload(
  incoming: StatePayload,
  stored: Record<string, unknown>,
  permissions: string[],
): GuardResult {
  const held = new Set(permissions);
  const has = (perms: string[]) => perms.some((p) => held.has(p));

  const payload = { ...incoming } as Record<string, unknown>;
  const rejected: RejectedGroup[] = [];

  for (const group of STATE_GROUPS) {
    const ignore = new Set(group.ignoreFields ?? []);
    const required = new Set<string>();
    let refuse = false;

    for (const key of group.stateKeys) {
      /* A key the client didn't send at all isn't a deletion — the legacy save
         always sends every key, and treating "absent" as "wipe it" would turn
         any partial/older client into a data-loss event. */
      if (!(key in payload)) continue;
      const d = diffGroup(payload[key], stored[key], ignore);
      if (d.added && !has(group.create)) {
        group.create.forEach((p) => required.add(p));
        refuse = true;
      }
      if (d.changed && !has(group.update)) {
        group.update.forEach((p) => required.add(p));
        refuse = true;
      }
      if (d.removed && !has(group.remove)) {
        group.remove.forEach((p) => required.add(p));
        refuse = true;
      }
    }

    if (refuse) {
      /* Whole group reverts, not just the offending entity: the groups here are
         units the UI edits together, and a half-applied group is a state no
         screen in the app knows how to display. */
      for (const key of group.stateKeys) {
        if (key in payload) payload[key] = stored[key];
      }
      rejected.push({ key: group.key, label: group.label, required: [...required] });
    }
  }

  return { payload: payload as StatePayload, rejected };
}
