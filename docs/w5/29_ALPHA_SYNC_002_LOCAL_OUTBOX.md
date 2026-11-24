# ALPHA-SYNC-002：本地显式授权与持久 Outbox（第一阶段）

> **当前交付范围**：本地数据库迁移、逐条实体启用、事务性变更意图、重启后可读取的 Outbox、确认版本与删除墓碑。**没有远端传输、云端个人表、账号/设备绑定 UI、游标拉取或冲突界面。** 这不是完整跨设备同步。

## 1. 安全默认值与可同步实体

- 新建任务、手动日历事件默认不加入同步；用户必须对单条实体调用显式启用。
- Canvas 任务、ICS 导入事件、Canvas 日历事件不会被接受为同步对象。
- 已接受的邮件候选任务会通过 `mail_candidate_reviews` 关联检查而被拒绝；不能仅凭 `source=null` 批量推断其为普通个人任务。
- 专注会话、学习计划、知识库、邮件正文/草稿、AI 使用记录与 Token 均不进入此 Outbox。
- 关闭某实体同步会清理该实体的待发送意图，但保留本机实体；这不代表已经删除远端副本（远端撤销/删除仍需后续确认流程）。

## 2. 当前实现

### 个人任务（`ate-local.sqlite`，user_version 6）

新增：
- `personal_task_sync_enrollment`：每条任务显式授权，记录服务端版本（初始 null）。
- `personal_sync_outbox`：任务变更的稳定 operation ID、实体 ID、动作、baseVersion、严格白名单 payload 和创建时间。
- `setTaskSyncEnabled(id, enabled)`：逐条启用/关闭；不提供批量启用。
- `listPersonalSyncOutbox(limit)`：只读取本机待处理意图，不联网。
- `acknowledgePersonalSyncOperation(operationId, serverVersion)`：只有未来传输层收到服务端确认后才应调用。
- 对已启用任务的编辑在同一个 SQLite 事务里更新任务与 Outbox；待确认期间多次编辑合并到同一个 operation ID，保持重试幂等。
- 已有远端版本的任务删除会先写 tombstone，再删除本机任务；从未确认上传的新任务被删除时直接撤销本机 Outbox，不制造远端墓碑。

### 手动日历（`ate-fixed-calendar.sqlite`，user_version 4）

新增对应的 `manual_calendar_sync_enrollment` 与 `manual_calendar_sync_outbox`，只接受 `source='manual'` 且无外部 source UID 的事件。单次编辑、系列/区间编辑会在同一数据库事务中更新 Outbox；删除单条或整组系列时，为已确认上云的 occurrence 保留各自的 versioned tombstone。ICS/Canvas 来源不加入队列。

## 3. 迁移与备份

- 两个数据库各自通过 SQLite `BEGIN IMMEDIATE` 事务迁移；旧记录不会自动 enroll，也不会产生任何 Outbox 行。
- 本轮没有修改用户数据目录、迁移触发方式或自动备份策略；既有 `backupTo` 仍可用于迁移前快照。
- 迁移失败回滚到旧 schema；高版本数据库仍拒绝降级。
- 两个数据库不是跨库事务：任务与手动日历的授权/写入各自原子，不能宣称两个 SQLite 文件共同原子提交。

## 4. 下一步阻塞项

1. 设计账号与设备绑定：本地 Outbox 暂不包含 actorId/deviceId，必须在登录后由可信会话层补齐，绝不接受 renderer 自报身份。
2. 设计服务端个人表、RLS、版本检查、幂等 operation receipt 与 cursor 增量拉取；团队 Workspace 表不能复用。
3. 设计撤权、关闭同步后的远端副本处理、删除 tombstone 保留/回收及冲突时双方版本展示。
4. 增加 Outbox 崩溃恢复、SQLite 迁移备份/恢复和多设备断网回放验收。
5. 完成用户可理解的逐条授权 UI；当前 API 仅是 main-process store 能力，不应在没有 UI 的情况下宣称用户已能开启同步。

## 5. 验收命令

```sh
npm run typecheck
npm test
npm run build
```

Vitest 覆盖：默认不入队、显式单条授权、更新合并与 operation ID 稳定、服务器版本继承、已确认删除墓碑、未上传创建的本地撤销、关闭同步保留本地数据、拒绝 ICS 来源。真实云端同步尚未实现，因此不需要 Supabase 凭据，也不得运行 RLS 写入脚本来代替本轮本地验收。


## 6. 后续阶段记录（2026-11-24）

PR #35 已合并，完成本文件第 1–5 节所述的本地第一阶段。随后开发的 002B 服务端协议基础另见 [30](30_ALPHA_SYNC_002_SERVER_PROTOCOL.md)：owner-scoped 设备、记录、operation receipt 与 change log 表；RLS 默认拒绝直接表访问；通过 authenticated JWT RPC 注册/撤销设备、幂等 apply、按 owner cursor 分页 pull；本机 schema v7 按 owner 保存 deviceId/cursor。

**尚未完成**：本地 Outbox owner 隔离和网络上传/ack、pull 后本地应用、冲突副本与人工解决、逐条授权 UI、真实 Supabase 迁移部署和双设备验收。当前不能宣称个人跨设备同步已可用。