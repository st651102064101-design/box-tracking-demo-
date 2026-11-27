/* What a system lacks is hidden from the feature list, never by system name. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const sandbox = { window: {} };
for (const f of ['systems.js', 'gate-view.js']) vm.runInNewContext(read(f), sandbox);
const { Systems: S, GateView: G } = sandbox.window;
const html = read('legacy.html');
const reduced = ['rfidgate', 'gate1', 'gate2', 'gate3'];

describe('parts a system does not have', () => {
  it('offers the handheld in every system', () => {
    expect([...reduced, 'full'].filter((id) => !S.can(id, 'pda'))).toEqual([]);
  });

  it('has no stock import, direct shipping or shelf moves outside the full system', () => {
    for (const f of ['stockImport', 'stockShip', 'relocate']) {
      expect(reduced.filter((id) => S.can(id, f)), f).toEqual([]);
      expect(S.can('full', f)).toBe(true);
    }
  });

  it('keeps the plate report where there is a plate camera', () => {
    expect(['rfidgate', 'gate1', 'gate2', 'gate3', 'full'].map((id) => S.can(id, 'plateReport'))).toEqual([false, true, true, true, true]);
  });

  it('hides each of them on the page by feature', () => {
    for (const f of S.features) expect(html, f).toMatch(new RegExp(`html\\.no-${f}[ .#\\[]`));
    for (const gone of ['#bulkInvShip', '#bulkInvRelocate', '.sys-pda', '.sys-plates', 'invImportFile']) {
      expect(html).not.toMatch(new RegExp(`html\\[data-system="[a-z0-9]+"\\] [^,{]*${gone.replace('.', '\\.')}`));
    }
  });

  it('lists every feature any system lacks', () => {
    for (const id of reduced) for (const f of ['manualReceive', 'stockImport', 'stockShip', 'relocate', 'pda', 'plateReport']) {
      if (!S.can(id, f) && f !== 'manualReceive') expect(S.features).toContain(f);
    }
  });
});

describe('warehouse headings', () => {
  it('does not repeat the word warehouse', () => {
    expect(G.warehouseLabel('คลัง 3 — รังสิต')).toBe('คลัง 3 — รังสิต');
    expect(G.warehouseLabel('บางนา')).toBe('คลัง บางนา');
  });
});
