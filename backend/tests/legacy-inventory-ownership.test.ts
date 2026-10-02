import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';
const source = readFileSync(new URL('../../frontend/public/legacy.html', import.meta.url), 'utf8');
const start = source.indexOf('function inventoryWarehouseOf(b)');
const end = source.indexOf('/* ---- build customer sub-filter pills ---- */', start);
if (start < 0 || end < 0) throw new Error('Inventory boundaries changed');
function context(status = '') {
  const boxes = {
    A: { tag: 'A', status: 'warehouse', location: { wh: 'MAIN' } },
    B: { tag: 'B', status: 'out', outWh: 'MAIN', location: {} },
    C: { tag: 'C', status: 'lost', history: [{ dir: 'in', wh: 'MAIN' }] },
    D: { tag: 'D', status: 'damage', history: [{ dir: 'relocate', wh: 'MAIN' }] },
    E: { tag: 'E', status: 'hold', location: { wh: 'MAIN' } },
    F: { tag: 'F', status: 'out', outWh: 'OTHER', location: { wh: 'MAIN' } },
    G: { tag: 'G', status: 'pending', history: [] },
  };
  const c = vm.createContext({ S: { boxes }, document: { getElementById: () => null },
    invSearchTokens: [], invTagFilter: [], invWhFilter: 'MAIN', invDoFilter: '',
    invStatusFilter: status, invCustFilter: '', invDateFilterActive: false,
    now: () => new Date(), dstr: () => '2026-10-02',
    activeWarehouses: () => [{ id: 'MAIN' }, { id: 'OTHER' }],
  });
  vm.runInContext(source.slice(start, end), c);
  return c;
}
it('warehouse all-status filter includes stored, shipped, lost, damaged and held boxes', () => {
  const c = context();
  expect(c.filteredInvBoxes().map((b: {tag: string}) => b.tag)).toEqual(['A','B','C','D','E']);
});
it('warehouse ownership combines with selected status without guessing unassigned stock', () => {
  const c = context('out');
  expect(c.filteredInvBoxes().map((b: {tag: string}) => b.tag)).toEqual(['B']);
  expect(c.inventoryWarehouseOf({ status: 'pending' })).toBe('');
});
