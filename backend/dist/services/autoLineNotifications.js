import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import { auditLog, boxes, customers, lineNotificationDeliveries, } from '../db/schema.js';
import { env } from '../env.js';
import { pushLineFlex, pushLineText } from './lineMessaging.js';
import { sendMail } from '../lib/mailer.js';
const LINE_USER_ID = /^U[0-9a-f]{32}$/i;
const DAY = 86_400_000;
const MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 5 * 60_000;
const STAGE_ORDER = [
    'overdue_7',
    'overdue_3',
    'overdue_1',
    'due_today',
    'due_tomorrow',
];
function dateParts(value, timeZone = env.line.autoTimezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(value);
    const valueOf = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    return {
        year: valueOf('year'),
        month: valueOf('month'),
        day: valueOf('day'),
        hour: valueOf('hour'),
        minute: valueOf('minute'),
    };
}
export function businessDateKey(value, timeZone = env.line.autoTimezone) {
    const { year, month, day } = dateParts(value, timeZone);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function formatDate(value) {
    return new Intl.DateTimeFormat('th-TH', {
        timeZone: env.line.autoTimezone,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    }).format(value);
}
function calendarDifference(dueAt, now) {
    const due = dateParts(dueAt);
    const current = dateParts(now);
    const dueUtc = Date.UTC(due.year, due.month - 1, due.day);
    const currentUtc = Date.UTC(current.year, current.month - 1, current.day);
    return Math.round((dueUtc - currentUtc) / DAY);
}
export function classifyReminderStage(dueAt, now) {
    switch (calendarDifference(dueAt, now)) {
        case 1:
            return 'due_tomorrow';
        case 0:
            return 'due_today';
        case -1:
            return 'overdue_1';
        case -3:
            return 'overdue_3';
        case -7:
            return 'overdue_7';
        default:
            return null;
    }
}
function tagSummary(tags) {
    const visible = tags.slice(0, 20).join(', ');
    return tags.length > 20 ? `${visible} และอีก ${tags.length - 20} ใบ` : visible;
}
function gateNotificationFlex(kind, customerName, metadata) {
    const data = (metadata && typeof metadata === 'object' ? metadata : {});
    const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
    const outbound = kind === 'gate_out';
    const accent = outbound ? '#4DDB20' : '#2D9CDB';
    const title = outbound ? '📦 ส่งกล่องให้ลูกค้าแล้ว' : '✅ รับคืนกล่องเข้าคลังแล้ว';
    const subtitle = outbound
        ? `${customerName} ได้รับกล่องหมุนเวียน`
        : `${customerName} ส่งคืนกล่องหมุนเวียนสำเร็จ`;
    const rows = [
        { type: 'text', text: `จำนวน ${tags.length} ใบ`, size: 'xl', weight: 'bold', color: accent },
        ...(data.doNo ? [{ type: 'text', text: `เลขที่ DO  ${data.doNo}`, size: 'sm', color: '#666666', margin: 'md' }] : []),
        { type: 'text', text: `ทะเบียน  ${data.plate?.trim() || 'ไม่พบป้ายทะเบียน'}`, size: 'sm', color: '#666666', margin: 'sm' },
        ...(outbound && data.dueAt ? [{ type: 'text', text: `กำหนดคืน  ${formatDate(new Date(data.dueAt))}`, size: 'sm', color: '#666666', margin: 'sm' }] : []),
        ...(!outbound && data.receivedAt ? [{ type: 'text', text: `รับคืนเมื่อ  ${new Intl.DateTimeFormat('th-TH', { timeZone: env.line.autoTimezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(data.receivedAt))}`, size: 'sm', color: '#666666', margin: 'sm' }] : []),
        { type: 'separator', margin: 'lg', color: '#E5E7EB' },
        { type: 'text', text: tags.length ? `กล่อง  ${tagSummary(tags)}` : 'ไม่พบรายการกล่อง', size: 'sm', color: '#444444', wrap: true, margin: 'lg' },
    ];
    return {
        type: 'bubble',
        size: 'mega',
        header: {
            type: 'box', layout: 'vertical', backgroundColor: accent, paddingAll: '18px',
            contents: [{ type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'lg', wrap: true }],
        },
        body: {
            type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '18px',
            contents: [{ type: 'text', text: subtitle, size: 'md', weight: 'bold', color: '#222222', wrap: true }, ...rows],
        },
        footer: {
            type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: '#F7F8F5',
            contents: [{ type: 'text', text: outbound ? 'ระบบบันทึกการส่งออกเรียบร้อยแล้ว' : 'ระบบอัปเดตสถานะกล่องเป็นรับคืนแล้ว', size: 'xs', color: '#777777', wrap: true }],
        },
    };
}
export function buildDailyReminderMessage(customerName, rows) {
    const byStage = new Map();
    for (const row of rows)
        byStage.set(row.stage, [...(byStage.get(row.stage) ?? []), row]);
    const section = (stage, items) => {
        const labels = {
            due_tomorrow: '🟡 ครบกำหนดคืนพรุ่งนี้',
            due_today: '🚩 ครบกำหนดส่งคืนวันนี้',
            overdue_1: '🟠 เลยกำหนดคืน 1 วัน',
            overdue_3: '🔴 เลยกำหนดคืน 3 วัน (เตือนครั้งที่ 2)',
            overdue_7: '🚨 เลยกำหนดคืน 7 วัน — กรุณาให้แอดมินหรือฝ่ายขายติดตาม',
        };
        return `${labels[stage]}: ${items.length} ใบ\nกล่อง: ${tagSummary(items.map((item) => item.tag))}`;
    };
    const sections = STAGE_ORDER
        .map((stage) => (byStage.has(stage) ? section(stage, byStage.get(stage)) : null))
        .filter(Boolean);
    return [
        `🔔 สรุปสถานะกล่องหมุนเวียน (${customerName})`,
        ...sections,
        'กรุณาเตรียมส่งคืนเพื่อหลีกเลี่ยงค่าปรับ/ค่ามัดจำล่าช้า ขอบคุณครับ 🙏',
    ].join('\n\n');
}
async function markDelivery(db, id, status, detail) {
    await db
        .update(lineNotificationDeliveries)
        .set({
        status,
        lineRequestId: detail.lineRequestId ?? null,
        error: detail.error ?? null,
        sentAt: status === 'sent' ? new Date() : null,
        updatedAt: new Date(),
    })
        .where(eq(lineNotificationDeliveries.id, id));
}
async function pushDelivery(db, row) {
    try {
        const lineRequestId = row.channel === 'email'
            ? (await sendMail({
                to: row.recipient,
                subject: row.kind === 'gate_out'
                    ? 'แจ้งจัดส่งกล่องหมุนเวียน — Box Tracking'
                    : row.kind === 'gate_in'
                        ? 'ยืนยันรับคืนกล่องหมุนเวียน — Box Tracking'
                        : 'แจ้งเตือนกำหนดคืนกล่อง — Box Tracking',
                text: row.message,
            }), null)
            : (row.kind === 'gate_out' || row.kind === 'gate_in')
                ? await pushLineFlex({
                    to: row.recipient,
                    altText: row.message,
                    contents: gateNotificationFlex(row.kind, row.customerName, row.metadata),
                    retryKey: row.retryKey,
                })
                : await pushLineText({
                    to: row.recipient,
                    text: row.message,
                    retryKey: row.retryKey,
                });
        await markDelivery(db, row.id, 'sent', { lineRequestId });
        await db.insert(auditLog).values({
            action: row.channel === 'email' ? 'email_notification_sent' : 'line_notification_sent',
            actor: 'system:auto-notification',
            entityId: row.customerId,
            entityName: row.customerName,
            after: { deliveryId: row.id, kind: row.kind, lineRequestId },
            data: { deliveryId: row.id, kind: row.kind, metadata: row.metadata },
        });
        return true;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'unknown LINE error';
        await markDelivery(db, row.id, 'failed', { error: message });
        console.error('[auto-line] delivery failed', { id: row.id, kind: row.kind, error: message });
        return false;
    }
}
async function createAndPush(db, input) {
    const retryKey = randomUUID();
    const [created] = await db
        .insert(lineNotificationDeliveries)
        .values({ ...input, retryKey, metadata: input.metadata ?? {} })
        .onConflictDoNothing({ target: lineNotificationDeliveries.id })
        .returning();
    if (!created)
        return false;
    return pushDelivery(db, created);
}
export async function sendGateOutLineNotification(db, input) {
    if (input.tags.length === 0)
        return false;
    const tags = [...new Set(input.tags)].sort();
    const digest = createHash('sha256').update(tags.join('\n')).digest('hex').slice(0, 24);
    const dueAt = new Date(input.dueAt);
    const message = [
        `📦 ${input.customerName} ได้รับการจัดส่งสินค้าพร้อมกล่องหมุนเวียนจำนวน ${tags.length} ใบ`,
        `เลขที่ DO: ${input.doNo}`,
        `กำหนดคืน: ${formatDate(dueAt)}`,
        `ทะเบียน: ${input.plate?.trim() || 'ไม่พบป้ายทะเบียน'}`,
    ].join('\n');
    const common = {
        kind: 'gate_out',
        customerId: input.customerId,
        customerName: input.customerName,
        businessDate: businessDateKey(new Date()),
        message,
        metadata: { doNo: input.doNo, tags, dueAt: input.dueAt, plate: input.plate?.trim() || null },
    };
    let sent = false;
    if (env.line.autoNotificationsEnabled && env.line.channelAccessToken && input.lineUserId && LINE_USER_ID.test(input.lineUserId)) {
        sent = (await createAndPush(db, {
            ...common,
            id: `line:gate-out:${input.doNo}:${digest}`,
            channel: 'line',
            recipient: input.lineUserId,
        })) || sent;
    }
    const email = input.contactEmail?.trim();
    if (env.line.autoEmailNotificationsEnabled && email) {
        sent = (await createAndPush(db, {
            ...common,
            id: `email:gate-out:${input.doNo}:${digest}`,
            channel: 'email',
            recipient: email,
        })) || sent;
    }
    return sent;
}
export async function sendGateInNotifications(db, input) {
    if (input.tags.length === 0)
        return false;
    const tags = [...new Set(input.tags)].sort();
    const digest = createHash('sha256').update(tags.join('\n')).digest('hex').slice(0, 24);
    const receivedAt = new Date(input.receivedAt);
    const message = [
        `✅ ${input.customerName} ส่งคืนกล่องหมุนเวียนสำเร็จจำนวน ${tags.length} ใบ`,
        `กล่อง: ${tagSummary(tags)}`,
        `ทะเบียน: ${input.plate?.trim() || 'ไม่พบป้ายทะเบียน'}`,
        ...(input.doNo ? [`อ้างอิง DO: ${input.doNo}`] : []),
        `รับคืนเมื่อ: ${new Intl.DateTimeFormat('th-TH', {
            timeZone: env.line.autoTimezone,
            dateStyle: 'short',
            timeStyle: 'short',
        }).format(receivedAt)}`,
    ].join('\n');
    const reference = `${input.doNo ?? 'no-do'}:${receivedAt.toISOString()}:${digest}`;
    const common = {
        kind: 'gate_in', customerId: input.customerId, customerName: input.customerName,
        businessDate: businessDateKey(receivedAt), message,
        metadata: { doNo: input.doNo ?? null, tags, receivedAt: input.receivedAt, plate: input.plate?.trim() || null },
    };
    let sent = false;
    if (env.line.autoNotificationsEnabled && env.line.channelAccessToken && input.lineUserId && LINE_USER_ID.test(input.lineUserId)) {
        sent = (await createAndPush(db, {
            ...common, id: `line:gate-in:${reference}`, channel: 'line', recipient: input.lineUserId,
        })) || sent;
    }
    const email = input.contactEmail?.trim();
    if (env.line.autoEmailNotificationsEnabled && email) {
        sent = (await createAndPush(db, {
            ...common, id: `email:gate-in:${reference}`, channel: 'email', recipient: email,
        })) || sent;
    }
    return sent;
}
export async function runDailyLineReminders(db, now = new Date()) {
    if ((!env.line.autoNotificationsEnabled || !env.line.channelAccessToken)
        && !env.line.autoEmailNotificationsEnabled)
        return 0;
    const candidates = await db
        .select({
        tag: boxes.tag,
        dueAt: boxes.dueAt,
        customerId: customers.id,
        customerName: customers.name,
        lineUserId: customers.lineUserId,
        contactEmail: customers.contactEmail,
    })
        .from(boxes)
        .innerJoin(customers, eq(boxes.customer, customers.id))
        .where(and(eq(boxes.status, 'out'), isNotNull(boxes.dueAt), isNull(customers.deletedAt)));
    const groups = new Map();
    for (const candidate of candidates) {
        if (!candidate.dueAt)
            continue;
        const stage = classifyReminderStage(candidate.dueAt, now);
        if (!stage)
            continue;
        const group = groups.get(candidate.customerId) ?? {
            customerName: candidate.customerName ?? candidate.customerId,
            lineUserId: candidate.lineUserId,
            contactEmail: candidate.contactEmail,
            rows: [],
        };
        group.rows.push({ tag: candidate.tag, dueAt: candidate.dueAt, stage });
        groups.set(candidate.customerId, group);
    }
    const businessDate = businessDateKey(now);
    let sent = 0;
    for (const [customerId, group] of groups) {
        const common = {
            kind: 'daily_reminder', customerId, customerName: group.customerName, businessDate,
            message: buildDailyReminderMessage(group.customerName, group.rows),
            metadata: {
                stages: Object.fromEntries(STAGE_ORDER.map((stage) => [stage, group.rows.filter((row) => row.stage === stage).map((row) => row.tag)])),
            },
        };
        if (env.line.autoNotificationsEnabled && env.line.channelAccessToken && group.lineUserId && LINE_USER_ID.test(group.lineUserId)) {
            if (await createAndPush(db, { ...common, id: `line:daily:${businessDate}:${customerId}`, channel: 'line', recipient: group.lineUserId }))
                sent += 1;
        }
        if (env.line.autoEmailNotificationsEnabled && group.contactEmail?.trim()) {
            if (await createAndPush(db, { ...common, id: `email:daily:${businessDate}:${customerId}`, channel: 'email', recipient: group.contactEmail.trim() }))
                sent += 1;
        }
    }
    return sent;
}
export async function retryFailedLineNotifications(db) {
    if ((!env.line.autoNotificationsEnabled || !env.line.channelAccessToken)
        && !env.line.autoEmailNotificationsEnabled)
        return 0;
    const failures = await db
        .select()
        .from(lineNotificationDeliveries)
        .where(and(eq(lineNotificationDeliveries.status, 'failed'), lt(lineNotificationDeliveries.attemptCount, MAX_ATTEMPTS)))
        .limit(50);
    let sent = 0;
    for (const failure of failures) {
        const [claimed] = await db
            .update(lineNotificationDeliveries)
            .set({ status: 'processing', attemptCount: failure.attemptCount + 1, updatedAt: new Date() })
            .where(and(eq(lineNotificationDeliveries.id, failure.id), eq(lineNotificationDeliveries.status, 'failed')))
            .returning();
        if (claimed && (await pushDelivery(db, claimed)))
            sent += 1;
    }
    return sent;
}
function zonedDateTimeToUtc(date, hour, minute) {
    let timestamp = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
    for (let index = 0; index < 2; index += 1) {
        const actual = dateParts(new Date(timestamp));
        const desiredWallClock = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
        const actualWallClock = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
        timestamp += desiredWallClock - actualWallClock;
    }
    return new Date(timestamp);
}
function nextRun(now) {
    const local = dateParts(now);
    let candidate = zonedDateTimeToUtc(local, env.line.autoHour, env.line.autoMinute);
    if (candidate.getTime() <= now.getTime()) {
        const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
        candidate = zonedDateTimeToUtc({ year: tomorrow.getUTCFullYear(), month: tomorrow.getUTCMonth() + 1, day: tomorrow.getUTCDate() }, env.line.autoHour, env.line.autoMinute);
    }
    return candidate;
}
/** Starts one daily 08:30 scheduler plus a small durable-outbox retry loop. */
export function startAutoLineScheduler(db) {
    if (!env.line.autoNotificationsEnabled) {
        console.log('[auto-line] disabled');
        return () => undefined;
    }
    let dailyTimer;
    const executeDaily = async () => {
        try {
            const sent = await runDailyLineReminders(db);
            console.log('[auto-line] daily run complete', { sent, businessDate: businessDateKey(new Date()) });
        }
        catch (error) {
            console.error('[auto-line] daily run failed', error);
        }
        finally {
            scheduleNext();
        }
    };
    const scheduleNext = () => {
        const next = nextRun(new Date());
        dailyTimer = setTimeout(executeDaily, Math.max(1_000, next.getTime() - Date.now()));
        dailyTimer.unref();
        console.log('[auto-line] next daily run', { at: next.toISOString(), timeZone: env.line.autoTimezone });
    };
    // If a deployment restarts after 08:30, run today's idempotent catch-up once.
    const local = dateParts(new Date());
    if (local.hour * 60 + local.minute >= env.line.autoHour * 60 + env.line.autoMinute) {
        void runDailyLineReminders(db).catch((error) => console.error('[auto-line] startup catch-up failed', error));
    }
    void retryFailedLineNotifications(db).catch((error) => console.error('[auto-line] startup retry failed', error));
    const retryTimer = setInterval(() => {
        void retryFailedLineNotifications(db).catch((error) => console.error('[auto-line] retry failed', error));
    }, RETRY_INTERVAL_MS);
    retryTimer.unref();
    scheduleNext();
    return () => {
        if (dailyTimer)
            clearTimeout(dailyTimer);
        clearInterval(retryTimer);
    };
}
//# sourceMappingURL=autoLineNotifications.js.map