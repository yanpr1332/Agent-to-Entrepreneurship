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
afterEach(()=>{dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
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
  const ledger=new AIUsageLedger(join(dir,"usage.sqlite"));
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
    expect(()=>service.prepare("Hi")).toThrow("OPENAI_API_KEY");
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
    expect(ask.mock.calls[0][0]).toMatchObject({apiKey:key,model:AI_DEFAULT_MODEL});
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
    await expect(service.initialize()).rejects.toThrow("OPENAI_API_KEY");
    expect(JSON.stringify(service.status())).not.toContain(invalid);
    expect(service.status().connected).toBe(false);
    ledger.close();
  });
});
