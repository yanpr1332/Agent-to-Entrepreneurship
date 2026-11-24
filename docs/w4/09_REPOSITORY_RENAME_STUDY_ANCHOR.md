# REPO-RENAME-001：GitHub 仓库更名为 Study Anchor

> 日期：2026-11-24 · 范围：仓库和展示品牌整理 · 真实安装包升级验收：尚未进行

## 已确定的名称

- GitHub 仓库：[`yanpr1332/study-anchor`](https://github.com/yanpr1332/study-anchor)
- npm 根包（`package.json` + `package-lock.json`）：`study-anchor`
- 当前界面显示名、网页 `title`、W2 HTML 原型：**Study Anchor**
- 老 GitHub 仓库名：`Agent-to-Entrepreneurship`（历史名，GitHub 通常为旧仓库 URL 提供重定向；不保证所有外部工具/硬编码 API 路径都适用）

## 为了防止静默数据丢失，以下历史标识本轮**不改**

| 项目 | 保留值 | 原因 |
| --- | --- | --- |
| Electron Builder `build.appId` | `org.agenttoentrepreneurship.desktop` | OS 安装标识、更新与可能存在的授权/快捷方式依赖 |
| Electron Builder `build.productName` | `Agent to Entrepreneurship` | 更改可能影响 OS 的应用支持目录、安装路径、卸载记录及 `userData` |
| `ATE_USER_DATA_DIR` | 原环境变量 | 本地 Alpha 隔离目录、用户脚本和既有部署兼容 |
| `ate-*.sqlite` 及旧偏好/缓存文件名 | 原文件名 | 避免被应用视为新数据库，导致用户误以为原数据消失 |
| Supabase `ate_*` 表、RPC、迁移文件名 | 原协议标识 | 更改将涉及线上数据库及真实 RLS 兼容性；仓库改名不代表云端迁移 |
| 历史 Commit、Tag、PR、许可证文件 | 原记录不改写 | 审计/许可证及已有讨论链接可追溯 |

> 因此本轮**界面已经显示 Study Anchor，但 Windows/macOS 安装包名称依然可能显示原英文名**。这是一项明确的兼容性取舍；不要误认为已完成完整安装品牌迁移。正式更换需另开独立任务，先做旧安装 → 新安装、用户数据目录备份与无损迁移、卸载/更新和 Windows/macOS GUI 验收。

## 已有本地克隆如何切换

先在本地仓库目录检查未提交的修改，不要执行清空或强制重置：

```sh
git status --short
git remote set-url origin https://github.com/yanpr1332/study-anchor.git
git remote -v
git switch main
git pull --ff-only
npm ci
npm run typecheck
npm test
```

- 旧的本地**文件夹名不会被 GitHub 重命名自动改变**；保留原目录名称完全没问题，`cd` 路径必须使用实际本机目录。
- 远端从 `.../Agent-to-Entrepreneurship.git` 改为 `.../study-anchor.git` 即可；无需重新克隆。
- 团队其他机器、本地定时脚本、编辑器 Git Remote 和外部 CI 可能要同步更新；本 PR 只改仓库里确定可见的引用，不会触碰你的本地电脑。
- 本轮 PR 合并前，`main` 仍有旧的包名和界面品牌；上述 `npm ci` 要在包含更名提交的分支或合并后的 `main` 才可验证更名结果。

## 代码和文档改动

1. `package.json`、`package-lock.json` 根包名称一致，**没有升级/重装第三方依赖版本**。
2. Electron Renderer 界面品牌、HTML 标题、W2 静态原型品牌统一为 Study Anchor；原有本地路由/IPC/DB 访问未变。
3. README、贡献说明、产品定位、决策记录、GitHub 治理链接及许可证历史链接更新至新的仓库路径。历史许可证本身不改变。
4. 回归测试确认 npm lockfile、可见品牌、稳定安装标识及原有数据目录环境变量不因更名被改动。

## 本轮验收

```sh
npm ci
npm run typecheck
npm test
npm run build
```

还要在 GitHub PR 检查 Windows/macOS Actions 结果，至少由非作者成员审查后合并。CI 不代表旧安装包数据迁移、真机卸载/升级或外部系统 webhook 已完成测试。

## 后续独立任务（未执行）

- 决定是否要将发行安装包 `productName` 与 `appId` 迁移为 Study Anchor；若要改，应先制定幂等、可回滚的 Windows/macOS 用户数据迁移与备份方案。
- 检查仓库外的链接（Supabase Dashboard、Webhook、GitHub App 允许列表、外部 CI、分享给同学的文档）是否需要逐个更新。
- 域名、商标、正式发布的品牌资源与证书署名需要单独确认。
