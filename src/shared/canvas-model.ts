/** Non-secret Canvas data permitted to cross the Electron IPC boundary. */
export interface CanvasCourse {
  id: number;
  name: string;
  courseCode: string;
}

export interface CanvasAssignment {
  id: number;
  courseId: number;
  name: string;
  dueAt: string | null;
  htmlUrl: string | null;
  pointsPossible: number | null;
}

export interface CanvasConnectionStatus {
  connected: boolean;
  baseUrl: string | null;
  mode: "developer-local-token" | null;
}

export interface CanvasPersonalTokenInput {
  baseUrl: string;
  token: string;
}

export function parseCanvasPersonalTokenInput(input: unknown): CanvasPersonalTokenInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Canvas connection request is invalid");
  }
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some((key) => key !== "baseUrl" && key !== "token")) {
    throw new Error("Canvas connection request contains unexpected fields");
  }
  if (typeof data.baseUrl !== "string" || data.baseUrl.length > 2048) {
    throw new Error("Canvas instance address is required");
  }
  if (typeof data.token !== "string" || !data.token.trim() || data.token.length > 4096 ||
      /[\r\n]/.test(data.token)) {
    throw new Error("Invalid Canvas personal token");
  }
  return { baseUrl: data.baseUrl, token: data.token.trim() };
}

export function parseCanvasCourseId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("Invalid Canvas course identifier");
  }
  return value;
}

export interface CanvasImportResult {
  taskId: string;
  created: boolean;
  updatedFields: string[];
}

export interface CanvasSyncResult {
  imported: number;
  changed: number;
  missing: number;
  preserved: number;
}

/** Per-course sync preferences are independent of individual task visibility. */
export interface CanvasCourseSetting {
  courseId: number;
  enabled: boolean;
}
export interface CanvasAutoSyncSummary {
  connected: boolean;
  running: boolean;
  coursesChecked: number;
  assignmentsSeen: number;
  created: number;
  changed: number;
  preserved: number;
  missing: number;
  failedCourses: number;
  calendarEventsSeen?: number;
  calendarCreated?: number;
  calendarChanged?: number;
  calendarMissing?: number;
  calendarSkipped?: number;
  calendarFailedCourses?: number;
  lastAttempt: string | null;
  lastSuccess: string | null;
  lastError: string | null;
}
