import { SJTU_IMAP_PORT, SJTU_MAIL_HOST, type CampusMailCredentials, type MailEnvelope } from "../../shared/mail-model";
import { connectMailTls, type MailWire, type MailWireFactory } from "./mail-wire";

const MAX_MESSAGES_PER_SYNC = 50;
const MAX_SEARCH_IDS = 100_000;

function decodeWord(charset: string, encoding: string, encoded: string): string {
  try {
    let bytes: Buffer;
    if (encoding.toLowerCase() === "b") {
      bytes = Buffer.from(encoded, "base64");
    } else {
      const source = encoded.replace(/_/g, " ");
      const values: number[] = [];
      for (let i = 0; i < source.length; i++) {
        if (source[i] === "=" && /^[0-9a-f]{2}$/i.test(source.slice(i + 1, i + 3))) {
          values.push(parseInt(source.slice(i + 1, i + 3), 16));
          i += 2;
        } else {
          values.push(source.charCodeAt(i));
        }
      }
      bytes = Buffer.from(values);
    }
    return new TextDecoder(charset, {fatal: false}).decode(bytes);
  } catch {
    return "[unsupported email header encoding]";
  }
}

/** RFC 2047 encoded-words, including adjacent encoded tokens. */
export function decodeMailHeader(value: string): string {
  return value.replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)(?:\s+(?==\?[^?]+\?[bq]\?))?/gi, "$1")
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset: string, encoding: string, encoded: string) =>
      decodeWord(charset, encoding, encoded))
    .replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 500);
}

export function parseMailHeaderLiteral(raw: Buffer, uid: number, uidValidity: number): MailEnvelope {
  // Headers are capped before parsing; never render HTML from untrusted mail.
  const unfolded = raw.toString("latin1").replace(/\r?\n[ \t]+/g, " ");
  const fields = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const match = /^([a-z0-9-]+):\s*(.*)$/i.exec(line);
    if (match) fields.set(match[1].toLowerCase(), match[2]);
  }
  const from = decodeMailHeader(fields.get("from") || "(unknown sender)");
  const subject = decodeMailHeader(fields.get("subject") || "(no subject)");
  const rawDate = fields.get("date") ?? "";
  const timestamp = Date.parse(rawDate);
  const id = fields.get("message-id") ?? "";
  return {
    uid, uidValidity, from, subject,
    date: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    messageId: /^[^\r\n]{1,255}$/.test(id) ? id.trim() : null,
  };
}

function quoted(value: string): string {
  if (/[\r\n\x00]/.test(value)) throw new Error("Invalid IMAP login field");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export class ImapInboxReader {
  constructor(
    private readonly wireFactory: MailWireFactory = connectMailTls,
    private readonly host: string = SJTU_MAIL_HOST,
    private readonly port: number = SJTU_IMAP_PORT,
  ) {}

  private async tagged(wire: MailWire, tag: string, command: string): Promise<string[]> {
    await wire.write(`${tag} ${command}\r\n`);
    const lines: string[] = [];
    for (let count = 0; count < 500; count++) {
      const line = await wire.readLine();
      if (line.startsWith(`${tag} `)) {
        if (!/^A\d+ OK(?:\s|$)/i.test(line)) {
          throw new Error("IMAP server rejected the requested operation");
        }
        return lines;
      }
      if (line.length > 1024 * 1024) throw new Error("IMAP response exceeded safe limit");
      lines.push(line);
    }
    throw new Error("IMAP returned too many response lines");
  }

  async readRecent(credentials: CampusMailCredentials): Promise<{uidValidity:number;messages:MailEnvelope[]}> {
    const wire = await this.wireFactory(this.host, this.port);
    let tag = 0;
    const nextTag = () => `A${String(++tag).padStart(4, "0")}`;
    try {
      const greeting = await wire.readLine();
      if (!/^\* (OK|PREAUTH)\b/i.test(greeting)) {
        throw new Error("IMAP greeting was not accepted");
      }
      if (!/^\* PREAUTH\b/i.test(greeting)) {
        await this.tagged(wire, nextTag(),
          `LOGIN ${quoted(credentials.username)} ${quoted(credentials.password)}`);
      }

      // EXAMINE is read-only; fetching header fields uses BODY.PEEK.
      const examine = await this.tagged(wire, nextTag(), 'EXAMINE "INBOX"');
      const validity = examine.map(line => /\[UIDVALIDITY\s+(\d+)\]/i.exec(line))
        .find(Boolean)?.[1];
      const uidValidity = Number(validity);
      if (!Number.isSafeInteger(uidValidity) || uidValidity < 1) {
        throw new Error("IMAP server did not provide a valid UIDVALIDITY");
      }

      const search = await this.tagged(wire, nextTag(), "UID SEARCH ALL");
      const ids: number[] = [];
      for (const line of search) {
        if (!/^\* SEARCH(?:\s|$)/i.test(line)) continue;
        for (const item of line.replace(/^\* SEARCH\s*/i, "").trim().split(/\s+/)) {
          if (!item) continue;
          const id = Number(item);
          if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid IMAP UID");
          ids.push(id);
          if (ids.length > MAX_SEARCH_IDS) throw new Error("Inbox exceeds search safety limits");
        }
      }
      const recent = [...new Set(ids)].sort((a, b) => b - a).slice(0, MAX_MESSAGES_PER_SYNC);
      if (!recent.length) return {uidValidity,messages:[]};

      const fetchTag = nextTag();
      await wire.write(`${fetchTag} UID FETCH ${recent.join(",")} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])\r\n`);
      const found = new Map<number, MailEnvelope>();
      for (let step = 0; step < MAX_MESSAGES_PER_SYNC * 5 + 100; step++) {
        const line = await wire.readLine();
        if (line.startsWith(`${fetchTag} `)) {
          if (!new RegExp(`^${fetchTag} OK(?:\\s|$)`, "i").test(line)) {
            throw new Error("IMAP header fetch failed");
          }
          return {uidValidity,messages:[...found.values()].sort((a, b) => b.uid - a.uid)};
        }
        const match = /^\* \d+ FETCH \(.*?\bUID (\d+)\b.+?\{(\d+)\}$/i.exec(line);
        if (!match) continue;
        const uid = Number(match[1]);
        const size = Number(match[2]);
        if (!recent.includes(uid)) throw new Error("Unexpected IMAP UID in fetch result");
        const bytes = await wire.readBytes(size);
        found.set(uid, parseMailHeaderLiteral(bytes, uid, uidValidity));
        // Usually the literal is followed by a blank line and a closing ")".
        // Remaining IMAP response lines are consumed by the main read loop.
      }
      throw new Error("IMAP header fetch exceeded safety limits");
    } finally {
      wire.close();
    }
  }
}
