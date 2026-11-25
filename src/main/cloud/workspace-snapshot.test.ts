import {describe,expect,it,vi} from "vitest";
import {SharedCloudClient} from "./supabase-client";
import type {SharedMember} from "../../shared/cloud-model";

const projectUrl="https://schooltest.supabase.co";
const publicKey="sb_publishable_abcdefghijklmnopqrstuvwxyz12345";
const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const OTHER="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const WORKSPACE="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const MEMBERS:SharedMember[]=[{
  workspace_id:WORKSPACE,user_id:OWNER,role:"member",
  display_name:"Owner",joined_at:"2026-11-24T12:00:00.000Z",
}];
function make(fetchData:(url:string)=>unknown){
  const calls:string[]=[];
  const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
    calls.push(url);
    if(url.includes("/auth/v1/"))return new Response(JSON.stringify({
      access_token:"real-JWT-only-main",refresh_token:"secret-refresh",expires_in:3600,
      user:{id:OWNER,email:"owner@example.edu"},
    }));
    expect((init.headers as Record<string,string>).Authorization).toBe("Bearer real-JWT-only-main");
    return new Response(JSON.stringify(fetchData(url)),{status:200});
  });
  const cloud=new SharedCloudClient(fetcher);
  cloud.configure({projectUrl,publishableKey:publicKey});
  return {cloud,calls,fetcher};
}
describe("ALPHA-SYNC-003A: RLS-verified snapshots and private socket auth",()=>{
  it("returns a Main-only wss endpoint; only a public key is in the socket URL",async()=>{
    const m=make(()=>[]);
    await m.cloud.login({email:"owner@example.edu",password:"valid-password"});
    const credentials=await m.cloud.realtimeCredentials();
    expect(credentials.url).toContain("wss://schooltest.supabase.co/realtime/v1/websocket?apikey=");
    expect(credentials.url).toContain("vsn=1.0.0");
    expect(credentials.url).not.toContain(credentials.accessToken);
    expect(credentials.url).not.toContain("secret-refresh");
    expect(credentials).toMatchObject({accessToken:"real-JWT-only-main",userId:OWNER});
    expect(credentials.expiresAt).toBeGreaterThan(Date.now());
  });

  it("fetches members before content and returns a coherent scoped snapshot",async()=>{
    const m=make(url=>{
      if(url.includes("ate_workspace_members"))return MEMBERS;
      if(url.includes("ate_workspace_messages"))return [{
        id:"3a7cae55-a7c0-4fdd-9ef6-296fda99c5b4",
        workspace_id:WORKSPACE,author_id:OWNER,body:"Hello",created_at:"2026-11-24T10:00:00Z",
      }];
      if(url.includes("ate_workspace_tasks"))return [{
        id:"f073b3a3-e6f9-4813-a5bf-ab3a1c7ef63d",workspace_id:WORKSPACE,
        created_by:OWNER,title:"Plan",assigned_to:null,due_date:null,
        completed:false,created_at:"2026-11-24T10:00:00Z",updated_at:"2026-11-24T10:00:00Z",
      }];
      throw Error("unexpected endpoint "+url);
    });
    await m.cloud.login({email:"owner@example.edu",password:"valid-password"});
    const result=await m.cloud.workspaceSnapshot(WORKSPACE);
    expect(result).toMatchObject({workspaceId:WORKSPACE,members:MEMBERS,
      messages:[{body:"Hello"}],tasks:[{title:"Plan"}]});
    expect(m.calls[1]).toContain("ate_workspace_members?");
    expect(m.calls.filter(x=>x.includes("/rest/v1/"))).toHaveLength(3);
  });

  it("refuses stale shared content when membership is absent, with no task or message request",async()=>{
    const m=make(url=>url.includes("ate_workspace_members")?
      [{...MEMBERS[0],user_id:OTHER}]:[]);
    await m.cloud.login({email:"owner@example.edu",password:"valid-password"});
    await expect(m.cloud.workspaceSnapshot(WORKSPACE)).rejects.toThrow("membership revoked");
    expect(m.calls.filter(x=>x.includes("ate_workspace_messages"))).toEqual([]);
    expect(m.calls.filter(x=>x.includes("ate_workspace_tasks"))).toEqual([]);
  });

  it("refuses cross-account snapshots if a user signs out while membership is in flight",async()=>{
    let complete:(value:Response)=>void=()=>{};
    let notifyStarted:()=>void=()=>{};
    const started=new Promise<void>(resolve=>{notifyStarted=resolve;});
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      if(url.includes("/auth/v1/"))return new Response(JSON.stringify({
        access_token:"real-JWT-only-main",refresh_token:"secret-refresh",expires_in:3600,
        user:{id:OWNER,email:"owner@example.edu"},
      }));
      notifyStarted();
      return new Promise<Response>(resolve=>{complete=resolve;});
    });
    const cloud=new SharedCloudClient(fetcher);
    cloud.configure({projectUrl,publishableKey:publicKey});
    await cloud.login({email:"owner@example.edu",password:"valid-password"});
    const job=cloud.workspaceSnapshot(WORKSPACE);
    await started;
    cloud.signOut();
    complete(new Response(JSON.stringify(MEMBERS)));
    await expect(job).rejects.toThrow("Cloud account or project changed during request");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not allow a realtime URL from a non-Supabase host",async()=>{
    const cloud=new SharedCloudClient(async()=>new Response("{}"));
    expect(()=>cloud.configure({projectUrl:"https://evil.example.com",publishableKey:publicKey}))
      .toThrow("Only standard public Supabase");
    await expect(cloud.realtimeCredentials()).rejects.toThrow("Configure");
  });
});
