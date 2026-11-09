import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    if (row.user_version > 1) {
      throw new Error("Database created by a newer application; refusing to downgrade");
    }
    if (row.user_version === 1) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
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
        PRAGMA user_version = 1;
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

  listTasks(): LocalTask[] {
    const rows = this.db.prepare(
      "SELECT * FROM tasks ORDER BY completed ASC, (due_date IS NULL) ASC, due_date ASC, created_at DESC",
    ).all() as unknown as TaskRow[];
    return rows.map(taskFromRow);
  }

  private findTask(id: string): LocalTask | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
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
    ).get(session.sessionId) as FocusRow;
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
