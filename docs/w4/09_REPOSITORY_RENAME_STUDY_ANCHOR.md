# REPO-RENAME-001：Study Anchor 仓库及完整桌面品牌迁移

> 更新日期：2026-11-24。原 PR #47 同一分支扩展范围：用户明确要求一并更换安装包标识及数据文件名。**仍待非作者 Review、Windows/macOS 安装升级实测。**

## 新身份

| 类型 | 新值 |
|---|---|
| GitHub 仓库 | [`yanpr1332/study-anchor`](https://github.com/yanpr1332/study-anchor) |
| 根 npm 包 | `study-anchor` |
| UI、HTML `title`、W2 原型 | **Study Anchor** |
| Electron Builder `productName` | `Study Anchor` |
| Electron Builder `appId` | `org.studyanchor.desktop` |
| 默认用户数据目录 | Windows: `%APPDATA%\\Study Anchor`；macOS: `~/Library/Application Support/Study Anchor` |
| 自定义目录环境变量 | 优先 `STUDY_ANCHOR_USER_DATA_DIR`，继续支持旧 `ATE_USER_DATA_DIR` |
| 迁移后 SQLite | `study-anchor-tasks.sqlite`、`study-anchor-knowledge.sqlite`、`study-anchor-calendar.sqlite`、`study-anchor-planning.sqlite`、`study-anchor-ai-usage.sqlite`、`study-anchor-mail.sqlite`、`study-anchor-team-history.sqlite` |
| 加密凭据文件 | `study-anchor-ai.enc`、`study-anchor-canvas.enc`、`study-anchor-campus-mail.enc` |
| 诊断文件 | `study-anchor-diagnostics.jsonl` |

原 `ate_*` Supabase 表、函数、迁移 SQL 文件名**属于服务端协议，不在此次本地文件/安装包改名范围内**。为保持数据库协议兼容，不得仅凭仓库更名而修改云端表或重新部署 RLS。

## 旧用户数据的无损迁移

**升级前必须完全退出旧版 Electron 应用，并做好外部备份。** Windows/macOS 旧程序若仍在使用同一 SQLite/Keychain，无法保证无丢失的快照时间点。迁移先于任何新数据库构造、凭据加载、自动同步或 Renderer 创建执行；失败时停止启动并提示人工检查，不会回退到空白账户。

默认安装路径：程序从以下历史候选目录寻找实际存在旧数据文件的一个来源：`Agent to Entrepreneurship`、`Agent-to-Entrepreneurship`、`agent-to-entrepreneurship`。若发现多个来源或新的 `Study Anchor` 目录已经存在非空数据且无迁移标记，**拒绝自动合并或覆盖**。旧目录不会删除、移动或改写。

迁移在同一父目录构建私有 staging，使用 SQLite 在线 Backup API 创建一致的快照，包含旧 `-wal` 中已提交内容；其余配置、浏览器本机 Local Storage、`backups` 文件夹、加密凭据等逐项复制。**跳过旧 SQLite 的 WAL/SHM/JOURNAL sidecar**，新 DB 已由一致快照生成。无软链接跨路径复制，以防误读外部资料。验证每个 SQLite 的完整性后，先写入迁移标记，然后将整个 staging **原子改名**为新用户数据目录；若失败，原目录仍完整保留。

显式自定义目录：为尊重 `STUDY_ANCHOR_USER_DATA_DIR` 或 `ATE_USER_DATA_DIR` 指向的原目录，不改变目录路径。先在同级 staging 创建旧 SQLite 的新命名备份和凭据副本，确认目标没有新旧文件冲突后，再放入指定目录并写入迁移完成标记。此路径无法获得跨多个文件的原子目录替换，但普通异常会回滚本轮已复制的目标文件，旧文件始终保留。**如果进程在逐文件提交期间强制断电、导致新旧文件并存且缺少标记，下一次启动会阻止自动混合，请先从完整外部备份恢复或人工处理。**

迁移完成后**旧资料仍留在原目录或原文件名下**，这样可以手动回滚。但不应继续交替使用新旧版本写入同一套资料，避免两套数据产生分叉。旧数据的清理必须在跨平台升级验收和备份核查后单独进行。

## 凭据/安装升级边界

即使加密凭据文件原字节安全复制，Windows DPAPI 或 macOS Keychain 的解密授权也**可能**受到应用签名/Bundle ID 变更影响。不要在迁移过程中将凭据转为明文、上传云端或自动提交。首次升级后要人工验证 Canvas、校园邮箱及 AI Key 是否仍可用；若 OS 拒绝读取，按现有连接页面重新授权；旧密文原件保留。请勿把真实密钥写入 Issue/PR/CI。

改变 `appId` 后，Windows 安装器/旧快捷方式及 macOS 应用包可视为不同程序，**不会自动卸载旧程序**，也不保证新旧两版共存时行为一致。实际安装、卸载、签名、快捷方式升级和开发者 ID 必须在 Windows/macOS 真机分别人工验收；GitHub Actions 只构建源代码，并未跑安装包升级流程。

## 迁移失败与手动恢复

若程序提示「Study Anchor 数据迁移已暂停」：
1. 不要删除旧的用户数据文件、`-wal`、`-shm`，也不要执行 `git reset --hard` 试图修复数据库；
2. 彻底退出旧/新 Electron 进程，确认两个应用目录中哪一份有**实际内容**；如果两份都非空或发现 `.study-anchor-migration-*`，先单独备份，禁止自动合并；
3. 检查文件权限、剩余磁盘空间和同步盘/杀毒软件占用；使用真实数据前，在隔离目录复现并通过 SQLite integrity_check；
4. 自定义目录可在**确认旧版本已退出且新命名文件未被使用**后通过可核验备份恢复；若涉及并发写入或不同版本的数据分叉，应停用自动迁移并人工选择权威资料，不能简单覆盖。

如果你之前的本地仓库仍使用旧 Git 远端地址，在已有本地仓库中运行：

```sh
git status --short
git remote set-url origin https://github.com/yanpr1332/study-anchor.git
git remote -v
git switch main
git pull --ff-only
npm ci
npm run typecheck
npm test
```

本地 Git 目录名称与 Electron 应用数据目录是**两件不同的事**：GitHub 仓库改名不会改动你的电脑上 `cd` 目录。

## 验收命令和状态

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/profile-migration.test.ts src/main/repository-identity.test.ts src/main/user-data-override.test.ts src/main/local-backup.test.ts src/main/diagnostics.test.ts
npm test
npm run build
```

- CI 自动化验证：迁移映射、WAL 一致快照、旧目录不被删、冲突拒绝/多来源拒绝、显式目录副本、npm 包名、Electron 新 app ID 和产品显示名。
- 真机必须检查：旧版任务/专注/日历/知识库/规划/邮件/团队历史及用户主题是否迁移完整，凭据解密、Windows/macOS 实际安装路径、卸载和回滚；**未执行前不能将真实升级标记为已验收**。
- 同一 PR 至少一名非作者审查；因更改安装标识和本地数据库，需要额外安全/迁移审查。自动化测试成功不表示所有旧安装用户已经安全迁移。
