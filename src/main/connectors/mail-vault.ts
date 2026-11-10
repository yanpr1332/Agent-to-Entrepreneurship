import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseCampusMailCredentials, type CampusMailCredentials } from "../../shared/mail-model";
import type { EncryptionProvider } from "./canvas-credentials";

/** Uses Electron safeStorage's OS key. Never falls back to plaintext. */
export class CampusMailVault {
  constructor(private readonly path: string, private readonly crypto: EncryptionProvider) {}

  private async assertAvailable(): Promise<void> {
    if (!await this.crypto.isAsyncEncryptionAvailable()) {
      throw new Error("System credential encryption unavailable; email password was not stored");
    }
  }

  async save(value: CampusMailCredentials): Promise<void> {
    const safe = parseCampusMailCredentials(value);
    await this.assertAvailable();
    const ciphertext = await this.crypto.encryptStringAsync(JSON.stringify(safe));
    await mkdir(dirname(this.path), {recursive:true});
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary,ciphertext,{mode:0o600,flag:"wx"});
      await rename(temporary,this.path);
    } finally {
      await rm(temporary,{force:true});
    }
  }

  async load(): Promise<CampusMailCredentials|null> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Cannot read encrypted mail credentials");
    }
    await this.assertAvailable();
    try {
      const decrypted = await this.crypto.decryptStringAsync(bytes);
      const saved = parseCampusMailCredentials(JSON.parse(decrypted.result));
      if (decrypted.shouldReEncrypt) await this.save(saved);
      return saved;
    } catch {
      throw new Error("Cannot decrypt campus mail credentials; reconnect the mailbox");
    }
  }

  async clear(): Promise<void> { await rm(this.path,{force:true}); }
}
