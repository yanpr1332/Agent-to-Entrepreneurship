# ALPHA-SYNC-002G：个人同步跨 SQLite 拉取检查点与崩溃重放

> 状态：单一开发 PR 待 Windows/macOS CI 和非作者 Review。无 Supabase 云端迁移、无后台自动同步、无真实设备或五账号 RLS 验收。

## 背景

过去一页云端增量按如下顺序处理：将个人任务写入 `ate-local.sqlite`，再将手动日历写入 `ate-fixed-calendar.sqlite`，随后记录本地冲突，最后更新任务库 Cursor。如果应用在两个数据库提交之间崩溃，Cursor 尚未推进但一个本地库已持久更新，后续依赖重新向云端请求原页和重放。若随后服务器不可用，恢复入口不明确；还可能在准备上传本地队列前忽略上一次部分应用的页面。

## 本轮实现：ALPHA-SYNC-002G

1. **任务库 schema v9 → v10**：新增唯一按 `owner_id` 隔离的 `personal_sync_pull_checkpoints`（设备 ID、原 Cursor、目标 Cursor、经过严格解析的完整页、创建时间）。Migration 在事务中执行。App 启动会先对需要升级的 `ate-local.sqlite` 做 WAL-aware 且经 `PRAGMA quick_check` 验证的原库快照。日历库 schema 保持 v5。
2. **拉取前写入检查点**：仅接受当前 owner / device / fromCursor 匹配且 1–200 条、严格递增、符合白名单的页面。检查点先在任务库的独立事务提交，才会触碰两库实际内容。每账号始终只有一个未完成页。
3. **两库应用与冲突持久化**：复用原有 task/calendar source 白名单、版本判断、冲突保存、日历容量/学习计划保护；不能因为没有全局事务而默认把失败视为成功。
4. **Cursor 与检查点原子提交**：两库和冲突记录都返回成功后，任务库在一个事务里 CAS 校验设备 ID、起始 Cursor、检查点目标 Cursor，并同时推进 Cursor 和删除已完成检查点。不允许跳过、清空或回退。
5. **重启先重放**：用户重新登录后下一次手动点击同步，Main 先按当前 owner 检查有没有上次尚未完成的页面；存在时从本地检查点重新应用，不需要从云端重新下载这页；随后进入正常设备注册、只读预检和剩余增量拉取。重放任务/日历版本幂等，不扩大同步实体范围。
6. **恢复当轮暂缓上传**：若恢复时仍有待上传内容，整轮保留 Outbox 且先拉取。给 Renderer 的 `recoveredPages` 只表示本次重放并完成了几个检查点，不代表其他云端变更已全部同步。用户检查冲突/待发送状态后再主动点击同步。
7. **损坏数据失败关闭**：检查点 JSON 不符合已审定协议、设备 ID 或起始 Cursor 不一致，直接拒绝任何上传、自动修复或轮换设备。显式设备更换 UI 不可越过未完成检查点；Main/Renderer 不允许输入 owner、Cursor 或检查点 JSON。
8. **强化 signed bigint 限制**：`nextCursor` 和每条 `change.cursor` 必须在 PostgreSQL signed bigint 范围；防止过大的 Cursor 进入本地持久状态。

## 可执行验证（仓库根目录）

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/personal-sync-pull-recovery.test.ts src/main/personal-sync-device-replacement.test.ts src/main/personal-sync-preflight.test.ts src/main/personal-sync.test.ts src/main/local-store.test.ts src/main/fixed-calendar-store.test.ts src/shared/personal-sync-contract.test.ts
npm test
npm run build
```

测试覆盖：真实磁盘 SQLite 文件重开；任务提交后日历崩溃并恢复；冲突记录失败后重放；Cursor 与检查点同事务提交/失败后不提前推进；旧 v9 → v10 迁移；不同 owner 隔离；伪造设备/损坏 JSON/错误 Cursor 禁止处理；阻止未完成页面期间更换设备；signed bigint 越界拒绝。Windows/macOS GitHub Actions 需分别通过。全套 CI 只证明离线模拟和桌面构建，**不等于真实 Supabase RLS、五账号或两台真机联机成功**。

## 限制与后续

- 这不是 PostgreSQL + 两个 SQLite 的分布式原子事务。本轮使用持久检查点与幂等重放以恢复中断页；检查点提交后到全部应用完成之间仍可能出现暂时部分本地可见的内容，后续需要进一步隔离/冻结 UI 或更强的快照策略。
- 云端已接受但 ACK 丢失的 Outbox 仍依赖原有 operationId 幂等回执；本轮不自动改写旧 operationId 或在设备撤销后猜测请求结果。
- Cursor 损坏、超前或服务器历史已裁剪时不能直接清零；需要具备离线备份、服务器权限验证和与所有本地覆盖字段核对的单独恢复流程。
- 真正的双设备、断网/撤权、五账号 RLS、跨平台 GUI 与安装包验收仍阻塞，禁止宣称 Alpha 正式通过。云端 schema 和服务没有自动部署。
