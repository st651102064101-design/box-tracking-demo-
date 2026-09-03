const MASTER = ['master.manage'];
export const STATE_GROUPS = [
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
];
/** Stable JSON with sorted keys, minus fields the client doesn't own, so two
 *  objects that mean the same thing compare equal regardless of key order. */
function normalize(value, ignore) {
    const walk = (v) => {
        if (Array.isArray(v))
            return v.map(walk);
        if (v && typeof v === 'object') {
            const src = v;
            const out = {};
            for (const k of Object.keys(src).sort()) {
                if (ignore.has(k))
                    continue;
                /* undefined and null both mean "not set" once this has been through
                   JSON on the wire — treat them the same so a round-trip isn't a diff. */
                if (src[k] === undefined || src[k] === null)
                    continue;
                out[k] = walk(src[k]);
            }
            return out;
        }
        return v;
    };
    return JSON.stringify(walk(value));
}
function diffGroup(incoming, stored, ignore) {
    const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    /* Non-map values (cfg, seq are maps; anything scalar) — a plain inequality
       counts as a change. */
    if (!isMap(incoming) || !isMap(stored)) {
        const same = normalize(incoming, ignore) === normalize(stored, ignore);
        return { added: false, changed: !same, removed: false };
    }
    const a = incoming;
    const b = stored;
    let added = false;
    let changed = false;
    let removed = false;
    for (const id of Object.keys(a)) {
        if (!(id in b))
            added = true;
        else if (normalize(a[id], ignore) !== normalize(b[id], ignore))
            changed = true;
    }
    for (const id of Object.keys(b))
        if (!(id in a))
            removed = true;
    return { added, changed, removed };
}
/**
 * Drops the parts of `incoming` the caller may not change, keeping `stored`
 * for those. Returns what to persist plus a report of what was refused.
 */
export function guardStatePayload(incoming, stored, permissions) {
    const held = new Set(permissions);
    const has = (perms) => perms.some((p) => held.has(p));
    const payload = { ...incoming };
    const rejected = [];
    for (const group of STATE_GROUPS) {
        const ignore = new Set(group.ignoreFields ?? []);
        const required = new Set();
        let refuse = false;
        for (const key of group.stateKeys) {
            /* A key the client didn't send at all isn't a deletion — the legacy save
               always sends every key, and treating "absent" as "wipe it" would turn
               any partial/older client into a data-loss event. */
            if (!(key in payload))
                continue;
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
                if (key in payload)
                    payload[key] = stored[key];
            }
            rejected.push({ key: group.key, label: group.label, required: [...required] });
        }
    }
    return { payload: payload, rejected };
}
//# sourceMappingURL=stateGuard.js.map