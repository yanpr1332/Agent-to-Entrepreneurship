import {
  AI_OUTPUT_TOKEN_CAP, parseAIPrompt, parseAIModel,
  type AIAnswer, type AIPrivateSettings,
} from "../../shared/ai-model";

const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const RESPONSE_LIMIT_BYTES = 192 * 1024;
const NETWORK_TIMEOUT_MS = 25_000;

type FetchProvider = (input: string, init: RequestInit) => Promise<Response>;

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader=response.body?.getReader();
  if(!reader)throw new Error("AI provider returned no data");
  const parts:Uint8Array[]=[];
  let total=0;
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.byteLength;
      if(total>RESPONSE_LIMIT_BYTES)throw new Error("AI provider response exceeded safety limits");
      parts.push(value);
    }
  }finally{reader.releaseLock();}
  const all=Buffer.concat(parts.map(part=>Buffer.from(part)));
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(all));}
  catch{throw new Error("AI provider response was malformed");}
}

function extractText(raw:unknown):{
  text:string;model:string;usage:{inputTokens:number|null;outputTokens:number|null};
}{
  if(!raw || typeof raw!=="object" || Array.isArray(raw))
    throw new Error("AI provider returned an invalid response");
  const response=raw as Record<string,unknown>;
  if(response.status!=="completed" || !Array.isArray(response.output))
    throw new Error("AI response was incomplete; no answer is shown");
  const parts:string[]=[];
  for(const item of response.output){
    if(!item || typeof item!=="object")continue;
    const entry=item as Record<string,unknown>;
    if(entry.type!=="message" || !Array.isArray(entry.content))continue;
    for(const bit of entry.content){
      if(!bit || typeof bit!=="object")continue;
      const block=bit as Record<string,unknown>;
      if(block.type==="output_text" && typeof block.text==="string")parts.push(block.text);
    }
  }
  const text=parts.join("\n").trim();
  if(!text || text.length>40_000)throw new Error("AI response was empty or too long");
  const usage=response.usage;
  const u=usage && typeof usage==="object" ? usage as Record<string,unknown> : {};
  const count=(x:unknown)=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=0?x:null;
  return {text,model:typeof response.model==="string"?response.model:"unknown",
    usage:{inputTokens:count(u.input_tokens),outputTokens:count(u.output_tokens)}};
}

/** Fixed HTTPS endpoint, no plugins/tools/file access, zero automatic retries. */
export class OpenAIResponsesClient {
  constructor(private readonly fetcher:FetchProvider=(url,init)=>fetch(url,init)){}
  async ask(settings:AIPrivateSettings,promptInput:unknown,signal?:AbortSignal):Promise<AIAnswer>{
    const prompt=parseAIPrompt(promptInput);
    const model=parseAIModel(settings.model);
    let response:Response;
    try{
      const requestSignal=signal
        ? AbortSignal.any([signal,AbortSignal.timeout(NETWORK_TIMEOUT_MS)])
        : AbortSignal.timeout(NETWORK_TIMEOUT_MS);
      response=await this.fetcher(RESPONSES_ENDPOINT,{
        method:"POST",
        redirect:"error",
        signal:requestSignal,
        headers:{
          Authorization:`Bearer ${settings.apiKey}`,
          "Content-Type":"application/json",
          Accept:"application/json",
        },
        body:JSON.stringify({
          model,store:false,max_output_tokens:AI_OUTPUT_TOKEN_CAP,
          tools:[],
          instructions:"你是学习助手。只根据用户明确提交的单次问题回答。不得声称你读取了个人日历、学校邮箱、Canvas、文件或团队资料；不要编造引用或声称执行了任何工具。对不确定内容说明限制。",
          input:[{role:"user",content:[{type:"input_text",text:prompt}]}],
        }),
      });
    }catch{
      throw new Error("AI request failed or timed out; delivery/cost may be uncertain. Do not retry automatically");
    }
    if(!response.ok){
      // Never return HTTP body, request headers, IDs or user content.
      if(response.status===401||response.status===403)
        throw new Error("AI authentication failed; check the project API key and permissions");
      if(response.status===429)throw new Error("AI provider rate or quota limit reached");
      throw new Error(`AI provider rejected the request (HTTP ${response.status})`);
    }
    const answer=extractText(await readBoundedJson(response));
    return {text:answer.text,model:answer.model,usage:answer.usage,createdAt:new Date().toISOString()};
  }
}
