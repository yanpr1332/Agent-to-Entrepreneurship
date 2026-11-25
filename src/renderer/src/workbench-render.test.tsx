import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import Workbench from "./Workbench";
import {presetLayout,saveWorkbenchLayout,WORKBENCH_STORAGE_KEY,
  setWidgetVisible} from "./workbench-layout";
import type {LocalTask,FocusSummary} from "../../shared/local-model";

const summary:FocusSummary={sessions:3,completedSessions:2,totalMinutes:65,points:50};
function task(id:string,completed=false):LocalTask{
  return {id,title:"Personal essay",description:"PRIVATE NOTES DO NOT DISPLAY",
    dueDate:"2026-11-25",priority:"high",completed,visible:true,
    hiddenAt:null,retentionExpiresAt:null,source:null,
    createdAt:"2026-11-24T00:00:00Z",updatedAt:"2026-11-24T00:00:00Z"};
}
function render(raw:string|null){
  vi.stubGlobal("window",{
    localStorage:{getItem:(key:string)=>{
      expect(key).toBe(WORKBENCH_STORAGE_KEY);
      return raw;
    },setItem:vi.fn()},
    clearInterval:vi.fn(),setInterval:vi.fn(),
  });
  return renderToStaticMarkup(createElement(Workbench,{
    tasks:[task("a"),task("b",true)],summary,plannedBlocks:[],fixedEvents:[],
    version:"0.1.0",runtime:"connected",refreshSignal:0,busy:false,
    onNavigate:vi.fn(),onEditTask:vi.fn(),onCompleteTask:vi.fn(),
  }));
}
describe("workbench static semantic rendering",()=>{
  beforeEach(()=>vi.unstubAllGlobals());
  afterEach(()=>vi.unstubAllGlobals());
  it("renders actual task/focus numbers, eight accessible modules and no private notes",()=>{
    const html=render(null);
    for(const label of ["待办任务","今日学习安排","专注与奖励","知识库与复习",
      "小组协作","Canvas 课程","邮箱管理","AI 学习助手"]){
      expect(html).toContain('aria-label="'+label+'"');
    }
    expect(html).toContain("Personal essay");
    expect(html).not.toContain("PRIVATE NOTES DO NOT DISPLAY");
    expect(html).toContain("累计专注");
    expect(html).toContain("65");
    expect(html).toContain("本机数据库");
    expect(html).toContain("正在读取");
    expect(html).toContain("自定义工作台布局");
    expect(html).toContain("刷新模块状态");
  });
  it("keeps settings and rescue when all eight modules are hidden",()=>{
    let layout=presetLayout();
    for(const key of layout.order)layout=setWidgetVisible(layout,key,false);
    const html=render(saveWorkbenchLayout(layout));
    expect(html).toContain("所有模块都已隐藏");
    expect(html).toContain("显示全部模块");
    expect(html).not.toContain('aria-label="邮箱管理"');
  });
  it("rejects tampered localStorage layout and restores full default dashboard",()=>{
    const html=render('{"version":100,"order":[]}');
    expect(html).toContain('aria-label="邮箱管理"');
    expect(html).toContain('aria-label="专注与奖励"');
  });
});
