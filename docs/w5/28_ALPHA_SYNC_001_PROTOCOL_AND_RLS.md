# ALPHA-SYNC-001：个人数据同步协议基线与五账号 RLS 验收（开发记录）

> **SYNC-001 状态（已合并）**：离线协议解析、来源白名单投影、五账号真实验收脚本与模拟测试已合并；真实 Supabase 项目部署/五账号 RLS 仍待授权。SYNC-002A 另行实现本机 Outbox，详见 [29](29_ALPHA_SYNC_002A_LOCAL_OUTBOX.md)。本文件记录的五账号脚本仍不会由 CI 自动联网执行。

## 1. 当前数据库和数据权威边界

| 库/实体 | 数据来源及权威 | SYNC-002 初版范围 | 原因 |
| --- | --- | --- | --- |
| `ate-local.sqlite` / `tasks`（`source=null`） | 用户个人任务，部分可能经邮件候选人工创建 | **候选：用户显式开启后才可投影** | 标题/描述可能包含敏感内容；未来还需要区分来自邮件的候选及逐实体授权 |
| `ate-local.sqlite` / Canvas 作业映射 | Canvas 控制作业事实，用户拥有本机完成/隐藏/截止日覆盖 | **不自动同步原始来源** | `instance_origin/account_id/course_id/assignment_id` 与个人覆盖不得混写 |
| `ate-local.sqlite` / 专注会话、积分、邮件候选审阅 | 本机个人执行数据和衍生记录 | **不纳入** | 需独立隐私与跨设备幂等规则 |
| `ate-fixed-calendar.sqlite` / `fixed_events` (`source=manual`) | 用户手动创建的课程/事件 | **候选：用户显式开启后才可投影** | 需保留 seriesId 与单次/区间编辑的原子语义 |
| `ate-fixed-calendar.sqlite` / `source=ics`、`canvas_calendar_events` | ICS 进口文件 / Canvas 来源事实与本机隐藏覆盖 | **不纳入** | 外部来源和用户编辑权限不同 |
| `ate-plans.sqlite` / 时间块、确认状态 | 本机学习规划及手动执行安排 | **不纳入** | 跨设备课程时间改变不能静默覆盖已确认规划块 |
| `ate-knowledge.sqlite` / 原文、PDF 文本、节点、关系、复习 | 用户明确导入的本机资料 | **不纳入** | 原文件、衍生内容和未来向量索引需分立权限 |
| `ate-ai-usage.sqlite` / 使用额度、审核与日志 | 本机服务预算与历史 | **不纳入** | 不得将本机用量视为远端账单或上传私人提示 |
| `ate-mail.sqlite` / 读取缓存及草稿 | 邮箱服务器来源、私人草稿 | **不纳入** | SMTP 发信与普通自动同步完全隔离 |
| Supabase `ate_workspace_*` 表 | 经认证的云端团队空间 | 属于 SYNC-003，**与个人同步分离** | 目前仅 PoC + 约 10 秒轮询；五账号 RLS 尚需真实验收 |

严格约束：**数据本地优先**。SYNC-001 的 `projectPersonalTask(task, explicitlyEnabled)` 和 `projectManualCalendarEvent(event, explicitlyEnabled)` 只生成白名单快照，不执行网络请求。SYNC-002A 已在 local v6 增加 `task_origin`：历史 accepted 邮件任务被分类为 `mail_candidate`，Canvas 任务分类为 `canvas`，其余旧任务为 `legacy`；只有用户显式选择的 manual/legacy 个人任务和手动日历事件才可进入本机 Outbox。没有任何历史任务会因迁移自动上传。暂停同步、删除远端副本、停止外部来源抓取与删除本机原件是不同操作。

## 2. 新增的个人同步协议边界（未接入网络）

代码：`src/shared/personal-sync-contract.ts` 和对应 Vitest。

- 只准 `personal-task` 与 `manual-calendar-event`；只准 `upsert` 与 `delete`。完整快照采用字段白名单，未知来源、文件路径、Token、Canvas 原始内容、邮件正文、知识资料等不得混入。
- 操作头强制 `operationId`、`deviceId`、`actorId`、`ownerId`、`entityId`、`baseVersion`、`clientTimestamp`。本机输入解析会检查 UUID、owner/actor 一致、UTC 时间、非负整数版本，但**服务端仍必须独立从用户 JWT 验证 actor/owner；客户端字段不构成权限依据**。
- 删除操作要求明确已知版本和空 payload；新建可用 null 版本。时间戳仅作诊断，不能用于覆盖服务端版本冲突。服务器需返回 `accepted / duplicate / conflict / rejected / retryable_failure`、版本及游标；成功/幂等确认必须有版本和游标。
- 本轮**没有** `outbox` 实体、`serverCursor` 持久化、墓碑、增量服务端表、双端冲突 UI 或迁移；以上都属于 SYNC-002。下一轮须明确多实体事务、重复操作响应丢失、冲突保留、断网队列、删除后的恢复与数据库备份/回滚。

## 3. Supabase 隔离测试项目准备步骤

1. 由使用者**亲自决定并授权**新建/选择 **非生产** Supabase 项目，检查配额和地域；不要把生产项目当一次性测试库。准备并验证五个互不相同的邮箱账号 **A、B、C、D、E**（各自设置安全密码）。不要共享同一个账号或复制他人的会话。
2. 审阅并在这个隔离项目的 SQL Editor 中部署 `supabase/migrations/20261110_ate_workspace_poc.sql`。脚本执行前要核对是否存在冲突表、确认执行范围；不要把它运行到生产实例。现有迁移是团队 PoC Schema，**不包含个人任务/日历跨设备云端表**。
3. 在自己控制的测试设备上，将以下变量以本机进程环境变量方式设置（**不要粘贴实际值到聊天、Shell 历史、日志、PR 或 GitHub Actions Secrets**）：
   - `ATE_POC_URL`：仅 `https://<project>.supabase.co/`
   - `ATE_POC_ANON_KEY`：`sb_publishable_...` 或合法旧版 `anon` JWT，**绝不能是 service_role / sb_secret**
   - `ATE_POC_A_EMAIL` ～ `ATE_POC_E_EMAIL`
   - `ATE_POC_A_PASSWORD` ～ `ATE_POC_E_PASSWORD`
   - `ATE_POC_CONFIRM_WRITES=CREATE_DISPOSABLE_TEST_WORKSPACE`：确认脚本确实会创建一个测试工作空间、邀请码、消息和任务；**不会自动清理**
4. 只在得到测试项目管理者授权后，在仓库根目录手动执行：
   
   ```sh
   node scripts/sync-rls-acceptance.mjs
   ```

   该命令**不会被 npm test 或 GitHub CI 自动调用**。失败时返回非零退出码、打印固定测试阶段与 HTTP 状态，不打印原始远端错误体、JWT、邮箱和密码。网络中断不自动重试写入；可能已留下部分测试记录。成功后人工通过测试项目管理界面删除测试 Workspace/消息/任务；不要在真实个人数据环境操作。

## 4. 已覆盖与待验收分层

| 验证项 | 离线自动测试 | 真实联机证据 |
| --- | --- | --- |
| 同步 payload 白名单/模型隔离、无授权默认不可投影 | `src/shared/personal-sync-contract.test.ts` | 无上传功能，不适用 |
| 运行前显式确认、拒绝 secret key、非法 URL、账号重复邮箱 | Node 内置测试 | 未执行 |
| A 创建空间、B/D/E 加入，C 在加入前不能读取空间/成员/任务/消息 | 模拟 RLS 正/反例 | **待真实五账号** |
| C 不可写任务/消息，B 不可伪造 A 的作者身份或创建邀请，不能分配给非成员 | 模拟 RLS 正/反例 | **待真实五账号** |
| A 创建任务，B 更新；C 最后加入成为第 5 人且能读取共享任务 | 模拟 RLS 正例 | **待真实五账号** |
| 成员撤权、5 人以上并发加入、Realtime、跨设备离线增量、持久 Outbox | **本轮未实现** | **未验证** |
| Windows/macOS Typecheck + Vitest + Node mock + Electron build | 由 PR 最新 CI 检查给出 | 真实 GUI 仍需用户集中验收 |

**自动验证命令**（Node 24、npm 11，安装依赖后）：

```sh
npm run typecheck
npm run test:sync-rls
npm test
npm run build
```

`npm test` 已包括 `vitest run` 和 **完全离线的 Node mock**；不会调用 Supabase。该测试不依赖真实账号或秘密，不覆盖任何本地 SQLite 数据。

### CI 稳定性修正（PR #34 后续提交）

PR 检查日志中，Windows runner 的 Vitest 同时启动了 52 个 worker；两个**既有** SQLite 迁移备份测试各自超过默认 5 秒超时（约 5.2–5.6 秒），随后在超时清理时出现临时目录 `EPERM`。同一提交的另一次 Windows Push 检查中，这两个测试分别在约 0.8–0.9 秒完成并通过，支持这是并发/runner 负载下的非确定性超时，而不是稳定复现的数据迁移失败。

因此 PR 内增加 `vitest.config.ts` 将并发 worker 限制为 4，并只将这两个包含 SQLite 在线备份的迁移用例超时提高到 15 秒；其他测试仍保留默认超时。CI 的独立 Type-check 和 Test 步骤已经完成验证，构建步骤改为直接调用 `electron-vite build`，避免原有 `npm run build` 再重复执行整套测试。最终仍以这次修正后的 Windows/macOS Checks 为准。

## 5. 下一轮 SYNC-002 的必须先解决事项

- 在既有 `tasks` 与 `fixed_events` 本机事务里追加 **同事务 Outbox**，仅对明确启用的个人范围创建操作；确定同步生命周期、设备 ID 与账号绑定/切换处理；迁移前做 SQLite 安全快照并可回滚。
- 确定个人任务的**邮件候选来源**和外部来源排除规则，防止初次启用同步时无意上传私人邮件衍生内容。
- 设计个人远端表的 RLS/版本游标/操作幂等、防重复与用户可见冲突副本，并通过隔离测试项目与断网回放验证。当前团队表不得挪用做私人数据存储。
- 对手动重复课程的批量修改（全系列/未来/指定区间）保持一个用户操作的原子语义；同步其他设备时不能无确认地破坏已确认学习规划时间块。
- 先完成此轮 PR 的 CI 和审阅；**一次只维护一个开发 PR**。SYNC-001 不等于 SYNC-002 已交付。

相关规划：[27 同步优先实施顺序](27_ALPHA_SYNC_FIRST_IMPLEMENTATION_PLAN.md)、[W3 同步与协作](../architecture/09_SYNC_AND_COLLABORATION.md)、[06 Supabase PoC](06_CLOUD_WORKSPACE_POC.md)。
