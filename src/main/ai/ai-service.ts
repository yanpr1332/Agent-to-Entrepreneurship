import { randomUUID } from "node:crypto";
import {
  AI_DEFAULT_MODEL, AI_DAILY_REQUEST_CAP, AI_OUTPUT_TOKEN_CAP, AI_PREVIEW_TTL_MS,
  parseAIPrompt, parseAIApprovalId, parseAIConnect,
  type AIAnswer, type AIStatus, type AIPreview,
} from "../../shared/ai-model";
import { AIKeyVault } from "./ai-vault";
import { AIUsageLedger } from "./ai-usage";
import { OpenAIResponsesClient } from "./openai-responses";

/** Explicit two-step approval. No background AI calls, task/calendar writes or telemetry. */
export class AIService {
  private connected=false;
  private model:string|null=null;
  private intent:{id:string;prompt:string;expires:number;generation:number}|null=null;
  private inflight:AbortController|null=null;
  private generation=0;
  constructor(
    private readonly vault:AIKeyVault,
    private readonly ledger:AIUsageLedger,
    private readonly client:Pick<OpenAIResponsesClient,"ask">=new OpenAIResponsesClient(),
  ){}

  async initialize():Promise<AIStatus>{
    const current=await this.vault.load();
    this.connected=!!current;
    this.model=current?.model??null;
    return this.status();
  }

  status():AIStatus{
    const quota=this.ledger.today();
    return {
      connected:this.connected,running:this.inflight!==null,
      provider:"openai",model:this.model,
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
    this.connected=true;
    this.model=config.model;
    return this.status();
  }

  async disconnect():Promise<AIStatus>{
    this.cancel();
    await this.vault.clear();
    this.connected=false;
    this.model=null;
    // Request quota remains persistent; disconnect never resets it.
    return this.status();
  }

  prepare(promptInput:unknown,now=new Date()):AIPreview {
    const prompt=parseAIPrompt(promptInput);
    if(!this.connected || !this.model)throw Error("Connect your own OpenAI project key first");
    if(this.inflight)throw Error("An AI request is already in progress");
    if(this.ledger.today(now).remaining===0)throw Error("Daily AI request limit reached (UTC)");
    const id=randomUUID(),expires=now.getTime()+AI_PREVIEW_TTL_MS;
    this.intent={id,prompt,expires,generation:this.generation};
    return {approvalId:id,prompt,model:this.model,
      expiresAt:new Date(expires).toISOString(),maxOutputTokens:AI_OUTPUT_TOKEN_CAP};
  }

  async confirm(idInput:unknown,now=new Date()):Promise<AIAnswer>{
    const id=parseAIApprovalId(idInput);
    if(this.inflight)throw Error("An AI request is already in progress");
    const intent=this.intent;
    this.intent=null; // One-time regardless of provider response.
    if(!intent || intent.id!==id || intent.expires<now.getTime() ||
       intent.generation!==this.generation || !this.connected){
      throw Error("AI preview expired or was replaced. Review the question again");
    }
    const controller=new AbortController();
    this.inflight=controller;
    const generation=this.generation;
    try{
      const config=await this.vault.load();
      if(!config || generation!==this.generation || controller.signal.aborted)
        throw Error("AI provider changed or the request was canceled");
      this.ledger.reserve(now); // Persist BEFORE making a potentially chargeable request.
      const result=await this.client.ask(config,intent.prompt,controller.signal);
      if(controller.signal.aborted || generation!==this.generation)
        throw Error("AI request was canceled; check provider usage before retrying");
      this.ledger.recordTokens(now,result.usage.inputTokens,result.usage.outputTokens);
      return result;
    }finally{
      if(this.inflight===controller)this.inflight=null;
    }
  }
}
