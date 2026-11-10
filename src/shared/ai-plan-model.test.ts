import {describe,expect,it} from "vitest";
import {parseAIPlanPrepare,parseAIPlanSlots} from "./ai-plan-model";
const task="3b772b6f-2376-4ef3-b7da-ab189dfc18b9";
const settings={startDate:"2026-11-11",days:2,dailyStart:"18:00",dailyEnd:"21:00",minutesPerTask:45};
describe("bounded AI scheduling input and strict JSON",()=>{
  it("only accepts specific reviewed source IDs and settings",()=>{
    expect(parseAIPlanPrepare({taskIds:[task],settings}).taskIds).toEqual([task]);
    expect(()=>parseAIPlanPrepare({taskIds:[task,task],settings})).toThrow();
    expect(()=>parseAIPlanPrepare({taskIds:[task],settings,freeText:"private"})).toThrow();
  });
  it("rejects markdown wrappers, forged keys and unsupported slot shapes",()=>{
    const item={taskId:task,day:"2026-11-11",startMinute:1080};
    expect(parseAIPlanSlots(JSON.stringify({slots:[item]}))).toEqual([item]);
    for(const text of [
      '```json\\n{"slots":[]}\\n```',
      JSON.stringify({slots:[{...item,title:"forged"}]}),
      JSON.stringify({slots:[{...item,startMinute:"18:00"}]}),
      JSON.stringify({slots:[],debug:"hidden"}),
    ])expect(()=>parseAIPlanSlots(text)).toThrow();
  });
});
