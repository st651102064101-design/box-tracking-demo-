import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { appSettings, events } from '../db/schema.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermissions } from './roles.js';
import { EPC_BITS, EpcEncodeError, encodeBarcodeToEpcHex, type EpcBits } from '../lib/rfid.js';

export const rfidRouter = Router();
rfidRouter.use(requireAuth);
/** Zebra IoT Connector is configured with Authentication: NONE. Keep its
 * receiver separate from the authenticated management API. */
export const fx9600WebhookRouter = Router();

const READER_KEY = 'rfid:fx9600:readers';
const SUPPRESSED_KEY = '__suppressedHistoricalReaders';
const MIN_READER_ONLINE_MS = 10_000;
const webhookBaseUrl = z.string().trim().default('').refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && !!url.hostname
      && !!url.port
      && !url.username
      && !url.password
      && (url.pathname === '' || url.pathname === '/')
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}, 'Webhook Base URL ต้องเป็น http(s)://IP:port เท่านั้น ห้ามใส่ path');
const readerInput = z.object({
  name: z.string().trim().min(1).max(120),
  model: z.string().trim().max(80).optional(),
  host: z.string().trim().max(255).default(''),
  webhookBaseUrl,
  gateNo: z.number().int().positive().max(9999),
  antennaCount: z.number().int().min(0).max(64).default(2),
  heartbeatIntervalSeconds: z.number().int().min(1).max(3600).default(1),
});

type Reader = Omit<z.infer<typeof readerInput>, 'model'> & {
  id: string;
  model: string;
  readingEnabled: boolean;
  lastSeenAt: string | null;
  antennaStatuses: Record<string, { connected: boolean; updatedAt: string; source?: 'antenna_event' | 'tag_read' }>;
};

/** A real tag report containing both EPC and antenna ID proves that RF
 * communication succeeded on that port. It does not prove cable state when
 * the report is absent; only the reader's explicit antenna event can do that. */
function antennaTagReads(payload: unknown, maxPorts = 64): number[] {
  const found = new Set<number>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 8 || value == null) return;
    if (Array.isArray(value)) { value.forEach((item) => visit(item, depth + 1)); return; }
    if (typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    const port = Number(item.antenna ?? item.antennaPort ?? item.antennaId ?? item.antennaID);
    const hasTag = ['idHex', 'epc', 'EPC', 'tagId', 'tagID'].some((key) => typeof item[key] === 'string' && item[key]);
    if (hasTag && Number.isInteger(port) && port >= 1 && port <= maxPorts) found.add(port);
    Object.values(item).forEach((child) => { if (child && typeof child === 'object') visit(child, depth + 1); });
  };
  visit(payload);
  return [...found];
}

/** Only explicit per-port connection reports establish antenna connectivity.
 * A reader heartbeat or a tag-read event is not evidence that every antenna is
 * physically connected. Supported webhook shape: { antennaStatuses: [{port,
 * connected}] } or { eventType: 'antenna', antennaPort, connected }. */
function antennaReports(payload: unknown, maxPorts: number): Array<{ port: number; connected: boolean }> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const body = payload as Record<string, unknown>;
  const rawReports = Array.isArray(body.antennaStatuses) ? body.antennaStatuses : [];
  const reports = rawReports.slice();
  if (String(body.eventType ?? body.type ?? '').toLowerCase().includes('antenna')) reports.push(body);
  const parsed = reports.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const port = Number(item.port ?? item.antennaPort ?? item.antenna);
    const rawState = item.connected ?? item.isConnected;
    const textState = typeof item.status === 'string' ? item.status.toLowerCase() : '';
    const connected = typeof rawState === 'boolean' ? rawState
      : ['connected', 'online'].includes(textState) ? true
        : ['disconnected', 'offline'].includes(textState) ? false : null;
    return Number.isInteger(port) && port >= 1 && port <= maxPorts && connected !== null
      ? [{ port, connected }] : [];
  });

  // Zebra IoT Connector Management Events can include a full antenna-state
  // snapshot in data.radio_control.antennas when ANTENNAS is enabled in the
  // heartbeat fields. This is the physical connected/disconnected state that
  // tag reads alone cannot provide.
  const visitManagementSnapshot = (value: unknown, depth = 0): void => {
    if (depth > 6 || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    const radioControl = item.radio_control ?? item.radioControl;
    if (radioControl && typeof radioControl === 'object' && !Array.isArray(radioControl)) {
      const antennas = (radioControl as Record<string, unknown>).antennas;
      if (antennas && typeof antennas === 'object' && !Array.isArray(antennas)) {
        for (const [rawPort, rawState] of Object.entries(antennas as Record<string, unknown>)) {
          const port = Number(rawPort);
          const state = typeof rawState === 'string' ? rawState.toLowerCase() : '';
          if (Number.isInteger(port) && port >= 1 && port <= maxPorts
            && ['connected', 'disconnected'].includes(state)) {
            parsed.push({ port, connected: state === 'connected' });
          }
        }
      }
    }
    for (const child of Object.values(item)) visitManagementSnapshot(child, depth + 1);
  };
  visitManagementSnapshot(body);
  return parsed;
}

async function readReaders(): Promise<Record<string, Reader>> {
  const db = getDb();
  const [stored] = await db.select().from(appSettings).where(eq(appSettings.key, READER_KEY)).limit(1);
  const saved = stored?.data && typeof stored.data === 'object' && !Array.isArray(stored.data)
    ? stored.data as Record<string, unknown>
    : {};
  const suppressed = Array.isArray(saved[SUPPRESSED_KEY]) ? saved[SUPPRESSED_KEY] as string[] : [];
  const readers: Record<string, Reader> = {};
  for (const [id, raw] of Object.entries(saved)) {
    if (id === SUPPRESSED_KEY) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const parsed = readerInput.safeParse(raw);
    if (!parsed.success) continue;
    const data = raw as Record<string, unknown>;
    readers[id] = {
      id,
      ...parsed.data,
      model: parsed.data.model ?? '',
      readingEnabled: data.readingEnabled !== false,
      lastSeenAt: typeof data.lastSeenAt === 'string' ? data.lastSeenAt : null,
      antennaStatuses: data.antennaStatuses && typeof data.antennaStatuses === 'object' && !Array.isArray(data.antennaStatuses)
        ? data.antennaStatuses as Reader['antennaStatuses'] : {},
    };
  }

  // Older installs recorded FX9600 gate activity before the reader registry
  // API existed. Surface those real reader IDs as unconfigured records so
  // the dashboard does not silently hide hardware already seen by the DB.
  const history = await db.select().from(events).orderBy(desc(events.ts)).limit(1000);
  for (const event of history) {
    const data = event.data as Record<string, unknown> | null;
    const id = typeof data?.device === 'string' ? data.device : '';
    const gateNo = Number(data?.gate);
    if (!/^fx9600/i.test(id) || !Number.isInteger(gateNo) || gateNo < 1 || suppressed.includes(id)) continue;
    const seenAt = typeof data?.ts === 'string' ? data.ts : event.ts.toISOString();
    if (readers[id]) {
      if (!readers[id].lastSeenAt || Date.parse(seenAt) > Date.parse(readers[id].lastSeenAt!)) readers[id].lastSeenAt = seenAt;
      const ports = antennaTagReads(data?.payload);
      for (const port of ports) {
        const key = String(port), previous = readers[id].antennaStatuses[key];
        if (!previous || Date.parse(seenAt) > Date.parse(previous.updatedAt)) {
          readers[id].antennaStatuses[key] = { connected: true, updatedAt: seenAt, source: 'tag_read' };
        }
      }
      continue;
    }
    readers[id] = {
      id,
      name: `RFID Reader · Gate ${gateNo}`,
      model: 'FX9600',
      host: '',
      webhookBaseUrl: '',
      gateNo,
      antennaCount: 2,
      heartbeatIntervalSeconds: 1,
      readingEnabled: true,
      lastSeenAt: seenAt,
      antennaStatuses: {},
    };
    for (const port of antennaTagReads(data?.payload)) {
      readers[id].antennaStatuses[String(port)] = { connected: true, updatedAt: seenAt, source: 'tag_read' };
    }
  }
  return readers;
}

async function saveReaders(readers: Record<string, Reader>, suppressed?: string[]) {
  const [stored] = await getDb().select().from(appSettings).where(eq(appSettings.key, READER_KEY)).limit(1);
  const previous = stored?.data && typeof stored.data === 'object' && !Array.isArray(stored.data)
    ? stored.data as Record<string, unknown>
    : {};
  const hidden = suppressed ?? (Array.isArray(previous[SUPPRESSED_KEY]) ? previous[SUPPRESSED_KEY] as string[] : []);
  await getDb().insert(appSettings).values({ key: READER_KEY, data: { ...readers, [SUPPRESSED_KEY]: hidden } }).onConflictDoUpdate({
    target: appSettings.key,
    set: { data: { ...readers, [SUPPRESSED_KEY]: hidden }, updatedAt: new Date() },
  });
}

// A browser GET is useful for checking the configured URL, while the reader
// sends POSTs. Neither request should require an operator JWT/API key. The
// legacy FX9600 mount remains supported; the generic mount accepts compatible
// fixed-reader webhook payloads from newer models such as FXR90.
fx9600WebhookRouter.route('/:gateNo/webhook')
  .get(asyncHandler(async (req, res) => {
    const gateNo = Number(req.params.gateNo);
    const reader = Object.values(await readReaders()).find((item) => item.gateNo === gateNo);
    if (!reader) throw httpError(404, 'ไม่พบ RFID Reader ที่ผูกกับ Gate นี้', 'reader_not_found');
    res.json({ ok: true, endpoint: 'RFID Reader webhook', method: 'POST', gate: gateNo, readerId: reader.id, model: reader.model, message: 'ปลายทางพร้อมรับข้อมูลจาก RFID Reader' });
  }))
  .post(asyncHandler(async (req, res) => {
    const gateNo = Number(req.params.gateNo);
    const readers = await readReaders();
    const reader = Object.values(readers).find((item) => item.gateNo === gateNo);
    if (!reader) throw httpError(404, 'ไม่พบ RFID Reader ที่ผูกกับ Gate นี้', 'reader_not_found');
    if (!reader.readingEnabled) throw httpError(423, 'ปิดการอ่าน Tag ของ FX9600 อยู่', 'reader_disabled');

    const receivedAt = new Date();
    reader.lastSeenAt = receivedAt.toISOString();
    // FX9600 events keep their physical 8-port contract even if the UI is set
    // to display fewer ports. Other models use their registered port count so
    // replacing hardware cannot inherit unsupported antenna states.
    const maxPorts = req.baseUrl.includes('/fx9600') || /fx9600/i.test(reader.model)
      ? 8
      : Math.max(1, Math.min(64, reader.antennaCount || 8));
    const reports = antennaReports(req.body, maxPorts);
    for (const report of reports) {
      reader.antennaStatuses[String(report.port)] = { connected: report.connected, updatedAt: receivedAt.toISOString(), source: 'antenna_event' };
    }
    for (const port of antennaTagReads(req.body, maxPorts)) {
      reader.antennaStatuses[String(port)] = { connected: true, updatedAt: receivedAt.toISOString(), source: 'tag_read' };
    }
    await saveReaders(readers);
    // Preserve the payload for diagnostics; parsing/moving inventory is not
    // safe until the reader's tag schema and antenna direction are known.
    await getDb().insert(events).values({
      ts: receivedAt,
      data: { ts: receivedAt.toISOString(), type: 'rfid-reader-webhook', dir: 'webhook', gate: gateNo, device: reader.id, model: reader.model, antennaReports: reports, payload: req.body ?? {} },
    });
    res.status(202).json({ ok: true, received: true, readerId: reader.id, gate: gateNo, receivedAt: receivedAt.toISOString() });
  }));

rfidRouter.get('/fx9600/readers', requirePermissions('rfid.log', 'rfid.manage', 'device.manage'), asyncHandler(async (_req, res) => {
  const readers = Object.values(await readReaders()).map((reader) => {
    const seen = reader.lastSeenAt ? Date.parse(reader.lastSeenAt) : 0;
    // The setting is the expected webhook interval, not a device-side
    // configuration. Allow three missed intervals, with a 10s floor for
    // network jitter, instead of keeping a disconnected reader green for 90s.
    const online = !!seen && Date.now() - seen <= Math.max(MIN_READER_ONLINE_MS, reader.heartbeatIntervalSeconds * 3_000);
    return { ...reader, online };
  });
  res.json({ readers });
}));

rfidRouter.put('/fx9600/readers/:id', requirePermissions('rfid.manage'), asyncHandler(async (req, res) => {
  const input = readerInput.parse(req.body);
  const readers = await readReaders();
  const [registryRow] = await getDb().select().from(appSettings).where(eq(appSettings.key, READER_KEY)).limit(1);
  const registryData = registryRow?.data && typeof registryRow.data === 'object' && !Array.isArray(registryRow.data)
    ? registryRow.data as Record<string, unknown>
    : {};
  const suppressed = Array.isArray(registryData[SUPPRESSED_KEY]) ? registryData[SUPPRESSED_KEY] as string[] : [];
  const currentReader = readers[req.params.id];
  const model = input.model ?? currentReader?.model ?? '';
  if (currentReader && currentReader.gateNo !== input.gateNo) {
    throw httpError(409, 'Reader ID นี้ผูกกับ Gate อื่นอยู่ กรุณาใช้ ID ใหม่เพื่อแยกประวัติอุปกรณ์', 'reader_id_in_use');
  }
  if (currentReader?.model && model && currentReader.model.toLowerCase() !== model.toLowerCase()) {
    throw httpError(409, 'การเปลี่ยนรุ่นฮาร์ดแวร์ต้องใช้ Reader ID ใหม่ เพื่อแยกสถานะเสาและประวัติ Log', 'reader_id_required_for_replacement');
  }
  const retiredIds = Object.values(readers)
    .filter((reader) => reader.id !== req.params.id && reader.gateNo === input.gateNo)
    .map((reader) => reader.id);
  retiredIds.forEach((id) => { delete readers[id]; });
  const hardwareChanged = !!currentReader
    && (currentReader.model !== model || currentReader.host !== input.host);
  readers[req.params.id] = {
    ...input,
    id: req.params.id,
    model,
    // Older screens don't send this field; preserve an explicitly configured
    // endpoint instead of silently replacing it with the default.
    webhookBaseUrl: input.webhookBaseUrl || currentReader?.webhookBaseUrl || '',
    readingEnabled: currentReader?.readingEnabled ?? true,
    lastSeenAt: hardwareChanged ? null : currentReader?.lastSeenAt ?? null,
    antennaStatuses: hardwareChanged ? {} : currentReader?.antennaStatuses ?? {},
  };
  await saveReaders(readers, Array.from(new Set([...suppressed, ...retiredIds])).filter((id) => id !== req.params.id));
  res.json({ reader: readers[req.params.id] });
}));

rfidRouter.post('/fx9600/readers/:id/reading', requirePermissions('rfid.manage'), asyncHandler(async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  const readers = await readReaders();
  const reader = readers[req.params.id];
  if (!reader) throw httpError(404, 'ไม่พบ FX9600 Reader', 'reader_not_found');
  reader.readingEnabled = enabled;
  await saveReaders(readers);
  res.json({ reader });
}));

rfidRouter.delete('/fx9600/readers/:id', requirePermissions('rfid.manage'), asyncHandler(async (req, res) => {
  const readers = await readReaders();
  delete readers[req.params.id];
  const [stored] = await getDb().select().from(appSettings).where(eq(appSettings.key, READER_KEY)).limit(1);
  const previous = stored?.data && typeof stored.data === 'object' && !Array.isArray(stored.data)
    ? stored.data as Record<string, unknown>
    : {};
  const suppressed = Array.isArray(previous[SUPPRESSED_KEY]) ? previous[SUPPRESSED_KEY] as string[] : [];
  await saveReaders(readers, Array.from(new Set([...suppressed, req.params.id])));
  res.json({ ok: true });
}));

rfidRouter.get('/fx9600/debug-log', requirePermissions('rfid.log'), asyncHandler(async (_req, res) => {
  const rows = await getDb().select().from(events).orderBy(desc(events.ts)).limit(250);
  const entries = rows.map((row): Record<string, unknown> => ({ ...(row.data as Record<string, unknown>), ts: row.ts.toISOString() }))
    .filter((item) => item.type === 'fx9600-webhook' || item.type === 'rfid-reader-webhook');
  res.json({ events: entries, entries });
}));

/**
 * Preview-only: computes the hex a PDA should Write to a blank tag's EPC
 * bank for this barcode. Doesn't touch the database — the box only actually
 * gets tagged once the PDA reads the write back and calls
 * POST /api/boxes/:tag/rfid with what's really on the chip (see boxes.ts).
 */
rfidRouter.get(
  '/encode/:tag',
  requirePermissions('rfid.manage', 'box.create'),
  asyncHandler(async (req, res) => {
    const bits = req.query.bits === '128' ? EPC_BITS.EPC_128 : (EPC_BITS.EPC_96 as EpcBits);
    try {
      const epcHex = encodeBarcodeToEpcHex(req.params.tag, bits);
      res.json({ tag: req.params.tag, bits, epcHex });
    } catch (e) {
      if (e instanceof EpcEncodeError) throw httpError(400, e.message, 'epc_encode_error');
      throw e;
    }
  }),
);

export default rfidRouter;
