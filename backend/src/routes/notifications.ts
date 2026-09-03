import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { customers } from '../db/schema.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { pushLineText } from '../services/lineMessaging.js';
import { sendMail } from '../lib/mailer.js';
import { writeAuditLog } from '../services/audit.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);
notificationsRouter.use(requirePermission('partner.update'));
notificationsRouter.use(rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'ส่งแจ้งเตือนถี่เกินไป กรุณารอสักครู่' },
}));

const requestSchema = z.object({
  customerId: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1, 'กรุณาระบุข้อความ').max(5000, 'ข้อความยาวเกิน 5,000 ตัวอักษร'),
  channel: z.enum(['line', 'email']).default('line'),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Messaging API accepts the immutable recipient id from a LINE webhook, not a user's LINE ID/username.
const LINE_MESSAGING_USER_ID = /^U[0-9a-f]{32}$/i;

notificationsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = requestSchema.parse(req.body);
    const db = getDb();
    const [customer] = await db
      .select({ id: customers.id, name: customers.name, lineUserId: customers.lineUserId, contactEmail: customers.contactEmail })
      .from(customers)
      .where(and(eq(customers.id, input.customerId), isNull(customers.deletedAt)))
      .limit(1);
    if (!customer) throw httpError(404, 'ไม่พบข้อมูลลูกค้า', 'customer_not_found');
    const headerKey = String(req.header('Idempotency-Key') ?? '').trim();
    const retryKey = UUID.test(headerKey) ? headerKey : randomUUID();
    if (input.channel === 'email') {
      const email = customer.contactEmail?.trim();
      if (!email) throw httpError(400, 'ลูกค้ารายนี้ยังไม่มีอีเมล กรุณาเพิ่มในข้อมูลลูกค้าก่อน', 'customer_email_missing');
      await sendMail({
        to: email,
        subject: 'แจ้งเตือนสถานะกล่อง — Box Tracking',
        text: input.message,
      });
      await writeAuditLog(db, {
        action: 'NOTIFY_CUSTOMER_EMAIL', actor: req.user!.username, itemId: customer.id,
        itemName: customer.name ?? customer.id, after: { channel: 'EMAIL', recipient: email, messageLength: input.message.length },
      });
      return res.json({ ok: true, message: 'ส่งแจ้งเตือนผ่านอีเมลแล้ว', customerId: customer.id, channel: 'email' });
    }
    const lineUserId = customer.lineUserId?.trim();
    if (!lineUserId) throw httpError(400, 'ลูกค้ารายนี้ยังไม่มี LINE User ID กรุณาเพิ่มในข้อมูลลูกค้าก่อน', 'line_user_id_missing');
    if (!LINE_MESSAGING_USER_ID.test(lineUserId)) throw httpError(400, 'LINE User ID ต้องเป็นค่าจาก webhook ที่ขึ้นต้นด้วย U และมี 33 ตัวอักษร ไม่ใช่ LINE ID หรือ username', 'line_user_id_invalid');
    const lineRequestId = await pushLineText({ to: lineUserId, text: input.message, retryKey });

    await writeAuditLog(db, {
      action: 'NOTIFY_CUSTOMER_LINE',
      actor: req.user!.username,
      itemId: customer.id,
      itemName: customer.name ?? customer.id,
      after: { channel: 'LINE', retryKey, lineRequestId, messageLength: input.message.length },
    });
    res.json({ ok: true, message: 'ส่งแจ้งเตือนผ่าน LINE แล้ว', customerId: customer.id, lineRequestId });
  }),
);

export default notificationsRouter;
