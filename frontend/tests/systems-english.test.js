/* System names and the system picker must read fully in English. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(read('systems.js'), sandbox);
const { Systems } = sandbox.window;
const translate = (text) => (Systems.en || []).reduce((out, [pattern, to]) => out.replace(pattern, to), text);
const THAI = /[฀-๿]/;

const html = read('legacy.html');
const picker = html.slice(html.indexOf('<div id="systemPicker"'), html.indexOf('<header class="chrome">'));
const pickerTexts = picker.replace(/<svg[\s\S]*?<\/svg>/g, '<i></i>').split(/<[^>]*>/).map((t) => t.trim()).filter((t) => THAI.test(t));

describe('systems in English', () => {
  it('translates every system name', () => {
    for (const id of ['rfidgate', 'gate1', 'gate2', 'gate3', 'full']) {
      expect(translate(Systems.name(id)), id).not.toMatch(THAI);
    }
    expect(translate(Systems.name('full'))).toBe('All features');
  });

  it('translates every text on the picker', () => {
    expect(pickerTexts.length).toBeGreaterThan(15);
    /* "ส่งออก" is already in the page dictionary. */
    for (const text of pickerTexts.filter((t) => t !== 'ส่งออก')) expect(translate(text), text).not.toMatch(THAI);
  });

  it('translates the switch button tooltip', () => {
    expect(translate('เปลี่ยนระบบ')).toBe('Switch system');
  });
});
