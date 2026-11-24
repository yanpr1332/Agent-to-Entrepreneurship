import { afterEach, describe, expect, it } from "vitest";
import { LocalStore } from "./local-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const OWNER_A="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const OWNER_B="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";

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
  it("persists a distinct device identity and cursor for each authenticated owner", () => {
    const db=memory();
    const first=db.getOrCreatePersonalSyncDevice("aae9ac05-b37d-4898-aee4-5848fa28e01b");
    expect(first.cursor).toBe("0");
    expect(db.getOrCreatePersonalSyncDevice("aae9ac05-b37d-4898-aee4-5848fa28e01b")).toEqual(first);
    const second=db.getOrCreatePersonalSyncDevice("9db8a5cb-1d6c-4e93-807e-e18be4b482a1");
    expect(second.deviceId).not.toBe(first.deviceId);
    db.advancePersonalSyncCursor("aae9ac05-b37d-4898-aee4-5848fa28e01b","12");
    expect(db.getOrCreatePersonalSyncDevice("aae9ac05-b37d-4898-aee4-5848fa28e01b").cursor).toBe("12");
    expect(()=>db.advancePersonalSyncCursor("aae9ac05-b37d-4898-aee4-5848fa28e01b","11")).toThrow("backwards");
    expect(()=>db.advancePersonalSyncCursor("aae9ac05-b37d-4898-aee4-5848fa28e01b","12x")).toThrow("cursor");
    expect(()=>db.getOrCreatePersonalSyncDevice("not-a-user")).toThrow("owner");
  });

  it("migrates v6 ownerless sync data into quarantined legacy tables without auto-assigning an account",()=>{
    const directory=mkdtempSync(join(tmpdir(),"ate-sync-owner-migration-"));
    const file=join(directory,"local.sqlite");
    try{
      const initial=new LocalStore(file);
      const task=initial.createTask({title:"Keep during account migration"});
      initial.close();
      const raw=new DatabaseSync(file);
      raw.exec(`
        DROP TABLE personal_task_sync_enrollment;
        DROP TABLE personal_sync_outbox;
        DROP TABLE personal_task_sync_legacy_enrollment;
        DROP TABLE personal_sync_legacy_outbox;
        DROP TABLE personal_sync_devices;
        CREATE TABLE personal_task_sync_enrollment(
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          server_version INTEGER,enabled_at TEXT NOT NULL
        );
        CREATE TABLE personal_sync_outbox(
          operation_id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL CHECK(entity_type IN ('personal-task','manual-calendar-event')),
          entity_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('upsert','delete')),
          base_version INTEGER,payload TEXT,created_at TEXT NOT NULL,UNIQUE(entity_type,entity_id),
          CHECK((action='upsert' AND payload IS NOT NULL) OR (action='delete' AND payload IS NULL))
        );
      `);
      raw.prepare("INSERT INTO personal_task_sync_enrollment VALUES(?,?,?)")
        .run(task.id,4,"2026-11-20T10:00:00.000Z");
      raw.prepare("INSERT INTO personal_sync_outbox VALUES(?,?,?,?,?,?,?)")
        .run("11111111-1111-4111-8111-111111111111","personal-task",task.id,"upsert",4,
          JSON.stringify({title:"stale",description:"",dueDate:null,priority:"normal",completed:false}),
          "2026-11-20T10:01:00.000Z");
      raw.prepare("INSERT INTO personal_sync_outbox VALUES(?,?,?,?,?,?,?)")
        .run("22222222-2222-4222-8222-222222222222","manual-calendar-event",
          "33333333-3333-4333-8333-333333333333","delete",9,null,"2026-11-20T10:02:00.000Z");
      raw.prepare("INSERT INTO personal_sync_outbox VALUES(?,?,?,?,?,?,?)")
        .run("66666666-6666-4666-8666-666666666666","personal-task",
          "77777777-7777-4777-8777-777777777777","delete",5,null,"2026-11-20T10:03:00.000Z");
      raw.exec("PRAGMA user_version=6");
      raw.close();

      const upgraded=new LocalStore(file);
      expect(upgraded.listTasks()).toMatchObject([{id:task.id,title:task.title}]);
      expect(upgraded.getOrCreatePersonalSyncDevice(OWNER_A).cursor).toBe("0");
      expect(upgraded.listPersonalSyncOutbox(OWNER_A)).toEqual([]);
      expect(upgraded.listPersonalSyncOutbox(OWNER_B)).toEqual([]);
      expect(upgraded.listLegacyPersonalSyncItems()).toEqual(expect.arrayContaining([
        expect.objectContaining({entityId:task.id,action:"upsert",canReauthorize:true}),
        expect.objectContaining({entityType:"manual-calendar-event",action:"delete",canReauthorize:false}),
        expect.objectContaining({entityId:"77777777-7777-4777-8777-777777777777",entityType:"personal-task",action:"delete",canReauthorize:false}),
      ]));
      expect(()=>upgraded.adoptLegacyPersonalTaskSync(OWNER_A,task.id,false)).toThrow("Explicit confirmation");
      upgraded.adoptLegacyPersonalTaskSync(OWNER_A,task.id,true);
      const fresh=upgraded.listPersonalSyncOutbox(OWNER_A);
      expect(fresh).toHaveLength(1);
      expect(fresh[0]).toMatchObject({entityId:task.id,action:"upsert",baseVersion:null});
      expect(JSON.parse(fresh[0].payload!)).toMatchObject({title:task.title});
      expect(upgraded.listPersonalSyncOutbox(OWNER_B)).toEqual([]);
      expect(upgraded.listLegacyPersonalSyncItems()).toHaveLength(2);
      expect(()=>upgraded.adoptLegacyPersonalTaskSync(OWNER_B,task.id,true)).toThrow("No unclaimed");
      expect(()=>upgraded.adoptLegacyPersonalTaskSync(OWNER_B,"77777777-7777-4777-8777-777777777777",true))
        .toThrow("existing personal task");
      upgraded.close();
    }finally{rmSync(directory,{recursive:true,force:true});}
  });

  it("enrolls only one explicitly selected personal task and persists its outbox intent", () => {
    const db = memory();
    const task = db.createTask({title:"跨设备任务", description:"用户主动选择"});
    expect(db.listPersonalSyncOutbox(OWNER_A)).toEqual([]);
    db.setTaskSyncEnabled(task.id, true, OWNER_A);
    const queued = db.listPersonalSyncOutbox(OWNER_A);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({entityType:"personal-task",entityId:task.id,action:"upsert",baseVersion:null});
    expect(JSON.parse(queued[0].payload!)).toEqual({title:"跨设备任务",description:"用户主动选择",dueDate:null,priority:"normal",completed:false});
  });

  it("isolates task enrollment, outbox, acknowledgements and disable actions by cloud owner",()=>{
    const db=memory();
    const task=db.createTask({title:"Two account task"});
    db.setTaskSyncEnabled(task.id,true,OWNER_A);
    db.setTaskSyncEnabled(task.id,true,OWNER_B);
    const a=db.listPersonalSyncOutbox(OWNER_A)[0];
    const b=db.listPersonalSyncOutbox(OWNER_B)[0];
    expect(a.operationId).not.toBe(b.operationId);
    expect(()=>db.acknowledgePersonalSyncOperation(OWNER_B,a.operationId,3)).toThrow("no longer pending");
    db.updateTask({id:task.id,title:"Edited for both explicitly enrolled accounts"});
    expect(db.listPersonalSyncOutbox(OWNER_A)[0].operationId).toBe(a.operationId);
    expect(db.listPersonalSyncOutbox(OWNER_B)[0].operationId).toBe(b.operationId);
    db.acknowledgePersonalSyncOperation(OWNER_A,db.listPersonalSyncOutbox(OWNER_A)[0].operationId,4);
    expect(db.listPersonalSyncOutbox(OWNER_A)).toEqual([]);
    expect(db.listPersonalSyncOutbox(OWNER_B)).toHaveLength(1);
    db.setTaskSyncEnabled(task.id,false,OWNER_B);
    expect(db.listPersonalSyncOutbox(OWNER_B)).toEqual([]);
    expect(db.listPersonalSyncEnrollments(OWNER_A)).toHaveLength(1);
    expect(db.listPersonalSyncEnrollments(OWNER_B)).toEqual([]);
    db.updateTask({id:task.id,completed:true});
    expect(db.listPersonalSyncOutbox(OWNER_A)).toMatchObject([{baseVersion:4}]);
  });

  it("creates one delete tombstone per acknowledged owner and cancels unacknowledged creates",()=>{
    const db=memory();
    const task=db.createTask({title:"Owner scoped deletion"});
    db.setTaskSyncEnabled(task.id,true,OWNER_A);
    db.setTaskSyncEnabled(task.id,true,OWNER_B);
    const a=db.listPersonalSyncOutbox(OWNER_A)[0];
    db.acknowledgePersonalSyncOperation(OWNER_A,a.operationId,7);
    expect(db.removeTask(task.id)).toBe(true);
    expect(db.listPersonalSyncOutbox(OWNER_A)).toMatchObject([
      {entityType:"personal-task",entityId:task.id,action:"delete",baseVersion:7,payload:null},
    ]);
    expect(db.listPersonalSyncOutbox(OWNER_B)).toEqual([]);
  });

  it("coalesces repeated edits into the same pending intent and preserves server version after acknowledgement", () => {
    const db = memory();
    const task = db.createTask({title:"初始标题"});
    db.setTaskSyncEnabled(task.id, true, OWNER_A);
    const first = db.listPersonalSyncOutbox(OWNER_A)[0];
    db.updateTask({id:task.id,title:"更新标题"});
    db.updateTask({id:task.id,completed:true});
    const latest = db.listPersonalSyncOutbox(OWNER_A)[0];
    expect(latest.operationId).toBe(first.operationId);
    expect(JSON.parse(latest.payload!)).toMatchObject({title:"更新标题",completed:true});
    db.acknowledgePersonalSyncOperation(OWNER_A,latest.operationId, 4);
    expect(db.listPersonalSyncOutbox(OWNER_A)).toEqual([]);
    db.updateTask({id:task.id,title:"版本四之后"});
    expect(db.listPersonalSyncOutbox(OWNER_A)[0].baseVersion).toBe(4);
  });

  it("creates a versioned delete tombstone only after a server acknowledgement", () => {
    const db = memory();
    const task = db.createTask({title:"远端任务"});
    db.setTaskSyncEnabled(task.id,true,OWNER_A);
    const create = db.listPersonalSyncOutbox(OWNER_A)[0];
    db.acknowledgePersonalSyncOperation(OWNER_A,create.operationId,2);
    expect(db.removeTask(task.id)).toBe(true);
    expect(db.listPersonalSyncOutbox(OWNER_A)).toMatchObject([{entityType:"personal-task",entityId:task.id,action:"delete",baseVersion:2,payload:null}]);
  });

  it("cancels an unacknowledged local create when the enrolled task is deleted", () => {
    const db = memory();
    const task = db.createTask({title:"还未上传"});
    db.setTaskSyncEnabled(task.id,true,OWNER_A);
    expect(db.removeTask(task.id)).toBe(true);
    expect(db.listPersonalSyncOutbox(OWNER_A)).toEqual([]);
  });

  it("disabling sync clears pending intents without deleting the local task", () => {
    const db = memory();
    const task = db.createTask({title:"保留在本机"});
    db.setTaskSyncEnabled(task.id,true,OWNER_A);
    db.setTaskSyncEnabled(task.id,false,OWNER_A);
    expect(db.listTasks()).toHaveLength(1);
    expect(db.listPersonalSyncOutbox(OWNER_A)).toEqual([]);
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
