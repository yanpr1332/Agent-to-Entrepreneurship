import { parseAIApprovalId, type AIPreview } from "../../shared/ai-model";
import { parseAIPlanPrepare,parseAIPlanSlots,type AIPlanAccepted } from "../../shared/ai-plan-model";
import type { LocalTask } from "../../shared/local-model";
import { PlanningStore } from "../planning-store";
import type { AIService } from "./ai-service";

interface PendingPlan {
  approvalId:string;
  settings:ReturnType<typeof parseAIPlanPrepare>["settings"];
  selected:LocalTask[];
}
function sameTask(a:LocalTask,b:LocalTask):boolean {
  return a.id===b.id && a.title===b.title && a.dueDate===b.dueDate &&
    a.priority===b.priority && a.updatedAt===b.updatedAt &&
    a.visible===b.visible && a.completed===b.completed;
}

/** Only Main can compose trusted task context and verify the final model output. */
export class AIPlanningCoordinator {
  private pending:PendingPlan|null=null;
  constructor(
    private readonly ai:Pick<AIService,"prepare"|"confirm">,
    private readonly planning:Pick<PlanningStore,"proposeFromAI">,
    private readonly listTasks:()=>LocalTask[],
    private readonly now:()=>Date=()=>new Date(),
  ){}

  prepare(input:unknown):AIPreview{
    const {taskIds,settings}=parseAIPlanPrepare(input);
    const all=this.listTasks();
    const selected=taskIds.map(id=>{
      const task=all.find(t=>t.id===id);
      if(!task || !task.visible || task.completed)
        throw Error("AI planning may only use your selected visible, incomplete tasks");
      return task;
    });
    const disclosed=selected.map(t=>({
      taskId:t.id,title:t.title.slice(0,120),dueDate:t.dueDate,priority:t.priority,
    }));
    const prompt=[
      "请只返回紧凑 JSON，不要 Markdown。格式严格为：",
      '{"slots":[{"taskId":"任务 ID","day":"YYYY-MM-DD","startMinute":1080}]}',
      "请为下面由用户明确选择的 1–5 个任务各安排最多一段学习时间，",
      "时间使用设备本地民用日期和午夜起的分钟数，开始时刻是15分钟的整数倍。",
      "不得安排在截止日期之后，不得超出给定窗口，不得改变任何任务或声称已写入日历。",
      "任务、截止时间和允许时间窗：",
      JSON.stringify({settings,tasks:disclosed}),
    ].join("\n");
    const preview=this.ai.prepare(prompt); // Still no network request.
    this.pending={approvalId:preview.approvalId,settings,selected};
    return preview;
  }

  async confirm(idInput:unknown):Promise<AIPlanAccepted>{
    const approvalId=parseAIApprovalId(idInput);
    const pending=this.pending;
    this.pending=null; // Cannot reuse an already confirmed or failed plan context.
    if(!pending || pending.approvalId!==approvalId)
      throw Error("AI planning approval expired or was replaced");
    const verify=()=>{
      const tasks=this.listTasks();
      if(pending.selected.some(t=>!tasks.some(now=>sameTask(now,t))))
        throw Error("A selected task changed; review and authorize the context again");
    };
    verify(); // Do not spend API budget on stale data.
    const answer=await this.ai.confirm(approvalId);
    const slots=parseAIPlanSlots(answer.text);
    verify(); // Recheck after network latency, before persisting any suggestion.
    const proposal=this.planning.proposeFromAI(
      pending.settings,pending.selected,slots,this.now(),
    );
    return {proposal,providerModel:answer.model,usage:answer.usage};
  }
}
