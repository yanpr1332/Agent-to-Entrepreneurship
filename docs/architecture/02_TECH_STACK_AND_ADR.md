# W3 技术选型记录 ADR
> 2026-11-07 经用户逐项选择及集中审阅确认，仍须 W4 验证具体版本、费用和真实平台能力。

| 决策 | 方案 | 原因与代价 |
|---|---|---|
| W3-1 | **B** Electron+React+TS；Rust 按需 | UI 生态成熟；用安全隔离/后台预算抵消资源开销 |
| W3-2 | **C** SQLite Local-first + 可替换 Cloud Adapter | 离线优先、逐文件同步；额外协议与迁移工作 |
| W3-3 | **B** 模块化单体+最小共享核心 | 同一 Task、接口事件；需严格依赖边界 |
| W3-4 | **B** Connector Engine+内置适配器 | 集中 OAuth/限流/映射；插件平台后置 |
| W3-5 | **B** 本地知识库+本地/云端 AI Provider | 自备 Key 或本地模型，模型/硬件按需 |
| W3-6 | **B** 分级专注+原生系统适配 | 真实可逆干预、紧急退出，不能保证不可绕过 |
| W3-7 | **B** Outbox+增量同步+业务冲突 | 更适合团队授权审批；复杂度高于简单 LWW |
| W3-8 | **B** Monorepo+分层测试+安全 CI/CD | 双平台质量保障；签名和真机有成本 |

集中审阅 **B**：保留以上决策，并采纳 R01–R10 补强及身份、敏感信息、后台资源三项横向约束。

## 重要非决策
- **Supabase 是首版云服务候选，不是唯一已经锁定的供应商。** Auth/Sync/Storage/Realtime Port 允许迁移，但迁移不是零成本。
- 向量扩展（例如 sqlite-vec）、FSRS/ts-fsrs、OCR/ASR 引擎和 Rust 原生组件需兼容、安全、许可证及硬件评估。
- 具体 Node/Electron/React 版本和包管理器待 W4 锁定；发布包内 Node 的版本不等于用户系统 Node，升级须测试。
- macOS 最低版本、Intel/Apple Silicon、Windows ARM64、代码签名和 E2EE 范围暂不假定。
- 八模块全部首版 P0；Gmail/Outlook 专用邮件连接器 P1，Google/Outlook 日历 P0。详情见 [风险](11_RISKS_AND_OPEN_QUESTIONS.md)。
