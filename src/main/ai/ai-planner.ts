import { parseAIApprovalId, type AIPreview } from "../../shared/ai-model";
import {parseAIPlanPrepare,parseAIPlanSlots,type AIPlanAccepted,type AIPlanSlot} from "../../shared/ai-plan-model";
import type { LocalTask } from "../../shared/local-model";
import { PlanningStore } from "../planning-store";
import type { AIService } from "./ai-service";
import type {AIProjectStore} from "./ai-project-store";

interface PendingPlan {
  approvalId:string;
  projectId:string;
  settings:ReturnType<typeof parseAIPlanPrepare>["settings"];
  selected:LocalTask[];
}
function sameTask(a:LocalTask,b:LocalTask):boolean {
  return a.id===b.id && a.title===b.title && a.dueDate===b.dueDate &&
    a.priority===b.priority && a.updatedAt===b.updatedAt &&
    a.visible===b.visible && a.completed===b.completed && a.source===b.source;
}

/** Only Main can compose trusted task context and verify the final model output. */
export class AIPlanningCoordinator {
  private pending:PendingPlan|null=null;
  constructor(
    private readonly ai:Pick<AIService,"prepare"|"confirm">,
    private readonly planning:Pick<PlanningStore,"proposeFromAI">,
    private readonly listTasks:()=>LocalTask[],
    private readonly projects:Pick<AIProjectStore,"authorizeSources"|"authorizeAction">,
    private readonly now:()=>Date=()=>new Date(),
  ){}

  cancel():void{this.pending=null;}

  prepare(input:unknown):AIPreview{
    const {projectId,taskIds,settings}=parseAIPlanPrepare(input);
    const now=this.now();
    this.projects.authorizeSources(projectId,"task",taskIds,"configured-model",now);
    this.projects.authorizeAction(projectId,"planning.propose",now);
    const all=this.listTasks();
    const selected=taskIds.map(id=>{
      const task=all.find(t=>t.id===id);
      if(!task || !task.visible || task.completed || task.source!==null)
        throw Error("AI project planning may only use visible, incomplete personal tasks without an external source");
      return task;
    });
    const disclosed=selected.map(t=>({
      taskId:t.id,title:t.title.slice(0,120),dueDate:t.dueDate,priority:t.priority,
    }));
    const prompt=[
      "请只返回紧凑 JSON，不要 Markdown。格式严格为：",
      '{"slots":[{"taskId":"任务 ID","day":"YYYY-MM-DD","startMinute":1080}]}',
      "请为下面由用户明确选择的 1–8 个任务各安排最多一段学习时间，",
      "时间使用设备本地民用日期和午夜起的分钟数，开始时刻是15分钟的整数倍。",
      "不得安排在截止日期之后，不得超出给定窗口，不得改变任何任务或声称已写入日历。",
      "任务、截止时间和允许时间窗：",
      JSON.stringify({settings,tasks:disclosed}),
    ].join("\n");
    const preview=this.ai.prepare(prompt,now,"project-plan"); // Still no network request.
    this.pending={approvalId:preview.approvalId,projectId,settings,selected};
    return preview;
  }

  async confirm(idInput:unknown):Promise<AIPlanAccepted>{
    const approvalId=parseAIApprovalId(idInput);
    const pending=this.pending;
    this.pending=null; // Cannot reuse an already confirmed or failed plan context.
    if(!pending || pending.approvalId!==approvalId)
      throw Error("AI planning approval expired or was replaced");
    const verify=()=>{
      const now=this.now();
      // Permissions are re-read from the authoritative local registry. A
      // preview never freezes a grant: revoke/expiry/archive blocks sending.
      this.projects.authorizeSources(pending.projectId,"task",
        pending.selected.map(t=>t.id),"configured-model",now);
      this.projects.authorizeAction(pending.projectId,"planning.propose",now);
      const tasks=this.listTasks();
      if(pending.selected.some(t=>!tasks.some(current=>sameTask(current,t))))
        throw Error("A selected task changed; review and authorize the context again");
    };
    verify(); // Do not spend API budget on stale or revoked context.
    // AIService invokes this callback after key resolution, immediately before
    // reserving quota and making the external request.
    const answer=await this.ai.confirm(approvalId,this.now(),verify,"project-plan");
    let slots:AIPlanSlot[];
    try{slots=parseAIPlanSlots(answer.text);}
    catch{
      throw Error("The approved task summaries were already sent to the selected provider, but its response failed validation. No local plan proposal was saved; check provider usage.");
    }
    try{verify();} // Recheck after network latency, before creating a local proposal.
    catch{
      throw Error("The approved task summaries were already sent to the selected provider, but the project permission or task changed during the request. No local plan proposal was saved; check provider usage.");
    }
    let proposal:AIPlanAccepted["proposal"];
    try{
      proposal=this.planning.proposeFromAI(
        pending.settings,pending.selected,slots,this.now(),
      );
    }catch(error){
      const reason=error instanceof Error?error.message:"local schedule validation failed";
      throw Error("The approved task summaries were already sent to the selected provider, but the returned schedule could not be saved as a local proposal ("+reason+"). No calendar change was applied; check provider usage.");
    }
    return {proposal,providerModel:answer.model,usage:answer.usage};
  }
}
