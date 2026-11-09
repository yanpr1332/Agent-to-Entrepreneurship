import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanvasCredentialVault, type EncryptionProvider } from "./canvas-credentials";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(available = true) {
  const directory = mkdtempSync(join(tmpdir(), "ate-canvas-test-"));
  directories.push(directory);
  const file = join(directory, "canvas-personal.enc");
  // Test-only reversible encoder: production uses Electron OS-backed safeStorage.
  const crypto: EncryptionProvider = {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (value) => Buffer.from(value).reverse(),
    decryptStringAsync: async (value) => ({
      result: Buffer.from(value).reverse().toString("utf8"),
      shouldReEncrypt: false,
    }),
  };
  return { file, vault: new CanvasCredentialVault(file, crypto) };
}

describe("Canvas credential storage", () => {
  it("writes encrypted bytes and never stores a plaintext token", async () => {
    const { file, vault } = fixture();
    await vault.save({ baseUrl: "https://oc.sjtu.edu.cn", token: "local-demo-secret" });
    expect(readFileSync(file, "utf8")).not.toContain("local-demo-secret");
    expect(await vault.load()).toEqual({
      baseUrl: "https://oc.sjtu.edu.cn", token: "local-demo-secret",
    });
    await vault.clear();
    expect(await vault.load()).toBeNull();
  });

  it("refuses to persist a token without OS-provided encryption", async () => {
    const { file, vault } = fixture(false);
    await expect(vault.save({ baseUrl: "https://oc.sjtu.edu.cn", token: "secret" }))
      .rejects.toThrow("encryption is unavailable");
    expect(() => readFileSync(file)).toThrow();
  });
});
