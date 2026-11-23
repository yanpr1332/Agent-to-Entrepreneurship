/**
 * ALPHA-SYNC-001: fail-closed wire contract for the FUTURE personal sync MVP.
 * This module defines the only eligible source fields. It does not start syncing,
 * create cloud tables, read private records, or authorize a remote caller.
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
  if (seriesId !== null &&
      (typeof seriesId !== "string" || !/^manual:[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seriesId)))
    throw Error("Only manual calendar series may sync");
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
