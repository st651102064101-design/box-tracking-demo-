import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../../frontend/public/legacy.html', import.meta.url), 'utf8');
function handler(start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error('Inventory handler boundaries changed');
  let callback: () => void = () => { throw new Error('Handler not registered'); };
  const button = { dataset: { st: 'damage' }, classList: { add() {}, remove() {} },
    addEventListener(_type: string, fn: () => void) { callback = fn; } };
  const c = vm.createContext({
    invWhFilter: 'WH-001', invDoFilter: 'DO', invCustFilter: 'C', invShowValue: true,
    document: { getElementById: () => button },
    $all: (selector: string) => selector.includes('invWhSearch') ? [] : [button],
    $: () => null, pagerReset() {}, saveInvFilters() {}, renderInventory() {}, buildInvCustPills() {},
  });
  vm.runInContext(source.slice(from, to), c);
  return { c, invoke: () => callback.call(button) };
}
it('changing inventory status preserves the selected warehouse', () => {
  const { c, invoke } = handler('/* ---- status segment filter ---- */', '/* Putaway button removed');
  invoke();
  expect(c.invStatusFilter).toBe('damage');
  expect(c.invWhFilter).toBe('WH-001');
});
it('typing inventory search preserves the selected warehouse', () => {
  const { c, invoke } = handler("document.getElementById('schInv').addEventListener('input'", '/* ---- view switcher ---- */');
  invoke();
  expect(c.invWhFilter).toBe('WH-001');
  expect(c.invDoFilter).toBe('');
});
