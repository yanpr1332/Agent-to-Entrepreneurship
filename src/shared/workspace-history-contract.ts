import {requireUuid,type SharedMessage,type SharedTask} from "./cloud-model";

export const MAX_WORKSPACE_HISTORY_PAGE=100;
const MAX_CURSOR=9223372036854775807n;
export type WorkspaceHistoryKind="message"|"task";
export type WorkspaceHistoryAction="upsert"|"delete";
export interface WorkspaceHistoryChange {
  cursor:string;kind:WorkspaceHistoryKind;action:WorkspaceHistoryAction;
  entityId:string;record:SharedMessage|SharedTask|null;
}
export interface WorkspaceHistoryPage {
  changes:WorkspaceHistoryChange[];
  nextCursor:string;
  serverCursor:string;
  hasMore:boolean;
}
export interface WorkspaceHistoryMarker {createdAt:string;id:string;}
export interface WorkspaceHistoryItems<T> {
  items:T[];
  nextBefore:WorkspaceHistoryMarker|null;
  hasMore:boolean;
}
export interface WorkspaceHistoryStatus {
  mode:"durable"|"fallback";
  cursor:string|null;
  applied:number;
  hasMore:boolean;
  totalMessages:number|null;
  totalTasks:number|null;
}

function obj(value:unknown):Record<string,unknown>{
  if(value===null||typeof value!=="object"||Array.isArray(value))throw Error("Malformed workspace history object");
  return value as Record<string,unknown>;
}
function exact(row:Record<string,unknown>,keys:string[]):void{
  if(Object.keys(row).some(k=>!keys.includes(k))||keys.some(k=>!Object.hasOwn(row,k)))
    throw Error("Unexpected workspace history property");
}
export function workspaceCursor(value:unknown):string{
  if(typeof value!=="string"||!/^(0|[1-9][0-9]{0,18})$/.test(value)||
    BigInt(value)>MAX_CURSOR)throw Error("Malformed workspace history cursor");
  return value;
}
function iso(value:unknown):string{
  if(typeof value!=="string"||value.length>50||!Number.isFinite(Date.parse(value))||
    !/^\d{4}-\d{2}-\d{2}T/.test(value))throw Error("Malformed workspace timestamp");
  return value;
}
function validDate(value:unknown):string|null{
  if(value===null)return null;
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value)||
     !Number.isFinite(Date.parse(value+"T00:00:00Z"))||
     new Date(value+"T00:00:00Z").toISOString().slice(0,10)!==value)
    throw Error("Malformed workspace due date");
  return value;
}
function nonempty(value:unknown,max:number):string{
  if(typeof value!=="string"||value.length<1||value.length>max)
    throw Error("Malformed workspace history text");
  return value;
}
function parseRecord(value:unknown,kind:WorkspaceHistoryKind,workspace:string,id:string):
  SharedMessage|SharedTask{
  const row=obj(value);
  if(requireUuid(row.id)!==id||requireUuid(row.workspace_id)!==workspace)
    throw Error("Workspace history row ownership mismatch");
  if(kind==="message"){
    exact(row,["id","workspace_id","author_id","body","created_at"]);
    return {id,workspace_id:workspace,author_id:requireUuid(row.author_id),
      body:nonempty(row.body,2000),created_at:iso(row.created_at)};
  }
  exact(row,["id","workspace_id","created_by","title","due_date","assigned_to",
    "completed","created_at","updated_at"]);
  if(typeof row.completed!=="boolean")throw Error("Malformed workspace task completion");
  return {id,workspace_id:workspace,created_by:requireUuid(row.created_by),
    title:nonempty(row.title,120),due_date:validDate(row.due_date),
    assigned_to:row.assigned_to===null?null:requireUuid(row.assigned_to),
    completed:row.completed,created_at:iso(row.created_at),updated_at:iso(row.updated_at)};
}
export function parseWorkspaceHistoryPage(value:unknown,workspaceInput:unknown,
  fromInput:unknown):WorkspaceHistoryPage{
  const workspace=requireUuid(workspaceInput),from=workspaceCursor(fromInput);
  const row=obj(value);
  exact(row,["changes","nextCursor","serverCursor","hasMore"]);
  if(!Array.isArray(row.changes)||row.changes.length>MAX_WORKSPACE_HISTORY_PAGE||
     typeof row.hasMore!=="boolean")throw Error("Malformed workspace history page");
  const nextCursor=workspaceCursor(row.nextCursor);
  const serverCursor=workspaceCursor(row.serverCursor);
  if(BigInt(from)>BigInt(serverCursor)||BigInt(nextCursor)>BigInt(serverCursor))
    throw Error("Workspace history cursor ahead of server");
  let cursor=BigInt(from);
  const changes:WorkspaceHistoryChange[]=row.changes.map(item=>{
    const change=obj(item);
    exact(change,["cursor","kind","action","entityId","record"]);
    const current=BigInt(workspaceCursor(change.cursor));
    if(current!==cursor+1n)throw Error("Workspace history sequence gap or duplicate");
    cursor=current;
    if(change.kind!=="message"&&change.kind!=="task")throw Error("Unknown workspace history entity");
    if(change.action!=="upsert"&&change.action!=="delete")
      throw Error("Unknown workspace history action");
    const entityId=requireUuid(change.entityId);
    if(change.action==="delete"&&change.record!==null)
      throw Error("Workspace tombstone includes unexpected record");
    const record=change.action==="upsert"?
      parseRecord(change.record,change.kind,workspace,entityId):null;
    return {cursor:current.toString(),kind:change.kind,action:change.action,entityId,record};
  });
  if(cursor!==BigInt(nextCursor)||(!row.hasMore&&nextCursor!==serverCursor)||
     (row.hasMore&&BigInt(nextCursor)>=BigInt(serverCursor))||
     (row.hasMore&&changes.length===0))
    throw Error("Inconsistent workspace history page boundary");
  return {changes,nextCursor,serverCursor,hasMore:row.hasMore};
}
export function parseWorkspaceHistoryMarker(value:unknown):WorkspaceHistoryMarker{
  const row=obj(value);
  exact(row,["createdAt","id"]);
  return {createdAt:iso(row.createdAt),id:requireUuid(row.id)};
}
