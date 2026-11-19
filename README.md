# Agent-to-Entrepreneurship

> 面向大学生的跨平台个人学习、时间、知识与协作管理软件。

当前产品需求、交互原型和技术架构见 [PRD](docs/PRD.md)、[W2 UI/UX](docs/ui-ux/README.md)、[W3 架构](docs/architecture/README.md) 与 [W4 开发计划](docs/w4/README.md)。

## 项目目标

把课程和个人事务、学习资料、AI 规划、专注执行以及小组协作连接成完整工作流：收集 → 组织 → 规划 → 执行 → 反馈 → 调整。

- 首发平台：Windows 与 macOS 桌面端。
- 技术方向：Electron + React + TypeScript；Rust 按需引入。
- 数据原则：本地优先、选择性云同步、外传和团队共享分别授权。
- 目标：交付可在 Windows/macOS 演示的内部 Alpha，而非本阶段发布应用商店。

## 八大模块

1. 日历与任务
2. 个人知识库
3. 专注与自律
4. 小组协作
5. AI 辅助规划
6. 数据接入与扩展
7. 邮件管理与 AI 通信
8. 个人工作台

所有模块 P0 验收要求以正式 PRD 为准。当前仓库已落地 15 个垂直切片，八大模块均有可运行的基础闭环，
但完整 P0 与真实外部接入尚未完成；逐项完成度、证据与未验证项见 [W5 验收矩阵](docs/w5/00_ACCEPTANCE_MATRIX.md)。

## 工程开发

W5/W6 共 15 个切片已落地。工程结构、版本、开发命令和安全边界见 [W5 工程说明](docs/w5/README.md)；
可复现的验证结果、环境差异与未验证项见 [W5 验收矩阵](docs/w5/00_ACCEPTANCE_MATRIX.md)。

## Windows / macOS 本地 Alpha 验收指南

以下命令全部在包含 package.json 的**仓库根目录**执行。本指南优先使用隔离测试数据，不需要真实 Canvas、学校邮箱、OpenAI 或 Supabase 凭据。**CI 构建成功不代表完成真实 GUI 验收。**

### 0. 检查开发环境与更新仓库

- Windows 10/11、macOS；Node.js **24.x**（项目 .nvmrc 固定 **24.18.0**）；npm **11.x**；Git。
- 先保存本机尚未提交的修改。不要为了验收使用 git reset --hard。
- 下列 Windows 的 cd 路径只是示例，请替换成自己的目录。

Windows（PowerShell）：

~~~powershell
cd D:\Electives\AgentToEntrepreneurship\Agent-to-Entrepreneurship
git status --short
git switch main
git pull --ff-only
node --version                     # 需要 v24.x
npm --version                      # 需要 11.x
~~~

macOS（Terminal）：

~~~bash
cd /path/to/Agent-to-Entrepreneurship
git status --short
git switch main
git pull --ff-only
node --version
npm --version
~~~

**尚未合并的 PR 不在 main 中。** 如需提前测试某个 PR，先执行 git fetch origin，再根据 PR 中显示的分支名切换到相应远端分支；验收完成后切回 main。不要假设 git pull 会自动拉到尚未合并的功能。

### 1. 安装依赖

Windows/macOS 通用：

~~~sh
npm ci
~~~

npm ci 会按 package-lock.json 安装依赖。出现 deprecated、funding 提示并不意味着安装失败；出现审计漏洞请保存结果、按运行时与开发工具风险分别判断：

~~~sh
npm audit --omit=dev
npm audit
~~~

**不要在首次验收前执行 npm audit fix --force**，它可能强制改变 Electron 构建工具的版本。安装输出的 added N packages 也**不保证 Electron 可执行文件安装完整**。

### 2. 验证 Electron 已安装

Windows PowerShell：

~~~powershell
Test-Path .\node_modules\electron\dist\electron.exe  # 应为 True
Test-Path .\node_modules\electron\path.txt           # 应为 True
~~~

若结果为 False 或启动报 **Error: Electron uninstall**，可运行 Electron 自身的安装脚本：

~~~powershell
node .\node_modules\electron\install.js
~~~

如果因网络问题下载失败，只有在允许使用该镜像且信任其来源时才尝试：

~~~powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
node .\node_modules\electron\install.js
~~~

再运行两个 Test-Path 确认安装成功；不必反复运行 npm ci。若从其他 Electron 应用的终端启动且出现 ELECTRON_RUN_AS_NODE=1，可在 PowerShell 清除该变量：

~~~powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
~~~

macOS：

~~~bash
test -f node_modules/electron/path.txt && echo "Electron install record exists"
node -p "require('electron')"      # 应返回 Electron 可执行文件路径
~~~

### 3. 用独立数据目录启动应用

不要直接拿真实任务、真实课程或真实密钥验证删除和导入。隔离目录内保存单独的 SQLite 数据，**切换目录不会自动迁移旧数据**。

Windows PowerShell（每个**新终端窗口**都应重新设置）：

~~~powershell
$env:ATE_USER_DATA_DIR = "$env:LOCALAPPDATA\ATE-alpha-acceptance"
npm run dev
~~~

macOS Terminal：

~~~bash
export ATE_USER_DATA_DIR="$HOME/Library/Application Support/ATE-alpha-acceptance"
npm run dev
~~~

正常结果是 Electron 应用窗口出现，个人工作台显示 **SQLite 已连接**。仅看到 dev server 的 localhost:5173 地址，不代表桌面窗口已经打开。

如果 Windows 上默认启动报 Chromium 子进程、GPU 或沙箱创建失败，参见 [本地运行排障](docs/w5/16_LOCAL_RUNTIME_TROUBLESHOOTING.md)。仅在**自己控制且可信的本地开发环境**下可临时尝试：

~~~powershell
npm run dev:compat
~~~

该模式通过 --noSandbox 关闭 Chromium OS 级沙箱，**不得用于正式打包或对外分发**。退出时关闭桌面窗口，若终端仍有残留进程再按 Ctrl+C。备份前关闭应用，避免复制处于写入状态的数据库。

### 4. 类型检查、自动化单测与构建

关闭或另开应用运行终端，在仓库根目录执行：

~~~sh
npm run typecheck
npm test
npm run build
~~~

- npm run typecheck：TypeScript 类型检查。
- npm test：Vitest 单元及集成测试。
- npm run build：再次进行类型检查和测试，再编译 Electron-Vite；**不会生成最终安装包**。
- 受限 Windows 环境如出现 Timeout terminating forks worker，可额外用线程池复核，但不替代 CI：

~~~sh
node node_modules/vitest/vitest.mjs run --pool=threads
~~~

- Windows 安装包命令：npm run dist:win；macOS：npm run dist:mac。签名、公证和真实安装包仍需另做验收，不得以 npm run build 通过冒充发布完成。
- GitHub Actions 在 Windows 与 macOS 均运行，独立于用户真机 GUI 体验。

### 5. 本地人工验收顺序

逐项记录通过 / 失败 / 未验证，保留触发动作与脱敏截图。

1. 工作台：显示 SQLite 已连接；所有导航不出现白屏。
2. 任务：日历页点 **+ 新建任务**，填写任务和截止日期、收起/重新打开编辑器；标记完成、撤销完成、编辑已有任务及截止日期。
3. 日期：月视图选择一个不是今天的日期，确认顶部 **当前选中**、日历高亮、下方任务/课程一致；切月/周/日、跨月、回到今天。
4. 固定课程：创建一门按周重复 4 次的测试课程，再点 **修改本次日期/时间**，选择「仅修改本次 / 从本次起 / 整个系列 / 指定区间」。确认日期按相同自然日差批量移动、已确认学习计划冲突时整组拒绝保存。该批量修改仅支持**本机手动重复系列**，不修改 ICS 或 Canvas 来源。详见 [22 重复课程批量修改与验收](docs/w5/22_ALPHA_TIME_004_COURSE_SERIES_EDIT.md)。
5. 专注：点 1 分钟预设、自定义 2 分钟，开始/暂停/继续/结束；验证记录与积分。输入 0、181 和小数应无法开始。
6. 主题：侧边栏底部 **外观主题** 选择浅色/深色/跟随系统，重启验证保存与系统主题联动。
7. 知识库：用无私人信息的 .md、.html、.tex、.txt、.pdf 文件验证阅读预览、原始源码和证据片段；同时导入准确和轻微拼写错误的资料，搜索时应当同时出现「精确」及「容错」结果。选择某一段原文后，可以自愿使用自己的 OpenAI API Key，通过**预览完整请求 → 确认发送**获得一次 AI 辅助解释；默认离线，不上传其他文件或整库。完整 TeX 编译和真正全库 AI 语义检索仍未实现。详见 [24 安全预览](docs/w5/24_ALPHA_KB_003_SAFE_PREVIEW_SEARCH.md) 和 [25 可选 AI 原文解释](docs/w5/25_ALPHA_KB_004_AI_SOURCE_EXPLANATION.md)。

**专注与日历联动（PR #27）**：在专注页填写标题，计时期间可切换模块再返回；点击「记录完成」后，历史中可以修改标题，日历月视图用圆点提示有实际专注，日/周和选中日期详情显示实际学习时段。暂停期间计入起止区间，但不计入有效专注秒数；旧版估算时间不进入实际日历。此变更会把本地任务数据库从 v4 迁移到 v5，首次运行前会制作迁移快照；详见 [实施及迁移说明](docs/w5/20_ALPHA_TIME_002_FOCUS_CALENDAR.md)。
8. 学习规划：生成、选择性应用、核对日历占用并撤销。已确认的单段学习计划可在日历中修改时间或删除本段。

**任务执行时间编辑（PR #28）**：在日历中选中日期，找到「任务执行时间」，点击「+ 安排任务时间」为可见、未完成的任务指定具体日期、开始时刻和时长（15–480 分钟、5 分钟刻度）。同一任务可安排多段，也可对已确认的时间块逐段修改或删除。固定课程及其他时间块重叠会被主进程拦截。任务截止日期不变。此轮将 `ate-plans.sqlite` 从 v1 升至 v2，原规划库会在迁移前生成快照；详情和本地集中测试案例见 [任务执行时间实施文档](docs/w5/21_ALPHA_TIME_003_TASK_SCHEDULES.md)。
9. 关闭应用，在**同一** ATE_USER_DATA_DIR 下重新启动，核实任务、专注记录和主题保留。

本轮交互变更与未实现的反馈见 [Alpha 验收反馈路线图](docs/w5/19_ALPHA_UX_FEEDBACK_ROADMAP.md)，逐功能当前证据见 [验收矩阵](docs/w5/00_ACCEPTANCE_MATRIX.md)。

### 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| npm warn deprecated / npm fund | 依赖维护/赞助信息，本身不阻止 npm ci 成功 |
| npm audit --omit=dev 为 0 但 npm audit 有告警 | 运行与开发依赖风险不同；不要直接 --force 破坏锁定版本 |
| Error: Electron uninstall | 检查 Windows electron.exe 和 path.txt，补运行 electron/install.js |
| GPU process isn't usable | 参考排障文档检查沙箱，dev:compat 只能用于可信本地开发 |
| 本地数据无法打开 | 检查 ATE_USER_DATA_DIR 可写性，不要直接删除真实数据 |
| libpng warning: iCCP: known incorrect sRGB profile | 记录出现时机和图片来源；可能是 PNG 色彩配置，单独出现不代表数据库损坏 |
| npm test 中 fork worker timeout | 参考上文 --pool=threads，CI 标准检查仍须另行通过 |

> 提交 Issue、截图和日志前，请遮盖真实 Token、邮箱、API Key 和课程资料。当前项目许可为 [PolyForm Strict 1.0.0](LICENSE)，开发者/贡献者修改授权要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 工程边界

- Renderer 不拥有 Node、文件系统或 shell 权限；仅通过 Preload 暴露的白名单 API 与主进程通信。
- 不在仓库提交密钥、个人 Token、邮箱密码或真实用户数据。
- SQLite、云端协作、Canvas、邮件和 AI Runtime 将按独立任务接入，不以 Mock 作为真实集成验收证据。
- macOS 打包必须在 macOS 设备或 CI 上完成。

## 许可证与使用限制

本项目的**当前版本**采用 [PolyForm Strict License 1.0.0](LICENSE)（[官方条款](https://polyformproject.org/licenses/strict/1.0.0)）。
这属于**源码可见（source-available），不是 OSI 开源许可证**。

- 允许许可证定义的**非商业使用**，包括个人学习、研究，以及许可证列明的教育、公益等机构用途。
- **不授予修改、制作衍生作品或再分发软件的权利**，即使是非商业目的也不例外；需要额外取得相应权利持有者的授权。
- 一般**商业使用不被允许**；商业授权须与相应版权持有人另行协商。
- 本许可只覆盖有权以该许可提供的项目内容；第三方依赖与资产维持各自的许可证。
- **历史版本已根据 MPL-2.0 作出的有效授权不会被本次变更追溯撤销。**

许可证切换的版权边界、历史版本、协作贡献要求见 [许可说明](docs/LICENSING.md)。

## 贡献

参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。所有功能经独立分支和 PR 进入 main；任务认领、文件范围和验收证据记录在 W4 Backlog。
