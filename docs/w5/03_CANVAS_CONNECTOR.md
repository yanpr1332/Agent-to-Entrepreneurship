# W5 Canvas Personal Token 开发验证连接器

> 范围：W4-008、CAN-001/002、CAN-004 的本机开发验证与最小真实只读界面。**不是五人正式 Canvas 接入验收。** OAuth Developer Key 申请继续并行进行。

## 交付内容

- 在「数据接入」页面填写 Canvas 实例地址（例如 https://oc.sjtu.edu.cn）和**开发者自己的**个人 API Token。
- Main 进程使用 Bearer Authorization Header 调用真实 Canvas API，不把 Token 放入 URL。
- 连接时先验证能真实读取授权课程，再使用 Electron safeStorage 的异步 OS 加密接口保存 Token。
- 已连接状态下可刷新课程、选择课程并读取作业名称、截止时间、分值。
- 用户可断开并删除本机加密 Token 文件。
- 非法实例地址和跨域分页 URL 被拒绝；请求设置 HTTPS、禁用自动重定向和超时上限。
- 课程/作业数据通过窄 IPC DTO 返回 Renderer；**Token 不会出现在状态、课程、作业、日志或云端同步接口中。**

## 实例与认证限制

个人 Token 是开发阶段的单人验证手段，不能要求五名成员各自生成 Token 用作多用户正式授权。后续必须采用学校/Canvas 管理员 Developer Key + OAuth 授权，并在拿到正式授权前把它标记为外部阻塞。

所有人都不应把 Token 发送给 AI、放进 GitHub Issue/PR、提交仓库、共享到 Supabase 或团队消息。此连接器没有任何后台自动上传行为。

## 数据与权限边界

| 对象 | 保存位置 | 规则 |
|---|---|---|
| 个人 Token | Electron 用户数据目录中的系统加密密文文件 `canvas-personal.enc` | OS 密钥来自 safeStorage（Windows DPAPI / macOS Keychain），Renderer 不持有持久化凭据 |
| Canvas 实例地址 | 与 Token 一起放入加密文件 | 只接受公共 HTTPS 实例根地址 |
| 课程/作业 | 本次会话的 Renderer 内存状态 | 本轮不持久化、不上传团队云端 |
| 本地任务 SQLite | 用户本机原有 `ate-local.sqlite` | 本轮 Canvas 数据尚未写入任务表 |

**特别说明：** safeStorage 使用系统提供的密钥对本地文件内容加密；并不是把完整 Token 直接保存为系统 Keychain/凭据管理器中的独立条目。对无法获得系统加密服务的环境，拒绝落盘。真实 macOS 未签名构建可能遇到 Keychain 提示。

## 安全保护

- 公共 HTTPS 主机校验，拒绝 localhost、IP 地址、局域网主机名、HTTP、URL 用户信息、非标准端口、附加路径和查询参数。
- API 读取只访问自身实例 `/api/v1/` 下的路径；跟随 Canvas Link 分页时再次校验同源与路径。
- 使用 `redirect: "error"`，避免携带 Token 的请求因重定向发送给其他服务。
- 使用 15 秒超时、最多 20 页与 1000 结果数量上限，避免异常拉取。
- 连接器只返回最小必要字段；不向 Renderer 发送 API Token 或原始未筛选 HTTP 数据。
- 用户确认断开后删除密文文件。若 Token 可能已泄露，还需到 Canvas 网站撤销该 Token。
- DNS rebinding 等高级网络威胁需独立安全评审；当前对公共域名的语法校验不能证明 DNS 解析目标永远可信。

## 测试与验收

GitHub CI 可以使用**合成 Token 与模拟 HTTP Responses** 验证：
1. 地址验证与危险目标拒绝；
2. Bearer Header 而非 URL 参数；
3. 正确处理 Link 分页和跨域分页拦截；
4. 返回课程和作业 DTO；
5. 401/403/429 错误处理；
6. 加密凭据文件不出现明文 Token；
7. OS 加密不可用时拒绝保存。

CI 的这些测试不等于学校真实连接成功。**真实 API 验收必须由开发者在自己设备上，使用自己的合法 Token，手动点击连接并验证真实课程与作业。** 不需要把 Token 提交给仓库，也不需要提供给助手。

## 下一轮待完成

- 申请 Developer Key 并实现 OAuth（不同成员各自授权、独立 Account ID）。
- 为 Canvas 作业建立带来源的本地任务映射、重复同步去重和用户自定义字段保护。
- 同步状态、撤权通知、增量同步与适当请求限流。
- 真实交大邮箱 IMAP/SMTP 接入以及 AI 邮件事项候选；此功能需要单独评估依赖和安全设计。
- 五人 Supabase Auth/Workspace/RLS/Realtime PoC。

本轮不增加 npm 依赖，不使用 RDC，也不在用户电脑安装软件。

## 参考

- Canvas OAuth/API 文档：https://canvas.instructure.com/doc/api/file.oauth.html
- Canvas 分页文档：https://developerdocs.instructure.com/services/canvas/basics/file.pagination
- Electron safeStorage：https://www.electronjs.org/docs/latest/api/safe-storage
