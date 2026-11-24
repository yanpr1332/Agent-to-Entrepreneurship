# ALPHA-SYNC-002C：本地 Outbox 账号隔离与安全迁移

> **状态：已合并 PR #37；本轮仅完成本地 schema/store 层，不执行网络同步。** Supabase 迁移不部署，旧 ownerless 队列不自动绑定账号。

## 1. 为什么必须先做

同一台设备可能先后登录多个 Supabase 账号。此前本地 enrollment/Outbox 只有 task/event ID，没有 owner_id；若直接把这些行交给新登录账号的 uploader，就可能把 A 账号的数据误传到 B 账号，或用 A 账号的旧 serverVersion 覆盖 B 账号的数据。

因此在任何网络上传之前，必须先做到：
- 每个账号独立的 enrollment、pending operation、serverVersion 和 acknowledgement。
- Main 进程从当前认证会话取得 ownerId；Renderer 不得自报 ownerId。
- 旧版无归属队列进入隔离区，不猜测、不自动上传。
- 旧数据重新授权必须是明确、逐条、可审计的用户动作。

## 2. 本轮数据库迁移

| 数据库 | 旧版本 | 新版本 | 新增内容 |
| --- | ---: | ---: | --- |
| `ate-local.sqlite` | v7 | v8 | 个人任务 owner-scoped enrollment/outbox 与 legacy quarantine |
| `ate-fixed-calendar.sqlite` | v4 | v5 | 手动日历 owner-scoped enrollment/outbox 与 legacy quarantine |

应用启动时先对两个数据库分别执行 WAL-aware 在线备份，再运行 schema migration；目标版本分别为 8 和 5。迁移在 SQLite 事务内完成，失败会回滚，不删除旧数据。

### 新表的关键约束

- `personal_task_sync_enrollment` 主键为 `(owner_id, task_id)`。
- `personal_sync_outbox` 唯一约束为 `(owner_id, entity_type, entity_id)`。
- `manual_calendar_sync_enrollment` 主键为 `(owner_id, event_id)`。
- `manual_calendar_sync_outbox` 唯一约束为 `(owner_id, entity_id)`。
- operationId 仍全局唯一；每个 owner 的同一实体最多只有一个 pending intent。
- 同一实体可以被多个账号分别显式授权；编辑会为这些已授权账号各自更新队列。

## 3. 删除、禁用与确认回执

- 禁用某个实体对某个账号的同步，只清理该 owner 的 enrollment 和 pending operation，不影响其他 owner。
- 删除实体时，对每个 owner 单独处理：已确认过的远端版本生成该 owner 的 delete tombstone；从未被服务端确认的本地创建只撤销该 owner 的 pending upsert。
- 删除手动重复课程时，对每个 occurrence、每个 owner 分别生成墓碑。
- acknowledgement 必须同时匹配 ownerId + operationId；账号 B 不能确认或清除账号 A 的操作。
- 编辑任务/日历时，只为已有 enrollment 的 owner 入队，不会因普通编辑自动启用同步。

## 4. 旧版 ownerless 数据的隔离规则

迁移不会把旧表直接改成当前账号的数据，而是重命名保留：

- `personal_task_sync_legacy_enrollment`
- `personal_sync_legacy_outbox`
- `manual_calendar_sync_legacy_enrollment`
- `manual_calendar_sync_legacy_outbox`

每条 legacy 行增加 `claimed_by_owner_id` / `claimed_at`，默认均为 NULL。它们不参与新的 owner-scoped Outbox 查询。

### 可重新授权的 legacy 项

只有仍存在且来源符合白名单的个人任务/手动日历事件，才可被逐条重新授权：
1. 用户查看 legacy 项目及当前本地实体。
2. 用户明确确认将该实体重新绑定到当前登录账号。
3. Main 使用当前云会话的 ownerId 调用 store 层 adoption API。
4. 新 enrollment 的 serverVersion 从 NULL 开始；忽略旧 ownerless serverVersion 和旧 payload。
5. 以当前本地实体重新生成新 operationId 与新 payload，避免发送过期快照。

adoption API 必须收到明确的 `confirmation === true`。当前轮只提供 store 层方法和测试；用户界面的查看/确认控件尚未接入。

### 不会自动认领的旧数据

- 旧 delete tombstone、已经不存在的任务/事件、无法证明来源的记录，继续留在 legacy quarantine。
- Canvas、邮件候选、ICS 导入、Canvas 日历、知识库和其他 SQLite 数据不允许通过 adoption API 进入个人同步。
- 旧数据不会因登录、退出、切换账号、应用启动或后台任务而自动认领/上传。
- 旧 tombstone 后续需要单独的人工审查与明确删除确认；本轮不提供自动删除远端副本的路径。

## 5. 自动化测试覆盖

- v6 本地任务库升级到 v8：设备表创建、ownerless enrollment/outbox 保留、账号队列为空、明确重新授权后使用新快照。
- v4 手动日历库升级到 v5：旧 enrollment/outbox 隔离、明确重新授权后使用新快照。
- 同一任务/日历事件分别加入两个 owner；编辑时两个 owner 得到各自独立操作。
- 账号 B 不能 ack 账号 A 的 operationId。
- 禁用一个 owner 不清理另一个 owner 的队列。
- 删除时为已确认 owner 创建 tombstone，未确认 owner 取消 pending create。
- 手动重复课程删除对每个 owner 独立写入每次 occurrence 的 tombstone。
- 本地迁移前备份目标版本提高到 v8/v5。

## 6. 本轮边界与下一步

**本轮未完成：**
1. 没有 Main-process uploader；没有调用 register/apply/pull RPC。
2. 没有 push 成功后的 owner-scoped ack 回写编排。
3. 没有 pull 变更应用到 task/calendar SQLite 的事务处理。
4. 没有远端删除、冲突副本和人工冲突解决 UI。
5. 没有逐条同步授权 UI、legacy quarantine 审查 UI 或设备管理 UI。
6. 没有真实 Supabase 部署、RLS 五账号验证或双设备验收。

后续 ALPHA-SYNC-002D 已在 [32](32_ALPHA_SYNC_002D_PUSH_PULL.md) 中实现手动 Main-process Push/Pull、逐条授权 UI 与冲突保留。冲突解决 UI、自动后台同步和真实 Supabase/双设备验收仍未完成。

## 7. 本地验证命令

```sh
npm run typecheck
npm test
npm run build
```

CI 通过只能证明迁移与 store 层代码测试通过，不证明真实 Supabase RLS、网络上传或多设备同步已经可用。


## 后续 legacy UI 进度（2026-11-24）

[34 旧数据隔离区审查](34_ALPHA_SYNC_002E_LEGACY_REVIEW.md) 在现有 store-level adoption API 上增加只读审查、Main 的登录 owner 约束及两次交互确认。不会自动归属旧记录；旧删除墓碑依旧隔离。原 002C 的迁移代码/验收历史保持不变。
