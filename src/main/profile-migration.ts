import {randomUUID} from "node:crypto";
import {
  copyFileSync,existsSync,lstatSync,mkdirSync,readdirSync,renameSync,
  rmdirSync,rmSync,statSync,writeFileSync,
} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {DatabaseSync,backup} from "node:sqlite";

/**
 * The old profile is NEVER renamed or deleted. New full profiles are built
 * outside of Electron's userData path and committed with a directory rename.
 * All SQLite files use the online backup API, so committed -wal frames survive.
 */
export const PROFILE_MARKER="study-anchor-profile.json";
export const LEGACY_DEFAULT_NAMES=[
  "Agent to Entrepreneurship",
  "Agent-to-Entrepreneurship",
  "agent-to-entrepreneurship",
] as const;
export const RENAMED_PROFILE_FILES={
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
} as const;

const renamed=new Map(Object.entries(RENAMED_PROFILE_FILES));
const oldFiles=new Set(Object.keys(RENAMED_PROFILE_FILES));
const newFiles=new Set(Object.values(RENAMED_PROFILE_FILES));
const MIGRATION_VERSION=1;
const safeRoot=(path:string)=>resolve(path);
type MigrationMode="directory"|"in-place";
export interface ProfileMigrationRequest {
  /** Root containing old app profiles, usually Electron appData. */
  appData:string;
  /** The new app's selected userData directory (or an explicit override). */
  destination:string;
  /** Caller explicitly requested userData override, don't move that root. */
  inPlace:boolean;
}
export type ProfileMigrationResult="fresh"|"already-migrated"|"migrated";

function assertDirectory(path:string):void{
  const info=lstatSync(path);
  if(!info.isDirectory()||info.isSymbolicLink())
    throw Error("Profile directory must be a real directory");
}
function asPath(path:string):void{
  if(existsSync(path)&&lstatSync(path).isSymbolicLink())
    throw Error("Refusing a symbolic link in the profile");
}
function hasLegacyData(dir:string):boolean{
  if(!existsSync(dir))return false;
  assertDirectory(dir);
  return readdirSync(dir).some(name=>oldFiles.has(name));
}
function assertNoNewProfileConflicts(dir:string):void{
  if(!existsSync(dir))return;
  assertDirectory(dir);
  if(readdirSync(dir).length!==0)
    throw Error("New Study Anchor data already exists; review profiles manually before migration");
}
function isSqlite(name:string):boolean{return name.endsWith(".sqlite");}
function isSidecar(name:string):boolean{
  return /\.sqlite-(?:wal|shm|journal)$/.test(name);
}
function mapName(name:string):string{return renamed.get(name)??name;}
function verifyDb(path:string):void{
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    const result=db.prepare("PRAGMA quick_check").get() as {quick_check:string}|undefined;
    if(result?.quick_check!=="ok")throw Error("SQLite integrity verification failed");
  }finally{db.close();}
}

/**
 * Rebuilds the profile in a private staging directory. Unknown non-SQLite
 * files, Chromium Local Storage/Preferences, prior backups and vaults are
 * preserved; symlinks are rejected to prevent migration outside the source.
 */
async function stageProfile(source:string,stage:string,mode:MigrationMode):Promise<string[]>{
  const moved:string[]=[];
  const visit=async(src:string,dst:string,topLevel:boolean):Promise<void>=>{
    mkdirSync(dst,{recursive:true,mode:0o700});
    for(const item of readdirSync(src,{withFileTypes:true})){
      if(item.isSymbolicLink()||(!item.isFile()&&!item.isDirectory()))
        throw Error("Unsupported symbolic link or special file in existing profile");
      if(topLevel&&(item.name===PROFILE_MARKER||item.name.startsWith(".study-anchor-migration-")))
        throw Error("Previous profile migration is incomplete; inspect it before retry");
      if(isSidecar(item.name))continue; // SQLite backup incorporates committed WAL.
      if(mode==="in-place"&&topLevel&&!oldFiles.has(item.name))continue;
      const targetName=topLevel?mapName(item.name):item.name;
      const from=join(src,item.name),to=join(dst,targetName);
      if(topLevel&&targetName!==item.name)moved.push(targetName);
      if(item.isDirectory()){
        if(mode==="in-place")continue;
        await visit(from,to,false);
      }else if(isSqlite(item.name)){
        const db=new DatabaseSync(from,{readOnly:true});
        try{
          const original=db.prepare("PRAGMA quick_check").get() as {quick_check:string}|undefined;
          if(original?.quick_check!=="ok")throw Error("Legacy SQLite integrity check failed");
          await backup(db,to);
        }finally{db.close();}
        verifyDb(to);
      }else copyFileSync(from,to);
    }
  };
  await visit(source,stage,true);
  return moved;
}
function writeMarker(root:string,mode:MigrationMode):void{
  writeFileSync(join(root,PROFILE_MARKER),JSON.stringify({
    schema:MIGRATION_VERSION,product:"Study Anchor",mode,
    migratedAt:new Date().toISOString(),
    sourceRetained:true,
  },null,2),{flag:"wx",mode:0o600});
}

/**
 * Refuses ambiguous source roots, an existing nonempty destination, and
 * unexpected partial custom-directory migrations. Never silently starts an
 * empty profile if a legacy profile must be migrated.
 */
export async function migrateStudyAnchorProfile(
  input:ProfileMigrationRequest,
):Promise<ProfileMigrationResult>{
  const appData=safeRoot(input.appData),destination=safeRoot(input.destination);
  asPath(appData);asPath(destination);
  if(input.inPlace){
    if(!existsSync(destination))mkdirSync(destination,{recursive:true,mode:0o700});
    assertDirectory(destination);
    const oldFound=readdirSync(destination).filter(name=>oldFiles.has(name));
    const newFound=readdirSync(destination).filter(name=>newFiles.has(name));
    const marker=join(destination,PROFILE_MARKER);
    if(existsSync(marker))return "already-migrated";
    if(!oldFound.length){
      if(newFound.length)throw Error("Partial Study Anchor profile migration; review files before startup");
      return "fresh";
    }
    if(newFound.length)throw Error("Both old and new profile files exist; refusing automatic merge");
    const stage=join(dirname(destination),".study-anchor-migration-"+randomUUID());
    mkdirSync(stage,{mode:0o700});
    const committed:string[]=[];
    try{
      const moved=await stageProfile(destination,stage,"in-place");
      // Files only: we must not replace the caller's explicit directory.
      for(const name of moved){
        if(existsSync(join(destination,name)))
          throw Error("Study Anchor profile target appeared during migration");
        renameSync(join(stage,name),join(destination,name));
        committed.push(name);
      }
      writeMarker(destination,"in-place");
      return "migrated";
    }catch(error){
      // Old source files are still intact. Roll back only files created in
      // THIS invocation, never preexisting user files.
      for(const name of committed)rmSync(join(destination,name),{force:true});
      throw error;
    }finally{rmSync(stage,{recursive:true,force:true});}
  }

  const sources=LEGACY_DEFAULT_NAMES.map(name=>join(appData,name))
    .filter(path=>safeRoot(path)!==destination&&hasLegacyData(path));
  if(sources.length>1)throw Error("Multiple old app profiles found; choose the correct one manually");
  if(!sources.length)return existsSync(join(destination,PROFILE_MARKER))
    ?"already-migrated":"fresh";
  const source=sources[0];
  if(existsSync(join(destination,PROFILE_MARKER)))return "already-migrated";
  assertNoNewProfileConflicts(destination);
  const stage=join(appData,".study-anchor-migration-"+randomUUID());
  mkdirSync(stage,{mode:0o700});
  try{
    await stageProfile(source,stage,"directory");
    writeMarker(stage,"directory");
    // Electron may have created an empty userData directory before ready.
    if(existsSync(destination)){
      assertNoNewProfileConflicts(destination);
      rmdirSync(destination);
    }
    renameSync(stage,destination); // same parent filesystem, atomic visibility
    return "migrated";
  }finally{if(existsSync(stage))rmSync(stage,{recursive:true,force:true});}
}
