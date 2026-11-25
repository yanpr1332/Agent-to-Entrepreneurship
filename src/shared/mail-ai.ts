import {parseAIApprovalId} from "./ai-model";
import {parseCreateTask} from "./local-model";

export type MailAIKind="coursework"|"deadline"|"event"|"none";
export interface MailAIRef {uid:number;uidValidity:number;}
export interface MailAISelection {sources:MailAIRef[];includeBodies?:boolean;}
export interface MailAIProposal extends MailAIRef {
  kind:MailAIKind;title:string;dueDate:string|null;reason:string;
  /** Displays data from the current authorized local mail header. */
  subject:string;
}
export interface MailAIReview {
  reviewId:string;expiresAt:string;model:string;
  usage:{inputTokens:number|null;outputTokens:number|null};
  items:MailAIProposal[];
}
export interface MailAIApply extends MailAIRef {
  reviewId:string;title:string;dueDate:string|null;
}
const NO_CONTROL=/[\u0000-\u001f\u007f]/;
function exact(input:unknown,fields:string[]):Record<string,unknown>{
  if(!input||typeof input!=="object"||Array.isArray(input))
    throw Error("Invalid mail AI request");
  const value=input as Record<string,unknown>;
  if(Object.keys(value).sort().join(",")!==fields.sort().join(","))
    throw Error("Unexpected mail AI fields");
  return value;
}
function number(input:unknown):number{
  if(!Number.isSafeInteger(input)||(input as number)<1)
    throw Error("Invalid mail AI message identity");
  return input as number;
}
export function mailAIKey(ref:MailAIRef):string{
  return ref.uidValidity+":"+ref.uid;
}
export function parseMailAISelection(input:unknown):MailAISelection{
  const incoming=input as Record<string,unknown>;
  const value=exact(input,("includeBodies" in incoming)?["sources","includeBodies"]:["sources"]);
  if(value.includeBodies!==undefined&&typeof value.includeBodies!=="boolean")
    throw Error("Mail body permission must be explicit boolean");
  if(!Array.isArray(value.sources)||value.sources.length<1||value.sources.length>3)
    throw Error("Select 1–3 mail headers explicitly");
  const sources=value.sources.map(item=>{
    const r=exact(item,["uid","uidValidity"]);
    return {uid:number(r.uid),uidValidity:number(r.uidValidity)};
  });
  if(new Set(sources.map(mailAIKey)).size!==sources.length)
    throw Error("Duplicate mail AI selection");
  return {sources,...(value.includeBodies===true?{includeBodies:true}:{})};
}
export function parseMailAIApply(input:unknown):MailAIApply{
  const v=exact(input,["reviewId","uid","uidValidity","title","dueDate"]);
  const task=parseCreateTask({title:v.title,dueDate:v.dueDate});
  if(NO_CONTROL.test(task.title))throw Error("Invalid mail task title");
  return {reviewId:parseAIApprovalId(v.reviewId),
    uid:number(v.uid),uidValidity:number(v.uidValidity),
    title:task.title,dueDate:task.dueDate};
}

/** Mail subjects are untrusted hints. Model output must be strict JSON
 * with one item for each specifically authorized header. Dates are never
 * derived from mail sent_at; only verbatim ISO dates in the actual source
 * subject may appear as model-suggested deadlines. */
export function parseMailAIAnswer(input:unknown,
  selected:readonly {uid:number;uidValidity:number;subject:string;body?:string}[]):
  Array<Pick<MailAIProposal,"uid"|"uidValidity"|"kind"|"title"|"dueDate"|"reason">>{
  if(typeof input!=="string"||input.length>8000)throw Error("Invalid AI mail answer");
  let raw:unknown;
  try{raw=JSON.parse(input);}catch{throw Error("AI mail answer must be strict JSON");}
  const data=exact(raw,["items"]);
  if(!Array.isArray(data.items)||data.items.length!==selected.length)
    throw Error("AI mail answer count mismatch");
  const byId=new Map(selected.map(item=>[mailAIKey(item),item]));
  const seen=new Set<string>();
  return data.items.map(item=>{
    const o=exact(item,["uid","uidValidity","kind","title","dueDate","reason"]);
    const ref={uid:number(o.uid),uidValidity:number(o.uidValidity)};
    const key=mailAIKey(ref),mail=byId.get(key);
    if(!mail||seen.has(key))throw Error("AI cited an unapproved mail identity");
    seen.add(key);
    if(o.kind!=="coursework"&&o.kind!=="deadline"&&o.kind!=="event"&&o.kind!=="none")
      throw Error("Unknown AI mail kind");
    if(typeof o.title!=="string"||o.title.length>120||NO_CONTROL.test(o.title))
      throw Error("Invalid AI candidate title");
    if(o.kind!=="none"&&!o.title.trim())
      throw Error("AI mail title cannot be empty");
    if(typeof o.reason!=="string"||o.reason.length>160||NO_CONTROL.test(o.reason))
      throw Error("Invalid AI mail explanation");
    const task=parseCreateTask({
      title:o.kind==="none"?"No action suggested":o.title,dueDate:o.dueDate,
    });
    if(task.dueDate&&!mail.subject.includes(task.dueDate)&&
       !mail.body?.includes(task.dueDate))
      throw Error("AI invented an unsupported mail deadline");
    return {...ref,kind:o.kind,title:o.kind==="none"?"":task.title,
      dueDate:task.dueDate,reason:o.reason};
  });
}
