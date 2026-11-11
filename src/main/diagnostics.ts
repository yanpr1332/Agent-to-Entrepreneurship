import { constants } from "node:fs";
import { lstat,open,rename,rm,writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { IPC_CHANNELS, type IpcChannel } from "../shared/ipc-channels";

/**
 * No Error objects, request arguments, stack traces, paths, URLs, credentials,
 * mailbox subjects or document contents are accepted by the log interface.
 */
export const DIAGNOSTIC_CODES = [
  "APP_START",
  "APP_READY",
  "SANDBOX_DISABLED",
  "STORAGE_OPEN_FAILED",
  "AI_INIT_DEGRADED",
  "MAIL_INIT_DEGRADED",
  "CANVAS_SYNC_FAILED",
  "MAIL_SYNC_FAILED",
  "IPC_FAILED",
] as const;
export type DiagnosticCode=(typeof DIAGNOSTIC_CODES)[number];

const allowedCodes=new Set<string>(DIAGNOSTIC_CODES);
const allowedOperations=new Set<string>([
  ...Object.values(IPC_CHANNELS),
  "app","storage","canvas","mail","ai",
]);

export type DiagnosticEntry={
  time:string;
  level:"info"|"warning"|"error";
  code:DiagnosticCode;
  operation:string;
};

export const DIAGNOSTIC_FILE="ate-diagnostics.jsonl";
export const MAX_DIAGNOSTIC_BYTES=128*1024;

function safeOperation(operation:unknown):string{
  // A hostile or accidental free-form string cannot be serialized as metadata.
  return typeof operation==="string"&&allowedOperations.has(operation)?
    operation:"app";
}
function severity(code:DiagnosticCode):DiagnosticEntry["level"]{
  return code==="APP_START"||code==="APP_READY"?"info":
    code==="SANDBOX_DISABLED"||code==="AI_INIT_DEGRADED"||
    code==="MAIL_INIT_DEGRADED"?"warning":"error";
}

/** Persist only a small, bounded, private on-device diagnostic event stream. */
export class DiagnosticLogger{
  private pending:Promise<void>=Promise.resolve();
  private readonly path:string;
  constructor(
    userDataDirectory:string,
    private readonly output:(line:string)=>void=(line)=>console.info(line),
    private readonly clock:()=>Date=()=>new Date(),
  ){
    this.path=join(userDataDirectory,DIAGNOSTIC_FILE);
  }
  record(code:DiagnosticCode,operation?:string):void{
    if(!allowedCodes.has(code))throw new Error("Unknown diagnostic event code");
    const line=JSON.stringify({
      time:this.clock().toISOString(),
      level:severity(code),
      code,
      operation:safeOperation(operation),
    } satisfies DiagnosticEntry)+"\n";
    // Console receives the same sanitized entry, never a raw exception.
    try{this.output(line.trimEnd());}catch{/* Diagnostics cannot break application work. */}
    this.pending=this.pending.then(async()=>{
      // Windows does not reliably truncate a descriptor opened in append mode.
      // Perform cap rollover through a closed-handle atomic file replacement.
      try{
        const previous=await lstat(this.path);
        if(!previous.isFile()||previous.isSymbolicLink())return;
      }catch(error){
        if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
      }
      const flags=constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|
        (process.platform==="win32"?0:constants.O_NOFOLLOW);
      let rollover=false;
      const file=await open(this.path,flags,0o600);
      try{
        const stat=await file.stat();
        if(!stat.isFile())return;
        if(process.platform!=="win32")await file.chmod(0o600);
        rollover=stat.size+Buffer.byteLength(line,"utf8")>MAX_DIAGNOSTIC_BYTES;
        if(!rollover)await file.writeFile(line,"utf8");
      }finally{await file.close();}
      if(rollover){
        const temporary=this.path+"."+randomUUID()+".tmp";
        try{
          await writeFile(temporary,line,{flag:"wx",mode:0o600});
          await rename(temporary,this.path);
        }finally{
          await rm(temporary,{force:true}).catch(()=>{});
        }
      }
    }).catch(()=>{
      // Read-only directories or unsupported filesystem flags must never
      // prevent the actual operation from succeeding; no path is printed.
    });
  }
  async flush():Promise<void>{await this.pending;}
}

const genericMessages:Record<string,string>={
  app:"操作未完成，请重新尝试。",
  tasks:"任务操作失败，请检查数据或重新尝试。",
  calendar:"日历操作失败，请检查时间和日程冲突。",
  planning:"学习规划操作失败，请检查时间、任务状态和冲突。",
  knowledge:"知识库操作失败，请检查本地数据与权限。",
  canvas:"Canvas 操作失败，请检查连接、授权和网络。",
  mail:"邮箱操作失败，请检查邮箱连接、授权和网络。",
  ai:"AI 操作失败，请检查个人授权、预算或网络。",
  cloud:"团队服务操作失败，请检查连接和成员权限。",
  focus:"专注记录未能保存，请重试。",
  backup:"备份失败，请检查本机磁盘空间和权限。",
};

/** Never return arbitrary library/network Error.message to a renderer. */
export function publicIpcErrorMessage(channel:IpcChannel,error:unknown):string{
  const message=error instanceof Error?error.message:"";
  // Exact comparisons only: source messages with user content are NEVER copied.
  if(message==="Untrusted IPC sender")return "请求已被拒绝：调用来源未通过安全验证。";
  if(message==="SMTP send acknowledgement was lost; delivery status is uncertain. Check Sent Mail before sending again")
    return "邮件发送状态不确定：请先检查已发送邮件，避免重复发送。";
  if(message==="Canvas token is invalid or expired")
    return "Canvas 授权已失效，请重新连接个人账户。";
  if(message==="Canvas rate limit reached; try again later")
    return "Canvas 请求频率受限，请稍后重新同步。";
  if(message==="Canvas access denied. Check account permissions and rate limits")
    return "Canvas 拒绝访问，请检查课程权限。";
  return genericMessages[channel.split(":")[0]]??genericMessages.app;
}

/** Thin IPC error boundary: generic UI errors + fixed-code private diagnostics. */
export async function protectIpc<T>(
  channel:IpcChannel,
  action:()=>T|Promise<T>,
  logger:Pick<DiagnosticLogger,"record">,
):Promise<T>{
  try{return await action();}
  catch(error){
    logger.record("IPC_FAILED",channel);
    throw new Error(publicIpcErrorMessage(channel,error));
  }
}
