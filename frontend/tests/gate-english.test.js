/* The gate page must read fully in English; names stored in the data stay. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const sandbox = { window: {} };
for (const f of ['systems.js', 'gate-view.js']) vm.runInNewContext(read(f), sandbox);
const { Systems, GateView } = sandbox.window;
const patterns = [...(GateView.en || []), ...Systems.en];
const translate = (text) => {
  const hit = patterns.find(([p]) => p.test(text.trim()));
  return hit ? text.trim().replace(hit[0], hit[1]) : text;
};
const THAI = /[฀-๿]/;
const html = read('legacy.html');
const section = html.slice(html.indexOf('<section class="tab" id="tab-gate">'), html.indexOf('<section class="tab" id="tab-gatein">'));
const fixed = section.split(/<[^>]*>/).map((t) => t.trim()).filter((t) => THAI.test(t));

const shown = [
  'ยังไม่มีประตูในระบบ', 'เพิ่มประตู', 'ประตู 4 ยังตั้งค่าไม่ตรงกับระบบนี้', 'แก้การตั้งค่า ›',
  'ขาเข้าอย่างเดียว', 'ขาออกอย่างเดียว', 'เข้า-ออก · เสาอากาศบอกทิศ', 'เข้า-ออก · เจ้าหน้าที่เลือก', 'ทิศทาง',
  'ทำงานเองโดยไม่ต้องมีคนเฝ้า', 'เจ้าหน้าที่กดเลือกทิศก่อนรถผ่าน', 'เครื่องอ่าน FX9600', '● พร้อมใช้งาน', '● ไม่ตอบสนอง',
  '● ยังไม่ผูก', 'ตรวจเครื่อง ›', 'ผูกเครื่อง ›', 'กล้องป้ายทะเบียน (LPR)', 'อ่านล่าสุด 2026-11-27 10:00',
  'ยังไม่เคยอ่านป้ายคู่กับกล่องที่ประตูนี้', '⬇ ขาเข้า', '⬆ ขาออก', 'ออก', 'เข้า', 'ยังไม่มีกล่องผ่านประตูนี้', '— เลือกลูกค้า —',
  'ต้องตรวจ', 'ต้องตรวจ · 3 ใบ',
  'เครื่องอ่านเจอกล่อง แต่ระบบไม่บันทึกเอง เพราะไม่รู้ทิศทางหรือลูกค้า หรือรออ่านป้ายรถ (รายการหายเองใน 10 นาที)',
  'ไม่มีรายการค้าง', 'นำออก', 'ส่งแล้ว 2 ใบ', 'รอรถ', 'เลยวันแล้ว', 'รอถึงวัน', 'ลบ', 'ยังไม่มีรายการรอรถ',
  'ยังไม่ได้ตั้งลูกค้าไว้', 'นำเข้าแล้ว 1 รายการ', 'ข้าม 2 แถว', 'แถว 3: ไม่พบลูกค้า "x"', 'แถว 2: ไม่มีทะเบียนรถ',
  'แถว 4: วันที่ไม่ถูกต้อง "31/02/2026"', 'ไฟล์ต้องมีหัวคอลัมน์ “ทะเบียนรถ” และ “ลูกค้า”', 'ไฟล์ไม่มีรายการ',
  'อ่านไฟล์ไม่ได้', 'เลือกลูกค้าก่อน', 'ตั้งลูกค้าของประตูแล้ว', 'ทำรายการไม่สำเร็จ',
];

describe('gate page in English', () => {
  it('translates the fixed texts of the page', () => {
    expect(fixed.length).toBeGreaterThan(5);
    for (const text of fixed) expect(translate(text), text).not.toMatch(THAI);
  });

  it('translates everything the page writes', () => {
    const warnings = [
      GateView.mismatch('gate1', { type: 'in' }), GateView.mismatch('gate2', { type: 'in' }), GateView.mismatch('gate3', { type: 'both' }),
    ];
    for (const text of [...shown, ...warnings]) expect(translate(text), text).not.toMatch(THAI);
  });

  it('keeps names from the data', () => {
    expect(translate('ตอนนี้ตั้งไว้: Acme (ถึง 2026-11-27 18:00)')).toBe('Set now: Acme (until 2026-11-27 18:00)');
    expect(translate('แถว 3: ไม่พบลูกค้า "x"')).toBe('Row 3: customer not found "x"');
  });
});
