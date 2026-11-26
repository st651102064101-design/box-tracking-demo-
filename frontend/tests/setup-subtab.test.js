/* The settings page must never end up with no visible section. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const html = readFileSync(new URL('../public/legacy.html', import.meta.url), 'utf8');
const lift = (name) => {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no ${name}`);
  return html.slice(start, html.indexOf('\n}', start) + 2);
};

function page({ putaway, hidden = [] }) {
  const el = (shown, cls = []) => ({
    style: { display: shown ? '' : 'none' },
    classList: { add: (c) => cls.push(c), remove: (c) => cls.splice(0, cls.length, ...cls.filter((x) => x !== c)), contains: (c) => cls.includes(c) },
  });
  const tabs = { btype: el(true, ['active']), box: el(true), loc: el(putaway) };
  const secs = { btype: el(true), box: el(false), loc: el(false) };
  Object.entries(tabs).forEach(([k, t]) => { t.dataset = { stab: k }; });
  const find = (q) => {
    if (q === '#stabLoc') return tabs.loc;
    if (q.startsWith('#ssec-')) return secs[q.slice(6)] || null;
    const m = /data-stab="([^"]*)"/.exec(q);
    return m ? tabs[m[1]] || null : null;
  };
  const ctx = {
    S: { cfg: { putawayEnabled: putaway } },
    window: { Systems: { allowsStab: (_, stab) => !hidden.includes(stab) } },
    currentSystem: () => 'any',
    $: find,
    $all: (q) => Object.values(q === '.stab' ? tabs : secs),
    document: { querySelector: find },
    boxRegMode: 'single', setBoxRegMode() {}, renderLocMaster() {}, loadRoles() {}, loadRfidDebugLog() {},
  };
  vm.createContext(ctx);
  vm.runInContext(['showSetupSub', 'ensureSetupSub', 'renderOptionalLocation'].map(lift).join('\n'), ctx);
  const open = () => ({
    tab: Object.keys(tabs).filter((k) => tabs[k].classList.contains('active')),
    section: Object.keys(secs).filter((k) => secs[k].style.display !== 'none'),
  });
  return { ctx, tabs, open };
}
const plain = (v) => JSON.parse(JSON.stringify(v));

describe('settings sub-tabs', () => {
  it('refuses a sub-tab that is hidden', () => {
    const p = page({ putaway: false });
    expect(p.ctx.showSetupSub('loc')).toBe(false);
    expect(plain(p.open())).toEqual({ tab: ['btype'], section: ['btype'] });
  });

  it('opens the first one when the open sub-tab gets hidden', () => {
    const p = page({ putaway: true });
    p.ctx.showSetupSub('loc');
    p.ctx.S.cfg.putawayEnabled = false;
    p.ctx.renderOptionalLocation();
    expect(plain(p.open())).toEqual({ tab: ['btype'], section: ['btype'] });
  });

  it('skips a sub-tab the system in use does not offer', () => {
    const p = page({ putaway: false, hidden: ['btype'] });
    expect(p.ctx.showSetupSub('btype')).toBe(false);
    p.ctx.ensureSetupSub();
    expect(plain(p.open())).toEqual({ tab: ['box'], section: ['box'] });
  });

  it('leaves a visible sub-tab where it is', () => {
    const p = page({ putaway: false });
    p.ctx.showSetupSub('box');
    p.ctx.renderOptionalLocation();
    expect(plain(p.open())).toEqual({ tab: ['box'], section: ['box'] });
  });
});
