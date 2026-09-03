import { env } from '../env.js';
import { httpError } from '../middleware/error.js';

interface PushTextInput {
  to: string;
  text: string;
  retryKey: string;
}

interface PushFlexInput {
  to: string;
  altText: string;
  contents: Record<string, unknown>;
  retryKey: string;
}

interface ReplyTextInput {
  replyToken: string;
  text: string;
}

async function lineRequest(path: string, body: unknown) {
  if (!env.line.channelAccessToken) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(env.line.timeoutMs, 5000));
  try {
    const response = await fetch(`${env.line.apiBaseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.line.channelAccessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) console.error('[line-reply]', { status: response.status, body: await response.text() });
  } catch (error) {
    console.error('[line-reply]', { error: error instanceof Error ? error.message : 'unknown' });
  } finally {
    clearTimeout(timer);
  }
}

/** Reply must be used once and promptly with the replyToken supplied by LINE. */
export function replyLineText({ replyToken, text }: ReplyTextInput) {
  return lineRequest('/v2/bot/message/reply', { replyToken, messages: [{ type: 'text', text }] });
}

/** Push one text message through a LINE Official Account.
 * X-Line-Retry-Key makes a timeout-safe retry idempotent on LINE's side. */
export async function pushLineText({ to, text, retryKey }: PushTextInput): Promise<string | null> {
  return pushLineMessages(to, [{ type: 'text', text }], retryKey);
}

/** Push exactly one Flex Message bubble. Keeping this separate from text
 * notifications prevents the account-link flow from producing several
 * overlapping chat balloons. */
export async function pushLineFlex({ to, altText, contents, retryKey }: PushFlexInput): Promise<string | null> {
  return pushLineMessages(to, [{ type: 'flex', altText, contents }], retryKey);
}

async function pushLineMessages(to: string, messages: Array<Record<string, unknown>>, retryKey: string): Promise<string | null> {
  if (!env.line.channelAccessToken) {
    throw httpError(503, 'ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN', 'line_not_configured');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.line.timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${env.line.apiBaseUrl}/v2/bot/message/push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.line.channelAccessToken}`,
        'Content-Type': 'application/json',
        'X-Line-Retry-Key': retryKey,
      },
      body: JSON.stringify({ to, messages }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw httpError(504, 'LINE ตอบกลับช้าเกินกำหนด กรุณาลองใหม่', 'line_timeout');
    }
    throw httpError(502, 'เชื่อมต่อ LINE Messaging API ไม่สำเร็จ', 'line_unavailable');
  } finally {
    clearTimeout(timer);
  }

  const body = (await response.json().catch(() => ({}))) as {
    message?: string;
    details?: Array<{ message?: string }>;
  };
  const requestId = response.headers.get('x-line-request-id');

  // LINE returns 409 when the same retry key was already accepted. Treat that
  // as success: sending again would be the actual bug.
  if (response.status === 409) return requestId;
  if (!response.ok) {
    const detail = body.details?.map((item) => item.message).filter(Boolean).join(', ');
    console.error('[line-push]', { status: response.status, requestId, message: body.message, detail });
    throw httpError(
      response.status === 400 ? 400 : 502,
      response.status === 400 ? 'LINE ID หรือข้อความไม่ถูกต้อง' : 'LINE ไม่สามารถรับข้อความได้ในขณะนี้',
      'line_push_failed',
    );
  }
  return requestId;
}
