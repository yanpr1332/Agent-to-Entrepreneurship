import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,mkdirSync,existsSync,readFileSync,writeFileSync,rmSync,readdirSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {
  migrateStudyAnchorProfile,RENAMED_PROFILE_FILES,PROFILE_MARKER,
} from "./profile-migration";

const fixtures:string[]=[];
function temp():string{
  const d=mkdtempSync(join(tmpdir(),"study-anchor-rename-"));fixtures.push(d);return d;
}
function createDb(path:string,name:string,value:string):void{
  const db=new DatabaseSync(path);
  try{
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE content (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO content VALUES (?,?)").run(name,value);
  }finally{db.close();}
}
function valueAt(path:string,name:string):string{
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    return (db.prepare("SELECT value FROM content WHERE name=?").get(name) as {value:string}).value;
  }finally{db.close();}
}
afterEach(()=>{
  while(fixtures.length)rmSync(fixtures.pop()!,{recursive:true,force:true});
});

describe("REPO-RENAME-001: first-run userData and SQLite migration",()=>{
  it("atomically stages an old desktop profile and carries SQLite/WAL, vault and settings over",async()=>{
    const appData=temp(),old=join(appData,"Agent to Entrepreneurship");
    const target=join(appData,"Study Anchor");
    mkdirSync(old);
    createDb(join(old,"ate-local.sqlite"),"task","2026 saved task");
    createDb(join(old,"ate-knowledge.sqlite"),"knowledge","saved source");
    writeFileSync(join(old,"ai-personal.enc"),"ciphertext-not-plaintext");
    writeFileSync(join(old,"canvas-personal.enc"),"canvas-vault");
    writeFileSync(join(old,"campus-mail.enc"),"mail-vault");
    writeFileSync(join(old,"ate-diagnostics.jsonl"),'{"code":"APP_START"}\n');
    mkdirSync(join(old,"Local Storage"));
    writeFileSync(join(old,"Local Storage","profile.settings"),"keep theme");
    mkdirSync(target); // Electron can prepare an empty userData before ready.
    expect(await migrateStudyAnchorProfile({appData,destination:target,inPlace:false}))
      .toBe("migrated");
    expect(valueAt(join(target,"study-anchor-tasks.sqlite"),"task"))
      .toBe("2026 saved task");
    expect(valueAt(join(target,"study-anchor-knowledge.sqlite"),"knowledge"))
      .toBe("saved source");
    expect(readFileSync(join(target,"study-anchor-ai.enc"),"utf8"))
      .toBe("ciphertext-not-plaintext");
    expect(readFileSync(join(target,"study-anchor-canvas.enc"),"utf8")).toBe("canvas-vault");
    expect(readFileSync(join(target,"study-anchor-campus-mail.enc"),"utf8")).toBe("mail-vault");
    expect(readFileSync(join(target,"study-anchor-diagnostics.jsonl"),"utf8"))
      .toContain("APP_START");
    expect(readFileSync(join(target,"Local Storage","profile.settings"),"utf8"))
      .toBe("keep theme");
    // SQLite may create a NEW WAL file in its destination when opened.
    // The unsafe case is copying OLD legacy sidecars rather than using backup().
    expect(readdirSync(target).some(x=>x.startsWith("ate-")&&x.endsWith(".sqlite-wal")))
      .toBe(false);
    expect(JSON.parse(readFileSync(join(target,PROFILE_MARKER),"utf8")).sourceRetained)
      .toBe(true);
    // The ORIGINAL profile stays intact, including its encrypted credentials.
    expect(valueAt(join(old,"ate-local.sqlite"),"task")).toBe("2026 saved task");
    expect(readFileSync(join(old,"ai-personal.enc"),"utf8"))
      .toBe("ciphertext-not-plaintext");
    expect(await migrateStudyAnchorProfile({appData,destination:target,inPlace:false}))
      .toBe("already-migrated");
  });

  it("includes committed data held only in a live source WAL",async()=>{
    const appData=temp(),old=join(appData,"Agent to Entrepreneurship");
    mkdirSync(old);
    const path=join(old,"ate-local.sqlite");
    const db=new DatabaseSync(path);
    try{
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("CREATE TABLE content (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO content VALUES (?,?)").run("task","uncheckpointed WAL row");
      expect(existsSync(path+"-wal")).toBe(true);
      const target=join(appData,"Study Anchor");
      expect(await migrateStudyAnchorProfile({appData,destination:target,inPlace:false}))
        .toBe("migrated");
      expect(valueAt(join(target,"study-anchor-tasks.sqlite"),"task"))
        .toBe("uncheckpointed WAL row");
    }finally{db.close();}
  });

  it("preserves old and new profiles and blocks a nonempty conflicting target",async()=>{
    const appData=temp(),old=join(appData,"Agent to Entrepreneurship");
    const target=join(appData,"Study Anchor");
    mkdirSync(old);mkdirSync(target);
    createDb(join(old,"ate-local.sqlite"),"task","original");
    writeFileSync(join(target,"study-anchor-tasks.sqlite"),"EXISTING NEW DATA");
    await expect(migrateStudyAnchorProfile({appData,destination:target,inPlace:false}))
      .rejects.toThrow("already exists");
    expect(valueAt(join(old,"ate-local.sqlite"),"task")).toBe("original");
    expect(readFileSync(join(target,"study-anchor-tasks.sqlite"),"utf8"))
      .toBe("EXISTING NEW DATA");
  });

  it("fails closed if more than one legacy profile directory contains data",async()=>{
    const appData=temp(),one=join(appData,"Agent to Entrepreneurship");
    const two=join(appData,"agent-to-entrepreneurship");
    mkdirSync(one);mkdirSync(two);
    createDb(join(one,"ate-local.sqlite"),"task","one");
    createDb(join(two,"ate-local.sqlite"),"task","two");
    await expect(migrateStudyAnchorProfile({
      appData,destination:join(appData,"Study Anchor"),inPlace:false,
    })).rejects.toThrow("Multiple old app profiles");
    expect(valueAt(join(one,"ate-local.sqlite"),"task")).toBe("one");
    expect(valueAt(join(two,"ate-local.sqlite"),"task")).toBe("two");
  });

  it("does not follow symbolic links inside an old profile",async()=>{
    const {symlinkSync}=await import("node:fs");
    const appData=temp(),source=join(appData,"Agent to Entrepreneurship");
    mkdirSync(source);
    createDb(join(source,"ate-local.sqlite"),"task","safe");
    const outside=join(appData,"secrets.txt");
    writeFileSync(outside,"private");
    symlinkSync(outside,join(source,"untrusted-link"));
    await expect(migrateStudyAnchorProfile({
      appData,destination:join(appData,"Study Anchor"),inPlace:false,
    })).rejects.toThrow("symbolic link");
    expect(readFileSync(outside,"utf8")).toBe("private");
    expect(valueAt(join(source,"ate-local.sqlite"),"task")).toBe("safe");
  });

  it("in-place custom userData duplicates verified databases under the new names without deleting old",async()=>{
    const appData=temp(),data=join(appData,"explicit-data");
    mkdirSync(data);
    createDb(join(data,"ate-local.sqlite"),"task","custom persisted");
    writeFileSync(join(data,"canvas-personal.enc"),"encrypted source");
    expect(await migrateStudyAnchorProfile({appData,destination:data,inPlace:true}))
      .toBe("migrated");
    expect(valueAt(join(data,"study-anchor-tasks.sqlite"),"task")).toBe("custom persisted");
    expect(readFileSync(join(data,"study-anchor-canvas.enc"),"utf8"))
      .toBe("encrypted source");
    expect(valueAt(join(data,"ate-local.sqlite"),"task")).toBe("custom persisted");
    expect(await migrateStudyAnchorProfile({appData,destination:data,inPlace:true}))
      .toBe("already-migrated");
  });

  it("rejects a partial custom profile collision without deleting either version",async()=>{
    const appData=temp(),data=join(appData,"custom");
    mkdirSync(data);
    createDb(join(data,"ate-local.sqlite"),"task","legacy");
    createDb(join(data,"study-anchor-tasks.sqlite"),"task","new");
    await expect(migrateStudyAnchorProfile({appData,destination:data,inPlace:true}))
      .rejects.toThrow("Both old and new");
    expect(valueAt(join(data,"ate-local.sqlite"),"task")).toBe("legacy");
    expect(valueAt(join(data,"study-anchor-tasks.sqlite"),"task")).toBe("new");
  });

  it("starts a genuinely fresh profile without altering another directory",async()=>{
    const appData=temp(),target=join(appData,"Study Anchor");
    expect(await migrateStudyAnchorProfile({appData,destination:target,inPlace:false}))
      .toBe("fresh");
    expect(existsSync(target)).toBe(false);
    const custom=join(appData,"my-new-profile");
    expect(await migrateStudyAnchorProfile({appData,destination:custom,inPlace:true}))
      .toBe("fresh");
    expect(existsSync(custom)).toBe(true);
  });

  it("includes every known legacy database and credential in the migration map",()=>{
    expect(RENAMED_PROFILE_FILES).toMatchObject({
      "ate-local.sqlite":"study-anchor-tasks.sqlite",
      "ate-knowledge.sqlite":"study-anchor-knowledge.sqlite",
      "ate-fixed-calendar.sqlite":"study-anchor-calendar.sqlite",
      "ate-plans.sqlite":"study-anchor-planning.sqlite",
      "ate-ai-usage.sqlite":"study-anchor-ai-usage.sqlite",
      "ate-mail.sqlite":"study-anchor-mail.sqlite",
      "ate-shared-history.sqlite":"study-anchor-team-history.sqlite",
      "ai-personal.enc":"study-anchor-ai.enc",
      "canvas-personal.enc":"study-anchor-canvas.enc",
      "campus-mail.enc":"study-anchor-campus-mail.enc",
      "ate-diagnostics.jsonl":"study-anchor-diagnostics.jsonl",
    });
  });
});
