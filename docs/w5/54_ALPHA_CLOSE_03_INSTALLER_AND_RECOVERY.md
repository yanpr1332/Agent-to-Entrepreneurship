# ALPHA-CLOSE-03：五人 Alpha 内部安装包与数据恢复

> 2026-11-25，接续已合并的 #60、#61、#48；为 [51 五人内部 Alpha 总计划](51_V01_FIVE_PERSON_ALPHA_CLOSEOUT.md) 的第 3 轮。双平台 CI、安装包制作、实际 GUI 安装/恢复是三个不同的验收门槛。

## A. 未签名内部安装包

当前 Electron Builder 的 Windows 目标是 NSIS EXE，macOS 是 DMG+ZIP，产品名称 Study Anchor、appId org.studyanchor.desktop 不变。

新增手动 workflow：.github/workflows/internal-alpha-installers.yml。仓库维护者打开 GitHub Actions → Build internal Alpha installers (manual, unsigned) → Run workflow，选择已审查分支/commit。Windows/macOS 原生 Runner 各执行 npm ci、npm run build（TypeScript、Vitest、Electron bundle、离线 Worker smoke），再仅为本平台打出未签名安装包。没有自动发布、发版 tag、生产数据库或签名凭据。

scripts/verify-internal-installer.mjs 检查实际产物存在、名称和体积，为每个 EXE/DMG/ZIP 计算 SHA-256，并生成 release/SHA256SUMS.txt 和包含精确 Git commit 的 BUILD_EVIDENCE.json（signed=false/notarized=false）。上传 actions/upload-artifact@v4 的 7 天限期内部文件；五人团队只应分享受审查的构建，下载后使用操作系统工具核对 SHA256SUMS。

也可在各自本机运行 npm ci、npm run dist:win（Windows）或 npm run dist:mac（macOS），然后运行 node scripts/verify-internal-installer.mjs win 或 mac。安装包位于 release/。在真机安装、重启、卸载与再次启动前**不能宣布安装通过**。Windows SmartScreen/macOS Gatekeeper 可能对未签名包警告，须按合法设备/学校安全策略审核；不要全局关闭系统安全保护。签名、公证、自动更新和公开商店分发不在本轮。

## B. 五库备份范围与格式

知识库页面原有“备份本地数据库”会通过 Node SQLite 在线备份 API，在 userData/backups 下创建新目录。现为 manifest schema 2，含 databases 列表和 files 数组：每库 name、bytes、sha256、userVersion；包含任务/专注、邮件头、知识与复习、学习规划、固定课程/日历共五个 SQLite 文件。创建后执行 PRAGMA quick_check。

**备份没有额外加密**，可能含个人任务/课程原文/邮件主题；请放在受控且最好加密的磁盘，不要公开分享、直接上传网盘或提交 GitHub。**不包含**：加密 API Key、Canvas/邮箱凭据、团队历史缓存、AI 使用计费账本、硬盘原始资料、离线模型文件及本机 Local Storage UI 偏好。因此这不是全设备克隆，恢复后要重新授权账号。

原有 manifest schema 1（包括 migration 前快照）只支持只读 SQLite quick_check 和现有文件哈希，不能补回创建时未记录的历史哈希，也无法证明旧备份没有遭到事后篡改。

## C. 用户从界面恢复（永不覆盖正在运行的库）

1. 知识库 → 备份核验与独立恢复 → 检查或恢复已有备份；在系统原生文件夹对话框中选择含 manifest.json 的目录。Main 独占文件访问，Renderer 不允许提交任意本机绝对路径。
2. Main 校验白名单文件名、普通文件（拒绝 symlink/hardlink）、体积上限、manifest 数据、SHA-256、SQLite quick_check 和 schema 兼容性；只显示每库大小/版本、哈希状态、缺失数据库和剩余授权时间（10 分钟），不展示私密正文。
3. 用户明确核对，二次确认，并使用**操作系统原生保存对话框**选择一个**不存在的新目录名称**。不接受当前配置或它的子目录、源备份目录、已存在的目标。
4. Main 重新检查备份哈希绑定的一次性审核令牌，复制到目标旁的私有 staging，逐库再校验 SHA-256 和 quick_check，通过后原子提交成新的独立配置目录。失败只删除本次 staging，不删除原有 userData 或原备份。新目录只包含可恢复的五库与透明的本机 study-anchor-recovery.json 清单。
5. **恢复不会影响当前正在运行的程序。** 完全退出程序，使用 STUDY_ANCHOR_USER_DATA_DIR 指定新目录重新启动。进入日历、知识库、专注和邮箱页面核对真实数据及授权状态，再决定是否把恢复副本当作新的工作配置。不要删除原版数据和备份，直到真实人工验收完成。

Windows PowerShell 开发测试例子（路径必须改为实际新恢复目录）：

~~~powershell
$env:STUDY_ANCHOR_USER_DATA_DIR = 'C:\Users\you\Documents\Study Anchor Recovered 2026-11-25'
npm run dev
~~~

macOS Terminal 开发测试例子：

~~~bash
STUDY_ANCHOR_USER_DATA_DIR="$HOME/Documents/Study Anchor Recovered 2026-11-25" npm run dev
~~~

安装版则从该设置环境变量的**同一个进程环境**启动真正的 EXE 或 .app/Contents/MacOS/Study Anchor；macOS Finder 双击不保证继承 Terminal 的变量。确保**同一个用户数据目录不会被两个实例同时打开**。

## D. 测试与风险

自动测试使用临时独立 SQLite：WAL-aware 备份、v2 SHA/size/version、篡改备份、非法 manifest/重复库/未来 schema、目标覆盖拒绝、符号链接拒绝、v1 兼容，以及恢复后旧库原样保留、凭据/团队历史未复制。CI 检查是 TypeScript、Vitest、Electron bundle 和离线 Worker smoke；**CI 不自动执行手动安装包 workflow，也不能替代真实 NSIS/DMG 安装、系统凭据和卸载/迁移 E2E**。

仍需五人测试用合法隔离账号和两种系统在真实设备下载包、核验 SHA、安装/启动/重启/卸载、主动快照/隔离恢复、模拟坏库与旧版升级、回滚，并保留脱敏验收记录。只有这些完成后才可以在验收矩阵中标注“真机通过”。

下一轮 ALPHA-CLOSE-04 才进入五个独立账号的真实 Supabase RLS/Realtime 及撤权测试。云端部署需要授权，不允许自动运行迁移脚本。
