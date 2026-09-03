import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';

type Device = { deviceId: string; name: string; kind: 'pda'; warehouse: string; gate: string; lastSeenAt: string; appVersion?: string };
const devices = new Map<string, Device>();
const HEARTBEAT_TIMEOUT_MS = 45_000;
const schema = z.object({
  deviceId: z.string().trim().min(1).max(120), name: z.string().trim().min(1).max(160),
  warehouse: z.string().trim().max(120).default(''), gate: z.string().trim().max(40).default(''),
  appVersion: z.string().trim().max(40).optional(),
});
export const devicesRouter = Router();
devicesRouter.use(requireAuth);
devicesRouter.post('/heartbeat', (req, res) => {
  const input = schema.parse(req.body);
  const device: Device = { ...input, kind: 'pda', lastSeenAt: new Date().toISOString() };
  devices.set(device.deviceId, device);
  res.json({ ok: true, device, online: true });
});
devicesRouter.get('/', (_req, res) => {
  const now = Date.now();
  res.json({ devices: [...devices.values()].map((device) => ({ ...device, online: now - Date.parse(device.lastSeenAt) <= HEARTBEAT_TIMEOUT_MS })), heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS });
});
