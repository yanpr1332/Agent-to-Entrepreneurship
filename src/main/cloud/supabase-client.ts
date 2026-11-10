import {
  requireCloudCredentials, requireCloudMessage, requireDisplayName,
  requireInvite, requireUuid, requireWorkspaceName, parseCloudTask,
  validateCloudProject,
  type CloudSessionStatus, type SharedMember, type SharedMessage,
  type SharedTask, type SharedWorkspace, type CloudProjectConfig,
} from "../../shared/cloud-model";

type Fetcher=(input:string,init:RequestInit)=>Promise<Response>;
interface AuthPayload{
  access_token?:unknown;refresh_token?:unknown;expires_in?:unknown;
  user?:{id?:unknown;email?:unknown};
}
interface Session{
  accessToken:string;refreshToken:string;expiresAt:number;
  userId:string;email:string;
}
const REQUEST_TIMEOUT_MS=15_000;
const MAX_JSON_BYTES=512_000;

/**
 * A candidate Supabase PoC. ALL cloud data calls use the signed-in user's JWT,
 * never a service-role key. RLS in the SQL migration is authoritative.
 * Credentials and session tokens stay in Electron Main memory, not Renderer.
 */
export class SharedCloudClient {
  private project:CloudProjectConfig|null=null;
  private session:Session|null=null;
  private refreshJob:Promise<void>|null=null;

  constructor(private readonly fetcher:Fetcher=(url,init)=>fetch(url,init)){}

  configure(input:unknown):CloudSessionStatus {
    this.project=validateCloudProject(input);
    this.session=null;
    return this.status();
  }

  status():CloudSessionStatus {
    return {configured:this.project!==null,authenticated:this.session!==null,
      userId:this.session?.userId??null,email:this.session?.email??null};
  }

  signOut():void {
    // Volatile credentials: no durable tokens, no silent cross-device login.
    this.session=null;
  }

  private async call(path:string,method:"GET"|"POST"|"PATCH",
    body?:unknown,headers:Record<string,string>={},useUser=true):Promise<unknown>{
    if(!this.project)throw Error("Configure a Supabase test project first");
    const base=this.project;
    if(useUser) await this.requireSession();
    const token=useUser ? this.session!.accessToken : base.publishableKey;
    let response:Response;
    try {
      response=await this.fetcher(`${base.projectUrl}/${path}`,{
        method,
        headers:{
          apikey:base.publishableKey,
          Authorization:`Bearer ${token}`,
          Accept:"application/json",
          ...(body===undefined?{}:{"Content-Type":"application/json"}),
          ...headers,
        },
        ...(body===undefined?{}:{body:JSON.stringify(body)}),
        redirect:"error",
        signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }catch{
      throw Error("Cloud service is unreachable; check the connection and project URL");
    }
    if(!response.ok) {
      // Never forward remote error bodies: they may contain private account details.
      if(response.status===401 || response.status===403)
        throw Error("Cloud authorization failed or server-side workspace access was denied");
      throw Error(`Cloud request rejected (HTTP ${response.status})`);
    }
    if(response.status===204)return null;
    const text=await response.text();
    if(text.length>MAX_JSON_BYTES)throw Error("Cloud response exceeds safety limit");
    if(!text)return null;
    try{return JSON.parse(text);}catch{throw Error("Cloud returned malformed JSON");}
  }

  private acceptAuth(input:unknown):void {
    const p=input as AuthPayload|null;
    if(!p || typeof p.access_token!=="string" || typeof p.refresh_token!=="string" ||
       typeof p.expires_in!=="number" || !Number.isFinite(p.expires_in) ||
       !p.user || typeof p.user.id!=="string" ||
       typeof p.user.email!=="string")throw Error("Cloud login response missing a valid session");
    this.session={
      accessToken:p.access_token,refreshToken:p.refresh_token,
      expiresAt:Date.now()+Math.max(60,p.expires_in)*1000,
      userId:requireUuid(p.user.id),email:p.user.email,
    };
  }

  async signUp(input:unknown):Promise<{emailVerificationRequired:true}> {
    const credentials=requireCloudCredentials(input);
    const result=await this.call("auth/v1/signup","POST",credentials,{},false);
    // An account can require email confirmation. Do not assume signup logs in.
    if(result && typeof result==="object" && "access_token" in result &&
       (result as AuthPayload).access_token){
      this.acceptAuth(result);
    }
    return {emailVerificationRequired:true};
  }

  async login(input:unknown):Promise<CloudSessionStatus> {
    const credentials=requireCloudCredentials(input);
    const data=await this.call("auth/v1/token?grant_type=password","POST",credentials,{},false);
    this.acceptAuth(data);
    return this.status();
  }

  private async requireSession():Promise<void> {
    if(!this.session)throw Error("Log in to the cloud workspace first");
    if(Date.now()<this.session.expiresAt-60_000)return;
    if(this.refreshJob)return this.refreshJob;
    const refreshToken=this.session.refreshToken;
    const job=(async()=>{
      const updated=await this.call("auth/v1/token?grant_type=refresh_token","POST",
        {refresh_token:refreshToken},{},false);
      this.acceptAuth(updated);
    })().catch(()=>{
      this.session=null;
      throw Error("Cloud session expired; log in again");
    }).finally(()=>{if(this.refreshJob===job)this.refreshJob=null;});
    this.refreshJob=job;
    return job;
  }

  private userId():string {
    if(!this.session)throw Error("Log in to the cloud workspace first");
    return this.session.userId;
  }
  private async getArray<T>(path:string):Promise<T[]>{
    const output=await this.call(path,"GET");
    if(!Array.isArray(output))throw Error("Cloud returned an unexpected list");
    return output as T[];
  }
  private async rpc(name:string,body:object):Promise<unknown>{
    return this.call(`rest/v1/rpc/${name}`,"POST",body);
  }

  async listWorkspaces():Promise<SharedWorkspace[]>{
    return this.getArray<SharedWorkspace>(
      "rest/v1/ate_workspaces?select=id,name,created_at&order=created_at.desc");
  }

  async createWorkspace(name:unknown,displayName:unknown):Promise<string>{
    const id=await this.rpc("ate_create_workspace",{
      p_name:requireWorkspaceName(name),p_display_name:requireDisplayName(displayName),
    });
    return requireUuid(id);
  }

  async createInvite(workspaceId:unknown):Promise<string>{
    const token=await this.rpc("ate_create_invite",{p_workspace:requireUuid(workspaceId)});
    return requireInvite(token);
  }

  async joinWorkspace(token:unknown,displayName:unknown):Promise<string>{
    const id=await this.rpc("ate_join_workspace",{
      p_token:requireInvite(token),p_display_name:requireDisplayName(displayName),
    });
    return requireUuid(id);
  }

  async listMembers(workspaceId:unknown):Promise<SharedMember[]>{
    const id=requireUuid(workspaceId);
    return this.getArray<SharedMember>(`rest/v1/ate_workspace_members?workspace_id=eq.${id}&select=workspace_id,user_id,role,display_name,joined_at&order=joined_at.asc`);
  }

  async listMessages(workspaceId:unknown):Promise<SharedMessage[]>{
    const id=requireUuid(workspaceId);
    return this.getArray<SharedMessage>(`rest/v1/ate_workspace_messages?workspace_id=eq.${id}&select=id,workspace_id,author_id,body,created_at&order=created_at.desc&limit=100`);
  }

  async sendMessage(workspaceId:unknown,body:unknown):Promise<SharedMessage>{
    const id=requireUuid(workspaceId);
    const created=await this.call("rest/v1/ate_workspace_messages","POST",
      {workspace_id:id,author_id:this.userId(),body:requireCloudMessage(body)},
      {Prefer:"return=representation"});
    if(!Array.isArray(created) || created.length!==1)
      throw Error("Cloud did not confirm the shared message");
    return created[0] as SharedMessage;
  }

  async listTasks(workspaceId:unknown):Promise<SharedTask[]>{
    const id=requireUuid(workspaceId);
    return this.getArray<SharedTask>(`rest/v1/ate_workspace_tasks?workspace_id=eq.${id}&select=*&order=created_at.desc&limit=100`);
  }

  async createTask(workspaceId:unknown,input:unknown):Promise<SharedTask>{
    const id=requireUuid(workspaceId);
    const task=parseCloudTask(input);
    const created=await this.call("rest/v1/ate_workspace_tasks","POST",{
      workspace_id:id,created_by:this.userId(),title:task.title,
      due_date:task.dueDate,assigned_to:task.assignedTo,completed:false,
    },{Prefer:"return=representation"});
    if(!Array.isArray(created) || created.length!==1)
      throw Error("Cloud did not confirm the shared task");
    return created[0] as SharedTask;
  }

  async markTask(workspaceId:unknown,taskId:unknown,completed:unknown):Promise<SharedTask>{
    const workspace=requireUuid(workspaceId),id=requireUuid(taskId);
    if(typeof completed!=="boolean")throw Error("Invalid shared task completion flag");
    const updated=await this.call(
      `rest/v1/ate_workspace_tasks?id=eq.${id}&workspace_id=eq.${workspace}`,
      "PATCH",{completed},{Prefer:"return=representation"});
    if(!Array.isArray(updated) || updated.length!==1)
      throw Error("Shared task not found or permission denied");
    return updated[0] as SharedTask;
  }
}
