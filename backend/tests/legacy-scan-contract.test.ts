import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { expect, it } from 'vitest';

// Execute the actual legacy resolver in an isolated context, not a rewritten
// implementation. These adjacent function boundaries are part of the fixture.
const source = readFileSync(new URL('../../frontend/public/legacy.html', import.meta.url), 'utf8');
const start = source.indexOf('function tagForRfidCode(code){');
const end = source.indexOf('/* auto-submits a scan input', start);
if (start < 0 || end < 0) throw new Error('Legacy scan resolver boundaries changed');
function resolver(boxes: Record<string, unknown>) {
  const context = vm.createContext({ S: { boxes }, dethaify: (s: string) => s });
  vm.runInContext(source.slice(start, end), context);
  return context;
}
it('legacy live resolver finds current RFID plus legacy EPC/TID case-insensitively', () => {
  const c = resolver({ A: { rfid: 'E200ABCD' }, B: { rfidTid: 'TID' }, C: { rfidEpc: 'EPC' } });
  expect(c.resolveTag('e200abcd')).toBe('A');
  expect(c.resolveTag('tid')).toBe('B');
  expect(c.resolveTag('epc')).toBe('C');
});
it('legacy barcode wins over colliding RFID and strips Code39 delimiters', () => {
  const c = resolver({ A: { rfid: 'BOX-B' }, 'BOX-B': {} });
  expect(c.resolveTag(' *BOX-B* ')).toBe('BOX-B');
  expect(c.resolveTag('')).toBe('');
  expect(c.resolveTag('NOPE')).toBe('NOPE');
});
