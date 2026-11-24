# ALPHA-KB-005B — 可选本机词向量模型、Worker 推理与增量索引闭环

> 2026-11-24 开发批次。**这是纯本机静态词向量检索，不是 E5/BGE Transformer、ONNX 或训练过的通用中英模型**。仍待 Windows/macOS 实际 GUI、长期性能以及真实独立数据质量验收。PR #48 的视觉工作独立审查。

## 为什么先用词向量

005A 完成了 SQLite v4 向量数据层，但没有真实模型。本轮以可选的**用户本地导入静态词向量（word2vec / fastText 导出的 .vec 文本子集）**打通真正的离线“权重文件 → Worker 编码 → 分批索引 → 三路检索 → 中断/重启 → 卸载”链路，无需引入未知的原生 Node/ONNX ABI 和庞大的初始下载。

实际词向量的质量取决于来源和词表覆盖。模型不支持 transformer 注意力、上下文语义推理、E5 的 query/passage 前缀或 BGE 的 instruction。为了避免假造结果，完全不认识的原文块不会被生成随机向量；该批次会保留已完成的索引并提示用户词表不匹配。**不得把 CI 中的六词微型词表当成公开模型已达到的语义检索准确率**。

## 用户操作（默认关闭）

1. 进入**个人知识库 → 资料与搜索 → 本机词向量语义索引**。默认只能进行原有 FTS 精确/容错检索，不联网下载模型，不自动索引私人文档。
2. 用户自行取得并检查使用许可、来源及权重完整性，选用 UTF-8 编码、LF 换行、第一行 `词数 维度` 的纯文本 `.vec` 文件（例子在下方），点击“导入本机 .vec 词向量”并确认后由 Electron **系统文件选择器**选取。应用不接受 Renderer 随意提交文件路径，不执行模型文件中的脚本，也不调用云端服务。
3. 主进程对源文件执行常规文件/软链接/体积检查，读取上限 **32 MiB、15000 个词、2–384 维**。解析 Unicode 词表、有限 Float32 坐标、重复/异常词条；SHA-256 与模型维度一起登记版本，将通过验证的只读模型副本保存至本机 `userData/knowledge-models/<sha256>.vec`，manifest 存于同一目录。运行时 Worker 再次验证内容 SHA-256；用户自行提供的原文件**不修改/不删除**。
4. 用户再点击“构建/继续本地索引”，应用对知识库已导入的原文段落（最多 6000 个）逐批生成向量，每轮不超过 16 个，并使用 005A 的事务保护核查文档 revision 与模型 SHA。完成的批次随 SQLite 保存；取消、应用退出或异常时，不提交尚未完成的批次。重新开始会跳过已存在且版本有效的向量。
5. 查询时 Worker 在本机计算平均词向量；精确命中仍优先，容错和余弦语义结果随后融合，**每条引用都是当前数据库中真实原文和 PDF 页码**。模型不可用或无法识别查询词时，自动沿用原来的离线精确/容错结果，不触发云端 AI 单段解释。
6. 点击“卸载本机模型与向量”并确认后，仅删除本应用缓存的模型副本与生成的 SQLite 向量，**不删除已导入知识、源文件、复习卡、知识图谱、团队或云端数据**。本地 SSD、历史备份或文件系统快照可能仍留存旧向量；此操作不是物理安全擦除。

## 示例格式（演示，不是预训练模型）

```text
4 3
energy 1 0 0
mitochondria 0.9 0.1 0
线粒体 0.9 0.1 0
calculus 0 0 1
```

第一行含词条数量和维度；之后每行是单个 Unicode 词和该维度的**有限、非零**浮点坐标，空格分隔。词条按 Unicode NFKC 和小写标准化去重。英文按词切分，中文尝试在已导入词表内最长匹配（最长 8 字符）。这不是与标准 fastText/word2vec 所有变种 100% 兼容的通用导入器：gzip/二进制 `.bin`、带空格短语、巨型原始模型、自动分词器和 `model.onnx` **不受支持**。需要自行在具备相应许可和工具的离线机器上裁剪为小型 UTF-8 文本词表。

## 安全与运行约束

- Worker 固定由项目源代码编译并打包在 `out/main/knowledge-word-vector-worker.js`，不允许从用户导入文件执行 JS、WASM、DLL、Shell 或任意可执行路径；模型文件仅为数字数据。不向网络发送用户原文；不引入第三方推理下载器，也不索要 OpenAI Key。
- Worker 首次启动及每次查询/索引采用队列、单次批量 16、超时边界；取消/卸载前阻断进行中的文档向量事务。模型文件导入最多 32 MiB；长文档在已有的 1100 Unicode 字符段落上编码，**没有 transformer tokenizer 的 512 token 分段限制**。
- 存储的向量索引与历史本机数据库**未额外加密**。即使只在本机运行，拥有磁盘文件访问权限的人可能推断知识库的部分语义信息，请勿将其默认上传公开备份。
- 关闭/重启后通过私有 manifest 和模型文件 SHA-256 再次验证；如果文件不匹配或 Worker 失效，保留数据原件、停用语义候选并继续精确/容错检索。源文档的原有 FTS、知识图谱、复习卡完全不依赖模型。
- 对非 ASCII 源文档和跨语言文本，只能宣称实现了静态词向量聚合；**没有针对真实词向量的 30–100 条双语 Precision@5、Recall@10、MRR@10、CPU/内存和质量基准**，也不宣称优于纯 FTS。
- 初次文件验证在主进程执行，允许上限 32 MiB；正式大模型和大规模词表应转用独立导入 Worker/Utility Process 进行流式校验，并追加签名及来源白名单的供应链审核。

## 验收

```sh
npm ci
npm run typecheck
node node_modules/vitest/vitest.mjs run src/main/knowledge-word-vectors.test.ts src/main/knowledge-offline-models.test.ts src/main/knowledge-vector-index.test.ts src/shared/ipc-channels.test.ts
npm test
npm run build
```

`npm run build` 在 `electron-vite build` 后附加执行 `node scripts/verify-offline-worker.mjs`，**真正从 Windows/macOS 的构建产物启动 Worker**，加载临时 UTF-8 词向量，并校验查询编码和未知词失败。其余测试覆盖本地安装、SHA、权限/路径约束、词表解析、中文词典匹配、旧库重启、实际 Indexed SQLite 混合检索、增量续传、模型卸载、用户原文件保留及取消前事务检查。

## 后续迭代（尚未交付）

- **KB-005C：** 明确审核本机 Transformers.js/ONNX Runtime 的版本和许可证，集成可被用户主动选择、固定 SHA 的 multilingual-e5-small / BGE-zh 真正神经编码器，在独立推理进程做实际 tokenizer 分段、池化和归一化；支持更大模型、下载中断恢复、配置/运行时签名、内存预算以及性能及双语质量对比。
- 对真实用户安装包进行 Windows/macOS 端到端 GUI：本机确认、导入文件、索引中断、文件恢复、OCR 以外的 PDF 页码证据、误用模型/许可提醒、系统离线和原文删除等。
- 多账号云 RLS 验收仍是独立的 ALPHA-SYNC 门槛，本轮不部署 Supabase SQL 或变更 Canvas/email/privacy 隔离。
