/* The master-data importer lives inside public/legacy.html, so the test lifts
   that one self-contained block out of the page and runs it against stubs. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const html = readFileSync(new URL('../public/legacy.html', import.meta.url), 'utf8');
const start = html.indexOf('(function(){', html.indexOf('MASTER DATA BULK IMPORT (.xlsx'));
const end = html.indexOf('OUTBOUND BULK IMPORT (.xlsx');
const source = html.slice(start, html.lastIndexOf('})();', end) + 5);
const fmtTs = (s) => (s ? 'fmt ' + s : '-');

function setup() {
  const S = {
    cfg: { boxValue: 100 },
    boxtypes: { 'BT-01': { id: 'BT-01', name: 'ลัง', unit: 'ใบ', value: 450, dim: '60x40', extra: 'keep' } },
    warehouses: {
      'WH-1': { id: 'WH-1', name: 'คลัง 1', gates: [1, 2], gateType: 'both', gateTypes: { 1: 'in', 2: 'out' }, gateBidirectionalModes: {}, status: 'active', area: 'บางปู' },
    },
    customers: {
      'CUST-01': { id: 'CUST-01', name: 'เอเชีย', kind: 'supplier', status: 'blocked', addr: 'กรุงเทพ', contact: 'คุณเอ 02-111', taxId: '0105', contactPerson: 'เอ', returnDays: 15, returnDate: '01/12/2026', creditLimit: 5 },
    },
    employees: {
      'EMP-001': { id: 'EMP-001', name: 'สมชาย', status: 'leave', access: 'admin', phone: '081-234-5678', pinHash: 'keep', scanCode: 'EMP-001', wh: 'WH-1' },
    },
    boxes: {
      'BOX-1': { tag: 'BOX-1', type: 'BT-01', value: 450, status: 'out', cycles: 3, customer: 'CUST-01', location: { wh: 'WH-1', zone: 'A', rack: 'R1' }, regAt: '2026-01-01', regBy: 'x', rfidEpc: 'E1', lastSeenAt: '2026-02-03T04:05:00Z', history: [{ dir: 'reg' }] },
    },
  };
  const window = {};
  const sandbox = {
    window, S, USER: 'tester', KEY: 'k',
    document: { getElementById: () => null },
    nextSeqId: (p, ids) => p + String(ids.length + 1).padStart(3, '0'),
    nextBoxTagNumber: () => 2, formatBoxTag: (n) => 'BOX-' + n,
    resolveTag: (v) => v.replace(/\*/g, ''),
    iso: () => '2026-11-25T00:00:00Z', fmtTs,
    ddmmyyyy: () => '25/11/2026', parseFlexDateToDmy: (v) => v,
    normPhoneDigits: (v) => String(v).replace(/[\s()-]/g, ''),
    isValidThaiPhone: (v) => /^0\d{8,9}$/.test(String(v).replace(/[\s()-]/g, '')),
    isValidEmail: (v) => /@/.test(v),
    openImportSummaryModal() {},
    locBuildCode: (...p) => p.filter(Boolean).join('-').toUpperCase(),
    activeWarehouses: () => Object.values(S.warehouses),
    rebuildGates() {}, auditEntry() {}, save() {}, renderAll() {}, toast() {}, openModal() {}, closeModal() {},
    CUST_KIND: { customer: { t: 'ลูกค้า' }, supplier: { t: 'ซัพพลายเออร์' }, both: { t: 'ลูกค้า + ซัพพลายเออร์' } },
    CUST_STATUS: { active: { t: 'ใช้งาน' }, inactive: { t: 'ปิดใช้งานชั่วคราว' }, blocked: { t: 'ระงับการใช้งาน' } },
  };
  vm.runInNewContext(source, sandbox);

  /* Same auto-mapping the column-mapping modal does, then validate + commit. */
  function run(key, head, ...data) {
    const cfg = window.IMPORT_CONFIGS[key];
    const lower = head.map((h) => h.trim().toLowerCase());
    const colMap = {};
    for (const f of cfg.fields) colMap[f.key] = lower.findIndex((h) => f.aliases.includes(h));
    const results = window.importParseAndValidate([head, ...data], colMap, cfg);
    window.commitImportRows(results.filter((r) => !r.errors.length), cfg, 't.xlsx', 0);
    return results;
  }
  const snapshot = () => JSON.parse(JSON.stringify(S));
  return { S, run, snapshot };
}

// Header rows exactly as the app's own export writes them.
const BT = ['รหัสประเภท', 'ชื่อประเภท', 'หน่วยนับ', 'มูลค่าต่อใบ', 'ขนาด (ซม.)', 'กล่องที่ใช้ประเภทนี้'];
const WH = ['รหัสคลัง', 'ชื่อคลัง', 'ประตูเริ่ม', 'ประตูสิ้นสุด', 'ประเภทประตู', 'ทิศทางแต่ละประตู (JSON)', 'โหมดประตูร่วม (JSON)', 'เปิด RFID/LPR', 'พื้นที่', 'ละติจูด', 'ลองจิจูด', 'สถานะ', 'จำนวนประตู', 'กล่องที่เก็บอยู่'];
const CUST = ['รหัสลูกค้า', 'ชื่อลูกค้า / บริษัท', 'ประเภท', 'สถานะ', 'ยืมได้กี่วัน', 'กำหนดคืนภายใน (วันที่)', 'ที่อยู่/สาขา', 'เบอร์โทรศัพท์', 'อีเมล', 'เลขผู้เสียภาษี', 'ผู้ติดต่อหลัก', 'วงเงินเครดิต', 'ค่าปรับ/วัน', 'ค่าปรับกล่องหาย', 'กล่องที่ถืออยู่'];
const EMP = ['รหัสพนักงาน', 'ชื่อ-นามสกุล', 'ตำแหน่ง', 'แผนก', 'รหัสคลังที่สังกัด', 'เบอร์โทรศัพท์', 'อีเมล', 'วันเริ่มงาน', 'รหัสบัตรพนักงาน', 'สิทธิ์', 'สถานะ'];
const BOX = ['บาร์โค้ด', 'รหัสประเภทกล่อง', 'มูลค่ากล่อง', 'สถานะกล่อง', 'รหัสคลัง', 'รหัสลูกค้า', 'DO', 'PO', 'ล็อต/ชุด', 'วันหมดอายุ', 'รหัสซัพพลายเออร์', 'รอบหมุนเวียน', 'อัปเดตล่าสุด'];

const btRow = ['BT-01', 'ลัง', 'ใบ', '450', '60x40', '1'];
const whRow = ['WH-1', 'คลัง 1', '1', '2', 'both', '{"1":"in","2":"out"}', '{}', 'ใช่', 'บางปู', '', '', 'ใช้งาน', '2', '0'];
const custRow = ['CUST-01', 'เอเชีย', 'ซัพพลายเออร์', 'ระงับการใช้งาน', '15', '01/12/2026', 'กรุงเทพ', 'คุณเอ 02-111', '', '0105', 'เอ', '5', '0', '0', '1'];
const empRow = ['EMP-001', 'สมชาย', '', '', 'WH-1', '081-234-5678', '', '', 'EMP-001', 'admin', 'ลา/พักงาน'];
const boxRow = ['*BOX-1*', 'BT-01', '450', 'ออกไปแล้ว', 'WH-1', 'CUST-01', '', '', '', '', '', '3', fmtTs('2026-02-03T04:05:00Z')];

describe('re-importing an unchanged export', () => {
  for (const [key, head, row] of [['btype', BT, btRow], ['wh', WH, whRow], ['cust', CUST, custRow], ['emp', EMP, empRow], ['box', BOX, boxRow]]) {
    it(`${key}: updates in place and changes nothing`, () => {
      const { run, snapshot } = setup();
      const before = snapshot();
      const [result] = run(key, head, row);
      expect(result.errors).toEqual([]);
      expect(result.dup).toBe(true);
      expect(snapshot()).toEqual(before);
    });
  }
});

describe('values already stored but outside the import enum', () => {
  it('round-trips an employee whose access is "staff"', () => {
    const { S, run } = setup();
    S.employees['EMP-001'].access = 'staff';
    const [result] = run('emp', EMP, empRow.map((v) => (v === 'admin' ? 'staff' : v)));
    expect(result.errors).toEqual([]);
    expect(S.employees['EMP-001'].access).toBe('staff');
  });
});

describe('editing an export', () => {
  const edit = (head, row, changes) => row.map((v, i) => (head[i] in changes ? changes[head[i]] : v));

  it('writes only the edited customer cell', () => {
    const { S, run, snapshot } = setup();
    const before = snapshot().customers['CUST-01'];
    run('cust', CUST, edit(CUST, custRow, { 'ชื่อลูกค้า / บริษัท': 'เอเชียใหม่' }));
    expect(S.customers['CUST-01']).toEqual({ ...before, name: 'เอเชียใหม่' });
  });

  it('stores enum codes for Thai labels', () => {
    const { S, run } = setup();
    run('cust', CUST, edit(CUST, custRow, { 'ประเภท': 'ลูกค้า', 'สถานะ': 'ใช้งาน' }), ['', 'รายใหม่', 'ซัพพลายเออร์', 'ใช้งาน']);
    expect(S.customers['CUST-01']).toMatchObject({ kind: 'customer', status: 'active' });
    expect(Object.values(S.customers)[1]).toMatchObject({ name: 'รายใหม่', kind: 'supplier', status: 'active' });
  });

  it('keeps stored values when a column is missing or a cell is blank', () => {
    const { S, run } = setup();
    run('cust', ['รหัสลูกค้า', 'ชื่อลูกค้า / บริษัท', 'ที่อยู่/สาขา'], ['cust-01', 'เอเชีย', '']);
    expect(Object.keys(S.customers)).toEqual(['CUST-01']);
    expect(S.customers['CUST-01']).toMatchObject({ addr: 'กรุงเทพ', kind: 'supplier', returnDays: 15 });
  });

  it('moves a box to another warehouse without dragging the old shelf along', () => {
    const { S, run } = setup();
    S.warehouses['WH-2'] = { id: 'WH-2', name: 'คลัง 2', gates: [3] };
    run('box', BOX, edit(BOX, boxRow, { 'รหัสคลัง': 'WH-2' }));
    expect(S.boxes['BOX-1'].location).toMatchObject({ wh: 'WH-2', zone: '', rack: '' });
    expect(S.boxes['BOX-1']).toMatchObject({ rfidEpc: 'E1', regAt: '2026-01-01', status: 'out' });
  });
});

describe('rows that would corrupt master data are refused', () => {
  it('a new box type or warehouse reusing an existing name', () => {
    const { S, run } = setup();
    expect(run('btype', BT, ['', 'ลัง', 'ใบ'])[0].errors.join()).toContain('BT-01');
    expect(run('wh', WH, ['', 'คลัง 1', '8', '9'])[0].errors.join()).toContain('WH-1');
    expect(Object.keys(S.boxtypes)).toHaveLength(1);
    expect(Object.keys(S.warehouses)).toHaveLength(1);
  });

  it('gates already owned by another warehouse, including within one file', () => {
    const { S, run } = setup();
    const results = run('wh', WH, ['', 'ทับ', '2', '3'], ['', 'ใหม่', '5', '6'], ['', 'ทับในไฟล์', '6', '7']);
    expect(results.map((r) => r.errors.length > 0)).toEqual([true, false, true]);
    expect(Object.keys(S.warehouses)).toHaveLength(2);
  });
});

describe('rack locations', () => {
  const LOC = ['รหัสตำแหน่ง', 'รหัสคลัง', 'ชื่อคลัง', 'โซน', 'แร็ค', 'ชั้น', 'ช่อง', 'ประเภทแร็ค', 'หมายเหตุ', 'มีของ/ว่าง'];

  it('imports new positions, updates in place, and refuses an unknown warehouse', () => {
    const { S, run } = setup();
    S.locations = { 'A-R1-1-01': { code: 'A-R1-1-01', wh: 'WH-1', zone: 'A', rack: 'R1', shelf: '1', slot: '01', type: '', note: 'เดิม', reportedFullAt: 'x' } };
    const results = run('loc', LOC,
      ['A-R1-1-01', 'WH-1', 'คลัง 1', 'A', 'R1', '1', '01', 'พาเลท', ''],
      ['', 'คลัง 1', '', 'B', 'R2', '2', '03'],
      ['', 'WH-9', '', 'C']);
    expect(results.map((r) => r.errors.length > 0)).toEqual([false, false, true]);
    expect(S.locations['A-R1-1-01']).toMatchObject({ type: 'พาเลท', note: 'เดิม', reportedFullAt: 'x' });
    expect(S.locations['B-R2-2-03']).toMatchObject({ wh: 'WH-1', zone: 'B' });
    expect(Object.keys(S.locations)).toHaveLength(2);
  });
});
