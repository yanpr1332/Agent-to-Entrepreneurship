import {afterEach,describe,expect,it} from "vitest";
import {PlanningStore} from "../planning-store";
import type {LocalTask} from "../../shared/local-model";
const tasks:LocalTask[]=[
  {
    id:"bc8e1c94-68ab-4ee1-9851-1437e10fc011",
    title:"Course examination",description:"Never upload this private text",
    dueDate:"2026-11-12",priority:"high",completed:false,visible:true,
    hiddenAt:null,retentionExpiresAt:null,source:null,
    createdAt:"2026-11-10T00:00:00Z",updatedAt:"2026-11-10T00:00:00Z",
  },
  {
    id:"bc8e1c94-68ab-4ee1-9851-1437e10fc012",
    title:"Write report",description:"",
    dueDate:null,priority:"normal",completed:false,visible:true,
    hiddenAt:null,retentionExpiresAt:null,source:null,
    createdAt:"2026-11-10T00:00:00Z",updatedAt:"2026-11-10T00:00:00Z",
  },
];
const prefs={startDate:"2026-11-11",days:2,dailyStart:"18:00",dailyEnd:"21:00",minutesPerTask:45};
const now=new Date("2026-11-10T01:00:00Z");
const block=(taskId:string,day="2026-11-11",startMinute=1080)=>({taskId,day,startMinute});
const stores:PlanningStore[]=[];
function store(){const s=new PlanningStore(":memory:");stores.push(s);return s;}
afterEach(()=>{while(stores.length)stores.pop()!.close();});

describe("AI-generated schedule validation never bypasses local rules",()=>{
  it("creates a user-reviewable proposal only and supports the normal apply/undo workflow",()=>{
    const db=store();
    const proposal=db.proposeFromAI(prefs,tasks,[block(tasks[0].id)],now);
    expect(proposal.blocks).toHaveLength(1);
    expect(proposal.blocks[0].state).toBe("proposed");
    expect(proposal.skipped).toHaveLength(1);
    expect(db.listCommitted()).toEqual([]);
    const applied=db.apply({proposalId:proposal.id,blockIds:[proposal.blocks[0].id],edits:[]},tasks,now);
    expect(applied.blocks).toHaveLength(1);
    expect(db.undo(applied.id)).toBe(true);
    expect(tasks[0].dueDate).toBe("2026-11-12");
  });

  it("rejects a hallucinated task or a duplicate task",()=>{
    const db=store();
    expect(()=>db.proposeFromAI(prefs,tasks,[block("99999999-9999-4999-8999-999999999999")],now))
      .toThrow("unknown");
    expect(()=>db.proposeFromAI(prefs,tasks,[block(tasks[0].id),block(tasks[0].id,"2026-11-12")],now))
      .toThrow("duplicate");
    expect(db.proposals()).toHaveLength(0);
  });

  it("rejects out-of-window times, missed deadlines and internal overlap",()=>{
    const db=store();
    expect(()=>db.proposeFromAI(prefs,tasks,[block(tasks[0].id,"2026-11-15")],now))
      .toThrow("outside");
    expect(()=>db.proposeFromAI(prefs,tasks,[block(tasks[0].id,"2026-11-13")],now))
      .toThrow("outside");
    expect(()=>db.proposeFromAI(prefs,tasks,[block(tasks[0].id,"2026-11-11",1200)],now))
      .toThrow("outside");
    expect(()=>db.proposeFromAI(prefs,tasks,[
      block(tasks[0].id),block(tasks[1].id,"2026-11-11",1080),
    ],now)).toThrow("overlapping");
    expect(db.proposals()).toHaveLength(0);
  });

  it("rejects a slot that collides with a previously confirmed time block",()=>{
    const db=store();
    const existing=db.propose(prefs,[tasks[0]],now);
    db.apply({proposalId:existing.id,blockIds:[existing.blocks[0].id],edits:[]},tasks,now);
    expect(()=>db.proposeFromAI(prefs,tasks,[block(tasks[1].id)],now))
      .toThrow("overlapping");
    expect(db.listCommitted()).toHaveLength(1);
  });
});
