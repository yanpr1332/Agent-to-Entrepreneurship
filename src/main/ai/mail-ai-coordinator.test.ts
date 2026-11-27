import {afterEach,describe,expect,it,vi} from "vitest";
import {MailAIReviewCoordinator} from "./mail-ai-coordinator";
import {LocalStore} from "../local-store";
import type {MailRecord} from "../../shared/mail-model";
const id="07dd8395-fdb5-43b8-8b0c-ce4715cf98d0";
const account="student@sjtu.edu.cn";
const row:MailRecord={
  account,uidValidity:5,uid:13,from:"Teacher <teacher@sjtu.edu.cn>",
  subject:"Lab report is due 2026-12-05",date:"2026-11-25T09:00:00Z",
  messageId:"<13@sjtu.edu.cn>",receivedAt:"2026-11-25T09:02:00Z",
};
const second:MailRecord={...row,uid:14,subject:"Weekly lab report",messageId:"<14@sjtu.edu.cn>"};
const stores:LocalStore[]=[];
afterEach(()=>{while(stores.length)stores.pop()!.close();});
function fixture(){
  const store=new LocalStore(":memory:");stores.push(store);
  let now=Date.parse("2026-11-25T11:00:00Z");
  let headers=[row,second];
  const prepare=vi.fn((prompt:string)=>({
    approvalId:id,prompt,model:"gpt-4.1-mini",provider:"openai" as const,endpointLabel:"openai",
    expiresAt:new Date(now+120000).toISOString(),maxOutputTokens:512,
  }));
  const confirm=vi.fn(async()=>({
    text:JSON.stringify({items:[{
      uid:13,uidValidity:5,kind:"coursework",title:"Write lab report",
      dueDate:"2026-12-05",reason:"Explicit due date is in subject",
    }]}),
    model:"gpt-4.1-mini",usage:{inputTokens:90,outputTokens:70},
    createdAt:new Date(now).toISOString(),
  }));
  const readBody=vi.fn(async()=>"Teacher: please submit lab report 2026-12-06");
  const coordinator=new MailAIReviewCoordinator({prepare,confirm},{
    list:async()=>headers,
    readBody,
    decisions:addr=>store.mailCandidateDecisions(addr),
    accept:(record,draft)=>store.reviewMailCandidate(record,"accept",draft),
  },()=>now);
  return {store,coordinator,prepare,confirm,readBody,
    setHeaders:(value:MailRecord[])=>{headers=value;},
    advance:(ms:number)=>{now+=ms;}};
}
const selection={sources:[{uidValidity:5,uid:13}]};
const apply=(reviewId:string)=>({
  reviewId,uidValidity:5,uid:13,
  title:"Write edited lab report",dueDate:"2026-12-08",
});
describe("Alpha 01 mail AI user consent and source-safe task creation",()=>{
  it("sends only selected authorized headers after one paid confirmation",async()=>{
    const f=fixture();
    const preview=await f.coordinator.prepare(selection);
    expect(preview.prompt).toContain(row.subject);
    expect(preview.prompt).toContain(row.from);
    expect(preview.prompt).not.toContain(second.subject);
    expect(preview.prompt).not.toContain("secret mail body");
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.prepare).toHaveBeenCalledWith(expect.any(String),expect.any(Date),"mail");
    expect(f.store.listTasks()).toHaveLength(0);
    const result=await f.coordinator.confirm(id);
    expect(f.confirm).toHaveBeenCalledWith(id,expect.any(Date),undefined,"mail");
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(result.items).toMatchObject([{
      uidValidity:5,uid:13,kind:"coursework",dueDate:"2026-12-05",
    }]);
    expect(f.store.listTasks()).toHaveLength(0);
    const task=await f.coordinator.apply(apply(result.reviewId));
    expect(task).toMatchObject({action:"accept",created:true});
    expect(f.store.listTasks()).toMatchObject([{title:"Write edited lab report",
      dueDate:"2026-12-08",source:null,priority:"normal"}]);
    const retry=await f.coordinator.apply(apply(result.reviewId));
    expect(retry).toEqual({...task,created:false});
    expect(f.store.listTasks()).toHaveLength(1);
    expect(f.store.mailCandidateDecisions(account)).toHaveLength(1);
  });

  it("never accesses a body unless explicitly authorized, and previews exact selected text",async()=>{
    const f=fixture();
    const without=await f.coordinator.prepare(selection);
    expect(without.prompt).not.toContain("Teacher: please submit");
    expect(f.readBody).not.toHaveBeenCalled();
    const withBody=await f.coordinator.prepare({...selection,includeBodies:true});
    expect(f.readBody).toHaveBeenCalledTimes(1);
    expect(withBody.prompt).toContain("Teacher: please submit lab report 2026-12-06");
    expect(f.confirm).not.toHaveBeenCalled();
    f.confirm.mockResolvedValueOnce({
      text:JSON.stringify({items:[{
        uid:13,uidValidity:5,kind:"coursework",title:"Submit report",
        dueDate:"2026-12-06",reason:"Approved plain-text body cited exact due date",
      }]}),model:"gpt-4.1-mini",usage:{inputTokens:50,outputTokens:20},
      createdAt:"2026-11-25T11:00:00Z",
    });
    const reviewed=await f.coordinator.confirm(id);
    expect(reviewed.items[0].dueDate).toBe("2026-12-06");
    expect(f.store.listTasks()).toHaveLength(0);
  });
  it("rejects stale changed/removed mails before charging or task writes",async()=>{
    const f=fixture();
    await f.coordinator.prepare(selection);
    f.setHeaders([{...row,subject:"changed after preview"},second]);
    await expect(f.coordinator.confirm(id)).rejects.toThrow("changed");
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.store.listTasks()).toHaveLength(0);
  });
  it("rejects mailbox changes after network latency and skips suggestions",async()=>{
    const f=fixture();
    await f.coordinator.prepare(selection);
    f.confirm.mockImplementationOnce(async()=>{
      f.setHeaders([{...row,uidValidity:6},second]);
      return {text:JSON.stringify({items:[{
        uid:13,uidValidity:5,kind:"coursework",title:"New title",dueDate:null,reason:"",
      }]}),model:"gpt-4.1-mini",usage:{inputTokens:8,outputTokens:9},
        createdAt:"2026-11-25T11:00:00Z"};
    });
    await expect(f.coordinator.confirm(id)).rejects.toThrow("changed");
    expect(f.store.listTasks()).toHaveLength(0);
  });
  it("rejects invented due dates and unapproved IDs even after AI answer",async()=>{
    const f=fixture();
    await f.coordinator.prepare(selection);
    f.confirm.mockResolvedValueOnce({
      text:JSON.stringify({items:[{
        uid:13,uidValidity:5,kind:"deadline",title:"Submit",
        dueDate:"2026-12-01",reason:"Guess",
      }]}),model:"gpt-4.1-mini",usage:{inputTokens:9,outputTokens:8},
      createdAt:"2026-11-25T11:00:00Z",
    });
    await expect(f.coordinator.confirm(id)).rejects.toThrow("unsupported");
    expect(f.store.listTasks()).toHaveLength(0);
  });
  it("does not analyze already accepted/ignored sources or forge body/source",async()=>{
    const f=fixture();
    f.store.reviewMailCandidate(row,"ignore");
    await expect(f.coordinator.prepare(selection)).rejects.toThrow("reviewed");
    f.store.reviewMailCandidate(row,"reopen");
    await expect(f.coordinator.prepare({sources:[{
      uid:13,uidValidity:5,subject:"forged",
    }]})).rejects.toThrow();
    await expect(f.coordinator.prepare({sources:[{
      uid:404,uidValidity:5,
    }]})).rejects.toThrow("not in");
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it("rejects non-actions, expires pending proposal and discards on cancel",async()=>{
    const f=fixture();
    await f.coordinator.prepare(selection);
    f.confirm.mockResolvedValueOnce({
      text:JSON.stringify({items:[{
        uid:13,uidValidity:5,kind:"none",title:"",dueDate:null,reason:"No action",
      }]}),model:"gpt-4.1-mini",usage:{inputTokens:11,outputTokens:11},
      createdAt:"2026-11-25T11:00:00Z",
    });
    const review=await f.coordinator.confirm(id);
    await expect(f.coordinator.apply(apply(review.reviewId))).rejects.toThrow("Only");
    await f.coordinator.prepare(selection);
    const review2=await f.coordinator.confirm(id);
    f.advance(10*60_000+1);
    await expect(f.coordinator.apply(apply(review2.reviewId))).rejects.toThrow("expired");
    f.coordinator.cancel();
    await expect(f.coordinator.apply(apply(review2.reviewId))).rejects.toThrow("expired");
  });
  it("refuses new task writes if the mail was independently ignored after analysis",async()=>{
    const f=fixture();
    await f.coordinator.prepare(selection);
    const review=await f.coordinator.confirm(id);
    f.store.reviewMailCandidate(row,"ignore");
    await expect(f.coordinator.apply(apply(review.reviewId))).rejects.toThrow("reviewed");
    expect(f.store.listTasks()).toHaveLength(0);
  });
});
