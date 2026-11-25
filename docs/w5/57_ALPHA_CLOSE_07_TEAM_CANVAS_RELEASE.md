# ALPHA-CLOSE-07：五人成员撤权、Canvas 恢复与安装包独立校验

> 2026-11-25 集中大开发。本批次包含实际代码、Node/Vitest 回归和脱敏验收清单。**自动测试、静态 SQL 预检和 CI 不等于已部署真实 Supabase、已读取真实 Canvas 或已在双平台成功安装。**

## 1. 小组所有者撤销成员

- 新增 `supabase/migrations/20261125_ate_workspace_member_revoke.sql`，必须在隔离非生产 Supabase 项目**人工审查并部署**，且放在工作空间/历史同步迁移之后。
- 服务端 `ate_revoke_workspace_member(p_workspace,p_user)` 只接受当前登录、属于目标工作空间的 **owner**。拒绝撤销 owner 自己或不存在的非 member。锁定邀请码和工作空间以避免并发加入与撤销发生意外冲突，撤销后所有旧邀请码在该空间失效；**以后重新邀请需要 owner 再生成新邀请码**。
- 成员授权通过数据库实时成员关系检查。服务端保留消息和任务的作者记录，但会将该成员的现有任务指派清空，持续化团队历史会记录任务变更；不修改个人本地数据、个人同步和其他空间的权限。
- UI 只在 owner 查看非 owner 成员时出现「撤销成员」，二次确认、走受信 IPC/Main JWT RPC；执行成功刷新成员列表并清空已显示的旧邀请码。
- **权限传播不是立即擦除对方物理磁盘**。旧 JWT 的后续 REST/RPC 读写由 RLS 拒绝，客户端轮询/Realtime 会员复检后应停止显示共享数据并最佳努力清空本地 TEAM 缓存。对方电脑离线时已看过的内容/备份仍可能保留，不能宣称远程擦除。
- 新迁移会重定义 `ate_create_invite`，在颁发新邀请码之前锁定工作空间，以协调并发撤权。此方案须在隔离 PostgreSQL 中执行并发加入与撤权实验；静态代码检查不能证明锁顺序在真实部署中无死锁。

## 2. 五账号 RLS 真实反向测试

已有 `scripts/sync-rls-acceptance.mjs` 需使用五个真实不同 Supabase Auth 账号及**显式** `ATE_POC_CONFIRM_WRITES=CREATE_DISPOSABLE_TEST_WORKSPACE`，只能由用户在独立测试项目授权运行；不在 CI、机器人或生产环境运行。运行前先执行：

```sh
npm run preflight:supabase
node --test scripts/sync-rls-acceptance.node.mjs
```

脚本现在涵盖：五成员加入、owner-only 邀请、外部账号 RLS、作者身份冒充、防非成员任务分配、团队任务读写、owner-only 撤权、撤销 owner 自己的非法请求、**被撤成员持旧 JWT 的读/写/更新阻断**、撤销前未使用邀请码重放被拒、被撤成员的任务改为未分配、其他四成员仍可访问。这会创建和保留测试数据，须管理员事后人工清理并保存脱敏结果。

此外必须手工验证设备联网/离线两种情况下，B 被撤销后 B 的 React UI 清空共享消息、持久化 TEAM 本地缓存不能再展示、SQLite 旧页/WAL/备份并非物理擦除，以及 owner 再发新邀请码/成员数上限的恢复行为。历史分页/Checkpoint 和设备撤销也须真实逐项检查。

## 3. Canvas 用户自行重新授权

- 连接时同时要求 `/api/v1/courses` 与 `/api/v1/users/self` 成功，两个请求均成功才保存加密 Token，不能因只读课程成功但无身份权限而建立错误账号来源。
- 身份或课程请求报告 `401` 时，自动同步保留旧任务，不再每隔 30 分钟使用同一个失效 Token 重试；用户在页面主动点击「使用新的个人 Token 重新授权」，验证新账号身份与课程后替换加密 Token、解除暂停。同步失败原因仅用安全类别提示，不显示远端敏感信息。
- 429 限流停止当前批次后续课程，避免连续请求；普通网络中断与部分课程权限不足保留本地任务并允许后续重试。断开/更换身份对旧请求进行 generation fencing，旧请求不得让新授权再次进入「已失效」状态。
- **学校 Developer Key/OAuth 未获批仍 Blocked**。个人 Token 仅用于拥有该合法账号的开发者本机，不可分享给五人，也不写入 GitHub、测试截图或日志。

## 4. 内部安装包下载后的离线 SHA 核验

保留已有手动 GitHub Actions 的未签名 Windows NSIS/macOS DMG+ZIP 构建流程。在各自电脑下载解压单个平台的 artifact 后，先**独立从 GitHub 提交页面核对 40 位 commit SHA**，再在仓库根目录执行：

```sh
node scripts/verify-downloaded-alpha.mjs "/path/to/unsigned-artifact" win FULL_40_CHARACTER_COMMIT_SHA
# macOS 替换为：mac，并在该目录同时放置 DMG 与 ZIP
```

工具只读检查 `SHA256SUMS.txt` 和 `BUILD_EVIDENCE.json`，要求独立确定的提交 SHA、产品名、OS 平台、未签名属性、每个 EXE/DMG/ZIP 的文件名/大小/sha256 全部一致；拒绝额外安装文件、路径穿越、软/硬链接、重复项、篡改和错误平台。使用 npm 测试里的 Node fixtures 作为回归。

**清单和安装包都来自同一个不可信压缩包，本工具不是数字签名或供应链认证**；如果下载渠道和清单一起被替换，单独 hash 不能检测。应从仓库受信任的 GitHub Actions run 下载并独立核对 commit。测试者还必须亲自完成 Windows/macOS 真实安装→启动→重启→卸载→再次安装，以及 5 SQLite 数据库的独立备份/恢复/quick_check、迁移回滚、GUI 与凭据/Keychain/DPAPI 测试，才能将 Beta/Alpha 安装验收标为通过。

## 5. 一轮集中回归

```sh
npm ci
npm run preflight:supabase
node --test scripts/sync-rls-acceptance.node.mjs scripts/supabase-alpha-preflight.node.mjs scripts/verify-downloaded-alpha.node.mjs
npm run typecheck
npm test
npm run build
```

**未做/阻塞：** 真实隔离 Supabase 五账号及并发 RLS/Realtime、Canvas 有权测试账户、学校 OAuth 审批、SJTU IMAP/SMTP 收发、个人 AI API 真调用、Windows/macOS 内部安装包真实下载及安装。需要用户授权和设备/账户，不能把这些项目标为通过。

**本批次不会自动部署 SQL、使用 service_role、代用户真实撤销成员、触发 SMTP、发送付费模型请求或自动合并 PR。**
