import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CanvasAssignment, CanvasImportResult, CanvasSyncResult } from "../shared/canvas-model";
import {
  parseCreateTask, parseFocusCompletion, parseTaskId, parseUpdateTask,
  type FocusSession, type FocusSummary, type LocalTask, type TaskPriority,
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
  planned_minutes: number;
  elapsed_seconds: number;
  completed: number;
  points: number;
  started_at: string;
  ended_at: string;
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

function focusFromRow(row: FocusRow): FocusSession {
  return {
    id: row.id, plannedMinutes: row.planned_minutes,
    elapsedSeconds: row.elapsed_seconds, completed: row.completed === 1,
    points: row.points, startedAt: row.started_at, endedAt: row.ended_at,
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
    if (version > 3) throw new Error("Database created by a newer application; refusing to downgrade");
    if (version === 3) return;

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
      this.db.exec("PRAGMA user_version = 3");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
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
    this.db.prepare(`
      UPDATE tasks SET title = ?, description = ?, due_date = ?, priority = ?,
      completed = ?, updated_at = ? WHERE id = ?
    `).run(
      patch.title ?? current.title,
      patch.description ?? current.description,
      patch.dueDate === undefined ? current.dueDate : patch.dueDate,
      patch.priority ?? current.priority,
      (patch.completed ?? current.completed) ? 1 : 0,
      new Date().toISOString(), patch.id,
    );
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
    return this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes === 1;
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
    return this.db.prepare(`DELETE FROM tasks WHERE id IN (
      SELECT task_id FROM canvas_assignment_links
      WHERE visible=0 AND retention_expires_at IS NOT NULL AND retention_expires_at <= ?
    )`).run(now.toISOString()).changes;
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
      "SELECT * FROM focus_sessions ORDER BY ended_at DESC LIMIT 100",
    ).all() as unknown as FocusRow[];
    return rows.map(focusFromRow);
  }

  recordFocusSession(input: unknown): FocusSession {
    const session = parseFocusCompletion(input);
    const now = new Date();
    const completed = session.elapsedSeconds === session.plannedMinutes * 60;
    const points = completed ? session.plannedMinutes : 0;
    // The session ID is an idempotency key. Repeated IPC calls cannot earn points twice.
    this.db.prepare(`
      INSERT INTO focus_sessions
      (id, planned_minutes, elapsed_seconds, completed, points, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      session.sessionId, session.plannedMinutes, session.elapsedSeconds,
      completed ? 1 : 0, points,
      new Date(now.getTime() - session.elapsedSeconds * 1000).toISOString(),
      now.toISOString(),
    );
    const row = this.db.prepare(
      "SELECT * FROM focus_sessions WHERE id = ?",
    ).get(session.sessionId) as unknown as FocusRow | undefined;
    if (!row) throw new Error("Focus record could not be loaded");
    return focusFromRow(row);
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
