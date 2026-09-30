import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { events, gates } from '../db/schema.js';
import { env } from '../env.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { bump } from '../lib/bus.js';

export const lprWebhookRouter = Router();

const payloadSchema = z.object({
  eventId: z.string().trim().max(160).optional(),
  cameraId: z.string().trim().max(160).optional(),
  cameraIp: z.string().trim().max(64).optional(),
  ipAddress: z.string().trim().max(64).optional(),
  plateNumber: z.string().trim().min(1).max(32).optional(),
  plate: z.string().trim().min(1).max(32).optional(),
  confidence: z.coerce.number().min(0).max(100).optional(),
  gateId: z.union([z.string(), z.number()]).optional(),
  gate: z.union([z.string(), z.number()]).optional(),
  timestamp: z.string().optional(),
  ts: z.string().optional(),
  imageUrl: z.string().url().max(2048).optional(),
}).passthrough();

function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, '').split('%')[0];
  if (ip === '::1' || ip === 'localhost') return true;
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = octets;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function validSecret(received: string, expected: string): boolean {
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

lprWebhookRouter.post('/', asyncHandler(async (req, res) => {
  if (env.lprWebhookSecret) {
    const received = req.get('X-LPR-Webhook-Secret') ?? '';
    if (!validSecret(received, env.lprWebhookSecret)) {
      throw httpError(401, 'Webhook Secret ไม่ถูกต้อง', 'invalid_webhook_secret');
    }
  } else if (!isPrivateAddress(req.ip || req.socket.remoteAddress || '')) {
    throw httpError(401, 'LPR Webhook อนุญาตเฉพาะเครือข่ายภายใน กรุณาตั้ง LPR_WEBHOOK_SECRET หากส่งจากภายนอก', 'webhook_network_not_allowed');
  }

  const input = payloadSchema.parse(req.body);
  const plateNumber = input.plateNumber ?? input.plate;
  if (!plateNumber) throw httpError(400, 'ต้องระบุ plateNumber', 'plate_number_required');
  const gateRaw = input.gateId ?? input.gate;
  const gateMatch = String(gateRaw ?? '').match(/(?:gate\s*)?(\d+)/i);
  const gateNo = gateMatch ? Number(gateMatch[1]) : NaN;
  if (!Number.isSafeInteger(gateNo) || gateNo < 1) throw httpError(400, 'ต้องระบุ gateId เป็น DB Gate ที่ถูกต้อง', 'gate_id_required');

  const db = getDb();
  const [gateRow] = await db.select().from(gates).where(eq(gates.gateNo, gateNo)).limit(1);
  if (!gateRow) throw httpError(404, `ไม่พบ DB Gate ${gateNo}`, 'gate_not_found');

  const tsRaw = input.timestamp ?? input.ts;
  const occurredAt = tsRaw ? new Date(tsRaw) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw httpError(400, 'timestamp ไม่ใช่วันที่ที่ถูกต้อง', 'invalid_timestamp');
  const eventId = input.eventId || `lpr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const cameraId = input.cameraId || `LPR-${gateNo}`;
  const receivedAt = new Date().toISOString();
  const cameraIp = input.cameraIp || input.ipAddress || '';
  const sourceIp = req.ip || req.socket.remoteAddress || '';

  // Make camera retries idempotent so a network retry cannot duplicate an
  // arrival in the realtime event stream.
  const recent = await db.select().from(events).orderBy(desc(events.ts)).limit(500);
  const duplicate = recent.some((row) => {
    const data = row.data as Record<string, unknown> | null;
    return data?.dir === 'lpr' && data.eventId === eventId;
  });
  if (duplicate) {
    res.json({ ok: true, duplicate: true, eventId });
    return;
  }

  const record = {
    dir: 'lpr',
    type: 'lpr-detection',
    eventId,
    cameraId,
    ...(cameraIp ? { cameraIp } : {}),
    sourceIp,
    plateNumber,
    confidence: input.confidence ?? null,
    gate: gateNo,
    gateId: String(gateNo),
    wh: gateRow.warehouseId ?? '',
    ts: occurredAt.toISOString(),
    receivedAt,
    ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
    rfidTags: [],
  };
  await db.insert(events).values({ ts: occurredAt, data: record });
  bump();
  res.status(202).json({ ok: true, received: true, eventId, cameraId, cameraIp: cameraIp || sourceIp, sourceIp, gateId: String(gateNo), plateNumber, timestamp: occurredAt.toISOString() });
}));
