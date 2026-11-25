import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { getDb } from '../src/db/client.js';
import { users } from '../src/db/schema.js';
import { bootstrap, type TestCtx } from './helpers.js';

/* The mailer is mocked so these tests control "SMTP is configured" and can read
   the OTP out of the message that would have been sent. */
vi.mock('../src/lib/mailer.js', () => ({
  assertMailConfigured: vi.fn(),
  sendMail: vi.fn(async () => {}),
}));
import { sendMail } from '../src/lib/mailer.js';

let ctx: TestCtx;

beforeAll(async () => {
  ctx = await bootstrap();
  await request(ctx.app)
    .post('/api/auth/register')
    .send({ username: 'reset1', password: 'oldpass1', name: 'Reset One', email: 'reset1@example.com' });
  await request(ctx.app)
    .post('/api/auth/register')
    .send({ username: 'noemail1', password: 'oldpass1', name: 'No Email', email: 'noemail1@example.com' });
  await getDb().update(users).set({ email: null }).where(eq(users.username, 'noemail1'));
});

beforeEach(() => {
  vi.mocked(sendMail).mockClear();
});

const forgot = (username: string) => request(ctx.app).post('/api/auth/forgot-password').send({ username });
const reset = (username: string, otp: string, password = 'newpass1') =>
  request(ctx.app).post('/api/auth/reset-password').send({ username, otp, password });

/** Waits for the (deliberately not awaited) mail send to have been attempted. */
async function sentOtp(): Promise<string> {
  await vi.waitFor(() => expect(sendMail).toHaveBeenCalledTimes(1));
  const text = vi.mocked(sendMail).mock.calls[0][0].text;
  const match = /\b(\d{6})\b/.exec(text);
  expect(match).not.toBeNull();
  return match![1];
}

/* forgot-password used to answer differently for real accounts ("sent to
   j****@c****.com", no_email_on_file, an SMTP error), which let anyone enumerate
   usernames. Every case now gets the identical reply. */
describe('POST /api/auth/forgot-password — same answer for every username', () => {
  const replies: Record<string, { status: number; body: unknown }> = {};

  it('unknown username: success with nothing sent', async () => {
    const res = await forgot('no-such-user');
    replies.unknown = { status: res.status, body: res.body };
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sentTo: null });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('real account with an email: the identical body, and the code is emailed to it', async () => {
    const res = await forgot('reset1');
    replies.real = { status: res.status, body: res.body };
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sentTo: null });
    await sentOtp();
    expect(vi.mocked(sendMail).mock.calls[0][0].to).toBe('reset1@example.com');
  });

  it('real account with no email on file: the identical body, no error', async () => {
    const res = await forgot('noemail1');
    replies.noEmail = { status: res.status, body: res.body };
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sentTo: null });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('the three responses above are byte-for-byte equal', () => {
    expect(JSON.stringify(replies.real)).toBe(JSON.stringify(replies.unknown));
    expect(JSON.stringify(replies.noEmail)).toBe(JSON.stringify(replies.unknown));
  });

  it('a failed email send does not turn into an error for real accounts', async () => {
    vi.mocked(sendMail).mockRejectedValueOnce(new Error('smtp down'));
    const res = await forgot('reset1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sentTo: null });
  });
});
