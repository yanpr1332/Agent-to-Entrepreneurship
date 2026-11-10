# W5-7 五人云端协作：Supabase 候选方案服务端 PoC

> 这是 **Supabase 候选方案验证代码**，不是正式选型或已部署的五人云端工作空间。真实服务端权限必须在独立测试项目中验收，通过后才能正式采用。

## 目标与已写代码

按照 W4-DEC-03，先验证五个不同账号能通过互联网进入一个工作空间，服务端 RLS 阻止无权限成员读取或写入共享信息。

当前 PR 新增：
- `supabase/migrations/20261110_ate_workspace_poc.sql`：Postgres 工作空间、成员、短时邀请码、共享任务、消息的表结构和 RLS 策略；最多 5 位成员。
- `src/shared/cloud-model.ts`：输入校验、公开项目信息边界、任务 DTO。
- `src/main/cloud/supabase-client.ts`：使用 Node 内置 `fetch` 的 GoTrue Auth + PostgREST 客户端，只使用 **publishable / legacy anon key** 和各用户自己的 JWT，拒绝 service_role / sb_secret。
- `src/main/cloud/supabase-client.test.ts`：模拟 HTTPS 授权、项目身份、消息与任务 REST 请求；断言不会把原始错误体传回 Renderer。
- `src/main/cloud/rls-schema.test.ts`：检查迁移文件存在 RLS、成员条件、受限制的 RPC 和明确授权。
- `scripts/rls-smoke-test.mjs`：**手动运行**的真实三账号隔离烟雾测试脚本（不在 CI 自动运行），A 创建工作空间并邀请 B；B 可看到 A 的消息；未加入的 C 不可读写。

此 PR 不接入 Electron 主进程 IPC / React 云端页面；没有真实项目凭据时，不能声称五人已经可以登录聊天。该部分将在验证 RLS/帐号后继续接入。

## 服务端数据模型

| 表 | 主要字段 | 权限 |
|---|---|---|
| `ate_workspaces` | UUID、名称、创建者 | 成员可读；用户不能直接插入 |
| `ate_workspace_members` | 工作空间、用户 UUID、owner/member、显示名 | 成员可见；仅 RPC 增加 |
| `ate_workspace_invites` | 邀请 Token SHA-256、剩余次数、48 小时有效期 | 普通用户不能直接读写；owner 通过 RPC 创建 |
| `ate_workspace_messages` | UUID、作者、消息、时间 | 成员可读；登录且为成员者才能以自身身份发消息 |
| `ate_workspace_tasks` | UUID、标题、到期日期、分配对象、完成状态 | 成员可读；成员可创建与更新，不能冒充任务创建者 |

每个工作空间最多 5 位成员。加入操作使用数据库行锁序列化成员数量检查，避免同时加入超过上限。

采用 `SECURITY DEFINER SET search_path=''` 的成员检测函数避免 RLS 自引用递归；调用者只能通过公开的固定 RPC 访问受控操作。所有共享 REST 请求都携带各自的登录用户 JWT，**绝不在 Electron 中使用 Supabase service_role**。

## 隐私与本地优先边界

- 云端只存放用户明确创建的共享工作空间数据；个人 SQLite 任务、Canvas Token、交大邮箱密码与邮件正文不会自动同步到云端。
- Supabase URL 和 Publishable Key 是项目公共客户端配置，不能把它们与 service_role、数据库密码或用户登录密码混淆。
- 当前客户端的登录凭据和 JWT 仅保存在 Electron Main 进程内存中，不写入磁盘。重新启动需再次登录。
- 客户端只允许 `https://<project>.supabase.co` 标准公开域名；不支持自签名本地域名与跳转，避免将 JWT 传往任意地址。
- API 限制响应体尺寸、设置请求超时，并且不向 UI 透传包含用户资料的原始服务端错误体。
- 账号创建可能要求 Supabase Email Verification；不应为了测试而绕过邮箱验证或共享账号。
- W4 目标的「五位不同账号共享」必须通过真实服务端 RLS 测试，**不可用同一个账号模拟五人**。

## 需要用户授权后才能执行的实际云端步骤

这些步骤会创建**外部服务、测试用户及真实云端数据**。当前未代用户创建项目、开通付费服务、上传凭据或运行远程变更。

1. 用户本人创建或选择一个隔离的 Supabase **测试项目**（不是生产库），确认免费/付费配额和访问政策。
2. 在 Test Project 的 SQL Editor 中审阅并执行仓库的迁移文件。
3. 创建三个独立、可验证邮箱的测试账户 A、B、C（未来再补齐 5 人），准备每个账户自己的密码；不发送给助手。
4. 本地以环境变量提供 `ATE_POC_URL`、`ATE_POC_ANON_KEY` 和 A/B/C 的账号密码；仅在测试设备上主动运行：
   `node scripts/rls-smoke-test.mjs`。
5. 检查 B 能看到 A 的消息、C 无法读写；再使用 5 个不同账号验证邀请码、人数上限和成员权限。
6. 在真实验收通过后，再确认 Supabase 是否成为正式云端方案，并安排 Electron IPC、团队协作界面、实时消息或断线重试。

**重要：** 手动脚本会在测试项目中创建一个工作空间、邀请码与消息；不会自动清理云端测试数据。请只在明确允许创建数据的测试项目执行。仓库 CI **不会**连接 Supabase。

## CI 能证明什么 / 不能证明什么

CI 可以证明：
- TypeScript 类型检查通过、没有引入新 npm 依赖；
- 登录与 REST 调用使用用户 JWT 和公开项目密钥，而非 service_role；
- 共享消息、任务、邀请码和字段有入参校验；
- SQL 文本包含关键 RLS/权限规则；
- 普通构建没有引入云端密钥。

**不能证明**：
- SQL 确实可以在目标 Supabase 项目部署；
- RLS 策略对真实独立用户能够隔离数据；
- 五人消息实时传输、离线冲突、邀请实际成功；
- Supabase 服务可达、邮件确认正常或费用限制可接受。

这些都需要独立的云端联机验收；一旦遇到此阶段，我会明确提出最小验收步骤，不在未经授权情况下操作外部云服务。

## 下一步开发

- 完成测试项目 RLS 验证和所有者批准方案 C；
- 将客户端接入 Electron Main 的窄 IPC、实现团队空间 React UI；
- 提供实时消息（Supabase Realtime 或经审查的轮询方案）、成员在线/离线状态、任务归属；
- 增加审计、私有资料隔离、可靠退出与云端撤销会话机制；
- 实测 Windows 和 macOS 各自独立账号跨互联网共享工作空间。

本 PR 无 RDC、无本机软件安装、无新增 npm 依赖、无真实凭据，也未修改或部署任何外部云资源。
