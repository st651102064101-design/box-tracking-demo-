import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const sandbox = { window: {} };
for (const f of ['systems.js', 'gate-view.js']) vm.runInNewContext(readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'), sandbox);
const { Systems: S, GateView: G } = sandbox.window;
const plain = (v) => JSON.parse(JSON.stringify(v));

describe('the three gate systems', () => {
  it('share one gate page, reports, stock and the needed settings', () => {
    for (const id of ['gate1', 'gate2', 'gate3']) {
      expect(['overview', 'gate', 'inventory', 'setup'].every((t) => S.allowsTab(id, t))).toBe(true);
      expect(S.allowsTab(id, 'track')).toBe(false);
      expect(S.home(id)).toBe('gate');
      expect(S.can(id, 'manualReceive')).toBe(false);
      expect(S.allowsSetting(id, 'security')).toBe(false);
    }
    expect([S.allowsTab('full', 'gate'), S.allowsTab('rfidgate', 'gate')]).toEqual([false, false]);
  });

  it('only the attended one confirms on the in and out screens, by RFID', () => {
    expect(S.allowsTab('gate2', 'gateout')).toBe(true);
    expect(S.allowsTab('gate1', 'gateout')).toBe(false);
    expect([S.mode('gate2', 'in', 'manual'), S.mode('gate2', 'out', 'excel')]).toEqual(['rfid', 'rfid']);
    expect([S.unattended('gate1'), S.unattended('gate2'), S.unattended('gate3'), S.unattended('full')]).toEqual([true, false, true, false]);
  });
});

describe('does a gate suit the system', () => {
  const gate = (type, mode = 'screen') => ({ type, mode });
  it('says nothing when it does', () => {
    expect(G.mismatch('gate1', gate('both', 'antenna'))).toBe('');
    expect(G.mismatch('gate2', gate('both', 'screen'))).toBe('');
    expect(G.mismatch('gate3', gate('in'))).toBe('');
    expect(G.mismatch('gate3', gate('out'))).toBe('');
  });
  it('explains what to change when it does not', () => {
    expect(G.mismatch('gate1', gate('both', 'screen'))).toContain('2 เสาอากาศ');
    expect(G.mismatch('gate1', gate('in'))).toContain('เข้า-ออกร่วมกัน');
    expect(G.mismatch('gate2', gate('out'))).toContain('หน้าจอ');
    expect(G.mismatch('gate3', gate('both'))).toContain('ทิศเดียว');
  });
});

describe('gate page data', () => {
  it('lists the latest passages through one gate, newest first', () => {
    const events = [
      { ts: '2026-11-26T01:00:00Z', dir: 'in', gate: 1, tag: 'A' },
      { ts: '2026-11-26T03:00:00Z', dir: 'out', gate: 1, tag: 'B' },
      { ts: '2026-11-26T02:00:00Z', dir: 'out', gate: 2, tag: 'C' },
      { ts: '2026-11-26T04:00:00Z', dir: 'cycle-count', gate: 1, tag: 'D' },
    ];
    expect(plain(G.passages(events, 1)).map((e) => e.tag)).toEqual(['B', 'A']);
  });

  it('reads the shipping list whatever the column order or language', () => {
    expect(plain(G.planRows([['ลูกค้า', 'ทะเบียนรถ', 'DO', 'วันที่'], ['C1', '70-1111', 'DO-1', ''], ['', '', '', '']])))
      .toEqual([{ plate: '70-1111', customer: 'C1', doNo: 'DO-1', po: '', date: '' }]);
    expect(plain(G.planRows([['Plate', 'Customer', 'PO'], ['80-2', 'two', 7]])))
      .toEqual([{ plate: '80-2', customer: 'two', doNo: '', po: '7', date: '' }]);
  });

  it('refuses a file without the two needed columns', () => {
    expect(G.planRows([['a', 'b'], [1, 2]])).toBeNull();
    expect(G.planRows([])).toBeNull();
  });
});
