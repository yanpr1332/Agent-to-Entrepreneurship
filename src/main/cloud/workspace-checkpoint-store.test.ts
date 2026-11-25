import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {WorkspaceHistoryStore} from "./workspace-history-store";
import {testHistoryCipher} from "./workspace-history-crypto.test-helper";
import type {WorkspaceHistoryExpired} from "../../shared/workspace-history-contract";

const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const OTHER="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const W="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const SECOND="79c7ba8d-ad06-4c71-8172-672b78b0298d";
const dirs:string[]=[];
const openStores:WorkspaceHistoryStore[]=[];
const ident=(n:number)=>"00000000-0000-4000-8000-"+n.toString(16).padStart(12,"0");
function disk(){
  const dir=mkdtempSync(join(tmpdir(),"study-anchor-checkpoint-"));
  dirs.push(dir);
  const file=join(dir,"history.sqlite");
  const store=new WorkspaceHistoryStore(file,testHistoryCipher);
  openStores.push(store);
  return {file,store};
}
function record(n:number){
  return {id:ident(n),workspace_id:W,author_id:OWNER,body:"Live message "+n,
    created_at:new Date(Date.UTC(2026,10,24,12,0,n%60)).toISOString()};
}
function response(start:number,count:number,total:number,checkpoint="50"){
  return {checkpointCursor:checkpoint,totalItems:String(total),
    items:Array.from({length:count},(_,i)=>{
      const n=start+i+1;
      return {ordinal:String(n),kind:"message",entityId:ident(n),record:record(n)};
    }),
    nextOrdinal:String(start+count),hasMore:start+count<total};
}
const expiry=(checkpoint="50",total="150"):WorkspaceHistoryExpired=>({
  status:"expired",checkpointCursor:checkpoint,serverCursor:checkpoint,
  totalItems:total,
});
function base(store:WorkspaceHistoryStore){
  store.applyPage(OWNER,W,{changes:[{
    cursor:"1",kind:"message",action:"upsert",entityId:ident(999),
    record:record(999),
  }],nextCursor:"1",serverCursor:"1",hasMore:false});
}
afterEach(()=>{
  while(openStores.length){try{openStores.pop()!.close();}catch{/* closed */}}
  while(dirs.length)rmSync(dirs.pop()!,{recursive:true,force:true});
});

describe("ALPHA-SYNC-003C crash-safe full snapshot replacement",()=>{
  it("stages 150 rows across a real SQLite close/reopen before atomically replacing old cache",()=>{
    const {file,store}=disk();
    base(store);
    store.beginCheckpoint(OWNER,W,expiry());
    store.stageCheckpointPage(OWNER,W,response(0,100,150));
    expect(store.getCursor(OWNER,W)).toBe("1");
    expect(store.counts(OWNER,W)).toEqual({messages:1,tasks:0});
    expect(store.list(OWNER,W,"message").items[0]).toMatchObject({body:"Live message 999"});
    store.close();openStores.length=0;

    const resumed=new WorkspaceHistoryStore(file,testHistoryCipher);openStores.push(resumed);
    expect(resumed.getCheckpoint(OWNER,W)).toMatchObject({
      checkpointCursor:"50",sourceCursor:"1",nextOrdinal:"100",totalItems:"150",
    });
    // The same authenticated expired result resumes the existing stage.
    resumed.beginCheckpoint(OWNER,W,expiry());
    resumed.stageCheckpointPage(OWNER,W,response(100,50,150));
    expect(resumed.getCursor(OWNER,W)).toBe("1");
    expect(resumed.finishCheckpoint(OWNER,W)).toBe("50");
    expect(resumed.getCursor(OWNER,W)).toBe("50");
    expect(resumed.getCheckpoint(OWNER,W)).toBeNull();
    expect(resumed.counts(OWNER,W)).toEqual({messages:150,tasks:0});
    const older=resumed.list(OWNER,W,"message");
    expect(older.items).toHaveLength(100);
    expect(resumed.list(OWNER,W,"message",older.nextBefore).items).toHaveLength(50);
    expect(resumed.list(OWNER,W,"message").items.some(x=>x.id===ident(999))).toBe(false);

    resumed.close();openStores.length=0;
    const again=new WorkspaceHistoryStore(file,testHistoryCipher);openStores.push(again);
    expect(again.getCursor(OWNER,W)).toBe("50");
    expect(again.counts(OWNER,W).messages).toBe(150);
  });

  it("rejects incomplete snapshot publication while preserving existing records and cursor",()=>{
    const {store}=disk();base(store);
    store.beginCheckpoint(OWNER,W,expiry());
    store.stageCheckpointPage(OWNER,W,response(0,100,150));
    expect(()=>store.finishCheckpoint(OWNER,W)).toThrow("Incomplete");
    expect(store.getCursor(OWNER,W)).toBe("1");
    expect(store.counts(OWNER,W).messages).toBe(1);
    expect(store.getCheckpoint(OWNER,W)?.nextOrdinal).toBe("100");
  });

  it("rolls back a failed staged page and allows the same request to be retried",()=>{
    const {file,store}=disk();base(store);
    store.beginCheckpoint(OWNER,W,expiry("50","2"));
    const external=new DatabaseSync(file);
    external.exec(`CREATE TRIGGER stage_abort BEFORE INSERT ON checkpoint_records
      WHEN NEW.entity_id='00000000-0000-4000-8000-000000000002'
      BEGIN SELECT RAISE(ABORT,'forced crash'); END;`);
    external.close();
    expect(()=>store.stageCheckpointPage(OWNER,W,response(0,2,2))).toThrow("forced crash");
    expect(store.getCheckpoint(OWNER,W)?.nextOrdinal).toBe("0");
    expect(store.getCursor(OWNER,W)).toBe("1");
    const remove=new DatabaseSync(file);remove.exec("DROP TRIGGER stage_abort");remove.close();
    store.stageCheckpointPage(OWNER,W,response(0,2,2));
    expect(store.finishCheckpoint(OWNER,W)).toBe("50");
    expect(store.counts(OWNER,W).messages).toBe(2);
  });

  it("accepts an empty snapshot and removes all deleted old rows only at final commit",()=>{
    const {store}=disk();base(store);
    store.beginCheckpoint(OWNER,W,expiry("50","0"));
    expect(store.counts(OWNER,W).messages).toBe(1);
    expect(store.finishCheckpoint(OWNER,W)).toBe("50");
    expect(store.counts(OWNER,W).messages).toBe(0);
    expect(store.getCursor(OWNER,W)).toBe("50");
  });

  it("replaces obsolete interrupted staging when a newer server generation is confirmed",()=>{
    const {store}=disk();base(store);
    store.beginCheckpoint(OWNER,W,expiry("50","150"));
    store.stageCheckpointPage(OWNER,W,response(0,100,150));
    store.beginCheckpoint(OWNER,W,expiry("75","1"));
    expect(store.getCheckpoint(OWNER,W)).toMatchObject({
      sourceCursor:"1",checkpointCursor:"75",nextOrdinal:"0",totalItems:"1",
    });
    store.stageCheckpointPage(OWNER,W,response(0,1,1,"75"));
    expect(store.finishCheckpoint(OWNER,W)).toBe("75");
    expect(store.counts(OWNER,W).messages).toBe(1);
    expect(store.list(OWNER,W,"message").items[0]).toMatchObject({id:ident(1)});
  });

  it("rejects fabricated server rows and does not mutate current cache",()=>{
    const {store}=disk();base(store);
    store.beginCheckpoint(OWNER,W,expiry("50","1"));
    const bad=response(0,1,1);
    bad.items[0].record.workspace_id=SECOND;
    expect(()=>store.stageCheckpointPage(OWNER,W,bad)).toThrow("ownership");
    expect(store.getCheckpoint(OWNER,W)?.nextOrdinal).toBe("0");
    expect(store.getCursor(OWNER,W)).toBe("1");
  });

  it("purges BOTH published rows and the unpublished stage when workspace access is revoked",()=>{
    const {store}=disk();base(store);
    store.beginCheckpoint(OWNER,W,expiry("50","1"));
    store.stageCheckpointPage(OWNER,W,response(0,1,1));
    store.revoke(OTHER,W);
    expect(store.getCursor(OWNER,W)).toBe("1");
    store.revoke(OWNER,SECOND);
    expect(store.getCheckpoint(OWNER,W)).not.toBeNull();
    store.revoke(OWNER,W);
    expect(store.getCheckpoint(OWNER,W)).toBeNull();
    expect(store.hasProgress(OWNER,W)).toBe(false);
    expect(store.counts(OWNER,W)).toEqual({messages:0,tasks:0});
    expect(()=>store.finishCheckpoint(OWNER,W)).toThrow("Incomplete");
  });
});
