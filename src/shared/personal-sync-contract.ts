/**
 * ALPHA-SYNC-001/002D: fail-closed wire contract for explicitly authorized personal sync.
 * It defines the only eligible source fields and validates every network envelope/page.
 * Actual account identity and network calls remain in Electron Main; this module never
 * authorizes a caller or permits unrelated local sources to enter the sync protocol.
 */
import { parseCreateTask, type LocalTask } from "./local-model";
import {
  validateFixedSlot, validateFixedTitle, type FixedEvent,
} from "./fixed-calendar-model";
import { requireUuid } from "./cloud-model";

export type PersonalSyncEntity = "personal-task" | "manual-calendar-event";
export type PersonalSyncAction = "upsert" | "delete";
export interface PersonalTaskSnapshot {
  title: string;
  description: string;
  dueDate: string | null;
  priority: "low" | "normal" | "high";
  completed: boolean;
}
export interface ManualCalendarSnapshot {
  title: string;
  day: string;
  startMinute: number;
  durationMinutes: number;
  seriesId: string | null;
}
export type PersonalSyncOperation =
  | (SyncOperationHeader & { entityType: "personal-task"; action: "upsert"; payload: PersonalTaskSnapshot })
  | (SyncOperationHeader & { entityType: "manual-calendar-event"; action: "upsert"; payload: ManualCalendarSnapshot })
  | (SyncOperationHeader & { entityType: PersonalSyncEntity; action: "delete"; payload: null });

export interface SyncOperationHeader {
  operationId: string;
  deviceId: string;
  actorId: string;
  ownerId: string;
  entityId: string;
  /** null only when an entity is first created. Server versions are authoritative. */
  baseVersion: number | null;
  /** Diagnostic only; never used to arbitrate a conflict or authorize the request. */
  clientTimestamp: string;
}
export type SyncOperationStatus =
  "accepted" | "duplicate" | "conflict" | "rejected" | "retryable_failure";
export interface SyncOperationResult {
  status: SyncOperationStatus;
  serverVersion: number | null;
  cursor: string | null;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid personal sync record");
  return value as Record<string, unknown>;
}
function exactKeys(row: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key)))
    throw Error("Unexpected personal sync field");
}
function parseTimestamp(value: unknown): string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    throw Error("Invalid personal sync timestamp");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value)
    throw Error("Invalid personal sync timestamp");
  return value;
}
function parseVersion(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw Error("Invalid personal sync version");
  return value as number;
}
function taskPayload(value: unknown): PersonalTaskSnapshot {
  const row = record(value);
  exactKeys(row, ["title", "description", "dueDate", "priority", "completed"]);
  const parsed = parseCreateTask({
    title: row.title, description: row.description,
    dueDate: row.dueDate, priority: row.priority,
  });
  if (typeof row.completed !== "boolean") throw Error("Invalid task completion flag");
  return { ...parsed, completed: row.completed };
}
function eventPayload(value: unknown): ManualCalendarSnapshot {
  const row = record(value);
  exactKeys(row, ["title", "day", "startMinute", "durationMinutes", "seriesId"]);
  const seriesId = row.seriesId;
  if (seriesId !== null) {
    if(typeof seriesId!=="string"||!seriesId.startsWith("manual:"))
      throw Error("Only manual calendar series may sync");
    requireUuid(seriesId.slice("manual:".length));
  }
  return {
    title: validateFixedTitle(row.title),
    ...validateFixedSlot(row.day, row.startMinute, row.durationMinutes),
    seriesId: seriesId as string | null,
  };
}

/** No raw Canvas records, ICS events, mail data, paths, tokens or knowledge contents. */
export function parsePersonalSyncOperation(value: unknown): PersonalSyncOperation {
  const row = record(value);
  exactKeys(row, ["operationId", "deviceId", "actorId", "ownerId", "entityType",
    "entityId", "action", "baseVersion", "clientTimestamp", "payload"]);
  const actorId = requireUuid(row.actorId);
  const ownerId = requireUuid(row.ownerId);
  if (actorId !== ownerId) throw Error("Cross-owner personal sync prohibited");
  const header: SyncOperationHeader = {
    operationId: requireUuid(row.operationId),
    deviceId: requireUuid(row.deviceId),
    actorId, ownerId,
    entityId: requireUuid(row.entityId),
    baseVersion: parseVersion(row.baseVersion),
    clientTimestamp: parseTimestamp(row.clientTimestamp),
  };
  if (row.entityType !== "personal-task" && row.entityType !== "manual-calendar-event")
    throw Error("Unsupported personal sync entity");
  if (row.action === "delete") {
    if (row.payload !== null || header.baseVersion === null)
      throw Error("Delete requires a known version and no payload");
    return { ...header, entityType: row.entityType, action: "delete", payload: null };
  }
  if (row.action !== "upsert") throw Error("Unsupported personal sync action");
  if (row.entityType === "personal-task")
    return { ...header, entityType: "personal-task", action: "upsert",
      payload: taskPayload(row.payload) };
  return { ...header, entityType: "manual-calendar-event", action: "upsert",
    payload: eventPayload(row.payload) };
}

export function parseSyncOperationResult(value: unknown): SyncOperationResult {
  const row = record(value);
  exactKeys(row, ["status", "serverVersion", "cursor"]);
  if (!["accepted", "duplicate", "conflict", "rejected", "retryable_failure"]
    .includes(row.status as string)) throw Error("Invalid sync result status");
  const serverVersion = parseVersion(row.serverVersion);
  if (row.cursor !== null &&
      (typeof row.cursor !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.cursor)))
    throw Error("Invalid sync cursor");
  if ((row.status === "accepted" || row.status === "duplicate") &&
      (serverVersion === null || row.cursor === null))
    throw Error("Acknowledged sync result requires version and cursor");
  return { status: row.status as SyncOperationStatus,
    serverVersion, cursor: row.cursor as string | null };
}

export interface PersonalSyncChange {
  cursor:string;
  entityType:PersonalSyncEntity;
  entityId:string;
  version:number;
  payload:PersonalTaskSnapshot|ManualCalendarSnapshot|null;
  deleted:boolean;
  updatedAt:string;
}
export interface PersonalSyncPullPage {
  changes:PersonalSyncChange[];
  nextCursor:string;
  hasMore:boolean;
}

export type PersonalSyncConflictReason =
  | "remote-change-while-local-pending"
  | "remote-delete-while-local-pending"
  | "local-entity-not-eligible"
  | "remote-overlaps-study-plan"
  | "local-calendar-capacity";

export interface PersonalSyncConflict {
  entityType:PersonalSyncEntity;
  entityId:string;
  localOperationId:string|null;
  localAction:PersonalSyncAction|null;
  localPayload:PersonalTaskSnapshot|ManualCalendarSnapshot|null;
  remoteVersion:number;
  remotePayload:PersonalTaskSnapshot|ManualCalendarSnapshot|null;
  remoteDeleted:boolean;
  remoteUpdatedAt:string;
  reason:PersonalSyncConflictReason;
}
export interface PersonalSyncConflictRecord extends PersonalSyncConflict {
  createdAt:string;
  updatedAt:string;
  /** Main-derived UI eligibility; never supplied to a resolution request. */
  canResolve?:boolean;
}

/** Owner identity is never accepted from Renderer. The version and operation
 * identity are compare-and-swap guards, not authorization. */
export type PersonalSyncResolutionChoice="keep-local"|"use-remote";
export interface PersonalSyncResolutionRequest {
  entityType:PersonalSyncEntity;
  entityId:string;
  remoteVersion:number;
  localOperationId:string;
  choice:PersonalSyncResolutionChoice;
}
export function parsePersonalSyncResolutionRequest(value:unknown):PersonalSyncResolutionRequest {
  const row=record(value);
  exactKeys(row,["entityType","entityId","remoteVersion","localOperationId","choice"]);
  if(row.entityType!=="personal-task"&&row.entityType!=="manual-calendar-event")
    throw Error("Unsupported personal sync resolution entity");
  if(row.choice!=="keep-local"&&row.choice!=="use-remote")
    throw Error("Unsupported personal sync resolution choice");
  if(!Number.isSafeInteger(row.remoteVersion)||(row.remoteVersion as number)<1)
    throw Error("Invalid conflict version");
  return {
    entityType:row.entityType,entityId:requireUuid(row.entityId),
    remoteVersion:row.remoteVersion as number,localOperationId:requireUuid(row.localOperationId),
    choice:row.choice,
  };
}
/** Old ownerless rows have NO trustworthy owner, and are never a source of
 * automatic upload. A displayed old payload/version is not an upload source. */
export interface PersonalSyncLegacyItem {
  legacyStore:"task-database"|"calendar-database";
  entityType:PersonalSyncEntity;
  entityId:string;
  operationId:string|null;
  action:"upsert"|"delete"|"enrolled";
  title:string|null;
  createdAt:string;
  canReauthorize:boolean;
}
export interface PersonalSyncLegacyReview {
  items:PersonalSyncLegacyItem[];
  taskLimitReached:boolean;
  calendarLimitReached:boolean;
}
export interface PersonalSyncLegacyAdoptionRequest {
  entityType:PersonalSyncEntity;
  entityId:string;
  expectedAction:"upsert"|"enrolled";
  expectedOperationId:string|null;
  confirmation:true;
}
/** Renderer cannot choose an account, reuse an old server version, or submit a
 * historical payload. The Main process obtains owner identity from its session. */
export function parsePersonalSyncLegacyAdoptionRequest(value:unknown):PersonalSyncLegacyAdoptionRequest{
  const row=record(value);
  exactKeys(row,["entityType","entityId","expectedAction","expectedOperationId","confirmation"]);
  if(row.entityType!=="personal-task"&&row.entityType!=="manual-calendar-event")
    throw Error("Unsupported legacy personal sync entity");
  if(row.confirmation!==true)throw Error("Explicit legacy sync confirmation is required");
  if(row.expectedAction!=="upsert"&&row.expectedAction!=="enrolled")
    throw Error("Historical deletion cannot be automatically re-authorized");
  const expectedOperationId=row.expectedAction==="upsert"
    ?requireUuid(row.expectedOperationId)
    :row.expectedOperationId===null?null:(()=>{throw Error("Unexpected legacy operation id");})();
  return {
    entityType:row.entityType,entityId:requireUuid(row.entityId),
    expectedAction:row.expectedAction,expectedOperationId,confirmation:true,
  };
}

export interface PersonalSyncCandidate {
  entityType:PersonalSyncEntity;
  entityId:string;
  title:string;
  detail:string|null;
  enabled:boolean;
  serverVersion:number|null;
}
export interface PersonalSyncRunResult {
  ownerId:string;
  deviceId:string;
  pushed:number;
  pulled:number;
  pullPages:number;
  conflicts:number;
  pushConflicts:number;
  rejected:number;
  retryableFailures:number;
  /** Remote changes were found before upload; this run pulls first, never pushes stale intent. */
  pushDeferred:boolean;
  pending:number;
  cursor:string;
  hasMore:boolean;
}


/** Parse a bounded, ordered page before any local database mutation. */
export function parsePersonalSyncPullPage(value:unknown):PersonalSyncPullPage {
  const row=record(value);
  exactKeys(row,["changes","nextCursor","hasMore"]);
  if(!Array.isArray(row.changes)||row.changes.length>500||typeof row.hasMore!=="boolean"||
    (row.hasMore&&row.changes.length===0))
    throw Error("Invalid personal sync page");
  if(typeof row.nextCursor!=="string"||!/^(0|[1-9][0-9]{0,18})$/.test(row.nextCursor))
    throw Error("Invalid personal sync cursor");
  const changes=row.changes.map((input):PersonalSyncChange=>{
    const change=record(input);
    exactKeys(change,["cursor","entityType","entityId","version","payload","deleted","updatedAt"]);
    if(typeof change.cursor!=="string"||!/^[1-9][0-9]{0,18}$/.test(change.cursor))
      throw Error("Invalid personal sync change cursor");
    if(change.entityType!=="personal-task"&&change.entityType!=="manual-calendar-event")
      throw Error("Unsupported personal sync change");
    if(typeof change.deleted!=="boolean")throw Error("Invalid personal sync deletion marker");
    const version=parseVersion(change.version);
    if(version===null||version<1)throw Error("Invalid personal sync change version");
    const payload=change.deleted
      ? (change.payload===null?null:(()=>{throw Error("Deleted sync change cannot contain a payload");})())
      : change.entityType==="personal-task"?taskPayload(change.payload):eventPayload(change.payload);
    return {
      cursor:change.cursor,entityType:change.entityType,entityId:requireUuid(change.entityId),
      version,payload,deleted:change.deleted,updatedAt:parseTimestamp(change.updatedAt),
    };
  });
  for(let i=1;i<changes.length;i++){
    if(BigInt(changes[i].cursor)<=BigInt(changes[i-1].cursor))
      throw Error("Personal sync changes are not strictly ordered");
  }
  if(changes.length&&row.nextCursor!==changes[changes.length-1].cursor)
    throw Error("Personal sync page cursor must equal its last change");
  return {changes,nextCursor:row.nextCursor,hasMore:row.hasMore};
}

/** This is a projection only. No network or side effects. */
export function projectPersonalTask(task: LocalTask, explicitlyEnabled: boolean): PersonalTaskSnapshot | null {
  // Consent must be supplied by the future per-account/scope preference flow.
  if (explicitlyEnabled !== true || task.source !== null || !task.visible) return null;
  return taskPayload({
    title: task.title, description: task.description,
    dueDate: task.dueDate, priority: task.priority, completed: task.completed,
  });
}
export function projectManualCalendarEvent(event: FixedEvent, explicitlyEnabled: boolean): ManualCalendarSnapshot | null {
  if (explicitlyEnabled !== true || event.source !== "manual" || event.sourceUid !== null) return null;
  return eventPayload({
    title: event.title, day: event.day, startMinute: event.startMinute,
    durationMinutes: event.durationMinutes, seriesId: event.seriesId,
  });
}
