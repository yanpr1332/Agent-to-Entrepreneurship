import {describe,expect,it,vi} from "vitest";
import {AIPlanningCoordinator} from "./ai-planner";
import {PlanningStore} from "../planning-store";
import type {LocalTask} from "../../shared/local-model";
const id1="dc926d48-ac41-46a1-8a4c-e9308b32b301",id2="ec926d48-ac41-46a1-8a4c-e9308b32b302";
const approvalId="a42e9abc-42e9-4a2e-8b7c-a42e9a42e9a4";
const task=(id:string,title:string):LocalTask=>({
  id,title,description:"SECRET PERSONAL NOTES",dueDate:"2026-11-12",
  priority:"high",completed:false,visible:true,hiddenAt:null,retentionExpiresAt:null,
  createdAt:"2026-11-10T00:00:00Z",updatedAt:"2026-11-10T00:00:00Z",source:null,
});
const settings={startDate:"2026-11-11",days:2,dailyStart:"18:00",dailyEnd:"21:00",minutesPerTask:45};
const baseTime=new Date("2026-11-10T00:00:00Z");

function setup(){
  const store=new PlanningStore(":memory:");
  let tasks=[task(id1,"Math revision"),task(id2,"Lab report")];
  const prepare=vi.fn((prompt:string)=>({
    approvalId,prompt,model:"gpt-4.1-mini",
    expiresAt:"2026-11-12T00:00:00Z",maxOutputTokens:512,
  }));
  const confirm=vi.fn(async()=>({
    text:JSON.stringify({slots:[{taskId:id1,day:"2026-11-11",startMinute:1080}]}),
    model:"gpt-4.1-mini",usage:{inputTokens:180,outputTokens:45},
    createdAt:baseTime.toISOString(),
  }));
  const coordinator=new AIPlanningCoordinator({prepare,confirm},store,()=>tasks,()=>baseTime);
  return {store,coordinator,prepare,confirm,setTasks:(next:LocalTask[])=>{tasks=next;}};
}

describe("AI opt-in planning with authoritative validation",()=>{
  it("only discloses specifically selected task summaries and never sends notes",async()=>{
    const f=setup();
    const preview=f.coordinator.prepare({taskIds:[id1],settings});
    expect(preview.prompt).toContain("Math revision");
    expect(preview.prompt).not.toContain("Lab report");
    expect(preview.prompt).not.toContain("SECRET PERSONAL NOTES");
    expect(f.confirm).not.toHaveBeenCalled();
    const next=await f.coordinator.confirm(approvalId);
    expect(next.proposal.blocks).toHaveLength(1);
    expect(next.proposal.blocks[0]).toMatchObject({taskId:id1,day:"2026-11-11",state:"proposed"});
    expect(f.store.listCommitted()).toHaveLength(0);
    f.store.close();
  });
  it("rejects changed task before spending a request",async()=>{
    const f=setup();
    f.coordinator.prepare({taskIds:[id1],settings});
    f.setTasks([{...task(id1,"Math revision"),completed:true}]);
    await expect(f.coordinator.confirm(approvalId)).rejects.toThrow("changed");
    expect(f.confirm).not.toHaveBeenCalled();
    f.store.close();
  });
  it("rejects forged or expired context and model-made-up task IDs",async()=>{
    const f=setup();
    f.coordinator.prepare({taskIds:[id1],settings});
    await expect(f.coordinator.confirm("c1231234-4321-4bad-8123-123412341234"))
      .rejects.toThrow("expired");
    f.coordinator.prepare({taskIds:[id1],settings});
    f.confirm.mockResolvedValueOnce({
      text:JSON.stringify({slots:[{taskId:id2,day:"2026-11-11",startMinute:1080}]}),
      model:"gpt-4.1-mini",usage:{inputTokens:100,outputTokens:35},
      createdAt:baseTime.toISOString(),
    });
    await expect(f.coordinator.confirm(approvalId)).rejects.toThrow("unknown");
    expect(f.store.listCommitted()).toHaveLength(0);
    f.store.close();
  });
  it("rejects hidden task authorization and leaves local tasks untouched",()=>{
    const f=setup();
    f.setTasks([{...task(id1,"Hidden"),visible:false}]);
    expect(()=>f.coordinator.prepare({taskIds:[id1],settings})).toThrow("visible");
    expect(f.prepare).not.toHaveBeenCalled();
    f.store.close();
  });
});
