# W4-08 GitHub 分支、PR 与 main 分支保护

## 1. 目标
在五人团队和多个 AI 编程 Agent 并行工作的情况下，保护 main 始终保持可审查、可构建、可回退。规划文档和代码都通过独立分支与 Pull Request 进入 main，不直接向 main 推送。

## 2. 分支命名
- 功能：feat/<task-id>-short-name
- 修复：fix/<task-id>-short-name
- 文档：docs/<topic>
- 紧急修复：hotfix/<task-id>-short-name

每个分支应对应一个或一组紧密相关 Task ID。避免一个 PR 混入多个不相关模块。

## 3. Pull Request 最低要求
每个 PR 必须说明目标和范围、关联 Task ID、PRD/W2/W3 引用、修改文件和模块、数据模型/接口变化、测试命令和真实执行结果、Windows/macOS 影响、安全/权限/数据外传/第三方依赖影响、未完成项和风险，以及截图/录屏/脱敏日志等验收证据。

至少一名非作者成员复核。涉及安全、权限、邮件发送、Canvas OAuth、云端 RLS、数据库迁移或系统限制的 PR，必须由具备相应上下文的成员额外审查。

## 4. main 分支保护建议
建议在 GitHub Repository Settings → Branches（或 Rulesets）为 main 配置：

**立即启用的基础规则**
1. Require a pull request before merging。
2. Require at least 1 approving review；审批者不得是 PR 作者本人。
3. Require conversation resolution before merging。
4. Dismiss stale approvals when new commits are pushed。
5. Block force pushes。
6. Block branch deletion。
7. 管理员也应尽量遵守 PR 流程；如平台提供 bypass 选项，默认不授予日常开发 Agent。

**CI 建立后再增加的规则**
- Require status checks to pass before merging。
- 先确认工作流实际存在且稳定，再选择必需检查，例如 lint、typecheck、unit tests、integration tests、Windows build、macOS build。
- 不要在检查尚未创建时将不存在的检查设为必需，否则会把 main 永久阻塞。
- 根据团队实际节奏决定是否要求分支在合并前更新到最新 main。

**其他建议**
- 保留可审计的合并记录；优先使用 Squash Merge 或团队统一的合并策略。
- 不把 GitHub Secret 写进 PR 描述或测试日志。
- GitHub Actions 使用最小权限 Token，并固定经审查的 Action 版本。

## 5. 当前状态与操作说明
W4 采用独立文档分支和 PR 流程。当前 GitHub 自动化连接不能管理 branch-protection/ruleset 写入权限；因此本文件只定义目标规则，不宣称 main 已受保护。仓库管理员需在 GitHub Settings 中核验现状并启用规则。

设置入口：https://github.com/yanpr1332/Agent-to-Entrepreneurship/settings/branches

启用后，应由仓库管理员验证：
- 直接向 main 推送是否被拒绝。
- 无审批 PR 是否不能合并。
- 未解决 Review 对话是否阻止合并。
- 强制推送/删除是否被阻止。
- CI 建立后必需检查是否按预期运行。

## 6. PR 与任务协作
- Issue 是任务状态与当前 Driver/Reviewer 的记录点；Backlog 文档是任务定义的索引。
- 一个任务可以拆成多个 PR，但每个 PR 应保持单一主题。
- PR 未合并前不得把任务标记为“已通过”。
- 发生冲突时先更新分支并重新运行测试，不能直接覆盖他人提交。
- 只有经人工 Review、必需检查通过并满足分支规则后才合并。
