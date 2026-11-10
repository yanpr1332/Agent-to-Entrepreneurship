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
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version > 2) {
      throw new Error("Database created by a newer application; refusing to downgrade");
    }
    if (row.user_version === 2) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (row.user_version === 0) {
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
        PRAGMA user_version = 2;
      `);
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
    l.assignment_id, l.source_url, l.last_synced_at
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
    return this.findTask(patch.id)!;
  }

  removeTask(idInput: unknown): boolean {
    const id = parseTaskId(idInput);
    return this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id).changes === 1;
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
        } | undefined;
        if (!old) continue;
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
        const preserveTitle = old.task_title !== old.remote_title;
        const preserveDue = old.task_due_date !== old.remote_due_date;
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
