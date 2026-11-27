import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL('../public/readiness.js', import.meta.url), 'utf8'), sandbox);
const { assess } = sandbox.window.Readiness;

const good = () => ({
  needsLpr: true, needsPda: true, unattended: true,
  readers: [{ gate: 1, online: true }], lprGates: [1], pda: [{ name: 'TC52', online: true }],
  boxes: { ready: 7, hold: 0, damage: 0, lost: 0, overdue: 0 },
  customers: 3, review: 0, plans: 2, preset: false,
});
const run = (change) => assess({ ...good(), ...change });
const texts = (r, level) => r.groups.flatMap((g) => g.items).filter((i) => i.level === level).map((i) => i.text);

describe('system readiness', () => {
  it('says ready only when everything is', () => {
    const r = run({});
    expect([r.level, r.problems]).toEqual(['ok', 0]);
    expect(r.groups.map((g) => g.id)).toEqual(['devices', 'boxes', 'shipping']);
  });

  it('never says ready while something is still unknown', () => {
    for (const change of [{ readers: null }, { pda: null }, { review: null }, { plans: null }, { preset: null, plans: 0 }]) {
      expect(run(change).level, JSON.stringify(change)).toBe('wait');
    }
  });

  it('names the missing or silent reader', () => {
    expect(texts(run({ readers: [] }), 'bad')).toEqual(['ยังไม่ผูก FX9600 กับประตูใดเลย']);
    const r = run({ readers: [{ gate: 1, online: true }, { gate: 4, online: false }], lprGates: [1, 4] });
    expect(r.level).toBe('bad');
    expect(texts(r, 'bad')).toEqual(['FX9600 ประตู 4 ไม่ตอบสนอง']);
  });

  it('warns about a camera that never reported, and only where cameras are used', () => {
    expect(texts(run({ lprGates: [] }), 'warn')).toEqual(['LPR ประตู 1 ยังไม่เคยส่งข้อมูล']);
    expect(run({ lprGates: [], needsLpr: false }).level).toBe('ok');
  });

  it('warns about handhelds only in the system that has them', () => {
    expect(texts(run({ pda: [] }), 'warn')).toEqual(['ยังไม่มีเครื่อง PDA เชื่อมต่อ']);
    expect(texts(run({ pda: [{ name: 'TC52', online: false }] }), 'warn')).toEqual(['PDA ออฟไลน์: TC52']);
    expect(run({ pda: null, needsPda: false }).level).toBe('ok');
  });

  it('counts the boxes that need attention', () => {
    const r = run({ boxes: { ready: 0, hold: 1, damage: 2, lost: 3, overdue: 4 }, review: 5 });
    expect(texts(r, 'bad')).toEqual(['ไม่มีกล่องพร้อมส่ง']);
    expect(texts(r, 'warn')).toEqual(['ต้องตรวจที่ประตู 5 ใบ', 'ค้างคืนเกินกำหนด 4 ใบ', 'สูญหาย 3 ใบ', 'พักใช้งาน/ชำรุด 3 ใบ']);
    expect(r.problems).toBe(5);
  });

  it('asks who an unattended gate ships to', () => {
    expect(texts(run({ plans: 0 }), 'warn')).toEqual(['ขาออกอัตโนมัติยังไม่รู้ว่าส่งให้ใคร']);
    expect(run({ plans: 0, preset: true }).level).toBe('ok');
    expect(run({ unattended: false, plans: null, preset: null, review: null }).level).toBe('ok');
    expect(texts(run({ customers: 0 }), 'bad')).toEqual(['ยังไม่มีลูกค้า']);
  });

  it('says so when a check itself failed', () => {
    expect(texts(run({ plans: 'error' }), 'warn')).toEqual(['ตรวจรายการส่งของไม่ได้']);
    expect(texts(run({ review: 'error' }), 'warn')).toEqual(['ตรวจรายการต้องตรวจไม่ได้']);
  });
});
