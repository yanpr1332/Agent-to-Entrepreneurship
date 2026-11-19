import { afterEach,describe,expect,it } from "vitest";
import { PlanningStore } from "./planning-store";
import type { LocalTask } from "../shared/local-model";
import { dayOffset } from "../shared/planning-model";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const opened:PlanningStore[]=[];
function db(){const x=new PlanningStore(":memory:");opened.push(x);return x;}
afterEach(()=>{while(opened.length)opened.pop()!.close();});
const now=new Date("2026-11-10T06:00:00Z");
const prefs={startDate:"2026-11-11",days:3,dailyStart:"18:00",dailyEnd:"20:00",minutesPerTask:45};
const task=(id:string,title:string,dueDate:string|null,priority:"low"|"normal"|"high"="normal"):LocalTask=>({
 id,title,dueDate,priority,description:"",completed:false,visible:true,hiddenAt:null,
 retentionExpiresAt:null,source:null,createdAt:"2026-11-10T00:00:00Z",updatedAt:"2026-11-10T01:00:00Z",
});
const alpha=task("a","Exam revision","2026-11-12","high"),beta=task("b","Write report","2026-11-15");

describe("deterministic offline study time proposals",()=>{
  it("orders by deadlines, never moves existing tasks, leaves incomplete and hidden excluded",()=>{
    const p=db();
    const result=p.propose(prefs,[
      beta,alpha,{...task("c","Hidden","2026-11-11"),visible:false},
      {...task("d","Done","2026-11-11"),completed:true},
    ],now);
    expect(result.blocks.map(b=>b.taskId)).toEqual(["a","b"]);
    expect(result.blocks.map(b=>[b.day,b.startMinute])).toEqual([
      ["2026-11-11",1080],["2026-11-11",1125],
    ]);
    expect(p.proposals()[0].blocks).toHaveLength(2);
    expect(p.listCommitted()).toHaveLength(0);
  });

  it("allows selective, edited application without mutating task authority; supports undo",()=>{
    const p=db(),all=[alpha,beta];
    const proposal=p.propose(prefs,all,now);
    const chosen=proposal.blocks.find(b=>b.taskId==="b")!;
    const result=p.apply({
      proposalId:proposal.id,blockIds:[chosen.id],
      edits:[{blockId:chosen.id,day:"2026-11-12",startMinute:1140}],
    },all,now);
    expect(result.blocks[0]).toMatchObject({
      taskId:"b",day:"2026-11-12",startMinute:1140,state:"applied",
    });
    expect(all[1].dueDate).toBe("2026-11-15");
    expect(p.listCommitted()).toHaveLength(1);
    expect(p.undo(result.id)).toBe(true);
    expect(p.listCommitted()).toHaveLength(0);
    expect(p.undo(result.id)).toBe(false);
  });

  it("rejects any overlapping selected time block and preserves atomicity",()=>{
    const p=db(),all=[alpha,beta];
    const first=p.propose(prefs,all,now);
    expect(()=>p.apply({
      proposalId:first.id,blockIds:first.blocks.map(b=>b.id),
      edits:[{blockId:first.blocks[1].id,day:first.blocks[0].day,
        startMinute:first.blocks[0].startMinute}],
    },all,now)).toThrow("overlap");
    expect(p.listCommitted()).toHaveLength(0);
  });

  it("does not apply stale task completion or changed deadline",()=>{
    const p=db(),proposal=p.propose(prefs,[alpha],now);
    const input={proposalId:proposal.id,blockIds:[proposal.blocks[0].id],edits:[]};
    expect(()=>p.apply(input,[{...alpha,completed:true}],now)).toThrow("changed");
    expect(()=>p.apply(input,[{...alpha,dueDate:"2026-11-20"}],now)).toThrow("changed");
    expect(p.listCommitted()).toHaveLength(0);
  });

  it("prevents double application or duplicate scheduling across other proposals",()=>{
    const p=db(),all=[alpha,beta];
    const one=p.propose(prefs,all,now);
    const applied=p.apply({
      proposalId:one.id,blockIds:[one.blocks[0].id],edits:[],
    },all,now);
    expect(()=>p.apply({proposalId:one.id,blockIds:[one.blocks[0].id],edits:[]},all,now))
      .toThrow("already applied");
    const next=p.propose(prefs,all,now);
    expect(next.blocks.map(b=>b.taskId)).toEqual(["b"]);
    expect(next.skipped).toMatchObject([{taskId:"a"}]);
    expect(p.listCommitted()).toHaveLength(1);
    expect(p.undo(applied.id)).toBe(true);
  });

  it("rejects forged candidate IDs, changed task IDs and out of window edits",()=>{
    const p=db(),one=p.propose(prefs,[alpha],now);
    expect(()=>p.apply({
      proposalId:one.id,blockIds:["00000000-0000-4000-8000-000000000000"],edits:[],
    },[alpha],now)).toThrow("missing");
    expect(()=>p.apply({
      proposalId:one.id,blockIds:[one.blocks[0].id],
      edits:[{blockId:one.blocks[0].id,day:"2026-11-29",startMinute:1080}],
    },[alpha],now)).toThrow("outside");
    expect(()=>p.apply({
      proposalId:one.id,blockIds:[one.blocks[0].id],
      edits:[{blockId:one.blocks[0].id,day:"2026-11-11",startMinute:1215}],
    },[alpha],now)).toThrow("outside");
  });
  it("handles leap-year civil dates without moving due dates",()=>{
    expect(dayOffset("2028-02-28",1)).toBe("2028-02-29");
    expect(dayOffset("2028-02-28",2)).toBe("2028-03-01");
  });
});

describe("direct task schedule editing",()=>{
  const id="4db060d8-cb99-46fb-82f2-ff17fdc1cb22";
  const owner=task(id,"New manual task","2026-11-28");
  const slot={taskId:id,day:"2026-11-21",startMinute:1080,durationMinutes:45};

  it("creates multiple independent blocks without changing task due date",()=>{
    const p=db();
    const a=p.createManualBlock(slot,[owner],now);
    const b=p.createManualBlock({...slot,startMinute:1140},[owner],now);
    expect(a).toMatchObject({taskId:id,state:"applied",batchId:expect.any(String)});
    expect(b.id).not.toBe(a.id);
    expect(p.listCommitted().map(x=>x.startMinute)).toEqual([1080,1140]);
    expect(p.proposals()).toHaveLength(0);
    expect(p.batches()).toHaveLength(0);
    expect(owner.dueDate).toBe("2026-11-28");
    expect(p.removeCommittedBlock(a.id)).toBe(true);
    expect(p.removeCommittedBlock(a.id)).toBe(false);
    expect(p.listCommitted().map(x=>x.id)).toEqual([b.id]);
    expect(p.removeCommittedBlock(b.id)).toBe(true);
    expect(p.listCommitted()).toHaveLength(0);
  });

  it("edits a single committed block with conflict checks and atomic rejection",()=>{
    const p=db();
    const a=p.createManualBlock(slot,[owner],now);
    const b=p.createManualBlock({...slot,startMinute:1140},[owner],now);
    expect(()=>p.updateCommittedBlock({blockId:a.id,day:slot.day,
      startMinute:1140,durationMinutes:60})).toThrow("overlap");
    expect(p.listCommitted().find(x=>x.id===a.id)!.startMinute).toBe(1080);
    const moved=p.updateCommittedBlock({blockId:a.id,day:"2026-11-22",
      startMinute:1200,durationMinutes:90});
    expect(moved).toMatchObject({id:a.id,day:"2026-11-22",
      startMinute:1200,durationMinutes:90,taskDueDate:"2026-11-28"});
    expect(p.listCommitted().find(x=>x.id===b.id)!.day).toBe("2026-11-21");
    expect(owner.dueDate).toBe("2026-11-28");
  });

  it("rejects conflicting fixed classes, invalid tasks, and forged input",()=>{
    const blocked=new PlanningStore(":memory:",()=>[{
      day:"2026-11-21",startMinute:1080,durationMinutes:60,
    }]);opened.push(blocked);
    expect(()=>blocked.createManualBlock(slot,[owner],now)).toThrow("overlap");
    const safe=blocked.createManualBlock({...slot,startMinute:1170},[owner],now);
    expect(()=>blocked.updateCommittedBlock({blockId:safe.id,day:slot.day,
      startMinute:1090,durationMinutes:45})).toThrow("overlap");
    expect(()=>blocked.createManualBlock({...slot,startMinute:1260},[
      {...owner,visible:false}],now)).toThrow("visible");
    expect(()=>blocked.createManualBlock({...slot,startMinute:1260},[
      {...owner,completed:true}],now)).toThrow("visible");
    expect(()=>blocked.createManualBlock({...slot,taskId:"a"},[owner],now)).toThrow();
    expect(blocked.listCommitted()).toHaveLength(1);
  });

  it("does not mutate an entire generated batch when deleting one confirmed block",()=>{
    const p=db(),generated=p.propose(prefs,[alpha,beta],now);
    const applied=p.apply({proposalId:generated.id,
      blockIds:generated.blocks.map(b=>b.id),edits:[]},[alpha,beta],now);
    expect(applied.blocks).toHaveLength(2);
    expect(p.removeCommittedBlock(applied.blocks[0].id)).toBe(true);
    expect(p.listCommitted().map(b=>b.id)).toEqual([applied.blocks[1].id]);
    expect(p.batches()[0].blocks).toHaveLength(1);
    expect(p.undo(applied.id)).toBe(true);
    expect(p.listCommitted()).toHaveLength(0);
  });

  it("migrates v1 planning files without losing confirmed blocks",()=>{
    const folder=mkdtempSync(join(tmpdir(),"ate-planner-v1-"));
    const path=join(folder,"plans.sqlite");
    try{
      const first=new PlanningStore(path);
      const manual=first.createManualBlock(slot,[owner],now);
      first.close();
      const raw=new DatabaseSync(path);
      // Exact v1 shape: no source column and user_version 1.
      raw.exec("ALTER TABLE plan_proposals DROP COLUMN source; PRAGMA user_version=1");
      raw.close();
      const migrated=new PlanningStore(path);
      expect(migrated.listCommitted()).toMatchObject([{id:manual.id,
        taskId:owner.id,day:slot.day}]);
      expect(migrated.batches()).toHaveLength(1); // v1 has no source flag
      migrated.close();
      const again=new PlanningStore(path);
      expect(again.listCommitted()).toHaveLength(1);
      again.close();
    }finally{rmSync(folder,{recursive:true,force:true});}
  });
});
