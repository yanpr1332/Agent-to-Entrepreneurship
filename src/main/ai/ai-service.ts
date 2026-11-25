import { createHash, randomUUID } from "node:crypto";
import {
  AI_DEFAULT_MODEL, AI_DAILY_REQUEST_CAP, AI_OUTPUT_TOKEN_CAP, AI_PREVIEW_TTL_MS,
  parseAIPrompt, parseAIApprovalId, parseAIConnect,
  type AIAnswer, type AIStatus, type AIPreview, type AIPrivateSettings, type AIKeySource,
} from "../../shared/ai-model";
import { AIKeyVault } from "./ai-vault";
import { AIUsageLedger } from "./ai-usage";
import { OpenAIResponsesClient } from "./openai-responses";

type ActiveKey={settings:AIPrivateSettings;source:AIKeySource};
type PendingIntent={
  id:string;prompt:string;expires:number;generation:number;credentialFingerprint:string;
};

/** Explicit two-step approval. No background AI calls, task/calendar writes or telemetry. */
export class AIService {
  private active:ActiveKey|null=null;
  private intent:PendingIntent|null=null;
  private inflight:AbortController|null=null;
  private generation=0;
  constructor(
    private readonly vault:AIKeyVault,
    private readonly ledger:AIUsageLedger,
    private readonly client:Pick<OpenAIResponsesClient,"ask">=new OpenAIResponsesClient(),
    /** Read only in Electron Main. Never expose process.env to Renderer/Preload. */
    private readonly environmentKey:()=>string|undefined=()=>process.env.OPENAI_API_KEY,
  ){}

  private fingerprint(settings:AIPrivateSettings):string{
    return createHash("sha256").update(settings.apiKey).update("\\0")
      .update(settings.model).digest("hex");
  }

  /** Explicitly saved OS-encrypted credentials take precedence. The environment
   * variable is a non-persistent fallback for users who prefer external secret
   * management. Its value is never returned in status or written to the vault. */
  private async resolveActiveKey():Promise<ActiveKey|null>{
    const saved=await this.vault.load();
    if(saved)return {settings:saved,source:"saved"};
    const raw=this.environmentKey();
    if(raw===undefined||raw.trim()==="")return null;
    try{
      return {
        settings:parseAIConnect({apiKey:raw.trim(),model:AI_DEFAULT_MODEL}),
        source:"environment",
      };
    }catch{
      throw new Error("OPENAI_API_KEY is set but invalid; check its format and use a personal OpenAI project key");
    }
  }

  async initialize():Promise<AIStatus>{
    this.active=await this.resolveActiveKey();
    return this.status();
  }

  status():AIStatus{
    const quota=this.ledger.today();
    return {
      connected:this.active!==null,running:this.inflight!==null,
      provider:"openai",model:this.active?.settings.model??null,
      keySource:this.active?.source??null,
      usedToday:quota.used,remainingToday:quota.remaining,
      dailyRequestLimit:AI_DAILY_REQUEST_CAP,maxOutputTokens:AI_OUTPUT_TOKEN_CAP,
      lastRequestAt:quota.lastRequestAt,
    };
  }

  cancel():void{
    this.generation++;
    this.intent=null;
    this.inflight?.abort();
    this.inflight=null;
  }

  async connect(input:unknown):Promise<AIStatus>{
    const config=parseAIConnect(input);
    // Never test a key via a paid request during connection.
    this.cancel();
    await this.vault.save(config);
    this.active={settings:config,source:"saved"};
    return this.status();
  }

  async disconnect():Promise<AIStatus>{
    this.cancel();
    await this.vault.clear();
    this.active=null;
    // Removing the saved key falls back to OPENAI_API_KEY when present.
    this.active=await this.resolveActiveKey();
    // Request quota remains persistent; disconnect never resets it.
    return this.status();
  }

  prepare(promptInput:unknown,now=new Date()):AIPreview {
    const prompt=parseAIPrompt(promptInput);
    if(!this.active)throw Error("Connect your own OpenAI project key or set OPENAI_API_KEY first");
    if(this.inflight)throw Error("An AI request is already in progress");
    if(this.ledger.today(now).remaining===0)throw Error("Daily AI request limit reached (UTC)");
    const id=randomUUID(),expires=now.getTime()+AI_PREVIEW_TTL_MS;
    this.intent={
      id,prompt,expires,generation:this.generation,
      credentialFingerprint:this.fingerprint(this.active.settings),
    };
    return {approvalId:id,prompt,model:this.active.settings.model,
      expiresAt:new Date(expires).toISOString(),maxOutputTokens:AI_OUTPUT_TOKEN_CAP};
  }

  async confirm(idInput:unknown,now=new Date()):Promise<AIAnswer>{
    const id=parseAIApprovalId(idInput);
    if(this.inflight)throw Error("An AI request is already in progress");
    const intent=this.intent;
    this.intent=null; // One-time regardless of provider response.
    if(!intent || intent.id!==id || intent.expires<now.getTime() ||
       intent.generation!==this.generation || !this.active){
      throw Error("AI preview expired or was replaced. Review the question again");
    }
    const controller=new AbortController();
    this.inflight=controller;
    const generation=this.generation;
    try{
      const current=await this.resolveActiveKey();
      if(generation!==this.generation || controller.signal.aborted)
        throw Error("AI provider changed or the request was canceled");
      if(!current||this.fingerprint(current.settings)!==intent.credentialFingerprint){
        this.active=current;
        throw Error("AI provider key changed or was removed; review the request again");
      }
      this.active=current;
      this.ledger.reserve(now); // Persist BEFORE making a potentially chargeable request.
      const result=await this.client.ask(current.settings,intent.prompt,controller.signal);
      if(controller.signal.aborted || generation!==this.generation)
        throw Error("AI request was canceled; check provider usage before retrying");
      this.ledger.recordTokens(now,result.usage.inputTokens,result.usage.outputTokens);
      return result;
    }finally{
      if(this.inflight===controller)this.inflight=null;
    }
  }
}
