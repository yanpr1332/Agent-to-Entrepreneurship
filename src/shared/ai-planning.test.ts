import { describe,expect,it } from "vitest";
import type { LocalTask } from "./local-model";
import { buildAIPlanPrompt,eligibleAIPlanTasks,parseAIPlanDraft } from "./ai-planning";
const task=(id:string,extra:Partial<LocalTask>={}):LocalTask=>({
  id,title:"微积分习题",description:"PRIVATE DESCRIPTION",
  dueDate:"2026-11-14",priority:"high",completed:false,visible:true,
  createdAt:"2026-11-10T00:00:00Z",updatedAt:"2026-11-10T00:00:00Z",
  hiddenAt:null,retentionExpiresAt:null,
  source:null,...extra,
});
const a=task("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const b=task("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const response=(blocks:unknown)=>JSON.stringify({blocks});
const good={taskId:a.id,day:"2026-11-12",start:"18:15",minutes:45,reason:"临近截止日"};
describe("opt-in AI planning",()=>{
  it("sends only explicitly selected public task fields, never description/source",()=>{
    const prompt=buildAIPlanPrompt([a,b],[a.id],"2026-11-10");
    expect(prompt).toContain(a.id);
    expect(prompt).not.toContain(b.id);
    expect(prompt).not.toContain("PRIVATE DESCRIPTION");
    expect(prompt).toContain("微积分习题");
  });
  it("rejects unchecked, hidden and finished tasks and duplicates",()=>{
    expect(()=>eligibleAIPlanTasks([a,b],[b.id,b.id])).toThrow();
    expect(()=>eligibleAIPlanTasks([a,task(b.id,{visible:false})],[b.id])).toThrow();
    expect(()=>eligibleAIPlanTasks([a,task(b.id,{completed:true})],[b.id])).toThrow();
    expect(()=>eligibleAIPlanTasks([a,b],[])).toThrow();
  });
  it("accepts strict JSON for selected task inside the window",()=>{
    expect(parseAIPlanDraft(response([good]),[a],"2026-11-10")).toEqual([good]);
  });
  it("rejects hallucinated IDs, duplicates and unapproved fields",()=>{
    expect(()=>parseAIPlanDraft(response([{...good,taskId:b.id}]),[a],"2026-11-10")).toThrow();
    expect(()=>parseAIPlanDraft(response([good,good]),[a,b],"2026-11-10")).toThrow();
    expect(()=>parseAIPlanDraft(response([{...good,execute:true}]),[a],"2026-11-10")).toThrow();
  });
  it("rejects invalid JSON, dates, slot bounds and model instructions",()=>{
    expect(()=>parseAIPlanDraft("not json",[a],"2026-11-10")).toThrow();
    expect(()=>parseAIPlanDraft(response([{...good,day:"2026-11-18"}]),[a],"2026-11-10")).toThrow();
    expect(()=>parseAIPlanDraft(response([{...good,start:"22:45",minutes:45}]),[a],"2026-11-10")).toThrow();
    expect(()=>parseAIPlanDraft(response([{...good,reason:""}]),[a],"2026-11-10")).toThrow();
  });
});
