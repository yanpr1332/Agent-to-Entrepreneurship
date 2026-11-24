# ALPHA-SYNC-003A：团队 Realtime 提示、断线补拉与撤权隔离

> 状态：一个开发 PR，等待 Windows/macOS CI、非作者 Review 与隔离 Supabase 项目实际验收。本批次仅是 SYNC-003 的**第一阶段**，不宣称完成持久历史游标或真实五账号联机。未部署任何服务器 SQL，也未使用 RDC。

## 当前开发结果

本轮将团队消息/任务固定十秒轮询升级为：

1. **Main 独占 Realtime 连接**：仅使用当前已登录用户的 access_token + 公开 Supabase publishable key。项目 URL 仍由现有 `validateCloudProject` 限制为 `https://<project>.supabase.co`；WebSocket 是同域 `wss://...`。不向 Renderer、IPC、磁盘或日志返回 JWT、session refresh_token 或消息 payload。
2. **明确的 workspace 订阅**：每次 watch 和重连都通过 REST 读取当前用户是否为选定 workspace 的成员，订阅 Phoenix `postgres_changes` 的 `ate_workspace_messages`、`ate_workspace_tasks` 两张表，并为两者加 `workspace_id=eq.<uuid>` 过滤。任何 RLS 拒绝或身份不匹配立即停止新订阅。
3. **只转发“刷新提示”**：Socket 的事件数据不构成已确认业务内容，不进入消息/任务列表。Main IPC 仅发送 `workspaceId,phase,hint`；Renderer 遇提示后只通过原有用户 JWT 的 REST/RLS 请求重新获取成员、消息和任务。入站最大帧长度 64KiB，异常 JSON 被忽略。
4. **断线与长连接容错**：每 25 秒 Phoenix heartbeat；长时间无帧（80 秒）视为失活；网络错误、WebSocket 关闭、订阅拒绝/缺失订阅表均回到十秒轮询，同时指数退避至 30 秒上限重连。重连刷新用户登录态，重新验成员资格。主动切换工作空间或退出账号立即关闭旧 Socket，并阻止旧工作空间的异步结果污染新页面。
5. **周期性补拉**：实时已连接仍每 30 秒通过 REST/RLS 获取可信快照，避免实时事件丢失、乱序和同一事件重复造成的旧内容滞留；未连接则每十秒刷新。提示、初次进入及重新连接时都会补拉。仅订阅不保证收到所有历史事件。
6. **权限撤销清理**：每次快照先通过 REST 验证当前用户仍在 workspace 成员列表，再读取消息/任务；成员记录缺失、401/403 等异常会立即清空界面中原有成员/消息/任务和邀请码，并重新获取当前可访问小组。切换账号不继承旧数据。
7. **Supabase 可选 SQL**：`supabase/migrations/20261124_ate_workspace_realtime_hints.sql` 只将两张团队业务表加入已有 `supabase_realtime` publication，检查重复执行，**不修改 RLS、不给匿名用户增权、不发布成员/邀请表/个人资料**。没有该 SQL 或服务器未授权订阅时，仍使用安全 REST 轮询。

## 本批次真正覆盖的范围

- 用户当前选择的 **一个工作空间**，只推送团队消息和任务的“有变化”提醒；未选择小组不会打开 WebSocket。
- REST 快照仍按当前服务端接口每类返回**最近 100 条**。这能给现有 Alpha PoC 提供可靠的最新窗口回补，但**不是跨重装持久游标、无限历史补拉、历史数据永久保存或离线草稿队列**。超过 100 条窗口的历史、删除事件补拉和消息完整排序仍是后续 SYNC-003B 要做的。
- 聊天消息/任务现有 RLS、权限和写入 API 不变；没有团队离线写队列，断网期间创建和编辑仍需要用户重新提交。
- **个人任务/日历**仍按现有单独手动同步机制运作，Canvas/ICS/邮箱、知识库、Token、PDF 和 AI Key 不加入团队 Realtime。

## 在仓库根目录验证

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/cloud/workspace-realtime.test.ts src/main/cloud/workspace-snapshot.test.ts src/main/cloud/workspace-realtime-sql.test.ts src/main/cloud/supabase-client.test.ts src/shared/ipc-channels.test.ts
npm test
npm run build
```

自动化覆盖：无成员拒绝握手、JWT 仅 Main 使用、WSS 域名校验、订阅范围、成功 join/提示不透传 payload、错 topic/坏 JSON/超大帧丢弃、订阅缺失回退、断线重连复核成员、关闭旧 Socket、异步切换防串数据、静默超时、成员不在时不请求共享内容、登录状态切换阻断、SQL publication 范围静态检查。

## 真实 Supabase 隔离验收（当前均阻塞）

1. 在授权的**隔离测试项目**上先执行原 workspace PoC SQL，再检查 RLS，最后人工执行新 publication SQL。确认成员 A 可以订阅、B 非成员不能通过 PostgREST 或 Realtime 获得该组内容。
2. 五个独立测试账号从 Windows/macOS 两设备进入同一个测试 workspace，由 A 发送消息、B 建任务、C 更新任务；其他成员确认接收提示后 REST 重新获取正确内容。
3. 模拟断网 60 秒，A 同时写多条消息和任务；B 重连后看到最新窗口内数据，无重复消息；删除/写入权限必须仍受 RLS 限制。
4. 撤销或移除成员，观察下一次 REST 权限复核时清空其历史 UI 列表，拒绝继续读取；若其它账号仍有访问权，订阅切换不混入无关工作空间内容。
5. 在全部测试期间确保没有 access_token、Realtime 原始行和邮件/知识内容进入 Renderer IPC、错误日志或版本库。

当前没有独立 Supabase 授权或测试凭据，故这些项目只能标记 **Blocked/未实测**。CI 只证明本地协议和回退模拟。

## 后续待开发

- **SYNC-003B**：服务端可信单调增量游标、持久恢复位点、任务/消息删除墓碑、超出最近 100 条窗口的分页历史补拉，跨设备全量消息一致性。
- **SYNC-003C**：真实五账号 RLS 正反向测试、撤权后即时隔离、跨平台 GUI 和安装包验收，进一步完善通知频率/网络资源与用户可控的实时订阅设置。
- 后续的本地 Embedding 模型 PoC 仍在同步主线之后，知识库向量默认永不自动上云。
