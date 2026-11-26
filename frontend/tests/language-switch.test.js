/* The TH/EN switch must read the same whichever language is selected. */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const source = readFileSync(new URL('../lib/i18n.tsx', import.meta.url), 'utf8');
const labels = (key) => [...source.matchAll(new RegExp(`'${key.replace('.', '\\.')}': '([^']*)'`, 'g'))].map((m) => m[1]);

describe('language switch', () => {
  it('shows TH and EN in both languages', () => {
    expect(labels('language.th')).toEqual(['TH', 'TH']);
    expect(labels('language.en')).toEqual(['EN', 'EN']);
  });
});
