import {describe,expect,it} from "vitest";
import {
  dayOffset, parseMinute, parsePlanApply, parsePlanningSettings, validCivilDay,
  eligiblePlanningTasks,
} from "./planning-model";
import type {LocalTask} from "./local-model";

describe("planning API rejects forged / impossible time selections",()=>{
  it("validates local calendar dates and clock windows",()=>{
    expect(validCivilDay("2028-02-29")).toBe(true);
    expect(validCivilDay("2027-02-29")).toBe(false);
    expect(dayOffset("2028-02-29",1)).toBe("2028-03-01");
    expect(parseMinute("18:45")).toBe(1125);
    expect(()=>parseMinute("24:01")).toThrow();
    const settings={startDate:"2026-11-12",days:7,dailyStart:"18:00",dailyEnd:"21:00",minutesPerTask:45};
    expect(parsePlanningSettings(settings)).toEqual(settings);
    expect(()=>parsePlanningSettings({...settings,days:365})).toThrow();
    expect(()=>parsePlanningSettings({...settings,dailyStart:"21:00"})).toThrow();
    expect(()=>parsePlanningSettings({...settings,minutesPerTask:13})).toThrow();
    expect(()=>parsePlanningSettings({...settings,unrecognized:"danger"})).toThrow();
  });
  it("refuses duplicate apply IDs and forged edits",()=>{
    const id="00000000-0000-4000-8000-000000000001",b="00000000-0000-4000-8000-000000000002";
    expect(parsePlanApply({proposalId:id,blockIds:[b],edits:[]})).toMatchObject({proposalId:id});
    expect(()=>parsePlanApply({proposalId:id,blockIds:[b,b],edits:[]})).toThrow();
    expect(()=>parsePlanApply({proposalId:id,blockIds:[b],edits:[
      {blockId:id,day:"2026-11-12",startMinute:1080},
    ]})).toThrow();
    expect(()=>parsePlanApply({proposalId:id,blockIds:[b],edits:[
      {blockId:b,day:"2026-11-12",startMinute:1085},
    ]})).toThrow();
  });
  it("never includes hidden or completed tasks",()=>{
    const blank:LocalTask={id:"a",title:"A",description:"",dueDate:null,priority:"low",
      completed:false,createdAt:"2026-11-10T00:00:00Z",
      updatedAt:"2026-11-10T00:00:00Z",visible:true,hiddenAt:null,retentionExpiresAt:null,source:null};
    expect(eligiblePlanningTasks([
      {...blank,id:"h",visible:false},{...blank,id:"c",completed:true},blank,
    ]).map(t=>t.id)).toEqual(["a"]);
  });
});
