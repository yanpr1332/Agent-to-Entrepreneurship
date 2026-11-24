# ALPHA-SYNC-002B：个人云端协议与设备身份基础

> **状态：本轮代码/协议实现；未部署到 Supabase、未连接本地 Outbox 网络传输、未完成双向同步。** 本文件不构成执行云端迁移的授权。

## 1. 本轮交付

- 新增 `20261124_ate_personal_sync.sql`，与团队 Workspace 表完全分离。
- 为每个 Supabase owner 建立设备注册表、个人记录表、幂等操作回执表、持久变更日志和 cursor 账户行。
- 所有个人同步表启用 RLS，策略按 `owner_id = auth.uid()` 限制；不向 authenticated 客户端授予直接表读写权限。只能调用受限 RPC。
- RPC 使用当前登录用户 JWT，服务端从 `auth.uid()` 取得 owner，并再次检查请求中的 actorId/ownerId；校验设备归属和撤权状态。
- 只接受 `personal-task` 与 `manual-calendar-event`，严格校验字段、类型、日期、时间范围与系列 ID；Canvas、ICS、邮件、知识库、文件路径和凭据不在 payload 白名单。
- `apply` 使用 `baseVersion` 乐观并发检查；同一 owner 的账号行在事务中锁定并分配 cursor，避免并发事务提交顺序导致客户端跳过较小 cursor。
- `operationId` 在 owner 范围内唯一；相同 ID + 相同请求返回原始回执，不重复应用；相同 ID + 不同请求返回 rejected。
- `pull` 以 deviceId + cursor 分页，limit 为 1–500，返回 nextCursor/hasMore；服务端保留 tombstone，不物理删除记录。
- 可撤销单个设备；撤销后该设备的 apply/pull 都会被拒绝。
- 本机 `ate-local.sqlite` schema v7 按 owner 持久保存 deviceId 和 cursor；不同云账号有不同设备 ID，cursor 不能倒退。
- `SharedCloudClient` 增加设备注册、operation apply、增量 pull、设备撤销 RPC 包装；所有请求仍在 Main process 使用用户 JWT，Renderer 不持有 token。

## 2. 云端表和权限边界

| 表 | 用途 | 客户端访问 |
| --- | --- | --- |
| `ate_personal_sync_accounts` | 每个 owner 的 cursor 序列化计数器 | 无直接访问，仅 RPC |
| `ate_personal_sync_devices` | owner 与 deviceId 绑定、设备标签、撤销时间 | 无直接访问，仅 RPC |
| `ate_personal_sync_records` | 每个实体最新 payload、version、deleted tombstone | 无直接访问，仅 RPC |
| `ate_personal_sync_operations` | operationId 的 request/response 幂等回执 | 无直接访问，仅 RPC |
| `ate_personal_sync_changes` | owner 范围的持久增量变更流 | 无直接访问，仅 RPC |

所有 SECURITY DEFINER 函数固定空 search_path、撤销 public/anon 执行权限，只授予 authenticated。RPC 内不使用 service_role，不接受客户端自报身份作为授权依据。RLS/静态 DDL 测试仅是代码级检查，不替代独立 Supabase 项目上的真实五账号反向权限测试。

## 3. 版本、幂等与 Cursor

- 新实体的 `baseVersion=null`；接受后版本从 1 开始。更新/删除必须提交当前 serverVersion，否则返回 conflict，不使用客户端时间戳做 LWW。
- 删除保留服务端 tombstone 与版本，允许后续显式恢复；远端副本保留/清理策略仍需用户产品决策。
- 每个 owner 的 cursor 由账号行锁串行分配；变更记录与版本更新在同一 PostgreSQL 事务内提交。
- pull 页按 cursor 严格递增。客户端必须先将整页变更安全应用到本机，再持久推进 cursor；本轮只实现 RPC 与严格 parser，尚未实现本地 apply。
- operation receipt、change log 目前没有自动清理策略；保留期限、用户删除云端副本、cursor 过期重置需要后续设计。

## 4. 本机身份与迁移

- `ate-local.sqlite` 从 schema v6 升至 v7，新增 `personal_sync_devices(owner_id, device_id, cursor, created_at, last_sync_at)`。
- deviceId 对同一 owner 稳定，对不同 owner 分开生成；应用重启后不变。
- cursor 以十进制字符串保存，避免 SQLite/JavaScript 数值精度损失；只允许单调递增。
- 启动前的本地迁移备份目标版本同步提高到 v7，因此 schema v6 及更早版本会先生成快照；旧任务、Outbox 和 enrollment 保持原样。
- 当前 Outbox 尚未增加 owner_id 作用域，因此**不能直接调用 apply 上传现有队列**。下一轮必须先完成本地 enrollment/Outbox 的账号隔离与旧未绑定条目的重新授权规则。

## 5. 当前未完成项（不可误报）

1. 没有把新 SQL 迁移部署到真实 Supabase 项目；没有真实账号、设备、RLS 或多设备测试。
2. 没有 Outbox uploader、自动/手动传输编排或 ack 回写；本地 pending 操作仍只保存在 SQLite。
3. 没有 pull 后的 task/calendar 本地应用、远端删除应用、冲突副本保存和人工解决界面。
4. 没有逐条授权 UI；现有逐条授权仍是 main-process store API。
5. 没有关闭同步后远端副本删除/撤销、保留期、全设备撤权及恢复流程。
6. 没有 SYNC-003 Realtime；团队协作仍是独立 PoC 轮询。
7. 没有任何 SQLite 数据自动上传；Canvas、ICS、邮件、知识库和其他 SQLite 数据仍排除。

## 6. 本轮验证

```sh
npm run typecheck
npm test
npm run build
```

自动化包含：本地 per-owner deviceId/cursor 持久化与迁移、pull page 严格解析、当前 JWT 设备注册/apply/pull/revoke 客户端请求、不同账号 operation 拒绝、个人同步 SQL/RLS 静态检查。真实 Supabase 迁移和五账号验收必须在用户明确授权的隔离项目中另行执行。

## 7. 下一轮建议

先做本地 owner-scoped enrollment/Outbox schema 升级与安全迁移，再接入显式手动同步按钮、push + ack、pull + 本地事务应用、冲突保留/选择 UI。只有这几步完成后，才可把功能称为个人任务/手动日历跨设备同步 MVP。
