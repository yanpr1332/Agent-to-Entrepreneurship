import {describe,expect,it} from "vitest";
import {parseEditFixedSeries} from "./fixed-calendar-model";

describe("manual recurring course scope parser",()=>{
  const valid={
    id:"d92540f4-2413-4df1-9f9b-0f30e50eb833",
    title:"Linear algebra",day:"2026-11-20",startMinute:570,durationMinutes:90,
    scope:"future" as const,
  };
  it("accepts a complete custom range and rejects missing or extra endpoints",()=>{
    const withRange={...valid,scope:"range" as const,
      rangeStartId:"d92540f4-2413-4df1-9f9b-0f30e50eb833",
      rangeEndId:"6d2439b4-5b35-4a79-b5e1-3ff3d37d1e29"};
    expect(parseEditFixedSeries(withRange)).toEqual(withRange);
    for(const bad of [
      {...valid,scope:"range"}, {...withRange,rangeStartId:"forged"},
      {...withRange,rangeEndId:""}, {...withRange,privileged:true},
      {...withRange,scope:"all"}, {...valid,rangeStartId:withRange.rangeStartId},
    ])expect(()=>parseEditFixedSeries(bad)).toThrow();
  });
  it("accepts only complete, explicit future and whole-series edits",()=>{
    expect(parseEditFixedSeries(valid)).toEqual(valid);
    expect(parseEditFixedSeries({...valid,scope:"all"})).toMatchObject({scope:"all"});
  });
  it("rejects single edits, invalid dates, forged ids and extra properties",()=>{
    for(const input of [
      {...valid,scope:"single"}, {...valid,scope:"past"},
      {...valid,day:"2026-02-30"}, {...valid,startMinute:1430},
      {...valid,durationMinutes:0}, {...valid,title:""},
      {...valid,id:"oops"}, {...valid,privileged:true},
    ])expect(()=>parseEditFixedSeries(input)).toThrow();
  });
});
