# ALPHA-SYNC-002F 续篇：显式更换同步设备身份（保留 Cursor）

> 状态：单 PR 开发中，待 GitHub Actions Windows/macOS 检查及非作者 Review。**仅针对当前登录账号，当前设备已有合法 UUID / Cursor 且没有待发送队列和未解决冲突时开放。不能用于损坏 Cursor 自动恢复。** 不部署远端 SQL，也不启动后台同步。

## 目标与操作顺序

已合并 PR #41 仅在客户端阻断损坏的 deviceId/Cursor，并对非零 Cursor 的待发送队列预检。本次补齐“当前设备被云端撤销或需要安全更换本机身份”的用户主动操作，但不会清空已确认的同步进度。

1. 用户登录云端账号，点击“检查设备更换条件”。Main 从真实当前会话获取 ownerId，读取当前 owner 的持久设备身份及 Cursor，不接受 Renderer 传入设备 ID、账号 ID、Cursor、服务端版本或任何待上传内容。
2. Main 要求当前账号 **任务 Outbox、手动日历 Outbox 和持久冲突列表均为空**。否则返回不可更换原因，不生成确认令牌；只有来源白名单已确认的 owner-scoped 数据参与后续同步。
3. 满足条件时由 Main 生成一次性随机 review token，绑定 ownerId、原 deviceId 和原 Cursor。Renderer 显示当前登录邮箱及不可自动上传/不可修复 Cursor 的警示，用户再按一次“确认撤销旧设备并更换身份”。
4. Main 严格校验确认对象仅有 `reviewToken` + `confirmation:true`。没有有效确认或当前账号发生变化会拒绝；重复提交 token 失败。
5. Main 首先使用当前账号 JWT 调用已有服务端 `ate_personal_sync_revoke_device` RPC。远端出错时**不更换本机 ID**；RPC 返回 false 表示该设备已撤销或未登记，可继续在本地更换。
6. 请求结束后再次检查会话 owner、任务与日历待发送项目和冲突，确保使用先前审阅的 deviceId/cursor 通过 SQLite 事务 CAS 更换为新 UUID，保留旧 Cursor、enrollment、operation receipts/outbox。服务端旧 ID 已失效，新 ID 在下一次**用户手动同步**时注册。
7. 在设备更换网络请求期间阻断另一轮同步、冲突决策与 legacy 认领；关闭应用时等待此请求结束或中止后不继续更改本地身份。若撤销后发生新本地修改，操作中止且保留本地数据，不能偷偷强制继续。
8. 对所有有待发送项目的同步，不论 Cursor 是否为 0，都在上传前执行 `pull(limit=1)` 只读预检。发现远端未读数据则整轮先拉取、延后 Push；Cursor 异常、设备失效、服务端拒绝都会阻断上传。

## 本轮测试与验收

在仓库根目录：

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/personal-sync-device-replacement.test.ts src/main/personal-sync-preflight.test.ts src/main/personal-sync.test.ts src/main/local-store.test.ts src/shared/ipc-channels.test.ts
npm test
npm run build
```

自动化覆盖：撤销当前 owner 而不影响其他账号；保留 Cursor、无队列无冲突时更换 device ID；单次令牌/额外字段拒绝；任务和手动日历 pending 或持久冲突禁止更换；云端撤销失败不改本地；撤销等待期间切账号或新增日历任务不执行本地更换；Cursor 0 的待发送操作也先预检；RPC 只走 Main。

人工验收需在**隔离 ATE_USER_DATA_DIR 和隔离 Supabase 项目**中核查：正常账号登录 → 未选择时不调用撤销；无 pending/conflict → 显示二次确认 → 取消后不变化 → 确认后旧设备撤销、新设备仍需下一次手动同步；账号切换后不能复用确认；模拟离线/撤销错误不会更改本机 ID；待同步数据存在时按钮只显示阻断原因，不能清空以绕过。

## 限制与剩余工作

- **这是设备 ID 更换，不是云端数据全量重建或 Cursor 损坏修复。** 被篡改、超出 signed bigint、领先服务端的 Cursor 继续拒绝；要先做可审计的备份/恢复与源事实对账，不能一键置 0。
- 待发送操作（特别是“服务端已接受但 ACK 丢失”）不允许直接换 deviceId。它们保留在本地，由后续专门的重放/对账流程解决，不能凭猜测改 operationId。
- 服务端撤销成功而本地 CAS 失败时，旧设备可能被拒绝但本地数据不变。用户需要先处理新出现的 pending/冲突，并重新走审查；没有自动重试。
- 两个 SQLite 文件尚无跨库原子事务；真实 Supabase/RLS/双设备、Windows/macOS GUI、断网/设备撤权实测仍未执行。Mock CI 不代表真实环境完成验收。
