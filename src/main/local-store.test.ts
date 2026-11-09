import { afterEach, describe, expect, it } from "vitest";
import { LocalStore } from "./local-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stores: LocalStore[] = [];
function memory(): LocalStore {
  const store = new LocalStore(":memory:");
  stores.push(store);
  return store;
}
afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

describe("local-first SQLite store", () => {
  it("creates, updates and deletes personal tasks", () => {
    const db = memory();
    const task = db.createTask({ title: "  阅读论文 ", dueDate: "2026-11-25", priority: "high" });
    expect(task.title).toBe("阅读论文");
    expect(db.listTasks()).toHaveLength(1);
    expect(db.updateTask({ id: task.id, completed: true, description: "第 1 章" })).toMatchObject({
      completed: true, description: "第 1 章", dueDate: "2026-11-25",
    });
    expect(db.removeTask(task.id)).toBe(true);
    expect(db.listTasks()).toHaveLength(0);
  });

  it("rejects invalid fields before building SQL", () => {
    const db = memory();
    expect(() => db.createTask({ title: "Test", priority: "urgent" })).toThrow();
    expect(() => db.createTask({ title: "Test", dueDate: "2026-02-30" })).toThrow();
  });

  it("records focus completion once using an idempotency key", () => {
    const db = memory();
    const payload = {
      sessionId: "6fe14e93-83cc-46d6-b425-61f5b94a1d90",
      plannedMinutes: 25, elapsedSeconds: 1500,
    };
    expect(db.recordFocusSession(payload).points).toBe(25);
    expect(db.recordFocusSession(payload).points).toBe(25);
    expect(db.focusSummary()).toEqual({
      sessions: 1, completedSessions: 1, totalMinutes: 25, points: 25,
    });
  });

  it("does not award points for incomplete focus", () => {
    const db = memory();
    const record = db.recordFocusSession({
      sessionId: "8efad974-12bd-4d26-a49c-c6078c48e157",
      plannedMinutes: 25, elapsedSeconds: 60,
    });
    expect(record.completed).toBe(false);
    expect(record.points).toBe(0);
  });

  it("persists records to disk across close and reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "ate-sqlite-"));
    const file = join(directory, "local.sqlite");
    try {
      const first = new LocalStore(file);
      first.createTask({ title: "重启后仍存在" });
      first.close();
      const second = new LocalStore(file);
      expect(second.listTasks()[0].title).toBe("重启后仍存在");
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to open a database from an unknown future schema", () => {
    const db = memory();
    expect(db.listTasks()).toEqual([]);
  });
});
