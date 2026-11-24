import {afterEach,describe,expect,it,vi} from "vitest";
import {WorkspaceHistoryStore} from "./workspace-history-store";
import {testHistoryCipher} from "./workspace-history-crypto.test-helper";
import {WorkspaceHistoryService} from "./workspace-history-service";
import type {SharedCloudClient} from "./supabase-client";
import type {SharedMember,SharedMessage,SharedTask} from "../../shared/cloud-model";

const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const W="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const id=(n:number)=>"00000000-0000-4000-8000-"+n.toString(16).padStart(12,"0");
const now="2026-11-24T10:00:00.000Z";
const record=(n:number):SharedMessage=>({
  id:id(n),workspace_id:W,author_id:OWNER,
  body:"Message "+n,created_at:now,
});
const member:SharedMember={workspace_id:W,user_id:OWNER,role:"owner",
  display_name:"Owner",joined_at:now};
function expiry(cursor="50",total="2"){
  return {status:"expired",checkpointCursor:cursor,serverCursor:cursor,totalItems:total};
}
function snapshot(start:number,count:number,total:number,checkpoint="50"){
  return {checkpointCursor:checkpoint,totalItems:String(total),
    items:Array.from({length:count},(_,i)=>{
      const n=start+i+1;
      return {ordinal:String(n),kind:"message",entityId:id(n),record:record(n)};
    }),nextOrdinal:String(start+count),hasMore:start+count<total};
}
const active:WorkspaceHistoryStore[]=[];
function setup(){
  let owner=OWNER,authorized=true;
  const store=new WorkspaceHistoryStore(":memory:",testHistoryCipher);active.push(store);
  const cloud={
    currentUserId:vi.fn(()=>owner),
    currentProjectUrl:vi.fn(()=>"https://test-project.supabase.co"),
    listMembers:vi.fn(async()=>authorized?[member]:[]),
    workspaceSnapshot:vi.fn(async()=>({workspaceId:W,members:[member],
      messages:[],tasks:[] as SharedTask[]})),
    pullWorkspaceHistory:vi.fn(async(_workspace:string,cursor:string):Promise<unknown>=>
      cursor==="0"?expiry():{changes:[],nextCursor:cursor,serverCursor:cursor,hasMore:false}),
    pullWorkspaceCheckpoint:vi.fn(async(_w:string,_checkpoint:string,
      from:string):Promise<unknown>=>snapshot(Number(from),2-Number(from),2)),
  };
  const service=new WorkspaceHistoryService(cloud as unknown as SharedCloudClient,store);
  return {cloud,service,store,setOwner:(v:string)=>{owner=v;},
    revoke:()=>{authorized=false;}};
}
afterEach(()=>{while(active.length)active.pop()!.close();});

describe("ALPHA-SYNC-003C authenticated full checkpoint recovery",()=>{
  it("replaces older records before fetching post-checkpoint updates",async()=>{
    const m=setup();
    m.cloud.pullWorkspaceHistory.mockImplementation(async(_w,cursor)=>{
      if(cursor==="0")return expiry();
      if(cursor==="50")return {changes:[
        {cursor:"51",kind:"message",action:"delete",entityId:id(1),record:null},
        {cursor:"52",kind:"message",action:"upsert",entityId:id(3),record:record(3)},
      ],nextCursor:"52",serverCursor:"52",hasMore:false};
      return {changes:[],nextCursor:cursor,serverCursor:cursor,hasMore:false};
    });
    const result=await m.service.snapshot(W);
    expect(result.history).toMatchObject({mode:"durable",cursor:"52",
      rebuilding:false,checkpointCursor:"50",hasMore:false});
    expect(result.messages.map(x=>x.id).sort()).toEqual([id(2),id(3)]);
    expect(m.cloud.listMembers).toHaveBeenCalledTimes(2); // before pull + before publishing
    expect(m.cloud.workspaceSnapshot).not.toHaveBeenCalled();
  });

  it("uses a hard 20-page ceiling and does not expose a partial baseline",async()=>{
    const m=setup();
    const total=2105;
    m.cloud.pullWorkspaceHistory.mockImplementation(async(_w,cursor):Promise<unknown>=>
      cursor==="0"?expiry("50",String(total)):
        {changes:[],nextCursor:cursor,serverCursor:cursor,hasMore:false});
    m.cloud.pullWorkspaceCheckpoint.mockImplementation(async(_w,checkpoint,from)=>{
      const start=Number(from),count=Math.min(100,total-start);
      return snapshot(start,count,total,checkpoint);
    });
    const first=await m.service.snapshot(W);
    expect(first.history).toMatchObject({mode:"durable",cursor:"0",
      rebuilding:true,checkpointCursor:"50",hasMore:true});
    expect(first.messages).toEqual([]);
    expect(first.tasks).toEqual([]);
    expect(m.cloud.pullWorkspaceCheckpoint).toHaveBeenCalledTimes(19);
    const second=await m.service.snapshot(W);
    expect(second.history).toMatchObject({cursor:"50",rebuilding:false,hasMore:false,
      totalMessages:2105});
    expect(second.messages).toHaveLength(100);
    expect(m.cloud.pullWorkspaceCheckpoint).toHaveBeenCalledTimes(22);
    expect((await m.service.older(W,"message",null)).items).toHaveLength(100);
  });

  it("refuses missing snapshot RPC and malformed checkpoint without fallback or cursor reset",async()=>{
    for(const err of [Error("Cloud request rejected (HTTP 404)"),
      Error("Cloud authorization failed or server-side workspace access was denied")]){
      const m=setup();
      m.cloud.pullWorkspaceCheckpoint.mockRejectedValueOnce(err);
      await expect(m.service.snapshot(W)).rejects.toThrow(err.message);
      expect(m.cloud.workspaceSnapshot).not.toHaveBeenCalled();
      expect(m.cloud.pullWorkspaceHistory).toHaveBeenCalledOnce();
    }
    const m=setup();
    m.cloud.pullWorkspaceCheckpoint.mockResolvedValueOnce({
      ...snapshot(0,2,2),checkpointCursor:"51",
    });
    await expect(m.service.snapshot(W)).rejects.toThrow("generation");
    expect(m.cloud.workspaceSnapshot).not.toHaveBeenCalled();
  });

  it("rechecks membership before making complete recovery visible and erases old stage on revoke",async()=>{
    const m=setup();
    m.cloud.listMembers.mockImplementationOnce(async()=>[member])
      .mockImplementationOnce(async()=>[]);
    await expect(m.service.snapshot(W)).rejects.toThrow("membership revoked");
    expect(m.cloud.listMembers).toHaveBeenCalledTimes(2);
    expect(m.cloud.workspaceSnapshot).not.toHaveBeenCalled();
  });

  it("does not publish an in-flight checkpoint page after cloud account switches",async()=>{
    const m=setup();
    let resolve:(raw:unknown)=>void=()=>{};
    let signal:()=>void=()=>{};
    const started=new Promise<void>(r=>{signal=r;});
    m.cloud.pullWorkspaceCheckpoint.mockImplementationOnce(()=>new Promise(r=>{
      resolve=r;signal();
    }));
    const pending=m.service.snapshot(W);
    await started;
    m.service.cancel();
    m.setOwner("9db8a5cb-1d6c-4e93-807e-e18be4b482a1");
    resolve(snapshot(0,2,2));
    await expect(pending).rejects.toThrow("project changed");
    expect(m.cloud.workspaceSnapshot).not.toHaveBeenCalled();
  });

  it("blocks older-page reads while an expired snapshot is being rebuilt",async()=>{
    const m=setup();
    const total=2105;
    m.cloud.pullWorkspaceHistory.mockImplementation(async(_w,cursor):Promise<unknown>=>
      cursor==="0"?expiry("50",String(total)):
        {changes:[],nextCursor:cursor,serverCursor:cursor,hasMore:false});
    m.cloud.pullWorkspaceCheckpoint.mockImplementation(async(_w,cp,from)=>{
      const start=Number(from);return snapshot(start,Math.min(100,total-start),total,cp);
    });
    await m.service.snapshot(W);
    await expect(m.service.older(W,"message",null)).rejects.toThrow("rebuild");
    expect(m.cloud.listMembers).toHaveBeenCalledTimes(2);
  });
});
