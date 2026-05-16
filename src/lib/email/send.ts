import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

type SendEmailArgs = Parameters<typeof resend.emails.send>[0];

export async function sendEmail(args: SendEmailArgs) {
  const override = process.env.TEST_OVERRIDE_EMAIL;

  if (override) {
    const originalTo = Array.isArray(args.to) ? args.to.join(", ") : args.to;
    return resend.emails.send({
      ...args,
      to: override,
      subject: `[Originally to: ${originalTo}] ${args.subject}`,
    });
  }

  return resend.emails.send(args);
}
