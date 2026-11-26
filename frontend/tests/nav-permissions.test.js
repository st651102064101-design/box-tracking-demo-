/* Gate tabs are for accounts that can transact; the two permission tables in
   legacy.html (tab switch guard and menu visibility) must agree. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const html = readFileSync(new URL('../public/legacy.html', import.meta.url), 'utf8');
const table = (name) => vm.runInNewContext('(' + new RegExp(`var ${name}=(\\{[^}]*\\});`).exec(html)[1] + ')');

describe('gate tab permissions', () => {
  it('tab guard passes arrays and asks only for the gate permission', () => {
    const t = table('tabPerms');
    expect(Object.values(t).every(Array.isArray)).toBe(true);
    expect([t.gateout, t.gatein]).toEqual([['gate.out'], ['gate.in']]);
  });
  it('menu visibility uses the same gate permissions', () => {
    const t = table('navRules');
    expect([t.gateout, t.gatein]).toEqual(['gate.out', 'gate.in']);
  });
});

describe('setup tab', () => {
  it('is hidden from accounts the tab guard would turn away', () => {
    expect(html).not.toContain("allowed=tab==='setup'||");
    expect(table('navRules').setup).toBe('setting.view');
  });
});
