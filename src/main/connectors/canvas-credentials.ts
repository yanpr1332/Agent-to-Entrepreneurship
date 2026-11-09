import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseCanvasPersonalTokenInput, type CanvasPersonalTokenInput } from "../../shared/canvas-model";
import { validateCanvasInstance } from "./canvas-api";

export interface EncryptionProvider {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(text: string): Promise<Buffer>;
  decryptStringAsync(data: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

/**
 * Encrypts personal Canvas credentials using Electron safeStorage's OS-backed key.
 * Only the encrypted blob is written beside the local app database. No tokens
 * are written into SQLite, the renderer's storage, GitHub or cloud providers.
 */
export class CanvasCredentialVault {
  constructor(
    private readonly file: string,
    private readonly crypto: EncryptionProvider,
  ) {}

  private async assertEncryption(): Promise<void> {
    if (!await this.crypto.isAsyncEncryptionAvailable()) {
      throw new Error("System credential encryption is unavailable; Canvas token was not saved");
    }
  }

  async save(input: CanvasPersonalTokenInput): Promise<void> {
    const validated = parseCanvasPersonalTokenInput(input);
    const normalized: CanvasPersonalTokenInput = {
      baseUrl: validateCanvasInstance(validated.baseUrl),
      token: validated.token,
    };
    await this.assertEncryption();
    const encrypted = await this.crypto.encryptStringAsync(JSON.stringify(normalized));
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async load(): Promise<CanvasPersonalTokenInput | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Unable to read encrypted Canvas credentials");
    }

    await this.assertEncryption();
    try {
      const decrypted = await this.crypto.decryptStringAsync(encrypted);
      const input = parseCanvasPersonalTokenInput(JSON.parse(decrypted.result));
      const normalized = { baseUrl: validateCanvasInstance(input.baseUrl), token: input.token };
      if (decrypted.shouldReEncrypt) await this.save(normalized);
      return normalized;
    } catch {
      throw new Error("Unable to decrypt Canvas credentials; reconnect your personal account");
    }
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
