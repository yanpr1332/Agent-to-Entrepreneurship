# ALPHA-SYNC-002E 续篇：旧版 ownerless 同步记录安全审查

> 状态：开发中；仅本地 IPC + Renderer 显式审查流程。**不部署 Supabase、不自动上传旧数据、不触碰生产数据。** 以真实 CI 和本地人工验收区分实施状态。

## 动机

早期的 `personal_task_sync_enrollment` / `personal_sync_outbox` 和日历同类表没有 `owner_id`。002C（PR #37）已把它们迁入带 legacy 标记的隔离表，**不能据此推断这些数据属于目前登录的账号**。此前已有 store 级 `adoptLegacyPersonalTaskSync` / `adoptLegacyManualEventSync`，缺少让用户看清风险的界面。

## 设计及安全边界

1. 仅登录当前本人云端账号后，由 Main 读取两套 SQLite 的未认领 legacy 行，不访问云端或提供后台定时自动审查。
2. 每个 SQLite 数据库至多显示前 100 条，独立检测是否被截断；余项保持隔离。列表只返回 record ID、标题或不可用提示、旧动作、旧时间、可重新授权布尔值，**不暴露旧 payload、历史 serverVersion、旧 JWT 或凭据**。
3. **只有**旧动作为 `upsert` 或 `enrolled` 且当前本机实体存活、源于个人任务/手动日历并通过白名单检查时，才显示重新授权按钮。
4. 用户先点「检查并重新授权」，再次确认当前登录账号。Renderer 只能提交 `entityType/entityId/expectedAction/expectedOperationId/confirmation`，不能提交 `ownerId`、旧/新 payload、baseVersion、设备信息或远端游标。
5. Main 用 `SharedCloudClient.currentUserId()` 的有效会话标识 owner，对最新 local review 做 compare-and-swap，拒绝旧动作/旧 operationId 已变化的过期确认；若同步运行中则拒绝修改，避免入队时的网络竞态。
6. 成功后只调用 store 已有、受 SQLite 事务保护的逐条 adoption：重新读取当前本地实体，创建新的 owner-scoped enrollment、新 UUID、新 payload，`serverVersion=null`。**不会在 adoption 时调用网络上传**；用户之后还必须主动点击「立即同步」。
7. 旧 `delete` tombstone、缺少当前本地实体、Canvas/ICS/邮件衍生的记录均不能认领，保持原隔离区，不会自动执行云端删除，也不会默认丢弃历史记录。
8. 同一条历史记录被明确认领后不再显示在未认领列表。若已由当前账号授权、被另一个线程认领或本地实体发生更改，store 会拒绝并回滚；不静默覆盖。
9. 只读取 legacy 列表不会生成设备身份/同步操作，不会启动 Supabase 登录/上传，也不会更改 SQLite ownerless 原表。

## 覆盖与测试

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/personal-sync-legacy.test.ts src/main/local-store.test.ts src/main/fixed-calendar-store.test.ts src/shared/ipc-channels.test.ts
npm test
npm run build
```

新增 mock 验收：本地只读 review 不调用 adoption；两种来源 owner-scoped 明确授权；缺失 `confirmation`、额外 owner/payload 字段、历史 delete、错误/过期 operationId 都被拒绝；每个本地库 100 项上限。已有 SQLite 迁移测试覆盖：真实 v6/v4 旧版数据进入隔离、旧版本不参与新队列、手动认领时从当前本机实体重新生成快照。

### 手动 UI 验收建议（只在隔离数据目录）

- 旧版迁移数据存在时登录测试云账号，进入“个人任务与手动日历同步”，观察隔离区名称、来源、旧动作、时间和 100 条截断警告。
- 不点击认领，检查各 owner 的待发送队列仍为空。
- 逐条点“检查并重新授权”，核对显示的当前账号；取消后不应修改任何状态。
- 确认一个合法个人任务或手动课程后，列表移除该旧行、普通候选列表标记已授权，**不能产生网络上传**；只有独立点击“立即同步”才可能发送新的授权内容。
- 旧删除墓碑只显示“保持隔离”，即使用户点击别处也不允许执行远端删除。切换账号后再次核对没有自动认领。
- 不将 CI/mock 通过记录为真实 Supabase RLS/双设备验收。

## 仍未完成

- **旧删除墓碑最终归档/清理**：本轮故意保持隔离；未来需设计可审计且不等于远端删除的操作。
- **设备撤销/重新注册、Cursor 损坏/备份恢复、跨数据库崩溃重放**：不因这一轮 UI 完成而放行自动后台同步。
- **真实 Supabase 与两个设备/五个账户的正反向 RLS 验收**：需要用户授权的隔离测试项目和真实执行证据；未经批准不运行外部 migration。
- **完整用户 GUI/安装包验收**：Mock UI 与跨平台构建成功均不是人工验收证据。
