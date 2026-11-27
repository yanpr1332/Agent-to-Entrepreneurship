import { afterEach,describe,expect,it,vi } from "vitest";
import { mkdtempSync,rmSync } from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import { AIKeyVault } from "./ai-vault";
import { AIUsageLedger } from "./ai-usage";
import { AIService } from "./ai-service";
import type { EncryptionProvider } from "../connectors/canvas-credentials";
import { AI_DAILY_REQUEST_CAP,AI_DEFAULT_MODEL } from "../../shared/ai-model";
const dirs:string[]=[];
const ledgers:AIUsageLedger[]=[];
afterEach(()=>{
  for(const ledger of ledgers.splice(0)){try{ledger.close();}catch{/* already closed by the test */}}
  dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
});
const key="sk-"+"c".repeat(40);
const otherKey="sk-"+"d".repeat(40);
const cfg={apiKey:key,model:"gpt-4.1-mini"};
function fixture(environmentKey:()=>string|undefined=()=>undefined){
  const dir=mkdtempSync(join(tmpdir(),"ate-ai-test-"));dirs.push(dir);
  const crypt:EncryptionProvider={
    isAsyncEncryptionAvailable:async()=>true,
    encryptStringAsync:async text=>Buffer.from(text).reverse(),
    decryptStringAsync:async data=>({result:Buffer.from(data).reverse().toString(),shouldReEncrypt:false}),
  };
  const vault=new AIKeyVault(join(dir,"key.enc"),crypt);
  const ledger=new AIUsageLedger(join(dir,"usage.sqlite"));ledgers.push(ledger);
  const ask=vi.fn(async(_config:typeof cfg,_prompt:string,_signal?:AbortSignal)=>({
    text:"A proof-based answer.",model:_config.model,createdAt:"2026-11-10T00:00:00Z",
    usage:{inputTokens:20,outputTokens:50},
  }));
  const service=new AIService(vault,ledger,{ask},environmentKey);
  return {service,ledger,vault,ask,dir};
}
describe("paid AI requires explicit one-time approval",()=>{
  it("does not bill or send anything on connect and preview",async()=>{
    const {service,ledger,ask}=fixture();
    await service.connect(cfg);
    const preview=service.prepare("Explain Bernoulli.");
    expect(preview).toMatchObject({model:"gpt-4.1-mini",prompt:"Explain Bernoulli."});
    expect(ask).not.toHaveBeenCalled();
    expect(ledger.today().used).toBe(0);
    const answered=await service.confirm(preview.approvalId);
    expect(answered.text).toContain("proof");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ledger.today().used).toBe(1);
    expect(ledger.today().outputTokens).toBe(50);
    await expect(service.confirm(preview.approvalId)).rejects.toThrow("expired");
    ledger.close();
  });
  it("prevents chat, mail and project IPC handlers from confirming each other's approval tokens",async()=>{
    const {service,ledger,ask}=fixture();
    await service.connect(cfg);
    const project=service.prepare("Project plan",new Date(),"project-plan");
    await expect(service.confirm(project.approvalId)).rejects.toThrow("scope mismatch");
    expect(ask).not.toHaveBeenCalled();
    await service.confirm(project.approvalId,new Date(),undefined,"project-plan");
    const mail=service.prepare("Mail review",new Date(),"mail");
    await expect(service.confirm(mail.approvalId,new Date(),undefined,"project-plan"))
      .rejects.toThrow("scope mismatch");
    await service.confirm(mail.approvalId,new Date(),undefined,"mail");
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ledger.today().used).toBe(2);
    ledger.close();
  });
  it("scoped cancellation only invalidates a pending approval from its own domain",async()=>{
    const {service,ledger,ask}=fixture();
    await service.connect(cfg);
    const project=service.prepare("Project plan",new Date(),"project-plan");
    service.cancelScope("chat");
    await service.confirm(project.approvalId,new Date(),undefined,"project-plan");
    const mail=service.prepare("Mail review",new Date(),"mail");
    service.cancelScope("project-plan");
    await service.confirm(mail.approvalId,new Date(),undefined,"mail");
    const chat=service.prepare("Chat question");
    service.cancelScope("chat");
    await expect(service.confirm(chat.approvalId)).rejects.toThrow("expired");
    expect(ask).toHaveBeenCalledTimes(2);
    ledger.close();
  });
  it("only aborts an in-flight request when its own approval domain is canceled",async()=>{
    const {service,ledger,ask}=fixture();
    await service.connect(cfg);
    type Answer=Awaited<ReturnType<typeof ask>>;
    const answer:Answer={text:"A proof-based answer.",model:cfg.model,
      createdAt:"2026-11-10T00:00:00Z",usage:{inputTokens:20,outputTokens:50}};
    let resolveAllowed:(value:Answer)=>void=()=>{};
    ask.mockImplementationOnce(()=>new Promise<Answer>(resolve=>{resolveAllowed=resolve;}));
    const project=service.prepare("Project plan",new Date(),"project-plan");
    const allowed=service.confirm(project.approvalId,new Date(),undefined,"project-plan");
    await vi.waitFor(()=>expect(resolveAllowed).toBeTypeOf("function"));
    service.cancelScope("chat");
    resolveAllowed(answer);
    await expect(allowed).resolves.toMatchObject({text:"A proof-based answer."});
    let resolveCanceled:(value:Answer)=>void=()=>{};
    ask.mockImplementationOnce(()=>new Promise<Answer>(resolve=>{resolveCanceled=resolve;}));
    const mail=service.prepare("Mail review",new Date(),"mail");
    const canceled=service.confirm(mail.approvalId,new Date(),undefined,"mail");
    await vi.waitFor(()=>expect(resolveCanceled).toBeTypeOf("function"));
    service.cancelScope("mail");
    resolveCanceled(answer);
    await expect(canceled).rejects.toThrow("canceled");
    expect(ledger.today().used).toBe(2);
    ledger.close();
  });
  it("rechecks project authorization after key lookup and before quota reservation or network I/O",async()=>{
    const {service,ledger,ask}=fixture();
    await service.connect(cfg);
    const preview=service.prepare("Project-scoped question");
    const revoked=vi.fn(()=>{throw Error("project grant revoked");});
    await expect(service.confirm(preview.approvalId,new Date(),revoked))
      .rejects.toThrow("project grant revoked");
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(ledger.today().used).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    ledger.close();
  });
  it("does not repeat paid calls after failure or approval replacement",async()=>{
    const {service,ledger,ask}=fixture();
    await service.connect(cfg);
    const old=service.prepare("Old question");
    const next=service.prepare("New question");
    await expect(service.confirm(old.approvalId)).rejects.toThrow("expired");
    await expect(service.confirm(next.approvalId)).rejects.toThrow("expired");
    expect(ask).not.toHaveBeenCalled();
    const approval=service.prepare("Now send");
    ask.mockRejectedValueOnce(new Error("network lost; secret"));
    await expect(service.confirm(approval.approvalId)).rejects.toThrow("network lost");
    expect(ledger.today().used).toBe(1);
    await expect(service.confirm(approval.approvalId)).rejects.toThrow("expired");
    expect(ask).toHaveBeenCalledTimes(1);
    ledger.close();
  });
  it("disconnect invalidates approval and cannot reset daily usage",async()=>{
    const {service,ledger,ask}=fixture();
    await service.connect(cfg);
    const preview=service.prepare("Do not send");
    await service.disconnect();
    await expect(service.confirm(preview.approvalId)).rejects.toThrow("expired");
    expect(ask).not.toHaveBeenCalled();
    await service.connect(cfg);
    for(let i=0;i<AI_DAILY_REQUEST_CAP;i++){
      const approval=service.prepare("Question "+i);
      await service.confirm(approval.approvalId);
    }
    await service.disconnect();
    await service.connect(cfg);
    expect(service.status().remainingToday).toBe(0);
    expect(()=>service.prepare("One more")).toThrow("limit");
    ledger.close();
  });
  it("refuses actions before configuration and never echoes key in status",async()=>{
    const {service,ledger}=fixture();
    expect(()=>service.prepare("Hi")).toThrow("API_KEY");
    await service.connect(cfg);
    expect(JSON.stringify(service.status())).not.toContain(key);
    expect(service.status().keySource).toBe("saved");
    ledger.close();
  });
  it("uses OPENAI_API_KEY from Main without persisting or exposing it",async()=>{
    const environment={value:key};
    const {service,ledger,vault,ask}=fixture(()=>environment.value);
    const status=await service.initialize();
    expect(status).toMatchObject({
      connected:true,keySource:"environment",model:AI_DEFAULT_MODEL,
    });
    expect(JSON.stringify(status)).not.toContain(key);
    expect(await vault.load()).toBeNull();
    const preview=service.prepare("Use my environment key");
    await service.confirm(preview.approvalId);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({apiKey:key,model:AI_DEFAULT_MODEL}),
      "Use my environment key",expect.any(AbortSignal),
    );
    expect(await vault.load()).toBeNull();
    ledger.close();
  });
  it("prefers the encrypted manual key, then falls back to environment after removal",async()=>{
    const {service,ledger}=fixture(()=>key);
    await service.connect({apiKey:otherKey,model:"gpt-4.1-mini"});
    expect(service.status().keySource).toBe("saved");
    const next=await service.disconnect();
    expect(next).toMatchObject({connected:true,keySource:"environment",model:AI_DEFAULT_MODEL});
    expect(JSON.stringify(next)).not.toContain(key);
    ledger.close();
  });
  it("invalidates a preview if the environment key changes before confirmation",async()=>{
    const environment={value:key};
    const {service,ledger,ask}=fixture(()=>environment.value);
    await service.initialize();
    const preview=service.prepare("Do not use a changed key");
    environment.value=otherKey;
    await expect(service.confirm(preview.approvalId)).rejects.toThrow("key changed");
    expect(ledger.today().used).toBe(0);
    expect(ask).not.toHaveBeenCalled();
    expect(service.status().keySource).toBe("environment");
    ledger.close();
  });
  it("rejects malformed environment keys without exposing their value",async()=>{
    const invalid="not-a-real-secret";
    const {service,ledger}=fixture(()=>invalid);
    const status=await service.initialize();
    expect(status.configurationWarning).toBe("invalid_environment_key");
    expect(JSON.stringify(status)).not.toContain(invalid);
    expect(status.connected).toBe(false);
    ledger.close();
  });
  it("uses DeepSeek environment variable with official model and no secret disclosure",async()=>{
    const env={DEEPSEEK_API_KEY:"ds-"+"f".repeat(48)};
    const {service,ledger,vault,ask}=fixture(()=>undefined);
    // Main's only environment provider is injected separately in this test.
    const local=new AIService(vault,ledger,{ask},()=>undefined,()=>env);
    expect(await local.initialize()).toMatchObject({
      provider:"deepseek",model:"deepseek-flash",keySource:"environment",
    });
    const preview=local.prepare("Read my authorized data");
    expect(preview).toMatchObject({provider:"deepseek",endpointLabel:"deepseek"});
    await local.confirm(preview.approvalId);
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({provider:"deepseek",apiKey:env.DEEPSEEK_API_KEY}),
      expect.any(String),expect.any(AbortSignal),
    );
    expect(JSON.stringify(local.status())).not.toContain(env.DEEPSEEK_API_KEY);
    expect(await vault.load()).toBeNull();
    ledger.close();
  });
});
