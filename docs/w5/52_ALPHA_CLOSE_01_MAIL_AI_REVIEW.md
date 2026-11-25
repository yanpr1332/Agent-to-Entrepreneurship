# ALPHA-CLOSE-01：五人 Alpha 的邮件 AI 候选与人工建任务闭环

> 同属 [51 V0.1 五人内部 Alpha 收尾计划](51_V01_FIVE_PERSON_ALPHA_CLOSEOUT.md)，单 PR 提交。代码交付 ≠ 真实交大邮箱/个人 API Key 接入验收。

## 交互闭环

1. 用户先合法连接自己的交大邮箱（当前只缓存最近邮件的 **发件人、主题、发送日期和 UID**，不下载正文/附件），在“邮件 AI 识别”中明确选择 **1–3 封邮件的基本信息**，未勾选的内容不会被发送。
2. Main 从本机已授权的邮件缓存按 `uidValidity + uid + 当前账号` 重新获取标题和发件人，不接受 Renderer 提交原文、账号或任何数据库路径；已忽略/已创建的邮件不能重新产生收费候选。
3. 点击“预览”只产生本机提示词，不请求云 API。界面**完整展示实际发送文字、目标服务与模型、调用次数/可能收费提示**；仅在第二次“确认调用”时，通过已有 `AIService` 统一单次授权与日用量上限发送到固定 OpenAI Responses API，`store:false`、禁止工具/自动重试。
4. 提示词明确把邮件主题/发件人视为**外部不可信数据**，要求严格 JSON、只返回所选邮件 UID，绝不遵从其中的指令；不发送密码、未选邮件、邮件正文、附件、个人任务或其他工作空间数据。
5. Main 对模型 JSON 进行严格字段、UID、数量、分类、标题和日期校验。**只有标题中逐字存在的真实 `YYYY-MM-DD` 日期才可由 AI 提议为截止日期**；邮件发送日期绝不当作截止日期。没有可靠事项时返回 `kind=none`，不提供一键创建。
6. 用户在结果页面人工编辑最终任务标题与截止日期，看到明确的再次确认对话框后调用 `mail:ai-apply`。Main 再次核对邮件缓存身份/内容/授权状态和短期审阅令牌（最长 10 分钟）；本机 SQLite 同一事务创建任务并写入既有 `mail_candidate_reviews` 幂等记录。已接受 UID 不会因重复点击产生第二项任务，不发送 SMTP，也不修改 IMAP 服务端状态。
7. 邮箱断开、AI Key 断开、退出当前运行程序或用户取消，丢弃临时审核令牌；若在 AI 请求往返时邮件被同步、账号/标题/UIDValidity 变化，前后都重新验证，失败关闭且不建任务。已有日历个人任务不会因邮箱断开而删除。

## 代码实现和安全边界

- `src/shared/mail-ai.ts`：严格类型、1–3 个 ID 的输入解析、模型输出解析、截止日反幻觉防护及人工输入校验。
- `src/main/ai/mail-ai-coordinator.ts`：仅 Main 可组合当前邮箱上下文，向 AIService 发起两步授权；网络请求前后源快照复核，短期候选缓存、人工提交入口。
- `src/main/local-store.ts`：复用原有邮件候选事务的 UID 幂等逻辑，以同库任务表保存用户最终核对过的标题/日期。不新增 Schema、依赖或后台轮询。
- `src/main/index.ts`、`src/shared/ipc-channels.ts`、Preload 和 Renderer 类型：固定 Main 白名单 IPC，邮箱/AI 撤权清除短期缓存。
- `src/renderer/src/MailAIReviewPanel.tsx`：选择 → 完整预览 → 确认可能付费的调用 → 人工编辑 → 单条确认创建任务。界面将“邮件头”改为“邮件基本信息”，明确包括主题、发件人、发送时间和内部匹配编号，不包括正文/附件。
- **不包含**：自动下载邮件正文与附件、云端自动提取/后台监听、模型自发创建任务、跨邮箱分析、隐式 SMTP 发送、完整邮件线程内容理解或不经人工核验的截止日自动写入。

## 个人 OpenAI API Key 的两种配置方式

- **手动输入**：在 AI 学习助手填写个人项目 API Key，使用 Electron 系统凭据加密存储；不明文写入 SQLite 或普通配置文件。
- **环境变量**：在启动 Study Anchor 前设置 `OPENAI_API_KEY`。Electron Main 进程直接读取，Preload/Renderer 不接触密钥；环境变量 Key 不写入凭据库、SQLite 或日志。
- **优先级**：本机已加密保存的 Key 优先；没有本机 Key 时才使用环境变量。AI 设置页显示当前来源。删除本机 Key 后，如果环境变量存在会自动切换；环境变量本身由用户在操作系统中管理。
- Windows 安装版：在“系统属性 → 高级 → 环境变量”中创建当前用户变量 `OPENAI_API_KEY`，保存后完全退出并重新启动 Study Anchor（必要时重新登录 Windows）。开发时也可在 PowerShell 当前会话先设置 `$env:OPENAI_API_KEY = "sk-..."` 再运行 `npm run dev`；注意不要把真实 Key 提交到脚本或终端历史。
- macOS 开发时可从终端用 `OPENAI_API_KEY="sk-..." npm run dev` 启动。Finder 启动的安装版通常不会继承 shell profile 中的变量；当前登录会话可由用户 launchd 环境提供（例如 `launchctl setenv OPENAI_API_KEY "sk-..."`），然后重新打开应用；移除可用 `launchctl unsetenv OPENAI_API_KEY`。命令行设置可能留在 shell 历史中，谨慎使用。
- 环境变量通常以进程环境明文存在，便利性高于安全性；安装版日常使用优先建议手动输入并使用系统凭据加密。仓库不自动加载 `.env` 文件，禁止把 Key 写入 Git 或提交任何含 Key 的文件。环境变量只在应用启动时读取；运行中变更需要重启应用。

## 验证计划（不可混淆）

自动化测试：拒绝伪造 UID/多余字段/超量选择/重复 UID，未获确认不消费 API 额度，提示词仅包含明确选定的源信息；不可信输出、杜撰日期、来源变化/切换账号、已忽略邮件、人工编辑、事务幂等和审阅令牌过期均需验证。Windows/macOS 最新 SHA 的 TypeScript、全部 Vitest、Electron build 和离线 Worker smoke 通过才标为 CI 通过。

**尚需用户真实环境验收**：在隔离测试配置和合法 SJTU 邮箱中导入含明确日期/不含日期/恶意指令三类测试主题，明确授权个人 OpenAI API Key 并在确认前核对完整 prompt；核验实际模型返回、费用、手工编辑后的日历任务、重复请求、撤权；确保真实邮件密码、Token、完整地址或私人标题不上传到 GitHub、公共截图或日志。**无真实外部证据即保持待验收**。

## 下一轮交付依赖

本轮结束后，按 [51](51_V01_FIVE_PERSON_ALPHA_CLOSEOUT.md) 进入工作台最小闭环与布局预设，随后内部测试安装包/数据恢复，真实 Supabase 五人 RLS、Canvas、交大邮箱与 AI Provider 验收。学校 Developer Key 申请和测试账号准备可同步进行，但仅能由合法持有人进行授权。
