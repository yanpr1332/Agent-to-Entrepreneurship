# V0.2-03：真正本机神经 Embedding 的 Python/ONNX CPU 运行环境

> Alpha 后第三轮大开发。代码级故障注入和 CI ≠ 真实权重/双平台神经质量验证。本轮不下载模型权重、不上传私人知识库、不自动安装任何 Python 软件包。

## 已实现的部分

- 知识库页面新增「检查本机 Python / ONNX CPU 环境」：调用 Main-only 的只读诊断程序，检查 Python 版本、numpy、onnxruntime、transformers 能否实际导入以及 CPUExecutionProvider 是否存在。错误报告区分缺失 Python、配置路径错误、缺少依赖、CPU 不可用、超时和无效响应，但绝不向 Renderer 返回本机 Python 路径或原始异常。
- 离线推理和环境检测使用同一套 Python 选择优先级：显式 STUDY_ANCHOR_PYTHON_PATH（必须是存在的绝对路径）> 用户专有 HOME/.study-anchor/neural-runtime > 系统 PATH 中的 Python。
- 用户必须手动选择安装方式：在线 PyPI wheels，或自己审核并准备的离线 wheelhouse 目录。安装只在用户手动运行 setup 后发生；Electron 启动、npm ci、单元测试和模型导入都不会下载 Python 依赖或权重。
- Python 子进程环境改为必要操作系统路径/本机语言与临时目录的明确白名单，**不转交通过环境变量设置的个人 AI Key、邮箱密码、Supabase 凭据或 PYTHONPATH**；也不会默默复用任何代理进行模型下载。用户仍需自行审核安装/运行的第三方 Python wheels 与权重。
- Worker 继续使用 E5 查询/片段前缀、masked-mean pooling，或 BGE CLS pooling；固定 CPUExecutionProvider，最多 4 条 CPU 线程。严格禁止未知的必填 ONNX 图输入及错误的输出 batch/维度，不再给未知输入随意填零产生伪造向量。
- 真实用户自备 ONNX + tokenizer 数据：从原生目录对话框选择、逐资产 SHA256 校验、启动真实 CPU 推理验证后才替换先前模型。索引保留 SQLite revision pin、可中断/续建和词法 fallback。来源/许可仍需用户审查。

## Windows 上的具体步骤

打开 PowerShell 进入项目根目录，先执行：

~~~powershell
cd D:\Electives\AgentToEntrepreneurship\study-anchor
npm ci
npm run doctor:neural
~~~

如果缺少 Python 或依赖，先自行安装 Python 3.11–3.13，然后根据是否允许联网选择：

~~~powershell
# 主动允许下载第三方 Python wheels（官方 PyPI）
npm run setup:neural:runtime -- --online

# 或：用户已经审核过、含全部传递依赖 wheel 的离线目录
npm run setup:neural:runtime -- --wheelhouse "D:\reviewed-wheels"

npm run doctor:neural
npm run dev
~~~

这两个安装命令只选其一。不会向系统 Python 或 npm 目录安装；环境位于当前用户的 HOME/.study-anchor/neural-runtime。直接依赖清单位于 scripts/neural-requirements.txt，固定 numpy 2.2.6、onnxruntime 1.22.1、transformers 4.53.3。**它不是完整传递依赖 hash-lock；正式发布前仍需逐 wheel SHA-256、许可证、签名/SBOM 独立审核。** 如果 Python 版本/架构与 wheel 不匹配，pip 应明确失败而不是静默改用其他版本。线上安装从 PyPI 下载，不可在不信任网络或系统策略限制的电脑上盲目运行。

如果你自己有隔离 Python venv，也可以在程序启动前单独设置：

~~~powershell
$env:STUDY_ANCHOR_PYTHON_PATH = "C:\reviewed-venv\Scripts\python.exe"
npm run doctor:neural
npm run dev
~~~

## macOS

在 Terminal 中，预装 Python 3.11–3.13 后：

~~~bash
npm ci
npm run doctor:neural
npm run setup:neural:runtime -- --online
npm run doctor:neural
npm run dev
~~~

也可以用已审核的离线 wheelhouse 路径替换 --online。自定义已有隔离 venv：

~~~bash
export STUDY_ANCHOR_PYTHON_PATH="$HOME/reviewed-venv/bin/python"
npm run doctor:neural
npm run dev
~~~

## 模型准备和使用

用户自行从有许可的可靠来源获取 intfloat/multilingual-e5-small（384 维，query/passage 前缀）或 BAAI/bge-small-zh-v1.5（512 维，CLS pooling），并检查模型/转换来源与许可。所选目录需要 model.onnx（或官方常见的 onnx/model.onnx、onnx/model_quantized.onnx）、config.json、tokenizer.json 或 vocab.txt；可有 tokenizer_config.json、special_tokens_map.json。不要执行模型目录中的第三方脚本，程序只复制审核白名单中的数据文件并按 SHA-256 验证。

Study Anchor：知识库 → 检查本机 Python/ONNX CPU 环境 → 选择 E5/BGE → 选择本地 ONNX 文件夹 → 审核许可/文件 → 导入模型 → 构建/继续索引。只有真正的 CPU 推理进程通过模型维度预检才会启用它。没有真实模型时仍可精确/模糊搜索或使用旧的静态 .vec 模型。

## 需要人工验证、不能冒充完成的工作

1. Windows/macOS 各自运行真实 E5/BGE 权重至少 10 次查询，离线检查 P50/P95 延迟、RAM、CPU 占用，不用模拟向量声称性能。
2. 本机已有「导出证据目录 → 人工标注 → 用标注集评测」流程，需实际标注至少 30 条中英文问题的正负证据，比较词法与混合检索的 Precision@5、Recall@10、MRR@10。
3. 选一个额外依赖未知 graph 输入（例如 position_ids）的 ONNX 图，必须明确拒绝；中途中止索引、断网、模型切换、修改原文、模型 SHA 破坏重启后应保留旧词法结果。
4. 当前 Electron 安装包只携带固定 Python Worker 与诊断脚本；**不携带 Python 解释器、运行库、E5/BGE 权重**。本轮实现的是可以检测/配置的真实本地神经路径，而不是完整的一键免安装离线分发。正式可分发版需要独立的第三方依赖审查和资源打包轮次。

开发者回归命令：

~~~bash
npm run typecheck
npm test
npm run build
python -m py_compile scripts/neural-inference-worker.py scripts/neural-runtime-doctor.py
~~~

doctor:neural 在没有第三方 Python 依赖的 CI 主机上返回非零是正常行为；它不属于自动 CI 成功门槛。用户项目中所有私人资料、模型路径和查询均不向云端上传。开发必须保持单 PR、独立 Review、Windows/macOS CI 与真实设备分开记录。
