import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {WorkspaceHistoryStore} from "./workspace-history-store";
import {testHistoryCipher} from "./workspace-history-crypto.test-helper";
import type {WorkspaceHistoryChange} from "../../shared/workspace-history-contract";

const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const OTHER="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const WORKSPACE="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const ELSEWHERE="79c7ba8d-ad06-4c71-8172-672b78b0298d";
const paths:string[]=[];
const opened:WorkspaceHistoryStore[]=[];
function id(n:number){return "00000000-0000-4000-8000-"+n.toString(16).padStart(12,"0");}
function makeDisk(){
  const dir=mkdtempSync(join(tmpdir(),"ate-team-history-"));
  paths.push(dir);
  const file=join(dir,"shared.sqlite");
  const store=new WorkspaceHistoryStore(file,testHistoryCipher);
  opened.push(store);
  return {file,store};
}
function change(seq:number,kind:"message"|"task"="message"):WorkspaceHistoryChange{
  const entityId=id(seq);
  const at=new Date(Date.UTC(2026,10,24,10,0,seq%60)).toISOString();
  return {cursor:String(seq),kind,action:"upsert",entityId,
    record:kind==="message"?
      {id:entityId,workspace_id:WORKSPACE,author_id:OWNER,
        body:"Historical message "+seq,created_at:at}:
      {id:entityId,workspace_id:WORKSPACE,created_by:OWNER,
        title:"Historical task "+seq,due_date:null,assigned_to:null,
        completed:false,created_at:at,updated_at:at}};
}
function page(start:number,end:number){
  return {changes:Array.from({length:end-start},(_,i)=>change(start+i+1)),
    nextCursor:String(end),serverCursor:String(end),hasMore:false};
}
afterEach(()=>{
  while(opened.length){try{opened.pop()?.close();}catch{/* already closed */}}
  while(paths.length)rmSync(paths.pop()!,{recursive:true,force:true});
});

describe("ALPHA-SYNC-003B durable workspace SQLite store",()=>{
  it("persists >100 historical messages and a cursor across actual process-style reopens",()=>{
    const {file,store}=makeDisk();
    for(const [from,to] of [[0,100],[100,200],[200,205]]){
      const result=store.applyPage(OWNER,WORKSPACE,page(from,to));
      expect(result.nextCursor).toBe(String(to));
    }
    expect(store.getCursor(OWNER,WORKSPACE)).toBe("205");
    expect(store.counts(OWNER,WORKSPACE)).toEqual({messages:205,tasks:0});
    store.close();opened.length=0;
    const reopened=new WorkspaceHistoryStore(file,testHistoryCipher);opened.push(reopened);
    expect(reopened.getCursor(OWNER,WORKSPACE)).toBe("205");
    const first=reopened.list(OWNER,WORKSPACE,"message");
    expect(first.items).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    const second=reopened.list(OWNER,WORKSPACE,"message",first.nextBefore);
    expect(second.items).toHaveLength(100);
    const third=reopened.list(OWNER,WORKSPACE,"message",second.nextBefore);
    expect(third.items).toHaveLength(5);
    expect(third.hasMore).toBe(false);
    expect(new Set([...first.items,...second.items,...third.items].map(x=>x.id)).size)
      .toBe(205);
    expect(reopened.getCursor(OWNER,WORKSPACE)).toBe("205");
  });

  it("applies tombstones and updates without duplicated historical entities",()=>{
    const {store}=makeDisk();
    store.applyPage(OWNER,WORKSPACE,{changes:[change(1),change(2,"task")],
      nextCursor:"2",serverCursor:"2",hasMore:false});
    const changed={...change(2,"task"),cursor:"3",record:{
      ...change(2,"task").record,title:"Updated title",completed:true,
    }};
    store.applyPage(OWNER,WORKSPACE,{changes:[changed],
      nextCursor:"3",serverCursor:"3",hasMore:false});
    expect(store.counts(OWNER,WORKSPACE)).toEqual({messages:1,tasks:1});
    expect(store.list(OWNER,WORKSPACE,"task").items[0]).toMatchObject({
      title:"Updated title",completed:true,
    });
    store.applyPage(OWNER,WORKSPACE,{changes:[{
      cursor:"4",kind:"message",action:"delete",entityId:id(1),record:null,
    }],nextCursor:"4",serverCursor:"4",hasMore:false});
    expect(store.counts(OWNER,WORKSPACE)).toEqual({messages:0,tasks:1});
    expect(store.getCursor(OWNER,WORKSPACE)).toBe("4");
    store.applyPage(OWNER,WORKSPACE,{changes:[],nextCursor:"4",
      serverCursor:"4",hasMore:false});
    expect(store.getCursor(OWNER,WORKSPACE)).toBe("4");
  });

  it("atomically rolls back an interrupted page without advancing the cursor",()=>{
    const {file,store}=makeDisk();
    store.applyPage(OWNER,WORKSPACE,page(0,1));
    const external=new DatabaseSync(file);
    external.exec(`CREATE TRIGGER simulate_failure BEFORE INSERT ON records
      WHEN NEW.entity_id='00000000-0000-4000-8000-000000000003'
      BEGIN SELECT RAISE(ABORT,'Simulated interruption'); END;`);
    external.close();
    expect(()=>store.applyPage(OWNER,WORKSPACE,page(1,3)))
      .toThrow("Simulated interruption");
    expect(store.getCursor(OWNER,WORKSPACE)).toBe("1");
    expect(store.counts(OWNER,WORKSPACE).messages).toBe(1);
    const repair=new DatabaseSync(file);repair.exec("DROP TRIGGER simulate_failure");repair.close();
    store.applyPage(OWNER,WORKSPACE,page(1,3));
    expect(store.getCursor(OWNER,WORKSPACE)).toBe("3");
    expect(store.counts(OWNER,WORKSPACE).messages).toBe(3);
  });

  it("rejects invalid cursor, noncontiguous pages and foreign-workspace payloads",()=>{
    const {store}=makeDisk();
    expect(()=>store.applyPage(OWNER,WORKSPACE,{changes:[change(2)],
      nextCursor:"2",serverCursor:"2",hasMore:false})).toThrow("sequence gap");
    expect(()=>store.applyPage(OWNER,WORKSPACE,{changes:[{
      ...change(1),record:{...change(1).record,workspace_id:ELSEWHERE},
    }],nextCursor:"1",serverCursor:"1",hasMore:false})).toThrow("ownership");
    expect(store.hasProgress(OWNER,WORKSPACE)).toBe(false);
    expect(store.getCursor(OWNER,WORKSPACE)).toBe("0");
  });

  it("does not allow another owner or workspace to read or delete this cache",()=>{
    const {store}=makeDisk();
    store.applyPage(OWNER,WORKSPACE,page(0,2));
    expect(store.getCursor(OTHER,WORKSPACE)).toBe("0");
    expect(store.hasProgress(OTHER,WORKSPACE)).toBe(false);
    expect(()=>store.list(OTHER,WORKSPACE,"message")).toThrow("verified");
    expect(()=>store.list(OWNER,ELSEWHERE,"message")).toThrow("verified");
    store.revoke(OTHER,WORKSPACE);
    store.revoke(OWNER,ELSEWHERE);
    expect(store.getCursor(OWNER,WORKSPACE)).toBe("2");
    store.revoke(OWNER,WORKSPACE);
    expect(store.getCursor(OWNER,WORKSPACE)).toBe("0");
    expect(store.counts(OWNER,WORKSPACE).messages).toBe(0);
  });

  it("blocks tampered local cursor and future schema downgrade",()=>{
    const {file,store}=makeDisk();
    store.applyPage(OWNER,WORKSPACE,page(0,1));
    store.close();opened.length=0;
    const sqlite=new DatabaseSync(file);
    sqlite.prepare("UPDATE progress SET cursor=?").run("9223372036854775808");
    sqlite.close();
    const corrupted=new WorkspaceHistoryStore(file,testHistoryCipher);opened.push(corrupted);
    expect(()=>corrupted.getCursor(OWNER,WORKSPACE)).toThrow("cursor");
    corrupted.close();opened.length=0;
    const modified=new DatabaseSync(file);
    modified.exec("PRAGMA user_version=4");modified.close();
    expect(()=>new WorkspaceHistoryStore(file,testHistoryCipher)).toThrow("newer app");
  });
});
