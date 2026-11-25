# ALPHA-CLOSE-01：五人 Alpha 的邮件 AI 候选与人工建任务闭环

> 同属 [51 V0.1 五人内部 Alpha 收尾计划](51_V01_FIVE_PERSON_ALPHA_CLOSEOUT.md)，单 PR 提交。代码交付 ≠ 真实交大邮箱/个人 API Key 接入验收。

## 交互闭环

1. 用户先合法连接自己的交大邮箱（当前只缓存最近邮件的 **发件人、主题、发送日期和 UID**，不下载正文/附件），在“邮件 AI 识别”中明确选择 **1–3 封邮件的基本信息**，未勾选的内容不会被发送。
2. Main 从本机已授权的邮件缓存按 `uidValidity + uid + 当前账号` 重新获取标题和发件人，不接受 Renderer 提交原文、账号或任何数据库路径；已忽略/已创建的邮件不能重新产生收费候选。
3. 默认“预览”只利用本机缓存的基本信息。用户额外勾选“本次包含正文”并确认具体邮件标题后，Main 才逐封使用只读 IMAP `UID FETCH BODY.PEEK` 获取最多 64 KiB 原始 MIME 片段，**只提取纯文本正文并截取前 1100 字符进入提示词**。HTML/附件数据不会进入模型提示词，也不会写入本机邮件数据库；IMAP 读取的原始 MIME 片段可能包含 HTML/附件字节，不能等同于“绝不下载附件字节”。正文不自动同步、不做后台读取。完整外发提示词预览会显示所选正文；用户再次确认后，才调用当前选择的 AI 服务商，并可能产生费用。
4. 提示词明确把邮件主题/发件人及用户授权读取的正文视为**外部不可信数据**，要求严格 JSON、只返回所选邮件 UID，不执行内容指令；绝不发送密码、未选邮件、附件、HTML、个人任务或其他工作空间数据。默认未授权时不会获取或发送正文。
5. Main 对模型 JSON 进行严格字段、UID、数量、分类、标题和日期校验。**只有标题或本次授权正文中逐字存在的真实 `YYYY-MM-DD` 日期才可由 AI 提议为截止日期**；邮件发送日期绝不当作截止日期。没有可靠事项时返回 `kind=none`，不提供一键创建。
6. 用户在结果页面人工编辑最终任务标题与截止日期，看到明确的再次确认对话框后调用 `mail:ai-apply`。Main 再次核对邮件缓存身份/内容/授权状态和短期审阅令牌（最长 10 分钟）；本机 SQLite 同一事务创建任务并写入既有 `mail_candidate_reviews` 幂等记录。已接受 UID 不会因重复点击产生第二项任务，不发送 SMTP，也不修改 IMAP 服务端状态。
7. 邮箱断开、AI Key 断开、退出当前运行程序或用户取消，丢弃临时审核令牌；若在 AI 请求往返时邮件被同步、账号/标题/UIDValidity 变化，前后都重新验证，失败关闭且不建任务。已有日历个人任务不会因邮箱断开而删除。

## 代码实现和安全边界

- `src/shared/mail-ai.ts`：严格类型、1–3 个 ID 的输入解析、模型输出解析、截止日反幻觉防护及人工输入校验。
- `src/main/ai/mail-ai-coordinator.ts`：仅 Main 可组合当前邮箱上下文，向 AIService 发起两步授权；网络请求前后源快照复核，短期候选缓存、人工提交入口。
- `src/main/local-store.ts`：复用原有邮件候选事务的 UID 幂等逻辑，以同库任务表保存用户最终核对过的标题/日期。不新增 Schema、依赖或后台轮询。
- `src/main/index.ts`、`src/shared/ipc-channels.ts`、Preload 和 Renderer 类型：固定 Main 白名单 IPC，邮箱/AI 撤权清除短期缓存。
- `src/renderer/src/MailAIReviewPanel.tsx`：默认只选邮件基本信息；若用户逐次授权，按需只读获取所选邮件纯文本正文（限长），**全部外发信息先预览** → 确认可能付费的调用 → 人工编辑 → 单条确认创建任务。不允许自动读取正文、自动发信或读附件作为模型输入。
- **不包含**：后台自动下载邮件正文、读取附件用于模型输入、HTML 转正文或复杂附件分析、云端自动提取/后台监听、模型自发创建任务、跨邮箱分析、隐式 SMTP 发送、完整邮件线程理解或不经人工核验的截止日写入。

## 多服务商个人 API Key 的两种配置方式

- **手动输入**：AI 页面选择 OpenAI、Anthropic、Google Gemini、DeepSeek 或“其他 OpenAI-compatible 服务商”，填写各自的模型 ID、个人 API Key；兼容服务还需填写可信公网 HTTPS `/chat/completions` 完整地址。配置通过 Electron 系统凭据加密存储，不明文写入 SQLite。不同服务商使用不同协议和计费/隐私政策，不能保证任何随意提供的 Key 都能调用。
- **环境变量**：支持 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`、`DEEPSEEK_API_KEY`。若设多个，默认优先 OpenAI → Anthropic → Gemini → DeepSeek；用 `STUDY_ANCHOR_AI_PROVIDER` 可显式指定。其他兼容接口使用 `STUDY_ANCHOR_AI_PROVIDER=compatible`、`STUDY_ANCHOR_AI_ENDPOINT`、`STUDY_ANCHOR_AI_MODEL`、`STUDY_ANCHOR_AI_API_KEY`。Electron Main 独占密钥，Renderer 只看到服务商/模型/来源标识。
- **优先级**：已加密保存的用户配置优先；不存在时从环境变量决定服务商，模型可用 `STUDY_ANCHOR_AI_MODEL` 覆盖。删除本机配置后会回退环境变量。预览含当前模型与目标服务商，修改或删除 Key 会使尚未付费的预览令牌失效。
- Windows 安装版：在“系统属性 → 高级 → 环境变量”中创建当前用户变量 `OPENAI_API_KEY`，保存后完全退出并重新启动 Study Anchor（必要时重新登录 Windows）。开发时也可在 PowerShell 当前会话先设置 `$env:OPENAI_API_KEY = "sk-..."` 再运行 `npm run dev`；注意不要把真实 Key 提交到脚本或终端历史。
- macOS 开发时可从终端用 `OPENAI_API_KEY="sk-..." npm run dev` 启动。Finder 启动的安装版通常不会继承 shell profile 中的变量；当前登录会话可由用户 launchd 环境提供（例如 `launchctl setenv OPENAI_API_KEY "sk-..."`），然后重新打开应用；移除可用 `launchctl unsetenv OPENAI_API_KEY`。命令行设置可能留在 shell 历史中，谨慎使用。
- 环境变量通常以进程环境明文存在，便利性高于安全性；安装版日常使用优先建议手动输入并使用系统凭据加密。仓库不自动加载 `.env` 文件，禁止把 Key 写入 Git 或提交任何含 Key 的文件。环境变量只在应用启动时读取；运行中变更需要重启应用。

## 验证计划（不可混淆）

自动化测试：拒绝伪造 UID/多余字段/超量选择/重复 UID，未获确认不消费 API 额度，提示词仅包含明确选定的源信息；不可信输出、杜撰日期、来源变化/切换账号、已忽略邮件、人工编辑、事务幂等和审阅令牌过期均需验证。Windows/macOS 最新 SHA 的 TypeScript、全部 Vitest、Electron build 和离线 Worker smoke 通过才标为 CI 通过。

**尚需用户真实环境验收**：在隔离测试配置和合法 SJTU 邮箱中导入含明确日期/不含日期/恶意指令三类测试邮件，逐次授权只读正文并验证限长/附件过滤，分别授权合规的 OpenAI / Anthropic / Gemini / DeepSeek 或兼容供应商自己的 API Key，并在确认前核对完整 prompt；核验实际模型返回、费用、手工编辑后的日历任务、重复请求、撤权；确保真实邮件密码、Token、完整地址或私人标题不上传到 GitHub、公共截图或日志。**无真实外部证据即保持待验收**。

## 下一轮交付依赖

本轮结束后，按 [51](51_V01_FIVE_PERSON_ALPHA_CLOSEOUT.md) 进入工作台最小闭环与布局预设，随后内部测试安装包/数据恢复，真实 Supabase 五人 RLS、Canvas、交大邮箱与 AI Provider 验收。学校 Developer Key 申请和测试账号准备可同步进行，但仅能由合法持有人进行授权。
