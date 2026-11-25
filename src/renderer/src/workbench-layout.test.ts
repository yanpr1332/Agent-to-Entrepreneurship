import {describe,expect,it} from "vitest";
import {WORKBENCH_WIDGETS,WORKBENCH_PRESETS,WORKBENCH_STORAGE_KEY,
  loadWorkbenchLayout,parseWorkbenchLayout,presetLayout,saveWorkbenchLayout,
  moveWorkbenchWidget,setWidgetVisible,visibleWorkbenchWidgets} from "./workbench-layout";
describe("V0.1 Alpha workbench layout",()=>{
  it("offers all eight live-module widgets in each known preset",()=>{
    expect(WORKBENCH_STORAGE_KEY).toContain("workbench");
    for(const name of ["balanced","study","collaboration"] as const){
      const layout=presetLayout(name);
      expect(layout.order).toEqual(WORKBENCH_PRESETS[name]);
      expect(new Set(layout.order)).toEqual(new Set(WORKBENCH_WIDGETS));
      expect(visibleWorkbenchWidgets(layout)).toHaveLength(8);
    }
  });
  it("supports visibility and adjacent reordering with stable serialization",()=>{
    const start=presetLayout(),changed=setWidgetVisible(start,"mail",false);
    expect(visibleWorkbenchWidgets(changed)).not.toContain("mail");
    const moved=moveWorkbenchWidget(changed,"team",-1);
    expect(moved.order.indexOf("team")).toBe(start.order.indexOf("team")-1);
    expect(moved.preset).toBe("custom");
    const serialized=saveWorkbenchLayout(moved);
    expect(loadWorkbenchLayout(serialized)).toEqual(moved);
    expect(setWidgetVisible(moved,"mail",true).hidden).not.toContain("mail");
    expect(start.hidden).toEqual([]);
    expect(start.order[0]).toBe("tasks");
    expect(moveWorkbenchWidget(start,"tasks",-1)).toBe(start);
    expect(moveWorkbenchWidget(start,"ai",1)).toBe(start);
  });
  it("resets corrupted and future-version user data instead of hiding modules",()=>{
    const bad=[
      "not JSON",JSON.stringify({version:2,preset:"balanced",
        order:[...WORKBENCH_WIDGETS],hidden:[]}),
      JSON.stringify({version:1,preset:"balanced",order:[],hidden:[]}),
      JSON.stringify({version:1,preset:"balanced",
        order:Array(8).fill("tasks"),hidden:[]}),
      JSON.stringify({version:1,preset:"balanced",
        order:[...WORKBENCH_WIDGETS],hidden:["admin"]}),
      JSON.stringify({version:1,preset:"balanced",
        order:[...WORKBENCH_WIDGETS],hidden:["mail","mail"]}),
      JSON.stringify({version:1,preset:"balanced",
        order:[...WORKBENCH_WIDGETS],hidden:["mail"]}),
      JSON.stringify({version:1,preset:"custom",
        order:[...WORKBENCH_WIDGETS],hidden:[],token:"secret"}),
      "x".repeat(2500),
    ];
    for(const value of bad){
      expect(loadWorkbenchLayout(value)).toEqual(presetLayout());
      if(value!=="not JSON"&&value.length<2048)
        expect(()=>parseWorkbenchLayout(JSON.parse(value))).toThrow();
    }
    expect(loadWorkbenchLayout(null)).toEqual(presetLayout());
  });
  it("can hide all widgets without losing restore/settings controls",()=>{
    let layout=presetLayout("study");
    for(const key of WORKBENCH_WIDGETS)
      layout=setWidgetVisible(layout,key,false);
    expect(visibleWorkbenchWidgets(layout)).toEqual([]);
    expect(loadWorkbenchLayout(saveWorkbenchLayout(layout)).hidden).toHaveLength(8);
    expect(presetLayout()).toEqual(loadWorkbenchLayout(null));
  });
});
