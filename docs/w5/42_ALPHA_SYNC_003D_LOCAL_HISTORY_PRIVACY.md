# ALPHA-SYNC-003D — 团队本地历史加密、账户清理与安全降级

> 2026-11-24 开发批次。此文档描述代码及测试目标，**不代表 Windows/macOS 真机 Keychain/DPAPI、五账号 Supabase/RLS 或存储安全擦除已经验收**。独立的 UI 改版 PR #48 尚未合并；2026-11-24 用户明确允许其继续独立推进、003D 同时提交自己的 PR。分别走审查与 CI，不改写对方分支。

## 威胁模型及目标

003B/003C 的 `study-anchor-team-history.sqlite` 保存消息/任务原文 JSON 和部分未完成的 checkpoint 记录。这些数据不属于个人任务、Canvas、邮件或知识库；它们在成员授权下被下载，但用户退出时旧缓存曾继续停留在磁盘。

本轮改进：
1. **新写入的团队 JSON 正文必须受 OS 加密保护**：Electron Main 注入 `safeStorage`，创建 `sa1:` 版本化加密 payload；如果 `isEncryptionAvailable()` 为 false、Linux 返回不安全的 `basic_text`、加解密失败或 ciphertext 格式非法，**不回退到 Base64/固定密钥/明文**。Main 仍允许其他本地任务/日历/知识库工作，团队面板暂退回当前 JWT 的 REST/RLS 最近 100 条，不会读取旧加密缓存。
2. **SQLite schema v3 原子迁移**：原有 v1/v2 `records.json` 和 `checkpoint_records.json` 全部在同一个 `BEGIN IMMEDIATE` 事务中解析并加密。事务成功后才提升 `PRAGMA user_version=3`；任何异常 ROLLBACK 并关闭句柄，旧文件保持可恢复。Cursor、工作空间/账号分区、时间索引仍保留原有语义，不清零历史、不丢掉未完成快照。
3. **先备份再升级**：Main 在迁移前使用 SQLite Backup API 对旧 schema 创建经过完整性校验的备份，再执行加密转换。注意**旧库和这个升级前备份仍可能包含明文**，它们不是加密备份；不得误宣称整个磁盘现在都加密。请在真实设备验证数据可读、备份外存安全留存之后，再按单独安全擦除方案处置旧资料。
4. **账号退出与切换**：取消所有当前 team-history 在途请求，随后在一个 SQLite 事务内清除当前 Supabase project URL + 账号 UID 分区的正式记录、Cursor、未完成 checkpoint 和暂存行，**不删其他账号数据、不调用服务端删除 RPC**。即使可选缓存坏了，退出账号也不应被阻断；清理失败仅用固定诊断码记录，不输出路径、UID 或正文。
5. **手动清理入口**：认证用户可点击“清除此设备的团队历史”，在确认后通过受信任的 IPC 通道请求同一 Main 清理流程。选择中的工作空间和旧分页 UI 会清空，下一次进入小组才会重新获取。恶意 Renderer 无法传随意 ownerId 或 workspace ID 来跨账号删除：主进程只使用当前已登录 JWT 对应的账号和已验证的项目设置。
6. **删除后尽力截断 WAL**：本机 SQLite 使用 `secure_delete=ON`，完成逻辑删除后尝试 `wal_checkpoint(TRUNCATE)`，不能保证锁忙时完成截断，亦不保证 SSD、操作系统快照、文件系统历史或独立备份可彻底擦除。界面不得将这个动作叫作“安全擦除”。

## 加密边界

- `records.json` 和 `checkpoint_records.json` 的团队**内容**（消息 body、任务 title、所有快照 JSON 字段）由 OS 安全存储加密后写入数据库。工作空间 ID、实体 ID、timestamp 索引、Cursor、checkpoint 计数和 SQLite 文件本身仍可见；不是全盘加密。
- 无法从 Cloud Renderer 或 Supabase 客户端向 JS 配置密钥。安全存储的密钥由本机 OS 用户和 Electron 应用管理；跨设备不能直接复制密文 DB 当作可解密备份。
- Windows 使用 Electron safeStorage 提供的操作系统机制；macOS 则依赖当前 OS Keychain 权限。对已加密的 v3 库，启动时抽样解密正式/暂存区，如果系统钥匙串不可用或密钥改变，关闭本地缓存连接并保留原密文，团队界面降级到当前 JWT 的 REST；不得清空或默默覆盖旧文件。项目尚无真实签名安装包/凭据迁移测试，重装后访问权限可能变化。解密失败时**拒绝显示**，不凭猜测重新加密覆盖旧文件。
- **旧版本留下的数据库页、旧 WAL、迁移前备份与升级前复制的旧应用数据目录仍可能是明文**。本批次没有隐式删除历史备份，也没有物理安全擦除承诺。
- 账号清理只影响 team-history 本机缓存；个人任务/个人同步 Outbox、Canvas、邮件、AI 凭据和远端 team messages/tasks 都不会清除。团队再次查看时须联网并重新通过服务端成员鉴权。
- 不引入第三方依赖、远端 schema 或自动后台上传；003C 所要求的独立 Supabase 真实权限验收依然缺失。

## 测试范围

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/cloud/workspace-history-crypto.test.ts src/main/cloud/workspace-history-privacy.test.ts src/main/cloud/workspace-history-store.test.ts src/main/cloud/workspace-checkpoint-store.test.ts src/main/cloud/workspace-history-service.test.ts src/main/cloud/workspace-checkpoint-service.test.ts src/shared/ipc-channels.test.ts src/main/local-backup.test.ts
npm test
npm run build
```

- 测试用每次会话临时 AES-256-GCM 密钥模拟 OS 加密提供者，并不会生成/提交真实 Keychain/DPAPI 密钥；该测试证明协议、数据库写入及异常处理，不等于 OS 加密供应商安全认证。
- 校验 v2→v3 正式记录/未完成快照加密、损坏凭据或加密失败时 SQLite 整体事务回滚、真实磁盘重启、解密完整性、每条写入加密、恶意 Base64 与明文拒绝、确认清理、跨账号/项目隔离、延迟网络回包不能在清理后恢复旧数据、v1 升级前备份仍可读。
- Windows/macOS GitHub Actions 在 `feat/**` 推送时运行 TypeScript、Vitest 和 Electron 构建；需在 GitHub 工作流得到真实结果后记录，**不得把绿灯理解为真实安装升级验收**。

## 待阻塞的现场验收与下一步

- 使用真实已授权的 Windows DPAPI 和 macOS Keychain 环境测试同账号重启、签名安装/升级、系统锁定钥匙串和禁用 OS 加密的失效路径；确认不会写明文。
- 在**隔离的 Supabase 测试项目**中与五个不同的账号验证成员撤权、断网回包、切换项目、长期恢复、Owner 显式 checkpoint 压缩和 RPC RLS 的正反向权限用例。不能拿真实邮件/Canvas 私密数据填测试库。
- 设计老的明文备份处置流程（安全备份/用户审查/物理擦除条件）和团队保留策略。未来若需自动过期，必须有可恢复的过期 Cursor 机制并先进行真实数据保护评审。
- UI 视觉改版 PR #48 与本轮使用不同的源文件范围；用户已允许这两项工作并行，但两项 PR 应保持不同源文件范围、独立审查，不擅自修改其贡献者的分支。
