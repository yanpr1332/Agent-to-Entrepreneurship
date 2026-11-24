# ALPHA-KB-005A：本地语义检索的向量索引与评估基础

> 本批次只交付**纯本机、版本化向量索引及混合排序基础设施**，不安装、打包、下载或假装运行任何真实 Embedding 模型。不涉及线上服务、AI API Key、账户数据、团队同步 RLS、用户私有资料上传。UI 改版 PR #48 独立推进，本批次不改它的 `App.tsx` / `styles.css`。

## 这一轮真正实现的内容

1. **知识库 SQLite v4**：`knowledge_vector_config` 记录单一活跃模型（固定模型 ID、SHA-256 版本/权重标记、维度、float32-l2 和 passage-query-v1 协议）。`knowledge_vectors` 的 `chunk_id` 有外键指向当前原文块，任何文档重导入或删除都会通过现有知识库事务自动移除旧向量，防止“来源已删、向量还留着”。
2. **严格向量验证**：embedding 必须是 2–2048 维、有限非零、可归一化的实数数组；以**小端 Float32、L2 归一化**持久化。拒绝 NaN/Infinity、零向量、维度不匹配、模型版本不匹配。无任何外部向量数据库或原生扩展。
3. **有界离线索引**：一轮最多生成 16 个已获授权原文块向量，整个索引最多 6000 个。调用未来**可信的本机模型**之前检查文档 revision，`await` 推理完成后再次检查 revision、模型版本、原文块 ID 与内容，再使用单个 SQLite 事务写入整批；发现重导入、模型更换、损坏输出或容量超限时拒绝整批，无部分数据写入。
4. **混合搜索基础**：从同一份知识库按当前文档 revision、model ID、model SHA256 和原文 `sha256` 确认向量有效，计算本机余弦相似度；先保留**精确**命中的全部现有排序，再对容错/语义两个尾部使用 RRF 名次融合，去重键为 `documentId + documentRevision + chunkOrdinal`。结果仍提供来源标题、revision、原文证据、真实 PDF 页码，并标记 `semantic`。原本 `KnowledgeStore.search()` 不变。
5. **失败回退**：没有模型、模型配置不一致、单个向量损坏或推理输出不可信时，无模型路径保留原有精确与容错搜索；没有任何逻辑会将资料自动发往外网。模型切换会在本机一个事务中清空旧向量索引，**不删除知识库原文、复习卡、知识图谱和个人任务**。
6. **升级前备份**：Main 把 `study-anchor-knowledge.sqlite` 的备份目标版本从 v3 提升到 v4。使用已有 WAL-aware SQLite 在线备份 API，真实原件不被备份流程修改。
7. **质量评估工具**：新增 `evaluateRetrieval`，按**证据块**而非仅按文档计算 Precision@5、Recall@10、MRR@10，强制明确相关性标签并拒绝重复结果，方便后续对中英跨语言语义、错拼和引用质量做可重现的对照。

## 暂时不能宣称的能力

- **尚未集成真正的 ONNX / Transformers.js / E5 / BGE 推理库，也没有实际本机模型**。本轮自动化测试的 `LocalEmbeddingProvider` 是仅在测试代码中的小型词表向量桩，用来验证索引、崩溃一致性、失效处理、原文引用及融合排序；不能把该桩称为真实 Embedding、跨语言模型或质量达标。
- **尚未提供模型安装/卸载或可选启用 UI**：生产 Main 不向 Renderer 暴露向量注入通道、不接受用户提供的任意远程模型 API URL，知识库实际使用时仍按原有 FTS/容错搜索。后续模型运行层需要**用户明确同意**、权重来源和许可核验、固定修订、SHA-256、CPU/WASM 真实性能和完全断网验证。
- **索引未使用加密数据库**：知识库原文现在本就保存在本机 SQLite，向量会泄露部分语义信息；本轮不创建任何默认向量，也不自动为用户现有资料跑模型。后续在功能实际启用前需要明确告知本地持久派生索引与清除方式。
- 索引及搜索目前在内置的 `node:sqlite` 数据库和 JavaScript 余弦匹配中完成，最大 6000 向量有硬上限；后续实际模型推理必须放入受限异步 Worker / Utility Process，并通过实际 Windows/macOS GUI、内存和进程取消验收。
- Supabase 的五账号 RLS、团队历史压缩恢复、真实多设备和生产部署仍处于单独的 Alpha 验收队列；这批本地知识库改造**不代表团队同步联机验收已经通过**。

## 自动化与独立验证

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/knowledge-embeddings.test.ts src/main/knowledge-vector-index.test.ts src/main/knowledge-retrieval-benchmark.test.ts src/main/knowledge-store.test.ts src/shared/ipc-channels.test.ts
npm test
npm run build
```

覆盖真实 SQLite 关闭重开、老 v3 库升级、无模型回退、两份原文的精确优先 + 语义补充、PDF 第 2 页引用、模型版本切换、整批失败零提交、导入与异步推理竞争、文档删除后的外键级向量清理、非法向量、去重和三项质量指标。**CI 通过仅意味着本地数据流程通过，并不证明真实模型准确率或实际运行速度。**

## 后续 KB-005B / 005C

优先顺序：
1. 用户自愿从审核过的来源安装/离线导入真实模型，校验固定权重、许可证、SHA-256、依赖供应链和 CPU 内存上限，明确关闭自动远程模型拉取；
2. 在 Electron 隔离进程内加载模型、按 tokenizer 窗口安全分段、建立用户可取消的增量索引进度与磁盘配额；
3. 通过真实 30–100 条中英标注查询的 Precision@5、Recall@10、MRR@10 / latency 基准调整融合权重，添加启用开关、状态、清除、证据跳转及 Windows/macOS 离线 GUI 验收。
