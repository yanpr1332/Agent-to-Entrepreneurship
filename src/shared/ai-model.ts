export type AIProvider="openai"|"anthropic"|"gemini"|"deepseek"|"compatible";
export type AIKeySource="saved"|"environment";
export type AIConfigurationWarning="invalid_environment_key";
export const AI_DEFAULT_MODEL="gpt-4.1-mini";
export const AI_MAX_PROMPT_CHARS=7000;
export const AI_OUTPUT_TOKEN_CAP=512;
export const AI_DAILY_REQUEST_CAP=12;
export const AI_PREVIEW_TTL_MS=120_000;
export const AI_MODEL_DEFAULTS:Record<Exclude<AIProvider,"compatible">,string>={
  openai:AI_DEFAULT_MODEL,anthropic:"claude-sonnet-4-5",gemini:"gemini-2.5-flash",
  deepseek:"deepseek-flash",
};
export interface AIConnectInput{apiKey:string;model:string;provider?:AIProvider;endpoint?:string|null;}
export interface AIPrivateSettings{apiKey:string;model:string;provider:AIProvider;endpoint:string|null;}
export interface AIStatus{
  connected:boolean;running:boolean;provider:AIProvider|null;model:string|null;
  keySource:AIKeySource|null;configurationWarning:AIConfigurationWarning|null;
  usedToday:number;remainingToday:number;dailyRequestLimit:number;
  maxOutputTokens:number;lastRequestAt:string|null;
}
export interface AIPreview{
  approvalId:string;model:string;provider:AIProvider;endpointLabel:string;prompt:string;
  expiresAt:string;maxOutputTokens:number;
}
export interface AIAnswer{
  text:string;model:string;createdAt:string;
  usage:{inputTokens:number|null;outputTokens:number|null};
}
export function parseAIProvider(input:unknown):AIProvider{
  if(input!=="openai"&&input!=="anthropic"&&input!=="gemini"&&input!=="deepseek"&&input!=="compatible")
    throw Error("Unsupported AI provider protocol");
  return input;
}
export function parseAIModel(value:unknown):string{
  if(typeof value!=="string"||value.length>100||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(value)||
    value.includes("..")||value.includes("//"))
    throw Error("Invalid explicit provider model ID");
  return value;
}
export function parseAIEndpoint(input:unknown):string{
  if(typeof input!=="string"||input.length>300)throw Error("Invalid compatible endpoint");
  let url:URL;
  try{url=new URL(input);}catch{throw Error("Invalid compatible endpoint URL");}
  const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,"");
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||
     url.port||url.hostname.endsWith(".")||!host.includes(".")||
     host==="localhost"||host.endsWith(".localhost")||host.endsWith(".local")||
     host.endsWith(".internal")||host.endsWith(".test")||host.endsWith(".invalid")||
     /^[0-9.]+$/.test(host)||host.includes(":")||/^(?:0x|0[0-9])/.test(host)||!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host)||
     !/\/chat\/completions\/?$/.test(url.pathname))
    throw Error("Compatible endpoint must be a public HTTPS chat/completions URL");
  return url.toString();
}
export function parseAIConnect(input:unknown):AIPrivateSettings{
  if(!input||typeof input!=="object"||Array.isArray(input))
    throw Error("Invalid AI request");
  const fields=input as Record<string,unknown>,keys=Object.keys(fields);
  if(keys.some(x=>!["apiKey","model","provider","endpoint"].includes(x))||
     !keys.includes("apiKey")||!keys.includes("model"))
    throw Error("Invalid AI request fields");
  const provider=parseAIProvider(fields.provider??"openai");
  if(typeof fields.apiKey!=="string"||!/^[A-Za-z0-9_./+=:-]{12,512}$/.test(fields.apiKey))
    throw Error("Invalid personal AI provider key format");
  if(provider==="openai"&&!/^sk-[A-Za-z0-9_-]{20,}$/.test(fields.apiKey))
    throw Error("Invalid OpenAI API key format");
  const model=parseAIModel(fields.model);
  if(provider==="openai"&&!/^gpt-[a-z0-9._-]+$/i.test(model))
    throw Error("Select an OpenAI GPT model ID");
  const endpoint=provider==="compatible"?parseAIEndpoint(fields.endpoint):null;
  if(provider!=="compatible"&&fields.endpoint!==undefined&&fields.endpoint!==null)
    throw Error("Only OpenAI-compatible providers may set a custom endpoint");
  return {apiKey:fields.apiKey,model,provider,endpoint};
}
export function parseAIPrompt(value:unknown):string{
  if(typeof value!=="string"||!value.trim()||value.length>AI_MAX_PROMPT_CHARS||
     /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    throw Error("Question must be 1–7000 text characters");
  return value.trim();
}
export function parseAIApprovalId(value:unknown):string{
  if(typeof value!=="string"||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw Error("Invalid AI confirmation");
  return value;
}
