import {describe,expect,it} from "vitest";
import {appendManualLabelCase} from "./local-evaluation-labels";

const KEY="00000000-0000-4000-8000-000000000001:1:0";
describe("local human relevance labelling UI constraints",()=>{
  it("retains manually selected evidence across cases",()=>{
    const first=appendManualLabelCase([],"  mitochondria energy  ",[KEY],"case-001");
    expect(first).toEqual([{id:"case-001",query:"mitochondria energy",
      relevant:[KEY]}]);
    const later=appendManualLabelCase(first,"线粒体",[KEY],"case-002");
    expect(later).toHaveLength(2);
    expect(first).toHaveLength(1);
  });
  it("rejects empty, duplicate and oversized cases before IPC",()=>{
    const base=appendManualLabelCase([],"energy",[KEY],"case-001");
    expect(()=>appendManualLabelCase(base,"other",[KEY],"case-001")).toThrow();
    expect(()=>appendManualLabelCase(base,"",[KEY],"case-002")).toThrow();
    expect(()=>appendManualLabelCase(base,"okay",[],"case-002")).toThrow();
    expect(()=>appendManualLabelCase(base,"okay",[KEY,KEY],"case-002")).toThrow();
    expect(()=>appendManualLabelCase(base,"okay",Array(21).fill(KEY),"case-002")).toThrow();
    const full=Array.from({length:100},(_,i)=>({...base[0],id:"case-"+i}));
    expect(()=>appendManualLabelCase(full,"more",[KEY],"case-101")).toThrow();
  });
});
