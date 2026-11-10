import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import type { LocalTask } from "../shared/local-model";
import type { AIPlanSlot } from "../shared/ai-plan-model";
import {
  dayOffset, eligiblePlanningTasks, parsePlanApply, parsePlanningSettings, parseMinute,
  validCivilDay,
  type PlanBlock, type PlanningSettings, type PlanProposal, type AppliedPlanBatch,
} from "../shared/planning-model";

const MAX_PROPOSALS=15;
const MAX_TASKS=100;
interface BlockRow {
  id:string;proposal_id:string;task_id:string;task_title:string;
  task_updated_at:string;task_due_date:string|null;day:string;
  start_minute:number;duration_minutes:number;rationale:string;
  state:"proposed"|"applied";batch_id:string|null;
}
function toBlock(row:BlockRow):PlanBlock {
  return {id:row.id,taskId:row.task_id,taskTitle:row.task_title,
    taskUpdatedAt:row.task_updated_at,taskDueDate:row.task_due_date,day:row.day,
    startMinute:row.start_minute,durationMinutes:row.duration_minutes,
    rationale:row.rationale,state:row.state,batchId:row.batch_id};
}
function overlaps(a:{day:string;startMinute:number;durationMinutes:number},
                  b:{day:string;startMinute:number;durationMinutes:number}):boolean {
  return a.day===b.day && a.startMinute < b.startMinute+b.durationMinutes &&
    b.startMinute < a.startMinute+a.durationMinutes;
}

/** Distinct local SQLite authority for candidate schedule, not task mutation. */
export class PlanningStore {
  private readonly db:DatabaseSync;
  constructor(path:string){
    if(path!==":memory:")mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000");
    if(path!==":memory:")this.db.exec("PRAGMA journal_mode=WAL");
    const version=(this.db.prepare("PRAGMA user_version").get() as {user_version:number}).user_version;
    if(version>1)throw Error("A newer application created this planning database");
    if(version===0)this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE plan_proposals(
        id TEXT PRIMARY KEY,created_at TEXT NOT NULL,
        settings_json TEXT NOT NULL,skipped_json TEXT NOT NULL
      );
      CREATE TABLE plan_blocks(
        id TEXT PRIMARY KEY,proposal_id TEXT NOT NULL REFERENCES plan_proposals(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL,task_title TEXT NOT NULL,
        task_updated_at TEXT NOT NULL,task_due_date TEXT,
        day TEXT NOT NULL,start_minute INTEGER NOT NULL,
        duration_minutes INTEGER NOT NULL,rationale TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN('proposed','applied')),batch_id TEXT
      );
      CREATE INDEX plan_blocks_day ON plan_blocks(day,state);
      CREATE TABLE applied_batches(id TEXT PRIMARY KEY,applied_at TEXT NOT NULL);
      PRAGMA user_version=1;
      COMMIT;
    `);
  }
  close():void{this.db.close();}
  async backupTo(path:string):Promise<number>{return backup(this.db,path);}
  private blocksFor(proposalId:string):PlanBlock[]{
    return (this.db.prepare("SELECT * FROM plan_blocks WHERE proposal_id=? ORDER BY day,start_minute")
      .all(proposalId) as unknown as BlockRow[]).map(toBlock);
  }
  listCommitted():PlanBlock[]{
    return (this.db.prepare("SELECT * FROM plan_blocks WHERE state='applied' ORDER BY day,start_minute")
      .all() as unknown as BlockRow[]).map(toBlock);
  }
  proposals():PlanProposal[]{
    const rows=this.db.prepare("SELECT * FROM plan_proposals ORDER BY created_at DESC LIMIT 15")
      .all() as unknown as {id:string;created_at:string;settings_json:string;skipped_json:string}[];
    return rows.map(row=>({id:row.id,createdAt:row.created_at,
      settings:JSON.parse(row.settings_json) as PlanningSettings,
      skipped:JSON.parse(row.skipped_json) as PlanProposal["skipped"],
      blocks:this.blocksFor(row.id)}));
  }
  batches():AppliedPlanBatch[]{
    const rows=this.db.prepare("SELECT id,applied_at FROM applied_batches ORDER BY applied_at DESC LIMIT 50")
      .all() as unknown as {id:string;applied_at:string}[];
    const all=this.listCommitted();
    return rows.map(row=>({id:row.id,appliedAt:row.applied_at,
      blocks:all.filter(block=>block.batchId===row.id)}));
  }

  /**
   * Deterministic and transparent preview; no writes to task/calendar authority.
   * Each eligible task gets at most one proposed study block, and the engine
   * never overwrites an existing committed time block.
   */
  propose(raw:unknown,tasks:LocalTask[],now=new Date()):PlanProposal {
    const settings=parsePlanningSettings(raw);
    const today=[now.getFullYear(),String(now.getMonth()+1).padStart(2,"0"),
      String(now.getDate()).padStart(2,"0")].join("-");
    if(settings.startDate<today)throw Error("The planning window must not begin in the past");
    const start=parseMinute(settings.dailyStart),end=parseMinute(settings.dailyEnd);
    const committed=this.listCommitted();
    const planned:PlanBlock[]=[];
    const skipped:PlanProposal["skipped"]=[];
    const candidates=eligiblePlanningTasks(tasks).slice(0,MAX_TASKS);
    const id=randomUUID();
    for(const task of candidates){
      if(committed.some(b=>b.taskId===task.id)){
        skipped.push({taskId:task.id,reason:"该任务已经有确认的时间块"});
        continue;
      }
      let chosen:{day:string;startMinute:number}|null=null;
      for(let i=0;i<settings.days && !chosen;i++){
        const day=dayOffset(settings.startDate,i);
        if(task.dueDate && day>task.dueDate && task.dueDate>=settings.startDate)continue;
        for(let minute=start;minute+settings.minutesPerTask<=end;minute+=15){
          const test={day,startMinute:minute,durationMinutes:settings.minutesPerTask};
          if([...planned,...committed].some(other=>overlaps(test,other)))continue;
          chosen={day,startMinute:minute};
          break;
        }
      }
      if(!chosen){
        skipped.push({taskId:task.id,reason:"规划窗口内没有空闲时间或已超过任务截止日"});
        continue;
      }
      const rationale=task.dueDate
        ? `根据个人任务截止日 ${task.dueDate} 排序；时长为用户选择的估计值`
        : "任务没有截止日期；安排在窗口内的下一段空闲时间";
      planned.push({
        id:randomUUID(),taskId:task.id,taskTitle:task.title,
        taskUpdatedAt:task.updatedAt,taskDueDate:task.dueDate,
        day:chosen.day,startMinute:chosen.startMinute,durationMinutes:settings.minutesPerTask,
        rationale,state:"proposed",batchId:null,
      });
    }
    const proposal:PlanProposal={id,createdAt:now.toISOString(),settings,blocks:planned,skipped};
    this.persistProposal(proposal);
    return proposal;
  }

  /**
   * The model can ONLY choose proposed time slots for pre-approved task IDs.
   * There is no pathway to edit local tasks or commit the schedule here.
   */
  proposeFromAI(
    rawSettings:unknown, selectedTasks:LocalTask[], slots:AIPlanSlot[],now=new Date(),
  ):PlanProposal{
    const settings=parsePlanningSettings(rawSettings);
    if(!Array.isArray(slots) || slots.length<1 || slots.length>5)
      throw Error("AI returned an invalid number of schedule blocks");
    const today=[now.getFullYear(),String(now.getMonth()+1).padStart(2,"0"),
      String(now.getDate()).padStart(2,"0")].join("-");
    if(settings.startDate<today)throw Error("Planning window is already in the past");
    const taskMap=new Map(selectedTasks.filter(t=>t.visible&&!t.completed).map(t=>[t.id,t]));
    const known=new Set<string>();
    const already=this.listCommitted();
    const planned:PlanBlock[]=[];
    const lastDay=dayOffset(settings.startDate,settings.days-1);
    const start=parseMinute(settings.dailyStart),end=parseMinute(settings.dailyEnd);
    for(const item of slots){
      if(!item || typeof item.taskId!=="string" || !taskMap.has(item.taskId) ||
         known.has(item.taskId))throw Error("AI referenced an unknown or duplicate task");
      if(!validCivilDay(item.day) || item.day<settings.startDate || item.day>lastDay ||
         !Number.isSafeInteger(item.startMinute) || item.startMinute%15!==0 ||
         item.startMinute<start || item.startMinute+settings.minutesPerTask>end)
        throw Error("AI suggested a time outside the selected planning window");
      const task=taskMap.get(item.taskId)!;
      if(task.dueDate && item.day>task.dueDate)throw Error("AI suggested a slot after a task deadline");
      if(already.some(block=>block.taskId===task.id))
        throw Error("AI tried to schedule a task that was already planned");
      const proposed={day:item.day,startMinute:item.startMinute,durationMinutes:settings.minutesPerTask};
      if([...already,...planned].some(block=>overlaps(proposed,block)))
        throw Error("AI suggested overlapping schedule blocks");
      known.add(task.id);
      planned.push({
        id:randomUUID(),taskId:task.id,taskTitle:task.title,
        taskUpdatedAt:task.updatedAt,taskDueDate:task.dueDate,
        day:item.day,startMinute:item.startMinute,durationMinutes:settings.minutesPerTask,
        rationale:"AI 建议：仅根据你明确选择的任务与规划时间窗生成；请核对真实课程和其他日程",
        state:"proposed",batchId:null,
      });
    }
    const skipped=selectedTasks.filter(t=>!known.has(t.id))
      .map(t=>({taskId:t.id,reason:"AI 未为此任务提供符合规则的安排"}));
    const proposal:PlanProposal={
      id:randomUUID(),createdAt:now.toISOString(),settings,blocks:planned,skipped,
    };
    this.persistProposal(proposal);
    return proposal;
  }

  private persistProposal(proposal:PlanProposal):void {
    const {id,createdAt,settings,skipped,blocks:planned}=proposal;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare("INSERT INTO plan_proposals(id,created_at,settings_json,skipped_json) VALUES(?,?,?,?)")
        .run(id,createdAt,JSON.stringify(settings),JSON.stringify(skipped));
      const insert=this.db.prepare(`INSERT INTO plan_blocks(
        id,proposal_id,task_id,task_title,task_updated_at,task_due_date,
        day,start_minute,duration_minutes,rationale,state,batch_id
      ) VALUES(?,?,?,?,?,?,?,?,?,?,'proposed',NULL)`);
      for(const b of planned)insert.run(b.id,id,b.taskId,b.taskTitle,b.taskUpdatedAt,
        b.taskDueDate,b.day,b.startMinute,b.durationMinutes,b.rationale);
      const stale=this.db.prepare(`SELECT id FROM plan_proposals ORDER BY created_at DESC
        LIMIT -1 OFFSET ?`).all(MAX_PROPOSALS) as {id:string}[];
      for(const row of stale){
        const exists=this.db.prepare("SELECT 1 FROM plan_blocks WHERE proposal_id=? AND state='applied' LIMIT 1")
          .get(row.id);
        if(!exists)this.db.prepare("DELETE FROM plan_proposals WHERE id=?").run(row.id);
      }
      this.db.exec("COMMIT");
    }catch(e){this.db.exec("ROLLBACK");throw e;}
  }

  /** Atomic selected application. Reject stale tasks, forged IDs and overlaps. */
  apply(raw:unknown,tasks:LocalTask[],now=new Date()):AppliedPlanBatch {
    const req=parsePlanApply(raw);
    const proposal=this.proposals().find(p=>p.id===req.proposalId);
    if(!proposal)throw Error("Planning proposal was not found");
    const options=new Map(proposal.blocks.map(b=>[b.id,b]));
    const edits=new Map(req.edits.map(edit=>[edit.blockId,edit]));
    const chosen=req.blockIds.map(id=>{
      const original=options.get(id);
      if(!original || original.state!=="proposed")throw Error("A selected block is missing or already applied");
      const edit=edits.get(id);
      const b={...original,day:edit?.day??original.day,
        startMinute:edit?.startMinute??original.startMinute};
      const endDay=dayOffset(proposal.settings.startDate,proposal.settings.days-1);
      const start=parseMinute(proposal.settings.dailyStart);
      const end=parseMinute(proposal.settings.dailyEnd);
      if(!validCivilDay(b.day) || b.day<proposal.settings.startDate ||
        b.day>endDay || b.startMinute<start ||
        b.startMinute+b.durationMinutes>end || b.startMinute%15!==0)
        throw Error("Edited time block falls outside the allowed planning window");
      return b;
    });
    const existing=this.listCommitted();
    const taskMap=new Map(tasks.map(t=>[t.id,t]));
    for(const b of chosen){
      const current=taskMap.get(b.taskId);
      if(!current || !current.visible || current.completed ||
        current.updatedAt!==b.taskUpdatedAt || current.dueDate!==b.taskDueDate)
        throw Error("A task changed since preview; regenerate the plan before applying");
      if(existing.some(x=>x.taskId===b.taskId))
        throw Error("A task has already been scheduled");
      if([...existing,...chosen.filter(x=>x.id!==b.id)].some(x=>overlaps(x,b)))
        throw Error("Proposed blocks overlap an existing or selected time block");
    }
    const batchId=randomUUID(),appliedAt=now.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try{
      this.db.prepare("INSERT INTO applied_batches(id,applied_at) VALUES(?,?)").run(batchId,appliedAt);
      const update=this.db.prepare(`UPDATE plan_blocks SET state='applied',batch_id=?,
        day=?,start_minute=? WHERE id=? AND state='proposed'`);
      for(const b of chosen){
        const changed=Number(update.run(batchId,b.day,b.startMinute,b.id).changes);
        if(changed!==1)throw Error("Selected time block was already applied");
      }
      this.db.exec("COMMIT");
    }catch(e){this.db.exec("ROLLBACK");throw e;}
    return {id:batchId,appliedAt,blocks:chosen.map(b=>({...b,state:"applied" as const,batchId}))};
  }

  /** Undo only this batch of generated blocks, never user tasks. */
  undo(value:unknown):boolean {
    if(typeof value!=="string" || !/^[0-9a-f-]{36}$/i.test(value))
      throw Error("Invalid applied plan identifier");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const removed=Number(this.db.prepare("DELETE FROM applied_batches WHERE id=?").run(value).changes);
      if(removed!==1){this.db.exec("ROLLBACK");return false;}
      this.db.prepare(`UPDATE plan_blocks SET state='proposed',batch_id=NULL
        WHERE batch_id=? AND state='applied'`).run(value);
      this.db.exec("COMMIT");
      return true;
    }catch(e){this.db.exec("ROLLBACK");throw e;}
  }
}
