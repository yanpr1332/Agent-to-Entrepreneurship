# W4-08 GitHub 分支、PR 与 main 分支保护

## 1. 目标
main 始终通过 PR 接收变更。其他成员和 AI Agent 可以自由创建分支及 PR；仓库所有者负责最终审查。所有者自己创建的 PR 不能自我批准，因此必须保留管理员绕过审批的能力，完成自审后合并。

## 2. 规则
- Require a pull request before merging：开启。
- Require review from Code Owners：开启。
- Required approvals：1。
- CODEOWNERS：`.github/CODEOWNERS`，全仓库由 `@yanpr1332` 负责。
- Dismiss stale approvals：开启。
- Require conversation resolution：开启。
- Block force pushes：开启。
- Block branch deletion：开启。
- 不设置尚未存在的 CI status checks；CI 建立后再添加。
- 允许仓库管理员 bypass review requirements，以便所有者自己的 PR 在完成自审后合并。此权限只属于仓库管理员，不授予普通成员或 AI Agent。
- 若 GitHub 分支规则支持 bypass list，优先只列仓库管理员；不要把普通团队成员加入 bypass list。

## 3. 两类 PR 的处理
### 其他成员/Agent 创建的 PR
1. 由 `@yanpr1332` 作为 Code Owner 审查。
2. 所有者提交一个 Approval。
3. Review 对话解决且其他必需检查通过后合并。

### 仓库所有者自己创建的 PR
1. 所有者不能批准自己的 PR，GitHub 会拒绝作者自批。
2. 所有者完成自审和测试检查。
3. 使用仓库管理员 bypass 合并；保留 PR、diff、提交和合并记录。
4. 不通过伪造第二个审批账号来规避 GitHub 审计。

## 4. GitHub 配置入口
https://github.com/yanpr1332/Agent-to-Entrepreneurship/settings/branches

本仓库已在本 PR 分支新增 `.github/CODEOWNERS`，内容将全仓库指定给 `@yanpr1332`。**这不等于分支保护已开启**：必须由仓库管理员在 Settings 中创建针对 `main` 的 Branch protection rule 或 Ruleset，并启用以上规则。

## 5. 验收
- 普通成员 PR 无所有者审批时不能合并。
- 所有者审批普通成员 PR 后可以合并。
- 所有者自己的 PR 不要求作者自批；管理员 bypass 可用。
- 普通成员和 Agent 无法直接推送 main、强制推送或删除 main。
- 未解决 Review 对话阻止普通合并。
- CI 检查只在工作流真实存在后才设为必需。

## 6. PR 质量要求
每个 PR 说明 Task ID、目标、修改范围、数据模型/接口变化、测试命令及真实结果、Windows/macOS 影响、安全与隐私影响、未完成项和验收证据。涉及权限、凭据、邮件发送、Canvas OAuth、云端 RLS、数据库迁移或系统限制的 PR 必须额外审查。
