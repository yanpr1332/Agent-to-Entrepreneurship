import {afterEach,describe,expect,it} from "vitest";
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {DIAGNOSTIC_FILE,DiagnosticLogger,MAX_DIAGNOSTIC_BYTES,protectIpc,
  publicIpcErrorMessage} from "./diagnostics";

const directories:string[]=[];
function fixture():string{
  const path=mkdtempSync(join(tmpdir(),"ate-diagnostics-"));directories.push(path);return path;
}
afterEach(()=>{
  for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});
});
describe("APP-004 private diagnostics and IPC error boundary",()=>{
  it("only writes allowlisted operation names and event codes, never supplied secrets",async()=>{
    const dir=fixture(),lines:string[]=[];
    const logger=new DiagnosticLogger(dir,line=>lines.push(line),
      ()=>new Date("2026-11-11T00:00:00Z"));
    const hostile="https://private.example/?token=sk-secret EMAIL=private@example.org "+
      "C:\\Users\\Secret\\profile.pdf raw-mail-body";
    logger.record("IPC_FAILED",hostile);
    logger.record("CANVAS_SYNC_FAILED","canvas");
    await logger.flush();
    const disk=readFileSync(join(dir,DIAGNOSTIC_FILE),"utf8");
    expect(disk).toContain('"code":"IPC_FAILED"');
    expect(disk).toContain('"operation":"app"');
    expect(disk).toContain('"operation":"canvas"');
    expect(JSON.parse(disk.split("\n")[0])).toMatchObject({
      time:"2026-11-11T00:00:00.000Z",level:"error",code:"IPC_FAILED",
    });
    for(const log of [disk,...lines]){
      expect(log).not.toContain("sk-secret");
      expect(log).not.toContain("private@example.org");
      expect(log).not.toContain("profile.pdf");
      expect(log).not.toContain("raw-mail-body");
    }
  });

  it("caps the file without accidentally including arbitrary exception messages",async()=>{
    const dir=fixture(),logger=new DiagnosticLogger(dir,()=>{});
    for(let i=0;i<2600;i++)logger.record("APP_START","app");
    await logger.flush();
    const data=readFileSync(join(dir,DIAGNOSTIC_FILE),"utf8");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(MAX_DIAGNOSTIC_BYTES);
    expect(data.trim().split("\n").every(line=>JSON.parse(line).code==="APP_START")).toBe(true);
    if(process.platform!=="win32")expect(statSync(join(dir,DIAGNOSTIC_FILE)).mode&0o777).toBe(0o600);
  });

  it("never blocks startup if diagnostic storage is unavailable",async()=>{
    const dir=fixture(),path=join(dir,DIAGNOSTIC_FILE);
    writeFileSync(path,"original");
    const logger=new DiagnosticLogger(path,()=>{});
    logger.record("APP_READY","app");
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(readFileSync(path,"utf8")).toBe("original");
  });

  it("maps remote errors to constant, actionable UI messages without exposing content",async()=>{
    const logger={record:(_:string,operation?:string)=>{expect(operation).toBe("mail:confirm-send");}};
    const privateError=new Error("private@example.org Bearer sk-proj-secret "+
      "/home/sensitive/records.pdf subject=confidential");
    await expect(protectIpc("mail:confirm-send",async()=>{throw privateError;},
      logger as DiagnosticLogger)).rejects.toThrow("邮箱操作失败");
    const msg=publicIpcErrorMessage("canvas:connect",
      new Error("Canvas token is invalid or expired"));
    expect(msg).toContain("重新连接");
    expect(publicIpcErrorMessage("mail:confirm-send",
      new Error("SMTP send acknowledgement was lost; delivery status is uncertain. Check Sent Mail before sending again")))
      .toContain("避免重复发送");
    const spy:string[]=[];
    const realLogger=new DiagnosticLogger(fixture(),line=>spy.push(line));
    await expect(protectIpc("ai:confirm",()=>Promise.reject(
      new Error("sk-proj-secret mail-body=https://secret")),realLogger)
    ).rejects.toThrow("AI 操作失败");
    await realLogger.flush();
    expect(spy.join("\n")).not.toContain("sk-proj");
    expect(readFileSync(join(directories.at(-1)!,DIAGNOSTIC_FILE),"utf8")).not.toContain("sk-proj");
  });

  it("protects async IPC success results and rejects untrusted senders safely",async()=>{
    const records:string[]=[];
    const logger={record:(_:string,op?:string)=>{records.push(op??"");}};
    expect(await protectIpc("app:ping",async()=>({ok:true}),logger as DiagnosticLogger))
      .toEqual({ok:true});
    expect(records).toEqual([]);
    await expect(protectIpc("tasks:list",()=>{throw Error("Untrusted IPC sender");},
      logger as DiagnosticLogger)).rejects.toThrow("安全验证");
    expect(records).toEqual(["tasks:list"]);
  });
});
