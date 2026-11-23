import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type PersonalSyncEntityType = "personal-task" | "manual-calendar-event";
export type PersonalSyncAction = "upsert" | "delete";
export type PersonalSyncQueueStatus = "pending" | "in_flight" | "conflict" | "failed";

export interface PersonalSyncOutboxItem {
  operationId: string;
  ownerId: string;
  entityType: PersonalSyncEntityType;
  entityId: string;
  action: PersonalSyncAction;
  baseVersion: number | null;
  payload: unknown | null;
  createdAt: string;
  status: PersonalSyncQueueStatus;
  attempts: number;
  lastError: string | null;
}

export interface PersonalSyncSelection {
  ownerId: string;
  entityType: PersonalSyncEntityType;
  entityId: string;
  enabled: boolean;
  serverVersion: number | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireSyncUuid(value: unknown, label = "sync identifier"): string {
  if (typeof value !== "string" || !UUID.test(value)) throw Error("Invalid " + label);
  return value;
}

export function initializePersonalSyncSchema(db: DatabaseSync, requestedDeviceId?: string): string {
  db.exec(
    "CREATE TABLE IF NOT EXISTS personal_sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);" +
    "CREATE TABLE IF NOT EXISTS personal_sync_entities (" +
    "owner_id TEXT NOT NULL, entity_type TEXT NOT NULL CHECK(entity_type IN('personal-task','manual-calendar-event'))," +
    "entity_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1))," +
    "server_version INTEGER CHECK(server_version IS NULL OR server_version>=0)," +
    "last_synced_at TEXT, last_error TEXT, PRIMARY KEY(owner_id,entity_type,entity_id));" +
    "CREATE TABLE IF NOT EXISTS personal_sync_outbox (" +
    "operation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL," +
    "entity_type TEXT NOT NULL CHECK(entity_type IN('personal-task','manual-calendar-event'))," +
    "entity_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN('upsert','delete'))," +
    "base_version INTEGER CHECK(base_version IS NULL OR base_version>=0), payload_json TEXT," +
    "created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' " +
    "CHECK(status IN('pending','in_flight','conflict','failed'))," +
    "attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), last_error TEXT," +
    "CHECK((action='upsert' AND payload_json IS NOT NULL) OR (action='delete' AND payload_json IS NULL)));" +
    "CREATE INDEX IF NOT EXISTS idx_personal_sync_outbox_owner_status " +
    "ON personal_sync_outbox(owner_id,status,created_at);"
  );
  const existing = db.prepare("SELECT value FROM personal_sync_meta WHERE key='device_id'")
    .get() as {value:string} | undefined;
  const requested = requestedDeviceId === undefined ? undefined : requireSyncUuid(requestedDeviceId, "device id");
  if (existing) {
    const stored = requireSyncUuid(existing.value, "stored device id");
    // ate-local.sqlite is the canonical device identity; the separate calendar
    // database adopts it when restored independently or migrated from an older copy.
    if (requested && requested !== stored) {
      db.prepare("UPDATE personal_sync_meta SET value=? WHERE key='device_id'").run(requested);
      return requested;
    }
    return stored;
  }
  const deviceId = requested ?? randomUUID();
  db.prepare("INSERT INTO personal_sync_meta(key,value) VALUES('device_id',?)").run(deviceId);
  return deviceId;
}

export function setPersonalSyncEnabled(
  db: DatabaseSync, ownerInput: unknown, entityType: PersonalSyncEntityType,
  entityIdInput: unknown, enabled: boolean, payload: unknown, now = new Date(),
): void {
  const ownerId = requireSyncUuid(ownerInput, "sync account id");
  const entityId = requireSyncUuid(entityIdInput, "sync entity id");
  if (typeof enabled !== "boolean") throw Error("Sync selection must be boolean");
  const current = db.prepare(
    "SELECT enabled FROM personal_sync_entities WHERE owner_id=? AND entity_type=? AND entity_id=?"
  ).get(ownerId, entityType, entityId) as {enabled:number} | undefined;
  if (!enabled) {
    db.prepare("UPDATE personal_sync_entities SET enabled=0 WHERE owner_id=? AND entity_type=? AND entity_id=?")
      .run(ownerId, entityType, entityId);
    return;
  }
  if (current?.enabled === 1) return;
  db.prepare(
    "INSERT INTO personal_sync_entities(owner_id,entity_type,entity_id,enabled) VALUES(?,?,?,1) " +
    "ON CONFLICT(owner_id,entity_type,entity_id) DO UPDATE SET enabled=1"
  ).run(ownerId, entityType, entityId);
  enqueuePersonalSyncUpsert(db, entityType, entityId, payload, now);
}

function enqueueOneUpsert(
  db: DatabaseSync, ownerId: string, entityType: PersonalSyncEntityType,
  entityId: string, payload: unknown, serverVersion: number | null, now: Date,
): string {
  const serialized = JSON.stringify(payload);
  if (typeof serialized !== "string") throw Error("Sync snapshot is not serializable");
  const pending = db.prepare(
    "SELECT operation_id FROM personal_sync_outbox WHERE owner_id=? AND entity_type=? AND entity_id=? " +
    "AND status='pending' AND attempts=0 ORDER BY created_at DESC LIMIT 1"
  ).get(ownerId, entityType, entityId) as {operation_id:string} | undefined;
  if (pending) {
    db.prepare("UPDATE personal_sync_outbox SET action='upsert',base_version=?,payload_json=?,created_at=?,last_error=NULL " +
      "WHERE operation_id=?").run(serverVersion, serialized, now.toISOString(), pending.operation_id);
    return pending.operation_id;
  }
  const operationId = randomUUID();
  db.prepare("INSERT INTO personal_sync_outbox(operation_id,owner_id,entity_type,entity_id,action," +
    "base_version,payload_json,created_at) VALUES(?,?,?,?, 'upsert',?,?,?)")
    .run(operationId, ownerId, entityType, entityId, serverVersion, serialized, now.toISOString());
  return operationId;
}

export function enqueuePersonalSyncUpsert(
  db: DatabaseSync, entityType: PersonalSyncEntityType,
  entityId: string, payload: unknown, now = new Date(),
): string[] {
  const owners = db.prepare(
    "SELECT owner_id,server_version FROM personal_sync_entities WHERE entity_type=? AND entity_id=? AND enabled=1"
  ).all(entityType, entityId) as unknown as {owner_id:string;server_version:number|null}[];
  return owners.map(row => enqueueOneUpsert(
    db, row.owner_id, entityType, entityId, payload, row.server_version, now,
  ));
}

export function enqueuePersonalSyncDelete(
  db: DatabaseSync, entityType: PersonalSyncEntityType, entityId: string, now = new Date(),
): string[] {
  const owners = db.prepare(
    "SELECT owner_id,server_version FROM personal_sync_entities WHERE entity_type=? AND entity_id=? AND enabled=1"
  ).all(entityType, entityId) as unknown as {owner_id:string;server_version:number|null}[];
  const output: string[] = [];
  for (const row of owners) {
    const uncertain = db.prepare(
      "SELECT operation_id FROM personal_sync_outbox WHERE owner_id=? AND entity_type=? AND entity_id=? " +
      "AND (status IN('in_flight','conflict','failed') OR attempts>0)"
    ).get(row.owner_id, entityType, entityId);
    if (row.server_version === null && !uncertain) {
      db.prepare("DELETE FROM personal_sync_outbox WHERE owner_id=? AND entity_type=? AND entity_id=? AND status='pending'")
        .run(row.owner_id, entityType, entityId);
      db.prepare("DELETE FROM personal_sync_entities WHERE owner_id=? AND entity_type=? AND entity_id=?")
        .run(row.owner_id, entityType, entityId);
      continue;
    }
    const pending = db.prepare(
      "SELECT operation_id FROM personal_sync_outbox WHERE owner_id=? AND entity_type=? AND entity_id=? " +
      "AND status='pending' AND attempts=0 ORDER BY created_at DESC LIMIT 1"
    ).get(row.owner_id, entityType, entityId) as {operation_id:string} | undefined;
    if (pending) {
      db.prepare("UPDATE personal_sync_outbox SET action='delete',base_version=?,payload_json=NULL,created_at=?,last_error=NULL " +
        "WHERE operation_id=?").run(row.server_version, now.toISOString(), pending.operation_id);
      output.push(pending.operation_id);
    } else {
      const operationId = randomUUID();
      db.prepare("INSERT INTO personal_sync_outbox(operation_id,owner_id,entity_type,entity_id,action," +
        "base_version,payload_json,created_at) VALUES(?,?,?,?, 'delete',?,NULL,?)")
        .run(operationId, row.owner_id, entityType, entityId, row.server_version, now.toISOString());
      output.push(operationId);
    }
  }
  return output;
}

export function listPersonalSyncSelections(db: DatabaseSync, ownerInput: unknown): PersonalSyncSelection[] {
  const ownerId = requireSyncUuid(ownerInput, "sync account id");
  const rows = db.prepare("SELECT owner_id,entity_type,entity_id,enabled,server_version,last_synced_at,last_error " +
    "FROM personal_sync_entities WHERE owner_id=? ORDER BY entity_type,entity_id")
    .all(ownerId) as unknown as Array<{
      owner_id:string;entity_type:PersonalSyncEntityType;entity_id:string;enabled:number;
      server_version:number|null;last_synced_at:string|null;last_error:string|null;
    }>;
  return rows.map(row => ({
    ownerId:row.owner_id,entityType:row.entity_type,entityId:row.entity_id,
    enabled:row.enabled===1,serverVersion:row.server_version,
    lastSyncedAt:row.last_synced_at,lastError:row.last_error,
  }));
}

export function listPersonalSyncOutbox(
  db: DatabaseSync, ownerInput: unknown, limitInput = 100,
): PersonalSyncOutboxItem[] {
  const ownerId = requireSyncUuid(ownerInput, "sync account id");
  if (!Number.isSafeInteger(limitInput) || limitInput < 1 || limitInput > 500)
    throw Error("Invalid personal sync queue limit");
  const rows = db.prepare("SELECT o.* FROM personal_sync_outbox o " +
    "JOIN personal_sync_entities e ON e.owner_id=o.owner_id AND e.entity_type=o.entity_type " +
    "AND e.entity_id=o.entity_id AND e.enabled=1 " +
    "WHERE o.owner_id=? AND o.status='pending' AND NOT EXISTS (" +
    "SELECT 1 FROM personal_sync_outbox prior WHERE prior.owner_id=o.owner_id " +
    "AND prior.entity_type=o.entity_type AND prior.entity_id=o.entity_id " +
    "AND (prior.status IN('in_flight','conflict','failed') OR " +
    "(prior.status='pending' AND (prior.created_at<o.created_at OR " +
    "(prior.created_at=o.created_at AND prior.operation_id<o.operation_id))))) " +
    "ORDER BY o.created_at,o.operation_id LIMIT ?").all(ownerId, limitInput) as unknown as Array<{
      operation_id:string;owner_id:string;entity_type:PersonalSyncEntityType;entity_id:string;
      action:PersonalSyncAction;base_version:number|null;payload_json:string|null;created_at:string;
      status:PersonalSyncQueueStatus;attempts:number;last_error:string|null;
    }>;
  return rows.map(row => {
    let payload:unknown|null = null;
    if (row.payload_json !== null) {
      try { payload = JSON.parse(row.payload_json); }
      catch { throw Error("Corrupt personal sync queue payload"); }
    }
    return {
      operationId:row.operation_id,ownerId:row.owner_id,entityType:row.entity_type,
      entityId:row.entity_id,action:row.action,baseVersion:row.base_version,
      payload,createdAt:row.created_at,status:row.status,attempts:row.attempts,lastError:row.last_error,
    };
  });
}

export function markPersonalSyncAttempted(db: DatabaseSync, ownerInput: unknown, operationInput: unknown): void {
  const ownerId = requireSyncUuid(ownerInput, "sync account id");
  const operationId = requireSyncUuid(operationInput, "sync operation id");
  const changed = db.prepare("UPDATE personal_sync_outbox SET status='in_flight',attempts=attempts+1,last_error=NULL " +
    "WHERE operation_id=? AND owner_id=? AND status='pending' AND EXISTS (" +
    "SELECT 1 FROM personal_sync_entities e WHERE e.owner_id=personal_sync_outbox.owner_id " +
    "AND e.entity_type=personal_sync_outbox.entity_type AND e.entity_id=personal_sync_outbox.entity_id AND e.enabled=1)")
    .run(operationId, ownerId).changes;
  if (changed !== 1) throw Error("Personal sync operation is not pending");
}

export function acknowledgePersonalSyncOperation(
  db: DatabaseSync, ownerInput: unknown, operationInput: unknown,
  serverVersionInput: unknown, now = new Date(),
): void {
  const ownerId = requireSyncUuid(ownerInput, "sync account id");
  const operationId = requireSyncUuid(operationInput, "sync operation id");
  if (!Number.isSafeInteger(serverVersionInput) || (serverVersionInput as number) < 0)
    throw Error("Invalid acknowledged sync version");
  db.exec("BEGIN IMMEDIATE");
  try {
    const operation = db.prepare("SELECT entity_type,entity_id,action FROM personal_sync_outbox " +
      "WHERE operation_id=? AND owner_id=? AND status='in_flight'")
      .get(operationId, ownerId) as {entity_type:PersonalSyncEntityType;entity_id:string;action:PersonalSyncAction}|undefined;
    if (!operation) throw Error("Personal sync operation is not in flight");
    db.prepare("DELETE FROM personal_sync_outbox WHERE operation_id=?").run(operationId);
    if (operation.action === "delete") {
      db.prepare("DELETE FROM personal_sync_entities WHERE owner_id=? AND entity_type=? AND entity_id=?")
        .run(ownerId, operation.entity_type, operation.entity_id);
      db.prepare("DELETE FROM personal_sync_outbox WHERE owner_id=? AND entity_type=? AND entity_id=?")
        .run(ownerId, operation.entity_type, operation.entity_id);
      db.exec("COMMIT");
      return;
    }
    db.prepare("UPDATE personal_sync_entities SET server_version=?,last_synced_at=?,last_error=NULL " +
      "WHERE owner_id=? AND entity_type=? AND entity_id=?")
      .run(serverVersionInput, now.toISOString(), ownerId, operation.entity_type, operation.entity_id);
    const next = db.prepare("SELECT operation_id FROM personal_sync_outbox WHERE owner_id=? AND entity_type=? " +
      "AND entity_id=? AND status='pending' ORDER BY created_at,operation_id LIMIT 1")
      .get(ownerId, operation.entity_type, operation.entity_id) as {operation_id:string}|undefined;
    if (next) db.prepare("UPDATE personal_sync_outbox SET base_version=? WHERE operation_id=? AND status='pending'")
      .run(serverVersionInput, next.operation_id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function markPersonalSyncConflict(
  db: DatabaseSync, ownerInput: unknown, operationInput: unknown, message: string,
): void {
  const ownerId = requireSyncUuid(ownerInput, "sync account id");
  const operationId = requireSyncUuid(operationInput, "sync operation id");
  if (typeof message !== "string" || !message.trim()) throw Error("Invalid sync conflict message");
  const operation = db.prepare("SELECT entity_type,entity_id FROM personal_sync_outbox " +
    "WHERE operation_id=? AND owner_id=? AND status='in_flight'")
    .get(operationId,ownerId) as {entity_type:PersonalSyncEntityType;entity_id:string}|undefined;
  if (!operation) throw Error("Personal sync operation is not in flight");
  const safeMessage=message.trim().slice(0,160);
  db.prepare("UPDATE personal_sync_outbox SET status='conflict',last_error=? WHERE operation_id=?")
    .run(safeMessage,operationId);
  db.prepare("UPDATE personal_sync_entities SET last_error=? WHERE owner_id=? AND entity_type=? AND entity_id=?")
    .run(safeMessage,ownerId,operation.entity_type,operation.entity_id);
}
