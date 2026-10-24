import { afterEach, expect, test, vi } from 'vitest';
import { getBranding } from '../lib/api';

afterEach(() => vi.unstubAllGlobals());

test.each([{}, null, { systemName: '  ', subtitle: 42, logoData: {} }])(
  'empty or incomplete branding cannot crash login or onboarding (%j)', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    const branding = await getBranding();
    expect(branding).toEqual({ systemName: 'Smart Tracking', subtitle: '', logoData: null });
    expect(branding.systemName.charAt(0)).toBe('S');
  },
);

test('valid database branding is preserved', async () => {
  const body = { systemName: 'ชื่อระบบจาก DB', subtitle: 'Warehouse', logoData: 'data:image/png;base64,AAAA' };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
  expect(await getBranding()).toEqual(body);
});

test('branding HTTP failures still reject for the caller to handle', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 503 })));
  await expect(getBranding()).rejects.toMatchObject({ status: 503 });
});
