import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeStore } from "./knowledge-store";
import { LocalStore } from "./local-store";
import { createLocalBackup, backupBeforeMigration } from "./local-backup";

const directories:string[]=[];
const fixture=()=>{const dir=mkdtempSync(join(tmpdir(),"ate-backup-"));directories.push(dir);return dir;};
afterEach(()=>{for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});

describe("verified online SQLite snapshots",()=>{
  it("backs up WAL-backed tasks and knowledge into userData/backups with integrity checks",async()=>{
    const dir=fixture();
    const tasks=new LocalStore(join(dir,"ate-local.sqlite"));
    const kb=new KnowledgeStore(join(dir,"ate-knowledge.sqlite"));
    tasks.createTask({title:"Must survive"});
    kb.importText({sourcePath:"/tmp/study.md",title:"study.md",
      format:"markdown",text:"Never discard original evidence"});
    const result=await createLocalBackup(dir,[
      {name:"tasks",store:tasks},{name:"knowledge",store:kb},
    ]);
    expect(result.encryption).toBe("none");
    expect(result.databases).toEqual(["tasks.sqlite","knowledge.sqlite"]);
    const taskCopy=new DatabaseSync(join(result.folder,"tasks.sqlite"),{readOnly:true});
    expect((taskCopy.prepare("SELECT title FROM tasks").get() as {title:string}).title)
      .toBe("Must survive");
    taskCopy.close();
    const kbCopy=new DatabaseSync(join(result.folder,"knowledge.sqlite"),{readOnly:true});
    expect((kbCopy.prepare("SELECT title FROM knowledge_documents").get() as {title:string}).title)
      .toBe("study.md");
    kbCopy.close();
    tasks.close();kb.close();
  });

  it("snapshots v3 before opening/upgrading v4 local database",async()=>{
    const dir=fixture(),path=join(dir,"ate-local.sqlite");
    const db=new LocalStore(path);
    db.createTask({title:"Original before schema upgrade"});
    db.close();
    const older=new DatabaseSync(path);
    older.exec("DROP TABLE mail_candidate_reviews; PRAGMA user_version=3");
    older.close();
    const snapshot=await backupBeforeMigration(dir,"ate-local.sqlite",4);
    expect(snapshot).toBeTruthy();
    const pre=new DatabaseSync(join(snapshot!,"ate-local.sqlite"),{readOnly:true});
    expect((pre.prepare("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(3);
    expect((pre.prepare("SELECT COUNT(*) AS count FROM tasks").get() as {count:number}).count).toBe(1);
    pre.close();
    const migrated=new LocalStore(path);
    expect(migrated.listTasks()).toHaveLength(1);
    migrated.close();
    expect(await backupBeforeMigration(dir,"ate-local.sqlite",4)).toBeNull();
  });

  it("does not replace originals or silently overwrite existing backups",async()=>{
    const dir=fixture(),db=new LocalStore(join(dir,"ate-local.sqlite"));
    const a=await createLocalBackup(dir,[{name:"tasks",store:db}]);
    const b=await createLocalBackup(dir,[{name:"tasks",store:db}]);
    expect(a.folder).not.toBe(b.folder);
    expect(existsSync(a.folder)&&existsSync(b.folder)).toBe(true);
    expect(readdirSync(join(dir,"backups")).length).toBe(2);
    db.close();
    await expect(backupBeforeMigration(dir,"unapproved.sqlite",2)).rejects.toThrow("Unapproved");
  });
});
