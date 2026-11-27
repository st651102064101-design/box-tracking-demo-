import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';

type Device = { deviceId: string; name: string; kind: 'pda'; warehouse: string; gate: string; lastSeenAt: string; appVersion?: string; model?: string; ipAddress?: string; hasIntegratedRfid?: boolean; usesZebraSdk?: boolean; employeeId?: string; employeeName?: string; heartbeatSeconds?: number; sleeping?: boolean };
const devices = new Map<string, Device>();
const HEARTBEAT_TIMEOUT_MS = 45_000;
/** A handheld whose screen went dark reports once on the way down. That
 *  report is trusted for this long before the device counts as offline. */
const SLEEP_TIMEOUT_MS = 10 * 60_000;
export type DeviceState = 'online' | 'sleeping' | 'offline';
export function deviceState(d: Device, now: number): DeviceState {
  const age = now - Date.parse(d.lastSeenAt);
  if (d.sleeping) return age <= SLEEP_TIMEOUT_MS ? 'sleeping' : 'offline';
  return age <= (d.heartbeatSeconds ? d.heartbeatSeconds * 3000 : HEARTBEAT_TIMEOUT_MS) ? 'online' : 'offline';
}
const schema = z.object({
  /** Newer handhelds send no id: their login identifies them. */
  deviceId: z.string().trim().min(1).max(120).optional(),
  name: z.string().trim().min(1).max(160),
  warehouse: z.string().trim().max(120).optional(),
  gate: z.string().trim().max(40).optional(),
  warehouseId: z.string().trim().max(120).optional(),
  gateNo: z.number().int().positive().max(9999).optional(),
  appVersion: z.string().trim().max(40).optional(),
  model: z.string().trim().max(80).optional(),
  ipAddress: z.string().trim().max(64).optional(),
  hasIntegratedRfid: z.boolean().optional(),
  usesZebraSdk: z.boolean().optional(),
  /** Who is signed in on the handheld. Reported by the device: display only. */
  employeeId: z.string().trim().max(80).optional(),
  employeeName: z.string().trim().max(160).optional(),
  /** How often this handheld reports; older apps report every 15–25 s. */
  heartbeatSeconds: z.number().int().min(2).max(60).optional(),
  /** true while the screen is off or locked; the handheld says so on pause and clears it on resume. */
  sleeping: z.boolean().optional(),
});
export const devicesRouter = Router();
devicesRouter.use(requireAuth);
devicesRouter.post('/heartbeat', (req, res) => {
  const input = schema.parse(req.body);
  const device: Device = {
    deviceId: input.deviceId ?? req.user!.username,
    name: input.name,
    kind: 'pda',
    warehouse: input.warehouse ?? input.warehouseId ?? '',
    gate: input.gate ?? String(input.gateNo ?? ''),
    appVersion: input.appVersion,
    model: input.model,
    ipAddress: input.ipAddress,
    hasIntegratedRfid: input.hasIntegratedRfid,
    usesZebraSdk: input.usesZebraSdk,
    employeeId: input.employeeId,
    employeeName: input.employeeName,
    heartbeatSeconds: input.heartbeatSeconds,
    sleeping: input.sleeping === true,
    lastSeenAt: new Date().toISOString(),
  };
  devices.set(device.deviceId, device);
  res.json({ ok: true, device, online: true });
});
devicesRouter.get('/', (_req, res) => {
  const now = Date.now();
  res.json({ devices: [...devices.values()].map((device) => {
    const state = deviceState(device, now);
    return { ...device, state, online: state === 'online' };
  }), heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS });
});
