import {requireUuid,type SharedWorkspaceSnapshot,type SharedMember} from "../../shared/cloud-model";
import {createHash} from "node:crypto";
import {
  parseWorkspaceHistoryPull,type WorkspaceHistoryItems,type WorkspaceHistoryMarker,
} from "../../shared/workspace-history-contract";
import type {SharedMessage,SharedTask} from "../../shared/cloud-model";
import type {SharedCloudClient} from "./supabase-client";
import {WorkspaceHistoryStore} from "./workspace-history-store";

const MAX_CATCHUP_PAGES=20;
type Cloud=Pick<SharedCloudClient,"currentUserId"|"currentProjectUrl"|"listMembers"|"workspaceSnapshot"|"pullWorkspaceHistory"|"pullWorkspaceCheckpoint">;

export class WorkspaceHistoryService {
  private readonly running=new Map<string,Promise<SharedWorkspaceSnapshot>>();
  private epoch=0;
  private cacheOwner(owner:string):string{
    const hash=createHash("sha256").update(this.cloud.currentProjectUrl()+"\u0000"+owner).digest("hex");
    return [hash.slice(0,8),hash.slice(8,12),hash.slice(12,16),hash.slice(16,20),hash.slice(20,32)].join("-");
  }
  constructor(private readonly cloud:Cloud,private readonly store:WorkspaceHistoryStore){}

  private currentOwner():string{return requireUuid(this.cloud.currentUserId()).toLowerCase();}
  private assertOwner(id:string,epoch:number):void{
    if(epoch!==this.epoch||this.currentOwner()!==id)
      throw Error("Cloud account or project changed during team history retrieval");
  }
  private async checkMembership(owner:string,cacheOwner:string,workspace:string,epoch:number):Promise<SharedMember[]>{
    const members=await this.cloud.listMembers(workspace);
    this.assertOwner(owner,epoch);
    if(!members.some(m=>m.user_id===owner)){
      this.store.revoke(cacheOwner,workspace);
      throw Error("Workspace membership revoked or access denied");
    }
    return members;
  }

  snapshot(workspaceInput:unknown):Promise<SharedWorkspaceSnapshot>{
    const workspace=requireUuid(workspaceInput),owner=this.currentOwner();
    const cacheOwner=this.cacheOwner(owner),epoch=this.epoch;
    const key=cacheOwner+":"+workspace;
    const active=this.running.get(key);
    if(active)return active;
    const job=this.refresh(owner,cacheOwner,workspace,epoch).finally(()=>{
      if(this.running.get(key)===job)this.running.delete(key);
    });
    this.running.set(key,job);
    return job;
  }

  private async refresh(owner:string,cacheOwner:string,workspace:string,epoch:number):Promise<SharedWorkspaceSnapshot>{
    let members=await this.checkMembership(owner,cacheOwner,workspace,epoch);
    let applied=0,hasMore=false,rebuilding=false;
    let checkpointCursor:string|null=null;
    // One invocation has a hard cap across BOTH change and snapshot RPCs,
    // and a later poll resumes any staged checkpoint from durable SQLite.
    let budget=MAX_CATCHUP_PAGES;
    while(budget>0){
      this.assertOwner(owner,epoch);
      const cursor=this.store.getCursor(cacheOwner,workspace);
      let raw:unknown;
      try{
        raw=await this.cloud.pullWorkspaceHistory(workspace,cursor,100);
      }catch(error){
        this.assertOwner(owner,epoch);
        const message=error instanceof Error?error.message:"";
        // Only the absent optional 003B RPC (not auth, 403, corruption or
        // missing checkpoint RPC) allows legacy REST/RLS fallback.
        if(budget===MAX_CATCHUP_PAGES&&/HTTP 404/.test(message)){
          const legacy=await this.cloud.workspaceSnapshot(workspace);
          this.assertOwner(owner,epoch);
          return {...legacy,history:{mode:"fallback",cursor:null,applied:0,
            hasMore:false,totalMessages:null,totalTasks:null}};
        }
        if(/authorization failed|access was denied/i.test(message))
          this.store.revoke(cacheOwner,workspace);
        throw error;
      }
      budget--;
      this.assertOwner(owner,epoch);
      const response=parseWorkspaceHistoryPull(raw,workspace,cursor);
      if("status" in response){
        this.store.beginCheckpoint(cacheOwner,workspace,response);
        checkpointCursor=response.checkpointCursor;
        let stage=this.store.getCheckpoint(cacheOwner,workspace);
        while(stage&&stage.nextOrdinal!==stage.totalItems&&budget>0){
          const checkpointRaw=await this.cloud.pullWorkspaceCheckpoint(
            workspace,stage.checkpointCursor,stage.nextOrdinal,100);
          budget--;
          this.assertOwner(owner,epoch);
          const page=this.store.stageCheckpointPage(cacheOwner,workspace,checkpointRaw);
          applied+=page.items.length;
          stage=this.store.getCheckpoint(cacheOwner,workspace);
        }
        if(stage&&stage.nextOrdinal===stage.totalItems){
          // A member could be removed during a multi-page reconstruction.
          // Revalidate before making staged records visible to the UI.
          members=await this.checkMembership(owner,cacheOwner,workspace,epoch);
          this.assertOwner(owner,epoch);
          this.store.finishCheckpoint(cacheOwner,workspace);
          hasMore=budget===0;
          if(!hasMore)continue; // Pull post-checkpoint delta events next.
          break;
        }
        rebuilding=true;hasMore=true;
        break; // Partial baseline MUST NOT become visible as a live snapshot.
      }
      this.store.applyPage(cacheOwner,workspace,response);
      applied+=response.changes.length;
      hasMore=response.hasMore;
      if(!hasMore)break;
    }
    this.assertOwner(owner,epoch);
    if(rebuilding){
      return {workspaceId:workspace,members,messages:[],tasks:[],
        history:{mode:"durable",cursor:this.store.getCursor(cacheOwner,workspace),
          applied,hasMore:true,totalMessages:null,totalTasks:null,
          rebuilding:true,checkpointCursor}};
    }
    const messages=this.store.list<SharedMessage>(cacheOwner,workspace,"message");
    const tasks=this.store.list<SharedTask>(cacheOwner,workspace,"task");
    const counts=this.store.counts(cacheOwner,workspace);
    return {workspaceId:workspace,members,messages:messages.items,tasks:tasks.items,
      history:{mode:"durable",cursor:this.store.getCursor(cacheOwner,workspace),
        applied,hasMore,totalMessages:counts.messages,totalTasks:counts.tasks,
        rebuilding:false,checkpointCursor}};
  }

  /** Every local history page gets a fresh online membership check; cached
   * bytes are NEVER exposed merely because another user logged in before. */
  async older(workspaceInput:unknown,kind:"message"|"task",beforeInput:unknown):
    Promise<WorkspaceHistoryItems<SharedMessage|SharedTask>>{
    const workspace=requireUuid(workspaceInput),owner=this.currentOwner();
    const cacheOwner=this.cacheOwner(owner),epoch=this.epoch;
    if(kind!=="message"&&kind!=="task")throw Error("Invalid team history category");
    await this.checkMembership(owner,cacheOwner,workspace,epoch);
    if(this.store.getCheckpoint(cacheOwner,workspace))
      throw Error("Team history checkpoint rebuild is in progress");
    if(!this.store.hasProgress(cacheOwner,workspace))
      throw Error("Durable workspace history is unavailable until a successful journal sync");
    const marker:WorkspaceHistoryMarker|null=beforeInput===null?null:
      // Store.list revalidates the untrusted marker.
      beforeInput as WorkspaceHistoryMarker;
    const result=this.store.list<SharedMessage|SharedTask>(cacheOwner,workspace,kind,marker,100);
    this.assertOwner(owner,epoch);
    return result;
  }

  /** Intentionally removes every cached team/workspace snapshot and pending
   * checkpoint for the CURRENT signed-in account in this Supabase project.
   * There is no cloud delete. In-flight network results are invalidated before
   * the local transaction, so sign-out or account switch cannot repopulate it.
   */
  purgeCurrentAccountCache():{workspaces:number;checkpointed:boolean}{
    const owner=this.currentOwner(),scoped=this.cacheOwner(owner);
    this.cancel();
    return this.store.purgeOwner(scoped);
  }

  /** Called on explicit sign out/configuration changes. Already materialized
   * history is owner-isolated and never returned without a new membership check. */
  cancel():void{
    this.epoch++;
    // Existing in-flight network work cannot write under a different identity;
    // each await checks the currently signed-in owner.
    this.running.clear();
  }
}
