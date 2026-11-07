# W3 技术架构总览
> 2026-11-07：W3-1～8 决策和集中审阅 B 已获原则确认；本文是**技术设计归档**，不代表代码、真实连接器、签名或双平台实测完成。W2 原型最终体验仍待签收；W4/W5 未获开发授权。

| 文档 | 主题 |
|---|---|
| [01](01_SYSTEM_OVERVIEW.md) | Electron 运行时、后台与模块边界 |
| [02](02_TECH_STACK_AND_ADR.md) | 八项技术选型及权衡 |
| [03](03_DATA_MODEL.md) | ER、字段、索引、迁移 |
| [04](04_MODULE_INTERFACES.md) | 模块 Port、命令与事件 |
| [05](05_SECURITY_AND_PERMISSIONS.md) | Electron 安全、五维授权 |
| [06](06_CONNECTOR_ARCHITECTURE.md) | Canvas、SJTU、邮件、日历、Notion |
| [07](07_AI_AND_KNOWLEDGE.md) | 混合 AI、图谱、检索和复习 |
| [08](08_SYSTEM_ADAPTERS.md) | Win/Mac 系统能力与专注 |
| [09](09_SYNC_AND_COLLABORATION.md) | Local-first、离线冲突、团队同步 |
| [10](10_ENGINEERING_AND_RELEASE.md) | Monorepo、CI/CD、签名及迁移 |
| [11](11_RISKS_AND_OPEN_QUESTIONS.md) | R01–R10 与未决事项 |
| [12](12_REQUIREMENT_TRACEABILITY.md) | PRD 与 W2 验收映射 |

**架构基线**：Electron + React + TypeScript；Rust 按需。SQLite 本地优先、逐文件云同步、独立可替换同步层。八模块模块化单体、唯一 Task 权威、公开契约与领域事件。Connector Engine 真实接入；AI Runtime 本地/云端混合、图谱、跨文档证据与间隔复习。Windows/macOS 分级专注、安全退出；离线 outbox、增量补齐与业务冲突；分层测试、性能预算与发布门禁。

**范围**：八大 P0 模块必须全部通过真实验收；交大 Canvas/教务/邮箱、Google/Outlook **日历**和 Notion 为 P0；Gmail/Outlook 专用**邮箱**连接器仍属 P1。不能以 Mock 替代实测。详情见 [PRD](../PRD.md)、[W2 验收](../ui-ux/05_W2_ACCEPTANCE.md)。
