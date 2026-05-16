import twilio from "twilio";

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

type SendSmsArgs = {
  to: string;
  body: string;
  from?: string;
  [key: string]: unknown;
};

export async function sendSms(args: SendSmsArgs) {
  const override = process.env.TEST_OVERRIDE_PHONE;

  if (override) {
    return client.messages.create({
      ...args,
      to: override,
      body: `[Originally to: ${args.to}] ${args.body}`,
    });
  }

  return client.messages.create(
    args as Parameters<typeof client.messages.create>[0],
  );
}
