import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {AIUsageLedger} from "./ai-usage";
import {AI_DAILY_REQUEST_CAP} from "../../shared/ai-model";
const dirs:string[]=[];
afterEach(()=>{dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true}));});
const day=new Date("2026-11-10T01:00:00Z");
describe("durable bounded AI request attempts",()=>{
  it("reserves every network attempt and persists counters without prompts",()=>{
    const dir=mkdtempSync(join(tmpdir(),"ate-ai-usage-"));dirs.push(dir);
    const file=join(dir,"usage.sqlite");
    const store=new AIUsageLedger(file);
    store.reserve(day);store.recordTokens(day,25,40);
    expect(store.today(day)).toMatchObject({used:1,remaining:AI_DAILY_REQUEST_CAP-1,inputTokens:25,outputTokens:40});
    store.close();
    const reopened=new AIUsageLedger(file);
    expect(reopened.today(day).used).toBe(1);
    reopened.close();
  });
  it("refuses calls past the fixed daily cap without granting a reset",()=>{
    const store=new AIUsageLedger(":memory:");
    for(let x=0;x<AI_DAILY_REQUEST_CAP;x++)store.reserve(day);
    expect(()=>store.reserve(day)).toThrow("limit reached");
    expect(store.today(day).remaining).toBe(0);
    expect(store.today(new Date("2026-11-11T01:00:00Z")).remaining).toBe(AI_DAILY_REQUEST_CAP);
    store.close();
  });
});
