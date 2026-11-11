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
