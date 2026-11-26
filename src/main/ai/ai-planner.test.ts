import {afterEach,describe,expect,it,vi} from "vitest";
import {AIPlanningCoordinator} from "./ai-planner";
import {AIProjectStore} from "./ai-project-store";
import {PlanningStore} from "../planning-store";
import type {LocalTask} from "../../shared/local-model";
const id1="dc926d48-ac41-46a1-8a4c-e9308b32b301",id2="ec926d48-ac41-46a1-8a4c-e9308b32b302";
const approvalId="a42e9abc-42e9-4a2e-8b7c-a42e9a42e9a4";
const task=(id:string,title:string):LocalTask=>({
  id,title,description:"SECRET PERSONAL NOTES",dueDate:"2026-12-12",
  priority:"high",completed:false,visible:true,hiddenAt:null,retentionExpiresAt:null,
  createdAt:"2026-11-10T00:00:00Z",updatedAt:"2026-11-10T00:00:00Z",source:null,
});
const settings={startDate:"2026-11-27",days:2,dailyStart:"18:00",dailyEnd:"21:00",minutesPerTask:45};
const baseTime=new Date("2026-11-26T00:00:00Z");
const stores:(PlanningStore|AIProjectStore)[]=[];
function setup(){
  const planning=new PlanningStore(":memory:");stores.push(planning);
  const projects=new AIProjectStore(":memory:");stores.push(projects);
  const project=projects.createProject({name:"Study",purpose:"Test project"},baseTime);
  for(const id of [id1,id2])projects.setSourceGrant({
    projectId:project.id,sourceType:"task",sourceId:id,
    canReadLocal:true,canSendRemote:true,expiresAt:null,
  },baseTime);
  projects.setActionGrant({projectId:project.id,action:"planning.propose",
    enabled:true,expiresAt:null},baseTime);
  let tasks=[task(id1,"Math revision"),task(id2,"Lab report")];
  const prepare=vi.fn((prompt:string)=>({
    approvalId,prompt,model:"gpt-4.1-mini",provider:"openai" as const,endpointLabel:"openai",
    expiresAt:"2026-11-28T00:00:00Z",maxOutputTokens:512,
  }));
  const confirm=vi.fn(async(_id:string,_now?:Date,authorize?:()=>void)=>{
    authorize?.();
    return {
      text:JSON.stringify({slots:[{taskId:id1,day:"2026-11-27",startMinute:1080}]}),
      model:"gpt-4.1-mini",usage:{inputTokens:180,outputTokens:45},
      createdAt:baseTime.toISOString(),
    };
  });
  const coordinator=new AIPlanningCoordinator({prepare,confirm},planning,()=>tasks,projects,()=>baseTime);
  return {planning,projects,project,coordinator,prepare,confirm,
    setTasks:(next:LocalTask[])=>{tasks=next;}};
}
afterEach(()=>{while(stores.length)stores.pop()!.close();});

describe("AI project scoped planning with authoritative validation",()=>{
  it("only discloses project-authorized task summaries and never sends notes",async()=>{
    const f=setup();
    const preview=f.coordinator.prepare({projectId:f.project.id,taskIds:[id1],settings});
    expect(preview.prompt).toContain("Math revision");
    expect(preview.prompt).not.toContain("Lab report");
    expect(preview.prompt).not.toContain("SECRET PERSONAL NOTES");
    expect(f.prepare).toHaveBeenCalledWith(expect.any(String),baseTime,"project-plan");
    expect(f.confirm).not.toHaveBeenCalled();
    const next=await f.coordinator.confirm(approvalId);
    expect(f.confirm).toHaveBeenCalledWith(approvalId,baseTime,expect.any(Function),"project-plan");
    expect(next.proposal.blocks).toHaveLength(1);
    expect(next.proposal.blocks[0]).toMatchObject({taskId:id1,day:"2026-11-27",state:"proposed"});
    expect(f.planning.listCommitted()).toHaveLength(0);
  });
  it("requires both local read and cloud transmission grants before preparing a request",()=>{
    const f=setup();
    f.projects.setSourceGrant({projectId:f.project.id,sourceType:"task",sourceId:id1,
      canReadLocal:true,canSendRemote:false,expiresAt:null},baseTime);
    expect(()=>f.coordinator.prepare({projectId:f.project.id,taskIds:[id1],settings}))
      .toThrow("configured model endpoint transmission");
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("requires a separate explicit planning action grant",()=>{
    const f=setup();
    f.projects.setActionGrant({projectId:f.project.id,action:"planning.propose",
      enabled:false,expiresAt:null},baseTime);
    expect(()=>f.coordinator.prepare({projectId:f.project.id,taskIds:[id1],settings}))
      .toThrow("planning.propose");
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("rejects changed task or revoked project source before spending a request",async()=>{
    const f=setup();
    f.coordinator.prepare({projectId:f.project.id,taskIds:[id1],settings});
    f.setTasks([{...task(id1,"Math revision"),completed:true}]);
    await expect(f.coordinator.confirm(approvalId)).rejects.toThrow("changed");
    expect(f.confirm).not.toHaveBeenCalled();
    f.setTasks([task(id1,"Math revision")]);
    f.coordinator.prepare({projectId:f.project.id,taskIds:[id1],settings});
    f.projects.revokeSourceGrant({projectId:f.project.id,sourceType:"task",sourceId:id1},baseTime);
    await expect(f.coordinator.confirm(approvalId)).rejects.toThrow("configured model endpoint transmission");
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it("rechecks revocation after asynchronous credential resolution and before network send",async()=>{
    const f=setup();
    f.coordinator.prepare({projectId:f.project.id,taskIds:[id1],settings});
    f.confirm.mockImplementationOnce(async(_id,_now,authorize)=>{
      f.projects.revokeSourceGrant({projectId:f.project.id,sourceType:"task",sourceId:id1},baseTime);
      authorize?.();
      return {text:"{}",model:"test",usage:{inputTokens:0,outputTokens:0},createdAt:baseTime.toISOString()};
    });
    await expect(f.coordinator.confirm(approvalId)).rejects.toThrow("configured model endpoint transmission");
    expect(f.planning.listCommitted()).toHaveLength(0);
  });
  it("rejects Canvas-sourced tasks even if a stale or forged project grant exists",()=>{
    const f=setup();
    f.setTasks([{...task(id1,"Canvas assignment"),source:{
      provider:"canvas",instanceUrl:"https://canvas.example.edu",accountId:1,
      courseId:2,assignmentId:3,sourceUrl:"https://canvas.example.edu/assignments/3",
      lastSyncedAt:"2026-11-26T00:00:00Z",
    }}]);
    expect(()=>f.coordinator.prepare({projectId:f.project.id,taskIds:[id1],settings}))
      .toThrow("without an external source");
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("rejects hidden tasks and archived projects without contacting the provider",()=>{
    const f=setup();
    f.setTasks([{...task(id1,"Hidden"),visible:false}]);
    expect(()=>f.coordinator.prepare({projectId:f.project.id,taskIds:[id1],settings})).toThrow("visible");
    f.setTasks([task(id1,"Math revision")]);
    f.projects.archiveProject(f.project.id,baseTime);
    expect(()=>f.coordinator.prepare({projectId:f.project.id,taskIds:[id1],settings})).toThrow("archived");
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("rejects forged approval and model-made-up task IDs",async()=>{
    const f=setup();
    f.coordinator.prepare({projectId:f.project.id,taskIds:[id1],settings});
    await expect(f.coordinator.confirm("c1231234-4321-4bad-8123-123412341234"))
      .rejects.toThrow("expired");
    f.coordinator.prepare({projectId:f.project.id,taskIds:[id1],settings});
    f.confirm.mockResolvedValueOnce({
      text:JSON.stringify({slots:[{taskId:id2,day:"2026-11-27",startMinute:1080}]}),
      model:"gpt-4.1-mini",usage:{inputTokens:100,outputTokens:35},
      createdAt:baseTime.toISOString(),
    });
    await expect(f.coordinator.confirm(approvalId)).rejects.toThrow("unknown");
    expect(f.planning.listCommitted()).toHaveLength(0);
  });
});
