import { createHash, randomUUID } from "node:crypto";
import {
  AI_MODEL_DEFAULTS, AI_DAILY_REQUEST_CAP, AI_OUTPUT_TOKEN_CAP, AI_PREVIEW_TTL_MS,
  parseAIProvider,
  parseAIPrompt, parseAIApprovalId, parseAIConnect,
  type AIAnswer, type AIStatus, type AIPreview, type AIPrivateSettings, type AIKeySource,
  type AIProvider,
} from "../../shared/ai-model";
import { AIKeyVault } from "./ai-vault";
import { AIUsageLedger } from "./ai-usage";
import { OpenAIResponsesClient } from "./openai-responses";

export type AIApprovalScope="chat"|"mail"|"project-plan";
type ActiveKey={settings:AIPrivateSettings;source:AIKeySource};
type PendingIntent={
  id:string;prompt:string;expires:number;generation:number;credentialFingerprint:string;scope:AIApprovalScope;
};

/** Explicit two-step approval. No background AI calls, task/calendar writes or telemetry. */
export class AIService {
  private active:ActiveKey|null=null;
  private configurationWarning:AIStatus["configurationWarning"]=null;
  private intent:PendingIntent|null=null;
  private inflight:AbortController|null=null;
  private inflightScope:AIApprovalScope|null=null;
  private generation=0;
  constructor(
    private readonly vault:AIKeyVault,
    private readonly ledger:AIUsageLedger,
    private readonly client:Pick<OpenAIResponsesClient,"ask">=new OpenAIResponsesClient(),
    /** Read only in Electron Main. Never expose process.env to Renderer/Preload. */
    private readonly environmentKey:()=>string|undefined=()=>process.env.OPENAI_API_KEY,
    private readonly environment:()=>NodeJS.ProcessEnv=()=>process.env,
  ){}

  private fingerprint(settings:AIPrivateSettings):string{
    return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
  }

  /** Explicitly saved OS-encrypted credentials take precedence. The environment
   * variable is a non-persistent fallback for users who prefer external secret
   * management. Its value is never returned in status or written to the vault. */
  private async resolveActiveKey():Promise<ActiveKey|null>{
    const saved=await this.vault.load();
    if(saved){
      this.configurationWarning=null;
      return {settings:saved,source:"saved"};
    }
    const env=this.environment();
    const explicit=env.STUDY_ANCHOR_AI_PROVIDER;
    let provider:AIProvider;
    let raw:string|undefined;
    try{
      provider=explicit?parseAIProvider(explicit):"openai";
      if(explicit){
        raw=provider==="openai"?this.environmentKey():
          provider==="anthropic"?env.ANTHROPIC_API_KEY:
          provider==="gemini"?env.GEMINI_API_KEY:
          provider==="deepseek"?env.DEEPSEEK_API_KEY:env.STUDY_ANCHOR_AI_API_KEY;
      }else{
        raw=this.environmentKey();
        if(!raw){raw=env.ANTHROPIC_API_KEY;provider="anthropic";}
        if(!raw){raw=env.GEMINI_API_KEY;provider="gemini";}
        if(!raw){raw=env.DEEPSEEK_API_KEY;provider="deepseek";}
      }
      if(!raw?.trim()){
        this.configurationWarning=explicit?"invalid_environment_key":null;
        return null;
      }
      const model=env.STUDY_ANCHOR_AI_MODEL||
        (provider==="compatible"?"":AI_MODEL_DEFAULTS[provider]);
      const endpoint=provider==="compatible"?env.STUDY_ANCHOR_AI_ENDPOINT:null;
      const active={settings:parseAIConnect({
        apiKey:raw.trim(),model,provider,endpoint,
      }),source:"environment" as const};
      this.configurationWarning=null;
      return active;
    }catch{
      this.configurationWarning="invalid_environment_key";
      return null;
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
      provider:this.active?.settings.provider??null,model:this.active?.settings.model??null,
      keySource:this.active?.source??null,
      configurationWarning:this.configurationWarning,
      usedToday:quota.used,remainingToday:quota.remaining,
      dailyRequestLimit:AI_DAILY_REQUEST_CAP,maxOutputTokens:AI_OUTPUT_TOKEN_CAP,
      lastRequestAt:quota.lastRequestAt,
    };
  }

  cancelScope(scope:AIApprovalScope):void{
    if(this.intent?.scope===scope)this.intent=null;
    if(this.inflight&&this.inflightScope===scope){
      this.generation++;
      // Keep the slot occupied until confirm() settles; otherwise a provider
      // that ignores AbortSignal could overlap a second paid request.
      this.inflight.abort();
    }
  }

  /** Credential changes intentionally invalidate every approval domain. */
  cancel():void{
    this.generation++;
    this.intent=null;
    // confirm() releases the in-flight slot in finally after the provider settles.
    this.inflight?.abort();
  }

  async connect(input:unknown):Promise<AIStatus>{
    const config=parseAIConnect(input);
    // Never test a key via a paid request during connection.
    this.cancel();
    await this.vault.save(config);
    this.active={settings:config,source:"saved"};
    this.configurationWarning=null;
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

  prepare(promptInput:unknown,now=new Date(),scope:AIApprovalScope="chat"):AIPreview {
    if(scope!=="chat"&&scope!=="mail"&&scope!=="project-plan")throw Error("Invalid AI approval scope");
    const prompt=parseAIPrompt(promptInput);
    if(!this.active)throw Error("Connect your own AI provider API key or set a supported API_KEY environment variable first");
    if(this.inflight)throw Error("An AI request is already in progress");
    if(this.ledger.today(now).remaining===0)throw Error("Daily AI request limit reached (UTC)");
    const id=randomUUID(),expires=now.getTime()+AI_PREVIEW_TTL_MS;
    this.intent={
      id,prompt,expires,generation:this.generation,
      credentialFingerprint:this.fingerprint(this.active.settings),scope,
    };
    return {approvalId:id,prompt,model:this.active.settings.model,
      provider:this.active.settings.provider,
      endpointLabel:this.active.settings.endpoint?
        new URL(this.active.settings.endpoint).origin:
        this.active.settings.provider,
      expiresAt:new Date(expires).toISOString(),maxOutputTokens:AI_OUTPUT_TOKEN_CAP};
  }

  async confirm(idInput:unknown,now=new Date(),authorizeBeforeSend?:()=>void,
    expectedScope:AIApprovalScope="chat"):Promise<AIAnswer>{
    const id=parseAIApprovalId(idInput);
    if(this.inflight)throw Error("An AI request is already in progress");
    const intent=this.intent;
    // A wrong/old approval ID invalidates the currently displayed one-time
    // preview. A matching ID from another domain is different: reject it
    // without consuming the rightful mail/project coordinator's token.
    if(!intent || intent.id!==id){
      this.intent=null;
      throw Error("AI preview expired or was replaced. Review the request again");
    }
    if(intent.scope!==expectedScope)
      throw Error("AI preview scope mismatch. Use the matching approval flow");
    this.intent=null; // Consume a correctly scoped one-time approval before I/O.
    if(intent.expires<now.getTime() || intent.generation!==this.generation || !this.active)
      throw Error("AI preview expired or was replaced. Review the request again");
    const controller=new AbortController();
    this.inflight=controller;
    this.inflightScope=expectedScope;
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
      // Domain coordinators can re-check revocable project permissions after
      // async credential resolution and immediately before any paid network I/O.
      authorizeBeforeSend?.();
      this.ledger.reserve(now); // Persist BEFORE making a potentially chargeable request.
      const result=await this.client.ask(current.settings,intent.prompt,controller.signal);
      if(controller.signal.aborted || generation!==this.generation)
        throw Error("AI request was canceled; check provider usage before retrying");
      this.ledger.recordTokens(now,result.usage.inputTokens,result.usage.outputTokens);
      return result;
    }finally{
      if(this.inflight===controller){this.inflight=null;this.inflightScope=null;}
    }
  }
}
