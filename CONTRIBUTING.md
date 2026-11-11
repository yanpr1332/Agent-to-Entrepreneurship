# 参与贡献与开发协作

感谢参与 Agent-to-Entrepreneurship。项目已完成 W1 PRD、W2 UI/UX 归档、W3 技术架构归档、W4 内部 Alpha 开发计划，
并落地 W5/W6 共 15 个垂直切片。各切片的真实验收状态以 [W5 验收矩阵](docs/w5/00_ACCEPTANCE_MATRIX.md) 为准，
「代码已完成」不等于「已通过验收」。

## 开始前
1. 阅读 docs/PRD.md、docs/DECISIONS.md、docs/ui-ux/README.md、docs/architecture/README.md 和 docs/w4/README.md。
2. 在 docs/w4/02_DEV_BACKLOG.md 查找唯一 Task ID，确认是否已有 Issue、分支或 PR 正在处理，避免重复开发。
3. 阅读相关模块契约、数据模型、权限和测试要求。
4. 认领任务前确认临时 Driver、Reviewer、允许修改的文件范围、依赖和验收证据。

## 灵活认领，不固定人岗
团队由五名学生组成，工作时间和技术能力可能变化。项目不将某位成员永久绑定到前端、后端、集成或测试岗位。成员按可用时间和能力动态认领任务。每个具体任务只设一个临时 Driver，至少有一名不同成员复核；任务可交接，但必须更新 Issue/PR 状态和已修改文件清单。

## 分支与 Pull Request
- 禁止直接向 main 推送日常开发变更；使用独立 feature/fix/docs 分支。
- 分支名包含 Task ID，例如 feat/CAN-004-courses 或 fix/MAIL-008-unknown-state。
- **每轮开发仅创建一个 PR**，但可以在该 PR 的分支中提交多个 commit。属于同一轮的相关工作继续推送到同一 PR，不得为子任务再开堆叠 PR。
- 合并目标统一为 `main`；禁止将某轮的 PR 合并到旧 feature/fix 分支后就当作已完成进入主分支。合并前核查 PR 的 base，并在合并后检查主要功能文件在 `main` 的存在性。
- 一轮内多个任务允许合并，但应清楚列出各任务的修改范围、依赖与验收证据，避免跨轮混合。
- PR 必须说明目标、Task ID、修改路径、测试命令及真实结果、平台影响、安全/隐私影响和未完成项。
- 至少一名非作者成员审查；涉及权限、凭据、Canvas OAuth、邮件发送、RLS、系统限制和数据库迁移时需要额外审查。
- 解决 Review 对话并通过配置的检查后才合并。
- main 分支保护建议和当前待管理员核验事项见 docs/w4/08_GITHUB_GOVERNANCE.md。

## AI 编程工具
AI Agent 必须获得明确 Task ID、允许修改路径、禁止修改路径、接口约束、验收标准和测试命令。Agent 不得自行更改 PRD 优先级、放宽权限或安全要求、把 Mock 说成真实接入通过，或把密钥写入仓库。

## 安全与隐私
不得在 Issue、PR、代码、测试日志或公开文档中上传真实账号令牌、邮箱密码、Canvas Token、OAuth Client Secret、AI API Key、真实邮件正文、课堂录音或受限课程文件。凭据使用系统安全存储或经审查的安全密钥管理方案。

## 贡献许可
项目采用 MPL-2.0。贡献代码前应确认有权以此许可证提交。若未来引入额外贡献者协议，将提前公开讨论，不追溯假定授权。
