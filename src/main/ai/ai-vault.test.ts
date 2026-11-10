import { afterEach,describe,expect,it } from "vitest";
import { mkdtempSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AIKeyVault } from "./ai-vault";
import type { EncryptionProvider } from "../connectors/canvas-credentials";
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const config={apiKey:"sk-"+"a".repeat(32),model:"gpt-4.1-mini"};
function fixture(available=true, backend="safe") {
  const dir=mkdtempSync(join(tmpdir(),"ate-ai-vault-"));dirs.push(dir);
  const file=join(dir,"provider.enc");
  const crypt:EncryptionProvider & {getSelectedStorageBackend:()=>string}={
    isAsyncEncryptionAvailable:async()=>available,
    getSelectedStorageBackend:()=>backend,
    encryptStringAsync:async text=>Buffer.from(text).reverse(),
    decryptStringAsync:async data=>({result:Buffer.from(data).reverse().toString(),shouldReEncrypt:false}),
  };
  return {file,vault:new AIKeyVault(file,crypt)};
}
describe("encrypted OpenAI provider configuration",()=>{
  it("keeps credentials ciphertext-only and supports deletion",async()=>{
    const {file,vault}=fixture();
    await vault.save(config);
    expect(readFileSync(file,"utf8")).not.toContain(config.apiKey);
    expect(await vault.load()).toEqual(config);
    await vault.clear();
    expect(await vault.load()).toBeNull();
  });
  it("refuses storage without trustworthy OS encryption",async()=>{
    for(const [available,backend] of [[false,"safe"],[true,"basic_text"]] as const){
      const {vault}=fixture(available,backend);
      await expect(vault.save(config)).rejects.toThrow("encryption");
      expect(await vault.load()).toBeNull();
    }
  });
});
