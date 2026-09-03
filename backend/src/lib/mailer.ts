import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../env.js';
import { httpError } from '../middleware/error.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!env.smtp.host || !env.smtp.user || !env.smtp.pass) {
    // Fails the request with a clear reason instead of nodemailer's own
    // connection-refused stack trace — an admin reading logs should see
    // "SMTP isn't configured" immediately, not have to guess.
    throw httpError(503, 'ระบบยังไม่ได้ตั้งค่าอีเมล — ติดต่อผู้ดูแลระบบ', 'smtp_not_configured');
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.smtp.host,
      port: env.smtp.port,
      secure: env.smtp.secure,
      auth: { user: env.smtp.user, pass: env.smtp.pass },
    });
  }
  return transporter;
}

export async function sendMail(opts: { to: string; subject: string; text: string; html?: string }): Promise<void> {
  try {
    await getTransporter().sendMail({
      from: env.smtp.from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
  } catch (error) {
    const code = String((error as { code?: string }).code ?? '');
    const message = String((error as { message?: string }).message ?? '');
    if (code === 'EAUTH' || /application-specific password|required/i.test(message)) {
      throw httpError(502, 'Gmail ปฏิเสธการล็อกอิน: กรุณาตั้งค่า SMTP_PASS เป็น Google App Password 16 หลัก', 'smtp_auth_failed');
    }
    throw error;
  }
}
