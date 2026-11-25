import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedCloudClient } from "./supabase-client";

const URL="https://alpha-rehearsal.supabase.co";
const OTHER_URL="https://alpha-rotated.supabase.co";
const KEY="sb_publishable_abcdefghijklmnopqrstuvwxyz12345";
const A="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const B="9db8a5cb-1d6c-4e93-807e-e18be4b482a1";
const W="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";

function deferred<T>(){
  let resolve!:(result:T)=>void;
  let reject!:(reason:unknown)=>void;
  const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;});
  return {promise,resolve,reject};
}
async function flush(){
  for(let i=0;i<8;i++)await Promise.resolve();
}
function auth(id:string,tag:string,seconds=3600){
  return new Response(JSON.stringify({
    access_token:"jwt-"+tag,refresh_token:"refresh-"+tag,expires_in:seconds,
    user:{id,email:tag+"@example.edu"},
  }));
}
function workspace(){
  return new Response(JSON.stringify([{id:W,name:"Synthetic group",created_at:"2026-11-25"}]));
}
function configured(fetcher:ConstructorParameters<typeof SharedCloudClient>[0]){
  const cloud=new SharedCloudClient(fetcher);
  cloud.configure({projectUrl:URL,publishableKey:KEY});
  return cloud;
}
afterEach(()=>vi.useRealTimers());

describe("cloud session generation isolation under concurrent network responses",()=>{
  it("a login response cannot reauthenticate after explicit logout",async()=>{
    const blocked=deferred<Response>();
    const cloud=configured(async()=>blocked.promise);
    const pending=cloud.login({email:"a@example.edu",password:"valid-password"});
    await flush();
    cloud.signOut();
    blocked.resolve(auth(A,"a"));
    await expect(pending).rejects.toThrow(/changed|cancelled/);
    expect(cloud.status()).toMatchObject({authenticated:false,userId:null});
  });

  it("a slow previous login cannot overwrite a later successful login",async()=>{
    const first=deferred<Response>();
    const cloud=configured(async(url,init)=>{
      const body=JSON.parse(String(init.body)) as {email:string};
      if(!url.includes("/auth/v1/token"))throw Error("unexpected endpoint");
      return body.email.startsWith("a@") ? first.promise : auth(B,"b");
    });
    const pendingA=cloud.login({email:"a@example.edu",password:"valid-password"});
    await flush();
    await cloud.login({email:"b@example.edu",password:"valid-password"});
    first.resolve(auth(A,"a"));
    await expect(pendingA).rejects.toThrow(/changed|cancelled/);
    expect(cloud.status()).toMatchObject({authenticated:true,userId:B,email:"b@example.edu"});
  });

  it("configuration switch cancels a pending signup or login; old credentials stay unavailable",async()=>{
    const pendingResponse=deferred<Response>();
    const cloud=configured(async()=>pendingResponse.promise);
    const pending=cloud.login({email:"a@example.edu",password:"valid-password"});
    await flush();
    cloud.configure({projectUrl:OTHER_URL,publishableKey:KEY});
    pendingResponse.resolve(auth(A,"a"));
    await expect(pending).rejects.toThrow(/changed|cancelled/);
    expect(cloud.status()).toMatchObject({configured:true,authenticated:false,userId:null});
    await expect(cloud.listWorkspaces()).rejects.toThrow("Log in");
  });

  it("refresh from account A cannot sign out account B or resurrect account A",async()=>{
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T01:00:00Z"));
    const stalled=deferred<Response>();
    const calls:string[]=[];
    const cloud=configured(async(url,init)=>{
      if(url.includes("grant_type=password")){
        const body=JSON.parse(String(init.body)) as {email:string};
        return body.email.startsWith("a@")?auth(A,"a",120):auth(B,"b");
      }
      if(url.includes("grant_type=refresh_token")){
        calls.push("old-refresh");
        return stalled.promise;
      }
      calls.push((init.headers as Record<string,string>).Authorization);
      return workspace();
    });
    await cloud.login({email:"a@example.edu",password:"valid-password"});
    vi.setSystemTime(new Date("2026-11-25T01:01:05Z"));
    const pending=cloud.listWorkspaces();
    await flush();
    expect(calls).toEqual(["old-refresh"]);
    cloud.signOut();
    await cloud.login({email:"b@example.edu",password:"valid-password"});
    stalled.resolve(auth(A,"a-new"));
    await expect(pending).rejects.toThrow(/changed|expired/);
    expect(cloud.status()).toMatchObject({authenticated:true,userId:B});
    expect((await cloud.listWorkspaces())[0].name).toBe("Synthetic group");
    expect(calls).toContain("Bearer jwt-b");
    expect(calls).not.toContain("Bearer jwt-a-new");
  });

  it("discard an already-sent stale REST response when the user switches accounts",async()=>{
    const pendingResponse=deferred<Response>();
    let firstRead=true;
    const tokens:string[]=[];
    const cloud=configured(async(url,init)=>{
      if(url.includes("/auth/v1/token")){
        const body=JSON.parse(String(init.body)) as {email:string};
        return body.email.startsWith("a@")?auth(A,"a"):auth(B,"b");
      }
      tokens.push((init.headers as Record<string,string>).Authorization);
      if(firstRead){firstRead=false;return pendingResponse.promise;}
      return workspace();
    });
    await cloud.login({email:"a@example.edu",password:"valid-password"});
    const oldRead=cloud.listWorkspaces();
    await flush();
    cloud.signOut();
    await cloud.login({email:"b@example.edu",password:"valid-password"});
    pendingResponse.resolve(workspace());
    await expect(oldRead).rejects.toThrow("changed");
    await cloud.listWorkspaces();
    expect(tokens).toEqual(["Bearer jwt-a","Bearer jwt-b"]);
    expect(cloud.status().userId).toBe(B);
  });

  it("two simultaneous protected reads share one valid refresh, not two independent refreshes",async()=>{
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T01:00:00Z"));
    const wait=deferred<Response>();
    let refreshed=0;
    const protectedTokens:string[]=[];
    const cloud=configured(async(url,init)=>{
      if(url.includes("grant_type=password"))return auth(A,"a",120);
      if(url.includes("grant_type=refresh_token")){refreshed++;return wait.promise;}
      protectedTokens.push((init.headers as Record<string,string>).Authorization);
      return workspace();
    });
    await cloud.login({email:"a@example.edu",password:"valid-password"});
    vi.setSystemTime(new Date("2026-11-25T01:01:05Z"));
    const first=cloud.listWorkspaces(),second=cloud.listMembers(W);
    await flush();
    expect(refreshed).toBe(1);
    wait.resolve(auth(A,"a-renewed"));
    const [workspaces,members]=await Promise.all([first,second]);
    expect(workspaces).toHaveLength(1);
    expect(members).toEqual([{id:W,name:"Synthetic group",created_at:"2026-11-25"}]);
    expect(protectedTokens).toEqual(["Bearer jwt-a-renewed","Bearer jwt-a-renewed"]);
  });
});