# ALPHA-SYNC-002D：手动 Push/Pull、本地应用与冲突保留

> **状态：Main/Renderer 本地链路与自动化测试开发中；Supabase SQL migration 未部署，真实远端联机与双设备验收未做。** 本轮不启用自动后台同步。

## 1. 本轮目标与边界

在 002B 服务端 RPC、002C owner-scoped 本地 Outbox 之上，打通最小可控传输链路：
- 用户必须登录本人云端账号，并在 UI 中逐条勾选个人任务/手动课程。
- 只由 Main process 从当前认证会话取得 ownerId；Renderer 不能提交 ownerId、deviceId、cursor 或 operation envelope。
- 点击“立即同步”后注册稳定设备、上传本地待发送操作、确认回执、分页拉取并应用到本地。
- 远端变更遇到本地未发送修改时，保留双方内容并记录冲突；绝不静默覆盖。
- Canvas、ICS、邮件、知识库、专注记录、学习计划和旧 ownerless 队列不在本轮同步范围。

**本轮不是“完整双向同步已可用”**。没有自动定时/后台同步、冲突解决 UI、设备撤销 UI、legacy quarantine 认领 UI，也没有真实 Supabase 部署/多设备验收。

## 2. Main-process 编排

新增 `PersonalSyncService`，依赖现有 `SharedCloudClient`、`LocalStore`、`FixedCalendarStore`：

1. 读取 `SharedCloudClient.currentUserId()`，不接受 Renderer 身份。
2. 从 `ate-local.sqlite` 读取该 owner 的稳定 deviceId/cursor，并调用注册设备 RPC。
3. 合并任务 Outbox 与手动日历 Outbox，按创建时间顺序上传；每轮最多读取 100 个任务和 100 个日历操作。
4. 上传每一项前重新确认其 operationId 仍存在于当前 owner 的 Outbox；用户在前一个网络请求等待期间编辑或撤销的后续旧操作会被跳过，不上传过期快照。
5. 只对 `accepted`/`duplicate` 回执执行精确 owner-scoped ack；`conflict`、`rejected`、`retryable_failure` 均保留本地操作，不伪造成功。
6. 若已发送操作在途期间被本机新编辑/删除替换，当前 sync run 可基于自己刚才发送的原始快照调用独立 rebase 方法；store 的精确 ack 不会仅凭“当前 owner 有同实体 pending 行”推断 operation lineage，因此跨账号 operationId 不会误改另一账号队列。
7. 拉取每页最多 200 条变更，每轮最多 10 页；超过上限返回 `hasMore=true`，用户可再次点击继续。
8. 任务和日历变更分别在各自 SQLite 事务中应用；冲突记录写入任务库。
9. 只有两个 store 的变更与冲突记录均成功后，才推进本机 cursor。

网络请求不是 SQLite 事务的一部分。如果一库已应用而另一库失败，本机 cursor 不前进；重放同一页时按 serverVersion/owner/enrollment 检查实现幂等，不重复覆盖。

## 3. 幂等、并发编辑与撤销授权

operationId 必须对应不可变请求内容。普通本地编辑会将 pending Outbox 的 operationId 轮换为新 UUID，而不是复用旧 ID 携带新 payload；同一实体仍只保留一条最新 pending intent。

若一次上传期间用户再次编辑：
- 旧请求可能已被服务端接受。
- 精确 ack 只确认 owner + operationId + entityId + action + baseVersion 全部匹配的原始队列项。
- 若原 operationId 已被新 intent 替换，当前 sync run 才可调用独立 rebase；只有新 intent 的 baseVersion 与旧请求发送时的 baseVersion 一致，才将 enrollment 和新 intent 安全 rebase 到服务端新版本。
- 若用户在首次上传确认前删除本地实体，旧 upsert 被接受后会补写一个新 delete tombstone；禁用同步但保留实体则不会推断远端删除。
- 网络超时后重试使用相同 operationId + 相同 payload；不得把同一 operationId 改成不同请求。
- 用户在某个网络请求等待期间撤销尚未发送条目的授权，下一条上传前的 pending 检查会跳过该操作。已经发出的在途请求无法撤回；若服务端接受，远端副本保留，UI 明确说明取消勾选不会删除云端副本。

应用退出时，PersonalSyncService 停止继续发送/应用，等待当前有超时保护的网络请求结束后再关闭 SQLite。未收到确认的 Outbox 保留，下次登录后可用同一 operationId 安全重试。

## 4. 远端变更应用与冲突保留

- 无本地 pending intent 且实体可安全应用时，远端任务/手动课程按原 entityId upsert；同一 owner 的 enrollment.serverVersion 更新为服务端版本。
- 远端删除只删除该 owner 已同步的本地个人任务/手动课程，不会触碰 Canvas、ICS、邮件候选或其他数据源。
- 若本地存在更高优先级的 pending intent（其 baseVersion 早于远端变更），本地实体保持原样；把本地 operationId/action/payload 与远端 version/payload/deleted/updatedAt 保存到 `personal_sync_conflicts`。
- 如果目标 ID 已被本地不符合来源白名单的实体占用，或远端手动课程与已确认学习块冲突/超出本地容量，则记录阻塞冲突，不覆盖本地对象。
- 同一 owner/entity 的冲突记录保留最新远端版本；UI 显示双方标题和云端版本，尚未提供选择本机/采用云端的操作。

## 5. 逐条授权 UI

云端协作页新增个人同步区域：
- 只显示可授权的本地个人任务（排除 Canvas 任务和已接受邮件候选）及手动创建日历事件（排除 ICS/Canvas）。
- 每个条目独立勾选/取消；账号身份只由 Main 从会话读取。
- “立即同步”是唯一触发方式；没有登录时无法读取候选/Outbox。
- 取消勾选只停止该 owner 的后续同步并清理待发送意图，不会删除云端已有副本。
- 拉取到的同账号远端实体会在本机创建 owner-scoped enrollment，以便该设备后续编辑可以正常入队。

## 6. 数据库与迁移

| 数据库 | 版本 | 本轮变化 |
| --- | ---: | --- |
| `ate-local.sqlite` | v8 → v9 | 新增 `personal_sync_conflicts`，按 owner/entity 保存本地与远端冲突快照 |
| `ate-fixed-calendar.sqlite` | v5 | 无 schema 变化 |

应用启动前对本机任务库的备份目标版本从 v8 提高到 v9；手动日历仍为 v5。迁移事务失败会回滚，不删除旧任务、Outbox 或 legacy quarantine 数据。

## 7. 自动化测试

新增/更新覆盖：
- 逐条候选列表、任务/日历远端 upsert 与 delete。
- 本地 pending 修改不被远端覆盖，双方快照进入 conflict 表。
- 普通编辑轮换 operationId；旧请求成功时独立 rebase 新 intent。
- 跨 owner 的错误 operationId ack 返回 not-pending，不会改写另一个 owner 的新 intent。
- 用户撤销尚未发送条目后，当前 sync run 不会继续上传该条目。
- 首次 upsert 在途时本机删除，ack 后生成补偿 tombstone。
- 手动同步并发点击合并为同一 in-flight Promise。
- 应用退出时停止后续同步，当前请求结束后再关闭数据库；未确认操作保留。
- 本地变更应用失败时 cursor 不前进；重放保持幂等。
- v8→v9 冲突表迁移及旧任务保留。
- IPC allowlist、Renderer 类型与 UI 构建。

CI 通过只能证明本地代码和 mock 逻辑；不证明远端 RPC 已部署、RLS 生效或双设备真实一致。

## 8. 本地验收

在仓库根目录运行完整验收：

```sh
npm run typecheck
npm test
npm run build
```

若先只验证本轮涉及的核心测试，可执行：

```sh
node node_modules/vitest/vitest.mjs run src/main/personal-sync.test.ts src/main/local-store.test.ts src/main/fixed-calendar-store.test.ts src/main/local-backup.test.ts src/main/mail-candidates.test.ts src/shared/personal-sync-contract.test.ts src/shared/ipc-channels.test.ts
npm run test:sync-rls
```

完整 `npm test` 会运行 Vitest 全套测试及 RLS 静态验收脚本；`npm run build` 会再次执行类型检查和完整测试，再编译 Electron-Vite。上述本地测试不访问真实 Supabase。

隔离数据目录的启动前备份目标应为：
- `ate-local.sqlite`：v9
- `ate-fixed-calendar.sqlite`：v5

没有独立 Supabase 测试项目和明确部署授权时，不执行 SQL migration、不填写真实账号、不将 CI 标为联机验收。

## 9. 下一阶段

ALPHA-SYNC-002E：冲突解决与恢复 UX：
1. 逐条选择“保留本机版本”或“采用云端版本”，每次操作生成新 operationId 并使用最新 serverVersion。
2. 对远端删除冲突提供恢复/确认删除选择，禁止静默 resurrect。
3. 处理 cursor 损坏/本机数据库恢复/设备被撤销后的重新注册流程。
4. 逐条检查 legacy quarantine 的重新授权/删除 tombstone 人工处置。
5. 完成隔离 Supabase 项目部署审批后，再做真实 RLS、双账号/双设备、断网重连与撤权验收。

完成 002E 前，冲突仍只保留与展示，不应称为完整个人双向同步 MVP。


## 10. 后续 ALPHA-SYNC-002E 进度

PR #38 已合并；在其基础上新增 [33 冲突解决实施说明](33_ALPHA_SYNC_002E_CONFLICT_RESOLUTION.md)。002E 为本地待发送与云端变更冲突提供用户二次确认选择，仍未解决设备撤销/Cursor 恢复、legacy quarantine UI、跨数据库提交原子性和真实 RLS/双设备验收。
