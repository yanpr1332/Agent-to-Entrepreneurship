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
  /** Optional for compatibility with clients from before ALPHA-TIME-002. */
  title?: string;
  /** The actual wall-clock bounds, distinct from effective focus duration. */
  startedAt?: string;
  endedAt?: string;
}

export interface ParsedFocusCompletion {
  sessionId: string;
  plannedMinutes: number;
  elapsedSeconds: number;
  title: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface FocusTitleUpdate {
  id: string;
  title: string;
}

/** Short-lived, explicit focus guard. Never blocks OS recovery or kills apps.
 * "shield" only controls this application's full-screen window. */
export type FocusGuardMode="off"|"monitor"|"shield";
export type FocusGuardListMode="block"|"allow";
export interface FocusGuardStartInput {
  sessionId:string;
  durationSeconds:number;
  mode:FocusGuardMode;
  listMode:FocusGuardListMode;
  appNames:string[];
}
export interface FocusGuardStatus {
  active:boolean;
  mode:FocusGuardMode;
  endsAt:string|null;
  monitor:"idle"|"checking"|"available"|"unavailable";
  distraction:boolean;
  foregroundApp:string|null;
  warning:string|null;
  safeExitShortcut:string;
}
export interface FocusSession {
  id: string;
  title: string;
  plannedMinutes: number;
  elapsedSeconds: number;
  completed: boolean;
  points: number;
  startedAt: string;
  endedAt: string;
  /** Legacy sessions have a derived start time and are not actual calendar events. */
  timeSource: "recorded" | "estimated";
}

/** Virtual, user-defined rewards: never an actual purchase or entitlement. */
export interface FocusReward {
  id:string;
  title:string;
  description:string;
  cost:number;
  active:boolean;
  createdAt:string;
  updatedAt:string;
}
export interface FocusRewardCreateInput {
  title:string;description:string;cost:number;
}
export interface FocusRewardEditInput extends FocusRewardCreateInput {
  id:string;active:boolean;expectedUpdatedAt:string;
}
export interface FocusRewardRedeemInput {
  /** Unique client idempotency key, reused only for a retry of this reward. */
  redemptionId:string;rewardId:string;
}
export interface FocusRewardRedemption {
  id:string;rewardId:string;
  rewardTitle:string;cost:number;redeemedAt:string;
}
export interface FocusRewardOverview {
  earned:number;spent:number;available:number;
  level:number;badge:string;
  rewards:FocusReward[];
  recentRedemptions:FocusRewardRedemption[];
}

export interface FocusSummary {
  sessions: number;
  completedSessions: number;
  totalMinutes: number;
  points: number;
}

/** A local day is the date when the session ENDED in the selected timezone. */
export interface FocusInsightsTotals {
  sessions:number;
  completedSessions:number;
  minutes:number;
  points:number;
}
export interface FocusInsightsDay extends FocusInsightsTotals {
  day:string;recordedSessions:number;estimatedSessions:number;
}
export interface FocusInsights {
  timeZone:string;
  asOf:string;
  days:FocusInsightsDay[];
  last7:FocusInsightsTotals;
  previous7:FocusInsightsTotals;
  last30:FocusInsightsTotals;
  currentStreakDays:number;
  bestStreakDays:number;
  estimatedSessions:number;
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

/** User-controlled titles never become HTML or executable source. */
export function parseFocusTitle(input: unknown): string {
  if (typeof input !== "string") throw new Error("Invalid focus title");
  const title = input.trim();
  if (title.length < 1 || title.length > 120) throw new Error("Focus title must contain 1–120 characters");
  return title;
}

function parseFocusInstant(input: unknown): string {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input))
    throw new Error("Invalid focus timestamp");
  const date = new Date(input);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== input) throw new Error("Invalid focus timestamp");
  return input;
}

export function parseFocusTitleUpdate(input: unknown): FocusTitleUpdate {
  const record = asRecord(input);
  onlyKeys(record, ["id", "title"]);
  return { id: parseTaskId(record.id), title: parseFocusTitle(record.title) };
}

export function parseFocusCompletion(input: unknown): ParsedFocusCompletion {
  const record = asRecord(input);
  onlyKeys(record, ["sessionId", "plannedMinutes", "elapsedSeconds", "title", "startedAt", "endedAt"]);
  const sessionId = parseTaskId(record.sessionId);
  const { plannedMinutes, elapsedSeconds } = record;
  if (typeof plannedMinutes !== "number" || !Number.isInteger(plannedMinutes) || plannedMinutes < 1 || plannedMinutes > 180) {
    throw new Error("Focus length must be 1–180 minutes");
  }
  if (typeof elapsedSeconds !== "number" || !Number.isInteger(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > plannedMinutes * 60) {
    throw new Error("Invalid focus duration");
  }
  // Both bounds must be provided together; old clients may omit both.
  if ((record.startedAt === undefined) !== (record.endedAt === undefined)) {
    throw new Error("Focus timestamps must be paired");
  }
  const startedAt = record.startedAt === undefined ? null : parseFocusInstant(record.startedAt);
  const endedAt = record.endedAt === undefined ? null : parseFocusInstant(record.endedAt);
  if (startedAt !== null && endedAt !== null) {
    const wallMilliseconds = Date.parse(endedAt) - Date.parse(startedAt);
    if (wallMilliseconds < 0 || wallMilliseconds > 48 * 3600000 ||
        wallMilliseconds + 1500 < elapsedSeconds * 1000) {
      throw new Error("Invalid focus wall-clock interval");
    }
  }
  return {
    sessionId, plannedMinutes, elapsedSeconds,
    title: record.title === undefined ? "专注学习" : parseFocusTitle(record.title),
    startedAt, endedAt,
  };
}
