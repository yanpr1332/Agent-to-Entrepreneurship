# ALPHA-SYNC：同步优先开发与验收计划（2026-11-19 决策）

> **状态：已确认的开发顺序，尚非代码实现或真实服务验收。** 以 2026-11-25 内部 Alpha 为近期目标；阶段编号表示实施顺序，不构成保证按四个 PR 或固定工期完成的承诺。按“**同一时间只维护一个开发 PR**”推进，前一 PR 关闭或合并后再开下一轮。同步优先级仅指**近期研发排队**，不得修改 PRD 中正式 P0/P1 定义。

## 1. 决策、现状与优先级

| 方向 | 已具备的能力 / 明确缺口 | 近期排队 |
| --- | --- | --- |
| 同步与云端协作 | Canvas 作业、Canvas 日历有自动本机同步代码；邮箱有定时同步代码；Supabase 团队工作空间仍为 PoC，未在真实项目部署并完成 RLS/多账号验收；个人 SQLite 不会自动跨设备同步 | **先行：ALPHA-SYNC-001 → 002 → 003** |
| 原计划其余功能与验收 | 时间模型、知识库精确 + 容错搜索与用户确认的 AI 单段解释已有代码，仍缺双平台真实 GUI、外部连接、安装包和恢复演练；Canvas/学校邮箱真实测试仍为 Alpha 门槛 | **穿插处理高风险验收和阻塞**，不在同步尚不稳定时无差别扩展功能 |
| 本地 Embedding 语义检索 | ALPHA-KB-005 已完成模型可得性与架构评估，**未下载/集成模型、未建向量索引** | **同步核心门槛之后**先做独立 PoC，随后评估 B/C |

**两种“同步”不得混淆：**

- **外部数据源 → 本机**：Canvas 按授权读取作业/课程日历，邮箱按范围读取；它们的远端源事实由 Canvas/邮箱控制。已有自动刷新代码不代表在真实账号验收通过。
- **本机 ↔ 本机/云端协作**：个人任务、手动日历、共享团队数据需要账户身份映射、可靠增量协议、服务端鉴权、冲突处理和设备恢复；现有团队 PoC（约 10 秒轮询）不等于个人数据跨设备同步，也不等于 Supabase Realtime。
- **云端默认范围**：个人知识原文、PDF、OCR、语义向量、Canvas Token、学校邮件正文、AI Key、专注原始记录均**不因本项目启用云端协作而自动上传**。每类内容须另行设计细粒度授权与同步策略。

参考：[W3 同步与协作架构](../architecture/09_SYNC_AND_COLLABORATION.md)、[云端 Workspace PoC 边界](06_CLOUD_WORKSPACE_POC.md)、[Canvas 自动同步](04_CANVAS_TASK_SYNC.md)、[Canvas 日历同步](15_CANVAS_CALENDAR_AUTO_SYNC.md)、[Embedding 可行性](26_ALPHA_KB_005_LOCAL_SEMANTIC_SEARCH_FEASIBILITY.md)。

## 2. 开发批次、依赖与退出门槛

### ALPHA-SYNC-001：基线收口 + 独立测试项目验收准备（下一开发轮）

**范围**：盘点六个 SQLite 库中个人任务、手动课程、计划时间块与外部来源的权威边界；梳理现有 Supabase SQL、Auth、RLS、团队 IPC 及消息轮询实现。先写清同步实体/字段白名单、账号与设备绑定、错误状态及版本/恢复策略；完善独立测试项目部署步骤、可复现的正反向权限用例与断线测试脚本。若无需真实服务即可验证的逻辑，优先用测试桩和隔离数据测试。

**服务端真实验收依赖**：由有权限的使用者明确选择/创建**隔离的 Supabase 测试项目**，按授权部署 SQL，提供**五个独立测试账号**，在实际项目测试 RLS 对非成员的读写拒绝。项目 URL / publishable key 与 service_role/数据库密码必须区别对待；严禁把 service_role、密码或 Token 提交仓库、日志或前端。不凭文档自动创建云服务或宣称已部署。

**退出条件**：数据权威/授权清单和迁移回滚方案可审；五账号登录及 RLS 正反向步骤可复现；真实项目验证在有账号和授权时完成并归档脱敏证据，否则标为 **Blocked/未验证**，不冒充成功。范围不包含全面同步六个数据库或外部平台 OAuth 改造。

### ALPHA-SYNC-002：个人任务 + 手动日历跨设备 MVP

**范围**：先选择**个人任务与本机手动创建的日历事件**作为第一批可同步实体。定义本地事务与 Outbox 原子写入、持久操作 ID、设备/账号 ID、实体 ID、baseVersion、操作类型与时戳；服务端验证用户与作用域并幂等应答；客户端按持久游标增量拉取，能处理“服务端已成功但响应丢失”。支持离线创建/修改、重新联网续传、重复请求去重、重启恢复、显式失败/待同步/冲突界面和用户主动关闭同步。

**边界**：Canvas 源事实只读、保留个人隐藏/完成等本地覆盖，不与用户编辑混写；ICS 导入及学习规划已确认时间块、专注、知识库、邮件**暂不纳入首批个人数据同步**。UI 必须标记这些仍为 localOnly，防止用户误以为全部时间线已经跨设备一致；不能在另一设备静默应用与本机未同步时间块冲突的更改。外部数据源的同步周期不被改为云端上传周期。

**冲突策略**：不同字段在规则明确后可尝试合并；同字段/截止日期或手动课程时间冲突保留双方版本，显示人工选择，不允许静默 last-write-wins；权限拒绝时本地修改保留为草稿/冲突，不冒充共享成功。敏感数据的同步需用户显式启用，默认 localOnly。

**退出条件**：两设备不同账号身份/同账号多设备的授权边界可验证；断网编辑、跨设备最终可见、重复投递不重做、游标损坏/失效恢复、冲突/撤权、删除墓碑与数据库迁移前备份均有自动测试及实测记录；Windows/macOS GUI 验收分开登记。仅在可验证的安全授权和回滚路径下升级数据库。

### ALPHA-SYNC-003：团队消息与任务实时增量 + 多账号联机

**范围**：在 001 的真实 RLS 基础上，将团队消息/任务从约 10 秒轮询逐步升级到受权限限制的 Realtime 提示 + **持久游标/补拉**；单独覆盖断线重连、乱序/重复、成员退出、撤权后的访问拒绝和本地缓存策略。Realtime 只用作提醒，不能当作唯一一致性来源。

**退出条件**：五个独立账号经互联网共同进入测试 Workspace，跨设备创建/更新任务与消息，并通过非成员不可读写、撤权后拒绝、断网恢复一致性测试；真实服务截图/操作记录脱敏归档。未取得真实测试项目则状态保留“阻塞”，不得以模拟五人场景标为完成。

### 后续：ALPHA-KB-005A → 005B → 005C（不抢占同步主线）

先以 multilingual-e5-small 和 bge-small-zh-v1.5 做 CPU/WASM 离线 PoC、许可/体积与中英检索质量对比；再决定可选安装模型与增量向量索引，最后加入精确/容错/语义三路合流。独立于 OpenAI 单段解释；用户不启用模型时保留现有纯离线 FTS5/容错检索。模型、向量、源资料默认本机，不随 SYNC-002 上传。详细标准见 [26](26_ALPHA_KB_005_LOCAL_SEMANTIC_SEARCH_FEASIBILITY.md)。

## 3. 2026-11-25 内部 Alpha 交付门槛（条件性，而非完工承诺）

近期优先尝试：①五个**不同**测试账号可在真实 Supabase 测试项目登录并加入同一工作空间；② RLS 对成员和非成员的正反向测试有证据；③ 至少一个最小跨设备增量场景可展示，并显示离线、失败或冲突状态；④ 不回归本地任务/Canvas/邮件/知识库已有能力。Windows/macOS 真机 GUI、安装包、Canvas 真实 Personal Token、学校邮箱真实收发、数据备份恢复等原 Alpha 门槛**没有取消**。

若资源或审批不足：交付可执行的代码、测试脚本、已知问题与 **Blocked** 状态，**不得将 Mock、CI、设计文档或本地轮询称为真实五人联机/完整双向同步**。不得为了赶日期跳过权限、授权或备份要求。

## 4. 每轮工程与测试纪律

1. **仅一个在途开发 PR**：先检查 open PR；基于最新 main 建分支；当前轮关闭/合并并处理冲突后再启动下一轮。一个 PR 对应明确 Task ID、范围、风险、Windows/macOS 影响与证据。
2. **数据安全**：涉及数据库 schema 时隔离 ATE_USER_DATA_DIR 并先做可核验快照；保留旧数据及可回滚路径，不直接对唯一真实数据副本升级。同步记录和诊断不得泄露 Token、密码、邮件正文和私有文件。
3. **测试分层**：类型检查、Vitest、Electron 构建与 Windows/macOS CI；隔离 Supabase 正反向权限测试；断网/重连/重放/撤权故障测试；真实用户 GUI 验收。缺少哪层便记录未验证。
4. **范围控制**：ALPHA-SYNC-001 不凭空部署服务、建真实账号或改动线上项目；ALPHA-SYNC-002 不开启“所有资料自动上云”；ALPHA-SYNC-003 不把 Realtime 当作可靠事件日志；Embedding 不并行开实现 PR。

## 5. 本阶段仍需外部提供/决定的事项

- 是否批准在**独立** Supabase 测试项目进行真实部署、创建五个测试身份并运行正反向 RLS 测试；在取得明确授权前，只完善仓库内的测试步骤与模拟验证。
- Canvas Developer Key / 多用户 OAuth、学校邮箱测试凭据及真实双平台验收需要账号或设备持有人分别授权；缺失时标为阻塞。
- 个人同步启用流程、每类实体同步范围及冲突时用户选择界面细节应在 SYNC-001 设计收口，并以最小可撤销权限为默认。

**本文件只调整下一阶段的工程实施顺序，不代表 ALPHA-SYNC-001/002/003 已经实现。**

## 6. 进度更新：ALPHA-SYNC-001 工程验证工具（2026-11-19）

已开始 SYNC-001 独立开发 PR：补充个人任务/手动日历来源白名单、显式启用参数、同步操作与回执解析、五账号 Supabase 权限正反向验收脚本及离线 mock 测试。**此更新不表示真实五账号联机、Outbox、双向同步、Realtime 或后续 SYNC-002/003 已完成。** 详见 [28 实施与验收](28_ALPHA_SYNC_001_PROTOCOL_AND_RLS.md)。一个在途 PR 关闭/合并后方进入下一轮。


## 7. 进度更新：ALPHA-SYNC-002 本地 Outbox 第一阶段（2026-11-24）

PR #35 已合并：两个本机 SQLite 库分别新增逐条授权 enrollment 与持久 Outbox；任务/手动日历编辑在各自事务内同步写入待发送意图；重复编辑合并 pending operation；已获服务器版本的删除生成墓碑，未上传创建被删除时撤销本地意图。Canvas、ICS、邮件候选任务排除，默认不开启。该阶段没有远端传输。详见 [29](29_ALPHA_SYNC_002_LOCAL_OUTBOX.md)。

## 8. 进度更新：ALPHA-SYNC-002B 个人云端协议基础（2026-11-24）

PR #36 已合并：新增个人同步 Supabase schema/RLS、设备注册/撤销、personal-task/manual-calendar-event 严格 RPC、服务端版本检查、operationId 幂等回执、按 owner 串行分配的增量 cursor 和分页 pull。SharedCloudClient 使用当前用户 JWT；本地 ate-local.sqlite schema v7 按 owner 保存 deviceId/cursor。

**这仍不是可用的双向同步**：迁移未部署、没有真实联机；Outbox 尚未按 owner 隔离/上传，pull 变更尚未应用到本地，冲突 UI 与逐条授权 UI 尚未完成。详见 [30](30_ALPHA_SYNC_002_SERVER_PROTOCOL.md)。

## 9. 进度更新：ALPHA-SYNC-002C 本地账号隔离迁移（2026-11-24）

当前开发轮为个人任务与手动日历的 enrollment/Outbox 增加 owner_id 作用域：每个账号独立队列、独立版本基线和 owner-scoped acknowledgement；同一实体可被多个账号分别显式授权。编辑仅为已授权的 owner 生成队列；删除时为每个已确认的远端副本生成各自墓碑，未确认的本地创建仅撤销对应账号的待发送意图。

本机任务数据库升至 schema v8，手动日历数据库升至 v5。旧版无 owner_id 的 enrollment/outbox 不会猜测归属，而是保留在 legacy quarantine 表中；只有用户明确确认后，仍存在且符合来源白名单的个人任务/手动事件才可重新授权，并以当前本地快照和 null baseVersion 生成新操作。旧删除墓碑、已删除实体、Canvas/邮件/ICS 数据不会自动认领或上传。

**本轮仍不包含上传器、pull 本地应用、冲突 UI、逐条授权 UI、真实 Supabase 部署或多设备验收。** 详见 [31](31_ALPHA_SYNC_002C_OWNER_SCOPED_OUTBOX.md)。

## 10. 进度更新：ALPHA-SYNC-002D 手动 Push/Pull 与冲突保留（2026-11-24）

当前开发轮在 PR #37 合并后顺序启动。Main process 从当前 Supabase 会话读取 ownerId，不接受 Renderer 传入账号身份；点击“立即同步”时注册稳定设备，按 owner 读取任务/手动日历 Outbox，顺序调用 apply RPC，并仅在服务端 accepted/duplicate 回执后 owner-scoped ack。普通编辑会轮换 operationId，避免同一幂等 ID 对应不同 payload；如果旧请求在本机编辑/删除期间成功，精确 ack 不会跨账号推断替换关系，当前同步任务再基于其已发送快照安全 rebase 新 intent 或补写删除墓碑。

上传前会再次核验操作仍在当前 owner 的 Outbox 中，用户在前一请求等待期间撤销的后续条目不会被继续上传。随后按 cursor 分页 pull（每页 200、每轮最多 10 页），分别将任务和手动课程应用到各自 SQLite。两库应用和冲突记录完成后才推进 cursor；重放安全。存在本地未发送修改时不覆盖本机内容，而是保存本地 pending 与远端版本到 owner-scoped conflict 表。Renderer 增加逐条同步勾选、手动同步按钮、待发送/冲突摘要和冲突双方标题展示。

本机任务库从 schema v8 升至 v9，新增 `personal_sync_conflicts`；手动日历库仍为 v5。启动迁移前备份目标更新为 v9/v5。应用退出时停止继续发送/应用并等待当前网络请求结束，未确认 Outbox 留待下次重试。

**本轮不包含：**自动后台同步、冲突解决（选本机/选云端）操作、legacy quarantine 认领 UI、设备管理/撤销 UI、真实 Supabase 部署或真实双设备验收。没有授权执行 SQL migration；CI 与 mock 只证明本地逻辑，不代表远端已可用。详见 [32](32_ALPHA_SYNC_002D_PUSH_PULL.md)。


## 11. ALPHA-SYNC-002E 进度：冲突决策的安全最小闭环（2026-11-24）

PR #38 已合并。002E 优先交付：在已存冲突上选择“保留本机”或“采用云端”，先拉取到当前游标的远端增量，提交时要求冲突远端版本和本地 operationId 与审阅一致。保留本机时生成新的幂等操作 ID，按最新已知远端版本重基，并须再次手动同步；采用云端时删除对应 owner 的本地 pending，只覆盖符合来源白名单的任务/手动课程，若存在其他 owner 的同步关联则拒绝覆盖。远端删除不会自动恢复；仅明确选择后执行。冲突未解决时禁止它的队列上传和后续远端覆写。

本轮仍未覆盖设备被撤销、cursor 数据恢复后重新注册、legacy ownerless 行的人工审查/认领入口、跨数据库原子事务和真实 Supabase/双设备验收。完整同步 MVP 尚不具备发布条件，后续工作与已知恢复风险在 [33](33_ALPHA_SYNC_002E_CONFLICT_RESOLUTION.md) 中记录。


## 12. ALPHA-SYNC-002F 第一部分：Cursor/设备上传前预检（2026-11-24）

PR #40 已合并，legacy ownerless 审查流程完成。002F 首先实施不涉及数据库迁移的安全栅栏：读取本地设备记录时严格校验 UUID、游标十进制语法与服务端 bigint 边界；对非零游标且存在待发送操作的账号，在 push 前调用同 owner/device/cursor 的只读 pull。若服务端拒绝（例如 Cursor 已领先服务端、设备被撤销）则不进行上传；若发现未拉取变更，本轮先正常拉取并保留 pending，不提前发送，下一轮用户再选择手动同步。零游标无需提前探测是否超前，仍走服务端注册与原有 apply 版本 CAS。

这不是损坏游标修复工具：不重置游标、轮换 deviceId、不改历史 opId，不回写远端，也不启动后台循环。后续仍需要隔离备份与人工恢复、设备撤销后明确重新登记、跨 SQLite 崩溃恢复及真实 Supabase/RLS 双设备验证，详见 [35](35_ALPHA_SYNC_002F_CURSOR_PREFLIGHT.md)。


## 13. 002F 续篇：设备显式更换与零 Cursor 上传预检（2026-11-24）

在 PR #41 已合并的基础上，本轮增加当前账号无任务/日历 Outbox 且无持久冲突时的安全设备更换。Main 创建只属于当前登录 owner + deviceId + cursor 的一次性 review token；用户二次确认后撤销旧设备，再通过本地 CAS 更换本机设备 ID，原游标不倒退、不清空待发送操作，也不自动上传。撤销失败、账号切换、待发送操作在途出现、确认过期均阻断更换。所有存在 pending 的同步（包括 Cursor=0）都要先只读 pull 预检。损坏 Cursor 重建与待发送操作重放/对账留在下一阶段，参考 [36](36_ALPHA_SYNC_002F_DEVICE_REPLACEMENT.md)。


## 14. ALPHA-SYNC-002G：持久增量检查点与跨 SQLite 中断恢复（2026-11-24）

PR #42 已合并。本轮集中解决前述“task DB 已应用、calendar DB 未应用、cursor 仍旧”这一跨库崩溃窗口：任务库 v10 在处理每个 Pull 页前事务性记录 owner/device/fromCursor/完整白名单页；两库与冲突记录成功后 CAS 提交 Cursor 并同事务删除检查点。应用在途中断后，下次**用户手动同步**从本地检查点重放，阻断本轮未审查上传；设备更换期间不得丢弃检查点。不可解析的检查点、损坏/超前 Cursor 均失败关闭，不自动清零。完整验收与限制见 [37](37_ALPHA_SYNC_002G_CRASH_SAFE_PULL.md)；真实 Supabase RLS、多设备和 GUI 仍待单独授权验收。


## 15. ALPHA-SYNC-002H：只读健康诊断与已发送回执对账（2026-11-24）

在 PR #43 崩溃恢复检查点已合并的基础上，本轮实现供用户主动触发的恢复诊断：Main 读取当前 owner 设备/Cursor 和两个 Outbox、冲突/检查点，不创建本地设备；新增只读 RPC 根据 JWT owner 判断设备 active/revoked/unregistered 和云端 Cursor，标记超前但不自动回退。另一个只读 RPC 仅在 operationId 和**原完整操作请求**与服务端幂等回执完全一致时返回历史响应；客户端在所有返回通过校验后才对 accepted/duplicate 执行本地 ACK/CAS rebase，其他状态保持不变。无任何自动推送/云端变更；新 RPC 的迁移只留于仓库、须隔离项目额外安全审查。完整边界和验收见 [38](38_ALPHA_SYNC_002H_RECOVERY_DIAGNOSTICS.md)。


## 16. ALPHA-SYNC-003A：团队 Realtime 提示与最近窗口补拉（2026-11-24）

PR #44 已合并，开始团队实时工作流：Electron Main 用当前用户 JWT 连接 Supabase Realtime 的 `ate_workspace_messages`/`ate_workspace_tasks` 变更、加 workspace 过滤，仅推送没有原始行内容的 hint 到 Renderer；UI 仍经当前 JWT REST/RLS 验成员并抓取消息/任务，Realtime 可用时 30 秒安全补拉，掉线/订阅失败时 10 秒轮询+指数退避重连。切换工作空间、登出、成员撤权后关闭旧订阅并清空共享 UI。publication 迁移只保存在仓库，真实 Supabase/RLS 不曾部署验证。当前 REST 最近 100 条窗口还不满足持久游标与超过窗口历史补拉，003B/003C 仍待开发。详见 [39](39_ALPHA_SYNC_003A_REALTIME_HINTS.md)。


## 17. ALPHA-SYNC-003B：可靠历史变更日志与持久增量（2026-11-24）

PR #45 已合并，当前开发 003B：新增 workspace-scoped 事务提交顺序 Cursor、已有消息/任务回填、UPDATE/DELETE 变更日志、只读成员鉴权 RPC，客户端按页严格校验连续 Cursor、在独立 SQLite 中 CAS 原子提交。重启从已持久 Cursor 继续，历史消息/任务可本机键集分页，单次最多 2000 事件防止大同步独占 UI。当前队列涉及 **本地明文历史缓存**，需明确隐私与数据留存要求；新 SQL 尚未部署。服务器压缩/裁剪的安全恢复、真实五账号撤权 RLS 与平台 GUI 仍待 003C。见 [40](40_ALPHA_SYNC_003B_DURABLE_HISTORY.md)。


## 18. ALPHA-SYNC-003C：安全历史压缩与 Cursor 过期检查点（2026-11-24）

003B PR #46 已合并，当前 003C：增加 Owner-only 手动 checkpoint RPC 与受控事件裁剪、按当前 JWT 成员资格核验的不可变全量快照页；服务器返回明确的 expired checkpoint。客户端在 `study-anchor-team-history.sqlite` v2 中按 project/account/workspace 隔离暂存完整快照并持久化 ordinal，任何失败/中断不移动原 Cursor；全部完成后重新验证成员资格，再原子替换主缓存和位点，并继续拉取检查点后的变更。UI 重建期间隐藏旧缓存，禁止把不完整的最近 100 条冒充历史。迁移未在真实 Supabase 部署，Owner 压缩不会自动执行；五账号 RLS 及硬盘明文缓存保留/擦除仍需验收。参见 [41](41_ALPHA_SYNC_003C_CHECKPOINT_RECOVERY.md)。
