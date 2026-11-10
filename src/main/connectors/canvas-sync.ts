import type { CanvasAutoSyncSummary, CanvasCourseSetting } from "../../shared/canvas-model";
import { LocalStore } from "../local-store";
import { CanvasApi } from "./canvas-api";

const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const MAX_COURSES_PER_RUN = 100;

/**
 * Main-process coordinator for one Canvas account per developer-local device.
 * No token or raw HTTP response is exposed through results or callbacks.
 * Subsequent providers can use the same lifecycle pattern without importing
 * Canvas DTOs into the generic task authority.
 */
export class CanvasSyncService {
  private pending: Promise<CanvasAutoSyncSummary> | null = null;
  private generation = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private latest: CanvasAutoSyncSummary = {
    connected: false, running: false, coursesChecked: 0,
    assignmentsSeen: 0, created: 0, changed: 0,
    preserved: 0, missing: 0, failedCourses: 0,
    lastAttempt: null, lastSuccess: null, lastError: null,
  };

  constructor(
    private readonly store: LocalStore,
    private readonly apiFactory: () => Promise<CanvasApi | null>,
    private readonly notify: () => void = () => {},
  ) {}

  snapshot(): CanvasAutoSyncSummary {
    return { ...this.latest, running: this.pending !== null };
  }

  start(canSync: () => boolean): void {
    if (this.interval !== null) return;
    this.interval = setInterval(() => {
      if (canSync()) void this.sync().catch(() => {});
    }, SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
  }

  cancel(): void {
    this.generation++;
    this.pending = null;
    this.latest = { ...this.latest, connected: false, running: false,
      lastError: null };
    this.notify();
  }

  sync(): Promise<CanvasAutoSyncSummary> {
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.latest = { ...this.latest, running: true };
    const job = this.execute().then((result) => {
      if (generation === this.generation) this.latest = result;
      return this.latest;
    }).catch(() => {
      if (generation === this.generation) {
        this.latest = { ...this.latest, connected: false,
          lastAttempt: new Date().toISOString(),
          lastError: "Canvas 同步未完成，请检查网络或重新授权。" };
      }
      return this.latest;
    }).finally(() => {
      if (this.pending === job) this.pending = null;
      this.notify();
    });
    this.pending = job;
    return job;
  }

  async courseSettings(): Promise<CanvasCourseSetting[]> {
    const api = await this.apiFactory();
    if (!api) return [];
    const accountId = await api.getCurrentUserId();
    return this.store.listCanvasCourseSettings(api.origin, accountId);
  }

  async setCourseEnabled(courseId: number, enabled: boolean): Promise<void> {
    if (!Number.isSafeInteger(courseId) || courseId < 1 || typeof enabled !== "boolean") {
      throw new Error("Invalid Canvas course synchronization setting");
    }
    const api = await this.apiFactory();
    if (!api) throw new Error("Connect Canvas before changing its settings");
    const accountId = await api.getCurrentUserId();
    const courses = await api.listCourses();
    if (!courses.some((course) => course.id === courseId)) {
      throw new Error("This Canvas course is not currently accessible");
    }
    this.store.setCanvasCourseEnabled(api.origin, accountId, courseId, enabled);
  }

  private async execute(): Promise<CanvasAutoSyncSummary> {
    const generation = this.generation;
    this.store.purgeExpiredHiddenCanvasTasks();
    const now = new Date().toISOString();
    const summary: CanvasAutoSyncSummary = {
      connected: false, running: false, coursesChecked: 0,
      assignmentsSeen: 0, created: 0, changed: 0,
      preserved: 0, missing: 0, failedCourses: 0,
      lastAttempt: now, lastSuccess: this.latest.lastSuccess, lastError: null,
    };

    const api = await this.apiFactory();
    if (generation !== this.generation || !api) return summary;
    summary.connected = true;

    let accountId: number;
    try {
      [accountId] = await Promise.all([api.getCurrentUserId()]);
    } catch {
      summary.lastError = "Canvas 账号身份验证失败，请检查 Token 或网络。";
      return summary;
    }

    if (generation !== this.generation) return summary;
    const prior = this.store.canvasSyncState(api.origin, accountId);
    summary.lastSuccess = prior.lastSuccess;
    let courses;
    try {
      courses = await api.listCourses();
    } catch {
      summary.lastError = "Canvas 课程列表读取失败，旧的本地任务已保留。";
      this.store.updateCanvasSyncState(api.origin, accountId, false, summary.lastError);
      return summary;
    }
    if (generation !== this.generation) return summary;
    if (courses.length > MAX_COURSES_PER_RUN) {
      summary.lastError = "当前课程数量超过单次同步安全上限，请联系开发者处理。";
      this.store.updateCanvasSyncState(api.origin, accountId, false, summary.lastError);
      return summary;
    }

    const settings = new Map(this.store.listCanvasCourseSettings(api.origin, accountId)
      .map(({courseId, enabled}) => [courseId, enabled]));
    for (const course of courses) {
      if (generation !== this.generation) return summary;
      if (settings.get(course.id) === false) continue;
      try {
        const assignments = await api.listAssignments(course.id);
        if (generation !== this.generation) return summary;
        const report = this.store.reconcileCanvasCourse(api.origin, accountId, course.id, assignments);
        summary.coursesChecked++;
        summary.assignmentsSeen += assignments.length;
        summary.created += report.created;
        summary.changed += report.changed;
        summary.preserved += report.preserved;
        summary.missing += report.missing;
      } catch {
        // Other courses still sync. No remote error body or bearer token is logged.
        summary.failedCourses++;
      }
    }

    if (generation !== this.generation) return summary;
    if (summary.failedCourses) {
      summary.lastError = `有 ${summary.failedCourses} 门课程暂时未能同步，已有数据保留。`;
    } else {
      summary.lastSuccess = new Date().toISOString();
    }
    this.store.updateCanvasSyncState(api.origin, accountId,
      summary.failedCourses === 0, summary.lastError);
    return summary;
  }
}
