/** Email is separate from task authority. Syncing mail does not create or send tasks. */
export const SJTU_MAIL_HOST = "mail.sjtu.edu.cn";
export const SJTU_IMAP_PORT = 993;
export const SJTU_SMTP_PORT = 465;

export interface CampusMailCredentials {
  email: string;
  username: string;
  password: string;
}

export interface CampusMailConnectInput extends CampusMailCredentials {}

export interface MailEnvelope {
  uid: number;
  uidValidity: number;
  from: string;
  subject: string;
  date: string | null;
  messageId: string | null;
}

export interface MailRecord extends MailEnvelope {
  account: string;
  receivedAt: string;
}

export interface MailSyncState {
  connected: boolean;
  email: string | null;
  running: boolean;
  lastAttempt: string | null;
  lastSuccess: string | null;
  lastError: string | null;
  messageCount: number;
}

export interface MailDraft {
  to: string[];
  subject: string;
  body: string;
}

export interface MailSendPreview extends MailDraft {
  confirmationId: string;
  expiresAt: string;
  from: string;
}

function object(input: unknown): Record<string, unknown> {
  if (input === null || Array.isArray(input) || typeof input !== "object") {
    throw new Error("Invalid mail request");
  }
  return input as Record<string, unknown>;
}

function exactKeys(data: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(data).some(key => !keys.includes(key))) {
    throw new Error("Unexpected mail input field");
  }
}

export function normalizeAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || value !== value.trim() ||
      /[\r\n<>\s,;\x00-\x1f\x7f]/.test(value) ||
      !/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(value)) {
    throw new Error("Invalid email address");
  }
  return value.toLowerCase();
}

export function parseCampusMailCredentials(input: unknown): CampusMailCredentials {
  const data = object(input);
  exactKeys(data, ["email", "username", "password"]);
  const email = normalizeAddress(data.email);
  if (!email.endsWith("@sjtu.edu.cn")) {
    throw new Error("This connector currently supports SJTU campus accounts only");
  }
  if (typeof data.username !== "string" ||
      !/^[A-Za-z0-9._@-]{1,128}$/.test(data.username)) {
    throw new Error("Invalid jAccount username");
  }
  if (typeof data.password !== "string" || !data.password ||
      data.password.length > 1024 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.password)) {
    throw new Error("Invalid email password or app authorization code");
  }
  return { email, username: data.username, password: data.password };
}

export function parseMailDraft(input: unknown): MailDraft {
  const data = object(input);
  exactKeys(data, ["to", "subject", "body"]);
  if (!Array.isArray(data.to) || data.to.length < 1 || data.to.length > 5) {
    throw new Error("Choose one to five recipients");
  }
  const to = data.to.map(normalizeAddress);
  if (new Set(to).size !== to.length) throw new Error("Duplicate recipients");
  if (typeof data.subject !== "string" || !data.subject.trim() ||
      data.subject.length > 180 || /[\r\n\x00-\x1f\x7f]/.test(data.subject)) {
    throw new Error("Invalid mail subject");
  }
  if (typeof data.body !== "string" || !data.body.trim() ||
      data.body.length > 10000 || /\x00/.test(data.body)) {
    throw new Error("Invalid mail body");
  }
  return { to, subject: data.subject.trim(), body: data.body };
}
