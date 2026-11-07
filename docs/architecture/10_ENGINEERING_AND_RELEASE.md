# W3 工程结构、测试与发布安全
## 计划目录（没有初始化代码）
```text
apps/desktop/                Electron main/preload/renderer
packages/contracts/          DTO、IPC Schema、领域事件
packages/core/               用户、工作空间、权限原语
packages/modules/            m1-calendar ... m8-dashboard
packages/connectors/         Connector Engine + 适配器
packages/ai-runtime/         AI Provider 与权限执行
packages/sync/               Local Outbox 与云 Port
packages/system-adapters/    Win/Mac 系统能力
services/cloud/              可替换云端服务
native/                      需要时再引入 Rust
tests/{unit,integration,e2e,security,fixtures}/
docs/architecture/
.github/workflows/           W5 经授权后再创建
```
共享模块通过明确 contracts 通信，不允许跨模块直接写表。前端安全：contextIsolation、关闭 Node 集成、隔离 preload/IPC、CSP、sender/schema 验证、外部 URL 校验。API Key/OAuth Token 使用系统安全存储或服务端保密，不写仓库或普通日志。

## 五层测试
| 类型 | 要求 |
|---|---|
| 单元 | 任务状态、积分去重、FSRS、权限/字段映射 |
| 集成 | 模块 Port、Outbox、索引/知识图谱、数据库迁移 |
| Electron E2E | 首启、八模块、审批/发信确认、异常与工作台 |
| 真实平台 | SJTU/Google/Graph/Notion 授权，Win/Mac 托盘/专注 |
| 安全/恢复 | 越权、提示注入、撤权、重复发信、强退、同步冲突 |

Mock 不能作为真实连接器通过的证据；Windows 测试不能替代 macOS。PR 检查拟包括 Lint、TypeScript、单元/契约/集成、安全扫描和双平台构建。发布候选版再做完整 E2E、校方真实账户、真机紧急退出、性能预算、安装/卸载、数据库升级、签名/公证与自动更新。对 GitHub Actions 采用最小令牌权限及固定经审查的 Action 版本。**此次不会创建 CI 或安装依赖。**

## 依赖、性能、迁移
锁定 Node/Electron/包管理器及 lockfile，安全更新通过评估/测试而非盲目自动合并。后台资源 P0 分冷启动、前台、仅必要后台、长时间运行、OCR/ASR、同步重连测量 CPU/RSS/时延/磁盘流量；具体数字 W4 依真实目标设备定义。数据库 schema 每版提供迁移、事务、备份和失败恢复；测试旧版升级和新旧同步协议兼容，不能随意复制活动 WAL 文件当唯一备份。

## 正式发布门禁
内部测试包必须明确标识；正式 Windows 安装包需满足适用签名与安装测试；macOS 需签名及适用公证，验证发布渠道和更新安全。证书、费用、目标 OS/芯片矩阵目前未落实，不能宣称稳定版发布。MPL-2.0 不变，维护 LICENSE、SECURITY、CONTRIBUTING、AGENTS、架构和决策文件。本归档仅文档，W4 排期与 W5 代码分别获批。
