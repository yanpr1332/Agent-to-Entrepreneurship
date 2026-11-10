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
