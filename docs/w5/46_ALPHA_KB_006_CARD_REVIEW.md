# ALPHA-KB-006 — 复习卡编辑、过期证据人工核对与本机历史

> 2026-11-25。基于已合并的 #54 / SQLite 知识库 v5。本批次仅扩展个人本机复习卡，不涉及团队同步、云端 AI、Canvas/邮件授权、或 UI #48 视觉重设计。仍需真实 Windows/macOS GUI 验收。

## 问题及产品边界

原有卡片只能新建、评分、删除；不能修改问题/答案。重导入文档后 needsReview=1 会显示旧证据警告，但没有可用的人工核对和重新引用流程。
如果继续给旧证据评分，可能强化已经过时的回答。新版本在 needsReview 时由 Main 拒绝评分；不能只靠前端按钮禁用。
本轮只允许用户修改自己编写的问答并明确确认其看到的新片段。不会让 AI/模糊搜索自动宣布旧证据“仍然正确”；未接入 FSRS、自动引用推断或跨设备复习同步。

## 数据库升级与恢复

- study-anchor-knowledge.sqlite 从 v5 升级到 v6；在 Electron Main 构建 KnowledgeStore 前调用 backupBeforeMigration，旧版数据库需生成 WAL-aware、校验通过的迁移前备份。
- v6 新增 knowledge_card_evidence_history，外键关联本地 knowledge_cards，记录人工变更前的证据片段原文、来源 SHA-256、旧页码、ordinal 和归档时间。删除卡片/资料将级联删除对应历史行；删除后不保证 SSD 上物理安全擦除，也不自动清理历史备份。
- 每次重新引用使用 BEGIN IMMEDIATE 事务：先验证卡片 updated_at 乐观锁、当前文档 revision、目标 knowledge_chunks 是否存在；再写旧证据历史、更新当前证据及 needs_review=0，一并提交。任一校验/SQLite 错误整笔回滚。
- 卡片编辑仅修改问题、答案、updated_at；不重置 review_count、interval_days、next_due、复习尝试表或引用哈希。
- 历史记录保存在同一默认未单独加密的本机知识库 SQLite 中；只读 IPC 返回当前卡的最近 30 次引用记录，不上传到云端。

## 用户操作

1. 在个人知识库 → 今日复习找到卡片。待复习与后续复习列表都提供「编辑问题和答案」「核对并修复过期原文 / 重新选择证据原文」「查看旧证据历史」。
2. 点击编辑，手动修改问答，按「保存卡片文字」。若同卡在另一个窗口/异步操作中已变化，将拒绝旧版本覆盖并提示刷新。
3. 文档被再次导入且原文发生变化后，卡片出现「来源已变化」提示，不能评分；旧原文快照仍可读。
4. 点击核对：对照旧摘录，选择新版资料的片段序号（从 1 开始）；查看新原文及 PDF 物理页码。如新原文不支持旧问答，应先修改问答，不能只勾选确认。确认操作必须再次显示确认弹窗。
5. Main 重新验证卡片和文档版本后才迁移证据。版本变化、无效片段、伪造 IPC 字段、非法确认串、重复问答约束均失败关闭；旧证据和评分不会在失败时被破坏。
6. 成功后可以继续按既有规则复习，旧证据可在本机查看。重新关联不会删除旧复习历史；且不会修改硬盘原始文件。

## 实施文件与契约

- src/shared/knowledge-model.ts：新增严格的 ReviewCardEditInput、ReviewCardRebindInput 与证据历史结构。
- src/main/knowledge-store.ts：v6 事务迁移、卡片 CAS 编辑、显式证据重关联、证据历史及过期证据评分阻断。
- src/main/index.ts、src/shared/ipc-channels.ts、src/preload/index.ts、src/renderer/src/vite-env.d.ts：三个 trusted IPC：knowledge:card-edit、knowledge:card-rebind、knowledge:card-history，不接受 Renderer 任意文件路径、SQL 或原文字符串。
- src/renderer/src/KnowledgeBase.tsx、ReviewCardMaintenance.tsx：已有导航内接入编辑、核对、版本历史；不改 App.tsx / styles.css / UI #48。
- src/main/knowledge-card-maintenance.test.ts 等：旧 v1-v4 fixture 隔离新版表后降级、真实 SQLite v5 迁移、版本 CAS、事务回滚、PDF 引用及复习日程不变。

## 自动验证

执行 npm ci、npm run typecheck、npm test、npm run build，并运行 src/main/knowledge-card-maintenance.test.ts、knowledge-store.test.ts、knowledge-pdf-store.test.ts、knowledge-graph.test.ts 和 src/shared/ipc-channels.test.ts 的针对性 Vitest。

合并前必须有与最新提交对应的 Windows + macOS CI 全绿，以及独立非作者 Review。平台 CI 不等于真实窗口交互、磁盘权限、旧资料备份恢复已手工验收。

### 后续人工验收步骤

使用自造的非敏感 Markdown/PDF 测试文档：新建卡、评分 → 编辑问答且保留 next_due → 重启确认 → 修改源文件并重新导入 → 验证评分被拒绝、旧证据仍在 → 手动选择新片段/页码并确认 → 查看旧引用历史 → 继续评分 → 重启和再次备份 → 从旧 v5 数据副本升级并检查 SQLite 完整性。不要把私人用户数据发给 CI/PR/助手。
