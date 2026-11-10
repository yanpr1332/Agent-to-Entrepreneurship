import { randomUUID } from "node:crypto";
import { SJTU_MAIL_HOST, SJTU_SMTP_PORT, type CampusMailCredentials, type MailDraft } from "../../shared/mail-model";
import { connectMailTls, type MailWire, type MailWireFactory } from "./mail-wire";

function base64Lines(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
}

/** A plain-text SMTP MIME message: no HTML execution or attachment support. */
export function formatSmtpMessage(from: string, draft: MailDraft): string {
  const subject = Buffer.from(draft.subject, "utf8").toString("base64");
  const messageId = randomUUID();
  return [
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}@agent-to-entrepreneurship.local>`,
    `From: <${from}>`,
    `To: ${draft.to.map(address => `<${address}>`).join(", ")}`,
    `Subject: =?UTF-8?B?${subject}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(draft.body),
  ].join("\r\n");
}

async function smtpReply(wire: MailWire, expected: number[]): Promise<string[]> {
  let code = 0;
  const lines: string[] = [];
  for (let index = 0; index < 50; index++) {
    const line = await wire.readLine();
    const match = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!match) throw new Error("SMTP returned a malformed reply");
    const nextCode = Number(match[1]);
    if (code !== 0 && nextCode !== code) throw new Error("SMTP returned inconsistent reply lines");
    code = nextCode;
    lines.push(match[3]);
    if (match[2] !== "-") {
      if (!expected.includes(code)) throw new Error(`SMTP operation rejected (code ${code})`);
      return lines;
    }
  }
  throw new Error("SMTP returned too many reply lines");
}

export class SmtpSender {
  constructor(
    private readonly wireFactory: MailWireFactory = connectMailTls,
    private readonly host: string = SJTU_MAIL_HOST,
    private readonly port: number = SJTU_SMTP_PORT,
  ) {}

  async send(credentials: CampusMailCredentials, draft: MailDraft): Promise<void> {
    const wire = await this.wireFactory(this.host, this.port);
    let dataStarted = false;
    try {
      await smtpReply(wire, [220]);
      await wire.write("EHLO ate-workspace.local\r\n");
      const capabilities = await smtpReply(wire, [250]);
      if (!capabilities.some(line => /^(?:AUTH\s+|AUTH=).*\bPLAIN\b/i.test(line))) {
        throw new Error("SMTP server does not advertise the required AUTH PLAIN method");
      }
      const auth = Buffer.from(`\0${credentials.username}\0${credentials.password}`).toString("base64");
      await wire.write(`AUTH PLAIN ${auth}\r\n`);
      await smtpReply(wire, [235]);

      await wire.write(`MAIL FROM:<${credentials.email}>\r\n`);
      await smtpReply(wire, [250]);
      for (const recipient of draft.to) {
        await wire.write(`RCPT TO:<${recipient}>\r\n`);
        await smtpReply(wire, [250, 251]);
      }
      await wire.write("DATA\r\n");
      await smtpReply(wire, [354]);
      // After this point, delivery may be uncertain on connection failure.
      dataStarted = true;
      await wire.write(`${formatSmtpMessage(credentials.email, draft)}\r\n.\r\n`);
      await smtpReply(wire, [250]);
      dataStarted = false;
      // Once DATA is acknowledged, a failed QUIT must never turn a successful
      // send into a misleading "send failed" result.
      try {
        await wire.write("QUIT\r\n");
        await smtpReply(wire, [221]);
      } catch {
        // SMTP has already acknowledged responsibility for delivery.
      }
    } catch {
      if (dataStarted) {
        throw new Error("SMTP send acknowledgement was lost; delivery status is uncertain. Check Sent Mail before sending again");
      }
      throw new Error("SMTP could not send the message; check the mailbox settings or authentication");
    } finally {
      wire.close();
    }
  }
}
