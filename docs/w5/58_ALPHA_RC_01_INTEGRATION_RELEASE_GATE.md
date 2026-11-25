# ALPHA-RC-01：V0.1 发布候选集中集成与验收门禁

> 2026-11-25 开发批次。此文是**代码级自动化 + 手工验收操作说明**，不是发布验收已通过的声明。所有测试账号、课程、邮件和用户文件仅由授权人员操作。任何 CI 双绿、Mock 五账号、模拟系统加密或离线数据库回归都不能替代真实安装、RLS、外部 API、真人设备验收。

## 一次性代码回归：无需账号或密钥

在**刚合并且经独立审查的 commit** 上运行（Node 24.18.x，npm 11.x）：

```sh
npm ci
npm run alpha:rehearsal
npm run preflight:supabase
npm run test:sync-rls
npm run build
```

`alpha:rehearsal` 是本轮新增的跨模块真实 SQLite 集成回归（`src/main/alpha-release-rehearsal.test.ts`），它执行而不是伪造下列路径：

- 合成个人任务及日历课程、Canvas API 模拟双次同步（来源唯一、重复不生成任务），同一实体进入任务和固定日历 store。
- 合成 IMAP 邮件头经人工接受后写入个人任务（重复接收不产生第二条任务）；**不连接真实邮箱、不读取真实正文或发 SMTP**。
- 本地知识文档导入/FTS、基于确切片段建立复习卡、人工评分和下次日期；专注会话与积分兑换；规划器参照日历冲突生成并人工应用时间块；工作台使用真实任务/日历 store selectors。
- AI 测试通过**假的固定返回 Provider**验证「先预览无调用、确认后恰好一次请求」；本机密钥适配器也只是测试替身，不能当作真实 Keychain/DPAPI。
- 合成 TEAM 增量历史保存在独立本地加密 store，**不进入五库备份**，不访问 Supabase 或执行 SQL。
- 对五个真实 SQLite 库执行 WAL-safe 在线备份 → manifest SHA256、user_version 和 SQLite quick_check → 在一个不存在的临时新目录隔离恢复 → 实际重新打开五库验证数据和人工操作状态。快照后新写的条目不得出现在恢复副本；AI Key/用量、邮件草稿、团队历史不得进入恢复副本；原运行配置不得被覆盖。
- 整个脚本只在操作系统临时目录使用合成数据。不能替代 Electron GUI、真实 OS 加密、安装包、网络中断或真实服务联机测试。

## 二次检查：Alpha 的 20 条真实验收证据（默认 BLOCKED）

`scripts/alpha-readiness.mjs` 实现独立于 CI 的严格**人工证据完整性门禁**；不会联网，也不会自己执行测试、填「通过」，更不证明证据为真。仅供团队本地记录，**不要把含私人证据的 JSON、真实账号/Token 或未脱敏截图提交到 GitHub**。

从 GitHub 对应提交页面获得**完整 40 位 commit SHA**，在仓库根目录创建尚不存在的本地文件：

```sh
npm run alpha:evidence:init -- alpha-evidence/v01-internal.json FULL_40_CHAR_GIT_SHA
```

文件默认 20 条 `ALPHA-01` 至 `ALPHA-20` 全部为 `blocked`，Windows/macOS CI run ID 和 Blocker/Critical 计数为空。用户和验收人员亲自核验以后，只允许按 **原 case mode** 将单条改为：

```json
{
  "status": "pass",
  "mode": "windows-install",
  "reviewer": "R01",
  "observedAt": "2026-11-25T12:00:00.000Z",
  "evidenceSha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

上面是字段格式示例，**不是可用的真实验收证据**。证据哈希必须来自验收人员自行持有的、已脱敏文件；`reviewer` 为团队内部匿名代号，不输入名字、邮箱、IP、路径、密码或受限资料。验收中有缺陷/待审批则维持 `blocked`/`fail` 和简短无敏感信息的 `reason`；不允许用 Mock 替换真实 `canvas-live`、`imap-live`、`smtp-live`、`team-five-live`、`team-rls-live`、`ai-provider-live` 证据。

其中：
- `ci.windowsRunId`、`ci.macosRunId`：从当前 Git SHA 的 **真实 GitHub Actions** 记录抄录同一次 run 中的 Windows/macOS 已通过 job ID/Run ID（数字）；程序只检查格式，人工须独立核对该 run 的 SHA 与两个 job 均为 success。
- `issues.blocker` 和 `issues.critical`：由维护者核查当前未关闭缺陷后填写非负整数；不允许为追求通过而填假 0。
- `cases`：全部 20 个 ID 必须存在；通过项包含严格模式、审查代号、UTC 时间及 64 位证据哈希。阻塞项必须有不含外链和个人信息的简短原因。

全部核对之后运行：

```sh
npm run alpha:evidence:check -- alpha-evidence/v01-internal.json FULL_40_CHAR_GIT_SHA
```

**只要有一条 blocked/fail、CI 未填、Blocker/Critical 不为 0 或证据格式不完整，就退出非零。** 全部 20 条完整时只输出 `Inventory complete; independent human verification ... still required`，表示可以交由独立验收人复查，而非程序证明已达标。清单本身容易人为造假，必须由独立 Reviewer 查对实际证据；不能以这一脚本的退出码代替发布批准。

`alpha-evidence/` 与 `*.alpha-evidence.json` 加入了 Git 忽略规则；从无敏感信息的临时证据中计算 SHA256，证据原文由获授权的组织私下保管，不发给模型或 CI。

## 最后一次真实验收顺序（不由机器人执行）

1. 主线发布候选 SHA 对应 Windows/macOS 最新 CI 完整成功（TypeScript、Vitest、Electron bundle、离线 Worker）。触发仓库**手动**的 `Build internal Alpha installers (manual, unsigned)`，下载两平台 artifact。每台电脑下载后运行 `node scripts/verify-downloaded-alpha.mjs <artifact-folder> win|mac <FULL_SHA>`，仍不能视作代码签名。
2. 先做 Windows/macOS 真机安装、首次启动、八模块基本导航、正常退出及重启；在每个 OS 上保留脱敏系统版本、芯片/架构和操作步骤。没有签名/公证，不要关闭整个系统安全保护。
3. 新建纯合成个人任务、知识、复习、专注奖励、固定课、邮件草稿与规划，并检查工作台；创建五库备份，然后在**独立新 userData 目录**恢复和重启。原 profile 保留，关键机密必须不被复制；真实操作系统 Keychain/DPAPI 必须独立测试。
4. 在自己合法授权的 Canvas 账号读取课程、作业；断线/401/429、重新授权、改课程屏蔽并重启。多人 OAuth 的 Developer Key 未批准则仍为外部 Blocked，不允许共享 Personal Token。
5. 使用合法交大测试邮箱逐封授权查看 IMAP 正文、保存和重启恢复 OS 加密草稿，经两次人工确认只发送单封测试邮件，并检查服务端投递；网络不确定时绝不自动重试。不得用模拟 SMTP 标记真实发送通过。
6. 通过有权管理的独立**非生产** Supabase 实例部署经人审查的完整 SQL（见 [55](55_ALPHA_CLOSE_04_SUPABASE_PREFLIGHT.md)、[57](57_ALPHA_CLOSE_07_TEAM_CANVAS_RELEASE.md)），用五个独立账号检查 RLS、成员撤权后旧 JWT、旧邀请码、工作流与历史/断网重连；不得把 service_role 带进桌面端。
7. 仅用自己合法自选的 AI Provider Key 进行有限的真实调用：人工预览外发内容、人工确认可能计费、人工审核卡片/任务候选再入库；核对提供商计费。不连接亦应保留离线可用。
8. 清点 Blocker/Critical 并独立 Review 所有 20 条证据，测试通过与缺席/阻塞逐项登记。**未真正验收的项目不能标「通过」或宣布 Alpha Ready。**

## 冻结与后续

- 本批次代码 PR 可以依据双平台 CI/独立审查合并，但**V0.1 Alpha Ready 仍需全部真实条件成立**。代码 ready 与外部验收/发布 ready 是两个状态。
- 其他不在内测首版最小闭环的增强（完整 OAuth 审批、全部第三方生态、系统级强制应用封锁、官方神经权重分发）不被偷偷标为完成；正式 P0 仍留在 Backlog。
- 如果无法提供合法账号、专用测试项目或真机，本版本保持 **Code Candidate / Live Acceptance Blocked**。缺陷出现后只针对 Blocker/Critical 做一次集成修复，并保留完整证据/回滚路径。
