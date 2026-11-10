import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AI_DAILY_REQUEST_CAP } from "../../shared/ai-model";

interface UsageRow {
  attempts: number;
  input_tokens: number;
  output_tokens: number;
}
function utcDate(now: Date): string {return now.toISOString().slice(0,10);}

/**
 * Durable daily request cap, not a monetary spending limit.
 * No questions, completions or credentials are ever written to SQLite.
 */
export class AIUsageLedger {
  private readonly db:DatabaseSync;
  constructor(path:string) {
    if(path!==":memory:")mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=3000");
    if(path!==":memory:")this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS daily_ai_usage(
      day TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      last_request_at TEXT
    )`);
  }
  close():void{this.db.close();}
  today(now=new Date()):{used:number;remaining:number;inputTokens:number;outputTokens:number;lastRequestAt:string|null}{
    const row=this.db.prepare("SELECT attempts,input_tokens,output_tokens,last_request_at FROM daily_ai_usage WHERE day=?")
      .get(utcDate(now)) as (UsageRow & {last_request_at:string|null})|undefined;
    return {
      used:Number(row?.attempts??0),
      remaining:Math.max(0,AI_DAILY_REQUEST_CAP-Number(row?.attempts??0)),
      inputTokens:Number(row?.input_tokens??0),
      outputTokens:Number(row?.output_tokens??0),
      lastRequestAt:row?.last_request_at??null,
    };
  }
  /** Reserve before network I/O; failures and uncertain outcomes count. */
  reserve(now=new Date()):void{
    const day=utcDate(now);
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const row=this.db.prepare("SELECT attempts FROM daily_ai_usage WHERE day=?")
        .get(day) as {attempts:number}|undefined;
      if(Number(row?.attempts??0)>=AI_DAILY_REQUEST_CAP){
        throw new Error("Daily AI request limit reached (UTC); no request was sent");
      }
      this.db.prepare(`INSERT INTO daily_ai_usage(day,attempts,last_request_at)
        VALUES(?,1,?) ON CONFLICT(day) DO UPDATE SET
        attempts=attempts+1,last_request_at=excluded.last_request_at`)
        .run(day,now.toISOString());
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  recordTokens(now:Date,input:number|null,output:number|null):void{
    const valid=(n:number|null)=>n!==null&&Number.isSafeInteger(n)&&n>=0&&n<=1_000_000?n:0;
    this.db.prepare(`UPDATE daily_ai_usage SET
      input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE day=?`)
      .run(valid(input),valid(output),utcDate(now));
  }
}
