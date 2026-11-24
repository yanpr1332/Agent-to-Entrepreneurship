import {describe,expect,it,vi} from "vitest";
import type {LocalStore} from "./local-store";
import type {FixedCalendarStore} from "./fixed-calendar-store";
import {adoptReviewedLegacySync,listLegacySyncReview} from "./personal-sync-legacy";
import {parsePersonalSyncLegacyAdoptionRequest} from "../shared/personal-sync-contract";

const OWNER="aae9ac05-b37d-4898-aee4-5848fa28e01b";
const TASK="3babcb78-c10d-4f4e-ab3e-f47f6ad72447";
const EVENT="663e4c7e-37e0-468c-b3d4-a70f2c3bf0fb";
const OP="26248088-a42b-4915-ab2c-3c064d43f040";
const stamp="2026-11-24T08:00:00.000Z";

function stores(){
  const tasks={
    listLegacyPersonalSyncItems:vi.fn(()=>[
      {operationId:OP,entityType:"personal-task" as const,entityId:TASK,
        action:"upsert" as const,title:"Current local task",createdAt:stamp,canReauthorize:true},
      {operationId:"50ff310d-e452-41aa-b2f2-f33aee1c8fbc",entityType:"personal-task" as const,
        entityId:"de4b6929-006b-4859-86c8-570bc11dd203",action:"delete" as const,
        title:null,createdAt:stamp,canReauthorize:false},
    ]),
    adoptLegacyPersonalTaskSync:vi.fn(),
  };
  const calendar={
    listLegacyManualCalendarSyncItems:vi.fn(()=>[
      {operationId:null,entityId:EVENT,action:"enrolled" as const,
        title:"Current local event",createdAt:stamp,canReauthorize:true},
    ]),
    adoptLegacyManualEventSync:vi.fn(),
  };
  return {tasks,calendar};
}
type TaskDeps=Pick<LocalStore,"listLegacyPersonalSyncItems"|"adoptLegacyPersonalTaskSync">;
type CalendarDeps=Pick<FixedCalendarStore,
  "listLegacyManualCalendarSyncItems"|"adoptLegacyManualEventSync">;
function checked(raw:unknown){
  return parsePersonalSyncLegacyAdoptionRequest(raw);
}

describe("legacy ownerless sync quarantine review",()=>{
  it("lists the local quarantine without adopting anything or exposing old payloads",()=>{
    const {tasks,calendar}=stores();
    const result=listLegacySyncReview(tasks as unknown as TaskDeps,
      calendar as unknown as CalendarDeps);
    expect(result).toMatchObject({
      taskLimitReached:false,calendarLimitReached:false,
      items:[
        {legacyStore:"task-database",entityId:TASK,action:"upsert",canReauthorize:true},
        {legacyStore:"task-database",action:"delete",canReauthorize:false},
        {legacyStore:"calendar-database",entityType:"manual-calendar-event",
          entityId:EVENT,action:"enrolled",canReauthorize:true},
      ],
    });
    expect(JSON.stringify(result)).not.toContain("payload");
    expect(tasks.adoptLegacyPersonalTaskSync).not.toHaveBeenCalled();
    expect(calendar.adoptLegacyManualEventSync).not.toHaveBeenCalled();
  });

  it("only adopts a freshly reviewed row for Main's owner and never the old payload",()=>{
    const {tasks,calendar}=stores();
    adoptReviewedLegacySync(tasks as unknown as TaskDeps,calendar as unknown as CalendarDeps,
      OWNER,checked({entityType:"personal-task",entityId:TASK,
        expectedAction:"upsert",expectedOperationId:OP,confirmation:true}));
    expect(tasks.adoptLegacyPersonalTaskSync).toHaveBeenCalledOnce();
    expect(tasks.adoptLegacyPersonalTaskSync).toHaveBeenCalledWith(OWNER,TASK,true);
    expect(calendar.adoptLegacyManualEventSync).not.toHaveBeenCalled();
    adoptReviewedLegacySync(tasks as unknown as TaskDeps,calendar as unknown as CalendarDeps,
      OWNER,checked({entityType:"manual-calendar-event",entityId:EVENT,
        expectedAction:"enrolled",expectedOperationId:null,confirmation:true}));
    expect(calendar.adoptLegacyManualEventSync).toHaveBeenCalledOnce();
    expect(calendar.adoptLegacyManualEventSync).toHaveBeenCalledWith(OWNER,EVENT,true);
  });

  it("rejects historical deletes, stale rows, unexpected fields, and missing consent",()=>{
    const {tasks,calendar}=stores();
    const deps=[tasks as unknown as TaskDeps,calendar as unknown as CalendarDeps] as const;
    const valid={entityType:"personal-task",entityId:TASK,
      expectedAction:"upsert",expectedOperationId:OP,confirmation:true};
    expect(()=>checked({...valid,confirmation:false})).toThrow("confirmation");
    expect(()=>checked({...valid,ownerId:OWNER})).toThrow("Unexpected");
    expect(()=>checked({...valid,payload:{title:"old"}})).toThrow("Unexpected");
    expect(()=>checked({...valid,expectedAction:"delete"})).toThrow("deletion");
    expect(()=>checked({...valid,expectedOperationId:"invalid"})).toThrow();
    expect(()=>adoptReviewedLegacySync(...deps,OWNER,
      checked({...valid,expectedOperationId:"75dc757e-2a35-4536-afb8-e0c497526e16"})))
      .toThrow("changed");
    expect(()=>adoptReviewedLegacySync(...deps,OWNER,
      checked({...valid,entityId:EVENT}))).toThrow("eligible");
    expect(tasks.adoptLegacyPersonalTaskSync).not.toHaveBeenCalled();
    expect(calendar.adoptLegacyManualEventSync).not.toHaveBeenCalled();
  });

  it("caps each SQLite source independently and warns about hidden rows",()=>{
    const {tasks,calendar}=stores();
    const first=tasks.listLegacyPersonalSyncItems();
    tasks.listLegacyPersonalSyncItems=vi.fn(()=>Array.from({length:101},()=>first[0]));
    const result=listLegacySyncReview(tasks as unknown as TaskDeps,
      calendar as unknown as CalendarDeps);
    expect(result.items).toHaveLength(101);
    expect(result.taskLimitReached).toBe(true);
    expect(result.calendarLimitReached).toBe(false);
    expect(tasks.listLegacyPersonalSyncItems).toHaveBeenCalledWith(101);
  });
});
