# ALPHA-SYNC-003B：团队历史变更日志、持久 Cursor 与断线全量补拉

> 状态：一个开发 PR，需 Windows/macOS CI、非作者 Review、隔离 Supabase 迁移审核及真实五账号测试。本批次不部署 SQL、不测试用户真实账号、不开第二个 PR、不使用 RDC。

## 为什么不能仅靠 Realtime 和最新 100 条

003A 通过 Realtime 触发 REST/RLS 刷新，每 10/30 秒轮询保证最近窗口，但断网期间若超过 100 条消息/任务变化，简单重新读取最新 100 条无法恢复完整历史，也无法表达已删除的任务。本轮把 **服务器可信变更序号 + 本机原子应用** 作为权威补拉路径，Realtime 仍只负责通知。

## 服务端变更日志

新增 `supabase/migrations/20261124_ate_workspace_durable_history.sql`，基于既有 `20261110_ate_workspace_poc.sql`：

- 新建 `ate_workspace_history_state`（每个 workspace 的单调递增 `last_cursor`）和 `ate_workspace_history`（`workspace_id,cursor,kind,action,entity_id,entity_payload`）。历史记录包含消息/任务行的 JSONB 快照；DELETE 为 `record: null` 墓碑。**不会**记录成员、邀请、Canvas、邮箱、AI 密钥或个人本地内容。
- 变更计数由同一 workspace 的计数器行 `INSERT .. ON CONFLICT DO UPDATE` 锁定，锁直到事务 COMMIT：不同事务不能在同一 workspace 中乱序提交更高 Cursor。不能以 PostgreSQL 自增 sequence 直接当可靠提交顺序。
- 迁移用独立事务在持有消息/任务表写锁时，为已有行生成有序初始快照，并在同一事务中安装 AFTER INSERT/UPDATE/DELETE trigger，不会在回填与触发器安装之间丢失写入。检查已有 journal 避免重跑全部旧消息。
- `ate_workspace_history_pull(p_workspace_id,p_after,p_limit)` 使用 SECURITY DEFINER、空 search_path、`auth.uid()` 和 `ate_is_member` 对当前工作空间做成员鉴权，按 Cursor 严格升序，每页最多 100 个变更，返回服务器高水位、nextCursor 和 hasMore。Cursor 越过服务器高水位拒绝。
- 不授予客户端直接读取或写入历史/计数表的权限；RPC EXECUTE 仅授予 `authenticated`。既有工作空间 RLS 不修改，也不使用 service_role。
- 本迁移不包含日志清理/压缩：在推出任何删除或保留策略前，必须设计“历史被裁剪/游标过旧”的拒绝与全量安全重建，否则会跳过变更。**永久增长的日志不是最终生产级存储方案**。

## Electron 本地历史缓存

新增独立 `ate-shared-history.sqlite`（schema v1），内容为历史消息/任务的 materialized rows 和每工作空间 Cursor。**同时由项目 URL 与账号 UID 派生隔离键**，不会把不同 Supabase 项目中相同 UUID 的工作空间视为同一份缓存。项目 URL 仅用于派生分区键，访问仍要求当前有效登录。

每次补拉：
1. Main 首先通过当前用户 JWT 的 REST 接口重新获取成员，确认 `user_id` 存在；若已撤权，删除对应隔离分区中的本地历史行及 Cursor 并拒绝显示。
2. 读取本机历史 Cursor，请求服务端下一页（最多 100 条）。所有记录必须是完全已知的类型与字段、workpace/entityId 匹配、Cursor 严格连续且不超出服务器高水位；重复/缺项/伪造额外字段/非标准 bigint 均拒绝。
3. 单个 SQLite `BEGIN IMMEDIATE` 事务应用任务/消息快照与删除墓碑，并 CAS 推进 Cursor；任何异常回滚整页，不跳页、不清空。
4. 单次网络刷新最多 20 页（2000 条），若仍有历史，界面提示尚未追上，下一轮从持久 Cursor 继续。重启后读取本机文件继续，不要求云端重复传输已确认的完整页。
5. 进入工作空间显示最近 100 条**已同步历史**，新增“加载更早消息/历史任务”从本机缓存按 `created_at,id` 键集分页（每次最多 100）。实时新变更包含墓碑时，先清掉旧的已展开历史 UI，防止已删除项继续可见。
6. 缺少可选的新 RPC（明确 HTTP 404）时退回 003A 的 REST 最近 100 条方案，**不读取过时的本机历史缓存**；网络断开、401/403、Cursor 错位、JSON 协议损坏时不得伪装为兼容模式或自动重置。
7. 退出账号/切换测试项目时取消在途补拉；旧请求即使延迟返回，也不能应用至新会话。分享历史缓存不保存 JWT、刷新令牌或 Supabase 密钥。

## 隐私与安全事项

本机新增文件会以普通 SQLite 保存当前账号在已授权小组中的消息正文和任务内容，**没有额外端到端加密**，不适合在不受信任的共享设备上把本机文件当作安全加密存储。首次正式启用前需要明确告知本机磁盘留存行为，并评估本地加密/设备撤权时清理策略。登出后缓存仍在磁盘上但**客户端接口不允许无当前成员验证就读取**；获得系统级磁盘访问权限的人不受此 UI 限制。

SQL migration 可能持有表写锁进行一次性回填，正式库执行前须另行评估最大数据量和维护窗口；本轮仅供隔离测试项目审核使用。

## 本地自动化命令

在仓库根目录运行：

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/shared/workspace-history-contract.test.ts src/main/cloud/workspace-history-store.test.ts src/main/cloud/workspace-history-service.test.ts src/main/cloud/workspace-history-sql.test.ts src/main/cloud/workspace-realtime.test.ts src/shared/ipc-channels.test.ts
npm test
npm run build
```

自动化目标：超过 100 条历史在三页及跨重启恢复、文件级模拟回滚、同一条任务的多次 upsert 与 DELETE 墓碑、owner/project 隔离、非法 Cursor 及不连续页拒绝、成员撤权后删除缓存、断网/HTTP 404 兼容与未授权 403 不降级、在途账户切换、最多 20 页有界补拉、精确 SQL 权限/表白名单静态检查。

## 必须单独进行的真实验收

- 用户提供并授权一个**独立 Supabase 测试项目**，审核并运行原 workspace PoC migration、003A Realtime publication migration、003B journal migration。记录真实 RLS 正/反向测试，不使用生产数据。
- 在迁移之前建立历史 A 组的消息与任务，确认回填保留所有旧行；并在迁移后由五账号产生超过 100 条跨设备变更，核对分页 Cursor、乱序、并发提交顺序、删除、重连和停机恢复。
- 撤销某成员权限，确认其 JWT 无法查询日志或读取旧分页，应用下一次成员验证清理本机缓存；另一 workspace、另一账号/另一 Supabase 项目 UUID 不得读到旧内容。
- Windows/macOS 实际 GUI 观察超过 100 条历史分页、30 秒补拉和断网恢复。校验安装包更新、数据库备份/损坏恢复、日志和授权撤回后原文件残留；以上未通过前不声称 003B 真机验收完成。

## 继续开发

- **003C**：服务器变更日志裁剪与 cursor-too-old 完整恢复协议、删除/成员撤权后的本机敏感数据清理/加密、真正五账号 RLS 与授权变更即时生效、多个工作空间网络负载。
- **003D**（如需）：离线写入队列、跨多设备冲突规则、长历史查询/搜索优化及发送状态。
- 同步主线基本可靠后才开始本地 Embedding 模型 + 精确/模糊/向量搜索融合。


## 可选缓存损坏时的非致命降级

如果 `ate-shared-history.sqlite` 不能打开（文件损坏/来自未来版本/权限异常），Main 记录固定诊断代码，但**不得因为这个可选团队缓存而让本地任务、日历、Canvas、邮件、知识库整体无法启动**。团队界面暂时退回 003A 的当前 JWT REST 最新 100 条补拉；历史分页按钮不启用。程序不覆盖/清零损坏文件。修复或迁移该独立文件需单独备份和人工验证。
