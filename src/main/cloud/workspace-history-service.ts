import {requireUuid,type SharedWorkspaceSnapshot,type SharedMember} from "../../shared/cloud-model";
import {
  parseWorkspaceHistoryPage,type WorkspaceHistoryItems,type WorkspaceHistoryMarker,
} from "../../shared/workspace-history-contract";
import type {SharedMessage,SharedTask} from "../../shared/cloud-model";
import type {SharedCloudClient} from "./supabase-client";
import {WorkspaceHistoryStore} from "./workspace-history-store";

const MAX_CATCHUP_PAGES=20;
type Cloud=Pick<SharedCloudClient,"currentUserId"|"listMembers"|"workspaceSnapshot"|"pullWorkspaceHistory">;

export class WorkspaceHistoryService {
  private readonly running=new Map<string,Promise<SharedWorkspaceSnapshot>>();
  constructor(private readonly cloud:Cloud,private readonly store:WorkspaceHistoryStore){}

  private currentOwner():string{return requireUuid(this.cloud.currentUserId()).toLowerCase();}
  private assertOwner(id:string):void{
    if(this.currentOwner()!==id)throw Error("Cloud account changed during team history retrieval");
  }
  private async checkMembership(owner:string,workspace:string):Promise<SharedMember[]>{
    const members=await this.cloud.listMembers(workspace);
    this.assertOwner(owner);
    if(!members.some(m=>m.user_id===owner)){
      this.store.revoke(owner,workspace);
      throw Error("Workspace membership revoked or access denied");
    }
    return members;
  }

  snapshot(workspaceInput:unknown):Promise<SharedWorkspaceSnapshot>{
    const workspace=requireUuid(workspaceInput),owner=this.currentOwner();
    const key=owner+":"+workspace;
    const active=this.running.get(key);
    if(active)return active;
    const job=this.refresh(owner,workspace).finally(()=>{
      if(this.running.get(key)===job)this.running.delete(key);
    });
    this.running.set(key,job);
    return job;
  }

  private async refresh(owner:string,workspace:string):Promise<SharedWorkspaceSnapshot>{
    const members=await this.checkMembership(owner,workspace);
    let applied=0,hasMore=false;
    for(let pageNum=0;pageNum<MAX_CATCHUP_PAGES;pageNum++){
      this.assertOwner(owner);
      const cursor=this.store.getCursor(owner,workspace);
      let raw:unknown;
      try{
        raw=await this.cloud.pullWorkspaceHistory(workspace,cursor,100);
      }catch(error){
        this.assertOwner(owner);
        const message=error instanceof Error?error.message:"";
        // Only missing optional RPC (404) invokes the compatible 003A path.
        // Any 401/403, bad cursor or malformed remote response fails closed.
        if(pageNum===0&&/HTTP 404/.test(message)){
          const legacy=await this.cloud.workspaceSnapshot(workspace);
          this.assertOwner(owner);
          return {...legacy,history:{mode:"fallback",cursor:null,applied:0,
            hasMore:false,totalMessages:null,totalTasks:null}};
        }
        if(/authorization failed|access was denied/i.test(message))
          this.store.revoke(owner,workspace);
        throw error;
      }
      this.assertOwner(owner);
      const parsed=parseWorkspaceHistoryPage(raw,workspace,cursor);
      this.store.applyPage(owner,workspace,parsed);
      applied+=parsed.changes.length;
      hasMore=parsed.hasMore;
      if(!hasMore)break;
    }
    this.assertOwner(owner);
    const messages=this.store.list<SharedMessage>(owner,workspace,"message");
    const tasks=this.store.list<SharedTask>(owner,workspace,"task");
    const counts=this.store.counts(owner,workspace);
    return {workspaceId:workspace,members,messages:messages.items,tasks:tasks.items,
      history:{mode:"durable",cursor:this.store.getCursor(owner,workspace),
        applied,hasMore,totalMessages:counts.messages,totalTasks:counts.tasks}};
  }

  /** Every local history page gets a fresh online membership check; cached
   * bytes are NEVER exposed merely because another user logged in before. */
  async older(workspaceInput:unknown,kind:"message"|"task",beforeInput:unknown):
    Promise<WorkspaceHistoryItems<SharedMessage|SharedTask>>{
    const workspace=requireUuid(workspaceInput),owner=this.currentOwner();
    if(kind!=="message"&&kind!=="task")throw Error("Invalid team history category");
    await this.checkMembership(owner,workspace);
    if(!this.store.hasProgress(owner,workspace))
      throw Error("Durable workspace history is unavailable until a successful journal sync");
    const marker:WorkspaceHistoryMarker|null=beforeInput===null?null:
      // Store.list revalidates the untrusted marker.
      beforeInput as WorkspaceHistoryMarker;
    const result=this.store.list<SharedMessage|SharedTask>(owner,workspace,kind,marker,100);
    this.assertOwner(owner);
    return result;
  }

  /** Called on explicit sign out/configuration changes. Already materialized
   * history is owner-isolated and never returned without a new membership check. */
  cancel():void{
    // Existing in-flight network work cannot write under a different identity;
    // each await checks the currently signed-in owner.
    this.running.clear();
  }
}
