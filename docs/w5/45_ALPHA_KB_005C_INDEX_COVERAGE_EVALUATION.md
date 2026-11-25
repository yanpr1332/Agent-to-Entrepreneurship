# ALPHA-KB-005C — 本地索引覆盖率、异常恢复与可复现检索评测

> **实施批次：2026-11-25**。在已经合并的 KB-005B（本机静态词向量 Worker）基础上加固可靠性及建立真实可用的离线评测入口。**尚未引入 ONNX / E5 / BGE 神经 Transformer 推理**；其依赖、模型权重、安全供应链和真实双平台性能验证仍待独立工作，不得把本轮静态词向量测试当作 Transformer 已可用。

## 发现的真实阻塞

原 005B 在某一篇私人文档全部不在静态词向量词表中时，Worker 的错误导致整个索引调度停止。下一次启动仍挑中相同原文块，用户即便有其他大量可编码资料也无法继续建立语义索引。缺少“已编码 / 无词表覆盖 / 待处理”状态时，`indexed / total` 还容易误导用户以为索引卡死了。

修复原则：**未知词不是系统崩溃，也绝不能生成伪造的零/随机向量**。对于确实无法编码的原文块，将其作为源文档版本、模型 SHA 和正文 hash 关联的、可恢复的负向结果。其他推理异常必须仍然报错/回滚，不得错误分类为“词表外”。

## SQLite v5 与跨重启恢复

- 新建 `knowledge_vector_skips` 表，以 `chunk_id` 主键、文档 ID、当前 revision、原文 hash、模型 ID/SHA、固定原因 `vocabulary_miss` 记录“仅因词表覆盖不足不可编码”。对 `knowledge_chunks` 外键级联删除，源文档重导入/删除时自动失效。新模型配置/卸载时与旧向量在**同一数据库事务**内清除。
- `indexEmbeddingBatch` 支持可选的 `embedPassages()` 语义：每批最多 16 个结果中只有确认为词表外的 passage 返回 `null`；已编码向量与跳过状态在一个 SQLite 事务内提交。一项异常维度、非法 Float32、取消或 revision 改变，**整批 ROLLBACK**，不能先提交部分成功项。
- `nextEmbeddingTarget` 忽略同模型、同 revision 的已编码和词表外记录，继续后面可索引的资料。重启后直接读取 SQLite 的持久状态续建，不再在同一段无限循环。后续文档修订将重新尝试索引原文。
- `embeddingStatus` 与 UI 显示明确的 `indexed`（已编码）、`skipped`（词表外）、`pending`（尚待处理）和 `total`。仅完成 indexed+skipped=total 才可判断所有段落已处理；**词表外片段不能参与语义召回，但仍可命中原有精确/容错搜索**。
- App 启动执行 **WAL-aware SQLite v4 → v5 升级前备份**（`backupBeforeMigration(...,5)`）；原始备份和明文知识资料不被本轮更改。
- 原有 005B 模型、已建立向量和精确/模糊检索保持兼容；Worker 在 `passage` 请求中只把确定的未知词情况标为 null，`query` 未知词仍拒绝并自动回退原有本机搜索。

## 本机标注与模型质量验收

真正的模型质量必须通过**用户自己确认相关性的证据标签**测试，而不是声称平均词向量能通用理解中英语义。

1. 在个人知识库中点击“**导出证据目录（供手动标注）**”，明确同意后通过 OS 保存对话框把最多 500 条原文块引用保存至本机 JSON；字段仅含 `evidenceKey`、标题、PDF 页码、最多 240 字摘要。**目录可能包含私人学习内容，必须私下保存，绝不自动上传**。如果本机目标文件已存在，拒绝覆盖而不是悄悄改写。
2. 对目录中的真实资料人工整理评测文件，格式如下（需要把示例证据 ID 换成实际导出值，不能直接使用示例作为有效标签）：

```json
{
  "schema": 1,
  "cases": [
    {
      "id": "bio-en-001",
      "query": "energy production in mitochondria",
      "relevant": ["00000000-0000-4000-8000-000000000001:1:0"]
    }
  ]
}
```

3. 点击“**用本地标注集评测检索**”，通过原生文件选择器加载最多 **128 KiB、100 条查询、单查询不超过 20 个证据引用**的 UTF-8 JSON。严格验证字段、重复 ID、document UUID、修订号和 ordinal。不存在或已经更改的证据版本**直接拒绝评测**，绝不把过期答案当作模型错误。
4. Main 在**同一台电脑**上逐条执行两次查询：原本精确+容错检索，与当前已安装/已建向量的本地混合检索。用相同的人工作业标签计算 **Precision@5、Recall@10、MRR@10**，并提供两套路径各自的 P50/P95 延迟、实际出现语义候选的查询数和当前索引覆盖率。仅显示汇总结果，不把 query/原文/标签写日志或传出客户端。
5. 评测时没有安装模型、有效向量数量为零、索引正在运行或有文档标签过期时直接拒绝。模型切换/取消时避免发布跨模型混杂的汇总；没有完成独立公开数据测试前**不能宣称 E5、BGE 或任何特定模型性能指标**。

## 完成条件与测试

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/knowledge-index-coverage.test.ts src/main/knowledge-quality-audit.test.ts src/main/knowledge-vector-index.test.ts src/main/knowledge-offline-models.test.ts src/main/knowledge-word-vectors.test.ts src/shared/ipc-channels.test.ts
npm test
npm run build
```

测试覆盖：混合批次原子存储向量和跳过记录、同批非法结果/取消整批回滚、真正 Worker 只对 `passage` 无词可用时返回 `null`、跨重启跳过同一原文块、文件重导入后重新建索引、旧 SQLite v4 正确升级不丢数据、模型版本更换清理状态、词表外仍能被 FTS 查询、标注样本大小与注入边界、本机文件软链接和过期引用拒绝、成对检索指标和私有证据目录导出。

**仍需单独手动验收：** 真实 Windows/macOS 安装包中通过系统文件选择器导出证据、加载非合成标注并比较词向量表现，观察持续索引下的 CPU/内存与长时间使用；真实双语检索的质量不能仅凭单元测试确认。

## 新增：无需手写 JSON 的本机人工标注工具（005C 续篇）

- 知识库页面提供「开始创建人工标注集」：用户输入自己的检索问题，分页（每页最多 50 条）浏览本机证据目录，**不是只能从模型已命中的搜索结果中选**。跨页勾选 1–20 条相关原文，最多 100 条案例；删除、重新编辑当前查询不更改数据库内容。
- 前端预检，Main 再次严格校验同一 `schema:1/cases` 协议。新增只读、固定分页 `knowledge:embedding-evidence-page` 与确认后通过 Electron **原生保存对话框**导出标签的 `knowledge:embedding-save-labels`。Renderer 不接受任意文件路径/SQL；Main 对来源文档 revision+ordinal 逐一回读后写入。
- 文件使用 Node `wx` 独占创建和仅当前用户模式（受 OS 权限语义限制）；拒绝已有文件、软链接、超 128 KiB、错误结构、失效原文。用户可以随后选择自己保存的 JSON 进行原有词向量/词法成对评测。已导出目录仍可作为离线审查和大批量人工标注的辅助文件。
- **这不是自动生成真值或公开数据集**。用户必须自己判定、尽可能勾选全部相关证据；只选搜索命中的结果会造成评测偏差，尤其要审查漏召回证据。私有原文摘要、用户问题和标签不会上传；导出到用户选定的位置后，由用户保护文件。
- 回归包括证据分页、规范化标签保存、重复/越权/格式错误/旧引用拦截、不覆盖已有文件及 Renderer 约束；Electron Windows/macOS 真实 SaveDialog 与用户标注质量仍须人工验收。

## 后续神经 Embedding 独立批次

已研究的本机推理方案包括 Transformers.js 的 `env.allowRemoteModels=false` 和 `env.localModelPath`，以及 `intfloat/multilingual-e5-small` 的 ONNX 文件与 MIT 许可；但**本次没有给 npm 增加无法核验的依赖、没有提交不完整 package-lock、没有下载或打包权重**。后续提交必须独立审查 runtime/ONNX native binary 的 Windows/macOS 兼容性、离线 tokenizer/池化与前缀协议，固定所有模型文件 SHA-256 和权重许可证；在隔离 CI 中验证真实推理、资源上限、5–10 条基线和至少 30–100 条真实中英标签，再面向用户开放。

参考：[Transformers.js 本地模型配置](https://huggingface.co/docs/transformers.js/custom_usage) 与 [multilingual-e5-small 模型信息](https://huggingface.co/intfloat/multilingual-e5-small)。外部网站材料不属于本项目的自动下载流程。
