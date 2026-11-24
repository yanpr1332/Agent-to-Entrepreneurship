import {afterEach,describe,expect,it,vi} from "vitest";
import {WorkspaceHistoryService} from "./workspace-history-service";
import {WorkspaceHistoryStore} from "./workspace-history-store";
import type {SharedCloudClient} from "./supabase-client";
import type {SharedMember,SharedMessage,SharedTask} from "../../shared/cloud-model";

const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const OTHER="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const W="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
function id(n:number){return "00000000-0000-4000-8000-"+n.toString(16).padStart(12,"0");}
const baseTime="2026-11-24T12:00:00.000Z";
function member():SharedMember{
  return {workspace_id:W,user_id:OWNER,role:"member",display_name:"Owner",joined_at:baseTime};
}
function payload(n:number):SharedMessage{
  return {id:id(n),workspace_id:W,author_id:OWNER,body:"Message "+n,
    created_at:new Date(Date.UTC(2026,10,24,12,0,n%60)).toISOString()};
}
function response(start:number,end:number,server=end,hasMore=false){
  return {changes:Array.from({length:end-start},(_,i)=>{
    const n=start+i+1;
    return {cursor:String(n),kind:"message",action:"upsert",entityId:id(n),record:payload(n)};
  }),nextCursor:String(end),serverCursor:String(server),hasMore};
}
const opened:WorkspaceHistoryStore[]=[];
function setup(){
  let owner=OWNER,project="https://first.supabase.co",authorized=true;
  const store=new WorkspaceHistoryStore(":memory:");
  opened.push(store);
  const client={
    currentUserId:vi.fn(()=>owner),
    currentProjectUrl:vi.fn(()=>project),
    listMembers:vi.fn(async()=>authorized?[member()]:[]),
    workspaceSnapshot:vi.fn(async()=>({workspaceId:W,members:[member()],
      messages:[payload(1)],tasks:[] as SharedTask[]})),
    pullWorkspaceHistory:vi.fn(async(_workspace:string,cursor:string)=>({
      changes:[],nextCursor:cursor,serverCursor:cursor,hasMore:false,
    })),
  };
  const service=new WorkspaceHistoryService(client as unknown as SharedCloudClient,store);
  return {service,store,client,setOwner:(v:string)=>{owner=v;},
    setProject:(v:string)=>{project=v;},
    setAuthorized:(v:boolean)=>{authorized=v;}};
}
afterEach(()=>{while(opened.length)opened.pop()!.close();});

describe("ALPHA-SYNC-003B bounded team journal catch-up",()=>{
  it("synchronizes 205 rows across three cursor pages, then loads older local history",async()=>{
    const m=setup();
    m.client.pullWorkspaceHistory.mockImplementation(async(_w,cursor)=>{
      if(cursor==="0")return response(0,100,205,true);
      if(cursor==="100")return response(100,200,205,true);
      if(cursor==="200")return response(200,205,205,false);
      return {changes:[],nextCursor:"205",serverCursor:"205",hasMore:false};
    });
    const first=await m.service.snapshot(W);
    expect(first.history).toMatchObject({
      mode:"durable",cursor:"205",applied:205,hasMore:false,totalMessages:205,totalTasks:0,
    });
    expect(first.messages).toHaveLength(100);
    const marker={createdAt:first.messages.at(-1)!.created_at,id:first.messages.at(-1)!.id};
    const second=await m.service.older(W,"message",marker);
    expect(second.items).toHaveLength(100);
    expect(second.hasMore).toBe(true);
    const third=await m.service.older(W,"message",second.nextBefore);
    expect(third.items).toHaveLength(5);
    expect(new Set([...first.messages,...second.items,...third.items].map(x=>x.id)).size).toBe(205);
    const repeated=await m.service.snapshot(W);
    expect(repeated.history?.applied).toBe(0);
    expect(m.client.pullWorkspaceHistory).toHaveBeenLastCalledWith(W,"205",100);
  });

  it("uses legacy RLS snapshots only when the optional RPC truly does not exist",async()=>{
    const m=setup();
    m.client.pullWorkspaceHistory.mockRejectedValueOnce(Error("Cloud request rejected (HTTP 404)"));
    const result=await m.service.snapshot(W);
    expect(result.history?.mode).toBe("fallback");
    expect(result.messages).toHaveLength(1);
    expect(m.client.workspaceSnapshot).toHaveBeenCalledOnce();
    expect(m.store.hasProgress(OWNER,W)).toBe(false);
    expect(m.client.listMembers).toHaveBeenCalledOnce();
  });

  it("does not treat authorization, malformed pages or network failures as absence of RPC",async()=>{
    for(const e of [
      Error("Cloud authorization failed or server-side workspace access was denied"),
      Error("Cloud service is unreachable"),
    ]){
      const m=setup();
      m.client.pullWorkspaceHistory.mockRejectedValueOnce(e);
      await expect(m.service.snapshot(W)).rejects.toThrow(e.message);
      expect(m.client.workspaceSnapshot).not.toHaveBeenCalled();
    }
    const bad=setup();
    bad.client.pullWorkspaceHistory.mockResolvedValueOnce(response(1,2));
    await expect(bad.service.snapshot(W)).rejects.toThrow("sequence gap");
    expect(bad.client.workspaceSnapshot).not.toHaveBeenCalled();
  });

  it("rejects membership before querying history and purges previously verified rows",async()=>{
    const m=setup();
    m.client.pullWorkspaceHistory.mockResolvedValueOnce(response(0,1));
    await m.service.snapshot(W);
    m.setAuthorized(false);
    await expect(m.service.snapshot(W)).rejects.toThrow("membership revoked");
    expect(m.client.pullWorkspaceHistory).toHaveBeenCalledTimes(1);
    m.setAuthorized(true);
    const page=await m.service.snapshot(W);
    expect(page.history?.cursor).toBe("0");
    expect(page.messages).toEqual([]);
  });

  it("never reads cached content for a different account or project even with the same workspace UUID",async()=>{
    const m=setup();
    m.client.pullWorkspaceHistory.mockResolvedValueOnce(response(0,1));
    await m.service.snapshot(W);
    m.setProject("https://other.supabase.co");
    m.service.cancel();
    const different=await m.service.snapshot(W);
    expect(different.history?.cursor).toBe("0");
    expect(different.messages).toEqual([]);
    m.setProject("https://first.supabase.co");
    m.service.cancel();
    expect((await m.service.snapshot(W)).messages).toHaveLength(1);
  });

  it("blocks account or project switch during a delayed history page",async()=>{
    const m=setup();
    let resolve:(v:unknown)=>void=()=>{};
    m.client.pullWorkspaceHistory.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const job=m.service.snapshot(W);
    // Ensure service has passed membership and started network pull.
    for(let i=0;i<8;i++)await Promise.resolve();
    m.service.cancel();
    m.setProject("https://next.supabase.co");
    resolve(response(0,1));
    await expect(job).rejects.toThrow("project changed");
    m.setProject("https://first.supabase.co");
    expect((await m.service.snapshot(W)).messages).toEqual([]);
  });

  it("ensures a fresh server membership check for every historical page",async()=>{
    const m=setup();
    m.client.pullWorkspaceHistory.mockResolvedValueOnce(response(0,2));
    await m.service.snapshot(W);
    m.setAuthorized(false);
    await expect(m.service.older(W,"message",null)).rejects.toThrow("membership revoked");
    m.setAuthorized(true);
    await expect(m.service.older(W,"message",null)).rejects.toThrow("unavailable");
  });

  it("deduplicates concurrent calls within the same signed-in account and workspace",async()=>{
    const m=setup();
    let resolve:(v:unknown)=>void=()=>{};
    m.client.pullWorkspaceHistory.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const one=m.service.snapshot(W),two=m.service.snapshot(W);
    expect(one).toBe(two);
    for(let i=0;i<8;i++)await Promise.resolve();
    resolve(response(0,1));
    const a=await one,b=await two;
    expect(a.history?.cursor).toBe("1");
    expect(b.messages).toHaveLength(1);
    expect(m.client.pullWorkspaceHistory).toHaveBeenCalledTimes(1);
  });

  it("caps each catchup to 20 pages and resumes next time without resets",async()=>{
    const m=setup();
    m.client.pullWorkspaceHistory.mockImplementation(async(_w,cursor)=>{
      const start=Number(cursor);
      if(start===2100)return {changes:[],nextCursor:"2100",serverCursor:"2100",hasMore:false};
      return response(start,start+100,2100,start+100<2100);
    });
    const first=await m.service.snapshot(W);
    expect(first.history).toMatchObject({cursor:"2000",applied:2000,hasMore:true});
    const next=await m.service.snapshot(W);
    expect(next.history).toMatchObject({cursor:"2100",applied:100,hasMore:false,
      totalMessages:2100});
  });
});
