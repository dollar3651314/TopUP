import nodemailer from 'nodemailer';

/** 测试环境发出的邮件，标题前面加上"[测试环境]" */
export const envSubject = (config, subject) => (config?.appEnv === 'staging' ? `[测试环境] ${subject}` : subject);

/**
 * 通用发信：send({ to, subject, text, replyTo })。
 * 配置了 RESEND_API_KEY 用 Resend（https://resend.com/docs/api-reference/emails/send-email），否则用 SMTP。
 */
export function createRawSender(config, fetchImpl = fetch) {
  if (config.resendApiKey) {
    return async ({ to, subject, text, replyTo }) => {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.resendApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: config.mailFrom, to: [to], subject: envSubject(config, subject), text, ...(replyTo ? { reply_to: replyTo } : {}) }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
    };
  }
  const transport = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    disableFileAccess: true, disableUrlAccess: true,
  });
  return async ({ to, subject, text, replyTo }) => {
    await transport.sendMail({ from: config.mailFrom, to, subject: envSubject(config, subject), text, ...(replyTo ? { replyTo } : {}) });
  };
}
