# W5-4 Canvas 作业导入与增量对账

状态：PR 审阅中；CI、真实设备与学校 API 验收状态单独追踪。

## 范围
任务 CAL-004、CAL-005（去重和远端更新）、CAN-006（部分）。

从「数据接入 → Canvas → 课程 → 作业」中点击 **导入任务**，明确选择某一条 Canvas 作业进入个人任务与日历。不会因浏览、读取课程、连接账号而自动导入。

「同步已导入作业」只处理当前课程、当前学校实例、当前 Canvas 用户已导入的作业；不会创建新任务，也不会清空已删除的远端项目所对应的个人任务。

## 单一权威任务数据源

所有任务依旧由 M1 的本地 SQLite `tasks` 表管理。Canvas 只负责提供外部课程/作业数据，不直接持有独立任务副本。

新增 SQLite v2 表 `canvas_assignment_links`：
- `instance_origin + account_id + course_id + assignment_id` 是外部自然主键；
- `task_id` 唯一关联本地 `tasks.id`，删除本地任务后外部关联级联删除；
- `remote_title` 和 `remote_due_date` 保存上次同步的外部字段快照；
- `source_url`、`last_synced_at`、`missing` 用于来源追踪和状态判断。

在 SQLite v1 上按事务执行 v2 迁移，不直接更改旧任务表结构、旧任务 ID、专注记录和用户备注。打开未来版本数据库仍然拒绝写入。

## 同步冲突策略

| 字段 | 首次导入 | 后续同步 |
|---|---|---|
| 标题 | Canvas 标题 | 只有当本地标题等于上次远端快照时才更新；否则保留个人修改 |
| 截止日期 | Canvas due_at 转换为本地日期 | 同上；保留用户手动更改的日期 |
| 备注 | 初始为空 | 永不被 Canvas 覆盖 |
| 优先级 | 普通 | 永不被 Canvas 覆盖 |
| 完成状态 | 未完成 | 永不被 Canvas 覆盖 |
| 来源、上次同步时间 | 记录 Canvas 原始身份 | 保留来源并更新同步快照 |
| 远端缺失 | 不适用 | 标记 missing 并计入报告；绝不静默删除本地任务 |

同步不会执行 Canvas 写操作、修改课程、提交作业或更改学校原始数据。

## 安全与账号隔离

- Main 进程通过已授权 Token 请求 `/api/v1/users/self`，识别实际 Canvas 用户 ID。
- 导入 IPC 仅接受课程和作业数值 ID；Main 自行查询 Canvas 的最新作业，不信任 Renderer 传入的任务正文或链接。
- 账号隔离键为 Canvas origin + 用户 ID + 课程 ID + 作业 ID，避免同一实例不同账号之间相互覆盖。
- Token 仍只在 Main 和系统加密文件中使用；不出现在 SQLite 任务来源、Renderer、GitHub 或团队空间。
- Canvas 作业在未获得用户逐项同意前绝不写入本地任务。仅开发者本人使用个人 Token 本地验证，五人 OAuth 仍待 Developer Key。

## 自动化与实际验收

CI 使用模拟 Canvas HTTP 回复验证用户身份接口，以及真正的 SQLite 内存和磁盘迁移：
- 同一作业重复导入只能生成一条任务；
- 相同实例不同 Canvas 账号记录独立；
- 手动改截止日期、备注、优先级、完成状态后同步仍保留；
- Canvas 标题变更可在未手动编辑的情况下更新；
- 远端作业消失不删除任务；
- 删除本地任务后可由用户主动重新导入；
- 原有 SQLite v1 数据迁移到 v2 不丢失旧任务。

真实验收仍须开发者本人在 Windows/macOS 测试设备，使用合法 Canvas Token 亲自连接、导入一条真实作业、编辑任务、重新同步并检查内容。CI 不代表学校 API 实际调用已通过。

## 尚未完成

- Canvas OAuth 多用户、Developer Key 申请审批；
- 自动定时同步、后台同步和同步游标；
- 完整状态标记、学校撤权后的数据清理策略、逐文件云同步；
- 真实 IMAP/SMTP 收发、五人云端 Workspace；
- 数据库迁移前自动快照备份和完整恢复 UI。

本 PR 不新增依赖，不使用 RDC，不安装软件到用户个人设备；构建与单测只在 GitHub CI 的临时 runner 上运行。
