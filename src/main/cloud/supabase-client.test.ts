import { describe,expect,it,vi } from "vitest";
import { SharedCloudClient } from "./supabase-client";

const projectUrl="https://campus-test.supabase.co";
const publishableKey="sb_publishable_abcdefghijklmnopqrstuvwxyz12345";
const userId="d2270e99-fca1-496f-9327-76dcf25e092e";
const workspace="6fe14e93-83cc-46d6-b425-61f5b94a1d90";
const taskId="8efad974-12bd-4d26-a49c-c6078c48e157";
const memberId="d2270e99-fca1-496f-9327-76dcf25e092f";

describe("Supabase candidate: individual JWT + RLS REST boundaries",()=>{
  it("only uses the signed-in person's JWT and never a service key",async()=>{
    const fetcher=vi.fn(async(url:string, init:RequestInit)=>{
      expect(url.startsWith(projectUrl+"/")).toBe(true);
      expect(init.redirect).toBe("error");
      const headers=init.headers as Record<string,string>;
      expect(headers.apikey).toBe(publishableKey);
      if(url.includes("auth/v1/token")){
        expect(headers.Authorization).toBe(`Bearer ${publishableKey}`);
        return new Response(JSON.stringify({
          access_token:"real-user-jwt",refresh_token:"opaque-refresh-token",expires_in:3600,
          user:{id:userId,email:"member@example.edu"},
        }),{status:200});
      }
      expect(headers.Authorization).toBe("Bearer real-user-jwt");
      return new Response(JSON.stringify([{id:workspace,name:"Study Group",created_at:"2026-11-10"}]),{status:200});
    });
    const cloud=new SharedCloudClient(fetcher);
    cloud.configure({projectUrl,publishableKey});
    expect(cloud.status().authenticated).toBe(false);
    await expect(cloud.listWorkspaces()).rejects.toThrow("Log in");
    const status=await cloud.login({email:"member@example.edu",password:"a-strong-password"});
    expect(status).toMatchObject({authenticated:true,userId,email:"member@example.edu"});
    expect(JSON.stringify(status)).not.toContain("refresh");
    expect((await cloud.listWorkspaces())[0].name).toBe("Study Group");
    cloud.signOut();
    expect(cloud.status().authenticated).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("RPC invitations use fixed endpoints, validate input and preserve one-time issued tokens",async()=>{
    const token="a".repeat(48);
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      expect(url.startsWith(projectUrl+"/rest/v1/rpc/ate_")).toBe(true);
      const headers=init.headers as Record<string,string>;
      expect(headers.Authorization).toBe("Bearer user");
      if(url.endsWith("ate_create_workspace"))return new Response(JSON.stringify(workspace));
      if(url.endsWith("ate_create_invite"))return new Response(JSON.stringify(token));
      return new Response(JSON.stringify(workspace));
    });
    const cloud=new SharedCloudClient(async(url,init)=>{
      if(url.includes("/auth/v1/"))return new Response(JSON.stringify({
        access_token:"user",refresh_token:"refresh",expires_in:3600,
        user:{id:userId,email:"owner@example.edu"},
      }));
      return fetcher(url,init);
    });
    cloud.configure({projectUrl,publishableKey});
    await cloud.login({email:"owner@example.edu",password:"strong-password"});
    expect(await cloud.createWorkspace("Project Alpha","Owner")).toBe(workspace);
    expect(await cloud.createInvite(workspace)).toBe(token);
    expect(await cloud.joinWorkspace(token,"Second member")).toBe(workspace);
    await expect(cloud.joinWorkspace("bad","Second")).rejects.toThrow("invitation");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("member revocation uses only a signed-in owner JWT and validates exact RPC success",async()=>{
    const calls:string[]=[];
    let reply:unknown=true;
    const cloud=new SharedCloudClient(async(url,init)=>{
      if(url.includes("/auth/v1/"))return new Response(JSON.stringify({
        access_token:"signed-in-user-jwt",refresh_token:"refresh",expires_in:3600,
        user:{id:userId,email:"owner@example.edu"},
      }));
      expect(url).toBe(projectUrl+"/rest/v1/rpc/ate_revoke_workspace_member");
      expect((init.headers as Record<string,string>).Authorization).toBe("Bearer signed-in-user-jwt");
      expect(JSON.parse(init.body as string)).toEqual({
        p_workspace:workspace,p_user:memberId,
      });
      calls.push("revoke");
      return new Response(JSON.stringify(reply));
    });
    cloud.configure({projectUrl,publishableKey});
    await expect(cloud.revokeWorkspaceMember(workspace,memberId)).rejects.toThrow("Log in");
    await cloud.login({email:"owner@example.edu",password:"strong-password"});
    expect(await cloud.revokeWorkspaceMember(workspace,memberId)).toEqual({revoked:true});
    reply=false;
    await expect(cloud.revokeWorkspaceMember(workspace,memberId))
      .rejects.toThrow("did not confirm");
    await expect(cloud.revokeWorkspaceMember(workspace,"not-uuid")).rejects.toThrow();
    expect(calls).toEqual(["revoke","revoke"]);
  });

  it("shared task mutation sends only user-owned fields via RLS-protected REST",async()=>{
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      if(url.includes("/auth/v1/"))return new Response(JSON.stringify({
        access_token:"jwt",refresh_token:"refresh",expires_in:3600,
        user:{id:userId,email:"person@example.edu"},
      }));
      const body=JSON.parse(init.body as string);
      expect((init.headers as Record<string,string>).Authorization).toBe("Bearer jwt");
      if(init.method==="PATCH"){
        expect(url).toContain(`id=eq.${taskId}`);
        expect(body).toEqual({completed:true});
      } else {
        expect(body).toMatchObject({
          workspace_id:workspace,created_by:userId,title:"Prepare report",
          assigned_to:memberId,completed:false,
        });
      }
      return new Response(JSON.stringify([{
        id:taskId,workspace_id:workspace,created_by:userId,
        title:"Prepare report",completed:init.method==="PATCH",
      }]));
    });
    const cloud=new SharedCloudClient(fetcher);
    cloud.configure({projectUrl,publishableKey});
    await cloud.login({email:"person@example.edu",password:"strong-password"});
    const task=await cloud.createTask(workspace,{
      title:"Prepare report",assignedTo:memberId,dueDate:"2026-11-25",
    });
    expect(task.title).toBe("Prepare report");
    expect((await cloud.markTask(workspace,taskId,true)).completed).toBe(true);
  });

  it("registers an owner-bound device, applies idempotent operations and pulls an ordered cursor page",async()=>{
    const deviceId="6da6f704-5b0c-4e5a-a7dd-dc8db5b4c665";
    const entityId="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
    const op={
      operationId:"ca9c6544-371b-41f2-b621-a956b088c7fb",
      deviceId,actorId:userId,ownerId:userId,entityId,
      entityType:"personal-task",action:"upsert",baseVersion:null,
      clientTimestamp:"2026-11-19T15:30:00.000Z",
      payload:{title:"Prepare report",description:"Study notes",dueDate:null,priority:"normal",completed:false},
    };
    const page={
      changes:[{cursor:"1",entityType:"personal-task",entityId,version:1,
        payload:op.payload,deleted:false,updatedAt:"2026-11-20T10:00:00.000Z"}],
      nextCursor:"1",hasMore:false,
    };
    const calls:string[]=[];
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      const headers=init.headers as Record<string,string>;
      expect(headers.apikey).toBe(publishableKey);
      if(url.includes("/auth/v1/")){
        expect(headers.Authorization).toBe(`Bearer ${publishableKey}`);
        return new Response(JSON.stringify({access_token:"jwt",refresh_token:"refresh",
          expires_in:3600,user:{id:userId,email:"person@example.edu"}}));
      }
      expect(headers.Authorization).toBe("Bearer jwt");
      const body=JSON.parse(init.body as string);
      if(url.endsWith("ate_personal_sync_register_device")){
        calls.push("register");
        expect(body).toEqual({p_device_id:deviceId,p_device_label:"macOS laptop"});
        return new Response(JSON.stringify({ownerId:userId,deviceId,
          createdAt:"2026-11-20T10:00:00.000Z",lastSeenAt:"2026-11-20T10:00:00.000Z"}));
      }
      if(url.endsWith("ate_personal_sync_apply")){
        calls.push("apply");
        expect(body.p_operation).toEqual(op);
        return new Response(JSON.stringify({status:"accepted",serverVersion:1,cursor:"1"}));
      }
      if(url.endsWith("ate_personal_sync_pull")){
        calls.push("pull");
        expect(body).toEqual({p_device_id:deviceId,p_cursor:"0",p_limit:100});
        return new Response(JSON.stringify(page));
      }
      calls.push("revoke");
      expect(body).toEqual({p_device_id:deviceId});
      return new Response("true");
    });
    const cloud=new SharedCloudClient(fetcher);
    cloud.configure({projectUrl,publishableKey});
    await cloud.login({email:"person@example.edu",password:"strong-password"});
    expect(cloud.currentUserId()).toBe(userId);
    expect(await cloud.registerPersonalSyncDevice(deviceId,"macOS laptop"))
      .toMatchObject({ownerId:userId,deviceId});
    expect(await cloud.applyPersonalSyncOperation(op))
      .toEqual({status:"accepted",serverVersion:1,cursor:"1"});
    expect(await cloud.pullPersonalSyncChanges(deviceId,"0",100)).toEqual(page);
    expect(await cloud.revokePersonalSyncDevice(deviceId)).toBe(true);
    expect(calls).toEqual(["register","apply","pull","revoke"]);
  });

  it("inspects current-owner device and exact operation receipt using only user JWT",async()=>{
    const deviceId="6da6f704-5b0c-4e5a-a7dd-dc8db5b4c665";
    const op={
      operationId:"ca9c6544-371b-41f2-b621-a956b088c7fb",
      deviceId,actorId:userId,ownerId:userId,entityId:"3babcb78-c10d-4f4e-ab3e-f47f6ad72447",
      entityType:"personal-task",action:"upsert",baseVersion:null,
      clientTimestamp:"2026-11-19T15:30:00.000Z",
      payload:{title:"Pending",description:"",dueDate:null,priority:"normal",completed:false},
    };
    const calls:string[]=[];
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      if(url.includes("/auth/v1/"))return new Response(JSON.stringify({
        access_token:"jwt",refresh_token:"refresh",expires_in:3600,
        user:{id:userId,email:"owner@example.edu"},
      }));
      expect((init.headers as Record<string,string>).Authorization).toBe("Bearer jwt");
      if(url.endsWith("ate_personal_sync_inspect_device")){
        calls.push("inspect");
        expect(JSON.parse(init.body as string)).toEqual({p_device_id:deviceId});
        return new Response(JSON.stringify({deviceStatus:"revoked",serverCursor:"5"}));
      }
      if(url.endsWith("ate_personal_sync_lookup_receipt")){
        calls.push("receipt");
        expect(JSON.parse(init.body as string)).toEqual({p_operation:op});
        return new Response(JSON.stringify({status:"matched",response:{
          status:"accepted",serverVersion:1,cursor:"1",
        }}));
      }
      throw Error("unexpected RPC");
    });
    const cloud=new SharedCloudClient(fetcher);
    cloud.configure({projectUrl,publishableKey});
    await cloud.login({email:"owner@example.edu",password:"strong-password"});
    expect(await cloud.inspectPersonalSyncDevice(deviceId))
      .toEqual({deviceStatus:"revoked",serverCursor:"5"});
    expect(await cloud.lookupPersonalSyncReceipt(op))
      .toMatchObject({status:"matched",response:{status:"accepted",serverVersion:1}});
    const foreign={...op,ownerId:memberId,actorId:memberId};
    await expect(cloud.lookupPersonalSyncReceipt(foreign)).rejects.toThrow("another cloud account");
    expect(calls).toEqual(["inspect","receipt"]);
  });

  it("rejects malformed inspection and receipt RPC results without using them as acknowledgements",async()=>{
    const deviceId="6da6f704-5b0c-4e5a-a7dd-dc8db5b4c665";
    const cloud=new SharedCloudClient(async(url,init)=>{
      if(url.includes("/auth/v1/"))return new Response(JSON.stringify({
        access_token:"jwt",refresh_token:"refresh",expires_in:3600,
        user:{id:userId,email:"owner@example.edu"},
      }));
      if(url.endsWith("ate_personal_sync_inspect_device"))
        return new Response(JSON.stringify({deviceStatus:"active",serverCursor:"99999999999999999999"}));
      return new Response(JSON.stringify({status:"matched",response:null}));
    });
    cloud.configure({projectUrl,publishableKey});
    await cloud.login({email:"owner@example.edu",password:"strong-password"});
    await expect(cloud.inspectPersonalSyncDevice(deviceId)).rejects.toThrow("cursor");
    const op={operationId:"ca9c6544-371b-41f2-b621-a956b088c7fb",deviceId,
      actorId:userId,ownerId:userId,entityId:"3babcb78-c10d-4f4e-ab3e-f47f6ad72447",
      entityType:"personal-task",action:"delete",baseVersion:1,
      clientTimestamp:"2026-11-19T15:30:00.000Z",payload:null};
    await expect(cloud.lookupPersonalSyncReceipt(op)).rejects.toThrow();
  });

  it("rejects operations for a different authenticated account before sending them",async()=>{
    const fetcher=vi.fn(async(_url:string,_init:RequestInit)=>new Response("{}"));
    const cloud=new SharedCloudClient(async(url,init)=>{
      if(url.includes("/auth/v1/"))return new Response(JSON.stringify({
        access_token:"jwt",refresh_token:"refresh",expires_in:3600,
        user:{id:userId,email:"person@example.edu"},
      }));
      return fetcher(url,init);
    });
    cloud.configure({projectUrl,publishableKey});
    await cloud.login({email:"person@example.edu",password:"strong-password"});
    const foreign={
      operationId:"ca9c6544-371b-41f2-b621-a956b088c7fb",
      deviceId:"6da6f704-5b0c-4e5a-a7dd-dc8db5b4c665",
      actorId:memberId,ownerId:memberId,
      entityId:"3babcb78-c10d-4f4e-ab3e-f47f6ad72447",
      entityType:"personal-task",action:"upsert",baseVersion:null,
      clientTimestamp:"2026-11-19T15:30:00.000Z",
      payload:{title:"Prepare report",description:"",dueDate:null,priority:"normal",completed:false},
    };
    await expect(cloud.applyPersonalSyncOperation(foreign)).rejects.toThrow("another cloud account");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never forwards private Supabase errors or sends requests to non-allowlisted hosts",async()=>{
    const fetcher=vi.fn(async()=>new Response('{"message":"secret backend token"}',{status:403}));
    const cloud=new SharedCloudClient(fetcher);
    expect(()=>cloud.configure({projectUrl:"http://localhost:54321",publishableKey})).toThrow();
    expect(()=>cloud.configure({projectUrl,publishableKey:"sb_secret_root"})).toThrow();
    cloud.configure({projectUrl,publishableKey});
    await expect(cloud.login({email:"person@example.edu",password:"strong-password"}))
      .rejects.toThrow("authorization");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
