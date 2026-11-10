import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import type { BackupResult } from "../shared/knowledge-model";

export interface SnapshotSource {
  backupTo(path:string):Promise<number>;
}

function assertSqliteBackup(path:string):void{
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    const result=db.prepare("PRAGMA quick_check").get() as {quick_check:string};
    if(result.quick_check!=="ok")throw Error("SQLite backup integrity check did not pass");
  }finally{db.close();}
}

/**
 * SQLite's online backup API is WAL-aware. Never copy a live .sqlite file by
 * itself; that can omit changes in its -wal file.
 */
export async function createLocalBackup(
  userData:string, sources:ReadonlyArray<{name:"tasks"|"mail"|"knowledge"|"planning"|"calendar";store:SnapshotSource}>,
):Promise<BackupResult>{
  const createdAt=new Date().toISOString();
  const folder=join(userData,"backups",createdAt.replace(/[:.]/g,"-")+"-"+randomUUID());
  await mkdir(folder,{recursive:true,mode:0o700});
  const databases:string[]=[];
  try{
    for(const {name,store} of sources){
      const file=name+".sqlite";
      const output=join(folder,file);
      await store.backupTo(output);
      assertSqliteBackup(output);
      databases.push(file);
    }
    const manifest:BackupResult={folder,createdAt,databases,encryption:"none"};
    await writeFile(join(folder,"manifest.json"),JSON.stringify({
      schema:1,createdAt,databases,encryption:"none",
      note:"Local SQLite snapshots only; does not include encrypted credentials or original documents",
    },null,2),{mode:0o600,flag:"wx"});
    return manifest;
  }catch(error){
    await rm(folder,{recursive:true,force:true});
    throw error;
  }
}

/**
 * Before any SQLite schema upgrade, make a verified snapshot of the old
 * database without creating or modifying the original database.
 */
export async function backupBeforeMigration(
  userData:string, filename:string, expectedVersion:number,
):Promise<string|null>{
  if(!["ate-local.sqlite","ate-knowledge.sqlite"].includes(filename))
    throw Error("Unapproved migration backup source");
  const sourcePath=join(userData,filename);
  if(!existsSync(sourcePath))return null;
  const db=new DatabaseSync(sourcePath,{readOnly:true});
  let version:number;
  try {
    version=(db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version;
    if(version>=expectedVersion)return null;
    const folder=join(userData,"backups","pre-migration-"+filename+"-v"+version+"-"+
      new Date().toISOString().replace(/[:.]/g,"-")+"-"+randomUUID());
    mkdirSync(folder,{recursive:true,mode:0o700});
    const destination=join(folder,filename);
    try{
      await backup(db,destination);
      assertSqliteBackup(destination);
      await writeFile(join(folder,"manifest.json"),JSON.stringify({
        schema:1,source:filename,previousVersion:version,targetVersion:expectedVersion,
        createdAt:new Date().toISOString(),encryption:"none",
      },null,2),{mode:0o600,flag:"wx"});
      return folder;
    }catch(error){
      await rm(folder,{recursive:true,force:true});
      throw error;
    }
  }finally{db.close();}
}
