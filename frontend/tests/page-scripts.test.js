/* A syntax error in the page's inline script leaves the whole app dead, and
   tests that lift single functions out of it do not notice. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const html = readFileSync(new URL('../public/legacy.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter(([, attrs, body]) => !/\bsrc=|type=/.test(attrs) && body.trim());

describe('page scripts', () => {
  it('finds the inline scripts', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it.each(scripts.map((m, i) => [i + 1, m[2]]))('inline script %i parses', (_, body) => {
    expect(() => new vm.Script(body)).not.toThrow();
  });
});
