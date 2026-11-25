import {describe,it,expect} from "vitest";
import {parseMailAISelection,parseMailAIAnswer,parseMailAIApply} from "./mail-ai";
const source=[{uidValidity:9,uid:3,subject:"Lab report 2026-12-05"}];
const valid={items:[{uidValidity:9,uid:3,kind:"coursework",title:"提交实验报告",
  dueDate:"2026-12-05",reason:"主题包含实验报告和明确日期"}]};
const uuid="b27409e8-b8a1-43a7-86d5-9849a3f15eb1";
describe("explicit bounded mail AI inputs and output",()=>{
  it("accepts one to three unique source IDs, never renderer content",()=>{
    expect(parseMailAISelection({sources:[{uid:3,uidValidity:9}]})).toEqual({
      sources:[{uid:3,uidValidity:9}],
    });
    for(const value of [{sources:[]},{sources:Array(4).fill({uid:1,uidValidity:1})},
      {sources:[{uid:1,uidValidity:1},{uid:1,uidValidity:1}]},
      {sources:[{uid:3,uidValidity:9,subject:"Injected"}]},
      {sources:[{uid:0,uidValidity:9}]}])
      expect(()=>parseMailAISelection(value)).toThrow();
  });
  it("requires matching provider items and literal source dates",()=>{
    expect(parseMailAIAnswer(JSON.stringify(valid),source)[0]).toMatchObject({
      kind:"coursework",title:"提交实验报告",dueDate:"2026-12-05",
    });
    for(const answer of [
      "not JSON",JSON.stringify({items:[]}),
      JSON.stringify({items:[{...valid.items[0],uid:4}]}),
      JSON.stringify({items:[{...valid.items[0],dueDate:"2026-12-06"}]}),
      JSON.stringify({items:[{...valid.items[0],kind:"drop table"}]}),
      JSON.stringify({items:[{...valid.items[0],extra:"unsafe"}]}),
      JSON.stringify({items:[{...valid.items[0],dueDate:"2026-02-30"}]}),
    ])expect(()=>parseMailAIAnswer(answer,source)).toThrow();
    expect(parseMailAIAnswer(JSON.stringify({items:[{
      ...valid.items[0],kind:"none",title:"",dueDate:null,
    }]}),source)[0].kind).toBe("none");
  });
  it("requires review UUID, valid date and bounded user-edited title",()=>{
    expect(parseMailAIApply({reviewId:uuid,uidValidity:9,uid:3,
      title:"  重新命名  ",dueDate:null})).toMatchObject({
        reviewId:uuid,title:"重新命名",dueDate:null,
    });
    for(const input of [
      {reviewId:uuid,uidValidity:9,uid:3,title:"",dueDate:null},
      {reviewId:uuid,uidValidity:9,uid:3,title:"A",dueDate:"2026-02-30"},
      {reviewId:uuid,uidValidity:9,uid:3,title:"A",dueDate:null,earned:99},
      {reviewId:"not-a-uuid",uidValidity:9,uid:3,title:"A",dueDate:null},
    ])expect(()=>parseMailAIApply(input)).toThrow();
  });
});
