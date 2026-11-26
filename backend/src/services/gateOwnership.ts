/**
 * The web app ships boxes by uploading the whole state, so it never passes
 * through gateOut()'s "this box belongs to another warehouse" refusal. This is
 * the same rule applied to that upload: a box going from the shelf to "out"
 * must leave through a gate of the warehouse it is in.
 */
import type { StatePayload } from '../validators/schemas.js';
import type { RejectedGroup } from './stateGuard.js';

type Dict = Record<string, unknown>;

/** `location.wh`, else the last warehouse it was received into. Read from the
 *  uploaded box, so a receive and a ship saved together still agree. Unknown
 *  (empty) never blocks — same as gateOut(). */
function warehouseOfBox(box: Dict): string {
  const located = (box.location as Dict | null | undefined)?.wh;
  if (typeof located === 'string' && located) return located;
  const history = Array.isArray(box.history) ? (box.history as Dict[]) : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const { dir, wh } = history[i];
    if ((dir === 'in' || dir === 'in-new') && typeof wh === 'string' && wh) return wh;
  }
  return '';
}

export function refuseCrossWarehouseShipments(
  payload: StatePayload,
  stored: Dict,
): { payload: StatePayload; rejected: RejectedGroup[] } {
  const boxes = { ...(payload.boxes as Record<string, Dict>) };
  const storedBoxes = (stored.boxes ?? {}) as Record<string, Dict>;
  const gates = payload.gates as Record<string, unknown>;
  const refused: string[] = [];

  for (const [tag, box] of Object.entries(boxes)) {
    const before = storedBoxes[tag];
    if (!before || before.status !== 'warehouse' || box.status !== 'out' || !box.outGate) continue;
    const gateWh = gates[String(box.outGate)];
    const boxWh = warehouseOfBox(box);
    if (!gateWh || !boxWh || gateWh === boxWh) continue;
    boxes[tag] = before;
    refused.push(tag);
  }
  if (!refused.length) return { payload, rejected: [] };

  // The movement never happened, so its new "out" events must not be recorded.
  const eventKey = (e: Dict) => `${e.dir}|${e.tag}|${e.ts}`;
  const known = new Set(((stored.events ?? []) as Dict[]).map(eventKey));
  const events = (payload.events as Dict[]).filter(
    (e) => !(e?.dir === 'out' && refused.includes(String(e.tag)) && !known.has(eventKey(e))),
  );

  return {
    payload: { ...payload, boxes, events },
    rejected: [{
      key: 'gateOwnership',
      label: 'ส่งออกข้ามคลัง',
      required: [],
      message: `กล่องไม่ได้อยู่ในคลังของประตูที่เลือก: ${refused.join(', ')}`,
    }],
  };
}
