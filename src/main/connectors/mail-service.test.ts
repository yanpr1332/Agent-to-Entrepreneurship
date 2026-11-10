import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampusMailService } from "./mail-service";
import { CampusMailStore } from "./mail-store";
import { CampusMailVault } from "./mail-vault";
import type { EncryptionProvider } from "./canvas-credentials";

const paths:string[]=[];
afterEach(()=>{for(const dir of paths.splice(0))rmSync(dir,{recursive:true,force:true});});
function setup(){
  const dir=mkdtempSync(join(tmpdir(),"ate-mail-coordinator-"));
  paths.push(dir);
  const adapter:EncryptionProvider={
    isAsyncEncryptionAvailable:async()=>true,
    encryptStringAsync:async text=>Buffer.from(text).reverse(),
    decryptStringAsync:async bytes=>({result:Buffer.from(bytes).reverse().toString(),shouldReEncrypt:false}),
  };
  const store=new CampusMailStore(join(dir,"mail.sqlite"));
  const vault=new CampusMailVault(join(dir,"mail.enc"),adapter);
  const imap={readRecent:vi.fn(async()=>({uidValidity:3,messages:[
    {uid:7,uidValidity:3,from:"Teacher",subject:"Homework",date:null,messageId:null},
  ]}))};
  const smtp={send:vi.fn(async()=>undefined)};
  const service=new CampusMailService(vault,store,imap,smtp);
  const credentials={email:"student@sjtu.edu.cn",username:"student",password:"secret"};
  return {store,vault,imap,smtp,service,credentials};
}

describe("mail read-sync versus explicit SMTP consent",()=>{
  it("connects, stores headers, syncs idempotently, never sends during polling",async()=>{
    const {store,service,smtp,imap,credentials}=setup();
    const first=await service.connect(credentials);
    expect(first).toMatchObject({connected:true,messageCount:1});
    await service.sync();
    await service.sync();
    expect(imap.readRecent).toHaveBeenCalledTimes(3);
    expect(store.list(credentials.email)).toHaveLength(1);
    expect(smtp.send).not.toHaveBeenCalled();
    store.close();
  });

  it("requires a preview and one-time manual confirmation before any mail is sent",async()=>{
    const {store,service,smtp,credentials}=setup();
    await service.connect(credentials);
    const draft={to:["student2@sjtu.edu.cn"],subject:"Project",body:"Please read"};
    const preview=await service.prepareSend(draft);
    expect(preview).toMatchObject({...draft,from:credentials.email});
    expect(smtp.send).not.toHaveBeenCalled();
    expect(await service.confirmSend(preview.confirmationId)).toEqual({accepted:true});
    expect(smtp.send).toHaveBeenCalledTimes(1);
    await expect(service.confirmSend(preview.confirmationId)).rejects.toThrow("expired");
    expect(smtp.send).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("invalidates stale confirmations when a new draft is reviewed",async()=>{
    const {store,service,credentials,smtp}=setup();
    await service.connect(credentials);
    const old=await service.prepareSend({to:["first@example.com"],subject:"A",body:"1"});
    const next=await service.prepareSend({to:["second@example.com"],subject:"B",body:"2"});
    await expect(service.confirmSend(old.confirmationId)).rejects.toThrow("expired");
    await expect(service.confirmSend(next.confirmationId)).rejects.toThrow("expired");
    expect(smtp.send).not.toHaveBeenCalled();
    store.close();
  });

  it("disconnect deletes cached headers and encrypted credentials",async()=>{
    const {store,vault,service,credentials}=setup();
    await service.connect(credentials);
    const preview=await service.prepareSend({to:["x@example.com"],subject:"Hi",body:"Body"});
    await service.disconnect();
    expect(await vault.load()).toBeNull();
    expect(store.list(credentials.email)).toHaveLength(0);
    await expect(service.confirmSend(preview.confirmationId)).rejects.toThrow("expired");
    store.close();
  });

  it("failed IMAP login never saves a password",async()=>{
    const {store,vault,credentials}=setup();
    const service=new CampusMailService(vault,store,{
      readRecent:async()=>{throw Error("login failed: secret");},
    },{send:async()=>undefined});
    await expect(service.connect(credentials)).rejects.toThrow();
    expect(await vault.load()).toBeNull();
    store.close();
  });

  it("keeps cached mail if a scheduled sync fails",async()=>{
    const {store,vault,credentials,service,imap}=setup();
    await service.connect(credentials);
    imap.readRecent.mockRejectedValueOnce(Error("raw server secret"));
    const status=await service.sync();
    expect(status.lastError).toContain("邮箱同步失败");
    expect(status.lastError).not.toContain("raw server secret");
    expect(store.list(credentials.email)).toHaveLength(1);
    expect(await vault.load()).not.toBeNull();
    store.close();
  });
});
