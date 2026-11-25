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

/* Each file stays under the 10-requests-per-15-minutes limit that forgot-password
   and reset-password share, which is why these are not in forgot-password.test.ts. */
describe('POST /api/auth/reset-password — one failure for every cause', () => {
  it('works end to end: the emailed code sets a new password', async () => {
    await forgot('reset1');
    const otp = await sentOtp();
    const ok = await reset('reset1', otp, 'brandnew1');
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();

    const login = await request(ctx.app).post('/api/auth/login').send({ username: 'reset1', password: 'brandnew1' });
    expect(login.status).toBe(200);
    // the code is single use
    const again = await reset('reset1', otp, 'another1');
    expect(again.status).toBe(400);
  });

  it('unknown account, nothing pending, wrong code and expired code all fail identically', async () => {
    // wrong code on an account with a request pending
    await forgot('reset1');
    await sentOtp();
    vi.mocked(sendMail).mockClear();
    const wrong = await reset('reset1', '000000');

    // nothing pending (this account never asked)
    const none = await reset('noemail1', '123456');

    // unknown account
    const unknown = await reset('no-such-user', '123456');

    // expired
    await forgot('reset1');
    const otp = await sentOtp();
    await getDb()
      .update(users)
      .set({ passwordResetExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(users.username, 'reset1'));
    const expired = await reset('reset1', otp);

    for (const res of [wrong, none, unknown, expired]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('otp_invalid');
    }
    expect(new Set([wrong, none, unknown, expired].map((r) => r.body.message)).size).toBe(1);
  });
});
