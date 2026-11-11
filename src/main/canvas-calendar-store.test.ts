import {afterEach,describe,expect,it} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {FixedCalendarStore} from "./fixed-calendar-store";
import {backupBeforeMigration} from "./local-backup";
import type {CanvasCalendarEvent} from "../shared/canvas-calendar-model";
import {toLocalCanvasSlot} from "../shared/canvas-calendar-model";

const origin="https://canvas.example.edu";
const remote:CanvasCalendarEvent={
  id:72,courseId:9,title:"Calculus lecture",
  startAt:"2026-11-12T09:00:00Z",endAt:"2026-11-12T10:00:00Z",allDayDate:null,
};
const folders:string[]=[];
const stores:FixedCalendarStore[]=[];
let active:{origin:string;accountId:number}|null={origin,accountId:44};
function db(){
  const store=new FixedCalendarStore(":memory:",()=>[],()=>active);
  stores.push(store);return store;
}
afterEach(()=>{
  while(stores.length)stores.pop()!.close();
  for(const folder of folders.splice(0))rmSync(folder,{recursive:true,force:true});
  active={origin,accountId:44};
});
describe("Canvas calendar cache is private, durable and user-controlled",()=>{
  it("deduplicates and updates only the matching account/course without touching personal events",()=>{
    const store=db();
    const manual=store.create({title:"Personal class",day:"2026-11-12",
      startMinute:600,durationMinutes:60,weeks:1})[0];
    expect(store.reconcileCanvasCourse(origin,44,9,[remote])).toMatchObject({created:1,changed:0});
    expect(store.reconcileCanvasCourse(origin,44,9,[remote]).created).toBe(0);
    const original=store.listCanvasEvents(origin,44)[0];
    const revised={...remote,title:"Updated lecture"};
    expect(store.reconcileCanvasCourse(origin,44,9,[revised]).changed).toBe(1);
    expect(store.listCanvasEvents(origin,44)[0]).toMatchObject({id:original.id,title:revised.title});
    expect(store.reconcileCanvasCourse(origin,45,9,[remote]).created).toBe(1);
    expect(store.listCanvasEvents(origin,45)).toHaveLength(1);
    expect(store.listCanvasEvents(origin,44)).toHaveLength(1);
    expect(store.list()).toMatchObject([{id:manual.id,title:"Personal class"}]);
    active={origin,accountId:45};
    expect(store.listForDisplay().filter(x=>x.source==="canvas")).toHaveLength(1);
    active=null;
    expect(store.listForDisplay()).toHaveLength(1);
    expect(store.busySlots()).toHaveLength(1);
  });
  it("keeps hidden events hidden during sync and removes them only after six months",()=>{
    const store=db();
    store.reconcileCanvasCourse(origin,44,9,[remote]);
    const item=store.listCanvasEvents(origin,44)[0];
    const hiddenAt=new Date("2026-11-11T10:00:00Z");
    expect(store.setCanvasEventVisibility(item.id,false,hiddenAt)).toBe(true);
    store.reconcileCanvasCourse(origin,44,9,[{...remote,title:"Renamed"}]);
    const hidden=store.listCanvasEvents(origin,44)[0];
    expect(hidden).toMatchObject({id:item.id,title:"Calculus lecture",visible:false,
      retentionExpiresAt:"2027-05-11T10:00:00.000Z"});
    expect(store.busySlots()).toEqual([]);
    active={origin,accountId:45};
    expect(()=>store.setCanvasEventVisibility(item.id,true)).toThrow("active account");
    active={origin,accountId:44};
    expect(store.purgeExpiredHiddenCanvasEvents(new Date("2027-05-10T10:00:00Z"))).toBe(0);
    expect(store.setCanvasEventVisibility(item.id,true)).toBe(true);
    expect(store.listCanvasEvents(origin,44)[0].visible).toBe(true);
    store.setCanvasEventVisibility(item.id,false,hiddenAt);
    expect(store.purgeExpiredHiddenCanvasEvents(new Date("2027-05-12T10:00:00Z"))).toBe(1);
  });
  it("marks remote removals for review instead of deleting and unblocks study time",()=>{
    const store=db();
    store.reconcileCanvasCourse(origin,44,9,[remote]);
    expect(store.busySlots()).toHaveLength(1);
    expect(store.reconcileCanvasCourse(origin,44,9,[]).missing).toBe(1);
    expect(store.listCanvasEvents(origin,44)[0].missing).toBe(true);
    expect(store.busySlots()).toHaveLength(0);
    store.reconcileCanvasCourse(origin,44,9,[remote]);
    expect(store.listCanvasEvents(origin,44)[0].missing).toBe(false);
  });
  it("rejects invalid or cross-midnight local slots without corrupting other events",()=>{
    const store=db();
    const bad={...remote,endAt:"2026-11-14T09:00:00Z"};
    expect(store.reconcileCanvasCourse(origin,44,9,[remote,bad])).toThrow("duplicate");
    expect(store.reconcileCanvasCourse(origin,44,9,[{...bad,id:73}]).skipped).toBe(1);
    expect(store.listCanvasEvents(origin,44)).toHaveLength(0);
    expect(toLocalCanvasSlot({...remote,allDayDate:"2026-11-12"})).toMatchObject({
      day:"2026-11-12",startMinute:0,durationMinutes:1440});
    expect(toLocalCanvasSlot({...remote,startAt:null})).toBeNull();
  });
  it("preserves v2 data with a verified pre-v3 backup",async()=>{
    const folder=mkdtempSync(join(tmpdir(),"ate-calendar-canvas-"));folders.push(folder);
    const path=join(folder,"ate-fixed-calendar.sqlite");
    const first=new FixedCalendarStore(path);
    const saved=first.create({title:"Legacy",day:"2026-11-12",
      startMinute:700,durationMinutes:60,weeks:1})[0];
    first.close();
    const old=new DatabaseSync(path);
    old.exec("DROP INDEX canvas_calendar_scope; DROP TABLE canvas_calendar_events; PRAGMA user_version=2;");
    old.close();
    const backupFolder=await backupBeforeMigration(folder,"ate-fixed-calendar.sqlite",3);
    expect(backupFolder).toBeTruthy();
    const preserved=new DatabaseSync(join(backupFolder!,"ate-fixed-calendar.sqlite"),{readOnly:true});
    expect((preserved.prepare("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(2);
    preserved.close();
    const restored=new FixedCalendarStore(path,()=>[],()=>active);
    expect(restored.list()).toMatchObject([{id:saved.id}]);
    expect(restored.reconcileCanvasCourse(origin,44,9,[remote]).created).toBe(1);
    restored.close();
  });
});
