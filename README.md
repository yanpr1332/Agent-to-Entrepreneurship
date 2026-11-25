# Study Anchor

> 面向大学生的跨平台个人学习、时间、知识与协作管理软件。

**GitHub 仓库：** [yanpr1332/study-anchor](https://github.com/yanpr1332/study-anchor)（原 `Agent-to-Entrepreneurship` 已于 2026-11-24 更名）。

> **完整品牌与数据目录迁移（PR #47）**：Electron 安装包名称、appId 和新建数据文件名一并改成 Study Anchor。首次启动时会尝试从旧版用户目录自动生成包含 WAL 的一致性 SQLite 快照及加密凭据副本，并原子切换至新目录；旧数据保留不删。发现双目录冲突、多个旧来源或文件异常时停止启动，**不创建空白用户数据库**。升级前必须关闭旧程序并备份旧目录；真实 Windows/macOS 安装升级和系统凭据解密仍需人工验收。详见 [数据迁移与回滚说明](docs/w4/09_REPOSITORY_RENAME_STUDY_ANCHOR.md)。

当前产品需求、交互原型和技术架构见 [PRD](docs/PRD.md)、[W2 UI/UX](docs/ui-ux/README.md)、[W3 架构](docs/architecture/README.md) 与 [W4 开发计划](docs/w4/README.md)。

## 项目目标

把课程和个人事务、学习资料、AI 规划、专注执行以及小组协作连接成完整工作流：收集 → 组织 → 规划 → 执行 → 反馈 → 调整。

- 首发平台：Windows 与 macOS 桌面端。
- 技术方向：Electron + React + TypeScript；Rust 按需引入。
- 数据原则：本地优先、选择性云同步、外传和团队共享分别授权。
- 目标：交付可在 Windows/macOS 演示的内部 Alpha，而非本阶段发布应用商店。

## 八大模块

1. 日历与任务
2. 个人知识库
3. 专注与自律
4. 小组协作
5. AI 辅助规划
6. 数据接入与扩展
7. 邮件管理与 AI 通信
8. 个人工作台

所有模块 P0 验收要求以正式 PRD 为准。当前仓库已落地 15 个垂直切片，八大模块均有可运行的基础闭环，
但完整 P0 与真实外部接入尚未完成；逐项完成度、证据与未验证项见 [W5 验收矩阵](docs/w5/00_ACCEPTANCE_MATRIX.md)。

## 工程开发

W5/W6 共 15 个切片已落地。工程结构、版本、开发命令和安全边界见 [W5 工程说明](docs/w5/README.md)；
可复现的验证结果、环境差异与未验证项见 [W5 验收矩阵](docs/w5/00_ACCEPTANCE_MATRIX.md)。

## 2026-11-19 开发顺序：同步优先

下一轮优先完善 **同步基础设施与 Supabase 真实验收准备**，再开发个人任务/手动日历的跨设备增量同步 MVP、团队消息/任务实时恢复与多账号联机；**精确 + 容错 + 本地 Embedding** 保留在同步主线之后先做离线 PoC。原 Alpha 的 Canvas/邮箱真实接入、Windows/macOS GUI、安装包、权限与备份验收不被取消。计划与每轮退出条件见 [ALPHA-SYNC 同步优先开发计划](docs/w5/27_ALPHA_SYNC_FIRST_IMPLEMENTATION_PLAN.md)。目前这只是排期决定，**不是同步代码或真实云端验收已完成**。

### ALPHA-SYNC-001 工程基线（已合并）

个人同步协议白名单、字段来源投影、五账号 RLS 手动验收脚本及离线 mock 已归档；真实项目仍需用户提供隔离测试项目、五个独立账号与明确写入授权。脚本：`npm run test:sync-rls`，不会由 CI 自动连接。详见 [SYNC-001 实施及测试](docs/w5/28_ALPHA_SYNC_001_PROTOCOL_AND_RLS.md)。

### ALPHA-SYNC-002 个人任务与手动日历跨设备同步（分阶段推进）

- PR #35 已合并：逐条授权、本地 Outbox、待发送操作合并和版本化删除墓碑。
- PR #36 已合并：个人云端表/RLS、设备注册/撤销、版本检查、幂等回执、增量 Cursor RPC。
- PR #37 已合并：owner-scoped 本地 enrollment/Outbox、旧 ownerless 数据隔离和明确重新授权；任务库 schema v8、日历库 v5。
- PR #38 已合并：Main 进程手动 push/ack + pull/SQLite 应用、逐条授权 UI、冲突保留与状态展示；任务库 schema v9 增加冲突记录表。
- PR #39 已合并：本地/云端冲突二次确认、owner/版本/operationId 校验；未解决冲突阻止继续上传/覆写。
- PR #40 已合并：旧 ownerless 同步数据的只读审查与逐条重新授权；历史删除墓碑继续隔离。
- PR #41 已合并：校验本地设备身份/Cursor，对有待发送内容的账号执行只读拉取预检；远端有新变更时本轮延后上传。
- PR #42 已合并：只在任务/日历 Outbox 与冲突均为空时，经二次确认撤销旧设备、轮换本机 UUID 并保留 Cursor；Cursor 0 也需要上传前只读预检。
- PR #43 已合并：任务库 schema v10 新增持久 Pull 页检查点；两库中断时下次手动同步优先重放，损坏检查点阻断上传。
- PR #44 已合并：当前账号只读设备/Cursor 健康诊断，及人工预览、二次确认后严格匹配的 operationId 回执核销；新只读 RPC 未在真实项目部署。
- PR #45 已合并：团队消息/任务获得 Main-only Realtime 提醒、成员验证与最近 100 条 REST/RLS 兼容补拉；对应 SQL publication 未在隔离项目部署。
- PR #46 已合并：团队消息/任务的持久增量日志、SQLite Cursor、删除墓碑及历史分页；003B 云端迁移未进行真实项目部署。\n- 当前 ALPHA-SYNC-003C：Owner 显式压缩旧日志时先生成完整版本化快照；过期 Cursor 会得到服务器明确的恢复协议。客户端分批严格验证并持久暂存、重启续传，全部完成且复核成员资格后原子替换旧数据；**无自动清零、无跳过删除、无默认生产日志裁剪**。仍待隔离项目、五账号 RLS 和真实安装验收。
- 当前 ALPHA-SYNC-003D：团队历史 SQLite v3 的正文及未完成快照使用 Electron OS safeStorage 加密，原 v1/v2 文件原子转换，切换账号/退出时清理所属团队缓存，UI 可确认清理本设备缓存。**旧明文库和迁移前备份仍可能含原文**，不能保证磁盘安全擦除；PR #48 UI 视觉改版仍由另一贡献者独立推进；经用户明确同意，003D 另提独立 PR，按非重叠文件范围并行开发、分别审查。

详见 [29 本地 Outbox](docs/w5/29_ALPHA_SYNC_002_LOCAL_OUTBOX.md)、[30 服务端协议基础](docs/w5/30_ALPHA_SYNC_002_SERVER_PROTOCOL.md)、[31 本地账号隔离迁移](docs/w5/31_ALPHA_SYNC_002C_OWNER_SCOPED_OUTBOX.md) 、[32 Push/Pull 实施](docs/w5/32_ALPHA_SYNC_002D_PUSH_PULL.md) 、[33 冲突解决](docs/w5/33_ALPHA_SYNC_002E_CONFLICT_RESOLUTION.md) 、[34 旧数据审查](docs/w5/34_ALPHA_SYNC_002E_LEGACY_REVIEW.md) 、[35 Cursor 预检](docs/w5/35_ALPHA_SYNC_002F_CURSOR_PREFLIGHT.md) 、[36 设备安全更换](docs/w5/36_ALPHA_SYNC_002F_DEVICE_REPLACEMENT.md) 、[37 崩溃安全拉取](docs/w5/37_ALPHA_SYNC_002G_CRASH_SAFE_PULL.md) 与 [38 同步诊断和回执对账](docs/w5/38_ALPHA_SYNC_002H_RECOVERY_DIAGNOSTICS.md)。

**重要边界：目前只提供用户手动触发的同步，不会后台自动上传；002E 只允许对本地待发送操作与云端变更冲突选择一方，来源冲突、学习计划占用、容量问题仍需人工处理。旧 ownerless 记录只有逐条明确确认才生成新的待发送意图，不会直接上传历史内容；旧删除墓碑不会变成远端删除。Supabase 迁移未部署，真实 RLS/双设备验收尚未完成。** Canvas、ICS、邮件、知识库、专注记录、学习计划和 legacy ownerless 队列均不会自动上传。

### ALPHA-SYNC-002G 崩溃安全拉取定向测试

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/personal-sync-pull-recovery.test.ts src/main/personal-sync-device-replacement.test.ts src/main/personal-sync-preflight.test.ts src/main/personal-sync.test.ts src/main/local-store.test.ts src/main/fixed-calendar-store.test.ts src/shared/personal-sync-contract.test.ts
npm test
npm run build
```

任务库从 v9 升级到 v10，首次启动之前会创建可核验的预迁移 SQLite 备份；本机仍需使用隔离的 `ATE_USER_DATA_DIR`。测试覆盖崩溃重放但不意味着真实 Supabase / 两设备已验收，详见 [37](docs/w5/37_ALPHA_SYNC_002G_CRASH_SAFE_PULL.md)。

### ALPHA-SYNC-002H 同步诊断与回执对账定向测试

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/personal-sync-recovery-health.test.ts src/main/personal-sync-recovery-sql.test.ts src/main/cloud/supabase-client.test.ts src/shared/personal-sync-contract.test.ts src/shared/ipc-channels.test.ts src/main/personal-sync-pull-recovery.test.ts
npm test
npm run build
```

本轮新增只读 Supabase RPC 的 SQL 文件：`supabase/migrations/20261124_ate_personal_sync_recovery_inspect.sql`。**CI 不部署或调用生产数据库**；在隔离测试项目由管理员明确授权执行迁移前，新 UI 中的云端诊断和回执核对会因 RPC 不可用而失败，不影响旧“立即同步”。详见 [38](docs/w5/38_ALPHA_SYNC_002H_RECOVERY_DIAGNOSTICS.md)。

### ALPHA-SYNC-003A 团队 Realtime / 断线补拉测试

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/cloud/workspace-realtime.test.ts src/main/cloud/workspace-snapshot.test.ts src/main/cloud/workspace-realtime-sql.test.ts src/main/cloud/supabase-client.test.ts src/shared/ipc-channels.test.ts
npm test
npm run build
```

如需在**用户单独批准的隔离 Supabase 项目**验证实时订阅，请先审查并运行既有 `20261110_ate_workspace_poc.sql`，再审查 `supabase/migrations/20261124_ate_workspace_realtime_hints.sql`；本仓库 CI **不部署云端**。未完成五账号 RLS 反向测试、30 秒安全补拉 GUI 与历史游标验收之前，不视为完整 Realtime 发布。详见 [39 团队实时提示验收](docs/w5/39_ALPHA_SYNC_003A_REALTIME_HINTS.md)。

## V0.1 五人内部 Alpha 收尾执行计划（2026-11-25）

经用户确认，后续约 **4–7 轮大型开发与集成**集中推进：邮件 AI 候选闭环、工作台、内部桌面包与数据恢复、Supabase 五账号/RLS、Canvas/交大邮箱真实接入、AI 真实调用及双平台 Alpha 验收。**以完整八模块最小闭环为目标**，不降低真实外部账号和安全门槛。详见 [51 V0.1 五人 Alpha 收尾计划](docs/w5/51_V01_FIVE_PERSON_ALPHA_CLOSEOUT.md)。

### ALPHA-FOC-003/004 + KB-005D 专注安全保护与本地神经模型

专注页面可在计时开始前自愿启用 Windows/macOS 前台程序黑/白名单**提醒**和可逆全屏保护；所有模式可通过 Ctrl/Cmd+Shift+F12 紧急解除，或暂停、取消、退出时释放。无权限则明确提示并降级，不会强杀进程或强制屏蔽其他网站。知识库可选用户自己准备的 E5/BGE ONNX 资产，经本机 SHA-256 校验后调用隔离 Python + ONNX Runtime CPU 运行真实神经编码（查询/段落前缀、pooling、L2），再使用现有 SQLite 检索。**需要额外 Python numpy/onnxruntime/transformers 依赖和本机 ONNX 权重**；没有运行时不能宣称模型可用。不上传文档，也不联网下载模型。详细使用/安全验收见 [50](docs/w5/50_ALPHA_FOCUS_SAFETY_NEURAL_EMBEDDING.md)。

### ALPHA-FOC-006 自定义虚拟奖励与积分兑换

「专注与自律」模块支持创建/修改/停用自定义现实奖励的**虚拟计划**，显示已赚/已用/可用积分和等级；用户确认后记录一次兑换，软件不会实际购买、付款或提供奖励。积分从本机完整专注会话和兑换账本核算，重复提交不重复消费，兑换凭据保留原名称及花费。SQLite v11 升级前使用 WAL-aware 备份；平台 GUI 与真实恢复需人工验收。详见 [49](docs/w5/49_ALPHA_FOC_006_VIRTUAL_REWARDS.md)。

### ALPHA-FOC-005 本机专注趋势和连续完成天数

专注与自律页面新增近 7/30 天统计、上一周对照、每日趋势以及近 30 日连续完成天数。统计按系统时区的专注结束日分组，直接聚合 SQLite 中有限 30 日窗口的全部记录，不受最近 500 条历史列表限制；不更改既有积分、计时和本地隐私边界。仅展示历史记录，不提供程序限制或积分兑换。详见 [48](docs/w5/48_ALPHA_FOC_005_FOCUS_INSIGHTS.md)；真实桌面 UI 与时区切换仍待人工验收。

### ALPHA-KB-007 批量导入和来源更新检查

个人知识库新增一次最多 20 份的原生多文件导入（PDF/MD/HTML/LaTeX/TXT），并可对之前导入的资料主动执行只读原文件变更检查；**只有用户勾选变化项且二次确认后**才会以旧版/文件哈希双重校验进行更新。失败项保留旧的本地原文快照和历史引用，不自动扫描目录、不上传私人文档，也不宣称已实现自动文件监控。真实文件多选与跨平台 GUI 仍待人工验收。详见 [47](docs/w5/47_ALPHA_KB_007_SOURCE_LIFECYCLE.md)。

### ALPHA-KB-006 复习卡编辑与新版原文核对

卡片支持人工修改问题/答案，并保留既有评分次数和到期日期；当原文再次导入且版本变化后，必须先在本机核对当前证据才可以继续评分。人工确认更新引用时，将旧片段、来源哈希和 PDF 页码归档到本地 SQLite v6 的证据历史表。旧版数据库在升级前使用 WAL-aware 备份。**不会自动由 AI 决定原文是否仍正确**，也不修改硬盘原始文档；双平台 GUI 和真实数据库恢复仍待人工验收。详见 [46](docs/w5/46_ALPHA_KB_006_CARD_REVIEW.md)。

### ALPHA-KB-005C 离线索引词表覆盖与检索质量评测

本轮在本地 SQLite v5 中增加明确的“已索引 / 词表外跳过 / 待处理”计数，**无法编码的文档不再阻塞后续索引**，仍可使用精确及容错搜索。用户明确确认后可导出最多 500 条本机证据 ID、文档标题、PDF 页码和摘要，人工编写相关性标注 JSON 后对同一批查询计算精确/容错与混合检索的 Precision@5、Recall@10、MRR@10、P50/P95 查询延迟，全程不上传私人数据。**尚未接入 E5/BGE ONNX Transformer**，不能把这些静态词向量测试误称为真正神经模型基准。详见 [45](docs/w5/45_ALPHA_KB_005C_INDEX_COVERAGE_EVALUATION.md)。

### ALPHA-KB-005B 自愿导入离线静态词向量与 Worker 编码

从个人知识库选择“导入本机 .vec 词向量”，自行确认模型来源/许可后通过原生文件选择器导入不超过 32 MiB 的 UTF-8 文本词向量，第二次点击“构建/继续本地索引”才开始处理个人知识库。每轮最多 16 个原文块，索引可取消/续传、可卸载，查询保留精确优先排序和 PDF 页码。**不预装/下载模型，也不表示 E5/BGE ONNX 已接入**。构建会执行真实打包 Worker smoke：`node scripts/verify-offline-worker.mjs`。详见 [44](docs/w5/44_ALPHA_KB_005B_OFFLINE_WORD_VECTORS.md)。

### ALPHA-SYNC-003D 团队历史本机加密与清理

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/cloud/workspace-history-crypto.test.ts src/main/cloud/workspace-history-privacy.test.ts src/main/cloud/workspace-history-store.test.ts src/main/cloud/workspace-checkpoint-store.test.ts src/main/local-backup.test.ts src/shared/ipc-channels.test.ts
npm test
npm run build
```

团队历史 SQLite v3 将消息/任务正文及暂存快照使用本机 OS 安全存储加密，**并非全盘加密**，工作空间 ID/时间/Cursor 可见。已有 v1/v2 原文库在转换前建立经过验证的备份，旧原文页、早期迁移备份、旧安装目录可能仍含明文。退出云端账号时尝试清除此账号的团队缓存，也可通过团队界面二次确认清理；**不删除云端记录或个人任务**。完整边界和验收见 [42 本机团队历史加密与隐私](docs/w5/42_ALPHA_SYNC_003D_LOCAL_HISTORY_PRIVACY.md)。

### ALPHA-SYNC-003C 历史 Cursor 过期与完整检查点重建

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/shared/workspace-checkpoint-contract.test.ts src/main/cloud/workspace-checkpoint-store.test.ts src/main/cloud/workspace-checkpoint-service.test.ts src/main/cloud/workspace-checkpoint-sql.test.ts
npm test
npm run build
```

003C 新迁移 `supabase/migrations/20261124_ate_workspace_checkpoint_recovery.sql` 需要先安装原 workspace PoC 和 003B 日志 SQL，**不通过 CI 自动部署，也不自动运行 Owner 历史压缩**。完整快照内容会继续留存于服务器；本轮本机团队 SQLite 已升级为 OS 保护的正文加密格式，但旧明文备份/页可能仍保留。旧数据过期时，客户端会先在独立 SQLite 暂存完整快照，验证完成且复核成员资格后才替换旧缓存和 Cursor。详见 [41 检查点与安全恢复](docs/w5/41_ALPHA_SYNC_003C_CHECKPOINT_RECOVERY.md)。

### ALPHA-SYNC-003B 持久团队历史增量与重启恢复

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/shared/workspace-history-contract.test.ts src/main/cloud/workspace-history-store.test.ts src/main/cloud/workspace-history-service.test.ts src/main/cloud/workspace-history-sql.test.ts src/main/cloud/workspace-realtime.test.ts src/shared/ipc-channels.test.ts
npm test
npm run build
```

测试会以真实本地 SQLite 文件关闭/重开模拟客户端重启，验证百条以上分页、删除墓碑和 Cursor 原子回滚。原 003B 的本地文件 `study-anchor-team-history.sqlite` 曾**保存明文团队消息/任务缓存**（003D 起将正文转换为 OS 加密），首次使用前须按 [40 持久历史验收和隐私约束](docs/w5/40_ALPHA_SYNC_003B_DURABLE_HISTORY.md) 评估本机留存；不能将其当作加密存储。新增缓存数据库打开失败时仍保留其文件并降级当前 JWT 的 REST 刷新，不阻止其他本地模块启动。新增云端迁移 `supabase/migrations/20261124_ate_workspace_durable_history.sql` **不会通过 CI 自动部署**，需要独立审核、用户授权与隔离项目测试。

### Study Anchor 安装及旧数据目录升级（PR #47）

首次启动新构建前，务必退出旧应用并将旧用户数据目录**另行备份**：

- Windows 旧目录：`%APPDATA%\\Agent to Entrepreneurship`；新目录：`%APPDATA%\\Study Anchor`
- macOS 旧目录：`~/Library/Application Support/Agent to Entrepreneurship`；新目录：`~/Library/Application Support/Study Anchor`
- 自定义目录：新变量 `STUDY_ANCHOR_USER_DATA_DIR`，兼容 `ATE_USER_DATA_DIR`，不得设置成互相冲突的两条路径。

新安装标识：`org.studyanchor.desktop`，安装包显示名称：**Study Anchor**。原目录和原凭据副本由迁移器保留；发现冲突时拒绝自动合并。迁移测试：

```sh
node node_modules/vitest/vitest.mjs run src/main/profile-migration.test.ts src/main/repository-identity.test.ts src/main/local-backup.test.ts
```

更多平台细节、WAL 一致性、备份/回滚和真正安装升级前的必须验收项见 [09 仓库及桌面品牌迁移](docs/w4/09_REPOSITORY_RENAME_STUDY_ANCHOR.md)。

## Windows / macOS 本地 Alpha 验收指南

以下命令全部在包含 package.json 的**仓库根目录**执行。本指南优先使用隔离测试数据，不需要真实 Canvas、学校邮箱、OpenAI 或 Supabase 凭据。**CI 构建成功不代表完成真实 GUI 验收。**

### 0. 检查开发环境、Git 远端与更新仓库

仓库重命名**不会自动改变本地文件夹名称**。以下 `cd` 路径只是示例，请替换为电脑上已有的仓库目录；不需要重新克隆或删除本地数据。

- Windows 10/11、macOS；Node.js **24.x**（项目 .nvmrc 固定 **24.18.0**）；npm **11.x**；Git。
- 先保存本机尚未提交的修改。不要为了验收使用 git reset --hard。
- 下列 Windows 的 cd 路径只是示例，请替换成自己的目录。

Windows（PowerShell）：

~~~powershell
cd "C:\path\to\your\existing-local-repo"   # 示例：请替换为实际本地路径
git remote set-url origin https://github.com/yanpr1332/study-anchor.git
git remote -v
git status --short
git switch main
git pull --ff-only
node --version                     # 需要 v24.x
npm --version                      # 需要 11.x
~~~

macOS（Terminal）：

~~~bash
cd /path/to/your/existing-local-repo   # 替换为实际本地路径
git remote set-url origin https://github.com/yanpr1332/study-anchor.git
git remote -v
git status --short
git switch main
git pull --ff-only
node --version
npm --version
~~~

上面的 `git remote set-url` 只会修改 Git 远端地址，不会更改本地数据库、旧安装目录或已有提交；确认 `git remote -v` 显示新的 `study-anchor.git`。

**尚未合并的 PR 不在 main 中。** 如需提前测试某个 PR，先执行 git fetch origin，再根据 PR 中显示的分支名切换到相应远端分支；验收完成后切回 main。不要假设 git pull 会自动拉到尚未合并的功能。

### 1. 安装依赖

Windows/macOS 通用：

~~~sh
npm ci
~~~

npm ci 会按 package-lock.json 安装依赖。出现 deprecated、funding 提示并不意味着安装失败；出现审计漏洞请保存结果、按运行时与开发工具风险分别判断：

~~~sh
npm audit --omit=dev
npm audit
~~~

**不要在首次验收前执行 npm audit fix --force**，它可能强制改变 Electron 构建工具的版本。安装输出的 added N packages 也**不保证 Electron 可执行文件安装完整**。

### 2. 验证 Electron 已安装

Windows PowerShell：

~~~powershell
Test-Path .\node_modules\electron\dist\electron.exe  # 应为 True
Test-Path .\node_modules\electron\path.txt           # 应为 True
~~~

若结果为 False 或启动报 **Error: Electron uninstall**，可运行 Electron 自身的安装脚本：

~~~powershell
node .\node_modules\electron\install.js
~~~

如果因网络问题下载失败，只有在允许使用该镜像且信任其来源时才尝试：

~~~powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
node .\node_modules\electron\install.js
~~~

再运行两个 Test-Path 确认安装成功；不必反复运行 npm ci。若从其他 Electron 应用的终端启动且出现 ELECTRON_RUN_AS_NODE=1，可在 PowerShell 清除该变量：

~~~powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
~~~

macOS：

~~~bash
test -f node_modules/electron/path.txt && echo "Electron install record exists"
node -p "require('electron')"      # 应返回 Electron 可执行文件路径
~~~

### 3. 用独立数据目录启动应用

不要直接拿真实任务、真实课程或真实密钥验证删除和导入。隔离目录内保存单独的 SQLite 数据，**切换目录不会自动迁移旧数据**。

Windows PowerShell（每个**新终端窗口**都应重新设置）：

~~~powershell
$env:ATE_USER_DATA_DIR = "$env:LOCALAPPDATA\ATE-alpha-acceptance"
npm run dev
~~~

macOS Terminal：

~~~bash
export ATE_USER_DATA_DIR="$HOME/Library/Application Support/ATE-alpha-acceptance"
npm run dev
~~~

正常结果是 Electron 应用窗口出现，个人工作台显示 **SQLite 已连接**。仅看到 dev server 的 localhost:5173 地址，不代表桌面窗口已经打开。

如果 Windows 上默认启动报 Chromium 子进程、GPU 或沙箱创建失败，参见 [本地运行排障](docs/w5/16_LOCAL_RUNTIME_TROUBLESHOOTING.md)。仅在**自己控制且可信的本地开发环境**下可临时尝试：

~~~powershell
npm run dev:compat
~~~

该模式通过 --noSandbox 关闭 Chromium OS 级沙箱，**不得用于正式打包或对外分发**。退出时关闭桌面窗口，若终端仍有残留进程再按 Ctrl+C。备份前关闭应用，避免复制处于写入状态的数据库。

### 4. 类型检查、自动化单测与构建

关闭或另开应用运行终端，在仓库根目录执行：

~~~sh
npm run typecheck
npm test
npm run build
~~~

- npm run typecheck：TypeScript 类型检查。
- npm test：Vitest 单元及集成测试。
- npm run build：再次进行类型检查和测试，再编译 Electron-Vite；**不会生成最终安装包**。

#### ALPHA-SYNC-002F 设备安全更换/游标预检定向验收

```sh
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/personal-sync-device-replacement.test.ts src/main/personal-sync-preflight.test.ts src/main/personal-sync.test.ts src/main/local-store.test.ts src/shared/ipc-channels.test.ts
npm test
npm run build
```

这些是本地 SQLite 与 Mock RPC 测试，不能代替真实设备撤销、Supabase RLS 与双设备 GUI 验收。建议用隔离测试项目按 [36 设备更换验收](docs/w5/36_ALPHA_SYNC_002F_DEVICE_REPLACEMENT.md) 逐项记录。

#### ALPHA-SYNC-002D/002E 定向验收命令

如果只想先验证个人任务/手动日历同步相关改动，在仓库根目录执行：

~~~sh
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/personal-sync.test.ts src/main/personal-sync-legacy.test.ts src/main/local-store.test.ts src/main/fixed-calendar-store.test.ts src/main/local-backup.test.ts src/main/mail-candidates.test.ts src/shared/personal-sync-contract.test.ts src/shared/ipc-channels.test.ts
npm run test:sync-rls
~~~

这些定向测试使用内存 SQLite、临时 SQLite 文件和 Mock 云端响应，不需要真实 Supabase、Canvas、学校邮箱或 API Key。包括旧 ownerless 隔离区的只读列表、重新授权的双重确认、拒绝历史删除墓碑和防止过期认领。覆盖内容包括：逐条授权、任务/手动课程 Push/Pull、冲突保留、跨账号隔离、在途编辑/删除、撤销尚未发送条目的授权、退出时保留待确认操作，以及 v8→v9 迁移备份。

完整验收仍需运行 `npm test`。它会执行全部 Vitest 测试，并运行 `scripts/sync-rls-acceptance.node.mjs` 静态验收；`npm run build` 会再次执行类型检查和完整测试后才构建桌面 bundle。

**本轮暂不做真实云端手工验收：** 当前 PR 没有部署 Supabase SQL migration，也没有提供隔离测试项目。不要为了让“立即同步”按钮通过而把 migration 直接部署到生产项目；真实双设备/RLS 验收须等隔离项目与部署授权明确后再做。

- 受限 Windows 环境如出现 Timeout terminating forks worker，可额外用线程池复核，但不替代 CI：

~~~sh
node node_modules/vitest/vitest.mjs run --pool=threads
~~~

- Windows 安装包命令：npm run dist:win；macOS：npm run dist:mac。签名、公证和真实安装包仍需另做验收，不得以 npm run build 通过冒充发布完成。
- GitHub Actions 在 Windows 与 macOS 均运行，独立于用户真机 GUI 体验。

### 5. 本地人工验收顺序

逐项记录通过 / 失败 / 未验证，保留触发动作与脱敏截图。

1. 工作台：显示 SQLite 已连接；所有导航不出现白屏。
2. 任务：日历页点 **+ 新建任务**，填写任务和截止日期、收起/重新打开编辑器；标记完成、撤销完成、编辑已有任务及截止日期。
3. 日期：月视图选择一个不是今天的日期，确认顶部 **当前选中**、日历高亮、下方任务/课程一致；切月/周/日、跨月、回到今天。
4. 固定课程：创建一门按周重复 4 次的测试课程，再点 **修改本次日期/时间**，选择「仅修改本次 / 从本次起 / 整个系列 / 指定区间」。确认日期按相同自然日差批量移动、已确认学习计划冲突时整组拒绝保存。该批量修改仅支持**本机手动重复系列**，不修改 ICS 或 Canvas 来源。详见 [22 重复课程批量修改与验收](docs/w5/22_ALPHA_TIME_004_COURSE_SERIES_EDIT.md)。
5. 专注：点 1 分钟预设、自定义 2 分钟，开始/暂停/继续/结束；验证记录与积分。输入 0、181 和小数应无法开始。
6. 主题：侧边栏底部 **外观主题** 选择浅色/深色/跟随系统，重启验证保存与系统主题联动。
7. 知识库：用无私人信息的 .md、.html、.tex、.txt、.pdf 文件验证阅读预览、原始源码和证据片段；同时导入准确和轻微拼写错误的资料，搜索时应当同时出现「精确」及「容错」结果。选择某一段原文后，可以自愿使用自己的 OpenAI API Key，通过**预览完整请求 → 确认发送**获得一次 AI 辅助解释；默认离线，不上传其他文件或整库。完整 TeX 编译和真正全库 AI 语义检索仍未实现。详见 [24 安全预览](docs/w5/24_ALPHA_KB_003_SAFE_PREVIEW_SEARCH.md) 和 [25 可选 AI 原文解释](docs/w5/25_ALPHA_KB_004_AI_SOURCE_EXPLANATION.md)。

**专注与日历联动（PR #27）**：在专注页填写标题，计时期间可切换模块再返回；点击「记录完成」后，历史中可以修改标题，日历月视图用圆点提示有实际专注，日/周和选中日期详情显示实际学习时段。暂停期间计入起止区间，但不计入有效专注秒数；旧版估算时间不进入实际日历。此变更会把本地任务数据库从 v4 迁移到 v5，首次运行前会制作迁移快照；详见 [实施及迁移说明](docs/w5/20_ALPHA_TIME_002_FOCUS_CALENDAR.md)。
8. 学习规划：生成、选择性应用、核对日历占用并撤销。已确认的单段学习计划可在日历中修改时间或删除本段。

**本地语义检索研发（ALPHA-KB-005B：可选离线静态词向量，非 E5/BGE）**：拟在现有精确/容错结果上加入可选的**本地 embedding 语义检索**，让同义词和中英混合问题能命中不同措辞的原文。模型下载需用户同意，索引默认本地、断网可用，详情见 [模型可得性和工程难度评估](docs/w5/26_ALPHA_KB_005_LOCAL_SEMANTIC_SEARCH_FEASIBILITY.md)。005A 已提供 SQLite v4 版本化向量、原文引用失效保护和精确优先融合；005B 新增**用户自备 .vec 静态词向量（最大 32 MiB）的 SHA-256 校验、独立 Worker 离线编码、分批可取消/可续传索引以及模型卸载 UI**。不会自动下载或上传原文；**静态词向量不等于 Transformer E5/BGE，模型质量尚未进行正式中英基准评测**，见 [44 本机模型实现与验收](docs/w5/44_ALPHA_KB_005B_OFFLINE_WORD_VECTORS.md)。详见 [43 索引基础与验收](docs/w5/43_ALPHA_KB_005A_VECTOR_FOUNDATION.md)。该功能不属于已合并 PR #32 的实际交付。

**任务执行时间编辑（PR #28）**：在日历中选中日期，找到「任务执行时间」，点击「+ 安排任务时间」为可见、未完成的任务指定具体日期、开始时刻和时长（15–480 分钟、5 分钟刻度）。同一任务可安排多段，也可对已确认的时间块逐段修改或删除。固定课程及其他时间块重叠会被主进程拦截。任务截止日期不变。此轮将 旧版 `ate-plans.sqlite`（新版本自动迁为 `study-anchor-planning.sqlite`）从 v1 升至 v2，原规划库会在迁移前生成快照；详情和本地集中测试案例见 [任务执行时间实施文档](docs/w5/21_ALPHA_TIME_003_TASK_SCHEDULES.md)。
9. 关闭应用，在**同一** ATE_USER_DATA_DIR 下重新启动，核实任务、专注记录和主题保留。

本轮交互变更与未实现的反馈见 [Alpha 验收反馈路线图](docs/w5/19_ALPHA_UX_FEEDBACK_ROADMAP.md)，逐功能当前证据见 [验收矩阵](docs/w5/00_ACCEPTANCE_MATRIX.md)。

### 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| npm warn deprecated / npm fund | 依赖维护/赞助信息，本身不阻止 npm ci 成功 |
| npm audit --omit=dev 为 0 但 npm audit 有告警 | 运行与开发依赖风险不同；不要直接 --force 破坏锁定版本 |
| Error: Electron uninstall | 检查 Windows electron.exe 和 path.txt，补运行 electron/install.js |
| GPU process isn't usable | 参考排障文档检查沙箱，dev:compat 只能用于可信本地开发 |
| 本地数据无法打开 | 检查 STUDY_ANCHOR_USER_DATA_DIR（或兼容的 ATE_USER_DATA_DIR）可写性，不要直接删除真实数据 |
| libpng warning: iCCP: known incorrect sRGB profile | 记录出现时机和图片来源；可能是 PNG 色彩配置，单独出现不代表数据库损坏 |
| npm test 中 fork worker timeout | 参考上文 --pool=threads，CI 标准检查仍须另行通过 |

> 提交 Issue、截图和日志前，请遮盖真实 Token、邮箱、API Key 和课程资料。当前项目许可为 [PolyForm Strict 1.0.0](LICENSE)，开发者/贡献者修改授权要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 工程边界

- Renderer 不拥有 Node、文件系统或 shell 权限；仅通过 Preload 暴露的白名单 API 与主进程通信。
- 不在仓库提交密钥、个人 Token、邮箱密码或真实用户数据。
- SQLite、云端协作、Canvas、邮件和 AI Runtime 将按独立任务接入，不以 Mock 作为真实集成验收证据。
- macOS 打包必须在 macOS 设备或 CI 上完成。

## 许可证与使用限制

本项目的**当前版本**采用 [PolyForm Strict License 1.0.0](LICENSE)（[官方条款](https://polyformproject.org/licenses/strict/1.0.0)）。
这属于**源码可见（source-available），不是 OSI 开源许可证**。

- 允许许可证定义的**非商业使用**，包括个人学习、研究，以及许可证列明的教育、公益等机构用途。
- **不授予修改、制作衍生作品或再分发软件的权利**，即使是非商业目的也不例外；需要额外取得相应权利持有者的授权。
- 一般**商业使用不被允许**；商业授权须与相应版权持有人另行协商。
- 本许可只覆盖有权以该许可提供的项目内容；第三方依赖与资产维持各自的许可证。
- **历史版本已根据 MPL-2.0 作出的有效授权不会被本次变更追溯撤销。**

许可证切换的版权边界、历史版本、协作贡献要求见 [许可说明](docs/LICENSING.md)。

## 贡献

参阅 [CONTRIBUTING.md](CONTRIBUTING.md)。所有功能经独立分支和 PR 进入 main；任务认领、文件范围和验收证据记录在 W4 Backlog。
