import { afterEach,describe,expect,it } from "vitest";
import { PlanningStore } from "./planning-store";
import type { LocalTask } from "../shared/local-model";
import { dayOffset } from "../shared/planning-model";

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
