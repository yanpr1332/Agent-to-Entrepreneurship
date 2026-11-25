# ALPHA-CLOSE-04A：Supabase 部署前只读预检

**Windows 逐步操作版：[59 五账号项目创建与真实验收](59_SUPABASE_FIVE_ACCOUNT_WINDOWS_WALKTHROUGH.md)。** 第七个迁移修复记录见 PR #67：旧版函数美元引号有语法错误，须在完成独立 Review 与合并后使用修正文件。

本轮先补齐隔离项目的可重复部署准备，**尚未登录、部署、联机或验证真实 RLS**。绝不将 GitHub Actions 模拟/静态检查当成五人云端验收。

## 一、本机只读预检

在仓库根目录执行：

```sh
npm run preflight:supabase
node --test scripts/supabase-alpha-preflight.node.mjs
npm run test:sync-rls
```

预检使用本机 `supabase/migrations` 下已审查的八个 SQL 文件，检查文件缺失、额外未审查 SQL、危险的 RLS 关闭或宽泛授权、核心表的 RLS 声明及历史 Cursor/Checkpoint 关键字。**仅字符串启发式检查，不是真正 SQL 解析器或权限证明**。它没有网络请求，不读取账号凭据，不连接数据库，也不执行迁移。新增迁移必须独立审查后更新清单及测试，缺失/异常会使 CI 失败。

按依赖手动核对并部署，前置基础优先：

1. `20261110_ate_workspace_poc.sql`（workspace 表/RLS/RPC）
2. `20261124_ate_personal_sync.sql`（个人任务和手动日历同步协议）
3. `20261124_ate_personal_sync_recovery_inspect.sql`（同步诊断 RPC）
4. `20261124_ate_workspace_realtime_hints.sql`（Realtime publication）
5. `20261124_ate_workspace_durable_history.sql`（持久增量日志）
6. `20261124_ate_workspace_checkpoint_recovery.sql`（检查点恢复，依赖 durable history）
7. `20261125_ate_workspace_member_revoke.sql`（owner-only 撤权与旧邀请码失效，见 [57](57_ALPHA_CLOSE_07_TEAM_CANVAS_RELEASE.md)）
8. `20261125_ate_personal_file_sync.sql`（V0.2 小文件私有 Bytea/RPC CAS 试点，见 [61](61_V02_02_CONSENTED_FILE_SYNC.md)，不由旧五账号脚本验收）

**这只是审查顺序**，不能盲目在已有数据的项目上重复部署；管理员必须先查看项目当前迁移状态、已存在表和备份，再选择实际需要的文件。只能用于用户授权的隔离非生产 Supabase 项目；不允许将 service_role/secret key 输入应用或任何测试脚本。

确认项目性质及逐份独立审查后，可以在个人终端设置 `STUDY_ANCHOR_TEST_PROJECT_CONFIRMED=ISOLATED_NON_PRODUCTION` 和 `STUDY_ANCHOR_MIGRATIONS_REVIEWED=YES` 让预检显示人为确认提示；**变量不会触发任何自动部署，也不是授权凭证**。

## 二、五账号真实 RLS 验收（阻塞中）

管理员在隔离测试项目部署相应 SQL 后，准备五个独立账号 A–E，在本地秘密环境提供 `ATE_POC_URL`、`ATE_POC_ANON_KEY`、`ATE_POC_{A,B,C,D,E}_{EMAIL,PASSWORD}`，并主动设置 `ATE_POC_CONFIRM_WRITES=CREATE_DISPOSABLE_TEST_WORKSPACE`，然后运行：

```sh
node scripts/sync-rls-acceptance.mjs
```

这是**会创建测试空间及消息/任务**的真实网络验收，不在 CI 自动运行。脚本会拒绝 service_role/secret key、非 Supabase HTTPS 地址以及同账号重复登录；检查外部账号不可读写、作者冒充受拒、五人加入及共享任务。当前脚本还测试 owner 撤销 B 后的旧 JWT 读写和旧邀请重放；**但不覆盖真实 GUI 中两台设备断网/重连、离线缓存清理和历史 Cursor 恢复**，这些必须独立手工验收。禁止将 Token、密码、邀请码、私人内容或完整响应上传 GitHub；只保留时间、SHA、项目匿名代号、用例结论与脱敏日志。测试资源应在人工确认后由项目管理员清理。

## 三、下一步实测与阻塞项

- **Blocked**：没有用户明确授权的隔离项目、五个独立账户及迁移执行许可；不能宣称五人 RLS/Realtime 成功。
- **待真实测试**：团队撤权后的旧 JWT 访问、历史 Cursor 过期/恢复、个人任务跨设备冲突/回执、断线重连/幂等、设备撤销、团队消息任务真实 Realtime 与回退。
- **待真机**：Windows/macOS 打包安装与 Supabase 联机、跨账号缓存清理与备份恢复。
- 本教程的所有自动化命令都不会部署 SQL；云端迁移仅在管理员对隔离项目进行明确审核和人工执行时发生。第七份 SQL 语法修复需审核 PR #67，不能把本地静态检查误当成数据库部署成功。
