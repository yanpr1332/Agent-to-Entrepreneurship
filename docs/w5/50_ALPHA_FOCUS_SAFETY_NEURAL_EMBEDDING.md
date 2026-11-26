# ALPHA-FOC-003/004 + ALPHA-KB-005D：专注保护与真正本地神经向量检索

> 2026-11-25，单 PR 开发。**安全性优先于所谓无法绕过的限制**。自动化 CI ≠ 系统权限验收或真实模型基准。

## A. 专注：系统级黑/白名单提醒 + 用户可控的全屏保护

- 保留原来专注计时与积分协议，默认模式“仅计时”，不主动扫描其他应用。
- 用户在计时前可显式选择“监测前台程序”或“全屏保护+监测”；输入最多 20 个程序/进程名，黑名单命中提醒，白名单之外提醒。
- Windows：固定脚本通过 User32 的 GetForegroundWindow/GetWindowThreadProcessId 读取前台进程；macOS：通过固定 osascript/System Events 读取前台应用进程。只读，不读取窗口内容/浏览器标签；需要时遵循 macOS 系统授权，绝不绕过 TCC。未知或权限不足显示“检测不可用”，不伪装监控成功。
- **不存在**强制杀进程、修改 Hosts/DNS、防火墙、系统权限或阻断任务管理器的行为。**不会真正阻止其他程序或网站运行**；全屏保护只改变 Study Anchor 自身窗口显示模式，并在用户选择时总在最上层。用户可以用系统切换、强制退出、安全快捷键解除。
- 启动保护前注册系统级 `Ctrl/Cmd+Shift+F12` 紧急退出；快捷键注册失败则整个保护启动失败，不锁窗。页面也一直提供“紧急解除专注保护”按钮。暂停、取消、完成、超时、窗口关闭、应用退出、OS 检测失败均不能把用户困在限制状态。
- Main 只在内存保存一个 lease，最长 180 分钟，应用重启后永不恢复保护。没有跨系统启动的后台守护进程、持久化占用焦点或开机自启机制。
- 不把前台程序名称写入 SQLite、日志、网络或云端；仅在本机 UI 提醒用户本人。系统安全和恢复功能不列为干扰项。

**未完成/必须如实提示**：真正对第三方进程的系统级屏蔽（需要额外操作系统权限与专用适配层）、白名单强制切换、浏览器站点级限制，以及 Windows/macOS 实机权限与紧急退出的完整验收。不能将“监测+全屏”宣传为 FOC-02 的不可绕过强制限制。

## B. 神经模型：离线 E5 / BGE ONNX 推理接入

- 两个明确模型家族：`intfloat/multilingual-e5-small`（384 维，masked mean pooling，查询带 `query: `，文档带 `passage: `）与 `BAAI/bge-small-zh-v1.5`（512 维，CLS pooling）。输入 token 长度上限 512，超长段截断，必须通过人工评测识别截断对相关性的影响。
- 通过 Electron 原生目录选择器，选择**用户自行获得并审核许可的本地模型文件夹**。根目录允许 `model.onnx`（或 `onnx/model.onnx`、`onnx/model_quantized.onnx`）、`config.json`、`tokenizer.json` 或 `vocab.txt`、可选 `tokenizer_config.json` 和 `special_tokens_map.json`。只复制这些固定类型的数据文件；拒绝符号链接、超限体积、错误 BERT 隐藏维度、格式和路径篡改。Graph 文件上限 750 MiB、总资产上限 800 MiB。
- 每份资产读时计算 SHA-256，模型 revision 由选定型号、资产哈希、pooling 方案和版本协议共同派生。安装先复制到私有暂存目录、通过独立 CPU 进程真实 ONNX 模型与 tokenizer 预检，才替换当前语义模型。重启后复核每个资产 SHA，异常安全退回精确和容错词法检索。
- 使用固定打包 Python Worker（`scripts/neural-inference-worker.py`），没有动态执行模型目录中的代码。它仅加载用户已经安装的 `numpy`、`onnxruntime`、`transformers` 和本机 ONNX/tokenizer 文件，`trust_remote_code=False`、`local_files_only=True`、`HF_HUB_OFFLINE=1`、`TRANSFORMERS_OFFLINE=1`、禁用遥测和代理；无需 API Key 或联网。
- 旧的 `.vec` 静态词向量 Worker 完整保留，可以回退。两种后端复用现有 SQLite 向量索引、文档 revision 失效处理、精确优先混合检索、人工标注的 P@5/Recall@10/MRR@10 对照；绝不把测试用合成向量算成真实 E5/BGE 质量。
- 安全边界：不会默认下载/附带第三方权重，模型来源、许可证及 Python 依赖由用户主动审核；本机用户提供的运行时属于第三方程序，**不能视为产品自身已经签名或审计**。

### 运行时前置条件（真实推理，不是模拟）

需要用户在自己的电脑建立独立 Python 环境（优先 3.11/3.12）、从已审核来源安装 `numpy`、`onnxruntime`、`transformers`；不要在模型文件夹执行任意第三方 Python 脚本。可把 `STUDY_ANCHOR_PYTHON_PATH` 环境变量设置为该隔离环境中的 Python 可执行文件**绝对路径**，之后启动 Study Anchor。此值不由 Renderer/IPC 控制。默认尝试 PATH 中的 `python3`（macOS）或 `python`（Windows）。

模型文件夹示意：

```text
my-e5-small/
  model.onnx                # 由可信 ONNX 转换源获得
  config.json
  tokenizer.json
  tokenizer_config.json     # 可选
  special_tokens_map.json  # 可选
```

本项目不在首次启动时通过 Python 包管理器安装依赖，也不随 Electron 安装包包含模型权重。没有运行时或文件校验失败时**不能声称神经模型已安装成功**。系统会保留原模型并显示失败。

### 实操验收

1. 分别在 Windows/macOS 断开网络，确认纯词法检索和旧 `.vec` 模型仍可使用；检查系统进程不连接模型仓库或第三方服务。
2. 在隔离 Python 环境自检 `python -I -c "import numpy,onnxruntime,transformers"`，导入真实、已取得许可且可辨认的 E5/BGE 量化 ONNX 模型。安装应通过 CPU 预检，索引从 0 正常建立并可取消、重启恢复。
3. 人工创建至少 30 条中英双语、相关与不相关证据标注；在真实设备离线比较 Precision@5、Recall@10、MRR@10、延迟与内存，并测文档重导入导致的向量失效；不要以零样本或合成测试宣称质量达标。
4. 篡改一份已安装 ONNX 文件，重启应拒绝恢复该后端、词法搜索可用；无权限模型目录、软链接、模型不匹配时失败关闭。不修改或泄露原始私人文件。
5. 在 Windows/macOS 启动专注保护，核实黑/白名单提醒、权限拒绝的提示、从托盘/应用切换仍可使用系统、快捷键+按钮紧急退出、倒计时结束和取消、强制退出/崩溃/重启后不遗留窗口限制。分别断网、断权限、双窗口尝试和深度休眠测试。
6. CI 应通过 TypeScript、全部 Vitest、Electron bundle 与离线 Worker smoke，并单独记录安装包 Python worker 资源路径。真实 GUI、模型和签名检查不能由 CI 替代。

## 后续缺口（不能标“全部完成”）

- 生产级模型运行时的一体化离线分发、依赖许可证/SBOM、供应链签名与可复现 hash-lock；Windows/macOS 两端真实神经 CPU/内存验收；设备真实程序阻断（非提醒）需要专用权限和安全退出演练，不能在没有授权时强行实现。
- 模型权重不是仓库源码的一部分，不得上传私人模型或学校数据到公共 CI。用户需要同意第三方模型许可。
