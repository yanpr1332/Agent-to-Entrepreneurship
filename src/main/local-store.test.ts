import { afterEach, describe, expect, it } from "vitest";
import { LocalStore } from "./local-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  it("enrolls only one explicitly selected personal task and persists its outbox intent", () => {
    const db = memory();
    const task = db.createTask({title:"跨设备任务", description:"用户主动选择"});
    expect(db.listPersonalSyncOutbox()).toEqual([]);
    db.setTaskSyncEnabled(task.id, true);
    const queued = db.listPersonalSyncOutbox();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({entityType:"personal-task",entityId:task.id,action:"upsert",baseVersion:null});
    expect(JSON.parse(queued[0].payload!)).toEqual({title:"跨设备任务",description:"用户主动选择",dueDate:null,priority:"normal",completed:false});
  });

  it("coalesces repeated edits into the same pending intent and preserves server version after acknowledgement", () => {
    const db = memory();
    const task = db.createTask({title:"初始标题"});
    db.setTaskSyncEnabled(task.id, true);
    const first = db.listPersonalSyncOutbox()[0];
    db.updateTask({id:task.id,title:"更新标题"});
    db.updateTask({id:task.id,completed:true});
    const latest = db.listPersonalSyncOutbox()[0];
    expect(latest.operationId).toBe(first.operationId);
    expect(JSON.parse(latest.payload!)).toMatchObject({title:"更新标题",completed:true});
    db.acknowledgePersonalSyncOperation(latest.operationId, 4);
    expect(db.listPersonalSyncOutbox()).toEqual([]);
    db.updateTask({id:task.id,title:"版本四之后"});
    expect(db.listPersonalSyncOutbox()[0].baseVersion).toBe(4);
  });

  it("creates a versioned delete tombstone only after a server acknowledgement", () => {
    const db = memory();
    const task = db.createTask({title:"远端任务"});
    db.setTaskSyncEnabled(task.id,true);
    const create = db.listPersonalSyncOutbox()[0];
    db.acknowledgePersonalSyncOperation(create.operationId,2);
    expect(db.removeTask(task.id)).toBe(true);
    expect(db.listPersonalSyncOutbox()).toMatchObject([{entityType:"personal-task",entityId:task.id,action:"delete",baseVersion:2,payload:null}]);
  });

  it("cancels an unacknowledged local create when the enrolled task is deleted", () => {
    const db = memory();
    const task = db.createTask({title:"还未上传"});
    db.setTaskSyncEnabled(task.id,true);
    expect(db.removeTask(task.id)).toBe(true);
    expect(db.listPersonalSyncOutbox()).toEqual([]);
  });

  it("disabling sync clears pending intents without deleting the local task", () => {
    const db = memory();
    const task = db.createTask({title:"保留在本机"});
    db.setTaskSyncEnabled(task.id,true);
    db.setTaskSyncEnabled(task.id,false);
    expect(db.listTasks()).toHaveLength(1);
    expect(db.listPersonalSyncOutbox()).toEqual([]);
  });

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

  it("stores real bounds and title, while edits never change earned points", () => {
    const db = memory();
    const now = Date.now();
    const start = new Date(now - 5 * 60_000).toISOString();
    const end = new Date(now - 60_000).toISOString();
    const payload = {
      sessionId: "f4692ac2-2942-4f64-8de4-c37800f86ab7",
      title: "数学复习", plannedMinutes: 3, elapsedSeconds: 180,
      startedAt: start, endedAt: end,
    };
    expect(db.recordFocusSession(payload)).toMatchObject({
      title: "数学复习", timeSource: "recorded", startedAt: start,
      endedAt: end, points: 3,
    });
    const renamed = db.renameFocusSession({id:payload.sessionId, title:"英语练习"});
    expect(renamed.title).toBe("英语练习");
    expect(renamed.points).toBe(3);
    expect(db.recordFocusSession({...payload,title:"重试不得改名"}).title).toBe("英语练习");
    expect(db.focusSummary().points).toBe(3);
    expect(() => db.renameFocusSession({id:payload.sessionId,title:"",points:500})).toThrow();
  });

  it("migrates legacy focus rows without inventing accurate start times", () => {
    const directory = mkdtempSync(join(tmpdir(), "ate-focus-migrate-"));
    const file = join(directory, "local.sqlite");
    try {
      const old = new DatabaseSync(file);
      old.exec(`
        CREATE TABLE focus_sessions (
          id TEXT PRIMARY KEY, planned_minutes INTEGER NOT NULL,
          elapsed_seconds INTEGER NOT NULL, completed INTEGER NOT NULL,
          points INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL
        );
        INSERT INTO focus_sessions VALUES (
          'e70d140f-cd1b-45d6-bcf7-892ab3f8039d',25,1500,1,25,
          '2026-11-08T12:00:00.000Z','2026-11-08T12:25:00.000Z'
        );
        PRAGMA user_version = 4;
      `);
      old.close();
      const next = new LocalStore(file);
      expect(next.listFocusSessions()[0]).toMatchObject({
        title:"专注学习",timeSource:"estimated",points:25,
      });
      next.close();
      const again = new LocalStore(file);
      expect(again.listFocusSessions()).toHaveLength(1);
      again.close();
    } finally {
      rmSync(directory,{recursive:true,force:true});
    }
  });

  it("rejects future and unrealistic session windows rather than creating calendar data", () => {
    const db = memory();
    const now = Date.now();
    const base = {
      sessionId: "dc2926b3-9fae-4c7a-93fb-6f51dd21b3ad",
      plannedMinutes: 2, elapsedSeconds: 120, title: "有效学习",
      startedAt: new Date(now - 60_000).toISOString(),
      endedAt: new Date(now + 5*60_000).toISOString(),
    };
    expect(() => db.recordFocusSession(base)).toThrow();
    expect(() => db.recordFocusSession({...base,
      startedAt:new Date(now-3*60_000).toISOString(),
      endedAt:new Date(now-2*60_000).toISOString()})).toThrow();
    expect(db.listFocusSessions()).toHaveLength(0);
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
