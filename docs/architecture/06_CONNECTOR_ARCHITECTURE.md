# W3 Connector Engine 与外部接入
## 架构
统一 Connector Engine 负责账户授权、凭据句柄、调度、分页、限流/退避、错误状态、同步游标、来源 ID、去重、重连及撤销。独立 Adapter 转换第三方协议；M1/M2/M7 负责业务，不让每个模块直接依赖平台 SDK。首版内置适配器，不建设公开 Connector 市场。

| 平台 | 版本范围 | 真实验收重点 |
|---|---|---|
| 上海交大 Canvas | **P0** 课程、作业、日历只读 | 合法授权、分页、截止时间变更、远端提交与个人完成分离 |
| SJTU jAccount 教务 | **P0** 真实课表 | 开发者申请、lessons scope、周次/节次/地点 |
| 交大邮箱 | **P0** 真实收件和监督发送 | Mail API 或可验证 IMAP/SMTP、阅读/发送分权、超时核验 |
| Google Calendar | **P0** 只读及增量 | OAuth、重复事件/时区、撤权 |
| Outlook Calendar | **P0** Microsoft Graph 日历 | 个人/学校租户权限、管理员拒绝 |
| Notion | **P0** 指定页面/数据源读取 | OAuth、字段映射、限流及访问范围 |
| ICS、CSV、Markdown | **P0** 导入导出 | 映射预览、编码、去重、回滚 |
| Gmail / Graph 专用邮件 | **P1** | 单独 OAuth 敏感权限和公开验证 |
| 更多高校/插件市场 | P1/P2 | 待后续决策 |

**关键优先级约束**：通用 IMAP/SMTP 可作为交大邮箱的技术实现与后续扩展基础，但“所有邮箱服务商均 P0 可用”并未被批准。Gmail/Outlook 的 P0 是**日历**而非专用邮箱。

## Adapter 契约
```ts
interface ConnectorPort {
 capabilities(): ConnectorCapabilities;
 authorize(req:AuthRequest):Promise<AuthResult>;
 pullChanges(accountId:string,cursor?:string):Promise<ExternalPage>;
 disconnect(accountId:string):Promise<DisconnectResult>;
}
type ExternalPage = {
 items: Array<{provider:string;accountId:string;externalId:string;
 remoteVersion?:string;deleted?:boolean;sourceUrl?:string;payload:unknown}>;
 nextCursor?:string;hasMore:boolean;
};
```
错误码至少区分 AUTH_REQUIRED、ADMIN_DENIED、INVALID_SCOPE、RATE_LIMITED、OFFLINE、CURSOR_EXPIRED、REMOTE_UNKNOWN。按 provider+account+externalId 去重；外部来源时区/版本/URL 保留，用户自有备注单独储存。OAuth 使用服务商允许的桌面授权方式（常见为系统浏览器授权码+PKCE），机密 client secret 不打入 Electron 包；jAccount 密码不由软件收集。

## 真实接入四层门禁
接口文档存在 ≠ 适配器开发完成 ≠ 合法真实测试通过 ≠ 普通用户可正常授权发布。校方审批/组织管理员/公开 OAuth 验证可能是发布阻塞因素；必须在 W4 早期 Spike 记录证据。手动 ICS/CSV 导入可作为备份路径，但不能冒充真实 API P0 验收。

## 发信适配
收到 M7 已冻结的草稿版本、From/To/Cc/Bcc/回复对象/附件及用户该次确认后，才允许一次实际发送。SMTP/API 超时可能已送达，进入 unknown 状态，先核对远端，绝不自动盲重发。邮件内容不可信，连接器访问权限不自动赋予 AI 处理或云端外传权。


## W4 V0.1 实施补充（2026-11-07）

### Canvas Provider
- 用户配置 Canvas 实例地址，连接器必须验证 HTTPS/可信主机和重定向目标，避免凭据被发送到非预期域名。
- 认证分为 PersonalTokenProvider 和 OAuthProvider，共用课程/作业/日历读取 Port。
- Personal Token 仅供开发者本人本地验证；不共享、不上传、不提交仓库、不传入模型。
- OAuth 是五人多用户接入路径。立即联系老师/Canvas 管理员申请 Developer Key，确认最小只读 Scope、Redirect URI、Secret 交换方式和 Token 生命周期。
- Electron 包中不得硬编码 OAuth Client Secret。若 Canvas 授权交换要求机密 Secret，应使用适当的安全交换组件，不能把 Secret 放在 Renderer 或安装包中。
- 首版优先完成真实课程、作业、截止时间读取和 M1 映射；处理分页、时区、去重、远端更新、撤权和错误状态。

### IMAP/SMTP Adapter
- 用户配置主机、端口、加密模式、账号和服务商允许的认证方式。
- 交大邮箱为首要真实测试对象，公开参数参考 mail.sjtu.edu.cn、IMAP 993、SMTP 465；必须验证当前账号的实际认证策略。
- IMAP 读取与 SMTP 发送分别配置和测试；发送权限不能由读取权限推导。
- 凭据通过系统安全存储句柄访问，不写普通数据库、云端团队空间、日志或 AI 上下文。
- 邮件事项提取输出 CandidateAction，由用户确认后调用 M1 Task/Event Port。
- 发信必须使用已冻结草稿版本和本次用户确认快照；未知结果先核验，不自动重发。

### 云端 PoC
Supabase 仅是 W4-DEC-03 的候选验证对象。五人 Auth、Workspace、RLS、Realtime 和断网恢复通过后再决定是否用于 Alpha；不得把 Service Role Key 放入桌面应用。
