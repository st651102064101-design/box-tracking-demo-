import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL('../public/systems.js', import.meta.url), 'utf8'), sandbox);
const S = sandbox.window.Systems;

describe('system 1: FX9600 in, Excel or hand scan out', () => {
  it('offers only the pages it needs', () => {
    const yes = ['overview', 'gatein', 'gateout', 'inventory', 'setup'].map((t) => S.allowsTab('rfidgate', t));
    expect([yes.every(Boolean), S.allowsTab('rfidgate', 'track')]).toEqual([true, false]);
    expect(S.label('rfidgate', 'overview')).toBe('รายงาน');
    expect(S.label('full', 'overview')).toBe('ภาพรวม');
    expect(['btype', 'box', 'wh', 'cust'].every((s) => S.allowsStab('rfidgate', s))).toBe(true);
    expect(['emp', 'role', 'audit', 'loc'].some((s) => S.allowsStab('rfidgate', s))).toBe(false);
    expect(S.home('rfidgate')).toBe('gatein');
  });

  it('offers no other way to receive or ship, and nothing about shelves', () => {
    for (const f of ['manualReceive', 'stockImport', 'stockShip', 'relocate']) {
      expect([S.can('rfidgate', f), S.can('full', f)]).toEqual([false, true]);
    }
  });

  it('receives by RFID only and ships by Excel or hand scan only', () => {
    expect(['manual', 'excel', 'rfid', null].map((m) => S.mode('rfidgate', 'in', m))).toEqual(['rfid', 'rfid', 'rfid', 'rfid']);
    expect(['manual', 'excel', 'rfid', null].map((m) => S.mode('rfidgate', 'out', m))).toEqual(['manual', 'excel', 'manual', 'manual']);
  });
});

describe('system 1 settings window', () => {
  it('keeps only backup and restore', () => {
    const rows = ['brand', 'workflow', 'devices', 'data', 'security', 'advanced'];
    expect(rows.filter((r) => S.allowsSetting('rfidgate', r))).toEqual(['data']);
    expect(rows.filter((r) => S.allowsSetting('full', r))).toEqual(rows);
  });
});

describe('the full system and unknown choices', () => {
  it('changes nothing', () => {
    for (const id of ['full', '', 'gone', null]) {
      expect(S.allowsTab(id, 'track')).toBe(true);
      expect(S.allowsStab(id, 'role')).toBe(true);
      expect(S.mode(id, 'in', 'excel')).toBe('excel');
    }
  });

  it('knows which choices are real', () => {
    expect([S.valid('rfidgate'), S.valid('full'), S.valid('gone'), S.valid(null)]).toEqual([true, true, false, false]);
  });
});
