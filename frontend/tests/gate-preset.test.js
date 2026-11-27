import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const sandbox = { window: {} };
for (const f of ['gate-view.js', 'readiness.js']) vm.runInNewContext(readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'), sandbox);
const { GateView: G, Readiness } = sandbox.window;
const now = Date.parse('2026-11-27T10:00:00Z');
const at = (s) => new Date(now + s * 1000).toISOString();
const session = (over = {}) => ({ preset: true, permanent: false, direction: 'out', customer: 'C1', ttlSeconds: 7200, startedAt: at(-3600), expiresAt: at(3600), ...over });
const view = (s, expired) => JSON.parse(JSON.stringify(G.presetView({ session: s, expired }, now)));

describe('the customer set at a gate', () => {
  it('counts down from when it was set', () => {
    expect(view(session())).toMatchObject({ state: 'active', remaining: '01:00:00', fraction: 0.5, customer: 'C1' });
  });

  it('warns in the last quarter hour', () => {
    expect(view(session({ expiresAt: at(899) }))).toMatchObject({ state: 'soon', remaining: '00:14:59' });
  });

  it('offers the last customer again once it has run out', () => {
    expect(view(session({ expiresAt: at(-1) }))).toMatchObject({ state: 'expired', customer: 'C1' });
    expect(view(null, session({ customer: 'C2' }))).toMatchObject({ state: 'expired', customer: 'C2' });
  });

  it('says how long a permanent one has been in use', () => {
    const permanent = (ago) => view(session({ permanent: true, startedAt: at(-ago), expiresAt: '9999-12-31T00:00:00Z' }));
    expect(permanent(3 * 86400)).toMatchObject({ state: 'permanent', used: 'ใช้มาแล้ว 3 วัน' });
    expect(permanent(7300).used).toBe('ใช้มาแล้ว 2 ชั่วโมง');
    expect(permanent(30).used).toBe('ใช้มาแล้ว 0 นาที');
  });

  it('shows the form when nothing was set by hand', () => {
    expect(view(null, null).state).toBe('none');
    expect(view(session({ preset: false })).state).toBe('none');
  });

  it('is flagged on the readiness panel while permanent, in both languages', () => {
    const r = Readiness.assess({ unattended: true, readers: [{ gate: 1, online: true }], needsLpr: false, needsPda: false, lprGates: [], pda: null,
      boxes: { ready: 1, hold: 0, damage: 0, lost: 0, overdue: 0 }, customers: 1, review: 0, plans: 0, preset: true, permanent: [1] });
    const text = 'ประตู 1 ใช้ลูกค้าแบบถาวร';
    expect(r.groups[2].items.map((i) => i.text)).toContain(text);
    expect(r.level).toBe('warn');
    expect(Readiness.en.reduce((t, [p, to]) => t.replace(p, to), text)).toBe('Gate 1 uses a permanent customer');
  });
});
