import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MailEnvelope, MailRecord } from "../../shared/mail-model";

/**
 * Separate SQLite database for bounded local IMAP metadata. No message body,
 * attachment, password or SMTP draft is written to this database.
 */
export class CampusMailStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), {recursive: true});
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout = 3000");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mail_headers (
        account TEXT NOT NULL,
        uid_validity INTEGER NOT NULL,
        uid INTEGER NOT NULL,
        sender TEXT NOT NULL,
        subject TEXT NOT NULL,
        sent_at TEXT,
        message_id TEXT,
        received_at TEXT NOT NULL,
        PRIMARY KEY(account, uid_validity, uid)
      );
      CREATE INDEX IF NOT EXISTS idx_mail_recent ON mail_headers(account, uid DESC);
      CREATE TABLE IF NOT EXISTS mail_accounts (
        account TEXT PRIMARY KEY,
        uid_validity INTEGER NOT NULL
      );
    `);
  }

  merge(account: string, validity: number, envelopes: MailEnvelope[], now = new Date()): number {
    if (!Number.isSafeInteger(validity) || validity < 1) throw new Error('Invalid UIDVALIDITY');
    if (!envelopes.every(item => item.uidValidity === validity)) {
      throw new Error("IMAP returned inconsistent UID validity identifiers");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db.prepare("SELECT uid_validity FROM mail_accounts WHERE account=?")
        .get(account) as {uid_validity:number}|undefined;
      if (current && current.uid_validity !== validity) {
        this.db.prepare("DELETE FROM mail_headers WHERE account=?").run(account);
      }
      this.db.prepare(`INSERT INTO mail_accounts(account,uid_validity) VALUES (?,?)
        ON CONFLICT(account) DO UPDATE SET uid_validity=excluded.uid_validity`).run(account,validity);
      const insert = this.db.prepare(`INSERT INTO mail_headers
        (account,uid_validity,uid,sender,subject,sent_at,message_id,received_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(account,uid_validity,uid) DO UPDATE SET
        sender=excluded.sender, subject=excluded.subject,
        sent_at=excluded.sent_at, message_id=excluded.message_id`);
      for (const envelope of envelopes) {
        insert.run(account,envelope.uidValidity,envelope.uid,envelope.from,
          envelope.subject,envelope.date,envelope.messageId,now.toISOString());
      }
      // Prevent unlimited growth; keep at most 200 headers per account.
      this.db.prepare(`DELETE FROM mail_headers WHERE account=? AND uid NOT IN (
        SELECT uid FROM mail_headers WHERE account=?
        ORDER BY uid DESC LIMIT 200
      )`).run(account,account);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.count(account);
  }

  list(account: string): MailRecord[] {
    const rows = this.db.prepare(`SELECT uid_validity,uid,sender,subject,sent_at,message_id,received_at
      FROM mail_headers WHERE account=? ORDER BY uid DESC LIMIT 100`).all(account) as unknown as {
      uid_validity:number;uid:number;sender:string;subject:string;
      sent_at:string|null;message_id:string|null;received_at:string;
    }[];
    return rows.map(row => ({
      account,uidValidity:row.uid_validity,uid:row.uid,from:row.sender,
      subject:row.subject,date:row.sent_at,messageId:row.message_id,receivedAt:row.received_at,
    }));
  }

  count(account: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM mail_headers WHERE account=?")
      .get(account) as {n:number};
    return Number(row.n);
  }

  clear(account: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM mail_headers WHERE account=?").run(account);
      this.db.prepare("DELETE FROM mail_accounts WHERE account=?").run(account);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
