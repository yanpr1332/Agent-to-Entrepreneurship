import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampusMailDraftVault } from "./mail-drafts";
import { CampusMailService } from "./mail-service";
import { CampusMailVault } from "./mail-vault";
import { CampusMailStore } from "./mail-store";
import type { EncryptionProvider } from "./canvas-credentials";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir,{recursive:true,force:true}); });
function fixture(available = true) {
  const dir=mkdtempSync(join(tmpdir(),"study-anchor-mail-drafts-"));
  directories.push(dir);
  const crypto: EncryptionProvider={
    isAsyncEncryptionAvailable:async()=>available,
    encryptStringAsync:async value=>Buffer.from(value).reverse(),
    decryptStringAsync:async bytes=>({result:Buffer.from(bytes).reverse().toString("utf8"),shouldReEncrypt:false}),
  };
  const path=join(dir,"drafts.enc");
  return {dir,path,crypto,drafts:new CampusMailDraftVault(path,crypto)};
}
const account="student@sjtu.edu.cn";
const content={to:["other@example.com"],subject:"Reply later",body:"Plain text"};

describe("encrypted campus mail draft lifecycle",()=>{
  it("saves, updates, reloads and deletes using only ciphertext", async()=>{
    const {path,crypto,drafts}=fixture();
    const original=await drafts.save(account,content);
    expect(original).toMatchObject({account,...content});
    expect(readFileSync(path,"utf8")).not.toContain("Reply later");
    expect(readFileSync(path,"utf8")).not.toContain("Plain text");
    const second=new CampusMailDraftVault(path,crypto);
    expect(await second.list(account)).toEqual([original]);
    const updated=await second.save(account,{...content,id:original.id,body:"Changed"});
    expect(updated.body).toBe("Changed");
    expect((await drafts.list(account))).toHaveLength(1);
    await drafts.remove(account,original.id);
    expect(await second.list(account)).toEqual([]);
  });
  it("preserves other account data rather than overwriting it",async()=>{
    const {drafts}=fixture();
    await drafts.save(account,content);
    await expect(drafts.list("someone@sjtu.edu.cn")).rejects.toThrow("different mailbox");
    await expect(drafts.save("someone@sjtu.edu.cn",content)).rejects.toThrow("different mailbox");
    expect(await drafts.list(account)).toHaveLength(1);
    await drafts.clear();
    expect(await drafts.list("someone@sjtu.edu.cn")).toEqual([]);
  });
  it("rejects corrupt ciphertext without overwriting it",async()=>{
    const {drafts,path}=fixture();
    await drafts.save(account,content);
    writeFileSync(path,Buffer.from("corrupt bytes"));
    await expect(drafts.save(account,content)).rejects.toThrow("preserved");
    expect(readFileSync(path,"utf8")).toBe("corrupt bytes");
  });
  it("rejects unavailable OS keychain and incomplete unsafe envelope",async()=>{
    const {drafts,path}=fixture(false);
    await expect(drafts.save(account,content)).rejects.toThrow("encryption unavailable");
    expect(()=>readFileSync(path)).toThrow();
  });
  it("permits a partially written draft, but rejects send-time invalid fields",async()=>{
    const {drafts}=fixture();
    const saved=await drafts.save(account,{to:[],subject:"",body:"Partial idea"});
    expect(saved.to).toEqual([]);
    await expect(drafts.save(account,{to:[],subject:"Hello\nBcc: outsider",body:"Secret"})).rejects.toThrow();
  });
  it("serializes concurrent updates to avoid losing drafts",async()=>{
    const {drafts}=fixture();
    const [a,b,c]=await Promise.all([
      drafts.save(account,{to:[],subject:"A",body:"a"}),
      drafts.save(account,{to:[],subject:"B",body:"b"}),
      drafts.save(account,{to:[],subject:"C",body:"c"}),
    ]);
    expect(new Set([a.id,b.id,c.id]).size).toBe(3);
    expect(await drafts.list(account)).toHaveLength(3);
  });
  it("service never sends when saving drafts, and clears drafts on disconnect",async()=>{
    const {dir,crypto,drafts}=fixture();
    const store=new CampusMailStore(join(dir,"headers.sqlite"));
    const vault=new CampusMailVault(join(dir,"credentials.enc"),crypto);
    const sender={send:vi.fn(async()=>undefined)};
    const reader={readRecent:vi.fn(async()=>({uidValidity:1,messages:[]}))};
    const service=new CampusMailService(vault,store,reader,sender,()=>{},drafts);
    await service.connect({email:account,username:"student",password:"secret"});
    const saved=await service.saveDraft(content);
    expect((await service.listSavedDrafts())[0].id).toBe(saved.id);
    expect(sender.send).not.toHaveBeenCalled();
    const reopened=new CampusMailService(vault,store,reader,sender,()=>{},new CampusMailDraftVault(join(dir,"drafts.enc"),crypto));
    await reopened.initialize();
    expect(await reopened.listSavedDrafts()).toHaveLength(1);
    await reopened.disconnect();
    expect(await reopened.listSavedDrafts()).toEqual([]);
    expect(await drafts.list(account)).toEqual([]);
    store.close();
  });
});
