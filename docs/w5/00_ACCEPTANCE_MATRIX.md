# W5/W6 切片验收矩阵

> 本文件是「哪些能力真的能跑」的唯一出处。任何文档里的"已实现"都必须能在下表找到对应格子；
> 没有证据的格子一律写「未验证」，不得用「代码已完成」代替验收。

## 1. 本次验证环境

| 项 | 值 |
| --- | --- |
| 时间 | 2026-11-11 18:40–18:55（Asia/Shanghai） |
| 基线提交 | `cd8347b`（`origin/main`，工作区与远端完全一致） |
| 操作系统 | Windows（用户本机桌面会话） |
| Node.js | v24.21.0（`engines` 要求 `>=24 <25`；[`.nvmrc`](../../.nvmrc) 钉 24.18.0，CI 亦为 24.18.0） |
| npm | 11.19.0 |
| Electron | 45.2.3 |

## 2. 工程三件套结果

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck`（`tsc -b`） | ✅ 通过，无输出，退出码 0 | `node_modules/.tmp/tsconfig.node.tsbuildinfo`（66,062 B）与 `tsconfig.web.tsbuildinfo`（20,837 B）已生成 |
| `npm test`（默认 forks 池） | ⚠️ 环境失败，**非断言失败** | 全部测试文件报 `Timeout terminating forks worker`；沙箱禁止子进程 IPC |
| `node node_modules/vitest/vitest.mjs run --pool=threads` | ✅ **43 文件 / 190 用例全部通过**，3.06 s | 命中 `Test Files 43 passed (43)`、`Tests 190 passed (190)` |
| `node node_modules/electron-vite/bin/electron-vite.js build` | ✅ 通过，0.6 s | `out/main/index.js` 214.67 kB、`out/preload/index.js` 12.30 kB、`out/renderer/index.html` 0.60 kB、`index-*.css` 26.81 kB、`index-*.js` 780.93 kB |
| `npm run dev`（默认，沙箱开启） | ❌ 本机不可用 | 默认路径启动即退出；日志显示 GPU/沙箱子进程启动失败（`GPU process isn't usable. Goodbye.`）。兼容模式下应用可正常运行，但默认路径的根因仍需在真实桌面环境进一步复核；排查记录与替代参数见 [16 本地运行排障](16_LOCAL_RUNTIME_TROUBLESHOOTING.md) |
| `npm run dev:compat`（`--noSandbox`） | ✅ 已验证（CDP 自动化驱动） | 11 项断言全部通过：preload 桥、IPC、版本、9 个导航、SQLite 连接横幅、4 张指标卡、9 个页面均渲染标题且无全局错误横幅、表单建任务、SQLite 回读、主题切换；另独立验证重启后任务仍在并能清理。userData 下生成 6 个 SQLite 库 |

> `npm run build` = `typecheck && test && electron-vite build`，因第二段在本地环境受限，本次以分步执行替代；
> CI 使用的是同一组命令，以 CI 结果为准。

### CI 证据

| 项 | 链接 / 说明 |
| --- | --- |
| PR #22 Checks（始终反映最新提交） | <https://github.com/yanpr1332/Agent-to-Entrepreneurship/pull/22/checks> |
| 首个 Windows + macOS 双绿的 run（提交 `4067176`） | <https://github.com/yanpr1332/Agent-to-Entrepreneurship/actions/runs/43009081733> |
| 「CI」列的读法 | 指该 PR 的 Checks 全绿；此后新增的提交以 PR Checks 页面为准，不继承旧结果 |

两个 job（`Verify (windows-latest)`、`Verify (macos-latest)`）各自执行 `npm ci → typecheck → test → build`。

## 3. 切片状态

状态定义：**代码**＝仓库有实现；**单测**＝有 Vitest 覆盖并通过；**CI**＝Windows+macOS 双平台工作流通过；**真机**＝实际运行过（⚠️ 自动化＝由 CDP 脚本真实点击 DOM 验证，未由人手工走查）。

| # | 切片 | 设计文档 | 代码 | 单测 | CI | 真机 |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | 工程基线 + Electron 骨架（IPC 白名单、可信 sender、安全基线） | [README](README.md) | ✅ | ✅ | ✅ | ⚠️ 自动化 |
| 02 | 本地 SQLite：任务 / 日历 / 专注积分 | [02](02_LOCAL_WORKFLOWS.md) | ✅ | ✅ | ✅ | ⚠️ 自动化（任务 CRUD 与主题已验证；日历逐日切换、专注计时交互未点） |
| 03 | Canvas 个人 Token 只读连接器（仅开发者本机） | [03](03_CANVAS_CONNECTOR.md) | ✅ | ✅ | ✅ | ❌ 无真实 Token |
| 04 | Canvas 作业自动同步 + 隐藏六个月保留 | [04](04_CANVAS_TASK_SYNC.md) | ✅ | ✅ | ✅ | ❌ |
| 05 | 交大邮箱 IMAP 只读同步 / SMTP 逐次确认发送 | [05](05_SJTU_MAIL_CONNECTOR.md) | ✅ | ✅ | ✅ | ❌ 未做真实邮箱收发 |
| 06 | 云端工作空间 PoC（Supabase + RLS） | [06](06_CLOUD_WORKSPACE_POC.md) | ✅ | ✅ | ✅ | ❌ 未在真实项目部署/验收 |
| 07 | 邮件转任务候选（确认后写入） | [07](07_MAIL_TASK_CANDIDATES.md) | ✅ | ✅ | ✅ | ❌ |
| 08 | 本地知识库 + FTS5 检索 + 离线复习 | [08](08_LOCAL_KNOWLEDGE_REVIEW.md) | ✅ | ✅ | ✅ | ❌ |
| 09 | 离线规则规划 + 选择性应用 + 批次撤销 | [09](09_OFFLINE_PLANNING_REVIEW.md) | ✅ | ✅ | ✅ | ❌ |
| 10 | OpenAI Provider 安全接入（两阶段确认、用量上限） | [10](10_AI_PROVIDER_SECURITY.md) | ✅ | ✅ | ✅ | ❌ 无真实 Key |
| 11 | AI 结构化规划人工审核闭环 | [11](11_AI_PLANNING_REVIEW.md) | ✅ | ✅ | ✅ | ❌ |
| 12 | PDF 逐页解析与页码引用 | [12](12_PDF_KNOWLEDGE_CITATIONS.md) | ✅ | ✅ | ✅ | ❌ |
| 13 | 本地知识图谱（人工节点/关系 + 证据） | [13](13_KNOWLEDGE_GRAPH.md) | ✅ | ✅ | ✅ | ❌ |
| 14 | 固定课程 + ICS 导入导出（时区/重复规则白名单） | [14](14_ICS_FIXED_CALENDAR.md) | ✅ | ✅ | ✅ | ❌ |
| 15 | Canvas 日历事项自动同步 | [15](15_CANVAS_CALENDAR_AUTO_SYNC.md) | ✅ | ✅ | ✅ | ❌ |
| 17 | CAL-002 日/周视图、真实时间线与冲突提示 | [17](17_CALENDAR_DAY_WEEK.md) | ✅ | ✅ | ✅ [Windows/macOS run](https://github.com/yanpr1332/Agent-to-Entrepreneurship/actions/runs/43017575714) | ❌ 未做真实 GUI 验收 |
| 18 | APP-004 主进程结构化脱敏诊断与统一 IPC 错误边界 | [18](18_APP_004_SAFE_DIAGNOSTICS.md) | ✅ | ✅ | ✅ [Windows/macOS run](https://github.com/yanpr1332/Agent-to-Entrepreneurship/actions/runs/43022221335) | ❌ 未做真实故障注入 GUI 验收 |

「真机」一栏的含义是**实际运行过**。目前只有 01、02 拿到「⚠️ 自动化」——由 CDP 脚本真实点击
DOM 验证，不是人手工走查；其余切片仍为 ❌。在补齐之前，本仓库不得对外表述任何切片"已验收通过"。

### 2026-11-19 Windows Alpha 用户反馈

已记录实际用户提出的日期选中、任务编辑、课程编辑入口、专注自定义、主题、知识库渲染/模糊搜索、积分排名及专注进日历要求。详见 [19 Alpha 反馈路线图](19_ALPHA_UX_FEEDBACK_ROADMAP.md)。

ALPHA-UX-001 的 [PR #26](https://github.com/yanpr1332/Agent-to-Entrepreneurship/pull/26) 已有 [Windows/macOS 双平台 CI 成功证据](https://github.com/yanpr1332/Agent-to-Entrepreneurship/actions/runs/44446851977)（提交 92e8e710）；**后续提交仍需看 PR 最新 Checks**，用户真实 GUI 回归未执行。其余需求为未来轮次。此记录不改变上表真机验收结论。

### ALPHA-TIME-002 专注时间模型（2026-11-19）

- **代码**：PR #27 新增专注标题、更名、实时时段、SQLite v5 迁移及独立日历回显。
- **测试**：增加旧版数据迁移、幂等与更名、日期拆分等测试，最终结果以 PR #27 最新 CI 为准。
- **GUI**：尚未真实点击；用户计划在本轮完成后集中 Windows 验收，macOS GUI 仍待安排。
- **未实现**：任务计划/截止时刻、课程系列编辑等仍不能标为完成。详细验收见 [20](20_ALPHA_TIME_002_FOCUS_CALENDAR.md)。

### ALPHA-TIME-003 任务执行时间编辑（2026-11-19）

- PR #28 已提交“手动安排可见任务执行时间”“修改/删除单个已确认时间块”及规划库 v2 迁移相关代码。
- 新增单段冲突校验、校验器和数据库迁移/备份测试；**最终自动化结论以 PR 最新 Checks 为准**。
- 真机 Windows、macOS GUI 以及旧版数据库恢复演练：**尚未执行，集中验收时核对**。
- 不在本轮范围：任务具体截止时刻、重复课程批量编辑、MD/HTML/LaTeX 渲染、团队积分榜。
- 详细测试： [21 Alpha 任务时间安排](21_ALPHA_TIME_003_TASK_SCHEDULES.md)。

### ALPHA-TIME-004 手动重复课程修改（2026-11-19）

- PR #29 已开发手动重复课程的单次/未来/整组范围编辑及冲突保护。**不涉及数据库版本变更**。
- 新增 SQLite 原子回滚、日期偏移、ICS 权限隔离与输入校验测试；**以 PR 最新提交的 CI 结果为准**。
- Windows/macOS 真机 GUI 尚未验收，用户计划集中验收。操作与预期见 [22](22_ALPHA_TIME_004_COURSE_SERIES_EDIT.md)。
- 不在范围：Canvas/ICS 批量编辑、任务具体截止时刻、知识库安全渲染/模糊搜索、团队积分榜。

### ALPHA-TIME-005 手动重复课程指定闭区间修改（2026-11-19）

- 新增「指定区间：第 N 次至第 M 次（含）」；只影响区间内成员。以区间起点为日期偏移基准。
- 新增输入校验、范围外保持原样、跨系列与逆序拒绝、时间冲突原子回滚测试。
- 最新 CI 结论以相应 PR 的 Checks 为准；**Windows/macOS GUI 尚未集中验收**。
- 详细手工步骤：[23](23_ALPHA_TIME_005_COURSE_CUSTOM_RANGE.md)。

### ALPHA-KB-003 知识库安全预览与容错检索（2026-11-19）

- PR #31 已提交 HTML/TeX UTF-8 导入、受限 HTML/Markdown/LaTeX 阅读器、基础 MathML、源码切换、有限离线编辑距离检索及来源标记。
- 自动化测试和构建状态以 **PR 最新 Checks** 为准；不等于安全审计或用户真实 GUI 通过。
- Windows/macOS GUI 尚未执行；按 [24](24_ALPHA_KB_003_SAFE_PREVIEW_SEARCH.md) 集中验收。全文排版、AI 语义搜索等未实现，不可误标。

### ALPHA-KB-004 精确+容错混合搜索与授权 AI 单段解释（2026-11-19）

- PR #32（已合并）在本地知识库混合输出精确和容错命中，同时防重复；单段 AI 解释需要用户先预览**实际外发文本**再明确确认，复用已有每日限额与个人加密 Key。
- 仅在用户确认时向 OpenAI API 发送当前片段（最多 1150 字符）与问题；不发送文件路径、其他文件或 Canvas/邮箱资料。未连接时仍可离线搜索。
- 模型回答作为参考，不是已验证引用，不自动存知识库、复习卡或日历。此功能**不等于**已开发全库 AI 语义搜索。
- 单测与 CI 结果以 PR #32 的**最新提交检查**为准。真人 Windows/macOS GUI 与自愿的真 API 计费验收**尚未执行**。
- 详细本机测试用例见 [25](25_ALPHA_KB_004_AI_SOURCE_EXPLANATION.md)。

### ALPHA-KB-005 本地三路检索（后续规划，未实现）

- 用户希望继续演进为**精确搜索 + 模糊搜索 + 本地向量语义搜索**，已记录在 Backlog 与 [26 选型及工程难度评估](26_ALPHA_KB_005_LOCAL_SEMANTIC_SEARCH_FEASIBILITY.md)。
- **当前未安装 embedding 模型、未建立向量索引、未运行 CPU/内存性能测试**。后续分 PoC、增量向量索引、三路结果合并，均须独立 CI 与真实 Windows/macOS GUI 验收。
- 不把 PR #32 的可选 OpenAI 单段解释误称为全库本地语义检索。

### ALPHA-SYNC-001/002/003 同步优先队列（2026-11-24，持续实施）

- **001：已有代码，真实验收未做**。个人同步协议/字段来源白名单、显式授权投影、五账号 RLS 手动验收脚本及离线 mock 已合并；独立测试项目部署、五账号与服务端 RLS 正反向真实验收仍未完成，不把 Mock 结果填成联机通过。详细见 [28](28_ALPHA_SYNC_001_PROTOCOL_AND_RLS.md)。
- **002 第一阶段：已合并 PR #35，尚未联机**。个人任务与手动日历逐条显式授权、事务性 Outbox、pending 合并、版本基线及删除墓碑已落地。详见 [29](29_ALPHA_SYNC_002_LOCAL_OUTBOX.md)。
- **002B：已合并 PR #36，未部署**。owner-scoped 个人同步表/RLS、设备注册与撤销、幂等 apply、版本检查、按 owner 串行 cursor pull RPC，以及本机 per-owner deviceId/cursor 持久化已合并；没有真实 Supabase 项目/多设备验收。详见 [30](30_ALPHA_SYNC_002_SERVER_PROTOCOL.md)。
- **002C：已合并 PR #37**。任务库 schema v8、手动日历库 schema v5；owner-scoped enrollment/outbox、按 owner ack、跨账号独立删除墓碑；旧 ownerless 数据保留在隔离表，只有明确确认才重新授权存活的个人任务/手动事件。详见 [31](31_ALPHA_SYNC_002C_OWNER_SCOPED_OUTBOX.md)。
- **002D：已合并 PR #38，未进行真实云端验收**。Main-process 手动 push/ack + pull/SQLite 应用、逐条授权 UI、冲突记录与展示；任务库 schema v9 新增 owner-scoped conflict 表。每轮 push 最多读取 100 个任务和 100 个手动日历操作；pull 每页 200、最多 10 页。普通编辑轮换 operationId，ack 与并发 rebase 分离，上传前再次核验 pending 意图；pull 只有在本地数据和冲突记录完成后才推进 cursor。退出应用时等待/停止在途同步，未确认操作保留供重试。**不自动后台同步；002D 尚无冲突解决 UI、legacy 认领 UI、真实 Supabase 部署或双设备验收**。详见 [32](32_ALPHA_SYNC_002D_PUSH_PULL.md)。
- **002E：当前开发中**。对个人任务/手动日历的本地 pending 与远端变更冲突提供版本 CAS + 二次确认、“保留本机”操作重基/“采用云端”本地更新；未解决冲突继续阻断上传和覆写，新远端变更仅更新冲突快照。来源不合格、日历容量、已确认学习计划占用仍保持阻塞。**Cursor 恢复、设备重新注册/撤销、legacy quarantine UI、远端 RLS/双设备测试均未完成**。详见 [33](33_ALPHA_SYNC_002E_CONFLICT_RESOLUTION.md)。
- **003：未开发**。团队消息仍使用轮询，Realtime + 断线补拉 + 撤权后拒绝 + 五账号联机尚无真实证据。
- **Embedding：未开发**。ALPHA-KB-005 继续保留，待同步核心门槛后先做离线 PoC；不将 PR #32 的 AI 单段解释误算为本地 embedding。
- 2026-11-25 内部 Alpha 以真实授权测试账号、RLS 反向测试、最小跨设备增量场景及已知风险记录为条件性目标；未验证项应明确阻塞，不能冒充完成。详见 [27 同步优先实施计划](27_ALPHA_SYNC_FIRST_IMPLEMENTATION_PLAN.md)。

## 4. 未验证项清单（按风险排序）

1. **双平台安装包**：从未执行 `npm run dist:win` / `dist:mac`，无签名、无公证、无安装包产物。
2. **Canvas 真实读取**：无真实 Personal Token 的本机集成记录；OAuth 多用户方案依赖学校 Developer Key，未申请或未获批。
3. **交大邮箱真实收发**：IMAP 登录、收件、SMTP 发送均无真实账号证据。
4. **Supabase 真实部署**：迁移 SQL 未在真实项目执行；RLS 隔离未用独立账号做正反向验证；Realtime 未接入（当前 10 秒轮询）。
5. **OpenAI 真实调用**：无真实 Key 的调用记录；成本与限流仅由单元测试的假 client 覆盖。
6. **GUI 交互**：已用 CDP 自动化点击 9 个页面、建任务、重启持久化并通过；但专注计时、知识库导入、规划应用、ICS 导入等具体交互尚未人工走查。
7. **备份恢复**：只能生成备份，无恢复 UI、无自动清理；备份未加密。

## 5. 本机复现步骤

```powershell
npm ci
# npm 11.19 的 allowScripts 会拦下 Electron 安装脚本；若 node_modules\electron\dist 缺失：
#   $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
#   node node_modules\electron\install.js
npm run typecheck
npm test                      # CI 环境用默认池；受限环境改用下面一行
node node_modules\vitest\vitest.mjs run --pool=threads
npm run build
npm run dev                   # 默认：Chromium 沙箱开启
npm run dev:compat            # 本机无法创建 Chromium 沙箱子进程时使用；见 16_LOCAL_RUNTIME_TROUBLESHOOTING.md
```

GUI 冒烟清单（逐项记录 通过 / 失败 / 未验证）：

1. 左侧 9 个导航项逐个点击，无白屏、无红色错误横幅。
2. 工作台显示版本号与「SQLite 已连接」。
3. 日历页创建任务 → 月历出现圆点 → 编辑 → 勾选完成。
4. 关闭应用重新 `npm run dev` → 任务仍在（持久化）。
5. 专注页 1 分钟：开始 → 暂停 → 继续 → 记录完成 → 积分 +1。
6. 知识库导入 `.md` → 搜索命中 → 建复习卡 → 评分。
7. 学习规划生成建议 → 选择性应用 → 日历显示时间块 → 撤销。
8. 数据接入 / 邮件 / 协作页在未连接时给出可理解提示，不崩溃。
9. 明暗主题切换 → 重启后保持。

## 6. 维护规则

- 每次合并影响上表任一格子的 PR，必须同步更新该格并附证据（截图、命令输出或 CI 链接）。
- 「真机」一栏只能由实际执行者在真实设备上填写，禁止由 CI 结果推导。
- 新增切片必须同时在 [W5 工程说明](README.md) 与 [W4 Backlog](../w4/02_DEV_BACKLOG.md) 登记。
