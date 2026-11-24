# ALPHA-SYNC-002H：同步健康诊断与精确发送回执对账

> 状态：单一开发 PR，需通过 Windows/macOS CI 和**非作者安全审查**。不运行真实 Supabase，不部署 SQL，不提交任何账号凭据。本批次不是 Cursor 自动重建，也不是强制覆盖云端的恢复工具。

## 两项能力及边界

### 1. 只读健康诊断

- 云端新增 `public.ate_personal_sync_inspect_device(p_device_id uuid)`（单独 SQL migration）。以 `auth.uid()` 作为唯一 owner，在 security-definer + 空 search_path 下从账号表读取服务器 Cursor、从当前 owner 的设备表读取状态：`active` / `revoked` / `unregistered`。只返回最小元数据，不读写业务实体、设备 last_seen、Outbox 或凭据。**其他账号的相同设备 ID 视为未注册**。
- Main 只从当前登录会话获取 owner ID，先读本地 SQLite 状态和待发送/冲突数量：从不创建新设备。若本地设备/Cursor 已损坏，直接报告本地异常而不访问网络；若有未完成的 Pull 检查点，报告优先重放；有效时才调用新 RPC 并比较 localCursor/serverCursor，判断是否超前。
- 诊断不会将 Cursor 清零/回退、自动注册/撤销设备或上传。远端 RPC 未部署、离线或权限失败都报告“不可用”，**不是服务端没有数据**。UI 展示当前账号的计数、状态和排障提示，不公开账号、设备 ID 或旧 payload。
- 已被撤销且有 pending 的设备，**不会**因为诊断成功而自动重新注册；仍遵守 #42 的显式更换限制。

### 2. 显式核对未确认发送回执

- 云端新增 `public.ate_personal_sync_lookup_receipt(p_operation jsonb)`。服务端严格以 `auth.uid()` 定位 `ate_personal_sync_operations` 中的完整历史请求，只有当前提交的**完整操作请求**（包括原 deviceId、operationId、actor/owner、payload、baseVersion、clientTimestamp）与保存的 JSONB 完全相等，才返回 `matched` + 对应已保存的状态/版本/游标。若未找到回执返回 `not-found`；找到同 ID 但请求不同返回 `mismatch`，**不会**返回旧请求内容或业务实体。该 RPC 不写入云端。
- 用户主动点击“仅核对未确认发送回执”，Main 在两个本机 owner-scoped Outbox 分别读取最多 100 项；先用当前身份构造严谨协议包，再对所有本轮项目查询并严格解析回执，**任何服务端错误、请求不匹配、账号切换或格式非法都在修改任何本地队列前中止**。
- 对于确切 `matched` 且状态为 `accepted` / `duplicate` 的条目，才运行已有本机 acknowledgement + CAS rebase；若用户在网络查询期间修改了同一条目，只按原 operationId 处理，绝不把新版本当旧版本清空。其他 `matched` 冲突/拒绝、`not-found` 都继续留在 Outbox；下一次“立即同步”仍需正常版本校验。
- 本功能**不会**调用 `ate_personal_sync_apply`、不会 pull、不会注册/撤销设备，也不会自动重试或生成新 operationId。没有本地设备或存在尚未完成的 Pull 检查点时阻止回执核对。RPC 未部署或断网时保留全部本地待发送记录并显示错误。
- 对已经因用户编辑而更换 operationId、且本机不再保存旧操作包的历史发送，目前**不能**推断旧回执；远端未来需支持带完整历史请求封存的审计/对账。不得据此清零 Outbox 或自动认为成功。

## SQL 部署与真实测试前提

唯一新增后端文件：`supabase/migrations/20261124_ate_personal_sync_recovery_inspect.sql`，必须在已有个人同步表和 RPC 的**隔离 Supabase 测试项目**上由有权限者审核并手动运行。此 PR/CI **不会**运行远端 migration 或访问生产项目。旧的“立即同步”流程不依赖这两个新增 RPC，未部署时仍使用既有幂等 operationId；只有新增检查/核对按钮因缺少 RPC 无法使用。

真实手工安全验收（需明确提供独立账号和隔离项目）：

1. A 登录注册设备，A 的健康查询返回自己的 serverCursor/设备状态；B 对 A 的 deviceId 只会看到 `unregistered` 和 B 的 serverCursor，而不会看到 A 的内容；未登录/anon 无权执行 RPC。
2. 在 A 下创建一次已接受操作，断网模拟客户端未收到 ACK。保留原 Outbox，点击“仅核对”应只做 RPC 查询并把**完整匹配**的已接受记录本地 ACK；B 使用相同 operationId 只能得到 `not-found`，不能读取 A 的回执。
3. 用同 operationId 但更改 payload、baseVersion 或 deviceId，必须返回 `mismatch` 且本地不核销；未知操作必须 `not-found`。`conflict`、`rejected` 不得自动当作成功。
4. 测试本机保存的 Cursor 大于 serverCursor、设备撤销、检查点损坏与网络断开；只读诊断应显示阻断/不可用，不改变本地 cursor、Outbox 或设备身份。
5. B 登录不能复用 A 的健康查询或处理 A 的回执；在途切换账号应中止确认；退出或关闭应用时不得继续突变本地队列。
6. 逐一核对两台真机和 Windows/macOS GUI，记录 RLS 反向案例与无泄漏日志；真实云端和跨设备通过之前本功能状态仍是“待验收”。

## 本地验证

在仓库根目录运行：

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/personal-sync-recovery-health.test.ts src/main/personal-sync-recovery-sql.test.ts src/main/cloud/supabase-client.test.ts src/shared/personal-sync-contract.test.ts src/shared/ipc-channels.test.ts src/main/personal-sync-pull-recovery.test.ts
npm test
npm run build
```

新增单测覆盖：只读、不产生本机设备；本机损坏先阻断；撤销、未注册、Cursor 超前、RPC 未部署；客户端 JWT 透传与严格返回解析；两种 Outbox 的已接受回执核销、冲突/未知保持、请求 mismatch 全批阻断、网络中断无本地改动、在途编辑 operationId 换代 CAS、账号切换以及 checkpoint 的排他性。SQL 静态测试只核对代码中的权限和**无 DML**，不代表 Postgres/RLS 在真实项目中已通过。

## 需要继续开发

- 非法或超前 Cursor 的**有审计轨迹的人工恢复/全量重建**，包括校验本地数据副本与云端多版本实体，不允许一键清零。
- 旧 operationId 离线历史与跨设备已发送/未确认操作的更完整对账；无法仅根据 entityId 猜测已接受。
- 团队 Realtime、断线补拉、五账号联机、真实 RLS 逆向测试、安装包及两平台真机 GUI 验收。
- 本功能不会加入自动后台云同步；Canvas、ICS、邮件、知识库、AI 凭据和规划数据均不在个人同步范围内。
