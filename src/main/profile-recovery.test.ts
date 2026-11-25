import {afterEach,describe,expect,it} from "vitest";
import {
  copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,
  symlinkSync,writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {LocalStore} from "./local-store";
import {KnowledgeStore} from "./knowledge-store";
import {createLocalBackup} from "./local-backup";
import {inspectRecoveryFolder,recoverToNewProfile,sha256File} from "./profile-recovery";
import {parseRecoveryConfirmation} from "../shared/recovery-model";

const roots:string[]=[];
function root(){const dir=mkdtempSync(join(tmpdir(),"study-alpha-recovery-"));roots.push(dir);return dir;}
afterEach(()=>{for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true});});
async function snapshot(){
  const dir=root(),live=join(dir,"current"),archive=join(dir,"separate");
  mkdirSync(live);mkdirSync(archive);
  const tasks=new LocalStore(join(live,"study-anchor-tasks.sqlite"));
  const knowledge=new KnowledgeStore(join(live,"study-anchor-knowledge.sqlite"));
  tasks.createTask({title:"Never erase this personal task"});
  knowledge.importText({sourcePath:"/tmp/safe.md",title:"safe.md",format:"markdown",
    text:"Local evidence should survive verified recovery."});
  const saved=await createLocalBackup(live,[
    {name:"tasks",store:tasks},{name:"knowledge",store:knowledge},
  ]);
  tasks.close();knowledge.close();
  return {dir,live,archive,saved};
}
describe("ALPHA-CLOSE-03 strict manifest and offline isolated profile recovery",()=>{
  it("produces v2 manifest with per-DB SHA-256, SQLite schema and independent restore",async()=>{
    const {dir,live,saved}=await snapshot();
    const manifest=JSON.parse(readFileSync(join(saved.folder,"manifest.json"),"utf8"));
    expect(manifest).toMatchObject({schema:2,encryption:"none",
      databases:["tasks.sqlite","knowledge.sqlite"]});
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files[0].sha256).toBe(await sha256File(join(saved.folder,"tasks.sqlite")));
    expect(manifest.files[0]).toHaveProperty("userVersion");
    const inspected=await inspectRecoveryFolder(saved.folder);
    expect(inspected.legacyManifest).toBe(false);
    expect(inspected.databases.map(r=>r.sha256Verified)).toEqual([true,true]);
    expect(inspected.missing).toEqual(["mail","planning","calendar"]);
    const dst=join(dir,"a-new-isolated-test-profile");
    const recovered=await recoverToNewProfile({
      folder:saved.folder,destination:dst,activeUserData:live,
      expectedFingerprint:inspected.fingerprint,
    });
    expect(recovered).toEqual({directory:dst,databases:["tasks","knowledge"],isolated:true});
    expect(existsSync(join(dst,"study-anchor-recovery.json"))).toBe(true);
    expect(existsSync(join(dst,"study-anchor-ai.enc"))).toBe(false);
    expect(existsSync(join(dst,"study-anchor-team-history.sqlite"))).toBe(false);
    const t=new DatabaseSync(join(dst,"study-anchor-tasks.sqlite"),{readOnly:true});
    expect((t.prepare("SELECT title FROM tasks").get() as {title:string}).title)
      .toBe("Never erase this personal task");
    t.close();
    const k=new DatabaseSync(join(dst,"study-anchor-knowledge.sqlite"),{readOnly:true});
    expect((k.prepare("SELECT title FROM knowledge_documents").get() as {title:string}).title)
      .toBe("safe.md");
    k.close();
    const original=new DatabaseSync(join(live,"study-anchor-tasks.sqlite"),{readOnly:true});
    expect((original.prepare("SELECT COUNT(*) AS n FROM tasks").get() as {n:number}).n).toBe(1);
    original.close();
    await expect(recoverToNewProfile({folder:saved.folder,destination:dst,
      activeUserData:live,expectedFingerprint:inspected.fingerprint}))
      .rejects.toThrow("nonexistent");
  });
  it("refuses a tampered snapshot even if its SQLite database is structurally valid",async()=>{
    const {dir,live,saved}=await snapshot();
    const inspected=await inspectRecoveryFolder(saved.folder);
    const db=new DatabaseSync(join(saved.folder,"tasks.sqlite"));
    db.prepare("UPDATE tasks SET title=?").run("Changed after user approved");
    db.close();
    expect(existsSync(join(dir,"candidate"))).toBe(false);
    await expect(inspectRecoveryFolder(saved.folder)).rejects.toThrow("checksum mismatch");
    await expect(recoverToNewProfile({folder:saved.folder,
      destination:join(dir,"candidate"),activeUserData:live,
      expectedFingerprint:inspected.fingerprint})).rejects.toThrow("checksum mismatch");
    expect(existsSync(join(dir,"candidate"))).toBe(false);
  });
  it("fails closed on unknown or duplicate database names, future schema and manifest edits",async()=>{
    const {dir,live,saved}=await snapshot();
    const path=join(saved.folder,"manifest.json");
    const original=readFileSync(path,"utf8"),v2=JSON.parse(original);
    const bad=[
      {...v2,schema:99},
      {...v2,databases:["../secret.sqlite","knowledge.sqlite"]},
      {...v2,databases:["tasks.sqlite","tasks.sqlite"]},
      {...v2,files:[v2.files[1],v2.files[0]]},
      {...v2,encryption:"aes-unknown"},
    ];
    for(const value of bad){
      writeFileSync(path,JSON.stringify(value));
      await expect(inspectRecoveryFolder(saved.folder)).rejects.toThrow();
    }
    writeFileSync(path,original);
    const db=new DatabaseSync(join(saved.folder,"tasks.sqlite"));
    db.exec("PRAGMA user_version=10000");db.close();
    await expect(inspectRecoveryFolder(saved.folder)).rejects.toThrow("checksum mismatch");
    const dst=join(dir,"new-profile");
    expect(existsSync(dst)).toBe(false);
    expect(existsSync(join(live,"study-anchor-tasks.sqlite"))).toBe(true);
  });
  it("rejects symlinks, target overwrite and restoration inside current userData",async()=>{
    const {dir,live,saved}=await snapshot();
    const inspected=await inspectRecoveryFolder(saved.folder);
    await expect(recoverToNewProfile({folder:saved.folder,destination:join(live,"different"),
      activeUserData:live,expectedFingerprint:inspected.fingerprint})).rejects.toThrow("nonexistent");
    await expect(recoverToNewProfile({folder:saved.folder,destination:live,
      activeUserData:live,expectedFingerprint:inspected.fingerprint})).rejects.toThrow("nonexistent");
    const liveAlias=join(dir,"live-alias");symlinkSync(live,liveAlias,"dir");
    await expect(recoverToNewProfile({folder:saved.folder,
      destination:join(liveAlias,"sneaky"),activeUserData:live,
      expectedFingerprint:inspected.fingerprint})).rejects.toThrow("nonexistent");
    const linked=join(dir,"linked");symlinkSync(saved.folder,linked,"dir");
    await expect(inspectRecoveryFolder(linked)).rejects.toThrow("symlink");
    const linkFile=join(saved.folder,"tasks.sqlite");
    const moved=join(saved.folder,"tasks-original.sqlite");
    const {renameSync}=await import("node:fs");
    renameSync(linkFile,moved);symlinkSync(moved,linkFile,"file");
    await expect(inspectRecoveryFolder(saved.folder)).rejects.toThrow("ordinary");
  });
  it("supports older manifest v1 and pre-migration snapshot without fake hash guarantees",async()=>{
    const {dir,live,saved}=await snapshot();
    const single=join(dir,"v1");mkdirSync(single);
    const filename="ate-local.sqlite";
    copyFileSync(join(saved.folder,"tasks.sqlite"),join(single,filename));
    writeFileSync(join(single,"manifest.json"),JSON.stringify({
      schema:1,source:filename,createdAt:"2026-11-25T00:00:00.000Z",
      previousVersion:11,targetVersion:12,encryption:"none",
    }));
    const inspected=await inspectRecoveryFolder(single);
    expect(inspected.legacyManifest).toBe(true);
    expect(inspected.databases[0]).toMatchObject({name:"tasks",sha256Verified:false});
    expect(inspected.missing).toContain("knowledge");
    const dest=join(dir,"v1-recovered");
    await recoverToNewProfile({folder:single,destination:dest,activeUserData:live,
      expectedFingerprint:inspected.fingerprint});
    expect(existsSync(join(dest,"study-anchor-tasks.sqlite"))).toBe(true);
    expect(existsSync(join(dest,filename))).toBe(false);
  });
  it("requires a one-time strictly shaped confirmation token, no paths from Renderer",()=>{
    const uuid="98e832b6-0643-481d-bd87-9da9014d32bc";
    expect(parseRecoveryConfirmation({reviewId:uuid,confirmation:"RESTORE_TO_NEW_PROFILE"}))
      .toEqual({reviewId:uuid,confirmation:"RESTORE_TO_NEW_PROFILE"});
    for(const v of [
      {reviewId:"unsafe",confirmation:"RESTORE_TO_NEW_PROFILE"},
      {reviewId:uuid,confirmation:"YES"},
      {reviewId:uuid,confirmation:"RESTORE_TO_NEW_PROFILE",destination:"/Users/me/Library"},
      {},
    ])expect(()=>parseRecoveryConfirmation(v)).toThrow();
  });
});
