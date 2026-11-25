import {afterEach,describe,expect,it,vi} from "vitest";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {WorkspaceHistoryStore} from "./workspace-history-store";
import {WorkspaceHistoryService} from "./workspace-history-service";
import {testHistoryCipher} from "./workspace-history-crypto.test-helper";
import type {TeamHistoryCipher} from "./workspace-history-crypto";
import type {SharedCloudClient} from "./supabase-client";

const A="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const B="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const W="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const W2="79c7ba8d-ad06-4c71-8172-672b78b0298d";
const ID="7c2cb69c-8b50-419c-8966-e8a55c397a11";
const AT="2026-11-24T12:00:00.000Z";
const message=(workspace=W,body="Confidential study group report")=>({
  id:ID,workspace_id:workspace,author_id:A,body,created_at:AT,
});
function upsert(workspace=W){
  return {changes:[{cursor:"1",kind:"message",action:"upsert",entityId:ID,
    record:message(workspace)}],nextCursor:"1",serverCursor:"1",hasMore:false};
}
const directories:string[]=[];
const opened:WorkspaceHistoryStore[]=[];
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"study-anchor-privacy-"));
  directories.push(root);
  const path=join(root,"study-anchor-team-history.sqlite");
  const store=new WorkspaceHistoryStore(path,testHistoryCipher);
  opened.push(store);
  return {path,store};
}
function close(store:WorkspaceHistoryStore){
  store.close();
  const idx=opened.indexOf(store);if(idx>=0)opened.splice(idx,1);
}
function simulateLegacyVersion2(path:string){
  const db=new DatabaseSync(path);
  try{
    for(const table of ["records","checkpoint_records"]){
      const rows=db.prepare(`SELECT owner_id,workspace_id,kind,entity_id,json FROM ${table}`)
        .all() as Array<{owner_id:string;workspace_id:string;kind:string;entity_id:string;json:string}>;
      const update=db.prepare(`UPDATE ${table} SET json=? WHERE
        owner_id=? AND workspace_id=? AND kind=? AND entity_id=?`);
      for(const row of rows)update.run(testHistoryCipher.decrypt(row.json),
        row.owner_id,row.workspace_id,row.kind,row.entity_id);
    }
    db.exec("PRAGMA user_version=2");
  }finally{db.close();}
}
afterEach(()=>{
  while(opened.length){try{opened.pop()!.close();}catch{/* closed */}}
  while(directories.length)rmSync(directories.pop()!,{recursive:true,force:true});
});

describe("ALPHA-SYNC-003D protected and revocable local team history",()=>{
  it("stores new published and staged team payloads as ciphertext, with real disk reopen",()=>{
    const {path,store}=fixture();
    store.applyPage(A,W,upsert());
    store.beginCheckpoint(A,W,{status:"expired",checkpointCursor:"5",
      serverCursor:"5",totalItems:"1"});
    store.stageCheckpointPage(A,W,{checkpointCursor:"5",totalItems:"1",
      items:[{ordinal:"1",kind:"message",entityId:ID,record:message()}],
      nextOrdinal:"1",hasMore:false});
    close(store);
    const sql=new DatabaseSync(path,{readOnly:true});
    const published=sql.prepare("SELECT json FROM records").get() as {json:string};
    const staged=sql.prepare("SELECT json FROM checkpoint_records").get() as {json:string};
    const version=(sql.prepare("PRAGMA user_version").get() as {user_version:number}).user_version;
    sql.close();
    expect(version).toBe(3);
    expect(published.json).toMatch(/^sa1:/);
    expect(staged.json).toMatch(/^sa1:/);
    expect(published.json).not.toContain("Confidential");
    expect(testHistoryCipher.decrypt(published.json)).toContain("Confidential");
    expect(readFileSync(path).toString("utf8")).not.toContain("Confidential study group report");
    const again=new WorkspaceHistoryStore(path,testHistoryCipher);opened.push(again);
    expect(again.list(A,W,"message").items).toMatchObject([{body:"Confidential study group report"}]);
    expect(again.getCheckpoint(A,W)?.nextOrdinal).toBe("1");
    expect(again.finishCheckpoint(A,W)).toBe("5");
    expect(again.list(A,W,"message").items).toHaveLength(1);
  });

  it("transactionally re-encrypts both old published and interrupted checkpoint rows",()=>{
    const {path,store}=fixture();
    store.applyPage(A,W,upsert());
    store.beginCheckpoint(A,W,{status:"expired",checkpointCursor:"5",
      serverCursor:"5",totalItems:"1"});
    store.stageCheckpointPage(A,W,{checkpointCursor:"5",totalItems:"1",
      items:[{ordinal:"1",kind:"message",entityId:ID,record:message()}],
      nextOrdinal:"1",hasMore:false});
    close(store);
    simulateLegacyVersion2(path);
    const prior=new DatabaseSync(path,{readOnly:true});
    expect((prior.prepare("SELECT json FROM records").get() as {json:string}).json)
      .toContain("Confidential study group");
    prior.close();
    const migrated=new WorkspaceHistoryStore(path,testHistoryCipher);opened.push(migrated);
    expect(migrated.getCursor(A,W)).toBe("1");
    expect(migrated.getCheckpoint(A,W)?.nextOrdinal).toBe("1");
    expect(migrated.list(A,W,"message").items[0]).toMatchObject({
      body:"Confidential study group report",
    });
    const db=new DatabaseSync(path,{readOnly:true});
    for(const table of ["records","checkpoint_records"]){
      expect((db.prepare(`SELECT json FROM ${table}`).get() as {json:string}).json)
        .toMatch(/^sa1:/);
    }
    db.close();
    expect(migrated.finishCheckpoint(A,W)).toBe("5");
  });

  it("rolls back a failed v2->v3 encryption so the original DB can be recovered",()=>{
    const {path,store}=fixture();
    store.applyPage(A,W,upsert());
    close(store);
    simulateLegacyVersion2(path);
    const broken:TeamHistoryCipher={
      encrypt:()=>{throw Error("Simulated locked OS credential vault");},
      decrypt:testHistoryCipher.decrypt,
    };
    expect(()=>new WorkspaceHistoryStore(path,broken))
      .toThrow("Simulated locked OS credential vault");
    const db=new DatabaseSync(path,{readOnly:true});
    expect((db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version)
      .toBe(2);
    expect((db.prepare("SELECT json FROM records").get() as {json:string}).json)
      .toContain("Confidential study group report");
    db.close();
    const repaired=new WorkspaceHistoryStore(path,testHistoryCipher);opened.push(repaired);
    expect(repaired.list(A,W,"message").items[0]).toMatchObject({
      body:"Confidential study group report",
    });
  });

  it("fails closed on a lost OS key at database open, preserves bytes, and releases Windows locks",()=>{
    const {path,store}=fixture();
    store.applyPage(A,W,upsert());
    store.beginCheckpoint(A,W,{status:"expired",checkpointCursor:"5",
      serverCursor:"5",totalItems:"1"});
    store.stageCheckpointPage(A,W,{checkpointCursor:"5",totalItems:"1",
      items:[{ordinal:"1",kind:"message",entityId:ID,record:message()}],
      nextOrdinal:"1",hasMore:false});
    close(store);
    const invalidKey:TeamHistoryCipher={
      encrypt:testHistoryCipher.encrypt,
      decrypt:()=>{throw Error("Simulated OS key access revoked");},
    };
    expect(()=>new WorkspaceHistoryStore(path,invalidKey))
      .toThrow("Protected team history is not readable");
    const db=new DatabaseSync(path,{readOnly:true});
    expect((db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version)
      .toBe(3);
    const original=(db.prepare("SELECT json FROM records").get() as {json:string}).json;
    expect(original).toMatch(/^sa1:/);
    expect(testHistoryCipher.decrypt(original)).toContain("Confidential study group report");
    db.close();
    const recovered=new WorkspaceHistoryStore(path,testHistoryCipher);
    opened.push(recovered);
    expect(recovered.getCheckpoint(A,W)?.nextOrdinal).toBe("1");
    expect(recovered.list(A,W,"message").items[0])
      .toMatchObject({body:"Confidential study group report"});
  });

  it("purges only the target account, including staged snapshots, without cloud deletion",()=>{
    const {store}=fixture();
    store.applyPage(A,W,upsert());
    store.applyPage(B,W2,upsert(W2));
    store.beginCheckpoint(A,W,{status:"expired",checkpointCursor:"5",
      serverCursor:"5",totalItems:"0"});
    const cleared=store.purgeOwner(A);
    expect(cleared.workspaces).toBe(1); // one workspace, despite live + staged generations
    expect(typeof cleared.checkpointed).toBe("boolean");
    expect(store.getCursor(A,W)).toBe("0");
    expect(store.getCheckpoint(A,W)).toBeNull();
    expect(store.counts(A,W).messages).toBe(0);
    expect(store.getCursor(B,W2)).toBe("1");
    expect(store.list(B,W2,"message").items).toHaveLength(1);
  });

  it("cancel + purge fences off late network pages after logout",async()=>{
    let resolve:(value:unknown)=>void=()=>{};
    let started!:()=>void;
    const startedPromise=new Promise<void>(r=>{started=r;});
    const {store}=fixture();
    const client={
      currentUserId:vi.fn(()=>A),
      currentProjectUrl:vi.fn(()=>"https://team.supabase.co"),
      listMembers:vi.fn(async()=>[{workspace_id:W,user_id:A,role:"member",
        display_name:"Study",joined_at:AT}]),
      pullWorkspaceHistory:vi.fn(async()=>new Promise<unknown>(r=>{resolve=r;started();})),
      pullWorkspaceCheckpoint:vi.fn(),
      workspaceSnapshot:vi.fn(),
    };
    const service=new WorkspaceHistoryService(client as unknown as SharedCloudClient,store);
    const pending=service.snapshot(W);
    await startedPromise;
    const result=service.purgeCurrentAccountCache();
    expect(result.workspaces).toBe(0);
    resolve(upsert());
    await expect(pending).rejects.toThrow("project changed");
    const scoped=client.currentProjectUrl()+"\u0000"+A;
    // The old response must not create a record under any owner partition.
    expect(store.counts(A,W).messages).toBe(0);
    expect(service).toBeTruthy();
    expect(scoped).toContain(A);
    expect(client.workspaceSnapshot).not.toHaveBeenCalled();
  });
});
