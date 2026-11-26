/**
 * Whether a box can stand in a rack slot. The racks are the fixed thing: a slot
 * holds two boxes side by side, and a box needs a little air above it to be
 * lifted in and out.
 */
import { DEFAULT_SLOT_CM } from '../services/warehouseGeometry.js';

export const SLOT_POSITIONS = 2;
export const LIFT_CLEARANCE_CM = 15;

export interface Size { width: number; height: number; depth: number }
export interface SlotSize { widthCm: number; heightCm: number; depthCm: number }

export const STANDARD_SLOT: SlotSize = {
  widthCm: DEFAULT_SLOT_CM.width, heightCm: DEFAULT_SLOT_CM.height, depthCm: DEFAULT_SLOT_CM.depth,
};

/** The largest single box this slot takes. */
export function maxBoxFor(slot: SlotSize): Size {
  return {
    width: Math.floor(slot.widthCm / SLOT_POSITIONS),
    depth: slot.depthCm,
    height: slot.heightCm - LIFT_CLEARANCE_CM,
  };
}

export function fitsSlot(box: Size, slot: SlotSize): boolean {
  const max = maxBoxFor(slot);
  return box.width <= max.width && box.depth <= max.depth && box.height <= max.height;
}

/** True when at least one slot takes it. With no slots defined, the standard one. */
export function fitsSomeSlot(box: Size, slots: SlotSize[]): boolean {
  return (slots.length ? slots : [STANDARD_SLOT]).some((slot) => fitsSlot(box, slot));
}

/** The roomiest slot's limit — what to tell someone whose box fits nowhere. */
export function largestLimit(slots: SlotSize[]): Size {
  const volume = (s: Size) => s.width * s.depth * s.height;
  return (slots.length ? slots : [STANDARD_SLOT]).map(maxBoxFor).reduce((a, b) => (volume(b) > volume(a) ? b : a));
}

/** Written the way the box type form is filled in: width × length × height. */
export const sizeText = (s: Size) => `${s.width} × ${s.depth} × ${s.height}`;

export const boxSize = (box: SlotSize): Size => ({ width: box.widthCm, height: box.heightCm, depth: box.depthCm });

export const tooBigMessage = (tag: string, box: Size, slot: SlotSize) =>
  `กล่อง ${tag} ขนาด ${sizeText(box)} ซม. ใส่ช่องนี้ไม่ได้ (สูงสุด ${sizeText(maxBoxFor(slot))} ซม.)`;
