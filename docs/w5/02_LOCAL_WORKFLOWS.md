# W5 下一轮：本地任务、日历、专注与工作台

> 目标：W5-1 本地存储切片与 W5-2 的 M1/M3/M8 可运行最小闭环。状态以 PR / CI / 人工设备验收为准。

## 任务映射

| W4 Task ID | 本轮实现 | 验收证据 |
|---|---|---|
| APP-003（部分） | 本地 SQLite 初始 Schema、版本迁移、WAL 模式、重启恢复 | local-store.test.ts 真实文件往返测试 |
| CAL-001 | 本地任务创建/编辑/删除/完成、优先级、说明与截止日期 | SQLite 集成测试 + 手动 UI 验收 |
| CAL-002（部分） | 月历视图、按日期过滤任务、无日期/全部任务 | calendar.test.ts + 手动 UI 验收 |
| FOC-001 | 专注开始/暂停/恢复/提前结束/保存完成 | 手动计时 UI 验收 |
| FOC-002（部分） | 专注历史、积分累计、唯一会话 ID 防重复记录 | SQLite 集成测试 |
| DASH-001（部分） | 真实个人任务与专注汇总，基础明暗主题 | 手动 UI 验收 |

本轮不宣称完成 ICS、Canvas 课程同步、奖励兑换、系统强制专注、五人云端工作空间、知识图谱、真实邮件或 AI。

## 技术选择与安装边界

- 使用 Electron 45 内置的 Node.js 24 的 `node:sqlite` 与 `DatabaseSync`，**不添加第三方 npm 依赖**，不更改 `package.json` 或锁文件。
- SQLite 数据文件由 Electron 主进程创建于 `app.getPath("userData")/ate-local.sqlite`。连接开启 WAL 与外键约束。
- 每个任务 UUID 为本地唯一 ID；个人任务只由主进程的 LocalStore 写入。
- 所有数据库操作仅通过 Main 里的经过验证的窄 IPC handler 暴露给 Renderer；不开放任意 SQL、文件系统或 shell。
- 输入校验在主进程再次执行，阻止异常字段、无效日期、无效优先级和超长内容。
- UI 不使用后台服务，也不上传个人任务或专注记录。
- 本轮只通过 GitHub 接口写入仓库；已存在的 CI 在 GitHub 托管的临时 runner 上使用既有锁文件运行检查。**没有在用户电脑上安装任何新依赖或使用 RDC。**

## SQLite Schema v1

```text
tasks:
  id (UUID), title, description, due_date (YYYY-MM-DD or NULL),
  priority (low/normal/high), completed (0/1),
  created_at, updated_at

focus_sessions:
  id (UUID, idempotency key), planned_minutes,
  elapsed_seconds, completed (0/1), points,
  started_at, ended_at
```

数据库使用 `PRAGMA user_version` 做迁移版本控制；发现未来版本的数据库时拒绝打开，避免旧版本应用写坏新数据。**自动备份、加密存储、恢复 UI 还未实现**，属于 W5 后续工程门槛，不能把基本持久化等同于完整备份体系。

## 积分规则

完整专注满预设分钟数，按 1 分钟 = 1 积分记录（可在正式奖励规则设计时调整）；未满计划时记录实际专注分钟数，但不奖励积分。

每个会话 UUID 在数据库中有唯一约束；同一会话重复通过 IPC 上报，只会保存一次，不会重复增加积分。

## 本地 UI 验收（后续真实设备操作）

1. 进入日历页，新增「完成项目报告」、选择截止日期和优先级。
2. 切换到目标日期，确认月历标记出现，任务可见。
3. 修改标题/备注/日期并完成任务；刷新列表仍正确。
4. 关闭 Electron 再次启动，任务仍存在。
5. 专注页选择 1 分钟，启动/暂停/继续计时；完成后保存记录。
6. 检查积分 +1；重复提交同一 sessionId 不重复计分。
7. 提前结束一次专注，确认积分 +0 且历史有记录。
8. 工作台显示待办、今日截止任务、累计专注分钟和积分的真实数值。
9. 切换浅色/深色主题，重新打开应用后主题仍保留。
10. 在 Windows 与 macOS 上分别执行以上流程。CI 的构建成功不能替代真实设备交互验收。

## 风险与后续任务

- Node 内置 SQLite 当前为 Release Candidate API；已在既有 Node 24/Electron 45 路线中可用，但仍需 Windows/macOS 真实 Electron 运行和性能验证。
- 当前为同步 SQLite API，在本地短操作中使用；大文件、批量索引和长事务未来迁移到 Worker / Utility Process 以避免阻塞 UI。
- 初始数据库没有跨版本迁移备份流程；正式迁移前应建立快照、校验和失败恢复。
- 专注计时运行期间关闭应用不会生成完整记录；下一阶段应考虑持久化中断会话和故障恢复。
- 团队数据并不写入本地个人表；未来云协作按 W3 权限与冲突策略采用独立权威数据源。
