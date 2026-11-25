import {requireUuid} from "../../shared/cloud-model";
import type {SharedCloudClient} from "./supabase-client";
import type {WorkspaceLiveUpdate} from "../../shared/cloud-model";

/** Small socket surface, so the Phoenix transport can be fault-injected in Vitest. */
export interface RealtimeSocket {
  readyState:number;
  onopen:(()=>void)|null;
  onmessage:((event:{data:unknown})=>void)|null;
  onerror:(()=>void)|null;
  onclose:(()=>void)|null;
  send(message:string):void;
  close():void;
}
export type RealtimeSocketFactory=(url:string)=>RealtimeSocket;
const HEARTBEAT_MS=25_000;
const STALE_MS=80_000;
const MAX_RETRY_MS=30_000;
const MAX_FRAME_BYTES=65_536;

/** Never retry known authorization failures as transient network outages. */
function accessDenied(error:unknown):boolean {
  const message=error instanceof Error?error.message:"";
  return /authorization failed|access was denied|membership|log in to the cloud workspace first/i.test(message);
}

/**
 * Supabase Realtime is a *hint channel*, not a source of truth. Main keeps
 * the JWT and parses no record bodies; Renderer always re-fetches via RLS.
 * Every reconnect validates membership before opening the next socket.
 */
export class WorkspaceRealtimeBridge {
  private epoch=0;
  private socket:RealtimeSocket|null=null;
  private workspaceId:string|null=null;
  private ownerId:string|null=null;
  private phase:WorkspaceLiveUpdate["phase"]="stopped";
  private retries=0;
  private sequence=0;
  private lastFrameAt=0;
  private reconnectTimer:ReturnType<typeof setTimeout>|null=null;
  private heartbeatTimer:ReturnType<typeof setInterval>|null=null;
  private expiryTimer:ReturnType<typeof setTimeout>|null=null;

  constructor(
    private readonly cloud:Pick<SharedCloudClient,
      "currentUserId"|"listMembers"|"realtimeCredentials">,
    private readonly notify:(update:WorkspaceLiveUpdate)=>void,
    private readonly socketFactory:RealtimeSocketFactory=(url)=>new WebSocket(url) as unknown as RealtimeSocket,
  ){}

  getStatus():WorkspaceLiveUpdate|null{
    return this.workspaceId?{workspaceId:this.workspaceId,phase:this.phase,hint:false}:null;
  }

  async watch(rawWorkspaceId:unknown):Promise<WorkspaceLiveUpdate>{
    const workspaceId=requireUuid(rawWorkspaceId);
    const ownerId=this.cloud.currentUserId();
    this.stop();
    this.workspaceId=workspaceId;
    this.ownerId=ownerId;
    const epoch=this.epoch;
    this.publish("connecting");
    // First watch enforces membership; transient network failures instead
    // remain in polling mode and schedule a bounded retry after reconnect.
    let members:Awaited<ReturnType<SharedCloudClient["listMembers"]>>;
    try{
      members=await this.cloud.listMembers(workspaceId);
    }catch(error){
      if(!this.active(epoch)||this.workspaceId!==workspaceId)
        throw Error("Workspace selection changed");
      if(accessDenied(error)){
        this.clearTimersAndSocket();
        this.publish("revoked");
        throw error;
      }
      this.retry(epoch);
      return {workspaceId,phase:"fallback",hint:false};
    }
    if(epoch!==this.epoch||this.workspaceId!==workspaceId)
      throw Error("Workspace selection changed");
    if(this.cloud.currentUserId()!==ownerId||!members.some(m=>m.user_id===ownerId)){
      this.publish("revoked");
      this.clearTimersAndSocket();
      throw Error("Workspace membership no longer permits realtime access");
    }
    void this.connect(epoch);
    return {workspaceId,phase:"connecting",hint:false};
  }

  /** A delayed cleanup from the previous selection cannot stop a newer watch. */
  stopWatching(rawWorkspaceId:unknown):{stopped:true}{
    const workspaceId=requireUuid(rawWorkspaceId);
    if(this.workspaceId===workspaceId)this.stop();
    return {stopped:true};
  }

  stop():void{
    this.epoch++;
    this.clearTimersAndSocket();
    const previous=this.workspaceId;
    this.workspaceId=null;
    this.ownerId=null;
    this.retries=0;
    this.phase="stopped";
    if(previous)this.notify({workspaceId:previous,phase:"stopped",hint:false});
  }

  private publish(phase:WorkspaceLiveUpdate["phase"],hint=false):void{
    if(!this.workspaceId)return;
    this.phase=phase;
    this.notify({workspaceId:this.workspaceId,phase,hint});
  }

  private clearTimersAndSocket():void{
    if(this.reconnectTimer!==null){clearTimeout(this.reconnectTimer);this.reconnectTimer=null;}
    if(this.heartbeatTimer!==null){clearInterval(this.heartbeatTimer);this.heartbeatTimer=null;}
    if(this.expiryTimer!==null){clearTimeout(this.expiryTimer);this.expiryTimer=null;}
    const old=this.socket;
    this.socket=null;
    if(old){
      old.onopen=null;old.onmessage=null;old.onerror=null;old.onclose=null;
      try{old.close();}catch{/* socket already unavailable */}
    }
  }

  private active(epoch:number,ws?:RealtimeSocket):boolean{
    return epoch===this.epoch && this.workspaceId!==null &&
      this.ownerId!==null && (!ws||this.socket===ws);
  }

  private retry(epoch:number):void{
    if(!this.active(epoch))return;
    this.clearTimersAndSocket();
    this.publish("fallback");
    const delay=Math.min(MAX_RETRY_MS,1000*2**Math.min(5,this.retries++));
    this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;void this.connect(epoch);},delay);
  }

  private async connect(epoch:number):Promise<void>{
    if(!this.active(epoch))return;
    const workspaceId=this.workspaceId!,ownerId=this.ownerId!;
    this.publish("connecting");
    try{
      // Never reconnect using a stale account or a cached membership list.
      const [members,credentials]=await Promise.all([
        this.cloud.listMembers(workspaceId),this.cloud.realtimeCredentials(),
      ]);
      if(!this.active(epoch))return;
      if(credentials.userId!==ownerId||this.cloud.currentUserId()!==ownerId||
        !members.some(m=>m.user_id===ownerId)){
        this.clearTimersAndSocket();
        this.publish("revoked");
        return;
      }
      const ws=this.socketFactory(credentials.url);
      if(!this.active(epoch)){ws.close();return;}
      this.socket=ws;
      const topic="realtime:ate-workspace-"+workspaceId;
      let joined=false;
      const joinRef=String(++this.sequence);
      ws.onopen=()=>{
        if(!this.active(epoch,ws))return;
        this.lastFrameAt=Date.now();
        try{ws.send(JSON.stringify({
          topic,event:"phx_join",ref:joinRef,
          payload:{
            access_token:credentials.accessToken,
            config:{broadcast:{self:false},presence:{key:""},postgres_changes:[
              {event:"*",schema:"public",table:"ate_workspace_messages",
                filter:"workspace_id=eq."+workspaceId},
              {event:"*",schema:"public",table:"ate_workspace_tasks",
                filter:"workspace_id=eq."+workspaceId},
            ]},
          },
        }));}catch{this.retry(epoch);return;}
        this.heartbeatTimer=setInterval(()=>{
          if(!this.active(epoch,ws))return;
          if(Date.now()-this.lastFrameAt>STALE_MS){this.retry(epoch);return;}
          if(ws.readyState===1){
            try{ws.send(JSON.stringify({topic:"phoenix",event:"heartbeat",payload:{},
              ref:String(++this.sequence)}));}catch{this.retry(epoch);}
          }
        },HEARTBEAT_MS);
        // Reconnect before JWT expiry, refresh via the normal Main auth path.
        const expiresIn=Math.max(1000,credentials.expiresAt-Date.now()-60_000);
        this.expiryTimer=setTimeout(()=>{if(this.active(epoch,ws))this.retry(epoch);},expiresIn);
      };
      ws.onmessage=event=>{
        if(!this.active(epoch,ws)||typeof event.data!=="string"||
           event.data.length>MAX_FRAME_BYTES)return;
        this.lastFrameAt=Date.now();
        let frame:Record<string,unknown>;
        try{const value=JSON.parse(event.data) as unknown;
          if(!value||typeof value!=="object"||Array.isArray(value))return;
          frame=value as Record<string,unknown>;
        }catch{return;}
        if(frame.topic!==topic)return;
        if(frame.event==="phx_reply"&&frame.ref===joinRef){
          const payload=frame.payload;
          if(!payload||typeof payload!=="object"||Array.isArray(payload)){
            this.retry(epoch);return;
          }
          const response=payload as Record<string,unknown>;
          const registration=response.response;
          if(response.status!=="ok"||!registration||typeof registration!=="object"||
            !Array.isArray((registration as Record<string,unknown>).postgres_changes)||
            ((registration as Record<string,unknown>).postgres_changes as unknown[]).length!==2){
            this.retry(epoch);return;
          }
          joined=true;this.retries=0;
          // A join or rejoin triggers a full RLS-protected catch-up.
          this.publish("live",true);
          return;
        }
        if(frame.event==="phx_error"||frame.event==="phx_close"){
          this.retry(epoch);return;
        }
        if(joined&&frame.event==="postgres_changes"){
          // No row contents are trusted or forwarded to Renderer.
          this.publish("live",true);
        }
      };
      ws.onerror=()=>{if(this.active(epoch,ws))this.retry(epoch);};
      ws.onclose=()=>{if(this.active(epoch,ws))this.retry(epoch);};
    }catch(error){
      if(!this.active(epoch))return;
      if(accessDenied(error)){
        this.clearTimersAndSocket();
        this.publish("revoked");
        return;
      }
      this.retry(epoch);
    }
  }
}
