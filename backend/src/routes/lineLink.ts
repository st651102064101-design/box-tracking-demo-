import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { env } from '../env.js';
import { getDb } from '../db/client.js';
import { customers, lineLinkInvites } from '../db/schema.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/error.js';
import { writeAuditLog } from '../services/audit.js';
import { pushLineFlex } from '../services/lineMessaging.js';

export const lineLinkRouter = Router();

const createSchema = z.object({ customerId: z.string().trim().min(1).max(80) });
const unlinkSchema = z.object({ customerId: z.string().trim().min(1).max(80) });
const LINE_USER_ID = /^U[0-9a-f]{32}$/i;
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const secret = () => randomBytes(32).toString('base64url');

/** Existing links made before profile fields were added can be hydrated from
 * Messaging API if the account is still a friend of the OA. Failure is
 * intentionally non-fatal: the binding itself remains valid. */
async function fetchMessagingProfile(userId: string) {
  if (!env.line.channelAccessToken || !LINE_USER_ID.test(userId)) return null;
  try {
    const response = await fetch(`${env.line.apiBaseUrl}/v2/bot/profile/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${env.line.channelAccessToken}` },
      signal: AbortSignal.timeout(Math.min(env.line.timeoutMs, 5000)),
    });
    if (!response.ok) return null;
    const body = await response.json() as { displayName?: string; pictureUrl?: string };
    return { displayName: body.displayName?.trim() || '', pictureUrl: body.pictureUrl?.trim() || '' };
  } catch { return null; }
}

function configured() {
  return Boolean(
    env.line.loginChannelId &&
    env.line.loginChannelSecret &&
    env.line.loginRedirectUri &&
    env.line.publicBaseUrl,
  );
}

function lineOaChatUrl() {
  const basicId = (env.line.oaBasicId || '').trim();
  if (!/^@[a-z0-9._-]+$/i.test(basicId)) return 'https://line.me/';
  /* Android's LINE app-link resolver is more reliable with the canonical
     literal @ form here (for example /R/ti/p/@my-official-account), rather
     than receiving %40 through the final OAuth redirect. */
  return `https://line.me/R/ti/p/${basicId}`;
}

function resultPage(title: string, detail: string, ok: boolean) {
  const color = ok ? '#84cc16' : '#ef4444';
  /* Use LINE's OA-message universal link. It opens the OA chat in LINE and is
     accepted by iOS/Safari, unlike a scripted line:// navigation which iOS can
     reject with an "unsupported link" alert. */
  const lineChatUrl = lineOaChatUrl();
  /* Helmet blocks inline scripts. Keep the target in a data attribute and run
     the timer from a same-origin script endpoint allowed by CSP. */
  const redirect = '';
  const actions = ok ? `<a href="${lineChatUrl}" style="display:inline-block;margin-top:24px;padding:13px 20px;border-radius:12px;background:#84cc16;color:#111;text-decoration:none;font-weight:800">เปิดแชท Box Tracking ใน LINE</a><p style="color:#777;font-size:12px;line-height:1.55;margin:14px 0 0">แตะปุ่มนี้บนมือถือเพื่อเปิดแชทในแอป LINE โดยตรง</p>` : '<p style="color:#777;font-size:13px;margin-top:24px">ปิดหน้านี้แล้วกลับไปที่ LINE ได้เลย</p>';
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body data-line-target="${lineChatUrl}" style="margin:0;background:#101012;color:#f5f5f5;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh"><main style="width:min(520px,calc(100% - 40px));background:#19191c;border:1px solid #333;border-radius:20px;padding:32px;text-align:center"><div style="width:64px;height:64px;margin:auto;border-radius:50%;display:grid;place-items:center;background:${color};color:#111;font-size:34px;font-weight:800">${ok ? '✓' : '!'}</div><h1 style="font-size:24px;margin:20px 0 8px">${title}</h1><p style="color:#aaa;line-height:1.65;margin:0">${detail}</p>${actions}</main>${redirect}</body></html>`;
}

lineLinkRouter.get('/redirect.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(`(function(){
    var el=document.getElementById('lineRedirectCountdown');
    var target=(document.body&&document.body.getAttribute('data-line-target'))||'';
    var remaining=3;
    if(el)el.textContent=String(remaining);
    var timer=setInterval(function(){
      remaining-=1;
      if(remaining>0){if(el)el.textContent=String(remaining);return;}
      clearInterval(timer);
      if(el)el.textContent='0';
      if(target)window.location.replace(target);
    },1000);
  }());`);
});

/** Admin creates a one-time, opaque invitation. Customer IDs never appear in
 * the public URL and the raw bearer token is never stored in PostgreSQL. */
lineLinkRouter.post('/unlink', requireAuth, requirePermission('partner.update'), asyncHandler(async (req, res) => {
  const { customerId } = unlinkSchema.parse(req.body);
  const db = getDb();
  const [customer] = await db.select({ id: customers.id, name: customers.name, lineUserId: customers.lineUserId, lineDisplayName: customers.lineDisplayName, data: customers.data })
    .from(customers).where(and(eq(customers.id, customerId), isNull(customers.deletedAt))).limit(1);
  if (!customer) throw httpError(404, 'ไม่พบข้อมูลลูกค้า', 'customer_not_found');
  // Deliver the final notice while the old Messaging User ID still exists.
  // A push failure must not prevent the administrator from revoking access.
  if (customer.lineUserId && LINE_USER_ID.test(customer.lineUserId)) {
    try {
      await pushLineFlex({
        to: customer.lineUserId,
        retryKey: randomUUID(),
        altText: 'ยกเลิกการเชื่อมต่อ Box Tracking สำเร็จ',
        contents: {
          type: 'bubble',
          size: 'kilo',
          header: {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#5A1515',
            paddingAll: '18px',
            contents: [{ type: 'text', text: '⚠️  ยกเลิกการเชื่อมต่อสำเร็จ', color: '#FFFFFF', weight: 'bold', size: 'lg', wrap: true }],
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            paddingAll: '20px',
            contents: [
              {
                type: 'text',
                text: 'บัญชี LINE ของท่านได้ถูกยกเลิกการเชื่อมต่อกับฐานข้อมูลลูกค้าแล้ว ท่านจะไม่ได้รับการแจ้งเตือนสถานะกล่องหมุนเวียนใด ๆ ผ่านช่องทางนี้อีกต่อไป',
                size: 'sm',
                color: '#343434',
                wrap: true,
              },
              { type: 'separator', margin: 'md' },
              {
                type: 'text',
                text: '🔗 หากต้องการกลับมารับการแจ้งเตือนอีกครั้ง กรุณาติดต่อแอดมินหรือเซลส์เพื่อขอรับลิงก์ลงทะเบียนใหม่ครับ 🙏',
                size: 'sm',
                color: '#7D4C00',
                wrap: true,
              },
            ],
          },
        },
      });
    } catch (error) {
      console.warn('[line-link] unlink notice push failed', error instanceof Error ? error.message : error);
    }
  }
  /* Revoke every outstanding invitation as part of an unlink.  This makes a
     newly generated invitation the only usable invitation for this customer. */
  await db.update(lineLinkInvites)
    .set({ consumedAt: new Date() })
    .where(and(eq(lineLinkInvites.customerId, customerId), isNull(lineLinkInvites.consumedAt)));
  const nextData = { ...((customer.data ?? {}) as Record<string, unknown>) }; delete nextData.lineUserId;
  await db.update(customers).set({ lineUserId: null, lineDisplayName: null, linePictureUrl: null, lineLinkedAt: null, data: nextData, updatedAt: new Date() }).where(eq(customers.id, customerId));
  await writeAuditLog(db, { action: 'UNLINK_CUSTOMER_LINE', actor: req.user!.username, itemId: customer.id, itemName: customer.name ?? customer.id, before: { linked: Boolean(customer.lineUserId) }, after: { linked: false } });
  res.json({ ok: true });
}));

/** Profile snapshot for the admin UI. Deliberately excludes the Messaging User ID. */
lineLinkRouter.get('/customers/:customerId/profile', requireAuth, requirePermission('partner.update'), asyncHandler(async (req, res) => {
  const customerId = z.string().trim().min(1).max(80).parse(req.params.customerId);
  const db = getDb();
  const [customer] = await db.select({
    id: customers.id, name: customers.name, lineUserId: customers.lineUserId,
    lineDisplayName: customers.lineDisplayName, linePictureUrl: customers.linePictureUrl,
    lineLinkedAt: customers.lineLinkedAt,
  }).from(customers).where(and(eq(customers.id, customerId), isNull(customers.deletedAt))).limit(1);
  if (!customer) throw httpError(404, 'ไม่พบข้อมูลลูกค้า', 'customer_not_found');
  let displayName = customer.lineDisplayName ?? '';
  let pictureUrl = customer.linePictureUrl ?? '';
  let linkedAt = customer.lineLinkedAt;
  if (customer.lineUserId && (!displayName || !pictureUrl)) {
    const latest = await fetchMessagingProfile(customer.lineUserId);
    if (latest) {
      displayName = latest.displayName || displayName;
      pictureUrl = latest.pictureUrl || pictureUrl;
      linkedAt ??= new Date();
      await db.update(customers).set({ lineDisplayName: displayName || null, linePictureUrl: pictureUrl || null, lineLinkedAt: linkedAt, updatedAt: new Date() }).where(eq(customers.id, customer.id));
    }
  }
  res.json({
    customerId: customer.id,
    linked: Boolean(customer.lineUserId),
    displayName,
    pictureUrl,
    linkedAt: linkedAt?.toISOString() ?? null,
  });
}));

lineLinkRouter.post(
  '/invitations',
  requireAuth,
  requirePermission('partner.update'),
  asyncHandler(async (req, res) => {
    if (!configured()) {
      throw httpError(503, 'ยังไม่ได้ตั้งค่า LINE Login Channel และ Public URL', 'line_login_not_configured');
    }
    const { customerId } = createSchema.parse(req.body);
    const db = getDb();
    const [customer] = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(and(eq(customers.id, customerId), isNull(customers.deletedAt)))
      .limit(1);
    if (!customer) throw httpError(404, 'ไม่พบข้อมูลลูกค้า', 'customer_not_found');

    const token = secret();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.insert(lineLinkInvites).values({
      tokenHash: hash(token),
      customerId,
      expiresAt,
      createdBy: req.user!.username,
    });
    await writeAuditLog(db, {
      action: 'CREATE_LINE_LINK_INVITE',
      actor: req.user!.username,
      itemId: customer.id,
      itemName: customer.name ?? customer.id,
      after: { expiresAt: expiresAt.toISOString() },
    });
    res.status(201).json({
      ok: true,
      url: `${env.line.publicBaseUrl}/api/line/link/login?token=${encodeURIComponent(token)}`,
      expiresAt: expiresAt.toISOString(),
    });
  }),
);

/** Public invitation entrypoint. Starts Authorization Code + PKCE and stores
 * state/nonce server-side to prevent CSRF and replay. */
lineLinkRouter.get(
  '/login',
  asyncHandler(async (req, res) => {
    if (!configured()) return res.status(503).send(resultPage('ยังไม่พร้อมใช้งาน', 'ผู้ดูแลระบบยังตั้งค่า LINE Login ไม่ครบ', false));
    const token = z.string().min(20).max(200).parse(req.query.token);
    const db = getDb();
    const [invite] = await db
      .select({ id: lineLinkInvites.id, customerId: lineLinkInvites.customerId, consumedAt: lineLinkInvites.consumedAt, expiresAt: lineLinkInvites.expiresAt })
      .from(lineLinkInvites)
      .where(eq(lineLinkInvites.tokenHash, hash(token)))
      .limit(1);
    if (!invite) return res.status(404).send(resultPage('ลิงก์ไม่ถูกต้อง', 'ไม่พบลิงก์เชิญนี้ กรุณาขอลิงก์ใหม่จากผู้ดูแลระบบ', false));
    if (invite.consumedAt) return res.status(409).send(resultPage('ลิงก์นี้ถูกใช้ไปแล้ว', 'บัญชี LINE ถูกผูกสำเร็จแล้ว ลิงก์เชิญหนึ่งรายการใช้ได้เพียงครั้งเดียว', false));
    if (invite.expiresAt <= new Date()) return res.status(410).send(resultPage('ลิงก์หมดอายุแล้ว', 'กรุณาขอลิงก์ใหม่จากผู้ดูแลระบบ', false));
    const [customer] = await db.select({ lineUserId: customers.lineUserId })
      .from(customers).where(and(eq(customers.id, invite.customerId), isNull(customers.deletedAt))).limit(1);
    if (!customer) return res.status(404).send(resultPage('ไม่พบลูกค้า', 'ข้อมูลลูกค้านี้ถูกลบหรือปิดใช้งานแล้ว', false));
    if (customer.lineUserId) return res.status(409).send(resultPage('ลูกค้านี้ผูก LINE แล้ว', 'ไม่สามารถใช้ QR เดิมเพื่อผูกซ้ำได้ ผู้ดูแลระบบต้องเลือกสร้างลิงก์ใหม่ก่อน', false));

    const state = secret();
    const nonce = secret();
    const codeVerifier = secret();
    await db.update(lineLinkInvites).set({
      oauthStateHash: hash(state),
      nonce,
      codeVerifier,
    }).where(eq(lineLinkInvites.id, invite.id));

    const authorize = new URL('https://access.line.me/oauth2/v2.1/authorize');
    const authorizeParams: Record<string, string> = {
      response_type: 'code',
      client_id: env.line.loginChannelId,
      redirect_uri: env.line.loginRedirectUri,
      state,
      scope: 'profile openid',
      nonce,
      /* Keep the add-friend option in the normal consent screen.  The
       * aggressive flow adds a second LINE-controlled transition and has
       * proven unreliable in Android in-app WebViews/emulators. */
      bot_prompt: 'normal',
      code_challenge: hash(codeVerifier),
      code_challenge_method: 'S256',
      ui_locales: 'th',
    };
    /* Keep Auto Login enabled on the initial authorization request. LINE can
     * hand Android users from its scanner/in-app browser to the signed-in LINE
     * app without asking for credentials. `disable_auto_login=true` belongs
     * only in an explicit retry flow after LINE reports an Auto Login failure. */
    authorize.search = new URLSearchParams(authorizeParams).toString();
    res.redirect(302, authorize.toString());
  }),
);

lineLinkRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    if (!configured()) return res.status(503).send(resultPage('ยังไม่พร้อมใช้งาน', 'ผู้ดูแลระบบยังตั้งค่า LINE Login ไม่ครบ', false));
    if (req.query.error) return res.status(400).send(resultPage('ยกเลิกการเชื่อมต่อ', 'ยังไม่ได้อนุญาตให้ Box Tracking เข้าถึงโปรไฟล์ LINE', false));
    const parsed = z.object({ code: z.string().min(1), state: z.string().min(20).max(200) }).safeParse(req.query);
    if (!parsed.success) return res.status(400).send(resultPage('ลิงก์ไม่ถูกต้อง', 'ไม่พบข้อมูลยืนยันจาก LINE', false));

    const db = getDb();
    const [invite] = await db
      .select({
        id: lineLinkInvites.id,
        customerId: lineLinkInvites.customerId,
        nonce: lineLinkInvites.nonce,
        codeVerifier: lineLinkInvites.codeVerifier,
        createdBy: lineLinkInvites.createdBy,
      })
      .from(lineLinkInvites)
      .where(and(
        eq(lineLinkInvites.oauthStateHash, hash(parsed.data.state)),
        isNull(lineLinkInvites.consumedAt),
        gt(lineLinkInvites.expiresAt, new Date()),
      ))
      .limit(1);
    if (!invite?.nonce || !invite.codeVerifier) return res.status(410).send(resultPage('ลิงก์ใช้ไม่ได้แล้ว', 'ลิงก์หมดอายุ ถูกใช้แล้ว หรือไม่ได้เริ่มจากลิงก์เชิญ', false));

    const tokenResponse = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: parsed.data.code,
        redirect_uri: env.line.loginRedirectUri,
        client_id: env.line.loginChannelId,
        client_secret: env.line.loginChannelSecret,
        code_verifier: invite.codeVerifier,
      }),
      signal: AbortSignal.timeout(Math.min(env.line.timeoutMs, 15000)),
    });
    const tokenBody = await tokenResponse.json() as { id_token?: string; error_description?: string };
    if (!tokenResponse.ok || !tokenBody.id_token) {
      return res.status(502).send(resultPage('เชื่อมต่อ LINE ไม่สำเร็จ', 'LINE ไม่ยอมรับรหัสยืนยัน กรุณาขอลิงก์ใหม่แล้วลองอีกครั้ง', false));
    }

    const verifyResponse = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        id_token: tokenBody.id_token,
        client_id: env.line.loginChannelId,
        nonce: invite.nonce,
      }),
      signal: AbortSignal.timeout(Math.min(env.line.timeoutMs, 15000)),
    });
    const profile = await verifyResponse.json() as { sub?: string; name?: string; picture?: string };
    if (!verifyResponse.ok || !profile.sub || !LINE_USER_ID.test(profile.sub)) {
      return res.status(502).send(resultPage('ยืนยันตัวตนไม่สำเร็จ', 'ไม่สามารถตรวจสอบ LINE User ID ได้ กรุณาขอลิงก์ใหม่', false));
    }

    const [duplicate] = await db.select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(and(eq(customers.lineUserId, profile.sub), ne(customers.id, invite.customerId), isNull(customers.deletedAt)))
      .limit(1);
    if (duplicate) return res.status(409).send(resultPage('บัญชีนี้ถูกใช้งานแล้ว', `LINE บัญชีนี้ผูกกับลูกค้า ${duplicate.name ?? duplicate.id} อยู่แล้ว`, false));

    const [customer] = await db.select({ id: customers.id, name: customers.name, data: customers.data, lineUserId: customers.lineUserId })
      .from(customers).where(and(eq(customers.id, invite.customerId), isNull(customers.deletedAt))).limit(1);
    if (!customer) return res.status(404).send(resultPage('ไม่พบลูกค้า', 'ข้อมูลลูกค้าถูกลบหรือปิดใช้งานแล้ว', false));

    await db.transaction(async (tx) => {
      const claimed = await tx.update(lineLinkInvites).set({ consumedAt: new Date() })
        .where(and(eq(lineLinkInvites.id, invite.id), isNull(lineLinkInvites.consumedAt)))
        .returning({ id: lineLinkInvites.id });
      if (!claimed.length) throw httpError(409, 'ลิงก์นี้ถูกใช้ไปแล้ว', 'line_link_already_used');
      await tx.update(customers).set({
        lineUserId: profile.sub,
        lineDisplayName: profile.name ?? null,
        linePictureUrl: profile.picture ?? null,
        lineLinkedAt: new Date(),
        data: { ...(customer.data as Record<string, unknown>), lineUserId: profile.sub },
        updatedAt: new Date(),
      }).where(eq(customers.id, customer.id));
      await writeAuditLog(tx, {
        action: 'LINK_CUSTOMER_LINE',
        actor: invite.createdBy,
        itemId: customer.id,
        itemName: customer.name ?? customer.id,
        before: { linked: Boolean(customer.lineUserId) },
        after: { linked: true, lineDisplayName: profile.name ?? '' },
      });
    });
    /* A re-link does not create a new LINE chat and LINE does not expose an
       API to clear its history.  Send a fresh confirmation into the existing
       chat instead; notification delivery is already enabled by this point. */
    try {
      const displayName = profile.name?.trim() || 'ลูกค้า';
      const customerName = customer.name?.trim() || customer.id;
      await pushLineFlex({
        to: profile.sub,
        retryKey: randomUUID(),
        altText: `ผูกบัญชี Box Tracking กับ ${customerName} สำเร็จแล้ว`,
        contents: {
          type: 'bubble',
          size: 'kilo',
          header: {
            type: 'box',
            layout: 'vertical',
            backgroundColor: '#173300',
            paddingAll: '18px',
            contents: [{
              type: 'text',
              text: '✅  ผูกบัญชีสำเร็จ!',
              color: '#A6FF2E',
              weight: 'bold',
              size: 'xl',
            }],
          },
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'md',
            paddingAll: '20px',
            contents: [
              { type: 'text', text: `ยินดีต้อนรับคุณ ${displayName}`, weight: 'bold', size: 'lg', wrap: true },
              {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#F3F6EF',
                cornerRadius: '10px',
                paddingAll: '12px',
                contents: [
                  { type: 'text', text: 'เชื่อมต่อกับลูกค้า', size: 'xs', color: '#6B7265' },
                  { type: 'text', text: customerName, weight: 'bold', size: 'md', margin: 'sm', wrap: true },
                ],
              },
              {
                type: 'text',
                text: 'คุณจะได้รับการแจ้งเตือนสถานะกล่องหมุนเวียน (รับ-ส่ง/ค้างคืน) ผ่านแชทนี้โดยอัตโนมัติ 📦',
                size: 'sm',
                color: '#343A32',
                wrap: true,
              },
              { type: 'separator', margin: 'md' },
              {
                type: 'text',
                text: 'นี่คือระบบอัตโนมัติ หากมีข้อสงสัยโปรดติดต่อฝ่ายบริการลูกค้า',
                size: 'xxs',
                color: '#8A9185',
                wrap: true,
              },
            ],
          },
        },
      });
    } catch (error) {
      console.warn('[line-link] linked but welcome push failed', error instanceof Error ? error.message : error);
    }
    // Linking is complete. Skip the intermediate success page and hand the
    // user directly to the tested LINE OA universal link.
    return res.redirect(302, lineOaChatUrl());
  }),
);
