# ALPHA-KB-003：知识库安全预览与离线容错搜索（PR #31）

> 功能代码已提交 GitHub；是否通过自动化检查以最新 PR Checks 为准。用户尚未进行真实 Windows GUI 集中验收。本轮没有实现完整 TeX 编译，也没有接入 AI 语义搜索。

## 支持范围

- **格式导入**：原生 Electron 文件选择器允许 .md、.markdown、.html、.htm、.tex、.latex、.txt 和可提取文字的 .pdf。UTF-8 文本文件限制 2 MiB，PDF 限制 12 MiB、120 页；依旧拒绝符号链接、二进制和无效 UTF-8。
- **Markdown 预览**：标题、段落、强调、行内代码、代码围栏、列表、引用、基本表格，以及简单的行内/块数学。
- **HTML 预览**：仅展示安全标签的文本/层级结构，完全丢弃 DOM 属性（包括 style、onclick、href、src），不处理 img/video/iframe/script/style 等资源或可执行内容。不运行 JavaScript，不渲染远程图片，不请求远程地址。
- **LaTeX 预览**：常见 section/subsection、itemize/enumerate、textbf/emph 和 equation/align 的有限子集。简单数学（如希腊字母、上/下标、分数、平方根）使用原生 MathML。**不支持完整 TeX、复杂宏包、TikZ、宏定义、引用解析、外部文件读取或 PDF 编译**；不支持的内容可能作为普通文本出现。
- **双模式**：知识库资料阅读器可切换「阅读预览 / 原始源码」，不覆盖本地文件或 SQLite 原始快照。原文片段证据仍保留标题、版本、PDF 页码和分块序号。
- **全文搜索**：先用 FTS5 进行精确匹配，没有命中且归一化查询长度 4–60 时，用 FTS5 trigram 提取最多 200 个候选，再按有界编辑距离选出最多 40 条容错结果，明确标记“容错匹配”。这不是 AI 语义理解；不上传任何内容。
- 为避免迁移旧表的 CHECK 约束，HTML 和 TeX 在 SQLite 中仍以受支持的基础文本格式存储，界面展示格式由**经原生文件选择器认可的本地扩展名**还原，源代码字符串保持原样。旧库仍为 schema v3，**无新迁移**。
- 预览最多处理前 80,000 字符，以控制内存和 UI 卡顿；源码展示仍可读取全文快照。

## 安全限制与已知边界

文档内容不可信。预览不使用 dangerouslySetInnerHTML、外部服务、TeX 命令执行或任意浏览器 HTML 属性。HTML 解析是特意受限的阅读器，不承诺像 Chrome 浏览器一样完整还原 CSS 布局；数学公式是 MathML 子集，不是 KaTeX/LaTeX 完整引擎。

本地容错算法可能产生误命中，不承担专业搜索引擎的复杂排序职责。短于 4 字符的查询不做编辑距离容错，完全不同语义的同义词暂不自动匹配。用户资料无需发送给云端 AI，也未自动索引已有未授权文件。

## Windows 集中验收

在 PR #31 未合并时，使用隔离数据目录测试当前分支。可复制 PowerShell 命令：

~~~powershell
git fetch origin
git switch -c alpha-kb-pr31 --track origin/feat/alpha-kb-003-safe-preview-fuzzy-search
npm ci
$env:ATE_USER_DATA_DIR = "$env:LOCALAPPDATA\ATE-alpha-kb-003"
npm run dev
~~~

若本地分支已存在，请用 git switch alpha-kb-pr31 然后 git pull --ff-only 更新，不要重置尚未保存的代码。Electron 缺失、沙箱故障和诊断命令详见 [README](../../README.md)。

### 人工验收要点

1. 建立没有私人资料的 .md 文件，包含标题、表格、代码块、**加粗**、简单公式 $x^2$；导入后核对预览和源码切换。
2. 创建 .html 文本，含 <h1>、<p>、<script>、onerror/onload 属性、指向测试无效域名的 img 标签。预览应显示文字标题和段落，但**不执行、不加载、也不显示危险代码内容**。源码模式应仍能看到原文件完整内容。
3. 创建 .tex，包含 \section、itemize、\frac{a}{b} 和 x^2；检查基本结构与 MathML 公式。输入 TikZ 或自定义宏，确认不会自动编译/执行，并不把不支持内容描述为已排版。
4. 搜索 polymerase 应有精确结果；拼错一个字母如 polymeraze 应得到标为“容错匹配”的来源片段；输入完全无关的长短语应无误报。
5. 搜索命中 .md/.html/.tex 与 PDF 后，点击引用，检查打开的原始文档和片段序号，PDF 保留物理页码；生成复习卡仍从原文片段取证，不从排版后的 HTML 动态生成来源。
6. 尝试非法二进制、过大文件、无效 UTF-8 和符号链接，确保均被拒绝；不允许任何自动云端上传。
7. 在同一隔离目录重启应用，检查已导入内容、搜索和复习卡保持，原始文件未被覆盖。
8. 关注长文档预览性能：超过 80,000 字符提示被截断，但源码仍保留导入快照。复杂 HTML/LaTeX 仍需专项安全审查，不以本轮测试代替完整安全审计。

## 下一阶段候选（未实现）

完整数学渲染引擎的离线依赖审核、复杂 Markdown 标准支持、文档分页、搜索排名优化、同义词或嵌入向量语义检索。若未来引入云端 AI，必须单独征得用户明确授权，保留来源引用与数据发送预览，并设定成本与隐私边界。
