import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {requireUuid,type SharedMessage,type SharedTask} from "../../shared/cloud-model";
import type {TeamHistoryCipher} from "./workspace-history-crypto";
import {
  parseWorkspaceHistoryMarker,parseWorkspaceHistoryPage,workspaceCursor,
  parseWorkspaceCheckpointPage,type WorkspaceHistoryExpired,
  type WorkspaceCheckpointPage,type WorkspaceHistoryMarker,type WorkspaceHistoryItems,type WorkspaceHistoryPage,
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
  constructor(path:string,private readonly cipher:TeamHistoryCipher){
    if(!cipher||typeof cipher.encrypt!=="function"||typeof cipher.decrypt!=="function")
      throw Error("Team history requires a protected payload cipher");
    if(path!==":memory:")mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON");
    if(path!==":memory:")this.db.exec("PRAGMA journal_mode=WAL");
    const version=(this.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version;
    if(version>3){
      // Windows holds an exclusive file handle until DatabaseSync is closed.
      // Refusing to downgrade must not strand the file lock.
      this.db.close();
      throw Error("Workspace history database was created by a newer app");
    }
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
    if(version<=1)this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE checkpoint_progress(
        owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
        checkpoint_cursor TEXT NOT NULL,source_cursor TEXT NOT NULL,
        next_ordinal TEXT NOT NULL,total_items TEXT NOT NULL,
        PRIMARY KEY(owner_id,workspace_id)
      );
      CREATE TABLE checkpoint_records(
        owner_id TEXT NOT NULL,workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('message','task')),
        entity_id TEXT NOT NULL,created_at TEXT NOT NULL,json TEXT NOT NULL,
        PRIMARY KEY(owner_id,workspace_id,kind,entity_id),
        FOREIGN KEY(owner_id,workspace_id)
          REFERENCES checkpoint_progress(owner_id,workspace_id) ON DELETE CASCADE
      );
      PRAGMA user_version=2;
      COMMIT;
    `);
    // Existing v1/v2 rows were plaintext. Migration v3 encrypts both
    // published and staged JSON inside a single SQLite transaction. A failure
    // preserves the previous schema and data; older backup files may still
    // hold plaintext and require separate, reviewed disposal.
    if(version<3){
      this.db.exec("BEGIN IMMEDIATE");
      try{
        for(const table of ["records","checkpoint_records"] as const){
          const rows=this.db.prepare(`SELECT owner_id,workspace_id,kind,entity_id,json FROM ${table}`)
            .all() as Array<{owner_id:string;workspace_id:string;kind:string;
              entity_id:string;json:string}>;
          const update=this.db.prepare(`UPDATE ${table} SET json=?
            WHERE owner_id=? AND workspace_id=? AND kind=? AND entity_id=?`);
          for(const row of rows){
            // Validate legacy payload shape before irreversibly changing
            // representation; do not manufacture an empty cache if corrupt.
            JSON.parse(row.json);
            update.run(this.cipher.encrypt(row.json),
              row.owner_id,row.workspace_id,row.kind,row.entity_id);
          }
        }
        this.db.exec("PRAGMA user_version=3");
        this.db.exec("COMMIT");
      }catch(error){this.db.exec("ROLLBACK");this.db.close();throw error;}
    }
    // A Keychain/DPAPI change can make a previously encrypted database
    // unreadable. Detect it before any cache pages reach the renderer. Do NOT
    // silently replace ciphertext with a fresh empty database: Main instead
    // falls back to authenticated REST and preserves the unreadable original.
    try{
      for(const table of ["records","checkpoint_records"] as const){
        const sample=this.db.prepare(`SELECT json FROM ${table} LIMIT 1`)
          .get() as {json:string}|undefined;
        if(sample)JSON.parse(this.cipher.decrypt(sample.json));
      }
    }catch{
      this.db.close();
      throw Error("Protected team history is not readable with the current OS key");
    }
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
            change.record.created_at,this.cipher.encrypt(JSON.stringify(change.record)));
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


  /** A staged snapshot stays invisible until its final atomic swap. */
  getCheckpoint(ownerInput:unknown,workspaceInput:unknown):{
    checkpointCursor:string;sourceCursor:string;nextOrdinal:string;totalItems:string;
  }|null{
    const id=owner(ownerInput),workspace=requireUuid(workspaceInput);
    const row=this.db.prepare(`SELECT checkpoint_cursor,source_cursor,next_ordinal,total_items
      FROM checkpoint_progress WHERE owner_id=? AND workspace_id=?`)
      .get(id,workspace) as {
        checkpoint_cursor:string;source_cursor:string;next_ordinal:string;total_items:string;
      }|undefined;
    if(!row)return null;
    return {checkpointCursor:workspaceCursor(row.checkpoint_cursor),
      sourceCursor:workspaceCursor(row.source_cursor),
      nextOrdinal:workspaceCursor(row.next_ordinal),
      totalItems:workspaceCursor(row.total_items)};
  }

  /** Only a server-confirmed expiry may begin/reset a snapshot. The previous
   * live records and Cursor are untouched, even when a newer checkpoint
   * supersedes an interrupted attempt. */
  beginCheckpoint(ownerInput:unknown,workspaceInput:unknown,
    expired:WorkspaceHistoryExpired):void{
    const id=owner(ownerInput),workspace=requireUuid(workspaceInput);
    if(expired.status!=="expired")throw Error("Snapshot recovery requires server expiry");
    const checkpoint=workspaceCursor(expired.checkpointCursor);
    const total=workspaceCursor(expired.totalItems);
    if(checkpoint==="0")throw Error("Missing nonzero trusted checkpoint");
    const original=this.getCursor(id,workspace);
    if(BigInt(original)>=BigInt(checkpoint))
      throw Error("Checkpoint must be ahead of the local cursor");
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const stage=this.getCheckpoint(id,workspace);
      if(stage&&stage.checkpointCursor===checkpoint&&stage.sourceCursor===original){
        if(stage.totalItems!==total)throw Error("Checkpoint item count changed");
      }else{
        this.db.prepare("DELETE FROM checkpoint_progress WHERE owner_id=? AND workspace_id=?")
          .run(id,workspace);
        this.db.prepare(`INSERT INTO checkpoint_progress(
          owner_id,workspace_id,checkpoint_cursor,source_cursor,next_ordinal,total_items
        ) VALUES(?,?,?,?,?,?)`).run(id,workspace,checkpoint,original,"0",total);
      }
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  /** Atomic stage insert + checkpoint ordinal advancement. A crash replay
   * resumes at the last fully validated staged page, never a partial row. */
  stageCheckpointPage(ownerInput:unknown,workspaceInput:unknown,raw:unknown):
    WorkspaceCheckpointPage{
    const id=owner(ownerInput),workspace=requireUuid(workspaceInput);
    const previous=this.getCheckpoint(id,workspace);
    if(!previous)throw Error("Workspace checkpoint has not been authorized");
    const page=parseWorkspaceCheckpointPage(raw,workspace,previous.checkpointCursor,
      previous.nextOrdinal,previous.totalItems);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const current=this.getCheckpoint(id,workspace);
      if(!current||JSON.stringify(current)!==JSON.stringify(previous))
        throw Error("Workspace checkpoint stage changed");
      if(this.getCursor(id,workspace)!==previous.sourceCursor)
        throw Error("Workspace checkpoint source cursor changed");
      const insert=this.db.prepare(`INSERT INTO checkpoint_records(
        owner_id,workspace_id,kind,entity_id,created_at,json
      ) VALUES(?,?,?,?,?,?)`);
      for(const row of page.items){
        insert.run(id,workspace,row.kind,row.entityId,
          row.record.created_at,this.cipher.encrypt(JSON.stringify(row.record)));
      }
      const result=this.db.prepare(`UPDATE checkpoint_progress
        SET next_ordinal=? WHERE owner_id=? AND workspace_id=? AND next_ordinal=?`)
        .run(page.nextOrdinal,id,workspace,previous.nextOrdinal);
      if(result.changes!==1)throw Error("Workspace checkpoint ordinal CAS failed");
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    return page;
  }

  /** FULL baseline replacement and cursor jump occur in ONE SQLite
   * transaction only after every ordinal has been staged and counted. */
  finishCheckpoint(ownerInput:unknown,workspaceInput:unknown):string{
    const id=owner(ownerInput),workspace=requireUuid(workspaceInput);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const stage=this.getCheckpoint(id,workspace);
      if(!stage||stage.nextOrdinal!==stage.totalItems)
        throw Error("Incomplete workspace checkpoint cannot be published");
      if(this.getCursor(id,workspace)!==stage.sourceCursor)
        throw Error("Workspace checkpoint cursor changed before publication");
      const count=this.db.prepare(`SELECT count(*) AS n FROM checkpoint_records
        WHERE owner_id=? AND workspace_id=?`).get(id,workspace) as {n:number};
      if(BigInt(count.n)!==BigInt(stage.totalItems))
        throw Error("Workspace checkpoint row count mismatch");
      // New devices may have no progress row yet. Establish the parent
      // before INSERT...SELECT into FK-protected records; all three steps
      // still COMMIT atomically, so no premature cursor publication.
      this.db.prepare(`INSERT INTO progress(owner_id,workspace_id,cursor)
        VALUES(?,?,?) ON CONFLICT(owner_id,workspace_id)
        DO UPDATE SET cursor=excluded.cursor`).run(id,workspace,stage.checkpointCursor);
      this.db.prepare("DELETE FROM records WHERE owner_id=? AND workspace_id=?")
        .run(id,workspace);
      this.db.prepare(`INSERT INTO records(
        owner_id,workspace_id,kind,entity_id,created_at,json
      ) SELECT owner_id,workspace_id,kind,entity_id,created_at,json
        FROM checkpoint_records WHERE owner_id=? AND workspace_id=?`)
        .run(id,workspace);
      this.db.prepare("DELETE FROM checkpoint_progress WHERE owner_id=? AND workspace_id=?")
        .run(id,workspace);
      this.db.exec("COMMIT");
      return stage.checkpointCursor;
    }catch(error){this.db.exec("ROLLBACK");throw error;}
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
      const item=JSON.parse(this.cipher.decrypt(row.json)) as T;
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
      WHERE owner_id=? AND workspace_id=? GROUP BY kind`).all(id,workspace) as Array<{kind:string;count:number}>;
    return {messages:rows.find(x=>x.kind==="message")?.count??0,
      tasks:rows.find(x=>x.kind==="task")?.count??0};
  }

  /** Deletes ALL workspaces and in-flight checkpoint pages belonging to ONE
   * OS/project/account scope. Does not touch other users, cloud data, local
   * personal tasks or cross-account SQLite records. */
  purgeOwner(ownerInput:unknown):{workspaces:number;checkpointed:boolean}{
    const id=owner(ownerInput);
    this.db.exec("BEGIN IMMEDIATE");
    let workspaces=0;
    try{
      // Count distinct workspace partitions; a workspace can have BOTH a
      // published cursor and an unfinished checkpoint stage.
      const existing=this.db.prepare(`SELECT count(*) AS n FROM (
        SELECT workspace_id FROM progress WHERE owner_id=?
        UNION SELECT workspace_id FROM checkpoint_progress WHERE owner_id=?
      )`).get(id,id) as {n:number};
      workspaces=existing.n;
      this.db.prepare("DELETE FROM checkpoint_progress WHERE owner_id=?").run(id);
      this.db.prepare("DELETE FROM progress WHERE owner_id=?").run(id);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    return {workspaces,checkpointed:this.bestEffortWalCheckpoint()};
  }

  /** TRUNCATE old WAL frames if no other SQLite connection holds a read
   * lock. This is NOT an SSD/backups/filesystem-level secure erase. */
  private bestEffortWalCheckpoint():boolean{
    try{
      const state=this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
        {busy:number}|undefined;
      return state?.busy===0;
    }catch{return false;}
  }

  /** Revoke cleanup deletes local cached team rows and durable cursor together.
   * Missing membership cannot leave displayable stale team records. */
  revoke(ownerInput:unknown,workspaceInput:unknown):void{
    const id=owner(ownerInput),workspace=requireUuid(workspaceInput);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare("DELETE FROM checkpoint_progress WHERE owner_id=? AND workspace_id=?")
        .run(id,workspace);
      this.db.prepare("DELETE FROM progress WHERE owner_id=? AND workspace_id=?")
        .run(id,workspace);
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    this.bestEffortWalCheckpoint();
  }

  close():void{this.db.close();}
}
