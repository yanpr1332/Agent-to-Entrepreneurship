# W5 工程启动与桌面基础框架

状态：进行中。本 PR 覆盖 W5-0 工程基线与 W5-1 Electron 桌面骨架；不代表 W5-1 全部完成。

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

- 工作台卡片是静态产品结构预览，不是八大模块业务功能。
- 目前只暴露 ping 与 app version 两个只读 IPC 能力。
- 当前窗口关闭遵循平台默认退出行为；托盘驻留、后台资源控制和紧急退出属于 W5-6。
- 尚无 SQLite、Supabase、Canvas、IMAP/SMTP、AI Runtime、账号系统和同步引擎。
- 本地运行成功不等于 macOS 安装包、签名或团队云端验收通过。

## 验收证据

- Windows 本机此前执行的 npm install、typecheck、Vitest 与 electron-vite build 曾通过；安全信任校验代码新增后，必须由 CI 对最新 PR head 重新执行，旧结果不作为新代码的完整验收证据。
- GitHub Actions 应分别通过 Windows 与 macOS 的 typecheck、unit tests、production bundle build。
- macOS 原生安装包、签名、公证仍需单独验收。


## 下一轮开发：本地任务、日历、专注与工作台

已启动独立 PR 实现 W5-1 的 SQLite 初始迁移与本地持久化、W5-2 的任务与日历基础闭环、专注记录与积分、真实个人工作台摘要。技术方案、验收步骤、风险和未完成项见 [02_LOCAL_WORKFLOWS.md](02_LOCAL_WORKFLOWS.md)。本轮无新增 npm 依赖，不安装任何项目依赖到用户电脑；GitHub CI 将负责对已锁定依赖的跨平台构建与测试验证。


## Canvas 真实接口开发验证

本轮新增 Canvas Personal Token **仅限开发者本人本地** 的真实只读连接器：课程/作业浏览、安全分页、主进程凭据加密、断开连接。实现方式、真实账号验收条件和未完成 OAuth/增量同步事项见 [03_CANVAS_CONNECTOR.md](03_CANVAS_CONNECTOR.md)。不把 CI mock 误报为学校接口已测试通过；不增加 npm 依赖。
