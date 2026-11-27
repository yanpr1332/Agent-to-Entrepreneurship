export type AIProjectSourceType="task";
export type AIProjectAction=
  "planning.propose"|"task.write"|"calendar.write"|"mail.send"|"file.write"|"external.tool";
export type AIProjectDestination="local"|"configured-model";
export type AIProjectAuditKind=
  "project.created"|"project.renamed"|"project.archived"|
  "source.grant.updated"|"source.grant.revoked"|
  "action.grant.updated"|"source.access"|"action.access";
export interface AIProject{
  id:string;name:string;purpose:string;createdAt:string;updatedAt:string;
  archivedAt:string|null;
}
export interface AIProjectSourceGrant{
  projectId:string;sourceType:AIProjectSourceType;sourceId:string;
  canReadLocal:boolean;canSendRemote:boolean;expiresAt:string|null;
  createdAt:string;updatedAt:string;revokedAt:string|null;
}
export interface AIProjectActionGrant{
  projectId:string;action:AIProjectAction;enabled:boolean;
  expiresAt:string|null;updatedAt:string;available:boolean;
}
export interface AIProjectAuditEvent{
  id:string;projectId:string;kind:AIProjectAuditKind;
  sourceType:AIProjectSourceType|null;sourceId:string|null;
  action:AIProjectAction|null;destination:AIProjectDestination|null;
  result:"recorded"|"allowed"|"denied";occurredAt:string;
}
export interface AIProjectCreateInput{name:string;purpose:string;}
export interface AIProjectRenameInput{id:string;name:string;purpose:string;}
export interface AIProjectSourceGrantInput{
  projectId:string;sourceType:AIProjectSourceType;sourceId:string;
  canReadLocal:boolean;canSendRemote:boolean;expiresAt:string|null;
}
export interface AIProjectSourceRevokeInput{
  projectId:string;sourceType:AIProjectSourceType;sourceId:string;
}
export interface AIProjectActionGrantInput{
  projectId:string;action:AIProjectAction;enabled:boolean;expiresAt:string|null;
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS:readonly AIProjectAction[]=[
  "planning.propose","task.write","calendar.write","mail.send","file.write","external.tool",
];
function record(raw:unknown):Record<string,unknown>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("Invalid AI project request");
  return raw as Record<string,unknown>;
}
function exact(x:Record<string,unknown>,keys:string[]):void{
  if(Object.keys(x).sort().join(",")!==[...keys].sort().join(","))
    throw Error("Unexpected AI project request fields");
}
function uuid(value:unknown,label:string):string{
  if(typeof value!=="string"||!UUID.test(value))throw Error("Invalid "+label);
  return value.toLowerCase();
}
function text(value:unknown,label:string,max:number,required:boolean):string{
  if(typeof value!=="string"||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    throw Error("Invalid "+label);
  const normalized=value.trim();
  if(required&&!normalized)throw Error("Invalid "+label);
  return normalized;
}
function expiry(value:unknown):string|null{
  if(value===null)return null;
  if(typeof value!=="string"||value.length>32)throw Error("Invalid permission expiry");
  const date=new Date(value);
  if(!Number.isFinite(date.getTime())||date.toISOString()!==value)
    throw Error("Permission expiry must be a canonical UTC ISO timestamp");
  return value;
}
export function parseAIProjectId(raw:unknown):string{return uuid(raw,"project ID");}
export function parseAIProjectCreate(raw:unknown):AIProjectCreateInput{
  const x=record(raw);exact(x,["name","purpose"]);
  return {name:text(x.name,"project name",80,true),purpose:text(x.purpose,"project purpose",300,false)};
}
export function parseAIProjectRename(raw:unknown):AIProjectRenameInput{
  const x=record(raw);exact(x,["id","name","purpose"]);
  return {id:uuid(x.id,"project ID"),name:text(x.name,"project name",80,true),
    purpose:text(x.purpose,"project purpose",300,false)};
}
export function parseAIProjectSourceGrant(raw:unknown):AIProjectSourceGrantInput{
  const x=record(raw);exact(x,["projectId","sourceType","sourceId","canReadLocal","canSendRemote","expiresAt"]);
  if(x.sourceType!=="task"||typeof x.canReadLocal!=="boolean"||
    typeof x.canSendRemote!=="boolean"||(!x.canReadLocal&&x.canSendRemote))
    throw Error("Invalid task source permissions");
  if(!x.canReadLocal&&!x.canSendRemote)throw Error("Revoke a source grant instead of saving an empty grant");
  return {projectId:uuid(x.projectId,"project ID"),sourceType:"task",
    sourceId:uuid(x.sourceId,"task ID"),canReadLocal:x.canReadLocal,
    canSendRemote:x.canSendRemote,expiresAt:expiry(x.expiresAt)};
}
export function parseAIProjectSourceRevoke(raw:unknown):AIProjectSourceRevokeInput{
  const x=record(raw);exact(x,["projectId","sourceType","sourceId"]);
  if(x.sourceType!=="task")throw Error("Unsupported AI project source");
  return {projectId:uuid(x.projectId,"project ID"),sourceType:"task",sourceId:uuid(x.sourceId,"task ID")};
}
export function parseAIProjectActionGrant(raw:unknown):AIProjectActionGrantInput{
  const x=record(raw);exact(x,["projectId","action","enabled","expiresAt"]);
  if(typeof x.action!=="string"||!ACTIONS.includes(x.action as AIProjectAction)||
    typeof x.enabled!=="boolean")throw Error("Invalid AI project action permission");
  return {projectId:uuid(x.projectId,"project ID"),action:x.action as AIProjectAction,
    enabled:x.enabled,expiresAt:expiry(x.expiresAt)};
}
export const AI_PROJECT_ACTIONS=ACTIONS;
export const AI_PROJECT_IMPLEMENTED_ACTIONS:readonly AIProjectAction[]=["planning.propose"];
