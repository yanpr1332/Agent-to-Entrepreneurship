import {describe,expect,it,vi} from "vitest";
import {CanvasApi} from "./canvas-api";
describe("Canvas calendar REST read-only boundary",()=>{
  it("queries dated type=event per course, never assignments or other contexts",async()=>{
    const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
      const parsed=new URL(url);
      expect(parsed.pathname).toBe("/api/v1/calendar_events");
      expect(parsed.searchParams.get("type")).toBe("event");
      expect(parsed.searchParams.get("context_codes[]")).toBe("course_9");
      expect(parsed.searchParams.get("start_date")).toBe("2026-11-01");
      expect(parsed.searchParams.get("end_date")).toBe("2026-11-30");
      expect(init.redirect).toBe("error");
      expect(url).not.toContain("private-token");
      return new Response(JSON.stringify([
        {id:72,title:"Course lecture",context_code:"course_9",
          start_at:"2026-11-12T09:00:00Z",end_at:"2026-11-12T10:00:00Z"},
        {id:73,title:"Other course",context_code:"course_10",
          start_at:"2026-11-12T09:00:00Z",end_at:"2026-11-12T10:00:00Z"},
      ]),{status:200});
    });
    const result=await new CanvasApi("https://canvas.example.edu","private-token",fetcher)
      .listCalendarEvents(9,"2026-11-01","2026-11-30");
    expect(result).toMatchObject([{id:72,courseId:9,title:"Course lecture"}]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects unbounded date windows and duplicate event identity",async()=>{
    const mock=vi.fn(async()=>new Response(JSON.stringify([
      {id:1,context_code:"course_9"},{id:1,context_code:"course_9"},
    ]),{status:200}));
    const api=new CanvasApi("https://canvas.example.edu","token",mock);
    await expect(api.listCalendarEvents(9,"2026-01-01","2026-12-01")).rejects.toThrow("200 days");
    await expect(api.listCalendarEvents(9,"2026-11-01","2026-11-30")).rejects.toThrow("duplicate");
  });
});
