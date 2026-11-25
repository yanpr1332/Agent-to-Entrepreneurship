import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import {buildFocusInsights,requireFocusTimeZone,type FocusInsightRow}
  from "./focus-insights";
import {parseRewardCreate,parseRewardEdit,parseRewardRedeem,virtualFocusLevel}
  from "./focus-rewards";
import type { CanvasAssignment, CanvasImportResult, CanvasSyncResult } from "../shared/canvas-model";
import type { MailCandidateAction, MailCandidateChoiceResult, MailCandidateDecision } from "../shared/mail-candidates";
import { suggestedTaskTitle } from "../shared/mail-candidates";
import type { MailRecord } from "../shared/mail-model";
import { requireUuid } from "../shared/cloud-model";
import { parsePersonalSyncPullPage } from "../shared/personal-sync-contract";
import type {
  PersonalSyncChange, PersonalSyncConflict, PersonalSyncConflictRecord, PersonalSyncCandidate,
  PersonalTaskSnapshot, PersonalSyncResolutionRequest, PersonalSyncPullPage,
} from "../shared/personal-sync-contract";
import {
  parseCreateTask, parseFocusCompletion, parseFocusTitleUpdate, parseTaskId, parseUpdateTask,
  type FocusSession, type FocusSummary, type FocusInsights,
  type FocusReward, type FocusRewardOverview,type FocusRewardRedemption,
  type LocalTask, type TaskPriority,
} from "../shared/local-model";

interface TaskRow {
  id: string;
  title: string;
  description: string;
  due_date: string | null;
  priority: TaskPriority;
  completed: number;
  created_at: string;
  updated_at: string;
  instance_origin: string | null;
  account_id: number | null;
  course_id: number | null;
  assignment_id: number | null;
  source_url: string | null;
  last_synced_at: string | null;
  visible: number | null;
  hidden_at: string | null;
  retention_expires_at: string | null;
  override_title: number | null;
  override_due: number | null;
}

interface FocusRow {
  id: string;
  title: string;
  planned_minutes: number;
  elapsed_seconds: number;
  completed: number;
  points: number;
  started_at: string;
  ended_at: string;
  time_source: "recorded" | "estimated";
}

function taskFromRow(row: TaskRow): LocalTask {
  return {
    id: row.id, title: row.title, description: row.description,
    dueDate: row.due_date, priority: row.priority,
    completed: row.completed === 1, createdAt: row.created_at, updatedAt: row.updated_at,
    visible: row.visible !== 0,
    hiddenAt: row.hidden_at ?? null,
    retentionExpiresAt: row.retention_expires_at ?? null,
    source: row.instance_origin && row.account_id !== null && row.course_id !== null &&
      row.assignment_id !== null && row.last_synced_at
      ? { provider: "canvas", instanceUrl: row.instance_origin,
          accountId: row.account_id, courseId: row.course_id,
          assignmentId: row.assignment_id, sourceUrl: row.source_url,
          lastSyncedAt: row.last_synced_at }
      : null,
  };
}

function syncOwnerId(input: unknown): string { return requireUuid(input).toLowerCase(); }

function checkedPersonalSyncDevice(row:{device_id:string;cursor:string}):{deviceId:string;cursor:string}{
  // A restored or edited SQLite file may contain a cursor that is not safe to
  // pass to the server. Fail closed before registering or uploading anything.
  if(typeof row.cursor!=="string"||!/^(0|[1-9][0-9]{0,18})$/.test(row.cursor)||
     BigInt(row.cursor)>9223372036854775807n)
    throw Error("Saved personal sync cursor is invalid; sync is blocked until the local data is reviewed");
  if(typeof row.device_id!=="string")
    throw Error("Saved personal sync device is invalid; sync is blocked until the local data is reviewed");
  try{return {deviceId:requireUuid(row.device_id),cursor:row.cursor};}
  catch{throw Error("Saved personal sync device is invalid; sync is blocked until the local data is reviewed");}
}

function focusFromRow(row: FocusRow): FocusSession {
  return {
    id: row.id, title: row.title, plannedMinutes: row.planned_minutes,
    elapsedSeconds: row.elapsed_seconds, completed: row.completed === 1,
    points: row.points, startedAt: row.started_at, endedAt: row.ended_at,
    timeSource: row.time_source,
  };
}

/**
 * Local SQLite store owned exclusively by the Electron main process.
 * Uses Node's built-in SQLite API, without a new native npm dependency.
 */
export class LocalStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 3000");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version > 11) throw new Error("Database created by a newer application; refusing to downgrade");
    if (version === 11) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (version === 0) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            due_date TEXT,
            priority TEXT NOT NULL CHECK (priority IN ('low','normal','high')),
            completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks (due_date);
          CREATE TABLE IF NOT EXISTS focus_sessions (
            id TEXT PRIMARY KEY,
            planned_minutes INTEGER NOT NULL CHECK (planned_minutes BETWEEN 1 AND 180),
            elapsed_seconds INTEGER NOT NULL CHECK (elapsed_seconds >= 0),
            completed INTEGER NOT NULL CHECK (completed IN (0,1)),
            points INTEGER NOT NULL CHECK (points >= 0),
            started_at TEXT NOT NULL,
            ended_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_focus_sessions_ended_at ON focus_sessions (ended_at);
        `);
      }
      if (version <= 1) {
        this.db.exec(`
          CREATE TABLE canvas_assignment_links (
            instance_origin TEXT NOT NULL,
            account_id INTEGER NOT NULL,
            course_id INTEGER NOT NULL,
            assignment_id INTEGER NOT NULL,
            task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
            remote_title TEXT NOT NULL,
            remote_due_date TEXT,
            source_url TEXT,
            last_synced_at TEXT NOT NULL,
            missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0,1)),
            PRIMARY KEY (instance_origin, account_id, course_id, assignment_id)
          );
          CREATE INDEX idx_canvas_assignment_links_task ON canvas_assignment_links (task_id);
        `);
      }
      if (version <= 2) {
        this.db.exec(`
          ALTER TABLE canvas_assignment_links ADD COLUMN visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0,1));
          ALTER TABLE canvas_assignment_links ADD COLUMN hidden_at TEXT;
          ALTER TABLE canvas_assignment_links ADD COLUMN retention_expires_at TEXT;
          ALTER TABLE canvas_assignment_links ADD COLUMN override_title INTEGER NOT NULL DEFAULT 0 CHECK (override_title IN (0,1));
          ALTER TABLE canvas_assignment_links ADD COLUMN override_due INTEGER NOT NULL DEFAULT 0 CHECK (override_due IN (0,1));
          CREATE INDEX idx_canvas_expiry ON canvas_assignment_links (visible, retention_expires_at);
          CREATE TABLE canvas_course_settings (
            instance_origin TEXT NOT NULL,
            account_id INTEGER NOT NULL,
            course_id INTEGER NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
            PRIMARY KEY (instance_origin, account_id, course_id)
          );
          CREATE TABLE canvas_sync_state (
            instance_origin TEXT NOT NULL,
            account_id INTEGER NOT NULL,
            last_attempt TEXT,
            last_success TEXT,
            last_error TEXT,
            PRIMARY KEY (instance_origin, account_id)
          );
        `);
      }
      if (version <= 3) {
        this.db.exec("CREATE TABLE mail_candidate_reviews (" +
          "account TEXT NOT NULL, uid_validity INTEGER NOT NULL CHECK(uid_validity>0), " +
          "uid INTEGER NOT NULL CHECK(uid>0), decision TEXT NOT NULL " +
          "CHECK(decision IN ('ignored','accepted')), task_id TEXT, decided_at TEXT NOT NULL, " +
          "PRIMARY KEY(account,uid_validity,uid), " +
          "CHECK((decision='accepted' AND task_id IS NOT NULL) OR " +
          "(decision='ignored' AND task_id IS NULL)))");
      }
      if (version <= 4) {
        // Legacy fixture databases can have a newer focus table while their
        // user_version was deliberately reset for mail migration tests.
        const columnRows = this.db.prepare("PRAGMA table_info(focus_sessions)").all() as {name:string}[];
        const columns = new Set(columnRows.map(row => row.name));
        if (!columns.has("title"))
          this.db.exec("ALTER TABLE focus_sessions ADD COLUMN title TEXT NOT NULL DEFAULT '专注学习'");
        if (!columns.has("time_source"))
          this.db.exec("ALTER TABLE focus_sessions ADD COLUMN time_source TEXT NOT NULL DEFAULT 'estimated' " +
            "CHECK (time_source IN ('recorded','estimated'))");
      }
      if (version <= 5) {
        this.db.exec(`
          CREATE TABLE personal_task_sync_enrollment (
            task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
            server_version INTEGER,
            enabled_at TEXT NOT NULL
          );
          CREATE TABLE personal_sync_outbox (
            operation_id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL CHECK(entity_type IN ('personal-task','manual-calendar-event')),
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
            base_version INTEGER,
            payload TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(entity_type, entity_id),
            CHECK((action='upsert' AND payload IS NOT NULL) OR (action='delete' AND payload IS NULL))
          );
          CREATE INDEX personal_sync_outbox_created ON personal_sync_outbox(created_at);
        `);
      }
      if (version <= 6) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS personal_sync_devices (
            owner_id TEXT PRIMARY KEY,
            device_id TEXT NOT NULL UNIQUE,
            cursor TEXT NOT NULL DEFAULT '0',
            created_at TEXT NOT NULL,
            last_sync_at TEXT
          );
          CREATE INDEX IF NOT EXISTS personal_sync_devices_created ON personal_sync_devices(created_at);
        `);
      }
      if (version <= 7) {
        // Legacy rows have no trustworthy account identity: preserve but quarantine them.
        this.db.exec(`
          ALTER TABLE personal_task_sync_enrollment RENAME TO personal_task_sync_legacy_enrollment;
          ALTER TABLE personal_sync_outbox RENAME TO personal_sync_legacy_outbox;
          ALTER TABLE personal_task_sync_legacy_enrollment ADD COLUMN claimed_by_owner_id TEXT;
          ALTER TABLE personal_task_sync_legacy_enrollment ADD COLUMN claimed_at TEXT;
          ALTER TABLE personal_sync_legacy_outbox ADD COLUMN claimed_by_owner_id TEXT;
          ALTER TABLE personal_sync_legacy_outbox ADD COLUMN claimed_at TEXT;
          CREATE TABLE personal_task_sync_enrollment (
            owner_id TEXT NOT NULL CHECK(length(owner_id)=36),
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            server_version INTEGER CHECK(server_version IS NULL OR server_version > 0),
            enabled_at TEXT NOT NULL,
            PRIMARY KEY(owner_id,task_id)
          );
          CREATE TABLE personal_sync_outbox (
            owner_id TEXT NOT NULL CHECK(length(owner_id)=36),
            operation_id TEXT PRIMARY KEY,
            entity_type TEXT NOT NULL CHECK(entity_type IN ('personal-task','manual-calendar-event')),
            entity_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
            base_version INTEGER CHECK(base_version IS NULL OR base_version >= 0),
            payload TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(owner_id,entity_type,entity_id),
            CHECK((action='upsert' AND payload IS NOT NULL) OR (action='delete' AND payload IS NULL))
          );
          CREATE INDEX personal_sync_outbox_owner_created ON personal_sync_outbox(owner_id,created_at,operation_id);
          CREATE INDEX personal_task_sync_enrollment_owner ON personal_task_sync_enrollment(owner_id,enabled_at);
        `);
      }
      if (version <= 8) {
        this.db.exec(`
          CREATE TABLE personal_sync_conflicts (
            owner_id TEXT NOT NULL CHECK(length(owner_id)=36),
            entity_type TEXT NOT NULL CHECK(entity_type IN ('personal-task','manual-calendar-event')),
            entity_id TEXT NOT NULL,
            local_operation_id TEXT,
            local_action TEXT CHECK(local_action IS NULL OR local_action IN ('upsert','delete')),
            local_payload TEXT,
            remote_version INTEGER NOT NULL CHECK(remote_version>0),
            remote_payload TEXT,
            remote_deleted INTEGER NOT NULL CHECK(remote_deleted IN (0,1)),
            remote_updated_at TEXT NOT NULL,
            reason TEXT NOT NULL CHECK(reason IN (
              'remote-change-while-local-pending','remote-delete-while-local-pending',
              'local-entity-not-eligible','remote-overlaps-study-plan','local-calendar-capacity'
            )),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(owner_id,entity_type,entity_id),
            CHECK((remote_deleted=1 AND remote_payload IS NULL) OR
              (remote_deleted=0 AND remote_payload IS NOT NULL))
          );
          CREATE INDEX personal_sync_conflicts_owner_updated
            ON personal_sync_conflicts(owner_id,updated_at DESC);
        `);
      }
      if (version <= 9) {
        // A durable record of the *exact* pull page must exist before either
        // SQLite store is modified, so interrupted cross-store applies replay.
        this.db.exec(`CREATE TABLE personal_sync_pull_checkpoints (
          owner_id TEXT PRIMARY KEY CHECK(length(owner_id)=36),
          device_id TEXT NOT NULL,
          from_cursor TEXT NOT NULL,
          next_cursor TEXT NOT NULL,
          page_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );`);
      }
      if(version<=10){
        this.db.exec(`
          CREATE TABLE focus_rewards (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
            description TEXT NOT NULL CHECK(length(description)<=500),
            cost INTEGER NOT NULL CHECK(cost BETWEEN 1 AND 1000000),
            active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE focus_reward_redemptions (
            id TEXT PRIMARY KEY,
            reward_id TEXT NOT NULL REFERENCES focus_rewards(id) ON DELETE RESTRICT,
            reward_title TEXT NOT NULL,
            cost INTEGER NOT NULL CHECK(cost BETWEEN 1 AND 1000000),
            redeemed_at TEXT NOT NULL
          );
          CREATE INDEX idx_focus_redemptions_time
            ON focus_reward_redemptions(redeemed_at DESC,id DESC);
        `);
      }
      this.db.exec("PRAGMA user_version = 11");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  async backupTo(path: string): Promise<number> {
    return backup(this.db,path);
  }

  /** This inspection never creates a device or modifies SQLite. */
  peekPersonalSyncDevice(ownerInput:unknown):{deviceId:string;cursor:string}|null{
    const owner=syncOwnerId(ownerInput);
    const row=this.db.prepare(
      "SELECT device_id,cursor FROM personal_sync_devices WHERE owner_id=?"
    ).get(owner) as {device_id:string;cursor:string}|undefined;
    return row?checkedPersonalSyncDevice(row):null;
  }

  /** A stable device identity and cursor are scoped to the authenticated owner. */
  getOrCreatePersonalSyncDevice(ownerId: string, now = new Date()): {deviceId:string;cursor:string} {
    const owner=syncOwnerId(ownerId);
    const existing = this.db.prepare(
      "SELECT device_id,cursor FROM personal_sync_devices WHERE owner_id=?"
    ).get(owner) as {device_id:string;cursor:string}|undefined;
    if (existing) return checkedPersonalSyncDevice(existing);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "INSERT INTO personal_sync_devices(owner_id,device_id,cursor,created_at) VALUES(?,?, '0', ?) " +
        "ON CONFLICT(owner_id) DO NOTHING"
      ).run(owner,randomUUID(),now.toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const created=this.db.prepare(
      "SELECT device_id,cursor FROM personal_sync_devices WHERE owner_id=?"
    ).get(owner) as {device_id:string;cursor:string}|undefined;
    if (!created) throw new Error("Personal sync device could not be initialized");
    return checkedPersonalSyncDevice(created);
  }

  /**
   * Explicit, owner-scoped device replacement after the remote device was revoked.
   * Keep the last committed cursor and all enrollment metadata. A nonempty
   * personal-task queue or unresolved conflict blocks any local identity change.
   * Main also checks the separate manual-calendar queue before invoking this.
   */
  rotatePersonalSyncDevice(ownerInput:unknown,expectedDeviceIdInput:unknown,
    expectedCursor:string,now=new Date()):{deviceId:string;cursor:string}{
    const owner=syncOwnerId(ownerInput),expectedDeviceId=requireUuid(expectedDeviceIdInput);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const stored=this.db.prepare(
        "SELECT device_id,cursor FROM personal_sync_devices WHERE owner_id=?"
      ).get(owner) as {device_id:string;cursor:string}|undefined;
      if(!stored)throw Error("Personal sync device is missing; review replacement again");
      const existing=checkedPersonalSyncDevice(stored);
      if(existing.deviceId!==expectedDeviceId||existing.cursor!==expectedCursor)
        throw Error("Personal sync device changed; review replacement again");
      const taskPending=this.db.prepare(
        "SELECT 1 FROM personal_sync_outbox WHERE owner_id=? LIMIT 1"
      ).get(owner);
      const unresolved=this.db.prepare(
        "SELECT 1 FROM personal_sync_conflicts WHERE owner_id=? LIMIT 1"
      ).get(owner);
      if(taskPending||unresolved)throw Error("Resolve local pending operations and conflicts before replacing a device");
      if(this.db.prepare("SELECT 1 FROM personal_sync_pull_checkpoints WHERE owner_id=?").get(owner))
        throw Error("Recover the interrupted personal sync pull before replacing a device");
      const deviceId=randomUUID();
      const result=this.db.prepare(
        "UPDATE personal_sync_devices SET device_id=?,created_at=?,last_sync_at=NULL "+
        "WHERE owner_id=? AND device_id=? AND cursor=?"
      ).run(deviceId,now.toISOString(),owner,existing.deviceId,existing.cursor);
      if(result.changes!==1)throw Error("Personal sync device changed; review replacement again");
      this.db.exec("COMMIT");
      return {deviceId,cursor:existing.cursor};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  /** A checkpoint is the durable evidence needed to safely replay across
   * task and calendar SQLite files after process interruption. */
  getPendingPersonalSyncPull(ownerInput:unknown):
    {deviceId:string;fromCursor:string;page:PersonalSyncPullPage}|null{
    const owner=syncOwnerId(ownerInput);
    const row=this.db.prepare(
      "SELECT device_id,from_cursor,next_cursor,page_json FROM personal_sync_pull_checkpoints WHERE owner_id=?"
    ).get(owner) as {device_id:string;from_cursor:string;next_cursor:string;page_json:string}|undefined;
    if(!row)return null;
    try{
      const device=this.getOrCreatePersonalSyncDevice(owner);
      if(device.deviceId!==row.device_id||device.cursor!==row.from_cursor)
        throw Error("Checkpoint does not match the current device and cursor");
      const page=parsePersonalSyncPullPage(JSON.parse(row.page_json));
      if(page.changes.length===0||page.changes.length>200||
        page.nextCursor!==row.next_cursor||
        BigInt(page.changes[0].cursor)<=BigInt(row.from_cursor))
        throw Error("Checkpoint page is inconsistent");
      return {deviceId:device.deviceId,fromCursor:device.cursor,page};
    }catch{
      throw Error("Saved personal sync pull checkpoint is invalid; no upload or cursor change is allowed");
    }
  }

  /** Persist before changing either store. One unfinished page per owner. */
  beginPersonalSyncPullPage(ownerInput:unknown,deviceInput:unknown,fromCursor:string,
    rawPage:PersonalSyncPullPage):void{
    const owner=syncOwnerId(ownerInput),deviceId=requireUuid(deviceInput);
    const page=parsePersonalSyncPullPage(rawPage);
    if(page.changes.length===0||page.changes.length>200||
       !/^(0|[1-9][0-9]{0,18})$/.test(fromCursor)||
       BigInt(fromCursor)>9223372036854775807n||
       BigInt(page.changes[0].cursor)<=BigInt(fromCursor))
      throw Error("Invalid personal sync checkpoint page");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const row=this.db.prepare(
        "SELECT device_id,cursor FROM personal_sync_devices WHERE owner_id=?"
      ).get(owner) as {device_id:string;cursor:string}|undefined;
      if(!row||row.device_id!==deviceId||row.cursor!==fromCursor)
        throw Error("Device or cursor changed before pull checkpoint");
      if(this.db.prepare("SELECT 1 FROM personal_sync_pull_checkpoints WHERE owner_id=?").get(owner))
        throw Error("An unfinished personal sync pull must be replayed first");
      this.db.prepare(`INSERT INTO personal_sync_pull_checkpoints
        (owner_id,device_id,from_cursor,next_cursor,page_json,created_at)
        VALUES(?,?,?,?,?,?)`).run(owner,deviceId,fromCursor,page.nextCursor,
        JSON.stringify(page),new Date().toISOString());
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  /** Cursor and checkpoint clearance commit atomically in task SQLite.
   * A failed finish leaves the full page available for the next replay. */
  finishPersonalSyncPullPage(ownerInput:unknown,deviceInput:unknown,fromCursor:string,
    nextCursor:string):void{
    const owner=syncOwnerId(ownerInput),deviceId=requireUuid(deviceInput);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const checkpoint=this.getPendingPersonalSyncPull(owner);
      if(!checkpoint||checkpoint.deviceId!==deviceId||
         checkpoint.fromCursor!==fromCursor||checkpoint.page.nextCursor!==nextCursor)
        throw Error("Personal sync pull checkpoint changed; refusing cursor advance");
      const updated=this.db.prepare(
        "UPDATE personal_sync_devices SET cursor=?,last_sync_at=? "+
        "WHERE owner_id=? AND device_id=? AND cursor=?"
      ).run(nextCursor,new Date().toISOString(),owner,deviceId,fromCursor);
      if(updated.changes!==1)throw Error("Personal sync device changed during pull commit");
      this.db.prepare("DELETE FROM personal_sync_pull_checkpoints WHERE owner_id=?").run(owner);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  /** Advance only after a complete page has been durably applied locally. */
  advancePersonalSyncCursor(ownerId:string,cursor:string):void {
    const owner=syncOwnerId(ownerId);
    if(typeof cursor!=="string"||!/^(0|[1-9][0-9]{0,18})$/.test(cursor))
      throw new Error("Invalid personal sync cursor");
    if(this.db.prepare("SELECT 1 FROM personal_sync_pull_checkpoints WHERE owner_id=?").get(owner))
      throw Error("Cannot directly advance cursor with a pending pull checkpoint");
    const current=this.db.prepare(
      "SELECT cursor FROM personal_sync_devices WHERE owner_id=?"
    ).get(owner) as {cursor:string}|undefined;
    if (!current) throw new Error("Personal sync device is not registered locally");
    const next=BigInt(cursor);
    if(next>9223372036854775807n)throw new Error("Personal sync cursor exceeds server bounds");
    if (next<BigInt(current.cursor)) throw new Error("Personal sync cursor cannot move backwards");
    this.db.prepare("UPDATE personal_sync_devices SET cursor=?,last_sync_at=? WHERE owner_id=?")
      .run(cursor,new Date().toISOString(),owner);
  }

  private readonly taskSelect = `SELECT t.*, l.instance_origin, l.account_id, l.course_id,
    l.assignment_id, l.source_url, l.last_synced_at,
    l.visible, l.hidden_at, l.retention_expires_at, l.override_title, l.override_due
    FROM tasks t LEFT JOIN canvas_assignment_links l ON l.task_id = t.id`;

  listTasks(): LocalTask[] {
    const rows = this.db.prepare(
      this.taskSelect + " ORDER BY t.completed ASC, (t.due_date IS NULL) ASC, t.due_date ASC, t.created_at DESC",
    ).all() as unknown as TaskRow[];
    return rows.map(taskFromRow);
  }

  private findTask(id: string): LocalTask | null {
    const row = this.db.prepare(this.taskSelect + " WHERE t.id = ?").get(id) as unknown as TaskRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  /** Explicitly enroll one eligible personal task for one authenticated owner. */
  setTaskSyncEnabled(idInput: unknown, enabled: boolean, ownerInput: unknown, now = new Date()): void {
    const id = parseTaskId(idInput);
    const ownerId = syncOwnerId(ownerInput);
    if (typeof enabled !== "boolean") throw new Error("Sync preference must be boolean");
    const task = this.findTask(id);
    if (!task || task.source !== null) throw new Error("Only personal tasks can be enrolled");
    const mail = this.db.prepare("SELECT 1 AS found FROM mail_candidate_reviews WHERE task_id=? AND decision='accepted'")
      .get(id);
    if (mail) throw new Error("Mail-derived tasks require separate review and cannot be enrolled in this release");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!enabled) {
        this.db.prepare("DELETE FROM personal_sync_outbox WHERE owner_id=? AND entity_type='personal-task' AND entity_id=?").run(ownerId,id);
        this.db.prepare("DELETE FROM personal_task_sync_enrollment WHERE owner_id=? AND task_id=?").run(ownerId,id);
      } else {
        this.db.prepare("INSERT INTO personal_task_sync_enrollment(owner_id,task_id,server_version,enabled_at) VALUES(?,?,NULL,?) ON CONFLICT(owner_id,task_id) DO NOTHING")
          .run(ownerId,id,now.toISOString());
        this.enqueuePersonalTaskForOwner(id,ownerId,now);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private enqueuePersonalTask(id: string, now = new Date()): void {
    const enrollments=this.db.prepare(
      "SELECT owner_id FROM personal_task_sync_enrollment WHERE task_id=? ORDER BY owner_id"
    ).all(id) as {owner_id:string}[];
    for(const enrollment of enrollments)
      this.enqueuePersonalTaskForOwner(id,enrollment.owner_id,now);
  }

  private enqueuePersonalTaskForOwner(id:string,ownerId:string,now=new Date()):void {
    const enrolled=this.db.prepare(
      "SELECT server_version FROM personal_task_sync_enrollment WHERE owner_id=? AND task_id=?"
    ).get(ownerId,id) as {server_version:number|null}|undefined;
    if(!enrolled)return;
    const task=this.findTask(id);
    if(!task||task.source!==null)throw new Error("Only personal tasks can be queued");
    const mail=this.db.prepare(
      "SELECT 1 AS found FROM mail_candidate_reviews WHERE task_id=? AND decision='accepted'"
    ).get(id);
    if(mail)throw new Error("Mail-derived tasks cannot be queued");
    const payload=JSON.stringify({
      title:task.title,description:task.description,dueDate:task.dueDate,
      priority:task.priority,completed:task.completed,
    });
    this.db.prepare(`
      INSERT INTO personal_sync_outbox(owner_id,operation_id,entity_type,entity_id,action,base_version,payload,created_at)
      VALUES(?,?,'personal-task',?,'upsert',?,?,?)
      ON CONFLICT(owner_id,entity_type,entity_id) DO UPDATE SET
        operation_id=excluded.operation_id,action='upsert',base_version=excluded.base_version,
        payload=excluded.payload,created_at=excluded.created_at
    `).run(ownerId,randomUUID(),id,enrolled.server_version,payload,now.toISOString());
  }

  /** Pending intents are visible only inside the authenticated owner's scope. */
  listPersonalSyncOutbox(ownerInput:unknown,limit=100):{
    operationId:string;entityType:"personal-task"|"manual-calendar-event";entityId:string;
    action:"upsert"|"delete";baseVersion:number|null;payload:string|null;createdAt:string;
  }[]{
    const ownerId=syncOwnerId(ownerInput);
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw new Error("Invalid outbox limit");
    return (this.db.prepare(
      "SELECT operation_id,entity_type,entity_id,action,base_version,payload,created_at "+
      "FROM personal_sync_outbox WHERE owner_id=? AND entity_type='personal-task' ORDER BY created_at,operation_id LIMIT ?"
    ).all(ownerId,limit) as unknown as {operation_id:string;entity_type:"personal-task"|"manual-calendar-event";
      entity_id:string;action:"upsert"|"delete";base_version:number|null;payload:string|null;created_at:string}[])
      .map(row=>({operationId:row.operation_id,entityType:row.entity_type,entityId:row.entity_id,
        action:row.action,baseVersion:row.base_version,payload:row.payload,createdAt:row.created_at}));
  }

  getPersonalSyncPendingIntent(ownerInput:unknown,entityInput:unknown):{
    operationId:string;action:"upsert"|"delete";payload:string|null;
  }|null{
    const ownerId=syncOwnerId(ownerInput),entityId=parseTaskId(entityInput);
    const row=this.db.prepare(
      "SELECT operation_id,action,payload FROM personal_sync_outbox "+
      "WHERE owner_id=? AND entity_type='personal-task' AND entity_id=?"
    ).get(ownerId,entityId) as {
      operation_id:string;action:"upsert"|"delete";payload:string|null;
    }|undefined;
    return row?{operationId:row.operation_id,action:row.action,payload:row.payload}:null;
  }

  /** Reconcile a newer local edit into the held conflict so the user can
   * re-review it. Never change the already reviewed remote version here. */
  refreshPersonalSyncConflictLocal(ownerInput:unknown,entityType:PersonalSyncConflict["entityType"],
    entityInput:unknown,pending:{
      operationId:string;action:"upsert"|"delete";payload:string|null;
    }):void{
    const ownerId=syncOwnerId(ownerInput),entityId=requireUuid(entityInput);
    const operationId=requireUuid(pending.operationId);
    if(entityType!=="personal-task"&&entityType!=="manual-calendar-event")
      throw Error("Invalid conflict type");
    if(pending.action!=="upsert"&&pending.action!=="delete")
      throw Error("Invalid local conflict action");
    if((pending.action==="upsert")!== (pending.payload!==null))
      throw Error("Invalid local conflict snapshot");
    this.db.prepare(`UPDATE personal_sync_conflicts
      SET local_operation_id=?,local_action=?,local_payload=?,updated_at=?
      WHERE owner_id=? AND entity_type=? AND entity_id=?
        AND reason IN ('remote-change-while-local-pending','remote-delete-while-local-pending')
        AND (local_operation_id IS NOT ? OR local_action IS NOT ? OR local_payload IS NOT ?)`)
      .run(operationId,pending.action,pending.payload,new Date().toISOString(),
        ownerId,entityType,entityId,operationId,pending.action,pending.payload);
  }

  hasPendingPersonalSyncOperation(ownerInput:unknown,operationIdInput:unknown):boolean{
    const ownerId=syncOwnerId(ownerInput),operationId=requireUuid(operationIdInput);
    return Boolean(this.db.prepare(
      "SELECT 1 AS found FROM personal_sync_outbox "+
      "WHERE owner_id=? AND entity_type='personal-task' AND operation_id=?"
    ).get(ownerId,operationId));
  }

  countPersonalSyncOutbox(ownerInput:unknown):number{
    const ownerId=syncOwnerId(ownerInput);
    const row=this.db.prepare(
      "SELECT COUNT(*) AS count FROM personal_sync_outbox "+
      "WHERE owner_id=? AND entity_type='personal-task'"
    ).get(ownerId) as {count:number};
    return row.count;
  }

  countPersonalSyncConflicts(ownerInput:unknown):number{
    const ownerId=syncOwnerId(ownerInput);
    const row=this.db.prepare(
      "SELECT COUNT(*) AS count FROM personal_sync_conflicts WHERE owner_id=?"
    ).get(ownerId) as {count:number};
    return row.count;
  }

  listPersonalSyncCandidates(ownerInput:unknown,limit=500):PersonalSyncCandidate[]{
    const ownerId=syncOwnerId(ownerInput);
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error("Invalid sync candidate limit");
    const rows=this.db.prepare(`
      SELECT t.id,t.title,t.due_date,e.server_version,e.task_id AS enrolled
      FROM tasks t
      LEFT JOIN canvas_assignment_links l ON l.task_id=t.id
      LEFT JOIN personal_task_sync_enrollment e ON e.owner_id=? AND e.task_id=t.id
      WHERE l.task_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM mail_candidate_reviews m
          WHERE m.task_id=t.id AND m.decision='accepted')
      ORDER BY t.updated_at DESC,t.id LIMIT ?
    `).all(ownerId,limit) as unknown as {
      id:string;title:string;due_date:string|null;server_version:number|null;enrolled:string|null;
    }[];
    return rows.map(row=>({entityType:"personal-task",entityId:row.id,title:row.title,
      detail:row.due_date?("截止 "+row.due_date):null,enabled:row.enrolled!==null,
      serverVersion:row.server_version}));
  }

  listPersonalSyncEnrollments(ownerInput:unknown):{
    taskId:string;title:string;serverVersion:number|null;enabledAt:string;
  }[]{
    const ownerId=syncOwnerId(ownerInput);
    return (this.db.prepare(`
      SELECT e.task_id,t.title,e.server_version,e.enabled_at
      FROM personal_task_sync_enrollment e JOIN tasks t ON t.id=e.task_id
      WHERE e.owner_id=? ORDER BY e.enabled_at,e.task_id
    `).all(ownerId) as unknown as {task_id:string;title:string;server_version:number|null;enabled_at:string}[])
      .map(row=>({taskId:row.task_id,title:row.title,serverVersion:row.server_version,enabledAt:row.enabled_at}));
  }

  listLegacyPersonalSyncItems(limit=100):{
    operationId:string|null;entityType:"personal-task"|"manual-calendar-event";entityId:string;
    action:"upsert"|"delete"|"enrolled";title:string|null;createdAt:string;canReauthorize:boolean;
  }[]{
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw new Error("Invalid legacy sync item limit");
    const rows=this.db.prepare(`
      SELECT o.operation_id,o.entity_type,o.entity_id,o.action,t.title,o.created_at,
        CASE WHEN o.entity_type='personal-task' AND o.action='upsert' AND t.id IS NOT NULL
          AND l.task_id IS NULL AND NOT EXISTS(SELECT 1 FROM mail_candidate_reviews m
            WHERE m.task_id=t.id AND m.decision='accepted') THEN 1 ELSE 0 END AS can_reauthorize
      FROM personal_sync_legacy_outbox o LEFT JOIN tasks t ON t.id=o.entity_id
        LEFT JOIN canvas_assignment_links l ON l.task_id=t.id
      WHERE o.claimed_by_owner_id IS NULL
      UNION ALL
      SELECT NULL AS operation_id,'personal-task' AS entity_type,e.task_id AS entity_id,
        'enrolled' AS action,t.title,e.enabled_at AS created_at,
        CASE WHEN t.id IS NOT NULL AND l.task_id IS NULL AND NOT EXISTS(
          SELECT 1 FROM mail_candidate_reviews m WHERE m.task_id=t.id AND m.decision='accepted')
          THEN 1 ELSE 0 END AS can_reauthorize
      FROM personal_task_sync_legacy_enrollment e LEFT JOIN tasks t ON t.id=e.task_id
        LEFT JOIN canvas_assignment_links l ON l.task_id=t.id
      WHERE e.claimed_by_owner_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM personal_sync_legacy_outbox o
          WHERE o.entity_type='personal-task' AND o.entity_id=e.task_id)
      ORDER BY created_at,entity_id LIMIT ?
    `).all(limit) as unknown as {operation_id:string|null;entity_type:"personal-task"|"manual-calendar-event";
      entity_id:string;action:"upsert"|"delete"|"enrolled";title:string|null;created_at:string;can_reauthorize:number}[];
    return rows.map(row=>({operationId:row.operation_id,entityType:row.entity_type,entityId:row.entity_id,
      action:row.action,title:row.title,createdAt:row.created_at,canReauthorize:row.can_reauthorize===1}));
  }

  /** Re-authorize one surviving legacy personal task for one explicit account. */
  adoptLegacyPersonalTaskSync(ownerInput:unknown,taskInput:unknown,confirmation:unknown,now=new Date()):void{
    const ownerId=syncOwnerId(ownerInput),taskId=parseTaskId(taskInput);
    if(confirmation!==true)throw Error("Explicit confirmation is required to re-authorize a legacy task");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const task=this.findTask(taskId);
      if(!task||task.source!==null)throw Error("Only an existing personal task can be re-authorized");
      const mail=this.db.prepare(
        "SELECT 1 AS found FROM mail_candidate_reviews WHERE task_id=? AND decision='accepted'"
      ).get(taskId);
      if(mail)throw Error("Mail-derived tasks cannot be re-authorized");
      const legacyEnrollment=this.db.prepare(
        "SELECT 1 AS found FROM personal_task_sync_legacy_enrollment WHERE task_id=? AND claimed_by_owner_id IS NULL"
      ).get(taskId);
      const legacyOutbox=this.db.prepare(
        "SELECT action FROM personal_sync_legacy_outbox WHERE entity_type='personal-task' AND entity_id=? AND claimed_by_owner_id IS NULL"
      ).get(taskId) as {action:string}|undefined;
      if(!legacyEnrollment&&!legacyOutbox)throw Error("No unclaimed legacy sync preference exists for this task");
      if(legacyOutbox?.action==="delete")
        throw Error("Legacy delete tombstones remain quarantined for manual review");
      const existing=this.db.prepare(
        "SELECT 1 AS found FROM personal_task_sync_enrollment WHERE owner_id=? AND task_id=?"
      ).get(ownerId,taskId);
      if(existing)throw Error("This task is already enrolled for this account");
      this.db.prepare(
        "INSERT INTO personal_task_sync_enrollment(owner_id,task_id,server_version,enabled_at) VALUES(?,?,NULL,?)"
      ).run(ownerId,taskId,now.toISOString());
      this.enqueuePersonalTaskForOwner(taskId,ownerId,now);
      this.db.prepare(
        "UPDATE personal_task_sync_legacy_enrollment SET claimed_by_owner_id=?,claimed_at=? "+
        "WHERE task_id=? AND claimed_by_owner_id IS NULL"
      ).run(ownerId,now.toISOString(),taskId);
      this.db.prepare(
        "UPDATE personal_sync_legacy_outbox SET claimed_by_owner_id=?,claimed_at=? "+
        "WHERE entity_type='personal-task' AND entity_id=? AND action='upsert' AND claimed_by_owner_id IS NULL"
      ).run(ownerId,now.toISOString(),taskId);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  /** Acknowledge only the exact owner-scoped operation that was sent. */
  acknowledgePersonalSyncOperation(ownerInput:unknown,operationId:string,entityIdInput:unknown,
    actionInput:unknown,serverVersion:number,expectedBaseVersion:number|null):
    "acknowledged"|"not-pending"{
    const ownerId=syncOwnerId(ownerInput),entityId=parseTaskId(entityIdInput);
    requireUuid(operationId);
    if((actionInput!=="upsert"&&actionInput!=="delete")||
      !Number.isSafeInteger(serverVersion)||serverVersion<1||
      (expectedBaseVersion!==null&&(!Number.isSafeInteger(expectedBaseVersion)||expectedBaseVersion<0)))
      throw Error("Invalid sync acknowledgement");
    const action=actionInput as "upsert"|"delete";
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const row=this.db.prepare(
        "SELECT entity_id,entity_type,action,base_version FROM personal_sync_outbox WHERE owner_id=? AND operation_id=?"
      ).get(ownerId,operationId) as {entity_id:string;entity_type:string;action:string;base_version:number|null}|undefined;
      if(!row){
        this.db.exec("COMMIT");
        return "not-pending";
      }
      if(row.entity_id!==entityId||row.entity_type!=="personal-task"||row.action!==action||
        row.base_version!==expectedBaseVersion)
        throw Error("Sync acknowledgement does not match its pending operation");
      this.db.prepare("DELETE FROM personal_sync_outbox WHERE owner_id=? AND operation_id=?")
        .run(ownerId,operationId);
      if(action==="upsert")
        this.db.prepare("UPDATE personal_task_sync_enrollment SET server_version=? WHERE owner_id=? AND task_id=?")
          .run(serverVersion,ownerId,entityId);
      if(action==="delete")
        this.db.prepare("DELETE FROM personal_task_sync_enrollment WHERE owner_id=? AND task_id=?")
          .run(ownerId,entityId);
      this.db.exec("COMMIT");
      return "acknowledged";
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  /** Rebase only an owner-scoped newer intent after this sync run confirms its prior request. */
  rebasePersonalSyncOperation(ownerInput:unknown,entityIdInput:unknown,actionInput:unknown,
    serverVersion:number,expectedBaseVersion:number|null):
    "superseded"|"deleted-during-upload"|"stale"{
    const ownerId=syncOwnerId(ownerInput),entityId=parseTaskId(entityIdInput);
    if((actionInput!=="upsert"&&actionInput!=="delete")||
      !Number.isSafeInteger(serverVersion)||serverVersion<1||
      (expectedBaseVersion!==null&&(!Number.isSafeInteger(expectedBaseVersion)||expectedBaseVersion<0)))
      throw Error("Invalid sync rebase");
    const action=actionInput as "upsert"|"delete";
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const newer=this.db.prepare(
        "SELECT operation_id,base_version FROM personal_sync_outbox "+
        "WHERE owner_id=? AND entity_type='personal-task' AND entity_id=?"
      ).get(ownerId,entityId) as {operation_id:string;base_version:number|null}|undefined;
      if(newer&&newer.base_version===expectedBaseVersion){
        this.db.prepare(
          "UPDATE personal_task_sync_enrollment SET server_version=? WHERE owner_id=? AND task_id=?"
        ).run(serverVersion,ownerId,entityId);
        this.db.prepare(
          "UPDATE personal_sync_outbox SET base_version=? WHERE owner_id=? AND operation_id=?"
        ).run(serverVersion,ownerId,newer.operation_id);
        this.db.exec("COMMIT");
        return "superseded";
      }
      const taskExists=Boolean(this.db.prepare("SELECT 1 AS found FROM tasks WHERE id=?").get(entityId));
      if(!newer&&!taskExists&&action==="upsert"){
        this.db.prepare(`
          INSERT INTO personal_sync_outbox(owner_id,operation_id,entity_type,entity_id,action,base_version,payload,created_at)
          VALUES(?,?,'personal-task',?,'delete',?,NULL,?)
          ON CONFLICT(owner_id,entity_type,entity_id) DO UPDATE SET
            operation_id=excluded.operation_id,action='delete',base_version=excluded.base_version,
            payload=NULL,created_at=excluded.created_at
        `).run(ownerId,randomUUID(),entityId,serverVersion,new Date().toISOString());
        this.db.exec("COMMIT");
        return "deleted-during-upload";
      }
      this.db.exec("COMMIT");
      return "stale";
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  applyRemotePersonalTaskChanges(ownerInput:unknown,changes:readonly PersonalSyncChange[],
    now=new Date()):PersonalSyncConflict[]{
    const ownerId=syncOwnerId(ownerInput);
    if(!Array.isArray(changes)||changes.length>500)throw Error("Invalid remote task changes");
    const conflicts:PersonalSyncConflict[]=[];
    this.db.exec("BEGIN IMMEDIATE");
    try{
      for(const change of changes){
        if(change.entityType!=="personal-task"||!Number.isSafeInteger(change.version)||change.version<1)
          throw Error("Invalid remote personal task change");
        const entityId=parseTaskId(change.entityId);
        const pending=this.db.prepare(
          "SELECT operation_id,action,base_version,payload FROM personal_sync_outbox "+
          "WHERE owner_id=? AND entity_type='personal-task' AND entity_id=?"
        ).get(ownerId,entityId) as {operation_id:string;action:"upsert"|"delete";
          base_version:number|null;payload:string|null}|undefined;
        if(pending){
          if(change.version>(pending.base_version??0)){
            conflicts.push({entityType:"personal-task",entityId,localOperationId:pending.operation_id,
              localAction:pending.action,localPayload:pending.payload?JSON.parse(pending.payload):null,
              remoteVersion:change.version,remotePayload:change.payload as PersonalSyncConflict["remotePayload"],
              remoteDeleted:change.deleted,remoteUpdatedAt:change.updatedAt,
              reason:change.deleted?"remote-delete-while-local-pending":"remote-change-while-local-pending"});
          }
          continue;
        }
        const enrollment=this.db.prepare(
          "SELECT server_version FROM personal_task_sync_enrollment WHERE owner_id=? AND task_id=?"
        ).get(ownerId,entityId) as {server_version:number|null}|undefined;
        if(enrollment?.server_version!==null&&enrollment?.server_version!==undefined&&
          change.version<=enrollment.server_version)continue;
        const task=this.findTask(entityId);
        const acceptedMail=this.db.prepare(
          "SELECT 1 AS found FROM mail_candidate_reviews WHERE task_id=? AND decision='accepted'"
        ).get(entityId);
        // Multiple explicitly enrolled cloud owners share this canonical local
        // task ID. Never let A's remote snapshot silently change B's local copy.
        const anotherOwner=task&&Boolean(this.db.prepare(
          "SELECT 1 FROM personal_task_sync_enrollment WHERE task_id=? AND owner_id<>? LIMIT 1"
        ).get(entityId,ownerId));
        if(task&&(!enrollment||task.source!==null||acceptedMail||anotherOwner)){
          const localPayload=task.source===null&&!acceptedMail?{
            title:task.title,description:task.description,dueDate:task.dueDate,
            priority:task.priority,completed:task.completed,
          }:null;
          conflicts.push({entityType:"personal-task",entityId,localOperationId:null,localAction:null,
            localPayload,remoteVersion:change.version,
            remotePayload:change.payload as PersonalSyncConflict["remotePayload"],
            remoteDeleted:change.deleted,remoteUpdatedAt:change.updatedAt,
            reason:"local-entity-not-eligible"});
          continue;
        }
        if(change.deleted){
          this.db.prepare("DELETE FROM tasks WHERE id=?").run(entityId);
          this.db.prepare("DELETE FROM personal_task_sync_enrollment WHERE owner_id=? AND task_id=?")
            .run(ownerId,entityId);
          continue;
        }
        const payload=change.payload as PersonalTaskSnapshot|null;
        if(!payload||typeof payload!=="object"||!("title" in payload))
          throw Error("Remote task snapshot is missing");
        if(task){
          this.db.prepare(`
            UPDATE tasks SET title=?,description=?,due_date=?,priority=?,completed=?,updated_at=?
            WHERE id=?
          `).run(payload.title,payload.description,payload.dueDate,payload.priority,
            payload.completed?1:0,change.updatedAt,entityId);
        }else{
          this.db.prepare(`
            INSERT INTO tasks(id,title,description,due_date,priority,completed,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?)
          `).run(entityId,payload.title,payload.description,payload.dueDate,payload.priority,
            payload.completed?1:0,change.updatedAt,change.updatedAt);
        }
        this.db.prepare(`
          INSERT INTO personal_task_sync_enrollment(owner_id,task_id,server_version,enabled_at)
          VALUES(?,?,?,?)
          ON CONFLICT(owner_id,task_id) DO UPDATE SET server_version=excluded.server_version
        `).run(ownerId,entityId,change.version,now.toISOString());
      }
      this.db.exec("COMMIT");
      return conflicts;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  recordPersonalSyncConflicts(ownerInput:unknown,conflicts:readonly PersonalSyncConflict[],
    now=new Date()):void{
    const ownerId=syncOwnerId(ownerInput);
    if(!Array.isArray(conflicts)||conflicts.length>1000)throw Error("Invalid personal sync conflicts");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      for(const conflict of conflicts){
        const entityId=requireUuid(conflict.entityId);
        if((conflict.entityType!=="personal-task"&&conflict.entityType!=="manual-calendar-event")||
          !Number.isSafeInteger(conflict.remoteVersion)||conflict.remoteVersion<1||
          typeof conflict.remoteDeleted!=="boolean"||
          (conflict.remoteDeleted?conflict.remotePayload!==null:conflict.remotePayload===null)||
          !Number.isFinite(Date.parse(conflict.remoteUpdatedAt)))
          throw Error("Invalid personal sync conflict");
        if(conflict.localOperationId!==null)requireUuid(conflict.localOperationId);
        if(conflict.localAction!==null&&conflict.localAction!=="upsert"&&conflict.localAction!=="delete")
          throw Error("Invalid local conflict action");
        const stamp=now.toISOString();
        this.db.prepare(`
          INSERT INTO personal_sync_conflicts(owner_id,entity_type,entity_id,local_operation_id,
            local_action,local_payload,remote_version,remote_payload,remote_deleted,remote_updated_at,
            reason,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(owner_id,entity_type,entity_id) DO UPDATE SET
            local_operation_id=excluded.local_operation_id,local_action=excluded.local_action,
            local_payload=excluded.local_payload,remote_version=excluded.remote_version,
            remote_payload=excluded.remote_payload,remote_deleted=excluded.remote_deleted,
            remote_updated_at=excluded.remote_updated_at,reason=excluded.reason,updated_at=excluded.updated_at
          WHERE excluded.remote_version>=personal_sync_conflicts.remote_version
        `).run(ownerId,conflict.entityType,entityId,conflict.localOperationId,conflict.localAction,
          conflict.localPayload===null?null:JSON.stringify(conflict.localPayload),conflict.remoteVersion,
          conflict.remotePayload===null?null:JSON.stringify(conflict.remotePayload),
          conflict.remoteDeleted?1:0,conflict.remoteUpdatedAt,conflict.reason,stamp,stamp);
      }
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }


  /** Read by primary key, not from a capped UI page. All callers provide the authenticated owner. */
  getPersonalSyncConflict(ownerInput:unknown,entityType:PersonalSyncConflict["entityType"],
    entityInput:unknown):PersonalSyncConflictRecord|null{
    const ownerId=syncOwnerId(ownerInput),entityId=requireUuid(entityInput);
    if(entityType!=="personal-task"&&entityType!=="manual-calendar-event")
      throw Error("Invalid personal sync conflict type");
    const row=this.db.prepare(`
      SELECT entity_type,entity_id,local_operation_id,local_action,local_payload,remote_version,
        remote_payload,remote_deleted,remote_updated_at,reason,created_at,updated_at
      FROM personal_sync_conflicts WHERE owner_id=? AND entity_type=? AND entity_id=?
    `).get(ownerId,entityType,entityId) as {
      entity_type:PersonalSyncConflict["entityType"];entity_id:string;local_operation_id:string|null;
      local_action:PersonalSyncConflict["localAction"];local_payload:string|null;remote_version:number;
      remote_payload:string|null;remote_deleted:number;remote_updated_at:string;
      reason:PersonalSyncConflict["reason"];created_at:string;updated_at:string;
    }|undefined;
    return row?{
      entityType:row.entity_type,entityId:row.entity_id,localOperationId:row.local_operation_id,
      localAction:row.local_action,localPayload:row.local_payload?JSON.parse(row.local_payload):null,
      remoteVersion:row.remote_version,remotePayload:row.remote_payload?JSON.parse(row.remote_payload):null,
      remoteDeleted:row.remote_deleted===1,remoteUpdatedAt:row.remote_updated_at,reason:row.reason,
      createdAt:row.created_at,updatedAt:row.updated_at,
    }:null;
  }

  /**
   * Caller must hold the Main-process sync/resolution lock. Performs a strict
   * compare-and-swap on both the reviewed remote version and current local intent.
   */
  resolvePersonalTaskConflict(ownerInput:unknown,input:PersonalSyncResolutionRequest,now=new Date()):void{
    const ownerId=syncOwnerId(ownerInput),entityId=requireUuid(input.entityId);
    if(input.entityType!=="personal-task")throw Error("Wrong personal sync conflict entity");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const conflict=this.getPersonalSyncConflict(ownerId,"personal-task",entityId);
      if(!conflict||conflict.remoteVersion!==input.remoteVersion||
        conflict.localOperationId!==input.localOperationId||
        (conflict.reason!=="remote-change-while-local-pending"&&
          conflict.reason!=="remote-delete-while-local-pending"))
        throw Error("Conflict changed; refresh and review the latest versions");
      const pending=this.db.prepare(
        "SELECT operation_id,action,payload FROM personal_sync_outbox "+
        "WHERE owner_id=? AND entity_type='personal-task' AND entity_id=?"
      ).get(ownerId,entityId) as {operation_id:string;action:"upsert"|"delete";payload:string|null}|undefined;
      const task=this.findTask(entityId);
      const mailDerived=Boolean(this.db.prepare(
        "SELECT 1 FROM mail_candidate_reviews WHERE task_id=? AND decision='accepted'"
      ).get(entityId));
      const snapshot=task?JSON.stringify({
        title:task.title,description:task.description,dueDate:task.dueDate,
        priority:task.priority,completed:task.completed,
      }):null;
      if(!pending||pending.operation_id!==input.localOperationId||
        pending.action!==conflict.localAction||
        JSON.stringify(pending.payload?JSON.parse(pending.payload):null)!==
          JSON.stringify(conflict.localPayload)||
        (pending.action==="upsert"&&(!task||task.source!==null||mailDerived||snapshot!==pending.payload))||
        (pending.action==="delete"&&task))
        throw Error("Local task changed; refresh and review before resolving");
      if(input.choice==="use-remote"){
        const otherEnrollment=this.db.prepare(
          "SELECT 1 FROM personal_task_sync_enrollment WHERE task_id=? AND owner_id<>? LIMIT 1"
        ).get(entityId,ownerId);
        const otherPending=this.db.prepare(
          "SELECT 1 FROM personal_sync_outbox WHERE entity_type='personal-task' AND entity_id=? AND owner_id<>? LIMIT 1"
        ).get(entityId,ownerId);
        if(otherEnrollment||otherPending)
          throw Error("This task is also linked to another account; remote overwrite is blocked");
        if(conflict.remoteDeleted){
          this.db.prepare("DELETE FROM tasks WHERE id=?").run(entityId);
          this.db.prepare("DELETE FROM personal_task_sync_enrollment WHERE owner_id=? AND task_id=?")
            .run(ownerId,entityId);
        }else{
          const remote=conflict.remotePayload as PersonalTaskSnapshot|null;
          if(!remote||typeof remote.title!=="string")throw Error("Invalid remote task snapshot");
          if(task){
            this.db.prepare(`UPDATE tasks
              SET title=?,description=?,due_date=?,priority=?,completed=?,updated_at=? WHERE id=?`)
              .run(remote.title,remote.description,remote.dueDate,remote.priority,
                remote.completed?1:0,conflict.remoteUpdatedAt,entityId);
          }else{
            this.db.prepare(`INSERT INTO tasks
              (id,title,description,due_date,priority,completed,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?)`)
              .run(entityId,remote.title,remote.description,remote.dueDate,remote.priority,
                remote.completed?1:0,conflict.remoteUpdatedAt,conflict.remoteUpdatedAt);
          }
          this.db.prepare(`INSERT INTO personal_task_sync_enrollment
            (owner_id,task_id,server_version,enabled_at) VALUES(?,?,?,?)
            ON CONFLICT(owner_id,task_id) DO UPDATE SET server_version=excluded.server_version`)
            .run(ownerId,entityId,conflict.remoteVersion,now.toISOString());
        }
        this.db.prepare(
          "DELETE FROM personal_sync_outbox WHERE owner_id=? AND entity_type='personal-task' AND entity_id=?"
        ).run(ownerId,entityId);
      }else if(input.choice==="keep-local"){
        if(pending.action==="delete"&&conflict.remoteDeleted){
          // The requested deletion is already reflected on the server.
          this.db.prepare(
            "DELETE FROM personal_sync_outbox WHERE owner_id=? AND entity_type='personal-task' AND entity_id=?"
          ).run(ownerId,entityId);
        }else{
          this.db.prepare(`UPDATE personal_sync_outbox SET operation_id=?,base_version=?,created_at=?
            WHERE owner_id=? AND entity_type='personal-task' AND entity_id=?`)
            .run(randomUUID(),conflict.remoteVersion,now.toISOString(),ownerId,entityId);
          if(task)this.db.prepare(
            "UPDATE personal_task_sync_enrollment SET server_version=? WHERE owner_id=? AND task_id=?"
          ).run(conflict.remoteVersion,ownerId,entityId);
        }
      }else throw Error("Invalid conflict resolution choice");
      const cleared=this.db.prepare(`
        DELETE FROM personal_sync_conflicts
        WHERE owner_id=? AND entity_type='personal-task' AND entity_id=?
          AND remote_version=? AND local_operation_id=?
      `).run(ownerId,entityId,input.remoteVersion,input.localOperationId);
      if(cleared.changes!==1)throw Error("Conflict changed during resolution");
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  /** A calendar decision lives in another SQLite file; remove its conflict only
   * after the calendar decision commits. Compare-and-swap prevents stale clearing. */
  clearPersonalSyncConflict(ownerInput:unknown,input:PersonalSyncResolutionRequest):void{
    const ownerId=syncOwnerId(ownerInput),entityId=requireUuid(input.entityId);
    const cleared=this.db.prepare(`
      DELETE FROM personal_sync_conflicts WHERE owner_id=? AND entity_type=? AND entity_id=?
        AND remote_version=? AND local_operation_id=?
    `).run(ownerId,input.entityType,entityId,input.remoteVersion,input.localOperationId);
    if(cleared.changes!==1)throw Error("Conflict changed during resolution");
  }

  listPersonalSyncConflicts(ownerInput:unknown,limit=100):PersonalSyncConflictRecord[]{
    const ownerId=syncOwnerId(ownerInput);
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error("Invalid sync conflict limit");
    const rows=this.db.prepare(
      "SELECT entity_type,entity_id,local_operation_id,local_action,local_payload,remote_version,"+
      "remote_payload,remote_deleted,remote_updated_at,reason,created_at,updated_at "+
      "FROM personal_sync_conflicts WHERE owner_id=? ORDER BY updated_at DESC,entity_id LIMIT ?"
    ).all(ownerId,limit) as unknown as Array<{
      entity_type:"personal-task"|"manual-calendar-event";entity_id:string;
      local_operation_id:string|null;local_action:"upsert"|"delete"|null;local_payload:string|null;
      remote_version:number;remote_payload:string|null;remote_deleted:number;remote_updated_at:string;
      reason:PersonalSyncConflict["reason"];created_at:string;updated_at:string;
    }>;
    return rows.map(row=>({entityType:row.entity_type,entityId:row.entity_id,
      localOperationId:row.local_operation_id,localAction:row.local_action,
      localPayload:row.local_payload?JSON.parse(row.local_payload):null,
      remoteVersion:row.remote_version,remotePayload:row.remote_payload?JSON.parse(row.remote_payload):null,
      remoteDeleted:row.remote_deleted===1,remoteUpdatedAt:row.remote_updated_at,
      reason:row.reason,createdAt:row.created_at,updatedAt:row.updated_at}));
  }


  createTask(input: unknown): LocalTask {
    const draft = parseCreateTask(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO tasks (id, title, description, due_date, priority, completed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, draft.title, draft.description, draft.dueDate, draft.priority, now, now);
    return this.findTask(id)!;
  }

  updateTask(input: unknown): LocalTask {
    const patch = parseUpdateTask(input);
    const current = this.findTask(patch.id);
    if (!current) throw new Error("Task no longer exists");
    const now = new Date();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE tasks SET title = ?, description = ?, due_date = ?, priority = ?,
        completed = ?, updated_at = ? WHERE id = ?
      `).run(
        patch.title ?? current.title,
        patch.description ?? current.description,
        patch.dueDate === undefined ? current.dueDate : patch.dueDate,
        patch.priority ?? current.priority,
        (patch.completed ?? current.completed) ? 1 : 0,
        now.toISOString(), patch.id,
      );
      this.enqueuePersonalTask(patch.id, now);
      this.db.exec("COMMIT");
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
    // Explicit field-ownership flags survive a user editing a field back to
    // its previous Canvas value; equality with a remote snapshot is insufficient.
    if (current.source && (patch.title !== undefined || patch.dueDate !== undefined)) {
      this.db.prepare(`UPDATE canvas_assignment_links
        SET override_title = CASE WHEN ? THEN 1 ELSE override_title END,
            override_due = CASE WHEN ? THEN 1 ELSE override_due END
        WHERE task_id = ?`).run(patch.title !== undefined ? 1 : 0,
          patch.dueDate !== undefined ? 1 : 0, patch.id);
    }
    return this.findTask(patch.id)!;
  }

  /** Delete personal tasks; a linked Canvas task is hidden for six months instead. */
  removeTask(idInput: unknown): boolean {
    const id = parseTaskId(idInput);
    const linked = this.db.prepare("SELECT task_id FROM canvas_assignment_links WHERE task_id=?").get(id);
    if (linked) return this.setCanvasTaskVisibility(id, false);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const enrollments=this.db.prepare(
        "SELECT owner_id,server_version FROM personal_task_sync_enrollment WHERE task_id=? ORDER BY owner_id"
      ).all(id) as {owner_id:string;server_version:number|null}[];
      const stamp=new Date().toISOString();
      for(const enrolled of enrollments){
        if(enrolled.server_version!==null){
          this.db.prepare(`
            INSERT INTO personal_sync_outbox(owner_id,operation_id,entity_type,entity_id,action,base_version,payload,created_at)
            VALUES(?,?,'personal-task',?,'delete',?,NULL,?)
            ON CONFLICT(owner_id,entity_type,entity_id) DO UPDATE SET
              operation_id=excluded.operation_id,action='delete',
              base_version=excluded.base_version,payload=NULL,created_at=excluded.created_at
          `).run(enrolled.owner_id,randomUUID(),id,enrolled.server_version,stamp);
        }else{
          this.db.prepare(
            "DELETE FROM personal_sync_outbox WHERE owner_id=? AND entity_type='personal-task' AND entity_id=?"
          ).run(enrolled.owner_id,id);
        }
      }
      const removed = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes === 1;
      this.db.exec("COMMIT");
      return removed;
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Six calendar months, clamped to the last day of the destination month. */
  static retentionExpiry(when: Date): string {
    const year = when.getUTCFullYear();
    const month = when.getUTCMonth() + 6;
    const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const clampedDay = Math.min(when.getUTCDate(), maxDay);
    return new Date(Date.UTC(year, month, clampedDay,
      when.getUTCHours(), when.getUTCMinutes(), when.getUTCSeconds(),
      when.getUTCMilliseconds())).toISOString();
  }

  setCanvasTaskVisibility(idInput: unknown, visible: boolean, now = new Date()): boolean {
    const id = parseTaskId(idInput);
    if (typeof visible !== "boolean") throw new Error("Task visibility must be boolean");
    const existing = this.db.prepare("SELECT visible FROM canvas_assignment_links WHERE task_id=?")
      .get(id) as { visible: number } | undefined;
    if (!existing) throw new Error("Only Canvas tasks can be hidden or restored");
    if ((existing.visible === 1) === visible) return true;
    return this.db.prepare(`UPDATE canvas_assignment_links
      SET visible=?, hidden_at=?, retention_expires_at=?
      WHERE task_id=?`).run(visible ? 1 : 0,
      visible ? null : now.toISOString(),
      visible ? null : LocalStore.retentionExpiry(now), id).changes === 1;
  }

  /** Expired hidden records only. Visible personal tasks are never purged. */
  purgeExpiredHiddenCanvasTasks(now = new Date()): number {
    const deleted = this.db.prepare(`DELETE FROM tasks WHERE id IN (
      SELECT task_id FROM canvas_assignment_links
      WHERE visible=0 AND retention_expires_at IS NOT NULL AND retention_expires_at <= ?
    )`).run(now.toISOString()).changes;
    return Number(deleted);
  }

  listCanvasCourseSettings(origin: string, accountId: number): { courseId: number; enabled: boolean }[] {
    this.validateCanvasIdentity(origin, accountId, 1);
    const rows = this.db.prepare(`SELECT course_id, enabled FROM canvas_course_settings
      WHERE instance_origin=? AND account_id=?`).all(origin, accountId) as unknown as
      { course_id: number; enabled: number }[];
    return rows.map((row) => ({ courseId: row.course_id, enabled: row.enabled === 1 }));
  }

  setCanvasCourseEnabled(origin: string, accountId: number, courseId: number, enabled: boolean): void {
    this.validateCanvasIdentity(origin, accountId, courseId);
    if (typeof enabled !== "boolean") throw new Error("Course sync state must be boolean");
    this.db.prepare(`INSERT INTO canvas_course_settings(instance_origin,account_id,course_id,enabled)
      VALUES(?,?,?,?) ON CONFLICT(instance_origin,account_id,course_id)
      DO UPDATE SET enabled=excluded.enabled`).run(origin, accountId, courseId, enabled ? 1 : 0);
  }

  canvasSyncState(origin: string, accountId: number): {
    lastAttempt: string | null; lastSuccess: string | null; lastError: string | null;
  } {
    this.validateCanvasIdentity(origin, accountId, 1);
    const row = this.db.prepare(`SELECT last_attempt, last_success, last_error
      FROM canvas_sync_state WHERE instance_origin=? AND account_id=?`)
      .get(origin, accountId) as {last_attempt: string|null; last_success: string|null;last_error: string|null}|undefined;
    return {lastAttempt: row?.last_attempt ?? null, lastSuccess: row?.last_success ?? null,
      lastError: row?.last_error ?? null};
  }

  updateCanvasSyncState(origin: string, accountId: number, success: boolean, error: string | null, now = new Date()): void {
    this.validateCanvasIdentity(origin, accountId, 1);
    this.db.prepare(`INSERT INTO canvas_sync_state(instance_origin,account_id,last_attempt,last_success,last_error)
      VALUES(?,?,?,?,?) ON CONFLICT(instance_origin,account_id) DO UPDATE SET
      last_attempt=excluded.last_attempt,
      last_success=CASE WHEN excluded.last_success IS NULL THEN canvas_sync_state.last_success ELSE excluded.last_success END,
      last_error=excluded.last_error`).run(origin, accountId, now.toISOString(),
      success ? now.toISOString() : null, error?.slice(0, 160) ?? null);
  }

  /** Mail candidate reviews are local and keyed by account + UIDVALIDITY + UID. */
  mailCandidateDecisions(account: string): {
    uidValidity: number; uid: number; decision: MailCandidateDecision; taskId: string | null;
  }[] {
    const rows = this.db.prepare("SELECT uid_validity,uid,decision,task_id " +
      "FROM mail_candidate_reviews WHERE account=?").all(account) as unknown as {
        uid_validity: number; uid: number; decision: "ignored"|"accepted"; task_id: string|null;
      }[];
    return rows.map(row => ({uidValidity:row.uid_validity,uid:row.uid,
      decision:row.decision,taskId:row.task_id}));
  }

  /**
   * Convert an authorized mail candidate into a canonical local task and
   * persist its idempotency record in one SQLite transaction. Mail Date is
   * send time, not a deadline, so the resulting task has no due date.
   */
  reviewMailCandidate(record: MailRecord, action: MailCandidateAction): MailCandidateChoiceResult {
    if (!record.account.endsWith("@sjtu.edu.cn") ||
        !Number.isSafeInteger(record.uid) || record.uid < 1 ||
        !Number.isSafeInteger(record.uidValidity) || record.uidValidity < 1 ||
        !["accept","ignore","reopen"].includes(action)) {
      throw new Error("Invalid mail candidate source");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const args = [record.account,record.uidValidity,record.uid] as const;
      const existing = this.db.prepare("SELECT decision,task_id FROM mail_candidate_reviews " +
        "WHERE account=? AND uid_validity=? AND uid=?")
        .get(...args) as {decision:"ignored"|"accepted";task_id:string|null}|undefined;
      let result: MailCandidateChoiceResult;
      if (action === "accept") {
        if (existing?.decision === "ignored") throw new Error("Restore the candidate before creating a task");
        if (existing?.decision === "accepted") {
          result = {action,taskId:existing.task_id,created:false};
        } else {
          const id = randomUUID();
          const now = new Date().toISOString();
          this.db.prepare("INSERT INTO tasks(" +
            "id,title,description,due_date,priority,completed,created_at,updated_at) " +
            "VALUES(?,?,?,NULL,'normal',0,?,?)")
            .run(id,suggestedTaskTitle(record.subject),"",now,now);
          this.db.prepare("INSERT INTO mail_candidate_reviews(" +
            "account,uid_validity,uid,decision,task_id,decided_at) " +
            "VALUES(?,?,?,'accepted',?,?)").run(...args,id,now);
          result = {action,taskId:id,created:true};
        }
      } else if (action === "ignore") {
        if (existing?.decision === "accepted") throw new Error("Edit the created task in Calendar");
        if (!existing) this.db.prepare("INSERT INTO mail_candidate_reviews(" +
          "account,uid_validity,uid,decision,task_id,decided_at) " +
          "VALUES(?,?,?,'ignored',NULL,?)").run(...args,new Date().toISOString());
        result = {action,taskId:null,created:false};
      } else {
        if (existing?.decision === "accepted") throw new Error("This candidate already created a task");
        if (existing?.decision === "ignored") this.db.prepare("DELETE FROM mail_candidate_reviews " +
          "WHERE account=? AND uid_validity=? AND uid=?").run(...args);
        result = {action,taskId:null,created:false};
      }
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Forget mailbox-specific metadata on disconnect, without deleting personal tasks. */
  clearMailCandidateDecisions(account: string): number {
    return Number(this.db.prepare("DELETE FROM mail_candidate_reviews WHERE account=?")
      .run(account).changes);
  }

  /** Convert a Canvas instant into the user's local calendar day. */
  private assignmentDate(value: string | null): string | null {
    if (!value) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return [
      String(date.getFullYear()).padStart(4, "0"),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  }

  private validateCanvasIdentity(origin: string, accountId: number, courseId: number): void {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin ||
      !Number.isSafeInteger(accountId) || accountId < 1 ||
      !Number.isSafeInteger(courseId) || courseId < 1) {
      throw new Error("Invalid Canvas account or course identity");
    }
  }

  listImportedCanvasAssignmentIds(origin: string, accountId: number, courseId: number): number[] {
    this.validateCanvasIdentity(origin, accountId, courseId);
    const rows = this.db.prepare(`
      SELECT assignment_id FROM canvas_assignment_links
      WHERE instance_origin = ? AND account_id = ? AND course_id = ?
    `).all(origin, accountId, courseId) as unknown as { assignment_id: number }[];
    return rows.map((row) => row.assignment_id);
  }

  /** A deliberate import, not an automatic import of all Canvas assignments. */
  importCanvasAssignment(origin: string, accountId: number, assignment: CanvasAssignment): CanvasImportResult {
    this.validateCanvasIdentity(origin, accountId, assignment.courseId);
    if (!Number.isSafeInteger(assignment.id) || assignment.id < 1) {
      throw new Error("Invalid Canvas assignment identifier");
    }
    const name = assignment.name.trim().slice(0, 120) || `Canvas 作业 ${assignment.id}`;
    const dueDate = this.assignmentDate(assignment.dueAt);
    const existing = this.db.prepare(`
      SELECT task_id FROM canvas_assignment_links
      WHERE instance_origin = ? AND account_id = ? AND course_id = ? AND assignment_id = ?
    `).get(origin, accountId, assignment.courseId, assignment.id) as { task_id: string } | undefined;
    if (existing) {
      return { taskId: existing.task_id, created: false, updatedFields: [] };
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO tasks(id,title,description,due_date,priority,completed,created_at,updated_at)
        VALUES(?,?,?,?,'normal',0,?,?)
      `).run(id, name, "", dueDate, now, now);
      this.db.prepare(`
        INSERT INTO canvas_assignment_links(
          instance_origin,account_id,course_id,assignment_id,task_id,
          remote_title,remote_due_date,source_url,last_synced_at,missing
        ) VALUES(?,?,?,?,?,?,?,?,?,0)
      `).run(origin, accountId, assignment.courseId, assignment.id, id,
        name, dueDate, assignment.htmlUrl, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { taskId: id, created: true, updatedFields: [] };
  }

  /**
   * Update only previously imported assignments. Remote-controlled title and
   * date fields are refreshed only while matching the prior remote snapshot.
   * Personal description, completion, priority and edited fields are retained.
   */
  syncImportedCanvasAssignments(
    origin: string, accountId: number, courseId: number, assignments: CanvasAssignment[],
  ): CanvasSyncResult {
    this.validateCanvasIdentity(origin, accountId, courseId);
    const imported = this.listImportedCanvasAssignmentIds(origin, accountId, courseId);
    const byId = new Map(assignments.filter((a) => a.courseId === courseId).map((a) => [a.id, a]));
    const result: CanvasSyncResult = { imported: imported.length, changed: 0, missing: 0, preserved: 0 };
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const assignmentId of imported) {
        const old = this.db.prepare(`
          SELECT l.*, t.title AS task_title, t.due_date AS task_due_date FROM canvas_assignment_links l
          JOIN tasks t ON t.id=l.task_id
          WHERE l.instance_origin=? AND l.account_id=? AND l.course_id=? AND l.assignment_id=?
        `).get(origin, accountId, courseId, assignmentId) as unknown as {
          task_id: string; remote_title: string; remote_due_date: string | null;
          task_title: string; task_due_date: string | null;
          visible: number; override_title: number; override_due: number;
        } | undefined;
        if (!old) continue;
        if (old.visible === 0) continue; // Never unhide or mutate hidden records.
        const remote = byId.get(assignmentId);
        if (!remote) {
          this.db.prepare(`
            UPDATE canvas_assignment_links SET missing=1
            WHERE instance_origin=? AND account_id=? AND course_id=? AND assignment_id=?
          `).run(origin, accountId, courseId, assignmentId);
          result.missing++;
          continue;
        }

        const remoteTitle = remote.name.trim().slice(0, 120) || `Canvas 作业 ${remote.id}`;
        const remoteDue = this.assignmentDate(remote.dueAt);
        const preserveTitle = old.override_title === 1 || old.task_title !== old.remote_title;
        const preserveDue = old.override_due === 1 || old.task_due_date !== old.remote_due_date;
        const title = preserveTitle ? old.task_title : remoteTitle;
        const dueDate = preserveDue ? old.task_due_date : remoteDue;
        if (preserveTitle || preserveDue) result.preserved++;
        if (title !== old.task_title || dueDate !== old.task_due_date) {
          this.db.prepare("UPDATE tasks SET title=?, due_date=?, updated_at=? WHERE id=?")
            .run(title, dueDate, now, old.task_id);
          result.changed++;
        }
        this.db.prepare(`
          UPDATE canvas_assignment_links
          SET remote_title=?, remote_due_date=?, source_url=?, last_synced_at=?, missing=0
          WHERE instance_origin=? AND account_id=? AND course_id=? AND assignment_id=?
        `).run(remoteTitle, remoteDue, remote.htmlUrl, now,
          origin, accountId, courseId, assignmentId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return result;
  }

  /** Upserts all discovered assignments; hidden ones remain untouched and deduplicated. */
  reconcileCanvasCourse(origin: string, accountId: number, courseId: number,
    assignments: CanvasAssignment[]): { created: number; changed: number; missing: number; preserved: number } {
    this.validateCanvasIdentity(origin, accountId, courseId);
    let created = 0;
    for (const assignment of assignments) {
      if (assignment.courseId !== courseId) continue;
      if (this.importCanvasAssignment(origin, accountId, assignment).created) created++;
    }
    const result = this.syncImportedCanvasAssignments(origin, accountId, courseId, assignments);
    return { created, changed: result.changed, missing: result.missing, preserved: result.preserved };
  }

  listFocusSessions(): FocusSession[] {
    const rows = this.db.prepare(
      "SELECT * FROM focus_sessions ORDER BY ended_at DESC LIMIT 500",
    ).all() as unknown as FocusRow[];
    return rows.map(focusFromRow);
  }

  recordFocusSession(input: unknown): FocusSession {
    const session = parseFocusCompletion(input);
    const now = new Date();
    const completed = session.elapsedSeconds === session.plannedMinutes * 60;
    const points = completed ? session.plannedMinutes : 0;
    // Recorded instants are for local display, not an independently verified time authority.
    // Restrict future/backdated wall times rather than accepting arbitrary calendar history.
    if (session.startedAt !== null && session.endedAt !== null) {
      if (Date.parse(session.endedAt) > now.getTime() + 60_000 ||
          Date.parse(session.startedAt) < now.getTime() - 48 * 3600000) {
        throw new Error("Focus wall-clock times are outside the accepted window");
      }
    }
    const started = session.startedAt ??
      new Date(now.getTime() - session.elapsedSeconds * 1000).toISOString();
    const ended = session.endedAt ?? now.toISOString();
    // The session ID is an idempotency key. Repeated IPC calls cannot earn points twice.
    this.db.prepare(`
      INSERT INTO focus_sessions
      (id, title, planned_minutes, elapsed_seconds, completed, points,
       started_at, ended_at, time_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      session.sessionId, session.title, session.plannedMinutes, session.elapsedSeconds,
      completed ? 1 : 0, points, started, ended,
      session.startedAt !== null ? "recorded" : "estimated",
    );
    const row = this.db.prepare(
      "SELECT * FROM focus_sessions WHERE id = ?",
    ).get(session.sessionId) as unknown as FocusRow | undefined;
    if (!row) throw new Error("Focus record could not be loaded");
    return focusFromRow(row);
  }

  /** Post-hoc edits are limited to presentation data, never points or timestamps. */
  renameFocusSession(input: unknown): FocusSession {
    const update = parseFocusTitleUpdate(input);
    const result = this.db.prepare("UPDATE focus_sessions SET title = ? WHERE id = ?")
      .run(update.title, update.id);
    if (Number(result.changes) !== 1) throw new Error("Focus session not found");
    const row = this.db.prepare("SELECT * FROM focus_sessions WHERE id = ?")
      .get(update.id) as unknown as FocusRow;
    return focusFromRow(row);
  }

  /** Aggregate all sessions from the recent local window; the UI's list
   * of 500 sessions is deliberately NOT the source for statistics. */
  focusInsights(zone:unknown,now=new Date()):FocusInsights{
    const timeZone=requireFocusTimeZone(zone);
    if(!Number.isFinite(now.getTime()))throw Error("Invalid statistics clock");
    // UTC window safely covers the last 30 local dates for all IANA zones.
    const from=new Date(now.getTime()-32*86_400_000).toISOString();
    const rows=this.db.prepare(
      "SELECT ended_at,elapsed_seconds,completed,points,time_source "+
      "FROM focus_sessions WHERE ended_at >= ? AND ended_at <= ? "+
      "ORDER BY ended_at ASC LIMIT 20001"
    ).all(from,now.toISOString()) as unknown as FocusInsightRow[];
    if(rows.length>20000)
      throw Error("Too many recent focus sessions for bounded statistics");
    return buildFocusInsights(rows,timeZone,now);
  }

  /** True accounting is from the full earned session ledger minus every
   * redemption, not the recent 500 UI rows or a client-supplied balance. */
  private focusRewardBalance():{earned:number;spent:number;available:number}{
    const earned=Number((this.db.prepare(
      "SELECT COALESCE(SUM(points),0) AS total FROM focus_sessions"
    ).get() as {total:number}).total);
    const spent=Number((this.db.prepare(
      "SELECT COALESCE(SUM(cost),0) AS total FROM focus_reward_redemptions"
    ).get() as {total:number}).total);
    if(!Number.isSafeInteger(earned)||!Number.isSafeInteger(spent)||
      earned<0||spent<0||spent>earned)
      throw Error("Corrupt local virtual reward balance");
    return {earned,spent,available:earned-spent};
  }
  focusRewards():FocusRewardOverview{
    const balance=this.focusRewardBalance();
    const rewards=this.db.prepare(
      "SELECT * FROM focus_rewards ORDER BY active DESC,created_at DESC,id DESC LIMIT 100"
    ).all() as Array<{id:string;title:string;description:string;cost:number;
      active:number;created_at:string;updated_at:string}>;
    const history=this.db.prepare(
      "SELECT * FROM focus_reward_redemptions ORDER BY redeemed_at DESC,id DESC LIMIT 100"
    ).all() as Array<{id:string;reward_id:string;reward_title:string;cost:number;redeemed_at:string}>;
    return {...balance,...virtualFocusLevel(balance.earned),
      rewards:rewards.map(x=>({id:x.id,title:x.title,description:x.description,
        cost:x.cost,active:x.active===1,createdAt:x.created_at,updatedAt:x.updated_at})),
      recentRedemptions:history.map(x=>({id:x.id,rewardId:x.reward_id,
        rewardTitle:x.reward_title,cost:x.cost,redeemedAt:x.redeemed_at}))};
  }
  createFocusReward(input:unknown,now=new Date()):FocusReward{
    const item=parseRewardCreate(input);
    if(!Number.isFinite(now.getTime()))throw Error("Invalid reward clock");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const count=(this.db.prepare("SELECT COUNT(*) AS total FROM focus_rewards")
        .get() as {total:number}).total;
      if(count>=100)throw Error("At most 100 local rewards can be created");
      const id=randomUUID(),stamp=now.toISOString();
      this.db.prepare("INSERT INTO focus_rewards "+
        "(id,title,description,cost,active,created_at,updated_at) VALUES(?,?,?,?,1,?,?)"
      ).run(id,item.title,item.description,item.cost,stamp,stamp);
      this.db.exec("COMMIT");
      return {id,...item,active:true,createdAt:stamp,updatedAt:stamp};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  editFocusReward(input:unknown,now=new Date()):FocusReward{
    const item=parseRewardEdit(input);
    if(!Number.isFinite(now.getTime()))throw Error("Invalid reward clock");
    const stamp=new Date(Math.max(now.getTime(),
      Date.parse(item.expectedUpdatedAt)+1)).toISOString();
    const result=this.db.prepare(
      "UPDATE focus_rewards SET title=?,description=?,cost=?,active=?,updated_at=? "+
      "WHERE id=? AND updated_at=?"
    ).run(item.title,item.description,item.cost,item.active?1:0,
      stamp,item.id,item.expectedUpdatedAt);
    if(Number(result.changes)!==1)
      throw Error("Reward changed or disappeared; reload before editing");
    return {...item,createdAt:(this.db.prepare(
      "SELECT created_at FROM focus_rewards WHERE id=?"
    ).get(item.id) as {created_at:string}).created_at,updatedAt:stamp};
  }
  /** Application-level append-only spending, serialized with BEGIN IMMEDIATE.
   * Identical retries return the original receipt; mismatched keys fail. */
  redeemFocusReward(input:unknown,now=new Date()):FocusRewardRedemption{
    const item=parseRewardRedeem(input);
    if(!Number.isFinite(now.getTime()))throw Error("Invalid reward clock");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const found=this.db.prepare(
        "SELECT * FROM focus_reward_redemptions WHERE id=?"
      ).get(item.redemptionId) as {reward_id:string;reward_title:string;cost:number;
        redeemed_at:string}|undefined;
      if(found){
        if(found.reward_id!==item.rewardId)
          throw Error("Redemption idempotency key belongs to another reward");
        this.db.exec("COMMIT");
        return {id:item.redemptionId,rewardId:found.reward_id,
          rewardTitle:found.reward_title,cost:found.cost,redeemedAt:found.redeemed_at};
      }
      const reward=this.db.prepare(
        "SELECT title,cost,active FROM focus_rewards WHERE id=?"
      ).get(item.rewardId) as {title:string;cost:number;active:number}|undefined;
      if(!reward||reward.active!==1)throw Error("Reward is unavailable");
      if(this.focusRewardBalance().available<reward.cost)
        throw Error("Insufficient earned focus points for reward");
      const redeemedAt=now.toISOString();
      this.db.prepare("INSERT INTO focus_reward_redemptions "+
        "(id,reward_id,reward_title,cost,redeemed_at) VALUES(?,?,?,?,?)"
      ).run(item.redemptionId,item.rewardId,reward.title,reward.cost,redeemedAt);
      this.db.exec("COMMIT");
      return {id:item.redemptionId,rewardId:item.rewardId,
        rewardTitle:reward.title,cost:reward.cost,redeemedAt};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  focusSummary(): FocusSummary {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS sessions,
      COALESCE(SUM(completed), 0) AS completed_sessions,
      COALESCE(SUM(elapsed_seconds), 0) AS elapsed_seconds,
      COALESCE(SUM(points), 0) AS points
      FROM focus_sessions
    `).get() as {
      sessions: number; completed_sessions: number; elapsed_seconds: number; points: number;
    };
    return {
      sessions: row.sessions,
      completedSessions: row.completed_sessions,
      totalMinutes: Math.floor(row.elapsed_seconds / 60),
      points: row.points,
    };
  }
}
