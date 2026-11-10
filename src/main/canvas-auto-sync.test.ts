import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "./local-store";
import { CanvasSyncService } from "./connectors/canvas-sync";
import type { CanvasAssignment, CanvasCourse } from "../shared/canvas-model";
import type { CanvasApi } from "./connectors/canvas-api";

const origin = "https://oc.sjtu.edu.cn";
const assignment: CanvasAssignment = {
  id: 90, courseId: 4, name: "Report",
  dueAt: "2026-11-25T12:00:00.000Z", htmlUrl: null, pointsPossible: 100,
};
const stores: LocalStore[] = [];
const memory = (): LocalStore => {
  const store = new LocalStore(":memory:");
  stores.push(store);
  return store;
};
afterEach(() => { while (stores.length) stores.pop()!.close(); });

function client(
  courses: CanvasCourse[] = [{id:4,name:"Calculus",courseCode:"MATH"}],
  getAssignments: (id:number)=>Promise<CanvasAssignment[]> = async () => [assignment],
): CanvasApi {
  return {
    origin,
    getCurrentUserId: async () => 12,
    listCourses: async () => courses,
    listAssignments: getAssignments,
  } as unknown as CanvasApi;
}

describe("automatic Canvas import and six-month hidden records", () => {
  it("auto-imports all accessible courses and remains idempotent", async () => {
    const db = memory();
    const remote = client([{id:4,name:"Math",courseCode:"M"}, {id:5,name:"Physics",courseCode:"P"}],
      async (id) => [{...assignment,courseId:id}]);
    const engine = new CanvasSyncService(db, async () => remote);
    const first = await engine.sync();
    expect(first).toMatchObject({connected:true,coursesChecked:2,created:2,failedCourses:0});
    expect(db.listTasks()).toHaveLength(2);
    const second = await engine.sync();
    expect(second.created).toBe(0);
    expect(db.listTasks()).toHaveLength(2);
  });

  it("course exclusions stop future automatic imports but preserve existing work", async () => {
    const db = memory();
    db.setCanvasCourseEnabled(origin,12,4,false);
    const engine = new CanvasSyncService(db,async()=>client());
    expect((await engine.sync()).created).toBe(0);
    expect(db.listTasks()).toHaveLength(0);
    db.setCanvasCourseEnabled(origin,12,4,true);
    expect((await engine.sync()).created).toBe(1);
    db.setCanvasCourseEnabled(origin,12,4,false);
    await engine.sync();
    expect(db.listTasks()).toHaveLength(1);
  });

  it("hidden entries are retained and never re-added or overwritten by sync", async () => {
    const db = memory();
    let remoteName = "Report";
    const engine = new CanvasSyncService(db,async()=>client(undefined,
      async()=>[{...assignment,name:remoteName}]));
    await engine.sync();
    const task = db.listTasks()[0];
    const hiddenAt = new Date("2026-11-10T10:00:00.000Z");
    db.setCanvasTaskVisibility(task.id,false,hiddenAt);
    remoteName = "Report revised";
    const synced = await engine.sync();
    expect(synced.created).toBe(0);
    expect(db.listTasks()).toHaveLength(1);
    expect(db.listTasks()[0]).toMatchObject({
      id:task.id,title:"Report",visible:false,hiddenAt:hiddenAt.toISOString(),
      retentionExpiresAt:"2027-05-10T10:00:00.000Z",
    });
    db.setCanvasTaskVisibility(task.id,true);
    await engine.sync();
    expect(db.listTasks()[0]).toMatchObject({
      id:task.id,visible:true,hiddenAt:null,retentionExpiresAt:null,title:"Report revised",
    });
  });

  it("manually edited fields stay owned by the user even if values happen to match remote", () => {
    const db = memory();
    const task = db.importCanvasAssignment(origin,12,assignment);
    db.updateTask({id:task.taskId,title:"Report",dueDate:db.listTasks()[0].dueDate});
    const changed = {...assignment,name:"Report rewritten",dueAt:"2026-12-15T12:00:00.000Z"};
    const result = db.syncImportedCanvasAssignments(origin,12,4,[changed]);
    expect(result.preserved).toBe(1);
    expect(db.listTasks()[0]).toMatchObject({title:"Report",dueDate:"2026-11-25"});
  });

  it("purges only hidden records after six calendar months, preserving visible tasks", () => {
    const db = memory();
    const first = db.importCanvasAssignment(origin,12,assignment);
    db.importCanvasAssignment(origin,13,assignment);
    db.setCanvasTaskVisibility(first.taskId,false,new Date("2026-08-31T12:00:00.000Z"));
    expect(db.listTasks().find(t=>t.id===first.taskId)?.retentionExpiresAt)
      .toBe("2027-02-28T12:00:00.000Z");
    expect(db.purgeExpiredHiddenCanvasTasks(new Date("2027-02-27T12:00:00Z"))).toBe(0);
    expect(db.purgeExpiredHiddenCanvasTasks(new Date("2027-03-01T12:00:00Z"))).toBe(1);
    expect(db.listTasks()).toHaveLength(1);
    expect(db.importCanvasAssignment(origin,12,assignment).created).toBe(true);
  });

  it("rejects visibility changes for normal personal tasks", () => {
    const db = memory();
    const normal = db.createTask({title:"Standalone"});
    expect(()=>db.setCanvasTaskVisibility(normal.id,false)).toThrow("Only Canvas");
  });

  it("isolates failures to individual courses and keeps previously imported data", async () => {
    const db = memory();
    const engine = new CanvasSyncService(db,async()=>client([
      {id:4,name:"Math",courseCode:"M"},{id:5,name:"Biology",courseCode:"B"},
    ],async id => {
      if (id===5) throw new Error("simulated remote failure");
      return [assignment];
    }));
    const result = await engine.sync();
    expect(result).toMatchObject({created:1,failedCourses:1,coursesChecked:1});
    expect(db.listTasks()).toHaveLength(1);
    expect(result.lastError).not.toContain("simulated");
  });

  it("cancels pending sync before it can write after disconnect", async () => {
    const db = memory();
    let release: ((value:CanvasAssignment[])=>void)|undefined;
    const delayed = new Promise<CanvasAssignment[]>((resolve)=>{release=resolve;});
    const engine = new CanvasSyncService(db,async()=>client(undefined,async()=>delayed));
    const pending = engine.sync();
    // Flush async identity/course continuations before reaching the course fetch.
    for (let n=0;n<8;n++) await Promise.resolve();
    engine.cancel();
    release?.([assignment]);
    await pending;
    expect(db.listTasks()).toHaveLength(0);
    expect(engine.snapshot().connected).toBe(false);
  });
});

describe("SQLite schema v2 to v3 upgrade", () => {
  it("preserves task rows and provenance while adding visibility columns", () => {
    const dir = mkdtempSync(join(tmpdir(),"ate-v3-"));
    const file = join(dir,"store.sqlite");
    try {
      const raw = new DatabaseSync(file);
      raw.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,
          due_date TEXT,priority TEXT NOT NULL,completed INTEGER NOT NULL,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL
        );
        CREATE TABLE canvas_assignment_links (
          instance_origin TEXT NOT NULL,account_id INTEGER NOT NULL,
          course_id INTEGER NOT NULL,assignment_id INTEGER NOT NULL,
          task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          remote_title TEXT NOT NULL,remote_due_date TEXT,source_url TEXT,
          last_synced_at TEXT NOT NULL,missing INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(instance_origin,account_id,course_id,assignment_id)
        );
        CREATE INDEX idx_canvas_assignment_links_task ON canvas_assignment_links(task_id);
        CREATE TABLE focus_sessions(id TEXT PRIMARY KEY,planned_minutes INTEGER NOT NULL,
          elapsed_seconds INTEGER NOT NULL,completed INTEGER NOT NULL,points INTEGER NOT NULL,
          started_at TEXT NOT NULL,ended_at TEXT NOT NULL);
        INSERT INTO tasks VALUES('a','Original','personal note','2026-11-25','high',1,'old','old');
        INSERT INTO canvas_assignment_links VALUES(
          'https://oc.sjtu.edu.cn',12,4,90,'a','Original','2026-11-25',NULL,'old',0);
        PRAGMA user_version=2;
      `);
      raw.close();
      const upgraded = new LocalStore(file);
      expect(upgraded.listTasks()[0]).toMatchObject({
        id:"a",title:"Original",description:"personal note",completed:true,visible:true,
      });
      upgraded.close();
      const reopened = new LocalStore(file);
      expect(reopened.listTasks()[0].source?.assignmentId).toBe(90);
      reopened.close();
    } finally {
      rmSync(dir,{recursive:true,force:true});
    }
  });
});
