# W3 八模块接口、领域事件与事务
## 公开边界
| 模块 | 权威实体 | 公开命令 |
|---|---|---|
| M1 日程任务 | Task, Course, CalendarEvent, TimeBlock, Reminder | create/update/completeTask, getEvents, scheduleTimeBlock |
| M2 知识 | Resource, Node/Edge/Evidence, ReviewCard | importResource, search, linkKnowledge, recordReview |
| M3 专注 | FocusSession/Rule, RewardLedger | start/stopFocus, getStats, redeem |
| M4 协作 | Membership, TeamMessage, Assignment, TaskReview | invite, claim/assign, submitReview, approve/reject |
| M5 AI | AIProject, AgentRun, PlanProposal | proposePlan, runAgent, approveProposal, grant/revoke |
| M6 接入 | ConnectorAccount, ExternalBinding, SyncCursor | connect, pullChanges, disconnect, capabilities |
| M7 邮件 | MailMessage/Thread/Draft/SendAttempt | list, createDraft, preview, confirmSend, verifyAttempt |
| M8 工作台 | DashboardLayout, Notification, SearchProjection | overview, globalSearch, updateLayout |

各模块只能通过公开 Port 调用其他模块，不能直接修改其他模块内部数据库。任务保持单一 Task ID；M4 只持有其审核/指派扩展，M8 只持有聚合结果。

## 接口示意
```ts
type ErrorCode = 'PERMISSION_DENIED'|'AUTH_REQUIRED'|'OFFLINE'|
 'CONFLICT'|'STALE_VERSION'|'RATE_LIMITED'|'INVALID_INPUT'|
 'NOT_SUPPORTED'|'REMOTE_UNKNOWN'|'INTERNAL';
type Result<T> = {ok:true;value:T;version?:string} |
 {ok:false;error:{code:ErrorCode;retryable:boolean;operationId?:string}};
interface CommandContext {
 operationId:string;workspaceId:string;actorId:string;
 deviceId:string;expectedVersion?:string;aiProjectId?:string;
}
interface TaskPort {
 createTask(ctx:CommandContext,input:CreateTaskInput):Promise<Result<Task>>;
 updateTask(ctx:CommandContext,id:string,patch:TaskPatch):Promise<Result<Task>>;
 completeTask(ctx:CommandContext,id:string):Promise<Result<Task>>;
}
```
示例为设计契约，不代表 TypeScript 项目已创建。真正的 actor 身份需由可信应用/服务端身份上下文提供，不得相信渲染进程自报字段。

## 领域事件
统一字段 eventId,eventType,schemaVersion,aggregateId,workspaceId,actorId,occurredAt,causationId,correlationId,payload；消费者按 eventId 幂等。核心事件：TaskCompleted、CalendarEventUpdated、DocumentImported、KnowledgeEdgeVerified、ReviewAttemptRecorded、FocusSessionEnded、TeamAssignmentChanged、ReviewApproved、PlanProposalAccepted、MailReceived、PermissionRevoked、SyncConflictDetected。

## 事务与异常
本地命令：权限/版本检查 → 领域修改 → 同 SQLite 事务写业务数据 + DomainEvent + Outbox → 提交；网络副作用使用状态机、幂等键、失败补偿/人工恢复，不能假设跨网络事务。重复发送尤其必须避免盲重试。

## 跨模块用例
1. 邮件解析 → CandidateAction(pending) → 用户接受 → TaskPort.createTask → 来源关联；忽略时不建正式事项。
2. AI 建议 → PlanProposal/多个候选 TimeBlock → 用户仅采纳所选 → 校验课程锁定/任务版本 → 可撤销应用。
3. 复习评价 → ReviewAttempt(系统建议+用户最终评价) → 下次调度 → M1 候选日程。
4. 团队任务完成 → 单审核服务端核验 → Task 状态更新事件，个人视图引用同对象。
5. 原件/知识读取 → 文件授权+AI Project+外传许可独立校验。
6. 发信草稿冻结版本/账号/收件人/附件 → 用户逐次确认 → 一次尝试 → success/failed/unknown。
所有 Port 需针对重复命令、越权、离线、过期版本和异常恢复增加契约测试。
