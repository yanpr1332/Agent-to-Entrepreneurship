import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./local-store";
import type { CanvasAssignment } from "../shared/canvas-model";

const stores: LocalStore[] = [];
function memory(): LocalStore {
  const store = new LocalStore(":memory:");
  stores.push(store);
  return store;
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

const origin = "https://oc.sjtu.edu.cn";
const base: CanvasAssignment = {
  id: 202, courseId: 51, name: "Homework 1",
  dueAt: "2026-11-25T12:00:00.000Z",
  htmlUrl: "https://oc.sjtu.edu.cn/courses/51/assignments/202",
  pointsPossible: 100,
};

describe("Canvas assignment import into local task authority", () => {
  it("imports once and records a traceable external identity", () => {
    const db = memory();
    const first = db.importCanvasAssignment(origin, 12, base);
    const again = db.importCanvasAssignment(origin, 12, base);
    expect(first.created).toBe(true);
    expect(again).toEqual({ taskId: first.taskId, created: false, updatedFields: [] });
    expect(db.listTasks()).toHaveLength(1);
    expect(db.listTasks()[0].source).toMatchObject({
      provider: "canvas", instanceUrl: origin, accountId: 12, courseId: 51, assignmentId: 202,
    });
    expect(db.listImportedCanvasAssignmentIds(origin, 12, 51)).toEqual([202]);
  });

  it("keeps independent Canvas users on the same instance separate", () => {
    const db = memory();
    db.importCanvasAssignment(origin, 12, base);
    db.importCanvasAssignment(origin, 13, base);
    expect(db.listTasks()).toHaveLength(2);
    expect(db.listImportedCanvasAssignmentIds(origin, 12, 51)).toEqual([202]);
    expect(db.listImportedCanvasAssignmentIds(origin, 13, 51)).toEqual([202]);
  });

  it("refreshes remote-controlled fields but protects personal edits and completion", () => {
    const db = memory();
    const first = db.importCanvasAssignment(origin, 12, base);
    db.updateTask({ id: first.taskId, description: "自己的笔记", completed: true, priority: "high",
      dueDate: "2026-12-01" });
    const updated: CanvasAssignment = { ...base, name: "Homework 1 (revised)",
      dueAt: "2026-12-15T12:00:00.000Z" };
    const report = db.syncImportedCanvasAssignments(origin, 12, 51, [updated]);
    expect(report).toEqual({ imported: 1, changed: 1, missing: 0, preserved: 1 });
    expect(db.listTasks()[0]).toMatchObject({
      title: "Homework 1 (revised)", dueDate: "2026-12-01",
      completed: true, description: "自己的笔记", priority: "high",
    });
    // The latest snapshot, not the original one, is used when deciding edit ownership.
    const next = db.syncImportedCanvasAssignments(origin, 12, 51, [
      { ...updated, name: "Homework 1 (newer)", dueAt: "2026-12-20T12:00:00.000Z" },
    ]);
    expect(next.preserved).toBe(1);
    expect(db.listTasks()[0].title).toBe("Homework 1 (newer)");
    expect(db.listTasks()[0].dueDate).toBe("2026-12-01");
  });

  it("does not create new tasks on sync, or silently delete missing assignments", () => {
    const db = memory();
    db.importCanvasAssignment(origin, 12, base);
    const report = db.syncImportedCanvasAssignments(origin, 12, 51, []);
    expect(report.missing).toBe(1);
    expect(db.listTasks()).toHaveLength(1);
    const unknown: CanvasAssignment = { ...base, id: 999 };
    db.syncImportedCanvasAssignments(origin, 12, 51, [unknown]);
    expect(db.listTasks()).toHaveLength(1);
  });

  it("deleting a Canvas task unlinks provenance and permits deliberate reimport", () => {
    const db = memory();
    const first = db.importCanvasAssignment(origin, 12, base);
    expect(db.removeTask(first.taskId)).toBe(true);
    expect(db.listImportedCanvasAssignmentIds(origin, 12, 51)).toEqual([]);
    expect(db.importCanvasAssignment(origin, 12, base).created).toBe(true);
  });

  it("rejects unsafe user/account identities", () => {
    const db = memory();
    expect(() => db.importCanvasAssignment("http://insecure.example", 12, base)).toThrow();
    expect(() => db.importCanvasAssignment(origin, 0, base)).toThrow();
  });

  it("migrates an existing v1 database without discarding personal tasks", () => {
    const directory = mkdtempSync(join(tmpdir(), "ate-canvas-migration-"));
    const file = join(directory, "local.sqlite");
    try {
      const db = new DatabaseSync(file);
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          due_date TEXT, priority TEXT NOT NULL, completed INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE focus_sessions (
          id TEXT PRIMARY KEY, planned_minutes INTEGER NOT NULL,
          elapsed_seconds INTEGER NOT NULL, completed INTEGER NOT NULL,
          points INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL
        );
        INSERT INTO tasks VALUES (
          '6fe14e93-83cc-46d6-b425-61f5b94a1d90','原有任务','保留备注',
          '2026-11-25','high',1,'2026-11-09T00:00:00Z','2026-11-09T00:00:00Z'
        );
        PRAGMA user_version=1;
      `);
      db.close();
      const upgraded = new LocalStore(file);
      expect(upgraded.listTasks()).toHaveLength(1);
      expect(upgraded.listTasks()[0]).toMatchObject({
        title: "原有任务", completed: true, description: "保留备注", source: null,
      });
      expect(upgraded.importCanvasAssignment(origin, 12, base).created).toBe(true);
      upgraded.close();
      const opened = new LocalStore(file);
      expect(opened.listTasks()).toHaveLength(2);
      opened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
