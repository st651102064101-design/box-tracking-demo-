/**
 * The web app moves boxes by uploading the whole state, so it never passes
 * through gateOut()/gateIn(). The same rules are applied to that upload here.
 */
import type { StatePayload } from '../validators/schemas.js';
import { gateTypeOf } from '../lib/gateType.js';
import type { RejectedGroup } from './stateGuard.js';

type Dict = Record<string, unknown>;

const historyOf = (box: Dict): Dict[] => (Array.isArray(box.history) ? (box.history as Dict[]) : []);
const entryKey = (h: Dict) => `${h.dir}|${h.ts}`;
const eventKey = (e: Dict) => `${e.dir}|${e.tag}|${e.ts}`;
const isInbound = (dir: unknown) => dir === 'in' || dir === 'in-new';

/** Entries in `box` that `before` does not have. */
function newEntries(box: Dict, before: Dict): Dict[] {
  const known = new Set(historyOf(before).map(entryKey));
  return historyOf(box).filter((h) => !known.has(entryKey(h)));
}

/**
 * A page that loaded before a handheld, reader or colleague changed something
 * still holds the old picture. Saving it must not undo that work: any box whose
 * stored history has entries the upload has never seen keeps its stored version,
 * and a box created after the page loaded (not in `baseTags`) is not a deletion.
 */
export function keepNewerMovements(
  payload: StatePayload,
  stored: Dict,
): { payload: StatePayload; rejected: RejectedGroup[] } {
  if (payload.restore) return { payload, rejected: [] };
  const boxes = { ...(payload.boxes as Record<string, Dict>) };
  const storedBoxes = (stored.boxes ?? {}) as Record<string, Dict>;
  const base = payload.baseTags ? new Set(payload.baseTags) : null;
  const stale: string[] = [];
  const kept = new Set<string>();

  for (const [tag, before] of Object.entries(storedBoxes)) {
    const box = boxes[tag];
    if (!box) {
      if (base && !base.has(tag)) {
        boxes[tag] = before;
        kept.add(tag);
      }
      continue;
    }
    /* LPR evidence is merged separately (see mergeLprHistory). */
    const seen = new Set(historyOf(box).map(entryKey));
    if (historyOf(before).some((h) => h.dir !== 'lpr' && !seen.has(entryKey(h)))) {
      boxes[tag] = before;
      stale.push(tag);
      kept.add(tag);
    }
  }

  /* The movement log is replaced wholesale, so give back what the page lacks. */
  const incoming = payload.events as Dict[];
  const have = new Set(incoming.map(eventKey));
  const missing = ((stored.events ?? []) as Dict[]).filter(
    (e) => !have.has(eventKey(e)) && (kept.has(String(e.tag)) || e.dir === 'cycle-count'),
  );
  const events = [...incoming.filter((e) => !stale.includes(String(e?.tag)) ||
    ((stored.events ?? []) as Dict[]).some((s) => eventKey(s) === eventKey(e))), ...missing];

  const doRecords = { ...(payload.doRecords as Dict) };
  const storedDos = (stored.doRecords ?? {}) as Dict;
  for (const tag of kept) {
    for (const h of historyOf(boxes[tag])) {
      const id = String(h.do ?? '');
      if (id && storedDos[id] && !doRecords[id]) doRecords[id] = storedDos[id];
    }
  }

  return {
    payload: { ...payload, boxes, events, doRecords },
    rejected: stale.length
      ? [{
        key: 'staleBoxes',
        label: 'ข้อมูลกล่องเก่า',
        required: [],
        message: `กล่องถูกเปลี่ยนจากเครื่องอื่นไปแล้ว จึงไม่บันทึกทับ: ${stale.join(', ')}`,
      }]
      : [],
  };
}

/** `location.wh`, else the last warehouse it was received into. Read from the
 *  uploaded box, so a receive and a ship saved together still agree. Unknown
 *  (empty) never blocks — same as gateOut(). */
function warehouseOfBox(box: Dict): string {
  const located = (box.location as Dict | null | undefined)?.wh;
  if (typeof located === 'string' && located) return located;
  const history = historyOf(box);
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const { dir, wh } = history[i];
    if (isInbound(dir) && typeof wh === 'string' && wh) return wh;
  }
  return '';
}

const REFUSALS = {
  gateOwnership: ['ส่งออกข้ามคลัง', 'กล่องไม่ได้อยู่ในคลังของประตูที่เลือก'],
  gateDirection: ['ผิดทิศประตู', 'ประตูที่เลือกใช้กับทิศทางนี้ไม่ได้'],
  flaggedBox: ['กล่องพัก/ชำรุด', 'กล่องถูกพักหรือชำรุดอยู่ ต้องปลดสถานะก่อน'],
  doNumber: ['เลขที่ DO ซ้ำ', 'เลขที่ DO นี้เป็นของลูกค้ารายอื่น'],
  deletedCustomer: ['ลูกค้าถูกลบแล้ว', 'ส่งให้ลูกค้าที่ถูกลบแล้วไม่ได้'],
} as const;
type Refusal = keyof typeof REFUSALS;

export function refuseInvalidMovements(
  payload: StatePayload,
  stored: Dict,
  deletedCustomers: Set<string> = new Set(),
): { payload: StatePayload; rejected: RejectedGroup[] } {
  if (payload.restore) return { payload, rejected: [] };
  const boxes = { ...(payload.boxes as Record<string, Dict>) };
  const storedBoxes = (stored.boxes ?? {}) as Record<string, Dict>;
  const storedDos = (stored.doRecords ?? {}) as Record<string, Dict>;
  const gates = payload.gates as Record<string, unknown>;
  const warehouses = payload.warehouses as Record<string, Dict>;
  const refused = new Map<Refusal, string[]>();
  const wrongWay = (gate: unknown, way: 'in' | 'out') => {
    const type = gateTypeOf(warehouses[String(gates[String(gate)] ?? '')], String(gate));
    return type !== 'both' && type !== way;
  };

  function why(box: Dict, before: Dict): Refusal | null {
    const added = newEntries(box, before);
    if (['hold', 'damage'].includes(String(before.status)) && added.some((h) => isInbound(h.dir))) return 'flaggedBox';
    const received = added.find((h) => isInbound(h.dir) && h.gate);
    if (before.status !== 'warehouse' && received && wrongWay(received.gate, 'in')) return 'gateDirection';
    if (before.status !== 'warehouse' || box.status !== 'out') return null;
    if (deletedCustomers.has(String(box.customer))) return 'deletedCustomer';
    const owner = storedDos[String(box.do ?? '')]?.customer;
    if (owner && box.customer && owner !== box.customer) return 'doNumber';
    if (!box.outGate) return null;
    if (wrongWay(box.outGate, 'out')) return 'gateDirection';
    const gateWh = gates[String(box.outGate)];
    const boxWh = warehouseOfBox(box);
    return gateWh && boxWh && gateWh !== boxWh ? 'gateOwnership' : null;
  }

  const dropped = new Set<string>();
  const doRecords = { ...(payload.doRecords as Dict) };
  for (const [tag, box] of Object.entries(boxes)) {
    const before = storedBoxes[tag];
    if (!before) continue;
    const reason = why(box, before);
    if (!reason) continue;
    boxes[tag] = before;
    dropped.add(tag);
    refused.set(reason, [...(refused.get(reason) ?? []), tag]);
    const id = String(box.do ?? '');
    if (reason === 'doNumber' && storedDos[id]) doRecords[id] = storedDos[id];
  }
  if (!dropped.size) return { payload, rejected: [] };

  // The movement never happened, so its new events must not be recorded.
  const known = new Set(((stored.events ?? []) as Dict[]).map(eventKey));
  const events = (payload.events as Dict[]).filter((e) => !(dropped.has(String(e?.tag)) && !known.has(eventKey(e))));

  return {
    payload: { ...payload, boxes, events, doRecords },
    rejected: Array.from(refused, ([key, tags]) => ({
      key,
      label: REFUSALS[key][0],
      required: [],
      message: `${REFUSALS[key][1]}: ${tags.join(', ')}`,
    })),
  };
}
