/** Classify Canvas API failures without ever including raw remote responses or tokens. */
export type CanvasSyncFailureKind =
  "authentication" | "permissions" | "rate-limit" | "network" | "other";

export function canvasFailureKind(error:unknown):CanvasSyncFailureKind{
  if(!(error instanceof Error))return "other";
  const message=error.message;
  if(/Canvas token is invalid or expired|HTTP 401/i.test(message))
    return "authentication";
  if(/Canvas access denied|not authorized|HTTP 403/i.test(message))
    return "permissions";
  if(/Canvas rate limit|HTTP 429/i.test(message))
    return "rate-limit";
  if(/fetch failed|timeout|aborted|network|HTTP 5\d\d/i.test(message))
    return "network";
  return "other";
}

export function canvasFailureHelp(kind:CanvasSyncFailureKind):string{
  switch(kind){
    case "authentication": return "Canvas Token 可能失效。已暂停自动请求，请重新授权；本机旧任务和日历不会删除。";
    case "permissions": return "Canvas 拒绝访问部分数据。请检查当前账号的课程权限，已有本地数据保留。";
    case "rate-limit": return "Canvas 服务端限流，当前批次停止后续请求；请稍后手动重试，旧数据保留。";
    case "network": return "Canvas 网络不可用或请求超时，旧数据保留；恢复网络后可重试。";
    default: return "Canvas 返回了无法处理的内容，已有本地数据保留。";
  }
}
