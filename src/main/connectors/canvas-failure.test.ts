import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStore } from "../local-store";
import { CanvasSyncService } from "./canvas-sync";
import { canvasFailureKind, canvasFailureHelp } from "./canvas-failure";
import type { CanvasApi } from "./canvas-api";

const stores: LocalStore[]=[];
function local() { const s=new LocalStore(":memory:"); stores.push(s);return s; }
afterEach(()=>{while(stores.length)stores.pop()!.close();});

function api(options?:{
  identify?:()=>Promise<number>;
  courses?:()=>Promise<{id:number;name:string;courseCode:string}[]>;
  assignments?:()=>Promise<never[]>;
}):CanvasApi {
  return {
    origin:"https://oc.sjtu.edu.cn",
    getCurrentUserId:options?.identify??(async()=>10),
    listCourses:options?.courses??(async()=>[{id:1,name:"Biology",courseCode:"BIO"}]),
    listAssignments:options?.assignments??(async()=>[]),
  } as unknown as CanvasApi;
}

describe("Canvas authorization and safe retry gates",()=>{
  it("classifies known failures without echoing secrets",()=>{
    expect(canvasFailureKind(Error("Canvas token is invalid or expired"))).toBe("authentication");
    expect(canvasFailureKind(Error("Canvas rate limit reached; try again later"))).toBe("rate-limit");
    expect(canvasFailureKind(Error("Canvas access denied."))).toBe("permissions");
    expect(canvasFailureKind(Error("fetch failed"))).toBe("network");
    expect(canvasFailureHelp("authentication")).not.toContain("Bearer");
  });
  it("expired identity blocks later background sync until explicit reconnect",async()=>{
    const db=local();
    const identify=vi.fn(async()=>{throw Error("Canvas token is invalid or expired");});
    const engine=new CanvasSyncService(db,async()=>api({identify}));
    const first=await engine.sync();
    expect(first.failureKind).toBe("authentication");
    expect(first.lastError).toContain("重新授权");
    await engine.sync();
    expect(identify).toHaveBeenCalledTimes(1);
    engine.cancel(); // Called only by Main after user explicitly reconnects.
    await engine.sync();
    expect(identify).toHaveBeenCalledTimes(2);
    expect(db.listTasks()).toHaveLength(0);
  });
  it("rate limits stop a batch after the first affected course",async()=>{
    const db=local();
    const assignments=vi.fn(async()=>{throw Error("Canvas rate limit reached; try again later");});
    const engine=new CanvasSyncService(db,async()=>api({
      courses:async()=>[{id:1,name:"A",courseCode:"A"},{id:2,name:"B",courseCode:"B"}],
      assignments,
    }));
    const result=await engine.sync();
    expect(result.failureKind).toBe("rate-limit");
    expect(result.failedCourses).toBe(1);
    expect(assignments).toHaveBeenCalledTimes(1);
  });
  it("401 from an individual course fences future background sync",async()=>{
    const db=local();
    const assignments=vi.fn(async()=>{throw Error("Canvas token is invalid or expired");});
    const engine=new CanvasSyncService(db,async()=>api({assignments}));
    const first=await engine.sync();
    expect(first.failureKind).toBe("authentication");
    await engine.sync();
    expect(assignments).toHaveBeenCalledTimes(1);
  });
  it("late 401 from a cancelled identity request cannot disable replacement credentials",async()=>{
    const db=local();
    let rejectOld:(reason:unknown)=>void=()=>{};
    const identify=vi.fn()
      .mockImplementationOnce(()=>new Promise<number>((_,reject)=>{rejectOld=reject;}))
      .mockResolvedValue(10);
    const engine=new CanvasSyncService(db,async()=>api({identify}));
    const first=engine.sync();
    for(let n=0;n<10&&!identify.mock.calls.length;n++)await Promise.resolve();
    engine.cancel();
    rejectOld(Error("Canvas token is invalid or expired"));
    await first;
    const next=await engine.sync();
    expect(next.failureKind).toBeNull();
    expect(next.connected).toBe(true);
    expect(identify).toHaveBeenCalledTimes(2);
  });
});
