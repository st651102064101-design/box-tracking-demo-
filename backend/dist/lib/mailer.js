import nodemailer from 'nodemailer';
import { env } from '../env.js';
import { httpError } from '../middleware/error.js';
let transporter = null;
function getTransporter() {
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
export async function sendMail(opts) {
    await getTransporter().sendMail({
        from: env.smtp.from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        html: opts.html,
    });
}
//# sourceMappingURL=mailer.js.map