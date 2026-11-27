/* The gate page refreshes every 5 seconds; with nothing new it must not redraw. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const html = read('legacy.html');
const lift = (name) => {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no ${name}`);
  const end = html.indexOf('\n', start);
  const line = html.slice(start, end);
  return line.trimEnd().endsWith('}') ? line : html.slice(start, html.indexOf('\n}', start) + 2);
};

function page() {
  const writes = {};
  const elements = {};
  const element = (id) => elements[id] || (elements[id] = {
    classList: { contains: () => true }, hidden: false, content: '',
    set innerHTML(v) { this.content = v; writes[id] = (writes[id] || 0) + 1; },
    get innerHTML() { return this.content; },
    set textContent(v) { if (v !== this.content) writes[id] = (writes[id] || 0) + 1; this.content = v; },
    get textContent() { return this.content; },
  });
  let loads = 0;
  const ctx = {
    window: {}, $: element, S: { boxes: {}, events: [], customers: {}, gates: { 1: 'W' } },
    gpTimer: 1, gpShownFor: '', gpPre: { gate: 0 },
    currentSystem: () => 'gate1', gpGateNo: () => 1, gpRenderPreset() {}, gpLoad() { loads += 1; },
    allGateNums: () => [1], gateWh: () => 'W', whName: () => 'wh', gpInfo: () => ({ type: 'both', mode: 'antenna' }),
    rfidGateIsBound: () => false, fx9600IsOnline: () => false, fx9600SeenText: () => '',
    esc: (v) => String(v), fmtTs: String, custName: String, typeName: String,
  };
  vm.createContext(ctx);
  vm.runInContext(read('systems.js'), ctx);
  vm.runInContext(read('gate-view.js'), ctx);
  vm.runInContext([lift('gpHtml'), lift('gpReadyHtml'), lift('renderGatePage')].join('\n'), ctx);
  return { ctx, writes, loads: () => loads };
}

describe('gate page refresh', () => {
  it('draws once and leaves an unchanged page alone', () => {
    const p = page();
    p.ctx.renderGatePage();
    const first = { ...p.writes };
    p.ctx.renderGatePage();
    p.ctx.renderGatePage();
    expect(p.writes).toEqual(first);
    expect(p.loads()).toBe(1);
  });

  it('refetched panels are only rewritten when their content changes', () => {
    const p = page();
    const target = p.ctx.$('#gpPlans');
    p.ctx.gpHtml(target, '<i>a</i>');
    p.ctx.gpHtml(target, '<i>a</i>');
    expect(p.writes['#gpPlans']).toBe(1);
    p.ctx.gpHtml(target, '<i>b</i>');
    expect(p.writes['#gpPlans']).toBe(2);
  });
});
