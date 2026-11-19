# ALPHA-KB-005：精确 + 容错 + 本地向量语义检索（后续规划与技术可行性）

> 状态：**已列入开发 Backlog，尚未实施、安装模型或新增依赖**。形成于 2026-11-19，基于已实现的知识库 FTS5 和单段 AI 辅助解释。此项不等于现有 PR #32 已实现向量语义搜索。截至 2026-11-19，PR #32 已合并；按新的 [同步优先计划](27_ALPHA_SYNC_FIRST_IMPLEMENTATION_PLAN.md)，ALPHA-KB-005 仍保留但排在同步核心门槛之后。继续遵守**同一时间只维护一个开发 PR**，不与 ALPHA-SYNC 并行实施。

## 1. 产品目标与用户价值

统一搜索入口，在用户明确启用可选本地语义功能后，对已获授权导入、且索引仍有效的个人知识库，组合：

1. **精确**：本机 SQLite FTS5，保证明确关键词、课程名、公式名、数字和引用符号的可发现性。
2. **模糊**：现有 trigram 候选 + 有界字符编辑距离，容忍少量拼写、标点、大小写差异。
3. **语义**：在本机以 embedding 模型将**查询和已导入文本块**编码为向量，使用余弦相似度召回同义表达、概念相关或中英混合表达。

第三路不能替代前两路。每条结果显示**来源文档、修订版本、块序号、PDF 页码（如有）、匹配渠道**与实际原文证据；点击后仍能回到原文。使用检索无需付费 API，也不能自动触发云端 AI 解释。

### 当前架构可直接复用

- 代码：src/main/knowledge-store.ts 已经将所选文档分块（约 1100 Unicode 字符，100 字符重叠），维护独立的 ate-knowledge.sqlite、FTS5 trigram、版本及来源元信息。
- 代码：src/shared/knowledge-search-text.ts 已有离线编辑距离和候选限制，PR #32 在同一条搜索中结合精确/模糊结果。
- 代码：src/renderer/src/KnowledgeBase.tsx 已有原文查看和版本标记。
- 运行环境：Electron 45、Node 24、Windows/macOS、React；当前 package.json **没有** ONNX/Transformers.js 或向量数据库依赖。
- **不同于当前可选的 OpenAI 单段解释**：新功能是本地模型推理+本地向量搜索，不需要 OpenAI Key、不向 AI 服务商传送文档。

## 2. 模型可得性及选型

| 候选 | 语言、规模及权重 | 推荐用途 | 当前判断 |
| --- | --- | --- | --- |
| [intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small)；[Transformers.js ONNX 转换](https://huggingface.co/Xenova/multilingual-e5-small/tree/main/onnx) | 多语言（含中文、英文），约 118M 参数，384 维，512-token 输入窗口；ONNX int8 / quantized 约 **118 MB**，原始 float32 约 **470 MB** | **首选原型候选**：中英混合课程与跨语言检索 | MIT；已存在可下载 ONNX 权重，无需自行训练或首次导出。但打包及 Windows/macOS 兼容性尚待实际验证 |
| [BAAI/bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5)；[官方 BGE 型号表](https://bge-model.com/tutorial/1_Embedding/1.2.1.html) | **偏中文**，24M 参数、512 维；官方基础权重约 **95.8 MB** | 中文优先、低资源设备的基线对照组 | MIT；体积更小，但对英语/中英混合课程是否足够，必须用真实数据集对比 |
| [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) | 多语言、1024 维、最大 8192 tokens；约 **568M 参数 / 2.27 GB** 的原始模型规模 | 后续大型文档、较高质量基线 | MIT；模型、内存和初始化成本明显更高，**不作为初版默认下载** |

体积为公开仓库的**模型权重近似值**，实际完整下载与运行内存还会包含 tokenizer、配置、WASM/ONNX runtime、缓存和中间张量。**没有**在本项目硬件上实测速度、内存或排名质量，不将外部 benchmark 直接认定为本项目表现。模型转换分发版的授权链、文件来源、版本与 SHA-256 必须在真正内置/下载前另行核验；不得把第三方模型权重改标为项目自身的 PolyForm Strict 许可。

**E5 的注意事项：** 检索时查询需添加 `query: ` 前缀，文档块需添加 `passage: ` 前缀，并采用与模型卡一致的池化/归一化策略；否则会明显影响检索效果。文档分块约 1100 Unicode 字符，不保证落在 512-token 窗口内，因此必须按实际 tokenizer 限额分段，保留与原文块/页码的关联。

## 3. 可用推理技术与实际难点

- **首选试验方案：** [Transformers.js](https://huggingface.co/docs/transformers.js/api/env) + 现有 ONNX 权重，先以 CPU/WASM 在 Windows/macOS 实测。库明确提供 `localModelPath`、`cacheDir`、`allowRemoteModels=false`，可以实现模型文件就绪后**彻底禁止远程加载**。
- 模型应由用户**主动点击安装/启用**（显示来源、尺寸、许可和所需磁盘空间），下载只取经白名单审核的固定版本；支持离线手动导入、哈希校验、中断重试、明确移除缓存。**索引生成期间不自动把私人内容发出设备**。不应为所有用户预装数 GB 模型。
- 推理应放在 Electron 专用 Worker/Utility Process 或独立可取消任务中，避免 Node 同步 SQLite 和大模型计算卡住 UI；设置队列、进度、取消、内存上限和失败后的 FTS-only 降级。
- **向量库初版优先用单独 SQLite 表保存版本化 Float32 向量 + 小规模批量余弦比对**，尽量避免新的可执行原生扩展。用户库变大后再评估 [sqlite-vec](https://github.com/asg017/sqlite-vec)：它可以与 SQLite 配合，但 Electron/Node 的扩展装载、安全白名单、二进制分发及 Windows/macOS 架构需要单独审查，不能直接假设兼容。
- 向量索引可以新建单独的 ate-knowledge-vectors.sqlite；记录 documentId、ordinal、documentRevision、contentHash、modelId、modelRevision、dimension、pooling/normalization/version。新导入/重导入/删除文档必须**增量更新或清理**相应向量。模型更换时必须重建索引，不能混用不兼容向量。
- 三路结果按 documentId+revision+chunkOrdinal 去重，考虑 Reciprocal Rank Fusion（RRF）等**名次级融合**；先以精确词和文档证据为硬性优先，避免裸 cosine 分数误压重要的精确结果。权重必须通过本项目基准集决定，不预设“语义结果永远更好”。

## 4. 难度评估与开发拆分（不是工期承诺）

| 工作项 | 技术难度（1 最低，5 最高） | 主要不确定性 |
| --- | --- | --- |
| 取得可用模型/许可核对 | **1–2/5，容易** | 确认第三方 ONNX 转换文件、哈希和模型许可归属 |
| 本机 CPU 推理 PoC | **3/5，中等** | Node/Electron 原生/WASM 包装、模型内存、实际速度 |
| 向量索引及增量维护 | **3–4/5，中等偏难** | 旧文档更新、页码引用、版本失效、恢复与重新索引 |
| 三路检索融合与质量对比 | **3–4/5，中等偏难** | 中英双语样本、同义表达、误召回、边界过滤与引用 |
| 安全下载、安装包和双平台交付 | **4/5，较难** | 体积、网络中断、签名/校验、Windows/macOS 架构、离线模式 |

**结论：模型本身很容易获得，整体工程难度中等偏高（约 3–4/5），不需要自己训练 embedding 模型。**

建议未来**按一个 PR 一轮的方式**迭代，且新一轮必须在上一 PR 关闭/合并后开始：

1. **ALPHA-KB-005A / PoC：** 用两种小模型和脱敏中英文测试集实测命中率、CPU 延迟、占用内存、权重尺寸及许可证；做“完全离线”断网验证。初版只在测试环境，不修改用户真实库。
2. **ALPHA-KB-005B / 本地索引：** 用户可选安装/卸载模型；向量分块、索引增量更新、版本迁移/恢复、进度取消、分离的资源配额；不上传私有资料。
3. **ALPHA-KB-005C / 搜索融合：** 搜索 UI 精确+模糊+语义合流，标注匹配类型、原文跳转、去重和用户开关，模型不可用时仍按旧方法检索；Windows/macOS GUI、安装包和性能验收。

## 5. 验收标准与不得误报的事项

- 在**明确选择并导入**的本机测试资料中，中文同义表达、中英跨语言表述与错拼词均能找到相关原文；数字/专有名词仍能精确检索。实际用 30–100 条人工标注的中英双语检索样本比较 Precision@5、Recall@10、MRR@10、延迟、内存和索引时长；指标阈值由 PoC 证据设定。
- 关闭 Wi-Fi/断网后检索功能完整可用；模型首次获取必须显式同意，下载完成后禁用隐性网络模型拉取；没有模型时原 FTS/模糊检索正常。
- 编辑、删除、重新导入时不返回失效的旧向量证据；PDF 结果引用真实页码；模型更换会提示重建索引，重启后持久化。
- 模型缓存/派生向量数据应可被用户查看大小、显式清除；不删除原文、复习卡或其他本机资料。备份/恢复策略、磁盘空间与个人隐私风险单列。
- 不使用真实私有学校材料做 CI；未实测的模型速度、准确率与可选硬件加速**不得标为已通过**。真实 Windows/macOS GUI 验收仍由用户集中完成。
- 不新增外部 API Key 或强制云端调用；**本地语义检索与可选 OpenAI 单段解释相互独立**。没有模型时不阻断已有知识库。

## 6. 外部资料（2026-11-19 核对）

- [E5 原始模型卡：MIT、多语言、query/passage 前缀](https://huggingface.co/intfloat/multilingual-e5-small)
- [Transformers.js 兼容 ONNX 权重及量化文件大小](https://huggingface.co/Xenova/multilingual-e5-small/tree/main/onnx)
- [BGE 官方型号表及原始模型大小](https://bge-model.com/tutorial/1_Embedding/1.2.1.html)
- [BGE 中文小模型与 MIT 许可](https://huggingface.co/BAAI/bge-small-zh-v1.5)
- [BGE-M3 模型](https://huggingface.co/BAAI/bge-m3)
- [Transformers.js 本地模型和禁用网络文档](https://huggingface.co/docs/transformers.js/api/env)
- [sqlite-vec 项目](https://github.com/asg017/sqlite-vec)
