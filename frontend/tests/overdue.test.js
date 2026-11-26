import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const sandbox = { window: {} };
vm.runInNewContext(readFileSync(new URL('../public/overdue.js', import.meta.url), 'utf8') , Object.assign(sandbox, { Date }));
const { dmy, day, after, extend } = sandbox.window.Overdue;
const now = new Date(2026, 10, 26, 10, 0);
const box = () => ({ status: 'out', do: 'DO-2', customer: 'C1', dueAt: new Date(2026, 10, 19, 23, 59).toISOString(), history: [] });

describe('overdue box', () => {
  it('shows the due date even when only the timestamp is stored', () => {
    expect(dmy(box())).toBe('19/11/2026');
    expect(dmy({ dueDate: '01/12/2026', dueAt: box().dueAt })).toBe('01/12/2026');
    expect(dmy({})).toBe('-');
  });

  it('counts an extension from today when the box is already overdue, else from the due date', () => {
    expect(day(after(box(), 7, now))).toBe('2026-12-03');
    const later = { ...box(), dueAt: new Date(2026, 11, 10, 23, 59).toISOString() };
    expect(day(after(later, 15, now))).toBe('2026-12-25');
  });

  it('moves the due date to the end of the chosen day and records it', () => {
    const b = box();
    expect(extend(b, '2026-12-03', now)).toBe(true);
    expect(b.dueAt).toBe(new Date(2026, 11, 3, 23, 59, 59, 999).toISOString());
    expect(b.dueDate).toBe('03/12/2026');
    expect(b.history).toEqual([{ dir: 'due', ts: now.toISOString(), do: 'DO-2', customer: 'C1', dueAt: b.dueAt, note: 'เลื่อนกำหนดคืน 19/11/2026 → 03/12/2026' }]);
  });

  it('refuses a past or unreadable date, and a box that is not out', () => {
    for (const text of ['2026-11-25', '', 'abc', '2026-02-31']) {
      const b = box();
      expect(extend(b, text, now)).toBe(false);
      expect(b).toEqual(box());
    }
    expect(extend({ ...box(), status: 'warehouse' }, '2026-12-03', now)).toBe(false);
  });
});
