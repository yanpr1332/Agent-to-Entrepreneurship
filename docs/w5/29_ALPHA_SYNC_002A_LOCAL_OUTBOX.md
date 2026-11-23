# ALPHA-SYNC-002A：个人任务与手动日历的本机事务 Outbox

> **开发范围**：为 SYNC-002 建立可恢复的本机同步队列与逐条授权基础。此阶段只写入两个现有 SQLite 数据库，**不连接 Supabase、不上传数据、不执行跨设备同步**。云端 push/pull、游标、用户界面和冲突解决属于后续批次。

## 1. 数据库迁移与备份

- `ate-local.sqlite`：schema v5 → v6。
  - 新增 `tasks.task_origin`：`manual`、`mail_candidate`、`canvas`、`legacy`。
  - 新建 `personal_sync_meta`、`personal_sync_entities`、`personal_sync_outbox`。
- `ate-fixed-calendar.sqlite`：schema v3 → v4。
  - 新建同一组 Outbox/选择/设备元数据表。
- 启动时在构造数据库之前，分别通过 `backupBeforeMigration` 对 local v6、calendar v4 目标版本执行在线 SQLite 备份；迁移失败时不会主动删除或覆盖原库。
- `ate-local.sqlite` 是本机唯一 device ID 的权威来源；固定日历库初始化时采用同一个 ID。若日历库单独从旧备份恢复，会向 local 库的 device ID 对齐，Outbox 操作本身不保存凭据或设备密钥。

## 2. 来源分类和明确授权

| 任务/事件来源 | 迁移/创建标记 | 是否允许用户逐条加入个人同步 |
| --- | --- | --- |
| 新建个人任务 | `manual` | 是 |
| 迁移前已有、来源不明的任务 | `legacy` | 是，但不会自动加入 |
| 从学校邮件候选接受生成的任务 | `mail_candidate` | **否** |
| Canvas 作业导入 | `canvas` | **否** |
| 手动创建的固定日历事件 | `fixed_events.source='manual'` 且 `source_uid IS NULL` | 是 |
| ICS 导入 / Canvas 日历事件 | ICS / Canvas 独立来源表 | **否** |

v5→v6 迁移会先将已有任务全部标记为 `legacy`，再根据 `mail_candidate_reviews` 的 accepted 记录和 `canvas_assignment_links` 将相应任务标为 `mail_candidate` / `canvas`。因此，已有任务不会因升级而被批量加入云端；邮件生成的任务也不会因为 `source === null` 而误入个人同步。

当前存储层提供 `setTaskSyncEnabled(ownerId, taskId, enabled)` 和 `setManualEventSyncEnabled(ownerId, eventId, enabled)` 两个逐实体选择入口。它们要求合法 UUID 账号 ID，且仅允许上述个人来源。**本 PR 尚未添加 Renderer 设置界面或 IPC 开关**；在后续 UI 接入前，这些 API 仅作为 Main 进程存储层能力，不会自动调用。

## 3. Outbox 协议

每个 SQLite 库独立维护：

- `personal_sync_entities`：以 `owner_id + entity_type + entity_id` 为键，记录该云账号对单个实体的启用/暂停、最近服务端版本和同步状态。
- `personal_sync_outbox`：记录不可混淆的 `operation_id`、账号、实体、动作、`base_version`、严格白名单 JSON 快照、创建时间、尝试次数和状态。
- `personal_sync_meta`：保存持久 device ID。任务库和日历库共用该 ID。

当前实体只有 `personal-task` 与 `manual-calendar-event`；动作只有 `upsert` 与 `delete`。快照仍由 SYNC-001 的 `projectPersonalTask` / `projectManualCalendarEvent` 投影，不包含邮件正文、Canvas 原始数据、ICS UID、知识库内容、文件路径或凭据。

### 原子性和幂等

- 对已明确启用的任务，更新数据库行和写入 Outbox 在 `ate-local.sqlite` 的同一事务完成。
- 对已明确启用的手动日历事件，单次编辑、删除、重复课程全系列/未来/指定区间编辑及系列删除，都在 `ate-fixed-calendar.sqlite` 的同一事务写入对应操作。
- 尚未尝试发送的同实体 pending 操作可以合并为最新快照；进入 `in_flight` 后，operation ID 和 payload 保持不变，网络响应丢失时后续同步器必须用相同 ID 重试。
- 同实体后续操作按顺序等待前一操作应答；成功应答更新服务端版本，并将下一条 pending 操作的 `base_version` 重新锚定到新版本。
- 服务端已确认的实体被本机删除时会保留 delete tombstone；从未发送且从未获得服务端版本的新建实体若在发送前删除，则取消其未发送操作，不创建无意义的远端墓碑。
- 冲突/失败/在途操作会阻塞同实体后续 pending 操作，避免乱序覆盖。冲突记录只保存截断后的诊断文本，不保存远端原始错误体。

### 暂停与删除语义

`enabled=false` 表示**暂停该账号在本机继续排队**，不是删除远端副本。暂停期间本机改动不会上传；远端数据保持原样。将来 UI 必须清楚提示：如果用户在暂停期间删除了本机实体，云端副本不会因此自动删除；恢复同步前需要用户选择恢复、重新同步或明确删除远端副本。真正删除远端内容必须由后续同步器执行 tombstone 并获得服务端确认。

## 4. 本阶段明确不包含

- Supabase 个人数据表、RLS policy、RPC、HTTP push/pull、Realtime 或任何真实云端写入。
- 自动同步调度、启动/网络恢复触发器、请求重试策略、持久游标与增量拉取。
- Renderer 中的逐条同步开关、同步状态、冲突比较/解决 UI。
- 远端版本冲突解决、撤权、账号切换 UI、跨设备首次全量合并。
- Canvas、邮件、ICS、学习规划、专注、知识库、AI 用量和向量数据同步。

因此，这个批次只能证明**本机授权选择和本地变更能够与 Outbox 原子落盘**，不能称为“跨设备同步 MVP 已完成”。

## 5. 测试与验收

新增/更新的自动测试覆盖：

1. 个人任务默认不进入 Outbox；显式启用后生成字段白名单快照。
2. 发送前连续编辑合并为一条 pending；进入 in-flight 后后续修改生成新操作；前一操作确认后下一条版本号正确重锚定。
3. 服务端已确认实体的删除生成 tombstone；删除未发送的新实体不会留下远端无效操作。
4. 暂停后不再返回可发送操作；重新启用会继续使用本机快照。
5. 邮件候选和 Canvas 任务不可选择；旧数据库升级会恢复 mail/canvas 来源分类并保留 device ID。
6. 手动日历事件可选；ICS 事件不可选；重复课程区间编辑只为已选 occurrence 排队，且与日历修改原子提交。
7. 两个数据库可以共用同一个 device ID；数据库迁移备份版本更新为 local v6 / calendar v4。

仓库根目录运行：

```sh
npm run typecheck
npm test
npm run build
```

`npm test` 包含全部 Vitest 与离线 Node RLS mock；不会访问 Supabase。Windows/macOS CI 结果以本 PR 最新 Checks 为准。真实 Supabase、双设备断网/重放和 Renderer GUI 尚未验收。

## 6. 下一步

- **SYNC-002B**：新增个人云端表和 RLS；设计按 owner/device/entity 的服务端版本、幂等 operation ledger、持久变更游标与删除墓碑；先在隔离 Supabase 项目测试，禁止复用团队 Workspace 表。
- **SYNC-002C**：接入 Main 进程 push/pull、网络恢复/重启续传、同实体串行、冲突持久化与用户选择 UI；添加账号切换/撤权、游标过期全量恢复及双设备实测。
- 在 002B/C 完成之前，Outbox 只在本机累积，不会自动上传。Embedding 仍排在同步核心门槛之后。

关联文档：[27 同步优先实施计划](27_ALPHA_SYNC_FIRST_IMPLEMENTATION_PLAN.md)、[28 SYNC-001 协议与 RLS](28_ALPHA_SYNC_001_PROTOCOL_AND_RLS.md)。
