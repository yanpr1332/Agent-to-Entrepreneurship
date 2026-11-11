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

### 环境要求

- Node.js 24.18.x
- npm 11.x
- Windows 10/11 或 macOS（支持版本按发布验收矩阵确定）

### 启动与检查

    npm ci
    npm run dev
    npm run typecheck
    npm test
    npm run build

## 工程边界

- Renderer 不拥有 Node、文件系统或 shell 权限；仅通过 Preload 暴露的白名单 API 与主进程通信。
- 不在仓库提交密钥、个人 Token、邮箱密码或真实用户数据。
- SQLite、云端协作、Canvas、邮件和 AI Runtime 将按独立任务接入，不以 Mock 作为真实集成验收证据。
- macOS 打包必须在 macOS 设备或 CI 上完成。

## 贡献

参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。所有功能经独立分支和 PR 进入 main；任务认领、文件范围和验收证据记录在 W4 Backlog。
