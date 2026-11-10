import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EncryptionProvider } from "./canvas-credentials";
import { CampusMailVault } from "./mail-vault";

const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(available=true){
  const directory=mkdtempSync(join(tmpdir(),"ate-mail-vault-"));
  dirs.push(directory);
  const file=join(directory,"mail.enc");
  const crypto:EncryptionProvider={
    isAsyncEncryptionAvailable:async()=>available,
    encryptStringAsync:async text=>Buffer.from(text).reverse(),
    decryptStringAsync:async bytes=>({result:Buffer.from(bytes).reverse().toString(),shouldReEncrypt:false}),
  };
  return {file,vault:new CampusMailVault(file,crypto)};
}
describe("OS-backed campus mail secrets",()=>{
  it("never writes a raw password and permits explicit deletion",async()=>{
    const {file,vault}=fixture();
    const credentials={email:"student@sjtu.edu.cn",username:"student",password:"secret-mail-password"};
    await vault.save(credentials);
    expect(readFileSync(file,"utf8")).not.toContain("secret-mail-password");
    expect(await vault.load()).toEqual(credentials);
    await vault.clear();
    expect(await vault.load()).toBeNull();
  });
  it("fails closed without OS encryption",async()=>{
    const {file,vault}=fixture(false);
    await expect(vault.save({email:"student@sjtu.edu.cn",username:"student",password:"test"}))
      .rejects.toThrow("encryption unavailable");
    expect(()=>readFileSync(file)).toThrow();
  });
});
