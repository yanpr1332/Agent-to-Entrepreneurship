# V0.2 第一轮：Electron 启动诊断与云端会话安全/联机恢复

> 2026-11-25，Alpha 汇报后的集中开发。当前是代码级修复与模拟故障测试，绝不代表已完成真正五人 Supabase、Windows/macOS 安装或外部 API 验收。所有 CI 与真机验收须分别记录。

## A. Electron 45 安装与启动前诊断

- npm run dev、npm run dev:compat 均会先调用纯只读 scripts/electron-dev-preflight.mjs，检查 Electron npm 包、path.txt 和当前平台的真正可执行文件。用户此前遇到的 Electron uninstall 会在启动 electron-vite 之前得到有针对性的修复说明，而不再只有堆栈。
- npm run doctor:electron 手动检测，npm run setup:electron 才通过当前 electron npm 包的 install-electron --no 下载锁定版本的二进制。启动诊断本身**永不联网或静默重装**，也不修改任何 userData。
- 仅在受限本机开发环境可以临时选择 dev:compat 关闭 Chromium sandbox；正常运行、正式构建不得默认这样做。官方安装方法见 https://www.electronjs.org/docs/latest/tutorial/installation。
- 如果用户下载受阻，需自行确认网络与可信镜像的来源。不得为了绕过 Windows 安全策略而关闭系统保护。

Windows PowerShell 示例：

~~~powershell
cd D:\Electives\AgentToEntrepreneurship\study-anchor
git switch main
git pull --ff-only origin main
npm ci
npm run doctor:electron
# 如果提示缺少 Electron binary，执行用户主动授权的下载：
npm run setup:electron
npm run doctor:electron
npm run dev
~~~

## B. Supabase 登录状态跨账号/项目隔离

- Electron Main 的 SharedCloudClient 现在使用会话版本（auth epoch）：登录、注册、退出、配置项目会使旧异步授权结果失效。
- 用户 A 开始登录后退出，迟到的登录响应不得把 A 重新登录；A 的 refresh_token 尚在途时用户 B 登录，旧刷新失败不能把 B 踢下线。
- 项目或账号切换后旧 REST 响应在交回 UI 之前被拒绝。一个用户的两个并发受保护请求共用一次刷新，不会执行两个相互竞争的 refresh token 更新。
- 服务端刷新令牌如意外换回另一用户 UUID，将直接拒绝并关闭旧会话，而非悄悄切换身份。Main-only 的 Realtime JWT 返回前也执行项目与会话版本校验，Renderer 不接触 JWT。
- 说明：已经发送到服务器的写请求不能凭退出登录撤销；本轮的防护重点是拒绝旧响应污染后继账号状态。个人同步仍须人工触发、遵守现有 Outbox 幂等与冲突保留边界。

## C. Realtime 断网恢复和可见诊断

- 以前首次 watchWorkspace 时成员检查发生临时网络错误，会直接拒绝且不再自动建立实时订阅。现在进入 fallback（普通 REST/RLS 轮询仍在），Main 用最多 30 秒有界指数退避重试成员检查和 WebSocket 连接，恢复后提示一次完整补拉。
- 已知 401/403 或服务端不再具有成员资格，属于撤权/授权失败，不再反复重试；前端会清理对应共享 UI。Realtime 数据帧仍只作为变化提醒，所有真实数据重新经 REST/RLS 和成员检查获取。
- 小组页新入口「立即刷新小组」，并显示上次成功向云端核对的时间以及最近刷新失败状态，方便两名测试者现场核对断网恢复；正常实时连接约 30 秒安全补拉，退化状态每 10 秒轮询。
- 云端身份真正过期时重新核对 Main 状态，旧成员/消息/任务不继续显示；状态诊断本身失败则隐藏原共享内容、要求显式重新登录。

## 本轮离线回归命令

~~~sh
npm ci
npm run typecheck
node --test scripts/electron-dev-preflight.node.mjs
npx vitest run src/main/cloud/supabase-session-races.test.ts src/main/cloud/workspace-realtime.test.ts src/main/cloud/supabase-client.test.ts
npm test
npm run build
~~~

用模拟文件系统/时钟/网络检查 Windows/macOS/Linux Electron 路径、A/B 登录乱序、退出/换项目、刷新令牌错号、旧 REST 响应丢弃、两请求单次刷新、首次网络不可用回退、断网自动重连与旧 workspace 重试取消、撤权后不重复连接。CI 绿色不能取代真实五人联机和真机启动。

## 两台真实电脑联机验收（需用户授权独立测试项目）

1. 依照仓库 59_SUPABASE_FIVE_ACCOUNT_WINDOWS_WALKTHROUGH.md 预检并由管理员审核部署七份 SQL。确认 URL + Publishable Key，不用高权限 Secret/service_role 或生产数据。
2. A 与 B 使用不同合法 Auth 账号，在不同网络的设备启动相同提交，登录同一工作空间。A 发消息、B 建任务，观察实时标签、最近一次成功刷新以及两端一致性。
3. 让 B 暂时断网 1 分钟；A 继续发送有编号消息并改任务。B 恢复联网后观察自动恢复，点击「立即刷新小组」，确认无丢失或重复。
4. B 切换账号或项目、A 撤销 B，旧团队内容不能重新出现，旧 JWT 经服务端 RLS 不能读写。离线电脑已看过的数据和备份不保证物理擦除。
5. 五账号服务端权限脚本只在非生产隔离项目、真实五账号、明确写入确认后执行。必须先跑 npm run preflight:supabase，不由 CI 自动连接外部云端。

## 后续阻塞与第二轮

真实安装包、OS Keychain/DPAPI、五账号 RLS/Realtime/撤权、真实 Canvas、交大 IMAP/SMTP、个人付费模型仍需独立用户授权与真人测试。V0.2 下一轮将集中推进明确授权的逐文件跨设备同步与冲突恢复；其后为真正可打包的本地神经 embedding 和质量评估。

提交代码仍遵循一轮一个 PR、双平台 CI、独立 Review 后合并的规则。