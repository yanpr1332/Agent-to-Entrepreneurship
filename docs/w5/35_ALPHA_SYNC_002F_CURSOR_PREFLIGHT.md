# ALPHA-SYNC-002F 第一部分：设备与 Cursor 上传前预检

> 状态：开发 PR，待 CI / 独立 Reviewer；**未部署 Supabase、不自动上传、不恢复或替换已撤销设备**。本轮不改数据库 schema，也不需要服务端 migration。

## 背景与危险场景

上一版 SYNC-002D 的顺序是注册设备 → 上传待发送操作 → 拉取远端更新。若备份回滚/手工篡改令本机保存的 Cursor 无效或高于服务端，则可能先上传成功才在拉取时发现错误。设备被撤销时服务端已经拒绝 register，但本机的错误状态与 Cursor 恢复仍没有专门流程。

## 实施范围

1. `LocalStore.getOrCreatePersonalSyncDevice(ownerId)` 对已有 deviceId 做 UUID 校验，保存的 cursor 必须是无前导零的非负十进制且不超过 Postgres signed bigint 最大值（9223372036854775807）。损坏时抛错，**不生成新 ID、不重置或回退 Cursor、不触及待发送操作**。
2. 每次用户手动同步先注册当前 owner-scoped device。对有 pending 且 Cursor 非零的账号，上传前调用 `ate_personal_sync_pull` 做只读预检，limit=1，保留原 cursor，不修改本地实体。服务端拒绝、返回不合法的空页位置时直接阻断推送。
3. 如果预检发现远端未拉取变更，整轮跳过发送，按现有上限拉取远端变更、生成/保留冲突、在两套 SQLite 处理成功后推进 Cursor；用户确认冲突或查看状态后再手动点击同步。UI 明确显示“因远端新变更暂缓上传”，pending 仍在本地。
4. 若非零 Cursor 的预检发现远端没有新变化，继续原有版本 CAS 的 Push/Ack/Pull 流程；新设备 Cursor=0 不可能超前于服务端，但仍需先注册并通过服务端授权/版本校验。
5. 不暴露 deviceId、ownerId、Cursor 编辑/重置入口给 Renderer。不会自动替换已被服务端撤销的设备，不会自动重新授权源数据；Canvas/ICS/邮箱/知识库/规划和凭据继续排除。
6. 不加后台自动重试、没有新的云端查询或部署；预检只在用户点击“立即同步”且存在非零 Cursor + 待发送项时运行。

## 本轮验证

从仓库根目录执行：

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/personal-sync-preflight.test.ts src/main/personal-sync.test.ts src/main/local-store.test.ts
npm test
npm run build
```

新增的预检测试覆盖：已有 Cursor 且远端有新变更时推迟全部上传、先拉取再等待用户下一轮确认；没有未读远端时正常上传；远端拒绝 Cursor 时无任何 apply/ack；已撤销设备不发送操作；本地 SQLite 保存的损坏 cursor / deviceId 不再被拿来上传。

**这些都是 Mock 或本地 SQLite 测试，不构成真实 Supabase / Windows / macOS GUI / 双设备验收。** Windows/macOS CI 的 typecheck、Vitest 和桌面 bundle 结果还需在 PR 上核实。

## 已知限制与后续

- 恢复被撤销的设备需要**明确用户选择**、新的设备注册和现有 pending/operationId 的幂等历史核对；不能直接旋转 ID 后重发旧 operationId。
- 本地 Cursor 已损坏、回滚或云端历史遭裁剪时，不能直接清零重放；先在隔离目录备份并诊断，设计可审计的全量重建/冲突流程。
- 目前两套 SQLite 的 pull 应用与 cursor 写入并非跨数据库原子事务，进程崩溃后仍依赖幂等重放；特殊删除/计划占用冲突需继续测试。
- 真实 RLS 正反向、五账号、双设备、断网/重连、撤权、跨平台 GUI 和安装包验收均未执行；外部 Supabase SQL 仍需独立项目与明确授权。
