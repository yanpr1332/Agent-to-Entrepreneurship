import {afterEach,describe,expect,it,vi} from "vitest";
import {WorkspaceRealtimeBridge,type RealtimeSocket} from "./workspace-realtime";
import type {WorkspaceLiveUpdate,SharedMember} from "../../shared/cloud-model";
import type {SharedCloudClient} from "./supabase-client";

const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const OTHER="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const FIRST="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const SECOND="79c7ba8d-ad06-4c71-8172-672b78b0298d";

class FakeSocket implements RealtimeSocket{
  readyState=1;
  onopen:(()=>void)|null=null;
  onmessage:((event:{data:unknown})=>void)|null=null;
  onerror:(()=>void)|null=null;
  onclose:(()=>void)|null=null;
  sent:string[]=[];
  closed=false;
  send(v:string){this.sent.push(v);}
  close(){this.closed=true;}
  open(){this.onopen?.();}
  receive(value:unknown){this.onmessage?.({data:typeof value==="string"?value:JSON.stringify(value)});}
  fail(){this.onerror?.();}
}
function mocks(){
  let owner=OWNER;
  let authorized=true;
  const cloud={
    currentUserId:vi.fn(()=>owner),
    realtimeCredentials:vi.fn(async()=>({
      url:"wss://demo.supabase.co/realtime/v1/websocket?apikey=public&vsn=1.0.0",
      accessToken:"private-user-jwt",userId:owner,expiresAt:Date.now()+3600_000,
    })),
    listMembers:vi.fn(async(workspaceId:string):Promise<SharedMember[]>=>authorized
      ?[{workspace_id:workspaceId,user_id:owner,role:"member",display_name:"Member",joined_at:"2026-11-24T00:00:00Z"}]
      :[]),
  };
  const events:WorkspaceLiveUpdate[]=[];
  const sockets:FakeSocket[]=[];
  const urls:string[]=[];
  const bridge=new WorkspaceRealtimeBridge(cloud as unknown as SharedCloudClient,
    update=>events.push(update),url=>{
      urls.push(url);
      const socket=new FakeSocket();sockets.push(socket);
      return socket;
    });
  return {bridge,cloud,events,sockets,urls,changeOwner:(id:string)=>{owner=id;},
    setAuthorized:(value:boolean)=>{authorized=value;}};
}
async function tick(){
  // Promise.all/listMembers + credentials are microtask-bound.
  for(let i=0;i<7;i++)await Promise.resolve();
}
function join(socket:FakeSocket){
  socket.open();
  const frame=JSON.parse(socket.sent[0]) as {ref:string;payload:{access_token:string;config:{postgres_changes:unknown[]}};topic:string;event:string};
  socket.receive({topic:frame.topic,ref:frame.ref,event:"phx_reply",payload:{
    status:"ok",response:{postgres_changes:[{id:11},{id:12}]},
  }});
  return frame;
}
afterEach(()=>vi.useRealTimers());

describe("ALPHA-SYNC-003A: Main-only Realtime transport",()=>{
  it("never opens a socket for a nonmember or unauthenticated owner",async()=>{
    const m=mocks();
    m.setAuthorized(false);
    await expect(m.bridge.watch(FIRST)).rejects.toThrow("membership");
    expect(m.sockets).toHaveLength(0);
    expect(m.events.at(-1)).toMatchObject({workspaceId:FIRST,phase:"revoked",hint:false});
    m.bridge.stop();
  });

  it("sends only a scoped topic and Main JWT in join, and emits content-free hints",async()=>{
    const m=mocks();
    await m.bridge.watch(FIRST);
    await tick();
    expect(m.sockets).toHaveLength(1);
    const frame=join(m.sockets[0]);
    expect(frame.topic).toBe("realtime:ate-workspace-"+FIRST);
    expect(frame.event).toBe("phx_join");
    expect(frame.payload.access_token).toBe("private-user-jwt");
    expect(frame.payload.config.postgres_changes).toEqual([
      {event:"*",schema:"public",table:"ate_workspace_messages",filter:"workspace_id=eq."+FIRST},
      {event:"*",schema:"public",table:"ate_workspace_tasks",filter:"workspace_id=eq."+FIRST},
    ]);
    expect(m.urls[0]).not.toContain("private-user-jwt");
    expect(m.events.at(-1)).toEqual({workspaceId:FIRST,phase:"live",hint:true});
    const before=m.events.length;
    m.sockets[0].receive({topic:"realtime:other",event:"postgres_changes",payload:{body:"malicious"}});
    expect(m.events).toHaveLength(before);
    m.sockets[0].receive({topic:frame.topic,event:"postgres_changes",
      payload:{body:"NEVER FORWARD"},ref:null});
    expect(m.events.at(-1)).toEqual({workspaceId:FIRST,phase:"live",hint:true});
    expect(JSON.stringify(m.events)).not.toContain("NEVER FORWARD");
    m.bridge.stop();
  });

  it("does not treat a join without both table subscriptions as live",async()=>{
    vi.useFakeTimers();
    const m=mocks();
    await m.bridge.watch(FIRST);await tick();
    const socket=m.sockets[0];
    socket.open();
    const frame=JSON.parse(socket.sent[0]) as {topic:string;ref:string};
    socket.receive({topic:frame.topic,ref:frame.ref,event:"phx_reply",payload:{
      status:"ok",response:{postgres_changes:[]},
    }});
    expect(m.bridge.getStatus()).toMatchObject({phase:"fallback"});
    expect(socket.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    expect(m.sockets).toHaveLength(2);
    expect(m.cloud.listMembers).toHaveBeenCalledTimes(3); // initial + first + retry
    m.bridge.stop();
  });

  it("revalidates owner/membership on reconnect and fails closed after revoke",async()=>{
    vi.useFakeTimers();
    const m=mocks();
    await m.bridge.watch(FIRST);await tick();
    join(m.sockets[0]);
    m.setAuthorized(false);
    m.sockets[0].fail();
    expect(m.bridge.getStatus()).toMatchObject({phase:"fallback"});
    await vi.advanceTimersByTimeAsync(1000);await tick();
    expect(m.bridge.getStatus()).toMatchObject({phase:"revoked"});
    expect(m.sockets).toHaveLength(1);
    expect(m.sockets[0].closed).toBe(true);
    m.bridge.stop();
  });

  it("stops the old subscription on workspace switch; stale callbacks cannot emit",async()=>{
    const m=mocks();
    await m.bridge.watch(FIRST);await tick();
    const old=m.sockets[0];
    const oldHandler=old.onmessage;
    await m.bridge.watch(SECOND);await tick();
    const recent=m.events.length;
    oldHandler?.({data:JSON.stringify({topic:"realtime:ate-workspace-"+FIRST,event:"postgres_changes"})});
    expect(m.events).toHaveLength(recent);
    expect(old.closed).toBe(true);
    expect(m.bridge.getStatus()?.workspaceId).toBe(SECOND);
    m.bridge.stopWatching(FIRST);
    expect(m.bridge.getStatus()?.workspaceId).toBe(SECOND);
    m.bridge.stopWatching(SECOND);
    expect(m.bridge.getStatus()).toBeNull();
  });

  it("does not open a socket after watch was cancelled during membership lookup",async()=>{
    const m=mocks();
    let resolve:(members:SharedMember[])=>void=()=>{};
    m.cloud.listMembers.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const pending=m.bridge.watch(FIRST);
    m.bridge.stopWatching(FIRST);
    resolve([{workspace_id:FIRST,user_id:OWNER,role:"owner",display_name:"x",joined_at:"2026-11-24"}]);
    await expect(pending).rejects.toThrow("selection changed");
    expect(m.sockets).toHaveLength(0);
  });

  it("falls back to safe polling when FIRST membership check is offline, then reconnects",async()=>{
    vi.useFakeTimers();
    const m=mocks();
    m.cloud.listMembers.mockRejectedValueOnce(Error("Cloud service is unreachable"));
    const result=await m.bridge.watch(FIRST);
    expect(result).toMatchObject({phase:"fallback",hint:false});
    expect(m.sockets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await tick();
    expect(m.cloud.listMembers).toHaveBeenCalledTimes(2);
    expect(m.sockets).toHaveLength(1);
    join(m.sockets[0]);
    expect(m.bridge.getStatus()).toMatchObject({phase:"live"});
    m.bridge.stop();
  });

  it("does not retry initial or reconnect-time 401/403 RLS failures",async()=>{
    vi.useFakeTimers();
    const initial=mocks();
    initial.cloud.listMembers.mockRejectedValueOnce(
      Error("Cloud authorization failed or server-side workspace access was denied"));
    await expect(initial.bridge.watch(FIRST)).rejects.toThrow("authorization");
    expect(initial.bridge.getStatus()).toMatchObject({phase:"revoked"});
    await vi.advanceTimersByTimeAsync(65_000);
    expect(initial.cloud.listMembers).toHaveBeenCalledTimes(1);
    expect(initial.sockets).toHaveLength(0);
    initial.bridge.stop();

    const reconnected=mocks();
    await reconnected.bridge.watch(FIRST);await tick();
    join(reconnected.sockets[0]);
    reconnected.cloud.listMembers.mockRejectedValueOnce(
      Error("Cloud authorization failed or server-side workspace access was denied"));
    reconnected.sockets[0].fail();
    await vi.advanceTimersByTimeAsync(1_000);await tick();
    expect(reconnected.bridge.getStatus()).toMatchObject({phase:"revoked"});
    const calls=reconnected.cloud.listMembers.mock.calls.length;
    await vi.advanceTimersByTimeAsync(65_000);
    expect(reconnected.cloud.listMembers).toHaveBeenCalledTimes(calls);
    expect(reconnected.sockets).toHaveLength(1);
    reconnected.bridge.stop();
  });

  it("does not endlessly reconnect after the signed-in JWT refresh expires",async()=>{
    vi.useFakeTimers();
    const m=mocks();
    await m.bridge.watch(FIRST);await tick();
    join(m.sockets[0]);
    m.cloud.realtimeCredentials.mockRejectedValueOnce(
      Error("Cloud session expired or account changed; log in again"));
    m.sockets[0].fail();
    await vi.advanceTimersByTimeAsync(1_000);await tick();
    expect(m.bridge.getStatus()).toMatchObject({phase:"revoked"});
    const calls=m.cloud.realtimeCredentials.mock.calls.length;
    await vi.advanceTimersByTimeAsync(65_000);
    expect(m.cloud.realtimeCredentials).toHaveBeenCalledTimes(calls);
    m.bridge.stop();
  });

  it("cancels pending offline retry when user switches workspaces or logs out",async()=>{
    vi.useFakeTimers();
    const m=mocks();
    m.cloud.listMembers.mockRejectedValueOnce(Error("fetch failed"));
    await m.bridge.watch(FIRST);
    await m.bridge.watch(SECOND);await tick();
    join(m.sockets[0]);
    const before=m.cloud.listMembers.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(m.cloud.listMembers).toHaveBeenCalledTimes(before);
    expect(m.bridge.getStatus()?.workspaceId).toBe(SECOND);
    m.bridge.stop();
  });

  it("will not reconnect a socket under a different logged-in owner",async()=>{
    vi.useFakeTimers();
    const m=mocks();
    await m.bridge.watch(FIRST);await tick();
    join(m.sockets[0]);
    m.changeOwner(OTHER);
    m.sockets[0].fail();
    await vi.advanceTimersByTimeAsync(1000);await tick();
    expect(m.bridge.getStatus()).toMatchObject({phase:"revoked"});
    expect(m.sockets).toHaveLength(1);
    m.bridge.stop();
  });

  it("rejects malformed/oversized websocket frames without emitting row contents",async()=>{
    const m=mocks();
    await m.bridge.watch(FIRST);await tick();
    const frame=join(m.sockets[0]);
    const len=m.events.length;
    m.sockets[0].receive("bad-json");
    m.sockets[0].receive("x".repeat(65_537));
    m.sockets[0].receive({topic:"realtime:other",event:"postgres_changes"});
    expect(m.events).toHaveLength(len);
    m.sockets[0].receive({topic:frame.topic,event:"postgres_changes",payload:{secret:"x"}});
    expect(m.events).toHaveLength(len+1);
    expect(JSON.stringify(m.events)).not.toContain("secret");
    m.bridge.stop();
  });

  it("times out silent sockets and reconnects with bounded backoff",async()=>{
    vi.useFakeTimers();
    const m=mocks();
    await m.bridge.watch(FIRST);await tick();
    join(m.sockets[0]);
    await vi.advanceTimersByTimeAsync(100_000);
    await tick();
    expect(m.sockets[0].closed).toBe(true);
    // Backoff timer begins after the stale heartbeat is detected.
    await vi.advanceTimersByTimeAsync(1_500);
    await tick();
    expect(m.sockets.length).toBeGreaterThanOrEqual(2);
    m.bridge.stop();
  });
});
