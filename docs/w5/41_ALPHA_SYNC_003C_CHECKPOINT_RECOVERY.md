# ALPHA-SYNC-003C — 团队历史日志检查点、Cursor 过期与安全重建

> **开发阶段：代码与自动化验证，未部署任何真实 Supabase 项目。** 该迁移涉及历史数据裁剪、成员权限和明文本机缓存，必须经过非作者安全审查与真实多账号测试。本轮保持单 PR、不使用 RDC。

## 003B 的关键缺口

003B 的团队历史日志单调增长。服务端若直接删掉旧变更，断线很久的客户端就会遇到 Cursor 缺口；错误的恢复方式是把本机 Cursor 清零后只取最近 100 条，这会丢失历史、复活已删除的消息，并让旧数据与新数据混杂。

003C 明确区分 **历史增量** 和 **服务端可信、完整的快照检查点**。历史裁剪只允许 workspace Owner 主动触发；客户端使用匿名类型不受信任的服务端响应，严格验证后才切换。

## 受控 SQL 迁移

新增 `supabase/migrations/20261124_ate_workspace_checkpoint_recovery.sql`，依赖原 workspace PoC 和 003B durable journal 迁移：

- `ate_workspace_history_state` 增加 `min_cursor`、`checkpoint_cursor`、`checkpoint_count`，用 SQL CHECK 约束确认低水位不超出高水位。
- 新 `ate_workspace_history_checkpoint`（完整、不可变的当前团队消息和任务快照）启用 RLS，不向匿名/普通客户端授予直接读取/写入权限，**只提供经过当前 JWT 成员核验的只读 RPC**。快照按 (kind,entity_id) 固定排序生成严格递增 `ordinal`。
- `ate_workspace_history_compact(p_workspace_id)` 是**显式、Owner-only**、不在应用 UI/后台自动执行的 RPC：先检查 `auth.uid()` 对应工作空间的 `owner` 角色，在同一 SQL 事务中锁住消息和任务写入表、锁住对应 workspace 计数器，生成完整快照并获得实际行数，推进 `min_cursor`，随后裁剪该检查点之前的历史事件。后续写入的事件依然用递增 Cursor 追加。没有后台 Cron。
- `ate_workspace_history_pull` 向新客户端返回严格的 `{status:"expired",checkpointCursor,serverCursor,totalItems}`，而**不是**隐式重置或偷偷跳跃旧事件。对于尚未过期的游标仍使用 003B 原有返回协议。
- `ate_workspace_history_snapshot` 每页最多 100 条，核验当前 JWT 的 workspace 成员资格以及所请求的 **checkpoint_cursor 必须等于当前服务端存活的版本**。若新的压缩动作替换了旧快照，在途请求显式失败；客户端下次读到新版 expiry 后丢弃旧暂存并重新开始，绝不拼接不同世代的快照。
- 迁移脚本本身**不立即压缩任何数据**，不触碰 Canvas、邮箱、个人任务/日历或 AI Key，也不改已有表的读写 RLS。涉及历史内容的本地/云端存储仍未实现额外加密，绝不能用真实敏感数据作为测试样本。

## 客户端 SQLite v2：先暂存，后原子切换

`study-anchor-team-history.sqlite`（SQLite schema 从 v1 → v2）增加 `checkpoint_progress`、`checkpoint_records`，仍按 Supabase project URL 和用户 ID 派生的分区键、workspace ID 隔离。

一次自动补拉最多 **20 个 RPC 页面预算**，可分多轮继续：
1. 先通过当前用户 JWT 查成员资格；正常 Cursor 仍按 003B 严格增量应用。
2. 若服务端明确返回 `expired`，**保持旧 records 和 cursor 完全不动**，初始化或恢复同一世代的暂存状态，按 `ordinal` 逐页下载完整快照；每条记录的 ID、workspace_id、字段、日期、页序和 totalItems 都通过严格协议校验。
3. 每一页用 SQLite `BEGIN IMMEDIATE` 同时持久化快照记录和下一 ordinal；崩溃或进程终止后读取原 staging 继续，而不是重新传输已完成的页。任何失败回滚整页，不前进位点。
4. 快照尚未完成时，Renderer 不展示有可能过时或被删除的旧缓存，并显示**正在安全重建**提示；也禁止继续分页旧缓存。
5. 所有页完成以后**再次联网复核成员资格**，再在**同一个 SQLite 事务**删除旧 materialized 记录、复制全部已验证的新快照、把 Cursor 切换到可信检查点，清除 staging。只有全部完成，才继续拉取检查点以后的变更和删除墓碑。
6. 新一代服务端检查点出现时只重建 staging，仍不覆盖旧正式记录；若服务器 RPC 缺失、身份不符、Cursor 不连续、快照数量不符或磁盘写入失败，**不回退到不完整的最近 100 条**，也不清空本地位点。
7. 被服务器移除 workspace 成员后，清空该 owner/project/workspace 的**正式缓存及未完成的暂存**，不允许再读取旧历史。云端暂时不可达时同样不能通过历史分页接口访问本机缓存。
8. Owner/project 切换和登出会取消在途补拉，使旧网络请求即便稍后返回，也不能写入新账号的 staging。

## 需要真实验收的风险

- **真实 RLS**：用 5 个独立测试账号确认 workspace 成员只能下载本人有权限查看的快照，非成员及另一 workspace 的 JWT 被拒绝，非 Owner 不能调用压缩。
- **多设备事务顺序**：两个设备并发写入和 Owner 压缩时，锁顺序为写入表 → workspace 计数器，不能遗漏或重复提交。实际测试须验证压缩前后每条消息/任务的一致性与删除墓碑。
- **中断与恢复**：至少生成 2500 条隔离测试记录，A 在快照第 19 页断网后退出，B 继续发送消息并删除旧任务。A 重启先恢复被验证的完整快照，再补拉新变化；不得短暂显示已删除项目。
- **快照替换竞态**：重建期间 Owner 再次执行压缩，旧世代会失效。客户端保留已确认的旧正式记录不变，下一轮遇到新版本后重置暂存。不能把两个世代的页合并。
- **权限撤销**：下载/原子发布前确认成员身份，撤权后拒绝 REST/RPC 访问并删除当前 owner 分区的两个缓存表。操作系统本地直接读取旧明文文件、释放页和未清理 WAL 的安全清除**不受 UI 层保证**，生产级数据擦除及本机加密仍待后续安全设计。
- **容量与锁**：一次完整快照可能复制整个工作空间的数据并在事务期间阻塞团队写入；需要真实统计数据量、锁等待、存储成本，才可以给生产环境设定具体的自动保留/压缩策略。这一轮不会自动执行 `compact` RPC。
- **安装包**：Windows/macOS CI 不能代替真实旧版 Study Anchor 安装升级、Credential Vault 或五账号协作验收。

## 仓库根目录验证

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/shared/workspace-checkpoint-contract.test.ts src/main/cloud/workspace-checkpoint-store.test.ts src/main/cloud/workspace-checkpoint-service.test.ts src/main/cloud/workspace-checkpoint-sql.test.ts src/main/cloud/workspace-history-service.test.ts src/main/cloud/workspace-history-store.test.ts
npm test
npm run build
```

当前状态仍以最新 Windows/macOS GitHub Actions 和独立 Reviewer 结论为准。不得在未通过真实隔离项目验收时把本批次写成生产环境可用。

## 后续

- **003D**：真实隔离 Supabase 五账号/RLS 正反向测试、并发压缩基准、删除后的本机文件加密/安全清理、自动压缩触发与保留上限，必要时进行离线写 Outbox 与冲突处理。
- **KB-005**：同步与隐私主线基本验收后，开始本地 Embedding 语义检索与精确/模糊/向量融合；默认不上传私有知识和向量。


### 后续 003D 的本地隐私改造说明

[42 003D 安全缓存升级](42_ALPHA_SYNC_003D_LOCAL_HISTORY_PRIVACY.md) 在保持本章 checkpoint/cursor 协议不变的前提下，把团队历史 SQLite 升级到 v3：记录正文及未完成快照 JSON 从旧明文迁移到 OS safeStorage 加密；退出/切换账号时清除对应缓存并使在途恢复页失效。**历史 SQLite 备份/旧数据页可能仍含明文**，不宣称物理安全擦除。003C 的真实 RLS/多设备验收仍需独立完成。
