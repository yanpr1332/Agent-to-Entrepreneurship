import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeAddress, parseMailDraftSave, type MailDraftSaveInput, type MailSavedDraft } from "../../shared/mail-model";
import type { EncryptionProvider } from "./canvas-credentials";

/**
 * Only OS-encrypted, account-scoped local draft snapshots. No plaintext SQLite
 * bodies, unattended send, sync, or fallback when the keychain is unavailable.
 * One file holds up to 20 drafts for the currently connected account.
 */
export class CampusMailDraftVault {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly crypto: EncryptionProvider) {}

  private async encryptionReady(): Promise<void> {
    if (!await this.crypto.isAsyncEncryptionAvailable())
      throw Error("System credential encryption unavailable; draft was not saved");
  }

  private async read(account: string): Promise<MailSavedDraft[]> {
    await this.encryptionReady();
    let ciphertext: Buffer;
    try { ciphertext = await readFile(this.path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw Error("Cannot read encrypted drafts");
    }
    try {
      const data = JSON.parse((await this.crypto.decryptStringAsync(ciphertext)).result) as {
        version: number; account: string; drafts: unknown;
      };
      if (data.version !== 1 || typeof data.account !== "string" || !Array.isArray(data.drafts) ||
          data.drafts.length > 20) throw Error("Invalid draft file");
      if (data.account !== account) throw Error("Saved drafts belong to a different mailbox; disconnect before switching accounts");
      return data.drafts.map(value => {
        if (!value || typeof value !== "object") throw Error("Invalid draft");
        const item = value as MailSavedDraft;
        const parsed = parseMailDraftSave({ to: item.to, subject: item.subject, body: item.body, ...(item.replyMessageId ? {replyMessageId: item.replyMessageId} : {}) });
        if (item.account !== account || typeof item.id !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(item.id) ||
            typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt)))
          throw Error("Invalid draft metadata");
        return { ...parsed, account, id: item.id, updatedAt: item.updatedAt };
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Saved drafts belong to a different mailbox"))
        throw error;
      throw Error("Cannot decrypt or validate saved drafts; existing file was preserved");
    }
  }

  private async write(account: string, drafts: MailSavedDraft[]): Promise<void> {
    await this.encryptionReady();
    const encrypted = await this.crypto.encryptStringAsync(
      JSON.stringify({ version: 1, account, drafts })
    );
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); }
    finally { release(); }
  }

  async list(account: string): Promise<MailSavedDraft[]> {
    const safeAccount = normalizeAddress(account);
    return this.exclusive(async () => this.read(safeAccount));
  }

  async save(account: string, input: MailDraftSaveInput): Promise<MailSavedDraft> {
    const safeAccount = normalizeAddress(account);
    const parsed = parseMailDraftSave(input);
    return this.exclusive(async () => {
      const drafts = await this.read(safeAccount);
      if (input.id && !drafts.some(x => x.id === input.id))
        throw Error("Saved draft no longer exists; reload the list");
      if (!input.id && drafts.length >= 20)
        throw Error("At most 20 saved drafts are supported");
      const saved: MailSavedDraft = {
        ...parsed, account: safeAccount,
        id: input.id ?? randomUUID(), updatedAt: new Date().toISOString(),
      };
      await this.write(safeAccount, [saved, ...drafts.filter(x => x.id !== saved.id)]);
      return saved;
    });
  }

  async remove(account: string, id: unknown): Promise<void> {
    const safeAccount = normalizeAddress(account);
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))
      throw Error("Invalid saved draft identifier");
    return this.exclusive(async () => {
      const drafts = await this.read(safeAccount);
      if (!drafts.some(x => x.id === id)) throw Error("Saved draft no longer exists");
      await this.write(safeAccount, drafts.filter(x => x.id !== id));
    });
  }

  async clear(): Promise<void> {
    return this.exclusive(async () => { await rm(this.path, { force: true }); });
  }
}
