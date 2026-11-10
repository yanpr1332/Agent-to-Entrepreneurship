/**
 * Local-only DTOs and input validation shared between main, preload and renderer.
 * All write requests are validated again in the main process.
 */
export type TaskPriority = "low" | "normal" | "high";

export interface CanvasTaskSource {
  provider: "canvas";
  instanceUrl: string;
  accountId: number;
  courseId: number;
  assignmentId: number;
  sourceUrl: string | null;
  lastSyncedAt: string;
}

export interface LocalTask {
  id: string;
  title: string;
  description: string;
  dueDate: string | null;
  priority: TaskPriority;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
  source: CanvasTaskSource | null;
  /** Hidden items remain in SQLite but are omitted from ordinary calendar/workbench views. */
  visible: boolean;
  hiddenAt: string | null;
  retentionExpiresAt: string | null;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  dueDate?: string | null;
  priority?: TaskPriority;
}

export interface UpdateTaskInput {
  id: string;
  title?: string;
  description?: string;
  dueDate?: string | null;
  priority?: TaskPriority;
  completed?: boolean;
}

export interface FocusCompletionInput {
  sessionId: string;
  plannedMinutes: number;
  elapsedSeconds: number;
}

export interface FocusSession {
  id: string;
  plannedMinutes: number;
  elapsedSeconds: number;
  completed: boolean;
  points: number;
  startedAt: string;
  endedAt: string;
}

export interface FocusSummary {
  sessions: number;
  completedSessions: number;
  totalMinutes: number;
  points: number;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(input: unknown): UnknownRecord {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid payload");
  }
  return input as UnknownRecord;
}

function onlyKeys(record: UnknownRecord, allowed: readonly string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new Error("Unexpected input field");
  }
}

function parseTitle(value: unknown): string {
  if (typeof value !== "string") throw new Error("Task title must be text");
  const title = value.trim();
  if (title.length === 0 || title.length > 120) {
    throw new Error("Task title must contain 1–120 characters");
  }
  return title;
}

function parseDescription(value: unknown): string {
  if (typeof value !== "string" || value.length > 2000) {
    throw new Error("Task description must contain at most 2000 characters");
  }
  return value.trim();
}

function parsePriority(value: unknown): TaskPriority {
  if (value !== "low" && value !== "normal" && value !== "high") {
    throw new Error("Invalid task priority");
  }
  return value;
}

function parseDueDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("Invalid due date");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Invalid due date");
  }
  return value;
}

export function parseTaskId(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)) {
    throw new Error("Invalid task id");
  }
  return input;
}

export function parseCreateTask(input: unknown): Required<CreateTaskInput> {
  const record = asRecord(input);
  onlyKeys(record, ["title", "description", "dueDate", "priority"]);
  return {
    title: parseTitle(record.title),
    description: record.description === undefined ? "" : parseDescription(record.description),
    dueDate: record.dueDate === undefined ? null : parseDueDate(record.dueDate),
    priority: record.priority === undefined ? "normal" : parsePriority(record.priority),
  };
}

export function parseUpdateTask(input: unknown): UpdateTaskInput {
  const record = asRecord(input);
  onlyKeys(record, ["id", "title", "description", "dueDate", "priority", "completed"]);
  const id = parseTaskId(record.id);
  const patch: UpdateTaskInput = { id };
  if (Object.hasOwn(record, "title")) patch.title = parseTitle(record.title);
  if (Object.hasOwn(record, "description")) patch.description = parseDescription(record.description);
  if (Object.hasOwn(record, "dueDate")) patch.dueDate = parseDueDate(record.dueDate);
  if (Object.hasOwn(record, "priority")) patch.priority = parsePriority(record.priority);
  if (Object.hasOwn(record, "completed")) {
    if (typeof record.completed !== "boolean") throw new Error("Invalid task completion flag");
    patch.completed = record.completed;
  }
  if (Object.keys(patch).length === 1) throw new Error("Empty task update");
  return patch;
}

export function parseFocusCompletion(input: unknown): FocusCompletionInput {
  const record = asRecord(input);
  onlyKeys(record, ["sessionId", "plannedMinutes", "elapsedSeconds"]);
  const sessionId = parseTaskId(record.sessionId);
  const { plannedMinutes, elapsedSeconds } = record;
  if (typeof plannedMinutes !== "number" || !Number.isInteger(plannedMinutes) || plannedMinutes < 1 || plannedMinutes > 180) {
    throw new Error("Focus length must be 1–180 minutes");
  }
  if (typeof elapsedSeconds !== "number" || !Number.isInteger(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > plannedMinutes * 60) {
    throw new Error("Invalid focus duration");
  }
  return { sessionId, plannedMinutes, elapsedSeconds };
}
