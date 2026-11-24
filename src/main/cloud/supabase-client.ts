import {
  requireCloudCredentials, requireCloudMessage, requireDisplayName,
  requireInvite, requireUuid, requireWorkspaceName, parseCloudTask,
  validateCloudProject,
  type CloudSessionStatus, type SharedMember, type SharedMessage,
  type SharedTask, type SharedWorkspace, type CloudProjectConfig, type SharedWorkspaceSnapshot,
} from "../../shared/cloud-model";
import {workspaceCursor} from "../../shared/workspace-history-contract";
import {
  parsePersonalSyncOperation, parsePersonalSyncPullPage, parseSyncOperationResult,
  parsePersonalSyncDeviceInspection, parsePersonalSyncReceiptLookup,
  type PersonalSyncPullPage, type PersonalSyncOperation, type SyncOperationResult,
  type PersonalSyncDeviceInspection, type PersonalSyncReceiptLookup,
} from "../../shared/personal-sync-contract";

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

  /** Authenticated identity is exposed only to trusted Main-process services. */
  currentUserId():string {
    return this.userId();
  }
  /** Validated public project origin, used only to partition local team cache. */
  currentProjectUrl():string{
    if(!this.project)throw Error("Configure a Supabase test project first");
    return this.project.projectUrl;
  }

  async registerPersonalSyncDevice(deviceIdInput:unknown,labelInput:unknown):Promise<{
    ownerId:string;deviceId:string;createdAt:string;lastSeenAt:string;
  }> {
    const ownerId=this.userId(),deviceId=requireUuid(deviceIdInput);
    const deviceLabel=requireDisplayName(labelInput);
    const result=await this.rpc("ate_personal_sync_register_device",{
      p_device_id:deviceId,p_device_label:deviceLabel,
    });
    if(!result||typeof result!=="object"||Array.isArray(result))
      throw Error("Cloud returned an invalid device registration");
    const row=result as Record<string,unknown>;
    if(Object.keys(row).sort().join(",")!=="createdAt,deviceId,lastSeenAt,ownerId"||
      row.ownerId!==ownerId||row.deviceId!==deviceId||
      typeof row.createdAt!=="string"||typeof row.lastSeenAt!=="string"||
      !Number.isFinite(Date.parse(row.createdAt))||!Number.isFinite(Date.parse(row.lastSeenAt)))
      throw Error("Cloud returned an invalid device registration");
    return {ownerId,deviceId,createdAt:row.createdAt,lastSeenAt:row.lastSeenAt};
  }

  async applyPersonalSyncOperation(input:unknown):Promise<SyncOperationResult> {
    const operation:PersonalSyncOperation=parsePersonalSyncOperation(input);
    const ownerId=this.userId();
    if(operation.actorId!==ownerId||operation.ownerId!==ownerId)
      throw Error("Personal sync operation belongs to another cloud account");
    return parseSyncOperationResult(await this.rpc("ate_personal_sync_apply",{
      p_operation:operation,
    }));
  }

  async pullPersonalSyncChanges(deviceIdInput:unknown,cursorInput:unknown,limit=200):Promise<PersonalSyncPullPage> {
    const deviceId=requireUuid(deviceIdInput);
    if(typeof cursorInput!=="string"||!/^(0|[1-9][0-9]{0,18})$/.test(cursorInput)||
      BigInt(cursorInput)>9223372036854775807n||
      !Number.isSafeInteger(limit)||limit<1||limit>500)
      throw Error("Invalid personal sync pull request");
    this.userId();
    return parsePersonalSyncPullPage(await this.rpc("ate_personal_sync_pull",{
      p_device_id:deviceId,p_cursor:cursorInput,p_limit:limit,
    }));
  }

  async revokePersonalSyncDevice(deviceIdInput:unknown):Promise<boolean> {
    const deviceId=requireUuid(deviceIdInput);
    this.userId();
    const result=await this.rpc("ate_personal_sync_revoke_device",{p_device_id:deviceId});
    if(typeof result!=="boolean")throw Error("Cloud returned an invalid device revocation result");
    return result;
  }

  /** Optional ALPHA-SYNC-002H read-only endpoints. No device registration or mutations. */
  async inspectPersonalSyncDevice(deviceIdInput:unknown):Promise<PersonalSyncDeviceInspection>{
    const deviceId=requireUuid(deviceIdInput);
    this.userId();
    return parsePersonalSyncDeviceInspection(await this.rpc("ate_personal_sync_inspect_device",{
      p_device_id:deviceId,
    }));
  }

  /** Exact saved idempotency receipt, never a guess based on an entity ID. */
  async lookupPersonalSyncReceipt(input:unknown):Promise<PersonalSyncReceiptLookup>{
    const operation=parsePersonalSyncOperation(input);
    const ownerId=this.userId();
    if(operation.ownerId!==ownerId||operation.actorId!==ownerId)
      throw Error("Personal sync receipt request belongs to another cloud account");
    return parsePersonalSyncReceiptLookup(await this.rpc("ate_personal_sync_lookup_receipt",{
      p_operation:operation,
    }));
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

  /** Authenticated, scoped journal pull. Never creates or edits cloud rows. */
  /** Pinned, read-only checkpoint page. Always uses the signed-in user JWT
   * through the same protected RPC transport as normal history pulls. */
  async pullWorkspaceCheckpoint(workspaceInput:unknown,checkpointInput:unknown,
    afterInput:unknown,limit=100):Promise<unknown>{
    const workspace=requireUuid(workspaceInput);
    const checkpoint=workspaceCursor(checkpointInput);
    const after=workspaceCursor(afterInput);
    if(checkpoint==="0"||!Number.isInteger(limit)||limit<1||limit>100)
      throw Error("Invalid team checkpoint page request");
    return this.rpc("ate_workspace_history_snapshot",{
      p_workspace_id:workspace,p_checkpoint_cursor:checkpoint,
      p_after:after,p_limit:limit,
    });
  }

  async pullWorkspaceHistory(workspaceInput:unknown,cursorInput:unknown,limit=100):Promise<unknown>{
    const workspace=requireUuid(workspaceInput);
    const cursor=workspaceCursor(cursorInput);
    if(!Number.isInteger(limit)||limit<1||limit>100)throw Error("Invalid team history page limit");
    return this.rpc("ate_workspace_history_pull",{
      p_workspace_id:workspace,p_after:cursor,p_limit:limit,
    });
  }

  async listMembers(workspaceId:unknown):Promise<SharedMember[]>{
    const id=requireUuid(workspaceId);
    return this.getArray<SharedMember>(`rest/v1/ate_workspace_members?workspace_id=eq.${id}&select=workspace_id,user_id,role,display_name,joined_at&order=joined_at.asc`);
  }

  /** Main-only credentials; no user secret ever reaches Renderer. */
  async realtimeCredentials():Promise<{url:string;accessToken:string;userId:string;expiresAt:number}>{
    if(!this.project)throw Error("Configure a Supabase test project first");
    await this.requireSession();
    const session=this.session!;
    const host=new URL(this.project.projectUrl);
    if(host.protocol!=="https:"||!/^[a-z0-9-]+\.supabase\.co$/i.test(host.hostname))
      throw Error("Realtime project host is not allowlisted");
    return {url:"wss://"+host.hostname+"/realtime/v1/websocket?apikey="+
      encodeURIComponent(this.project.publishableKey)+"&vsn=1.0.0",
      accessToken:session.accessToken,userId:session.userId,expiresAt:session.expiresAt};
  }

  /** A full RLS-checked catch-up. No cached shared row is trusted after revoke. */
  async workspaceSnapshot(input:unknown):Promise<SharedWorkspaceSnapshot>{
    const workspaceId=requireUuid(input),ownerId=this.currentUserId();
    const members=await this.listMembers(workspaceId);
    if(this.currentUserId()!==ownerId)throw Error("Cloud account changed during workspace refresh");
    if(!members.some(m=>m.user_id===ownerId))
      throw Error("Workspace membership revoked or access denied");
    const [messages,tasks]=await Promise.all([
      this.listMessages(workspaceId),this.listTasks(workspaceId),
    ]);
    if(this.currentUserId()!==ownerId)throw Error("Cloud account changed during workspace refresh");
    return {workspaceId,members,messages,tasks};
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
