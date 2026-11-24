import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {requireUuid,type SharedMessage,type SharedTask} from "../../shared/cloud-model";
import {
  parseWorkspaceHistoryMarker,parseWorkspaceHistoryPage,workspaceCursor,
  type WorkspaceHistoryMarker,type WorkspaceHistoryItems,type WorkspaceHistoryPage,
} from "../../shared/workspace-history-contract";

type CachedRow={entity_id:string;json:string;created_at:string};
function owner(input:unknown):string{return requireUuid(input).toLowerCase();}

/** Durable per-owner, per-workspace materialization. The page and cursor
 * advance commit together in this one SQLite file; no split-store writes.
 * Cached team content is never read without a fresh current membership check
 * in WorkspaceHistoryService. No credentials or access tokens are persisted.
 */
export class WorkspaceHistoryStore {
  private readonly db:DatabaseSync;
  constructor(path:string){
    if(path!==":memory:")mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
    if(path!==":memory:")this.db.exec("PRAGMA journal_mode=WAL");
    const version=(this.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version;
    if(version>1)throw Error("Workspace history database was created by a newer app");
    if(version===0)this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE progress(
        owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        cursor TEXT NOT NULL,
        PRIMARY KEY(owner_id,workspace_id)
      );
      CREATE TABLE records(
        owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN('message','task')),
        entity_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY(owner_id,workspace_id,kind,entity_id),
        FOREIGN KEY(owner_id,workspace_id)
          REFERENCES progress(owner_id,workspace_id) ON DELETE CASCADE
      );
      CREATE INDEX records_history_page ON records
        (owner_id,workspace_id,kind,created_at DESC,entity_id DESC);
      PRAGMA user_version=1;
      COMMIT;
    `);
  }

  getCursor(ownerInput:unknown,workspaceInput:unknown):string{
    const id=owner(ownerInput),workspace=requireUuid(workspaceInput);
    const row=this.db.prepare("SELECT cursor FROM progress WHERE owner_id=? AND workspace_id=?")
      .get(id,workspace) as {cursor:string}|undefined;
    return row?workspaceCursor(row.cursor):"0";
  }

  hasProgress(ownerInput:unknown,workspaceInput:unknown):boolean{
    const id=owner(ownerInput),workspace=requireUuid(workspaceInput);
    return Boolean(this.db.prepare("SELECT 1 FROM progress WHERE owner_id=? AND workspace_id=?")
      .get(id,workspace));
  }

  /** Reject gaps or a stale page; atomically apply snapshot/tombstones and move
   * cursor. A crash before COMMIT leaves page replayable from prior cursor. */
  applyPage(ownerInput:unknown,workspaceInput:unknown,rawPage:unknown):WorkspaceHistoryPage{
    const id=owner(ownerInput),workspace=requireUuid(workspaceInput);
    const before=this.getCursor(id,workspace);
    const page=parseWorkspaceHistoryPage(rawPage,workspace,before);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const current=this.getCursor(id,workspace);
      if(current!==before)throw Error("Workspace history cursor changed before commit");
      this.db.prepare(`INSERT INTO progress(owner_id,workspace_id,cursor) VALUES(?,?,?)
        ON CONFLICT(owner_id,workspace_id) DO UPDATE SET cursor=excluded.cursor`)
        .run(id,workspace,before);
      const upsert=this.db.prepare(`INSERT INTO records
          (owner_id,workspace_id,kind,entity_id,created_at,json)
          VALUES(?,?,?,?,?,?)
          ON CONFLICT(owner_id,workspace_id,kind,entity_id)
          DO UPDATE SET created_at=excluded.created_at,json=excluded.json`);
      const remove=this.db.prepare(`DELETE FROM records
        WHERE owner_id=? AND workspace_id=? AND kind=? AND entity_id=?`);
      for(const change of page.changes){
        if(change.action==="delete")remove.run(id,workspace,change.kind,change.entityId);
        else{
          if(!change.record)throw Error("Workspace upsert missing record");
          upsert.run(id,workspace,change.kind,change.entityId,
            change.record.created_at,JSON.stringify(change.record));
        }
      }
      const result=this.db.prepare(`UPDATE progress SET cursor=?
        WHERE owner_id=? AND workspace_id=? AND cursor=?`)
        .run(page.nextCursor,id,workspace,before);
      if(result.changes!==1)throw Error("Workspace history cursor CAS failed");
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    return page;
  }

  list<T extends SharedMessage|SharedTask>(ownerInput:unknown,workspaceInput:unknown,
    kind:"message"|"task",beforeInput?:unknown,pageSize=100):WorkspaceHistoryItems<T>{
    const id=owner(ownerInput),workspace=requireUuid(workspaceInput);
    if(!this.hasProgress(id,workspace))throw Error("No workspace history has been verified");
    if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100)
      throw Error("Invalid workspace history page size");
    const before=beforeInput===undefined||beforeInput===null
      ?null:parseWorkspaceHistoryMarker(beforeInput);
    const rows=this.db.prepare(`SELECT entity_id,json,created_at FROM records
      WHERE owner_id=? AND workspace_id=? AND kind=?
        AND (? IS NULL OR created_at<? OR (created_at=? AND entity_id<?))
      ORDER BY created_at DESC,entity_id DESC LIMIT ?`)
      .all(id,workspace,kind,before?.createdAt??null,before?.createdAt??null,
        before?.createdAt??null,before?.id??null,pageSize+1) as CachedRow[];
    const limited=rows.slice(0,pageSize);
    const items=limited.map(row=>{
      const item=JSON.parse(row.json) as T;
      if(item.id!==row.entity_id||item.workspace_id!==workspace||
         item.created_at!==row.created_at)
        throw Error("Saved workspace record mismatches its owner or index");
      return item;
    });
    const last=limited.at(-1);
    return {items,hasMore:rows.length>pageSize,
      nextBefore:last?{createdAt:last.created_at,id:last.entity_id}:null};
  }

  counts(ownerInput:unknown,workspaceInput:unknown):{messages:number;tasks:number}{
    const id=owner(ownerInput),workspace=requireUuid(workspaceInput);
    const rows=this.db.prepare(`SELECT kind,count(*) AS count FROM records
      WHERE owner_id=? AND workspace_id=? GROUP BY kind`).all(id,workspace)
      as Array<{kind:string;count:number}>;
    return {messages:rows.find(x=>x.kind==="message")?.count??0,
      tasks:rows.find(x=>x.kind==="task")?.count??0};
  }

  /** Revoke cleanup deletes local cached team rows and durable cursor together.
   * Missing membership cannot leave displayable stale team records. */
  revoke(ownerInput:unknown,workspaceInput:unknown):void{
    const id=owner(ownerInput),workspace=requireUuid(workspaceInput);
    this.db.prepare("DELETE FROM progress WHERE owner_id=? AND workspace_id=?")
      .run(id,workspace);
  }

  close():void{this.db.close();}
}
