import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { env } from '../env.js';
import { httpError } from '../middleware/error.js';
import { asyncHandler } from '../middleware/error.js';
import { replyLineText } from '../services/lineMessaging.js';

export const lineWebhookRouter = Router();

const greeting = 'สวัสดีครับ ยินดีต้อนรับสู่ระบบ Box Tracking (Smart Asset Tracking) 📦\n\nเพื่อเปิดใช้งานการแจ้งเตือนสถานะกล่องและรับ-ส่งสินค้า กรุณาพิมพ์ “ชื่อบริษัทของท่าน” หรือ “รหัสลูกค้า” ส่งมาในแชทนี้ได้เลยครับ\n\nแอดมินจะตรวจสอบและผูกบัญชี LINE ของท่านเข้ากับระบบ WMS ให้ครับ';
const registrationReply = 'ขอบคุณสำหรับข้อมูลครับ 📝 ระบบได้รับข้อความของคุณเรียบร้อยแล้ว ขณะนี้แอดมินกำลังดำเนินการผูกบัญชี LINE ของท่านเข้ากับฐานข้อมูลลูกค้าในระบบ WMS\n\n🔔 เมื่อผูกบัญชีเสร็จสมบูรณ์ ท่านจะเริ่มได้รับการแจ้งเตือนสถานะกล่องเข้า-ออก และกล่องค้างคืนโดยอัตโนมัติครับ';

function validSignature(rawBody: Buffer, signature: string | undefined) {
  if (!env.line.webhookSecret || !signature) return false;
  const expected = createHmac('sha256', env.line.webhookSecret).update(rawBody).digest('base64');
  const actual = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

lineWebhookRouter.post('/', asyncHandler(async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  // LINE's console "Verify" probe is an empty unsigned POST. Real webhook
  // deliveries contain an event payload and must always pass signature check.
  if (rawBody.length === 0 && !req.header('x-line-signature')) {
    res.status(200).json({ ok: true, verification: true });
    return;
  }
  // The LINE console may include a probe signature generated with a different
  // verification request body. An empty events array has no user data and is
  // only the console probe, so acknowledge it before delivery authentication.
  if (rawBody.length > 0) {
    try {
      const probe = JSON.parse(rawBody.toString('utf8')) as { events?: unknown };
      if (Array.isArray(probe.events) && probe.events.length === 0) {
        res.status(200).json({ ok: true, verification: true });
        return;
      }
    } catch {
      // Continue to signature validation below.
    }
  }
  // Depending on the LINE console version, Verify can send a probe envelope
  // without events (and without a signature). It contains no user event and
  // is safe to acknowledge; any delivery containing a userId still requires
  // the cryptographic signature below.
  if (!req.header('x-line-signature') && rawBody.length > 0) {
    try {
      const probe = JSON.parse(rawBody.toString('utf8')) as { events?: Array<{ source?: { userId?: string } }> };
      const hasUserId = Array.isArray(probe.events) && probe.events.some((event) => Boolean(event.source?.userId));
      if (!hasUserId) {
        res.status(200).json({ ok: true, verification: true });
        return;
      }
    } catch {
      // Fall through to the normal signature error for unsigned non-JSON data.
    }
  }
  if (!validSignature(rawBody, req.header('x-line-signature'))) {
    throw httpError(401, 'ลายเซ็น LINE Webhook ไม่ถูกต้อง', 'line_webhook_signature_invalid');
  }

  let payload: { events?: Array<{ type?: string; replyToken?: string; source?: { userId?: string }; message?: { type?: string; text?: string } }> };
  try {
    payload = JSON.parse(rawBody.toString('utf8')) as typeof payload;
  } catch {
    throw httpError(400, 'ข้อมูล LINE Webhook ไม่ใช่ JSON ที่ถูกต้อง', 'line_webhook_invalid_json');
  }

  /* A Messaging API webhook belongs to the OA, not to a single customer.
     Customer binding is deliberately handled only by the signed LINE Login
     magic-link callback.  Never accept customerId in this public webhook: it
     could otherwise bind any incoming sender to a customer by URL alone. */
  for (const event of payload.events ?? []) {
    if (!event.replyToken) continue;
    if (event.type === 'follow') {
      await replyLineText({ replyToken: event.replyToken, text: greeting });
      continue;
    }
    if (event.type === 'message' && event.message?.type === 'text' && event.message.text?.trim()) {
      await replyLineText({ replyToken: event.replyToken, text: registrationReply });
    }
  }
  res.status(200).json({ ok: true });
}));

export default lineWebhookRouter;
