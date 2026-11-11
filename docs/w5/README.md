# W5 工程启动与桌面基础框架

状态：进行中。W5-0 工程基线与 W5-1 Electron 桌面骨架已完成，并在此基础上推进了 15 个垂直切片；
逐项验证结果、环境差异与未验证项见 [验收矩阵](00_ACCEPTANCE_MATRIX.md)。

## W5-0 工程决策

- 桌面容器：Electron；UI：React + TypeScript。
- 构建：electron-vite + Vite；包管理：npm，提交 package-lock.json。
- Node.js：24.18.0；npm：11.x。
- Windows 为首个本机验证环境；新增 GitHub Actions Windows/macOS 矩阵验证，二者均需实际通过后才算双平台构建基础验收。
- Rust 不作为首版依赖；只有明确的系统级或性能瓶颈才通过 ADR 引入。
- W5-1 不提前初始化 SQLite、云 SDK 或 AI SDK；先稳定 IPC、进程隔离和 UI 工程结构。
- 不要求开发者全局安装项目依赖；依赖只通过仓库锁文件在项目本地或隔离 CI runner 安装。任何对团队成员本机的安装都由本人明确执行。

## 版本策略

依赖版本由 package.json 与 package-lock.json 锁定；Node 主版本固定为 24.18.0。升级 Electron/Vite/React/TypeScript 必须单独评估兼容性和安全影响，不接受 Agent 自动主版本升级。

## 工程结构

- src/main：Electron 主进程、窗口生命周期和 IPC handler。
- src/preload：白名单 contextBridge API。
- src/renderer：React 页面与样式。
- src/shared：跨进程共享契约与可独立测试的安全辅助函数。
- docs/w5：工程启动、开发和验收说明。
- .github/workflows/desktop-ci.yml：Windows/macOS 基础 CI。

## Electron 安全基线

- contextIsolation=true；nodeIntegration=false；sandbox=true；webSecurity=true。
- 不向 Renderer 暴露任意 IPC channel、Node API、文件系统或 shell。
- 主进程只注册显式 allowlist IPC，并检查 IPC sender URL。
- IPC sender 和导航检查必须匹配可信 Renderer 入口：开发环境匹配已配置的 Vite origin 与入口路径；生产环境匹配打包后的精确 index.html URL，不得只检查 file: 协议或文件名后缀。
- 拒绝 Renderer 新窗口请求；阻止导航到非本地可信页面。
- Renderer 不加载远端脚本；CSP 限制脚本、样式、图片和连接来源。
- 凭据、SQLite、文件系统能力不在本任务暴露。

## 本地开发（由开发者自行决定是否执行）

需要 Node.js 24.18.x 和 npm 11.x：

    npm ci
    npm run dev
    npm run typecheck
    npm test
    npm run build

上述命令中的 npm ci 会在当前项目目录安装 package-lock.json 中锁定的依赖；未经设备所有者同意，不得代替其在个人设备上执行。GitHub Actions 使用隔离 runner 运行同一组检查。

Windows 安装包：npm run dist:win。macOS 安装包必须在 macOS 主机/CI 运行 npm run dist:mac；基础 CI 的 bundle build 不等于完成签名、公证或安装包验收。

## 当前已知边界

- 个人任务与专注、知识库、固定日历、学习规划、AI 用量、邮件缓存分别落在 **6 个独立 SQLite 库**（`ate-local` / `ate-knowledge` / `ate-fixed-calendar` / `ate-plans` / `ate-ai-usage` / `ate-mail`，均启用 WAL 与 user_version 迁移）；Canvas、邮箱、AI 凭据与云端会话各自隔离。
- 已暴露约 90 个显式 allowlist IPC 通道，覆盖任务、日历、知识、规划、AI、Canvas、邮件与云端；Renderer 仍无 Node、文件系统或 shell 能力。
- 当前窗口关闭遵循平台默认退出行为；托盘驻留、后台资源控制和紧急退出属于 W5-6，尚未实现。
- Canvas 仅支持开发者本人的 Personal Token；OAuth 多用户方案依赖学校 Developer Key，尚未申请或获批。
- 云端协作只有 PoC 代码，未在真实 Supabase 项目部署，也未做 RLS 隔离的正反向验收；消息为 10 秒轮询。
- 尚未实现：统一日志与脱敏、E2E 测试、备份恢复 UI、安装包签名与公证、专注程序限制。
- 本地运行成功不等于 macOS 安装包、签名或团队云端验收通过。
- 受管控的 Windows 主机可能无法创建 Chromium 沙箱子进程，需用 `npm run dev:compat`，详见 [本地运行排障](16_LOCAL_RUNTIME_TROUBLESHOOTING.md)。

## 验收证据

- 2026-11-11 本机复现：`typecheck` 通过；43 个测试文件 / 190 个用例全部通过；`electron-vite build` 产出 out/main、out/preload、out/renderer。命令、环境差异与失败项记录在 [验收矩阵](00_ACCEPTANCE_MATRIX.md)。
- GUI 启动与交互、真实外部接入、双平台安装包尚未验收，明细见矩阵第 3、4 节。
- GitHub Actions 应分别通过 Windows 与 macOS 的 typecheck、unit tests、production bundle build；CI 结果优先于本机记录。
- macOS 原生安装包、签名、公证仍需单独验收。


## 下一轮开发：本地任务、日历、专注与工作台

已启动独立 PR 实现 W5-1 的 SQLite 初始迁移与本地持久化、W5-2 的任务与日历基础闭环、专注记录与积分、真实个人工作台摘要。技术方案、验收步骤、风险和未完成项见 [02_LOCAL_WORKFLOWS.md](02_LOCAL_WORKFLOWS.md)。本轮无新增 npm 依赖，不安装任何项目依赖到用户电脑；GitHub CI 将负责对已锁定依赖的跨平台构建与测试验证。


## Canvas 真实接口开发验证

本轮新增 Canvas Personal Token **仅限开发者本人本地** 的真实只读连接器：课程/作业浏览、安全分页、主进程凭据加密、断开连接。实现方式、真实账号验收条件和未完成 OAuth/增量同步事项见 [03_CANVAS_CONNECTOR.md](03_CANVAS_CONNECTOR.md)。不把 CI mock 误报为学校接口已测试通过；不增加 npm 依赖。


## Canvas 自动同步与统一外部接入同步原则

产品决策：Canvas 当前课程作业默认自动同步；用户逐条控制显示/隐藏；隐藏数据本地保留六个月并提醒到期清理。邮箱、日历、文件等接入遵循授权后按范围定时增量同步的统一模型，不要求所有条目手动导入。详见 [04_CANVAS_TASK_SYNC.md](04_CANVAS_TASK_SYNC.md)。该文档包含目标验收标准，不代表当前 PR 代码已经全部实现。


## 上海交大 IMAP/SMTP 邮件连接器

开发验证版新增 `mail.sjtu.edu.cn` 的 TLS IMAP 只读收件头同步（每 10 分钟）、本地加密凭据、纯文本草稿与两阶段人工确认 SMTP 发送。详细设计、服务器参数、隐私与真实账号验收见 [05_SJTU_MAIL_CONNECTOR.md](05_SJTU_MAIL_CONNECTOR.md)。未对学校邮箱执行真实连接，CI 通过不等于实际收发完成验收。


## 邮件自动整理待办候选

邮件已支持在既有自动同步基础上，自动识别疑似作业、考试、报名等候选，并在本地提供创建个人任务、忽略及恢复审阅；用户确认后才创建任务，SQLite v4 保证去重与事务一致性。见 [07_MAIL_TASK_CANDIDATES.md](07_MAIL_TASK_CANDIDATES.md)，CI 验证和真实校邮箱验收分别记录。


## 本地知识库与离线复习

已在独立 PR 建设 Markdown/TXT 原文导入、本机 FTS5 全文检索、可溯源手工复习卡、离线评分调度与 SQLite 在线备份。资料只在用户选定后处理，不默认上传，真实设备验收仍待进行。边界与验收见 [08_LOCAL_KNOWLEDGE_REVIEW.md](08_LOCAL_KNOWLEDGE_REVIEW.md)。


## 离线学习规划与人工应用

独立 PR 实现从本机个人任务生成可编辑的时间块候选、按用户选择部分应用、检查已确认时间冲突与批次撤销，并在日历中查看。该切片明确属于离线规则规划，**不冒充已接入 AI Provider**。详见 [09_OFFLINE_PLANNING_REVIEW.md](09_OFFLINE_PLANNING_REVIEW.md)。


## W6-12 OpenAI Provider 安全接入

新增独立的 AI 学习助手：个人 Key 系统加密、单轮问题预览与两分钟一次性确认、固定 HTTPS Responses API、无自动工具/任务写入、每日请求预算与本地脱敏 token 用量。尚不把 AI 自动接入规划或知识库，也不需要开发阶段的真实 API Key。详见 [10_AI_PROVIDER_SECURITY.md](10_AI_PROVIDER_SECURITY.md)。


## W6-13 AI 结构化学习规划的人工审核闭环

在 PR #12 的用户授权与付费保护基础上增加「逐项选择个人任务 → 完整外发预览 → 明确确认 API → 严格校验 JSON 时间块 → 现有人工审阅/选择性应用/撤销」。默认离线规划照旧可用。参见 [11_AI_PLANNING_REVIEW.md](11_AI_PLANNING_REVIEW.md)。PR #13 依赖 PR #12，二者需依序审阅合并。


## W6-15 可追溯 PDF 知识库

本地知识库支持原生文件选取 PDF 的纯文字逐页解析，全文搜索和复习卡记录 PDF 物理页码。SQLite 由 v1 安全备份后升级至 v2；只保留提取后的文字/来源记录而非 PDF 原文件。OCR、复杂公式校验、原文 PDF 内嵌阅读器和 AI 引用问答留待后续。参见 [12_PDF_KNOWLEDGE_CITATIONS.md](12_PDF_KNOWLEDGE_CITATIONS.md)。


## W6 本地知识图谱

新增带真实原文片段与 PDF 页码来源的知识节点、人工跨文档关系、SQLite v3 迁移和只读关系图展示。原文重新导入后旧节点标记待复核，旧来源不自动重绑定；无需云端或 AI。开发范围、测试和边界见 [13_KNOWLEDGE_GRAPH.md](13_KNOWLEDGE_GRAPH.md)。


## W6 固定课程与 ICS

支持本机固定课程/按周展开、IANA TZID 与有限周 RRULE 的安全 ICS 导入预览、单次编辑/整组删除、ICS 导出，以及学习规划和 AI 建议的固定事项避让。具体支持格式与时区限制见 [14_ICS_FIXED_CALENDAR.md](14_ICS_FIXED_CALENDAR.md)。


## CAL-005 Canvas 日历自动同步

现有 Canvas 个人连接扩展为自动同步当前课程日历事项（非作业），在日历里按用户选择显示/隐藏，保留本机缓存并将可见课程时间用于学习规划冲突检查；ICS 仍作为手动备选导入方式。隐私、同步窗口、账号边界和保留规则见 [15_CANVAS_CALENDAR_AUTO_SYNC.md](15_CANVAS_CALENDAR_AUTO_SYNC.md)。


## CAL-002 日/周/月统一日历

现有月历新增可切换的周视图和日视图：将个人任务截止日期与固定课程、ICS、Canvas 日历以及已确认学习时间分别展示，按本机自然日导航并提示重叠。隐藏或来源缺失的 Canvas 条目不会出现在时间线上。详见 [17_CALENDAR_DAY_WEEK.md](17_CALENDAR_DAY_WEEK.md)；真实桌面验收仍需用户执行。


## APP-004 主进程安全诊断

全部 IPC 处理器增加统一的异常输出白名单，启动和 Canvas/邮箱等自动同步使用本机结构化诊断记录。日志不接受原始异常、用户输入或凭据，仅保留固定事件和操作码；原始第三方错误不会通过 IPC 输出到界面。详细边界和测试见 [18_APP_004_SAFE_DIAGNOSTICS.md](18_APP_004_SAFE_DIAGNOSTICS.md)。实际服务故障场景和用户侧交互仍需本机验收。
