import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect } from 'vitest';

const sandbox = { window: {}, URL };
vm.runInNewContext(readFileSync(new URL('../public/pda-device.js', import.meta.url), 'utf8'), sandbox);
const { view, serverUrl, isLocalUrl } = sandbox.window.PdaDevice;
const now = Date.parse('2026-11-26T08:00:00Z');
const device = {
  deviceId: 'pda-1', name: 'Zebra TC52', online: true, lastSeenAt: '2026-11-26T07:59:52Z',
  warehouse: 'WH-1', gate: '1', model: 'TC52', ipAddress: '192.168.3.115',
  employeeName: 'สมชาย', employeeId: 'EMP-001', hasIntegratedRfid: false, usesZebraSdk: true,
};
const plain = (v) => JSON.parse(JSON.stringify(v));

describe('PDA detail view', () => {
  it('says who uses the handheld, where, and when it was last heard', () => {
    expect(plain(view(device, { now, warehouseName: 'บางปู' }))).toMatchObject({
      title: 'Zebra TC52', online: true, user: 'สมชาย (EMP-001)', post: 'คลัง บางปู · ประตู 1',
      seen: '8 วินาทีที่แล้ว', model: 'TC52', ip: '192.168.3.115', rfid: false, zebra: true, hint: '',
    });
  });

  it('does not repeat the word warehouse, and capitalises the model', () => {
    const v = view({ ...device, model: 'tc52' }, { now, warehouseName: 'คลัง 1 — บางปู' });
    expect([v.post, v.model]).toEqual(['คลัง 1 — บางปู · ประตู 1', 'TC52']);
  });

  it('shows what is missing plainly, and how to fix an offline handheld', () => {
    const bare = view({ name: '', online: false, lastSeenAt: '2026-11-26T05:00:00Z', warehouse: '', gate: '' }, { now });
    expect(plain(bare)).toMatchObject({
      title: 'PDA Scanner', user: 'ยังไม่มีผู้เข้างาน', post: '—', seen: '3 ชั่วโมงที่แล้ว',
      model: '—', ip: '—', rfid: null, zebra: null,
    });
    expect(bare.hint).toContain('Wi-Fi');
  });
});

describe('PDA connect address', () => {
  it('knows an address the handheld cannot reach', () => {
    for (const url of ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000']) expect(isLocalUrl(url)).toBe(true);
    expect(isLocalUrl('http://192.168.3.9:4000')).toBe(false);
  });

  it('normalises what the operator types', () => {
    expect(serverUrl(' 192.168.3.9 ')).toBe('http://192.168.3.9:4000');
    expect(serverUrl('http://192.168.3.9:4100/')).toBe('http://192.168.3.9:4100');
    expect(serverUrl('https://api.example.com')).toBe('https://api.example.com');
    expect(serverUrl('server.local:4000')).toBe('http://server.local:4000');
  });

  it('refuses junk and local addresses', () => {
    for (const text of ['', '   ', 'abc def', 'localhost', '127.0.0.1:4000', 'ftp://1.2.3.4', '999.1.1.1', '192.168.3', '<b>']) {
      expect(serverUrl(text)).toBe('');
    }
  });
});
