import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseAIConnect, type AIPrivateSettings } from "../../shared/ai-model";
import type { EncryptionProvider } from "../connectors/canvas-credentials";

type SafeEncryption = EncryptionProvider & { getSelectedStorageBackend?: () => string };

/**
 * Separate from mail/Canvas secrets. Fails closed when OS-backed encryption
 * is unavailable or Linux silently falls back to basic_text.
 */
export class AIKeyVault {
  constructor(private readonly path: string, private readonly crypt: SafeEncryption) {}
  private async requireSafeEncryption(): Promise<void> {
    if (!await this.crypt.isAsyncEncryptionAvailable() ||
        this.crypt.getSelectedStorageBackend?.() === "basic_text") {
      throw new Error("System credential encryption is unavailable; AI key was not saved");
    }
  }
  async save(input: AIPrivateSettings): Promise<void> {
    const validated = parseAIConnect(input);
    await this.requireSafeEncryption();
    const ciphertext = await this.crypt.encryptStringAsync(JSON.stringify(validated));
    await mkdir(dirname(this.path), {recursive:true});
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp,ciphertext,{mode:0o600,flag:"wx"});
      await rename(temp,this.path);
    } finally {
      await rm(temp,{force:true});
    }
  }
  async load(): Promise<AIPrivateSettings|null> {
    let bytes:Buffer;
    try {
      bytes=await readFile(this.path);
    } catch(error) {
      if((error as NodeJS.ErrnoException).code==="ENOENT")return null;
      throw new Error("Cannot read encrypted AI configuration");
    }
    await this.requireSafeEncryption();
    try {
      const decrypted=await this.crypt.decryptStringAsync(bytes);
      const value=parseAIConnect(JSON.parse(decrypted.result));
      if(decrypted.shouldReEncrypt)await this.save(value);
      return value;
    } catch {
      throw new Error("Cannot decrypt AI credentials; reconnect your own provider account");
    }
  }
  async clear(): Promise<void> { await rm(this.path,{force:true}); }
}
